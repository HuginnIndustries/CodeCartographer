// Host-observed proof ingestion (E05, #409): the inbox reader and the hook.
//
// Every test here uses a real temp store and real files, because the whole
// point of this path is what the filesystem allows: a symlink in the inbox,
// a directory named `x.json`, a pre-created target name for the hook.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The hook is POSIX-only by design: it refuses any namespace that is not an
// absolute POSIX path and needs O_NOFOLLOW, which Windows does not have, so on
// Windows it records nothing. Its tests are skipped there rather than bent to
// pass. The reader's O_NOFOLLOW guard is POSIX-only for the same reason; on
// Windows only its lstat check stands between an inbox symlink and a read.
const POSIX_ONLY = process.platform === "win32" && "POSIX-only: the hook refuses non-POSIX namespaces and O_NOFOLLOW does not exist on Windows";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, ingestHostObservations, validateHostObservation, validateHostActivity, readInboxFile, proofAuthority, MAX_OBSERVATION_BYTES, HOST_OBSERVATION_SCHEMA } = engineering;
const HOOK = join(REPO_ROOT, "hosts/claude-code/observe.mjs");

const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));
const CHANGE = await readFixture("change.json");
const SLICE = await readFixture("slice.json");
const ATTEMPT = await readFixture("attempt.json");
const SNAPSHOT = await readFixture("snapshot-candidate.json");

const TEST_CMD = "node --test tests/widgets-count.test.mjs";
const LINT_CMD = "npm run lint";

/** The fixture slice with commands on its obligations (O1: the test, O2: lint). */
function sliceWithCommands(overrides = {}) {
	return {
		...SLICE,
		proof_obligations: [
			{ ...SLICE.proof_obligations[0], command: TEST_CMD },
			{ ...SLICE.proof_obligations[1], command: LINT_CMD },
		],
		...overrides,
	};
}

// Every observation in these tests was "recorded" in the workspace the store
// was opened from: the reader refuses any other cwd. `withWorkspace` sets it.
let WORKSPACE = "/unset";

async function withWorkspace(fn, slice = sliceWithCommands()) {
	// realpath: the reader compares canonical paths (tmpdir may be a symlink).
	const root = await realpath(await mkdtemp(join(tmpdir(), "codecarto-e05-host-obs-")));
	WORKSPACE = root;
	try {
		const store = await openStore(join(root, ".codecarto"));
		await store.put(CHANGE);
		await store.put(slice);
		await store.put(ATTEMPT);
		await store.put(SNAPSHOT);
		const inbox = join(store.root, "inbox");
		await mkdir(inbox, { recursive: true });
		return await fn({ store, root, inbox });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const EMPTY = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const observation = (overrides = {}) => ({
	schema: HOST_OBSERVATION_SCHEMA,
	host: "claude-code",
	event: "PostToolUse",
	tool_name: "Bash",
	tool_use_id: "toolu_01abc",
	session_id: "sess-1",
	cwd: WORKSPACE,
	command: TEST_CMD,
	exit_code: 0,
	stdout: { digest: EMPTY, size: 0 },
	stderr: { digest: EMPTY, size: 0 },
	started_at: "2026-09-17T10:20:00Z",
	ended_at: "2026-09-17T10:21:30Z",
	...overrides,
});
const drop = (inbox, name, value) => writeFile(join(inbox, name), typeof value === "string" ? value : JSON.stringify(value));
const ingest = (store, capabilities, extra = {}) => ingestHostObservations(store, { changeId: CHANGE.id, attemptId: ATTEMPT.id, capabilities, ...extra });
const PROTECTED = { tool_result_path: "protected" };
const UNPROTECTED = { tool_result_path: "unprotected" };

// ------------------------------------------------------------- attestation

test("protected path: a matching observation becomes a host-tool-result proof that discharges", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation());
		const out = await ingest(store, PROTECTED);
		assert.equal(out.attested_by, "host-tool-result");
		assert.equal(out.skipped.length, 0);
		assert.equal(out.ingested.length, 1);
		const [one] = out.ingested;
		assert.equal(one.authority, "observed");
		assert.equal(one.discharges, true);
		assert.equal(one.obligation_id, "O1");
		const stored = (await store.get("proof", one.proof_id, { changeId: CHANGE.id, attemptId: ATTEMPT.id })).record;
		assert.equal(stored.provenance.attested_by, "host-tool-result");
		assert.equal(stored.provenance.tool_call_id, "toolu_01abc");
		assert.equal(stored.collector, "host-observed");
		assert.equal(proofAuthority(stored), "observed");
		// rotated out of the inbox, never deleted
		assert.deepEqual(await readdir(inbox), ["processed"]);
		assert.deepEqual(await readdir(join(inbox, "processed")), ["a.json"]);
	});
});

test("unprotected path: the same observation is attested caller, claimed, and does not discharge", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation());
		const out = await ingest(store, UNPROTECTED);
		assert.equal(out.attested_by, "caller");
		assert.equal(out.ingested.length, 1);
		assert.equal(out.ingested[0].authority, "claimed");
		assert.equal(out.ingested[0].discharges, false);
		const stored = (await store.get("proof", out.ingested[0].proof_id, { changeId: CHANGE.id, attemptId: ATTEMPT.id })).record;
		assert.equal(stored.provenance.attested_by, "caller");
		assert.equal(stored.provenance.tool_call_id, undefined);
	});
});

test("missing capabilities never default to protected", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation());
		const out = await ingest(store, {});
		assert.equal(out.attested_by, "caller");
		assert.equal(out.ingested[0].discharges, false);
	});
});

// ------------------------------------------------------------ parsing scope

test("malformed, wrong-schema, symlinked, directory, oversized and non-.json entries are skipped and reported, no proof", async () => {
	await withWorkspace(async ({ store, inbox, root }) => {
		await drop(inbox, "bad-json.json", "{not json");
		await drop(inbox, "wrong-schema.json", { ...observation(), schema: "something/9" });
		await drop(inbox, "missing-field.json", (() => { const o = observation(); delete o.tool_use_id; return o; })());
		await drop(inbox, "bad-exit.json", observation({ event: "PostToolUse", exit_code: 3 }));
		await writeFile(join(root, "outside.json"), JSON.stringify(observation()));
		await symlink(join(root, "outside.json"), join(inbox, "link.json"));
		await mkdir(join(inbox, "dir.json"));
		await drop(inbox, "huge.json", JSON.stringify(observation({ cwd: "x".repeat(MAX_OBSERVATION_BYTES) })));
		await mkdir(join(store.root, "hook-logs"), { recursive: true });
		await drop(inbox, "1.err", "Read-only file system");
		await drop(inbox, "1.status", "wrote");
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 0);
		const reasons = Object.fromEntries(out.skipped.map((s) => [basename(s.file), s.reason]));
		assert.deepEqual(reasons, {
			"bad-json.json": "not-json",
			"wrong-schema.json": "invalid-observation",
			"missing-field.json": "invalid-observation",
			"bad-exit.json": "invalid-observation",
			"link.json": "symlink",
			"dir.json": "not-a-regular-file",
			"huge.json": "oversized",
		});
		// .err/.status are opaque: neither parsed nor reported
		assert.ok(!Object.keys(reasons).some((f) => f.endsWith(".err") || f.endsWith(".status")));
		// the symlink is refused by the lstat layer, before any open (O_NOFOLLOW is the second line)
		assert.equal(out.skipped.find((s) => s.file.endsWith("link.json")).message, "symlinks in the inbox are never followed");
		// nothing moved, nothing deleted
		const left = (await readdir(inbox)).sort();
		assert.ok(left.includes("link.json") && left.includes("dir.json") && left.includes("1.err"));
		assert.ok(!left.includes("processed"));
		// symlink target untouched
		assert.equal((await lstat(join(inbox, "link.json"))).isSymbolicLink(), true);
	});
});

test("an observation carrying authority/discharges/attested_by/provenance is refused as not hook-written", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation({ authority: "observed" }));
		await drop(inbox, "b.json", observation({ discharges: true }));
		await drop(inbox, "c.json", observation({ attested_by: "host-tool-result" }));
		await drop(inbox, "d.json", observation({ provenance: { attested_by: "host-tool-result" } }));
		const out = await ingest(store, UNPROTECTED);
		assert.equal(out.ingested.length, 0);
		assert.equal(out.skipped.length, 4);
		for (const s of out.skipped) assert.equal(s.reason, "invalid-observation");
	});
});

// ---------------------------------------------------------------- matching

test("a command that matches no obligation is reported and yields no proof", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation({ command: "npm test" }));
		await drop(inbox, "b.json", observation({ command: `${TEST_CMD}; true` }));
		await drop(inbox, "c.json", observation({ command: TEST_CMD.slice(0, -4) }));
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 0);
		assert.equal(out.skipped.length, 3);
		for (const s of out.skipped) assert.equal(s.reason, "no-matching-obligation");
	});
});

test("a command matching two obligations is ambiguous: reported, no proof", async () => {
	const slice = sliceWithCommands({ proof_obligations: SLICE.proof_obligations.map((o) => ({ ...o, command: TEST_CMD })) });
	await withWorkspace(
		async ({ store, inbox }) => {
			await drop(inbox, "a.json", observation());
			const out = await ingest(store, PROTECTED);
			assert.equal(out.ingested.length, 0);
			assert.equal(out.skipped[0].reason, "ambiguous-obligation");
			assert.match(out.skipped[0].message, /O1, O2/);
		},
		slice,
	);
});

// ------------------------------------------------------------- idempotency

test("the same observation twice is a replay, not a second proof", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation());
		const first = await ingest(store, PROTECTED, { processedDir: null });
		const second = await ingest(store, PROTECTED, { processedDir: null });
		assert.equal(first.ingested[0].replayed, false);
		assert.equal(second.ingested[0].replayed, true);
		assert.equal(second.ingested[0].proof_id, first.ingested[0].proof_id);
		await drop(inbox, "copy.json", observation());
		const third = await ingest(store, PROTECTED, { processedDir: null });
		assert.equal(third.ingested.length, 2);
		assert.ok(third.ingested.every((i) => i.replayed && i.proof_id === first.ingested[0].proof_id));
		const proofs = await readdir(join(store.root, "changes", CHANGE.id, "attempts", ATTEMPT.id, "proofs"));
		assert.equal(proofs.filter((n) => n.endsWith(".json")).length, 1);
		// same tool_use_id, different bytes: a conflict, refused, not a second proof
		await drop(inbox, "conflict.json", observation({ command: LINT_CMD }));
		const fourth = await ingest(store, PROTECTED, { processedDir: null });
		const conflict = fourth.skipped.find((s) => s.file.endsWith("conflict.json"));
		assert.equal(conflict.reason, "proof-refused");
		assert.match(conflict.message, /different payload/);
	});
});

// ----------------------------------------------------------------- failure

test("a failing exit code records a failed proof that does not discharge; no exit code records blocked", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation({ event: "PostToolUseFailure", exit_code: 7, tool_use_id: "toolu_fail" }));
		await drop(inbox, "b.json", observation({ event: "PostToolUseFailure", exit_code: null, tool_use_id: "toolu_denied" }));
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 2);
		const [failed, blocked] = out.ingested;
		assert.equal(failed.result, "failed");
		assert.equal(failed.authority, "observed");
		assert.equal(failed.discharges, false);
		const stored = (await store.get("proof", failed.proof_id, { changeId: CHANGE.id, attemptId: ATTEMPT.id })).record;
		assert.equal(stored.exit_code, 7);
		assert.equal(blocked.result, "blocked");
		assert.equal(blocked.discharges, false);
	});
});

test("validateHostObservation refuses unknown fields and bad shapes", () => {
	assert.equal(validateHostObservation(observation()).ok, true);
	assert.equal(validateHostObservation(null).ok, false);
	assert.equal(validateHostObservation([]).ok, false);
	assert.equal(validateHostObservation(observation({ extra: 1 })).ok, false);
	assert.equal(validateHostObservation(observation({ exit_code: -1 })).ok, false);
	assert.equal(validateHostObservation(observation({ stdout: { digest: "md5:x", size: 0 } })).ok, false);
	assert.equal(validateHostObservation(observation({ started_at: "yesterday" })).ok, false);
	assert.equal(validateHostObservation(observation({ command: "" })).ok, false);
});


// ------------------------------------------------------------------ binding
// Fixture timeline: attempt created 10:10:00, check ran 10:20:00–10:21:30,
// candidate captured 10:22:00 (E01's valid proof has exactly this
// run-then-capture shape; it must keep discharging).

const activity = (overrides = {}) => ({
	schema: HOST_OBSERVATION_SCHEMA,
	kind: "activity",
	host: "claude-code",
	event: "PostToolUse",
	tool_name: "Edit",
	tool_use_id: "toolu_edit",
	session_id: "sess-1",
	cwd: WORKSPACE,
	ended_at: "2026-09-17T10:21:45Z",
	...overrides,
});

test("A1: an observation that ended before the attempt was created is refused (observation-predates-attempt)", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "stale.json", observation({ started_at: "2026-09-01T00:00:00Z", ended_at: "2026-09-01T00:01:00Z" }));
		await drop(inbox, "edge.json", observation({ tool_use_id: "toolu_edge", started_at: "2026-09-17T10:09:00Z", ended_at: "2026-09-17T10:09:59Z" }));
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 0);
		assert.equal(out.skipped.length, 2);
		for (const s of out.skipped) {
			assert.equal(s.reason, "observation-predates-attempt");
			assert.match(s.message, /before attempt att_00000000000000000000a001 was created at 2026-09-17T10:10:00Z/);
		}
		// refused files are left in place
		assert.deepEqual((await readdir(inbox)).sort(), ["edge.json", "stale.json"]);
	});
});

test("A2: an observation recorded outside the workspace root is refused (observation-outside-workspace); a symlink alias of the root is accepted", async () => {
	await withWorkspace(async ({ store, inbox, root }) => {
		await drop(inbox, "elsewhere.json", observation({ cwd: "/somewhere/else/entirely" }));
		await drop(inbox, "other-session.json", observation({ tool_use_id: "toolu_other", session_id: "other-session", cwd: "/somewhere/else/entirely" }));
		await drop(inbox, "empty.json", observation({ tool_use_id: "toolu_empty", cwd: "" }));
		await drop(inbox, "sub.json", observation({ tool_use_id: "toolu_sub", cwd: join(root, ".codecarto") }));
		await drop(inbox, "parent.json", observation({ tool_use_id: "toolu_parent", cwd: dirname(root) }));
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 0);
		assert.equal(out.skipped.length, 5);
		for (const s of out.skipped) {
			assert.equal(s.reason, "observation-outside-workspace");
			assert.match(s.message, new RegExp(`not the workspace root ${JSON.stringify(JSON.stringify(root)).slice(1, -1)}`));
		}
		// realpaths are compared: a symlink to the root is the root
		await symlink(root, join(dirname(root), `${basename(root)}-alias`));
		try {
			await drop(inbox, "alias.json", observation({ tool_use_id: "toolu_alias", cwd: `${root}-alias` }));
			const again = await ingest(store, PROTECTED);
			assert.equal(again.ingested.length, 1);
			assert.equal(again.ingested[0].discharges, true);
		} finally {
			await rm(`${root}-alias`, { force: true });
		}
	});
});

test("A2: explicit workspaceRoot option is honoured and compared by realpath", async () => {
	await withWorkspace(async ({ store, inbox, root }) => {
		const other = join(root, "other-ws");
		await mkdir(other);
		await drop(inbox, "a.json", observation());
		const refused = await ingest(store, PROTECTED, { workspaceRoot: other, processedDir: null });
		assert.equal(refused.ingested.length, 0);
		assert.equal(refused.skipped[0].reason, "observation-outside-workspace");
		const accepted = await ingest(store, PROTECTED, { workspaceRoot: `${root}/./`, processedDir: null });
		assert.equal(accepted.ingested.length, 1);
	});
});

test("A3: run, then Edit, then capture -> refused as tree-activity-after-run naming the Edit; the activity entry is never a proof", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "run.json", observation()); // ended 10:21:30
		await drop(inbox, "edit.json", activity({ ended_at: "2026-09-17T10:21:45Z" })); // before the 10:22:00 capture
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 0);
		assert.equal(out.skipped.length, 1);
		assert.equal(out.skipped[0].reason, "tree-activity-after-run");
		assert.ok(out.skipped[0].file.endsWith("run.json"));
		assert.match(out.skipped[0].message, /Edit call toolu_edit completed at 2026-09-17T10:21:45Z/);
		// the activity entry stays: it still gates run.json on the next read
		assert.deepEqual((await readdir(inbox)).sort(), ["edit.json", "run.json"]);
		const again = await ingest(store, PROTECTED);
		assert.equal(again.ingested.length, 0);
		assert.equal(again.skipped[0].reason, "tree-activity-after-run");
		// nothing was written to the proofs directory
		await assert.rejects(readdir(join(store.root, "changes", CHANGE.id, "attempts", ATTEMPT.id, "proofs")));
	});
});

test("A3: activity exactly at captured_at counts; activity after captured_at does not; activity in another session does not; activity before the run does not", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "run.json", observation());
		await drop(inbox, "late.json", activity({ tool_use_id: "toolu_late", ended_at: "2026-09-17T10:22:01Z" }));
		await drop(inbox, "other.json", activity({ tool_use_id: "toolu_other", session_id: "sess-2", ended_at: "2026-09-17T10:21:45Z" }));
		await drop(inbox, "before.json", activity({ tool_use_id: "toolu_before", ended_at: "2026-09-17T10:19:00Z" }));
		await drop(inbox, "same-instant.json", activity({ tool_use_id: "toolu_same", ended_at: "2026-09-17T10:21:30Z" }));
		const out = await ingest(store, PROTECTED, { processedDir: null });
		assert.equal(out.skipped.length, 0, JSON.stringify(out.skipped));
		assert.equal(out.ingested.length, 1);
		assert.equal(out.ingested[0].discharges, true);
		// the boundary: an Edit that completed exactly at the capture instant is inside the window
		await drop(inbox, "at.json", activity({ tool_use_id: "toolu_at", ended_at: "2026-09-17T10:22:00Z" }));
		const again = await ingest(store, PROTECTED, { processedDir: null });
		assert.equal(again.ingested.length, 0);
		assert.equal(again.skipped[0].reason, "tree-activity-after-run");
		assert.match(again.skipped[0].message, /toolu_at/);
	});
});

test("A3: run, then a later Bash call, then capture -> refused naming the Bash call; a Bash call after the capture does not count", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "run.json", observation());
		await drop(inbox, "after-capture.json", observation({ tool_use_id: "toolu_git", command: "git status", started_at: "2026-09-17T10:22:10Z", ended_at: "2026-09-17T10:22:11Z" }));
		const ok = await ingest(store, PROTECTED, { processedDir: null });
		assert.deepEqual(ok.ingested.map((i) => i.discharges), [true]);
		assert.deepEqual(ok.skipped.map((s) => s.reason), ["no-matching-obligation"]);
		await drop(inbox, "sed.json", observation({ tool_use_id: "toolu_sed", command: "sed -i s/a/b/ src/x.ts", started_at: "2026-09-17T10:21:40Z", ended_at: "2026-09-17T10:21:41Z" }));
		const out = await ingest(store, PROTECTED, { processedDir: null });
		const run = out.skipped.find((s) => s.file.endsWith("run.json"));
		assert.equal(run.reason, "tree-activity-after-run");
		assert.match(run.message, /Bash call toolu_sed completed at 2026-09-17T10:21:41Z/);
	});
});

test("A3: run then capture with nothing in between discharges (E01's valid proof fixture timings)", async () => {
	const PROOF = await readFixture("proof.json");
	assert.equal(PROOF.started_at, "2026-09-17T10:20:00Z");
	assert.equal(PROOF.ended_at, "2026-09-17T10:21:30Z");
	assert.equal(SNAPSHOT.captured_at, "2026-09-17T10:22:00Z");
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "a.json", observation({ started_at: PROOF.started_at, ended_at: PROOF.ended_at }));
		const out = await ingest(store, PROTECTED);
		assert.equal(out.skipped.length, 0);
		assert.equal(out.ingested[0].discharges, true);
		const stored = (await store.get("proof", out.ingested[0].proof_id, { changeId: CHANGE.id, attemptId: ATTEMPT.id })).record;
		assert.equal(stored.snapshot_id, SNAPSHOT.id);
		assert.equal(stored.ended_at, PROOF.ended_at);
	});
});

test("A3: rotation keeps a gating record while the observation it refuses is still in the inbox", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "run.json", observation());
		await drop(inbox, "edit.json", activity());
		await drop(inbox, "unrelated-edit.json", activity({ tool_use_id: "toolu_u", session_id: "sess-9" }));
		const out = await ingest(store, PROTECTED);
		assert.deepEqual(out.rotated.map((f) => basename(f)), ["unrelated-edit.json"]);
		assert.deepEqual((await readdir(inbox)).sort(), ["edit.json", "processed", "run.json"]);
	});
});

test("validateHostActivity refuses unknown fields, non-activity tools, and anything result-shaped", () => {
	assert.equal(validateHostActivity(activity()).ok, true);
	for (const tool of ["Write", "MultiEdit", "NotebookEdit"]) assert.equal(validateHostActivity(activity({ tool_name: tool })).ok, true);
	assert.equal(validateHostActivity(activity({ tool_name: "Bash" })).ok, false);
	assert.equal(validateHostActivity(activity({ tool_name: "Read" })).ok, false);
	assert.equal(validateHostActivity(activity({ command: "x" })).ok, false);
	assert.equal(validateHostActivity(activity({ exit_code: 0 })).ok, false);
	assert.equal(validateHostActivity(activity({ file_path: "/etc/passwd" })).ok, false);
	assert.equal(validateHostActivity(activity({ ended_at: "soon" })).ok, false);
	assert.equal(validateHostActivity({ ...activity(), kind: "observation" }).ok, false);
	// an activity-shaped inbox file with a bad shape is skipped as invalid, not ingested
	assert.equal(validateHostObservation(activity()).ok, false);
});

test("an activity-shaped inbox file with unknown fields is skipped and left in place", async () => {
	await withWorkspace(async ({ store, inbox }) => {
		await drop(inbox, "bad.json", activity({ file_path: "src/x.ts" }));
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 0);
		assert.equal(out.skipped[0].reason, "invalid-observation");
		assert.match(out.skipped[0].message, /activity: unknown field file_path/);
		assert.deepEqual(await readdir(inbox), ["bad.json"]);
	});
});

test("reader O_NOFOLLOW: with an lstat that lies about a symlink, the open still refuses to follow it", { skip: POSIX_ONLY }, async () => {
	const root = await mkdtemp(join(tmpdir(), "codecarto-nofollow-"));
	try {
		await writeFile(join(root, "target.json"), JSON.stringify(observation()));
		await symlink(join(root, "target.json"), join(root, "link.json"));
		const honest = await readInboxFile(join(root, "link.json"));
		assert.equal(honest.ok, false);
		assert.equal(honest.skip.reason, "symlink");
		// the swap window: lstat saw a regular file, then the path became a symlink
		const lying = { lstat: async (p) => stat(p) };
		const swapped = await readInboxFile(join(root, "link.json"), lying);
		assert.equal(swapped.ok, false);
		assert.equal(swapped.skip.reason, "symlink");
		assert.match(swapped.skip.message, /ELOOP/);
		// and a real regular file still reads
		const plain = await readInboxFile(join(root, "target.json"), lying);
		assert.equal(plain.ok, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// -------------------------------------------------------------------- hook

const PAYLOAD = {
	session_id: "sess-live",
	transcript_path: "/nowhere",
	cwd: "/work", // hook tests only; the end-to-end test overrides it with the workspace
	permission_mode: "default",
	hook_event_name: "PostToolUse",
	tool_name: "Bash",
	tool_use_id: "toolu_hook",
	tool_input: { command: "/usr/bin/true", description: "x" },
	tool_response: { stdout: "hello\n", stderr: "", interrupted: false },
	duration_ms: 20,
};

function runHook(namespace, payload, stamp) {
	const args = [HOOK, namespace];
	if (stamp) args.push(stamp);
	return spawnSync(process.execPath, args, { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
}

async function listAll(dir) {
	const out = [];
	for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) out.push(join(e.parentPath ?? e.path, e.name).slice(dir.length + 1));
	return out.sort();
}

test("hook: one synthetic payload -> exactly one new inbox file, a status log, nothing else, nothing outside", { skip: POSIX_ONLY }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codecarto-hook-")));
	try {
		const ns = join(root, "ns");
		await mkdir(ns); // the operator creates the namespace as a real directory before the first session
		const r = runHook(ns, PAYLOAD);
		assert.equal(r.status, 0, r.stderr);
		const files = await listAll(root);
		const inboxFiles = files.filter((f) => f.startsWith("ns/inbox/"));
		const logFiles = files.filter((f) => f.startsWith("ns/hook-logs/"));
		assert.equal(inboxFiles.length, 1);
		assert.equal(logFiles.length, 1);
		assert.ok(logFiles[0].endsWith(".status"));
		assert.equal(files.length, 2 + 3, files.join(",")); // ns/, inbox/, hook-logs/ + 2 files
		const record = JSON.parse(await readFile(join(root, inboxFiles[0]), "utf8"));
		const valid = validateHostObservation(record);
		assert.equal(valid.ok, true, valid.message);
		assert.equal(record.tool_use_id, "toolu_hook");
		assert.equal(record.command, "/usr/bin/true");
		assert.equal(record.exit_code, 0);
		assert.equal(record.stdout.size, 6);
		assert.equal((await stat(join(root, inboxFiles[0]))).mode & 0o777, 0o600);
		// a failure payload parses the exit code from `error`
		const f = runHook(ns, { ...PAYLOAD, hook_event_name: "PostToolUseFailure", tool_use_id: "toolu_f", tool_input: { command: "/usr/bin/false" }, error: "Exit code 1\nsome text", tool_response: undefined });
		assert.equal(f.status, 0);
		const after = (await listAll(root)).filter((x) => x.startsWith("ns/inbox/"));
		assert.equal(after.length, 2);
		const failRec = JSON.parse(await readFile(join(root, after.find((x) => x !== inboxFiles[0])), "utf8"));
		assert.equal(failRec.exit_code, 1);
		assert.equal(failRec.event, "PostToolUseFailure");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hook: O_EXCL — a pre-created target (file or symlink) is never overwritten or written through", { skip: POSIX_ONLY }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codecarto-hook-excl-")));
	try {
		const ns = join(root, "ns");
		await mkdir(join(ns, "inbox"), { recursive: true });
		await mkdir(join(ns, "hook-logs"), { recursive: true });
		await writeFile(join(ns, "inbox", "fixed.json"), "ORIGINAL");
		const r = runHook(ns, PAYLOAD, "fixed");
		assert.equal(r.status, 0);
		assert.equal(await readFile(join(ns, "inbox", "fixed.json"), "utf8"), "ORIGINAL");
		assert.equal(await readFile(join(ns, "hook-logs", "fixed.status"), "utf8"), "refused\n");
		assert.match(await readFile(join(ns, "hook-logs", "fixed.err"), "utf8"), /EEXIST/);
		// dangling symlink at the target: not followed, target not created
		const victim = join(root, "victim.json");
		await symlink(victim, join(ns, "inbox", "planted.json"));
		const s = runHook(ns, PAYLOAD, "planted");
		assert.equal(s.status, 0);
		await assert.rejects(stat(victim));
		assert.equal((await lstat(join(ns, "inbox", "planted.json"))).isSymbolicLink(), true);
		// a symlinked inbox directory: refused outright, nothing written anywhere
		const ns2 = join(root, "ns2");
		await mkdir(ns2);
		await symlink(join(root, "elsewhere"), join(ns2, "inbox"));
		const d = runHook(ns2, PAYLOAD);
		assert.equal(d.status, 0);
		assert.deepEqual(await listAll(ns2), ["inbox"]);
		await assert.rejects(stat(join(root, "elsewhere")));
		// garbage on stdin: no inbox file, one .err + one .status
		const g = runHook(ns, "not json at all", "garbage");
		assert.equal(g.status, 0);
		await assert.rejects(stat(join(ns, "inbox", "garbage.json")));
		assert.equal(await readFile(join(ns, "hook-logs", "garbage.status"), "utf8"), "refused\n");
		// nothing outside the namespaces
		const top = (await readdir(root)).sort();
		assert.deepEqual(top, ["ns", "ns2"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hook + reader end to end: hook output ingests as a host-tool-result proof under protected capabilities", { skip: POSIX_ONLY }, async () => {
	await withWorkspace(async ({ store }) => {
		const r = runHook(store.root, { ...PAYLOAD, cwd: WORKSPACE, tool_input: { command: TEST_CMD } });
		assert.equal(r.status, 0);
		const out = await ingest(store, PROTECTED);
		assert.equal(out.skipped.length, 0);
		assert.equal(out.ingested.length, 1);
		assert.equal(out.ingested[0].authority, "observed");
		assert.equal(out.ingested[0].discharges, true);
	});
});

test("hook B: a symlinked ANCESTOR of the namespace -> nothing written anywhere, one stderr line, exit 0", { skip: POSIX_ONLY }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codecarto-hook-ancestor-")));
	try {
		await mkdir(join(root, "attacker", "engineering"), { recursive: true });
		await mkdir(join(root, "proj"));
		await symlink(join(root, "attacker"), join(root, "proj", ".codecarto"));
		const ns = join(root, "proj", ".codecarto", "engineering"); // lstat: a real directory
		const r = runHook(ns, PAYLOAD);
		assert.equal(r.status, 0);
		assert.match(r.stderr, /^observe\.mjs: refusing to write: namespace is missing, not canonical, or reached through a symlink\n$/);
		assert.deepEqual(await listAll(join(root, "attacker")), ["engineering"]); // target stays empty
		assert.deepEqual(await listAll(join(root, "proj")), [".codecarto"]);
		// a namespace that does not exist yet is refused too: the operator creates it
		const fresh = runHook(join(root, "missing"), PAYLOAD);
		assert.equal(fresh.status, 0);
		assert.match(fresh.stderr, /namespace is missing/);
		await assert.rejects(stat(join(root, "missing")));
		// a non-canonical spelling of a real directory is refused (`..`, trailing slash)
		await mkdir(join(root, "real"));
		for (const spelling of [`${root}/proj/../real`, `${root}/real/`]) {
			const nc = runHook(spelling, PAYLOAD);
			assert.equal(nc.status, 0);
			assert.match(nc.stderr, /namespace is missing, not canonical/);
		}
		assert.deepEqual(await listAll(join(root, "real")), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hook B: a symlinked hook-logs (or inbox) directory under a real namespace -> refused, target untouched", { skip: POSIX_ONLY }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codecarto-hook-logs-")));
	try {
		const ns = join(root, "ns");
		await mkdir(join(ns, "inbox"), { recursive: true });
		await mkdir(join(root, "attacker"));
		await symlink(join(root, "attacker"), join(ns, "hook-logs"));
		const r = runHook(ns, PAYLOAD);
		assert.equal(r.status, 0);
		assert.match(r.stderr, /hook-logs does not resolve to <namespace>\/hook-logs/);
		assert.deepEqual(await listAll(join(root, "attacker")), []);
		assert.deepEqual(await listAll(ns), ["hook-logs", "inbox"]);
		const ns2 = join(root, "ns2");
		await mkdir(join(ns2, "hook-logs"), { recursive: true });
		await symlink(join(root, "attacker"), join(ns2, "inbox"));
		const i = runHook(ns2, PAYLOAD);
		assert.equal(i.status, 0);
		assert.match(i.stderr, /inbox does not resolve to <namespace>\/inbox/);
		assert.deepEqual(await listAll(join(root, "attacker")), []);
		assert.deepEqual(await listAll(ns2), ["hook-logs", "inbox"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hook A3: Edit/Write/MultiEdit/NotebookEdit -> an activity entry with nothing from tool_input; other tools are refused", { skip: POSIX_ONLY }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codecarto-hook-activity-")));
	try {
		const ns = join(root, "ns");
		await mkdir(ns);
		const secret = "/very/secret/path.ts";
		for (const [i, tool] of ["Edit", "Write", "MultiEdit", "NotebookEdit"].entries()) {
			const r = runHook(ns, { ...PAYLOAD, tool_name: tool, tool_use_id: `toolu_${tool}`, tool_input: { file_path: secret, content: "TOP SECRET CONTENT", old_string: "a", new_string: "b" }, tool_response: { filePath: secret, success: true } }, `act${i}`);
			assert.equal(r.status, 0, r.stderr);
			const text = await readFile(join(ns, "inbox", `act${i}.json`), "utf8");
			assert.ok(!text.includes("secret") && !text.includes("SECRET"), text);
			const record = JSON.parse(text);
			assert.deepEqual(Object.keys(record).sort(), ["cwd", "ended_at", "event", "host", "kind", "schema", "session_id", "tool_name", "tool_use_id"]);
			assert.equal(record.kind, "activity");
			assert.equal(record.tool_name, tool);
			assert.equal(record.tool_use_id, `toolu_${tool}`);
			assert.equal(record.session_id, "sess-live");
			assert.equal(validateHostActivity(record).ok, true);
			assert.equal(await readFile(join(ns, "hook-logs", `act${i}.status`), "utf8"), "wrote\n");
		}
		// a failure event on an edit tool is activity too (the tool may have partially written)
		const f = runHook(ns, { ...PAYLOAD, hook_event_name: "PostToolUseFailure", tool_name: "Write", tool_use_id: "toolu_wf", tool_input: { file_path: secret }, error: "permission denied" }, "actf");
		assert.equal(f.status, 0);
		assert.equal(JSON.parse(await readFile(join(ns, "inbox", "actf.json"), "utf8")).event, "PostToolUseFailure");
		// Read / Grep / anything else: refused, no inbox file
		for (const [i, tool] of ["Read", "Grep", "Glob", "Task"].entries()) {
			const r = runHook(ns, { ...PAYLOAD, tool_name: tool, tool_use_id: `toolu_${tool}`, tool_input: { file_path: secret } }, `no${i}`);
			assert.equal(r.status, 0);
			await assert.rejects(stat(join(ns, "inbox", `no${i}.json`)));
			assert.equal(await readFile(join(ns, "hook-logs", `no${i}.status`), "utf8"), "refused\n");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hook + reader end to end (A3): a check run, then an Edit, then the capture -> the reader refuses the check naming the Edit", { skip: POSIX_ONLY }, async () => {
	await withWorkspace(async ({ store, inbox }) => {
		// Both hook writes happen "now" (after the fixture capture at 10:22:00),
		// so the hook records are re-stamped onto the fixture timeline.
		const run = runHook(store.root, { ...PAYLOAD, cwd: WORKSPACE, tool_input: { command: TEST_CMD } }, "run");
		const edit = runHook(store.root, { ...PAYLOAD, cwd: WORKSPACE, tool_name: "Edit", tool_use_id: "toolu_e2e_edit", tool_input: { file_path: "src/x.ts" } }, "edit");
		assert.equal(run.status, 0);
		assert.equal(edit.status, 0);
		const runRecord = JSON.parse(await readFile(join(inbox, "run.json"), "utf8"));
		const editRecord = JSON.parse(await readFile(join(inbox, "edit.json"), "utf8"));
		await drop(inbox, "run.json", { ...runRecord, started_at: "2026-09-17T10:20:00Z", ended_at: "2026-09-17T10:21:30Z" });
		await drop(inbox, "edit.json", { ...editRecord, ended_at: "2026-09-17T10:21:50Z" });
		const out = await ingest(store, PROTECTED);
		assert.equal(out.ingested.length, 0);
		assert.equal(out.skipped.length, 1);
		assert.equal(out.skipped[0].reason, "tree-activity-after-run");
		assert.match(out.skipped[0].message, /Edit call toolu_e2e_edit/);
	});
});
