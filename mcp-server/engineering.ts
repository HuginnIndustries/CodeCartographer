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

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import {
	buildChangeBrief,
	describeGateOutcome,
	evaluateAcceptanceGate,
	ingestProof,
	newRecordId,
	openStore,
	type ChangeRecord,
	type EngineeringStore,
	type ProofRecord,
} from "../core/engineering/index.ts";
import { ENGINEERING_SCHEMA_VERSION } from "../core/engineering/types.ts";

/** Every action this surface implements. Pinned so the schema and the dispatch cannot drift. */
export const CHANGE_ACTIONS = ["create", "update", "show", "list", "plan", "record_proof", "gate"] as const;
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
			return new McpError(ErrorCode.InvalidParams, `${message}; use a new request_id or resend the original payload`);
		case "invalid-enum":
		case "invalid-value":
		case "invalid-request":
		case "stale-revision":
			return new McpError(ErrorCode.InvalidParams, message);
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
	throw new McpError(ErrorCode.InvalidParams, message);
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

const DERIVED_FIELDS = ["state", "decision", "authority", "discharges", "revision_token", "approved_by", "accepted_at"];

function refuseDerivedFields(args: Record<string, unknown>, where: string): void {
	for (const field of DERIVED_FIELDS) {
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
}) {
	return async function handleChange(args: ChangeArgs) {
		const action = args.action;
		if (typeof action !== "string" || action.length === 0) {
			invalid(`action is required; one of ${CHANGE_ACTIONS.join(", ")}`);
		}
		if (Object.hasOwn(REFUSED_ACTIONS, action)) {
			throw new McpError(ErrorCode.InvalidParams, `${action} is not available through this surface: ${REFUSED_ACTIONS[action]}`);
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
			case "record_proof":
				return await recordProof(store, args, deps.textResult);
			case "gate":
				return await gateChange(store, args, deps.textResult);
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
		throw new McpError(
			ErrorCode.InvalidRequest,
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
		throw new McpError(
			ErrorCode.InvalidParams,
			`update requires the revision you last read (change ${changeId} is at revision ${record.revision}), ` +
				`so a concurrent writer's work cannot be overwritten silently`,
		);
	}
	if (typeof revision !== "number" || !Number.isInteger(revision)) {
		throw new McpError(ErrorCode.InvalidParams, `revision must be an integer, got ${JSON.stringify(revision)}`);
	}
	if (revision !== record.revision) {
		throw new McpError(
			ErrorCode.InvalidParams,
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

async function planChange(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	const changeId = requireString(args, "change_id");
	const found = await store.get("change", changeId);
	const record = found.record as ChangeRecord;
	const brief = buildChangeBrief({
		title: record.title,
		mode: record.mode,
		requested_outcome: record.requested_outcome,
		baseline: { vcs: "git", description: record.baseline.description },
		scope: record.scope,
		preserved_contracts: record.preserved_contracts,
		acceptance_scenarios: record.acceptance_scenarios,
		references: record.references,
	});
	if (!brief.ok || !brief.markdown) {
		throw new McpError(
			ErrorCode.InvalidParams,
			`this change cannot be planned yet: ${(brief.errors ?? []).map((e) => e.message).join("; ") || "the brief could not be built"}`,
		);
	}
	return textResult(brief.markdown, { change_id: changeId, markdown: brief.markdown });
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
		throw new McpError(ErrorCode.InvalidParams, ingested.errors.map((e) => e.message).join("; "));
	}
	return textResult(`Recorded proof ${ingested.proof.id} (${ingested.proof.result}, authority ${ingested.authority}).`, {
		proof_id: ingested.proof.id,
		result: ingested.proof.result,
		authority: ingested.authority,
		discharges: ingested.discharges,
	});
}

async function gateChange(store: EngineeringStore, args: ChangeArgs, textResult: (t: string, s?: Record<string, unknown>) => unknown) {
	const changeId = requireString(args, "change_id");
	const attemptId = typeof args.attempt_id === "string" ? args.attempt_id : undefined;
	const outcome = await evaluateAcceptanceGate(store, {
		change_id: changeId,
		attempt_id: attemptId ?? "",
		// An MCP tool call cannot obtain a human decision on its own. Saying so
		// is the honest answer; E08 introduces the channel that can.
		host: { can_obtain_human_decision: false, storage: { boundary: "none", protection: "unknown" } },
	});
	return textResult(describeGateOutcome(outcome), {
		change_id: changeId,
		state: outcome.state,
		blockers: outcome.blockers,
		limitations: outcome.limitations,
	});
}

/** The advertised tool. One entry, one discriminator, marked experimental. */
export const ENGINEERING_TOOLS = [
	{
		name: "codecarto_change",
		description:
			"EXPERIMENTAL. Record and inspect an engineering change: its brief, its plan, proofs of checks a host ran, and the acceptance gate. This surface records what a host did — it never runs anything, and it cannot approve work.",
		inputSchema: {
			type: "object" as const,
			properties: {
				cwd: { type: "string", description: "Workspace directory." },
				action: { type: "string", enum: [...CHANGE_ACTIONS], description: "The operation to perform." },
				change_id: { type: "string", description: "Change record id, for actions that address one." },
				title: { type: "string", description: "Short change title (create)." },
				outcome: { type: "string", description: "The outcome being requested (create)." },
				revision: { type: "number", description: "Compare-and-swap revision the caller last read (update)." },
				request_id: { type: "string", description: "Caller-chosen id making create retry-safe." },
				attempt_id: { type: "string", description: "Attempt to evaluate (gate)." },
				proof: { type: "object", description: "A proof of a check the HOST ran (record_proof)." },
				mode: { type: "string", enum: ["fix", "feature", "refactor", "migration", "investigation"], description: "Change mode (create); defaults to feature." },
				baseline_commit: { type: "string", description: "Full commit hash the change is based on (create). Without it the baseline is recorded as having no VCS, because HEAD alone never identifies a candidate." },
			},
			required: ["cwd", "action"],
		},
	},
];
