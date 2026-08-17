// Pins the auto-mode behavior of buildPhasePrompt's Strategic Alignment Hook.
//
// Background: the original Strategic Alignment Hook (in the `reimplementation-spec`
// phase prompt) asks the user — explicitly, in chat — whether the spec should be
// language-agnostic or opinionated. That's a useful prompt for an interactive run
// but it wedges `/codecarto-next --auto`: the sub-agent stops mid-phase to ask a
// question nobody answers, no primary output is written, and the auto loop sees
// MISSING and bails. Reproducer is documented in the PR description: an auto run
// finishes `porting`, advances to `reimplementation-spec`, and stops at validation
// MISSING with the sub-agent's "Which route would you like?" still hanging.
//
// Fix: thread an `auto: true` option through `buildPhasePrompt` and emit a
// different hook block under auto — one that pre-defaults to language-agnostic
// and explicitly forbids pausing on the user. These tests pin both branches
// (interactive vs. auto) and confirm non-reimplementation-spec phases are
// unaffected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { buildPhasePrompt, getWorkspaceState, resolvePhase } = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

let WORKSPACE;
let state;
let reimplPhase;
let architecturePhase;

test("setup: fresh workspace with the default pipeline", async () => {
	WORKSPACE = await mkdtemp(join(tmpdir(), "cc-prompts-auto-"));
	await handleInit({ cwd: WORKSPACE });
	state = await getWorkspaceState(WORKSPACE);
	assert.ok(state, "workspace state should load after init");
	reimplPhase = resolvePhase(state, "reimplementation-spec");
	architecturePhase = resolvePhase(state, "architecture");
	assert.ok(reimplPhase, "default pipeline should expose reimplementation-spec");
	assert.ok(architecturePhase, "default pipeline should expose architecture");
});

test("interactive default emits the user-facing Strategic Alignment Hook", async () => {
	const prompt = await buildPhasePrompt(state, reimplPhase, false);
	assert.match(prompt, /Strategic Alignment Hook \(run BEFORE producing the spec\):/);
	assert.match(prompt, /Confirm with the user/);
	assert.doesNotMatch(prompt, /auto run/i);
	assert.doesNotMatch(prompt, /selection: auto-default/);
});

test("explicit `auto: false` matches the interactive default byte-for-byte", async () => {
	const implicit = await buildPhasePrompt(state, reimplPhase, false);
	const explicit = await buildPhasePrompt(state, reimplPhase, false, { auto: false });
	assert.equal(explicit, implicit, "auto:false must not perturb the interactive prompt");
});

test("`auto: true` swaps the hook to the no-user-prompt variant", async () => {
	const prompt = await buildPhasePrompt(state, reimplPhase, false, { auto: true });
	assert.match(prompt, /Strategic Alignment Hook \(auto run — DO NOT ask the user\):/);
	assert.match(prompt, /Default the spec to LANGUAGE-AGNOSTIC/);
	assert.match(prompt, /templates\/reimplementation-spec\.md/);
	assert.match(prompt, /selection: auto-default/);
	assert.match(prompt, /open_questions/);
	assert.doesNotMatch(prompt, /Confirm with the user/);
});

test("`auto: true` on non-synthesis phases changes only the orchestrator-duties header", async () => {
	// Since issue #98 the phase prompt carries an "Orchestrator duties" block
	// whose header differs under auto (perform-without-asking vs perform-before-
	// executing). Auto must still not introduce a Strategic Alignment Hook here,
	// and every other line must be identical.
	const interactive = await buildPhasePrompt(state, architecturePhase, false);
	const auto = await buildPhasePrompt(state, architecturePhase, false, { auto: true });
	assert.doesNotMatch(auto, /Strategic Alignment Hook/);
	assert.doesNotMatch(interactive, /Strategic Alignment Hook/);
	const stripDutiesHeader = (prompt) => prompt.split("\n").filter((line) => !line.startsWith("Orchestrator duties (")).join("\n");
	assert.equal(stripDutiesHeader(auto), stripDutiesHeader(interactive), "auto:true may change only the duties header on non-synthesis phases");
	if (auto !== interactive) {
		assert.match(auto, /Orchestrator duties \(auto run — perform them without asking the user/);
		assert.match(interactive, /Orchestrator duties \(perform BEFORE executing this phase/);
	}
});

test("`auto: true` composes with `forced: true` (manual /codecarto-phase under an auto-style driver)", async () => {
	const prompt = await buildPhasePrompt(state, reimplPhase, true, { auto: true });
	assert.match(prompt, /Strategic Alignment Hook \(auto run/);
	assert.match(prompt, /The user explicitly requested this phase/);
});

test("existing phase checkpoint is included as a required resumability read", async () => {
	const checkpointDir = join(WORKSPACE, ".codecarto", "scratch", "checkpoints");
	await mkdir(checkpointDir, { recursive: true });
	await writeFile(join(checkpointDir, "architecture.md"), "checkpoint", "utf8");
	const prompt = await buildPhasePrompt(state, architecturePhase, false);
	assert.match(prompt, /\.codecarto\/scratch\/checkpoints\/architecture\.md/);
	assert.match(prompt, /resume from durable in-phase progress/i);
});

test("teardown: remove temp workspace", async () => {
	if (WORKSPACE) await rm(WORKSPACE, { recursive: true, force: true });
});
