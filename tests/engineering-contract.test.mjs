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
	CHANGE_STATE_TRANSITIONS,
	ATTEMPT_OUTCOME_TRANSITIONS,
	ACCEPTANCE_REQUEST_MAX_TTL_MS,
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
	request: await readJson("valid/acceptance-request.json"),
	bundle: await readJson("valid/bundle.json"),
};

/** The receipt context the valid approval fixture was issued against. */
function receiptContext(overrides = {}) {
	return { request: valid.request, consumed_nonces: [], attempt: valid.attempt, candidate: valid.candidate, ...overrides };
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
	assert.deepEqual(files, ["digest.ts", "ids.ts", "index.ts", "types.ts", "validation.ts"]);
	const layer = { types: 0, ids: 1, digest: 1, validation: 2, index: 3 };
	for (const file of files) {
		const source = await readFile(join(dir, file), "utf8");
		const name = file.slice(0, -3);
		for (const match of source.matchAll(/^(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+"([^"]+)";/gm)) {
			const target = match[1];
			if (target.startsWith("./")) {
				const dep = target.slice(2, -3);
				assert.ok(layer[dep] < layer[name], `${file} imports ${target}, which is not below it`);
				assert.notEqual(dep, "index", `${file} imports the barrel`);
			} else if (name !== "index") {
				// The only Node modules the contract may touch: hashing and randomness.
				assert.ok(["node:crypto"].includes(target), `${file} imports ${target}; validators are pure`);
			}
		}
		assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|child_process|node:fs|node:net|node:http/, `${file} reaches outside its arguments`);
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
	assert.deepEqual([...subjects].sort(), ["acceptance-request", "bundle", "receipt", "receipt-caller-candidate", "receipt-replay", "record", "request", "request-valid"], "every validator has negative coverage");
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
		limitations: ["No CI run exists for this candidate."],
	});
	assert.deepEqual(built, valid.request);
	assert.deepEqual(standardLimitations([valid.proof, valid.proof2], [valid.review]), valid.request.presentation.limitations.slice(0, 2), "caller attestation is always disclosed");
	assert.deepEqual(standardLimitations([{ ...valid.proof, provenance: { ...valid.proof.provenance, attested_by: "adapter" } }], []), []);
	assert.equal(ACCEPTANCE_REQUEST_MAX_TTL_MS, 24 * 60 * 60 * 1000);
	assert.equal(validateAcceptanceRequest(built).ok, true);
	assert.throws(() => buildAcceptanceRequest({ ...builtArgs(built), candidate: valid.baseline }), /not the attempt's bound candidate/);
	function builtArgs() {
		return { id: built.id, nonce: built.nonce, issued_at: built.issued_at, expires_at: built.expires_at, change: valid.change, slice: valid.slice, attempt: valid.attempt, candidate: valid.candidate, proofs: [], reviews: [], limitations: [] };
	}
});

// ---------- proof and review semantics ----------

test("agent-claimed is a legal collector that satisfies no obligation, and deferred blockers still block", () => {
	const claimed = { ...valid.proof, collector: "agent-claimed", check: { kind: "test" } };
	delete claimed.exit_code;
	assert.equal(validateRecord(claimed).ok, true, "a claim is kept so it can be contradicted");
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
