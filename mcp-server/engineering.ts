// The experimental engineering MCP surface (E07, #405).
//
// ---------------------------------------------------------------------------
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
//
// This is the first point at which the engineering record system is reachable
// from outside this process. Everything beneath it — the store, the planner,
// proof ingestion, the gates — was written for a caller that had already been
// admitted. A tool call has not been, so this file is a boundary before it is
// an API.
//
// It adds ONE tool with an action discriminator rather than a dozen entries.
// An inventory that grows by twelve is an inventory nobody audits, and each
// name would be a separately-reviewable surface.
//
// THREE THINGS IT MUST NOT DO:
//
//   1. Introduce execution. No `exec`, no spawn, no target-code write, no
//      GitHub mutation, no provider call. The server gains a way to RECORD
//      what a host did, never a second way to do things. A test greps this
//      file for those symbols rather than trusting the claim.
//
//   2. Let an agent approve its own work. Approval needs a trusted channel and
//      a receipt E01 can evaluate. A `decision: accepted` arriving as an
//      ordinary tool argument is the exact forgery this system exists to
//      prevent, so it is refused HERE — not stored and disbelieved later,
//      because a stored forgery is one validator change away from being
//      believed.
//
//   3. Claim more than the transport supports. A tool call is a caller-reported
//      channel by construction. Every proof arriving this way is `claimed`,
//      whatever its payload says, and the gate result says plainly when this
//      host cannot obtain a human decision.
//
// The operations are thin adapters over core. Nearly all the code below is
// argument validation, because that is where the value is.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import {
	boundCandidate,
	buildChangeBrief,
	captureCandidate,
	describeGateOutcome,
	engineeringPaths,
	evaluateAcceptanceGate,
	ingestHostObservations,
	ingestProof,
	newRecordId,
	openStore,
	recordReview,
	requestAcceptance,
	startAttempt,
	validateRecordOfKind,
	type ChangeRecord,
	type CurrentStorage,
	type EngineeringStore,
	type HostCapabilities,
	type Presenter,
	type ProofRecord,
	type SnapshotRecord,
	type VerifiedAcceptanceIntegration,
} from "../core/engineering/index.ts";
import { ENGINEERING_SCHEMA_VERSION, type AttemptRecord, type CoverageExclusion } from "../core/engineering/types.ts";
import { atomicWriteFile } from "../core/utils.ts";
import { captureWorkingTree, readWorkingTree } from "./working-tree.ts";

/** Every action this surface implements. Pinned so the schema and the dispatch cannot drift. */
export const CHANGE_ACTIONS = ["create", "update", "show", "list", "plan", "start_attempt", "capture_candidate", "record_proof", "record_review", "gate", "request_acceptance", "ingest_observations"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * Actions an agent may NOT reach through this surface, and why.
 *
 * Listing them explicitly — rather than simply not implementing them — means a
 * caller gets a reason instead of "unknown action", and a future contributor
 * sees that the omission was a decision.
 */
// A null prototype and an Object.hasOwn guard at the lookup, so `action:
// "constructor"` cannot reach Object's constructor and print native function
// source as the refusal reason.
//
// UNTESTED BY CONSTRUCTION, and deliberately kept: the allow-list below runs
// after this check and rejects every inherited name anyway, so mutating either
// guard away leaves the suite green. That makes them defence in depth rather
// than dead code — if the two checks are ever reordered, or an inherited name
// is added to CHANGE_ACTIONS, the leak returns. Removing a guard because a
// mutation survived is exactly the error that let a baseline proof discharge
// in E05.
const REFUSED_ACTIONS: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
	approve: "acceptance requires a trusted channel and a receipt the core can evaluate; it cannot be reached through an ordinary tool argument",
	accept: "acceptance requires a trusted channel and a receipt the core can evaluate; it cannot be reached through an ordinary tool argument",
	record: "records are written through their own action; a free-form record write would let a caller choose its own kind",
	execute: "this surface records what a host did; it never runs anything",
	run: "this surface records what a host did; it never runs anything",
});

/**
 * A change id derived from the caller's request key.
 *
 * Same key, same id — so a retried create collides with its own first write
 * and the store reports the original rather than minting a second change.
 */
/** ingestProof, with request-blaming store refusals mapped to InvalidParams. */
async function ingestProofSafely(store: EngineeringStore, payload: Record<string, unknown>) {
	try {
		return await ingestProof(store, payload as never);
	} catch (error) {
		throw asCallerError(error);
	}
}

function deterministicChangeId(requestId: string): string {
	const digest = createHash("sha256").update(`change:${requestId}`).digest("hex").slice(0, 24);
	return `chg_${digest}`;
}

/**
 * The wall-clock time of the FIRST call carrying this request id.
 *
 * A retry must serialize to the same bytes or the store reports a conflict, so
 * the timestamp cannot simply be read again. Rather than synthesize one, the
 * first real time is recovered from the change the earlier call already wrote.
 */
async function rememberedTimestamp(store: EngineeringStore, requestId: string): Promise<string> {
	const existing = await store.get("change", deterministicChangeId(requestId)).catch(() => null);
	const remembered = (existing?.record as ChangeRecord | undefined)?.created_at;
	return remembered ?? new Date().toISOString();
}

/** Map a store-level refusal that blames the REQUEST onto a caller-facing code. */
function asCallerError(error: unknown): unknown {
	const code = (error as { code?: string } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	switch (code) {
		case "idempotency-conflict":
			// Retrying verbatim will never succeed: the key is already bound to
			// different bytes. Say so rather than looking like a blip.
			return new ProtocolError(ProtocolErrorCode.InvalidParams, `${message}; use a new request_id or resend the original payload`);
		case "invalid-enum":
		case "invalid-value":
		case "invalid-request":
		case "stale-revision":
		case "unknown-field":
		case "missing-field":
		case "cross-change-reference":
		case "not-found":
			return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
		case "invalid-state":
			// The records are not in a state this action can act on (no
			// candidate bound, already accepted, a request in flight). The
			// request is what is wrong, so a retry without change fails again.
			return new ProtocolError(ProtocolErrorCode.InvalidRequest, message);
		default:
			return error;
	}
}

/**
 * Strip control characters from free text before it is reported back.
 *
 * A title is caller-supplied and reaches a human-readable line. A NUL byte
 * truncates that line in some terminals and ANSI escapes can repaint it, so a
 * caller could make the reported record look like something it is not. The
 * STORED value keeps whatever E01 accepts; this only governs what is shown.
 */
function displayText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function invalid(message: string): never {
	throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

/** A non-empty string argument, or a refusal naming the field. */
function requireString(args: Record<string, unknown>, field: string): string {
	const value = args[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		invalid(`${field} is required and must be a non-empty string`);
	}
	return value;
}

/**
 * Refuse any attempt to set a field this surface does not own.
 *
 * `state`, `decision`, `authority` and `discharges` are all DERIVED — by the
 * store, by the approval machinery, by proof ingestion. A caller that can set
 * them directly can assert a conclusion rather than report an observation.
 */
/** States after which a change's approved presentation must not move. */
const TERMINAL_CHANGE_STATES = new Set(["accepted", "abandoned"]);

const DERIVED_FIELDS = ["state", "decision", "authority", "discharges", "revision_token", "approved_by", "accepted_at", "attested_by"];

/**
 * Fields the LIFECYCLE actions derive from the tree or the stored records.
 * `outcome` is a create argument (the requested outcome) but an attempt's
 * `outcome` is a lifecycle conclusion; it is refused only where the second
 * meaning applies.
 */
const LIFECYCLE_ACTIONS = new Set(["start_attempt", "capture_candidate", "record_review"]);
const LIFECYCLE_DERIVED_FIELDS = ["outcome", "stability", "digest", "candidate_snapshot_id", "candidate_digest", "input_digest", "baseline_snapshot_id", "collector", "ended_at", "started_at"];

function refuseDerivedFields(args: Record<string, unknown>, where: string): void {
	const fields = LIFECYCLE_ACTIONS.has(where) ? [...DERIVED_FIELDS, ...LIFECYCLE_DERIVED_FIELDS] : DERIVED_FIELDS;
	for (const field of fields) {
		if (field === "state" && where === "update") {
			// `state` is refused for update too, but with a specific message:
			// it is the field an agent would reach for to mark its own work
			// accepted, and a generic error would read like a schema quibble.
			if (args.state !== undefined) {
				invalid(
					"state is derived from the recorded evidence and cannot be set directly; an attempt to set it to accepted is an attempt to approve your own work",
				);
			}
			continue;
		}
		if (args[field] !== undefined) {
			invalid(`${field} is derived and cannot be supplied by a caller`);
		}
	}
}

export interface ChangeArgs extends Record<string, unknown> {
	cwd?: string;
	action?: string;
	change_id?: string;
	request_id?: string;
}

/**
 * The single entry point. `validateCwd`/`requireWorkspace` are the server's
 * own, passed in so this module stays free of workspace-resolution logic (and
 * of the filesystem checks that go with it).
 */
export function createChangeHandler(deps: {
	validateCwd: (cwd: unknown) => Promise<string>;
	requireWorkspaceDir: (cwd: string) => Promise<string>;
	textResult: (text: string, structured?: Record<string, unknown>) => unknown;
	/**
	 * The live session, for `request_acceptance`. Derived by the SERVER from
	 * the transport (client capabilities and clientInfo at initialize) and
	 * from host configuration; absent for handlers driven without a session,
	 * in which case the host declares no channel.
	 */
	session?: () => AcceptanceSession | undefined;
}) {
	return async function handleChange(args: ChangeArgs) {
		const action = args.action;
		if (typeof action !== "string" || action.length === 0) {
			invalid(`action is required; one of ${CHANGE_ACTIONS.join(", ")}`);
		}
		if (Object.hasOwn(REFUSED_ACTIONS, action)) {
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${action} is not available through this surface: ${REFUSED_ACTIONS[action]}`);
		}
		if (!(CHANGE_ACTIONS as readonly string[]).includes(action)) {
			invalid(`unknown action ${JSON.stringify(action)}; one of ${CHANGE_ACTIONS.join(", ")}`);
		}

		const cwd = await deps.validateCwd(args.cwd);
		const workspaceDir = await deps.requireWorkspaceDir(cwd);
		const store = await openStore(workspaceDir);

		switch (action as ChangeAction) {
			case "create":
				return await createChange(store, args, deps.textResult);
			case "update":
				return await updateChange(store, args, deps.textResult);
			case "show":
				return await showChange(store, args, deps.textResult);
			case "list":
				return await listChanges(store, deps.textResult);
			case "plan":
				return await planChange(store, args, deps.textResult);
			case "start_attempt":
				return await startAttemptAction(store, args, deps.textResult, cwd);
			case "capture_candidate":
				return await captureCandidateAction(store, args, deps.textResult, cwd);
			case "record_proof":
				return await recordProof(store, args, deps.textResult);
			case "record_review":
				return await recordReviewAction(store, args, deps.textResult);
			case "gate":
				return await gateChange(store, args, deps.textResult, cwd);
			case "request_acceptance":
				return await requestAcceptanceAction(store, args, deps.textResult, deps.session?.(), cwd);
			case "ingest_observations":
				return await ingestObservations(store, args, deps.textResult);
		}
	};
}

/**
 * Retry-safe creation.
 *
 * A tool call gets retried — by a flaky transport, or by an agent that never
 * saw the first result. A retry that forks the workspace into two changes is
 * worse than an error, because nothing downstream can tell which one is real.
 * When `request_id` is supplied, a second call with the same one returns the
 * first change instead of minting another.
 */
async function createChange(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	refuseDerivedFields(args, "create");
	const title = requireString(args, "title");
	const outcome = requireString(args, "outcome");
	const requestId = typeof args.request_id === "string" ? args.request_id : undefined;

	// A retry must produce the SAME BYTES or the store's idempotency check
	// correctly calls it a conflict. A fresh uuid and a fresh timestamp on
	// every call would make two retries of one request differ, so when the
	// caller supplies a request_id both are derived from it: the id from a
	// digest of the key, the timestamp from the request's own content. Without
	// a request_id the ordinary fresh values are used and no retry-safety is
	// claimed.
	// F-3: the timestamp comes from the clock, never from a digest. An earlier
	// revision derived it from the request so retries produced identical bytes,
	// but that bounded every created_at in a workspace to 1000 distinct values
	// in the year 2020 — any consumer ordering by creation time got arbitrary
	// order. Retry-safety now comes from remembering the first call's timestamp.
	const now = requestId ? await rememberedTimestamp(store, requestId) : new Date().toISOString();
	const record = {
		schema_version: ENGINEERING_SCHEMA_VERSION,
		kind: "change" as const,
		id: requestId ? deterministicChangeId(requestId) : newRecordId("change"),
		created_at: now,
		updated_at: now,
		revision: 1,
		title,
		// `feature` is the neutral default for a change created without a
		// declared mode. CHANGE_MODES is fix/feature/refactor/migration/
		// investigation — there is no "behavior".
		mode: (typeof args.mode === "string" ? args.mode : "feature") as never,
		state: "draft" as const,
		requested_outcome: outcome,
		// E01 requires a full commit hash whenever vcs is `git` — "HEAD" alone
		// never identifies a candidate, so a baseline without one would be a
		// pointer that resolves to different bytes tomorrow. A caller that
		// supplies the commit gets a git baseline; one that does not gets an
		// honest `none` rather than a git baseline that names nothing.
		baseline:
			typeof args.baseline_commit === "string" && args.baseline_commit.length > 0
				? { vcs: "git" as const, head: args.baseline_commit, description: "recorded through the experimental MCP surface" }
				: { vcs: "none" as const, description: "recorded through the experimental MCP surface; no baseline commit supplied" },
		scope: { in_scope: [], non_goals: [] },
		preserved_contracts: [],
		acceptance_scenarios: [],
		references: [],
	};

	// Retry-safety uses the store's own idempotency key, not a record field:
	// `request_id` is not part of the change schema and putting it there is
	// correctly refused. A repeated call with the same key is a no-op that
	// reports the original id rather than minting a second change.
	let put;
	try {
		put = await store.put(record as never, requestId ? { idempotencyKey: requestId } : undefined);
	} catch (error) {
		// F-4: a caller's bad argument is not a server fault. StoreError codes
		// that describe the REQUEST are re-raised as InvalidParams so a host can
		// branch on them; InternalError invites a retry that fails identically
		// forever.
		throw asCallerError(error);
	}
	return textResult(`Created change ${put.id} (revision ${put.revision}).`, {
		change_id: put.id,
		revision: put.revision,
		state: record.state,
		retried: put.replayed === true,
	});
}

async function updateChange(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	refuseDerivedFields(args, "update");
	const changeId = requireString(args, "change_id");
	const current = await store.get("change", changeId);
	const record = current.record as ChangeRecord;

	// The CAS token is carried through rather than papered over: two writers
	// that cannot see each other must not silently lose one another's work.
	// F-1: title and requested_outcome are exactly the fields an
	// AcceptancePresentation carries, and an approval's presentation_digest is
	// recomputed from its OWN embedded copy — so editing them after acceptance
	// leaves the approval validating against a change it no longer describes.
	// The record would then state an outcome nobody approved.
	if (TERMINAL_CHANGE_STATES.has(record.state)) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidRequest,
			`change ${changeId} is ${record.state} and cannot be edited: an approval records agreement to a specific title and outcome, ` +
				`so changing them would leave the approval describing bytes nobody approved. Open a new change instead.`,
		);
	}

	// F-2: the CAS is no longer opt-in. Omitting `revision` used to mean the
	// adapter compared the record against itself, which is not a
	// compare-and-swap at all — it is last-write-wins with extra steps, and a
	// second writer's work vanished with no error reported to anyone.
	const revision = args.revision;
	if (revision === undefined) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`update requires the revision you last read (change ${changeId} is at revision ${record.revision}), ` +
				`so a concurrent writer's work cannot be overwritten silently`,
		);
	}
	if (typeof revision !== "number" || !Number.isInteger(revision)) {
		throw new ProtocolError(ProtocolErrorCode.InvalidParams, `revision must be an integer, got ${JSON.stringify(revision)}`);
	}
	if (revision !== record.revision) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`stale revision ${String(revision)}: change ${changeId} is at revision ${record.revision}; re-read it and retry`,
		);
	}

	const next = {
		...record,
		revision: record.revision + 1,
		...(typeof args.title === "string" ? { title: args.title } : {}),
		...(typeof args.outcome === "string" ? { requested_outcome: args.outcome } : {}),
		updated_at: new Date().toISOString(),
	};
	let put;
	try {
		put = await store.put(next as never, { ifRevision: record.revision });
	} catch (error) {
		throw asCallerError(error);
	}
	return textResult(`Updated change ${changeId} to revision ${put.revision}.`, { change_id: changeId, revision: put.revision });
}

async function showChange(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	const changeId = requireString(args, "change_id");
	const found = await store.get("change", changeId);
	const record = found.record as ChangeRecord;
	return textResult(`${displayText(record.title)} (${record.state}, revision ${record.revision})\n\n${displayText(record.requested_outcome)}`, {
		change_id: record.id,
		title: record.title,
		state: record.state,
		revision: record.revision,
		requested_outcome: record.requested_outcome,
	});
}

async function listChanges(store: EngineeringStore, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	const changes = await store.listChanges();
	const lines = changes.map((c) => `- ${c.id}`);
	return textResult(changes.length === 0 ? "No changes recorded." : lines.join("\n"), { changes: changes.map((c) => c.id) });
}

/**
 * Build the brief and, when `slices` are supplied, record the plan.
 *
 * Without `slices` this is the read-only preview it always was. With them,
 * the change moves `draft` -> `planned` under compare-and-swap on `revision`,
 * carrying the caller's `acceptance_scenarios`, and each slice is stored
 * `pending`; `start_attempt` activates the change and the slice it works on.
 * The brief is written to `brief.md` and the plan to `plan.md` so their
 * digests — returned here — can be the attempt's inputs. Slices are
 * validated by the same schema as a stored slice record; a slice whose
 * obligation names `agent-claimed` as its minimum is refused there.
 */
async function planChange(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	refuseDerivedFields(args, "plan");
	const changeId = requireString(args, "change_id");
	const found = await store.get("change", changeId);
	const record = found.record as ChangeRecord;
	const scenarios = Array.isArray(args.acceptance_scenarios) ? (args.acceptance_scenarios as ChangeRecord["acceptance_scenarios"]) : record.acceptance_scenarios;
	const brief = buildChangeBrief({
		title: record.title,
		mode: record.mode,
		requested_outcome: record.requested_outcome,
		baseline: { vcs: "git", description: record.baseline.description },
		scope: record.scope,
		preserved_contracts: record.preserved_contracts,
		acceptance_scenarios: scenarios,
		references: record.references,
	});
	if (!brief.ok || !brief.markdown) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`this change cannot be planned yet: ${(brief.errors ?? []).map((e) => e.message).join("; ") || "the brief could not be built"}`,
		);
	}
	if (args.slices === undefined) return textResult(brief.markdown, { change_id: changeId, markdown: brief.markdown });

	if (!Array.isArray(args.slices) || args.slices.length === 0) invalid("slices must be a non-empty array of { title, deliverable, scenario_ids, proof_obligations, permitted_scope, depends_on? }");
	if (typeof args.revision !== "number" || args.revision !== record.revision) {
		invalid(`plan requires the revision you last read (change ${changeId} is at revision ${record.revision}) so a concurrent planner's slices are not overwritten silently`);
	}
	if (record.state !== "draft") throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `change ${changeId} is ${record.state}; slices are planned once, from draft`);
	const now = new Date().toISOString();
	const slices = (args.slices as Record<string, unknown>[]).map((input) => {
		if (typeof input !== "object" || input === null) invalid("each slice must be an object");
		for (const field of ["id", "state", "revision", "change_id", "block_reason"]) if (input[field] !== undefined) invalid(`slices[].${field} is derived and cannot be supplied`);
		const slice = { schema_version: ENGINEERING_SCHEMA_VERSION, kind: "slice" as const, id: newRecordId("slice"), created_at: now, updated_at: now, change_id: changeId, revision: 1, state: "pending" as const, depends_on: [], ...input };
		const valid = validateRecordOfKind("slice", slice);
		if (valid.ok === false) invalid(`slice ${JSON.stringify(input.title)} is invalid: ${valid.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
		return valid.value;
	});
	const planMarkdown = typeof args.plan_markdown === "string" ? args.plan_markdown : `# Plan\n\n${slices.map((s) => `- ${s.id}: ${s.title}`).join("\n")}\n`;
	const planned = { ...record, revision: record.revision + 1, state: "planned" as const, acceptance_scenarios: scenarios, updated_at: now };
	const validChange = validateRecordOfKind("change", planned);
	if (validChange.ok === false) invalid(`the planned change is invalid: ${validChange.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
	try {
		await writeArtifact(store, changeId, "brief.md", brief.markdown);
		await writeArtifact(store, changeId, "plan.md", planMarkdown);
		for (const slice of slices) await store.put(slice);
		await store.put(planned as never, { ifRevision: record.revision });
	} catch (error) {
		throw asCallerError(error);
	}
	const digestText = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
	return textResult(`Planned change ${changeId} (revision ${planned.revision}, ${slices.length} slice(s)).\n\n${brief.markdown}`, {
		change_id: changeId,
		revision: planned.revision,
		state: planned.state,
		slice_ids: slices.map((s) => s.id),
		brief_digest: digestText(brief.markdown),
		plan_digest: digestText(planMarkdown),
		markdown: brief.markdown,
	});
}

/** `brief.md` / `plan.md` under the change, through the store's own namespace root. */
async function writeArtifact(store: EngineeringStore, changeId: string, name: "brief.md" | "plan.md", text: string): Promise<void> {
	const relative = (name === "brief.md" ? engineeringPaths.brief(changeId) : engineeringPaths.plan(changeId)).replace(/^engineering\//, "");
	const absolute = join(store.root, relative);
	await mkdir(dirname(absolute), { recursive: true });
	await atomicWriteFile(absolute, text);
}

/**
 * Record a proof of a check a HOST ran.
 *
 * The authority is computed from collector and attestation, never read from
 * the payload. A tool call cannot attest to its own execution, so a proof
 * arriving here is caller-reported and discharges nothing under the verified
 * policy — whatever `authority: "observed"` it carries.
 */
async function recordProof(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	const changeId = requireString(args, "change_id");
	const proof = args.proof;
	if (typeof proof !== "object" || proof === null || Array.isArray(proof)) {
		invalid("proof must be an object");
	}
	// Deliberately NOT refused: a payload that declares `authority: "observed"`
	// or `discharges: true` is simply not believed. ingestProof derives both
	// from collector and attestation and strips whatever the payload said.
	// Refusing instead would teach callers to delete the fields and change
	// nothing about what is trusted; the claim must be inert, not forbidden.

	const ingested = await ingestProofSafely(store, {
		...(proof as Record<string, unknown>),
		change_id: changeId,
		// Stated once, here: this transport is caller-reported, so the
		// provenance is overwritten rather than merged. A payload that names
		// itself adapter-attested is making a claim it cannot support.
		provenance: { source: "mcp:tool-call", attested_by: "caller" },
	});
	if (ingested.ok === false) {
		throw new ProtocolError(ProtocolErrorCode.InvalidParams, ingested.errors.map((e) => e.message).join("; "));
	}
	return textResult(`Recorded proof ${ingested.proof.id} (${ingested.proof.result}, authority ${ingested.authority}).`, {
		proof_id: ingested.proof.id,
		result: ingested.proof.result,
		authority: ingested.authority,
		discharges: ingested.discharges,
	});
}

/**
 * The bound candidate of an attempt, or null when the records do not resolve.
 * The gate reports the missing record itself; this only serves the re-read.
 * Resolved through the core's one definition (lifecycle.ts), so this surface
 * re-reads exactly the candidate the gate and the acceptance path judge.
 */
async function candidateOf(store: EngineeringStore, changeId: string, attemptId: string): Promise<SnapshotRecord | null> {
	try {
		const attempt = (await store.get("attempt", attemptId, { changeId })).record as AttemptRecord;
		return await boundCandidate(store, attempt);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// start_attempt / capture_candidate / record_review: the attempt lifecycle.
// The adapter captures every snapshot itself from the server's cwd, through
// the SAME walker the acceptance re-read uses (working-tree.ts). A caller-
// supplied `snapshot` is refused when the adapter can read the tree: the
// contract says it is ignored there, and refusing rather than silently
// ignoring tells the caller its bytes did not become the record.
// ---------------------------------------------------------------------------

/** Fields a caller might use to hand this surface a tree of its choosing. */
const SNAPSHOT_SUPPLY_FIELDS = ["snapshot", "baseline_snapshot", "candidate_snapshot", "manifest", "coverage", "repository"];

/**
 * The capture's scope: the change's and slice's declared exclusions do not
 * exist yet as record fields (a slice's `permitted_scope` says where edits
 * may land, not what the identity omits), so the scope is exactly
 * `ALWAYS_EXCLUDED` plus the exclusions the host configured — none on this
 * surface today. Stated here so the origin of coverage is one line.
 */
function captureScope(): CoverageExclusion[] {
	return [];
}

async function adapterCapture(cwd: string, role: "baseline" | "candidate") {
	const read = await captureWorkingTree(cwd, captureScope());
	if (read.ok === false) throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `the ${role} could not be captured from ${cwd}: ${read.reason}`);
	const { digest: _digest, ...tree } = read.capture;
	void _digest;
	return { source: { attested_by: "adapter" as const, collector: "host-observed" as const, tree }, limitations: read.limitations };
}

function refuseSuppliedSnapshot(args: Record<string, unknown>, action: string): void {
	for (const field of SNAPSHOT_SUPPLY_FIELDS) {
		if (args[field] !== undefined) {
			invalid(`${field} is not accepted by ${action}: this adapter reads the working tree itself and attests the snapshot; a caller-supplied tree would be recorded caller-attested and could never bind an acceptance, so it is refused rather than silently ignored`);
		}
	}
}

async function startAttemptAction(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown, cwd: string) {
	refuseDerivedFields(args, "start_attempt");
	refuseSuppliedSnapshot(args, "start_attempt");
	const changeId = requireString(args, "change_id");
	const sliceId = requireString(args, "slice_id");
	const inputs = args.inputs;
	if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) invalid("inputs must be an object { brief_digest, plan_digest, references }");
	const { brief_digest, plan_digest, references } = inputs as Record<string, unknown>;
	if (typeof brief_digest !== "string" || typeof plan_digest !== "string") invalid("inputs.brief_digest and inputs.plan_digest are required digests of the brief and plan the attempt starts from");
	const baseline = await adapterCapture(cwd, "baseline");
	let started;
	try {
		started = await startAttempt(store, {
			change_id: changeId,
			slice_id: sliceId,
			inputs: { brief_digest, plan_digest, references: Array.isArray(references) ? (references as never) : [] },
			baseline: baseline.source,
			...(typeof args.parent_attempt_id === "string" ? { parent_attempt_id: args.parent_attempt_id } : {}),
			...(typeof args.request_id === "string" ? { idempotency_key: args.request_id } : {}),
		});
	} catch (error) {
		throw asCallerError(error);
	}
	return textResult(`Started attempt ${started.attempt.id} on slice ${sliceId}; baseline ${started.snapshot.id} captured by the adapter (${started.snapshot.manifest.length} entries, ${started.snapshot.stability}).`, {
		change_id: changeId,
		slice_id: sliceId,
		attempt_id: started.attempt.id,
		outcome: started.attempt.outcome,
		baseline_snapshot_id: started.snapshot.id,
		baseline_digest: started.snapshot.digest,
		attested_by: started.snapshot.attested_by,
		stability: started.snapshot.stability,
		input_digest: started.attempt.inputs.digest,
		limitations: baseline.limitations,
	});
}

async function captureCandidateAction(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown, cwd: string) {
	refuseDerivedFields(args, "capture_candidate");
	refuseSuppliedSnapshot(args, "capture_candidate");
	const changeId = requireString(args, "change_id");
	const attemptId = requireString(args, "attempt_id");
	const candidate = await adapterCapture(cwd, "candidate");
	let captured;
	try {
		captured = await captureCandidate(store, { change_id: changeId, attempt_id: attemptId, candidate: candidate.source, ...(typeof args.request_id === "string" ? { idempotency_key: args.request_id } : {}) });
	} catch (error) {
		throw asCallerError(error);
	}
	return textResult(
		`Captured candidate ${captured.snapshot.id} for attempt ${attemptId} (${captured.snapshot.manifest.length} entries, ${captured.snapshot.stability}, attested by the adapter)${captured.superseded_candidate_id ? `; replaces unproved candidate ${captured.superseded_candidate_id}` : ""}. The attempt stays ${captured.attempt.outcome}.`,
		{
			change_id: changeId,
			attempt_id: attemptId,
			outcome: captured.attempt.outcome,
			candidate_snapshot_id: captured.snapshot.id,
			candidate_digest: captured.snapshot.digest,
			attested_by: captured.snapshot.attested_by,
			stability: captured.snapshot.stability,
			...(captured.superseded_candidate_id ? { superseded_candidate_id: captured.superseded_candidate_id } : {}),
			limitations: candidate.limitations,
		},
	);
}

async function recordReviewAction(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	refuseDerivedFields(args, "record_review");
	const changeId = requireString(args, "change_id");
	const attemptId = requireString(args, "attempt_id");
	const review = args.review;
	if (typeof review !== "object" || review === null || Array.isArray(review)) invalid("review must be an object { reviewer, objections, summary }");
	let recorded;
	try {
		recorded = await recordReview(store, { change_id: changeId, attempt_id: attemptId, review: review as Record<string, unknown>, ...(typeof args.request_id === "string" ? { idempotency_key: args.request_id } : {}) });
	} catch (error) {
		throw asCallerError(error);
	}
	return textResult(
		`Recorded review ${recorded.review.id} of candidate ${recorded.review.candidate_snapshot_id} (${recorded.review.remaining_blockers.length} blocker(s) remaining); attempt ${attemptId} is ${recorded.attempt.outcome}${recorded.finalized ? " (finalized by this review; the candidate is now frozen)" : ""}.`,
		{
			change_id: changeId,
			attempt_id: attemptId,
			review_id: recorded.review.id,
			candidate_snapshot_id: recorded.review.candidate_snapshot_id,
			candidate_digest: recorded.review.candidate_digest,
			input_digest: recorded.review.input_digest,
			remaining_blockers: recorded.review.remaining_blockers,
			outcome: recorded.attempt.outcome,
			finalized: recorded.finalized,
		},
	);
}

async function gateChange(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown, cwd: string) {
	const changeId = requireString(args, "change_id");
	const attemptId = typeof args.attempt_id === "string" ? args.attempt_id : undefined;
	// The re-read is what lets the gate check freshness at all; without it the
	// gate can only disclose that the tree was not looked at. A candidate that
	// cannot be re-read gets no re-read, and the gate says so.
	const candidate = attemptId ? await candidateOf(store, changeId, attemptId) : null;
	const reread = candidate ? await readWorkingTree(cwd, candidate) : null;
	const outcome = await evaluateAcceptanceGate(store, {
		change_id: changeId,
		attempt_id: attemptId ?? "",
		// An MCP tool call cannot obtain a human decision on its own. Saying so
		// is the honest answer; E08 introduces the channel that can.
		host: { can_obtain_human_decision: false, storage: { boundary: "none", protection: "unknown" } },
		...(reread?.ok ? { candidate_reread: reread.reread } : {}),
	});
	if (reread && reread.ok === false) outcome.limitations.push(`the working tree could not be re-read: ${reread.reason}`);
	if (reread?.ok) outcome.limitations.push(...reread.limitations);
	return textResult(describeGateOutcome(outcome), {
		change_id: changeId,
		state: outcome.state,
		blockers: outcome.blockers,
		limitations: outcome.limitations,
	});
}

// ---------------------------------------------------------------------------
// request_acceptance (E08): ASK the person through the client. Never grants.
// ---------------------------------------------------------------------------

/**
 * What the server knows about the connected session. Built by server.ts from
 * the SDK's initialize-scoped client capabilities and clientInfo plus host
 * configuration — never from tool arguments.
 */
export interface AcceptanceSession {
	/** Whether the client declared `elicitation.form` at initialize. */
	elicitation_form: boolean;
	client?: { name: string; version?: string };
	/** How this session is named in receipts. */
	host_session?: string;
	/** From host/user-level configuration outside the workspace; defaults to the least-trusted values. */
	storage_boundary: HostCapabilities["storage_boundary"];
	tool_result_path: HostCapabilities["tool_result_path"];
	current_storage: CurrentStorage;
	presenter: Presenter;
	/**
	 * @internal Test seam: the registry to consult instead of the contract's.
	 * Reachable only through {@link buildServer}'s options in server.ts, which
	 * bin.mjs never passes; there is no environment or config path to it.
	 */
	registry?: ReadonlyArray<VerifiedAcceptanceIntegration>;
}

/** The host label this adapter registers under; the registry is keyed by (host, client.name, client.version, channel). */
export const ACCEPTANCE_HOST_LABEL = "mcp-server";

/**
 * Fields that would let a request describe its own host. The contract lists
 * them as unknown-field on every action; they are refused here by name so a
 * caller learns that capability is derived, not declared.
 */
const HOST_CAPABILITY_FIELDS = ["host", "assurance", "assurance_policy", "verified_integration", "storage", "storage_boundary", "attested_by", "tool_result_path", "current_storage", "protection", "human_acceptance", "label", "client", "capabilities", "registry", "approve", "approved", "approval", "receipt", "human_accepted"];

/** HostCapabilities from the session and nothing else. `assurance_policy` is always `verified` (D5). */
export function hostCapabilitiesFromSession(session: AcceptanceSession | undefined): HostCapabilities {
	return {
		human_acceptance: session?.elicitation_form ? "mcp-elicitation" : "none",
		label: ACCEPTANCE_HOST_LABEL,
		...(session?.client ? { client: session.client } : {}),
		// Derived by acceptanceChannelSupported from the registry; declared true
		// here so that function — and only that function — decides.
		verified_integration: true,
		storage_boundary: session?.storage_boundary ?? "none",
		assurance_policy: "verified",
		tool_result_path: session?.tool_result_path ?? "none",
	};
}

async function requestAcceptanceAction(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown, session: AcceptanceSession | undefined, cwd: string) {
	refuseDerivedFields(args, "request_acceptance");
	for (const field of HOST_CAPABILITY_FIELDS) {
		if (args[field] !== undefined) invalid(`unknown field ${field}: host capabilities and decisions are derived from the session and the client, never from a request`);
	}
	const changeId = requireString(args, "change_id");
	const attemptId = requireString(args, "attempt_id");
	const capabilities = hostCapabilitiesFromSession(session);
	let result;
	try {
		result = await requestAcceptance(store, {
			change_id: changeId,
			attempt_id: attemptId,
			capabilities,
			host_session: session?.host_session,
			presenter: session?.presenter ?? { elicit: async () => ({ threw: "no session: nothing can be presented" }) },
			current_storage: session?.current_storage ?? { boundary: "none" },
			registry: session?.registry,
			// The adapter is the only party that can see the repository, so
			// the fresh re-read the gate compares against is taken HERE.
			reread: (candidate) => readWorkingTree(cwd, candidate),
		});
	} catch (error) {
		throw asCallerError(error);
	}
	const structured: Record<string, unknown> = {
		change_id: changeId,
		attempt_id: attemptId,
		outcome: result.outcome,
		assurance: result.assurance,
	};
	if (result.request === undefined) {
		// The gate refused or the tree could not be re-read: no request was
		// issued and nobody was asked. The blockers are the whole answer.
		structured.reason = result.reason;
		if (result.gate) {
			structured.gate_state = result.gate.state;
			structured.blockers = result.gate.blockers;
			structured.limitations = result.gate.limitations;
		}
		return textResult(`${result.outcome}: ${displayText(result.reason.split("\n")[0])} (no request issued; nothing presented).\n\n${result.gate ? describeGateOutcome(result.gate) : ""}`, structured);
	}
	structured.request_id = result.request_id;
	structured.expires_at = result.request.expires_at;
	if (result.outcome === "accepted") {
		structured.approval_id = result.approval.id;
		structured.classification = result.classification.class;
		structured.classification_reasons = result.classification.reasons;
		return textResult(
			`Accepted through ${result.approval.receipt.channel} on ${result.approval.receipt.client.name} ${result.approval.receipt.client.version}: approval ${result.approval.id} (reads as ${result.classification.class}).`,
			structured,
		);
	}
	structured.reason = result.reason;
	if ("elicitation" in result) structured.elicitation = result.elicitation;
	return textResult(`${result.outcome}: ${displayText(result.reason)} (request ${result.request_id} stored; nothing minted).`, structured);
}

// ---------------------------------------------------------------------------
// ingest_observations (E05): read the hook's inbox into proofs. Never protected here.
// ---------------------------------------------------------------------------

/**
 * Ingest the host's hook-written observations for one attempt (E05, #409).
 *
 * `tool_result_path` is host configuration outside the workspace. No such
 * configuration channel reaches this MCP server yet, so this surface passes
 * `unprotected`: every proof it ingests is attested `caller`, is `claimed`,
 * and discharges nothing under `verified`. That is stated in the result. A
 * request field could not change it — a model cannot raise its own
 * capability — so none is read.
 */
const MCP_TOOL_RESULT_PATH = "unprotected" as const;

async function ingestObservations(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	const changeId = requireString(args, "change_id");
	const attemptId = requireString(args, "attempt_id");
	if (Object.hasOwn(args, "tool_result_path") || Object.hasOwn(args, "capabilities")) {
		invalid("tool_result_path is host configuration, not a request field");
	}
	const outcome = await ingestHostObservations(store, { changeId, attemptId, capabilities: { tool_result_path: MCP_TOOL_RESULT_PATH, label: "claude-code" } });
	const summary = `Ingested ${outcome.ingested.length} observation(s) as ${outcome.attested_by} (attested by this surface as caller-reported: no protected tool-result path is configured for MCP, so nothing here discharges under verified); skipped ${outcome.skipped.length}.`;
	return textResult(summary, {
		change_id: changeId,
		attempt_id: attemptId,
		attested_by: outcome.attested_by,
		ingested: outcome.ingested,
		skipped: outcome.skipped.map((s) => ({ file: s.file, reason: s.reason, message: s.message })),
		rotated: outcome.rotated,
	});
}

/** The advertised tool. One entry, one discriminator, marked experimental. */
export const ENGINEERING_TOOLS = [
	{
		name: "codecarto_change",
		description:
			"EXPERIMENTAL. Record and inspect an engineering change: its brief, its plan, the attempt lifecycle (start_attempt captures the baseline, capture_candidate the candidate — both read from the workspace by this server, never supplied by the caller), proofs of checks a host ran, a review bound to the captured candidate (record_review), and the acceptance gate. request_acceptance ASKS the person through the client's own elicitation form; it never grants. This surface records what a host did — it never runs anything, and it cannot approve work.",
		inputSchema: {
			type: "object" as const,
			properties: {
				cwd: { type: "string", description: "Workspace directory." },
				action: { type: "string", enum: [...CHANGE_ACTIONS], description: "The operation to perform." },
				change_id: { type: "string", description: "Change record id, for actions that address one." },
				title: { type: "string", description: "Short change title (create)." },
				outcome: { type: "string", description: "The outcome being requested (create)." },
				revision: { type: "number", description: "Compare-and-swap revision the caller last read (update, plan with slices)." },
				acceptance_scenarios: { type: "array", description: "[{ id, kind: behavior|preserved|non-functional, description }] (plan with slices)." },
				slices: { type: "array", description: "Slices to record (plan): [{ title, deliverable, scenario_ids, proof_obligations: [{ id, scenario_id, check_kind, description, minimum_collector }], permitted_scope: { paths }, depends_on? }]. Omit for a read-only brief." },
				plan_markdown: { type: "string", description: "The plan text stored as plan.md (plan with slices); a listing of the slices when omitted." },
				request_id: { type: "string", description: "Caller-chosen id making create retry-safe." },
				attempt_id: { type: "string", description: "Attempt to capture a candidate for (capture_candidate), review (record_review), evaluate (gate), ask acceptance for (request_acceptance), or ingest host observations for (ingest_observations)." },
				slice_id: { type: "string", description: "Slice the attempt works on (start_attempt)." },
				inputs: { type: "object", description: "{ brief_digest, plan_digest, references } the attempt starts from (start_attempt); the input digest is derived." },
				parent_attempt_id: { type: "string", description: "The attempt this one retries or continues (start_attempt)." },
				proof: { type: "object", description: "A proof of a check the HOST ran (record_proof)." },
				review: { type: "object", description: "{ reviewer, objections, summary } (record_review). The candidate and input digests are bound from the stored attempt, never supplied." },
				mode: { type: "string", enum: ["fix", "feature", "refactor", "migration", "investigation"], description: "Change mode (create); defaults to feature." },
				baseline_commit: { type: "string", description: "Full commit hash the change is based on (create). Without it the baseline is recorded as having no VCS, because HEAD alone never identifies a candidate." },
			},
			required: ["cwd", "action"],
		},
	},
];
