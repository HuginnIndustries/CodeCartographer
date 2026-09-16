// The 30 s linger after a phase ends must not clear a re-run of the same
// phase started inside the window (#343): the first run's timer deleted the
// second run's live entry, the widget dropped it, and the re-entry guard
// then let a second sub-agent start on the phase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { clearPhase, finishPhase, getPhaseActivity, startPhase } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/agent-state.ts`).href);

test("a linger clear tied to an earlier run leaves a re-run's entry alone", () => {
	const first = startPhase("architecture");
	finishPhase("architecture", { status: "error", error: "boom" });
	assert.equal(getPhaseActivity("architecture"), first, "the finished entry lingers");

	// Re-run inside the linger window: a fresh entry replaces the finished one.
	const second = startPhase("architecture");
	assert.notEqual(second, first);
	assert.equal(second.status, "running");
	assert.equal(startPhase("architecture"), second, "a running entry is what the re-entry guard sees");

	// The first run's timer fires: nothing happens to the second run.
	clearPhase("architecture", first);
	assert.equal(getPhaseActivity("architecture"), second);

	// The second run's own timer clears it; a clear without an entry is unconditional.
	clearPhase("architecture", second);
	assert.equal(getPhaseActivity("architecture"), undefined);
	startPhase("architecture");
	clearPhase("architecture");
	assert.equal(getPhaseActivity("architecture"), undefined);
});

test("the runner's linger timer names the run it belongs to", async () => {
	const runner = await readFile(join(REPO_ROOT, "extensions", "codecarto", "auto-runner.ts"), "utf8");
	assert.match(runner, /setTimeout\(\(\) => clearPhase\(phase\.id, activity\), 30_000\)/);
	assert.doesNotMatch(runner, /clearPhase\(phase\.id\)/, "no unconditional linger clear remains");
});

// ---------- #359: the phase is reserved before the prelude's first await ----------

test("runSinglePhase reserves the phase synchronously, so a second call during the prelude is refused instead of spawning twice", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { runSinglePhase, isPhaseRunning } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/auto-runner.ts`).href);
	const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
	const { getWorkspaceState } = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
	const cwd = await mkdtemp(join(tmpdir(), "cc-reentry-"));
	try {
		await handleInit({ cwd, pipeline: "architecture-only" });
		const state = await getWorkspaceState(cwd);
		const phase = state.pipeline.phases.find((p) => p.id === "architecture");
		// A context with no Pi runtime behind it: the sub-agent spawn fails
		// inside runPhase, which is caught and reported — after the prelude.
		const ctx = { cwd, hasUI: false, signal: new AbortController().signal, sessionManager: { getSessionFile: () => null }, isIdle: () => true };
		const pi = { sendMessage: () => {} };
		const stderr = process.stderr.write;
		process.stderr.write = () => true;
		try {
			const first = runSinglePhase(ctx, pi, state, phase, { llmSteerEnabled: false });
			assert.equal(isPhaseRunning("architecture"), true, "reserved before the first await resolved");
			const second = await runSinglePhase(ctx, pi, state, phase, { llmSteerEnabled: false });
			assert.equal(second.status, "error");
			assert.match(second.error, /Phase architecture is already running/);
			const result = await first;
			assert.equal(result.status, "error", "the stub runtime cannot spawn; the first run ends in error");
			assert.equal(isPhaseRunning("architecture"), false, "and the reservation is released with it");
		} finally {
			process.stderr.write = stderr;
		}
	} finally {
		clearPhase("architecture");
		// The error path's best-effort usage and dashboard writes may still be landing.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});
