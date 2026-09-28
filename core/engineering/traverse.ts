// The supervised Traverse loop (E08, #406).
//
// ---------------------------------------------------------------------------
// WHAT THIS DECIDES, AND WHAT IT REFUSES TO DECIDE
//
// Everything before this module records facts: a change exists, an attempt
// produced these bytes, a check was observed, a reviewer objected, a gate
// found no blockers. None of it says what to do next.
//
// This module answers exactly one question, from the records alone:
//
//     given what is on disk, what is the next single bounded action?
//
// It does NOT do the action. There is no exec here, no file write into the
// target repository, no provider call, no GitHub call. The host executes; this
// says what executing would mean and when to stop. That separation is the
// whole reason the records are worth keeping -- a loop that both decided and
// acted could always launder its own decision into its own evidence.
//
// THREE PROPERTIES THE LOOP MUST HAVE
//
// 1. Bounded. Every step names its limits. A step that says "run the tests"
//    without saying what would end the run is an invitation to spin, and the
//    host has no basis to stop. A host that declares no bounds at all is
//    refused outright rather than defaulted to something generous.
//
// 2. Resumable from disk. A fresh session with no memory must reach the same
//    next action as the session that died. This is why the step is a pure
//    function of the records and the host's declared capability: anything
//    derived from the clock or from process state would make two sessions
//    disagree about the same change.
//
// 3. Non-repeating. A lost acknowledgement must not become a second side
//    effect. An attempt already recorded as `running` is resumed, never
//    started again, and every step carries a key derived from the records so
//    a host can deduplicate its own retries.
//
// WHY THE ORDER OF THE CHECKS MATTERS
//
// Capability is consulted only where it is actually needed. Checking "can this
// host obtain a human decision?" first would stop a change that has not even
// been planned yet, reporting a capability problem when the real answer is
// "write some slices". The loop judges the WORK first and the HOST second --
// the same ordering the acceptance gate uses, for the same reason.

import type { AttemptRecord, ChangeRecord, ProofRecord, ReviewRecord, SliceRecord, StorageBoundary } from "./types.ts";
import type { EngineeringStore } from "./store.ts";
import { boundCandidate, judgeApprovals, listAttemptRecords } from "./lifecycle.ts";
import { evaluateAcceptanceGate } from "./gates.ts";
import { createHash } from "node:crypto";

/** Every reason the loop can stop. A stop is always one of these, never prose. */
export const TRAVERSE_STOP_REASONS = [
	"unknown-change",
	"change-concluded",
	"attempt-budget-exhausted",
	"host-cannot-execute",
	"host-cannot-obtain-human-decision",
	"awaiting-human-decision",
	"blocked-needs-operator",
] as const;

export type TraverseStopReason = (typeof TRAVERSE_STOP_REASONS)[number];

/** The actions the loop can ask for. One per step, never a list. */
export const TRAVERSE_ACTIONS = [
	"plan-slices",
	"start-attempt",
	"resume-attempt",
	"capture-candidate",
	"record-observations",
	"request-review",
	"address-objections",
	"request-human-acceptance",
	"retry-after-failure",
	"stop",
] as const;

export type TraverseAction = (typeof TRAVERSE_ACTIONS)[number];

/** What the host says it can do. Declared, never inferred. */
export interface TraverseHost {
	can_obtain_human_decision: boolean;
	can_execute: boolean;
	storage: { boundary: string; protection?: string };
	/**
	 * Required. A host that declares no bounds does not get a default: an
	 * unbounded retry loop against a real repository is the failure this
	 * module exists to prevent, and silently choosing a limit on the host's
	 * behalf would hide that the host never chose one.
	 */
	bounds?: { max_attempts: number; max_wall_clock_ms: number };
}

export interface TraverseRequest {
	change_id: string;
	host: TraverseHost;
}

export interface TraverseStep {
	action: TraverseAction;
	/** Present exactly when `action` is `stop`. */
	stop_reason?: TraverseStopReason;
	/** Why this action and not another, in terms a host can act on. */
	rationale: string;
	bounds: { limits: string[] };
	/** What the loop read to get here, so a resumed session can say so. */
	resumed_from?: { attempt_id: string; outcome: string };
	/** Prior failures and blockers, surfaced rather than buried. */
	history: string[];
	/**
	 * Derived from the records, never the clock: a host retrying a step it
	 * already performed presents the same key and can recognize its own work.
	 */
	idempotency_key: string;
}

/**
 * Decide the next bounded action for a change.
 *
 * Pure with respect to the store: it reads, and returns. Two calls against
 * unchanged records return identical steps, which is what makes a resumed
 * session agree with the one it replaced.
 */
export async function planTraverseStep(store: EngineeringStore, request: TraverseRequest): Promise<TraverseStep> {
	// Presence was not enough. `NaN` passed a typeof check and then defeated
	// the budget entirely, because `failures >= NaN` is false forever: the
	// loop retried without limit while advertising "attempts remaining NaN"
	// as its stated bound. A bound that cannot bound is worse than a missing
	// one, because it reads as a limit in the step it returns.
	const bounds = request.host?.bounds;
	const bounded = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
	if (!bounds || !Number.isInteger(bounds.max_attempts) || !bounded(bounds.max_attempts) || !bounded(bounds.max_wall_clock_ms)) {
		throw new Error(
			"the host must declare real bounds: max_attempts a positive integer and max_wall_clock_ms a positive finite number. An unbounded loop is not a default, and choosing a limit here would hide that the host never chose one",
		);
	}

	try {
		return await planFromRecords(store, request, bounds);
	} catch (error) {
		if (error instanceof TraverseUnreadableError) {
			// Deliberately a stop rather than a throw: the caller asked what to
			// do next, and "stop, a person must look at this" IS the answer.
			// Throwing would push handling onto every host, and a host that
			// catches broadly ends up back at fail-open.
			return stop("blocked-needs-operator", `${error.message}. The loop will not proceed while a record cannot be read`, []);
		}
		throw error;
	}
}

async function planFromRecords(
	store: EngineeringStore,
	request: TraverseRequest,
	bounds: NonNullable<TraverseHost["bounds"]>,
): Promise<TraverseStep> {
	const change = await readOne<ChangeRecord>(store, "change", request.change_id, {});
	if (!change) {
		return stop("unknown-change", `no change ${request.change_id} is recorded; intake it before traversing`, []);
	}

	const slices = await listSlices(store, change.id);
	const attempts = await listAttempts(store, change.id, slices);
	const history = buildHistory(attempts);

	// The work first. A concluded change has nothing left to do regardless of
	// what the host can or cannot do.
	if (change.state === "accepted" || change.state === "abandoned") {
		return stop("change-concluded", `change ${change.id} is ${change.state}; open a new change rather than extending this one`, history);
	}

	// A blocked change outranks anything the attempts say: someone marked the
	// whole change untouchable, and the attempt-level check below would never
	// see it because a blocked change need not have a blocked attempt.
	if (change.state === "blocked") {
		return stop(
			"blocked-needs-operator",
			`change ${change.id} is blocked: ${change.block_reason ?? "no reason recorded"}. A person must clear this before any attempt`,
			history,
		);
	}

	if (slices.length === 0) {
		return {
			action: "plan-slices",
			rationale: `change ${change.id} has no slices; the work must be divided before any of it can be attempted`,
			bounds: { limits: ["produce slices only; no execution", "one planning pass"] },
			history,
			idempotency_key: keyFor("plan-slices", change.id, String(change.revision)),
		};
	}

	const latest = attempts.at(-1);

	// An attempt already running is RESUMED. Starting a second one because an
	// acknowledgement was lost is how a host runs a migration twice. WHERE it
	// is resumed is read from the records under it: the bound candidate, the
	// proofs naming that candidate, and the reviews of it. Each stage is
	// keyed on the record that ends it, so a host re-asking after a lost
	// acknowledgement sees the same key.
	if (latest?.outcome === "running") {
		const stage = await runningStage(store, change.id, latest);
		if (stage.kind === "no-candidate") {
			return {
				action: "resume-attempt",
				rationale: `attempt ${latest.id} is running with no candidate bound; resume the work, then capture the candidate that records the tree the checks will run against`,
				bounds: { limits: [`wall clock ${bounds.max_wall_clock_ms} ms`, "no new attempt record", "ends with capture-candidate"] },
				resumed_from: resumedFrom(latest),
				history,
				idempotency_key: keyFor("resume-attempt", change.id, latest.id),
			} as TraverseStep;
		}
		if (stage.kind === "unproved") {
			return {
				action: "record-observations",
				rationale: `attempt ${latest.id} has candidate ${stage.candidate.id} bound and no proof names it; run the slice's checks against that tree and record what was observed`,
				bounds: { limits: [`wall clock ${bounds.max_wall_clock_ms} ms`, "checks named by the slice's proof obligations only", "a proof must name the bound candidate"] },
				resumed_from: resumedFrom(latest),
				history,
				idempotency_key: keyFor("record-observations", change.id, latest.id, stage.candidate.id),
			} as TraverseStep;
		}
		if (stage.kind === "unreviewed") {
			return {
				action: "request-review",
				rationale: `attempt ${latest.id} has proofs against candidate ${stage.candidate.id} and no review of those bytes; a review of these exact bytes is required before acceptance can be offered`,
				bounds: { limits: ["review only; no further execution", "one review per candidate"] },
				resumed_from: resumedFrom(latest),
				history,
				idempotency_key: keyFor("request-review", change.id, latest.id, stage.candidate.id),
			} as TraverseStep;
		}
		if (stage.kind === "objections") {
			return {
				action: "address-objections",
				rationale: `review ${stage.review.id} of candidate ${stage.candidate.id} leaves blockers open: ${stage.review.remaining_blockers.join(", ")}. The candidate is pinned by its proofs; address them in a new attempt (parent_attempt_id: ${latest.id})`,
				bounds: { limits: ["a new attempt, never a rewrite of this one", `attempts remaining ${bounds.max_attempts - attempts.filter((a) => a.outcome === "failed").length}`] },
				resumed_from: resumedFrom(latest),
				history,
				idempotency_key: keyFor("address-objections", change.id, latest.id, stage.review.id),
			} as TraverseStep;
		}
		return {
			action: "resume-attempt",
			rationale: `attempt ${latest.id} is running and reviewed clean but not finalized; resume it so the lifecycle can finalize it, rather than starting another`,
			bounds: { limits: [`wall clock ${bounds.max_wall_clock_ms} ms`, "no new attempt record"] },
			resumed_from: resumedFrom(latest),
			history,
			idempotency_key: keyFor("resume-attempt", change.id, latest.id),
		} as TraverseStep;
	}

	const failures = attempts.filter((attempt) => attempt.outcome === "failed").length;
	if (failures >= bounds.max_attempts) {
		return stop(
			"attempt-budget-exhausted",
			`${failures} attempts have failed and the host's budget is ${bounds.max_attempts}; retrying again would spend without new information`,
			history,
		);
	}

	if (latest?.outcome === "blocked") {
		return stop(
			"blocked-needs-operator",
			`attempt ${latest.id} is blocked: ${latest.block_reason ?? "no reason recorded"}. A person must clear this; retrying will block identically`,
			history,
		);
	}

	if (latest?.outcome === "failed") {
		if (!request.host.can_execute) {
			return stop("host-cannot-execute", "the previous attempt failed and this host cannot execute a retry", history);
		}
		return {
			action: "retry-after-failure",
			rationale: `attempt ${latest.id} failed: ${latest.failure_summary ?? "no summary recorded"}. A new attempt supersedes nothing; the failure stays on the record`,
			bounds: { limits: [`attempts remaining ${bounds.max_attempts - failures}`, `wall clock ${bounds.max_wall_clock_ms} ms`] },
			resumed_from: resumedFrom(latest),
			history,
			idempotency_key: keyFor("retry-after-failure", change.id, latest.id),
		} as TraverseStep;
	}

	if (latest?.outcome === "ready-for-review") {
		// Only NOW does the human path matter: there is something to accept.
		if (!request.host.can_obtain_human_decision) {
			return stop(
				"host-cannot-obtain-human-decision",
				`attempt ${latest.id} is ready for review, but this host cannot obtain a human decision; acceptance requires one and this loop will not simulate it`,
				history,
			);
		}
		return {
			action: "request-review",
			rationale: `attempt ${latest.id} is ready for review; a review of these exact bytes is required before acceptance can be offered`,
			bounds: { limits: ["review only; no further execution", "one review per candidate"] },
			resumed_from: resumedFrom(latest),
			history,
			idempotency_key: keyFor("request-review", change.id, latest.id),
		} as TraverseStep;
	}

	if (latest?.outcome === "needs-human-acceptance") {
		// An approval already recorded for the bound candidate is a decision
		// that was made; asking again would ask a person to decide something
		// already decided. The loop stops and names the approval.
		// "Recorded" means judged genuine by judgeApprovals (lifecycle.ts):
		// decision, candidate id + digest, input digest, stored request and
		// receipt binding. A file under approvals/ that fails that judgement
		// is not silently skipped: the loop stops for an operator, naming the
		// file and the codes, because an approval nobody issued is either a
		// forgery or a broken adapter, and neither is the loop's to walk past.
		const candidate = await boundCandidate(store, latest);
		const verdicts = candidate ? await judgeApprovals(store, latest, candidate) : [];
		const accepted = verdicts.find((v) => v.genuine === true);
		if (accepted) {
			return stop("change-concluded", `approval ${accepted.id} records acceptance of candidate ${accepted.approval.candidate_snapshot_id} (attempt ${latest.id}); conclude the change rather than asking again`, history);
		}
		const suspect = verdicts.filter((v) => v.genuine === false);
		if (suspect.length > 0) {
			return stop(
				"blocked-needs-operator",
				`${suspect.map((v) => `approval ${v.id} under attempt ${latest.id} is not a genuine acceptance of the bound candidate (${v.codes.join(", ")}): ${v.detail}`).join(" | ")}. An approval file that binds to no stored request is an operator matter; the loop will not conclude on it and will not ask for another decision over it`,
				history,
			);
		}
		// A finalized attempt the gate would refuse (no observed proof, an
		// open objection, drifted inputs) must not send the host to ask a
		// person: the request would be refused before anyone was asked, and
		// telling the host to ask is telling it to loop on a refusal. The gate
		// runs here without a re-read (this module sees no repository), so a
		// stale tree is still the adapter's to find at request time.
		const gate = await evaluateAcceptanceGate(store, {
			change_id: change.id,
			attempt_id: latest.id,
			host: { can_obtain_human_decision: request.host.can_obtain_human_decision, storage: { boundary: request.host.storage.boundary as StorageBoundary, ...(request.host.storage.protection !== undefined ? { protection: request.host.storage.protection } : {}) } },
		});
		if (gate.state === "refused") {
			return {
				...stop(
					"blocked-needs-operator",
					`attempt ${latest.id} is needs-human-acceptance but the acceptance gate refuses it (${gate.blockers.map((b) => b.code).join(", ")}): ${gate.blockers.map((b) => `${b.detail} — ${b.remedy}`).join(" | ")}. Asking a person would be refused before anyone was asked; the remedy is a new attempt that clears the blockers`,
					history,
				),
				resumed_from: resumedFrom(latest),
			};
		}
		if (!request.host.can_obtain_human_decision) {
			return stop(
				"host-cannot-obtain-human-decision",
				`attempt ${latest.id} needs a human decision this host cannot obtain; the loop stops here rather than proceeding without one`,
				history,
			);
		}
		return {
			action: "request-human-acceptance",
			rationale: `attempt ${latest.id} needs a human acceptance; present the candidate and wait, and record only a decision a person actually made`,
			bounds: { limits: ["no execution", "no acceptance without a receipt the core can evaluate"] },
			resumed_from: resumedFrom(latest),
			history,
			idempotency_key: keyFor("request-human-acceptance", change.id, latest.id),
		} as TraverseStep;
	}

	// No attempt yet, or the last one was superseded/accepted at slice level.
	if (!request.host.can_execute) {
		return stop("host-cannot-execute", "the next action is to attempt the work, and this host cannot execute", history);
	}
	return {
		action: "start-attempt",
		rationale: `change ${change.id} has slices and no open attempt; start one against a recorded baseline so the candidate can be identified later`,
		bounds: { limits: [`attempts remaining ${bounds.max_attempts - failures}`, `wall clock ${bounds.max_wall_clock_ms} ms`] },
		history,
		idempotency_key: keyFor("start-attempt", change.id, sliceIdentity(slices)),
	};
}

type RunningStage =
	| { kind: "no-candidate" }
	| { kind: "unproved"; candidate: { id: string } }
	| { kind: "unreviewed"; candidate: { id: string } }
	| { kind: "objections"; candidate: { id: string }; review: ReviewRecord }
	| { kind: "reviewed" };

/** Where a running attempt is, read from the records under it and nothing else. */
async function runningStage(store: EngineeringStore, changeId: string, attempt: AttemptRecord): Promise<RunningStage> {
	const candidate = await boundCandidate(store, attempt);
	if (!candidate) return { kind: "no-candidate" };
	const context = { changeId, attemptId: attempt.id };
	let proved = false;
	for (const id of await listAttemptRecords(store, changeId, attempt.id, "proofs")) {
		const proof = await readOne<ProofRecord>(store, "proof", id, context);
		if (proof && proof.snapshot_id === candidate.id) proved = true;
	}
	if (!proved) return { kind: "unproved", candidate };
	const reviews: ReviewRecord[] = [];
	for (const id of await listAttemptRecords(store, changeId, attempt.id, "reviews")) {
		const review = await readOne<ReviewRecord>(store, "review", id, context);
		if (review && review.candidate_snapshot_id === candidate.id && review.candidate_digest === candidate.digest) reviews.push(review);
	}
	if (reviews.length === 0) return { kind: "unreviewed", candidate };
	const blocked = reviews.find((r) => r.remaining_blockers.length > 0);
	if (blocked) return { kind: "objections", candidate, review: blocked };
	return { kind: "reviewed" };
}

/**
 * Slice identity, not slice count.
 *
 * Keying on cardinality gave two materially different plans the same key, and
 * a host that dropped one slice and added another returned to a key it had
 * already used -- so genuinely new work could be mistaken for a retry.
 */
function sliceIdentity(slices: SliceRecord[]): string {
	return slices
		.map((slice) => `${slice.id}@${slice.revision}`)
		.sort()
		.join(",");
}

function resumedFrom(attempt: AttemptRecord): { attempt_id: string; outcome: string } {
	return { attempt_id: attempt.id, outcome: attempt.outcome };
}

function stop(reason: TraverseStopReason, rationale: string, history: string[]): TraverseStep {
	return {
		action: "stop",
		stop_reason: reason,
		rationale,
		bounds: { limits: ["no further action until the stated condition changes"] },
		history,
		idempotency_key: keyFor("stop", reason, rationale),
	};
}

/**
 * A key derived from the records.
 *
 * Not the clock: two reads of unchanged records must produce the same key, or
 * a host cannot tell its own retry from new work.
 */
function keyFor(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/** Prior failures and blockers, in order, so a resumed session sees them. */
function buildHistory(attempts: AttemptRecord[]): string[] {
	return attempts
		.filter((attempt) => attempt.outcome === "failed" || attempt.outcome === "blocked")
		.map((attempt) =>
			attempt.outcome === "blocked"
				? `attempt ${attempt.id} blocked: ${attempt.block_reason ?? "no reason recorded"}`
				: `attempt ${attempt.id} failed: ${attempt.failure_summary ?? "no summary recorded"}`,
		);
}

/**
 * Read one record, distinguishing "absent" from "unreadable".
 *
 * Swallowing every error made corruption and a containment refusal look
 * exactly like an empty store: a truncated `running` attempt vanished and the
 * loop cheerfully said `start-attempt`. The one case where the loop cannot
 * know whether a side effect is in flight must not be the case where it
 * proceeds. Only a genuine not-found reads as absent; anything else is raised
 * and stops the loop.
 */
async function readOne<T>(store: EngineeringStore, kind: string, id: string, context: Record<string, string>): Promise<T | null> {
	try {
		const found = await store.get(kind as never, id, context as never);
		return (found?.record as T) ?? null;
	} catch (error) {
		if (isMissing(error)) return null;
		throw new TraverseUnreadableError(`${kind} ${id} is recorded but unreadable: ${messageOf(error)}`);
	}
}

/** A record that exists but cannot be trusted to say what it says. */
export class TraverseUnreadableError extends Error {
	readonly code = "unreadable-record";
}

function isMissing(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	return code === "not-found" || code === "ENOENT";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function listSlices(store: EngineeringStore, changeId: string): Promise<SliceRecord[]> {
	const ids = await store.listIds("slice", { changeId }).catch((error) => {
		if (isMissing(error)) return [] as string[];
		throw new TraverseUnreadableError(`the slices of ${changeId} cannot be enumerated: ${messageOf(error)}`);
	});
	const records: SliceRecord[] = [];
	for (const id of ids) {
		const record = await readOne<SliceRecord>(store, "slice", id, { changeId });
		if (record) records.push(record);
	}
	return records;
}

/**
 * Attempts across every slice, oldest first.
 *
 * Ordered by `started_at` then id: the id alone is not chronological, and a
 * loop that mistook the newest record for the newest attempt would resume the
 * wrong one.
 */
async function listAttempts(store: EngineeringStore, changeId: string, slices: SliceRecord[]): Promise<AttemptRecord[]> {
	const ids = await store.listIds("attempt", { changeId }).catch((error) => {
		// A containment refusal here means someone redirected the attempts
		// directory. Reading that as "no attempts" would hide a running one.
		if (isMissing(error)) return [] as string[];
		throw new TraverseUnreadableError(`the attempts of ${changeId} cannot be enumerated: ${messageOf(error)}`);
	});
	const records: AttemptRecord[] = [];
	for (const id of ids) {
		const record = await readOne<AttemptRecord>(store, "attempt", id, { changeId });
		if (record) records.push(record);
	}
	void slices;
	// Compare INSTANTS, not strings. E01 permits an optional fractional part
	// (`...00Z` and `...00.001Z` are both valid), and "Z" (0x5A) sorts after
	// "." (0x2E), so lexicographic order reverses the two. That is not a
	// cosmetic ordering bug: it ranks a live `running` attempt before an older
	// failed one, the loop stops seeing the running attempt, and the host is
	// told to start a second attempt beside one still executing -- the exact
	// repeated side effect this module exists to prevent.
	return records.sort((a, b) => {
		const delta = Date.parse(a.started_at) - Date.parse(b.started_at);
		// The id tie-break is UNTESTED BY CONSTRUCTION and deliberately kept.
		// `listIds` returns ids already ascending and Array#sort is stable, so
		// equal instants already come out id-ascending and this branch cannot
		// change the result -- a mutation deleting it survives, correctly.
		// It stays because the guarantee it depends on lives in another file:
		// if listIds ever stopped sorting, this is what keeps two sessions
		// reading identical records from disagreeing about which attempt is
		// latest.
		return delta !== 0 ? delta : a.id.localeCompare(b.id);
	});
}
