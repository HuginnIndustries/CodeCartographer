// The four operations that were MCP-only until #157/#159/#160/#161 —
// codecarto_list_skills, codecarto_guide, codecarto_refresh_scaffold, and
// codecarto_amend — driven through their Pi slash commands on a fake harness.
// What matters here is parity with the MCP handlers on the payload, and the two
// places Pi deliberately differs: it asks before a scaffold refresh or an
// amendment writes anything (MCP has nobody to ask), and its footers and hints
// name the slash command rather than the MCP tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

function createHarness(cwd) {
	const commands = new Map();
	const events = new Map();
	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		setActiveTools: () => {},
		setSessionName: () => {},
		sendMessage: () => {},
		sentUserMessages: [],
		sendUserMessage: (message, options) => {
			pi.sentUserMessages.push({ message, options });
		},
	};
	const ui = {
		widgets: [],
		notifications: [],
		confirmations: [],
		/** What the next ctx.ui.confirm answers; tests flip it between calls. */
		answer: true,
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => {
			ui.confirmations.push({ title, body });
			return ui.answer;
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui,
		signal: new AbortController().signal,
		idle: true,
		isIdle: () => ctx.idle,
		reload: async () => {},
	};
	codeCartographerExtension(pi);
	return { commands, events, pi, ctx, ui };
}

async function withTempRepo(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-pi-parity-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

const lastNotification = (ui) => ui.notifications.at(-1);
const lastWidgetText = (ui) => ui.widgets.at(-1).value.join("\n");

/** Complete the single architecture phase with a handoff that leaves work for an amendment. */
async function completeArchitecture(cwd, handoffBody) {
	const codecarto = join(cwd, ".codecarto");
	await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), [
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
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), handoffBody, "utf8");
	const state = await core.getWorkspaceState(cwd);
	const validation = await core.validatePhaseOutput(state, "architecture");
	await core.completeValidatedPhase(cwd, validation, "pi-parity-test");
}

async function writeAmendment(cwd, slug, body) {
	const dir = join(cwd, ".codecarto", "scratch", "amendments");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${slug}.yaml`), body, "utf8");
}

test("the four formerly MCP-only operations are registered as slash commands", async () => {
	await withTempRepo(async (cwd) => {
		const { commands } = createHarness(cwd);
		for (const name of ["codecarto-list-skills", "codecarto-guide", "codecarto-refresh-scaffold", "codecarto-amend"]) {
			assert.equal(typeof commands.get(name)?.handler, "function", `${name} is not registered`);
		}
		assert.equal(commands.size, 20, "the registered-command count is pinned; update README's table and this number together");
	});
});

// ---------- /codecarto-list-skills (#161) ----------

test("/codecarto-list-skills needs a workspace, like codecarto_list_skills", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-list-skills").handler("", ctx);
		assert.equal(lastNotification(ui).level, "warning");
		assert.match(lastNotification(ui).message, /codecarto-init/);
	});
});

test("/codecarto-list-skills lists the same skills as codecarto_list_skills and names the ungated Broad-Side guide", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-init").handler("lite", ctx);

		await commands.get("codecarto-list-skills").handler("", ctx);

		const widget = lastWidgetText(ui);
		const mcp = await server.handleListSkills({ cwd });
		assert.ok(mcp.structuredContent.skills.length > 0, "the packaged template ships at least one post-pipeline skill");
		const listed = widget.split("\n").filter((line) => line.startsWith("  - ")).map((line) => line.slice(4));
		assert.deepEqual(listed, mcp.structuredContent.skills, "both surfaces must list the same skills in the same order");
		assert.match(widget, new RegExp(`Available skills \\(${mcp.structuredContent.skills.length}\\):`));
		assert.match(widget, /unlock when the pipeline completes \(next phase: architecture\)/, "Pi says why /codecarto-skill would refuse right now");
		assert.match(widget, /Also served by \/codecarto-skill \(not pipeline-gated\): broadside/, "the Broad-Side line names the slash command, not the MCP tool");
		assert.equal(widget.includes("codecarto_skill"), false);
		assert.equal(lastNotification(ui).level, "info");
		assert.match(lastNotification(ui).message, /spec-delta-application/);
	});
});

// ---------- /codecarto-guide (#160) ----------

test("/codecarto-guide serves the packaged overview without a workspace, footer naming the slash command", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, pi, ctx, ui } = createHarness(cwd);

		await commands.get("codecarto-guide").handler("", ctx);

		assert.equal(pi.sentUserMessages.length, 1, "the guide is queued as one message");
		const { message, options } = pi.sentUserMessages[0];
		assert.equal(options, undefined, "an idle session receives it immediately");
		const document = (await core.readGuide("overview")).content;
		assert.ok(message.includes(document), "the document is embedded entire, not summarized");

		// The document body is byte-identical to what MCP serves; only the Pi
		// framing around it differs. Compare the shared span rather than the
		// whole message.
		const mcp = await server.handleGuide({});
		const mcpDocument = mcp.content[0].text.slice(0, mcp.content[0].text.indexOf("\n\n---\nOther guide topics:"));
		assert.ok(message.includes(mcpDocument), "Pi and MCP serve the same guide bytes");

		// Framing: reference-not-task header before, Pi-surface addendum after.
		assert.ok(message.indexOf("reference material, not a task") < message.indexOf(document), "the framing header precedes the document");
		assert.match(message, /Do not start a workflow/, "the header tells the model not to drive");
		assert.ok(message.indexOf("Reading this guide in a Pi session") > message.indexOf(document), "the surface addendum follows the document");
		assert.match(message, /registers no tools/, "the addendum explains why no codecarto_\* tool exists here");
		assert.match(message, /auto-validates and auto-completes/, "the addendum corrects the MCP drive loop");

		const footer = message.slice(message.lastIndexOf("\n\n---\nOther guide topics:"));
		assert.match(footer, /^\n\n---\nOther guide topics: .*handoff-contract.* \(run \/codecarto-guide <topic>\)\.$/);
		assert.equal(footer.includes("codecarto_guide"), false, "the footer sends a Pi session to the slash command, not the MCP tool");

		assert.equal(lastNotification(ui).level, "info");
		assert.match(lastNotification(ui).message, /overview/);
	});
});

test("/codecarto-guide <topic> serves that topic and queues as a follow-up while the agent is busy", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, pi, ctx } = createHarness(cwd);
		ctx.idle = false;

		await commands.get("codecarto-guide").handler("phase-recovery", ctx);

		const { message, options } = pi.sentUserMessages[0];
		assert.match(message, /Recovering a stalled or failed phase/);
		assert.match(message, /Other guide topics: overview, /, "the overview is offered back from a topic");
		assert.deepEqual(options, { deliverAs: "followUp" });
	});
});

test("/codecarto-guide rejects an unknown topic loudly and sends nothing", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, pi, ctx, ui } = createHarness(cwd);

		await commands.get("codecarto-guide").handler("../package", ctx);

		assert.equal(pi.sentUserMessages.length, 0);
		assert.equal(lastNotification(ui).level, "error");
		assert.match(lastNotification(ui).message, /Unknown guide topic/);
		assert.match(lastNotification(ui).message, /Available: overview, /);
	});
});

test("/codecarto-guide tab-completes the packaged topics", async () => {
	await withTempRepo(async (cwd) => {
		const { commands } = createHarness(cwd);
		const complete = commands.get("codecarto-guide").getArgumentCompletions;
		const all = await complete("");
		assert.deepEqual(all.map((item) => item.value), await core.listGuideTopics());
		assert.deepEqual((await complete("phase-")).map((item) => item.value), ["phase-recovery"]);
		assert.equal(await complete("zzz"), null);
	});
});

// ---------- /codecarto-refresh-scaffold (#159) ----------

test("/codecarto-refresh-scaffold previews the exact file set, and a declined confirmation writes nothing", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-init").handler("architecture-only", ctx);
		const codecarto = join(cwd, ".codecarto");
		await writeFile(join(codecarto, "GUIDE.md"), "# Stale guide from an old release\n", "utf8");
		await unlink(join(codecarto, "workflow", "scaffold-version.yaml"));
		const threadLogBefore = await readFile(join(codecarto, "THREAD_LOG.md"), "utf8");

		ui.answer = false;
		await commands.get("codecarto-refresh-scaffold").handler("", ctx);

		assert.equal(ui.confirmations.length, 1, "Pi asks before a refresh; MCP cannot");
		const { title, body } = ui.confirmations[0];
		assert.match(title, /Refresh the \.codecarto\/ scaffold/);
		assert.match(body, new RegExp(`Scaffold version: unversioned → ${core.PACKAGE_VERSION.replaceAll(".", "\\.")}\\.`));
		const files = await core.listScaffoldRefreshFiles();
		assert.match(body, new RegExp(`Overwrites ${files.length} framework-owned file\\(s\\)`), "the count is the set refreshScaffold writes");
		assert.match(body, /GUIDE\.md/);
		assert.match(body, /workflow\/: VALIDATE\.md, pipeline-architecture-only\.yaml, .*scaffold-version\.yaml/, "workflow/ files are named individually");
		assert.match(body, /Never touched: workflow\/status\.yaml, workflow\/config\.yaml, workflow\/\.usage\.local\.yaml, BACKLOG\.md, THREAD_LOG\.md, CONVENTIONS\.md, DECISIONS\.md, scratch\/, inputs\/, closeouts\/, broadside\/\./);

		assert.equal(await readFile(join(codecarto, "GUIDE.md"), "utf8"), "# Stale guide from an old release\n", "declining leaves the stale file alone");
		assert.equal(await readFile(join(codecarto, "THREAD_LOG.md"), "utf8"), threadLogBefore, "declining logs nothing");
		assert.equal(lastNotification(ui).level, "info");
		assert.match(lastNotification(ui).message, /cancelled\. Nothing was written/);
	});
});

test("/codecarto-refresh-scaffold restores framework-owned files on approval and clears the staleness line", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-init").handler("architecture-only", ctx);
		const codecarto = join(cwd, ".codecarto");
		await writeFile(join(codecarto, "GUIDE.md"), "# Stale guide from an old release\n", "utf8");
		await unlink(join(codecarto, "templates", "phase-handoff.yaml"));
		await writeFile(join(codecarto, "workflow", "scaffold-version.yaml"), "scaffold_version: 0.11.0\n", "utf8");
		await writeFile(join(codecarto, "CONVENTIONS.md"), "# Conventions\n\nC01: project-specific.\n", "utf8");
		const statusBefore = await readFile(join(codecarto, "workflow", "status.yaml"), "utf8");

		await commands.get("codecarto-status").handler("", ctx);
		assert.match(lastWidgetText(ui), /Scaffold: .*older than the running framework/, "the stale marker shows in the widget first");
		assert.match(lastWidgetText(ui), /\/codecarto-refresh-scaffold/, "the staleness notice names the Pi remedy inside a Pi session");

		ui.answer = true;
		await commands.get("codecarto-refresh-scaffold").handler("", ctx);

		assert.match(ui.confirmations[0].body, new RegExp(`Scaffold version: 0\\.11\\.0 → ${core.PACKAGE_VERSION.replaceAll(".", "\\.")}\\.`));
		const packagedGuide = await readFile(join(core.packagedWorkspaceDir, "GUIDE.md"), "utf8");
		assert.equal(await readFile(join(codecarto, "GUIDE.md"), "utf8"), packagedGuide, "GUIDE restored byte-identically");
		const packagedHandoff = await readFile(join(core.packagedWorkspaceDir, "templates", "phase-handoff.yaml"), "utf8");
		assert.equal(await readFile(join(codecarto, "templates", "phase-handoff.yaml"), "utf8"), packagedHandoff, "deleted template restored");
		assert.match(await readFile(join(codecarto, "workflow", "scaffold-version.yaml"), "utf8"), new RegExp(core.PACKAGE_VERSION.replaceAll(".", "\\.")));
		assert.equal(await readFile(join(codecarto, "workflow", "status.yaml"), "utf8"), statusBefore, "project state untouched");
		assert.match(await readFile(join(codecarto, "CONVENTIONS.md"), "utf8"), /project-specific/, "user-owned file untouched");
		assert.match(await readFile(join(codecarto, "THREAD_LOG.md"), "utf8"), /scaffold-refresh — Refreshed \d+ framework-owned file\(s\) .*\(0\.11\.0 → /);

		const widget = lastWidgetText(ui);
		assert.match(widget, /Refreshed \d+ framework-owned file\(s\) from the packaged template \(0\.11\.0 → /);
		assert.match(widget, /THREAD_LOG\.md: one scaffold-refresh entry appended\./);
		assert.equal(widget.includes("Scaffold:"), false, "the staleness line clears once the marker matches");
		assert.equal(lastNotification(ui).level, "info");
		assert.match(lastNotification(ui).message, /^Refreshed \d+ framework-owned file\(s\) \(0\.11\.0 → /);
	});
});

// ---------- /codecarto-amend (#157) ----------

test("/codecarto-amend surfaces codecarto_amend's refusals as errors, before asking anything", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-init").handler("architecture-only", ctx);

		await commands.get("codecarto-amend").handler("", ctx);
		assert.equal(lastNotification(ui).level, "warning");
		assert.match(lastNotification(ui).message, /Usage: \/codecarto-amend <name>/);
		assert.match(lastNotification(ui).message, /templates\/amendment\.yaml/, "with nothing staged, say where an amendment comes from");

		await commands.get("codecarto-amend").handler("missing-file", ctx);
		assert.equal(lastNotification(ui).level, "error");
		assert.match(lastNotification(ui).message, /No amendment at \.codecarto\/scratch\/amendments\/missing-file\.yaml/);

		await commands.get("codecarto-amend").handler("../escape.yaml", ctx);
		assert.equal(lastNotification(ui).level, "error");
		assert.match(lastNotification(ui).message, /read from \.codecarto\/scratch\/amendments\/ only/);

		await writeAmendment(cwd, "too-early", ["schema_version: 1", "open_question_closures:", "  - arch-OQ1", "closeout_summary: Premature.", ""].join("\n"));
		await commands.get("codecarto-amend").handler("too-early", ctx);
		assert.equal(lastNotification(ui).level, "error");
		assert.match(lastNotification(ui).message, /Cannot amend: the pipeline is not complete \(next phase: architecture\)/);

		await writeAmendment(cwd, "malformed", ["schema_version: 1", "open_question_closures: not-an-array", ""].join("\n"));
		await commands.get("codecarto-amend").handler("malformed", ctx);
		assert.equal(lastNotification(ui).level, "error");
		assert.match(lastNotification(ui).message, /must be an array/);

		assert.equal(ui.confirmations.length, 0, "a refused amendment is never put to the user");
		const closeouts = await readdir(join(cwd, ".codecarto", "closeouts")).catch(() => []);
		assert.deepEqual(closeouts.filter((name) => name.includes("-amendment-")), [], "nothing was written");
		assert.equal((await readFile(join(cwd, ".codecarto", "THREAD_LOG.md"), "utf8")).includes("amendment:"), false);
	});
});

test("/codecarto-amend previews the closures against status.yaml, applies on yes, and is idempotent by path", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, events, ctx, ui } = createHarness(cwd);
		await events.get("session_start")({}, ctx);
		await commands.get("codecarto-init").handler("architecture-only", ctx);
		const codecarto = join(cwd, ".codecarto");
		await completeArchitecture(cwd, [
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
		await writeAmendment(cwd, "scope-resolved", [
			"schema_version: 1",
			"open_question_closures:",
			"  - arch-OQ1",
			"  - arch-OQ9",
			"post_pipeline_closures:",
			"  - post-1",
			"notes:",
			"  - Resolved on source evidence; the launcher refuses non-loopback binds.",
			"closeout_summary: Deployment scope resolved on evidence.",
			"",
		].join("\n"));

		// Tab-completion lists what is staged.
		const complete = commands.get("codecarto-amend").getArgumentCompletions;
		assert.deepEqual((await complete("sc")).map((item) => item.value), ["scope-resolved"]);

		// Declined: the preview resolved every id, and nothing changed.
		ui.answer = false;
		await commands.get("codecarto-amend").handler("scope-resolved", ctx);
		assert.equal(ui.confirmations.length, 1);
		const { title, body } = ui.confirmations[0];
		assert.equal(title, 'Apply amendment "scope-resolved"?');
		assert.match(body, /Closes 2 open question\(s\):/);
		assert.match(body, /arch-OQ1 \(architecture, needs-maintainer-decision\): Is the loopback-only bind intentional\?/);
		assert.match(body, /arch-OQ9 — matches nothing \(already closed or unknown; reported, not fatal\)/);
		assert.match(body, /Retires 1 post-pipeline item\(s\):/);
		assert.match(body, /post-1 \(spike, from architecture\): Probe concurrent writers\./);
		assert.match(body, /Records 1 note\(s\) in the closeout:\n {2}- Resolved on source evidence/);
		assert.match(body, /appends one THREAD_LOG entry \("Deployment scope resolved on evidence\."\)/);
		assert.match(lastNotification(ui).message, /cancelled\. Nothing was written/);
		let state = await core.getWorkspaceState(cwd);
		assert.deepEqual(state.status.phases.architecture.open_questions.map((entry) => entry.id), ["arch-OQ1", "arch-OQ2"]);
		assert.deepEqual((await readdir(join(codecarto, "closeouts"))).filter((name) => name.includes("-amendment-")), []);
		assert.equal((await readFile(join(codecarto, "THREAD_LOG.md"), "utf8")).includes("amendment:"), false);

		// Approved: the same result codecarto_amend renders, plus the dashboard.
		ui.answer = true;
		await commands.get("codecarto-amend").handler("scope-resolved", ctx);
		const widget = lastWidgetText(ui);
		assert.match(widget, /Amendment applied: scope-resolved/);
		assert.match(widget, /Open questions closed: arch-OQ1\n/);
		assert.match(widget, /Post-pipeline items closed: post-1\n/);
		assert.match(widget, /Ids that matched nothing \(already closed or unknown\): arch-OQ9/);
		assert.match(widget, /Closeout: \.codecarto\/closeouts\/\S+-amendment-scope-resolved\.md/);
		assert.match(widget, /Dashboard refreshed: \.codecarto\/dashboard\.html/);
		assert.ok(await core.pathExists(join(codecarto, "dashboard.html")), "the dashboard regenerates like MCP's handler");
		assert.equal(lastNotification(ui).level, "warning", "an id that matched nothing is worth a second look");
		assert.match(lastNotification(ui).message, /1 open question\(s\) and 1 post-pipeline item\(s\) closed; 1 id\(s\) matched nothing/);
		state = await core.getWorkspaceState(cwd);
		assert.deepEqual(state.status.phases.architecture.open_questions.map((entry) => entry.id), ["arch-OQ2"]);
		assert.deepEqual(state.status.post_pipeline, []);
		const threadLog = await readFile(join(codecarto, "THREAD_LOG.md"), "utf8");
		assert.match(threadLog, /amendment:scope-resolved — Deployment scope resolved on evidence\./);

		// Re-run by path: accepted, previewed as already applied, logged once.
		await commands.get("codecarto-amend").handler(".codecarto/scratch/amendments/scope-resolved.yaml", ctx);
		assert.equal(ui.confirmations.length, 3);
		assert.match(ui.confirmations[2].body, /arch-OQ1 — matches nothing/);
		assert.match(ui.confirmations[2].body, /post-1 — matches nothing/);
		assert.match(lastWidgetText(ui), /Open questions closed: none\nPost-pipeline items closed: none/);
		assert.equal(lastNotification(ui).level, "warning");
		assert.equal((await readFile(join(codecarto, "THREAD_LOG.md"), "utf8")).match(/amendment:scope-resolved/g).length, 1, "THREAD_LOG entry appears once");
	});
});
