// Ingesting observed proof without promoting claims (E05, #403).
//
// ---------------------------------------------------------------------------
// THE TRUST BOUNDARY, STATED ONCE
//
// CodeCartographer does not run checks. A host runs them and reports what it
// saw. Therefore this module CANNOT establish that a result is true: a
// dishonest host can fabricate an observation and everything here will store
// it faithfully. Claiming otherwise would be the most dangerous lie the
// framework could tell, so it is never claimed — E05's own scope says so.
//
// What this module does enforce is that a claim cannot be LAUNDERED into an
// observation. Authority is derived, never read: it comes from the collector
// and the attestation together (E01's `proofAuthority`), so a caller who
// writes `authority: "observed"` beside a prose PASS still gets a `claimed`
// proof that discharges nothing under the verified policy. The difference
// between "we know this is true" and "we know who is asserting it" is the
// entire value on offer.
//
// A second boundary: ingestion records artifact IDENTITY, never artifact
// CONTENT. It does not execute commands, does not read the bytes it
// references, and does not upload anything. An ingester that retained any
// path a caller named would be a file-exfiltration primitive wearing an
// evidence label.
// ---------------------------------------------------------------------------

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { engineeringPaths } from "./ids.ts";
import { proofAuthority, proofDischarges, validateRecord } from "./validation.ts";
import type { EvidenceAuthority, ProofRecord, SliceRecord, AttemptRecord, SnapshotRecord, AssurancePolicy } from "./types.ts";
import type { EngineeringStore } from "./store.ts";

export interface IngestError {
	path: string;
	code: "invalid-value" | "unknown-reference" | "missing-field" | "stale-evidence" | "already-exists";
	message: string;
}

export interface IngestOptions {
	idempotencyKey?: string;
	/** Defaults to `verified`; `cooperative` is a host-operator policy set outside the workspace. */
	policy?: AssurancePolicy;
}

export type IngestOutcome =
	| {
			ok: true;
			proof: ProofRecord;
			/** Derived from collector + attestation. Never read from the payload. */
			authority: EvidenceAuthority;
			/** Whether this proof discharges its obligation under the active policy. */
			discharges: boolean;
			replayed: boolean;
	  }
	| { ok: false; errors: IngestError[] };

function fail(errors: IngestError[], path: string, code: IngestError["code"], message: string): void {
	errors.push({ path, code, message });
}

/**
 * Fields a caller might send that this module derives itself. Accepting them
 * would let the payload state its own conclusion — the exact laundering this
 * module exists to prevent — so they are stripped before validation rather
 * than merely ignored downstream.
 */
const DERIVED_FIELDS = ["authority", "discharges"] as const;

function stripDerived(payload: Record<string, unknown>): Record<string, unknown> {
	const clean: Record<string, unknown> = { ...payload };
	for (const field of DERIVED_FIELDS) delete clean[field];
	return clean;
}

/**
 * Whether a retained artifact's own storage slot escapes the namespace.
 *
 * NOT what this checks: a caller-supplied path. `ArtifactReference` has no
 * path field, and an artifact's location is DERIVED from its id through
 * `engineeringPaths.artifact`, whose `assertId` accepts only `[0-9a-f]{24}`.
 * A traversing path is therefore unrepresentable — proved by probing the id
 * grammar directly, after a first draft of this module shipped a containment
 * check for an input that cannot exist. E01 designed the exfiltration
 * primitive out; re-validating it here would be theatre.
 *
 * What CAN happen is a symlink planted at the derived slot by some earlier
 * process. Ingestion never reads artifact bytes, so it is unharmed — but
 * `retained: true` asserts those bytes sit under the attempt's directory, and
 * a later consumer that packages or exports them would follow the link out.
 * So the claim is checked, not the caller's path.
 */
async function checkRetainedArtifact(
	store: EngineeringStore,
	changeId: string,
	attemptId: string,
	artifactId: string,
	at: string,
	errors: IngestError[],
): Promise<void> {
	const slot = engineeringPaths.artifact(changeId, attemptId, artifactId).replace(/^engineering[/\\]/, "");
	const target = resolve(store.root, slot);
	let real: string;
	try {
		real = await realpath(target);
	} catch {
		// Not written yet. A record may legitimately reference an artifact the
		// host has not flushed, and an absent file resolves nowhere, so there
		// is nothing to refuse.
		return;
	}
	const realRoot = await realpath(store.root);
	const rel = relative(realRoot, real);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		fail(errors, at, "invalid-value", `artifact ${artifactId} is marked retained but its slot resolves to ${real}, outside the engineering namespace`);
	}
}

/** Reads a record the proof binds to, returning null when it is absent. */
async function readRecord<T>(store: EngineeringStore, kind: string, id: string, context: Record<string, string>): Promise<T | null> {
	try {
		const outcome = await store.get(kind as never, id, context);
		return outcome.record as unknown as T;
	} catch {
		return null;
	}
}

/**
 * Ingest one proof.
 *
 * The order matters: shape first (E01 owns it), then binding, then staleness,
 * then internal consistency, then storage. A record that fails any of these is
 * never written, because a refused observation that is nonetheless on disk is
 * indistinguishable from an accepted one to the next reader.
 */
export async function ingestProof(store: EngineeringStore, payload: unknown, options: IngestOptions = {}): Promise<IngestOutcome> {
	const errors: IngestError[] = [];
	if (payload === null || typeof payload !== "object") {
		return { ok: false, errors: [{ path: "", code: "invalid-value", message: "a proof record is required" }] };
	}
	const candidate = stripDerived(payload as Record<string, unknown>);

	// E01 owns the shape, including every collector-specific requirement:
	// exit_code for host-observed/ci-reported pass/fail, observer for a manual
	// observation, run_reference for ci-reported, block_reason when blocked,
	// and which attestation may vouch for which collector. Re-implementing any
	// of that here would create a second, divergent contract.
	const validation = validateRecord(candidate);
	if (validation.ok !== true) {
		for (const error of validation.errors) {
			fail(errors, error.path, error.code === "missing-field" ? "missing-field" : "invalid-value", error.message);
		}
		return { ok: false, errors };
	}
	const proof = validation.value as ProofRecord;

	// ---- binding: the proof must describe work that exists here ----
	const attempt = await readRecord<AttemptRecord>(store, "attempt", proof.attempt_id, { changeId: proof.change_id });
	if (!attempt) {
		fail(errors, "/attempt_id", "unknown-reference", `no attempt ${proof.attempt_id} in change ${proof.change_id}`);
		return { ok: false, errors };
	}
	const snapshot: SnapshotRecord | null = await readRecord<SnapshotRecord>(store, "snapshot", proof.snapshot_id, { changeId: proof.change_id, attemptId: proof.attempt_id });
	if (!snapshot) {
		fail(errors, "/snapshot_id", "unknown-reference", `no snapshot ${proof.snapshot_id} of attempt ${proof.attempt_id}`);
	} else if (snapshot.attempt_id !== attempt.id) {
		// Unreachable through the store API — a snapshot lives under
		// `attempts/<attempt_id>/snapshots/`, so reading with this attempt's
		// context cannot return another attempt's record; that path yields
		// `unknown-reference` above instead.
		//
		// It IS reachable by tampering: when `storage_boundary` is `none`, any
		// process as the user can drop a foreign record into this attempt's
		// directory. Keeping the check costs one comparison and is the
		// difference between detecting that and trusting it.
		fail(errors, "/snapshot_id", "invalid-value", `snapshot ${snapshot.id} belongs to attempt ${snapshot.attempt_id}, not ${attempt.id}`);
	}

	const slice = await readRecord<SliceRecord>(store, "slice", attempt.slice_id, { changeId: proof.change_id });
	const obligation = slice?.proof_obligations.find((o) => o.id === proof.obligation_id);
	if (slice && !obligation) {
		fail(errors, "/obligation_id", "unknown-reference", `slice ${slice.id} declares no obligation ${proof.obligation_id}`);
	}
	if (obligation && obligation.scenario_id !== undefined && !proof.scenario_ids.includes(obligation.scenario_id)) {
		// A result that proves something other than what the obligation is for
		// discharges nothing; accepting it would let a passing lint stand in
		// for a behavioral scenario.
		fail(errors, "/scenario_ids", "invalid-value", `obligation ${obligation.id} proves scenario ${obligation.scenario_id}, which this proof does not name`);
	}

	// ---- staleness: evidence about bytes that no longer exist ----
	// NOT a rule: comparing a caller-declared `snapshot_digest`. There is no
	// such field — `ProofRecord` binds a `snapshot_id`, and E01 refuses
	// unknown keys, so a first draft's "stale digest" check was dead code that
	// could never fire. A proof always names an immutable snapshot; the bytes
	// it measured cannot drift.
	//
	// The real staleness is relational: the ATTEMPT may have moved on. A proof
	// against a candidate the attempt no longer points at is evidence about
	// superseded bytes. It stays on the record — it is a truthful account of
	// what ran — but it cannot discharge an obligation about the current tree.
	// No `role === "candidate"` term: `candidate_snapshot_id` names a
	// candidate by construction, so a baseline snapshot never equals it and
	// the comparison below already excludes one. A mutation check proved the
	// term could be deleted with no test noticing — it was decoration.
	const supersededCandidate =
		snapshot !== null && attempt.candidate_snapshot_id !== undefined && attempt.candidate_snapshot_id !== snapshot.id;
	// NOT a rule: "the check started before the snapshot was captured". That
	// ordering is the normal one — an agent runs the check, then captures the
	// candidate that records the tree it ran against. E01's own valid proof
	// fixture has exactly that shape, which is how this invented rule was
	// caught. A capture timestamp says when the tree was fingerprinted, not
	// when its bytes came into existence.
	//
	// The real signal the contract defines is stability: `unstable` means the
	// tree MOVED during capture, so nobody can say which bytes the check
	// actually saw. Such a proof is still a truthful record of what was run,
	// so it is retained — but it cannot discharge, because the thing it would
	// discharge against is unknown.

	// ---- internal consistency: the halves of one observation must agree ----
	if ((proof.collector === "host-observed" || proof.collector === "ci-reported") && proof.exit_code !== undefined) {
		if (proof.result === "passed" && proof.exit_code !== 0) {
			fail(errors, "/exit_code", "invalid-value", `a passed result contradicts exit code ${proof.exit_code}; this record was built rather than observed`);
		}
		if (proof.result === "failed" && proof.exit_code === 0) {
			fail(errors, "/exit_code", "invalid-value", "a failed result contradicts exit code 0; this record was built rather than observed");
		}
	}

	// ---- artifacts: identity only, contained ----
	for (const [i, artifact] of proof.artifacts.entries()) {
		if (artifact.retained) {
			await checkRetainedArtifact(store, proof.change_id, proof.attempt_id, artifact.id, `/artifacts/${i}/id`, errors);
		}
		// NOT a rule: a `redacted` flag. `ArtifactReference` has no such field,
		// and E01 refuses unknown keys. The contract signals redaction by the
		// PRESENCE of `sanitized_digest` ("differs from raw_digest whenever
		// anything was redacted"), so there is no state where a redaction is
		// claimed without naming what was published.
	}

	if (errors.length > 0) return { ok: false, errors };

	// ---- storage: create-only ----
	// A completed observation is immutable. Editing one is how a failing
	// result quietly becomes a passing one, so an existing id is refused
	// rather than overwritten — except for an exact idempotent replay, which
	// the store detects by payload.
	const existing = await readRecord<ProofRecord>(store, "proof", proof.id, { changeId: proof.change_id, attemptId: proof.attempt_id });
	if (existing && options.idempotencyKey === undefined) {
		return {
			ok: false,
			errors: [{ path: "/id", code: "already-exists", message: `proof ${proof.id} already exists; a completed observation is immutable` }],
		};
	}

	const put = await store.put(proof, { idempotencyKey: options.idempotencyKey });

	const policy: AssurancePolicy = options.policy ?? "verified";
	const authority = proofAuthority(proof);
	const unstableSnapshot = snapshot?.stability === "unstable";
	const discharges = obligation !== undefined && !unstableSnapshot && !supersededCandidate && proofDischarges(proof, obligation, policy);

	return { ok: true, proof, authority, discharges, replayed: put.replayed };
}

export interface ExportedArtifact {
	id: string;
	label: string;
	media_type?: string;
	/** The sanitized export's digest. The raw digest is deliberately absent — see below. */
	digest?: string;
	retained: boolean;
}

export interface ExportedProofSummary {
	id: string;
	obligation_id: string;
	scenario_ids: string[];
	check: { kind: string; command?: string; procedure?: string };
	collector: string;
	result: string;
	/** Derived, and stated rather than implied, so a reader never has to infer it. */
	authority: EvidenceAuthority;
	exit_code?: number;
	started_at: string;
	ended_at: string;
	block_reason?: string;
	observer?: string;
	artifacts: ExportedArtifact[];
	source: string;
	run_reference?: string;
}

/**
 * The shareable view of a proof.
 *
 * The raw digest never leaves. The raw/sanitized distinction exists precisely
 * because raw bytes may carry secrets, so publishing `raw_digest` would leak
 * the identity of unredacted content — and a digest is a perfectly good
 * confirmation oracle for anyone who already holds a candidate file.
 *
 * Throws rather than degrades when an artifact claims a redaction it cannot
 * evidence: silently exporting it would present unverified sanitization as a
 * completed one.
 */
export function exportProofSummary(proof: ProofRecord): ExportedProofSummary {
	const artifacts: ExportedArtifact[] = proof.artifacts.map((artifact) => {
		const redacted = (artifact as { redacted?: unknown }).redacted === true;
		if (redacted && artifact.sanitized_digest === undefined) {
			throw new Error(`artifact ${artifact.id} is marked redacted but carries no sanitized digest; refusing to export an unverifiable redaction`);
		}
		return {
			id: artifact.id,
			label: artifact.label,
			media_type: artifact.media_type,
			// Only the sanitized digest, and only when one exists. An artifact
			// with no sanitized export contributes no digest at all rather
			// than falling back to the raw one.
			digest: artifact.sanitized_digest,
			retained: artifact.retained,
		};
	});

	return {
		id: proof.id,
		obligation_id: proof.obligation_id,
		scenario_ids: [...proof.scenario_ids],
		check: { kind: proof.check.kind, command: proof.check.command, procedure: proof.check.procedure },
		collector: proof.collector,
		result: proof.result,
		authority: proofAuthority(proof),
		exit_code: proof.exit_code,
		started_at: proof.started_at,
		ended_at: proof.ended_at,
		block_reason: proof.block_reason,
		observer: proof.observer,
		artifacts,
		source: proof.provenance.source,
		run_reference: proof.provenance.run_reference,
	};
}
