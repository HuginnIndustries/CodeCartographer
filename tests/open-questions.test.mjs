import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(join(ROOT, "core/index.ts")).href);

async function initWorkspace(cwd, pipelinePath = "workflow/pipeline-architecture-only.yaml") {
	await cp(join(ROOT, ".codecarto"), join(cwd, ".codecarto"), { recursive: true });
	const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
	const pipeline = await core.loadYamlFile(join(cwd, ".codecarto", pipelinePath));
	const status = core.createEmptyStatus("test", pipelinePath, pipeline);
	status.last_updated = new Date().toISOString();
	await writeFile(statusPath, `${core.stringifySimpleYaml(status)}\n`, "utf8");
}

function validation(phaseId = "architecture") {
	return { phaseId, primaryOutput: `findings/${phaseId}/${phaseId}-map.md`, outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
}

test("parseHandoff auto-assigns canonical IDs to open_questions missing them", async () => {
	const handoff = core.parseHandoff({
		phase_id: "architecture",
		open_questions: [
			{ description: "what does loadConfig return on parse error" },
			{ id: "q-explicit", description: "explicit id" },
		],
	});
	assert.equal(handoff.open_questions[0].id, "oq-architecture-1");
	assert.equal(handoff.open_questions[1].id, "q-explicit");
});

test("parseHandoff auto-assigns canonical IDs to carry_forward missing them", async () => {
	const handoff = core.parseHandoff({
		phase_id: "architecture",
		carry_forward: [
			{ target_phase: "defect-scan", description: "defer the loadConfig ambiguity" },
		],
	});
	assert.equal(handoff.carry_forward[0].id, "cf-architecture-1");
});

test("open_questions merge across phases by canonical id without creating duplicates", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-oq-"));
	try {
		await initWorkspace(cwd, "workflow/pipeline-full-with-deep-audit.yaml");
		const dir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(dir, { recursive: true });

		// Phase 1 raises a question with an explicit id
		await writeFile(join(dir, "architecture.yaml"), [
			"phase_id: architecture",
			"open_questions:",
			"  - id: q-loadconfig",
			"    description: loadConfig returns {} on both ENOENT and parse-error",
			"closeout_summary: done",
		].join("\n"), "utf8");
		await core.completeValidatedPhase(cwd, validation("architecture"), "test");

		// Phase 2 raises the same question with the same explicit id
		await writeFile(join(dir, "contracts.yaml"), [
			"phase_id: contracts",
			"open_questions:",
			"  - id: q-loadconfig",
			"    description: loadConfig returns {} on both ENOENT and parse-error (confirmed)",
			"closeout_summary: done",
		].join("\n"), "utf8");
		await core.completeValidatedPhase(cwd, validation("contracts"), "test");

		const state = await core.getWorkspaceState(cwd);
		// The question should appear in exactly one phase, not both
		const allQuestions = Object.values(state.status.phases).flatMap((p) => p.open_questions);
		const loadConfigQuestions = allQuestions.filter((q) => q.id === "q-loadconfig");
		assert.equal(loadConfigQuestions.length, 1);
		// The updated description from phase 2 should win
		assert.match(loadConfigQuestions[0].description, /confirmed/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("open_question_closures remove resolved questions from all phases by id", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-oq-"));
	try {
		await initWorkspace(cwd, "workflow/pipeline-full-with-deep-audit.yaml");
		const dir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(dir, { recursive: true });

		// Phase 1 raises a question
		await writeFile(join(dir, "architecture.yaml"), [
			"phase_id: architecture",
			"open_questions:",
			"  - id: q-loadconfig",
			"    description: loadConfig returns {} on both ENOENT and parse-error",
			"closeout_summary: done",
		].join("\n"), "utf8");
		await core.completeValidatedPhase(cwd, validation("architecture"), "test");

		// Phase 2 resolves it via open_question_closures
		await writeFile(join(dir, "contracts.yaml"), [
			"phase_id: contracts",
			"open_question_closures:",
			"  - q-loadconfig",
			"closeout_summary: done",
		].join("\n"), "utf8");
		await core.completeValidatedPhase(cwd, validation("contracts"), "test");

		const state = await core.getWorkspaceState(cwd);
		const allQuestions = Object.values(state.status.phases).flatMap((p) => p.open_questions);
		assert.equal(allQuestions.filter((q) => q.id === "q-loadconfig").length, 0);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("terminal unresolved open questions are reported at pipeline completion", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-oq-"));
	try {
		await initWorkspace(cwd);
		const dir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(dir, { recursive: true });

		// Complete the only phase with an unresolved question
		await writeFile(join(dir, "architecture.yaml"), [
			"phase_id: architecture",
			"open_questions:",
			"  - id: q- unresolved",
			"    description: something we could not resolve",
			"closeout_summary: done",
		].join("\n"), "utf8");
		await core.completeValidatedPhase(cwd, validation("architecture"), "test");

		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.status.current_phase, "complete");

		const { handleStatus } = await import(pathToFileURL(join(ROOT, "mcp-server/server.ts")).href);
		const result = await handleStatus({ cwd });
		assert.match(result.content[0].text, /Open questions \(terminal unresolved\): 1/);
		assert.equal(result.structuredContent.openQuestionsTerminal, 1);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("dashboard rollup deduplicates open questions by canonical id across phases", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-oq-"));
	try {
		await initWorkspace(cwd, "workflow/pipeline-full-with-deep-audit.yaml");
		const dir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(dir, { recursive: true });

		await writeFile(join(dir, "architecture.yaml"), [
			"phase_id: architecture",
			"open_questions:",
			"  - id: q-shared",
			"    description: shared question from architecture",
			"closeout_summary: done",
		].join("\n"), "utf8");
		await core.completeValidatedPhase(cwd, validation("architecture"), "test");

		await writeFile(join(dir, "contracts.yaml"), [
			"phase_id: contracts",
			"open_questions:",
			"  - id: q-shared",
			"    description: shared question updated by contracts",
			"closeout_summary: done",
		].join("\n"), "utf8");
		await core.completeValidatedPhase(cwd, validation("contracts"), "test");

		const state = await core.getWorkspaceState(cwd);
		const html = core.renderDashboard({
			status: state.status,
			pipeline: state.pipeline,
			usage: { version: 1, runs: [] },
			closeouts: [],
			outputsPresent: new Map(),
			packageVersion: "test",
			generatedAt: new Date().toISOString(),
		});
		// Should show 1 unique, not 2
		assert.match(html, /1 unique/);
		assert.match(html, /shared question updated by contracts/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});