// The v1 engineering record and approval contract (E01, #399).
//
// The fixtures under tests/fixtures/engineering/v1/ are the executable half of
// docs/engineering/record-contract.md: every valid record there must parse,
// every invalid one must be refused with the listed code at the listed path,
// and the digests in them — computed by the fixture generator's own canonical
// JSON, not by core/engineering/digest.ts — must agree with the core's. A
// downstream issue that needs a new field adds a fixture here first.
//
// What these tests do not claim: that a well-formed approval record proves a
// person approved anything. `evaluateApprovalReceipt` checks that a receipt
// binds to the request the core issued; who answered the host's prompt is the
// host's attestation, and the record says so in `receipt.authenticated`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "engineering", "v1");

const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const barrel = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const {
	ENGINEERING_SCHEMA_VERSION,
	RECORD_ID_PREFIXES,
	COLLECTORS,
	OBSERVED_COLLECTORS,
	CHANGE_STATES,
	ATTEMPT_OUTCOMES,
	APPROVAL_CHANNELS,
	TRUSTED_APPROVAL_CHANNELS,
	CHANGE_ACTIONS,
	ENGINEERING_ERROR_CODES,
	ACCEPTANCE_REQUIRED_RECORDS,
	isRecordId,
	recordKindOfId,
	newRecordId,
	newNonce,
	isRepoRelativePath,
	isScopePattern,
	engineeringPaths,
	canonicalJson,
	digestOf,
	digestOfBytes,
	computeSnapshotDigest,
	computeInputDigest,
	computePresentationDigest,
	validateRecord,
	validateRecordOfKind,
	parseRecord,
	validateChangeBundle,
	validateAcceptanceRequest,
	validateChangeRequest,
	evaluateApprovalReceipt,
	buildAcceptanceRequest,
	deriveRemainingBlockers,
	collectorSatisfies,
	COLLECTOR_RANK,
	isTimestamp,
	isAllowedTransition,
	checkCandidateFreshness,
	standardLimitations,
	checkPresentationDisclosure,
	CHANGE_STATE_TRANSITIONS,
	ATTEMPT_OUTCOME_TRANSITIONS,
	ACCEPTANCE_REQUEST_MAX_TTL_MS,
	ATTESTATIONS,
	OBSERVING_ATTESTATIONS,
	ASSURANCE_POLICIES,
	VERIFIED_ACCEPTANCE_INTEGRATIONS,
	proofAuthority,
	proofDischarges,
	acceptanceChannelSupported,
	classifyAcceptance,
	attestationForHostObservation,
	PROTECTION_HISTORIES,
	TOOL_RESULT_PATHS,
	ELICITATION_OUTCOMES,
	elicitationDecision,
	acceptanceTtlWithin,
	checkAcceptanceRequestTtl,
} = engineering;

async function readJson(relPath) {
	return JSON.parse(await readFile(join(FIXTURES, relPath), "utf8"));
}

async function listJson(relDir) {
	return (await readdir(join(FIXTURES, relDir))).filter((n) => n.endsWith(".json")).sort();
}

const valid = {
	change: await readJson("valid/change.json"),
	minimalChange: await readJson("valid/change-minimal.json"),
	slice: await readJson("valid/slice.json"),
	attempt: await readJson("valid/attempt.json"),
	baseline: await readJson("valid/snapshot-baseline.json"),
	candidate: await readJson("valid/snapshot-candidate.json"),
	proof: await readJson("valid/proof.json"),
	proof2: await readJson("valid/proof-second-obligation.json"),
	review: await readJson("valid/review.json"),
	approval: await readJson("valid/approval.json"),
	approvalCooperative: await readJson("valid/approval-cooperative.json"),
	proofClaimed: await readJson("valid/proof-caller-reported.json"),
	request: await readJson("valid/acceptance-request.json"),
	bundle: await readJson("valid/bundle.json"),
};

/** The receipt context the valid approval fixture was issued against. */
function receiptContext(overrides = {}) {
	// `proofs`/`reviews` are what the acceptance binds to; classifyAcceptance
	// requires them to re-derive the presentation's disclosure, and a reader
	// that omits them may not read `verified`. The fixture bundle's proofs are
	// observed and its presentation discloses nothing beyond them.
	return { request: valid.request, consumed_nonces: [], attempt: valid.attempt, candidate: valid.candidate, proofs: [], reviews: [], ...overrides };
}

function codesAt(result) {
	assert.equal(result.ok, false, "expected a refusal");
	return result.errors.map((e) => `${e.code} ${e.path}`);
}

// ---------- the barrel ----------

test("core/index.ts re-exports the engineering contract, and nothing in core/engineering/ imports the barrel or a side-effecting module", async () => {
	for (const name of ["validateRecord", "validateChangeBundle", "evaluateApprovalReceipt", "validateChangeRequest", "ENGINEERING_SCHEMA_VERSION", "engineeringPaths"]) {
		assert.equal(typeof barrel[name], typeof engineering[name], `core/index.ts exports ${name}`);
	}
	const dir = join(REPO_ROOT, "core", "engineering");
	const files = (await readdir(dir)).filter((n) => n.endsWith(".ts")).sort();
	assert.deepEqual(files, ["digest.ts", "gates.ts", "ids.ts", "index.ts", "lift.ts", "planning.ts", "proofs.ts", "snapshots.ts", "store.ts", "traverse.ts", "types.ts", "validation.ts"]);
	// snapshots (E03) sits beside validation: both consume types/ids/digest and
	// neither imports the other. store (E02) sits above both: it is the one
	// file here that is ALLOWED to touch the filesystem, because persisting
	// records is its entire job, and it consumes the pure layers below it.
	// planning (E04) sits with validation and snapshots: it consumes types and
	// produces markdown, reads no filesystem, and imports neither sibling.
	// proofs (E05) sits ABOVE the store, because ingestion is defined in terms
	// of persisted state: it reads the attempt, slice, and snapshot a proof
	// binds to before accepting it.
	// gates (E06) sits beside proofs: both are defined in terms of persisted
	// state, and neither imports the other.
	// traverse (E08) sits ABOVE gates: it decides the next action from what
	// the records already say, so it reads the store and must not be mistaken
	// for a pure layer. It still executes nothing -- deciding and doing stay
	// apart, which is why it may read the store but imports no child process,
	// no network, and nothing that writes outside the namespace.
	// lift (E09) reads a planning artifact into the record vocabulary. It
	// imports only the id grammar and sits with the other pure readers.
	const layer = { types: 0, ids: 1, digest: 1, validation: 2, snapshots: 2, planning: 2, lift: 2, store: 3, proofs: 4, gates: 4, traverse: 5, index: 6 };
	// Everything except the store must stay pure. Splitting the rule rather
	// than dropping it: a validator that gained a `node:fs` import would
	// still fail, which is the property this test was written for.
	// Two files may touch the filesystem, for different reasons: the store
	// persists records, and proofs resolves an artifact's storage slot to
	// check a `retained` claim. Everything else stays pure, and the rule still
	// bites — a validator that gained a `node:fs` import would still fail.
	// Three files may touch the filesystem: the store persists records, proofs
	// resolves an artifact's slot, and gates enumerates an attempt's proofs and
	// reviews. Note gates reaches fs through a STATIC import on purpose — a
	// dynamic `await import("node:fs/promises")` would slip past this regex
	// entirely, which is evasion rather than compliance.
	const IMPURE = ["index.ts", "store.ts", "proofs.ts", "gates.ts"];
	const PURE = files.filter((f) => !IMPURE.includes(f));
	for (const file of files) {
		const source = await readFile(join(dir, file), "utf8");
		const name = file.slice(0, -3);
		for (const match of source.matchAll(/^(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+"([^"]+)";/gm)) {
			const target = match[1];
			if (target.startsWith("./")) {
				const dep = target.slice(2, -3);
				assert.ok(layer[dep] < layer[name], `${file} imports ${target}, which is not below it`);
				assert.notEqual(dep, "index", `${file} imports the barrel`);
			} else if (name === "store" || name === "proofs" || name === "gates") {
				// The store may reach the filesystem and the shared primitives it
				// would otherwise reimplement: atomic write, transient-error
				// retry, and the workspace lock.
				assert.ok(
					["node:fs/promises", "node:path", "../utils.ts", "../status.ts"].includes(target),
					`${file} imports ${target}; the store and proofs may only use fs, path, and the shared write/lock primitives`,
				);
			} else if (name !== "index") {
				// The only Node modules the contract may touch: hashing and
				// randomness. `../secrets.ts` is the one in-repo exception: the
				// secret-path list is shared with the analysis side so both
				// surfaces withhold the same files, and it is itself pure.
				assert.ok(["node:crypto", "../secrets.ts"].includes(target), `${file} imports ${target}; validators are pure`);
			}
		}
		if (PURE.includes(file)) {
			assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|child_process|node:fs|node:net|node:http/, `${file} reaches outside its arguments`);
		} else {
			// Even the store stays off the network and out of the environment.
			assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|child_process|node:net|node:http/, `${file} reaches beyond the filesystem`);
		}
	}
});

// ---------- enum spellings are the contract ----------

test("enum spellings and prefixes are pinned exactly", () => {
	assert.equal(ENGINEERING_SCHEMA_VERSION, 1);
	assert.deepEqual(RECORD_ID_PREFIXES, { change: "chg", slice: "slc", attempt: "att", snapshot: "snp", proof: "prf", review: "rvw", approval: "apr", artifact: "art", "acceptance-request": "acr" });
	assert.deepEqual(COLLECTORS, ["host-observed", "ci-reported", "manual-observation", "agent-claimed"]);
	assert.deepEqual(OBSERVED_COLLECTORS, ["host-observed", "ci-reported", "manual-observation"]);
	assert.deepEqual(CHANGE_STATES, ["draft", "planned", "active", "blocked", "accepted", "abandoned"]);
	assert.deepEqual(ATTEMPT_OUTCOMES, ["running", "failed", "blocked", "ready-for-review", "needs-human-acceptance", "accepted", "superseded"]);
	assert.deepEqual(APPROVAL_CHANNELS, ["mcp-elicitation", "host-native", "cooperative-file", "agent-declared"]);
	assert.deepEqual(TRUSTED_APPROVAL_CHANNELS, ["mcp-elicitation", "host-native"]);
	assert.deepEqual(CHANGE_ACTIONS, ["create", "status", "plan", "start-attempt", "capture-candidate", "record-proof", "record-review", "check", "request-acceptance"]);
	assert.ok(!CHANGE_ACTIONS.includes("approve"), "no approve action");
	assert.equal(new Set(ENGINEERING_ERROR_CODES).size, ENGINEERING_ERROR_CODES.length);
	assert.deepEqual(
		ACCEPTANCE_REQUIRED_RECORDS.map((r) => r.kind),
		["change", "slice", "attempt", "snapshot", "proof", "review", "approval"],
		"every record kind is required for acceptance",
	);
});

// ---------- ids and paths ----------

test("record ids are prefixed, opaque, and path-safe; paths are built only from valid ids", () => {
	const id = newRecordId("change");
	assert.match(id, /^chg_[0-9a-f]{24}$/);
	assert.ok(isRecordId(id, "change"));
	assert.ok(!isRecordId(id, "slice"), "prefix names the kind");
	assert.equal(recordKindOfId("slc_00000000000000000000e001"), "slice");
	assert.equal(recordKindOfId("xyz_00000000000000000000e001"), null);
	for (const bad of ["chg_../../etc", "chg_00000000000000000000e00", "CHG_00000000000000000000e001", "chg_00000000000000000000E001", "chg_00000000000000000000e001/", "", 42, null]) {
		assert.ok(!isRecordId(bad), `rejects ${JSON.stringify(bad)}`);
	}
	assert.match(newNonce(), /^[0-9a-f]{32}$/);
	assert.notEqual(newRecordId("proof"), newRecordId("proof"));

	const chg = "chg_00000000000000000000c001";
	const att = "att_00000000000000000000a001";
	assert.equal(engineeringPaths.changeRecord(chg), `engineering/changes/${chg}/change.json`);
	assert.equal(engineeringPaths.attemptRecord(chg, att), `engineering/changes/${chg}/attempts/${att}/attempt.json`);
	assert.equal(engineeringPaths.artifact(chg, att, "art_00000000000000000000aa01"), `engineering/changes/${chg}/attempts/${att}/artifacts/art_00000000000000000000aa01`);
	assert.throws(() => engineeringPaths.changeDir("../escape"), /Not a change id/);
	assert.throws(() => engineeringPaths.changeDir("My Change"), /Not a change id/);
	assert.throws(() => engineeringPaths.attemptDir(chg, chg), /Not an? attempt id/);
	assert.throws(() => engineeringPaths.sliceRecord(chg, "slc_00000000000000000000e001/../x"), /Not a slice id/);
});

test("repository-relative paths refuse traversal, separators, absolutes, and control characters", () => {
	for (const good of ["a", "src/x.ts", "a/b/c.d", "dir.with.dots/file", "~/not-home", ".codecarto/engineering/x"]) assert.ok(isRepoRelativePath(good), good);
	for (const bad of ["", "/abs", "a/../b", "../a", "./a", "a//b", "a/", "a\\b", "C:/x", "c:\\x", "a\u0000b", "a\nb", "src/*.ts", "x".repeat(4097)]) {
		assert.ok(!isRepoRelativePath(bad), JSON.stringify(bad));
	}
	assert.ok(isScopePattern("src/**/*.ts"));
	assert.ok(!isScopePattern("../**"));
	assert.ok(!isScopePattern("/**"));
});

// ---------- canonical digests ----------

test("canonical JSON sorts keys, omits undefined, refuses floats, and matches an independent implementation", () => {
	assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
	// Like JCS: only control characters, quotes, and backslashes are escaped; U+2028 and non-ASCII stay raw.
	assert.equal(canonicalJson({ a: undefined, b: "é\u2028\n\"" }), '{"b":"é\u2028\\n\\""}');
	assert.throws(() => canonicalJson({ a: 1.5 }), /non-integer/);
	assert.throws(() => canonicalJson({ a: Number.NaN }), /non-integer/);
	assert.throws(() => canonicalJson([undefined]), /undefined/);
	assert.throws(() => canonicalJson(new Date(0)), /non-plain/);
	const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
	assert.equal(digestOf({ b: 1, a: "x" }), sha('{"a":"x","b":1}'));
	assert.equal(digestOfBytes("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("fixture digests, computed by the generator's own canonical JSON, agree with the core's", () => {
	assert.equal(computeSnapshotDigest(valid.baseline), valid.baseline.digest);
	assert.equal(computeSnapshotDigest(valid.candidate), valid.candidate.digest);
	assert.equal(computeInputDigest(valid.attempt.inputs), valid.attempt.inputs.digest);
	assert.equal(computePresentationDigest(valid.request.presentation), valid.request.presentation_digest);
	// Identity is exactly coverage + manifest + repository: the rest of the snapshot does not move the digest.
	assert.equal(computeSnapshotDigest({ ...valid.candidate, captured_at: "2030-01-01T00:00:00Z", stability: "unstable", id: "snp_ffffffffffffffffffffffff" }), valid.candidate.digest);
	assert.notEqual(computeSnapshotDigest({ ...valid.candidate, repository: { ...valid.candidate.repository, dirty: false } }), valid.candidate.digest);
	const manifest = valid.candidate.manifest.map((e, i) => (i === 3 ? { ...e, executable: false } : e));
	assert.notEqual(computeSnapshotDigest({ ...valid.candidate, manifest }), valid.candidate.digest, "an executable bit is identity");
});

// ---------- valid fixtures ----------

test("every valid record fixture validates, alone and via parseRecord", async () => {
	const files = (await listJson("valid")).filter((n) => !["bundle.json", "acceptance-request.json"].includes(n));
	assert.ok(files.length >= 10);
	for (const file of files) {
		const text = await readFile(join(FIXTURES, "valid", file), "utf8");
		const parsed = parseRecord(text);
		assert.equal(parsed.ok, true, `${file}: ${JSON.stringify(parsed.errors ?? null)}`);
		const again = validateRecord(JSON.parse(text));
		assert.deepEqual(again, parsed, `${file} validates deterministically`);
	}
	assert.equal(validateRecordOfKind("change", valid.minimalChange).ok, true, "a draft change with no scenarios and no references is valid");
	assert.deepEqual(codesAt(validateRecordOfKind("slice", valid.change)), ["invalid-enum /kind"]);
	assert.deepEqual(codesAt(parseRecord("{not json")), ["invalid-request /"]);
});

test("the valid bundle, acceptance request, and every operation request validate", async () => {
	const bundle = validateChangeBundle(valid.bundle);
	assert.equal(bundle.ok, true, JSON.stringify(bundle.errors ?? null));
	assert.equal(bundle.value.proofs.length, 2);
	const request = validateAcceptanceRequest(valid.request);
	assert.equal(request.ok, true, JSON.stringify(request.errors ?? null));
	const requests = await listJson("valid/requests");
	assert.deepEqual(requests.map((n) => n.slice(0, -5)).sort(), [...CHANGE_ACTIONS].sort(), "one request fixture per action");
	for (const file of requests) {
		const result = validateChangeRequest(await readJson(`valid/requests/${file}`));
		assert.equal(result.ok, true, `${file}: ${JSON.stringify(result.errors ?? null)}`);
	}
});

test("the valid approval's receipt binds to the issued request", () => {
	assert.deepEqual(evaluateApprovalReceipt(valid.approval, receiptContext()), { ok: true, accepted: true });
	const rejected = { ...valid.approval, decision: "rejected" };
	assert.equal(validateRecord(rejected).ok, true);
	assert.deepEqual(evaluateApprovalReceipt(rejected, receiptContext()), { ok: true, accepted: false }, "a rejection is a valid receipt that is not an acceptance");
});

// ---------- invalid fixtures ----------

test("every invalid fixture is refused with the expected code at the expected path, deterministically", async () => {
	const files = await listJson("invalid");
	assert.ok(files.length >= 60, `${files.length} negative fixtures`);
	const subjects = new Set();
	for (const file of files) {
		const fixture = await readJson(`invalid/${file}`);
		subjects.add(fixture.subject);
		const run = () => {
			switch (fixture.subject) {
				case "record":
					return validateRecord(fixture.value);
				case "bundle":
					return validateChangeBundle(fixture.value);
				case "request":
				case "request-valid":
					return validateChangeRequest(fixture.value);
				case "receipt":
					return evaluateApprovalReceipt(fixture.value, receiptContext());
				case "receipt-replay":
					return evaluateApprovalReceipt(fixture.value, receiptContext({ consumed_nonces: new Set([valid.approval.receipt.nonce]) }));
				case "receipt-caller-candidate":
					return evaluateApprovalReceipt(fixture.value, receiptContext({ candidate: { ...valid.candidate, attested_by: "caller" } }));
				case "acceptance-request":
					return validateAcceptanceRequest(fixture.value);
				case "acceptance-request-ttl":
					// The client-timeout rule needs the registered integration the
					// receipt resolves to; the 24 h cap in validateAcceptanceRequest
					// does not catch a window this short.
					return checkAcceptanceRequestTtl(fixture.value, { client_request_timeout_ms: 150_000 });
				default:
					throw new Error(`${file}: unknown subject ${fixture.subject}`);
			}
		};
		const first = run();
		assert.deepEqual(run(), first, `${file} is deterministic`);
		if (fixture.subject === "request-valid") {
			assert.equal(first.ok, true, `${file}: ${JSON.stringify(first.errors ?? null)}`);
			continue;
		}
		assert.equal(first.ok, false, `${file} (${fixture.description}) was accepted`);
		const got = first.errors.map((e) => `${e.code} ${e.path}`);
		for (const { code, path } of fixture.expect) {
			assert.ok(got.includes(`${code} ${path}`), `${file}: expected ${code} at ${path}, got ${JSON.stringify(got)}`);
		}
		for (const error of first.errors) {
			assert.ok(ENGINEERING_ERROR_CODES.includes(error.code), `${file}: ${error.code} is not a contract error code`);
			assert.match(error.path, /^\/(?:[^/]+(?:\/[^/]+)*)?$/, `${file}: ${error.path} is a pointer`);
			assert.equal(typeof error.message, "string");
		}
	}
	assert.deepEqual(
		[...subjects].sort(),
		["acceptance-request", "acceptance-request-ttl", "bundle", "receipt", "receipt-caller-candidate", "receipt-replay", "record", "request", "request-valid"],
		"every validator has negative coverage",
	);
});

test("an unsupported schema version is refused without reading the rest of the record", () => {
	const future = { schema_version: 2, kind: "change", id: "chg_../x", nonsense: true };
	assert.deepEqual(codesAt(validateRecord(future)), ["unsupported-schema-version /schema_version"]);
	assert.deepEqual(codesAt(validateRecord({ ...valid.change, schema_version: "1" })), ["unsupported-schema-version /schema_version"]);
	assert.deepEqual(codesAt(validateAcceptanceRequest({ ...valid.request, schema_version: 0 })), ["unsupported-schema-version /schema_version"]);
	assert.deepEqual(codesAt(validateRecord("not an object")), ["invalid-type /"]);
	assert.deepEqual(codesAt(validateRecord(null)), ["invalid-type /"]);
});

// ---------- the approval boundary ----------

test("no agent-authored payload becomes human acceptance", () => {
	// 1. There is no action and no field through which a caller approves.
	assert.deepEqual(codesAt(validateChangeRequest({ action: "approve", change_id: valid.change.id })), ["invalid-action /action"]);
	for (const field of ["approve", "approved", "approval", "decision", "receipt", "human_accepted", "host", "attested_by", "constructor", "__proto__"]) {
		const request = JSON.parse(`{"action":"request-acceptance","change_id":"${valid.change.id}","attempt_id":"${valid.attempt.id}",${JSON.stringify(field)}:true}`);
		assert.ok(codesAt(validateChangeRequest(request)).includes(`unknown-field /${field}`), field);
	}
	// 2. A record spelled by the model is structurally legal but never a trusted receipt.
	const declared = { ...valid.approval, receipt: { ...valid.approval.receipt, channel: "agent-declared", authenticated: "none", attestation: "approve: true appeared in the tool call" } };
	assert.equal(validateRecord(declared).ok, true, "the record is kept so the refusal can name it");
	assert.deepEqual(codesAt(evaluateApprovalReceipt(declared, receiptContext())), ["untrusted-channel /receipt/channel"]);
	// 3. Nor can it claim authentication it does not have.
	const overclaim = { ...declared, receipt: { ...declared.receipt, authenticated: "host-session" } };
	assert.deepEqual(codesAt(validateRecord(overclaim)), ["invalid-value /receipt/authenticated"]);
	// 4. A hand-written file is a cooperative note.
	const cooperative = { ...valid.approval, receipt: { ...valid.approval.receipt, channel: "cooperative-file", authenticated: "none" } };
	assert.deepEqual(codesAt(evaluateApprovalReceipt(cooperative, receiptContext())), ["untrusted-channel /receipt/channel"]);
});

test("a receipt is single-use and bound to one request, candidate, and presentation", () => {
	const ctx = receiptContext();
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, consumed_nonces: [valid.approval.receipt.nonce] })), ["receipt-replayed /receipt/nonce"]);
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, request: undefined })), ["receipt-unknown-request /receipt/request_id"]);
	// The stored candidate record was replaced by one with the same id and different bytes.
	const rewritten = { ...valid.candidate, repository: { ...valid.candidate.repository, dirty: false } };
	rewritten.digest = computeSnapshotDigest(rewritten);
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, candidate: rewritten })), ["receipt-mismatch /candidate_digest"]);
	// The attempt was re-pointed at another candidate.
	const rebound = { ...valid.attempt, candidate_snapshot_id: "snp_00000000000000000000d002" };
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, attempt: rebound })), ["receipt-mismatch /candidate_snapshot_id"]);
	// The inputs changed after review.
	const replanned = { ...valid.attempt.inputs, plan_digest: digestOfBytes("a revised plan") };
	const newInputs = { ...valid.attempt, inputs: { ...replanned, digest: computeInputDigest(replanned) } };
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, attempt: newInputs })), ["receipt-mismatch /input_digest"]);
	// The request was issued for another change.
	const otherChange = { ...valid.request, change_id: "chg_00000000000000000000c002" };
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, request: otherChange })), ["cross-change-reference /change_id"]);
	// The tree was moving while captured.
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, candidate: { ...valid.candidate, stability: "unstable" } })), ["invalid-value /candidate_snapshot_id"]);
	// Several mismatches are all reported, once each, in a fixed order.
	const mangled = { ...valid.approval, slice_id: "slc_00000000000000000000e002", input_digest: digestOf(1) };
	assert.deepEqual(codesAt(evaluateApprovalReceipt(mangled, ctx)), ["receipt-mismatch /slice_id", "receipt-mismatch /input_digest"]);
	// Inputs are re-validated: garbage timestamps cannot slip past NaN comparisons.
	const garbage = { ...valid.approval, decided_at: "garbage" };
	assert.deepEqual(codesAt(evaluateApprovalReceipt(garbage, ctx)), ["invalid-request /"]);
	assert.deepEqual(codesAt(evaluateApprovalReceipt(valid.approval, { ...ctx, request: { ...valid.request, nonce: "short" } })), ["invalid-request /receipt/request_id"]);
	// The adapter's own re-read is the freshness check; a moved tree is a digest mismatch and nothing carries over.
	assert.equal(checkCandidateFreshness(valid.candidate, valid.candidate).ok, true);
	const moved = { ...valid.candidate, repository: { ...valid.candidate.repository, dirty: false } };
	assert.deepEqual(codesAt(checkCandidateFreshness(valid.candidate, moved)), ["digest-mismatch /digest"]);
});

test("buildAcceptanceRequest reproduces the fixture request byte for byte and refuses an unbound candidate", () => {
	const built = buildAcceptanceRequest({
		id: valid.request.id,
		nonce: valid.request.nonce,
		issued_at: valid.request.issued_at,
		expires_at: valid.request.expires_at,
		change: valid.change,
		slice: valid.slice,
		attempt: valid.attempt,
		candidate: valid.candidate,
		proofs: [valid.proof, valid.proof2],
		reviews: [valid.review],
		assurance: "verified",
		storage_boundary: "host-enforced",
		limitations: ["No CI run exists for this candidate."],
	});
	assert.deepEqual(built, valid.request);
	const std = (proofs, extra = {}) => standardLimitations({ proofs, reviews: [], assurance: "verified", storage_boundary: "host-enforced", ...extra });
	assert.deepEqual(std([valid.proof]), []);
	assert.match(std([valid.proofClaimed])[0], /^1 of 1 proofs are caller-reported claims/, "a claim is always disclosed");
	assert.match(std([], { assurance: "cooperative" })[0], /cooperative policy/);
	assert.match(std([], { storage_boundary: "none" })[0], /writable by agent tools/);
	assert.equal(ACCEPTANCE_REQUEST_MAX_TTL_MS, 24 * 60 * 60 * 1000);
	assert.equal(validateAcceptanceRequest(built).ok, true);
	assert.throws(() => buildAcceptanceRequest({ ...builtArgs(built), candidate: valid.baseline }), /not the attempt's bound candidate/);
	function builtArgs() {
		return { id: built.id, nonce: built.nonce, issued_at: built.issued_at, expires_at: built.expires_at, change: valid.change, slice: valid.slice, attempt: valid.attempt, candidate: valid.candidate, proofs: [], reviews: [], assurance: "verified", storage_boundary: "host-enforced", limitations: [] };
	}
});

// ---------- proof and review semantics ----------

test("agent-claimed is a legal collector that satisfies no obligation, and deferred blockers still block", () => {
	const claimed = { ...valid.proofClaimed, collector: "agent-claimed", check: { kind: "test" } };
	delete claimed.exit_code;
	assert.equal(validateRecord(claimed).ok, true, "a claim is kept so it can be contradicted");
	assert.equal(validateRecord({ ...valid.proof, collector: "agent-claimed", check: { kind: "test" }, exit_code: undefined }).ok, false, "a tool layer cannot attest an agent claim");
	assert.ok(!OBSERVED_COLLECTORS.includes("agent-claimed"));
	assert.deepEqual(codesAt(validateRecord({ ...valid.slice, proof_obligations: [{ ...valid.slice.proof_obligations[0], minimum_collector: "agent-claimed" }] })), ["invalid-enum /proof_obligations/0/minimum_collector"]);
	assert.deepEqual(COLLECTOR_RANK, { "host-observed": 3, "ci-reported": 2, "manual-observation": 1, "agent-claimed": 0 });
	for (const minimum of COLLECTORS) assert.equal(collectorSatisfies("agent-claimed", minimum), false, `agent-claimed never satisfies ${minimum}`);
	for (const actual of COLLECTORS) assert.equal(collectorSatisfies(actual, "agent-claimed"), false, `${actual} satisfies no agent-claimed minimum`);
	assert.equal(collectorSatisfies("host-observed", "manual-observation"), true);
	assert.equal(collectorSatisfies("ci-reported", "host-observed"), false);
	assert.equal(collectorSatisfies("manual-observation", "manual-observation"), true);
	assert.deepEqual(deriveRemainingBlockers(valid.review.objections), []);
	assert.deepEqual(deriveRemainingBlockers([{ id: "A", severity: "blocking", disposition: "deferred" }, { id: "B", severity: "advisory", disposition: "open" }, { id: "C", severity: "blocking", disposition: "open" }]), ["A", "C"]);
});

// ---------- claims versus observations ----------

test("a collector label never elevates a caller-reported record: authority comes from attestation", () => {
	assert.deepEqual(ATTESTATIONS, ["adapter", "host-tool-result", "caller"]);
	assert.deepEqual(OBSERVING_ATTESTATIONS, ["adapter", "host-tool-result"]);
	const obligation = valid.slice.proof_obligations[0];
	const claim = valid.proofClaimed;
	assert.equal(claim.provenance.attested_by, "caller");
	assert.equal(validateRecord(claim).ok, true, "the claim is retained as a record");
	for (const collector of COLLECTORS) {
		const relabelled = { ...claim, collector };
		assert.equal(proofAuthority(relabelled), "claimed", `${collector} on a caller-reported record is still a claim`);
		assert.equal(proofDischarges(relabelled, obligation, "verified"), false, `${collector} claim discharges nothing under verified`);
	}
	// The identical check delivered by the host's tool layer is an observation.
	assert.equal(proofAuthority(valid.proof), "observed");
	assert.equal(valid.proof.provenance.attested_by, "host-tool-result");
	assert.equal(proofDischarges(valid.proof, obligation, "verified"), true);
	// An observing attestation does not launder an agent-claimed collector, a failure, or the wrong obligation.
	assert.equal(proofAuthority({ ...valid.proof, collector: "agent-claimed" }), "claimed");
	// And the attestation must be able to vouch for that kind of check: a tool layer sees tool results only, the adapter runs nothing.
	assert.deepEqual(codesAt(validateRecord({ ...valid.proof, collector: "ci-reported", provenance: { ...valid.proof.provenance, run_reference: "run 1" } })), ["invalid-value /provenance/attested_by"]);
	assert.deepEqual(codesAt(validateRecord({ ...valid.proof, provenance: { source: "mcp-server", attested_by: "adapter" } })), ["invalid-value /provenance/attested_by"]);
	assert.equal(proofDischarges({ ...valid.proof, result: "failed" }, obligation, "cooperative"), false);
	assert.equal(proofDischarges(valid.proof, valid.slice.proof_obligations[1], "cooperative"), false);
	// Only the separately-approved cooperative policy lets a claim discharge, and it never becomes "observed".
	assert.equal(proofDischarges(claim, obligation, "cooperative"), true);
	assert.equal(proofAuthority(claim), "claimed");
	// The caller cannot vouch for itself on the way in.
	const smuggled = { action: "record-proof", change_id: valid.change.id, attempt_id: valid.attempt.id, proof: { ...stripProof(claim), provenance: { source: "x", attested_by: "host-tool-result" } } };
	assert.ok(codesAt(validateChangeRequest(smuggled)).includes("unknown-field /proof/provenance/attested_by"));
});

function stripProof(proof) {
	const { schema_version, kind, id, created_at, change_id, attempt_id, ...input } = proof;
	return input;
}

test("a trusted channel is a proposal until the host/client pair passes the integration check", () => {
	assert.deepEqual(VERIFIED_ACCEPTANCE_INTEGRATIONS, [], "no integration has been verified yet");
	const base = { human_acceptance: "mcp-elicitation", label: "mcp-server", client: { name: "claude-code", version: "2.1.277" }, verified_integration: false, storage_boundary: "host-enforced", assurance_policy: "verified" };
	assert.equal(acceptanceChannelSupported(base).supported, false);
	assert.match(acceptanceChannelSupported(base).reason, /not a verified integration/);
	// The adapter asserting it is verified does not make it so; the registry does.
	assert.equal(acceptanceChannelSupported({ ...base, verified_integration: true }).supported, false);
	assert.equal(acceptanceChannelSupported({ ...base, human_acceptance: "host-native", label: "pi" }).supported, false);
	assert.deepEqual(acceptanceChannelSupported({ ...base, human_acceptance: "none" }), { supported: false, reason: "the host declares no human-acceptance channel" });
	// Version drift: the D1 live check ran on 2.1.277 three minutes after the host updated itself from 2.1.263.
	const entry = { host: "mcp-server", client: "claude-code", client_version: "2.1.263", channel: "mcp-elicitation", client_request_timeout_ms: 150_000, evidence: "test-only" };
	const verified = { ...base, verified_integration: true };
	const drifted = acceptanceChannelSupported(verified, [entry]);
	assert.equal(drifted.supported, false);
	assert.match(drifted.reason, /registered for version 2\.1\.263 but the live client is 2\.1\.277/);
	assert.equal(acceptanceChannelSupported({ ...verified, client: { name: "claude-code" } }, [entry]).supported, false, "no live version reported");
	const exact = acceptanceChannelSupported(verified, [{ ...entry, client_version: "2.1.277" }]);
	assert.equal(exact.supported, true);
	assert.equal(exact.integration.client_version, "2.1.277");
	// A stale-version receipt classifies cooperative even with the pair registered at another version.
	const ctxV = { ...receiptContext(), current_storage: { boundary: "host-enforced", enforced_since: "2026-09-17T09:00:00Z", protection: "continuous-since-initialization" } };
	assert.equal(classifyAcceptance(valid.approval, { ...ctxV, integrations: [entry] }).class, "cooperative", "receipt says 2.1.277, registry says 2.1.263");
	assert.equal(classifyAcceptance(valid.approval, { ...ctxV, integrations: [{ ...entry, client_version: "2.1.277" }] }).class, "verified");
	// The TTL must fit inside the client's observed request timeout, or a timeout is indistinguishable from a late answer.
	const req = (secs) => ({ issued_at: "2026-09-18T21:30:00Z", expires_at: new Date(Date.parse("2026-09-18T21:30:00Z") + secs * 1000).toISOString().replace(/\.000Z$/, "Z") });
	assert.equal(acceptanceTtlWithin(req(120), entry), true);
	assert.equal(acceptanceTtlWithin(req(150), entry), false, "equal to the timeout is not within it");
	assert.equal(acceptanceTtlWithin(req(600), entry), false);
	assert.equal(acceptanceTtlWithin(req(60), { ...entry, client_request_timeout_ms: undefined }), false, "an unmeasured timeout fails closed");
	// The rule is enforced, not merely offered: classifyAcceptance calls
	// checkAcceptanceRequestTtl itself, so no adapter can skip it.
	const okEntry = { ...entry, client_version: "2.1.277" };
	const ttlCtx = (request, integration, integrations) => ({
		...receiptContext({ request }),
		current_storage: { boundary: "host-enforced", enforced_since: "2026-09-17T09:00:00Z", protection: "continuous-since-initialization" },
		integrations: integrations ?? [integration],
	});
	assert.deepEqual(classifyAcceptance(valid.approval, ttlCtx(valid.request, okEntry)), { class: "verified", reasons: [] }, "the fixture request fits inside the client's timeout");
	const longRequest = { ...valid.request, expires_at: "2026-09-17T11:40:00Z" };
	const tooLong = classifyAcceptance(valid.approval, ttlCtx(longRequest, okEntry));
	assert.equal(tooLong.class, "cooperative", "a window outliving the client's timeout cannot read as verified");
	assert.match(tooLong.reasons.join(" "), /is not shorter than the client's 150000 ms request timeout/);
	const unmeasured = classifyAcceptance(valid.approval, ttlCtx(valid.request, { ...okEntry, client_request_timeout_ms: undefined }));
	assert.equal(unmeasured.class, "cooperative", "an unmeasured client request timeout bounds nothing");
	assert.match(unmeasured.reasons.join(" "), /records no usable client_request_timeout_ms/);
	// A timeout that is not a finite positive number is not a measurement: a
	// numeric string, Infinity, or a one-element array would each coerce past
	// `<` and read verified if the shape were assumed instead of checked.
	for (const bogus of ["999999999", Infinity, [999_999_999], Number.NaN, 0, -1]) {
		const c = classifyAcceptance(valid.approval, ttlCtx(longRequest, { ...okEntry, client_request_timeout_ms: bogus }));
		assert.equal(c.class, "cooperative", `client_request_timeout_ms ${JSON.stringify(bogus)}`);
	}
	// Duplicate registrations must not let array order pick the generous entry,
	// and the strictest measured timeout is the one that binds.
	const generous = { ...okEntry, client_request_timeout_ms: 86_400_000 };
	const dup = classifyAcceptance(valid.approval, ttlCtx(longRequest, generous, [generous, okEntry]));
	assert.equal(dup.class, "cooperative", "a 60-minute window cannot read verified because a duplicate entry is generous");
	assert.match(dup.reasons.join(" "), /2 registry entries match/);
	const unmeasuredSibling = classifyAcceptance(valid.approval, ttlCtx(valid.request, okEntry, [okEntry, { ...okEntry, client_request_timeout_ms: undefined }]));
	assert.equal(unmeasuredSibling.class, "cooperative", "an unmeasured sibling cannot be sidestepped by a measured one, whatever the order");
	// The strictest entry binds independently of the duplicate-tuple refusal:
	// entries differing only in a field outside the tuple are one registration
	// each, so order must not decide which timeout applies.
	const byChannelAlias = { ...okEntry, client_request_timeout_ms: 86_400_000, evidence: "a second registration of the same pair" };
	for (const order of [
		[byChannelAlias, okEntry],
		[okEntry, byChannelAlias],
	]) {
		const c = classifyAcceptance(valid.approval, ttlCtx(longRequest, undefined, order));
		assert.equal(c.class, "cooperative", "order must not change the reading");
		assert.match(c.reasons.join(" "), /is not shorter than the client's 150000 ms request timeout/, "the strictest measured timeout is the one enforced, whichever entry came first");
	}
	// And the predicate's own refusals are reported as errors by the enforcement form.
	assert.equal(checkAcceptanceRequestTtl(valid.request, okEntry).ok, true);
	assert.equal(checkAcceptanceRequestTtl(undefined, okEntry).ok, false, "no request fails closed");
	assert.equal(checkAcceptanceRequestTtl(longRequest, okEntry).errors[0].path, "/expires_at");
	for (const field of ["assurance", "verified_integration", "storage", "storage_boundary", "assurance_policy"]) {
		assert.ok(codesAt(validateChangeRequest({ action: "request-acceptance", change_id: valid.change.id, attempt_id: valid.attempt.id, [field]: "verified" })).includes(`unknown-field /${field}`), field);
	}
});

test("the decision derives only from content.decision; action alone never authorizes; timeout is its own outcome", async () => {
	assert.deepEqual(ELICITATION_OUTCOMES, ["accepted", "rejected", "declined", "cancelled", "timed-out", "invalid"]);
	const files = await listJson("valid/elicitation");
	assert.ok(files.length >= 10);
	const seen = new Set();
	for (const file of files) {
		const fixture = await readJson(`valid/elicitation/${file}`);
		assert.equal(elicitationDecision(fixture.response), fixture.outcome, `${file}: ${fixture.description}`);
		assert.equal(elicitationDecision(fixture.response), elicitationDecision(fixture.response), "deterministic");
		seen.add(fixture.outcome);
	}
	assert.deepEqual([...seen].sort(), [...ELICITATION_OUTCOMES].sort(), "every outcome has a fixture");
	// The three shapes from the live check, verbatim.
	assert.equal(elicitationDecision({ action: "accept", content: { decision: "accept" } }), "accepted");
	assert.equal(elicitationDecision({ action: "accept", content: { decision: "reject" } }), "rejected", "action accept + decision reject is a rejection");
	assert.equal(elicitationDecision({ action: "decline" }), "declined");
	assert.equal(elicitationDecision({ threw: "MCP error -32001: Request timed out" }), "timed-out");
	// Only `accepted` may mint an acceptance; nothing else is one.
	for (const outcome of ELICITATION_OUTCOMES) if (outcome !== "accepted") assert.notEqual(outcome, "accepted");
});

test("channel trust and at-rest trust are separate: a real UI decision in a writable namespace is cooperative", () => {
	assert.deepEqual(ASSURANCE_POLICIES, ["verified", "cooperative"]);
	const enforced = { boundary: "host-enforced", enforced_since: "2026-09-17T09:00:00Z", protection: "continuous-since-initialization" };
	const registry = [{ host: "mcp-server", client: "claude-code", client_version: "2.1.277", channel: "mcp-elicitation", client_request_timeout_ms: 150_000, evidence: "test-only registry entry" }];
	const ctx = (storage, extra = {}) => ({ ...receiptContext(), current_storage: storage, ...extra });
	// Against the contract's own (empty) registry nothing is verified today, even the fixture approval.
	const today = classifyAcceptance(valid.approval, ctx(enforced));
	assert.equal(today.class, "cooperative");
	assert.match(today.reasons[0], /not in VERIFIED_ACCEPTANCE_INTEGRATIONS now/);
	// With the pair registered and a boundary enforced before the decision, the full path holds.
	assert.deepEqual(classifyAcceptance(valid.approval, ctx(enforced, { integrations: registry })), { class: "verified", reasons: [] });
	// The same record read by a host whose namespace agent tools can write.
	const now = classifyAcceptance(valid.approval, ctx({ boundary: "none" }, { integrations: registry }));
	assert.equal(now.class, "cooperative");
	assert.match(now.reasons[0], /not host-enforced now/);
	// A decision earlier than the boundary's own epoch is inconsistent with continuous protection: a consistency check that can only lower trust.
	const late = classifyAcceptance(valid.approval, ctx({ ...enforced, enforced_since: "2026-09-17T11:00:00Z" }, { integrations: registry }));
	assert.equal(late.class, "cooperative");
	assert.match(late.reasons[0], /before the boundary was enforced/);
	// A forged record claiming host-enforced storage and a verified integration is still cooperative under a boundary of none.
	const forged = { ...valid.approval, storage: { boundary: "host-enforced", note: "forged" } };
	assert.equal(classifyAcceptance(forged, ctx({ boundary: "none" }, { integrations: registry })).class, "cooperative");
	// A de-verified pair downgrades old approvals: the receipt's own boolean is not trusted.
	assert.equal(classifyAcceptance(valid.approval, ctx(enforced, { integrations: [{ ...registry[0], client: "other-client" }] })).class, "cooperative");
	// Malformed current storage fails closed.
	assert.equal(classifyAcceptance(valid.approval, ctx({ boundary: "host-enforced" }, { integrations: registry })).class, "cooperative");
	assert.equal(classifyAcceptance(valid.approval, ctx({ boundary: "host-enforced", enforced_since: enforced.enforced_since }, { integrations: registry })).class, "cooperative", "protection omitted");
	assert.equal(classifyAcceptance(valid.approval, ctx(undefined, { integrations: registry })).class, "cooperative");
	// A record minted over an unprotected namespace cannot even be written as verified …
	assert.deepEqual(codesAt(validateRecord({ ...valid.approval, storage: { boundary: "none", note: "n" } })), ["invalid-value /storage/boundary"]);
	// … and the honestly-labelled cooperative record is valid, binds correctly, and classifies as cooperative everywhere.
	assert.equal(validateRecord(valid.approvalCooperative).ok, true);
	assert.deepEqual(evaluateApprovalReceipt(valid.approvalCooperative, receiptContext()), { ok: true, accepted: true }, "the receipt binding itself is sound");
	const coop = classifyAcceptance(valid.approvalCooperative, ctx(enforced, { integrations: registry }));
	assert.equal(coop.class, "cooperative");
	// The fourth reason is the disclosure check: this fixture reuses the
	// verified request, so the presentation claims a stronger policy than the
	// record was minted under — exactly the mismatch a person must not be
	// shown. A real cooperative request would present `cooperative`.
	assert.equal(coop.reasons.length, 4, "unverified integration, cooperative policy, unprotected at mint, presentation overstated the policy");
	assert.match(coop.reasons.join(" "), /withheld 2 required disclosure\(s\) from the person who answered/);
	// A receipt that does not bind is invalid, not cooperative.
	assert.equal(classifyAcceptance({ ...valid.approval, decision: "rejected" }, ctx(enforced, { integrations: registry })).class, "invalid");
	assert.equal(classifyAcceptance(valid.approval, ctx(enforced, { integrations: registry, consumed_nonces: [valid.approval.receipt.nonce] })).class, "invalid");
	// The presentation discloses a candidate that could not bind a verified acceptance.
	const weak = standardLimitations({ proofs: [], reviews: [], candidate: { ...valid.candidate, attested_by: "caller" }, assurance: "verified", storage_boundary: "host-enforced" });
	assert.match(weak[0], /candidate snapshot is caller-attested/);
	// "verified" is the only spelling of verified: the presentation carries the policy and every proof's authority.
	assert.equal(valid.request.presentation.assurance, "verified");
	assert.ok(valid.request.presentation.proof_summary.every((p) => p.authority === "observed"));
});

test("the presentation a person answered must have disclosed what the acceptance is read under", () => {
	const enforced = { boundary: "host-enforced", enforced_since: "2026-09-17T09:00:00Z", protection: "continuous-since-initialization" };
	const registry = [{ host: "mcp-server", client: "claude-code", client_version: "2.1.277", channel: "mcp-elicitation", client_request_timeout_ms: 150_000, evidence: "test-only registry entry" }];
	const honest = { proofs: [], reviews: [], candidate: valid.candidate, assurance: "verified", storage_boundary: "host-enforced" };
	// The fixture request is honest for its own state.
	assert.equal(checkPresentationDisclosure(valid.request, honest).ok, true);
	// A presentation that hides a required line is refused, even though its
	// digest is recomputed correctly and the receipt binds to it: the binding
	// proves the person saw *a* presentation, not an honest one.
	const claimedProof = { ...valid.proof, provenance: { ...valid.proof.provenance, attested_by: "caller" } };
	const required = standardLimitations({ ...honest, proofs: [claimedProof] });
	assert.ok(required.length > 0, "a caller-reported proof must be disclosed");
	const silent = { ...valid.request, presentation: { ...valid.request.presentation, limitations: [] } };
	silent.presentation_digest = computePresentationDigest(silent.presentation);
	assert.equal(validateAcceptanceRequest(silent).ok, true, "byte-level the dishonest request is well formed");
	const hidden = checkPresentationDisclosure(silent, { ...honest, proofs: [claimedProof] });
	assert.equal(hidden.ok, false);
	assert.equal(hidden.errors[0].path, "/presentation/limitations");
	assert.match(hidden.errors[0].message, /withheld 1 required disclosure/);
	// classifyAcceptance enforces it, so no adapter can mint around it.
	const ctx = (request) => ({ ...receiptContext({ request }), current_storage: enforced, integrations: registry });
	assert.deepEqual(classifyAcceptance(valid.approval, ctx(valid.request)), { class: "verified", reasons: [] });
	const overstated = { ...valid.request, presentation: { ...valid.request.presentation, assurance: "cooperative", limitations: [] } };
	overstated.presentation_digest = computePresentationDigest(overstated.presentation);
	const rebound = { ...valid.approval, receipt: { ...valid.approval.receipt, presentation_digest: overstated.presentation_digest } };
	const misread = classifyAcceptance(rebound, ctx(overstated));
	assert.equal(misread.class, "cooperative", "a presentation naming another policy cannot read as verified");
	assert.match(misread.reasons.join(" "), /presentation said the decision was asked under the cooperative policy/);
	// Malformed or absent presentations fail closed.
	assert.equal(checkPresentationDisclosure(undefined, honest).ok, false);
	assert.equal(checkPresentationDisclosure({ presentation: { ...valid.request.presentation, limitations: "none" } }, honest).ok, false);
	assert.equal(checkPresentationDisclosure({ presentation: { ...valid.request.presentation, limitations: [1] } }, honest).ok, false);
	// Disclosing more than required is allowed; disclosing less is not.
	const extra = { presentation: { ...valid.request.presentation, limitations: [...valid.request.presentation.limitations, "The host also notes something else."] } };
	assert.equal(checkPresentationDisclosure(extra, honest).ok, true);
	// A reader that cannot supply the bound records cannot re-derive the whole
	// disclosure, so it may not read `verified`. Narrowing the check to the
	// derivable lines would restore the bypass: the same empty-limitations
	// request would pass because no proof line was ever required.
	const full = { ...receiptContext({ request: silent }), current_storage: enforced, integrations: registry };
	const reboundSilent = { ...valid.approval, receipt: { ...valid.approval.receipt, presentation_digest: silent.presentation_digest } };
	const { proofs: _p, reviews: _r, ...withoutRecords } = full;
	const blind = classifyAcceptance(reboundSilent, withoutRecords);
	assert.equal(blind.class, "cooperative", "omitting proofs/reviews degrades the reading, it does not skip the check");
	assert.match(blind.reasons.join(" "), /proofs and reviews were not supplied/);
	assert.equal(classifyAcceptance(reboundSilent, { ...full, proofs: [claimedProof] }).class, "cooperative", "and supplying them catches the withheld line");
});

test("protection must precede authoritative initialization: a pair forged while unprotected cannot be laundered by later protection, whatever times it carries", () => {
	assert.deepEqual(PROTECTION_HISTORIES, ["continuous-since-initialization", "enabled-after-initialization", "interrupted", "imported-history"]);
	assert.deepEqual(TOOL_RESULT_PATHS, ["protected", "unprotected", "none"]);
	const registry = [{ host: "mcp-server", client: "claude-code", client_version: "2.1.277", channel: "mcp-elicitation", client_request_timeout_ms: 150_000, evidence: "test-only registry entry" }];
	// The agent, while the namespace is writable, pre-writes a request/approval
	// pair whose issued and decided times are AFTER the epoch at which the
	// operator will later enable protection. Every timestamp it needs is inside
	// the records it is writing.
	const epoch = "2026-09-19T00:00:00Z";
	// A 120 s window, as the client-timeout rule requires: this test is about
	// protection history, and a TTL refusal here would mask what it proves.
	const forgedRequest = { ...valid.request, issued_at: "2026-09-20T12:00:00Z", expires_at: "2026-09-20T12:02:00Z" };
	const forgedApproval = {
		...valid.approval,
		decided_at: "2026-09-20T12:01:00Z",
		receipt: { ...valid.approval.receipt, issued_at: "2026-09-20T12:00:00Z", responded_at: "2026-09-20T12:01:00Z", verified_integration: true },
		storage: { boundary: "host-enforced", note: "forged while unprotected" },
	};
	assert.equal(validateRecord(forgedApproval).ok, true, "byte-level the forgery is a well-formed record");
	assert.equal(validateAcceptanceRequest(forgedRequest).ok, true);
	const base = { ...receiptContext(), request: forgedRequest, integrations: registry };
	// Protection is then enabled on the existing namespace. The record-internal
	// times post-date the epoch, so a timestamp comparison alone would pass.
	const enabledLater = classifyAcceptance(forgedApproval, { ...base, current_storage: { boundary: "host-enforced", enforced_since: epoch, protection: "enabled-after-initialization" } });
	assert.equal(enabledLater.class, "cooperative");
	assert.match(enabledLater.reasons[0], /^protection history is enabled-after-initialization/);
	assert.ok(!enabledLater.reasons.some((r) => /before the boundary/.test(r)), "the timestamp check is not what refuses it");
	// Nor does an interrupted boundary or imported history, and omitting the history fails closed.
	for (const protection of ["interrupted", "imported-history", undefined, null, true, "bogus"]) {
		const result = classifyAcceptance(forgedApproval, { ...base, current_storage: { boundary: "host-enforced", enforced_since: epoch, protection } });
		assert.equal(result.class, "cooperative", `protection ${protection}`);
		assert.match(result.reasons[0], PROTECTION_HISTORIES.includes(protection) ? /^protection history is / : /^protection history is not declared/);
	}
	// Only a namespace initialized under protection that never lapsed is eligible — and then the forgery could not have been written.
	assert.deepEqual(classifyAcceptance(forgedApproval, { ...base, current_storage: { boundary: "host-enforced", enforced_since: epoch, protection: "continuous-since-initialization" } }), { class: "verified", reasons: [] }, "with continuous protection the record is by construction not a forgery; the host's attestation, not the record, carries this");
	// The same holds for the genuine fixture: continuity is required, not just an early epoch.
	assert.equal(classifyAcceptance(valid.approval, { ...receiptContext(), integrations: registry, current_storage: { boundary: "host-enforced", enforced_since: "2026-09-17T09:00:00Z", protection: "imported-history" } }).class, "cooperative");
	// Nothing in a request can set the protection history or the tool-result path.
	for (const field of ["current_storage", "protection", "tool_result_path"]) {
		assert.ok(codesAt(validateChangeRequest({ action: "status", [field]: "continuous-since-initialization" })).includes(`unknown-field /${field}`), field);
	}
});

test("host-tool-result attestation requires a protected ingestion path; anything else is a claim", () => {
	assert.equal(attestationForHostObservation({ tool_result_path: "protected" }), "host-tool-result");
	assert.equal(attestationForHostObservation({ tool_result_path: "unprotected" }), "caller");
	assert.equal(attestationForHostObservation({ tool_result_path: "none" }), "caller");
	assert.equal(attestationForHostObservation({}), "caller", "an undeclared path is not a protected one");
	// And what that attestation yields on the record is then a claim, not an observation.
	const viaUnprotectedHook = { ...valid.proof, provenance: { source: "claude-code:post-tool-use-hook", attested_by: attestationForHostObservation({ tool_result_path: "unprotected" }) } };
	assert.equal(proofAuthority(viaUnprotectedHook), "claimed");
	assert.equal(proofDischarges(viaUnprotectedHook, valid.slice.proof_obligations[0], "verified"), false);
});

test("state transitions are a closed table", () => {
	assert.equal(isAllowedTransition("change", "draft", "planned"), true);
	assert.equal(isAllowedTransition("change", "draft", "accepted"), false);
	assert.equal(isAllowedTransition("change", "active", "active"), false, "same state is not a transition");
	assert.equal(isAllowedTransition("change", "accepted", "active"), false, "accepted is terminal");
	assert.equal(isAllowedTransition("slice", "pending", "active"), true);
	assert.equal(isAllowedTransition("attempt", "running", "accepted"), false, "an attempt is never accepted straight from running");
	assert.equal(isAllowedTransition("attempt", "failed", "superseded"), true);
	assert.equal(isAllowedTransition("attempt", "nonsense", "failed"), false);
	for (const table of [CHANGE_STATE_TRANSITIONS, ATTEMPT_OUTCOME_TRANSITIONS]) {
		for (const [from, next] of Object.entries(table)) assert.ok(!next.includes(from), `${from} does not transition to itself`);
	}
	assert.deepEqual(CHANGE_STATE_TRANSITIONS.accepted, []);
	assert.deepEqual(ATTEMPT_OUTCOME_TRANSITIONS.accepted, []);
});

test("timestamps are RFC 3339 UTC instants", () => {
	for (const good of ["2026-09-17T10:00:00Z", "2026-09-17T10:00:00.123Z", "2024-02-29T00:00:00Z"]) assert.ok(isTimestamp(good), good);
	for (const bad of ["2026-09-17T10:00:00", "2026-09-17T10:00:00+02:00", "2026-09-17 10:00:00Z", "2026-02-30T00:00:00Z", "2023-02-29T00:00:00Z", 1726567200, ""]) assert.ok(!isTimestamp(bad), JSON.stringify(bad));
});

test("the fixture generator is independent of core/engineering/ and reproduces the committed fixtures", async () => {
	const generator = await readFile(join(FIXTURES, "generate.mjs"), "utf8");
	for (const match of generator.matchAll(/from\s+"([^"]+)"/g)) assert.match(match[1], /^node:/, `the generator imports ${match[1]}; it computes its own digests`);
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const { mkdtemp, cp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const scratch = await mkdtemp(join(tmpdir(), "codecarto-e01-"));
	try {
		await cp(join(FIXTURES, "generate.mjs"), join(scratch, "generate.mjs"));
		await promisify(execFile)(process.execPath, [join(scratch, "generate.mjs")]);
		for (const dir of ["valid", "valid/requests", "invalid"]) {
			const names = (await readdir(join(scratch, dir))).filter((n) => n.endsWith(".json")).sort();
			assert.deepEqual(names, await listJson(dir), `${dir} inventory`);
			for (const name of names) {
				assert.equal(await readFile(join(scratch, dir, name), "utf8"), await readFile(join(FIXTURES, dir, name), "utf8"), `${dir}/${name} is what the generator writes`);
			}
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

// --- R11: the class sweep on a review objection --------------------------
// Three consecutive review rounds closed the reported instance and left a
// sibling of the same kind one identifier away. The record now carries the
// sweep, and the validator refuses the shapes that would let it be claimed
// without being done.

test("a class sweep is refused when it would be satisfiable without doing the work", () => {
	const review = valid.review;
	const sweep = (value) => {
		const candidate = structuredClone(review);
		candidate.objections[0].class_sweep = value;
		return validateRecord(candidate);
	};

	// The honest shape passes.
	assert.equal(
		sweep({
			class_statement: "environment-reachable git configuration sources",
			instances: [
				{ locus: "GIT_CONFIG_GLOBAL", disposition: "closed" },
				{ locus: "GIT_CONFIG_SYSTEM", disposition: "closed" },
				{ locus: "GIT_CONFIG_COUNT", disposition: "closed" },
				{ locus: "GIT_CONFIG_PARAMETERS", disposition: "closed" },
				{ locus: "GIT_TEMPLATE_DIR", disposition: "out-of-scope", note: "not configuration; tracked separately" },
			],
		}).ok,
		true,
	);

	// A sweep that enumerated nothing is not a sweep.
	const empty = sweep({ class_statement: "inputs reaching the digest unvalidated", instances: [] });
	assert.equal(empty.ok, false);
	// Message comes from the shared `arrayOf({ nonEmpty: true })` combinator
	// now that this is not hand-rolled; assert the path so the test pins
	// WHICH field was refused rather than one validator's prose.
	assert.match(empty.errors[0].message, /at least one entry/);
	assert.match(empty.errors[0].path, /class_sweep\/instances$/);

	// Declaring an instance out of scope without saying why is an assertion,
	// not an answer — this is the exact evasion R11 exists to prevent.
	const unexplained = sweep({
		class_statement: "inputs reaching the digest unvalidated",
		instances: [{ locus: "entry.executable", disposition: "out-of-scope" }],
	});
	assert.equal(unexplained.ok, false, "out-of-scope without a note must be refused");

	// A closed instance needs no note; only out-of-scope does.
	assert.equal(
		sweep({ class_statement: "coerced identity fields", instances: [{ locus: "entry.executable", disposition: "closed" }] }).ok,
		true,
	);

	for (const bad of [null, [], "swept", 3]) {
		assert.equal(sweep(bad).ok, false, `${JSON.stringify(bad)} is not a sweep`);
	}
	assert.equal(sweep({ class_statement: "", instances: [{ locus: "x", disposition: "closed" }] }).ok, false, "an unnamed class is not a class");
	assert.equal(
		sweep({ class_statement: "c", instances: [{ locus: "x", disposition: "fixed-later" }] }).ok,
		false,
		"only closed or out-of-scope are complete answers",
	);

	// It stays optional: the field's absence is a rubric finding, not a
	// schema error, so existing records remain valid.
	assert.equal(validateRecord(review).ok, true, "a review without a sweep is still a valid record");
});

test("a class sweep is held to the same object rules as every other record field", () => {
	// Found reviewing the first version of this validator, which was
	// hand-rolled and skipped the shared object gate. Each case below passed
	// there.
	const review = valid.review;
	const sweep = (value) => {
		const candidate = structuredClone(review);
		candidate.objections[0].class_sweep = value;
		return validateRecord(candidate);
	};
	const good = { class_statement: "c", instances: [{ locus: "x", disposition: "closed" }] };

	// The worst of them: a prototype-backed object validated ok:true and then
	// serialized to `{}`. The record was valid; the bytes written to disk
	// were not. A verdict that does not survive the write is not a verdict
	// about the stored record.
	const prototypeBacked = Object.create(good);
	assert.equal(sweep(prototypeBacked).ok, false, "a non-plain object must be refused");
	assert.equal(JSON.stringify(prototypeBacked), "{}", "...because this is what would have been stored");

	// Unknown keys are refused everywhere else in the schema; a typo'd
	// `dispostion` must not silently mean "nothing was checked".
	assert.equal(sweep({ ...good, swept: false }).ok, false, "unknown key on the sweep");
	assert.equal(
		sweep({ class_statement: "c", instances: [{ locus: "x", disposition: "closed", dispostion: "typo" }] }).ok,
		false,
		"unknown key on an instance",
	);
	assert.equal(
		sweep({ class_statement: "c", instances: [Object.create({ locus: "x", disposition: "closed" })] }).ok,
		false,
		"an instance whose fields are inherited is not an instance",
	);

	// Listing one place five times is "enumerating the surface" in exactly
	// the way R11 exists to refuse.
	assert.equal(
		sweep({ class_statement: "c", instances: Array(5).fill({ locus: "same", disposition: "closed" }) }).ok,
		false,
		"duplicate loci must be refused",
	);
	// Two genuinely different loci remain fine.
	assert.equal(
		sweep({ class_statement: "c", instances: [{ locus: "a", disposition: "closed" }, { locus: "b", disposition: "closed" }] }).ok,
		true,
	);

	// A note on a `closed` instance is a contradiction: the field means
	// "why this was NOT done", so carrying it on something that was done
	// reads as an excuse attached to completed work.
	assert.equal(sweep({ class_statement: "c", instances: [{ locus: "x", disposition: "closed", note: "actually not done" }] }).ok, false);
});
