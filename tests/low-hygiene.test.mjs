// The low-severity fixes from the self-audit's L2/L3/L5 groups (#263, #264,
// #266), each pinned where it changed behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { phaseIdFromSessionName } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/phase-compaction.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

function response(status, body) {
	return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

// ---------- #263 L2: user-fixable workspace errors are InvalidRequest (mech 2.8) ----------

test("a status.yaml the workspace loader cannot use is InvalidRequest, not InternalError", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-low-"));
	try {
		await server.handleInit({ cwd, pipeline: "lite" });
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		await writeFile(statusPath, "pipeline: workflow/no-such-pipeline.yaml\nschema_version: 1\n", "utf8");
		await assert.rejects(server.handleStatus({ cwd }), (error) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, ErrorCode.InvalidRequest, "a config problem is the caller's to fix, not a server bug");
			return true;
		});
		await writeFile(statusPath, "pipeline: workflow/pipeline-lite.yaml\n  bad: indent\n", "utf8");
		await assert.rejects(server.handleNext({ cwd }), (error) => error instanceof McpError && error.code === ErrorCode.InvalidRequest && /YAML line 2/.test(error.message));
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

// ---------- #264 L3: the phase-id alphabet is one alphabet (mech 6.11) ----------

test("the child session's phase-id match admits every id assertSafePhaseId admits", () => {
	for (const id of ["architecture", "defect-scan-mechanical", "Phase.One_x", "v2", "MODULE_A"]) {
		assert.doesNotThrow(() => core.assertSafePhaseId(id), id);
		assert.equal(phaseIdFromSessionName(`CodeCartographer phase: ${id}`), id, id);
	}
	for (const id of ["../x", "a b", "-lead", ".hidden", ""]) {
		assert.equal(phaseIdFromSessionName(`CodeCartographer phase: ${id}`), null, id);
	}
	assert.equal(phaseIdFromSessionName("something else"), null);
	assert.equal(phaseIdFromSessionName(undefined), null);
});

test("git subprocesses carry a timeout, like every fetch", () => {
	assert.equal(core.GIT_TIMEOUT_MS, 30_000);
});

// ---------- #266 L5: catalog cache per-entry TTL and schema check (mech 1.9, sem 5.10) ----------

const CONFIG = { model: core.BROADSIDE_MODEL, apiKey: "", defaultLenses: ["architecture"], maxCost: 0, pricing: null, lensModels: {}, reasoning: null };
const catalog = (...ids) => response(200, { data: ids.map((id) => ({ id, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["structured_outputs"] })) });

test("a freshly fetched model does not renew every other cached model's TTL", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-cache-"));
	try {
		let fetches = 0;
		const fetcher = async () => { fetches++; return catalog("a/one:batch", "b/two:batch"); };
		await core.resolveCatalogEntry(dir, CONFIG, "a/one:batch", "sk", fetcher);
		assert.equal(fetches, 1);
		// Age the first entry past the TTL by hand, then fetch a second model.
		const cachePath = join(dir, core.BROADSIDE_CATALOG_CACHE_FILE);
		const cache = JSON.parse(await readFile(cachePath, "utf8"));
		assert.equal(cache.schema_version, core.BROADSIDE_CATALOG_CACHE_SCHEMA);
		const old = new Date(Date.now() - 2 * core.BROADSIDE_CATALOG_CACHE_TTL_MS).toISOString();
		cache.models["a/one:batch"].fetched_at = old;
		cache.fetched_at = old;
		await writeFile(cachePath, JSON.stringify(cache), "utf8");

		await core.resolveCatalogEntry(dir, CONFIG, "b/two:batch", "sk", fetcher);
		assert.equal(fetches, 2);
		const after = JSON.parse(await readFile(cachePath, "utf8"));
		assert.equal(after.models["a/one:batch"].fetched_at, old, "the stale entry kept its own stamp");
		assert.notEqual(after.models["b/two:batch"].fetched_at, old);
		// So the stale one is fetched again rather than served from the cache.
		const one = await core.resolveCatalogEntry(dir, CONFIG, "a/one:batch", "sk", fetcher);
		assert.equal(one.source, "live");
		assert.equal(fetches, 3);
		const two = await core.resolveCatalogEntry(dir, CONFIG, "b/two:batch", "sk", fetcher);
		assert.equal(two.source, "cache");
		assert.equal(fetches, 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a schema-2 cache is read with the file's stamp, and an unknown schema is ignored", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-cache-"));
	try {
		const cachePath = join(dir, core.BROADSIDE_CATALOG_CACHE_FILE);
		const entry = { id: "a/one:batch", name: "one", inputPerM: 1, outputPerM: 2, supportedParameters: ["structured_outputs"] };
		let fetches = 0;
		const fetcher = async () => { fetches++; return catalog("a/one:batch"); };

		await writeFile(cachePath, JSON.stringify({ schema_version: 2, fetched_at: new Date().toISOString(), models: { "a/one:batch": entry } }), "utf8");
		assert.equal((await core.resolveCatalogEntry(dir, CONFIG, "a/one:batch", "sk", fetcher)).source, "cache");
		assert.equal(fetches, 0);

		await writeFile(cachePath, JSON.stringify({ schema_version: 99, fetched_at: new Date().toISOString(), models: { "a/one:batch": entry } }), "utf8");
		assert.equal((await core.resolveCatalogEntry(dir, CONFIG, "a/one:batch", "sk", fetcher)).source, "live", "a schema this build does not know is not trusted");
		assert.equal(fetches, 1);
		assert.equal(JSON.parse(await readFile(cachePath, "utf8")).schema_version, core.BROADSIDE_CATALOG_CACHE_SCHEMA, "and is rewritten in the current schema");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the terminal entry statuses are one constant built from the dead set", () => {
	assert.deepEqual(core.BROADSIDE_TERMINAL_ENTRY_STATUSES, ["completed", "failed", "expired", "cancelled", "auth-failed", "skipped", "rejected"]);
	for (const dead of core.BROADSIDE_DEAD_BATCH_STATUSES) assert.ok(core.BROADSIDE_TERMINAL_ENTRY_STATUSES.includes(dead), dead);
	assert.ok(!core.BROADSIDE_TERMINAL_ENTRY_STATUSES.includes("timeout"), "a timeout is still polled again");
});
