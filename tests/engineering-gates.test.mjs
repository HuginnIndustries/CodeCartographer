// Freshness, review, and acceptance gates (E06, #404).
//
// What "accepted" has to mean, and what it cannot mean.
//
// E01 already decides how to READ an approval that exists: `evaluateApprovalReceipt`
// checks the receipt, `classifyAcceptance` decides verified vs cooperative vs
// invalid. None of that is re-implemented here. E06 answers the question that
// comes first — may acceptance be OFFERED at all? — and that question is about
// the state of the work, not the trustworthiness of the channel.
//
// The gate refuses when:
//   - an obligation has no discharging proof (a PASS string is not a proof),
//   - proof was measured against bytes that are no longer the candidate,
//   - an acceptance scenario is claimed by no slice, or proved by nothing,
//   - a blocking objection is open or merely deferred,
//   - the review looked at a different candidate than the one being accepted,
//   - a dependency slice is not itself accepted,
//   - the host cannot obtain a human decision at all.
//
// The last one returns `needs-human-acceptance` rather than a refusal: the work
// may be perfect and the host simply unable to ask. That is a different fact
// from "this is not ready", and collapsing the two would either block good work
// or silently accept unreviewed work.
//
// Tests are written against the decision table, not the implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, evaluateAcceptanceGate, describeGateOutcome } = engineering;

const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));

// E01 owns every shape below. Reading the shipped fixtures rather than
// restating them means a contract change breaks this suite loudly instead of
// leaving it asserting against a stale idea of a record.
const CHANGE = await readFixture("change.json");
const SLICE = await readFixture("slice.json");
const ATTEMPT = await readFixture("attempt.json");
const SNAPSHOT = await readFixture("snapshot-candidate.json");
const PROOF = await readFixture("proof.json");
const PROOF2 = await readFixture("proof-second-obligation.json");
const REVIEW = await readFixture("review.json");

/**
 * A workspace in the state where acceptance is legitimately available:
 * both obligations discharged by observed proof against the bound candidate,
 * and a review by a declared-separate reviewer with no remaining blockers.
 */
async function withReadyWorkspace(fn, mutate = (records) => records) {
	const root = await mkdtemp(join(tmpdir(), "codecarto-e06-gates-"));
	try {
		const store = await openStore(join(root, ".codecarto"));
		const records = mutate({
			change: { ...CHANGE },
			slice: { ...SLICE },
			attempt: { ...ATTEMPT },
			snapshot: { ...SNAPSHOT },
			proofs: [observedProof(PROOF), observedProof(PROOF2)],
			reviews: [{ ...REVIEW }],
		});
		for (const record of [records.change, records.slice, records.attempt, records.snapshot]) {
			if (record) await store.put(record);
		}
		for (const extra of records.extraSlices ?? []) await store.put(extra);
		for (const proof of records.proofs ?? []) await store.put(proof);
		for (const review of records.reviews ?? []) await store.put(review);
		return await fn({ store, root, records });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The shipped proof fixtures are caller-attested; acceptance needs observed proof. */
const observedProof = (proof) => ({
	...proof,
	provenance: { ...proof.provenance, attested_by: "host-tool-result", tool_call_id: `call_${proof.id.slice(-4)}` },
});

/** A host that can ask a human. The registry is supplied explicitly so no test depends on the shipped one being non-empty. */
const CAPABLE_HOST = {
	can_obtain_human_decision: true,
	storage: { boundary: "host-enforced", protection: "continuous-since-initialization", enforced_since: "2026-09-17T09:00:00Z" },
};

// ---------------------------------------------------------------- the happy path

test("a change with discharged obligations, a clean review, and a capable host may be accepted", async () => {
	// The control. Without it, every refusal below could be produced by an
	// unrelated defect and still look like the gate working.
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
		});
		assert.equal(outcome.state, "may-accept", `${JSON.stringify(outcome.blockers)}`);
		assert.deepEqual(outcome.blockers, []);
	});
});

// ---------------------------------------------------------------- proof gates

test("an obligation with no proof at all refuses acceptance", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /O2/.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, proofs: [r.proofs[0]] }),
	);
});

test("a claimed proof cannot discharge an obligation, however it is labelled", async () => {
	// The central refusal of the whole system, restated at the gate: a prose
	// PASS carried by a caller is not evidence, and calling its collector
	// `host-observed` does not change that.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /claim|observ/i.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({
			...r,
			proofs: [{ ...r.proofs[0], provenance: { source: "mcp:claude-code", attested_by: "caller" } }, r.proofs[1]],
		}),
	);
});

test("a failing proof refuses acceptance even when every other gate passes", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
		},
		(r) => ({ ...r, proofs: [{ ...r.proofs[0], result: "failed", exit_code: 1 }, r.proofs[1]] }),
	);
});

test("proof measured against a superseded candidate refuses acceptance", async () => {
	// Stale evidence is the failure mode this system exists to prevent: the
	// check really ran and really passed, against bytes that are no longer
	// the ones being accepted.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /stale|candidate|snapshot/i.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => {
			const otherSnapshot = { ...r.snapshot, id: "snp_0000000000000000000000d5" };
			return { ...r, proofs: [{ ...r.proofs[0], snapshot_id: otherSnapshot.id }, r.proofs[1]] };
		},
	);
});

// ---------------------------------------------------------------- coverage gates

test("an acceptance scenario no slice claims refuses acceptance", async () => {
	// A scenario nobody planned to prove is not a scenario that passed; the
	// absence must surface as a refusal rather than as silence.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /S3|uncovered|no slice/i.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({
			...r,
			change: { ...r.change, acceptance_scenarios: [...r.change.acceptance_scenarios, { id: "S3", kind: "behavior", description: "an unclaimed scenario" }] },
		}),
	);
});

// ---------------------------------------------------------------- review gates

test("an open blocking objection refuses acceptance", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /R1|blocking|objection/i.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({
			...r,
			reviews: [
				{
					...r.reviews[0],
					objections: [{ ...r.reviews[0].objections[0], disposition: "open", resolution_evidence: undefined }],
					remaining_blockers: ["R1"],
				},
			],
		}),
	);
});

test("a deferred blocking objection still blocks", async () => {
	// E01 is explicit that `deferred` keeps a blocking objection blocking;
	// only `resolved` with evidence, or `withdrawn`, clears it. Deferral is
	// how a blocker quietly becomes a non-blocker if nobody checks.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
		},
		(r) => ({
			...r,
			reviews: [
				{
					...r.reviews[0],
					objections: [{ ...r.reviews[0].objections[0], disposition: "deferred", resolution_evidence: undefined, disposition_note: "next sprint" }],
					remaining_blockers: ["R1"],
				},
			],
		}),
	);
});

test("a review of a different candidate does not count as a review of this one", async () => {
	// The review's whole value is that someone looked at THESE bytes.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /review|candidate|digest/i.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, reviews: [{ ...r.reviews[0], candidate_digest: `sha256:${"7".repeat(64)}` }] }),
	);
});

test("no review at all refuses acceptance", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
		},
		(r) => ({ ...r, reviews: [] }),
	);
});

test("a same-context review is reported as weaker, not silently accepted", async () => {
	// `same-context` is a real review — it just is not an independent one.
	// The gate must say so rather than treating it as equivalent.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.ok(outcome.limitations.some((l) => /separat|independ|same context/i.test(l)), JSON.stringify(outcome.limitations));
		},
		(r) => ({
			...r,
			reviews: [{ ...r.reviews[0], reviewer: { ...r.reviews[0].reviewer, context: "same-session", separation: "same-context" } }],
		}),
	);
});

// ---------------------------------------------------------------- host capability

test("a host that cannot ask a human returns needs-human-acceptance, not a refusal", async () => {
	// The work may be perfect and the host simply unable to ask. Collapsing
	// this into "refused" would report ready work as unready; collapsing it
	// into "may-accept" would accept without anyone deciding.
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: { ...CAPABLE_HOST, can_obtain_human_decision: false },
		});
		assert.equal(outcome.state, "needs-human-acceptance");
		assert.deepEqual(outcome.blockers, [], "a capable-work/incapable-host state is not a blocker list");
	});
});

test("an incapable host does not mask a real refusal", async () => {
	// Order matters: if the work is not ready, that is the answer regardless
	// of whether the host could have asked.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: { ...CAPABLE_HOST, can_obtain_human_decision: false },
			});
			assert.equal(outcome.state, "refused", "an incapable host hid an unproved obligation");
		},
		(r) => ({ ...r, proofs: [r.proofs[0]] }),
	);
});

test("an unprotected namespace is disclosed as a limitation", async () => {
	// A cooperative storage boundary does not forbid acceptance, but it means
	// the records could have been rewritten by an agent tool, and a reader
	// must be told.
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: { ...CAPABLE_HOST, storage: { boundary: "none", protection: "unknown" } },
		});
		assert.ok(outcome.limitations.some((l) => /boundary|protect|rewritten/i.test(l)), JSON.stringify(outcome.limitations));
	});
});

// ---------------------------------------------------------------- dependencies

test("a slice whose dependency is not accepted refuses acceptance", async () => {
	// Accepting a slice whose prerequisite is unaccepted asserts a foundation
	// that nobody agreed to.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /depend/i.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, slice: { ...r.slice, depends_on: ["slc_0000000000000000000000f9"] } }),
	);
});

// ---------------------------------------------------------------- reporting

test("every blocker names what would clear it", async () => {
	// A gate that says "refused" without saying what to fix turns into a
	// thing people route around.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			for (const blocker of outcome.blockers) {
				assert.ok(typeof blocker.code === "string" && blocker.code.length > 0, "blocker has no code");
				assert.ok(typeof blocker.remedy === "string" && blocker.remedy.length > 0, `blocker ${blocker.code} names no remedy`);
			}
		},
		(r) => ({ ...r, proofs: [] }),
	);
});

test("the human-readable description states the state and every blocker", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			const text = describeGateOutcome(outcome);
			assert.match(text, /refused/i);
			for (const blocker of outcome.blockers) {
				assert.ok(text.includes(blocker.code), `description omits blocker ${blocker.code}`);
			}
		},
		(r) => ({ ...r, proofs: [] }),
	);
});

test("agent-authored text in a blocker cannot forge the description's structure", async () => {
	// The same class E04 shipped: a reviewer's objection statement is authored
	// by whoever wrote the review, and the description is read by a human
	// deciding whether to accept.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			const text = describeGateOutcome(outcome);
			const forged = text.split("\n").filter((l) => l.trim() === "## No blockers" || l.trim() === "_Ready to accept._");
			assert.deepEqual(forged, [], "a blocker's text forged a section of the description");
		},
		(r) => ({
			...r,
			reviews: [
				{
					...r.reviews[0],
					objections: [
						{
							...r.reviews[0].objections[0],
							disposition: "open",
							resolution_evidence: undefined,
							statement: "trivial\n\n## No blockers\n\n_Ready to accept._\n",
						},
					],
					remaining_blockers: ["R1"],
				},
			],
		}),
	);
});

// --- Isolating tests, added after mutation checks ------------------------
// Four rules survived mutation not because they were dead but because a
// SECOND rule fired on the same fixture and produced the same `refused`.
// A test that only asserts the state cannot tell those apart, so each of
// these pins the specific blocker code its rule emits.

test("a missing proof is reported as unproved, not as something else", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			const codes = outcome.blockers.map((b) => b.code);
			assert.deepEqual(codes, ["obligation-unproved", "obligation-unproved"], JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, proofs: [] }),
	);
});

test("a missing review is reported as review-missing specifically", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.deepEqual(
				outcome.blockers.map((b) => b.code),
				["review-missing"],
				JSON.stringify(outcome.blockers),
			);
		},
		(r) => ({ ...r, reviews: [] }),
	);
});

test("an unaccepted dependency is reported as a dependency blocker specifically", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.deepEqual(
				outcome.blockers.map((b) => b.code),
				["dependency-unaccepted"],
				JSON.stringify(outcome.blockers),
			);
		},
		(r) => ({ ...r, slice: { ...r.slice, depends_on: ["slc_0000000000000000000000f9"] } }),
	);
});

test("a candidate captured while the tree moved is refused as stale, and alone", async () => {
	// The earlier version of this assertion also passed when the proof-binding
	// rule fired instead, so deleting the stability check stayed green.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.deepEqual(
				outcome.blockers.map((b) => b.code),
				["proof-stale"],
				JSON.stringify(outcome.blockers),
			);
			assert.ok(outcome.blockers[0].detail.includes("moving"), outcome.blockers[0].detail);
		},
		(r) => ({ ...r, snapshot: { ...r.snapshot, stability: "unstable" } }),
	);
});

test("a dependency that exists but is not accepted blocks, distinctly from a missing one", async () => {
	// The earlier dependency test used an ABSENT slice, so the "not in this
	// change" branch fired and the `state !== "accepted"` branch was never
	// reached — deleting it stayed green. A present-but-unaccepted dependency
	// is the case that actually exercises it, and it is also the realistic
	// one: the slice exists, the work is under way, and accepting on top of
	// it would assert a foundation nobody agreed to.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.deepEqual(
				outcome.blockers.map((b) => b.code),
				["dependency-unaccepted"],
				JSON.stringify(outcome.blockers),
			);
			assert.match(outcome.blockers[0].detail, /active/, outcome.blockers[0].detail);
		},
		(r) => {
			const dependency = { ...r.slice, id: "slc_0000000000000000000000f8", state: "active", depends_on: [] };
			return { ...r, extraSlices: [dependency], slice: { ...r.slice, depends_on: [dependency.id] } };
		},
	);
});

test("an accepted dependency does not block", async () => {
	// The control: without it, the assertion above could be satisfied by any
	// dependency at all failing, rather than by the state check.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "may-accept", JSON.stringify(outcome.blockers));
		},
		(r) => {
			const dependency = { ...r.slice, id: "slc_0000000000000000000000f7", state: "accepted", depends_on: [] };
			return { ...r, extraSlices: [dependency], slice: { ...r.slice, depends_on: [dependency.id] } };
		},
	);
});

// --- Found in adversarial review of the first implementation --------------

test("caller-supplied records cannot replace what the store holds", async () => {
	// The first revision took proofs/reviews as an override parameter, so the
	// agent being judged could choose its own evidence: with an open blocking
	// objection on disk, passing a clean review turned refused into
	// may-accept. The parameter is gone; this pins that it cannot come back
	// as a third argument.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const cleanReview = { ...REVIEW };
			const outcome = await evaluateAcceptanceGate(
				store,
				{ change_id: records.change.id, attempt_id: records.attempt.id, host: CAPABLE_HOST },
				{ reviews: [cleanReview], proofs: [] },
			);
			assert.equal(outcome.state, "refused", "a caller-supplied record overrode the store");
		},
		(r) => ({
			...r,
			reviews: [
				{
					...r.reviews[0],
					objections: [{ ...r.reviews[0].objections[0], disposition: "open", resolution_evidence: undefined }],
					remaining_blockers: ["R1"],
				},
			],
		}),
	);
});

test("a same-context review alone does not satisfy the contract's independence requirement", async () => {
	// ACCEPTANCE_REQUIRED_RECORDS: "at least one with separation:
	// declared-separate". The first revision downgraded this to a limitation.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.deepEqual(
				outcome.blockers.map((b) => b.code),
				["review-not-independent"],
				JSON.stringify(outcome.blockers),
			);
		},
		(r) => ({
			...r,
			reviews: [{ ...r.reviews[0], reviewer: { ...r.reviews[0].reviewer, context: "separate-session", separation: "same-context" } }],
		}),
	);
});

test("an attempt that is already accepted is not offered for acceptance again", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /already accepted/.test(b.remedy)), JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, attempt: { ...r.attempt, outcome: "accepted" } }),
	);
});

test("an attempt that failed is not offered for acceptance", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.deepEqual(
				outcome.blockers.map((b) => b.code),
				["attempt-not-ready"],
				JSON.stringify(outcome.blockers),
			);
		},
		(r) => ({ ...r, attempt: { ...r.attempt, outcome: "failed" } }),
	);
});

test("an abandoned slice and an abandoned change are both refused", async () => {
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /slice .* is abandoned/.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, slice: { ...r.slice, state: "abandoned" } }),
	);
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.ok(outcome.blockers.some((b) => /change .* is abandoned/.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, change: { ...r.change, state: "abandoned" } }),
	);
});

test("a proof that does not claim the obligation's scenario does not discharge it", async () => {
	// proofDischarges checks obligation id, result, collector and authority —
	// not which scenarios the proof exercises. E01 requires the proof to name
	// the obligation's scenario and enforces it only in bundle validation.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(
				outcome.blockers.every((b) => b.code === "proof-scenario-uncovered"),
				JSON.stringify(outcome.blockers),
			);
		},
		(r) => ({ ...r, proofs: r.proofs.map((p) => ({ ...p, scenario_ids: ["S_unrelated"] })) }),
	);
});

test("an attempt with no candidate snapshot is refused", async () => {
	// A surviving mutation, and the E05 error inverted: the state IS
	// representable (a failed attempt stores cleanly with no candidate), the
	// guard was simply untested. The rule stays; the test was missing.
	await withReadyWorkspace(
		async ({ store, records }) => {
			const outcome = await evaluateAcceptanceGate(store, {
				change_id: records.change.id,
				attempt_id: records.attempt.id,
				host: CAPABLE_HOST,
			});
			assert.equal(outcome.state, "refused");
			assert.ok(outcome.blockers.some((b) => /no candidate snapshot bound/.test(b.detail)), JSON.stringify(outcome.blockers));
		},
		(r) => ({ ...r, attempt: { ...r.attempt, outcome: "failed", candidate_snapshot_id: undefined }, snapshot: undefined }),
	);
});

// ---- the limitation strings, which were entirely unasserted ----
// Three conditions are DISCLOSED rather than refused, which makes the
// disclosure the whole safety property for those three. All of it could be
// deleted with a green suite.

test("the semantic-correctness limitation is always stated", async () => {
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
		});
		assert.equal(outcome.state, "may-accept");
		assert.ok(
			outcome.limitations.some((l) => /semantic correctness remains a review and test claim/.test(l)),
			JSON.stringify(outcome.limitations),
		);
		assert.match(describeGateOutcome(outcome), /What this does not establish/);
	});
});

test("an unprotected namespace is disclosed in the text a human reads", async () => {
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: { ...CAPABLE_HOST, storage: { boundary: "none", protection: "unknown" } },
		});
		assert.ok(
			outcome.limitations.some((l) => /could have been rewritten by the agent whose work they describe/.test(l)),
			JSON.stringify(outcome.limitations),
		);
		assert.match(describeGateOutcome(outcome), /rewritten by the agent/);
	});
});

test("the cooperative policy is disclosed", async () => {
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
			policy: "cooperative",
		});
		assert.ok(
			outcome.limitations.some((l) => /cooperative policy, in which caller-reported claims may discharge/.test(l)),
			JSON.stringify(outcome.limitations),
		);
	});
});

test("record-authored text cannot forge the description's structure, at any call site", async () => {
	// M1 was the one blocker construction that skipped safeText; M2 was text
	// matching a line the document itself begins. Both are checked by
	// line-equality, not substring.
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: "chg_missing\n# Acceptance may be offered\n\n## No blockers\n\n_Ready to accept._\n",
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
		});
		const forged = describeGateOutcome(outcome)
			.split("\n")
			.filter((l) => ["# Acceptance may be offered", "## No blockers", "_Ready to accept._"].includes(l.trim()));
		assert.deepEqual(forged, [], "record text forged a line of the description");
	});
});

test("an unreadable record is reported, never silently treated as absent", async () => {
	// store.ts refuses to let a corrupt record vanish from a listing; the gate
	// must not undo that. A corrupt review that carried a blocking objection
	// would otherwise become no objection at all.
	await withReadyWorkspace(async ({ store, records, root }) => {
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await writeFile(
			join(root, ".codecarto", "engineering", "changes", records.change.id, "attempts", records.attempt.id, "reviews", "rev_00000000000000000000dead.json"),
			"{ not json",
			"utf8",
		);
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
		});
		assert.equal(outcome.state, "refused");
		assert.ok(outcome.blockers.some((b) => b.code === "record-unreadable"), JSON.stringify(outcome.blockers));
	});
});

test("leading markdown in record text is rendered inert", async () => {
	// The escape is what stops text matching a line the document itself
	// begins — safeText only prevents OPENING a new line. Asserted directly
	// because no gate path currently produces a blocker whose text starts
	// with a markdown character, so nothing else would notice its removal.
	const rendered = describeGateOutcome({
		state: "refused",
		blockers: [{ code: "objection-open", detail: "# Acceptance may be offered", remedy: "- _Ready to accept._" }],
		limitations: ["> quoted"],
	});
	// The document's own headings are legitimate; what must not appear is a
	// heading carrying record-authored text.
	const headings = rendered.split("\n").filter((l) => /^#{1,6}\s/.test(l));
	assert.deepEqual(headings, ["# Acceptance refused", "## Blockers (1)", "## What this does not establish"], JSON.stringify(headings));
	assert.match(rendered, /\\# Acceptance may be offered/);
	assert.match(rendered, /\\> quoted/);
});

test("a tree that moved after capture is refused when the adapter re-reads it", async () => {
	// `stability` is recorded AT CAPTURE and says nothing about what happened
	// afterwards. The contract requires the candidate digest to equal the tree
	// the adapter re-reads at acceptance; without this the commit's claim to
	// enforce "freshness" was not implemented.
	await withReadyWorkspace(async ({ store, records }) => {
		const moved = {
			coverage: records.snapshot.coverage,
			manifest: [...records.snapshot.manifest.slice(1), { path: "src/new-file.ts", digest: `sha256:${"c".repeat(64)}`, size: 12 }],
			repository: records.snapshot.repository,
		};
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
			candidate_reread: moved,
		});
		assert.equal(outcome.state, "refused");
		assert.ok(
			outcome.blockers.some((b) => b.code === "proof-stale" && /no longer matches/.test(b.detail)),
			JSON.stringify(outcome.blockers),
		);
	});
});

test("an unchanged tree passes the freshness check", async () => {
	// The control: without it the refusal above could come from any mismatch.
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
			candidate_reread: {
				coverage: records.snapshot.coverage,
				manifest: records.snapshot.manifest,
				repository: records.snapshot.repository,
			},
		});
		assert.equal(outcome.state, "may-accept", JSON.stringify(outcome.blockers));
		assert.ok(!outcome.limitations.some((l) => /no re-read/.test(l)), "a supplied re-read should not be disclosed as missing");
	});
});

test("a missing re-read is disclosed, not silently treated as fresh", async () => {
	await withReadyWorkspace(async ({ store, records }) => {
		const outcome = await evaluateAcceptanceGate(store, {
			change_id: records.change.id,
			attempt_id: records.attempt.id,
			host: CAPABLE_HOST,
		});
		assert.equal(outcome.state, "may-accept");
		assert.ok(
			outcome.limitations.some((l) => /no re-read of the working tree/.test(l)),
			JSON.stringify(outcome.limitations),
		);
	});
});
