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
