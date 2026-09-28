// Host-observed proof ingestion (E05, #409): the inbox reader and the hook.
//
// Every test here uses a real temp store and real files, because the whole
// point of this path is what the filesystem allows: a symlink in the inbox,
// a directory named `x.json`, a pre-created target name for the hook.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, ingestHostObservations, validateHostObservation, proofAuthority, MAX_OBSERVATION_BYTES, HOST_OBSERVATION_SCHEMA } = engineering;
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

async function withWorkspace(fn, slice = sliceWithCommands()) {
	const root = await mkdtemp(join(tmpdir(), "codecarto-e05-host-obs-"));
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
	cwd: "/work",
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
		const reasons = Object.fromEntries(out.skipped.map((s) => [s.file.split("/").pop(), s.reason]));
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

// -------------------------------------------------------------------- hook

const PAYLOAD = {
	session_id: "sess-live",
	transcript_path: "/nowhere",
	cwd: "/work",
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

test("hook: one synthetic payload -> exactly one new inbox file, a status log, nothing else, nothing outside", async () => {
	const root = await mkdtemp(join(tmpdir(), "codecarto-hook-"));
	try {
		const ns = join(root, "ns");
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

test("hook: O_EXCL — a pre-created target (file or symlink) is never overwritten or written through", async () => {
	const root = await mkdtemp(join(tmpdir(), "codecarto-hook-excl-"));
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

test("hook + reader end to end: hook output ingests as a host-tool-result proof under protected capabilities", async () => {
	await withWorkspace(async ({ store }) => {
		const r = runHook(store.root, { ...PAYLOAD, tool_input: { command: TEST_CMD } });
		assert.equal(r.status, 0);
		const out = await ingest(store, PROTECTED);
		assert.equal(out.skipped.length, 0);
		assert.equal(out.ingested.length, 1);
		assert.equal(out.ingested[0].authority, "observed");
		assert.equal(out.ingested[0].discharges, true);
	});
});
