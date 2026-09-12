// The state-store primitive: atomic writes with unique temp names, a lock
// whose release removes only its own file, and the two callers whose races
// the self-audit reproduced (usage appends, library publishes). #226 #227
// #238 #240.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { acquireLock, atomicWriteFile, uniqueTempSuffix, STALE_LOCK_MS } = core;
const { appendUsageRun, loadUsage, USAGE_RELATIVE_PATH } = await import(pathToFileURL(`${REPO_ROOT}/core/usage.ts`).href);
const { publishEntry, writeMarker } = core;

async function tempDir(prefix) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("uniqueTempSuffix never repeats within a process", () => {
	const seen = new Set();
	for (let i = 0; i < 5000; i++) seen.add(uniqueTempSuffix());
	assert.equal(seen.size, 5000);
});

test("concurrent atomicWriteFile calls all succeed, leave one intact file, and no temp files", async () => {
	const { dir, cleanup } = await tempDir("cc-atomic-");
	try {
		const target = join(dir, "state.yaml");
		const payloads = Array.from({ length: 40 }, (_, i) => `writer: ${i}\n`);
		const results = await Promise.allSettled(payloads.map((p) => atomicWriteFile(target, p)));
		const rejected = results.filter((r) => r.status === "rejected");
		assert.deepEqual(rejected, [], `writers failed: ${rejected.map((r) => r.reason?.message).join("; ")}`);
		const final = await readFile(target, "utf8");
		assert.ok(payloads.includes(final), `final content is not one writer's payload: ${JSON.stringify(final)}`);
		assert.deepEqual(await readdir(dir), ["state.yaml"], "no temp files left beside the target");
	} finally {
		await cleanup();
	}
});

test("atomicWriteFile removes its temp file and propagates the error when the rename cannot land", async () => {
	const { dir, cleanup } = await tempDir("cc-atomic-fail-");
	try {
		// A target inside a directory that does not exist: the temp write fails.
		await assert.rejects(atomicWriteFile(join(dir, "missing", "file.txt"), "x"), /ENOENT/);
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("release after a stale break leaves the new holder's lock in place", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		const a = await acquireLock(lockPath);
		assert.equal(a.brokeStale, undefined);
		// Age A's lock past the stale threshold, as a crashed process would.
		const old = new Date(Date.now() - STALE_LOCK_MS - 5_000);
		await utimes(lockPath, old, old);
		const b = await acquireLock(lockPath);
		assert.equal(b.brokeStale?.pid, process.pid, "B records whose lock it broke");
		const bContent = await readFile(lockPath, "utf8");

		await a.release();
		assert.equal(await readFile(lockPath, "utf8"), bContent, "A's release must not remove B's lock");

		await b.release();
		assert.deepEqual(await readdir(dir), [], "B's release removes B's lock");
	} finally {
		await cleanup();
	}
});

test("release is a no-op when the lock file is already gone", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-gone-");
	try {
		const lockPath = join(dir, "x.lock");
		const handle = await acquireLock(lockPath);
		await rm(lockPath);
		await handle.release();
		const again = await acquireLock(lockPath);
		await again.release();
	} finally {
		await cleanup();
	}
});

test("concurrent appendUsageRun calls each keep their record", async () => {
	const { dir, cleanup } = await tempDir("cc-usage-race-");
	try {
		const workspaceDir = join(dir, ".codecarto");
		await mkdir(join(workspaceDir, "workflow"), { recursive: true });
		const run = (i) => ({
			timestamp: `2026-09-11T00:00:${String(i).padStart(2, "0")}.000Z`,
			phase: `phase-${i}`,
			status: "completed",
			turn_count: 1,
			tool_uses: 1,
			duration_ms: 1,
			tokens: { input: i, output: 0, cache_write: 0 },
			recorded_by: "mcp-complete",
		});
		const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => appendUsageRun(workspaceDir, run(i))));
		const rejected = results.filter((r) => r.status === "rejected");
		assert.deepEqual(rejected, [], `appends failed: ${rejected.map((r) => r.reason?.message).join("; ")}`);
		const usage = await loadUsage(workspaceDir);
		assert.equal(usage.runs.length, 12);
		assert.deepEqual(new Set(usage.runs.map((r) => r.phase)).size, 12);
		const files = await readdir(join(workspaceDir, "workflow"));
		assert.deepEqual(files, [USAGE_RELATIVE_PATH.split("/").pop()], "no lock or temp files remain");
	} finally {
		await cleanup();
	}
});

test("appendUsageRun refuses to overwrite a usage log that does not parse", async () => {
	const { dir, cleanup } = await tempDir("cc-usage-corrupt-");
	try {
		const workspaceDir = join(dir, ".codecarto");
		await mkdir(join(workspaceDir, "workflow"), { recursive: true });
		const path = join(workspaceDir, USAGE_RELATIVE_PATH);
		const corrupt = "version: 1\nruns: []\nversion: 2\n"; // duplicate key: the one construct the parser refuses
		await writeFile(path, corrupt, "utf8");
		await assert.rejects(
			appendUsageRun(workspaceDir, { timestamp: "2026-09-11T00:00:00.000Z", phase: "x", status: "completed", turn_count: 0, tool_uses: 0, duration_ms: 0, tokens: { input: 0, output: 0, cache_write: 0 } }),
			/does not parse/,
		);
		assert.equal(await readFile(path, "utf8"), corrupt, "the corrupt file is left exactly as it was");
	} finally {
		await cleanup();
	}
});

test("two concurrent publishes of different specs to one slug land as v1 and v2", async () => {
	const { dir, cleanup } = await tempDir("cc-publish-race-");
	try {
		await writeMarker(dir, { schema_version: 1, name: "race", namespaced: false });
		const input = (n) => ({
			slug: "widget",
			source_repo: "https://example.test/widget",
			analyzed_at: "2026-09-11T00:00:00Z",
			pipeline: "workflow/pipeline.yaml",
			codecarto_version: "0.19.5",
			headline: `Spec ${n}`,
			tags: [],
			capabilities: [],
			generation: { surface: "mcp-server", agent: "test", agent_version: "0", model: "m", model_vendor: "v", reasoning: "low", notes: "" },
		});
		const results = await Promise.allSettled([
			publishEntry(dir, "# spec one\n", input(1)),
			publishEntry(dir, "# spec two\n", input(2)),
		]);
		const rejected = results.filter((r) => r.status === "rejected");
		assert.deepEqual(rejected, [], `publishes failed: ${rejected.map((r) => r.reason?.message).join("; ")}`);
		const versions = results.map((r) => r.value.version).sort();
		assert.deepEqual(versions, [1, 2]);
		const entryDir = join(dir, "entries", "widget");
		assert.deepEqual((await readdir(entryDir)).sort(), ["latest", "v1", "v2"]);
		assert.equal((await readFile(join(entryDir, "latest"), "utf8")).trim(), "v2");
		assert.ok(!(await readdir(join(dir, "entries"))).some((n) => n.includes(".publish.")), "no staging dirs remain");
		assert.ok(!(await readdir(dir)).some((n) => n.endsWith(".lock")), "the publish lock is released");
	} finally {
		await cleanup();
	}
});
