// Ingesting host observations from the protected inbox (E05, #409).
//
// The hook (hosts/claude-code/observe.mjs) runs outside the model's sandbox
// and drops one fresh file per Bash call into `<namespace>/inbox/`. This
// module is the other half: it turns each observation into a proof through
// `ingestProof`, and the ONLY thing that decides whether that proof is
// `host-tool-result` (observed, can discharge) or `caller` (claimed, cannot)
// is `attestationForHostObservation(capabilities)` — host configuration
// outside the workspace, never a request field and never the file itself.
//
// Parsing scope (record-contract forward-looking note): ONLY `inbox/*.json`
// regular files are read. `.err`/`.status` in `hook-logs/` are opaque; a
// symlink, a directory, a non-regular file, an oversized file or a file that
// does not validate is skipped and REPORTED, never trusted and never deleted.
//
// Matching: an observation discharges an obligation only when its `command`
// is byte-equal to the obligation's `command` on the attempt's slice.
// No match, or more than one match, is reported and produces no proof.
//
// Retention: a processed file (proof written or replayed) is renamed into
// `<namespace>/inbox/processed/` — never deleted, never modified — so the
// inbox stays bounded while the evidence trail survives. Refused files stay
// where they are for an operator to inspect. The model can do none of this:
// the whole namespace is in the host's `denyWrite` set.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ingestProof, type IngestError } from "./proofs.ts";
import { attestationForHostObservation, isTimestamp } from "./validation.ts";
import { ENGINEERING_SCHEMA_VERSION } from "./types.ts";
import type { AssurancePolicy, AttemptRecord, HostCapabilities, ProofRecord, SliceRecord } from "./types.ts";
import type { EngineeringStore } from "./store.ts";

export const HOST_OBSERVATION_SCHEMA = "codecarto.host-observation/1";
/** Larger than any honest hook output by orders of magnitude; the hook writes digests, not output. */
export const MAX_OBSERVATION_BYTES = 64 * 1024;

export interface HostObservation {
	schema: typeof HOST_OBSERVATION_SCHEMA;
	host: string;
	event: "PostToolUse" | "PostToolUseFailure";
	tool_name: string;
	tool_use_id: string;
	session_id: string;
	cwd: string;
	command: string;
	/** null when the failure carried no `Exit code N` (denied/interrupted). */
	exit_code: number | null;
	stdout: { digest: string; size: number };
	stderr: { digest: string; size: number };
	started_at: string;
	ended_at: string;
}

export interface IngestHostObservationsOptions {
	/** The namespace inbox, normally `<store.root>/inbox`. */
	inboxDir?: string;
	capabilities: Partial<Pick<HostCapabilities, "tool_result_path" | "label">>;
	changeId: string;
	attemptId: string;
	/** Defaults to `verified`; a host-operator policy, never a request field. */
	policy?: AssurancePolicy;
	/** Where processed files are moved; defaults to `<inboxDir>/processed`. Set to null to leave them in place. */
	processedDir?: string | null;
}

export interface SkippedObservation {
	file: string;
	reason:
		| "not-a-regular-file"
		| "symlink"
		| "oversized"
		| "not-json"
		| "invalid-observation"
		| "no-matching-obligation"
		| "ambiguous-obligation"
		| "proof-refused";
	message: string;
	errors?: IngestError[];
}

export interface IngestedObservation {
	file: string;
	proof_id: string;
	obligation_id: string;
	authority: "observed" | "claimed";
	discharges: boolean;
	replayed: boolean;
	result: ProofRecord["result"];
}

export interface IngestHostObservationsOutcome {
	attested_by: "host-tool-result" | "caller";
	ingested: IngestedObservation[];
	skipped: SkippedObservation[];
	/** Files this run moved to `processedDir`. */
	rotated: string[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function nonEmpty(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}
function digestRef(v: unknown): v is { digest: string; size: number } {
	return v !== null && typeof v === "object" && DIGEST.test(String((v as { digest?: unknown }).digest)) && Number.isInteger((v as { size?: unknown }).size) && ((v as { size: number }).size >= 0);
}

const OBSERVATION_KEYS = new Set(["schema", "host", "event", "tool_name", "tool_use_id", "session_id", "cwd", "command", "exit_code", "stdout", "stderr", "started_at", "ended_at", "observer"]);

/**
 * Strict shape check for one inbox record. Unknown keys are refused: the
 * hook writes a closed shape, and an extra `authority`/`discharges`/
 * `attested_by`/`provenance` field is exactly the laundering attempt this
 * path exists to stop (it is also stripped/overwritten downstream, but a file
 * that carries it was not written by the shipped hook).
 */
export function validateHostObservation(value: unknown): { ok: true; value: HostObservation } | { ok: false; message: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "observation must be an object" };
	const o = value as Record<string, unknown>;
	for (const key of Object.keys(o)) if (!OBSERVATION_KEYS.has(key)) return { ok: false, message: `unknown field ${key}` };
	if (o.schema !== HOST_OBSERVATION_SCHEMA) return { ok: false, message: `schema must be ${HOST_OBSERVATION_SCHEMA}` };
	if (o.event !== "PostToolUse" && o.event !== "PostToolUseFailure") return { ok: false, message: "event must be PostToolUse or PostToolUseFailure" };
	for (const key of ["host", "tool_name", "tool_use_id", "command"] as const) if (!nonEmpty(o[key])) return { ok: false, message: `${key} must be a non-empty string` };
	for (const key of ["session_id", "cwd"] as const) if (typeof o[key] !== "string") return { ok: false, message: `${key} must be a string` };
	if (o.exit_code !== null && !(Number.isInteger(o.exit_code) && (o.exit_code as number) >= 0)) return { ok: false, message: "exit_code must be a non-negative integer or null" };
	if (o.event === "PostToolUse" && o.exit_code !== 0) return { ok: false, message: "a PostToolUse observation must carry exit_code 0" };
	if (!digestRef(o.stdout) || !digestRef(o.stderr)) return { ok: false, message: "stdout/stderr must be {digest: sha256:…, size}" };
	if (!isTimestamp(o.started_at) || !isTimestamp(o.ended_at)) return { ok: false, message: "started_at/ended_at must be timestamps" };
	return { ok: true, value: o as unknown as HostObservation };
}

/** Deterministic per (attempt, tool_use_id): the same observation replayed yields the same idempotency key. */
export function observationIdempotencyKey(attemptId: string, observation: Pick<HostObservation, "tool_use_id" | "host">): string {
	// Hashed: the store requires a safe file name and tool_use_id is host-chosen text.
	return `host-observation-${observationHash(attemptId, observation)}`;
}

function observationHash(attemptId: string, observation: Pick<HostObservation, "tool_use_id" | "host">): string {
	return createHash("sha256").update(`${attemptId}\0${observation.host}\0${observation.tool_use_id}`).digest("hex");
}

/**
 * The proof id is DERIVED from (attempt, host, tool_use_id) rather than minted,
 * so the same observation ingested twice produces a byte-identical payload —
 * which is what the store's idempotent replay compares. A minted id would turn
 * every re-read of the inbox into an idempotency conflict.
 */
export function observationProofId(attemptId: string, observation: Pick<HostObservation, "tool_use_id" | "host">): string {
	return `prf_${observationHash(attemptId, observation).slice(0, 24)}`;
}

async function readRegularJson(path: string): Promise<{ ok: true; text: string } | { ok: false; skip: SkippedObservation }> {
	const file = path;
	const st = await lstat(path);
	if (st.isSymbolicLink()) return { ok: false, skip: { file, reason: "symlink", message: "symlinks in the inbox are never followed" } };
	if (!st.isFile()) return { ok: false, skip: { file, reason: "not-a-regular-file", message: "not a regular file" } };
	if (st.size > MAX_OBSERVATION_BYTES) return { ok: false, skip: { file, reason: "oversized", message: `${st.size} bytes exceeds ${MAX_OBSERVATION_BYTES}` } };
	// O_NOFOLLOW between lstat and open closes the swap window; the fstat after
	// open re-checks the object actually opened.
	const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const fst = await fh.stat();
		if (!fst.isFile() || fst.size > MAX_OBSERVATION_BYTES) return { ok: false, skip: { file, reason: "not-a-regular-file", message: "file changed between stat and open" } };
		return { ok: true, text: await fh.readFile("utf8") };
	} finally {
		await fh.close();
	}
}

/**
 * Ingest every well-formed observation in the inbox as a proof for the given
 * attempt. Never throws for a bad file; every non-ingested file is in
 * `skipped` with a reason.
 */
export async function ingestHostObservations(store: EngineeringStore, options: IngestHostObservationsOptions): Promise<IngestHostObservationsOutcome> {
	const inboxDir = resolve(options.inboxDir ?? join(store.root, "inbox"));
	const processedDir = options.processedDir === undefined ? join(inboxDir, "processed") : options.processedDir;
	const attested_by = attestationForHostObservation(options.capabilities);
	const policy: AssurancePolicy = options.policy ?? "verified";
	const outcome: IngestHostObservationsOutcome = { attested_by, ingested: [], skipped: [], rotated: [] };

	let entries: string[];
	try {
		entries = (await readdir(inboxDir)).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return outcome; // no inbox: nothing observed
	}
	if (entries.length === 0) return outcome;

	const attempt = (await store.get("attempt", options.attemptId, { changeId: options.changeId })).record as AttemptRecord;
	const slice = (await store.get("slice", attempt.slice_id, { changeId: options.changeId })).record as SliceRecord;

	for (const name of entries) {
		const file = join(inboxDir, name);
		let text: string;
		try {
			const read = await readRegularJson(file);
			if (read.ok === false) {
				outcome.skipped.push(read.skip);
				continue;
			}
			text = read.text;
		} catch (error) {
			outcome.skipped.push({ file, reason: "not-a-regular-file", message: error instanceof Error ? error.message : String(error) });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			outcome.skipped.push({ file, reason: "not-json", message: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const validated = validateHostObservation(parsed);
		if (validated.ok === false) {
			outcome.skipped.push({ file, reason: "invalid-observation", message: validated.message });
			continue;
		}
		const observation = validated.value;

		// Exact command equality only. A substring or prefix match would let
		// `npm test; true` discharge the obligation for `npm test`.
		const matches = slice.proof_obligations.filter((o) => o.command !== undefined && o.command === observation.command);
		if (matches.length === 0) {
			outcome.skipped.push({ file, reason: "no-matching-obligation", message: `no obligation on slice ${slice.id} names command ${JSON.stringify(observation.command)}` });
			continue;
		}
		if (matches.length > 1) {
			outcome.skipped.push({ file, reason: "ambiguous-obligation", message: `obligations ${matches.map((o) => o.id).join(", ")} all name command ${JSON.stringify(observation.command)}` });
			continue;
		}
		const obligation = matches[0];

		// A failure without an exit code is a check that did not complete: blocked.
		const result: ProofRecord["result"] = observation.exit_code === null ? "blocked" : observation.exit_code === 0 ? "passed" : "failed";
		const proof: Record<string, unknown> = {
			schema_version: ENGINEERING_SCHEMA_VERSION,
			kind: "proof",
			id: observationProofId(attempt.id, observation),
			// Deterministic for the same reason as the id; the observation's own end time.
			created_at: observation.ended_at,
			change_id: options.changeId,
			attempt_id: attempt.id,
			snapshot_id: attempt.candidate_snapshot_id,
			obligation_id: obligation.id,
			scenario_ids: [obligation.scenario_id],
			check: { kind: obligation.check_kind, command: observation.command },
			collector: "host-observed",
			result,
			...(result === "blocked" ? { block_reason: "the host reported a failure without an exit code (denied or interrupted)" } : { exit_code: observation.exit_code }),
			started_at: observation.started_at,
			ended_at: observation.ended_at,
			artifacts: [],
			// Stated here, once. The attestation is the host configuration's,
			// not the file's; tool_call_id is the host's identifier for the call.
			provenance: {
				source: `${observation.host}:post-tool-use-hook`,
				attested_by,
				...(attested_by === "host-tool-result" ? { tool_call_id: observation.tool_use_id } : {}),
			},
		};
		let ingested;
		try {
			ingested = await ingestProof(store, proof, { policy, idempotencyKey: observationIdempotencyKey(attempt.id, observation) });
		} catch (error) {
			// e.g. idempotency-conflict: same tool_use_id, different bytes — two
			// files claiming to be one call. Neither is believed.
			outcome.skipped.push({ file, reason: "proof-refused", message: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (ingested.ok === false) {
			outcome.skipped.push({ file, reason: "proof-refused", message: ingested.errors.map((e) => e.message).join("; "), errors: ingested.errors });
			continue;
		}
		outcome.ingested.push({ file, proof_id: ingested.proof.id, obligation_id: obligation.id, authority: ingested.authority, discharges: ingested.discharges, replayed: ingested.replayed, result });

		if (processedDir !== null) {
			try {
				await mkdir(processedDir, { recursive: true });
				await rename(file, join(processedDir, name));
				outcome.rotated.push(file);
			} catch {
				/* the proof is stored; a file that cannot be rotated is replayed harmlessly next time */
			}
		}
	}
	return outcome;
}
