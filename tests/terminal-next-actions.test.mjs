// Terminal routing (issue #114): the complete-state next_actions name the
// post-pipeline surfaces (skills, amend with live counts, publish for
// spec-producing pipelines, dashboard, usage) instead of a static sentence,
// and amendment rebuilds them so closure counts never go stale. The failure
// this pins: two full runs ended at a dead-end message with every
// post-pipeline surface unused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit, handleComplete, handleAmend } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

let WORKSPACE;
let CODECARTO;

test("unit: the builder names each surface exactly when it applies", () => {
	const base = {
		phases: {
			architecture: { open_questions: [] },
		},
		post_pipeline: [],
	};
	const quiet = core.buildTerminalNextActions(base);
	assert.match(quiet[0], /codecarto_list_skills/);
	assert.ok(!quiet.some((line) => line.includes("codecarto_amend")), "no amend line without pending work");
	assert.ok(!quiet.some((line) => line.includes("codecarto_publish")), "no publish line without a spec phase");
	assert.match(quiet.at(-1), /codecarto_dashboard/);
	assert.match(quiet.at(-1), /codecarto_usage/);

	const busy = {
		phases: {
			architecture: { open_questions: [{ id: "a" }, { id: "b" }] },
			"reimplementation-spec": { open_questions: [] },
		},
		post_pipeline: [{ id: "pp-1" }],
	};
	const routed = core.buildTerminalNextActions(busy);
	assert.ok(routed.some((line) => line.includes("2 open question(s) and 1 post-pipeline item(s)") && line.includes("codecarto_amend")));
	assert.ok(routed.some((line) => line.includes("codecarto_publish")));
});

test("setup: complete a pipeline with pending work", async () => {
	WORKSPACE = await mkdtemp(join(tmpdir(), "cc-terminal-routing-"));
	await handleInit({ cwd: WORKSPACE, pipeline: "architecture-only" });
	CODECARTO = join(WORKSPACE, ".codecarto");
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
	const handoffPath = join(CODECARTO, "scratch", "handoffs", "architecture.yaml");
	await mkdir(dirname(handoffPath), { recursive: true });
	await writeFile(handoffPath, [
		"schema_version: 1",
		"phase_id: architecture",
		"open_questions:",
		"  - id: arch-OQ1",
		"    kind: needs-runtime-test",
		"    description: Placeholder.",
		"    deferred_reason: Runtime probe.",
		"post_pipeline:",
		"  - id: pp-1",
		"    description: Follow-up item.",
		"closeout_summary: Mapped.",
		"",
	].join("\n"), "utf8");
	await handleComplete({ cwd: WORKSPACE });
});

test("terminal next_actions route to skills, amend with live counts, and the dashboard", async () => {
	const state = await core.getWorkspaceState(WORKSPACE);
	const actions = state.status.next_actions;
	assert.match(actions[0], /codecarto_list_skills/);
	assert.ok(actions.some((line) => line.includes("1 open question(s) and 1 post-pipeline item(s)") && line.includes("codecarto_amend")), `amend routing with live counts, got: ${JSON.stringify(actions)}`);
	assert.ok(!actions.some((line) => line.includes("codecarto_publish")), "architecture-only produces no spec; no publish line");
	assert.ok(actions.some((line) => line.includes("codecarto_dashboard") && line.includes("codecarto_usage")));
});

test("amendment rebuilds the routing so counts never go stale", async () => {
	const amendmentPath = join(CODECARTO, "scratch", "amendments", "close-all.yaml");
	await mkdir(dirname(amendmentPath), { recursive: true });
	await writeFile(amendmentPath, [
		"schema_version: 1",
		"open_question_closures:",
		"  - arch-OQ1",
		"post_pipeline_closures:",
		"  - pp-1",
		"closeout_summary: All pending work closed.",
		"",
	].join("\n"), "utf8");
	await handleAmend({ cwd: WORKSPACE, name: "close-all" });

	const state = await core.getWorkspaceState(WORKSPACE);
	const actions = state.status.next_actions;
	assert.ok(!actions.some((line) => line.includes("codecarto_amend")), `amend line must drop once nothing is pending, got: ${JSON.stringify(actions)}`);
	assert.match(actions[0], /codecarto_list_skills/);
});

test("teardown: remove temp workspace", async () => {
	await rm(WORKSPACE, { recursive: true, force: true });
});
