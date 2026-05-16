// Unit tests for buildPhaseSummary — the markdown emitted into the
// orchestrator's session as a CustomMessageEntry when a phase sub-agent
// finishes. Pure formatting; no I/O or session machinery exercised.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildPhaseSummary } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/agent-summary.ts`).href);

const baseInput = {
	phaseId: "blueprint",
	status: "completed",
	turnCount: 5,
	toolUses: 12,
	tokens: { input: 1500, output: 800, cacheWrite: 0 },
	durationMs: 90_000,
	responseText: "Documented the public API surface.",
	sessionFile: "/home/user/.pi/agent/sessions/abc/123.jsonl",
};

test("completed phase summary includes header, stats, excerpt, trailer", () => {
	const out = buildPhaseSummary(baseInput);
	assert.match(out, /\*\*Phase `blueprint` finished\.\*\*/);
	assert.match(out, /⟳ 5/);
	assert.match(out, /12 tool uses/);
	assert.match(out, /2\.3k tokens/);
	assert.match(out, /1m30s/);
	assert.match(out, /Documented the public API surface\./);
	assert.match(out, /Phase transcript:/);
	assert.match(out, /\/codecarto-validate/);
	assert.match(out, /\/codecarto-complete/);
});

test("aborted phase summary uses 'aborted' header and skips the validate trailer", () => {
	const out = buildPhaseSummary({ ...baseInput, status: "aborted" });
	assert.match(out, /\*\*Phase `blueprint` aborted\.\*\*/);
	assert.doesNotMatch(out, /\/codecarto-validate/);
});

test("error phase summary includes the error message and skips excerpt/trailer", () => {
	const out = buildPhaseSummary({
		...baseInput,
		status: "error",
		responseText: "",
		error: "model timed out after 60s",
	});
	assert.match(out, /\*\*Phase `blueprint` failed\.\*\*/);
	assert.match(out, /model timed out after 60s/);
	assert.doesNotMatch(out, /Documented the public API surface/);
	assert.doesNotMatch(out, /\/codecarto-validate/);
});

test("response text over the budget is truncated with an explanatory tail", () => {
	const long = "x".repeat(5000);
	const out = buildPhaseSummary({ ...baseInput, responseText: long });
	assert.match(out, /…/);
	assert.match(out, /transcript truncated; resume the phase session/);
	// First 2000 chars (budget) must be present, not the last 3000.
	assert.ok(out.includes("x".repeat(100)));
});

test("zero-activity phase emits an explicit 'no activity' marker", () => {
	const out = buildPhaseSummary({
		...baseInput,
		turnCount: 0,
		toolUses: 0,
		tokens: { input: 0, output: 0, cacheWrite: 0 },
		durationMs: 0,
		responseText: "",
	});
	assert.match(out, /\(no activity recorded\)/);
});

test("missing sessionFile drops the transcript line but keeps the validate trailer", () => {
	const out = buildPhaseSummary({ ...baseInput, sessionFile: undefined });
	assert.doesNotMatch(out, /Phase transcript:/);
	assert.match(out, /\/codecarto-validate/);
});

test("token formatting handles k and M thresholds", () => {
	const tk = buildPhaseSummary({ ...baseInput, tokens: { input: 500, output: 0, cacheWrite: 0 } });
	assert.match(tk, /500 tokens/);
	const tm = buildPhaseSummary({ ...baseInput, tokens: { input: 2_500_000, output: 100_000, cacheWrite: 0 } });
	assert.match(tm, /2\.6M tokens/);
});
