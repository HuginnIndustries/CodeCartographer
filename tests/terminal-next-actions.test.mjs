// Terminal routing (issue #114): the complete-state next_actions name the
// post-pipeline surfaces (skills, amend with live counts, publish for
// spec-producing pipelines, dashboard, usage) instead of a static sentence,
// and amendment rebuilds them so closure counts never go stale. The failure
// this pins: two full runs ended at a dead-end message with every
// post-pipeline surface unused.
//
// Every tool a routing line names is spelled for both executable surfaces —
// the MCP tool name and the Pi slash command — because the same strings render
// in codecarto_status on MCP and as the Pi widget's "Next:" line, and a Pi user
// handed only the MCP name has nothing to run (the sibling of #177's scaffold
// notice fix).

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

const piName = (tool) => `/codecarto-${tool.replaceAll("_", "-")}`;
const mcpName = (tool) => `codecarto_${tool}`;
/** The line names the tool for both surfaces. */
const namesBoth = (line, tool) => line.includes(mcpName(tool)) && line.includes(piName(tool));
/** The line names the tool on either surface (for asserting absence). */
const namesEither = (line, tool) => line.includes(mcpName(tool)) || line.includes(piName(tool));

/** No routing line may name an MCP tool without its Pi slash command beside it. */
function assertEveryToolSpelledForBothSurfaces(lines) {
	for (const line of lines) {
		for (const [, tool] of line.matchAll(/\bcodecarto_([a-z_]+)/g)) {
			assert.ok(line.includes(piName(tool)), `${mcpName(tool)} is named for MCP only in: ${line}`);
		}
	}
}

test("unit: the builder names each surface exactly when it applies", () => {
	const base = {
		phases: {
			architecture: { open_questions: [] },
		},
		post_pipeline: [],
	};
	const quiet = core.buildTerminalNextActions(base);
	assert.ok(namesBoth(quiet[0], "list_skills") && namesBoth(quiet[0], "skill"), `skills routing on both surfaces, got: ${quiet[0]}`);
	assert.ok(!quiet.some((line) => namesEither(line, "amend")), "no amend line without pending work");
	assert.ok(!quiet.some((line) => namesEither(line, "publish")), "no publish line without a spec phase");
	assert.ok(namesBoth(quiet.at(-1), "dashboard"), `dashboard on both surfaces, got: ${quiet.at(-1)}`);
	assert.ok(namesBoth(quiet.at(-1), "usage"), `usage on both surfaces, got: ${quiet.at(-1)}`);
	assertEveryToolSpelledForBothSurfaces(quiet);

	const busy = {
		phases: {
			architecture: { open_questions: [{ id: "a" }, { id: "b" }] },
			"reimplementation-spec": { open_questions: [] },
		},
		post_pipeline: [{ id: "pp-1" }],
	};
	const routed = core.buildTerminalNextActions(busy);
	assert.ok(routed.some((line) => line.includes("2 open question(s) and 1 post-pipeline item(s)") && namesBoth(line, "amend")));
	assert.ok(routed.some((line) => namesBoth(line, "publish") && namesBoth(line, "library_init")));
	assertEveryToolSpelledForBothSurfaces(routed);
});

test("unit: the Pi widget's Next: line (next_actions[0]) leads with the terminal state and stays one sentence-pair", () => {
	const [first] = core.buildTerminalNextActions({ phases: {}, post_pipeline: [] });
	assert.ok(first.startsWith("All phases complete."), first);
	assert.match(first, /codecarto_list_skills then codecarto_skill on MCP, \/codecarto-list-skills then \/codecarto-skill on Pi\.$/);
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

test("terminal next_actions route to skills, amend with live counts, and the dashboard, naming both surfaces", async () => {
	const state = await core.getWorkspaceState(WORKSPACE);
	const actions = state.status.next_actions;
	assert.ok(namesBoth(actions[0], "list_skills"), `skills routing on both surfaces, got: ${actions[0]}`);
	assert.ok(actions.some((line) => line.includes("1 open question(s) and 1 post-pipeline item(s)") && namesBoth(line, "amend")), `amend routing with live counts, got: ${JSON.stringify(actions)}`);
	assert.ok(!actions.some((line) => namesEither(line, "publish")), "architecture-only produces no spec; no publish line");
	assert.ok(actions.some((line) => namesBoth(line, "dashboard") && namesBoth(line, "usage")));
	assertEveryToolSpelledForBothSurfaces(actions);
});

test("codecarto_status text renders every routing line, not just the first (#114), with both surfaces named", async () => {
	const { handleStatus } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
	const result = await handleStatus({ cwd: WORKSPACE });
	const text = result.structuredContent.text;
	assert.match(text, /codecarto_list_skills/);
	assert.match(text, /\/codecarto-list-skills/);
	assert.match(text, /codecarto_amend/, "the amend routing line must reach the text view");
	assert.match(text, /\/codecarto-amend/, "the amend routing line must name the Pi command too");
	assert.match(text, /codecarto_dashboard/);
	assert.match(text, /\/codecarto-dashboard/);
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
	assert.ok(!actions.some((line) => namesEither(line, "amend")), `amend line must drop once nothing is pending, got: ${JSON.stringify(actions)}`);
	assert.ok(namesBoth(actions[0], "list_skills"), `skills routing on both surfaces, got: ${actions[0]}`);
	assertEveryToolSpelledForBothSurfaces(actions);
});

test("teardown: remove temp workspace", async () => {
	await rm(WORKSPACE, { recursive: true, force: true });
});
