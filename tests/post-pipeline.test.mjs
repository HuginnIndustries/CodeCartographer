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

function validation() {
	return { phaseId: "architecture", primaryOutput: "findings/architecture/architecture-map.md", outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
}

test("legacy status without post_pipeline normalizes to an empty backlog", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-post-"));
	try {
		await initWorkspace(cwd);
		const state = await core.getWorkspaceState(cwd);
		assert.deepEqual(state.status.post_pipeline, []);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("new handoffs reject carry_forward targets outside the active pipeline", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-post-"));
	try {
		await initWorkspace(cwd);
		const dir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "architecture.yaml"), "phase_id: architecture\ncarry_forward:\n  -\n    id: cf1\n    target_phase: spike\n    description: run a spike\n", "utf8");
		await assert.rejects(() => core.completeValidatedPhase(cwd, validation(), "test"), /target_phase spike is not a downstream active pipeline phase/);
		await writeFile(join(dir, "architecture.yaml"), "phase_id: architecture\ncarry_forward:\n  -\n    id: cf1\n    target_phase: architecture\n    description: defer to self\n", "utf8");
		await assert.rejects(() => core.completeValidatedPhase(cwd, validation(), "test"), /target_phase architecture is not a downstream active pipeline phase/);
		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.status.phases.architecture.status, "pending");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("post_pipeline handoff items remain distinct from carry_forward after pipeline completion", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-post-"));
	try {
		await initWorkspace(cwd);
		const dir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "architecture.yaml"), "phase_id: architecture\npost_pipeline:\n  -\n    id: post1\n    kind: spike\n    description: verify restart behavior\n", "utf8");
		await core.completeValidatedPhase(cwd, validation(), "test");
		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.status.current_phase, "complete");
		assert.equal(state.status.post_pipeline.length, 1);
		assert.equal(state.status.post_pipeline[0].source_phase, "architecture");
		assert.equal(state.status.post_pipeline[0].status, "pending");
		assert.equal(state.status.phases.architecture.carry_forward.length, 0);

		const { handleStatus } = await import(pathToFileURL(join(ROOT, "mcp-server/server.ts")).href);
		const result = await handleStatus({ cwd });
		assert.match(result.content[0].text, /Pipeline state: complete/);
		assert.match(result.content[0].text, /Post-pipeline work: 1 pending/);
		assert.equal(result.structuredContent.postPipelinePending, 1);
		const html = core.renderDashboard({
			status: state.status,
			pipeline: state.pipeline,
			usage: { version: 1, runs: [] },
			closeouts: [],
			outputsPresent: new Map(),
			packageVersion: "test",
			generatedAt: new Date().toISOString(),
		});
		assert.match(html, /Post-pipeline work/);
		assert.match(html, /verify restart behavior/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("post_pipeline items merge idempotently by canonical id", async () => {
	const status = {
		project_name: "x", pipeline: "p", current_phase: "complete", last_updated: "", schema_version: 1,
		phases: { architecture: { status: "complete", owner_notes: [], outputs_present: [], open_questions: [], carry_forward: [] } },
		next_actions: [], post_pipeline: [],
	};
	const handoff = core.parseHandoff({ phase_id: "architecture", post_pipeline: [{ id: "post1", kind: "spike", description: "first" }] });
	core.applyHandoff(status, handoff);
	core.applyHandoff(status, handoff);
	assert.equal(status.post_pipeline.length, 1);
});

test("legacy post_pipeline entries without IDs are preserved without ambiguous deduplication", async () => {
	const status = {
		project_name: "x", pipeline: "p", current_phase: "complete", last_updated: "", schema_version: 1,
		phases: { architecture: { status: "complete", owner_notes: [], outputs_present: [], open_questions: [], carry_forward: [] } },
		next_actions: [],
		post_pipeline: [
			{ source_phase: "architecture", description: "same description", status: "pending" },
			{ source_phase: "architecture", description: "same description", status: "pending" },
		],
	};
	core.applyHandoff(status, core.parseHandoff({ phase_id: "architecture" }));
	assert.equal(status.post_pipeline.length, 2);
});

test("dashboard omits the post-pipeline navigation link when the backlog is empty", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-post-"));
	try {
		await initWorkspace(cwd);
		const state = await core.getWorkspaceState(cwd);
		const html = core.renderDashboard({ status: state.status, pipeline: state.pipeline, usage: { version: 1, runs: [] }, closeouts: [], outputsPresent: new Map(), packageVersion: "test", generatedAt: new Date().toISOString() });
		assert.doesNotMatch(html, /href="#post-pipeline"/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});
