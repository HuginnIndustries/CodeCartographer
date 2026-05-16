// Unit tests for buildAutoSummary — the markdown emitted as the
// codecarto-auto-summary CustomMessageEntry after a /codecarto-next --auto
// run finishes (complete / stopped / aborted). Pure formatting; mirrors
// tests/agent-summary.test.mjs in shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildAutoSummary } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/auto-runner.ts`).href);

const baseComplete = {
	outcome: "complete",
	reason: "Pipeline complete.",
	phasesRun: ["architecture", "contracts", "protocols"],
	totalPhases: 3,
	startedAt: 1_000_000,
	endedAt: 1_180_000,           // 3 minutes
	totalTokens: { input: 50_000, output: 20_000, cacheWrite: 5_000 },
};

const baseStopped = {
	outcome: "stopped",
	reason: "Validation FAIL on contracts.",
	phasesRun: ["architecture"],
	totalPhases: 3,
	startedAt: 1_000_000,
	endedAt: 1_120_000,
	totalTokens: { input: 30_000, output: 15_000, cacheWrite: 2_000 },
	stoppedAt: { phaseId: "contracts", validation: "FAIL" },
	validationSummary: ["Validation results for contracts:", "- Criterion: failed because X"],
};

const baseAborted = {
	outcome: "aborted",
	reason: "Aborted during protocols.",
	phasesRun: ["architecture", "contracts"],
	totalPhases: 3,
	startedAt: 1_000_000,
	endedAt: 1_300_000,
	totalTokens: { input: 80_000, output: 35_000, cacheWrite: 8_000 },
	stoppedAt: { phaseId: "protocols" },
};

test("complete summary: header + 3/3 stats + dashboard link", () => {
	const out = buildAutoSummary(baseComplete);
	assert.match(out, /\*\*Auto pipeline complete\.\*\*/);
	assert.match(out, /3\/3 phases/);
	assert.match(out, /70\.0k tokens/);
	assert.match(out, /3m00s/);
	assert.match(out, /Dashboard: `\.codecarto\/dashboard\.html`/);
});

test("complete summary with skills available surfaces them as next-step hint", () => {
	const out = buildAutoSummary(baseComplete, ["spec-delta-application", "review"]);
	assert.match(out, /\/codecarto-skill spec-delta-application/);
	assert.match(out, /also available: review/);
});

test("complete summary with empty skills list omits the skill hint", () => {
	const out = buildAutoSummary(baseComplete, []);
	assert.doesNotMatch(out, /\/codecarto-skill/);
});

test("stopped summary names the phase it stopped at + embeds validation summary block", () => {
	const out = buildAutoSummary(baseStopped);
	assert.match(out, /Auto pipeline stopped at `contracts`/);
	assert.match(out, /Validation FAIL on contracts/);
	assert.match(out, /Validation results for contracts:/);
	// Recovery hint for FAIL
	assert.match(out, /Fix the phase output/);
});

test("stopped summary for PASS WITH GAPS (strict) gives the strict-specific recovery hint", () => {
	const out = buildAutoSummary({
		...baseStopped,
		reason: "PASS WITH GAPS on contracts (strict mode).",
		stoppedAt: { phaseId: "contracts", validation: "PASS WITH GAPS" },
	});
	assert.match(out, /Review gaps via `\/codecarto-validate`/);
	assert.match(out, /\/codecarto-complete contracts/);
});

test("aborted summary uses the aborted header + resume hint", () => {
	const out = buildAutoSummary(baseAborted);
	assert.match(out, /Auto pipeline aborted during `protocols`/);
	assert.match(out, /Run `\/codecarto-next --auto` to resume/);
});

test("stats line uses tabular tokens + duration formatting consistently", () => {
	const out = buildAutoSummary({
		...baseComplete,
		totalTokens: { input: 1_500_000, output: 600_000, cacheWrite: 100_000 },
		endedAt: 1_000_000 + 75_500,  // 1m15s
	});
	assert.match(out, /2\.10M tokens/);
	assert.match(out, /1m15s/);
});
