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
// Binding (reviewer finding 2 on #446): an observation is evidence about
// THIS attempt's current candidate only if it could be. Three refusals, each
// of which only ever refuses more, never trusts more:
//   - `observation-predates-attempt`: ended before the attempt was created;
//   - `observation-outside-workspace`: recorded in a cwd that is not the
//     workspace root the store was opened from (realpaths compared);
//   - `tree-activity-after-run`: a file-changing tool (an ACTIVITY entry the
//     hook records for Edit/Write/MultiEdit/NotebookEdit) or a later Bash
//     call in the SAME session ran strictly after the check ended and at or
//     before the candidate was captured. The tree may have moved between the
//     run and the capture, so the check cannot vouch for the captured bytes.
//     This is the contract's stability signal, not a timestamp-order rule:
//     run-then-capture with nothing in between is the normal order and is
//     accepted; capture-then-run is the gate's candidate-reread problem.
// No session binding: no record ties an attempt to a host session, and a
// rule that invented one would have nothing to compare against.
//
// Not observed, and so operator-attested: edits from another session (a
// subagent, a second window), from the user's editor, or from anything that
// is not a Claude Code tool call. The hook sees only the session that runs it.
//
// Retention: a processed file (proof written or replayed) is renamed into
// `<namespace>/inbox/processed/` — never deleted, never modified — so the
// inbox stays bounded while the evidence trail survives. Refused files stay
// where they are for an operator to inspect. An activity entry, or an
// ingested Bash observation, is rotated only when no observation it could
// gate is still in the inbox (same session, earlier `ended_at`): rotating it
// sooner would let the refused observation discharge on the next read. The
// model can do none of this: the whole namespace is in the host's
// `denyWrite` set.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ingestProof, type IngestError } from "./proofs.ts";
import { attestationForHostObservation, isTimestamp } from "./validation.ts";
import { ENGINEERING_SCHEMA_VERSION } from "./types.ts";
import type { AssurancePolicy, AttemptRecord, HostCapabilities, ProofRecord, SliceRecord, SnapshotRecord } from "./types.ts";
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

/**
 * An ACTIVITY entry: the hook's record that a file-changing tool completed.
 * Carries nothing from the tool's input — no path, no content — and is never
 * turned into a proof; it only gates observations that precede it.
 */
export interface HostActivity {
	schema: typeof HOST_OBSERVATION_SCHEMA;
	kind: "activity";
	host: string;
	event: "PostToolUse" | "PostToolUseFailure";
	tool_name: string;
	tool_use_id: string;
	session_id: string;
	cwd: string;
	ended_at: string;
}

export interface IngestHostObservationsOptions {
	/** The namespace inbox, normally `<store.root>/inbox`. */
	inboxDir?: string;
	/**
	 * The workspace root observations must have been recorded in. Defaults to
	 * the directory the store's namespace lives under (`<root>/../..`, i.e. the
	 * project whose `.codecarto/engineering` is the store). Compared by realpath.
	 */
	workspaceRoot?: string;
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
		| "observation-predates-attempt"
		| "observation-outside-workspace"
		| "tree-activity-after-run"
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
const ACTIVITY_KEYS = new Set(["schema", "kind", "host", "event", "tool_name", "tool_use_id", "session_id", "cwd", "ended_at"]);
/** The tools whose completion the hook records as activity. */
export const ACTIVITY_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

/**
 * Strict shape check for an activity entry: the same closed-shape rule as
 * an observation (unknown keys refused), and only the tools the hook records.
 * A `command`, `exit_code` or digest on an activity entry is refused — an
 * activity entry never carries anything that could be read as a result.
 */
export function validateHostActivity(value: unknown): { ok: true; value: HostActivity } | { ok: false; message: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "activity must be an object" };
	const o = value as Record<string, unknown>;
	for (const key of Object.keys(o)) if (!ACTIVITY_KEYS.has(key)) return { ok: false, message: `unknown field ${key}` };
	if (o.schema !== HOST_OBSERVATION_SCHEMA) return { ok: false, message: `schema must be ${HOST_OBSERVATION_SCHEMA}` };
	if (o.kind !== "activity") return { ok: false, message: "kind must be activity" };
	if (o.event !== "PostToolUse" && o.event !== "PostToolUseFailure") return { ok: false, message: "event must be PostToolUse or PostToolUseFailure" };
	for (const key of ["host", "tool_use_id"] as const) if (!nonEmpty(o[key])) return { ok: false, message: `${key} must be a non-empty string` };
	if (!nonEmpty(o.tool_name) || !ACTIVITY_TOOLS.has(o.tool_name)) return { ok: false, message: `tool_name must be one of ${[...ACTIVITY_TOOLS].join(", ")}` };
	for (const key of ["session_id", "cwd"] as const) if (typeof o[key] !== "string") return { ok: false, message: `${key} must be a string` };
	if (!isTimestamp(o.ended_at)) return { ok: false, message: "ended_at must be a timestamp" };
	return { ok: true, value: o as unknown as HostActivity };
}

/** An inbox record is an activity entry iff it says so; anything else is held to the observation shape. */
export function isActivityShaped(value: unknown): boolean {
	return value !== null && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "activity";
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

/**
 * Read one inbox file as text, refusing anything that is not a small regular
 * file. Exported with an injectable `lstat` ONLY so a test can make the
 * `O_NOFOLLOW` open matter: with a stat that lies (reports a regular file for
 * a path that is a symlink — the swap-between-lstat-and-open window), the
 * open itself must still refuse to follow. Production callers never pass it.
 */
export async function readInboxFile(path: string, fs: { lstat: typeof lstat } = { lstat }): Promise<{ ok: true; text: string } | { ok: false; skip: SkippedObservation }> {
	const file = path;
	const st = await fs.lstat(path);
	if (st.isSymbolicLink()) return { ok: false, skip: { file, reason: "symlink", message: "symlinks in the inbox are never followed" } };
	if (!st.isFile()) return { ok: false, skip: { file, reason: "not-a-regular-file", message: "not a regular file" } };
	if (st.size > MAX_OBSERVATION_BYTES) return { ok: false, skip: { file, reason: "oversized", message: `${st.size} bytes exceeds ${MAX_OBSERVATION_BYTES}` } };
	// O_NOFOLLOW between lstat and open closes the swap window; the fstat after
	// open re-checks the object actually opened.
	let fh;
	try {
		fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		// ELOOP: the object at the path became a symlink after the lstat.
		return { ok: false, skip: { file, reason: "symlink", message: `refused to open: ${error instanceof Error ? error.message : String(error)}` } };
	}
	try {
		const fst = await fh.stat();
		if (!fst.isFile() || fst.size > MAX_OBSERVATION_BYTES) return { ok: false, skip: { file, reason: "not-a-regular-file", message: "file changed between stat and open" } };
		return { ok: true, text: await fh.readFile("utf8") };
	} finally {
		await fh.close();
	}
}

const ms = (timestamp: string): number => Date.parse(timestamp);

async function realpathOrNull(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch {
		return null;
	}
}

/** One parsed, validated inbox record with its file. */
type InboxRecord = { file: string; name: string } & ({ kind: "observation"; value: HostObservation } | { kind: "activity"; value: HostActivity });

/**
 * Did `later` happen in a way that makes `earlier` unable to vouch for the
 * candidate? Same session, strictly after the check ended, at or before the
 * capture (an undefined capture bound refuses everything after the run:
 * without a candidate there is nothing the check could be about anyway).
 */
function gates(later: { session_id: string; ended_at: string }, earlier: HostObservation, capturedAtMs: number | undefined): boolean {
	if (later.session_id !== earlier.session_id) return false;
	const t = ms(later.ended_at);
	if (!(t > ms(earlier.ended_at))) return false;
	return capturedAtMs === undefined || t <= capturedAtMs;
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
	const attemptCreatedMs = ms(attempt.created_at);
	// The capture instant of the CURRENT candidate bounds the activity window.
	// No candidate, or one that cannot be read: the bound is open (refuse more).
	let capturedAtMs: number | undefined;
	if (attempt.candidate_snapshot_id !== undefined) {
		try {
			const snapshot = (await store.get("snapshot", attempt.candidate_snapshot_id, { changeId: options.changeId, attemptId: attempt.id })).record as SnapshotRecord;
			capturedAtMs = ms(snapshot.captured_at);
		} catch {
			capturedAtMs = undefined;
		}
	}
	const workspaceRoot = await realpathOrNull(options.workspaceRoot ?? resolve(store.root, "..", ".."));

	// Pass 1: read and classify every file. Activity entries and observations
	// are both needed before any observation can be judged.
	const records: InboxRecord[] = [];
	for (const name of entries) {
		const file = join(inboxDir, name);
		let text: string;
		try {
			const read = await readInboxFile(file);
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
		if (isActivityShaped(parsed)) {
			const activity = validateHostActivity(parsed);
			if (activity.ok === false) {
				outcome.skipped.push({ file, reason: "invalid-observation", message: `activity: ${activity.message}` });
				continue;
			}
			records.push({ file, name, kind: "activity", value: activity.value });
			continue;
		}
		const validated = validateHostObservation(parsed);
		if (validated.ok === false) {
			outcome.skipped.push({ file, reason: "invalid-observation", message: validated.message });
			continue;
		}
		records.push({ file, name, kind: "observation", value: validated.value });
	}

	// Everything that can gate an observation: activity entries, and every
	// Bash observation (a later Bash call may have modified files too).
	const gating = records.map((r) => ({ file: r.file, tool_use_id: r.value.tool_use_id, tool_name: r.value.tool_name, session_id: r.value.session_id, ended_at: r.value.ended_at }));

	// Pass 2: judge and ingest each observation.
	const rotatable: InboxRecord[] = [];
	const remaining: HostObservation[] = [];
	for (const record of records) {
		if (record.kind === "activity") {
			rotatable.push(record);
			continue;
		}
		const { file, value: observation } = record;

		if (ms(observation.ended_at) < attemptCreatedMs) {
			outcome.skipped.push({ file, reason: "observation-predates-attempt", message: `ended ${observation.ended_at}, before attempt ${attempt.id} was created at ${attempt.created_at}` });
			remaining.push(observation);
			continue;
		}
		const observedIn = await realpathOrNull(observation.cwd);
		if (workspaceRoot === null || observedIn === null || observedIn !== workspaceRoot) {
			outcome.skipped.push({ file, reason: "observation-outside-workspace", message: `recorded in ${JSON.stringify(observation.cwd)}, not the workspace root ${JSON.stringify(workspaceRoot)}` });
			remaining.push(observation);
			continue;
		}
		const later = gating.find((g) => g.file !== file && gates(g, observation, capturedAtMs));
		if (later !== undefined) {
			outcome.skipped.push({ file, reason: "tree-activity-after-run", message: `${later.tool_name} call ${later.tool_use_id} completed at ${later.ended_at}, after this check ended at ${observation.ended_at} and before the candidate was captured; the tree may have moved` });
			remaining.push(observation);
			continue;
		}

		// Exact command equality only. A substring or prefix match would let
		// `npm test; true` discharge the obligation for `npm test`.
		const matches = slice.proof_obligations.filter((o) => o.command !== undefined && o.command === observation.command);
		if (matches.length === 0) {
			outcome.skipped.push({ file, reason: "no-matching-obligation", message: `no obligation on slice ${slice.id} names command ${JSON.stringify(observation.command)}` });
			remaining.push(observation);
			continue;
		}
		if (matches.length > 1) {
			outcome.skipped.push({ file, reason: "ambiguous-obligation", message: `obligations ${matches.map((o) => o.id).join(", ")} all name command ${JSON.stringify(observation.command)}` });
			remaining.push(observation);
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
			remaining.push(observation);
			continue;
		}
		if (ingested.ok === false) {
			outcome.skipped.push({ file, reason: "proof-refused", message: ingested.errors.map((e) => e.message).join("; "), errors: ingested.errors });
			remaining.push(observation);
			continue;
		}
		outcome.ingested.push({ file, proof_id: ingested.proof.id, obligation_id: obligation.id, authority: ingested.authority, discharges: ingested.discharges, replayed: ingested.replayed, result });
		rotatable.push(record);
	}

	if (processedDir === null) return outcome;
	for (const record of rotatable) {
		// Keep anything that still gates an observation left in the inbox: a
		// refused observation must be refused again on the next read, which
		// needs the record that refused it to still be there. The capture bound
		// is deliberately not applied — a later capture may move it.
		const stillGates = remaining.some((earlier) => earlier.session_id === record.value.session_id && ms(record.value.ended_at) > ms(earlier.ended_at));
		if (stillGates) continue;
		try {
			await mkdir(processedDir, { recursive: true });
			await rename(record.file, join(processedDir, record.name));
			outcome.rotated.push(record.file);
		} catch {
			/* the proof is stored; a file that cannot be rotated is replayed harmlessly next time */
		}
	}
	return outcome;
}
