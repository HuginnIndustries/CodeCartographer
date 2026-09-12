// The four Broad-Side highs from the self-audit (#230–#233).
//
// #230 wait_seconds: 0 became the 25-minute default on both surfaces.
// #231 the MCP surface had no default spend cap, and cannot ask a human.
// #232 a config.yaml that failed to parse was treated as absent — defaults,
//      no cap, no lens routing, no message.
// #233 a corrupt state.json was read as empty and written over, orphaning
//      every paid run's batch ids.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
const { BROADSIDE_DEFAULT_MAX_COST, BroadsideConfigError, BroadsideStateError, broadsideDirFor, defaultBroadsideConfig, loadBroadsideConfig, loadBroadsideState, persistBroadsideRun, runBroadsideCollect, runBroadsideSubmit, saveBroadsideState } = core;

process.env.OPENROUTER_API_KEY = "sk-fake";

async function withRepo(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-guard-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

function response(status, body) {
	return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Accepts every POST and reports every GET batch as still running, counting the GETs. */
function runningFetcher(counts = { posts: 0, gets: 0 }) {
	const fetcher = async (url, init) => {
		if (init?.method === "POST") {
			counts.posts++;
			return response(202, { id: `batch-${counts.posts}`, status: "validating" });
		}
		if (String(url).includes("/models")) return response(200, { data: [] });
		counts.gets++;
		return response(200, { id: "batch-1", status: "in_progress", request_counts: {} });
	};
	return { fetcher, counts };
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
	const ui = {
		widgets: [], notifications: [], confirmations: [],
		theme: { fg: (_name, text) => text }, setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async () => true,
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, ctx, ui };
}

// ---------- #230 ----------

test("collect with wait_seconds 0 polls each in-flight batch once and returns at once", async () => {
	await withRepo(async (dir) => {
		const { fetcher, counts } = runningFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const started = Date.now();
		const result = await runBroadsideCollect(dir, "sk-fake", { waitMs: 0, fetcher, includeSynthesis: false, includeTriage: false });
		assert.ok(Date.now() - started < 1000, `returned in ${Date.now() - started}ms`);
		assert.equal(counts.gets, 1, "one poll, no waiting");
		assert.equal(result.lensOutcomes.architecture.status, "timeout", "the batch is still running server-side; collect again later");
	});
});

/** Run `fn` with global fetch stubbed to `fetcher` — the surfaces build their own. */
async function withGlobalFetch(fetcher, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = fetcher;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

test("codecarto_broadside and /codecarto-broadside collect with an explicit 0, and with nothing, return at once", async () => {
	await withRepo(async (dir) => {
		const { fetcher, counts } = runningFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		await withGlobalFetch(fetcher, async () => {
			for (const args of [{ wait_seconds: 0 }, {}]) {
				const before = counts.gets;
				const started = Date.now();
				const result = await server.handleBroadside({ cwd: dir, action: "collect", api_key: "sk-fake", include_synthesis: false, include_triage: false, ...args });
				assert.ok(Date.now() - started < 1000, `${JSON.stringify(args)} returned in ${Date.now() - started}ms`);
				assert.equal(counts.gets - before, 1, `${JSON.stringify(args)}: one poll`);
				assert.match(result.content[0].text, /architecture: timeout/);
			}
			const { commands, ctx, ui } = createHarness(dir);
			const before = counts.gets;
			const started = Date.now();
			await commands.get("codecarto-broadside").handler("collect --wait=0 --no-synthesis --no-triage", ctx);
			assert.ok(Date.now() - started < 1000);
			assert.equal(counts.gets - before, 1);
			assert.ok(ui.notifications.length > 0);
		});
	});
});

// ---------- #231 ----------

test("the shipped config carries a spend cap, and an explicit 0 spells no limit", async () => {
	assert.equal(BROADSIDE_DEFAULT_MAX_COST, 1);
	await withRepo(async (dir) => {
		const broadsideDir = broadsideDirFor(dir);
		assert.equal((await loadBroadsideConfig(broadsideDir)).maxCost, 1, "absent config → the default cap");
		await mkdir(broadsideDir, { recursive: true });
		await writeFile(join(broadsideDir, "config.yaml"), "max_cost: 0\n", "utf8");
		assert.equal((await loadBroadsideConfig(broadsideDir)).maxCost, 0, "explicit 0 → no limit");
		await writeFile(join(broadsideDir, "config.yaml"), "max_cost: 2.5\n", "utf8");
		assert.equal((await loadBroadsideConfig(broadsideDir)).maxCost, 2.5);
		await writeFile(join(broadsideDir, "config.yaml"), "max_cost: -1\n", "utf8");
		assert.equal((await loadBroadsideConfig(broadsideDir)).maxCost, 1, "a negative value is not a limit; the default applies");
	});
});

test("an MCP submit over the default cap is refused unless forced, and max_cost: 0 lifts it", async () => {
	await withRepo(async (dir) => {
		// A huge entry point makes the architecture lens alone cost more than a dollar.
		await writeFile(join(dir, "main.go"), `package main\n// ${"x".repeat(20_000)}\n`);
		for (let i = 0; i < 400; i++) await writeFile(join(dir, `f${i}.go`), `package main\n// ${"y".repeat(4000)}\n`);
		const { fetcher, counts } = runningFetcher();
		await mkdir(broadsideDirFor(dir), { recursive: true });
		await writeFile(join(broadsideDirFor(dir), "config.yaml"), "pricing:\n  input_per_m: 1000\n  output_per_m: 1000\n", "utf8");

		await assert.rejects(
			runBroadsideSubmit(dir, "sk-fake", { fetcher, lenses: ["defect"] }),
			/^Error: Estimated Broad-Side cost ~\$[\d.]+ exceeds the run limit \$1\.00\. Nothing was submitted\./,
		);
		assert.equal(counts.posts, 0);
		assert.deepEqual((await loadBroadsideState(broadsideDirFor(dir))).runs, []);

		const forced = await runBroadsideSubmit(dir, "sk-fake", { fetcher, lenses: ["defect"], force: true });
		assert.equal(forced.maxCost, 1);
		const unlimited = await runBroadsideSubmit(dir, "sk-fake", { fetcher, lenses: ["defect"], maxCost: 0 });
		assert.equal(unlimited.maxCost, undefined, "0 is no limit");
		assert.ok(counts.posts >= 2);
	});
});

// ---------- #232 ----------

test("a config.yaml that cannot be parsed refuses submit, collect, and models on both surfaces; status warns", async () => {
	await withRepo(async (dir) => {
		const broadsideDir = broadsideDirFor(dir);
		await mkdir(broadsideDir, { recursive: true });
		await writeFile(join(broadsideDir, "config.yaml"), "max_cost: 0.10\n  lens_models: bad-indent\n", "utf8");
		await assert.rejects(loadBroadsideConfig(broadsideDir), (error) => {
			assert.ok(error instanceof BroadsideConfigError);
			assert.match(error.message, /^Broad-Side config .*config\.yaml could not be parsed \(YAML line 2: .*\)\. Fix or remove the file; nothing runs on defaults while it is unreadable\.$/);
			return true;
		});
		await assert.rejects(runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: runningFetcher().fetcher }), (error) => error instanceof BroadsideConfigError);

		for (const action of ["submit", "collect", "models"]) {
			await assert.rejects(server.handleBroadside({ cwd: dir, action, api_key: "sk-fake" }), (error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidRequest);
				assert.match(error.message, /Broad-Side config .*could not be parsed/);
				return true;
			}, action);
		}
		const status = await server.handleBroadside({ cwd: dir, action: "status" });
		assert.match(status.content[0].text, /^No Broad-Side runs recorded/);
		assert.match(status.content[0].text, /^Warning: Broad-Side config .*could not be parsed/m);
		assert.match(status.structuredContent.configWarning, /could not be parsed/);

		const { commands, ctx, ui } = createHarness(dir);
		await commands.get("codecarto-broadside").handler("submit", ctx);
		assert.equal(ui.notifications.at(-1).level, "error");
		assert.match(ui.notifications.at(-1).message, /^Broad-Side submit refused: Broad-Side config .*could not be parsed/);
		await commands.get("codecarto-broadside").handler("status", ctx);
		assert.equal(ui.notifications.at(-1).level, "warning");
		assert.match(ui.widgets.at(-1).value.join("\n"), /Warning: Broad-Side config .*could not be parsed/);

		// A file that is not a mapping is refused the same way; an empty file is defaults.
		await writeFile(join(broadsideDir, "config.yaml"), "- a\n- b\n", "utf8");
		await assert.rejects(loadBroadsideConfig(broadsideDir), /is not a YAML mapping/);
		await writeFile(join(broadsideDir, "config.yaml"), "", "utf8");
		assert.equal((await loadBroadsideConfig(broadsideDir)).maxCost, 1);
	});
});

// ---------- #233 ----------

test("a corrupt state.json refuses submit and collect, is preserved, and is never written over", async () => {
	await withRepo(async (dir) => {
		const broadsideDir = broadsideDirFor(dir);
		const { fetcher } = runningFetcher();
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const statePath = join(broadsideDir, "state.json");
		const paid = await readFile(statePath, "utf8");
		assert.match(paid, /"batchId": "batch-1"/, "the paid run's batch id is on disk");
		// A crash mid-edit, a stray byte, a merge conflict marker — anything.
		const corrupt = `<<<<<<< HEAD\n${paid}`;
		await writeFile(statePath, corrupt, "utf8");

		const refused = (error) => {
			assert.ok(error instanceof BroadsideStateError || error instanceof McpError, String(error));
			assert.match(error.message, /Broad-Side state .*state\.json could not be parsed .*A copy is preserved at .*state\.json\.corrupt-[0-9a-f]{8}; the file is not overwritten\. Repair state\.json from the copy/);
			return true;
		};
		await assert.rejects(runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 }), refused);
		await assert.rejects(runBroadsideCollect(dir, "sk-fake", { waitMs: 0, fetcher }), refused);
		await assert.rejects(persistBroadsideRun(broadsideDir, { id: "new", createdAt: "", model: "m", lenses: [], status: "in-flight", outputDir: "new", batches: {}, synthesis: { status: "pending" }, triage: { status: "pending" } }), refused);
		await assert.rejects(server.handleBroadside({ cwd: dir, action: "status" }), refused);
		await assert.rejects(server.handleBroadside({ cwd: dir, action: "collect", api_key: "sk-fake", wait_seconds: 0 }), refused);

		assert.equal(await readFile(statePath, "utf8"), corrupt, "nothing wrote over the corrupt file");
		const copies = (await readdir(broadsideDir)).filter((name) => name.startsWith("state.json.corrupt-"));
		assert.equal(copies.length, 1, "one preserved copy, however many operations tripped on it");
		assert.equal(await readFile(join(broadsideDir, copies[0]), "utf8"), corrupt);

		// Repairing the file (here: restoring the paid content) brings collect back.
		await writeFile(statePath, paid, "utf8");
		const result = await runBroadsideCollect(dir, "sk-fake", { waitMs: 0, fetcher, includeSynthesis: false, includeTriage: false });
		assert.equal(result.runId, JSON.parse(paid).runs[0].id);

		// saveBroadsideState is the deliberate "make the file exactly this" call
		// and still writes — it is what a repair script would use.
		await writeFile(statePath, corrupt, "utf8");
		await saveBroadsideState(broadsideDir, { schema_version: 1, runs: [] });
		assert.deepEqual((await loadBroadsideState(broadsideDir)).runs, []);
	});
});
