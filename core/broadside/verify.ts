// Broad-Side verification pass (#143): the hybrid the roadmap kept coming
// back to. The batch sweep is cheap and reads files without being able to
// look anything up, and its measured weakness is precision, not coverage —
// on this repository the top twelve findings by severity were two real
// defects and ten claims that a look at the guard, the caller, or the
// tsconfig would have dismissed. So after collect, one sync-priced call per
// finding, with three read-only tools confined to the repository, reads the
// cited code and says whether the failure is reachable.
//
// Measured on 2026-09-13 (the #143 comparison run): twelve findings, the
// rubric below, `google/gemini-3.7-flash` at low reasoning effort —
// twelve-for-twelve agreement with a reviewer's ground truth, precision of
// the confirmed set from 17% to 100%, both true findings kept, $0.13 in all
// (about a cent a finding). The rubric mattered more than the model: a first
// draft without the `not-a-defect` verdict "confirmed" two type casts that
// every caller satisfies, because they were literally true of the code.
//
// Read-only on purpose. A tool-using pass that could mutate would need the
// headless-agent retry rule (retry only before the first tool call); one
// that only reads keeps the batch property that re-running is always safe.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BROADSIDE_DIR, BROADSIDE_LENS_IDS, type BroadsideLensId } from "./constants.ts";
import { type BroadsideVerifyEntry, defaultReasoningFor } from "./types.ts";
import { redactSecrets } from "../secrets.ts";
import { isSlurpable, listRepoFiles } from "./repo.ts";
import { broadsideDirFor, loadBroadsideConfig, loadBroadsideState, persistBroadsideRunMerging } from "./state.ts";
import { type FetchLike } from "./client.ts";
import { loadSavedLensResults, parseLensJson, type StoredLensResult } from "./results.ts";

export const BROADSIDE_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
/** How many findings `verify` reads by default, most severe first. */
export const BROADSIDE_VERIFY_DEFAULT_TOP = 10;
/** Tool calls one finding may spend before it must answer. */
export const BROADSIDE_VERIFY_MAX_TOOL_CALLS = 8;
/** The lenses whose findings carry a file:line and a claim to check. */
export const BROADSIDE_VERIFIABLE_LENSES: readonly BroadsideLensId[] = ["defect", "security"];
const READ_FILE_MAX_LINES = 200;
const GREP_MAX_MATCHES = 40;
const GREP_MAX_FILE_BYTES = 1_000_000;
const TOOL_OUTPUT_MAX_CHARS = 12_000;

export type VerifyVerdict = "confirmed" | "not-a-defect" | "discarded" | "unclear";

export type VerifiedFinding = {
	index: number;
	lensId: BroadsideLensId;
	customId: string;
	severity: string;
	title: string;
	location: string;
	verdict: VerifyVerdict | "error";
	confidence: string;
	evidence: Array<{ file: string; lines: string; note: string }>;
	reasoning: string;
	toolCalls: number;
	cost: number;
};

export type BroadsideVerifyResult = {
	runId: string;
	outputDir: string;
	model: string;
	status: BroadsideVerifyEntry["status"];
	/** How many findings the run had in the verifiable lenses. */
	candidates: number;
	findings: VerifiedFinding[];
	totalCost: number;
	/** Set when the cost cap stopped the pass before every selected finding was read. */
	stoppedByCost?: boolean;
	/** Secret-like values redacted from tool output before it reached the model (#358). */
	redactedValues: number;
	/** The files those values were in. */
	redactedFiles: string[];
};

type CandidateFinding = {
	lensId: BroadsideLensId;
	customId: string;
	severity: string;
	title: string;
	location: string;
	description: string;
	pattern: string;
};

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** The sync-priced id behind a `:batch` model id (`vendor/name:batch` → `vendor/name`). */
export function syncModelFor(batchModel: string): string {
	return batchModel.replace(/:batch$/, "");
}

/** The findings a run's saved lens results carry, most severe first. */
export function rankVerifiableFindings(stored: StoredLensResult[]): CandidateFinding[] {
	const out: CandidateFinding[] = [];
	for (const result of stored) {
		if (!BROADSIDE_VERIFIABLE_LENSES.includes(result.lensId) || result.truncated) continue;
		const parsed = parseLensJson(result.content) as { findings?: Array<Record<string, unknown>> } | null;
		for (const finding of parsed?.findings ?? []) {
			const location = typeof finding.location === "string" ? finding.location : "";
			const title = typeof finding.title === "string" ? finding.title : "";
			if (!location || !title) continue;
			out.push({
				lensId: result.lensId,
				customId: result.customId,
				severity: typeof finding.severity === "string" ? finding.severity.toLowerCase() : "unknown",
				title,
				location,
				description: typeof finding.description === "string" ? finding.description : "",
				pattern: typeof finding.pattern === "string" ? finding.pattern : typeof finding.category === "string" ? finding.category : "",
			});
		}
	}
	// Stable: severity, then lens order, then the order the lens listed them.
	return out
		.map((finding, order) => ({ finding, order }))
		.sort((a, b) =>
			(SEVERITY_RANK[a.finding.severity] ?? 9) - (SEVERITY_RANK[b.finding.severity] ?? 9)
			|| BROADSIDE_LENS_IDS.indexOf(a.finding.lensId) - BROADSIDE_LENS_IDS.indexOf(b.finding.lensId)
			|| a.order - b.order,
		)
		.map(({ finding }) => finding);
}

// ---------- read-only tools, confined to the repository ----------

export type RepoReader = {
	readFile(path: string, startLine?: number, endLine?: number): Promise<string>;
	grep(pattern: string, pathPrefix?: string): Promise<string>;
	listDir(path: string): Promise<string>;
	/** What the redaction pass did to this reader's output so far (#358). */
	readonly redactions: { values: number; files: Set<string> };
};

/**
 * Three read-only tools over the repository's own file list — the same
 * listing the lenses scan (tracked and untracked, ignore rules applied) minus
 * everything {@link isSlurpable} keeps out of a lens: credential stores, build
 * output, binaries. A path outside the repository, or one the listing does
 * not contain, is an error the model sees, not a read.
 *
 * Every line the reader hands back goes through the same secret-redaction
 * pass `submit` runs over its slices (#358): the file list keeps credential
 * *stores* out, but a key in an ordinary source file is exactly what a
 * finding points a verifier at, and the tool result is the upload. `redact`
 * mirrors config.yaml's `redact_secrets`. A pattern the model greps for can
 * still tell it that a line matched; the line it sees is redacted.
 */
export async function createRepoReader(cwd: string, opts: { redact?: boolean } = {}): Promise<RepoReader> {
	const { files } = await listRepoFiles(cwd);
	const readable = new Set(files.filter(isSlurpable));
	const redact = opts.redact ?? true;
	const redactions = { values: 0, files: new Set<string>() };
	const clean = (rel: string, line: string): string => {
		if (!redact) return line;
		const redaction = redactSecrets(line);
		if (redaction.count > 0) {
			redactions.values += redaction.count;
			redactions.files.add(rel);
		}
		return redaction.text;
	};
	const confine = (path: string): string => {
		const abs = resolve(cwd, path);
		const rel = relative(cwd, abs).split("\\").join("/");
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path is outside the repository: ${path}`);
		return rel;
	};
	return {
		redactions,
		async readFile(path, startLine, endLine) {
			const rel = confine(path);
			if (!readable.has(rel)) return `error: ${rel} is not a readable source file of this repository`;
			const lines = (await readFile(join(cwd, rel), "utf8")).split("\n");
			const start = Math.max(1, Math.floor(Number(startLine ?? 1)) || 1);
			const requestedEnd = Math.floor(Number(endLine ?? start + READ_FILE_MAX_LINES - 1)) || start;
			const end = Math.min(lines.length, requestedEnd, start + READ_FILE_MAX_LINES - 1);
			if (start > lines.length) return `error: ${rel} has ${lines.length} lines`;
			return lines.slice(start - 1, end).map((line, i) => `${start + i}: ${clean(rel, line)}`).join("\n");
		},
		async grep(pattern, pathPrefix) {
			let regex: RegExp;
			try {
				regex = new RegExp(pattern);
			} catch (error) {
				return `error: invalid pattern (${error instanceof Error ? error.message : String(error)})`;
			}
			const prefix = pathPrefix ? confine(pathPrefix) : "";
			const matches: string[] = [];
			for (const rel of readable) {
				if (prefix && rel !== prefix && !rel.startsWith(`${prefix}/`) && !rel.startsWith(prefix)) continue;
				let text: string;
				try {
					if ((await stat(join(cwd, rel))).size > GREP_MAX_FILE_BYTES) continue;
					text = await readFile(join(cwd, rel), "utf8");
				} catch {
					continue;
				}
				const lines = text.split("\n");
				for (let i = 0; i < lines.length && matches.length < GREP_MAX_MATCHES; i++) {
					if (regex.test(lines[i])) matches.push(`${rel}:${i + 1}: ${clean(rel, lines[i])}`);
				}
				if (matches.length >= GREP_MAX_MATCHES) break;
			}
			return matches.length > 0 ? matches.join("\n") : "(no matches)";
		},
		async listDir(path) {
			const rel = path === "." || path === "" ? "" : confine(path);
			try {
				const entries = await readdir(join(cwd, rel), { withFileTypes: true });
				return entries
					.filter((entry) => {
						const child = rel ? `${rel}/${entry.name}` : entry.name;
						return entry.isDirectory() ? [...readable].some((f) => f.startsWith(`${child}/`)) : readable.has(child);
					})
					.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
					.sort()
					.join("\n") || "(empty)";
			} catch (error) {
				return `error: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	};
}

const TOOLS = [
	{ type: "function", function: { name: "read_file", description: "Read a range of lines (1-based, inclusive) from a source file of the repository; at most 200 lines per call.", parameters: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"] } } },
	{ type: "function", function: { name: "grep", description: "Search the repository's source files for a regular expression; returns at most 40 matching lines as path:line: text.", parameters: { type: "object", properties: { pattern: { type: "string" }, path_prefix: { type: "string", description: "optional directory or file to search under" } }, required: ["pattern"] } } },
	{ type: "function", function: { name: "list_dir", description: "List a directory of the repository.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

const VERDICT_SCHEMA = {
	name: "broadside_verification",
	strict: true,
	schema: {
		type: "object",
		properties: {
			verdict: { type: "string", enum: ["confirmed", "not-a-defect", "discarded", "unclear"] },
			confidence: { type: "string", enum: ["high", "medium", "low"] },
			evidence: {
				type: "array",
				items: { type: "object", properties: { file: { type: "string" }, lines: { type: "string" }, note: { type: "string" } }, required: ["file", "lines", "note"], additionalProperties: false },
			},
			reasoning: { type: "string" },
		},
		required: ["verdict", "confidence", "evidence", "reasoning"],
		additionalProperties: false,
	},
};

/**
 * The rubric. The order is deliberate — it is the order a reviewer settles a
 * claim in — and `not-a-defect` is the verdict that separates "the code does
 * what the claim says" from "and that is a bug": without it, a cast every
 * caller satisfies gets confirmed because it is literally there.
 */
export const BROADSIDE_VERIFY_SYSTEM_PROMPT =
	"You verify a scouting finding produced by a one-shot batch scan against the real source code. " +
	"The scan saw files without being able to look anything up; you can. Use the tools to read the cited location " +
	"and whatever else the claim depends on (callers, the definition of a helper, error handling around it). " +
	"Then decide, in this order: " +
	"'discarded' — the claim is wrong about the code (the guard exists, the value cannot be what the claim assumes, " +
	"the cited line does something else, the condition it fears is ruled out by the project's config or runtime); " +
	"'not-a-defect' — the claim is literally true of the code but no caller, input, or state can reach the failure it " +
	"describes: a TypeScript cast every caller satisfies, a hypothetical about an environment the project does not " +
	"target, a style or type-hygiene observation; " +
	"'confirmed' — the failure is reachable: name the concrete input, call site, or sequence that triggers it, and what " +
	"then goes wrong; " +
	"'unclear' — settling it needs runtime behaviour or specification knowledge the code does not contain. " +
	"Be strict: a real but different problem than the one claimed is 'discarded' with the difference noted, and " +
	"'confirmed' without a trigger you found in the code is not allowed. " +
	"Cite line ranges you actually read. When you are done, reply with only the JSON verdict object.";

function findingPrompt(index: number, finding: CandidateFinding): string {
	return (
		`Finding ${index} (${finding.lensId} lens, severity ${finding.severity}):\n` +
		`Title: ${finding.title}\nLocation: ${finding.location}\nPattern/category: ${finding.pattern || "-"}\n` +
		`Description: ${finding.description}\n\n` +
		"Verify it. Reply with a JSON object {verdict, confidence, evidence:[{file,lines,note}], reasoning}."
	);
}

type ChatMessage = Record<string, unknown>;

async function chat(fetcher: FetchLike, apiKey: string, model: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const resp = await fetcher(BROADSIDE_CHAT_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, reasoning: defaultReasoningFor(), usage: { include: true }, ...body }),
		signal: AbortSignal.timeout(120_000),
	});
	const data = (await resp.json()) as Record<string, unknown>;
	if (!resp.ok || data.error) {
		const detail = (data.error as { message?: string } | undefined)?.message ?? JSON.stringify(data.error ?? data).slice(0, 300);
		throw new Error(`OpenRouter chat: HTTP ${resp.status}: ${detail}`);
	}
	return data;
}

function parseVerdict(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	try {
		const parsed = JSON.parse(fenced ? fenced[1] : trimmed) as Record<string, unknown>;
		return typeof parsed?.verdict === "string" ? parsed : null;
	} catch {
		return null;
	}
}

/** Verify one finding: up to the tool budget, then a verdict. */
export async function verifyFinding(
	finding: CandidateFinding,
	index: number,
	reader: RepoReader,
	apiKey: string,
	model: string,
	fetcher: FetchLike,
): Promise<Omit<VerifiedFinding, "index" | "lensId" | "customId" | "severity" | "title" | "location">> {
	const messages: ChatMessage[] = [
		{ role: "system", content: BROADSIDE_VERIFY_SYSTEM_PROMPT },
		{ role: "user", content: findingPrompt(index, finding) },
	];
	let toolCalls = 0;
	let cost = 0;
	const usageCost = (data: Record<string, unknown>): number => {
		const usage = data.usage as { cost?: unknown } | undefined;
		return typeof usage?.cost === "number" ? usage.cost : 0;
	};
	try {
		// The +2 leaves room for the final schema-forced call after the budget.
		for (let step = 0; step < BROADSIDE_VERIFY_MAX_TOOL_CALLS + 2; step++) {
			const budgetSpent = toolCalls >= BROADSIDE_VERIFY_MAX_TOOL_CALLS;
			if (budgetSpent) messages.push({ role: "user", content: "Tool budget spent. Emit the verdict JSON object now from what you have read." });
			const data = await chat(fetcher, apiKey, model, budgetSpent
				? { messages, response_format: { type: "json_schema", json_schema: VERDICT_SCHEMA }, max_tokens: 2000 }
				: { messages, tools: TOOLS, tool_choice: "auto", max_tokens: 4000 });
			cost += usageCost(data);
			const choice = (data.choices as Array<{ message?: ChatMessage }> | undefined)?.[0];
			const message = choice?.message ?? { role: "assistant", content: "" };
			messages.push(message);
			const calls = message.tool_calls as Array<{ id: string; function: { name: string; arguments?: string } }> | undefined;
			if (calls && calls.length > 0 && !budgetSpent) {
				for (const call of calls) {
					toolCalls += 1;
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
					} catch {
						// Malformed arguments: the model sees the error and can retry.
					}
					let output: string;
					try {
						output = call.function.name === "read_file"
							? await reader.readFile(String(args.path ?? ""), args.start_line as number | undefined, args.end_line as number | undefined)
							: call.function.name === "grep"
								? await reader.grep(String(args.pattern ?? ""), typeof args.path_prefix === "string" ? args.path_prefix : undefined)
								: call.function.name === "list_dir"
									? await reader.listDir(String(args.path ?? "."))
									: `error: unknown tool ${call.function.name}`;
					} catch (error) {
						output = `error: ${error instanceof Error ? error.message : String(error)}`;
					}
					messages.push({ role: "tool", tool_call_id: call.id, content: output.slice(0, TOOL_OUTPUT_MAX_CHARS) });
				}
				continue;
			}
			const verdict = parseVerdict(typeof message.content === "string" ? message.content : "");
			if (verdict) return finish(verdict, toolCalls, cost);
			if (budgetSpent) break;
			// Prose instead of JSON: one schema-forced call, no tools.
			const final = await chat(fetcher, apiKey, model, {
				messages: [...messages, { role: "user", content: "Emit the verdict JSON object now." }],
				response_format: { type: "json_schema", json_schema: VERDICT_SCHEMA },
				max_tokens: 2000,
			});
			cost += usageCost(final);
			const forced = parseVerdict(String(((final.choices as Array<{ message?: ChatMessage }>)?.[0]?.message?.content) ?? ""));
			if (forced) return finish(forced, toolCalls, cost);
			break;
		}
		return { verdict: "error", confidence: "low", evidence: [], reasoning: "no verdict within the tool budget", toolCalls, cost };
	} catch (error) {
		return { verdict: "error", confidence: "low", evidence: [], reasoning: error instanceof Error ? error.message : String(error), toolCalls, cost };
	}
}

function finish(verdict: Record<string, unknown>, toolCalls: number, cost: number) {
	const known: VerifyVerdict[] = ["confirmed", "not-a-defect", "discarded", "unclear"];
	const value = String(verdict.verdict);
	const evidence = Array.isArray(verdict.evidence)
		? (verdict.evidence as Array<Record<string, unknown>>).map((e) => ({ file: String(e.file ?? ""), lines: String(e.lines ?? ""), note: String(e.note ?? "") }))
		: [];
	return {
		verdict: (known.includes(value as VerifyVerdict) ? value : "unclear") as VerifyVerdict,
		confidence: typeof verdict.confidence === "string" ? verdict.confidence : "low",
		evidence,
		reasoning: typeof verdict.reasoning === "string" ? verdict.reasoning : "",
		toolCalls,
		cost,
	};
}

/**
 * Verify the top findings of a collected run against the repository.
 *
 * `maxCost` is a running cap, not a pre-flight estimate: a sync call's cost
 * is only known when it returns, so the pass stops *before* starting the next
 * finding once the cap is reached and reports `partial`. On the default
 * model a finding costs about a cent.
 */
export async function runBroadsideVerify(
	cwd: string,
	apiKey: string,
	opts: {
		runId?: string;
		top?: number;
		model?: string;
		/** USD; 0 means no limit. */
		maxCost?: number;
		fetcher?: FetchLike;
		signal?: AbortSignal;
		onProgress?: (finding: VerifiedFinding) => void;
	} = {},
): Promise<BroadsideVerifyResult> {
	const broadsideDir = broadsideDirFor(cwd);
	const state = await loadBroadsideState(broadsideDir);
	const run = opts.runId ? state.runs.find((candidate) => candidate.id === opts.runId) : state.runs[state.runs.length - 1];
	if (!run) {
		throw new Error(opts.runId ? `No Broad-Side run with id ${opts.runId}.` : "No Broad-Side run recorded. Submit and collect one first.");
	}
	const runDir = join(broadsideDir, run.outputDir);
	const stored = await loadSavedLensResults(runDir, run.lenses);
	const ranked = rankVerifiableFindings(stored);
	if (ranked.length === 0) {
		throw new Error(
			`Run ${run.id} has no verifiable findings on disk: the defect and security lenses either did not run, are not collected yet, or found nothing. Collect the run first.`,
		);
	}
	const top = Math.max(1, Math.floor(opts.top ?? BROADSIDE_VERIFY_DEFAULT_TOP));
	// The run's model is a `:batch` variant; the sync endpoint wants the base id.
	const model = opts.model ?? syncModelFor(run.model);
	const maxCost = opts.maxCost ?? 0;
	const fetcher = opts.fetcher ?? (fetch as FetchLike);
	// The same switch submit honours: a repository that turned redaction off
	// for its slices gets raw lines here too, and one that did not never
	// uploads a key through a tool result (#358).
	const config = await loadBroadsideConfig(broadsideDir);
	const reader = await createRepoReader(cwd, { redact: config.redactSecrets });
	const selected = ranked.slice(0, top);
	const findings: VerifiedFinding[] = [];
	let totalCost = 0;
	let stoppedByCost = false;
	for (const [i, candidate] of selected.entries()) {
		if (opts.signal?.aborted) break;
		if (maxCost > 0 && totalCost >= maxCost) {
			stoppedByCost = true;
			break;
		}
		const outcome = await verifyFinding(candidate, i + 1, reader, apiKey, model, fetcher);
		const finding: VerifiedFinding = {
			index: i + 1,
			lensId: candidate.lensId,
			customId: candidate.customId,
			severity: candidate.severity,
			title: candidate.title,
			location: candidate.location,
			...outcome,
		};
		findings.push(finding);
		totalCost += outcome.cost;
		opts.onProgress?.(finding);
	}
	const status: BroadsideVerifyEntry["status"] = findings.length === selected.length ? "completed" : "partial";
	const entry: BroadsideVerifyEntry = {
		status,
		model,
		top,
		verified: findings.length,
		confirmed: findings.filter((f) => f.verdict === "confirmed").length,
		cost: totalCost,
		at: new Date().toISOString(),
		redactedValues: reader.redactions.values,
	};
	const result: BroadsideVerifyResult = {
		runId: run.id,
		outputDir: join(".codecarto", BROADSIDE_DIR, run.id),
		model,
		status,
		candidates: ranked.length,
		findings,
		totalCost,
		...(stoppedByCost && { stoppedByCost: true }),
		redactedValues: reader.redactions.values,
		redactedFiles: [...reader.redactions.files].sort(),
	};
	await writeFile(join(runDir, "verified.json"), `${JSON.stringify({ ...entry, run_id: run.id, candidates: ranked.length, findings }, null, "\t")}\n`, "utf8");
	await writeFile(join(runDir, "verified.md"), renderVerifiedMarkdown(result), "utf8");
	run.verify = entry;
	await persistBroadsideRunMerging(broadsideDir, run);
	return result;
}

const VERDICT_MARK: Record<string, string> = { confirmed: "✓", "not-a-defect": "–", discarded: "✗", unclear: "?", error: "!" };

export function renderVerifiedMarkdown(result: BroadsideVerifyResult): string {
	const lines = [
		`# Verified findings — run ${result.runId}`,
		"",
		`${result.findings.length} of ${result.candidates} verifiable finding(s) read against the source on \`${result.model}\` (most severe first), $${result.totalCost.toFixed(4)}.` +
			(result.stoppedByCost ? " Stopped by the cost cap before the rest." : ""),
		"",
		"A **confirmed** finding names the input, call site, or sequence that reaches the failure. **not-a-defect** means the claim is",
		"literally true of the code but nothing can reach the failure it describes; **discarded** means the claim is wrong about the",
		"code; **unclear** needs runtime or specification knowledge. Every verdict is still a model's reading — a confirmed finding",
		"is a lead worth a human's next look, not a validated claim.",
		"",
	];
	if (result.redactedValues > 0) {
		lines.push(`${result.redactedValues} secret-like value(s) were redacted from tool output before upload (${result.redactedFiles.join(", ")}).`, "");
	}
	for (const f of result.findings) {
		lines.push(`## ${VERDICT_MARK[f.verdict] ?? "?"} ${f.index}. [${f.severity}] ${f.title}`, "", `- **verdict**: ${f.verdict} (${f.confidence})`, `- **location**: ${f.location}`, `- **lens**: ${f.lensId} (${f.customId})`);
		if (f.evidence.length > 0) lines.push(`- **evidence**: ${f.evidence.map((e) => `${e.file}:${e.lines} — ${e.note}`).join("; ")}`);
		lines.push(`- **reasoning**: ${f.reasoning.replace(/\s+/g, " ").trim()}`, `- **cost**: $${f.cost.toFixed(4)} (${f.toolCalls} tool call(s))`, "");
	}
	return lines.join("\n");
}

export function verifyResultText(result: BroadsideVerifyResult): string {
	const counts = { confirmed: 0, "not-a-defect": 0, discarded: 0, unclear: 0, error: 0 } as Record<string, number>;
	for (const f of result.findings) counts[f.verdict] = (counts[f.verdict] ?? 0) + 1;
	const lines = [
		`Broad-Side verify — run ${result.runId}: ${result.status}`,
		`  ${result.findings.length} of ${result.candidates} verifiable finding(s) read on ${result.model} | cost: $${result.totalCost.toFixed(4)}` +
			(result.stoppedByCost ? " (stopped by the cost cap)" : ""),
		`  confirmed ${counts.confirmed} · not-a-defect ${counts["not-a-defect"]} · discarded ${counts.discarded} · unclear ${counts.unclear}` + (counts.error ? ` · error ${counts.error}` : ""),
	];
	for (const f of result.findings) {
		lines.push(`  ${VERDICT_MARK[f.verdict] ?? "?"} [${f.severity}] ${f.title} @ ${f.location} — ${f.verdict}`);
	}
	if (result.redactedValues > 0) {
		lines.push(`  ${result.redactedValues} secret-like value(s) redacted from tool output before upload (${result.redactedFiles.join(", ")}).`);
	}
	lines.push(`Details in ${result.outputDir}/verified.md. A confirmed finding is a lead for a human's next look, not a validated claim.`);
	return lines.join("\n");
}
