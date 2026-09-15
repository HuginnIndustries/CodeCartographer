// runBroadsideCollect and runBroadsideStatus: polling, saving, the truncation retry, and the synthesis and triage post-passes (verdict-aware).
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../utils.ts";
import { BROADSIDE_DEFAULT_POLL_BUDGET_MS, type BroadsideLensId } from "./constants.ts";
import { type BatchRequest, type BroadsideCollectResult, type BroadsideRunSlot, type BroadsideStateFile, type BroadsideSynthesisEntry, type TriageItem, retryReasoningFor } from "./types.ts";
import { SCHEMAS } from "./schemas.ts";
import { getLens } from "./lenses.ts";
import { sanitizeId } from "./repo.ts";
import { broadsideDirFor, claimRunSlot, loadBroadsideState, persistBroadsideRunMerging, resetRunPostPasses } from "./state.ts";
import { BROADSIDE_DEAD_BATCH_STATUSES, BROADSIDE_TERMINAL_ENTRY_STATUSES, type FetchLike, explainBatchError, pollBatchesConcurrently, submitBatch } from "./client.ts";
import { type StoredLensResult, extractContent, loadSavedLensResults, loadStoredRequests, parseLensJson, renderFindingsMarkdown, saveLensResults } from "./results.ts";
import { parseSynthesisTopFindings } from "./render.ts";

// ---------- post-lens passes: synthesis + triage ----------

/**
 * One verdict from a run's `verified.json` (written by the verify pass in
 * `verify.ts`), reduced to what the post-passes are told.
 */
export type PostPassVerdict = {
	lensId: string;
	customId: string;
	severity: string;
	title: string;
	location: string;
	verdict: string;
	confidence: string;
	evidence: Array<{ file: string; lines: string; note: string }>;
	reasoning: string;
};

/**
 * The verdicts a verify pass left in the run directory, or null when none
 * has run (#338). A file that does not parse is treated as absent: the
 * post-passes then run from the findings alone, which is what they did
 * before verdicts existed, and `status` shows the pass carried no verdicts.
 */
export async function loadPostPassVerdicts(runDir: string): Promise<PostPassVerdict[] | null> {
	const path = join(runDir, "verified.json");
	if (!(await pathExists(path))) return null;
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		const findings = Array.isArray(parsed.findings) ? (parsed.findings as Array<Record<string, unknown>>) : [];
		const verdicts = findings
			.filter((f) => typeof f.title === "string" && typeof f.verdict === "string")
			.map((f) => ({
				lensId: String(f.lensId ?? ""),
				customId: String(f.customId ?? ""),
				severity: String(f.severity ?? ""),
				title: String(f.title),
				location: String(f.location ?? ""),
				verdict: String(f.verdict),
				confidence: String(f.confidence ?? ""),
				evidence: Array.isArray(f.evidence)
					? (f.evidence as Array<Record<string, unknown>>).map((e) => ({ file: String(e.file ?? ""), lines: String(e.lines ?? ""), note: String(e.note ?? "") }))
					: [],
				reasoning: String(f.reasoning ?? ""),
			}));
		return verdicts.length > 0 ? verdicts : null;
	} catch {
		return null;
	}
}

/**
 * The verdicts as a section of the post-pass user message: one line per
 * finding with the verdict, the evidence the verifier cited, and its
 * reasoning, so the pass can rank on them rather than on the batch model's
 * own severities (#338).
 */
export function renderPostPassVerdicts(verdicts: PostPassVerdict[]): string {
	const counts = new Map<string, number>();
	for (const v of verdicts) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
	const tally = [...counts.entries()].map(([verdict, n]) => `${n} ${verdict}`).join(", ");
	const lines = [
		"",
		`## Verification verdicts (${verdicts.length} finding(s) read against the source by a read-only-tools pass: ${tally})`,
		"",
		"A verdict outranks the batch severity of the finding it names. `confirmed` means the verifier found a reachable " +
		"failure and named its trigger; `not-a-defect` means the claim is literally true of the code but nothing reaches the " +
		"failure it describes; `discarded` means the claim is wrong about the code; `unclear` means the code alone could not " +
		"settle it; `error` means the pass could not read it — treat that finding as unverified. Findings not listed here " +
		"were not read and stay unverified leads.",
		"",
	];
	for (const v of verdicts) {
		const evidence = v.evidence.map((e) => `${e.file}${e.lines ? `:${e.lines}` : ""}${e.note ? ` (${e.note})` : ""}`).join("; ");
		lines.push(
			`- [${v.verdict}${v.confidence ? `, ${v.confidence} confidence` : ""}] ${v.lensId}/${v.customId} — [${v.severity}] ${v.title}` +
			`${v.location ? ` @ ${v.location}` : ""}` +
			`${v.reasoning ? `\n  Reasoning: ${v.reasoning.replace(/\s+/g, " ").trim()}` : ""}` +
			`${evidence ? `\n  Evidence: ${evidence}` : ""}`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

const SYNTHESIS_VERDICT_INSTRUCTIONS =
	" A verification pass has read some of the findings against the source; its verdicts follow the reports. " +
	"Lead top_findings with the confirmed findings and begin each such summary with 'verified: confirmed — ' and the " +
	"trigger the verifier named; keep an unclear one with 'verified: unclear — '. A discarded or not-a-defect finding " +
	"does not appear in top_findings and is not counted in severity_summary. Say in the executive summary how many " +
	"findings were verified and how the verdicts split; findings the pass did not read remain unverified, and the " +
	"summary says so of them, not of the confirmed ones.";

const TRIAGE_VERDICT_INSTRUCTIONS =
	" A verification pass has read some of the findings against the source; its verdicts follow the findings. " +
	"A confirmed finding ranks above every unverified finding of the same or lower severity: put the confirmed " +
	"findings at the top of the queue and begin each one's rationale with 'verified: confirmed — ' and the trigger " +
	"the verifier named. Keep an unclear finding in the queue with 'verified: unclear — ' in its rationale. Do not " +
	"queue a discarded or not-a-defect finding: list each in omitted, beginning with 'verified: discarded — ' or " +
	"'verified: not a defect — ' and the reason the pass gave. Findings the pass did not read stay unverified leads, " +
	"and the summary says how many verdicts the queue was built from.";

function buildSynthesisRequest(findingsText: string, truncatedNote: string, model: string, verdicts: PostPassVerdict[] | null = null): BatchRequest {
	return {
		custom_id: "synthesis",
		body: {
			model,
			messages: [
				{
					role: "system",
					content:
						"You are a technical editor synthesizing multiple analysis reports about a single " +
						"codebase into one coherent summary. The reports come from different lenses — " +
						"architecture, API surface, security review, defect scanning, convention extraction, " +
						"and porting assessment. Cross-reference findings across lenses: if a security issue " +
						"also appears as a defect, merge them. Produce a JSON object following the " +
						"synthesis_report schema. Prioritize the most actionable findings. " +
						"Be honest about gaps — if a lens found nothing, say 'no issues found' rather than " +
						"inventing problems. These are scouting signals from a batch model, not verified " +
						"claims; note that in the summary." +
						(verdicts ? SYNTHESIS_VERDICT_INSTRUCTIONS : ""),
				},
				{
					role: "user",
					content:
						"Synthesize these analysis reports into a single summary.\n\n" +
						findingsText +
						truncatedNote +
						(verdicts ? renderPostPassVerdicts(verdicts) : "") +
						"\nReturn the synthesis_report JSON schema.",
				},
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS.synthesis },
			max_tokens: 12_000,
		},
	};
}

function buildTriageRequest(findingsText: string, truncatedNote: string, model: string, verdicts: PostPassVerdict[] | null = null): BatchRequest {
	return {
		custom_id: "triage",
		body: {
			model,
			messages: [
				{
					role: "system",
					content:
						"You are a senior engineering lead turning unverified scouting findings into a " +
						"prioritized work order. Given the findings below, produce a JSON object following " +
						"the triage_report schema. Score every lead by impact and fix difficulty, assign a " +
						"priority (P0 urgent/safety-critical to P3 nice-to-have), give a rough effort " +
						"estimate, group the queue by module where sensible, and justify each call in the " +
						"rationale. Merge duplicate leads instead of listing them twice. Drop leads that are " +
						"too vague to act on and record each drop in omitted with the reason. These findings " +
						"are UNVERIFIED scouting signals from a cheap batch model: the queue is a starting " +
						"point for re-verification, not a commitment — say so in the summary, and never " +
						"inflate a severity you cannot see evidence for." +
						(verdicts ? TRIAGE_VERDICT_INSTRUCTIONS : ""),
				},
				{
					role: "user",
					content:
						"Triage these scouting findings into a prioritized work order.\n\n" +
						findingsText +
						truncatedNote +
						(verdicts ? renderPostPassVerdicts(verdicts) : "") +
						"\nReturn the triage_report JSON schema.",
				},
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS.triage },
			max_tokens: 10_000,
		},
	};
}

function parseTriageItems(content: string): TriageItem[] {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const items = Array.isArray(parsed.items) ? (parsed.items as Array<Record<string, unknown>>) : [];
		return items
			.filter((item) => typeof item.title === "string")
			.map((item) => ({
				title: String(item.title),
				severity: String(item.severity ?? "unknown"),
				module: String(item.module ?? "unknown"),
				impact: (["high", "medium", "low"].includes(String(item.impact)) ? String(item.impact) : "medium") as TriageItem["impact"],
				difficulty: (["high", "medium", "low"].includes(String(item.difficulty)) ? String(item.difficulty) : "medium") as TriageItem["difficulty"],
				priority: String(item.priority ?? "?"),
				effort_estimate: String(item.effort_estimate ?? ""),
				rationale: String(item.rationale ?? ""),
			}));
	} catch {
		return [];
	}
}

export async function runBroadsideCollect(
	cwd: string,
	apiKey: string,
	opts: {
		waitMs?: number;
		includeSynthesis?: boolean;
		includeTriage?: boolean;
		/** Re-submit truncated slices once with a doubled output cap (#133). */
		retryTruncated?: boolean;
		onStatus?: (lensId: string, status: string, counts: Record<string, unknown>) => void;
		fetcher?: FetchLike;
		/**
		 * Which run to collect. Absent, the most recent — which used to be the
		 * only choice, so an older run still in flight could not be collected
		 * once a newer submit existed (#268). `status` lists the ids.
		 */
		runId?: string;
		/**
		 * Stops polling and submits nothing further once fired; what was
		 * already submitted keeps running server-side for a later collect to
		 * claim. The MCP server fires it when its client disconnects (#322).
		 */
		signal?: AbortSignal;
		/** Poll cadence override; tests drive the loop faster than 15 s. */
		pollIntervalMs?: number;
		/**
		 * Reset the wanted post-passes of a collected run and run them again
		 * (#338) — after a `verify`, so the executive report and the work order
		 * are built from the verdicts. A pass still in flight is left to finish;
		 * a run whose lens batches are still running is refused.
		 */
		regeneratePostPasses?: boolean;
	} = {},
): Promise<BroadsideCollectResult> {
	const broadsideDir = broadsideDirFor(cwd);
	const state = await loadBroadsideState(broadsideDir);
	const run = opts.runId ? state.runs.find((candidate) => candidate.id === opts.runId) : state.runs[state.runs.length - 1];
	if (!run) {
		if (opts.runId) {
			const known = state.runs.map((candidate) => candidate.id);
			throw new Error(
				`No Broad-Side run with id ${opts.runId}. ` +
				(known.length > 0 ? `Recorded runs: ${known.join(", ")}.` : "No runs are recorded; call codecarto_broadside with action 'submit' first."),
			);
		}
		throw new Error("No Broad-Side run recorded. Call codecarto_broadside with action 'submit' first.");
	}

	const runDir = join(broadsideDir, run.outputDir);
	await mkdir(runDir, { recursive: true });

	// The spending slots this collect has claimed (#322); only a claimed slot
	// is ever submitted from here. Every write-back merges with the file, so a
	// slot another collect has moved further along is never overwritten.
	const owned = new Set<BroadsideRunSlot>();
	const persist = () => persistBroadsideRunMerging(broadsideDir, run);
	const aborted = () => opts.signal?.aborted === true;

	const deadline = Date.now() + (opts.waitMs ?? BROADSIDE_DEFAULT_POLL_BUDGET_MS);
	let totalCost = 0;
	let resultCount = 0;
	let truncatedCount = 0;
	const lensOutcomes: BroadsideCollectResult["lensOutcomes"] = {};

	const allLensResults: StoredLensResult[] = [];

	// Terminal entries are settled already; everything else polls in parallel
	// against one shared deadline (#136), then results save in lens order so
	// output layout stays deterministic.
	const inFlight: Array<{ lensId: BroadsideLensId; batchId: string }> = [];
	for (const lensId of run.lenses) {
		const entry = run.batches[lensId];
		if (!entry || !entry.batchId) {
			lensOutcomes[lensId] = { status: entry?.status ?? "failed", resultCount: 0 };
			continue;
		}
		if (BROADSIDE_TERMINAL_ENTRY_STATUSES.includes(entry.status)) {
			totalCost += entry.cost ?? 0;
			resultCount += entry.resultCount ?? 0;
			lensOutcomes[lensId] = { status: entry.status, cost: entry.cost, resultCount: entry.resultCount };
			continue;
		}
		inFlight.push({ lensId, batchId: entry.batchId });
	}

	const polled = await pollBatchesConcurrently(inFlight, apiKey, {
		deadlineMs: Math.max(0, deadline - Date.now()),
		fetcher: opts.fetcher,
		pollIntervalMs: opts.pollIntervalMs,
		signal: opts.signal,
		onStatus: opts.onStatus,
	});

	for (const { lensId } of inFlight) {
		const entry = run.batches[lensId];
		if (!entry) continue;
		const batch = polled.get(entry.batchId) ?? { id: entry.batchId, status: "timeout" };

		const status = String(batch.status ?? "unknown");
		entry.status = status;
		if (status === "completed") {
			const usage = (batch.usage ?? {}) as Record<string, unknown>;
			const cost = typeof usage.cost === "number" ? usage.cost : undefined;
			entry.cost = cost;
			entry.completedAt = new Date().toISOString();
			const stored = await saveLensResults(runDir, lensId, batch);
			entry.resultCount = stored.length;
			const truncated = stored.filter((s) => s.truncated).length;
			allLensResults.push(...stored);
			resultCount += stored.length;
			truncatedCount += truncated;
			totalCost += cost ?? 0;
			await writeFile(
				join(runDir, `raw-${lensId}.json`),
				`${JSON.stringify(batch, null, "\t")}\n`,
				"utf8",
			);
			// A batch can complete with every request failed — the account's
			// concurrent-job quota filling after acceptance does exactly this.
			// The per-request errors are on disk as `<id>.error.json`, but a
			// lens reporting "completed, 0 result(s)" with the reason buried
			// there read as an empty repository rather than a refused run.
			const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
			const failed = results.filter((r) => r.error && extractContent(r) === null);
			const allFailed = stored.length === 0 && failed.length > 0
				? `all ${failed.length} request(s) failed: ${explainBatchError(failed[0].error)}`
				: null;
			if (allFailed) entry.error = allFailed;
			lensOutcomes[lensId] = { status, cost: entry.cost, resultCount: entry.resultCount, truncated, ...(allFailed && { error: allFailed }) };
		} else {
			// Every non-completed outcome still has to reach the report.
			// `lensOutcomes` is what the caller renders, and this branch used to
			// require `batch.error` — but the commonest failure here is the
			// synthetic `{ status: "timeout" }` the poll returns when its budget
			// expires with the batch still in flight, and that carries no error.
			// A lens that never came back was therefore omitted entirely,
			// indistinguishable in the output from one that was never requested.
			if (batch.error) entry.error = batch.error;
			const error = explainBatchError(batch.error);
			lensOutcomes[lensId] = { status, cost: entry.cost, resultCount: entry.resultCount, ...(error && { error }) };
		}
		await persist();
	}

	// #133: re-submit truncated slices once with a bumped output cap and low
	// reasoning effort. Batch requests are pure, so re-running is always safe;
	// the aim is to recover coverage the first pass lost to a max_tokens
	// cutoff, not to loop forever. Low effort because the cutoff is usually
	// thinking, and a doubled budget doubled the thinking where a token cap
	// was ignored (see retryReasoningFor).
	//
	// All bumped requests for one model go out as ONE batch, and the batches
	// (one per model, since a batch carries a single model) are polled
	// together against the shared deadline. Each truncated slice used to be
	// submitted and polled to terminal before the next was submitted, so a
	// model that truncated 11 of 13 slices turned a five-minute collect into
	// eleven sequential round trips — the serialization #136 removed from the
	// lens pass, still present here (#206). Grouping also keeps the retry to
	// one job per model against OpenRouter's 16-concurrent-job quota.
	let retriedCount = 0;
	let retryElsewhere = false;
	// A collect that polled nothing — every lens already terminal — still owes
	// the retry if the collect that saved the results never got to it (it
	// died, or its client did: #322). Read the saved results back and let the
	// claim decide; a recovered slice re-parses clean, so this costs nothing
	// once the retry has run.
	if (opts.retryTruncated !== false && allLensResults.length === 0 && !aborted()) {
		const everyLensTerminal = run.lenses.every((lensId) => {
			const entry = run.batches[lensId];
			return entry && BROADSIDE_TERMINAL_ENTRY_STATUSES.includes(entry.status);
		});
		if (everyLensTerminal) {
			const restored = await loadSavedLensResults(runDir, run.lenses);
			if (restored.some((s) => s.truncated)) {
				allLensResults.push(...restored);
				truncatedCount = restored.filter((s) => s.truncated).length;
			}
		}
	}
	if (opts.retryTruncated !== false && truncatedCount > 0 && !aborted()) {
		// Claim the pass before spending: a second collect on this run finds the
		// claim and leaves the retry to the first (#322). A retry another
		// collect has already settled is not run again — its truncation is
		// what it is.
		if (await claimRunSlot(broadsideDir, run, "retry")) owned.add("retry");
		else if (run.retry?.status === "submitted") retryElsewhere = true;
	}
	if (opts.retryTruncated !== false && truncatedCount > 0 && owned.has("retry")) {
		const requestsByCustomId = await loadStoredRequests(runDir);
		const byModel = new Map<string, { requests: BatchRequest[]; slices: Map<string, StoredLensResult> }>();
		for (const stored of allLensResults) {
			if (!stored.truncated) continue;
			const original = requestsByCustomId[stored.customId];
			if (!original) continue;
			const lensEntry = run.batches[stored.lensId];
			// A lens may have run on its own model (config `lens_models`), with its
			// own completion ceiling. Re-submitting against the run default would
			// change the model mid-run and could exceed that lens's real ceiling.
			const lensModel = lensEntry?.model ?? run.model;
			const lensCap = lensEntry?.outputCap ?? run.outputCap;
			const previousMax = original.body.max_tokens ?? getLens(stored.lensId).maxTokens;
			const bumpedMax = lensCap ? Math.min(previousMax * 2, lensCap) : previousMax * 2;
			if (bumpedMax <= previousMax) continue; // already at the ceiling

			const group = byModel.get(lensModel) ?? { requests: [], slices: new Map() };
			group.requests.push({
				...original,
				body: { ...original.body, max_tokens: bumpedMax, reasoning: retryReasoningFor(original.body.reasoning) },
			});
			group.slices.set(stored.customId, stored);
			byModel.set(lensModel, group);
		}

		// Submit every group, then poll whatever was accepted, together.
		const submitted: Array<{ model: string; batchId: string }> = [];
		for (const [model, group] of byModel) {
			if (aborted()) break;
			try {
				const { batchId, error } = await submitBatch(group.requests, apiKey, opts.fetcher, model);
				if (!error && batchId) submitted.push({ model, batchId });
			} catch {
				// A retry batch that fails to submit leaves its slices' original
				// truncated results in place — nothing is lost.
			}
		}
		// Record the ids under the claim so a later collect can see what was
		// paid for, even if this one never returns. No group at all means every
		// truncated slice was already at its model's ceiling: nothing to retry.
		run.retry = {
			...run.retry!,
			batches: submitted,
			status: submitted.length > 0 ? "submitted" : byModel.size === 0 ? "completed" : "failed",
		};
		await persist();
		const polled = await pollBatchesConcurrently(
			submitted.map(({ model, batchId }) => ({ lensId: `retry:${model}` as BroadsideLensId, batchId })),
			apiKey,
			{
				// Share the caller's deadline. Each of these polls used to start a
				// fresh 25-minute budget, so `wait_seconds` bounded only the lens
				// poll and a collect could run for the caller's budget plus fifty
				// minutes.
				deadlineMs: Math.max(0, deadline - Date.now()),
				fetcher: opts.fetcher,
				pollIntervalMs: opts.pollIntervalMs,
				signal: opts.signal,
				onStatus: opts.onStatus,
			},
		);

		for (const { model, batchId } of submitted) {
			const batch = polled.get(batchId);
			if (!batch || batch.status !== "completed") continue;
			const group = byModel.get(model)!;
			const usage = (batch.usage ?? {}) as Record<string, unknown>;
			// Kept on the entry, not just added to this collect's running total:
			// a later collect on the run used to report a total without it.
			if (typeof usage.cost === "number") run.retry = { ...run.retry!, cost: (run.retry?.cost ?? 0) + usage.cost };
			const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
			for (const result of results) {
				const stored = group.slices.get(String(result.custom_id ?? ""));
				if (!stored) continue;
				const content = extractContent(result);
				if (content === null) continue;
				const parsed = parseLensJson(content);
				if (parsed === null) continue; // still no good
				await writeFile(join(runDir, `${sanitizeId(stored.customId)}.json`), `${JSON.stringify(parsed, null, "\t")}\n`, "utf8");
				await writeFile(join(runDir, `${sanitizeId(stored.customId)}.md`), renderFindingsMarkdown(content), "utf8");
				stored.content = content;
				stored.truncated = false;
				retriedCount += 1;
			}
		}
		// Every retry batch reached a terminal status, or the poll ran out.
		if (submitted.length > 0 && submitted.every(({ batchId }) => polled.get(batchId)?.status === "completed")) {
			run.retry = { ...run.retry!, status: "completed" };
		}
		truncatedCount = allLensResults.filter((s) => s.truncated).length;
		for (const [lensId, outcome] of Object.entries(lensOutcomes)) {
			if (outcome.truncated !== undefined) {
				outcome.truncated = allLensResults.filter((s) => s.lensId === lensId && s.truncated).length;
			}
		}
		await persist();
	}

	// Synthesis + triage: cross-lens post-passes, only after every lens batch
	// is terminal. Triage turns the leads into a prioritized work order.
	run.triage ??= { status: "pending" };
	let topFindings: BroadsideCollectResult["topFindings"] = [];
	let topTriageItems: BroadsideCollectResult["topTriageItems"] = [];
	const wantSynthesis = opts.includeSynthesis !== false;
	const wantTriage = opts.includeTriage !== false;
	// A regenerate resets the wanted, settled passes to pending on disk first —
	// the merging persist keeps whatever is further along on disk, so an
	// in-memory reset alone would be undone by the next persist (#338).
	let regenerated: Array<"synthesis" | "triage"> = [];
	if (opts.regeneratePostPasses) {
		if (!wantSynthesis && !wantTriage) {
			throw new Error("Nothing to regenerate: both post-passes are disabled for this collect.");
		}
		const lensesSettled = run.lenses.every((lensId) => {
			const entry = run.batches[lensId];
			return entry && BROADSIDE_TERMINAL_ENTRY_STATUSES.includes(entry.status);
		});
		if (!lensesSettled) {
			throw new Error(`Cannot regenerate the post-passes of run ${run.id}: its lens batches are still running — collect them first.`);
		}
		regenerated = await resetRunPostPasses(broadsideDir, run, { synthesis: wantSynthesis, triage: wantTriage });
	}
	// A resumed collect polls nothing — every lens is already terminal — so the
	// findings the post-passes need have to come back off disk, or a run whose
	// first collect was interrupted could never produce its executive report
	// and work order, however many times it was re-run.
	const postPassUnfinished = (entry: BroadsideSynthesisEntry): boolean =>
		entry.status === "pending" || entry.status === "submitted";
	if ((wantSynthesis || wantTriage) && allLensResults.length === 0
		&& (postPassUnfinished(run.synthesis) || postPassUnfinished(run.triage))) {
		const restored = await loadSavedLensResults(runDir, run.lenses);
		if (restored.length > 0) {
			allLensResults.push(...restored);
			truncatedCount = restored.filter((s) => s.truncated).length;
		}
	}
	if ((wantSynthesis || wantTriage) && allLensResults.length > 0) {
		const allTerminal = run.lenses.every((lensId) => {
			const entry = run.batches[lensId];
			return entry && BROADSIDE_TERMINAL_ENTRY_STATUSES.includes(entry.status);
		});
		if (allTerminal && (postPassUnfinished(run.synthesis) || postPassUnfinished(run.triage))) {
			const findingsText = allLensResults
				.map((r) => `## ${r.lensId} — ${r.customId}\n\n${r.content}\n`)
				.join("\n");
			// A verify pass that ran before this point leaves its verdicts in the
			// run directory; the post-passes rank on them when present (#338).
			const verdicts = await loadPostPassVerdicts(runDir);
			const truncatedNote =
				truncatedCount > 0
					? `\n\nNOTE: ${truncatedCount} lens result(s) were truncated at the output token limit and are ` +
						"not included above. Any gap they would have covered is unrepresented — do not treat " +
						"silence on a module as a clean bill.\n"
					: "";

			// Both post-passes consume the same findings; they run as two
			// batches (different response_format schemas cannot share one)
			// submitted together and polled in turn.
			// Claim each wanted, still-pending pass before building its request:
			// a second collect on this run adopts the first one's entry instead
			// of submitting its own (#322). An abort submits nothing further.
			const passes: Array<{
				kind: "synthesis" | "triage";
				request: BatchRequest;
				entry: BroadsideSynthesisEntry;
			}> = [];
			for (const kind of ["synthesis", "triage"] as const) {
				const want = kind === "synthesis" ? wantSynthesis : wantTriage;
				if (!want || aborted()) continue;
				if ((kind === "synthesis" ? run.synthesis : run.triage).status !== "pending") continue;
				if (!(await claimRunSlot(broadsideDir, run, kind))) continue;
				owned.add(kind);
				const entry = kind === "synthesis" ? run.synthesis : run.triage;
				if (verdicts) entry.verdicts = verdicts.length;
				else delete entry.verdicts;
				passes.push({
					kind,
					request: kind === "synthesis"
						? buildSynthesisRequest(findingsText, truncatedNote, run.model, verdicts)
						: buildTriageRequest(findingsText, truncatedNote, run.model, verdicts),
					entry,
				});
			}

			const submitted = new Map<string, { batchId: string; pass: (typeof passes)[number] }>();

			// A pass can be left at "submitted" when an earlier collect returned
			// before its batch reached a terminal status — the batch still runs
			// and is still charged, so the result exists and is simply unclaimed.
			// Nothing above would ever look at it again: the pass list is built
			// from "pending" entries only. Poll those regardless of the want
			// flags, because the spend already happened and discarding a
			// finished result is worse than saving one the caller opted out of.
			for (const kind of ["synthesis", "triage"] as const) {
				const entry = kind === "synthesis" ? run.synthesis : run.triage;
				if (entry.status !== "submitted" || !entry.batchId) continue;
				if (submitted.has(entry.batchId)) continue;
				submitted.set(entry.batchId, {
					batchId: entry.batchId,
					pass: { kind, request: undefined as unknown as BatchRequest, entry },
				});
			}

			await Promise.allSettled(
				passes.map(async (pass) => {
					pass.entry.status = "submitted";
					try {
						const { batchId, error } = await submitBatch([pass.request], apiKey, opts.fetcher, run.model);
						if (error) {
							pass.entry.status = "failed";
							return;
						}
						pass.entry.batchId = batchId;
						submitted.set(batchId, { batchId, pass });
					} catch {
						pass.entry.status = "failed";
					}
				}),
			);
			await persist();

			// Poll both passes together against the shared deadline. Polled in
			// turn, the first pass could spend the whole budget and leave the
			// second a single poll (0.22.1 live run: triage settled, synthesis
			// left running though it had been submitted at the same moment).
			// A pass whose poll runs out stays `submitted`, so the batch is
			// already paid for and a later collect claims its result.
			const polledPasses = await pollBatchesConcurrently(
				[...submitted.values()].map(({ batchId, pass }) => ({ lensId: pass.kind as unknown as BroadsideLensId, batchId })),
				apiKey,
				{
					deadlineMs: Math.max(0, deadline - Date.now()),
					fetcher: opts.fetcher,
					pollIntervalMs: opts.pollIntervalMs,
					signal: opts.signal,
					onStatus: opts.onStatus,
				},
			);
			for (const { batchId, pass } of submitted.values()) {
				const batch = polledPasses.get(batchId) ?? { id: batchId, status: "timeout" };
				if (batch.status === "completed") {
					const usage = (batch.usage ?? {}) as Record<string, unknown>;
					const cost = typeof usage.cost === "number" ? usage.cost : undefined;
					pass.entry.status = "completed";
					pass.entry.cost = cost;
					const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
					const content = results.length > 0 ? extractContent(results[0]) : null;
					if (content !== null) {
						await writeFile(join(runDir, `${pass.kind}.json`), `${content}\n`, "utf8");
						await writeFile(join(runDir, `${pass.kind}.md`), renderFindingsMarkdown(content), "utf8");
						if (pass.kind === "synthesis") {
							topFindings = parseSynthesisTopFindings(content);
						} else {
							topTriageItems = parseTriageItems(content);
						}
					}
				} else if (BROADSIDE_DEAD_BATCH_STATUSES.includes(String(batch.status))) {
					// The batch will never produce a result, so retire the pass.
					// This used to require `batch.error`, leaving an expired or
					// cancelled batch parked at "submitted" forever — and since a
					// resumed collect re-polls anything still "submitted", it
					// would re-poll a dead batch on every future run.
					pass.entry.status = "failed";
					if (batch.error) pass.entry.error = batch.error instanceof Error ? batch.error.message : String(batch.error);
				}
				// A "timeout" is deliberately left at "submitted": the batch is
				// still running server-side and has already been paid for, so a
				// later collect should claim its result rather than discard it.
				await persist();
			}
		}
	}

	const terminal = run.lenses.every((lensId) => {
		const entry = run.batches[lensId];
		return entry && BROADSIDE_TERMINAL_ENTRY_STATUSES.includes(entry.status);
	});
	run.status = terminal ? (resultCount > 0 ? "completed" : "failed") : "partial";
	// The run's total is the sum of what its entries record, not of what this
	// collect happened to poll: a repeat collect used to report — and persist
	// — a total without the post-passes and the retry an earlier collect had
	// settled, so the recorded cost of a run went down each time it was read.
	totalCost += (run.retry?.cost ?? 0) + (run.synthesis.cost ?? 0) + (run.triage.cost ?? 0) + (run.retiredCost ?? 0);
	run.totalCost = totalCost;
	await persist();

	await writeFile(
		join(runDir, "run-meta.json"),
		`${JSON.stringify(
			{
				experimental: true,
				method: "Broad-Side (OpenRouter Batch API)",
				model: run.model,
				pricing: run.pricing,
				max_cost: run.maxCost,
				run_id: run.id,
				created_at: run.createdAt,
				status: run.status,
				total_cost: totalCost,
				result_count: resultCount,
				truncated_count: truncatedCount,
				retried_count: retriedCount,
				synthesis: run.synthesis,
				triage: run.triage,
				lenses: run.lenses,
				// Which lens ran on which model. Absent means the run default —
				// a reader comparing two runs needs to know a lens changed model.
				lens_models: Object.fromEntries(
					Object.entries(run.batches)
						.filter(([, batch]) => batch?.model)
						.map(([lensId, batch]) => [lensId, batch!.model]),
				),
				disclaimer:
					"Findings are unverified scouting signals from a batch model, not validated claims. " +
					"Re-verify every file:line lead with the interactive pipeline or by hand.",
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);

	return {
		runId: run.id,
		status: run.status,
		totalCost,
		resultCount,
		truncatedCount,
		retriedCount,
		...(retryElsewhere && { retryElsewhere: true }),
		lensOutcomes,
		synthesis: run.synthesis,
		triage: run.triage,
		topFindings,
		topTriageItems,
		...(regenerated.length > 0 && { regenerated }),
	};
}

export async function runBroadsideStatus(cwd: string): Promise<{ state: BroadsideStateFile }> {
	const broadsideDir = broadsideDirFor(cwd);
	const state = await loadBroadsideState(broadsideDir);
	return { state };
}
