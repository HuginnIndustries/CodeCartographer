// Ingesting observed proof without promoting claims (E05, #403).
//
// The trust boundary this file defends, stated exactly once:
//
//   CodeCartographer never runs the check. A host does, and reports what it
//   saw. So the framework cannot know whether a result is TRUE — a dishonest
//   host can fabricate an observation and this module will store it.
//
//   What it can refuse to do is LAUNDER a claim into an observation. Authority
//   is derived from the collector and the attestation, never read from the
//   payload, so a caller who writes `authority: "observed"` on a prose PASS
//   gets a claimed proof that discharges nothing under the verified policy.
//
// Everything below tests a refusal, because an ingester that accepts
// everything is a filesystem with extra steps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, ingestProof, exportProofSummary, proofAuthority } = engineering;

const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));

// E01 owns these shapes; read the shipped fixtures rather than restating them,
// so a contract change breaks this suite loudly instead of leaving it
// asserting against a stale idea of a record.
const CHANGE = await readFixture("change.json");
const SLICE = await readFixture("slice.json");
const ATTEMPT = await readFixture("attempt.json");
const SNAPSHOT = await readFixture("snapshot-candidate.json");
const PROOF = await readFixture("proof.json");

/** A workspace with change/slice/attempt/snapshot already persisted — the state ingestion binds against. */
async function withWorkspace(fn) {
	const root = await mkdtemp(join(tmpdir(), "codecarto-e05-proofs-"));
	try {
		const store = await openStore(join(root, ".codecarto"));
		await store.put(CHANGE);
		await store.put(SLICE);
		await store.put(ATTEMPT);
		await store.put(SNAPSHOT);
		return await fn({ store, root });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** A host-observed passing proof, attested by the host's tool layer: the strongest thing that exists. */
const observed = (overrides = {}) => ({
	...PROOF,
	...overrides,
	provenance: { source: "mcp:claude-code", attested_by: "host-tool-result", tool_call_id: "call_0001", ...(overrides.provenance ?? {}) },
});

/** The same check, reported by the caller rather than witnessed. Identical labels, different authority. */
const claimed = (overrides = {}) => ({
	...PROOF,
	...overrides,
	provenance: { source: "mcp:claude-code", attested_by: "caller", ...(overrides.provenance ?? {}) },
});

// ---------------------------------------------------------------- authority

test("a caller-reported result is claimed however its collector is spelled", async () => {
	// The central refusal. `host-observed` is a label in a payload the caller
	// wrote; only the attestation says who actually watched.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, claimed({ collector: "host-observed" }));
		assert.equal(result.ok, true);
		assert.equal(result.authority, "claimed");
		assert.equal(proofAuthority(result.proof), "claimed");
	});
});

test("authority in the payload is ignored, not trusted", async () => {
	// A caller that simply writes the conclusion it wants must not get it.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, claimed({ authority: "observed" }));
		assert.equal(result.ok, true);
		assert.equal(result.authority, "claimed", "payload authority was promoted");
		assert.equal(result.proof.authority, undefined, "payload authority was persisted");
	});
});

test("a host-observed check attested by the host's tool layer is observed", async () => {
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed());
		assert.equal(result.ok, true);
		assert.equal(result.authority, "observed");
	});
});

test("an agent-claimed collector is never observed, whatever attested it", async () => {
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, { ...observed({ collector: "agent-claimed" }) });
		// It may be storable as a record of what the agent said, but it is a claim.
		if (result.ok) assert.equal(result.authority, "claimed");
		else assert.ok(result.errors.length > 0);
	});
});

// ---------------------------------------------------------------- binding

test("a proof naming an attempt that does not exist is refused", async () => {
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed({ attempt_id: "att_0000000000000000000000a2" }));
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /attempt/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("a proof bound to a snapshot of a different attempt is refused", async () => {
	// The snapshot is what says which bytes the check ran against. Binding to
	// another attempt's snapshot makes the result describe a tree that was
	// never under test here.
	await withWorkspace(async ({ store }) => {
		const foreign = { ...SNAPSHOT, id: "snp_0000000000000000000000f1", attempt_id: "att_0000000000000000000000a2" };
		await store.put(foreign, {}).catch(() => {});
		const result = await ingestProof(store, observed({ snapshot_id: foreign.id }));
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /snapshot/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("a proof naming an obligation the slice does not declare is refused", async () => {
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed({ obligation_id: "O-NOT-DECLARED" }));
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /obligation/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("a proof that does not name the obligation's scenario is refused", async () => {
	// A result that proves something other than what the obligation is for
	// discharges nothing, and silently accepting it would let a passing lint
	// stand in for a behavioral scenario.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed({ scenario_ids: ["S-UNRELATED"] }));
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /scenario/.test(e.message)), JSON.stringify(result.errors));
	});
});

// ---------------------------------------------------------------- staleness

test("a proof against a superseded candidate cannot discharge", async () => {
	// The real staleness, and it is relational. A proof always names an
	// immutable snapshot, so the bytes it measured cannot drift — a first
	// draft compared a caller-declared `snapshot_digest`, which is not a
	// contract field at all and could never fire.
	//
	// What does move is the ATTEMPT: it may capture a newer candidate. The old
	// proof stays on the record, because it is a truthful account of what ran,
	// but it is evidence about superseded bytes and discharges nothing.
	// E02 makes a published attempt immutable, so the superseded state is
	// built the way the contract actually allows: a SECOND attempt bound to a
	// newer candidate, with the proof still naming the first attempt's
	// snapshot while that attempt points elsewhere.
	await withWorkspace(async ({ store }) => {
		const newer = { ...SNAPSHOT, id: "snp_0000000000000000000000d9", attempt_id: "att_0000000000000000000000a5" };
		const secondAttempt = { ...ATTEMPT, id: "att_0000000000000000000000a5", candidate_snapshot_id: newer.id };
		await store.put(secondAttempt);
		await store.put(newer);

		// A proof on the second attempt naming the FIRST attempt's snapshot.
		const result = await ingestProof(store, observed({ attempt_id: secondAttempt.id, snapshot_id: SNAPSHOT.id }));
		// The snapshot belongs to another attempt, so this is refused outright
		// rather than merely non-discharging — the stronger outcome.
		assert.equal(result.ok, false, "a proof bound to another attempt's snapshot was accepted");
		assert.ok(result.errors.some((e) => e.path === "/snapshot_id"), JSON.stringify(result.errors));
	});
});

test("a proof against the attempt's current candidate does discharge", async () => {
	// The control for the test above: without it, a `discharges: false` that
	// came from any other cause would look like the superseded rule working.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed());
		assert.equal(result.ok, true, JSON.stringify(result.errors));
		assert.equal(result.discharges, true);
	});
});

test("a proof against an unstable snapshot cannot discharge", async () => {
	// `unstable` means the tree MOVED during capture, so nobody can say which
	// bytes the check actually saw. The observation is still a truthful record
	// of what was run — it is retained — but it discharges nothing, because
	// the thing it would discharge against is unknown.
	//
	// The rule this replaced ("the check started before the snapshot was
	// captured") was invented: running the check and then capturing the
	// candidate is the normal order, and E01's own valid proof fixture has
	// exactly that shape.
	await withWorkspace(async ({ store }) => {
		const unstable = { ...SNAPSHOT, id: "snp_0000000000000000000000d2", stability: "unstable" };
		await store.put(unstable);
		const result = await ingestProof(store, observed({ snapshot_id: unstable.id }));
		assert.equal(result.ok, true, `an unstable capture is still a real observation: ${JSON.stringify(result.errors)}`);
		assert.equal(result.discharges, false, "a proof against a moving tree discharged its obligation");
	});
});

test("the normal order — check first, capture after — is accepted", async () => {
	// Guards the invented rule from coming back.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed());
		assert.equal(result.ok, true, JSON.stringify(result.errors));
		assert.ok(result.proof.started_at < SNAPSHOT.captured_at, "fixture no longer exercises this ordering");
	});
});

// ---------------------------------------------------------------- completeness

test("a host-observed pass with no exit code is refused", async () => {
	// "It passed" without the exit status is a prose claim wearing an
	// observation's clothes.
	await withWorkspace(async ({ store }) => {
		const incomplete = observed();
		delete incomplete.exit_code;
		const result = await ingestProof(store, incomplete);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /exit_code/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("a passing result whose exit code is non-zero is refused", async () => {
	// The two halves of the same observation must agree; if they do not,
	// something built this record rather than witnessed it.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed({ result: "passed", exit_code: 1 }));
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /exit|contradict|disagree/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("a blocked result with no reason is refused", async () => {
	await withWorkspace(async ({ store }) => {
		const blocked = observed({ result: "blocked" });
		delete blocked.exit_code;
		const result = await ingestProof(store, blocked);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /block_reason/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("a manual observation with no observer is refused", async () => {
	await withWorkspace(async ({ store }) => {
		const manual = observed({
			collector: "manual-observation",
			check: { kind: "manual-procedure", procedure: "open the dashboard and read the count" },
			provenance: { source: "human", attested_by: "caller" },
		});
		delete manual.exit_code;
		const result = await ingestProof(store, manual);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /observer/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("a ci-reported result with no run reference is refused", async () => {
	// Without the run, nobody can go back and look.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed({ collector: "ci-reported", provenance: { source: "github-actions", attested_by: "caller" } }));
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /run_reference/.test(e.message)), JSON.stringify(result.errors));
	});
});

// ---------------------------------------------------------------- create-only

test("ingesting the same proof id twice is refused, not silently overwritten", async () => {
	// A completed observation is immutable. Editing one is how a failing
	// result becomes a passing one with no trace.
	await withWorkspace(async ({ store }) => {
		const first = await ingestProof(store, observed());
		assert.equal(first.ok, true);
		const second = await ingestProof(store, observed({ result: "failed", exit_code: 1 }));
		assert.equal(second.ok, false, "a second write to the same proof id was accepted");
		assert.ok(second.errors.some((e) => /exist|immutable|already/.test(e.message)), JSON.stringify(second.errors));
	});
});

test("an identical re-ingestion under an idempotency key replays rather than duplicating", async () => {
	await withWorkspace(async ({ store }) => {
		const first = await ingestProof(store, observed(), { idempotencyKey: "k1" });
		const second = await ingestProof(store, observed(), { idempotencyKey: "k1" });
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		assert.equal(second.replayed, true, "the repeat was stored as a second observation");
	});
});

// ---------------------------------------------------------------- artifacts

test("a traversing artifact location is unrepresentable, not merely rejected", async () => {
	// E01 designed this out rather than validating it: `ArtifactReference` has
	// no path field, and an artifact's location is DERIVED from its id, whose
	// grammar is `[0-9a-f]{24}`. The first draft of the ingester shipped a
	// containment check for a caller-supplied path — an input that cannot
	// exist. This test pins the structural property instead, so the guard is
	// not re-added out of habit.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(
			store,
			observed({
				artifacts: [{ id: "../../../../etc/passwd", label: "log", raw_digest: `sha256:${"a".repeat(64)}`, raw_size: 10, retained: true }],
			}),
		);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /\/artifacts\/0\/id/.test(e.path)), JSON.stringify(result.errors));
	});

	// And the path helper itself refuses it, which is what makes the above true.
	const { engineeringPaths } = engineering;
	assert.throws(() => engineeringPaths.artifact(CHANGE.id, ATTEMPT.id, "../../../../etc/passwd"), /artifact id/);
});

test("a retained artifact whose slot is a symlink out of the namespace is refused", async () => {
	// Ingestion never reads artifact bytes, so it is unharmed — but
	// `retained: true` asserts the bytes sit under the attempt's directory,
	// and a later consumer that packages them would follow the link out.
	await withWorkspace(async ({ store, root }) => {
		const outside = join(root, "outside.log");
		await writeFile(outside, "secret");
		const artifactId = "art_0000000000000000000000a2";
		const slot = join(store.root, "changes", CHANGE.id, "attempts", ATTEMPT.id, "artifacts", artifactId);
		await mkdir(dirname(slot), { recursive: true });
		await symlink(outside, slot);
		const result = await ingestProof(
			store,
			observed({ artifacts: [{ id: artifactId, label: "log", raw_digest: `sha256:${"a".repeat(64)}`, raw_size: 6, retained: true }] }),
		);
		assert.equal(result.ok, false, "a retained artifact pointing outside the namespace was accepted");
		assert.ok(result.errors.some((e) => /outside/.test(e.message)), JSON.stringify(result.errors));
	});
});

test("ingestion never reads artifact bytes", async () => {
	// The contract says ingestion does not execute commands or upload logs.
	// Recording an artifact's identity is not the same as handling its content.
	await withWorkspace(async ({ store }) => {
		const artifactId = "art_0000000000000000000000a3";
		const slot = join(store.root, "changes", CHANGE.id, "attempts", ATTEMPT.id, "artifacts", artifactId);
		await mkdir(dirname(slot), { recursive: true });
		await writeFile(slot, "AWS_SECRET_ACCESS_KEY=leaked");
		const result = await ingestProof(
			store,
			observed({ artifacts: [{ id: artifactId, label: "log", raw_digest: `sha256:${"b".repeat(64)}`, raw_size: 28, retained: true }] }),
		);
		assert.equal(result.ok, true, JSON.stringify(result.errors));
		assert.equal(JSON.stringify(result.proof).includes("leaked"), false, "artifact content reached the record");
	});
});

// ---------------------------------------------------------------- export

test("an exported summary carries the sanitized digest, never the raw one", async () => {
	// The raw/sanitized distinction exists precisely because the raw bytes may
	// carry secrets. An export that publishes the raw digest leaks the identity
	// of unredacted content.
	await withWorkspace(async ({ store }) => {
		const rawDigest = `sha256:${"c".repeat(64)}`;
		const sanitizedDigest = `sha256:${"d".repeat(64)}`;
		const result = await ingestProof(
			store,
			observed({
				artifacts: [{ id: "art_0000000000000000000000a4", label: "log", raw_digest: rawDigest, sanitized_digest: sanitizedDigest, raw_size: 12, retained: true }],
			}),
		);
		assert.equal(result.ok, true);
		const summary = exportProofSummary(result.proof);
		const text = JSON.stringify(summary);
		assert.equal(text.includes(sanitizedDigest), true, "the sanitized digest must identify the exported artifact");
		assert.equal(text.includes(rawDigest), false, "the raw digest reached an export");
	});
});

test("an artifact with no sanitized export contributes no digest at all", async () => {
	// The contract signals redaction by the PRESENCE of `sanitized_digest`
	// ("differs from raw_digest whenever anything was redacted"), so there is
	// no state where a redaction is claimed without naming what was published
	// — a first draft guarded a `redacted` flag that does not exist.
	//
	// What matters is the fallback: an unsanitized artifact must export NO
	// digest rather than quietly falling back to the raw one.
	await withWorkspace(async ({ store }) => {
		const rawDigest = `sha256:${"e".repeat(64)}`;
		const result = await ingestProof(
			store,
			observed({ artifacts: [{ id: "art_0000000000000000000000a5", label: "log", raw_digest: rawDigest, raw_size: 12, retained: false }] }),
		);
		assert.equal(result.ok, true, JSON.stringify(result.errors));
		const summary = exportProofSummary(result.proof);
		assert.equal(summary.artifacts[0].digest, undefined, "an unsanitized artifact exported a digest");
		assert.equal(JSON.stringify(summary).includes(rawDigest), false, "the raw digest reached an export");
	});
});

test("an exported summary states the authority rather than implying it", async () => {
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, claimed({ collector: "host-observed" }));
		const summary = exportProofSummary(result.proof);
		assert.equal(summary.authority, "claimed");
	});
});

// ---------------------------------------------------------------- promotion

test("a failing result cannot be ingested as a passing one", async () => {
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed({ result: "failed", exit_code: 1 }));
		assert.equal(result.ok, true, `a failure is a legitimate observation: ${JSON.stringify(result.errors)}`);
		assert.equal(result.proof.result, "failed");
		assert.equal(result.discharges, false, "a failed proof discharged its obligation");
	});
});

test("a blocked environment discharges nothing", async () => {
	await withWorkspace(async ({ store }) => {
		const blocked = observed({ result: "blocked", block_reason: "no network in the sandbox" });
		delete blocked.exit_code;
		const result = await ingestProof(store, blocked);
		assert.equal(result.ok, true, JSON.stringify(result.errors));
		assert.equal(result.discharges, false);
	});
});

test("a claimed pass discharges nothing under the verified policy", async () => {
	// The whole point: prose cannot satisfy an observed obligation.
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, claimed({ collector: "host-observed", result: "passed", exit_code: 0 }));
		assert.equal(result.ok, true);
		assert.equal(result.discharges, false, "a caller-reported claim discharged an observed obligation");
	});
});

test("an observed pass discharges its obligation", async () => {
	await withWorkspace(async ({ store }) => {
		const result = await ingestProof(store, observed());
		assert.equal(result.ok, true, JSON.stringify(result.errors));
		assert.equal(result.discharges, true);
	});
});

test("a proof against a non-current candidate of the same attempt cannot discharge", async () => {
	// This is what the superseded rule actually guards, and it took a mutation
	// check to find: an attempt may hold more than one candidate snapshot, but
	// only one is the candidate it is bound to. A proof measured against an
	// earlier one is a truthful record of what ran and is kept — but it is
	// evidence about bytes the attempt no longer points at, so it discharges
	// nothing.
	await withWorkspace(async ({ store }) => {
		const earlier = { ...SNAPSHOT, id: "snp_0000000000000000000000d7" };
		await store.put(earlier);
		assert.notEqual(ATTEMPT.candidate_snapshot_id, earlier.id, "fixture no longer exercises this");

		const result = await ingestProof(store, observed({ snapshot_id: earlier.id }));
		assert.equal(result.ok, true, `a superseded observation is still real: ${JSON.stringify(result.errors)}`);
		assert.equal(result.discharges, false, "a proof against a non-current candidate discharged its obligation");
	});
});

test("a snapshot record tampered into the wrong attempt's directory is detected", async () => {
	// Unreachable through the store API — the path is keyed by attempt, so a
	// read with this attempt's context cannot return another attempt's record.
	// It IS reachable by tampering: when `storage_boundary` is `none`, any
	// process as the user can drop a record into this attempt's directory.
	// Without this check the ingester would trust the planted file.
	await withWorkspace(async ({ store }) => {
		const planted = { ...SNAPSHOT, id: "snp_0000000000000000000000d8", attempt_id: "att_0000000000000000000000a7" };
		const slot = join(store.root, "changes", CHANGE.id, "attempts", ATTEMPT.id, "snapshots", `${planted.id}.json`);
		await mkdir(dirname(slot), { recursive: true });
		await writeFile(slot, JSON.stringify(planted));

		const result = await ingestProof(store, observed({ snapshot_id: planted.id }));
		assert.equal(result.ok, false, "a planted foreign snapshot was accepted");
		assert.ok(
			result.errors.some((e) => e.path === "/snapshot_id" && /belongs to attempt/.test(e.message)),
			JSON.stringify(result.errors),
		);
	});
});
