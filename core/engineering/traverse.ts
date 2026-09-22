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

import type { AttemptRecord, ChangeRecord, SliceRecord } from "./types.ts";
import type { EngineeringStore } from "./store.ts";
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
	if (!request.host?.bounds || typeof request.host.bounds.max_attempts !== "number") {
		throw new Error(
			"the host must declare bounds (max_attempts, max_wall_clock_ms): an unbounded loop is not a default, and choosing a limit here would hide that the host never chose one",
		);
	}

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
	// acknowledgement was lost is how a host runs a migration twice.
	if (latest?.outcome === "running") {
		return {
			action: "resume-attempt",
			rationale: `attempt ${latest.id} is already running; resume it rather than starting another, which would repeat whatever it already did`,
			bounds: { limits: [`wall clock ${request.host.bounds.max_wall_clock_ms} ms`, "no new attempt record"] },
			resumed_from: resumedFrom(latest),
			history,
			idempotency_key: keyFor("resume-attempt", change.id, latest.id),
		} as TraverseStep;
	}

	const failures = attempts.filter((attempt) => attempt.outcome === "failed").length;
	if (failures >= request.host.bounds.max_attempts) {
		return stop(
			"attempt-budget-exhausted",
			`${failures} attempts have failed and the host's budget is ${request.host.bounds.max_attempts}; retrying again would spend without new information`,
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
			bounds: { limits: [`attempts remaining ${request.host.bounds.max_attempts - failures}`, `wall clock ${request.host.bounds.max_wall_clock_ms} ms`] },
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
		bounds: { limits: [`attempts remaining ${request.host.bounds.max_attempts - failures}`, `wall clock ${request.host.bounds.max_wall_clock_ms} ms`] },
		history,
		idempotency_key: keyFor("start-attempt", change.id, String(slices.length)),
	};
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

async function readOne<T>(store: EngineeringStore, kind: string, id: string, context: Record<string, string>): Promise<T | null> {
	const found = await store.get(kind as never, id, context as never).catch(() => null);
	return (found?.record as T) ?? null;
}

async function listSlices(store: EngineeringStore, changeId: string): Promise<SliceRecord[]> {
	const ids = await store.listIds("slice", { changeId }).catch(() => []);
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
	const ids = await store.listIds("attempt", { changeId }).catch(() => []);
	const records: AttemptRecord[] = [];
	for (const id of ids) {
		const record = await readOne<AttemptRecord>(store, "attempt", id, { changeId });
		if (record) records.push(record);
	}
	void slices;
	return records.sort((a, b) => (a.started_at === b.started_at ? a.id.localeCompare(b.id) : a.started_at.localeCompare(b.started_at)));
}
