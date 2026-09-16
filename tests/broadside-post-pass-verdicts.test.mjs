// The synthesis and triage passes are built from a verify pass's verdicts
// when verified.json exists, and `collect --regenerate` re-runs them so a
// run verified after its first collect gets a work order ranked on verdicts
// (#338). Also the accounting this exposed: a repeat collect used to report
// and persist a run total without the post-passes an earlier collect had
// settled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { broadsideDirFor, collectResultText, loadBroadsideState, loadPostPassVerdicts, renderPostPassVerdicts, runBroadsideCollect, runBroadsideSubmit, statusText } = core;

process.env.OPENROUTER_API_KEY = "sk-fake";

const LENS_JSON = JSON.stringify({ module: "root", findings: [], patterns_checked: [], files_scanned: 0 });

async function withRepo(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-verdicts-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

function response(status, body) {
	return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

/**
 * A fake OpenRouter where every batch completes on its first poll, with a
 * synthesis/triage body that names its verdict provenance so the test can
 * see which request produced which file. `hold` keeps named kinds in
 * progress until released.
 */
function instantFetcher({ hold = new Set(), wrap = (kind, json) => json } = {}) {
	const posted = [];
	const fetcher = async (url, init) => {
		if (init?.method === "POST") {
			posted.push(JSON.parse(init.body));
			return response(202, { id: `batch-${posted.length}`, status: "validating" });
		}
		if (String(url).includes("/models")) return response(200, { data: [] });
		const index = Number(String(url).split("/").pop().replace(/^batch-/, "")) - 1;
		const payload = posted[index];
		const kind = payload.requests[0].custom_id;
		if (hold.has(kind)) return response(200, { id: `batch-${index + 1}`, status: "in_progress", request_counts: { completed: 0, total: 1 } });
		const withVerdicts = /## Verification verdicts/.test(payload.requests[0].body.messages[1].content);
		const content = kind === "synthesis"
			? wrap(kind, JSON.stringify({ executive_summary: withVerdicts ? "built from verdicts" : "unverified", severity_summary: { critical: 0, high: 0, medium: 1, low: 0 }, top_findings: [{ title: withVerdicts ? "verified: confirmed — the lock" : "the lock", severity: "medium", source_lens: "defect", summary: "s" }] }))
			: kind === "triage"
				? wrap(kind, JSON.stringify({ summary: withVerdicts ? "built from verdicts" : "unverified", items: [{ title: "the lock", severity: "medium", module: "core", impact: "high", difficulty: "low", priority: "P1", rationale: withVerdicts ? "verified: confirmed — trigger" : "unverified" }] }))
				: LENS_JSON;
		return response(200, {
			id: `batch-${index + 1}`,
			status: "completed",
			results: payload.requests.map((r) => ({ custom_id: r.custom_id, response: { status_code: 200, body: { choices: [{ message: { content } }] } }, error: null })),
			usage: { cost: kind === "synthesis" ? 0.01 : kind === "triage" ? 0.02 : 0.005 },
		});
	};
	return { fetcher, posted, postsOf: (kind) => posted.filter((p) => p.requests[0].custom_id === kind), hold };
}

const VERIFIED = {
	status: "completed", model: "google/gemini-3.7-flash", top: 10, verified: 3, confirmed: 1, cost: 0.03, at: "2026-09-14T00:00:00.000Z",
	run_id: "x", candidates: 3,
	findings: [
		{ index: 1, lensId: "defect", customId: "defect-core-1", severity: "medium", title: "Outcome resolved outside the lock", location: "core/amendment.ts:141", verdict: "confirmed", confidence: "high", evidence: [{ file: "core/amendment.ts", lines: "141-160", note: "check before lock" }], reasoning: "A status change between the read and the lock is amended over.", toolCalls: 3, cost: 0.01 },
		{ index: 2, lensId: "defect", customId: "defect-core-2", severity: "medium", title: "PathLike cast", location: "core/orchestrator-config.ts:98", verdict: "not-a-defect", confidence: "high", evidence: [], reasoning: "Every caller passes a string.", toolCalls: 2, cost: 0.01 },
		{ index: 3, lensId: "security", customId: "security-root", severity: "low", title: "Dangling listener", location: "core/broadside.ts:1330", verdict: "discarded", confidence: "high", evidence: [{ file: "core/broadside.ts", lines: "1325-1335", note: "removed on the timer path" }], reasoning: "The listener is removed.", toolCalls: 1, cost: 0.01 },
	],
};

async function runDirOf(dir) {
	const run = (await loadBroadsideState(broadsideDirFor(dir))).runs.at(-1);
	return { run, runDir: join(broadsideDirFor(dir), run.outputDir) };
}

test("the post-passes are built from verified.json when it exists, and say so everywhere", async () => {
	await withRepo(async (dir) => {
		const { fetcher, postsOf } = instantFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const { runDir } = await runDirOf(dir);
		await writeFile(join(runDir, "verified.json"), JSON.stringify(VERIFIED, null, "\t"), "utf8");

		const result = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 5_000 });
		assert.equal(result.status, "completed");
		for (const kind of ["synthesis", "triage"]) {
			const [request] = postsOf(kind)[0].requests;
			const [systemMsg, userMsg] = request.body.messages;
			assert.match(systemMsg.content, /A verification pass has read some of the findings against the source/, `${kind} system prompt`);
			assert.match(userMsg.content, /## Verification verdicts \(3 finding\(s\) read against the source by a read-only-tools pass: 1 confirmed, 1 not-a-defect, 1 discarded\)/, `${kind} user message`);
			assert.match(userMsg.content, /- \[confirmed, high confidence\] defect\/defect-core-1 — \[medium\] Outcome resolved outside the lock @ core\/amendment\.ts:141\n  Reasoning: A status change between the read and the lock is amended over\.\n  Evidence: core\/amendment\.ts:141-160 \(check before lock\)/);
			assert.match(userMsg.content, /- \[discarded, high confidence\] security\/security-root — \[low\] Dangling listener/);
			assert.equal(result[kind].verdicts, 3, `${kind} entry records the verdict count`);
		}
		assert.match(postsOf("triage")[0].requests[0].body.messages[0].content, /put the confirmed findings at the top of the queue/);
		assert.match(postsOf("synthesis")[0].requests[0].body.messages[0].content, /Lead top_findings with the confirmed findings/);

		const text = collectResultText(result);
		assert.match(text, /synthesis: completed, \$0\.010000 \(built from 3 verdicts\)/);
		assert.match(text, /Top findings \(verdicts applied; unread ones are unverified leads\):\n  \[medium\] verified: confirmed — the lock/);
		assert.match(text, /triage: completed, \$0\.020000 \(built from 3 verdicts\)/);
		assert.match(text, /Triage — prioritized work order \(confirmed findings first; re-verify the unread ones before acting\):/);
		assert.doesNotMatch(text, /collect --regenerate/, "no hint to regenerate what was built from verdicts");
		const { state } = await core.runBroadsideStatus(dir);
		assert.match(statusText(state), /synthesis: completed \(built from 3 verdicts\)\n  triage: completed \(built from 3 verdicts\)/);
		assert.match(await readFile(join(runDir, "run-meta.json"), "utf8"), /"verdicts": 3/);
	});
});

test("without verified.json the post-pass prompts are exactly what they were, and the report says no verdicts", async () => {
	await withRepo(async (dir) => {
		const { fetcher, postsOf } = instantFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const result = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 5_000 });
		const synthesis = postsOf("synthesis")[0].requests[0].body.messages;
		const triage = postsOf("triage")[0].requests[0].body.messages;
		assert.match(synthesis[0].content, /note that in the summary\.$/);
		assert.match(triage[0].content, /inflate a severity you cannot see evidence for\.$/);
		for (const [, user] of [synthesis, triage]) {
			assert.doesNotMatch(user.content, /Verification verdicts/);
			assert.match(user.content, /\n\nReturn the (synthesis|triage)_report JSON schema\.$/);
		}
		assert.equal(result.synthesis.verdicts, undefined);
		assert.equal(result.triage.verdicts, undefined);
		const text = collectResultText(result);
		assert.match(text, /synthesis: completed, \$0\.010000 \(no verdicts\)/);
		assert.match(text, /Top findings \(unverified leads\):/);
		assert.match(text, /Run verify, then collect --regenerate, to rebuild the report and the work order from verdicts\./);

		// A verified.json that does not parse is treated as absent.
		const { runDir } = await runDirOf(dir);
		await writeFile(join(runDir, "verified.json"), "{not json", "utf8");
		assert.equal(await loadPostPassVerdicts(runDir), null);
		await writeFile(join(runDir, "verified.json"), JSON.stringify({ findings: [] }), "utf8");
		assert.equal(await loadPostPassVerdicts(runDir), null, "no findings is no verdicts");
	});
});

test("collect --regenerate resets the settled passes, re-runs them with the verdicts, and keeps the money spent in the total", async () => {
	await withRepo(async (dir) => {
		const { fetcher, posted, postsOf } = instantFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const first = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 5_000 });
		assert.equal(first.synthesis.verdicts, undefined);
		assert.equal(first.totalCost.toFixed(3), "0.035", "lens 0.005 + synthesis 0.01 + triage 0.02");
		const { runDir } = await runDirOf(dir);
		assert.match(await readFile(join(runDir, "synthesis.json"), "utf8"), /unverified/);

		// A repeat collect reports the same total (it used to drop the post-passes).
		const again = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 5_000 });
		assert.equal(again.totalCost.toFixed(3), "0.035");
		assert.equal(again.regenerated, undefined);
		assert.equal(posted.length, 3, "a repeat collect submits nothing");

		// verify ran: regenerate rebuilds both passes from its verdicts.
		await writeFile(join(runDir, "verified.json"), JSON.stringify(VERIFIED), "utf8");
		const regenerated = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 5_000, regeneratePostPasses: true });
		assert.deepEqual(regenerated.regenerated, ["synthesis", "triage"]);
		assert.equal(postsOf("synthesis").length, 2);
		assert.equal(postsOf("triage").length, 2);
		assert.equal(regenerated.synthesis.verdicts, 3);
		assert.equal(regenerated.triage.verdicts, 3);
		assert.equal(regenerated.synthesis.batchId, "batch-4", "a new batch, not the first one's");
		assert.equal(regenerated.totalCost.toFixed(3), "0.065", "lens 0.005 + retired 0.03 + synthesis 0.01 + triage 0.02");
		assert.match(await readFile(join(runDir, "synthesis.json"), "utf8"), /built from verdicts/);
		assert.match(await readFile(join(runDir, "triage.json"), "utf8"), /verified: confirmed — trigger/);
		const text = collectResultText(regenerated);
		assert.match(text, /regenerated: synthesis, triage/);
		assert.match(text, /Total cost: \$0\.065000/);
		const run = (await loadBroadsideState(broadsideDirFor(dir))).runs.at(-1);
		assert.equal(run.retiredCost.toFixed(3), "0.030");
		assert.equal(run.totalCost.toFixed(3), "0.065");
		assert.equal(run.synthesis.status, "completed");

		// Only the wanted pass is reset; the other keeps its result and cost.
		const onlyTriage = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 5_000, regeneratePostPasses: true, includeSynthesis: false });
		assert.deepEqual(onlyTriage.regenerated, ["triage"]);
		assert.equal(postsOf("synthesis").length, 2);
		assert.equal(postsOf("triage").length, 3);
		assert.equal(onlyTriage.totalCost.toFixed(3), "0.085");

		// Nothing wanted: refused before anything is touched.
		await assert.rejects(
			runBroadsideCollect(dir, "sk-fake", { fetcher, regeneratePostPasses: true, includeSynthesis: false, includeTriage: false }),
			/Nothing to regenerate/,
		);
		assert.equal(posted.length, 6);
	});
});

test("a regenerate leaves a pass in flight alone and refuses a run whose lens batches are still running", async () => {
	await withRepo(async (dir) => {
		const { fetcher, postsOf, hold } = instantFetcher({ hold: new Set(["architecture-root", "triage"]) });
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		await assert.rejects(
			runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 50, regeneratePostPasses: true }),
			/Cannot regenerate the post-passes of run .*: its lens batches are still running/,
		);
		hold.delete("architecture-root");
		// Lens settles; triage stays in flight (its poll runs out), synthesis completes.
		const first = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 150 });
		assert.equal(first.synthesis.status, "completed");
		assert.equal(first.triage.status, "submitted");
		const regenerated = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 150, regeneratePostPasses: true });
		assert.deepEqual(regenerated.regenerated, ["synthesis"], "the in-flight triage is not reset");
		assert.equal(postsOf("synthesis").length, 2);
		assert.equal(postsOf("triage").length, 1);
		assert.match(collectResultText(regenerated), /triage: still running — collect again for its result\./);
		hold.delete("triage");
		const settled = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 10, waitMs: 5_000 });
		assert.equal(settled.triage.status, "completed");
		assert.equal(settled.triage.batchId, "batch-3", "the first triage's batch, claimed by the later collect");
	});
});

test("renderPostPassVerdicts lists each verdict with what the verifier cited", () => {
	const text = renderPostPassVerdicts([
		{ lensId: "defect", customId: "defect-a", severity: "high", title: "T", location: "a.ts:1", verdict: "unclear", confidence: "", evidence: [], reasoning: "  needs\n runtime  " },
		{ lensId: "defect", customId: "defect-b", severity: "low", title: "U", location: "", verdict: "error", confidence: "low", evidence: [{ file: "b.ts", lines: "", note: "" }], reasoning: "" },
	]);
	assert.match(text, /^\n## Verification verdicts \(2 finding\(s\) read against the source by a read-only-tools pass: 1 unclear, 1 error\)\n/);
	assert.match(text, /- \[unclear\] defect\/defect-a — \[high\] T @ a\.ts:1\n  Reasoning: needs runtime\n/);
	assert.match(text, /- \[error, low confidence\] defect\/defect-b — \[low\] U\n  Evidence: b\.ts\n/);
	assert.match(text, /`error` means the pass could not read it — treat that finding as unverified/);
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

test("codecarto_broadside collect: regenerate_post_passes is validated and reported", async () => {
	await withRepo(async (dir) => {
		const { fetcher } = instantFetcher();
		await withGlobalFetch(fetcher, async () => {
			await server.handleBroadside({ cwd: dir, action: "submit", lenses: ["architecture"], max_cost: 0 });
			await server.handleBroadside({ cwd: dir, action: "collect", wait_seconds: 5 });
			const { runDir } = await runDirOf(dir);
			await writeFile(join(runDir, "verified.json"), JSON.stringify(VERIFIED), "utf8");
			await assert.rejects(
				server.handleBroadside({ cwd: dir, action: "collect", regenerate_post_passes: "yes" }),
				(error) => error instanceof McpError && error.code === ErrorCode.InvalidParams && /must be a boolean/.test(error.message),
			);
			await assert.rejects(
				server.handleBroadside({ cwd: dir, action: "collect", regenerate_post_passes: true, include_synthesis: false, include_triage: false }),
				(error) => error instanceof McpError && error.code === ErrorCode.InvalidParams && /needs at least one of/.test(error.message),
			);
			const result = await server.handleBroadside({ cwd: dir, action: "collect", regenerate_post_passes: true, wait_seconds: 5 });
			assert.deepEqual(result.structuredContent.regenerated, ["synthesis", "triage"]);
			assert.equal(result.structuredContent.triage.verdicts, 3);
			assert.match(result.content[0].text, /regenerated: synthesis, triage/);
			const source = await readFile(join(REPO_ROOT, "mcp-server", "server.ts"), "utf8");
			assert.match(source, /regenerate_post_passes: \{\s*type: "boolean"/);
		});
	});
});

function createHarness(cwd) {
	const commands = new Map();
	const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
	const ui = {
		widgets: [], notifications: [],
		theme: { fg: (_name, text) => text }, setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async () => true,
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, ctx, ui };
}

test("/codecarto-broadside collect --regenerate rebuilds the passes from the verdicts", async () => {
	await withRepo(async (dir) => {
		const { fetcher, postsOf } = instantFetcher();
		await withGlobalFetch(fetcher, async () => {
			const { commands, ctx, ui } = createHarness(dir);
			await commands.get("codecarto-broadside").handler("submit architecture --max-cost=0 --wait=5", ctx);
			const { runDir } = await runDirOf(dir);
			await writeFile(join(runDir, "verified.json"), JSON.stringify(VERIFIED), "utf8");
			await commands.get("codecarto-broadside").handler("collect --regenerate --wait=5", ctx);
			assert.equal(postsOf("triage").length, 2);
			const widget = ui.widgets.at(-1)?.value ?? "";
			const shown = [widget, ...ui.notifications.map((n) => n.message)].join("\n");
			assert.match(shown, /regenerated: synthesis, triage/);
			assert.match(shown, /built from 3 verdicts/);
		});
	});
});

// ---------- #366: post-pass replies get the lens path's JSON tolerance ----------

test("a fenced post-pass reply is read as JSON; one that is not JSON fails the pass and says so", async () => {
	await withRepo(async (dir) => {
		// Fenced: both passes parse and the top items are populated.
		const fenced = instantFetcher({ wrap: (kind, json) => "```json\n" + json + "\n```" });
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: fenced.fetcher, maxCost: 0 });
		const ok = await runBroadsideCollect(dir, "sk-fake", { fetcher: fenced.fetcher, pollIntervalMs: 10, waitMs: 5_000 });
		assert.equal(ok.synthesis.status, "completed");
		assert.deepEqual(ok.topFindings.map((f) => f.title), ["the lock"]);
		assert.equal(ok.topTriageItems.length, 1);
		const { runDir } = await runDirOf(dir);
		assert.doesNotMatch(await readFile(join(runDir, "synthesis.json"), "utf8"), /```/, "the stored file is the JSON, fence stripped");
	});
	await withRepo(async (dir) => {
		// Prose: the pass is failed with a reason, the raw text kept, no empty "completed".
		const prose = instantFetcher({ wrap: (kind) => `I could not produce the ${kind} report in time.` });
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: prose.fetcher, maxCost: 0 });
		const bad = await runBroadsideCollect(dir, "sk-fake", { fetcher: prose.fetcher, pollIntervalMs: 10, waitMs: 5_000 });
		assert.equal(bad.synthesis.status, "failed");
		assert.match(bad.synthesis.error, /was not a JSON object/);
		assert.equal(bad.triage.status, "failed");
		assert.deepEqual(bad.topFindings, []);
		const { runDir } = await runDirOf(dir);
		assert.match(await readFile(join(runDir, "synthesis.raw.txt"), "utf8"), /could not produce the synthesis/);
		assert.equal((await import("node:fs")).existsSync(join(runDir, "synthesis.json")), false);
		assert.match(collectResultText(bad), /synthesis: failed — the reply was not a JSON object/);
	});
});

// ---------- #367: two submits in one millisecond are two runs ----------

test("run ids carry a random suffix, so two submits in the same millisecond are two runs with two directories", async () => {
	await withRepo(async (dir) => {
		const { fetcher } = instantFetcher();
		const [a, b] = await Promise.all([
			runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 }),
			runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 }),
		]);
		assert.notEqual(a.runId, b.runId);
		assert.match(a.runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{4}$/);
		const runs = (await loadBroadsideState(broadsideDirFor(dir))).runs.map((r) => r.id);
		assert.deepEqual(new Set(runs).size, 2, "both runs are on record");
		const { readdir } = await import("node:fs/promises");
		const dirs = (await readdir(broadsideDirFor(dir))).filter((name) => name.endsWith("Z") || /Z-[0-9a-f]{4}$/.test(name));
		assert.equal(dirs.length, 2, "each run has its own directory");
	});
});
