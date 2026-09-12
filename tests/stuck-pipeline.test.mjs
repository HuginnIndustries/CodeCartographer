// A pipeline that cannot finish is "stuck", not "complete" (self-audit #228,
// D-H6; probe P6).
//
// getNextEligiblePhase returned null both when every phase was complete and
// when the remaining phases waited on a dependency that would never clear,
// and every consumer read null as complete: a two-phase pipeline whose second
// phase depends on a phase that does not exist reported "Phase: complete",
// "Progress: 1/2", and unlocked the post-pipeline skills and amendments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { buildAutoSummary } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/auto-runner.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

const REPORT = "# A\n\n## Validation\n\n| # | c | r | e |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n";
const STUCK = /^Pipeline is stuck: b depends on nope, which is not in this pipeline\. No phase can run until the pipeline file's depends_on is fixed \(or switch pipelines with codecarto_switch_pipeline \/ \/codecarto-switch-pipeline\)\.$/m;

/** Probe P6: init, install a two-phase pipeline whose `b` depends on `nope`, complete `a`. */
async function probeP6(cwd) {
	const codecarto = join(cwd, ".codecarto");
	if (!(await core.pathExists(join(codecarto, "workflow", "status.yaml")))) await server.handleInit({ cwd, pipeline: "architecture-only" });
	await writeFile(join(codecarto, "workflow", "pipeline-stuck.yaml"), "phase_order:\n  - a\n  - b\nphases:\n  - id: a\n    primary_output: findings/a/a.md\n  - id: b\n    depends_on:\n      - nope\n    primary_output: findings/b/b.md\n", "utf8");
	const pipeline = await core.loadYamlFile(join(codecarto, "workflow", "pipeline-stuck.yaml"));
	const status = core.createEmptyStatus("p6", "workflow/pipeline-stuck.yaml", pipeline);
	await writeFile(join(codecarto, "workflow", "status.yaml"), `${core.stringifySimpleYaml(status)}\n`, "utf8");
	await mkdir(join(codecarto, "findings", "a"), { recursive: true });
	await writeFile(join(codecarto, "findings", "a", "a.md"), REPORT, "utf8");
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", "a.yaml"), "phase_id: a\ncloseout_summary: done\n", "utf8");
	await server.handleComplete({ cwd });
	return codecarto;
}

async function withTemp(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-stuck-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sentUserMessages: [], sendUserMessage: (message) => pi.sentUserMessages.push(message) };
	const ui = {
		widgets: [], notifications: [], confirmations: [],
		theme: { fg: (_name, text) => text }, setStatus: (_id, text) => { ui.statusLine = text; },
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => { ui.confirmations.push({ title, body }); return true; },
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, pi, ctx, ui };
}

// ---------- engine ----------

test("resolvePipelineOutcome tells eligible, complete, and stuck apart", async () => {
	await withTemp(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "lite" });
		const fresh = await core.getWorkspaceState(cwd);
		assert.deepEqual(core.resolvePipelineOutcome(fresh).kind, "eligible");
		assert.equal(core.isPipelineComplete(fresh), false);

		await probeP6(cwd);
		const stuck = await core.getWorkspaceState(cwd);
		const outcome = core.resolvePipelineOutcome(stuck);
		assert.deepEqual(outcome, { kind: "stuck", blocked: [{ phaseId: "b", missing: [{ dependencyId: "nope", reason: "not-in-pipeline" }] }] });
		assert.equal(core.getNextEligiblePhase(stuck), null, "the old primitive still says nothing is eligible");
		assert.equal(core.isPipelineComplete(stuck), false, "and that is not complete");
		assert.match(core.describeStuckPipeline(outcome.blocked), STUCK);
	});
});

test("a dependency cycle is stuck too, and each phase names the other as blocked", async () => {
	await withTemp(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		const codecarto = join(cwd, ".codecarto");
		await writeFile(join(codecarto, "workflow", "pipeline-cycle.yaml"), "phase_order:\n  - x\n  - y\nphases:\n  - id: x\n    depends_on:\n      - y\n    primary_output: findings/x/x.md\n  - id: y\n    depends_on:\n      - x\n    primary_output: findings/y/y.md\n", "utf8");
		const pipeline = await core.loadYamlFile(join(codecarto, "workflow", "pipeline-cycle.yaml"));
		await writeFile(join(codecarto, "workflow", "status.yaml"), `${core.stringifySimpleYaml(core.createEmptyStatus("c", "workflow/pipeline-cycle.yaml", pipeline))}\n`, "utf8");
		const outcome = core.resolvePipelineOutcome(await core.getWorkspaceState(cwd));
		assert.equal(outcome.kind, "stuck");
		assert.deepEqual(outcome.blocked.map((b) => [b.phaseId, b.missing[0].dependencyId, b.missing[0].reason]), [["x", "y", "blocked"], ["y", "x", "blocked"]]);
		assert.match(core.describeStuckPipeline(outcome.blocked), /^Pipeline is stuck: x depends on y, which is itself blocked; y depends on x, which is itself blocked\./);
	});
});

test("completion leaves the cursor on the blocked phase with the stuck sentence, not on complete", async () => {
	await withTemp(async (cwd) => {
		await probeP6(cwd);
		const status = await readFile(join(cwd, ".codecarto", "workflow", "status.yaml"), "utf8");
		assert.match(status, /^current_phase: b$/m, "the cursor stays on the phase that cannot run");
		assert.doesNotMatch(status, /^current_phase: complete$/m);
		assert.doesNotMatch(status, /All phases complete/, "the terminal routing is not written for a stuck pipeline");
		const state = await core.getWorkspaceState(cwd);
		assert.match(state.status.next_actions[0], STUCK);
	});
});

// ---------- MCP ----------

test("codecarto_status reports stuck (probe P6), and next / skill / amend refuse", async () => {
	await withTemp(async (cwd) => {
		const codecarto = await probeP6(cwd);
		const status = await server.handleStatus({ cwd });
		assert.match(status.content[0].text, /^Phase: b$/m);
		assert.match(status.content[0].text, /^Pipeline state: stuck$/m);
		assert.match(status.content[0].text, /^Progress: 1\/2 complete$/m);
		assert.match(status.content[0].text, STUCK);
		assert.equal(status.structuredContent.pipelineState, "stuck");
		assert.equal(status.structuredContent.currentPhase, "b");
		assert.deepEqual(status.structuredContent.stuck, [{ phaseId: "b", missing: [{ dependencyId: "nope", reason: "not-in-pipeline" }] }]);

		const refused = (error) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, ErrorCode.InvalidRequest);
			assert.match(error.message, /Pipeline is stuck: b depends on nope, which is not in this pipeline/);
			return true;
		};
		await assert.rejects(server.handleNext({ cwd }), refused);
		await assert.rejects(server.handleSkill({ cwd, name: "spec-delta-application" }), (error) => refused(error) && /^MCP error -32600: Cannot run skill: the pipeline is not complete\./.test(error.message));
		await mkdir(join(codecarto, "scratch", "amendments"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "amendments", "x.yaml"), "schema_version: 1\nopen_question_closures:\n  - q1\n", "utf8");
		await assert.rejects(server.handleAmend({ cwd, name: "x" }), (error) => refused(error) && /Cannot amend: the pipeline is not complete\./.test(error.message));

		const opened = await server.handleOpen({ cwd });
		assert.match(opened.content[0].text, /Current phase: b \(stuck\)\./);
		assert.match(opened.content[0].text, STUCK);
		assert.equal(opened.structuredContent.currentPhase, "b (stuck)");
	});
});

test("a genuinely complete pipeline still reads as complete on MCP", async () => {
	await withTemp(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		const codecarto = join(cwd, ".codecarto");
		await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), REPORT, "utf8");
		await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), "phase_id: architecture\ncloseout_summary: done\n", "utf8");
		await server.handleComplete({ cwd });
		const status = await server.handleStatus({ cwd });
		assert.match(status.content[0].text, /^Phase: complete$/m);
		assert.match(status.content[0].text, /^Pipeline state: complete$/m);
		assert.equal(status.structuredContent.pipelineState, "complete");
		assert.equal((await server.handleNext({ cwd })).structuredContent.complete, true);
		const skill = await server.handleSkill({ cwd, name: (await core.listSkillNames(codecarto))[0] });
		assert.ok(skill.content[0].text.length > 0, "skills unlock on a truly complete pipeline");
	});
});

// ---------- Pi ----------

test("the Pi widget, status line, /codecarto-next, /codecarto-skill, and /codecarto-list-skills all say stuck", async () => {
	await withTemp(async (cwd) => {
		await probeP6(cwd);
		const { commands, pi, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-open").handler("", ctx);
		await commands.get("codecarto-status").handler("", ctx);
		const widget = ui.widgets.at(-1).value.join("\n");
		assert.match(widget, /^Phase: b$/m);
		assert.match(widget, /^Pipeline state: stuck$/m);
		assert.match(widget, STUCK);
		assert.match(ui.statusLine, /CC b$/, "the status line names the blocked phase, not complete");
		assert.equal(ui.notifications.at(-1).level, "error");
		assert.match(ui.notifications.at(-1).message, /^CodeCartographer phase: b\. Pipeline is stuck: b depends on nope/);

		await commands.get("codecarto-next").handler("", ctx);
		assert.equal(ui.notifications.at(-1).level, "error");
		assert.match(ui.notifications.at(-1).message, STUCK);
		assert.equal(pi.sentUserMessages.length, 0, "nothing is queued for a stuck pipeline");

		await commands.get("codecarto-skill").handler("spec-delta-application", ctx);
		assert.match(ui.notifications.at(-1).message, /^Cannot run skill: the pipeline is not complete\. Pipeline is stuck/);
		assert.equal(pi.sentUserMessages.length, 0);

		await commands.get("codecarto-list-skills").handler("", ctx);
		assert.match(ui.widgets.at(-1).value.join("\n"), /unlock when the pipeline completes, and it cannot: Pipeline is stuck/);
	});
});

test("the auto-run summary has a stuck outcome that is not the complete one", () => {
	const summary = buildAutoSummary({
		outcome: "stuck",
		reason: "Pipeline is stuck: b depends on nope, which is not in this pipeline. No phase can run until the pipeline file's depends_on is fixed (or switch pipelines with codecarto_switch_pipeline / /codecarto-switch-pipeline).",
		phasesRun: ["a"],
		totalPhases: 2,
		totalTokens: { input: 0, output: 0, cacheWrite: 0 },
		durationMs: 1000,
	}, ["spec-delta-application"]);
	assert.match(summary, /^\*\*Auto pipeline stuck: no phase can run\.\*\*/);
	assert.match(summary, /Pipeline is stuck: b depends on nope/);
	assert.doesNotMatch(summary, /Auto pipeline complete|try `\/codecarto-skill/);
});
