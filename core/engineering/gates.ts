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

import { proofAuthority, proofDischarges } from "./validation.ts";
import type {
	AssurancePolicy,
	AttemptRecord,
	ChangeRecord,
	ProofRecord,
	ReviewRecord,
	SliceRecord,
	SnapshotRecord,
	StorageBoundary,
} from "./types.ts";
import type { EngineeringStore } from "./store.ts";

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
		| "attempt-not-ready";
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

/** Everything under an attempt of one kind, skipping records that no longer parse. */
async function readAll<T>(store: EngineeringStore, kind: string, ids: string[], context: Record<string, string>): Promise<T[]> {
	const records: T[] = [];
	for (const id of ids) {
		const record = await readRecord<T>(store, kind, id, context);
		if (record) records.push(record);
	}
	return records;
}

/**
 * Evaluate whether acceptance may be offered for an attempt.
 *
 * The order is deliberate: the work is judged first and the host's capability
 * only afterwards, so an incapable host can never hide an unproved obligation
 * behind a capability notice.
 */
export async function evaluateAcceptanceGate(
	store: EngineeringStore,
	request: GateRequest,
	supplied?: { proofs?: ProofRecord[]; reviews?: ReviewRecord[] },
): Promise<GateOutcome> {
	const blockers: GateBlocker[] = [];
	const limitations: string[] = [];
	const policy: AssurancePolicy = request.policy ?? "verified";

	const change = await readRecord<ChangeRecord>(store, "change", request.change_id, {});
	const attempt = await readRecord<AttemptRecord>(store, "attempt", request.attempt_id, { changeId: request.change_id });
	if (!change || !attempt) {
		return {
			state: "refused",
			blockers: [
				{
					code: "attempt-not-ready",
					detail: `no ${change ? "attempt" : "change"} record for ${change ? request.attempt_id : request.change_id}`,
					remedy: "create the change and attempt before evaluating acceptance",
				},
			],
			limitations,
		};
	}

	const slice = await readRecord<SliceRecord>(store, "slice", attempt.slice_id, { changeId: request.change_id });
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

	const proofs = supplied?.proofs ?? (await readAll<ProofRecord>(store, "proof", await listIds(store, request.change_id, attempt.id, "proofs"), { changeId: request.change_id, attemptId: attempt.id }));
	const reviews = supplied?.reviews ?? (await readAll<ReviewRecord>(store, "review", await listIds(store, request.change_id, attempt.id, "reviews"), { changeId: request.change_id, attemptId: attempt.id }));

	// ---- every obligation must be discharged, against THIS candidate ----
	for (const obligation of slice?.proof_obligations ?? []) {
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
		const discharging = onCandidate.find((p) => proofDischarges(p, obligation, policy));
		if (!discharging) {
			const failed = onCandidate.find((p) => p.result !== "passed");
			if (failed) {
				blockers.push({
					code: "proof-failed",
					detail: `obligation ${obligation.id} is ${failed.result}${failed.block_reason ? `: ${safeText(failed.block_reason)}` : ""}`,
					remedy: `make the check for ${obligation.id} pass, or record why the scenario no longer applies`,
				});
			} else {
				// Passed, but the authority is too weak: a caller-reported
				// claim, or a collector below the obligation's minimum.
				const claimed = onCandidate.find((p) => proofAuthority(p) === "claimed");
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
	}

	for (const review of onThisCandidate) {
		for (const objection of review.objections ?? []) {
			if (objection.severity !== "blocking") continue;
			// E01 is explicit: `deferred` keeps a blocking objection blocking.
			// Only `resolved` (with evidence) or `withdrawn` clears it, and
			// deferral is precisely how a blocker becomes a non-blocker when
			// nobody is checking.
			if (objection.disposition === "open" || objection.disposition === "deferred") {
				blockers.push({
					code: "objection-open",
					detail: `blocking objection ${objection.id} is ${objection.disposition}: ${safeText(objection.statement)}`,
					remedy: `resolve ${objection.id} with evidence, or withdraw it; deferring does not clear a blocking objection`,
				});
			}
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
	limitations.push("gates establish that recorded checks passed and recorded objections were closed against these bytes; semantic correctness remains a review and test claim");

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
			lines.push(`- **${blocker.code}** — ${blocker.detail}`, `  - Remedy: ${blocker.remedy}`);
		}
		lines.push("");
	} else if (outcome.state === "needs-human-acceptance") {
		lines.push("Every gate passed. The host/client pair cannot obtain a human decision, so acceptance must be recorded through a channel that can.", "");
	} else {
		lines.push("Every gate passed and this host can obtain a human decision.", "");
	}

	if (outcome.limitations.length > 0) {
		lines.push("## What this does not establish", "");
		for (const limitation of outcome.limitations) lines.push(`- ${limitation}`);
		lines.push("");
	}

	return lines.join("\n");
}
