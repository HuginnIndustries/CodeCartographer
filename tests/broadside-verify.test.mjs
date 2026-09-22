// The verification pass (#143): one sync call per finding with read-only
// tools confined to the repository, a verdict per finding, verified.md and
// verified.json beside triage.md, and a running cost cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { ProtocolError, ProtocolErrorCode } = await import("@modelcontextprotocol/server");
const {
	BROADSIDE_CHAT_URL, BROADSIDE_MODEL, BROADSIDE_VERIFY_MAX_TOOL_CALLS, BROADSIDE_VERIFY_SYSTEM_PROMPT,
	broadsideDirFor, createRepoReader, loadBroadsideState, rankVerifiableFindings, runBroadsideVerify, saveBroadsideState, syncModelFor, verifyResultText,
} = core;

process.env.OPENROUTER_API_KEY = "sk-fake";

function response(status, body) {
	return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A repository with a collected run on disk: two defect findings, one security finding, one truncated slice. */
async function collectedRun() {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-verify-"));
	await writeFile(join(dir, "package.json"), '{"name":"svc","type":"module"}\n');
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "src", "server.js"), "export function auth(req, token) {\n\treturn req.headers.authorization === `Bearer ${token}`;\n}\n");
	await writeFile(join(dir, "src", "store.js"), "export async function flush(file) {\n\tconst tmp = `${file}.tmp`;\n\treturn tmp;\n}\n");
	await writeFile(join(dir, ".env"), "SECRET=hunter2\n");
	const runId = "2026-09-13T00-00-00-000Z";
	const runDir = join(broadsideDirFor(dir), runId);
	await mkdir(runDir, { recursive: true });
	await writeFile(join(runDir, "defect-svc.json"), JSON.stringify({
		module: "svc",
		findings: [
			{ severity: "low", pattern: "Style", title: "Unused variable", location: "src/store.js:2", description: "tmp is returned, not unused." },
			{ severity: "high", pattern: "Race", title: "Shared temp file across flushes", location: "src/store.js:2", description: "Concurrent flushes share one .tmp path." },
		],
		patterns_checked: [], files_scanned: 2,
	}));
	await writeFile(join(runDir, "security-svc.json"), JSON.stringify({
		findings: [{ severity: "medium", category: "Authentication", title: "Timing-unsafe token comparison", location: "src/server.js:2", description: "=== on the bearer token." }],
		overall_assessment: "x", coverage_note: "y",
	}));
	await writeFile(join(runDir, "defect-other.json"), '{"module": "other", "findings": [', "utf8"); // truncated: ignored
	await saveBroadsideState(broadsideDirFor(dir), {
		schema_version: 1,
		runs: [{
			id: runId, createdAt: runId, model: BROADSIDE_MODEL, lenses: ["defect", "security"], status: "completed", outputDir: runId,
			batches: {
				defect: { batchId: "batch-d", requests: 2, status: "completed", submittedAt: runId, estimatedCost: 0.01, resultCount: 2 },
				security: { batchId: "batch-s", requests: 1, status: "completed", submittedAt: runId, estimatedCost: 0.01, resultCount: 1 },
			},
			synthesis: { status: "completed", cost: 0.001 }, triage: { status: "completed", cost: 0.001 },
		}],
	});
	return { dir, runId, runDir };
}

/**
 * A fake chat endpoint. For each finding it first asks to read the cited file
 * (a tool call), then answers with the verdict scripted for that title —
 * as prose when `prose` is set, to exercise the schema-forced follow-up.
 */
function chatFetcher(verdicts, { prose = false, endlessTools = false, costPerCall = 0.01 } = {}) {
	const calls = [];
	const fetcher = async (url, init) => {
		assert.equal(String(url), BROADSIDE_CHAT_URL);
		const body = JSON.parse(init.body);
		calls.push(body);
		const userTurn = body.messages.find((m) => m.role === "user" && /^Finding \d+/.test(String(m.content)));
		const title = /Title: (.*)/.exec(String(userTurn.content))[1];
		const location = /Location: (.*)/.exec(String(userTurn.content))[1];
		const toolTurns = body.messages.filter((m) => m.role === "tool").length;
		const wantsTools = Array.isArray(body.tools);
		if (wantsTools && (toolTurns === 0 || endlessTools)) {
			const [path] = location.split(":");
			return response(200, {
				choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `call-${toolTurns + 1}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path, start_line: 1, end_line: 5 }) } }] } }],
				usage: { cost: costPerCall },
			});
		}
		const verdict = verdicts[title] ?? { verdict: "unclear", confidence: "low", evidence: [], reasoning: "unscripted" };
		const content = prose && !body.response_format ? `I read it. My verdict is ${verdict.verdict}.` : JSON.stringify(verdict);
		return response(200, { choices: [{ message: { role: "assistant", content } }], usage: { cost: costPerCall } });
	};
	return { fetcher, calls };
}

const VERDICTS = {
	"Shared temp file across flushes": { verdict: "confirmed", confidence: "high", evidence: [{ file: "src/store.js", lines: "1-4", note: "one tmp path per file, no per-call suffix" }], reasoning: "Two concurrent flushes of one file write the same tmp path." },
	"Timing-unsafe token comparison": { verdict: "confirmed", confidence: "high", evidence: [{ file: "src/server.js", lines: "2", note: "===" }], reasoning: "Plain equality on the secret." },
	"Unused variable": { verdict: "discarded", confidence: "high", evidence: [{ file: "src/store.js", lines: "2-3", note: "returned" }], reasoning: "tmp is returned on the next line." },
};

test("findings are ranked most severe first across the verifiable lenses, truncated slices skipped", async () => {
	const { dir, runDir, runId } = await collectedRun();
	try {
		const stored = await core.loadSavedLensResults(runDir, ["defect", "security"]);
		const ranked = rankVerifiableFindings(stored);
		assert.deepEqual(ranked.map((f) => [f.severity, f.title]), [
			["high", "Shared temp file across flushes"],
			["medium", "Timing-unsafe token comparison"],
			["low", "Unused variable"],
		]);
		assert.equal(ranked[1].pattern, "Authentication", "a security category stands in for the defect pattern");
		assert.equal(syncModelFor("google/gemini-3.7-flash:batch"), "google/gemini-3.7-flash");
		assert.equal(syncModelFor("vendor/plain"), "vendor/plain");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the reader is confined to the repository's readable source files", async () => {
	const { dir } = await collectedRun();
	try {
		const reader = await createRepoReader(dir);
		assert.match(await reader.readFile("src/server.js", 1, 2), /^1: export function auth/);
		assert.match(await reader.readFile("src/server.js", 2), /^2: /);
		assert.match(await reader.readFile(".env"), /not a readable source file/, "a credential store is never readable");
		await assert.rejects(reader.readFile("../../etc/passwd"), /outside the repository/);
		await assert.rejects(reader.readFile("/etc/passwd"), /outside the repository/);
		assert.match(await reader.readFile("src/server.js", 99), /has 4 lines/);
		assert.match(await reader.grep("Bearer"), /^src\/server\.js:2: /);
		assert.match(await reader.grep("hunter2"), /no matches/, "grep does not see the credential store either");
		assert.match(await reader.grep("("), /invalid pattern/);
		assert.match(await reader.grep("function", "src"), /store\.js/);
		assert.equal(await reader.listDir("."), "package.json\nsrc/");
		assert.equal(await reader.listDir("src"), "server.js\nstore.js");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("verify reads the top findings with tools, records a verdict each, and writes verified.md beside triage", async () => {
	const { dir, runDir, runId } = await collectedRun();
	try {
		const { fetcher, calls } = chatFetcher(VERDICTS);
		const seen = [];
		const result = await runBroadsideVerify(dir, "sk-fake", { fetcher, onProgress: (f) => seen.push(f.verdict) });
		assert.equal(result.status, "completed");
		assert.equal(result.candidates, 3);
		assert.equal(result.model, "google/gemini-3.7-flash", "the run's :batch model, used sync");
		assert.deepEqual(result.findings.map((f) => [f.index, f.verdict, f.toolCalls]), [[1, "confirmed", 1], [2, "confirmed", 1], [3, "discarded", 1]]);
		assert.deepEqual(seen, ["confirmed", "confirmed", "discarded"]);
		assert.ok(Math.abs(result.totalCost - 0.06) < 1e-9, "two calls per finding at a cent each");

		// What went over the wire: the rubric, low effort, usage accounting, the tools.
		const first = calls[0];
		assert.equal(first.model, "google/gemini-3.7-flash");
		assert.equal(first.messages[0].content, BROADSIDE_VERIFY_SYSTEM_PROMPT);
		assert.deepEqual(first.reasoning, { effort: "low" });
		assert.deepEqual(first.usage, { include: true });
		assert.deepEqual(first.tools.map((t) => t.function.name), ["read_file", "grep", "list_dir"]);
		// The tool result reached the second call as a tool message with the numbered lines.
		const second = calls[1];
		const toolMsg = second.messages.find((m) => m.role === "tool");
		assert.match(toolMsg.content, /^1: export async function flush/);

		// Outputs beside the run.
		const md = await readFile(join(runDir, "verified.md"), "utf8");
		assert.match(md, /^# Verified findings — run 2026-09-13T00-00-00-000Z/);
		assert.match(md, /## ✓ 1\. \[high\] Shared temp file across flushes/);
		assert.match(md, /## ✗ 3\. \[low\] Unused variable/);
		assert.match(md, /src\/store\.js:1-4 — one tmp path per file/);
		const json = JSON.parse(await readFile(join(runDir, "verified.json"), "utf8"));
		assert.equal(json.confirmed, 2);
		assert.equal(json.findings.length, 3);
		// Recorded on the run, and status prints it.
		const state = await loadBroadsideState(broadsideDirFor(dir));
		assert.equal(state.runs[0].verify.status, "completed");
		assert.equal(state.runs[0].verify.confirmed, 2);
		assert.match(core.statusText(state), /verify: completed — 2 confirmed of 3 read on google\/gemini-3\.7-flash/);
		// And the report.
		const text = verifyResultText(result);
		assert.match(text, /confirmed 2 · not-a-defect 0 · discarded 1 · unclear 0/);
		assert.match(text, /✓ \[high\] Shared temp file across flushes @ src\/store\.js:2 — confirmed/);
		assert.match(text, /verified\.md/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a prose answer gets one schema-forced follow-up; a model that never stops calling tools is cut off at the budget", async () => {
	const { dir } = await collectedRun();
	try {
		const prose = chatFetcher(VERDICTS, { prose: true });
		const result = await runBroadsideVerify(dir, "sk-fake", { fetcher: prose.fetcher, top: 1 });
		assert.equal(result.findings[0].verdict, "confirmed");
		const forced = prose.calls.find((c) => c.response_format);
		assert.ok(forced, "a schema-forced call followed the prose");
		assert.equal(forced.tools, undefined, "the forced call carries no tools");

		const endless = chatFetcher(VERDICTS, { endlessTools: true });
		const cut = await runBroadsideVerify(dir, "sk-fake", { fetcher: endless.fetcher, top: 1 });
		assert.equal(cut.findings[0].toolCalls, BROADSIDE_VERIFY_MAX_TOOL_CALLS, "no more tool calls than the budget");
		assert.equal(cut.findings[0].verdict, "confirmed", "the budget-spent call still yields the verdict");
		const last = endless.calls.at(-1);
		assert.ok(last.response_format && !last.tools, "the final call is schema-forced with no tools");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("max_cost is a running cap: the pass stops before the next finding and reports partial", async () => {
	const { dir } = await collectedRun();
	try {
		const { fetcher } = chatFetcher(VERDICTS, { costPerCall: 0.01 });
		// Each finding costs $0.02; a cap of $0.03 admits the first, then the
		// running total (0.02) is under the cap so the second starts, and the
		// third is refused at 0.04.
		const result = await runBroadsideVerify(dir, "sk-fake", { fetcher, maxCost: 0.03 });
		assert.equal(result.findings.length, 2);
		assert.equal(result.status, "partial");
		assert.equal(result.stoppedByCost, true);
		assert.match(verifyResultText(result), /stopped by the cost cap/);
		// An abort stops it too, without the cost flag.
		const controller = new AbortController();
		controller.abort();
		const aborted = await runBroadsideVerify(dir, "sk-fake", { fetcher, signal: controller.signal });
		assert.equal(aborted.findings.length, 0);
		assert.equal(aborted.status, "partial");
		assert.equal(aborted.stoppedByCost, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a provider error on one finding is recorded as its verdict, not thrown", async () => {
	const { dir } = await collectedRun();
	try {
		let n = 0;
		const fetcher = async () => {
			n += 1;
			return response(429, { error: { message: "rate limited" } });
		};
		const result = await runBroadsideVerify(dir, "sk-fake", { fetcher, top: 1 });
		assert.equal(result.findings[0].verdict, "error");
		assert.match(result.findings[0].reasoning, /HTTP 429: rate limited/);
		assert.equal(n, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("verify refuses a run with nothing verifiable, and an unknown run id", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-verify-empty-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		const runId = "2026-01-01T00-00-00-000Z";
		await mkdir(join(broadsideDirFor(dir), runId), { recursive: true });
		await saveBroadsideState(broadsideDirFor(dir), {
			schema_version: 1,
			runs: [{ id: runId, createdAt: runId, model: BROADSIDE_MODEL, lenses: ["architecture"], status: "completed", outputDir: runId, batches: {}, synthesis: { status: "pending" }, triage: { status: "pending" } }],
		});
		await assert.rejects(runBroadsideVerify(dir, "sk-fake", {}), /no verifiable findings on disk/);
		await assert.rejects(runBroadsideVerify(dir, "sk-fake", { runId: "nope" }), /No Broad-Side run with id nope/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function withGlobalFetch(fetcher, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = fetcher;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

test("codecarto_broadside verify: parameters validated, verdicts in text and structured content", async () => {
	const { dir } = await collectedRun();
	try {
		const { fetcher } = chatFetcher(VERDICTS);
		await withGlobalFetch(fetcher, async () => {
			for (const [args, pattern] of [[{ top: 0 }, /top must be a positive integer/], [{ top: 1.5 }, /top must be a positive integer/], [{ model: " " }, /model must be a non-empty/]]) {
				await assert.rejects(
					server.handleBroadside({ cwd: dir, action: "verify", ...args }),
					(error) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams && pattern.test(error.message),
				);
			}
			const result = await server.handleBroadside({ cwd: dir, action: "verify", top: 2, max_cost: 0 });
			assert.match(result.content[0].text, /^Broad-Side verify — run 2026-09-13T00-00-00-000Z: completed/);
			assert.equal(result.structuredContent.findings.length, 2);
			assert.equal(result.structuredContent.findings[0].verdict, "confirmed");
			assert.equal(result.structuredContent.model, "google/gemini-3.7-flash");
			// The tool's schema admits the action and the parameter (read from
			// the source: the tool list is not exported).
			const source = await readFile(join(REPO_ROOT, "mcp-server", "server.ts"), "utf8");
			assert.match(source, /enum: \["submit", "collect", "status", "models", "verify"\]/);
			assert.match(source, /top: \{\s*type: "integer"/);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("/codecarto-broadside verify --top=2 reads two findings and reports them", async () => {
	const { dir } = await collectedRun();
	try {
		const { fetcher } = chatFetcher(VERDICTS);
		await withGlobalFetch(fetcher, async () => {
			const commands = new Map();
			const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
			const ui = { widgets: [], notifications: [], theme: { fg: (_n, t) => t }, setStatus: () => {}, setWidget: (id, value) => ui.widgets.push({ id, value }), notify: (message, level) => ui.notifications.push({ message, level }), confirm: async () => true };
			const ctx = { cwd: dir, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
			codeCartographerExtension(pi);
			await commands.get("codecarto-broadside").handler("verify --top=2 --max-cost=0", ctx);
			const errors = ui.notifications.filter((n) => n.level === "error");
			assert.deepEqual(errors, []);
			assert.ok(ui.notifications.some((n) => /Broad-Side verify: 2 confirmed of 2 read/.test(n.message)), JSON.stringify(ui.notifications.map((n) => n.message)));
			assert.ok(ui.widgets.some((w) => Array.isArray(w.value) && w.value.some((line) => /Verifying findings… 1 read/.test(line))), "the widget counts verdicts as they land");
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- #358: tool output is redacted before it reaches the model ----------

test("the reader redacts secret-shaped values in read_file and grep output, and the pass reports it", async () => {
	const { dir, runDir, runId } = await collectedRun();
	try {
		// An ordinary source file — not a credential store, so isSlurpable keeps
		// it readable — carrying a value the redaction pass recognizes.
		await writeFile(join(dir, "src", "config.js"), 'export const api_key = "sk-abcdefghijklmnopqrstuvwxyz1234";\nexport const region = "eu";\n', "utf8");
		const reader = await core.createRepoReader(dir);
		const read = await reader.readFile("src/config.js", 1, 2);
		assert.doesNotMatch(read, /sk-abcdefghijklmnopqrstuvwxyz1234/, "the raw key never leaves the reader");
		assert.match(read, /1: export const api_key = "\[REDACTED:/);
		assert.match(read, /2: export const region = "eu";/, "the rest of the line and file are untouched");
		const grepped = await reader.grep("api_key");
		assert.doesNotMatch(grepped, /sk-abcdefghijklmnopqrstuvwxyz1234/);
		assert.match(grepped, /^src\/config\.js:1: export const api_key = "\[REDACTED:/);
		assert.equal(reader.redactions.values, 2, "one value in the read, one in the grep");
		assert.deepEqual([...reader.redactions.files], ["src/config.js"]);

		// Off by config: the value passes through, and the run record says so.
		const raw = await core.createRepoReader(dir, { redact: false });
		assert.match(await raw.readFile("src/config.js", 1, 1), /sk-abcdefghijklmnopqrstuvwxyz1234/);
		assert.equal(raw.redactions.values, 0);

		// End to end: a finding that points at the file; the model's read comes back redacted
		// and the message that carries it to the provider holds no secret.
		await writeFile(join(runDir, "security-svc.json"), JSON.stringify({
			module: "svc",
			findings: [{ severity: "high", category: "Secrets", title: "Hardcoded API key", location: "src/config.js:1", description: "A key in source." }],
		}), "utf8");
		const { fetcher, calls } = chatFetcher({ "Hardcoded API key": { verdict: "confirmed", confidence: "high", evidence: [{ file: "src/config.js", lines: "1", note: "literal" }], reasoning: "The key is in the file." } });
		const result = await runBroadsideVerify(dir, "sk-fake", { runId, top: 1, fetcher });
		const toolMessages = calls.flatMap((c) => c.messages.filter((m) => m.role === "tool"));
		assert.ok(toolMessages.length > 0, "the scripted model read the file");
		for (const m of toolMessages) assert.doesNotMatch(String(m.content), /sk-abcdefghijklmnopqrstuvwxyz1234/, "no message to the provider carries the raw key");
		assert.match(toolMessages[0].content, /\[REDACTED:sk-api-key\]/);
		assert.equal(result.redactedValues, 1);
		assert.match(core.verifyResultText(result), /1 secret-like value\(s\) redacted from tool output before upload/);
		assert.match(await readFile(join(runDir, "verified.md"), "utf8"), /redacted from tool output/);
		const { state } = await core.runBroadsideStatus(dir);
		assert.equal(state.runs.at(-1).verify.redactedValues, 1, "recorded on the run");

		// redact_secrets: false in config.yaml turns it off for verify the way it does for submit.
		await writeFile(join(core.broadsideDirFor(dir), "config.yaml"), "redact_secrets: false\n", "utf8");
		const { fetcher: rawFetcher, calls: rawCalls } = chatFetcher({ "Hardcoded API key": { verdict: "confirmed", confidence: "high", evidence: [], reasoning: "r" } });
		const rawResult = await runBroadsideVerify(dir, "sk-fake", { runId, top: 1, fetcher: rawFetcher });
		assert.match(rawCalls.flatMap((c) => c.messages.filter((m) => m.role === "tool"))[0].content, /sk-abcdefghijklmnopqrstuvwxyz1234/);
		assert.equal(rawResult.redactedValues, 0);
		assert.doesNotMatch(core.verifyResultText(rawResult), /redacted from tool output/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
