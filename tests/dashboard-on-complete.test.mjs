// Dashboard freshness as a lifecycle side effect (issue #112): completion and
// amendment regenerate dashboard.html best-effort, so the artifact whose whole
// job is showing current counts cannot silently go stale — and a render
// failure never fails the operation that triggered it. The failure this pins:
// two full seven-phase runs reached "complete" with no dashboard at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { handleInit, handleComplete, handleAmend } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

let WORKSPACE;
let CODECARTO;

async function writePassingArchitectureOutput() {
	await writeFile(join(CODECARTO, "findings", "architecture", "architecture-map.md"), [
		"# Architecture Map",
		"",
		"Body.",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		"| 1 | The system intent is documented. | PASS | §above |",
		"",
		"**Validated by:** test",
		"**Overall:** PASS",
		"",
	].join("\n"), "utf8");
}

test("setup: init and prepare a completable phase", async () => {
	WORKSPACE = await mkdtemp(join(tmpdir(), "cc-dashboard-lifecycle-"));
	await handleInit({ cwd: WORKSPACE, pipeline: "architecture-only" });
	CODECARTO = join(WORKSPACE, ".codecarto");
	await writePassingArchitectureOutput();
	const handoffPath = join(CODECARTO, "scratch", "handoffs", "architecture.yaml");
	await mkdir(dirname(handoffPath), { recursive: true });
	await writeFile(handoffPath, [
		"schema_version: 1",
		"phase_id: architecture",
		"open_questions:",
		"  - id: arch-OQ1",
		"    kind: needs-runtime-test",
		"    description: Placeholder question for the amendment below.",
		"    deferred_reason: Needs a runtime probe.",
		"closeout_summary: Architecture mapped.",
		"",
	].join("\n"), "utf8");
});

test("a dashboard render failure never fails the completion", async () => {
	// Occupy the dashboard path with a directory so the atomic rename must fail.
	await mkdir(join(CODECARTO, "dashboard.html"));
	try {
		const result = await handleComplete({ cwd: WORKSPACE });
		assert.equal(result.structuredContent.completedPhase, "architecture", "completion must succeed despite the blocked dashboard");
		assert.equal(result.structuredContent.dashboardPath, undefined, "no dashboard path is reported when rendering failed");
		assert.doesNotMatch(result.structuredContent.text, /Dashboard refreshed/);
	} finally {
		await rmdir(join(CODECARTO, "dashboard.html"));
	}
});

test("amendment regenerates the dashboard alongside the status change", async () => {
	const amendmentPath = join(CODECARTO, "scratch", "amendments", "close-oq1.yaml");
	await mkdir(dirname(amendmentPath), { recursive: true });
	await writeFile(amendmentPath, [
		"schema_version: 1",
		"open_question_closures:",
		"  - arch-OQ1",
		"closeout_summary: Closed by runtime probe.",
		"",
	].join("\n"), "utf8");

	const result = await handleAmend({ cwd: WORKSPACE, name: "close-oq1" });
	assert.deepEqual(result.structuredContent.openQuestionsClosed, ["arch-OQ1"]);
	assert.equal(result.structuredContent.dashboardPath, ".codecarto/dashboard.html");
	assert.match(result.structuredContent.text, /Dashboard refreshed: \.codecarto\/dashboard\.html/);
	const rendered = await readFile(join(CODECARTO, "dashboard.html"), "utf8");
	assert.match(rendered, /<html|<!doctype/i, "a real HTML dashboard is on disk");
	const info = await stat(join(CODECARTO, "dashboard.html"));
	assert.ok(info.isFile());
});

test("completion regenerates the dashboard when the path is writable", async () => {
	// Fresh workspace where nothing blocks the path: complete → dashboard exists.
	const workspace = await mkdtemp(join(tmpdir(), "cc-dashboard-clean-"));
	await handleInit({ cwd: workspace, pipeline: "architecture-only" });
	const codecarto = join(workspace, ".codecarto");
	await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), [
		"# Architecture Map",
		"",
		"Body.",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		"| 1 | The system intent is documented. | PASS | §above |",
		"",
		"**Validated by:** test",
		"**Overall:** PASS",
		"",
	].join("\n"), "utf8");
	const handoffPath = join(codecarto, "scratch", "handoffs", "architecture.yaml");
	await mkdir(dirname(handoffPath), { recursive: true });
	await writeFile(handoffPath, "schema_version: 1\nphase_id: architecture\ncloseout_summary: Mapped.\n", "utf8");
	const result = await handleComplete({ cwd: workspace });
	assert.equal(result.structuredContent.dashboardPath, ".codecarto/dashboard.html");
	assert.match(result.structuredContent.text, /Dashboard refreshed/);
	const info = await stat(join(codecarto, "dashboard.html"));
	assert.ok(info.isFile(), "completion must leave a rendered dashboard on disk");
	await rm(workspace, { recursive: true, force: true });
});

test("teardown: remove temp workspace", async () => {
	await rm(WORKSPACE, { recursive: true, force: true });
});
