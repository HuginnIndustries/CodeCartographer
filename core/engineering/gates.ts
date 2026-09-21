// Freshness, review, and acceptance gates (E06, #404).
//
// ---------------------------------------------------------------------------
// WHAT THIS DECIDES, AND WHAT IT DOES NOT
//
// E01 already decides how to READ an approval that exists: `evaluateApprovalReceipt`
// checks the receipt's internal consistency and `classifyAcceptance` decides
// verified / cooperative / invalid. None of that is re-implemented here.
//
// This module answers the question that comes FIRST: may acceptance be offered
// at all? That question is about the state of the work — is every obligation
// discharged by observed proof against the bytes being accepted, did someone
// review those same bytes, is every blocking objection actually closed — and
// not about the trustworthiness of the channel that would carry the decision.
//
// The two must not be collapsed. A perfect receipt over unproved work is
// paperwork; perfect work with no way to ask a human is not a defect in the
// work. So `needs-human-acceptance` is a distinct state from `refused`, and
// the work is evaluated BEFORE the host's capability is consulted — otherwise
// an incapable host would mask every real blocker behind a capability notice.
//
// LIMITS, stated plainly: a gate cannot establish semantic correctness. Every
// obligation discharged and every objection closed means people and checks
// said so about a specific set of bytes. It does not mean the change is right.
// Nothing here should ever be described as proving that.
// ---------------------------------------------------------------------------

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { checkCandidateFreshness, proofAuthority, proofDischarges } from "./validation.ts";
import type {
	AssurancePolicy,
	AttemptRecord,
	ChangeRecord,
	ProofRecord,
	ReviewRecord,
	SliceRecord,
	SnapshotInput,
	SnapshotRecord,
	StorageBoundary,
} from "./types.ts";
import type { EngineeringStore } from "./store.ts";

/**
 * Stated on every outcome, without exception.
 *
 * A gate can show that recorded checks passed and recorded objections were
 * closed against a specific set of bytes. It cannot show the change is right,
 * and the moment this sentence is optional is the moment someone reads a
 * green gate as a correctness proof.
 */
const ALWAYS_STATED_LIMITATION =
	"gates establish that recorded checks passed and recorded objections were closed against these bytes; semantic correctness remains a review and test claim";

/** Why acceptance cannot be offered, and what would clear it. */
export interface GateBlocker {
	/** Stable identifier for the rule that fired, so callers can branch without parsing prose. */
	code:
		| "obligation-unproved"
		| "proof-claimed"
		| "proof-failed"
		| "proof-stale"
		| "scenario-uncovered"
		| "objection-open"
		| "review-missing"
		| "review-mismatched"
		| "dependency-unaccepted"
		| "attempt-not-ready"
		| "record-unreadable"
		| "review-not-independent"
		| "proof-scenario-uncovered";
	/** What is wrong, in the reader's terms. Free text from records is neutralized. */
	detail: string;
	/** What would clear it. A gate that refuses without saying what to fix gets routed around. */
	remedy: string;
}

export type GateState = "may-accept" | "refused" | "needs-human-acceptance";

export interface GateOutcome {
	state: GateState;
	blockers: GateBlocker[];
	/** True things that narrow what acceptance would mean, without forbidding it. */
	limitations: string[];
}

export interface HostCapability {
	/** Whether the adapter can obtain a human decision at all on this host/client pair. */
	can_obtain_human_decision: boolean;
	storage: {
		boundary: StorageBoundary;
		protection?: string;
		enforced_since?: string;
	};
}

export interface GateRequest {
	change_id: string;
	attempt_id: string;
	host: HostCapability;
	/**
	 * The adapter's re-read of the working tree at acceptance time, if it
	 * performed one. ACCEPTANCE_REQUIRED_RECORDS requires the candidate digest
	 * to equal the tree the adapter re-reads; only the adapter can do that
	 * read — this module sees the record store, not the repository — so a
	 * missing re-read is disclosed as a limitation rather than silently
	 * treated as a pass.
	 */
	candidate_reread?: Pick<SnapshotInput, "coverage" | "manifest" | "repository">;
	/** Defaults to `verified`. `cooperative` is a host-operator policy set outside the workspace. */
	policy?: AssurancePolicy;
}

/**
 * Collapse record-authored free text onto one line before it reaches a
 * document a human reads.
 *
 * A reviewer's objection statement, a slice title, a proof's command: all are
 * authored by whoever wrote the record, and the gate description is read by
 * the person deciding whether to accept. E04 shipped exactly this bug — text
 * containing a newline and `## No blockers` forged a section of the artifact
 * above the real one. A heading or fence must begin a line, so collapsing is
 * what kills it.
 */
function safeText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/[\r\n\u2028\u2029]+/g, " ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
		.trim();
}

async function readRecord<T>(store: EngineeringStore, kind: string, id: string, context: Record<string, string>): Promise<T | null> {
	try {
		const outcome = await store.get(kind as never, id, context);
		return outcome.record as unknown as T;
	} catch {
		return null;
	}
}

/**
 * Everything under an attempt of one kind, and the ids that would not parse.
 *
 * Unreadable records are REPORTED, never silently skipped — the same rule the
 * store applies to its own listings: a corrupt record that vanishes is
 * indistinguishable from one that was never written, which is how history goes
 * missing quietly.
 */
async function readAll<T>(store: EngineeringStore, kind: string, ids: string[], context: Record<string, string>): Promise<{ records: T[]; unreadable: string[] }> {
	const records: T[] = [];
	const unreadable: string[] = [];
	for (const id of ids) {
		const record = await readRecord<T>(store, kind, id, context);
		if (record) records.push(record);
		else unreadable.push(`${kind} ${id}`);
	}
	return { records, unreadable };
}

/**
 * Evaluate whether acceptance may be offered for an attempt.
 *
 * The order is deliberate: the work is judged first and the host's capability
 * only afterwards, so an incapable host can never hide an unproved obligation
 * behind a capability notice.
 */
export async function evaluateAcceptanceGate(store: EngineeringStore, request: GateRequest): Promise<GateOutcome> {
	const blockers: GateBlocker[] = [];
	const limitations: string[] = [];
	const policy: AssurancePolicy = request.policy ?? "verified";

	const change = await readRecord<ChangeRecord>(store, "change", request.change_id, {});
	const attempt = await readRecord<AttemptRecord>(store, "attempt", request.attempt_id, { changeId: request.change_id });
	if (!change || !attempt) {
		// The always-stated limitation belongs on this path too. An earlier
		// revision returned early before adding it, so the one disclosure the
		// module promises to make unconditionally was missing from exactly the
		// outcomes a confused caller is most likely to be reading.
		limitations.push(ALWAYS_STATED_LIMITATION);
		return {
			state: "refused",
			blockers: [
				{
					code: "attempt-not-ready",
					detail: `no ${change ? "attempt" : "change"} record for ${safeText(change ? request.attempt_id : request.change_id)}`,
					remedy: "create the change and attempt before evaluating acceptance",
				},
			],
			limitations,
		};
	}

	const slice = await readRecord<SliceRecord>(store, "slice", attempt.slice_id, { changeId: request.change_id });

	// ACCEPTANCE_REQUIRED_RECORDS names the states each record must be in.
	// Without these, an `accepted` attempt could be accepted a second time, a
	// `failed` attempt could be offered as if it had succeeded, and an
	// `abandoned` slice or change could be accepted after being given up on.
	if (change.state !== "active") {
		blockers.push({
			code: "attempt-not-ready",
			detail: `change ${change.id} is ${safeText(change.state)}, not active`,
			remedy: "only an active change may be accepted; reopen it or accept the change it was superseded by",
		});
	}
	if (slice && slice.state !== "active") {
		blockers.push({
			code: "attempt-not-ready",
			detail: `slice ${slice.id} is ${safeText(slice.state)}, not active`,
			remedy: slice.state === "accepted" ? "this slice is already accepted; a second acceptance decides nothing" : "only an active slice may be accepted",
		});
	}
	if (attempt.outcome !== "ready-for-review" && attempt.outcome !== "needs-human-acceptance") {
		blockers.push({
			code: "attempt-not-ready",
			detail: `attempt ${attempt.id} is ${safeText(attempt.outcome)}`,
			remedy:
				attempt.outcome === "accepted"
					? "this attempt is already accepted; soliciting a second approval asks a human to decide something already decided"
					: "an attempt must reach ready-for-review or needs-human-acceptance before acceptance may be offered",
		});
	}
	const candidateId = attempt.candidate_snapshot_id;
	const candidate = candidateId ? await readRecord<SnapshotRecord>(store, "snapshot", candidateId, { changeId: request.change_id, attemptId: attempt.id }) : null;

	// An attempt with no candidate has nothing to accept: acceptance binds to
	// specific bytes, and there are none.
	if (!candidate) {
		blockers.push({
			code: "attempt-not-ready",
			detail: `attempt ${attempt.id} has no candidate snapshot bound`,
			remedy: "capture a candidate snapshot for this attempt before requesting acceptance",
		});
	} else if (candidate.stability !== "stable") {
		blockers.push({
			code: "proof-stale",
			detail: `candidate ${candidate.id} was captured while the tree was moving`,
			remedy: "recapture the candidate from a settled working tree",
		});
	}

	// `stability` is a property recorded AT CAPTURE. It says nothing about
	// whether the tree moved afterwards, which is the freshness the contract
	// actually requires.
	if (candidate) {
		if (request.candidate_reread) {
			const fresh = checkCandidateFreshness(candidate, request.candidate_reread);
			if (fresh.ok === false) {
				const reason = fresh.errors[0]?.message ?? "digest mismatch";
				blockers.push({
					code: "proof-stale",
					detail: `the working tree no longer matches candidate ${candidate.id}: ${safeText(reason)}`,
					remedy: "recapture the candidate and re-run the checks; the proofs describe bytes that are no longer there",
				});
			}
		} else {
			limitations.push(
				"the adapter supplied no re-read of the working tree, so nothing here shows the tree still matches the candidate; the proofs describe the bytes captured at snapshot time",
			);
		}
	}

	// Records come from the store and nowhere else. An earlier revision took
	// caller-supplied proofs and reviews as an override, which let the agent
	// whose work is being judged choose the evidence it would be judged on:
	// with an open blocking objection on disk, passing a clean review turned
	// `refused` into `may-accept`. A gate whose input the subject controls is
	// not a gate.
	const proofRead = await readAll<ProofRecord>(store, "proof", await listIds(store, request.change_id, attempt.id, "proofs"), { changeId: request.change_id, attemptId: attempt.id });
	const reviewRead = await readAll<ReviewRecord>(store, "review", await listIds(store, request.change_id, attempt.id, "reviews"), { changeId: request.change_id, attemptId: attempt.id });
	const proofs = proofRead.records;
	const reviews = reviewRead.records;

	// H3: a record that will not parse is NOT the same fact as a record that
	// was never written, and `store.ts` says so in as many words about its own
	// listing. A corrupt review that carried a blocking objection would
	// otherwise become no objection at all.
	for (const unreadable of [...proofRead.unreadable, ...reviewRead.unreadable]) {
		blockers.push({
			code: "record-unreadable",
			detail: `${safeText(unreadable)} could not be read`,
			remedy: "repair or remove the unreadable record; a record that cannot be read is not an absent record",
		});
	}

	// ---- every obligation must be discharged, against THIS candidate ----
	for (const obligation of slice?.proof_obligations ?? []) {
		// Only `obligation_id` is matched here, deliberately. A proof is read
		// from `changes/<change_id>/attempts/<attempt_id>/proofs/`, and the
		// store files it by the ids the RECORD carries — so a proof naming a
		// different change lands in a different directory and is never listed
		// for this attempt. Re-checking `change_id`/`attempt_id` here looked
		// like defence in depth and was verified unreachable: with the check
		// removed, a proof rewritten to a foreign change still produced
		// `obligation-unproved`, identical output. A guard that cannot fire is
		// indistinguishable from one that works, so it is not kept.
		const forObligation = proofs.filter((p) => p.obligation_id === obligation.id);
		if (forObligation.length === 0) {
			blockers.push({
				code: "obligation-unproved",
				detail: `obligation ${obligation.id} has no proof`,
				remedy: `run the check for ${obligation.id} and record the observed result`,
			});
			continue;
		}
		// Bound to the candidate first: a proof of the right thing against the
		// wrong bytes is the failure this system exists to catch, and it must
		// not be reported as a generic "unproved".
		const onCandidate = forObligation.filter((p) => candidate !== null && p.snapshot_id === candidate.id);
		if (onCandidate.length === 0) {
			blockers.push({
				code: "proof-stale",
				detail: `obligation ${obligation.id} is proved only against snapshots that are not the bound candidate`,
				remedy: `re-run the check for ${obligation.id} against candidate ${candidate?.id ?? "(none)"}`,
			});
			continue;
		}
		// H2: `proofDischarges` checks the obligation id, result, collector and
		// authority — not which scenarios the proof claims to exercise. E01
		// requires the proof to name the obligation's scenario, and enforces it
		// in bundle validation only, so the gate must do it here.
		const covering = onCandidate.filter((p) => (p.scenario_ids ?? []).includes(obligation.scenario_id));
		if (covering.length === 0) {
			blockers.push({
				code: "proof-scenario-uncovered",
				detail: `obligation ${obligation.id} names scenario ${obligation.scenario_id}, which no proof of it claims to exercise`,
				remedy: `record a proof for ${obligation.id} whose scenario_ids include ${obligation.scenario_id}`,
			});
			continue;
		}
		const discharging = covering.find((p) => proofDischarges(p, obligation, policy));
		if (!discharging) {
			const failed = covering.find((p) => p.result !== "passed");
			if (failed) {
				blockers.push({
					code: "proof-failed",
					detail: `obligation ${obligation.id} is ${failed.result}${failed.block_reason ? `: ${safeText(failed.block_reason)}` : ""}`,
					remedy: `make the check for ${obligation.id} pass, or record why the scenario no longer applies`,
				});
			} else {
				// Passed, but the authority is too weak: a caller-reported
				// claim, or a collector below the obligation's minimum.
				const claimed = covering.find((p) => proofAuthority(p) === "claimed");
				blockers.push({
					code: "proof-claimed",
					detail: claimed
						? `obligation ${obligation.id} is supported only by a caller-reported claim, whatever collector it names`
						: `obligation ${obligation.id} is proved by a collector weaker than its declared minimum ${obligation.minimum_collector}`,
					remedy: `record an observed result for ${obligation.id} from ${obligation.minimum_collector} or stronger`,
				});
			}
		}
	}

	// ---- every acceptance scenario must be claimed by a slice ----
	// A scenario nobody planned to prove is not a scenario that passed. This
	// is checked against the CHANGE's scenarios rather than the slice's, so a
	// slice that simply omits one cannot make it disappear.
	const claimedScenarios = new Set(slice?.scenario_ids ?? []);
	for (const scenario of change.acceptance_scenarios ?? []) {
		if (!claimedScenarios.has(scenario.id)) {
			blockers.push({
				code: "scenario-uncovered",
				detail: `acceptance scenario ${scenario.id} is claimed by no slice in this attempt`,
				remedy: `add a slice that proves ${scenario.id}, or record it as out of scope for this change`,
			});
		}
	}

	// ---- review must have looked at these bytes, with blockers closed ----
	const onThisCandidate = reviews.filter((r) => candidate !== null && r.candidate_snapshot_id === candidate.id && r.candidate_digest === candidate.digest);
	if (reviews.length === 0) {
		blockers.push({
			code: "review-missing",
			detail: "no review of this attempt",
			remedy: "have the candidate reviewed before requesting acceptance",
		});
	} else if (onThisCandidate.length === 0) {
		blockers.push({
			code: "review-mismatched",
			detail: "every review of this attempt looked at a different candidate than the one being accepted",
			remedy: "review the current candidate; a review of other bytes does not carry over",
		});
	} else if (!onThisCandidate.some((r) => r.reviewer?.separation === "declared-separate")) {
		// ACCEPTANCE_REQUIRED_RECORDS: "at least one with `separation:
		// declared-separate`". An earlier revision downgraded this to a
		// limitation on the argument that a same-context review is still a
		// review. That is arguable, but it is not what the contract says, and
		// the contract is explicit that the requirement lives there rather
		// than in this module. Same-context reviews still produce the
		// limitation below when they accompany an independent one.
		blockers.push({
			code: "review-not-independent",
			detail: "every review of this candidate was made in the same context as the work",
			remedy: "obtain at least one review from a declared-separate reviewer; a same-context review is a review, but the contract requires an independent one",
		});
	}

	for (const review of onThisCandidate) {
		for (const objection of review.objections ?? []) {
			if (objection.severity !== "blocking") continue;
			// NOTE: the store refuses both an out-of-domain disposition and a
			// `resolved` objection without `resolution_evidence`, so the two
			// extra conditions below are cross-checks against validator drift,
			// not reachable states. Kept cheap and stated plainly.
			//
			// Allow-list what CLEARS, never what blocks. Listing the blocking
			// dispositions means any unrecognised string — schema drift, a new
			// E01 disposition, a hand-edited record — falls through as cleared.
			// Only `withdrawn`, or `resolved` carrying the resolution evidence
			// E01 requires exactly when resolved, closes a blocking objection;
			// `deferred` is precisely how a blocker quietly stops blocking when
			// nobody is checking.
			const cleared =
				objection.disposition === "withdrawn" ||
				(objection.disposition === "resolved" && typeof objection.resolution_evidence === "string" && objection.resolution_evidence.trim().length > 0);
			if (!cleared) {
				blockers.push({
					code: "objection-open",
					detail: `blocking objection ${objection.id} is ${safeText(objection.disposition)}${objection.disposition === "resolved" ? " but carries no resolution evidence" : ""}: ${safeText(objection.statement)}`,
					remedy: `resolve ${objection.id} with evidence, or withdraw it; deferring does not clear a blocking objection`,
				});
			}
		}
		// E01 defines `remaining_blockers` as exactly the blocking objections
		// that are open or deferred, and `validateReview` enforces it — but
		// only when the objections are well-formed enough to derive from
		// (`derivable`). Every route tried to store a disagreement was refused
		// (out-of-domain disposition, missing severity, ghost id), so this
		// check is NOT currently reachable through the store and no test can
		// honestly assert it fires.
		//
		// It is kept anyway, unlike the unreachable proof-binding check
		// removed above, for one reason: that one duplicated a guarantee the
		// store's own layout provides, while this one guards against a
		// conditional validator weakening. Recorded as untested rather than
		// dressed up as covered.
		if ((review.remaining_blockers ?? []).length > 0) {
			blockers.push({
				code: "objection-open",
				detail: `review ${review.id} lists ${review.remaining_blockers.length} remaining blocker(s): ${review.remaining_blockers.map((id) => safeText(id)).join(", ")}`,
				remedy: "close every remaining blocker, or correct the review if its objections and remaining_blockers disagree",
			});
		}

		if (review.reviewer?.separation !== "declared-separate") {
			limitations.push(
				`review ${review.id} was made in the same context as the work (${safeText(review.reviewer?.context)}); it is a review, but not an independent one`,
			);
		}
	}

	// ---- dependencies must themselves be accepted ----
	for (const dependencyId of slice?.depends_on ?? []) {
		const dependency = await readRecord<SliceRecord>(store, "slice", dependencyId, { changeId: request.change_id });
		if (!dependency) {
			blockers.push({
				code: "dependency-unaccepted",
				detail: `slice ${attempt.slice_id} depends on ${dependencyId}, which is not in this change`,
				remedy: `add slice ${dependencyId} to this change, or remove the dependency`,
			});
			continue;
		}
		if (dependency.state !== "accepted") {
			blockers.push({
				code: "dependency-unaccepted",
				detail: `slice ${attempt.slice_id} depends on ${dependencyId}, which is ${safeText(dependency.state) || "not accepted"}`,
				remedy: `accept ${dependencyId} first; accepting on an unaccepted foundation asserts something nobody agreed to`,
			});
		}
	}

	// ---- disclosures that narrow the meaning without forbidding acceptance ----
	if (request.host.storage.boundary !== "host-enforced") {
		limitations.push(
			"the engineering namespace is not protected from agent tools, so these records could have been rewritten by the agent whose work they describe",
		);
	} else if (request.host.storage.protection !== undefined && request.host.storage.protection !== "continuous-since-initialization") {
		limitations.push(
			`the namespace's protection history is ${safeText(request.host.storage.protection)}: it held records while unprotected, and no timestamp inside a record can show it was not written then`,
		);
	}
	if (policy === "cooperative") {
		limitations.push("this evaluation ran under the cooperative policy, in which caller-reported claims may discharge obligations");
	}

	// A gate can only say that checks ran and people signed off on specific
	// bytes. It cannot say the change is correct, and must not imply it.
	limitations.push(ALWAYS_STATED_LIMITATION);

	if (blockers.length > 0) return { state: "refused", blockers, limitations };

	// Only now: the work is ready, so the host's ability to ask is the
	// remaining question. Checked last precisely so it cannot mask a blocker.
	if (!request.host.can_obtain_human_decision) {
		return { state: "needs-human-acceptance", blockers: [], limitations };
	}

	return { state: "may-accept", blockers: [], limitations };
}

/** Ids of an attempt's child records of one kind, empty when the directory is absent. */
async function listIds(store: EngineeringStore, changeId: string, attemptId: string, directory: "proofs" | "reviews"): Promise<string[]> {
	try {
		const entries = await readdir(join(store.root, "changes", changeId, "attempts", attemptId, directory));
		return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
	} catch {
		return [];
	}
}

/**
 * Render record-authored text so it cannot be read as this document's own
 * structure.
 *
 * `safeText` collapses newlines, which stops an attacker OPENING a line. It
 * does not stop text that matches a line the document already begins — a
 * limitation rendered as `- # Acceptance may be offered` still contains the
 * heading as a whole line once a reader's eye (or a renderer that stops at the
 * first `#`) reaches it. Escaping the leading markdown character at render
 * time closes that, and does so for every future call site rather than relying
 * on each one remembering to sanitize.
 */
function inert(value: string): string {
	return value.replace(/^([#>`~\-*_=+|])/, "\\$1").replace(/(^|\s)(#{1,6}\s)/g, "$1\\$2");
}

/**
 * The gate outcome as text a person reads before deciding.
 *
 * Record-authored free text is already collapsed onto one line by `safeText`
 * at the point each blocker was built, so nothing here can open a heading or
 * a fence. The structure below is the only structure in the document.
 */
export function describeGateOutcome(outcome: GateOutcome): string {
	const lines: string[] = [];
	const heading =
		outcome.state === "may-accept"
			? "# Acceptance may be offered"
			: outcome.state === "needs-human-acceptance"
				? "# Ready, but this host cannot obtain a human decision"
				: "# Acceptance refused";
	lines.push(heading, "");

	if (outcome.state === "refused") {
		lines.push(`## Blockers (${outcome.blockers.length})`, "");
		for (const blocker of outcome.blockers) {
			lines.push(`- **${blocker.code}** — ${inert(blocker.detail)}`, `  - Remedy: ${inert(blocker.remedy)}`);
		}
		lines.push("");
	} else if (outcome.state === "needs-human-acceptance") {
		lines.push("Every gate passed. The host/client pair cannot obtain a human decision, so acceptance must be recorded through a channel that can.", "");
	} else {
		lines.push("Every gate passed and this host can obtain a human decision.", "");
	}

	if (outcome.limitations.length > 0) {
		lines.push("## What this does not establish", "");
		for (const limitation of outcome.limitations) lines.push(`- ${inert(limitation)}`);
		lines.push("");
	}

	return lines.join("\n");
}
