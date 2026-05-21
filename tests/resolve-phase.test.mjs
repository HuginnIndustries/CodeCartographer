// Pins resolvePhase's argument resolution, including the primary_output
// filename fallback.
//
// Background: validation errors print the primary output path (e.g. "Missing
// primary output: .codecarto/findings/protocols/protocols-and-state.md"), so
// users naturally paste that filename back as the /codecarto-validate or
// /codecarto-complete argument instead of the phase id. Before the fallback,
// resolvePhase returned null for "protocols-and-state" and validatePhaseOutput
// threw "Unknown phase: protocols-and-state", surfacing as an extension crash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { getWorkspaceState, resolvePhase } = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

let WORKSPACE;
let state;

test("setup: fresh workspace with the default pipeline", async () => {
	WORKSPACE = await mkdtemp(join(tmpdir(), "cc-resolve-phase-"));
	await handleInit({ cwd: WORKSPACE });
	state = await getWorkspaceState(WORKSPACE);
	assert.ok(state, "workspace state should load after init");
});

test("resolvePhase matches an exact phase id", () => {
	const phase = resolvePhase(state, "protocols");
	assert.ok(phase, "protocols should resolve");
	assert.equal(phase.id, "protocols");
});

test("resolvePhase falls back to the primary_output basename without extension", () => {
	const phase = resolvePhase(state, "protocols-and-state");
	assert.ok(phase, "protocols-and-state should resolve via primary_output fallback");
	assert.equal(phase.id, "protocols");
});

test("resolvePhase falls back to the primary_output basename with .md", () => {
	const phase = resolvePhase(state, "protocols-and-state.md");
	assert.ok(phase, "protocols-and-state.md should resolve via primary_output fallback");
	assert.equal(phase.id, "protocols");
});

test("resolvePhase falls back to a full pasted primary_output path", () => {
	const phase = resolvePhase(state, ".codecarto/findings/protocols/protocols-and-state.md");
	assert.ok(phase, "pasted primary_output path should resolve via fallback");
	assert.equal(phase.id, "protocols");
});

test("resolvePhase returns null for a genuinely unknown argument", () => {
	assert.equal(resolvePhase(state, "totally-not-a-phase"), null);
});

test("resolvePhase with no argument returns the next eligible phase", () => {
	const phase = resolvePhase(state);
	assert.ok(phase, "a fresh workspace should have a next eligible phase");
	assert.equal(phase.id, state.pipeline.phase_order[0]);
});

test("teardown: remove temp workspace", async () => {
	if (WORKSPACE) await rm(WORKSPACE, { recursive: true, force: true });
});
