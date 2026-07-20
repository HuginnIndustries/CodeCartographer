import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);

function createHarness(cwd) {
	const events = new Map();
	const commands = new Map();
	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		setActiveTools: (tools) => {
			pi.activeTools = tools;
		},
		setSessionName: (name) => {
			pi.sessionName = name;
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
		activeTools: undefined,
		sessionName: undefined,
	};
	const ui = {
		statuses: [],
		widgets: [],
		notifications: [],
		theme: {
			fg: (_name, text) => text,
		},
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
		reload: async () => {
			ctx.reloads += 1;
		},
		reloads: 0,
	};
	codeCartographerExtension(pi);
	return { events, commands, pi, ctx, ui };
}

async function withTempRepo(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-pi-activation-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

test("session_start does not activate CodeCartographer UI just because .codecarto exists", async () => {
	await withTempRepo(async (cwd) => {
		await cp(join(REPO_ROOT, ".codecarto"), join(cwd, ".codecarto"), { recursive: true });
		const { events, pi, ctx, ui } = createHarness(cwd);

		await events.get("session_start")({}, ctx);

		assert.equal(pi.activeTools, undefined, "safe tool mode should not be enabled before /codecarto-init");
		assert.deepEqual(ui.statuses.at(-1), { id: "codecarto-status", value: undefined });
		assert.deepEqual(ui.widgets.at(-1), { id: "codecarto-widget", value: undefined });
	});
});

test("tool_call policy is inactive before /codecarto-init even when .codecarto exists", async () => {
	await withTempRepo(async (cwd) => {
		await cp(join(REPO_ROOT, ".codecarto"), join(cwd, ".codecarto"), { recursive: true });
		const { events, ctx } = createHarness(cwd);

		await events.get("session_start")({}, ctx);
		const result = await events.get("tool_call")({ toolName: "bash", input: {} }, ctx);

		assert.equal(result, undefined);
	});
});

test("/codecarto-init activates the CodeCartographer UI and read-only tool policy", async () => {
	await withTempRepo(async (cwd) => {
		const { commands, events, pi, ctx, ui } = createHarness(cwd);

		await events.get("session_start")({}, ctx);
		await commands.get("codecarto-init").handler("lite", ctx);

		assert.equal(ctx.reloads, 0, "/codecarto-init should render UI directly instead of relying on session_start reload activation");
		assert.deepEqual(pi.activeTools, ["read", "grep", "find", "ls", "edit", "write"]);
		assert.equal(pi.sessionName, "CodeCartographer: architecture");
		assert.equal(ui.widgets.at(-1).id, "codecarto-widget");
		assert.match(ui.widgets.at(-1).value.join("\n"), /CodeCartographer\nPhase: architecture/);

		const result = await events.get("tool_call")({ toolName: "bash", input: {} }, ctx);
		assert.deepEqual(result, { block: true, reason: "CodeCartographer mode disables bash to keep source analysis read-only." });
	});
});

test("/codecarto-open activates an existing workspace without resetting durable state", async () => {
	await withTempRepo(async (cwd) => {
		await cp(join(REPO_ROOT, ".codecarto"), join(cwd, ".codecarto"), { recursive: true });
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		const before = await readFile(statusPath, "utf8");
		const { commands, events, pi, ctx, ui } = createHarness(cwd);

		await events.get("session_start")({}, ctx);
		assert.equal(typeof commands.get("codecarto-open")?.handler, "function");
		await commands.get("codecarto-open").handler("", ctx);

		assert.equal(await readFile(statusPath, "utf8"), before);
		assert.deepEqual(pi.activeTools, ["read", "grep", "find", "ls", "edit", "write"]);
		assert.match(pi.sessionName, /^CodeCartographer:/);
		assert.match(ui.notifications.at(-1).message, /Opened existing CodeCartographer workspace/);
	});
});
