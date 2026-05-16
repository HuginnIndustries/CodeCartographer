// Unit tests for the auto-runner's pure decision function. The loop body
// itself (runAuto) is exercised by manual smoke; the decision matrix —
// "given this phase outcome + validation result, what's next?" — is the
// testable seam, and these tests pin its branches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { decideAfterPhase } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/auto-runner.ts`).href);

function makeValidation(overall, phaseId = "architecture") {
	return {
		phaseId,
		primaryOutput: `findings/${phaseId}/${phaseId}.md`,
		outputPath: `/tmp/findings/${phaseId}/${phaseId}.md`,
		exists: true,
		hasValidationBlock: true,
		overall,
		rows: [{ criterion: "Some criterion", result: overall === "PASS WITH GAPS" ? "PARTIAL" : "PASS", evidence: "evidence" }],
		gaps: [],
		errors: [],
	};
}

test("aborted phase → action: aborted (no validation consulted)", () => {
	const d = decideAfterPhase("aborted", undefined, null, false);
	assert.equal(d.action, "aborted");
});

test("aborted phase under strict mode → still aborted (strict doesn't change abort handling)", () => {
	const d = decideAfterPhase("aborted", undefined, null, true);
	assert.equal(d.action, "aborted");
});

test("errored phase → action: stop with the error message in reason", () => {
	const d = decideAfterPhase("error", "model timed out", null, false);
	assert.equal(d.action, "stop");
	assert.equal(d.reason, "model timed out");
	assert.equal(d.error, "model timed out");
});

test("errored phase with no error string → reason falls back to generic", () => {
	const d = decideAfterPhase("error", undefined, null, false);
	assert.equal(d.action, "stop");
	assert.match(d.reason, /Sub-agent errored/);
});

test("completed + PASS validation → action: continue", () => {
	const d = decideAfterPhase("completed", undefined, makeValidation("PASS"), false);
	assert.equal(d.action, "continue");
});

test("completed + PASS WITH GAPS (non-strict) → continue (default rule mirrors /codecarto-complete)", () => {
	const d = decideAfterPhase("completed", undefined, makeValidation("PASS WITH GAPS"), false);
	assert.equal(d.action, "continue");
});

test("completed + PASS WITH GAPS + strict → stop with validation summary lines", () => {
	const d = decideAfterPhase("completed", undefined, makeValidation("PASS WITH GAPS", "contracts"), true);
	assert.equal(d.action, "stop");
	assert.equal(d.validation, "PASS WITH GAPS");
	assert.match(d.reason, /PASS WITH GAPS on contracts/);
	assert.match(d.reason, /strict mode/);
	assert.ok(Array.isArray(d.validationSummary) && d.validationSummary.length > 0);
});

test("completed + FAIL → stop regardless of strict", () => {
	const dStrict = decideAfterPhase("completed", undefined, makeValidation("FAIL"), true);
	const dLoose = decideAfterPhase("completed", undefined, makeValidation("FAIL"), false);
	for (const d of [dStrict, dLoose]) {
		assert.equal(d.action, "stop");
		assert.equal(d.validation, "FAIL");
		assert.match(d.reason, /Validation FAIL/);
	}
});

test("completed + MISSING → stop regardless of strict", () => {
	const dStrict = decideAfterPhase("completed", undefined, makeValidation("MISSING"), true);
	const dLoose = decideAfterPhase("completed", undefined, makeValidation("MISSING"), false);
	for (const d of [dStrict, dLoose]) {
		assert.equal(d.action, "stop");
		assert.equal(d.validation, "MISSING");
		assert.match(d.reason, /Validation MISSING/);
	}
});

test("completed but validation missing (shouldn't happen but guarded) → stop", () => {
	const d = decideAfterPhase("completed", undefined, null, false);
	assert.equal(d.action, "stop");
	assert.match(d.reason, /Validation skipped/);
});
