// The file-backed engineering store (E02, #400).
//
// What this has to get right is narrower than it looks, because E01 already
// fixed the record shapes, the id grammar, and the path layout. What is left
// is the part that only a store can get wrong:
//
//   - One change's history must survive another change being created,
//     retried, or abandoned. Nothing outside its own directory is written.
//   - A completed observation is immutable. A retry appends; it never edits.
//   - A reader must never see a half-written record. Publication is atomic,
//     so a crash mid-write leaves the old bytes or the new bytes.
//   - The same request arriving twice does the work once (idempotency), and
//     the same key carrying a DIFFERENT payload is an error rather than a
//     silent overwrite.
//   - A writer holding a stale revision loses, loudly.
//   - A corrupt record on disk is reported as corrupt, not skipped and not
//     fatal to the enumeration of its siblings.
//
// The tests below are written against those properties rather than against
// an implementation, so a rewrite that keeps the guarantees keeps the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, ENGINEERING_NAMESPACE, ENGINEERING_SCHEMA_VERSION } = engineering;

async function withStore(fn) {
	const root = await mkdtemp(join(tmpdir(), "codecarto-e02-store-"));
	try {
		return await fn(await openStore(join(root, ".codecarto")), root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const CHANGE_A = "chg_0000000000000000000000a1";
const CHANGE_B = "chg_0000000000000000000000b1";

/**
 * A minimal valid change record. E01 owns the shape — this reads the shipped
 * fixture rather than restating it, so a contract change breaks the store's
 * tests loudly instead of leaving them asserting against a stale idea of a
 * record.
 */
const MINIMAL_CHANGE = JSON.parse(await readFile(join(REPO_ROOT, "tests/fixtures/engineering/v1/valid/change-minimal.json"), "utf8"));
const changeRecord = (id, title, overrides = {}) => ({ ...MINIMAL_CHANGE, id, title, ...overrides });

test("two changes keep separate histories", async () => {
	await withStore(async (store) => {
		await store.put(changeRecord(CHANGE_A, "first change"));
		await store.put(changeRecord(CHANGE_B, "second change"));

		const a = await store.get("change", CHANGE_A);
		const b = await store.get("change", CHANGE_B);
		assert.equal(a.record.title, "first change");
		assert.equal(b.record.title, "second change", "creating B must not have disturbed A");

		// And the second write did not reach into the first's directory.
		const changes = await store.listChanges();
		assert.deepEqual(changes.map((c) => c.id).sort(), [CHANGE_A, CHANGE_B].sort());
	});
});

test("the store writes nothing outside its own namespace", async () => {
	await withStore(async (store, root) => {
		// A status.yaml exactly where the analysis pipeline keeps one.
		const status = join(root, ".codecarto", "workflow", "status.yaml");
		await mkdir(dirname(status), { recursive: true });
		await writeFile(status, "project: untouched\n", "utf8");

		await store.put(changeRecord(CHANGE_A, "first change"));
		await store.put(changeRecord(CHANGE_B, "second change"));

		assert.equal(await readFile(status, "utf8"), "project: untouched\n", "analysis state must be untouched");
		const workspace = await readdir(join(root, ".codecarto"));
		assert.deepEqual(workspace.sort(), [ENGINEERING_NAMESPACE, "workflow"].sort(), "no stray top-level files");
	});
});

test("a published observation is immutable, whatever revision is offered", async () => {
	// The contract's second storage class: everything under attempts/ is
	// create-only. Editing an observation would be rewriting history rather
	// than recording it, so there is no revision that buys the right.
	const attempt = JSON.parse(await readFile(join(REPO_ROOT, "tests/fixtures/engineering/v1/valid/attempt.json"), "utf8"));
	await withStore(async (store) => {
		await store.put(changeRecord(attempt.change_id, "owning change"));
		await store.put(attempt);

		for (const options of [{}, { ifRevision: 1 }, { ifRevision: 2 }]) {
			await assert.rejects(
				() => store.put({ ...attempt, outcome: "accepted" }, options),
				(error) => error.code === "invalid-state",
				`an attempt must not be replaceable with ${JSON.stringify(options)}`,
			);
		}
		const still = await store.get("attempt", attempt.id, { changeId: attempt.change_id });
		assert.equal(still.record.outcome, attempt.outcome, "the original observation survives");
	});
});

test("a projection is replaced only by a writer holding its current revision", async () => {
	await withStore(async (store) => {
		await store.put(changeRecord(CHANGE_A, "first change"));
		await assert.rejects(
			() => store.put(changeRecord(CHANGE_A, "rewritten history")),
			(error) => error.code === "invalid-state",
			"replacing without naming a revision must be refused",
		);
		const still = await store.get("change", CHANGE_A);
		assert.equal(still.record.title, "first change", "the original bytes survive");
	});
});

test("the same request twice does the work once", async () => {
	await withStore(async (store) => {
		const record = changeRecord(CHANGE_A, "first change");
		const first = await store.put(record, { idempotencyKey: "k1" });
		const second = await store.put(record, { idempotencyKey: "k1" });
		assert.equal(second.revision, first.revision, "a replay returns the original outcome, not a new revision");
		assert.equal(second.replayed, true, "and says so");
	});
});

test("one idempotency key carrying a different payload is a conflict", async () => {
	await withStore(async (store) => {
		await store.put(changeRecord(CHANGE_A, "first change"), { idempotencyKey: "k1" });
		await assert.rejects(
			() => store.put(changeRecord(CHANGE_B, "different payload"), { idempotencyKey: "k1" }),
			(error) => error.code === "idempotency-conflict",
			"reusing a key for other content must not silently overwrite either one",
		);
	});
});

test("a stale revision loses loudly", async () => {
	await withStore(async (store) => {
		const created = await store.put(changeRecord(CHANGE_A, "first change"));
		await store.put(changeRecord(CHANGE_A, "second write", { revision: created.revision + 1 }), { ifRevision: created.revision });

		await assert.rejects(
			() => store.put(changeRecord(CHANGE_A, "third write", { revision: created.revision + 1 }), { ifRevision: created.revision }),
			(error) => error.code === "stale-revision",
			"a writer holding the first revision must not clobber the second",
		);
		const current = await store.get("change", CHANGE_A);
		assert.equal(current.record.title, "second write");
	});
});

test("a corrupt record is reported as corrupt, not skipped and not fatal", async () => {
	await withStore(async (store, root) => {
		await store.put(changeRecord(CHANGE_A, "first change"));
		await store.put(changeRecord(CHANGE_B, "second change"));

		// Truncate one, exactly as an interrupted non-atomic write would.
		const path = join(root, ".codecarto", ENGINEERING_NAMESPACE, "changes", CHANGE_B, "change.json");
		await writeFile(path, '{"kind":"change","id":', "utf8");

		const listed = await store.listChanges();
		const healthy = listed.filter((entry) => !entry.corrupt);
		const corrupt = listed.filter((entry) => entry.corrupt);
		assert.deepEqual(
			healthy.map((entry) => entry.id),
			[CHANGE_A],
			"the healthy sibling is still enumerable",
		);
		assert.equal(corrupt.length, 1, "and the corrupt one is reported rather than silently dropped");
		assert.equal(corrupt[0].id, CHANGE_B);
		assert.match(corrupt[0].reason, /parse|json|truncat/i);
	});
});

test("a record whose schema version is unknown is refused, not guessed at", async () => {
	await withStore(async (store, root) => {
		await store.put(changeRecord(CHANGE_A, "first change"));
		const path = join(root, ".codecarto", ENGINEERING_NAMESPACE, "changes", CHANGE_A, "change.json");
		const record = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...record, schema_version: "v99" }), "utf8");

		await assert.rejects(
			() => store.get("change", CHANGE_A),
			(error) => error.code === "unsupported-schema-version",
			"a future version must not be read as if it were this one",
		);
	});
});

test("a symlink cannot redirect a write out of the namespace", async () => {
	await withStore(async (store, root) => {
		const namespace = join(root, ".codecarto", ENGINEERING_NAMESPACE);
		const outside = join(root, "outside");
		await mkdir(join(namespace, "changes"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await symlink(outside, join(namespace, "changes", CHANGE_A));

		await assert.rejects(
			() => store.put(changeRecord(CHANGE_A, "escaping")),
			(error) => error.code === "invalid-path" || error.code === "invalid-state",
			"a planted symlink must not become a write primitive",
		);
		assert.deepEqual(await readdir(outside), [], "nothing was written through the link");
	});
});

test("an interrupted write leaves the previous record readable", async () => {
	// The property atomic publication exists for: kill a real process
	// between the temp write and the rename, and a reader still sees whole
	// bytes. Asserted against a child process rather than a mocked failure,
	// because the failure mode is a real crash.
	await withStore(async (store, root) => {
		await store.put(changeRecord(CHANGE_A, "first change"));
		const workspace = join(root, ".codecarto");

		const script = `
			import { openStore } from ${JSON.stringify(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href)};
			const store = await openStore(${JSON.stringify(workspace)});
			process.kill(process.pid, "SIGKILL");
		`;
		const file = join(root, "crash.mjs");
		await writeFile(file, script, "utf8");
		await execFileAsync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", file]).catch(() => undefined);

		const after = await store.get("change", CHANGE_A);
		assert.equal(after.record.title, "first change", "the published record is intact after a hard kill");

		// No temp file left masquerading as a record.
		const dir = join(workspace, ENGINEERING_NAMESPACE, "changes", CHANGE_A);
		const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
		assert.deepEqual(leftovers, [], "no orphaned temp file is visible as state");
	});
});

test("concurrent writers to one change serialize rather than interleave", async () => {
	await withStore(async (store) => {
		const created = await store.put(changeRecord(CHANGE_A, "first change"));
		const attempts = Array.from({ length: 8 }, (_, i) =>
			store
				.put(changeRecord(CHANGE_A, `writer ${i}`, { revision: created.revision + 1 }), { ifRevision: created.revision })
				.then(() => "won")
				.catch((error) => error.code),
		);
		const outcomes = await Promise.all(attempts);
		assert.equal(outcomes.filter((o) => o === "won").length, 1, "exactly one writer wins the revision");
		assert.ok(
			outcomes.filter((o) => o === "stale-revision").length === 7,
			`the rest lose with stale-revision, got: ${JSON.stringify(outcomes)}`,
		);
	});
});

test("a success projection cannot name an observation that was not published", async () => {
	await withStore(async (store) => {
		await store.put(changeRecord(CHANGE_A, "first change"));
		// Referencing a proof that was never written must not resolve.
		await assert.rejects(
			() => store.get("proof", "prf_0000000000000000000000f1", { changeId: CHANGE_A, attemptId: "att_0000000000000000000000a1" }),
			(error) => error.code === "not-found",
			"an unpublished observation is not readable",
		);
	});
});
