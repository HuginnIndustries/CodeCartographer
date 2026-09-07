// Issue #122: a run registered an open question saying "source alone cannot
// determine which" and, in the same run, shipped one of that question's
// candidates as `strong inference` / `fix before porting`. Nothing read what
// the evidence and action cells said. These tests pin the mechanical checks
// that now do — and that they gate only where the scaffold offers an honest
// alternative action.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

const FINDINGS_HEADER = [
	"| # | Location | Defect | Severity | Evidence Level | Action |",
	"|---|----------|--------|----------|----------------|--------|",
].join("\n");

function report({ pass1Rows, openQuestionRows = null, validationRows = 8 }) {
	const rows = Array.from({ length: validationRows }, (_, i) => `| ${i + 1} | criterion ${i + 1} | PASS | ok |`).join("\n");
	return [
		"# Mechanical Defects Report — fixture",
		"",
		"## Pass 1: Logic and Correctness",
		"",
		FINDINGS_HEADER,
		...pass1Rows,
		"",
		"## Pass 2: Error Handling and Resilience",
		"",
		FINDINGS_HEADER,
		"| 1 | | | | | |",
		"",
		"### Routed To Semantic Phase",
		"",
		"| ID | Description | Why Routed |",
		"|----|-------------|-----------|",
		"| mech-CF1 | a race | concurrency |",
		"",
		...(openQuestionRows === null
			? []
			: [
				"## Open Questions",
				"",
				"| ID | Kind | Question | Why source cannot settle it | Derived findings |",
				"|----|------|----------|-----------------------------|------------------|",
				...(openQuestionRows.length > 0 ? openQuestionRows : ["| | | | | |"]),
				"",
			]),
		"## Coverage and limits",
		"",
		"- Inspected scope: all",
		"- Skipped scope: none",
		"- Evidence basis: source inspection",
		"- Known blind spots: none",
		"- Coverage disposition: COMPLETE",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		rows,
		"",
		"**Overall:** PASS",
		"",
	].join("\n");
}

const VIOLATING = "| 1 | server/api.ts:40 | client sends logit_bias as a map; server expects an array | high | external-behavior claim | fix before porting |";
const HONEST = "| 1 | server/api.ts:40 | client sends logit_bias as a map; server expects an array | high | external-behavior claim | verify at runtime |";
const SETTLED = "| 2 | lib/parse.ts:12 | off-by-one in bounds check | medium | observed fact | fix before porting |";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test("parseFindingsTables reads only tables with Evidence Level and Action columns, tagged by pass", () => {
	const rows = core.parseFindingsTables(report({ pass1Rows: [VIOLATING, SETTLED] }));
	assert.deepEqual(
		rows.map(({ pass, number, evidence, action }) => ({ pass, number, evidence, action })),
		[
			{ pass: "1", number: "1", evidence: "external-behavior claim", action: "fix before porting" },
			{ pass: "1", number: "2", evidence: "observed fact", action: "fix before porting" },
		],
		"the Routed table has no evidence/action columns and the Pass 2 placeholder row is empty",
	);
});

test("parseFindingsTables tolerates markdown emphasis and case in the cells", () => {
	const rows = core.parseFindingsTables(report({ pass1Rows: ["| 1 | x.ts:1 | y | low | **Open Question** | `Fix Before Porting` |"] }));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].evidence, "open question");
	assert.equal(rows[0].action, "fix before porting");
});

// ---------------------------------------------------------------------------
// Cross-checks
// ---------------------------------------------------------------------------

test("an unsettled evidence level paired with a settled fix action is an error on a current scaffold", () => {
	const result = core.crossCheckFindings(report({ pass1Rows: [VIOLATING], openQuestionRows: ["| q1 | needs-runtime-test | which shape? | server-side parsing | 1.1 |"] }), { gate: true });
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0], /Pass 1 finding #1/);
	assert.match(result.errors[0], /external-behavior claim/);
	assert.match(result.errors[0], /verify at runtime/);
	assert.deepEqual(result.warnings, []);
});

test("the same violation only warns when the scaffold predates the verify-at-runtime vocabulary", () => {
	const result = core.crossCheckFindings(report({ pass1Rows: [VIOLATING] }), { gate: false });
	assert.deepEqual(result.errors, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /predates the verify-at-runtime vocabulary/);
});

test("an honest pairing produces neither errors nor warnings", () => {
	const result = core.crossCheckFindings(report({ pass1Rows: [HONEST, SETTLED], openQuestionRows: ["| q1 | needs-runtime-test | which shape? | server-side parsing | 1.1 |"] }), { gate: true });
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.warnings, []);
});

test("observed fact paired with verify at runtime is a self-contradiction, warned not gated", () => {
	const result = core.crossCheckFindings(report({ pass1Rows: ["| 1 | a.ts:1 | b | low | observed fact | verify at runtime |"], openQuestionRows: ["| q | k | ? | ? | 1.1 |"] }), { gate: true });
	assert.deepEqual(result.errors, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /contradicts itself/);
});

test("unsettled findings with an empty Open Questions table are warned", () => {
	const result = core.crossCheckFindings(report({ pass1Rows: [HONEST], openQuestionRows: [] }), { gate: true });
	assert.deepEqual(result.errors, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /Open Questions table is empty/);
});

test("a document without findings tables is left alone", () => {
	const result = core.crossCheckFindings("# Architecture Map\n\n| Layer | Owns |\n|---|---|\n| core | state |\n", { gate: true });
	assert.deepEqual(result, { errors: [], warnings: [], findings: [] });
});

test("the pairing gate opens at the scaffold version that ships the vocabulary", () => {
	assert.equal(core.findingsPairingGateActive(undefined), false, "unversioned scaffold warns");
	assert.equal(core.findingsPairingGateActive("0.16.0"), false);
	assert.equal(core.findingsPairingGateActive(core.FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION), true);
	assert.equal(core.findingsPairingGateActive("1.0.0"), true);
	assert.equal(core.findingsPairingGateActive("not-a-version"), false);
});

// ---------------------------------------------------------------------------
// Through validatePhaseOutput, on a real workspace
// ---------------------------------------------------------------------------

async function withWorkspace(pipeline, fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-findings-"));
	try {
		await handleInit({ cwd, pipeline });
		await fn(cwd, join(cwd, ".codecarto"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("validatePhaseOutput fails a defect report whose findings contradict their own evidence", async () => {
	await withWorkspace("full-with-deep-audit", async (cwd, ws) => {
		const out = join(ws, "findings", "defect-scan-mechanical", "mechanical-defects.md");
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, report({ pass1Rows: [VIOLATING], openQuestionRows: ["| q1 | needs-runtime-test | ? | ? | 1.1 |"] }));
		// The gate opens at the release that ships the vocabulary; pin the
		// scaffold there so the test does not depend on the packaged version.
		await writeFile(join(ws, "workflow", "scaffold-version.yaml"), `scaffold_version: ${core.FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION}\n`);

		const state = await core.getWorkspaceState(cwd);
		const validation = await core.validatePhaseOutput(state, "defect-scan-mechanical");
		assert.equal(validation.overall, "FAIL", "the validation table said PASS on every row; the findings said otherwise");
		assert.ok(validation.errors.some((e) => /Pass 1 finding #1/.test(e)), validation.errors.join("\n"));
		assert.ok(core.buildValidationSummary(validation).some((line) => /verify at runtime/.test(line)));
	});
});

test("on an older scaffold the same report passes with a NOTE instead of failing mid-run", async () => {
	await withWorkspace("full-with-deep-audit", async (cwd, ws) => {
		const out = join(ws, "findings", "defect-scan-mechanical", "mechanical-defects.md");
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, report({ pass1Rows: [VIOLATING], openQuestionRows: ["| q1 | needs-runtime-test | ? | ? | 1.1 |"] }));
		await writeFile(join(ws, "workflow", "scaffold-version.yaml"), "scaffold_version: 0.16.0\n");

		const state = await core.getWorkspaceState(cwd);
		const validation = await core.validatePhaseOutput(state, "defect-scan-mechanical");
		assert.equal(validation.overall, "PASS");
		assert.equal(validation.warnings?.length, 1);
		const summary = core.buildValidationSummary(validation);
		assert.ok(summary.some((line) => line.startsWith("NOTE:") && /predates/.test(line)), summary.join("\n"));
	});
});

test("a phase without findings tables validates exactly as before", async () => {
	await withWorkspace("lite", async (cwd, ws) => {
		const out = join(ws, "findings", "architecture", "architecture-map.md");
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, [
			"# Architecture Map",
			"",
			"## Coverage and limits",
			"- Inspected scope: all",
			"",
			"## Validation",
			"",
			"| # | Criterion | Result | Evidence |",
			"|---|---|---|---|",
			"| 1 | The system intent is documented. | PASS | here |",
			"",
			"**Overall:** PASS",
		].join("\n"));
		const state = await core.getWorkspaceState(cwd);
		const validation = await core.validatePhaseOutput(state, "architecture");
		assert.equal(validation.overall, "PASS");
		assert.equal(validation.warnings, undefined);
	});
});

// ---------------------------------------------------------------------------
// Closure integrity at completion (warning only)
// ---------------------------------------------------------------------------

async function completeArchitecture(cwd, ws, { mentions }) {
	const out = join(ws, "findings", "architecture", "architecture-map.md");
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, [
		"# Architecture Map",
		"",
		mentions ? "Resolves ghost-CF9: the callsite distinguishes absent from corrupt." : "Nothing about the routed item.",
		"",
		"## Coverage and limits",
		"- Inspected scope: all",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|---|---|---|",
		"| 1 | The system intent is documented. | PASS | here |",
		"",
		"**Overall:** PASS",
	].join("\n"));
	await mkdir(join(ws, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(ws, "scratch", "handoffs", "architecture.yaml"), [
		"phase_id: architecture",
		"owner_notes: []",
		"open_questions: []",
		"carry_forward: []",
		"carry_forward_closures:",
		"  - ghost-CF9",
		"closeout_summary: done",
	].join("\n"));
	const state = await core.getWorkspaceState(cwd);
	const validation = await core.validatePhaseOutput(state, "architecture");
	assert.equal(validation.overall, "PASS");
	return core.completeValidatedPhase(cwd, validation, "test");
}

test("completion warns when the handoff closes an id the report never mentions", async () => {
	await withWorkspace("lite", async (cwd, ws) => {
		const result = await completeArchitecture(cwd, ws, { mentions: false });
		assert.equal(result.updatedState.status.phases.architecture.status, "complete", "warning only — the phase still completes");
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /ghost-CF9/);
		assert.match(result.warnings[0], /never mentions/);
	});
});

test("completion stays quiet when the report addresses every closure it claims", async () => {
	await withWorkspace("lite", async (cwd, ws) => {
		const result = await completeArchitecture(cwd, ws, { mentions: true });
		assert.deepEqual(result.warnings, []);
	});
});

// ---------------------------------------------------------------------------
// The vocabulary travels: every surface that names the action set names all four
// ---------------------------------------------------------------------------

test("every template and pipeline that names the pre-porting disposition set includes verify at runtime", async () => {
	const files = [
		".codecarto/templates/reverse-engineering-bundle.md",
		".codecarto/findings/porting/SKILL.md",
		".codecarto/findings/reimplementation-spec/SKILL.md",
		".codecarto/findings/defect-scan/SKILL.md",
		".codecarto/findings/defect-scan-mechanical/SKILL.md",
		".codecarto/workflow/pipeline-full-with-audit.yaml",
		".codecarto/workflow/pipeline-full-with-deep-audit.yaml",
		".codecarto/workflow/pipeline-scout-first.yaml",
		"agent-skill/codecartographer/references/deep-audit-synthesis.md",
		"MANUAL.md",
	];
	for (const file of files) {
		const content = await readFile(join(REPO_ROOT, file), "utf8");
		assert.ok(content.includes("fix before porting"), `${file} no longer names the disposition set — update this list`);
		assert.ok(content.includes("verify at runtime"), `${file} names the pre-porting dispositions but omits verify at runtime`);
	}
});

test("every defect template carries an Open Questions table and the pairing criterion", async () => {
	for (const template of ["mechanical-defects.md", "semantic-defects.md", "defect-report.md"]) {
		const content = await readFile(join(REPO_ROOT, ".codecarto", "templates", template), "utf8");
		assert.match(content, /^## Open Questions\s*$/m, `${template} lacks an Open Questions section`);
		assert.match(content, /Derived findings/, `${template} Open Questions table lacks the Derived findings column`);
		const validation = content.split(/^## Validation\s*$/m)[1] ?? "";
		assert.match(validation, /Unsettled findings/, `${template} validation table lacks the pairing criterion`);
		assert.match(validation, /quantitative specific/, `${template} validation table lacks the cite-or-hedge criterion`);
	}
});
