// codecarto_amend (issue #99, formerly template BACKLOG B2): post-pipeline
// application of evidence-based resolutions to status.yaml. The failure this
// pins: a real run resolved four open questions after the pipeline completed
// and had no legitimate way to apply them — status kept reporting 28 open
// questions when 24 remained.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit, handleAmend } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

let WORKSPACE;
let CODECARTO;

async function writeAmendment(slug, body) {
	const dir = join(CODECARTO, "scratch", "amendments");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${slug}.yaml`), body, "utf8");
}

async function completeArchitecture(handoffBody) {
	await writeFile(join(CODECARTO, "findings", "architecture", "architecture-map.md"), [
		"# Map",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		"| 1 | Intent documented. | PASS | §above |",
		"",
		"**Overall:** PASS",
		"",
	].join("\n"), "utf8");
	await mkdir(join(CODECARTO, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(CODECARTO, "scratch", "handoffs", "architecture.yaml"), handoffBody, "utf8");
	const state = await core.getWorkspaceState(WORKSPACE);
	const validation = await core.validatePhaseOutput(state, "architecture");
	await core.completeValidatedPhase(WORKSPACE, validation, "amendment-test");
}

test("setup: single-phase pipeline with open questions and a post_pipeline item", async () => {
	WORKSPACE = await mkdtemp(join(tmpdir(), "cc-amend-"));
	await handleInit({ cwd: WORKSPACE, pipeline: "architecture-only" });
	CODECARTO = join(WORKSPACE, ".codecarto");
});

test("amend refuses while the pipeline is incomplete", async () => {
	await writeAmendment("too-early", [
		"schema_version: 1",
		"open_question_closures:",
		"  - arch-OQ1",
		"closeout_summary: Premature.",
		"",
	].join("\n"));
	await assert.rejects(
		() => handleAmend({ cwd: WORKSPACE, name: "too-early" }),
		/pipeline is not complete \(next phase: architecture\)/,
	);
});

test("amend closes open questions and post-pipeline items after completion", async () => {
	await completeArchitecture([
		"schema_version: 1",
		"phase_id: architecture",
		"open_questions:",
		"  - id: arch-OQ1",
		"    kind: needs-maintainer-decision",
		"    description: Is the loopback-only bind intentional?",
		"  - id: arch-OQ2",
		"    kind: needs-runtime-test",
		"    description: Does the log tolerate two writers?",
		"post_pipeline:",
		"  - id: post-1",
		"    kind: spike",
		"    description: Probe concurrent writers.",
		"closeout_summary: Architecture complete.",
		"",
	].join("\n"));

	await writeAmendment("scope-resolved", [
		"schema_version: 1",
		"open_question_closures:",
		"  - arch-OQ1",
		"post_pipeline_closures:",
		"  - post-1",
		"notes:",
		"  - Resolved on source evidence; the launcher refuses non-loopback binds.",
		"closeout_summary: Deployment scope resolved on evidence.",
		"",
	].join("\n"));

	const result = await handleAmend({ cwd: WORKSPACE, name: "scope-resolved" });
	assert.deepEqual(result.structuredContent.openQuestionsClosed, ["arch-OQ1"]);
	assert.deepEqual(result.structuredContent.postPipelineClosed, ["post-1"]);
	assert.deepEqual(result.structuredContent.unknownIds, []);
	assert.match(result.structuredContent.text, /Open questions closed: arch-OQ1/);

	const state = await core.getWorkspaceState(WORKSPACE);
	const remaining = state.status.phases.architecture.open_questions.map((entry) => entry.id);
	assert.deepEqual(remaining, ["arch-OQ2"], "only the closed question is removed");
	assert.deepEqual(state.status.post_pipeline, [], "post-pipeline item retired");

	const threadLog = await readFile(join(CODECARTO, "THREAD_LOG.md"), "utf8");
	assert.match(threadLog, /amendment:scope-resolved — Deployment scope resolved on evidence\./);
	const closeout = await readFile(join(CODECARTO, "closeouts", threadLog.match(/closeouts\/(\S+-amendment-scope-resolved\.md)/)[1]), "utf8");
	assert.match(closeout, /arch-OQ1/);
	assert.match(closeout, /Resolved on source evidence/);
});

test("re-running the same amendment is idempotent and reports unknown ids", async () => {
	const result = await handleAmend({ cwd: WORKSPACE, name: "scope-resolved" });
	assert.deepEqual(result.structuredContent.openQuestionsClosed, []);
	assert.deepEqual(result.structuredContent.postPipelineClosed, []);
	assert.deepEqual(result.structuredContent.unknownIds, ["arch-OQ1", "post-1"]);

	const threadLog = await readFile(join(CODECARTO, "THREAD_LOG.md"), "utf8");
	const entries = threadLog.match(/amendment:scope-resolved/g);
	assert.equal(entries.length, 1, "THREAD_LOG entry appears once");
});

test("amend validates its input file loudly", async () => {
	await assert.rejects(() => handleAmend({ cwd: WORKSPACE, name: "missing-file" }), /No amendment at \.codecarto\/scratch\/amendments\/missing-file\.yaml/);

	await writeAmendment("empty", ["schema_version: 1", "closeout_summary: Nothing.", ""].join("\n"));
	await assert.rejects(() => handleAmend({ cwd: WORKSPACE, name: "empty" }), /nothing to apply/);

	await writeAmendment("malformed", ["schema_version: 1", "open_question_closures: not-an-array", ""].join("\n"));
	await assert.rejects(() => handleAmend({ cwd: WORKSPACE, name: "malformed" }), /must be an array/);

	await assert.rejects(() => handleAmend({ cwd: WORKSPACE, name: "../escape" }), /Invalid amendment name/);
});

test("teardown: remove temp workspace", async () => {
	await rm(WORKSPACE, { recursive: true, force: true });
});
