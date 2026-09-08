// Stage 3 of issue #122 (#186): closure integrity in the handoff schema.
//
// Stages 1 and 2 read what a finding's own cells said; nothing checked whether
// a *closure* was honest. `applyHandoff` removed carry_forward and
// open_questions entries by id unconditionally, so a phase could close a routed
// item whose originating question was still open — the exact shape #122
// reported. These pin the three additions and, just as load-bearing, pin that a
// handoff using none of them behaves exactly as it did before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { loadYamlFile, stringifySimpleYaml } = await import(pathToFileURL(`${REPO_ROOT}/core/yaml.ts`).href);
const { parseHandoff, applyHandoff, ensureClosureArray } = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);
const { getWorkspaceState } = await import(pathToFileURL(`${REPO_ROOT}/core/workspace.ts`).href);
const { validatePhaseOutput } = await import(pathToFileURL(`${REPO_ROOT}/core/pipeline.ts`).href);
const { completeValidatedPhase, CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION } = await import(pathToFileURL(`${REPO_ROOT}/core/completion.ts`).href);
const { buildPhasePrompt } = await import(pathToFileURL(`${REPO_ROOT}/core/prompts.ts`).href);
const { parseCoverageAndLimits, collectCoverageGaps } = await import(pathToFileURL(`${REPO_ROOT}/core/coverage.ts`).href);

// The `lite` pipeline is the smallest one with a real downstream phase, which
// carry_forward routing requires: architecture -> contracts -> protocols.
const LITE_PIPELINE = "workflow/pipeline-lite.yaml";
const PHASE_OUTPUTS = {
	architecture: "findings/architecture/architecture-map.md",
	contracts: "findings/contracts/behavioral-contracts.md",
};

async function initWorkspace(cwd, pipeline = LITE_PIPELINE) {
	await cp(join(REPO_ROOT, ".codecarto"), join(cwd, ".codecarto"), { recursive: true });
	const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
	const raw = await loadYamlFile(statusPath);
	raw.pipeline = pipeline;
	await writeFile(statusPath, `${stringifySimpleYaml(raw)}\n`, "utf8");
}

/** A minimal primary output that validates PASS, plus an optional extra section. */
async function writePassingOutput(cwd, phaseId, extra = "") {
	const outputPath = join(cwd, ".codecarto", PHASE_OUTPUTS[phaseId]);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, [
		`# ${phaseId}`,
		"",
		"Body.",
		extra,
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		"| 1 | The output exists. | PASS | §above |",
		"",
		"**Overall:** PASS",
		"",
	].join("\n"), "utf8");
}

async function writeHandoff(cwd, phaseId, lines) {
	const handoffPath = join(cwd, ".codecarto", "scratch", "handoffs", `${phaseId}.yaml`);
	await mkdir(dirname(handoffPath), { recursive: true });
	await writeFile(handoffPath, [`schema_version: 1`, `phase_id: ${phaseId}`, ...lines, ""].join("\n"), "utf8");
}

/**
 * Pin the workspace's scaffold version. The runtime-evidence gate refuses only
 * from the scaffold that documents the rule, so a test asserting the refusal
 * must say which era it is in rather than inherit whatever the packaged
 * template happens to carry today.
 */
async function setScaffoldVersion(cwd, version) {
	const path = join(cwd, ".codecarto", "workflow", "scaffold-version.yaml");
	if (version === null) {
		await rm(path, { force: true });
		return;
	}
	await writeFile(path, `scaffold_version: ${version}\n`, "utf8");
}

async function complete(cwd, phaseId) {
	const state = await getWorkspaceState(cwd);
	const validation = await validatePhaseOutput(state, phaseId);
	return completeValidatedPhase(cwd, validation, "closure-integrity-test");
}

/**
 * A workspace whose architecture phase is complete, having registered one open
 * question and routed one candidate answer to contracts. `derives_from` is
 * written only when asked, so the same fixture serves the back-compat case.
 * @returns the temp cwd.
 */
async function workspaceWithRoutedCandidate({ derivesFrom = true, questionKind = "needs-runtime-test" } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-closure-"));
	await initWorkspace(cwd);
	await writePassingOutput(cwd, "architecture");
	await writeHandoff(cwd, "architecture", [
		"open_questions:",
		"  - id: q-logit-bias-root-cause",
		`    kind: ${questionKind}`,
		"    description: Three candidates explain the empty completion; source alone cannot determine which.",
		"    deferred_reason: Needs a probe against the running server.",
		"carry_forward:",
		"  - id: mech-CF3",
		"    kind: defer-to-phase",
		"    target_phase: contracts",
		...(derivesFrom ? ["    derives_from: q-logit-bias-root-cause"] : []),
		"    description: The client sends logit_bias as a map; the documented shape is an array.",
		"closeout_summary: Architecture mapped.",
	]);
	await complete(cwd, "architecture");
	return cwd;
}

// ---------------------------------------------------------------
// D1 — derives_from on carry-forward entries
// ---------------------------------------------------------------

test("D1: parseHandoff reads derives_from on carry_forward and nowhere else", () => {
	const handoff = parseHandoff({
		phase_id: "architecture",
		open_questions: [{ id: "q1", derives_from: "q0", description: "Q" }],
		carry_forward: [{ id: "cf1", target_phase: "contracts", derives_from: "  q1  ", description: "D" }],
	});
	assert.equal(handoff.carry_forward[0].derives_from, "q1", "trimmed and kept on the carry-forward path");
	assert.equal(handoff.open_questions[0].derives_from, undefined, "an open question has nothing to derive from");
});

test("D1: completion refuses a closure whose derives_from question is still open", async () => {
	const cwd = await workspaceWithRoutedCandidate();
	try {
		await writePassingOutput(cwd, "contracts", "\nmech-CF3 addressed by reshaping the payload.\n");
		await writeHandoff(cwd, "contracts", [
			"carry_forward_closures:",
			"  - mech-CF3",
			"closeout_summary: Contracts documented.",
		]);
		await assert.rejects(() => complete(cwd, "contracts"), (error) => {
			assert.match(error.message, /mech-CF3/, "refusal must name the routed item");
			assert.match(error.message, /q-logit-bias-root-cause/, "refusal must name the question");
			assert.match(error.message, /verify at runtime/, "refusal must name the unsettled action");
			return true;
		});
		const after = await getWorkspaceState(cwd);
		assert.equal(after.status.phases.contracts.status, "pending", "a refusal before the lock mutates nothing");
		assert.equal(
			after.status.phases.architecture.carry_forward.some((entry) => entry.id === "mech-CF3"),
			true,
			"the routed item stays routed",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D1: the same handoff may close both the routed item and its question", async () => {
	const cwd = await workspaceWithRoutedCandidate();
	try {
		await writePassingOutput(cwd, "contracts", "\nmech-CF3 and q-logit-bias-root-cause both settled.\n");
		await writeHandoff(cwd, "contracts", [
			"carry_forward_closures:",
			"  - mech-CF3",
			"open_question_closures:",
			"  - id: q-logit-bias-root-cause",
			"    evidence: scratch/spikes/logit-bias.md — probe against the running server.",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		assert.equal(result.updatedState.status.phases.contracts.status, "complete");
		const carried = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.carry_forward);
		const questions = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.open_questions);
		assert.equal(carried.some((entry) => entry.id === "mech-CF3"), false, "routed item removed");
		assert.equal(questions.some((entry) => entry.id === "q-logit-bias-root-cause"), false, "question removed");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D1: a derives_from naming an already-resolved question is fine", async () => {
	const cwd = await workspaceWithRoutedCandidate();
	try {
		// Resolve the question first, in its own handoff, leaving the routed item
		// behind. The link now points at an id that no longer exists.
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause settled; mech-CF3 still routed.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - id: q-logit-bias-root-cause",
			"    evidence: scratch/spikes/logit-bias.md — probe against the running server.",
			"closeout_summary: Question settled.",
		]);
		await complete(cwd, "contracts");

		await writePassingOutput(cwd, "contracts", "\nmech-CF3 addressed.\n");
		await writeHandoff(cwd, "contracts", [
			"carry_forward_closures:",
			"  - mech-CF3",
			"closeout_summary: Routed item closed.",
		]);
		const result = await complete(cwd, "contracts");
		const carried = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.carry_forward);
		assert.equal(carried.some((entry) => entry.id === "mech-CF3"), false, "closure applies with no question to guard");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D1: back-compat — a carry_forward with no derives_from is closed without comment", async () => {
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false });
	try {
		await writePassingOutput(cwd, "contracts", "\nmech-CF3 addressed.\n");
		await writeHandoff(cwd, "contracts", [
			"carry_forward_closures:",
			"  - mech-CF3",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		const carried = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.carry_forward);
		const questions = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.open_questions);
		assert.equal(carried.some((entry) => entry.id === "mech-CF3"), false, "routed item removed as before");
		assert.equal(questions.some((entry) => entry.id === "q-logit-bias-root-cause"), true, "the question is untouched, as before");
		assert.deepEqual(result.warnings, [], "no new warning for a handoff that uses none of the new fields");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------
// D3 — evidence on open-question closures
// ---------------------------------------------------------------

test("D3: ensureClosureArray coerces strings, trims, and drops entries with no usable id", () => {
	assert.deepEqual(ensureClosureArray(["  q-one  ", "", { id: " q-two ", evidence: "  spike.md  " }, { evidence: "orphan" }, { id: "   " }, null, ["nested"]]), [
		{ id: "q-one" },
		{ id: "q-two", evidence: "spike.md" },
	]);
	assert.deepEqual(ensureClosureArray(undefined), []);
	assert.deepEqual(ensureClosureArray("not-an-array"), []);
});

test("D3: parseHandoff accepts both closure shapes and applyHandoff matches on .id", () => {
	const handoff = parseHandoff({
		phase_id: "contracts",
		open_question_closures: ["q-bare", { id: "q-evidenced", evidence: "spike report" }],
	});
	assert.deepEqual(handoff.open_question_closures, [{ id: "q-bare" }, { id: "q-evidenced", evidence: "spike report" }]);

	const status = {
		phases: {
			architecture: { status: "complete", owner_notes: [], outputs_present: [], open_questions: [{ id: "q-bare" }, { id: "q-evidenced" }, { id: "q-kept" }], carry_forward: [] },
			contracts: { status: "pending", owner_notes: [], outputs_present: [], open_questions: [], carry_forward: [] },
		},
		post_pipeline: [],
	};
	applyHandoff(status, { ...handoff, owner_notes: [], open_questions: [], carry_forward: [], carry_forward_closures: [], post_pipeline: [], decisions: [], proposed_conventions: [] });
	assert.deepEqual(status.phases.architecture.open_questions.map((entry) => entry.id), ["q-kept"]);
});

test("D3: back-compat — a bare-string closure still resolves a question", async () => {
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false, questionKind: "needs-maintainer-decision" });
	try {
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause answered.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - q-logit-bias-root-cause",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		const questions = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.open_questions);
		assert.equal(questions.some((entry) => entry.id === "q-logit-bias-root-cause"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D3: completion refuses an evidence-free closure of a needs-runtime-test question", async () => {
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false });
	try {
		await setScaffoldVersion(cwd, CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION);
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause closed by re-reading the client.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - q-logit-bias-root-cause",
			"closeout_summary: Contracts documented.",
		]);
		await assert.rejects(() => complete(cwd, "contracts"), (error) => {
			assert.match(error.message, /q-logit-bias-root-cause/, "refusal must name the question");
			assert.match(error.message, /needs-runtime-test/);
			assert.match(error.message, /runtime evidence/);
			return true;
		});
		const after = await getWorkspaceState(cwd);
		assert.equal(after.status.phases.contracts.status, "pending", "a refusal before the lock mutates nothing");
		assert.equal(
			after.status.phases.architecture.open_questions.some((entry) => entry.id === "q-logit-bias-root-cause"),
			true,
			"the question stays open",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D3: an empty evidence string does not satisfy the gate", async () => {
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false });
	try {
		await setScaffoldVersion(cwd, CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION);
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - id: q-logit-bias-root-cause",
			'    evidence: "   "',
			"closeout_summary: Contracts documented.",
		]);
		await assert.rejects(() => complete(cwd, "contracts"), /needs-runtime-test/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D3: a needs-runtime-test question closes when the closure carries evidence", async () => {
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false });
	try {
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause closed on a runtime probe.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - id: q-logit-bias-root-cause",
			"    evidence: scratch/spikes/logit-bias.md — probe against llama-server b4321.",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		const questions = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.open_questions);
		assert.equal(questions.some((entry) => entry.id === "q-logit-bias-root-cause"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D3: a question of any other kind still closes without evidence", async () => {
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false, questionKind: "needs-spec-ruling" });
	try {
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause ruled on.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - id: q-logit-bias-root-cause",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		const questions = Object.values(result.updatedState.status.phases).flatMap((phase) => phase.open_questions);
		assert.equal(questions.some((entry) => entry.id === "q-logit-bias-root-cause"), false, "the gate is narrow to needs-runtime-test");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D3: an older scaffold gets a warning instead of a refusal", async () => {
	// The rule can bind a handoff that uses none of the new fields, because a
	// bare-string closure was the only shape before it existed. A workspace
	// scaffolded before the templates documented the rule must not have an
	// in-flight run stopped by it — Stage 2's pairing check draws the same line.
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false });
	try {
		await setScaffoldVersion(cwd, "0.18.0");
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause closed by re-reading the client.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - q-logit-bias-root-cause",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		assert.equal(result.updatedState.status.phases.contracts.status, "complete", "the older era completes");
		assert.ok(
			result.warnings.some((warning) => /q-logit-bias-root-cause/.test(warning) && /Warning only/.test(warning)),
			`expected a non-gating note naming the question, got: ${JSON.stringify(result.warnings)}`,
		);
		assert.ok(
			result.warnings.some((warning) => /refresh/i.test(warning)),
			"the note must say how to opt in",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("D3: an unversioned scaffold warns rather than refusing", async () => {
	const cwd = await workspaceWithRoutedCandidate({ derivesFrom: false });
	try {
		await setScaffoldVersion(cwd, null);
		await writePassingOutput(cwd, "contracts", "\nq-logit-bias-root-cause closed by re-reading the client.\n");
		await writeHandoff(cwd, "contracts", [
			"open_question_closures:",
			"  - q-logit-bias-root-cause",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		assert.equal(result.updatedState.status.phases.contracts.status, "complete");
		assert.ok(result.warnings.some((warning) => /q-logit-bias-root-cause/.test(warning)));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------
// E — the coverage-gap ledger reaches the next phase's prompt
// ---------------------------------------------------------------

const TEMPLATE_SHAPED_SECTION = [
	"# Architecture",
	"",
	"## Coverage and limits",
	"",
	"- Inspected scope: src/, launch.bat, the packaged manifest",
	"- Skipped scope: vendored dependencies under third_party/",
	"- Evidence basis: source inspection | upstream findings",
	"- Known blind spots:",
	"  - the encoded search-proxy command (launch.bat:1608) was not fully decoded",
	"  - the updater's signature check was read but not exercised",
	"- Coverage disposition: PARTIAL",
	"",
	"## Open Questions",
	"",
	"None.",
	"",
].join("\n");

test("E: the parser reads a template-shaped Coverage and limits section", () => {
	const ledger = parseCoverageAndLimits(TEMPLATE_SHAPED_SECTION);
	assert.equal(ledger.inspected_scope, "src/, launch.bat, the packaged manifest");
	assert.equal(ledger.skipped_scope, "vendored dependencies under third_party/");
	assert.equal(ledger.evidence_basis, "source inspection | upstream findings");
	assert.equal(
		ledger.known_blind_spots,
		"the encoded search-proxy command (launch.bat:1608) was not fully decoded; the updater's signature check was read but not exercised",
		"sub-bullets belong to their label and fold onto one line",
	);
	assert.equal(ledger.coverage_disposition, "PARTIAL");
});

test("E: the parser tolerates a missing section and empty bullets without throwing", async () => {
	assert.equal(parseCoverageAndLimits("# Report\n\nNo ledger here.\n"), null);
	assert.equal(parseCoverageAndLimits(""), null);
	const empty = parseCoverageAndLimits("## Coverage and limits\n\n- Inspected scope:\n- Skipped scope:\n- Known blind spots:\n");
	assert.deepEqual(empty, {
		inspected_scope: "",
		skipped_scope: "",
		evidence_basis: "",
		known_blind_spots: "",
		coverage_disposition: "",
	});
	// The shipped template's own untouched section contributes nothing.
	const { readFile } = await import("node:fs/promises");
	const template = await readFile(join(REPO_ROOT, ".codecarto", "templates", "architecture-map.md"), "utf8");
	const fromTemplate = parseCoverageAndLimits(template);
	assert.equal(fromTemplate.skipped_scope, "");
	assert.equal(fromTemplate.known_blind_spots, "");
});

test("E: a completed phase's declared gaps reach the next phase's prompt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-coverage-"));
	try {
		await initWorkspace(cwd);
		await writePassingOutput(cwd, "architecture", [
			"",
			"## Coverage and limits",
			"",
			"- Inspected scope: src/",
			"- Skipped scope: vendored dependencies under third_party/",
			"- Evidence basis: source inspection",
			"- Known blind spots: the encoded search-proxy command was not fully decoded",
			"- Coverage disposition: PARTIAL",
		].join("\n"));
		await writeHandoff(cwd, "architecture", ["closeout_summary: Architecture mapped."]);

		const before = await getWorkspaceState(cwd);
		const contractsPhase = before.pipeline.phases.find((phase) => phase.id === "contracts");
		const promptBefore = await buildPhasePrompt(before, contractsPhase, false);
		assert.doesNotMatch(promptBefore, /declared these coverage gaps/, "nothing is surfaced before the phase completes");
		assert.deepEqual(await collectCoverageGaps(before), [], "no completed phase, no gaps");

		await complete(cwd, "architecture");

		const after = await getWorkspaceState(cwd);
		assert.deepEqual(await collectCoverageGaps(after), [
			{ phaseId: "architecture", label: "skipped scope", detail: "vendored dependencies under third_party/", output: PHASE_OUTPUTS.architecture },
			{ phaseId: "architecture", label: "known blind spots", detail: "the encoded search-proxy command was not fully decoded", output: PHASE_OUTPUTS.architecture },
		]);

		const prompt = await buildPhasePrompt(after, contractsPhase, false);
		assert.match(prompt, /Upstream phases declared these coverage gaps/);
		assert.match(prompt, /must either close the gap with cited new evidence of its own or inherit its uncertainty/);
		assert.match(prompt, /^ {2}- architecture \(skipped scope\): vendored dependencies under third_party\/$/m);
		assert.match(prompt, /^ {2}- architecture \(known blind spots\): the encoded search-proxy command was not fully decoded$/m);
		// Non-gating and surface-agnostic: it is a duty bullet, and both
		// surfaces get it from buildPhasePrompt.
		const auto = await buildPhasePrompt(after, contractsPhase, false, { auto: true });
		assert.match(auto, /^ {2}- architecture \(known blind spots\)/m);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("E: a completed phase with an untouched ledger contributes no duty bullet", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-coverage-empty-"));
	try {
		await initWorkspace(cwd);
		await writePassingOutput(cwd, "architecture", "\n## Coverage and limits\n\n- Inspected scope: src/\n- Skipped scope:\n- Known blind spots:\n");
		await writeHandoff(cwd, "architecture", ["closeout_summary: Architecture mapped."]);
		await complete(cwd, "architecture");

		const after = await getWorkspaceState(cwd);
		const contractsPhase = after.pipeline.phases.find((phase) => phase.id === "contracts");
		const prompt = await buildPhasePrompt(after, contractsPhase, false);
		assert.doesNotMatch(prompt, /declared these coverage gaps/);
		assert.match(prompt, /Contradiction sweep:/, "the rest of the duties block is unaffected");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
