import "./helpers/git-environment-isolation.mjs";
// The attempt lifecycle on the MCP surface (#409): a host session drives
// change -> plan -> start_attempt -> capture_candidate -> record_proof ->
// record_review -> gate -> request_acceptance through `codecarto_change`
// alone, against a real temporary git repository. No record is seeded through
// the store on the happy path except where the contract itself forbids the
// MCP surface from producing it (an OBSERVED proof: a tool call is
// caller-reported by construction, so the one host-tool-result proof the
// acceptance needs is written the way E05's protected entry would write it,
// and the test says so where it does it).
//
// Every negative asserts by content: the candidate id a refusal names, the
// digest a review was bound to, the FRESH/STALE verdict of the same walker
// that captured the tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPO_ROOT, "tests/helpers/acceptance-server.mjs");
const execFileAsync = promisify(execFile);
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, checkCandidateFreshness, planTraverseStep, captureCandidate, judgeApprovals, readStoredInputDigests, requestAcceptance, ENGINEERING_SCHEMA_VERSION } = engineering;
const { readWorkingTree, captureWorkingTree, captureWorkingTreeWithSeams } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/working-tree.ts`).href);
const { handleChangeForTest: handleChange, handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { ProtocolError } = await import("@modelcontextprotocol/server");

const REGISTERED = { host: "mcp-server", client: "claude-code", client_version: "2.1.277", channel: "mcp-elicitation", client_request_timeout_ms: 150_000, evidence: "test-only: scripted client, not a live check" };
const TRAVERSE_HOST = { can_obtain_human_decision: true, can_execute: true, storage: { boundary: "none" }, bounds: { max_attempts: 3, max_wall_clock_ms: 60_000 } };
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

async function git(cwd, ...args) {
	await execFileAsync("git", args, { cwd });
}

/** A real git repository with one commit, initialized as a codecarto workspace. */
async function withRepo(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-lifecycle-"));
	try {
		await git(cwd, "init", "-q", "-b", "main");
		await git(cwd, "config", "user.email", "test@example.invalid");
		await git(cwd, "config", "user.name", "Test");
		await writeFile(join(cwd, "count.js"), "export const count = (items) => items.length;\n");
		await writeFile(join(cwd, "README.md"), "# widgets\n");
		await git(cwd, "add", ".");
		await git(cwd, "commit", "-q", "-m", "baseline");
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
		await handleInit({ cwd, pipeline: "lite" });
		const store = await openStore(join(cwd, ".codecarto"));
		return await fn({ cwd, head: stdout.trim(), store });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

const SCENARIOS = [{ id: "S1", kind: "behavior", description: "count() counts every item" }];
const SLICE = {
	title: "Count",
	deliverable: "count() is exported and counts",
	scenario_ids: ["S1"],
	proof_obligations: [{ id: "O1", scenario_id: "S1", check_kind: "test", description: "node --test passes", minimum_collector: "host-observed" }],
	permitted_scope: { paths: ["count.js"] },
};
const REVIEW = { reviewer: { context: "separate-session", separation: "declared-separate", label: "review session" }, objections: [], summary: "Read the diff; the count is right." };

/** create -> plan -> start_attempt through the in-process handler; returns the ids and digests the later steps need. */
async function planAndStart(cwd, head) {
	const created = (await handleChange({ cwd, action: "create", title: "Count widgets", outcome: "count() counts", baseline_commit: head })).structuredContent;
	const planned = (await handleChange({ cwd, action: "plan", change_id: created.change_id, revision: created.revision, acceptance_scenarios: SCENARIOS, slices: [SLICE] })).structuredContent;
	assert.equal(planned.state, "planned");
	assert.equal(planned.slice_ids.length, 1);
	const started = (await handleChange({ cwd, action: "start_attempt", change_id: created.change_id, slice_id: planned.slice_ids[0], inputs: { brief_digest: planned.brief_digest, plan_digest: planned.plan_digest, references: [] } })).structuredContent;
	assert.equal(started.outcome, "running");
	assert.equal(started.attested_by, "adapter");
	assert.equal(started.stability, "stable");
	return { changeId: created.change_id, sliceId: planned.slice_ids[0], attemptId: started.attempt_id, baselineDigest: started.baseline_digest };
}

// `record_proof` takes the full record shape (E01's ProofRecord, as the existing surface test drives it).
let proofSerial = 0;
const proofFor = (candidateId, extra = {}) => ({
	schema_version: ENGINEERING_SCHEMA_VERSION,
	kind: "proof",
	id: `prf_${String(++proofSerial).padStart(24, "0")}`,
	created_at: "2026-09-17T10:21:30Z",
	attempt_id: extra.attempt_id,
	snapshot_id: candidateId,
	obligation_id: "O1",
	scenario_ids: ["S1"],
	check: { kind: "test", command: "node --test", working_directory: "." },
	collector: "host-observed",
	result: "passed",
	exit_code: 0,
	started_at: "2026-09-17T10:20:00Z",
	ended_at: "2026-09-17T10:21:30Z",
	artifacts: [],
	provenance: { source: "mcp:tool-call" },
	...extra,
});

/** The one record the MCP surface cannot produce: an observed proof, written as E05's protected host entry would write it. */
async function observedProofThroughHostEntry(store, changeId, attemptId, candidateId) {
	await store.put({
		...proofFor(candidateId, { attempt_id: attemptId, provenance: { source: "claude-code:post-tool-use", attested_by: "host-tool-result", tool_call_id: "toolu_lifecycle_1" } }),
		change_id: changeId,
	});
}

async function traverse(store, changeId) {
	return await planTraverseStep(store, { change_id: changeId, host: TRAVERSE_HOST });
}

// ---------------------------------------------------------------- the whole loop, MCP only

test("lifecycle: create -> plan -> start_attempt -> edit -> capture_candidate -> proof -> review -> gate -> request_acceptance, accepted with exactly one approval", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId, baselineDigest } = await planAndStart(cwd, head);
		assert.equal((await traverse(store, changeId)).action, "resume-attempt", "running, no candidate: resume then capture");

		await writeFile(join(cwd, "count.js"), "export const count = (items) => items.filter(Boolean).length;\n");
		const captured = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.equal(captured.outcome, "running", "the attempt stays running after capture");
		assert.equal(captured.attested_by, "adapter");
		assert.notEqual(captured.candidate_digest, baselineDigest, "the edit changed the tree identity");
		const stepAfterCapture = await traverse(store, changeId);
		assert.equal(stepAfterCapture.action, "record-observations");
		assert.match(stepAfterCapture.rationale, new RegExp(captured.candidate_snapshot_id));

		// The caller's own proof is retained and claimed: it discharges nothing, and the gate says which obligation is still unproved.
		const claimed = (await handleChange({ cwd, action: "record_proof", change_id: changeId, attempt_id: attemptId, proof: proofFor(captured.candidate_snapshot_id, { attempt_id: attemptId }) })).structuredContent;
		assert.equal(claimed.authority, "claimed");
		assert.equal(claimed.discharges, false);
		assert.equal((await traverse(store, changeId)).action, "request-review", "a proof names the candidate; next is a review of those bytes");

		// The observed proof, through the host's entry (see the file header).
		await observedProofThroughHostEntry(store, changeId, attemptId, captured.candidate_snapshot_id);

		const reviewed = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW })).structuredContent;
		assert.equal(reviewed.candidate_snapshot_id, captured.candidate_snapshot_id, "the review is bound to the stored candidate");
		assert.equal(reviewed.candidate_digest, captured.candidate_digest);
		assert.equal(reviewed.finalized, true);
		assert.equal(reviewed.outcome, "needs-human-acceptance");
		assert.equal((await traverse(store, changeId)).action, "request-human-acceptance");

		const gate = (await handleChange({ cwd, action: "gate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.equal(gate.state, "needs-human-acceptance", JSON.stringify(gate.blockers));
		assert.deepEqual(gate.blockers.filter((b) => b.code !== "human-decision-unavailable"), [], JSON.stringify(gate.blockers));

		// Acceptance through the real server over stdio with a scripted client that answers the elicitation.
		await withClient({ registry: [REGISTERED], answer: () => ({ result: { action: "accept", content: { decision: "accept" } } }) }, async ({ send, elicitations }) => {
			const reply = await send("tools/call", { name: "codecarto_change", arguments: { cwd, action: "request_acceptance", change_id: changeId, attempt_id: attemptId } });
			assert.ok(!reply.error, JSON.stringify(reply.error));
			const out = reply.result.structuredContent;
			assert.equal(out.outcome, "accepted", JSON.stringify(out));
			assert.equal(elicitations.length, 1);
			assert.match(elicitations[0].message, /Change: Count widgets/);
		});
		const approvals = (await readdir(join(store.root, "changes", changeId, "attempts", attemptId, "approvals"))).filter((n) => n.endsWith(".json"));
		assert.equal(approvals.length, 1, "exactly one approval");
		const approval = JSON.parse(await readFile(join(store.root, "changes", changeId, "attempts", attemptId, "approvals", approvals[0]), "utf8"));
		assert.equal(approval.candidate_snapshot_id, captured.candidate_snapshot_id);
		assert.equal(approval.candidate_digest, captured.candidate_digest);
		const concluded = await traverse(store, changeId);
		assert.equal(concluded.action, "stop");
		assert.equal(concluded.stop_reason, "change-concluded");
		assert.match(concluded.rationale, new RegExp(approval.id));
	});
});

// ---------------------------------------------------------------- negatives

test("a caller-supplied snapshot never binds: start_attempt and capture_candidate refuse it by name", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, sliceId, attemptId } = await planAndStart(cwd, head);
		const forged = { repository: { vcs: "none", dirty: false }, manifest: [], coverage: { excluded: [], uncovered_relevant_inputs: [] }, stability: "stable", collector: "host-observed" };
		for (const field of ["snapshot", "candidate_snapshot", "manifest"]) {
			await assert.rejects(() => handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId, [field]: field === "manifest" ? [] : forged }), (e) => e instanceof ProtocolError && new RegExp(`${field} is not accepted`).test(e.message));
		}
		await assert.rejects(() => handleChange({ cwd, action: "start_attempt", change_id: changeId, slice_id: sliceId, inputs: { brief_digest: sha("a"), plan_digest: sha("b"), references: [] }, baseline_snapshot: forged }), /baseline_snapshot is not accepted/);
		const attempt = (await store.get("attempt", attemptId, { changeId })).record;
		assert.equal(attempt.candidate_snapshot_id, undefined, "nothing was bound by the refused calls");
	});
});

test("re-capture is repeatable until a proof references the candidate, then refused naming the candidate and the proof", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		const first = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		await writeFile(join(cwd, "count.js"), "export const count = () => 0;\n");
		const second = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.equal(second.superseded_candidate_id, first.candidate_snapshot_id);
		assert.equal((await store.get("attempt", attemptId, { changeId })).record.candidate_snapshot_id, second.candidate_snapshot_id);
		const proof = (await handleChange({ cwd, action: "record_proof", change_id: changeId, attempt_id: attemptId, proof: proofFor(second.candidate_snapshot_id, { attempt_id: attemptId }) })).structuredContent;
		await assert.rejects(
			() => handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId }),
			(e) => e instanceof ProtocolError && e.message.includes(second.candidate_snapshot_id) && e.message.includes(proof.proof_id) && /new attempt/.test(e.message),
		);
		assert.equal((await store.get("attempt", attemptId, { changeId })).record.candidate_snapshot_id, second.candidate_snapshot_id, "the pinned candidate did not move");
		const step = await traverse(store, changeId);
		assert.equal(step.action, "request-review");
	});
});

test("capture is deterministic: an edit then a revert yields the original digest; the walker applies ALWAYS_EXCLUDED", async () => {
	await withRepo(async ({ cwd, head }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		const original = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		const before = await readFile(join(cwd, "count.js"));
		await writeFile(join(cwd, "count.js"), "changed\n");
		const edited = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.notEqual(edited.candidate_digest, original.candidate_digest);
		await writeFile(join(cwd, "count.js"), before);
		const reverted = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.equal(reverted.candidate_digest, original.candidate_digest, "same bytes, same identity, whatever was written to .codecarto/engineering in between");
		const capture = await captureWorkingTree(cwd);
		assert.ok(capture.ok);
		assert.ok(!capture.capture.manifest.some((e) => e.path.startsWith(".codecarto/engineering/")), "the engineering namespace is never in the manifest");
		assert.ok(capture.capture.coverage.excluded.some((e) => e.pattern === ".codecarto/engineering/**"), "and its exclusion is disclosed");
		assert.ok(capture.capture.manifest.some((e) => e.path === "count.js"));
	});
});

test("parity: readWorkingTree of the tree capture_candidate captured is FRESH untouched and STALE after an edit", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		const captured = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		const candidate = (await store.get("snapshot", captured.candidate_snapshot_id, { changeId, attemptId })).record;
		const fresh = await readWorkingTree(cwd, candidate);
		assert.equal(fresh.ok, true, fresh.ok ? "" : fresh.reason);
		assert.equal(checkCandidateFreshness(candidate, fresh.reread).ok, true, "untouched tree re-reads FRESH through the same walker");
		await writeFile(join(cwd, "README.md"), "# widgets, edited\n");
		const stale = await readWorkingTree(cwd, candidate);
		assert.equal(stale.ok, true);
		const verdict = checkCandidateFreshness(candidate, stale.reread);
		assert.equal(verdict.ok, false, "an edit re-reads STALE");
		assert.equal(verdict.errors[0].code, "digest-mismatch");
		const gate = (await handleChange({ cwd, action: "gate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.ok(gate.blockers.some((b) => b.code === "proof-stale" && b.detail.includes(captured.candidate_snapshot_id)), JSON.stringify(gate.blockers));
	});
});

test("record_review binds the stored candidate and input digests; a caller's digests are refused, and a forged one cannot bind", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		await assert.rejects(() => handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW }), /no bound candidate/);
		const captured = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		const forgedDigest = sha("not the candidate");
		for (const [field, value] of [["candidate_digest", forgedDigest], ["candidate_snapshot_id", "snp_000000000000000000000bad"], ["input_digest", forgedDigest]]) {
			await assert.rejects(() => handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: { ...REVIEW, [field]: value } }), (e) => e instanceof ProtocolError && e.message.includes(`review.${field}`));
		}
		await assert.rejects(() => handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: { ...REVIEW, objections: [{ id: "R1", severity: "blocking", statement: "wrong", evidence: "line 1", disposition: "open" }], remaining_blockers: [] } }), /remaining_blockers must equal/);
		const recorded = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW })).structuredContent;
		const review = (await store.get("review", recorded.review_id, { changeId, attemptId })).record;
		const attempt = (await store.get("attempt", attemptId, { changeId })).record;
		assert.equal(review.candidate_digest, captured.candidate_digest);
		assert.equal(review.candidate_snapshot_id, captured.candidate_snapshot_id);
		assert.equal(review.input_digest, attempt.inputs.digest);
		assert.notEqual(review.candidate_digest, forgedDigest);
	});
});

test("a review with an open blocker does not finalize; traverse asks for a new attempt naming the review", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		const captured = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		await handleChange({ cwd, action: "record_proof", change_id: changeId, attempt_id: attemptId, proof: proofFor(captured.candidate_snapshot_id, { attempt_id: attemptId }) });
		const recorded = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: { ...REVIEW, objections: [{ id: "R1", severity: "blocking", statement: "wrong", evidence: "line 1", disposition: "open" }] } })).structuredContent;
		assert.deepEqual(recorded.remaining_blockers, ["R1"]);
		assert.equal(recorded.finalized, false);
		assert.equal(recorded.outcome, "running");
		const step = await traverse(store, changeId);
		assert.equal(step.action, "address-objections");
		assert.match(step.rationale, new RegExp(recorded.review_id));
		assert.match(step.rationale, /R1/);
	});
});

test("derived fields are refused on start_attempt, capture_candidate and record_review", async () => {
	await withRepo(async ({ cwd, head }) => {
		const { changeId, sliceId, attemptId } = await planAndStart(cwd, head);
		const base = { start_attempt: { slice_id: sliceId, inputs: { brief_digest: sha("a"), plan_digest: sha("b"), references: [] } }, capture_candidate: { attempt_id: attemptId }, record_review: { attempt_id: attemptId, review: REVIEW } };
		for (const action of Object.keys(base)) {
			for (const field of ["state", "attested_by", "outcome", "stability", "digest", "candidate_snapshot_id", "candidate_digest", "input_digest", "decision"]) {
				await assert.rejects(() => handleChange({ cwd, action, change_id: changeId, ...base[action], [field]: "accepted" }), (e) => e instanceof ProtocolError && e.message.includes(field), `${action} accepted ${field}`);
			}
		}
	});
});

test("a finalized attempt is history: capture_candidate is refused and the store rewrites nothing", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		const captured = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW });
		const finalized = (await store.get("attempt", attemptId, { changeId })).record;
		assert.equal(finalized.outcome, "needs-human-acceptance");
		await assert.rejects(() => handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId }), /needs-human-acceptance/);
		await assert.rejects(() => store.put({ ...finalized, candidate_snapshot_id: undefined, outcome: "running", ended_at: undefined }, { ifCandidate: captured.candidate_snapshot_id }), /immutable/);
		await assert.rejects(() => store.put({ ...finalized, outcome: "accepted" }, { ifCandidate: captured.candidate_snapshot_id }), /immutable/);
	});
});

test("the store pins a running attempt's identity and compare-and-swaps on the bound candidate", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		const running = (await store.get("attempt", attemptId, { changeId })).record;
		await assert.rejects(() => store.put({ ...running, slice_id: "slc_000000000000000000000bad" }, { ifCandidate: null }), /slice_id is fixed at start/);
		await assert.rejects(() => store.put({ ...running, outcome: "accepted", candidate_snapshot_id: "snp_000000000000000000000bad", ended_at: running.started_at }, { ifCandidate: null }), /not an allowed transition/);
		await assert.rejects(() => store.put({ ...running, failure_summary: "x" }, { ifCandidate: "snp_000000000000000000000bad" }), /expected candidate/);
		await assert.rejects(() => store.put({ ...running, failure_summary: "x" }), /pass ifCandidate/);
	});
});

// ---------------------------------------------------------------- review drivers (D1-D4)

/** A schema-valid approval that nobody minted: the fixture's receipt (a request id and nonce that exist nowhere under this attempt) re-pointed at the bound candidate. */
async function forgeApproval(store, changeId, sliceId, attemptId, candidate, inputDigest, id, overrides = {}) {
	const fixture = JSON.parse(await readFile(join(REPO_ROOT, "tests", "fixtures", "engineering", "v1", "valid", "approval.json"), "utf8"));
	const now = new Date().toISOString();
	const forged = { ...fixture, id, change_id: changeId, slice_id: sliceId, attempt_id: attemptId, candidate_snapshot_id: candidate.id, candidate_digest: candidate.digest, input_digest: inputDigest, decision: "accepted", created_at: now, decided_at: now, ...overrides };
	const dir = join(store.root, "changes", changeId, "attempts", attemptId, "approvals");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${id}.json`), `${JSON.stringify(forged, null, "\t")}\n`);
	return forged;
}

/** Drive the loop to needs-human-acceptance with an observed proof and a clean review; returns the bound candidate. */
async function finalizeCleanly(cwd, store, changeId, attemptId) {
	await writeFile(join(cwd, "count.js"), "export const count = (items) => items.filter(Boolean).length;\n");
	const captured = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
	await observedProofThroughHostEntry(store, changeId, attemptId, captured.candidate_snapshot_id);
	const reviewed = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW })).structuredContent;
	assert.equal(reviewed.finalized, true);
	return { candidate: (await store.get("snapshot", captured.candidate_snapshot_id, { changeId, attemptId })).record, inputDigest: reviewed.input_digest };
}

const approvalsOnDisk = async (store, changeId, attemptId) => (await readdir(join(store.root, "changes", changeId, "attempts", attemptId, "approvals"))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();

test("D1: a schema-valid forged approval (no stored request) never concludes the change: traverse stops for an operator naming it; request_acceptance proceeds, discloses it, and mints exactly one genuine approval; then traverse concludes naming the GENUINE one", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, sliceId, attemptId } = await planAndStart(cwd, head);
		const { candidate, inputDigest } = await finalizeCleanly(cwd, store, changeId, attemptId);
		const forgedId = `apr_${"d".repeat(24)}`;
		await forgeApproval(store, changeId, sliceId, attemptId, candidate, inputDigest, forgedId);

		const verdicts = await judgeApprovals(store, (await store.get("attempt", attemptId, { changeId })).record, candidate);
		assert.equal(verdicts.length, 1);
		assert.equal(verdicts[0].genuine, false);
		assert.ok(verdicts[0].codes.includes("receipt-unknown-request"), JSON.stringify(verdicts[0]));

		const blocked = await traverse(store, changeId);
		assert.equal(blocked.action, "stop");
		assert.equal(blocked.stop_reason, "blocked-needs-operator", blocked.rationale);
		assert.match(blocked.rationale, new RegExp(forgedId));
		assert.match(blocked.rationale, /receipt-unknown-request/);
		assert.equal((await handleChange({ cwd, action: "gate", change_id: changeId, attempt_id: attemptId })).structuredContent.state, "needs-human-acceptance");

		// The dropped file cannot deny service. In-process first (the stdio launcher below runs from dist/, so this is what pins the source): with no
		// channel the adapter still issues a request rather than refusing already-accepted, and the presentation it stores discloses the ignored file.
		const noChannel = await requestAcceptance(store, { change_id: changeId, attempt_id: attemptId, capabilities: { human_acceptance: "none", label: "mcp-server", verified_integration: true, storage_boundary: "none", assurance_policy: "verified", tool_result_path: "none" }, presenter: { elicit: async () => { throw new Error("never presented"); } }, current_storage: { boundary: "none" }, reread: async (c) => { const r = await readWorkingTree(cwd, c); return r.ok ? { ok: true, reread: r.reread, limitations: r.limitations } : { ok: false, reason: r.reason }; } });
		assert.equal(noChannel.outcome, "needs-human-acceptance", JSON.stringify(noChannel));
		assert.ok(noChannel.request_id, "a request was issued despite the forged file");
		assert.ok(noChannel.request.presentation.limitations.some((l) => l.includes(`approval ${forgedId} under this attempt is not a genuine acceptance`) && /receipt-unknown-request/.test(l)), JSON.stringify(noChannel.request.presentation.limitations));
		// Then through the real server: the real request goes to the person, and what they are shown names the file.
		await withClient({ registry: [REGISTERED], answer: () => ({ result: { action: "accept", content: { decision: "accept" } } }) }, async ({ send, elicitations }) => {
			const reply = await send("tools/call", { name: "codecarto_change", arguments: { cwd, action: "request_acceptance", change_id: changeId, attempt_id: attemptId } });
			assert.ok(!reply.error, JSON.stringify(reply.error));
			const out = reply.result.structuredContent;
			assert.equal(out.outcome, "accepted", JSON.stringify(out));
			assert.equal(elicitations.length, 1);
			assert.match(elicitations[0].message, new RegExp(`approval ${forgedId} under this attempt is not a genuine acceptance`));
			assert.match(elicitations[0].message, /receipt-unknown-request/);
			assert.match(JSON.stringify(out), new RegExp(`approval ${forgedId} under this attempt is not a genuine acceptance`), "the result discloses the ignored approval by id");
		});
		const ids = await approvalsOnDisk(store, changeId, attemptId);
		assert.equal(ids.length, 2, "the forged file is left in place (an operator matter), plus the one genuine approval");
		const after = await judgeApprovals(store, (await store.get("attempt", attemptId, { changeId })).record, candidate);
		const genuine = after.filter((v) => v.genuine);
		assert.equal(genuine.length, 1, "exactly one genuine approval per candidate");
		assert.notEqual(genuine[0].id, forgedId);
		const concluded = await traverse(store, changeId);
		assert.equal(concluded.action, "stop");
		assert.equal(concluded.stop_reason, "change-concluded");
		assert.match(concluded.rationale, new RegExp(genuine[0].id));
		assert.doesNotMatch(concluded.rationale, new RegExp(forgedId));
		// A second request is refused as already-accepted by the GENUINE one, not the forged one.
		await withClient({ registry: [REGISTERED], answer: () => ({ result: { action: "accept", content: { decision: "accept" } } }) }, async ({ send, elicitations }) => {
			const reply = await send("tools/call", { name: "codecarto_change", arguments: { cwd, action: "request_acceptance", change_id: changeId, attempt_id: attemptId } });
			const text = JSON.stringify(reply);
			assert.match(text, new RegExp(`already-accepted: approval ${genuine[0].id}`), text);
			assert.equal(elicitations.length, 0);
		});
		assert.equal((await approvalsOnDisk(store, changeId, attemptId)).length, 2, "nothing further was minted");

		// The genuine approval is genuine for the bound candidate ONLY: judged against another snapshot of the attempt (the baseline, standing in for a superseded candidate) it is not.
		const attempt = (await store.get("attempt", attemptId, { changeId })).record;
		const baseline = (await store.get("snapshot", attempt.baseline_snapshot_id, { changeId, attemptId })).record;
		const against = await judgeApprovals(store, attempt, { ...baseline, role: "candidate" });
		assert.ok(against.every((v) => v.genuine === false), JSON.stringify(against));
		assert.ok(against.find((v) => v.id === genuine[0].id).codes.includes("receipt-mismatch"));
	});
});

test("D1: a forged approval whose decision is rejected, or that names another candidate's id or digest, is not genuine even with every other field right; and a genuine record's nonce cannot be replayed", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, sliceId, attemptId } = await planAndStart(cwd, head);
		const { candidate, inputDigest } = await finalizeCleanly(cwd, store, changeId, attemptId);
		await withClient({ registry: [REGISTERED], answer: () => ({ result: { action: "accept", content: { decision: "accept" } } }) }, async ({ send }) => {
			const reply = await send("tools/call", { name: "codecarto_change", arguments: { cwd, action: "request_acceptance", change_id: changeId, attempt_id: attemptId } });
			assert.equal(reply.result.structuredContent.outcome, "accepted");
		});
		const attempt = (await store.get("attempt", attemptId, { changeId })).record;
		const [genuineId] = await approvalsOnDisk(store, changeId, attemptId);
		const genuine = JSON.parse(await readFile(join(store.root, "changes", changeId, "attempts", attemptId, "approvals", `${genuineId}.json`), "utf8"));
		// A REJECTED decision with a fully valid receipt (the genuine file, decision flipped, standing alone) is a decision, not an acceptance.
		const rejectedId = `apr_${"9".repeat(24)}`;
		await forgeApproval(store, changeId, sliceId, attemptId, candidate, inputDigest, rejectedId, { ...genuine, id: rejectedId, decision: "rejected" });
		await rm(join(store.root, "changes", changeId, "attempts", attemptId, "approvals", `${genuineId}.json`));
		const alone = await judgeApprovals(store, attempt, candidate);
		assert.equal(alone.length, 1);
		assert.equal(alone[0].genuine, false, "a rejected decision is never genuine acceptance");
		assert.ok(alone[0].codes.includes("invalid-value") && /rejected/.test(alone[0].detail), JSON.stringify(alone[0]));
		assert.equal((await traverse(store, changeId)).stop_reason, "blocked-needs-operator");
		await rm(join(store.root, "changes", changeId, "attempts", attemptId, "approvals", `${rejectedId}.json`));
		await writeFile(join(store.root, "changes", changeId, "attempts", attemptId, "approvals", `${genuineId}.json`), `${JSON.stringify(genuine, null, "\t")}\n`);
		assert.equal((await traverse(store, changeId)).stop_reason, "change-concluded");
		// Copies of the genuine record with one binding wrong each: same stored request, same receipt.
		const wrong = {
			[`apr_${"1".repeat(24)}`]: { decision: "rejected" },
			[`apr_${"2".repeat(24)}`]: { candidate_digest: sha("other bytes") },
			[`apr_${"3".repeat(24)}`]: { candidate_snapshot_id: attempt.baseline_snapshot_id },
			[`apr_${"4".repeat(24)}`]: { input_digest: sha("other inputs") },
		};
		for (const [id, patch] of Object.entries(wrong)) await forgeApproval(store, changeId, sliceId, attemptId, candidate, inputDigest, id, { ...genuine, id, ...patch });
		const verdicts = await judgeApprovals(store, attempt, candidate);
		for (const id of Object.keys(wrong)) {
			const v = verdicts.find((x) => x.id === id);
			assert.equal(v.genuine, false, id);
			assert.ok(v.codes.some((c) => c === "receipt-mismatch" || c === "invalid-value" || c === "receipt-replayed"), `${id}: ${v.codes}`);
		}
		// The genuine record itself now shares its nonce with four replays; per the receipt contract a nonce bound elsewhere is a replay, so NOTHING is genuine and traverse stops for an operator rather than concluding.
		assert.ok(verdicts.every((v) => v.genuine === false), JSON.stringify(verdicts.map((v) => [v.id, v.genuine, v.codes])));
		const step = await traverse(store, changeId);
		assert.equal(step.stop_reason, "blocked-needs-operator", step.rationale);
	});
});

test("D2: start_attempt derives brief_digest/plan_digest from the stored brief.md/plan.md; caller values that differ are refused naming both; omitted values are filled; the gate refuses an attempt whose inputs drifted after start", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const created = (await handleChange({ cwd, action: "create", title: "Count widgets", outcome: "count() counts", baseline_commit: head })).structuredContent;
		await assert.rejects(
			() => handleChange({ cwd, action: "start_attempt", change_id: created.change_id, slice_id: "slc_000000000000000000000bad", inputs: { references: [] } }),
			(e) => e instanceof ProtocolError && /no stored brief\.md or plan\.md/.test(e.message) && /does not accept caller-declared digests/.test(e.message),
			"a change with no stored artifacts is refused, not trusted",
		);
		const planned = (await handleChange({ cwd, action: "plan", change_id: created.change_id, revision: created.revision, acceptance_scenarios: SCENARIOS, slices: [SLICE] })).structuredContent;
		const stored = await readStoredInputDigests(store, created.change_id);
		assert.equal(stored.ok, true);
		assert.equal(planned.brief_digest, stored.brief_digest, "plan reports the digest of the bytes it stored");
		assert.equal(planned.plan_digest, stored.plan_digest);
		const bogus = { brief_digest: `sha256:${"a".repeat(64)}`, plan_digest: `sha256:${"b".repeat(64)}`, references: [] };
		await assert.rejects(
			() => handleChange({ cwd, action: "start_attempt", change_id: created.change_id, slice_id: planned.slice_ids[0], inputs: bogus }),
			(e) => e instanceof ProtocolError && e.message.includes(`inputs.brief_digest "${bogus.brief_digest}"`) && e.message.includes(`inputs.plan_digest "${bogus.plan_digest}"`) && e.message.includes(stored.brief_digest) && e.message.includes(stored.plan_digest),
		);
		await assert.rejects(() => handleChange({ cwd, action: "start_attempt", change_id: created.change_id, slice_id: planned.slice_ids[0], inputs: { brief_digest: planned.brief_digest, plan_digest: "not even a digest", references: [] } }), /inputs\.plan_digest "not even a digest"/);
		assert.deepEqual(await readdir(join(store.root, "changes", created.change_id)).then((n) => n.filter((x) => x === "attempts")), [], "no attempt was written by the refused calls");
		// Omitted: the adapter computes them, and they equal what plan returned.
		const started = (await handleChange({ cwd, action: "start_attempt", change_id: created.change_id, slice_id: planned.slice_ids[0], inputs: { references: [] } })).structuredContent;
		const attempt = (await store.get("attempt", started.attempt_id, { changeId: created.change_id })).record;
		assert.equal(attempt.inputs.brief_digest, planned.brief_digest);
		assert.equal(attempt.inputs.plan_digest, planned.plan_digest);
		// Happy path unchanged: echoing plan's values is accepted too.
		const echoed = (await handleChange({ cwd, action: "start_attempt", change_id: created.change_id, slice_id: planned.slice_ids[0], inputs: { brief_digest: planned.brief_digest, plan_digest: planned.plan_digest, references: [] }, parent_attempt_id: started.attempt_id })).structuredContent;
		assert.equal(echoed.outcome, "running");
		assert.equal(echoed.input_digest, started.input_digest);

		// Drift: update the title after the attempt started. brief.md is regenerated; the attempt keeps the digest it started from; the gate refuses it by name.
		await finalizeCleanly(cwd, store, created.change_id, echoed.attempt_id);
		const before = (await handleChange({ cwd, action: "gate", change_id: created.change_id, attempt_id: echoed.attempt_id })).structuredContent;
		assert.equal(before.state, "needs-human-acceptance", JSON.stringify(before.blockers));
		const change = (await store.get("change", created.change_id)).record;
		const updated = (await handleChange({ cwd, action: "update", change_id: created.change_id, revision: change.revision, title: "Renamed after start" })).structuredContent;
		assert.equal(updated.brief_rewritten, true);
		const now = await readStoredInputDigests(store, created.change_id);
		assert.notEqual(now.brief_digest, planned.brief_digest, "the stored brief moved");
		assert.equal(now.plan_digest, planned.plan_digest, "the plan did not");
		const after = (await handleChange({ cwd, action: "gate", change_id: created.change_id, attempt_id: echoed.attempt_id })).structuredContent;
		assert.equal(after.state, "refused");
		const stale = after.blockers.filter((b) => b.code === "input-stale");
		assert.equal(stale.length, 1, JSON.stringify(after.blockers));
		assert.match(stale[0].detail, /brief_digest/);
		assert.ok(stale[0].detail.includes(planned.brief_digest) && stale[0].detail.includes(now.brief_digest), stale[0].detail);
		assert.doesNotMatch(stale[0].detail, /plan_digest/);
		// And the loop does not send the host to ask a person for work the gate refuses.
		const step = await traverse(store, created.change_id);
		assert.equal(step.action, "stop");
		assert.equal(step.stop_reason, "blocked-needs-operator", step.rationale);
		assert.match(step.rationale, /input-stale/);
	});
});

test("D3: a clean review does not finalize when the reviewer is same-context, or the candidate is unstable or caller-attested; only a declared-separate review of an adapter-attested stable candidate does", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, attemptId } = await planAndStart(cwd, head);
		const captured = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.equal(captured.stability, "stable");
		const sameContext = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: { ...REVIEW, reviewer: { context: "same-session", separation: "same-context", label: "the author" } } })).structuredContent;
		assert.equal(sameContext.finalized, false, "a same-context review is a review, not a finalization");
		assert.equal(sameContext.outcome, "running");
		assert.deepEqual(sameContext.remaining_blockers, []);
		assert.equal((await store.get("attempt", attemptId, { changeId })).record.outcome, "running");

		// An UNSTABLE candidate, captured by the adapter's own walker while the tree moved between its two walks (the test seam), bound through core.
		const moving = await captureWorkingTreeWithSeams(cwd, [], { between_walks: async () => writeFile(join(cwd, "count.js"), `export const count = () => ${Date.now()};\n`) });
		assert.equal(moving.ok, true);
		assert.equal(moving.capture.stability, "unstable", "the walker saw the tree move");
		assert.ok(moving.limitations.some((l) => /recorded unstable/.test(l)));
		const { digest: _d, ...tree } = moving.capture;
		const unstable = await captureCandidate(store, { change_id: changeId, attempt_id: attemptId, candidate: { attested_by: "adapter", collector: "host-observed", tree } });
		assert.equal(unstable.snapshot.stability, "unstable");
		const onUnstable = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW })).structuredContent;
		assert.equal(onUnstable.finalized, false, "a clean separate review of an unstable candidate does not finalize");
		assert.equal(onUnstable.candidate_snapshot_id, unstable.snapshot.id);
		assert.equal((await store.get("attempt", attemptId, { changeId })).record.outcome, "running");
		const gateUnstable = (await handleChange({ cwd, action: "gate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.ok(gateUnstable.blockers.some((b) => b.code === "proof-stale" && b.detail.includes(unstable.snapshot.id) && /moving/.test(b.detail)), JSON.stringify(gateUnstable.blockers));

		// A CALLER-attested candidate (the core path an adapter that cannot read the tree would use).
		const settled = await captureWorkingTree(cwd);
		const { digest: _d2, ...settledTree } = settled.capture;
		const callerBound = await captureCandidate(store, { change_id: changeId, attempt_id: attemptId, candidate: { attested_by: "caller", collector: "host-observed", tree: settledTree } });
		assert.equal(callerBound.snapshot.attested_by, "caller");
		const onCaller = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW })).structuredContent;
		assert.equal(onCaller.finalized, false, "a clean separate review of a caller-attested candidate does not finalize");
		assert.equal((await store.get("attempt", attemptId, { changeId })).record.outcome, "running");
		assert.ok((await handleChange({ cwd, action: "gate", change_id: changeId, attempt_id: attemptId })).structuredContent.state === "refused");

		// Only the adapter's own stable capture with a declared-separate clean review finalizes.
		const again = (await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId })).structuredContent;
		assert.equal(again.stability, "stable");
		const clean = (await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW })).structuredContent;
		assert.equal(clean.finalized, true);
		assert.equal(clean.outcome, "needs-human-acceptance");
	});
});

test("D3: plan writes once, from draft, under compare-and-swap: a missing or stale revision is refused, a planned change cannot be re-planned, and two racing planners leave exactly one slice set", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const created = (await handleChange({ cwd, action: "create", title: "Count widgets", outcome: "count() counts", baseline_commit: head })).structuredContent;
		const write = (extra) => handleChange({ cwd, action: "plan", change_id: created.change_id, acceptance_scenarios: SCENARIOS, slices: [SLICE], ...extra });
		await assert.rejects(() => write({}), (e) => e instanceof ProtocolError && /plan requires the revision you last read/.test(e.message));
		await assert.rejects(() => write({ revision: created.revision + 1 }), (e) => e instanceof ProtocolError && /plan requires the revision you last read/.test(e.message));
		await assert.rejects(() => write({ revision: "1" }), /plan requires the revision/);
		assert.equal((await store.get("change", created.change_id)).record.state, "draft", "a refused plan wrote nothing");
		await assert.rejects(() => readdir(join(store.root, "changes", created.change_id, "slices")), /ENOENT/);
		const race = await Promise.allSettled([write({ revision: created.revision }), write({ revision: created.revision })]);
		const won = race.filter((r) => r.status === "fulfilled");
		assert.equal(won.length, 1, JSON.stringify(race.map((r) => r.status === "rejected" ? r.reason.message : "ok")));
		const slices = await readdir(join(store.root, "changes", created.change_id, "slices"));
		assert.equal(slices.length, 1, "the loser's slices were not written");
		assert.deepEqual(slices, won[0].value.structuredContent.slice_ids);
		const planned = (await store.get("change", created.change_id)).record;
		assert.equal(planned.state, "planned");
		await assert.rejects(() => write({ revision: planned.revision }), (e) => e instanceof ProtocolError && /is planned; slices are planned once, from draft/.test(e.message));
		await handleChange({ cwd, action: "start_attempt", change_id: created.change_id, slice_id: slices[0], inputs: { references: [] } });
		const active = (await store.get("change", created.change_id)).record;
		assert.equal(active.state, "active");
		await assert.rejects(() => write({ revision: active.revision }), /is active; slices are planned once, from draft/);
		assert.equal((await readdir(join(store.root, "changes", created.change_id, "slices"))).length, 1);
	});
});

test("D4: every snapshot-shaped argument is refused by name on both capture actions, and record_review discloses that reviewer separation is declared, not authenticated", async () => {
	await withRepo(async ({ cwd, head, store }) => {
		const { changeId, sliceId, attemptId } = await planAndStart(cwd, head);
		const forged = { repository: { vcs: "none", dirty: false }, manifest: [], coverage: { excluded: [], uncovered_relevant_inputs: [] }, stability: "stable" };
		for (const field of ["snapshot", "baseline_snapshot", "candidate_snapshot", "tree", "capture", "candidate", "baseline", "reread", "candidate_reread", "working_tree", "manifest", "coverage", "repository", "entries", "files"]) {
			await assert.rejects(() => handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId, [field]: forged }), (e) => e instanceof ProtocolError && e.message.includes(`${field} is not accepted by capture_candidate`), field);
			await assert.rejects(() => handleChange({ cwd, action: "start_attempt", change_id: changeId, slice_id: sliceId, inputs: { references: [] }, [field]: forged }), (e) => e instanceof ProtocolError && e.message.includes(`${field} is not accepted by start_attempt`), field);
		}
		assert.equal((await store.get("attempt", attemptId, { changeId })).record.candidate_snapshot_id, undefined);
		await handleChange({ cwd, action: "capture_candidate", change_id: changeId, attempt_id: attemptId });
		const out = await handleChange({ cwd, action: "record_review", change_id: changeId, attempt_id: attemptId, review: REVIEW });
		const disclosure = /reviewer separation is declared by the review's author, not authenticated/;
		assert.match(out.content[0].text, disclosure);
		assert.ok(out.structuredContent.limitations.some((l) => disclosure.test(l)), JSON.stringify(out.structuredContent.limitations));
	});
});

// ---------------------------------------------------------------- scripted stdio client (as in the adapter test)

async function withClient({ registry, capabilities = { elicitation: { form: {}, url: {} } }, clientInfo = { name: "claude-code", version: "2.1.277" }, answer }, fn) {
	const child = spawn(process.execPath, [LAUNCHER, ...(registry ? [JSON.stringify(registry)] : [])], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
	let buffer = "";
	const pending = new Map();
	const elicitations = [];
	let nextId = 1;
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message.method === "elicitation/create") {
				elicitations.push(message.params);
				(async () => {
					const reply = answer ? await answer(message.params) : null;
					if (reply === null || reply === undefined) return;
					child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: reply.result })}\n`);
				})();
				continue;
			}
			const waiter = pending.get(message.id);
			if (waiter) {
				pending.delete(message.id);
				waiter(message);
			}
		}
	});
	const send = (method, params, timeoutMs = 30_000) => {
		const id = nextId++;
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectPromise(new Error(`timed out waiting for ${method}; stderr: ${stderr.join("")}`));
			}, timeoutMs);
			pending.set(id, (message) => {
				clearTimeout(timer);
				resolvePromise(message);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	};
	try {
		const init = await send("initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo });
		assert.ok(!init.error, JSON.stringify(init.error));
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		return await fn({ send, elicitations, stderr });
	} finally {
		child.stdin.end();
		child.kill();
	}
}
