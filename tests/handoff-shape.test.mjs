// #453 and #454: a model-written handoff (or amendment) whose entries have the
// wrong shape is refused with a message the model can act on, instead of being
// filtered into a completion that silently loses state; and the Pi phase
// runner hands that refusal back to the still-live sub-agent for one repair
// turn instead of stranding a finished phase.
//
// The fixtures are the shapes a real run produced (a local 27B model on a
// full-with-deep-audit pipeline): closures written as `{ id, closure }`, open
// questions with their text under `question:`, and owner_notes as one folded
// string.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = (name) => import(pathToFileURL(`${REPO_ROOT}/core/${name}.ts`).href);

const { loadYamlFile, parseSimpleYaml, stringifySimpleYaml } = await core("yaml");
const { parseHandoff, ensureIdArray } = await core("status");
const { loadAmendmentFile } = await core("amendment");
const { getWorkspaceState } = await core("workspace");
const { validatePhaseOutput } = await core("pipeline");
const { completeValidatedPhase, checkPhaseHandoff } = await core("completion");
const { finishPhaseSession, buildHandoffRepairPrompt } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/agent-runner.ts`).href
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PHASE_OUTPUTS = {
	architecture: "findings/architecture/architecture-map.md",
	contracts: "findings/contracts/behavioral-contracts.md",
};

async function liteWorkspace() {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-shape-"));
	await cp(join(REPO_ROOT, ".codecarto"), join(cwd, ".codecarto"), { recursive: true });
	const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
	const raw = await loadYamlFile(statusPath);
	raw.pipeline = "workflow/pipeline-lite.yaml";
	await writeFile(statusPath, `${stringifySimpleYaml(raw)}\n`, "utf8");
	return cwd;
}

async function writePassingOutput(cwd, phaseId, extra = "") {
	const outputPath = join(cwd, ".codecarto", PHASE_OUTPUTS[phaseId]);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, [
		`# ${phaseId}`, "", "Body.", extra, "",
		"## Validation", "",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		"| 1 | The output exists. | PASS | §above |", "",
		"**Overall:** PASS", "",
	].join("\n"), "utf8");
}

async function writeHandoff(cwd, phaseId, lines) {
	const handoffPath = join(cwd, ".codecarto", "scratch", "handoffs", `${phaseId}.yaml`);
	await mkdir(dirname(handoffPath), { recursive: true });
	await writeFile(handoffPath, ["schema_version: 1", `phase_id: ${phaseId}`, ...lines, ""].join("\n"), "utf8");
}

async function complete(cwd, phaseId) {
	const state = await getWorkspaceState(cwd);
	return completeValidatedPhase(cwd, await validatePhaseOutput(state, phaseId), "handoff-shape-test");
}

/** Architecture complete, with arch-CF1 routed to contracts. */
async function workspaceWithRoutedItem() {
	const cwd = await liteWorkspace();
	await writePassingOutput(cwd, "architecture");
	await writeHandoff(cwd, "architecture", [
		"carry_forward:",
		"  - id: arch-CF1",
		"    kind: defer-to-phase",
		"    target_phase: contracts",
		"    description: Verify end-to-end path-boundary enforcement.",
		"closeout_summary: Architecture mapped.",
	]);
	await complete(cwd, "architecture");
	return cwd;
}

const routedIds = (state) => Object.values(state.status.phases).flatMap((phase) => phase.carry_forward.map((entry) => entry.id));

// ---------------------------------------------------------------------------
// #453 — closures
// ---------------------------------------------------------------------------

test("#453: carry_forward_closures accepts { id, … } mappings, not only bare ids", () => {
	const handoff = parseHandoff({
		phase_id: "contracts",
		carry_forward_closures: ["arch-CF1", { id: " arch-CF2 ", closure: "Closed as defect." }, { id: "arch-CF4" }],
	});
	assert.deepEqual(handoff.carry_forward_closures, ["arch-CF1", "arch-CF2", "arch-CF4"]);
});

test("#453 review: a closure's rationale is kept as an owner note, not dropped with the mapping", () => {
	const handoff = parseHandoff({
		phase_id: "contracts",
		owner_notes: ["Own note."],
		carry_forward_closures: [{ id: "arch-CF1", closure: "Closed as doc bug, both sides." }, "arch-CF2", { id: "arch-CF4" }],
		open_question_closures: [{ id: "q-sanity", closure: "README is wrong." }, { id: "q-spike", evidence: "scratch/spikes/x.md" }],
	});
	assert.deepEqual(handoff.owner_notes, [
		"Own note.",
		"arch-CF1 closure: Closed as doc bug, both sides.",
		"q-sanity closure: README is wrong.",
	], "evidence is carried on the closure itself, so it is not repeated as a note");
	assert.deepEqual(handoff.open_question_closures, [{ id: "q-sanity" }, { id: "q-spike", evidence: "scratch/spikes/x.md" }]);
});

test("#453 review: a one-key closure gets a hint naming the likely id", () => {
	assert.throws(
		() => parseHandoff({ phase_id: "contracts", carry_forward_closures: [{ "arch-CF1": "closed as doc bug" }] }),
		/has no id\..*If "arch-CF1" is the id, write `- id: arch-CF1`/s,
	);
});

test("#453: an object-shaped closure actually closes the routed item at completion", async () => {
	const cwd = await workspaceWithRoutedItem();
	try {
		assert.ok(routedIds(await getWorkspaceState(cwd)).includes("arch-CF1"), "fixture routes arch-CF1");
		await writePassingOutput(cwd, "contracts", "\narch-CF1 closed: containment lives in the permission engine.\n");
		await writeHandoff(cwd, "contracts", [
			"carry_forward_closures:",
			"  - id: arch-CF1",
			"    closure: >",
			"      Closed as doc bug, both sides.",
			"closeout_summary: Contracts documented.",
		]);
		const result = await complete(cwd, "contracts");
		assert.equal(routedIds(result.updatedState).includes("arch-CF1"), false, "the routed item is removed, not left open");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("#453: a closure entry with no id, or of another shape, is refused and names the entry", () => {
	assert.throws(
		() => parseHandoff({ phase_id: "contracts", carry_forward_closures: ["arch-CF1", { closure: "no id here" }] }),
		/carry_forward_closures\[1\] has no id.*- id: arch-CF1/s,
	);
	assert.throws(
		() => parseHandoff({ phase_id: "contracts", carry_forward_closures: [["arch-CF1"]] }),
		/carry_forward_closures\[0\] is a list/,
	);
	assert.throws(
		() => parseHandoff({ phase_id: "contracts", open_question_closures: [{ evidence: "spike.md" }] }),
		/open_question_closures\[0\] has no id/,
	);
});

test("#453: empty list items carry nothing and are still skipped", () => {
	const handoff = parseHandoff({
		phase_id: "contracts",
		owner_notes: ["kept", null],
		carry_forward_closures: [null, "arch-CF1", ""],
		open_questions: [null],
	});
	assert.deepEqual(handoff.owner_notes, ["kept"]);
	assert.deepEqual(handoff.carry_forward_closures, ["arch-CF1"]);
	assert.deepEqual(handoff.open_questions, []);
	assert.deepEqual(ensureIdArray([2048, " x ", { id: 7 }, {}]), ["2048", "x", "7"], "numeric ids read back as text");
});

// ---------------------------------------------------------------------------
// #453 — text lists
// ---------------------------------------------------------------------------

test("#453: an unquoted note containing ': ' is rejoined into its line, not dropped", () => {
	// `- Execution strategy: inline.` is a one-key mapping to YAML; before #453
	// it vanished from owner_notes without a word.
	const handoff = parseHandoff({
		phase_id: "architecture",
		owner_notes: [{ "Execution strategy": "inline." }, "plain"],
		decisions: [{ decision: "Kept the marker vocabulary", rationale: "two phases used it" }],
	});
	assert.deepEqual(handoff.owner_notes, ["Execution strategy: inline.", "plain"]);
	assert.deepEqual(handoff.decisions, ["decision: Kept the marker vocabulary; rationale: two phases used it"]);
});

test("#453: the rejoin covers what the YAML reader actually produces for an unquoted note", () => {
	const raw = parseSimpleYaml(["phase_id: architecture", "owner_notes:", "  - Execution strategy: inline.", "  - Plain note."].join("\n"));
	assert.deepEqual(raw.owner_notes[0], { "Execution strategy": "inline." }, "the reader yields a mapping for this line");
	assert.deepEqual(parseHandoff(raw).owner_notes, ["Execution strategy: inline.", "Plain note."]);
});

test("#453 review: a bare `key:` note keeps its colon, and `- {}` is skipped like an empty item", () => {
	const handoff = parseHandoff({ phase_id: "architecture", owner_notes: [{ Summary: null }, {}, "x"] });
	assert.deepEqual(handoff.owner_notes, ["Summary:", "x"]);
});

test("#453: a note with nested structure is refused instead of dropped", () => {
	assert.throws(
		() => parseHandoff({ phase_id: "architecture", owner_notes: ["fine", { note: ["a", "b"] }] }),
		/owner_notes\[1\] is a mapping with nested structure, not text/,
	);
	assert.throws(
		() => parseHandoff({ phase_id: "architecture", decisions: [["D1", "D2"]] }),
		/decisions\[0\] is a list with nested structure, not text/,
	);
	// Scalars still read back as text, as they always have (#225).
	assert.deepEqual(parseHandoff({ phase_id: "architecture", owner_notes: [2048, true] }).owner_notes, ["2048", "true"]);
});

test("#453: owner_notes written as one folded string still fails as a non-array", () => {
	assert.throws(() => parseHandoff({ phase_id: "architecture", owner_notes: "Completed all three passes." }), /owner_notes must be an array/);
});

// ---------------------------------------------------------------------------
// #453 — structured entries
// ---------------------------------------------------------------------------

test("#453: an open question whose text is under an unrecognized key is refused, naming the keys", () => {
	assert.throws(
		() => parseHandoff({
			phase_id: "defect-scan-mechanical",
			open_questions: [{
				id: "q-macos-libc",
				kind: "needs-runtime-test",
				question: "Does .NET on macOS resolve DllImport(\"libc\")?",
				why_source_cannot_settle: "Requires a macOS host.",
			}],
		}),
		(error) => {
			assert.match(error.message, /open_questions entry "q-macos-libc" has no description/);
			assert.match(error.message, /under fields completion does not read \(question, why_source_cannot_settle\)/);
			assert.match(error.message, /description.*deferred_reason/s);
			return true;
		},
	);
});

test("#453: carry_forward and post_pipeline entries with their text under an unread key are refused", () => {
	assert.throws(
		() => parseHandoff({ phase_id: "architecture", carry_forward: [{ id: "arch-CF9", target_phase: "contracts", summary: "x" }] }),
		/carry_forward entry "arch-CF9" has no description and its text is under a field completion does not read \(summary\)/,
	);
	assert.throws(
		() => parseHandoff({ phase_id: "architecture", post_pipeline: [{ id: "post-1", kind: "spike", task: "Capture restart behavior" }] }),
		/post_pipeline entry "post-1" has no description.*\(task\)\. Recognized fields/,
	);
	assert.throws(() => parseHandoff({ phase_id: "architecture", open_questions: [42] }), /open_questions\[0\] is a number/);
});

test("#453 review: an entry made only of recognized fields loses nothing and is still accepted", () => {
	// These completed before #453 with every field kept; no document forbade
	// them, so refusing them would break working handoffs.
	const handoff = parseHandoff({
		phase_id: "architecture",
		carry_forward: [{ id: "arch-CF2", kind: "defer-to-phase", target_phase: "contracts", deferred_reason: "Wire formats are the protocols rubric." }],
		post_pipeline: [{ id: "post-1", kind: "spike" }],
		open_questions: [{ id: "q-1", kind: "needs-runtime-test", description: "" }],
	});
	assert.equal(handoff.carry_forward[0].deferred_reason, "Wire formats are the protocols rubric.");
	assert.equal(handoff.post_pipeline[0].id, "post-1");
	assert.equal(handoff.open_questions[0].id, "q-1");
});

test("#453: well-formed entries — bare strings, and mappings with extra keys beside a description — still parse", () => {
	const handoff = parseHandoff({
		phase_id: "architecture",
		open_questions: ["Is the cache key canonical?", { id: "q-1", kind: "needs-runtime-test", description: "Q", severity: "low" }],
		carry_forward: [{ id: "arch-CF1", target_phase: "contracts", description: "D" }],
	});
	assert.equal(handoff.open_questions.length, 2);
	assert.equal(handoff.open_questions[0].description, "Is the cache key canonical?");
	assert.equal(handoff.carry_forward[0].target_phase, "contracts");
});

// ---------------------------------------------------------------------------
// #453 — the amendment sibling
// ---------------------------------------------------------------------------

async function withAmendment(lines, fn) {
	const workspaceDir = await mkdtemp(join(tmpdir(), "cc-amend-shape-"));
	try {
		await mkdir(join(workspaceDir, "scratch", "amendments"), { recursive: true });
		await writeFile(join(workspaceDir, "scratch", "amendments", "a.yaml"), ["schema_version: 1", ...lines, ""].join("\n"), "utf8");
		await fn(workspaceDir);
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
}

test("#453: an amendment closure written as { id, evidence } is applied and its evidence recorded", async () => {
	await withAmendment([
		"open_question_closures:",
		"  - q-bare",
		"  - id: q-macos-libc",
		"    evidence: scratch/spikes/macos-libc.md",
		"post_pipeline_closures:",
		"  - id: post-1",
		"notes:",
		"  - A note.",
	], async (workspaceDir) => {
		const amendment = await loadAmendmentFile("a", workspaceDir);
		assert.deepEqual(amendment.open_question_closures, ["q-bare", "q-macos-libc"]);
		assert.deepEqual(amendment.post_pipeline_closures, ["post-1"]);
		assert.deepEqual(amendment.notes, ["A note.", "q-macos-libc closed on: scratch/spikes/macos-libc.md"]);
	});
});

test("#453: a malformed amendment entry is refused rather than dropped", async () => {
	await withAmendment(["open_question_closures:", "  - evidence: orphan"], async (workspaceDir) => {
		await assert.rejects(loadAmendmentFile("a", workspaceDir), /Invalid amendment: open_question_closures\[0\] has no id/);
	});
	await withAmendment(["notes:", "  - key:", "      - nested"], async (workspaceDir) => {
		await assert.rejects(loadAmendmentFile("a", workspaceDir), /Invalid amendment: notes\[0\] is a mapping with nested structure, not text/);
	});
});

test("#453 review: amendment notes and closure evidence reach the closeout even when closeout_content is supplied", async () => {
	const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
	const { applyAmendment } = await core("amendment");
	const cwd = await mkdtemp(join(tmpdir(), "cc-amend-closeout-"));
	try {
		await handleInit({ cwd, pipeline: "architecture-only" });
		await writePassingOutput(cwd, "architecture");
		await writeHandoff(cwd, "architecture", [
			"open_questions:",
			"  - id: q-macos-libc",
			"    kind: needs-runtime-test",
			"    description: Does DllImport(libc) resolve on macOS?",
			"closeout_summary: Mapped.",
		]);
		await complete(cwd, "architecture");
		const dir = join(cwd, ".codecarto", "scratch", "amendments");
		await mkdir(dir, { recursive: true });
		// The template's own shape: a non-empty closeout_content.
		await writeFile(join(dir, "macos.yaml"), [
			"schema_version: 1",
			"open_question_closures:",
			"  - id: q-macos-libc",
			"    evidence: scratch/spikes/macos-libc.md",
			"notes:",
			"  - Ran on an M2 runner.",
			"closeout_summary: macOS question settled.",
			"closeout_content: |-",
			"  # Amendment — macos",
			"",
		].join("\n"), "utf8");
		const result = await applyAmendment(cwd, "macos");
		const closeoutPath = join(cwd, result.closeoutNotice.replace(/^Closeout: /, ""));
		const closeout = await readFile(closeoutPath, "utf8");
		assert.match(closeout, /^# Amendment — macos/);
		assert.match(closeout, /## Notes\n\n- Ran on an M2 runner\.\n- q-macos-libc closed on: scratch\/spikes\/macos-libc\.md/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("#454 review: an unreadable workspace is not a handoff refusal to spend the repair turn on", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-no-workspace-"));
	try {
		const check = await checkPhaseHandoff(cwd, "architecture");
		assert.equal(check.ok, true);
		assert.match(check.warnings[0], /Handoff not checked/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// #454 — checkPhaseHandoff: completion's verdict, without the writes
// ---------------------------------------------------------------------------

test("#454: checkPhaseHandoff accepts a handoff completion would accept", async () => {
	const cwd = await workspaceWithRoutedItem();
	try {
		await writePassingOutput(cwd, "contracts", "\narch-CF1 closed.\n");
		await writeHandoff(cwd, "contracts", ["carry_forward_closures:", "  - arch-CF1", "closeout_summary: Done."]);
		assert.deepEqual(await checkPhaseHandoff(cwd, "contracts"), { ok: true, warnings: [] });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("#454: checkPhaseHandoff returns completion's own refusal and changes nothing", async () => {
	const cwd = await workspaceWithRoutedItem();
	const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
	try {
		await writePassingOutput(cwd, "contracts");
		const cases = [
			[["owner_notes: >", "  One folded string."], /owner_notes must be an array/],
			[["open_questions:", "  - id: q-x", "    question: lost"], /open_questions entry "q-x" has no description/],
			[["carry_forward:", "  - id: c-1", "    target_phase: architecture", "    description: upstream"], /not a downstream active pipeline phase/],
		];
		for (const [lines, pattern] of cases) {
			await writeHandoff(cwd, "contracts", [...lines, "closeout_summary: Done."]);
			const before = await readFile(statusPath, "utf8");
			const check = await checkPhaseHandoff(cwd, "contracts");
			assert.equal(check.ok, false);
			assert.match(check.error, pattern);
			// The same message completion gives, word for word.
			await assert.rejects(complete(cwd, "contracts"), (error) => error.message === check.error);
			assert.equal(await readFile(statusPath, "utf8"), before, "neither the check nor the refused completion wrote status");
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("#454: checkPhaseHandoff reports a required handoff that is missing", async () => {
	const cwd = await liteWorkspace();
	try {
		const check = await checkPhaseHandoff(cwd, "architecture");
		assert.equal(check.ok, false);
		assert.match(check.error, /declares handoff_requirements, but no phase handoff exists/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// #454 — the repair turn
// ---------------------------------------------------------------------------

function fakeSession(messages = [{ role: "assistant", stopReason: "stop" }]) {
	const prompts = [];
	return { prompts, messages, prompt: async (text) => { prompts.push(text); } };
}

async function withPrimaryOutput(present, fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-finish-"));
	try {
		if (present) {
			await mkdir(join(cwd, ".codecarto", "findings"), { recursive: true });
			await writeFile(join(cwd, ".codecarto", "findings", "out.md"), "done");
		}
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

const finishOptions = (cwd, overrides = {}) => ({
	cwd,
	primaryOutput: "findings/out.md",
	compactionCompleted: Promise.resolve(false),
	isAborted: () => false,
	...overrides,
});

test("#454: a refused handoff gets exactly one repair turn carrying the refusal verbatim", async () => {
	await withPrimaryOutput(true, async (cwd) => {
		const session = fakeSession();
		const refusal = "Invalid handoff: owner_notes must be an array";
		let checks = 0;
		const refused = [];
		const result = await finishPhaseSession(session, finishOptions(cwd, {
			checkHandoff: async () => { checks++; return refusal; },
			onHandoffRefused: (text) => refused.push(text),
		}));
		assert.equal(checks, 1, "checked once — a second refusal is completion's to report, not another turn");
		assert.equal(session.prompts.length, 1);
		assert.equal(session.prompts[0], buildHandoffRepairPrompt(refusal));
		assert.ok(session.prompts[0].includes(refusal));
		assert.match(session.prompts[0], /scratch\/handoffs/);
		assert.match(session.prompts[0], /Do not redo the analysis/);
		assert.deepEqual(refused, [refusal]);
		assert.deepEqual(result, { handoffRefusal: refusal });
	});
});

test("#454: an accepted handoff costs no extra turn", async () => {
	await withPrimaryOutput(true, async (cwd) => {
		const session = fakeSession();
		const result = await finishPhaseSession(session, finishOptions(cwd, { checkHandoff: async () => null }));
		assert.deepEqual(session.prompts, []);
		assert.deepEqual(result, {});
	});
});

test("#454: no handoff check without a primary output, and none after an abort", async () => {
	await withPrimaryOutput(false, async (cwd) => {
		let checks = 0;
		const session = fakeSession();
		await finishPhaseSession(session, finishOptions(cwd, { checkHandoff: async () => { checks++; return "refused"; } }));
		assert.equal(checks, 0, "a phase with no output failed on its own terms; validation reports it");
		assert.equal(session.prompts.length, 1, "the existing missing-output continuation still runs");
		assert.match(session.prompts[0], /primary output/);
	});
	await withPrimaryOutput(true, async (cwd) => {
		let checks = 0;
		const session = fakeSession();
		await finishPhaseSession(session, finishOptions(cwd, { isAborted: () => true, checkHandoff: async () => { checks++; return "refused"; } }));
		assert.equal(checks, 0);
		assert.deepEqual(session.prompts, []);
	});
});

test("#454: runSinglePhase wires the handoff check into the phase run", async () => {
	const source = await readFile(join(REPO_ROOT, "extensions", "codecarto", "auto-runner.ts"), "utf8");
	assert.match(source, /checkHandoff: async \(\) => \{\s*const check = await checkPhaseHandoff\(state\.cwd, phase\.id\)/);
	assert.match(source, /onHandoffRefused:/);
});
