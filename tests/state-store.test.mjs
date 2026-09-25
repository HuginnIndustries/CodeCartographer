// The state-store primitive: atomic writes with unique temp names, a lock
// whose release removes only its own file, and the two callers whose races
// the self-audit reproduced (usage appends, library publishes). #226 #227
// #238 #240.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { acquireLock, atomicWriteFile, retryOnTransientFsError, uniqueTempSuffix, STALE_LOCK_MS } = core;
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

// ---------- the rename retries while a holder blocks it (#393) ----------

// atomicWriteFile's rename is wrapped in this retry because on Windows a
// concurrent writer of the same file makes it fail with EPERM instead of
// serializing. A POSIX rename cannot be made to fail that way from a test, so
// the loop is exercised directly here and the wiring is proven end to end by
// the forty-writer test above running on the windows-latest job.

/** An fs failure shaped the way Node reports one: a message plus a `code`. */
function fsError(code) {
	return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
	test(`retryOnTransientFsError retries a ${code} and returns the attempt that lands`, async () => {
		let attempts = 0;
		const result = await retryOnTransientFsError(async () => {
			attempts += 1;
			if (attempts < 3) throw fsError(code);
			return "renamed";
		});
		assert.equal(result, "renamed");
		assert.equal(attempts, 3, `${code} should have been retried until the rename landed`);
	});
}

test("retryOnTransientFsError propagates the last transient error once the budget is spent", async () => {
	let attempts = 0;
	const started = Date.now();
	await assert.rejects(
		retryOnTransientFsError(async () => {
			attempts += 1;
			throw fsError("EPERM");
		}, 250),
		/EPERM/,
	);
	assert.ok(attempts > 1, `a holder that never lets go should still have been retried, got ${attempts} attempt(s)`);
	assert.ok(Date.now() - started < 5000, "the budget must bound the wait rather than retrying forever");
});

test("retryOnTransientFsError propagates a permanent error on the first attempt", async () => {
	for (const code of ["ENOENT", "ENOSPC", "EISDIR", "EXDEV"]) {
		let attempts = 0;
		await assert.rejects(
			retryOnTransientFsError(async () => {
				attempts += 1;
				throw fsError(code);
			}),
			new RegExp(code),
		);
		assert.equal(attempts, 1, `${code} is permanent and must not cost the budget`);
	}
});

test("retryOnTransientFsError propagates something thrown that is not an Error", async () => {
	let attempts = 0;
	await assert.rejects(
		retryOnTransientFsError(async () => {
			attempts += 1;
			throw "not an Error";
		}),
		(thrown) => thrown === "not an Error",
	);
	assert.equal(attempts, 1);
});

// ---------- the lock is a queue of owned tickets (#227, #342, #355) ----------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (promise) => Promise.race([promise.then(() => true, () => true), wait(0).then(() => false)]);
const tickets = async (dir, base = "status.yaml.lock") => (await readdir(dir)).filter((n) => n.startsWith(`${base}.t.`)).sort();

/** A ticket left by a process that no longer exists (pid 2^22-1 is never live on Linux). */
async function deadTicket(dir, base = "status.yaml.lock", { ageMs = 0 } = {}) {
	const path = join(dir, `${base}.t.000000000000001-4194303-dead`);
	await writeFile(path, "4194303\n2026-01-01T00:00:00.000Z\ndead\n", "utf8");
	if (ageMs) {
		const old = new Date(Date.now() - ageMs);
		await utimes(path, old, old);
	}
	return path;
}

test("a live holder is never broken by age: its heartbeat keeps the ticket fresh while it holds (#355)", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-live-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		// A holder well past the stale threshold — a publish across a full reindex.
		const a = await acquireLock(lockPath, { staleMs: 300 });
		await wait(700);
		const b = acquireLock(lockPath, { staleMs: 300, timeoutMs: 400 });
		await wait(250);
		assert.equal(await settled(b), false, "B waits behind a live holder older than staleMs");
		await assert.rejects(b, /Timed out waiting for lock/, "and gives up at its timeout instead of breaking A");
		assert.equal((await tickets(dir)).length, 1, "A's ticket stands; B withdrew its own");
		await a.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("a dead owner's ticket is removed at once, an unrefreshed one after staleMs, and the breaker records whose it was", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-dead-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		await deadTicket(dir);
		const a = await acquireLock(lockPath);
		assert.equal(a.brokeStale?.pid, 4194303, "the dead process's ticket was removed and recorded");
		assert.equal(a.brokeStale?.since, "2026-01-01T00:00:00.000Z");
		await a.release();

		// Alive pid, but the ticket stopped being refreshed: hung, so broken after staleMs.
		const hung = join(dir, `status.yaml.lock.t.000000000000002-${process.pid}-hung`);
		await writeFile(hung, `${process.pid}\n2026-01-01T00:00:00.000Z\nhung\n`, "utf8");
		const old = new Date(Date.now() - 1_000);
		await utimes(hung, old, old);
		const b = await acquireLock(lockPath, { staleMs: 500 });
		assert.equal(b.brokeStale?.pid, process.pid);
		await b.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("a new waiter takes a number larger than every ticket it can see, so a same-moment arrival never sorts ahead of a holder", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-number-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		// A live holder with ticket number 5 and a token that sorts after anything random.
		const holder = join(dir, `status.yaml.lock.t.000000000000005-${process.pid}-zzzz`);
		await writeFile(holder, `${process.pid}\n${new Date().toISOString()}\nzzzz\n`, "utf8");
		const b = acquireLock(lockPath, { timeoutMs: 400 });
		await wait(100);
		const [mine] = (await tickets(dir)).filter((n) => !n.endsWith("-zzzz"));
		assert.match(mine, /^status\.yaml\.lock\.t\.000000000000006-/, "one more than the largest ticket on the floor, not the clock");
		await assert.rejects(b, /Timed out waiting for lock/, "and it waits behind the holder");
		await rm(holder);
		const c = await acquireLock(lockPath);
		await c.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("release removes only the releaser's own ticket, so a broken holder's late release harms no one (#227)", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-release-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		const a = await acquireLock(lockPath, { staleMs: 200 });
		// A stops refreshing (its heartbeat is what keeps it alive; simulate a
		// hang by ageing the ticket) and B breaks it.
		const [aTicket] = await tickets(dir);
		const old = new Date(Date.now() - 1_000);
		await utimes(join(dir, aTicket), old, old);
		const b = await acquireLock(lockPath, { staleMs: 200 });
		assert.equal(b.brokeStale?.pid, process.pid);
		const [bTicket] = await tickets(dir);
		await a.release();
		assert.deepEqual(await tickets(dir), [bTicket], "A's release must not remove B's ticket");
		await b.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("many waiters, one dead ticket ahead of them: one holder at a time, every waiter served, nothing left behind", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-many-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		await deadTicket(dir);
		let holders = 0;
		let overlap = 0;
		let served = 0;
		const handles = await Promise.all(
			Array.from({ length: 8 }, async () => {
				const handle = await acquireLock(lockPath);
				holders += 1;
				if (holders > 1) overlap += 1;
				await wait(15);
				holders -= 1;
				served += 1;
				await handle.release();
				return handle;
			}),
		);
		assert.equal(overlap, 0, "two holders at once");
		assert.equal(served, 8);
		assert.equal(handles.filter((h) => h.brokeStale).length, 1, "exactly one waiter removed the dead ticket");
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("Windows unlink errors after a stale-ticket claim cannot give two waiters the break", async () => {
	for (const code of ["EPERM", "EBUSY"]) {
		const { dir, cleanup } = await tempDir("cc-lock-windows-");
		try {
			const lockPath = join(dir, "status.yaml.lock");
			const dead = await deadTicket(dir);
			const claimedPaths = [];
			let errors = 0;
			const fsOps = {
				stat,
				rename: async (from, to) => {
					await rename(from, to);
					if (from.includes(".t.")) claimedPaths.push(from);
				},
				unlink: async (path) => {
					if (path.includes(".reaped.")) {
						const error = new Error("Windows unlink race");
						error.code = code;
						errors += 1;
						throw error;
					}
					await unlink(path);
				},
			};
			const handles = await Promise.all(Array.from({ length: 2 }, async () => {
				const handle = await acquireLock(lockPath, { fsOps });
				await handle.release();
				return handle;
			}));
			assert.deepEqual(claimedPaths, [dead], "only the planted dead ticket was claimed");
			assert.equal(handles.filter((handle) => handle.brokeStale).length, 1);
			assert.equal(errors, 1, `the winning claim encountered ${code} on cleanup`);
			const [tombstone] = (await readdir(dir)).filter((name) => name.includes(".reaped."));
			assert.ok(tombstone, "failed cleanup left a tombstone");
			const old = new Date(Date.now() - 1_000);
			await utimes(join(dir, tombstone), old, old);
			const next = await acquireLock(lockPath, { fsOps, staleMs: 100 });
			await next.release();
			assert.deepEqual(await readdir(dir), [], "the next waiter swept the old tombstone");
		} finally {
			await cleanup();
		}
	}
});

test("Windows claim contention retries while the stale ticket still exists", async () => {
	for (const code of ["EPERM", "EBUSY", "EACCES"]) {
		const { dir, cleanup } = await tempDir("cc-lock-claim-busy-");
		try {
			const lockPath = join(dir, "status.yaml.lock");
			const dead = await deadTicket(dir);
			let attempts = 0;
			const fsOps = {
				stat,
				rename: async (from, to) => {
					if (from === dead && attempts++ === 0) {
						const error = new Error("ticket held open by another waiter");
						error.code = code;
						throw error;
					}
					await rename(from, to);
				},
				unlink,
			};
			const handle = await acquireLock(lockPath, { fsOps, timeoutMs: 1_000 });
			assert.equal(attempts, 2, `${code} retried the claim`);
			assert.equal(handle.brokeStale?.pid, 4194303);
			await handle.release();
			assert.deepEqual(await readdir(dir), [], "no ticket remains after release");
		} finally {
			await cleanup();
		}
	}
});

test("only one waiter reports a break when Windows exposes the source after rename succeeds", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-claim-visible-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		const dead = await deadTicket(dir);
		let renameCalls = 0;
		const fsOps = {
			stat,
			rename: async (from, to) => {
				if (from === dead) {
					renameCalls += 1;
					return; // Model Windows reporting success while the source is still visible.
				}
				await rename(from, to);
			},
			unlink,
		};
		const first = await acquireLock(lockPath, { fsOps, timeoutMs: 1_000 });
		assert.equal(first.brokeStale?.pid, 4194303);
		await first.release();
		const secondPromise = acquireLock(lockPath, { fsOps, timeoutMs: 1_000 });
		await wait(100);
		assert.equal(await settled(secondPromise), false, "the claim marker blocks a second break");
		await unlink(dead);
		const second = await secondPromise;
		assert.equal(second.brokeStale, undefined);
		assert.equal(renameCalls, 1);
		await second.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("Windows claim errors after another waiter removed the ticket do not report a break", async () => {
	for (const code of ["EPERM", "EBUSY", "EACCES"]) {
		const { dir, cleanup } = await tempDir("cc-lock-claim-gone-");
		try {
			const lockPath = join(dir, "status.yaml.lock");
			const dead = await deadTicket(dir);
			let attempts = 0;
			const fsOps = {
				stat,
				rename: async (from, to) => {
					if (from === dead) {
						attempts += 1;
						await unlink(from);
						const error = new Error("losing Windows claim");
						error.code = code;
						throw error;
					}
					await rename(from, to);
				},
				unlink,
			};
			const handle = await acquireLock(lockPath, { fsOps });
			assert.equal(attempts, 1);
			assert.equal(handle.brokeStale, undefined, `${code} was a lost race`);
			await handle.release();
			assert.deepEqual(await readdir(dir), []);
		} finally {
			await cleanup();
		}
	}
});

test("a claim error removes this waiter's ticket before rejecting", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-claim-error-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		const dead = await deadTicket(dir);
		const fsOps = {
			stat,
			rename: async () => {
				const error = new Error("claim failed");
				error.code = "EIO";
				throw error;
			},
			unlink,
		};
		await assert.rejects(acquireLock(lockPath, { fsOps }), /claim failed/);
		assert.deepEqual(await readdir(dir), [basename(dead)], "the failed waiter's ticket was removed");
		const handle = await acquireLock(lockPath);
		await handle.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("a non-ENOENT ticket stat error is not evidence that its owner is gone", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-stat-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		const dead = await deadTicket(dir);
		const fsOps = {
			stat: async (path) => {
				if (path === dead) {
					const error = new Error("Windows stat denied");
					error.code = "EPERM";
					throw error;
				}
				return stat(path);
			},
			rename,
			unlink,
		};
		await assert.rejects(acquireLock(lockPath, { fsOps, timeoutMs: 150 }), /Timed out waiting for lock/);
		assert.equal(existsSync(dead), true, "an unreadable ticket is not reaped");
	} finally {
		await cleanup();
	}
});

test("a waiter that died in the doorway does not block the queue; a live one does until it has its ticket", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-door-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		await writeFile(join(dir, "status.yaml.lock.c.deadchooser"), "4194303\n2026-01-01T00:00:00.000Z\ndeadchooser\n", "utf8");
		const a = await acquireLock(lockPath);
		assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".c.")), [], "the dead chooser's marker is gone");
		await a.release();

		// A live chooser (our own pid) holds everyone at the door until its marker is withdrawn.
		const marker = join(dir, "status.yaml.lock.c.livechooser");
		await writeFile(marker, `${process.pid}\n${new Date().toISOString()}\nlivechooser\n`, "utf8");
		const b = acquireLock(lockPath);
		await wait(300);
		assert.equal(await settled(b), false, "B waits while a live waiter is choosing");
		await rm(marker);
		const handle = await b;
		await handle.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("a plain lock file from a pre-#355 process is honoured while fresh and removed once stale", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-legacy-");
	try {
		const lockPath = join(dir, "status.yaml.lock");
		await writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}\nlegacy\n`, "utf8");
		const fresh = acquireLock(lockPath, { timeoutMs: 400 });
		await assert.rejects(fresh, /Timed out waiting for lock/, "a fresh legacy lock blocks");
		const old = new Date(Date.now() - STALE_LOCK_MS - 5_000);
		await utimes(lockPath, old, old);
		const a = await acquireLock(lockPath);
		assert.equal(a.brokeStale?.pid, process.pid, "a stale legacy lock is removed and recorded");
		assert.equal(existsSync(lockPath), false);
		await a.release();
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await cleanup();
	}
});

test("release is a no-op when the holder's ticket is already gone", async () => {
	const { dir, cleanup } = await tempDir("cc-lock-gone-");
	try {
		const lockPath = join(dir, "x.lock");
		const handle = await acquireLock(lockPath);
		const [ticket] = await tickets(dir, "x.lock");
		await rm(join(dir, ticket));
		await handle.release();
		const again = await acquireLock(lockPath);
		await again.release();
		assert.deepEqual(await readdir(dir), []);
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
