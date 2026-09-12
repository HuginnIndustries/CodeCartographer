// The **Overall:** verdict is read tolerantly and a failed read names the
// line (self-audit #247, D-M9; mech 2.6).
//
// The value had to be exactly `PASS` or `PASS WITH GAPS`; `PASS (6/6)`,
// `PASS.`, or a bolded verdict classified the phase FAIL and the only error
// was "Validation overall result is FAIL." — nothing said the line went
// unread.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

const { parseOverallLine } = core;

test("parseOverallLine reads the verdict through decoration", () => {
	const cases = {
		"**Overall:** PASS": "PASS",
		"**Overall:** PASS WITH GAPS": "PASS WITH GAPS",
		"**Overall:** FAIL": "FAIL",
		"**Overall:** pass": "PASS",
		"**Overall:** PASS (6/6)": "PASS",
		"**Overall:** PASS.": "PASS",
		"**Overall:** PASS WITH GAPS (5/6) — criterion 3 is PARTIAL": "PASS WITH GAPS",
		"**Overall:** **PASS**": "PASS",
		"**Overall:** `PASS WITH GAPS`": "PASS WITH GAPS",
		"**Overall:** _FAIL_ (2/6)": "FAIL",
		"**Overall**: PASS": "PASS",
		"- **Overall:** PASS": "PASS",
		"> **Overall:** PASS": "PASS",
		"  **Overall:**   PASS  ": "PASS",
	};
	for (const [line, verdict] of Object.entries(cases)) {
		assert.deepEqual(parseOverallLine(line), { verdict }, line);
	}
});

test("parseOverallLine tells an unreadable verdict from a non-Overall line", () => {
	for (const line of ["**Overall:**", "**Overall:** PASSED", "**Overall:** all good", "**Overall:** PASSWITHGAPS", "**Overall:** FAILED (2/6)", "**Overall:** 6/6"]) {
		assert.deepEqual(parseOverallLine(line), { verdict: null }, line);
	}
	for (const line of ["Overall: PASS", "The overall result is PASS", "| 1 | Overall | PASS | x |", "**Result:** PASS", ""]) {
		assert.equal(parseOverallLine(line), null, line);
	}
});

// ---------- through validatePhaseOutput ----------

const report = (overallLine) => [
	"# Map",
	"",
	"## Validation",
	"",
	"| # | Criterion | Result | Evidence |",
	"|---|-----------|--------|----------|",
	"| 1 | Intent documented. | PASS | §above |",
	"",
	...(overallLine === null ? [] : [overallLine]),
	"",
].join("\n");

async function validateWith(overallLine) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-overall-"));
	try {
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		await writeFile(join(cwd, ".codecarto", "findings", "architecture", "architecture-map.md"), report(overallLine), "utf8");
		const state = await core.getWorkspaceState(cwd);
		return await core.validatePhaseOutput(state, "architecture");
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

test("a decorated Overall line passes validation", async () => {
	for (const line of ["**Overall:** PASS (1/1)", "**Overall:** **PASS**.", "**Overall:** PASS — all criteria met", "**Overall**: PASS"]) {
		const result = await validateWith(line);
		assert.equal(result.overall, "PASS", line);
		assert.deepEqual(result.errors, [], line);
	}
	const gaps = await validateWith("**Overall:** PASS WITH GAPS (0/1 partial; see handoff)");
	assert.equal(gaps.overall, "PASS WITH GAPS");
	assert.deepEqual(gaps.errors, []);
});

test("an Overall line whose verdict cannot be read fails and the error quotes the line", async () => {
	const result = await validateWith("**Overall:** all good");
	assert.equal(result.overall, "FAIL");
	assert.deepEqual(result.errors, [
		'Could not read the verdict on the Overall line: "**Overall:** all good". It must start with PASS, PASS WITH GAPS, or FAIL; anything after the verdict is ignored.',
	]);
	const empty = await validateWith("**Overall:**");
	assert.match(empty.errors[0], /^Could not read the verdict on the Overall line: "\*\*Overall:\*\*"\./);
});

test("a missing Overall line fails and the error says what to add", async () => {
	const result = await validateWith(null);
	assert.equal(result.overall, "FAIL");
	assert.deepEqual(result.errors, [
		"No **Overall:** line found in the ## Validation block. End the block with `**Overall:** PASS`, `**Overall:** PASS WITH GAPS`, or `**Overall:** FAIL`.",
	]);
});

test("an explicit FAIL verdict is reported as such, decoration included", async () => {
	const result = await validateWith("**Overall:** FAIL (0/1)");
	assert.equal(result.overall, "FAIL");
	assert.deepEqual(result.errors, ['The Overall line says FAIL: "**Overall:** FAIL (0/1)".']);
});

test("the last Overall line wins, and the summary shows the error", async () => {
	const result = await validateWith("**Overall:** FAIL\n\n**Overall:** PASS (revised)");
	assert.equal(result.overall, "PASS");
	const failed = await validateWith("**Overall:** PASS\n\n**Overall:** not sure");
	assert.equal(failed.overall, "FAIL");
	const summary = core.buildValidationSummary(failed);
	assert.equal(summary[0], "Validation: FAIL");
	assert.ok(summary.some((line) => line.startsWith("Could not read the verdict on the Overall line")), summary.join("\n"));
});
