// The attempt lifecycle: start, capture a candidate, record a review (#409).
//
// ---------------------------------------------------------------------------
// THE ONE PLACE A RUNNING ATTEMPT MOVES
//
// The contract (record-contract.md § Ownership and layout) says everything
// under `attempts/` is create-only ONCE FINALIZED. `capture-candidate` binds
// `candidate_snapshot_id` onto an attempt that "stays running" and is
// "repeatable until a proof references the candidate". Those two sentences
// are reconciled here: an attempt is a projection WHILE `running` and an
// observation once it is not. Every write to a running attempt goes through
// this module and through the store's `ifCandidate` compare-and-swap; nothing
// rewrites an attempt whose outcome has left `running`, and a correction to a
// finalized attempt is a new attempt naming the old one.
//
// WHAT "THE ATTEMPT'S CANDIDATE" MEANS, EVERYWHERE
//
// `boundCandidate(store, attempt)` is the single resolution every reader
// uses — the gate, the acceptance adapter, host-observation ingestion, the
// traverse loop, and the MCP re-read. It reads `attempt.candidate_snapshot_id`
// and nothing else; there is no second source of truth to drift from. A
// snapshot that is not the bound one is history a proof may still name, but
// nothing discharges against it (proofs.ts) and nothing accepts it.
//
// TRUST
//
// Snapshots recorded here are attested by whoever CAPTURED them. The adapter
// passes its own capture as `adapter`; a caller-supplied snapshot is recorded
// `caller` and only when the adapter could not read the tree, and a `caller`
// candidate never binds an acceptance (`candidateMayBindAcceptance`). Nothing
// in this module can mint an approval or move an attempt to `accepted`.
// ---------------------------------------------------------------------------

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { computeInputDigest, computeSnapshotDigest, digestOf } from "./digest.ts";
import { newRecordId } from "./ids.ts";
import { candidateMayBindAcceptance } from "./snapshots.ts";
import { StoreError, type EngineeringStore } from "./store.ts";
import { ENGINEERING_SCHEMA_VERSION, type AttemptInputs, type AttemptRecord, type ChangeRecord, type ProofRecord, type ReviewRecord, type SliceRecord, type SnapshotRecord } from "./types.ts";
import { deriveRemainingBlockers, validateRecordOfKind } from "./validation.ts";

/** The identity fields a capture yields; the adapter fills them from its own read of the tree. */
export type CapturedTree = Pick<SnapshotRecord, "coverage" | "manifest" | "repository" | "stability">;

/** How a snapshot arrived: the adapter read the tree itself, or a caller supplied it because the adapter could not. */
export type SnapshotSource = { attested_by: "adapter"; collector: "host-observed"; tree: CapturedTree } | { attested_by: "caller"; collector: SnapshotRecord["collector"]; tree: CapturedTree };

export interface StartAttemptArgs {
	change_id: string;
	slice_id: string;
	inputs: Omit<AttemptInputs, "digest">;
	baseline: SnapshotSource;
	parent_attempt_id?: string;
	supersedes_attempt_id?: string;
	now?: () => Date;
	idempotency_key?: string;
}

export interface CaptureCandidateArgs {
	change_id: string;
	attempt_id: string;
	candidate: SnapshotSource;
	now?: () => Date;
	idempotency_key?: string;
}

export interface RecordReviewArgs {
	change_id: string;
	attempt_id: string;
	/** The caller's review body; the binding fields are refused and filled from the stored records. */
	review: Record<string, unknown>;
	now?: () => Date;
	idempotency_key?: string;
}

const timestamp = (now: () => Date) => now().toISOString();

/**
 * The candidate an attempt currently offers, or null when none is bound (or
 * the bound one cannot be read — the caller reports that as "no candidate",
 * which is the conservative reading: nothing accepts a candidate it cannot
 * see).
 */
export async function boundCandidate(store: EngineeringStore, attempt: Pick<AttemptRecord, "id" | "change_id" | "candidate_snapshot_id">): Promise<SnapshotRecord | null> {
	if (!attempt.candidate_snapshot_id) return null;
	try {
		return (await store.get("snapshot", attempt.candidate_snapshot_id, { changeId: attempt.change_id, attemptId: attempt.id })).record as SnapshotRecord;
	} catch {
		return null;
	}
}

/** Ids of the records of one kind under an attempt; the store owns the layout, this only lists. */
export async function listAttemptRecords(store: EngineeringStore, changeId: string, attemptId: string, directory: "proofs" | "reviews" | "approvals"): Promise<string[]> {
	try {
		const entries = await readdir(join(store.root, "changes", changeId, "attempts", attemptId, directory));
		return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
	} catch {
		return [];
	}
}

/** Every proof of an attempt that names `snapshotId`. A re-capture is refused while this is non-empty. */
export async function proofsReferencing(store: EngineeringStore, changeId: string, attemptId: string, snapshotId: string): Promise<string[]> {
	const referencing: string[] = [];
	for (const id of await listAttemptRecords(store, changeId, attemptId, "proofs")) {
		try {
			const proof = (await store.get("proof", id, { changeId, attemptId })).record as ProofRecord;
			if (proof.snapshot_id === snapshotId) referencing.push(proof.id);
		} catch {
			// A proof that will not parse is still a file under proofs/ that
			// may name this candidate; the conservative reading is that it
			// does, so the candidate stays pinned rather than silently freed.
			referencing.push(id);
		}
	}
	return referencing;
}

function snapshotRecord(args: { changeId: string; attemptId: string; role: "baseline" | "candidate"; source: SnapshotSource; capturedAt: string }): SnapshotRecord {
	const { tree } = args.source;
	const record: SnapshotRecord = {
		schema_version: ENGINEERING_SCHEMA_VERSION,
		kind: "snapshot",
		id: newRecordId("snapshot"),
		created_at: args.capturedAt,
		change_id: args.changeId,
		attempt_id: args.attemptId,
		role: args.role,
		repository: tree.repository,
		manifest: tree.manifest,
		coverage: tree.coverage,
		stability: tree.stability,
		collector: args.source.collector,
		attested_by: args.source.attested_by,
		captured_at: args.capturedAt,
		digest: computeSnapshotDigest({ coverage: tree.coverage, manifest: tree.manifest, repository: tree.repository }),
	} as SnapshotRecord;
	const valid = validateRecordOfKind("snapshot", record);
	if (valid.ok === false) throw new StoreError(valid.errors[0].code, `the captured tree does not form a valid snapshot: ${valid.errors[0].message}`, valid.errors[0].path);
	return valid.value as SnapshotRecord;
}

/**
 * Start an attempt against a slice, with the baseline the adapter captured
 * (or, only when it could not, the caller's). Writes the snapshot first and
 * the attempt second, so a crash between the two leaves an orphan snapshot
 * and no attempt — never an attempt whose baseline does not exist.
 */
export async function startAttempt(store: EngineeringStore, args: StartAttemptArgs): Promise<{ attempt: AttemptRecord; snapshot: SnapshotRecord }> {
	const now = args.now ?? (() => new Date());
	const slice = (await store.get("slice", args.slice_id, { changeId: args.change_id })).record as SliceRecord;
	if (slice.change_id !== args.change_id) throw new StoreError("cross-change-reference", `slice ${slice.id} belongs to ${slice.change_id}, not ${args.change_id}`);
	for (const parent of [args.parent_attempt_id, args.supersedes_attempt_id]) {
		if (parent === undefined) continue;
		const record = (await store.get("attempt", parent, { changeId: args.change_id })).record as AttemptRecord;
		if (record.change_id !== args.change_id) throw new StoreError("cross-change-reference", `attempt ${parent} belongs to ${record.change_id}, not ${args.change_id}`);
	}
	const attemptId = newRecordId("attempt");
	const startedAt = timestamp(now);
	const snapshot = snapshotRecord({ changeId: args.change_id, attemptId, role: "baseline", source: args.baseline, capturedAt: startedAt });
	const references = [...args.inputs.references].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
	const inputs: AttemptInputs = { brief_digest: args.inputs.brief_digest, plan_digest: args.inputs.plan_digest, references, digest: computeInputDigest({ brief_digest: args.inputs.brief_digest, plan_digest: args.inputs.plan_digest, references }) };
	const attempt: AttemptRecord = {
		schema_version: ENGINEERING_SCHEMA_VERSION,
		kind: "attempt",
		id: attemptId,
		created_at: startedAt,
		change_id: args.change_id,
		slice_id: slice.id,
		inputs,
		baseline_snapshot_id: snapshot.id,
		outcome: "running",
		started_at: startedAt,
		...(args.parent_attempt_id ? { parent_attempt_id: args.parent_attempt_id } : {}),
		...(args.supersedes_attempt_id ? { supersedes_attempt_id: args.supersedes_attempt_id } : {}),
	};
	await store.put(snapshot);
	await store.put(attempt, args.idempotency_key ? { idempotencyKey: args.idempotency_key } : undefined);
	// Work has started: a planned change and a pending slice become active
	// (the transition table allows exactly these hops). Anything else is
	// left as it is — an already-active pair needs no write, and a blocked
	// or concluded one is not this function's to move.
	const change = (await store.get("change", args.change_id)).record as ChangeRecord;
	if (change.state === "planned") await store.put({ ...change, state: "active", revision: change.revision + 1, updated_at: startedAt }, { ifRevision: change.revision });
	if (slice.state === "pending") await store.put({ ...slice, state: "active", revision: slice.revision + 1, updated_at: startedAt }, { ifRevision: slice.revision });
	return { attempt, snapshot };
}

/**
 * Bind (or re-bind) the attempt's candidate. The attempt stays `running`.
 * Refused once any proof names the current candidate: evidence was taken
 * against those bytes, and moving the candidate underneath it would let a
 * proof of one tree stand for another. The remedy is a new attempt.
 */
export async function captureCandidate(store: EngineeringStore, args: CaptureCandidateArgs): Promise<{ attempt: AttemptRecord; snapshot: SnapshotRecord; superseded_candidate_id?: string }> {
	const now = args.now ?? (() => new Date());
	const attempt = (await store.get("attempt", args.attempt_id, { changeId: args.change_id })).record as AttemptRecord;
	if (attempt.change_id !== args.change_id) throw new StoreError("cross-change-reference", `attempt ${attempt.id} belongs to ${attempt.change_id}, not ${args.change_id}`);
	if (attempt.outcome !== "running") {
		throw new StoreError("invalid-state", `attempt ${attempt.id} is ${attempt.outcome}; a candidate can be captured only while an attempt is running. Start a new attempt (parent_attempt_id: ${attempt.id})`);
	}
	const previous = attempt.candidate_snapshot_id ?? null;
	if (previous !== null) {
		const pinned = await proofsReferencing(store, args.change_id, attempt.id, previous);
		if (pinned.length > 0) {
			throw new StoreError("invalid-state", `candidate ${previous} of attempt ${attempt.id} is referenced by proof ${pinned.join(", ")}; it cannot be re-captured. Start a new attempt (parent_attempt_id: ${attempt.id}) for the changed tree`);
		}
	}
	const capturedAt = timestamp(now);
	// Not compared against the baseline digest: an attempt whose candidate
	// equals its baseline is a legal record (nothing changed), and a proof
	// of "nothing changed" is still a proof.
	const snapshot = snapshotRecord({ changeId: args.change_id, attemptId: attempt.id, role: "candidate", source: args.candidate, capturedAt });
	const next: AttemptRecord = { ...attempt, candidate_snapshot_id: snapshot.id };
	await store.put(snapshot);
	await store.put(next, { ifCandidate: previous, ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}) });
	return { attempt: next, snapshot, ...(previous ? { superseded_candidate_id: previous } : {}) };
}

/** Fields of a review the adapter binds from the stored records; a caller may not supply them. */
export const REVIEW_BOUND_FIELDS = ["candidate_snapshot_id", "candidate_digest", "input_digest", "change_id", "attempt_id", "id", "kind", "schema_version", "created_at"] as const;

/**
 * Record a review of the attempt's bound candidate. The binding fields
 * (`candidate_snapshot_id`, `candidate_digest`, `input_digest`) come from the
 * stored attempt and candidate, never from the caller — a review that named
 * a digest of its own choosing could be a review of nothing. A clean review
 * (no remaining blockers, declared-separate reviewer) of an adapter-attested
 * candidate finalizes a running attempt to `needs-human-acceptance`: the
 * candidate is frozen from then on and the next step is a person's.
 */
export async function recordReview(store: EngineeringStore, args: RecordReviewArgs): Promise<{ review: ReviewRecord; attempt: AttemptRecord; finalized: boolean }> {
	const now = args.now ?? (() => new Date());
	for (const field of REVIEW_BOUND_FIELDS) {
		if (Object.hasOwn(args.review, field)) {
			throw new StoreError("unknown-field", `review.${field} is bound by the adapter from the stored attempt and candidate; a caller cannot supply it`, `/review/${field}`);
		}
	}
	const attempt = (await store.get("attempt", args.attempt_id, { changeId: args.change_id })).record as AttemptRecord;
	if (attempt.change_id !== args.change_id) throw new StoreError("cross-change-reference", `attempt ${attempt.id} belongs to ${attempt.change_id}, not ${args.change_id}`);
	const candidate = await boundCandidate(store, attempt);
	if (!candidate) throw new StoreError("invalid-state", `attempt ${attempt.id} has no bound candidate; capture one before reviewing`);
	const objections = Array.isArray(args.review.objections) ? (args.review.objections as ReviewRecord["objections"]) : [];
	const derived = deriveRemainingBlockers(objections.filter((o) => o && typeof o === "object"));
	if (args.review.remaining_blockers !== undefined && digestOf(args.review.remaining_blockers) !== digestOf(derived)) {
		throw new StoreError("invalid-value", `review.remaining_blockers must equal the blocking objections still open or deferred (${JSON.stringify(derived)}); it is derived, not declared`, "/review/remaining_blockers");
	}
	const createdAt = timestamp(now);
	const review = {
		schema_version: ENGINEERING_SCHEMA_VERSION,
		kind: "review",
		id: newRecordId("review"),
		created_at: createdAt,
		change_id: attempt.change_id,
		attempt_id: attempt.id,
		candidate_snapshot_id: candidate.id,
		candidate_digest: candidate.digest,
		input_digest: attempt.inputs.digest,
		...args.review,
		remaining_blockers: derived,
	};
	const valid = validateRecordOfKind("review", review);
	if (valid.ok === false) throw new StoreError(valid.errors[0].code, `review failed validation: ${valid.errors[0].message}`, valid.errors[0].path);
	const stored = valid.value as ReviewRecord;
	await store.put(stored, args.idempotency_key ? { idempotencyKey: args.idempotency_key } : undefined);

	const clean = derived.length === 0 && stored.reviewer.separation === "declared-separate" && candidateMayBindAcceptance(candidate).ok;
	if (attempt.outcome !== "running" || !clean) return { review: stored, attempt, finalized: false };
	const finalized: AttemptRecord = { ...attempt, outcome: "needs-human-acceptance", ended_at: createdAt };
	await store.put(finalized, { ifCandidate: candidate.id });
	return { review: stored, attempt: finalized, finalized: true };
}
