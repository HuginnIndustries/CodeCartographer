// Two collects on one run, and a collect whose client went away (#322).
//
// Seen live on the 0.22.1 verification: a client's request timeout fired
// while the MCP server was still polling a submit-with-wait; the server kept
// going, and a second collect on the same run submitted its own synthesis
// and triage — four paid post-passes for one run, and a state file written
// by whichever process persisted last.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);
const { BROADSIDE_MODEL, broadsideDirFor, claimRunSlot, loadBroadsideState, persistBroadsideRunMerging, pollBatchUntilTerminal, runBroadsideCollect, runBroadsideSubmit } = core;

const LENS_JSON = JSON.stringify({ module: "root", findings: [], patterns_checked: [], files_scanned: 0 });
const TRUNCATED = '{"module": "root", "findings": [';

async function withRepo(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-concurrent-"));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 5000) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await sleep(10);
	}
}

/**
 * A fake OpenRouter: lens batches complete at once with `lensContent`; every
 * other batch (post-passes, retries) stays in progress until `release()`.
 */
function gatedFetcher({ lensContent = LENS_JSON } = {}) {
	const posted = [];
	let released = false;
	const fetcher = async (url, init) => {
		if (init?.method === "POST") {
			const payload = JSON.parse(init.body);
			posted.push(payload);
			return response(202, { id: `batch-${posted.length}`, status: "validating" });
		}
		if (String(url).includes("/models")) return response(200, { data: [] });
		const index = Number(String(url).split("/").pop().replace(/^batch-/, "")) - 1;
		const payload = posted[index];
		const kind = payload.requests[0].custom_id;
		const isLens = kind !== "synthesis" && kind !== "triage" && !payload.requests.some((r) => posted.slice(0, index).some((p) => p.requests.some((q) => q.custom_id === r.custom_id)));
		if (!isLens && !released) return response(200, { id: `batch-${index + 1}`, status: "in_progress", request_counts: { completed: 0, total: 1 } });
		const content = (customId) => (kind === "synthesis"
			? JSON.stringify({ executive_summary: "s", severity_counts: {}, top_findings: [], cross_lens_themes: [], recommended_next_steps: [] })
			: kind === "triage"
				? JSON.stringify({ items: [] })
				: isLens ? lensContent : LENS_JSON);
		return response(200, {
			id: `batch-${index + 1}`,
			status: "completed",
			results: payload.requests.map((r) => ({ custom_id: r.custom_id, response: { status_code: 200, body: { choices: [{ message: { content: content(r.custom_id) } }] } }, error: null })),
			usage: { cost: 0.001 },
		});
	};
	return { fetcher, posted, release: () => { released = true; }, postsOf: (kind) => posted.filter((p) => p.requests[0].custom_id === kind).length };
}

test("two collects on one run submit synthesis and triage once, and the second adopts the first's batches", async () => {
	await withRepo(async (dir) => {
		const { fetcher, posted, release, postsOf } = gatedFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const lensPosts = posted.length;

		const first = runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 20, waitMs: 10_000 });
		await until(() => postsOf("synthesis") === 1 && postsOf("triage") === 1, "the first collect to submit both passes");
		// The claim is on disk with the batch ids before the second collect looks.
		const onDisk = async () => (await loadBroadsideState(broadsideDirFor(dir))).runs.at(-1);
		let claimed = await onDisk();
		while (!claimed.synthesis.batchId || !claimed.triage.batchId) { await sleep(10); claimed = await onDisk(); }
		assert.equal(claimed.synthesis.status, "submitted");
		assert.ok(claimed.synthesis.batchId, "the owner records its batch id under the claim");

		const second = runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 20, waitMs: 10_000 });
		await sleep(150); // long enough for the second collect to reach the post-pass decision
		assert.equal(postsOf("synthesis"), 1, "the second collect must not submit its own synthesis");
		assert.equal(postsOf("triage"), 1, "the second collect must not submit its own triage");

		release();
		const [a, b] = await Promise.all([first, second]);
		assert.equal(posted.length - lensPosts, 2, "exactly one synthesis and one triage batch for the run");
		for (const [label, result] of [["first", a], ["second", b]]) {
			assert.equal(result.synthesis.status, "completed", `${label} collect reports the synthesis`);
			assert.equal(result.triage.status, "completed", `${label} collect reports the triage`);
		}
		const run = (await loadBroadsideState(broadsideDirFor(dir))).runs.at(-1);
		assert.equal(run.synthesis.status, "completed");
		assert.equal(run.synthesis.batchId, claimed.synthesis.batchId, "the state keeps the one batch that was paid for");
		assert.equal(run.triage.status, "completed");
	});
});

test("two collects that both see a truncated slice submit one retry batch; the other reports it as elsewhere", async () => {
	await withRepo(async (dir) => {
		const { fetcher, release, postsOf, posted } = gatedFetcher({ lensContent: TRUNCATED });
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const retryPosts = () => posted.filter((p, i) => i > 0 && p.requests[0].custom_id === posted[0].requests[0].custom_id).length;

		const first = runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 20, waitMs: 10_000, includeSynthesis: false, includeTriage: false });
		await until(() => retryPosts() === 1, "the first collect to submit the retry");
		const onDisk = async () => (await loadBroadsideState(broadsideDirFor(dir))).runs.at(-1);
		let claimed = await onDisk();
		while (!claimed.retry || claimed.retry.batches.length === 0) { await sleep(10); claimed = await onDisk(); }
		assert.equal(claimed.retry.status, "submitted");
		assert.equal(claimed.retry.batches.length, 1, "the retry batch id is recorded under the claim");

		const second = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 20, waitMs: 10_000, includeSynthesis: false, includeTriage: false });
		assert.equal(retryPosts(), 1, "the second collect must not submit its own retry");
		assert.equal(second.retryElsewhere, true);
		assert.equal(second.retriedCount, 0);
		assert.equal(second.truncatedCount, 1, "the second collect reports the slice as still truncated — the recovery lands on the owner");

		release();
		const a = await first;
		assert.equal(a.retriedCount, 1);
		assert.equal(a.truncatedCount, 0);
		const run = (await loadBroadsideState(broadsideDirFor(dir))).runs.at(-1);
		assert.equal(run.retry.status, "completed");
		assert.equal(postsOf("synthesis"), 0);
	});
});

test("a claim adopted before its owner recorded a batch id is reported as submitted and never polled or re-submitted", async () => {
	await withRepo(async (dir) => {
		const { fetcher, posted, postsOf } = gatedFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		// Another collect claimed synthesis a moment ago and has not yet recorded its id.
		const state = await loadBroadsideState(broadsideDirFor(dir));
		const run = state.runs.at(-1);
		assert.equal(await claimRunSlot(broadsideDirFor(dir), run, "synthesis"), true);
		assert.equal(await claimRunSlot(broadsideDirFor(dir), run, "synthesis"), false, "a second claim on the same slot is refused");

		const result = await runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 20, waitMs: 500, includeTriage: false });
		assert.equal(postsOf("synthesis"), 0, "nothing submitted for a slot someone else holds");
		assert.equal(result.synthesis.status, "submitted", "reported as in flight elsewhere");
		assert.equal(posted.length, 1, "only the lens batch was ever posted");
	});
});

test("a collect stops at once when its signal fires, submits nothing further, and leaves the batches for the next collect", async () => {
	await withRepo(async (dir) => {
		const { fetcher, postsOf } = gatedFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const controller = new AbortController();
		// The lens completes at once; the post-passes are submitted and polled
		// (gated in progress); the abort fires during that poll.
		const collecting = runBroadsideCollect(dir, "sk-fake", { fetcher, pollIntervalMs: 5_000, waitMs: 60_000, signal: controller.signal });
		await until(() => postsOf("synthesis") === 1, "the post-pass submission");
		const started = Date.now();
		controller.abort();
		const result = await collecting;
		assert.ok(Date.now() - started < 1000, `an abort must not wait out the poll interval (took ${Date.now() - started}ms)`);
		assert.equal(result.synthesis.status, "submitted", "the paid batch stays claimable");
		assert.equal(result.status, "completed", "the lens results are settled");

		// Aborted before anything: nothing is submitted at all.
		const { fetcher: fetcher2, posted: posted2 } = gatedFetcher();
		const dir2 = await mkdtemp(join(tmpdir(), "cc-bs-abort-"));
		try {
			await writeFile(join(dir2, "go.mod"), "module x\n");
			await writeFile(join(dir2, "main.go"), "package main\n");
			await runBroadsideSubmit(dir2, "sk-fake", { lenses: ["architecture"], fetcher: fetcher2, maxCost: 0 });
			const dead = new AbortController();
			dead.abort();
			const result2 = await runBroadsideCollect(dir2, "sk-fake", { fetcher: fetcher2, pollIntervalMs: 20, waitMs: 60_000, signal: dead.signal });
			assert.equal(result2.lensOutcomes.architecture.status, "timeout", "an aborted poll reads as a batch still in flight");
			assert.equal(posted2.length, 1, "nothing beyond the original lens batch was posted");
		} finally {
			await rm(dir2, { recursive: true, force: true });
		}
	});
});

test("pollBatchUntilTerminal wakes from its interval the moment the signal fires", async () => {
	const controller = new AbortController();
	const fetcher = async () => response(200, { id: "b", status: "in_progress", request_counts: {} });
	const started = Date.now();
	setTimeout(() => controller.abort(), 50);
	const batch = await pollBatchUntilTerminal("b", "sk-fake", { fetcher, pollIntervalMs: 10_000, deadlineMs: 60_000, signal: controller.signal });
	assert.equal(batch.status, "timeout");
	assert.equal(batch.aborted, true);
	assert.ok(Date.now() - started < 1000, `woke in ${Date.now() - started}ms`);
});

test("a merging write never moves a pass, a retry, or a lens backwards", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-merge-"));
	try {
		const run = {
			id: "r1", createdAt: "2026-09-13T00:00:00.000Z", model: BROADSIDE_MODEL, lenses: ["architecture"], status: "in-flight", outputDir: "r1",
			batches: { architecture: { batchId: "batch-1", requests: 1, status: "validating", submittedAt: "x", estimatedCost: 0 } },
			synthesis: { status: "pending" }, triage: { status: "pending" },
		};
		await persistBroadsideRunMerging(dir, structuredClone(run));
		// Another collect settles everything.
		const theirs = structuredClone(run);
		theirs.batches.architecture = { ...theirs.batches.architecture, status: "completed", cost: 0.01 };
		theirs.synthesis = { status: "completed", batchId: "batch-2", cost: 0.02 };
		theirs.triage = { status: "submitted", batchId: "batch-3" };
		theirs.retry = { status: "submitted", batches: [{ model: BROADSIDE_MODEL, batchId: "batch-4" }], claimedAt: "x" };
		await persistBroadsideRunMerging(dir, theirs);
		// Our stale copy writes back: every slot keeps the further-along value,
		// and our copy is updated to match.
		const ours = structuredClone(run);
		ours.retry = { status: "submitted", batches: [], claimedAt: "y" };
		await persistBroadsideRunMerging(dir, ours);
		const onDisk = (await loadBroadsideState(dir)).runs[0];
		assert.equal(onDisk.batches.architecture.status, "completed");
		assert.equal(onDisk.synthesis.batchId, "batch-2");
		assert.equal(onDisk.triage.batchId, "batch-3");
		assert.deepEqual(onDisk.retry.batches, [{ model: BROADSIDE_MODEL, batchId: "batch-4" }]);
		assert.equal(ours.synthesis.batchId, "batch-2", "the caller's copy now reports what is true");
		// A tie keeps the writer's copy: the collect that settled a pass records its cost.
		const settled = structuredClone(theirs);
		settled.triage = { status: "completed", batchId: "batch-3", cost: 0.03 };
		await persistBroadsideRunMerging(dir, settled);
		assert.equal((await loadBroadsideState(dir)).runs[0].triage.cost, 0.03);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
