// Under `pi -p`, ctx.hasUI is false and ctx.ui.notify is a silent no-op, so a
// command whose only output is a notify exits 0 having printed nothing — which
// is exactly what a silent refusal looks like (#219). notifyCtx routes those
// messages to a stream instead. The interactive path must not change: the
// parity suite runs every command with hasUI: true and pins that.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { notifyCtx, isCtxLive, formatStreamNotification } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/notify.ts`).href
);
const { default: codeCartographerExtension } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href
);

function captureStream() {
	const chunks = [];
	return { chunks, write: (chunk) => chunks.push(chunk) };
}

// ---------- the wrapper itself ----------

test("with a UI, notifyCtx uses the TUI and writes nothing to the stream", () => {
	const notifications = [];
	const ctx = { cwd: "/tmp", hasUI: true, ui: { notify: (m, l) => notifications.push({ m, l }) } };
	const stream = captureStream();
	notifyCtx(ctx, "hello", "info", stream);
	assert.deepEqual(notifications, [{ m: "hello", l: "info" }]);
	assert.deepEqual(stream.chunks, []);
});

test("without a UI, notifyCtx writes one prefixed line to the stream instead of dropping it", () => {
	const ctx = { cwd: "/tmp", hasUI: false, ui: { notify: () => assert.fail("must not call the no-op notify") } };
	const stream = captureStream();
	notifyCtx(ctx, "Initialized CodeCartographer (lite)", "info", stream);
	assert.deepEqual(stream.chunks, ["[codecarto] info: Initialized CodeCartographer (lite)\n"]);
});

test("the stream line carries the level, so an error is distinguishable from a status", () => {
	assert.equal(formatStreamNotification("boom", "error"), "[codecarto] error: boom\n");
	assert.equal(formatStreamNotification("fine", "warning"), "[codecarto] warning: fine\n");
});

test("a stale ctx is dropped on both paths, never thrown on", () => {
	// Pi's stale ctx throws on every property access, hasUI included; a
	// Proxy whose get trap throws models it exactly (see #201).
	const stale = new Proxy({}, { get() { throw new Error("This extension ctx is stale"); } });
	assert.equal(isCtxLive(stale), false);
	const stream = captureStream();
	assert.doesNotThrow(() => notifyCtx(stale, "lost", "info", stream));
	assert.deepEqual(stream.chunks, [], "a dead session has nowhere for the message to go");
});

test("the default stream is stderr, not stdout", async () => {
	// --mode json owns stdout for its event stream; prose there corrupts it.
	const original = process.stderr.write;
	const chunks = [];
	process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
	try {
		notifyCtx({ cwd: "/tmp", hasUI: false, ui: { notify() {} } }, "to stderr", "info");
	} finally {
		process.stderr.write = original;
	}
	assert.deepEqual(chunks, ["[codecarto] info: to stderr\n"]);
});

// ---------- the commands that had no other output ----------

async function withHeadlessHarness(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-notify-fallback-"));
	try {
		const commands = new Map();
		const pi = {
			on() {},
			registerCommand: (name, opts) => commands.set(name, opts),
			setActiveTools() {},
			setSessionName() {},
			sendMessage() {},
			sendUserMessage() {},
		};
		const stream = captureStream();
		const original = process.stderr.write;
		process.stderr.write = (chunk) => { stream.write(String(chunk)); return true; };
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: () => assert.fail("headless: the no-op notify must not be the path"), setWidget() {}, confirm: async () => true },
			signal: new AbortController().signal,
			idle: true,
			isIdle: () => true,
			reload: async () => {},
		};
		try {
			codeCartographerExtension(pi);
			await fn({ commands, ctx, stream });
		} finally {
			process.stderr.write = original;
		}
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

test("headless /codecarto-init prints its confirmation instead of exiting silently", async () => {
	await withHeadlessHarness(async ({ commands, ctx, stream }) => {
		await commands.get("codecarto-init").handler("lite", ctx);
		const out = stream.chunks.join("");
		assert.match(out, /^\[codecarto\] info: Initialized CodeCartographer \(lite\)/m);
	});
});

test("headless /codecarto-status — the notify-only command — now produces output", async () => {
	await withHeadlessHarness(async ({ commands, ctx, stream }) => {
		await commands.get("codecarto-init").handler("lite", ctx);
		stream.chunks.length = 0;
		await commands.get("codecarto-status").handler("", ctx);
		const out = stream.chunks.join("");
		assert.ok(out.length > 0, "status must say something when there is no TUI");
		assert.match(out, /^\[codecarto\] info: /m);
	});
});

test("headless refusal is visible too: the same silence that hid #180's activation gate", async () => {
	await withHeadlessHarness(async ({ commands, ctx, stream }) => {
		// No init, no open: codecartoModeActive is false, so status refuses.
		await commands.get("codecarto-status").handler("", ctx);
		const out = stream.chunks.join("");
		assert.ok(out.length > 0, "a refusal must not look identical to success");
		assert.match(out, /\[codecarto\] (error|warning): /);
	});
});
