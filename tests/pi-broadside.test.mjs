// The Pi surface for Broad-Side (/codecarto-broadside). Drives the registered
// command through a fake Pi harness with a stubbed global fetch — no network,
// no spend. What matters here is the surface's two divergences from MCP: it
// asks a human about the money instead of refusing over max_cost, and it runs
// on a repository with no CodeCartographer workspace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: codeCartographerExtension } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href
);

function createHarness(cwd, { confirm = async () => true } = {}) {
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
		confirmations: [],
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => {
			ui.confirmations.push({ title, body });
			return confirm(title, body);
		},
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, ctx, ui };
}

function fakeResponse(status, body) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A repository big enough that the defect lens produces a priced slice. */
async function scoutableRepo() {
	const cwd = await mkdtemp(join(tmpdir(), "cc-pi-broadside-"));
	await writeFile(join(cwd, "go.mod"), "module x\n");
	await mkdir(join(cwd, "big"), { recursive: true });
	for (let i = 0; i < 20; i++) {
		await writeFile(join(cwd, "big", `file${i}.go`), `package big\n// ${"y".repeat(2000)}\n`);
	}
	return cwd;
}

async function withStubbedFetch(handler, fn) {
	const original = globalThis.fetch;
	const posts = [];
	globalThis.fetch = async (url, init = {}) => {
		if (init.method === "POST") posts.push({ url: String(url), body: JSON.parse(init.body ?? "{}") });
		return handler(String(url), init) ?? fakeResponse(200, { id: "x", status: "in_progress" });
	};
	try {
		return await fn(posts);
	} finally {
		globalThis.fetch = original;
	}
}

function lastNotification(ui) {
	return ui.notifications.at(-1);
}

test("status works with no workspace, no API key, and no runs recorded", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-pi-broadside-empty-"));
	const key = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	try {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-broadside").handler("status", ctx);

		assert.match(lastNotification(ui).message, /no runs recorded/i);
		assert.equal(lastNotification(ui).level, "info", "an empty scout history is not an error");
		// With no workspace there is no phase widget, so the result lives in the
		// Broad-Side widget rather than vanishing into a one-line notification.
		assert.equal(ui.widgets.at(-1).id, "codecarto-broadside");
		assert.equal(ui.widgets.at(-1).value[0], "Broad-Side");
	} finally {
		if (key !== undefined) process.env.OPENROUTER_API_KEY = key;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a missing API key names both ways to supply one and never takes it as an argument", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-pi-broadside-nokey-"));
	const key = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	try {
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-broadside").handler("submit architecture", ctx);

		const notice = lastNotification(ui);
		assert.equal(notice.level, "error");
		assert.match(notice.message, /OPENROUTER_API_KEY/);
		assert.match(notice.message, /config\.yaml/);
		assert.match(notice.message, /transcript/, "must say why the command takes no key argument");
		assert.equal(ui.confirmations.length, 0, "no spend prompt without a key");
	} finally {
		if (key !== undefined) process.env.OPENROUTER_API_KEY = key;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("submit prices the run, asks before spending, and submits nothing when declined", async () => {
	const cwd = await scoutableRepo();
	const key = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "sk-fake";
	try {
		await withStubbedFetch(() => fakeResponse(202, { id: "batch-1", status: "validating" }), async (posts) => {
			const { commands, ctx, ui } = createHarness(cwd, { confirm: async () => false });
			await commands.get("codecarto-broadside").handler("submit defect", ctx);

			assert.equal(ui.confirmations.length, 1, "the user must be asked before any spend");
			assert.match(ui.confirmations[0].title, /will spend about \$\d/);
			assert.match(ui.confirmations[0].body, /Per lens:/);
			assert.match(ui.confirmations[0].body, /pre-flight prediction/, "must not present the estimate as the bill");
			assert.equal(posts.length, 0, "declining must submit no batch");
			assert.equal(lastNotification(ui).level, "info", "a cancel is not an error");
			assert.match(lastNotification(ui).message, /cancelled/i);
		});
	} finally {
		if (key === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = key;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an approved submit fires the batch and reports the run id", async () => {
	const cwd = await scoutableRepo();
	const key = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "sk-fake";
	try {
		await withStubbedFetch(() => fakeResponse(202, { id: "batch-1", status: "validating" }), async (posts) => {
			const { commands, ctx, ui } = createHarness(cwd, { confirm: async () => true });
			await commands.get("codecarto-broadside").handler("submit defect", ctx);

			assert.equal(posts.length, 1, "exactly one lens batch should be submitted");
			assert.match(lastNotification(ui).message, /Broad-Side submitted: run /);
			const widget = ui.widgets.at(-1).value.join("\n");
			assert.match(widget, /collect/, "the result must say how to finish the run");
		});
	} finally {
		if (key === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = key;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a bad argument is refused before anything is priced or spent", async () => {
	const cwd = await scoutableRepo();
	const key = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "sk-fake";
	try {
		await withStubbedFetch(() => fakeResponse(202, { id: "b", status: "validating" }), async (posts) => {
			const { commands, ctx, ui } = createHarness(cwd);
			await commands.get("codecarto-broadside").handler("submit --max-cost=", ctx);
			assert.equal(lastNotification(ui).level, "error");
			assert.match(lastNotification(ui).message, /--max-cost needs a non-negative number/);

			await commands.get("codecarto-broadside").handler("sumbit", ctx);
			assert.match(lastNotification(ui).message, /Unknown \/codecarto-broadside argument: sumbit/);

			assert.equal(ui.confirmations.length, 0);
			assert.equal(posts.length, 0);
		});
	} finally {
		if (key === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = key;
		await rm(cwd, { recursive: true, force: true });
	}
});
