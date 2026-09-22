// End-to-end engineering loop and second-change continuity (E11, #409).
//
// Every earlier evolution proved one module against records it built in
// memory. This suite drives the REAL store and the REAL pure functions, in
// the order a host would: lift a plan, build the brief and plan, record the
// change and slice, start an attempt, capture a candidate, ingest observed
// proofs bound to that candidate, record a review, ask the gate, ask the
// loop what to do next. Then it breaks each link and checks the refusal
// names the link — by content (obligation id, snapshot id, objection id),
// not just by state.
//
// Rubric mapping (docs/engineering/evaluation-rubric.md): test names carry
// the R/N ids they map to. The pilot fixtures under
// tests/fixtures/engineering/pilot/ are synthetic; nothing here is a human
// acceptance, and no test produces an approval record.
//
// Nothing is mocked. `openStore` writes a real `.codecarto/engineering/`
// under a temp dir; N06 re-opens it with a fresh call to prove resumption
// reads from disk and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const {
	openStore,
	liftSlices,
	buildChangeBrief,
	buildChangePlan,
	planReadiness,
	collectSnapshot,
	candidateMayBindAcceptance,
	diffSnapshots,
	ingestProof,
	evaluateAcceptanceGate,
	describeGateOutcome,
	planTraverseStep,
	engineeringPaths,
	computeInputDigest,
} = engineering;

const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const PILOT = join(REPO_ROOT, "tests/fixtures/engineering/pilot");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// E01 owns every record shape. Read, never restate.
const CHANGE = await readJson(join(FIXTURES, "change.json"));
const SLICE = await readJson(join(FIXTURES, "slice.json"));
const ATTEMPT = await readJson(join(FIXTURES, "attempt.json"));
const SNAPSHOT = await readJson(join(FIXTURES, "snapshot-candidate.json"));
const PROOF = await readJson(join(FIXTURES, "proof.json"));
const PROOF2 = await readJson(join(FIXTURES, "proof-second-obligation.json"));
const REVIEW = await readJson(join(FIXTURES, "review.json"));

const PLAN_MD = await readFile(join(PILOT, "plan-widgets.md"), "utf8");
const PLAN_MD_NO_ROUTE = await readFile(join(PILOT, "plan-widgets-no-route.md"), "utf8");
const MANIFEST = await readJson(join(PILOT, "manifest.json"));

const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const entriesOf = (files) => files.map((f) => ({ path: f.path, type: "file", digest: sha(f.body), executable: false, size: Buffer.byteLength(f.body) }));

/** The shipped proof fixtures are caller-attested; acceptance needs observed proof. */
const observedProof = (proof) => ({
	...proof,
	provenance: { ...proof.provenance, attested_by: "host-tool-result", tool_call_id: `call_${proof.id.slice(-4)}` },
});

const CAPABLE_HOST = {
	can_obtain_human_decision: true,
	storage: { boundary: "host-enforced", protection: "continuous-since-initialization", enforced_since: "2026-09-17T09:00:00Z" },
};
const TRAVERSE_HOST = { ...CAPABLE_HOST, can_execute: true, bounds: { max_attempts: 3, max_wall_clock_ms: 60_000 } };

const ENVIRONMENT = { build_command: "npm run build", test_command: "npm test" };

/** The brief request the plan artifact is lifted into; mirrors the change fixture. */
function briefRequest() {
	return {
		title: CHANGE.title,
		mode: CHANGE.mode,
		requested_outcome: CHANGE.requested_outcome,
		baseline: CHANGE.baseline,
		scope: CHANGE.scope,
		preserved_contracts: CHANGE.preserved_contracts,
		acceptance_scenarios: CHANGE.acceptance_scenarios,
	};
}

/** Lifted slices carry ids and tiers; the planner wants SliceInput. The fixture slice supplies the E01 shape verbatim. */
function toSliceInput(lifted) {
	return {
		title: SLICE.title,
		deliverable: lifted.deliverable,
		scenario_ids: lifted.scenario_ids,
		depends_on: [],
		proof_obligations: SLICE.proof_obligations,
		permitted_scope: SLICE.permitted_scope,
	};
}

/**
 * Drive the first change through every step and return every record and
 * every intermediate outcome, so a test can assert on any link. `opts`
 * lets a negative control break exactly one link.
 */
async function runFirstChange(store, opts = {}) {
	// ---- planning: lift -> brief -> plan -> readiness
	const lifted = liftSlices(opts.planMarkdown ?? PLAN_MD);
	const request = briefRequest();
	const sliceInputs = lifted.slices.map(toSliceInput);
	const brief = buildChangeBrief(request);
	const plan = buildChangePlan(request, sliceInputs);
	const readiness = planReadiness(request, sliceInputs, opts.environment ?? ENVIRONMENT);

	// ---- records: change, slice, attempt
	const change = { ...CHANGE, ...(opts.change ?? {}) };
	const slice = { ...SLICE, change_id: change.id };
	await store.put(change);
	await store.put(slice);
	const attempt = { ...ATTEMPT, change_id: change.id, slice_id: slice.id, ...(opts.attempt ?? {}) };
	await store.put(attempt);

	// ---- candidate: collected from the in-memory tree, not restated
	const files = opts.files ?? MANIFEST.files;
	const collected = collectSnapshot({ entries: entriesOf(files), repository: MANIFEST.repository });
	assert.equal(collected.ok, true, collected.ok ? "" : JSON.stringify(collected.errors));
	const snapshot = attempt.candidate_snapshot_id === undefined ? null : {
		...SNAPSHOT,
		id: attempt.candidate_snapshot_id,
		change_id: change.id,
		attempt_id: attempt.id,
		manifest: collected.value.manifest,
		coverage: collected.value.coverage,
		repository: collected.value.repository,
		stability: collected.value.stability,
		digest: collected.value.digest,
	};
	if (snapshot) await store.put(snapshot);
	const binds = snapshot ? candidateMayBindAcceptance(snapshot) : null;

	// ---- proofs: through ingestProof, bound to this attempt and candidate
	const proofInputs = (opts.proofs ?? [observedProof(PROOF), observedProof(PROOF2)]).map((p) => ({
		...p,
		change_id: change.id,
		attempt_id: attempt.id,
		snapshot_id: p.snapshot_id === PROOF.snapshot_id ? snapshot?.id : p.snapshot_id,
	}));
	const ingested = [];
	for (const proof of proofInputs) ingested.push(await ingestProof(store, proof));

	// ---- review of these exact bytes
	const reviews = (opts.reviews ?? [REVIEW]).map((r) => ({
		...r,
		change_id: change.id,
		attempt_id: attempt.id,
		candidate_snapshot_id: snapshot?.id,
		candidate_digest: snapshot?.digest,
		input_digest: attempt.inputs.digest,
	}));
	for (const review of reviews) await store.put(review);

	// ---- the gate, then the loop
	const gate = await evaluateAcceptanceGate(store, {
		change_id: change.id,
		attempt_id: attempt.id,
		host: opts.gateHost ?? CAPABLE_HOST,
		...(opts.gateExtra ?? {}),
	});
	const step = await planTraverseStep(store, { change_id: change.id, host: opts.traverseHost ?? TRAVERSE_HOST });

	return { lifted, brief, plan, readiness, change, slice, attempt, snapshot, collected: collected.value, binds, proofInputs, ingested, reviews, gate, step };
}

async function withStore(fn) {
	const root = await mkdtemp(join(tmpdir(), "codecarto-e11-e2e-"));
	try {
		const store = await openStore(join(root, ".codecarto"));
		return await fn({ store, root });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The control every negative test runs first: the same helpers reach may-accept. */
async function assertControl(store) {
	const r = await runFirstChange(store);
	assert.equal(r.gate.state, "may-accept", `control failed: ${JSON.stringify(r.gate.blockers)}`);
	return r;
}

async function approvalsUnder(store, changeId, attemptId) {
	const dir = resolve(store.root, engineeringPaths.attemptDir(changeId, attemptId).replace(/^engineering[/\\]/, ""), "approvals");
	try {
		await stat(dir);
	} catch {
		return [];
	}
	return readdir(dir);
}

// ---------------------------------------------------------------- HAPPY: R01 / R03 / R04

test("R01/R03/R04: a first change traverses brief -> plan -> attempt -> candidate -> proofs -> review -> gate -> next action through real records", async () => {
	await withStore(async ({ store }) => {
		const r = await runFirstChange(store);

		// Planning artifacts lifted, not hand-written (R01).
		assert.deepEqual(r.lifted.errors, [], JSON.stringify(r.lifted.errors));
		assert.equal(r.lifted.slices[0].verification_route, "test");
		assert.equal(r.brief.ok, true, JSON.stringify(r.brief.errors));
		assert.equal(r.plan.ok, true, JSON.stringify(r.plan.errors));
		assert.deepEqual(r.readiness, { executable: true, blockers: [] });

		// Bindings are consistent across every step (R03).
		assert.equal(r.binds.ok, true, JSON.stringify(r.binds));
		assert.equal(r.snapshot.attempt_id, r.attempt.id);
		assert.equal(r.attempt.candidate_snapshot_id, r.snapshot.id);
		for (const [i, outcome] of r.ingested.entries()) {
			assert.equal(outcome.ok, true, JSON.stringify(outcome));
			assert.equal(outcome.discharges, true, `proof ${i} did not discharge`);
			assert.equal(outcome.proof.snapshot_id, r.snapshot.id);
			assert.equal(outcome.proof.attempt_id, r.attempt.id);
		}
		assert.equal(r.reviews[0].candidate_digest, r.snapshot.digest);
		assert.equal(r.reviews[0].input_digest, r.attempt.inputs.digest);

		// Every record is on disk under the store, readable by id.
		for (const [kind, id, ctx] of [
			["change", r.change.id, {}],
			["slice", r.slice.id, { changeId: r.change.id }],
			["attempt", r.attempt.id, { changeId: r.change.id }],
			["snapshot", r.snapshot.id, { changeId: r.change.id, attemptId: r.attempt.id }],
			["proof", PROOF.id, { changeId: r.change.id, attemptId: r.attempt.id }],
			["review", REVIEW.id, { changeId: r.change.id, attemptId: r.attempt.id }],
		]) {
			const got = await store.get(kind, id, ctx);
			assert.equal(got.record?.id, id, `${kind} ${id} unreadable: ${JSON.stringify(got)}`);
		}

		// The gate offers acceptance and names the obligations it relied on (R04).
		assert.equal(r.gate.state, "may-accept", JSON.stringify(r.gate.blockers));
		assert.deepEqual(r.gate.blockers, []);
		const text = describeGateOutcome(r.gate);
		assert.match(text, /Acceptance may be offered/);
		// LIMIT (R04): on may-accept the gate does not list the obligations it
		// relied on; only refusals name them. The per-obligation account here
		// comes from ingestProof's discharge outcomes, and N01 asserts the gate
		// names the obligation on refusal.
		assert.deepEqual(r.ingested.map((o) => o.proof.obligation_id).sort(), ["O1", "O2"]);
		assert.deepEqual(r.slice.proof_obligations.map((o) => o.id).sort(), ["O1", "O2"]);

		// The loop's next bounded action follows from the attempt's state.
		assert.equal(r.step.action, "request-human-acceptance", r.step.rationale);
		assert.deepEqual(r.step.resumed_from, { attempt_id: r.attempt.id, outcome: "needs-human-acceptance" });
		assert.ok(r.step.bounds.limits.length > 0, "the step names no bounds");
		assert.deepEqual(await approvalsUnder(store, r.change.id, r.attempt.id), [], "no approval was written by the loop itself");
	});
});

// ---------------------------------------------------------------- N01 missing proof

test("N01: withholding one proof refuses acceptance and the blocker names that obligation", async () => {
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	await withStore(async ({ store }) => {
		const r = await runFirstChange(store, { proofs: [observedProof(PROOF)] });
		assert.equal(r.gate.state, "refused");
		const hit = r.gate.blockers.filter((b) => b.code === "obligation-unproved");
		assert.equal(hit.length, 1, JSON.stringify(r.gate.blockers));
		assert.match(hit[0].detail, /\bO2\b/);
		assert.ok(!r.gate.blockers.some((b) => /\bO1\b/.test(b.detail) && b.code === "obligation-unproved"), "O1 was proved and must not be named");
	});
});

// ---------------------------------------------------------------- N02 wrong candidate

test("N02: a proof bound to a different snapshot is refused at ingestion (unknown snapshot) and, if forced past it, at the gate as stale", async () => {
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	await withStore(async ({ store }) => {
		// Boundary 1: ingestProof owns "does this snapshot exist for this attempt". A
		// proof naming a snapshot this attempt never captured is refused there.
		const other = "snp_0000000000000000000000d5";
		const r = await runFirstChange(store, { proofs: [observedProof(PROOF), { ...observedProof(PROOF2), snapshot_id: other }] });
		const second = r.ingested[1];
		assert.equal(second.ok, false, "a proof of an unknown snapshot was ingested");
		assert.ok(second.errors.some((e) => e.path === "/snapshot_id" && e.code === "unknown-reference" && e.message.includes(other)), JSON.stringify(second.errors));
		// Consequently the gate sees O2 unproved, by name.
		assert.equal(r.gate.state, "refused");
		assert.ok(r.gate.blockers.some((b) => b.code === "obligation-unproved" && /\bO2\b/.test(b.detail)), JSON.stringify(r.gate.blockers));
	});
	await withStore(async ({ store }) => {
		// Boundary 2: the gate owns "is the proof against the CURRENT candidate".
		// Write the proof directly (as a tampering host could) so the gate, not
		// ingestion, is what refuses it.
		const r = await runFirstChange(store, { proofs: [observedProof(PROOF)] });
		const stale = { ...observedProof(PROOF2), change_id: r.change.id, attempt_id: r.attempt.id, snapshot_id: "snp_0000000000000000000000d5" };
		await store.put(stale);
		const gate = await evaluateAcceptanceGate(store, { change_id: r.change.id, attempt_id: r.attempt.id, host: CAPABLE_HOST });
		assert.equal(gate.state, "refused");
		const hit = gate.blockers.filter((b) => b.code === "proof-stale");
		assert.equal(hit.length, 1, JSON.stringify(gate.blockers));
		assert.match(hit[0].detail, /\bO2\b/);
		assert.ok(hit[0].remedy.includes(r.snapshot.id), `remedy does not name the bound candidate: ${hit[0].remedy}`);
	});
});

// ---------------------------------------------------------------- N03 stale input

test("N03: after the plan input changes, a superseding attempt carries none of the earlier evidence; the gate refuses by obligation and the old proof cannot bind to the new candidate", async () => {
	// The staleness mechanism that exists (E03/E06) is relational: a proof
	// discharges only against the candidate its attempt currently offers. The
	// store makes attempts immutable, so "the attempt moved its candidate" is
	// expressed as a NEW attempt with a new input digest — the earlier
	// evidence stays truthful on the old attempt and establishes nothing for
	// the new one. There is no timestamp rule (proofs.ts says why).
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	await withStore(async ({ store }) => {
		const r = await assertControl(store);
		const edited = MANIFEST.files.map((f) => (f.path === "src/widgets/count.ts" ? { ...f, body: f.body + "// requirement changed\n" } : f));
		const recollected = collectSnapshot({ entries: entriesOf(edited), repository: MANIFEST.repository });
		assert.equal(recollected.ok, true);
		const revised = { ...r.attempt.inputs, plan_digest: sha("revised plan") };
		const nextAttemptId = "att_00000000000000000000a002";
		const newSnapshotId = "snp_00000000000000000000d002";
		const next = { ...r.attempt, id: nextAttemptId, created_at: "2026-09-17T12:00:00Z", started_at: "2026-09-17T12:00:00Z", ended_at: "2026-09-17T12:30:00Z", candidate_snapshot_id: newSnapshotId, inputs: { ...revised, digest: computeInputDigest(revised) } };
		assert.notEqual(next.inputs.digest, r.attempt.inputs.digest);
		await store.put(next);
		await store.put({ ...r.snapshot, id: newSnapshotId, attempt_id: nextAttemptId, manifest: recollected.value.manifest, digest: recollected.value.digest, repository: recollected.value.repository, created_at: "2026-09-17T12:10:00Z", captured_at: "2026-09-17T12:10:00Z" });

		// The earlier proof, re-presented for the new attempt, still names the old candidate: refused by id.
		const carried = await ingestProof(store, { ...r.proofInputs[0], id: "prf_00000000000000000000f0aa", attempt_id: nextAttemptId });
		assert.equal(carried.ok, false, "a proof of the superseded candidate bound to the new attempt");
		assert.ok(carried.errors.some((e) => e.path === "/snapshot_id" && e.message.includes(r.snapshot.id) && e.message.includes(nextAttemptId)), JSON.stringify(carried.errors));

		const gate = await evaluateAcceptanceGate(store, { change_id: r.change.id, attempt_id: nextAttemptId, host: CAPABLE_HOST });
		assert.equal(gate.state, "refused");
		const unproved = gate.blockers.filter((b) => b.code === "obligation-unproved");
		assert.deepEqual(unproved.map((b) => b.detail.match(/\bO[12]\b/)?.[0]).sort(), ["O1", "O2"], JSON.stringify(gate.blockers));
		assert.ok(gate.blockers.some((b) => b.code === "review-missing"), "the earlier review carried over to a candidate it never saw");
		// The loop follows the latest attempt, not the one that had evidence.
		const step = await planTraverseStep(store, { change_id: r.change.id, host: TRAVERSE_HOST });
		assert.equal(step.resumed_from?.attempt_id, nextAttemptId, step.rationale);
		// The first attempt's own gate outcome is unchanged: its evidence was never edited.
		const earlier = await evaluateAcceptanceGate(store, { change_id: r.change.id, attempt_id: r.attempt.id, host: CAPABLE_HOST });
		assert.equal(earlier.state, "may-accept");
	});
});

// ---------------------------------------------------------------- N04 dirty implementation

test("N04: changed bytes at the same declared HEAD are detected by diffSnapshots and refused by the gate as a stale candidate", async () => {
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	await withStore(async ({ store }) => {
		const r = await assertControl(store);
		const dirty = MANIFEST.files.map((f) => (f.path === "src/widgets/count.ts" ? { ...f, body: f.body.replace("3", "4") } : f));
		const reread = collectSnapshot({ entries: entriesOf(dirty), repository: MANIFEST.repository });
		assert.equal(reread.ok, true);
		assert.equal(reread.value.repository.head, r.snapshot.repository.head, "the declared HEAD did not change");
		assert.notEqual(reread.value.digest, r.snapshot.digest, "same HEAD, different bytes, same digest");

		const diff = diffSnapshots(r.snapshot, reread.value);
		assert.equal(diff.identical, false);
		assert.deepEqual(diff.modified, ["src/widgets/count.ts"]);
		assert.deepEqual(diff.added, []);
		assert.deepEqual(diff.removed, []);

		const gate = await evaluateAcceptanceGate(store, {
			change_id: r.change.id,
			attempt_id: r.attempt.id,
			host: CAPABLE_HOST,
			candidate_reread: { manifest: reread.value.manifest, coverage: reread.value.coverage, repository: reread.value.repository },
		});
		assert.equal(gate.state, "refused");
		const hit = gate.blockers.filter((b) => b.code === "proof-stale" && b.detail.includes(r.snapshot.id));
		assert.equal(hit.length, 1, JSON.stringify(gate.blockers));
		assert.ok(hit[0].detail.includes(reread.value.digest), "the blocker does not name the digest the tree now has");
	});
});

// ---------------------------------------------------------------- N05 open blocker

test("N05: an open blocking objection refuses acceptance by objection id; a named owner does not resolve it", async () => {
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	await withStore(async ({ store }) => {
		const review = {
			...REVIEW,
			objections: [{ ...REVIEW.objections[0], disposition: "open", resolution_evidence: undefined, disposition_note: "owner: the author; will fix" }, REVIEW.objections[1]],
			remaining_blockers: ["R1"],
		};
		const r = await runFirstChange(store, { reviews: [review] });
		assert.equal(r.gate.state, "refused");
		const hit = r.gate.blockers.filter((b) => b.code === "objection-open");
		assert.ok(hit.length >= 1, JSON.stringify(r.gate.blockers));
		for (const b of hit) assert.match(b.detail, /\bR1\b/);
		assert.ok(hit.some((b) => /open/.test(b.detail)), "no blocker says the objection is open");
		assert.ok(!r.gate.blockers.some((b) => /\bR2\b/.test(b.detail)), "the advisory objection must not be reported as a blocker");
		assert.ok(describeGateOutcome(r.gate).includes("R1"));
	});
});

// ---------------------------------------------------------------- N06 interrupt / resume

test("N06: after a failed attempt, a FRESH store on the same directory recovers scope, the failure, and the next bounded action without repeating it", async () => {
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	await withStore(async ({ store, root }) => {
		const failed = { outcome: "failed", failure_summary: "tests/widgets-count.test.mjs: 1 failing", candidate_snapshot_id: undefined };
		const r = await runFirstChange(store, { attempt: failed, proofs: [], reviews: [] });
		assert.equal(r.step.action, "retry-after-failure", r.step.rationale);
		const before = r.step;

		// A new session: no in-memory state, same directory.
		const fresh = await openStore(join(root, ".codecarto"));
		const step = await planTraverseStep(fresh, { change_id: r.change.id, host: TRAVERSE_HOST });
		assert.equal(step.action, "retry-after-failure", step.rationale);
		assert.deepEqual(step.resumed_from, { attempt_id: r.attempt.id, outcome: "failed" });
		assert.ok(step.rationale.includes(r.attempt.id) && step.rationale.includes("1 failing"), step.rationale);
		assert.ok(step.history.some((h) => h.includes(r.attempt.id)), JSON.stringify(step.history));
		assert.ok(step.bounds.limits.some((l) => /attempts remaining 2/.test(l)), JSON.stringify(step.bounds));
		assert.equal(step.idempotency_key, before.idempotency_key, "the resumed session computed a different key for the same records");

		// A running attempt is resumed, never restarted: no second side effect.
		await fresh.put({ ...r.attempt, id: "att_00000000000000000000a002", outcome: "running", failure_summary: undefined, ended_at: undefined, created_at: "2026-09-17T11:00:00Z", started_at: "2026-09-17T11:00:00Z" });
		const again = await openStore(join(root, ".codecarto"));
		const resumed = await planTraverseStep(again, { change_id: r.change.id, host: TRAVERSE_HOST });
		assert.equal(resumed.action, "resume-attempt", resumed.rationale);
		assert.equal(resumed.resumed_from.attempt_id, "att_00000000000000000000a002");
		assert.ok(resumed.bounds.limits.includes("no new attempt record"), JSON.stringify(resumed.bounds));
	});
});

// ---------------------------------------------------------------- N07 unavailable environment

test("N07: a slice with no verification route or no test command is blocked at planning, and no proof claims to have run", async () => {
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	// E10: route `none` is a recorded gap on the lifted slice, not a pass.
	const lifted = liftSlices(PLAN_MD_NO_ROUTE);
	assert.equal(lifted.slices[0].verification_route, "none");
	const gap = lifted.errors.filter((e) => e.code === "no-route");
	assert.equal(gap.length, 1, JSON.stringify(lifted.errors));
	assert.match(gap[0].message, /SL-01/);

	// E04: the environment lacks the collector the obligation needs.
	const readiness = planReadiness(briefRequest(), lifted.slices.map(toSliceInput), { build_command: null, test_command: null });
	assert.equal(readiness.executable, false);
	assert.ok(readiness.blockers.some((b) => /test/.test(b)), JSON.stringify(readiness.blockers));

	// A blocked attempt with no proofs: the loop stops, and the store has no proof.
	await withStore(async ({ store }) => {
		const blocked = { outcome: "blocked", block_reason: "no test command configured; obligation O1 cannot be observed", candidate_snapshot_id: undefined };
		const r = await runFirstChange(store, { attempt: blocked, proofs: [], reviews: [], planMarkdown: PLAN_MD_NO_ROUTE, environment: { build_command: null, test_command: null } });
		assert.equal(r.readiness.executable, false);
		assert.equal(r.step.action, "stop");
		assert.equal(r.step.stop_reason, "blocked-needs-operator");
		assert.ok(r.step.rationale.includes("no test command configured"), r.step.rationale);
		assert.notEqual(r.step.stop_reason, "attempt-budget-exhausted", "blocked must not count as failed");
		const proofsDir = resolve(store.root, engineeringPaths.attemptDir(r.change.id, r.attempt.id).replace(/^engineering[/\\]/, ""), "proofs");
		await assert.rejects(stat(proofsDir), "a proof directory exists for an attempt that never ran a check");
		assert.equal(r.gate.state, "refused");
		assert.ok(r.gate.blockers.some((b) => b.code === "attempt-not-ready"), JSON.stringify(r.gate.blockers));
	});
});

// ---------------------------------------------------------------- N08 acceptance unavailable

test("N08: a host that cannot obtain a human decision gets needs-human-acceptance, the loop stops, and no approval record exists afterwards", async () => {
	await withStore(async ({ store }) => {
		await assertControl(store);
	});
	await withStore(async ({ store }) => {
		const incapable = { ...CAPABLE_HOST, can_obtain_human_decision: false };
		const r = await runFirstChange(store, { gateHost: incapable, traverseHost: { ...TRAVERSE_HOST, can_obtain_human_decision: false } });
		assert.equal(r.gate.state, "needs-human-acceptance", JSON.stringify(r.gate.blockers));
		assert.deepEqual(r.gate.blockers, []);
		assert.equal(r.step.action, "stop");
		assert.equal(r.step.stop_reason, "host-cannot-obtain-human-decision");
		assert.ok(r.step.rationale.includes(r.attempt.id));
		assert.deepEqual(await approvalsUnder(store, r.change.id, r.attempt.id), [], "an approval record appeared without a human");
		const got = await store.get("change", r.change.id, {});
		assert.equal(got.record.state, "active", "the change was concluded without a decision");
	});
});

// ---------------------------------------------------------------- R09 second change

test("R09: a second change in the same store baselines on the first candidate and leaves the first change's records byte-identical", async () => {
	await withStore(async ({ store }) => {
		const first = await assertControl(store);
		const firstDir = resolve(store.root, engineeringPaths.changeDir(first.change.id).replace(/^engineering[/\\]/, ""));
		const snapshotFiles = async () => {
			const out = new Map();
			const walk = async (dir) => {
				for (const entry of await readdir(dir, { withFileTypes: true })) {
					const path = join(dir, entry.name);
					if (entry.isDirectory()) await walk(path);
					else out.set(path, await readFile(path));
				}
			};
			await walk(firstDir);
			return out;
		};
		const before = await snapshotFiles();
		assert.ok(before.size >= 6, `expected change, slice, attempt, snapshot, 2 proofs, review on disk; found ${before.size}`);

		// The second change: independent id, baseline derived from the first candidate.
		const changeId = "chg_00000000000000000000c002";
		const second = {
			...CHANGE,
			id: changeId,
			revision: 1,
			title: "Widget count exposes a total",
			created_at: "2026-09-18T09:00:00Z",
			updated_at: "2026-09-18T09:00:00Z",
			baseline: { vcs: "git", head: first.snapshot.repository.head, description: `candidate ${first.snapshot.id} of ${first.change.id} (${first.snapshot.digest})` },
		};
		await store.put(second);
		const slice = { ...SLICE, id: "slc_00000000000000000000e002", change_id: changeId };
		await store.put(slice);
		const attempt = {
			...ATTEMPT,
			id: "att_00000000000000000000a010",
			change_id: changeId,
			slice_id: slice.id,
			baseline_snapshot_id: first.snapshot.id,
			candidate_snapshot_id: "snp_00000000000000000000d010",
		};
		await store.put(attempt);
		// The second baseline IS the first candidate's tree; the second candidate extends it.
		const extended = [...MANIFEST.files, { path: "src/widgets/total.ts", body: "export const total = 3;\n" }];
		const collected = collectSnapshot({ entries: entriesOf(extended), repository: MANIFEST.repository });
		assert.equal(collected.ok, true);
		const candidate = { ...first.snapshot, id: attempt.candidate_snapshot_id, change_id: changeId, attempt_id: attempt.id, manifest: collected.value.manifest, coverage: collected.value.coverage, digest: collected.value.digest, created_at: "2026-09-18T09:30:00Z", captured_at: "2026-09-18T09:30:00Z" };
		await store.put(candidate);
		const diff = diffSnapshots(first.snapshot, candidate);
		assert.deepEqual(diff.added, ["src/widgets/total.ts"]);
		assert.deepEqual(diff.modified, []);

		for (const [i, p] of [observedProof(PROOF), observedProof(PROOF2)].entries()) {
			const out = await ingestProof(store, { ...p, id: `prf_00000000000000000000f01${i}`, change_id: changeId, attempt_id: attempt.id, snapshot_id: candidate.id });
			assert.equal(out.ok, true, JSON.stringify(out));
			assert.equal(out.discharges, true);
		}
		await store.put({ ...REVIEW, id: "rvw_000000000000000000000e10", change_id: changeId, attempt_id: attempt.id, candidate_snapshot_id: candidate.id, candidate_digest: candidate.digest, input_digest: attempt.inputs.digest });
		const gate = await evaluateAcceptanceGate(store, { change_id: changeId, attempt_id: attempt.id, host: CAPABLE_HOST });
		assert.equal(gate.state, "may-accept", JSON.stringify(gate.blockers));

		// The second change's records reference the first's candidate as baseline.
		const storedAttempt = await store.get("attempt", attempt.id, { changeId });
		assert.equal(storedAttempt.record.baseline_snapshot_id, first.snapshot.id);
		const storedChange = await store.get("change", changeId, {});
		assert.ok(storedChange.record.baseline.description.includes(first.snapshot.id));
		assert.equal(storedChange.record.baseline.head, first.snapshot.repository.head);

		// Both changes are listed; the first is untouched byte-for-byte.
		const listed = (await store.listChanges()).map((c) => c.id).sort();
		assert.deepEqual(listed, [first.change.id, changeId]);
		const after = await snapshotFiles();
		assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "the first change gained or lost files");
		for (const [path, bytes] of before) assert.ok(bytes.equals(after.get(path)), `${path} changed bytes`);
		const firstGate = await evaluateAcceptanceGate(store, { change_id: first.change.id, attempt_id: first.attempt.id, host: CAPABLE_HOST });
		assert.equal(firstGate.state, "may-accept", "the first change's gate outcome moved");
	});
});
