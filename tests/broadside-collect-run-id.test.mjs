// collect can target a run by id (self-audit #268, L7).
//
// With two runs in flight, collect always read the most recent, so an older
// run still in flight could not be collected once a newer submit existed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { parseBroadsideFlags } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/broadside-flags.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);

function response(status, body) {
	return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Batches complete with one empty result each; GETs record which batch was asked for. */
function fetcher(asked) {
	let posts = 0;
	return async (url, init) => {
		if (init?.method === "POST") return response(202, { id: `batch-${++posts}`, status: "validating" });
		if (String(url).includes("/models")) return response(200, { data: [] });
		const id = String(url).split("/").pop();
		asked.push(id);
		return response(200, { id, status: "completed", request_counts: {}, results: [], usage: { cost: 0 } });
	};
}

test("collect targets the run named by runId, and names the recorded ids when it is unknown", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-run-id-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		const asked = [];
		const fetch = fetcher(asked);
		const first = await core.runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: fetch, maxCost: 0 });
		await new Promise((done) => setTimeout(done, 5));
		const second = await core.runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: fetch, maxCost: 0 });
		assert.notEqual(first.runId, second.runId);

		const older = await core.runBroadsideCollect(dir, "sk-fake", { waitMs: 0, fetcher: fetch, includeSynthesis: false, includeTriage: false, runId: first.runId });
		assert.equal(older.runId, first.runId);
		assert.deepEqual(asked, ["batch-1"], "the older run's batch was polled, not the newest");

		const newest = await core.runBroadsideCollect(dir, "sk-fake", { waitMs: 0, fetcher: fetch, includeSynthesis: false, includeTriage: false });
		assert.equal(newest.runId, second.runId, "absent, the most recent — as before");

		await assert.rejects(
			core.runBroadsideCollect(dir, "sk-fake", { waitMs: 0, fetcher: fetch, runId: "nope" }),
			new RegExp(`^Error: No Broad-Side run with id nope\\. Recorded runs: ${first.runId}, ${second.runId}\\.$`),
		);
		assert.match(core.statusText(await core.loadBroadsideState(core.broadsideDirFor(dir))), new RegExp(`Run ${first.runId}`), "status lists the id to pass");
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("the MCP tool takes run_id and the Pi command takes --run=, for collect only", async () => {
	const flags = parseBroadsideFlags("collect --run=2026-09-12T00-00-00-000Z --wait=0");
	assert.equal(flags.runId, "2026-09-12T00-00-00-000Z");
	assert.equal(flags.error, undefined);
	assert.match(parseBroadsideFlags("submit --run=x").error, /^--run is only meaningful for collect/);
	assert.match(parseBroadsideFlags("collect --run=").error, /^--run= needs a run id/);

	const dir = await mkdtemp(join(tmpdir(), "cc-run-id-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		const asked = [];
		const fetch = fetcher(asked);
		const first = await core.runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: fetch, maxCost: 0 });
		await new Promise((done) => setTimeout(done, 5));
		await core.runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: fetch, maxCost: 0 });
		const original = globalThis.fetch;
		const originalKey = process.env.OPENROUTER_API_KEY;
		globalThis.fetch = fetch;
		process.env.OPENROUTER_API_KEY = "sk-fake"; // the slash command takes no key argument
		try {
			const result = await server.handleBroadside({ cwd: dir, action: "collect", api_key: "sk-fake", wait_seconds: 0, run_id: first.runId, include_synthesis: false, include_triage: false });
			assert.equal(result.structuredContent.runId, first.runId);
			await assert.rejects(server.handleBroadside({ cwd: dir, action: "collect", api_key: "sk-fake", wait_seconds: 0, run_id: "nope" }), /No Broad-Side run with id nope/);

			const commands = new Map();
			const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
			const ui = { widgets: [], notifications: [], theme: { fg: (_n, t) => t }, setStatus: () => {}, setWidget: (id, value) => ui.widgets.push({ id, value }), notify: (message, level) => ui.notifications.push({ message, level }), confirm: async () => true };
			const ctx = { cwd: dir, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
			codeCartographerExtension(pi);
			await commands.get("codecarto-broadside").handler(`collect --run=${first.runId} --wait=0 --no-synthesis --no-triage`, ctx);
			assert.ok(ui.widgets.length > 0, `no widget; notifications: ${JSON.stringify(ui.notifications)}`);
			assert.match(ui.widgets.at(-1).value.join("\n"), new RegExp(`Broad-Side run ${first.runId}`));
		} finally {
			globalThis.fetch = original;
			if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = originalKey;
		}
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
