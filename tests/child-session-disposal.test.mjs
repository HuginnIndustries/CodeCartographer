// Every child AgentSession is disposed when its work is done (self-audit
// #256, D-M19).
//
// Phases, prompt rewrites, and dashboard narrations each create a child via
// createAgentSession() and never called dispose(), which is what aborts the
// child's in-flight work, drops its agent subscription and listeners, and
// runs the per-session resource cleanups extensions register. Reaching a
// real child needs a live Pi session, so the pairing is pinned at the source
// level and the helper's contract is tested directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { disposeChildSession } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/agent-runner.ts`).href);

test("disposeChildSession calls dispose and survives a cleanup hook that throws", () => {
	let calls = 0;
	disposeChildSession({ dispose: () => { calls++; } });
	assert.equal(calls, 1);
	assert.doesNotThrow(() => disposeChildSession({ dispose: () => { throw new Error("hook failed"); } }));
});

test("every createAgentSession in the extension has a disposeChildSession in the same file", async () => {
	const dir = join(REPO_ROOT, "extensions", "codecarto");
	const creators = [];
	for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".ts"))) {
		const source = await readFile(join(dir, name), "utf8");
		// Call sites only: the runner's header comment names the function too.
		const creates = (source.match(/await createAgentSession\(/g) ?? []).length;
		if (creates === 0) continue;
		const disposes = (source.match(/\bdisposeChildSession\(session\)/g) ?? []).length;
		creators.push({ name, creates, disposes });
		assert.ok(disposes >= creates, `${name} creates ${creates} child session(s) and disposes ${disposes}`);
	}
	assert.deepEqual(creators.map((entry) => entry.name).sort(), ["agent-rewriter.ts", "agent-runner.ts", "dashboard-narrator.ts"], "the three known child-session sites");
});

test("the phase result and the activity record no longer carry the session", async () => {
	const runner = await readFile(join(REPO_ROOT, "extensions", "codecarto", "agent-runner.ts"), "utf8");
	const state = await readFile(join(REPO_ROOT, "extensions", "codecarto", "agent-state.ts"), "utf8");
	// A disposed session handed back to callers is a footgun; nothing read it.
	assert.doesNotMatch(runner, /export interface PhaseRunResult \{\s*session:/);
	assert.doesNotMatch(state, /session\?: AgentSession/);
});
