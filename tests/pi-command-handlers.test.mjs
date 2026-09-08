// Drives the Pi command handlers directly, through a fake extension host.
//
// Written because a survey found that ten of the twenty registered
// `/codecarto-*` commands were never invoked by any test — including
// `/codecarto-next`, the primary command on the surface CLAUDE.md calls
// recommended. That gap is the whole explanation for how a crash that killed
// the Pi process on `/codecarto-next` survived multiple releases with every CI
// gate green: the core logic behind it is tested exhaustively, and the handler
// wiring it to the surface was not tested at all.
//
// None of this needs a model, a network, or an API key. The sub-agent spawn is
// the only part that does, and it is fire-and-forget, so the handler's own
// contract — refuse cleanly, report through the UI, never throw — is fully
// observable here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keep git out of the user's real config, as the sibling fixtures do.
const ABSENT_GIT_CONFIG = join(tmpdir(), "codecarto-tests-absent-gitconfig");
process.env.GIT_CONFIG_GLOBAL = ABSENT_GIT_CONFIG;
process.env.GIT_CONFIG_SYSTEM = ABSENT_GIT_CONFIG;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { getWorkspaceState } = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);

function createHarness(cwd) {
	const events = new Map();
	const commands = new Map();
	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		setActiveTools: (tools) => { pi.activeTools = tools; },
		setSessionName: (name) => { pi.sessionName = name; },
		sendMessage: () => {},
		sentUserMessages: [],
		sendUserMessage: (message) => { pi.sentUserMessages.push(message); },
		activeTools: undefined,
		sessionName: undefined,
	};
	const ui = {
		statuses: [],
		widgets: [],
		notifications: [],
		theme: { fg: (_name, text) => text },
		setStatus: (id, value) => ui.statuses.push({ id, value }),
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
		reload: async () => { ctx.reloads += 1; },
		reloads: 0,
	};
	codeCartographerExtension(pi);
	return { events, commands, pi, ctx, ui };
}

async function withRepo(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-pi-handlers-"));
	try {
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "package.json"), '{"name":"handler-target","version":"0.1.0"}\n', "utf8");
		await writeFile(join(cwd, "src", "index.ts"), "export const x = 1;\n", "utf8");
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/** Boot the extension and initialize a workspace, as a real session would. */
async function initialized(cwd, pipeline = "lite") {
	const h = createHarness(cwd);
	await h.commands.get("codecarto-init").handler(pipeline, h.ctx);
	h.ui.notifications.length = 0;
	return h;
}

const messages = (ui) => ui.notifications.map((n) => n.message).join("\n");

/** A primary output whose `## Validation` table passes. */
async function writePassingArtifact(cwd, relativePath) {
	const path = join(cwd, ".codecarto", relativePath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		"# Architecture Map\n\n## Validation\n\n| Criterion | Result | Evidence |\n|---|---|---|\n| Intent documented | PASS | src/index.ts:1 |\n\n**Overall:** PASS\n",
		"utf8",
	);
	return path;
}

/** The phase handoff completion requires before it will advance a phase. */
async function writeHandoff(cwd, phaseId) {
	const dir = join(cwd, ".codecarto", "scratch", "handoffs");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${phaseId}.yaml`),
		[
			"schema_version: 1",
			`phase_id: ${phaseId}`,
			"owner_notes:",
			"  - Mapped the single exported constant.",
			"open_questions: []",
			"carry_forward: []",
			"carry_forward_closures: []",
			"open_question_closures: []",
			"post_pipeline: []",
			"decisions: []",
			"proposed_conventions: []",
			`closeout_summary: ${phaseId} complete`,
			"",
		].join("\n"),
		"utf8",
	);
}

// ---------------------------------------------------------------
// /codecarto-next — zero test invocations before this file
// ---------------------------------------------------------------

test("next rejects --strict without --auto instead of running anything", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-next").handler("--strict", ctx);
		assert.match(messages(ui), /--strict requires --auto/);
		assert.equal(ui.notifications.at(-1).level, "error");
	});
});

test("next names an unknown flag rather than ignoring it", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-next").handler("--turbo", ctx);
		assert.match(messages(ui), /Unknown \/codecarto-next flag: --turbo/);
		assert.equal(ui.notifications.at(-1).level, "error");
	});
});

test("next refuses before init rather than acting on an unopened workspace", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-next").handler("", ctx);
		assert.match(messages(ui), /not active in this session|Run \/codecarto-init/);
	});
});

test("next reports completion once every phase is done", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		// Mark the whole lite pipeline complete without going through the agent.
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		const status = await readFile(statusPath, "utf8");
		await writeFile(statusPath, status.replace(/status: pending/g, "status: complete"), "utf8");

		await commands.get("codecarto-next").handler("", ctx);
		assert.match(messages(ui), /All CodeCartographer phases are complete/);
	});
});

test("next does not throw when the sub-agent cannot be spawned", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx } = await initialized(cwd);
		// The harness ctx has no sessionManager, so runSinglePhase fails. The
		// handler fires it without awaiting, so its own contract is simply not
		// to throw — the failure belongs in a notification. Before the stale-ctx
		// fix this path took the whole process down.
		await assert.doesNotReject(async () => commands.get("codecarto-next").handler("", ctx));
	});
});

// ---------------------------------------------------------------
// /codecarto-validate and /codecarto-complete — the path that advances a pipeline
// ---------------------------------------------------------------

test("validate reports MISSING on a fresh workspace without throwing", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-validate").handler("", ctx);
		assert.match(messages(ui), /Validation architecture: MISSING/);
	});
});

test("validate surfaces an unknown phase as an error, not a crash", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await assert.doesNotReject(async () => commands.get("codecarto-validate").handler("no-such-phase", ctx));
		assert.ok(ui.notifications.length > 0, "an unknown phase must say something");
	});
});

test("complete refuses a phase whose output is missing", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-complete").handler("", ctx);
		assert.match(messages(ui), /Cannot complete architecture: MISSING/);
		const state = await getWorkspaceState(cwd);
		assert.equal(state.status.phases.architecture.status, "pending", "a refused completion must not advance status");
	});
});

test("validate then complete advances the phase and the pipeline", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await writePassingArtifact(cwd, "findings/architecture/architecture-map.md");
		await writeHandoff(cwd, "architecture");

		await commands.get("codecarto-validate").handler("", ctx);
		assert.match(messages(ui), /Validation architecture: PASS/);

		ui.notifications.length = 0;
		await commands.get("codecarto-complete").handler("", ctx);

		const state = await getWorkspaceState(cwd);
		assert.equal(state.status.phases.architecture.status, "complete", "a PASS must advance the phase");
		assert.ok(
			state.status.phases.architecture.outputs_present.includes("findings/architecture/architecture-map.md"),
			"completion must record the output it accepted",
		);
		assert.notEqual(state.status.current_phase, "architecture", "the pipeline must move on");
	});
});

// ---------------------------------------------------------------
// /codecarto-switch-pipeline
// ---------------------------------------------------------------

test("switch-pipeline explains itself when given no argument", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-switch-pipeline").handler("", ctx);
		assert.match(messages(ui), /Usage: \/codecarto-switch-pipeline/);
	});
});

test("switch-pipeline rejects an unknown variant", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-switch-pipeline").handler("turbo", ctx);
		assert.match(messages(ui), /Unknown pipeline: turbo/);
		const state = await getWorkspaceState(cwd);
		assert.match(state.status.pipeline, /pipeline-lite\.yaml$/, "a rejected switch must not change the pipeline");
	});
});

test("switch-pipeline is a no-op when already on the requested variant", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-switch-pipeline").handler("lite", ctx);
		assert.match(messages(ui), /Already on pipeline/);
	});
});

test("switch-pipeline changes the active pipeline on disk", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx } = await initialized(cwd);
		await commands.get("codecarto-switch-pipeline").handler("full", ctx);
		const state = await getWorkspaceState(cwd);
		assert.doesNotMatch(state.status.pipeline, /pipeline-lite\.yaml$/);
		assert.ok(state.pipeline.phase_order.length > 3, "the full pipeline has more phases than lite");
	});
});

// ---------------------------------------------------------------
// /codecarto-usage, /codecarto-dashboard, /codecarto-config
// ---------------------------------------------------------------

test("usage says so when nothing has run yet", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-usage").handler("", ctx);
		assert.match(messages(ui), /No phase runs recorded yet/);
	});
});

test("dashboard writes the single-file report", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx } = await initialized(cwd);
		const path = join(cwd, ".codecarto", "dashboard.html");
		await rm(path, { force: true });
		await commands.get("codecarto-dashboard").handler("", ctx);
		const html = await readFile(path, "utf8");
		assert.match(html, /<html|<!doctype/i);
		assert.ok(html.length > 1000, "the dashboard should not be a stub");
	});
});

test("config reports without throwing", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await assert.doesNotReject(async () => commands.get("codecarto-config").handler("", ctx));
		assert.ok(ui.notifications.length > 0 || ui.widgets.length > 0, "config must report something");
	});
});

test("complete reports a refusal instead of throwing it", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		// A passing artifact with no phase handoff. Completion refuses, and the
		// refusal text is the actionable part — it names the file to write and
		// the fields it needs. That call was the one in the extension that let
		// such a message escape as a rejection, so the guidance never rendered.
		await writePassingArtifact(cwd, "findings/architecture/architecture-map.md");

		await assert.doesNotReject(async () => commands.get("codecarto-complete").handler("", ctx));
		assert.match(messages(ui), /no phase handoff exists/);
		assert.match(messages(ui), /templates\/phase-handoff\.yaml/);
		assert.equal(ui.notifications.at(-1).level, "error");

		const state = await getWorkspaceState(cwd);
		assert.equal(state.status.phases.architecture.status, "pending", "a refused completion must not advance status");
	});
});

// ---------------------------------------------------------------
// /codecarto-phase, /codecarto-library-init, /codecarto-vision
// ---------------------------------------------------------------

test("phase explains itself when given no argument", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-phase").handler("", ctx);
		assert.match(messages(ui), /Usage: \/codecarto-phase <phase>/);
	});
});

test("phase rejects a phase the active pipeline does not declare", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-phase").handler("no-such-phase", ctx);
		assert.match(messages(ui), /Unknown phase: no-such-phase/);
		assert.equal(ui.notifications.at(-1).level, "error");
	});
});

test("phase forces a real phase without throwing", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx } = await initialized(cwd);
		// `protocols` is last in the lite order, so this exercises the explicit
		// out-of-DAG-order request the command exists for.
		await assert.doesNotReject(async () => commands.get("codecarto-phase").handler("protocols", ctx));
	});
});

test("library-init explains itself when given no path", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx, ui } = await initialized(cwd);
		await commands.get("codecarto-library-init").handler("", ctx);
		assert.match(messages(ui), /Usage: \/codecarto-library-init <path>/);
	});
});

test("library-init creates a library at an absolute path", async () => {
	await withRepo(async (cwd) => {
		const { commands, ctx } = await initialized(cwd);
		const libraryPath = join(cwd, "library");
		await assert.doesNotReject(async () => commands.get("codecarto-library-init").handler(libraryPath, ctx));
		// The `.codecarto-library` marker is what publish, list and reindex key
		// off; it is the whole on-disk footprint of an empty library.
		const marker = JSON.parse(await readFile(join(libraryPath, ".codecarto-library"), "utf8"));
		assert.equal(marker.schema_version, 1);
		assert.equal(marker.name, "library");
		assert.equal(marker.namespaced, false);
	});
});

test("vision queues the interview, and is not gated on the synthesis pipeline", async () => {
	await withRepo(async (cwd) => {
		// Init copies every skill directory into the workspace regardless of the
		// active pipeline, so the vision interview is present on an analysis
		// workspace too. That is deliberate rather than a leak — a brief can be
		// captured before switching to synthesis — and this pins it, because the
		// handler's own guard reads as though the skill might be absent.
		const { commands, ctx, ui, pi } = await initialized(cwd, "lite");
		await commands.get("codecarto-vision").handler("", ctx);
		assert.match(messages(ui), /Vision interview queued/);
		assert.ok(pi.sentUserMessages.length > 0, "the interview prompt must reach the agent");
		assert.match(pi.sentUserMessages.join("\n"), /interview|vision/i);
	});
});
