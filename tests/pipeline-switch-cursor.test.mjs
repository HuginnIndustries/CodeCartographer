// A pipeline switch recomputes the cursor and re-routes dangling carry-forwards
// (self-audit #236 D-M1 and #237 D-M2; spec acceptance scenario M1).
//
// Before this, switchPipeline carried each shared phase's record and then left
// current_phase and next_actions where createEmptyStatus had put them: phase
// one. A carry-forward whose target_phase the new pipeline lacked stayed in
// place with nothing to ever list or close it.

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

const PASSING_REPORT = [
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
].join("\n");

/** One item lite still runs (contracts), one it drops (porting), one open question. */
const HANDOFF = [
	"phase_id: architecture",
	"closeout_summary: done",
	"open_questions:",
	"  - id: arch-OQ1",
	"    kind: needs-maintainer-decision",
	"    description: Which storage engine is canonical?",
	"carry_forward:",
	"  - id: arch-CF-contracts",
	"    target_phase: contracts",
	"    description: Pin the retry contract.",
	"  - id: arch-CF-porting",
	"    target_phase: porting",
	"    kind: needs-runtime-test",
	"    description: Confirm the queue drains under load.",
	"    deferred_reason: Needs a live broker.",
	"",
].join("\n");

async function withTempRepo(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-switch-cursor-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/** Init the deep-audit pipeline and complete architecture with HANDOFF. */
async function initWithArchitectureComplete(cwd) {
	await server.handleInit({ cwd, pipeline: "full-with-deep-audit" });
	const codecarto = join(cwd, ".codecarto");
	await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), PASSING_REPORT, "utf8");
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), HANDOFF, "utf8");
	await server.handleComplete({ cwd });
	const state = await core.getWorkspaceState(cwd);
	assert.equal(state.status.current_phase, "defect-scan-mechanical", "precondition: completion moved the cursor past architecture");
	assert.equal(state.status.phases.architecture.carry_forward.length, 2, "precondition: both carry-forwards were recorded");
	return codecarto;
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = {
		on: () => {},
		registerCommand: (name, command) => commands.set(name, command),
		setActiveTools: () => {},
		setSessionName: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	const ui = {
		widgets: [],
		notifications: [],
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async () => true,
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui,
		signal: new AbortController().signal,
		isIdle: () => true,
		reload: async () => {},
	};
	codeCartographerExtension(pi);
	return { commands, pi, ctx, ui };
}

// ---------- #236: the cursor ----------

test("switching after a completion points the cursor at the next eligible phase, not phase one", async () => {
	await withTempRepo(async (cwd) => {
		await initWithArchitectureComplete(cwd);
		const result = await core.switchPipeline(cwd, "workflow/pipeline-lite.yaml");

		assert.deepEqual(result.carried, ["architecture"]);
		const { status } = result.state;
		assert.equal(status.current_phase, "contracts");
		assert.deepEqual(status.next_actions, ["Begin contracts phase by producing findings/contracts/behavioral-contracts.md"]);
		assert.equal(core.getNextEligiblePhase(result.state).id, "contracts", "stored cursor and engine agree");

		// What is on disk is what every later reader sees.
		const onDisk = await readFile(join(cwd, ".codecarto", "workflow", "status.yaml"), "utf8");
		assert.match(onDisk, /^current_phase: contracts$/m);
		assert.match(onDisk, /Begin contracts phase by producing/);
		assert.doesNotMatch(onDisk, /Begin architecture phase/);
	});
});

test("switching to a pipeline every carried phase already completes lands on the terminal cursor", async () => {
	await withTempRepo(async (cwd) => {
		await initWithArchitectureComplete(cwd);
		const result = await core.switchPipeline(cwd, "workflow/pipeline-architecture-only.yaml");

		const { status } = result.state;
		assert.equal(status.current_phase, "complete");
		assert.equal(core.getNextEligiblePhase(result.state), null);
		assert.match(status.next_actions[0], /^All phases complete\./);
		// The terminal routing counts the question that stayed and the item that moved.
		assert.match(status.next_actions[1], /1 open question\(s\) and 2 post-pipeline item\(s\) remain/);
	});
});

test("switching with nothing completed keeps the cursor at phase one and moves nothing", async () => {
	await withTempRepo(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "lite" });
		const result = await core.switchPipeline(cwd, "workflow/pipeline-full-with-deep-audit.yaml");
		assert.equal(result.state.status.current_phase, "architecture");
		assert.deepEqual(result.state.status.next_actions, ["Begin architecture phase by producing findings/architecture/architecture-map.md"]);
		assert.deepEqual(result.dangling, []);
		assert.deepEqual(result.state.status.post_pipeline, []);
	});
});

test("completion and switch spell the same next-action line for the same phase", async () => {
	await withTempRepo(async (cwd) => {
		await initWithArchitectureComplete(cwd);
		const afterCompletion = (await core.getWorkspaceState(cwd)).status.next_actions;
		// Switching to the same pipeline file under a different alias is refused by
		// the handlers, so go round-trip: to lite and back.
		await core.switchPipeline(cwd, "workflow/pipeline-lite.yaml");
		const back = await core.switchPipeline(cwd, "workflow/pipeline-full-with-deep-audit.yaml");
		assert.equal(back.state.status.current_phase, "defect-scan-mechanical");
		assert.deepEqual(back.state.status.next_actions, afterCompletion);
	});
});

// ---------- #237: dangling carry-forwards ----------

test("a carry-forward whose target the new pipeline lacks moves to post_pipeline and is reported", async () => {
	await withTempRepo(async (cwd) => {
		await initWithArchitectureComplete(cwd);
		const result = await core.switchPipeline(cwd, "workflow/pipeline-lite.yaml");

		assert.deepEqual(result.dangling, [
			{ id: "arch-CF-porting", source_phase: "architecture", target_phase: "porting", description: "Confirm the queue drains under load." },
		]);

		const { status } = result.state;
		assert.deepEqual(
			status.phases.architecture.carry_forward.map((entry) => entry.id),
			["arch-CF-contracts"],
			"the item lite can still route to stays where it was",
		);
		assert.deepEqual(status.post_pipeline, [
			{
				id: "arch-CF-porting",
				kind: "needs-runtime-test",
				description: "Confirm the queue drains under load.",
				deferred_reason: "Needs a live broker. Routed to porting, which the lite pipeline does not run.",
				source_phase: "architecture",
				status: "pending",
			},
		]);
		assert.deepEqual(
			status.phases.architecture.open_questions.map((entry) => entry.id),
			["arch-OQ1"],
			"open questions are not carry-forwards and are untouched",
		);
	});
});

test("a moved item survives the round trip on disk and can be closed by an amendment", async () => {
	await withTempRepo(async (cwd) => {
		await initWithArchitectureComplete(cwd);
		await core.switchPipeline(cwd, "workflow/pipeline-architecture-only.yaml");

		const reloaded = await core.getWorkspaceState(cwd);
		assert.equal(reloaded.status.post_pipeline.length, 2, "both carry-forwards dangle under architecture-only");
		assert.deepEqual(reloaded.status.post_pipeline.map((entry) => entry.id).sort(), ["arch-CF-contracts", "arch-CF-porting"]);
		assert.deepEqual(reloaded.status.phases.architecture.carry_forward, []);

		// post_pipeline is the one list an amendment can close, which is the
		// point of moving the entry there rather than leaving it stranded.
		const amendments = join(cwd, ".codecarto", "scratch", "amendments");
		await mkdir(amendments, { recursive: true });
		await writeFile(join(amendments, "close-porting.yaml"), [
			"schema_version: 1",
			"post_pipeline_closures:",
			"  - arch-CF-porting",
			"closeout_summary: Broker test ran elsewhere.",
			"",
		].join("\n"), "utf8");
		const amended = await server.handleAmend({ cwd, name: "close-porting" });
		assert.match(amended.content[0].text, /arch-CF-porting/);
		const after = await core.getWorkspaceState(cwd);
		assert.deepEqual(after.status.post_pipeline.map((entry) => entry.id), ["arch-CF-contracts"]);
	});
});

test("a dangling carry-forward without an id is given one before it moves", async () => {
	await withTempRepo(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "full-with-deep-audit" });
		// Only a hand-edited status can hold an id-less carry-forward; handoffs
		// always assign cf-<phase>-N.
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		const state = await core.getWorkspaceState(cwd);
		const status = core.normalizeStatus(state.status, state.pipeline, state.status.pipeline, cwd);
		status.phases.architecture.status = "complete";
		status.phases.architecture.carry_forward = [{ target_phase: "porting", description: "Hand-written item." }];
		await writeFile(statusPath, `${core.stringifySimpleYaml(status)}\n`, "utf8");

		const result = await core.switchPipeline(cwd, "workflow/pipeline-lite.yaml");
		assert.equal(result.dangling.length, 1);
		assert.equal(result.dangling[0].id, "cf-architecture-1");
		assert.equal(result.state.status.post_pipeline[0].id, "cf-architecture-1");
		assert.equal(result.state.status.post_pipeline[0].description, "Hand-written item.");
	});
});

// ---------- the two surfaces ----------

test("codecarto_switch_pipeline reports the cursor and the moved items", async () => {
	await withTempRepo(async (cwd) => {
		await initWithArchitectureComplete(cwd);
		const result = await server.handleSwitchPipeline({ cwd, pipeline: "lite" });
		const text = result.content[0].text;
		assert.match(text, /^Switched pipeline: lite$/m);
		assert.match(text, /^Phases preserved \(completed\): architecture$/m);
		assert.match(text, /^1 carry-forward item targeted a dropped phase and moved to post_pipeline \(close with an amendment's post_pipeline_closures\):$/m);
		assert.match(text, /^  - arch-CF-porting \(architecture → porting\): Confirm the queue drains under load\.$/m);
		assert.match(text, /^Current phase: contracts$/m);
		assert.equal(result.structuredContent.currentPhase, "contracts");
		assert.deepEqual(result.structuredContent.dangling, [
			{ id: "arch-CF-porting", source_phase: "architecture", target_phase: "porting", description: "Confirm the queue drains under load." },
		]);

		// status and next now agree with the switch result.
		const status = await server.handleStatus({ cwd });
		assert.match(status.content[0].text, /^Phase: contracts$/m);
		assert.match(status.content[0].text, /^Next: Begin contracts phase by producing/m);
		assert.match(status.content[0].text, /^Carry-forward \(pipeline phases\): 1$/m);
		assert.match(status.content[0].text, /^Post-pipeline work: 1 pending$/m);
		const next = await server.handleNext({ cwd });
		assert.equal(next.structuredContent.phase, "contracts");
	});
});

test("codecarto_switch_pipeline says nothing about dangling items when there are none", async () => {
	await withTempRepo(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "lite" });
		const result = await server.handleSwitchPipeline({ cwd, pipeline: "full" });
		assert.doesNotMatch(result.content[0].text, /carry-forward item/);
		assert.match(result.content[0].text, /^Current phase: architecture$/m);
		assert.deepEqual(result.structuredContent.dangling, []);
	});
});

test("/codecarto-switch-pipeline shows the same moved items as the MCP tool", async () => {
	await withTempRepo(async (cwd) => {
		await initWithArchitectureComplete(cwd);
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-open").handler("", ctx);
		await commands.get("codecarto-switch-pipeline").handler("lite", ctx);

		assert.equal(ui.notifications.at(-1).level, "info");
		assert.equal(ui.notifications.at(-1).message, "Switched to pipeline: lite");
		const widget = ui.widgets.at(-1).value.join("\n");
		assert.match(widget, /1 carry-forward item targeted a dropped phase and moved to post_pipeline \(close with an amendment's post_pipeline_closures\):/);
		assert.match(widget, /- arch-CF-porting \(architecture → porting\): Confirm the queue drains under load\./);

		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.status.current_phase, "contracts");
		assert.deepEqual(state.status.post_pipeline.map((entry) => entry.id), ["arch-CF-porting"]);
	});
});
