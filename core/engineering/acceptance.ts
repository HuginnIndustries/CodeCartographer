// The acceptance adapter: asking a person, through the host, for a decision.
//
// This is the one place in the engineering layer where a human decision is
// obtained. The rules it follows are the contract's
// (docs/engineering/record-contract.md § The receipt path, § Acceptance
// channel: a conditional pilot policy, D1 live check), and every rule that can
// be enforced by a pure core function IS enforced by that function rather than
// re-implemented here:
//
//   - `acceptanceChannelSupported` decides whether a decision may be asked for
//     at all (trusted channel AND a registry entry at the exact live client
//     version). The registry is empty today, so every host stops at
//     `needs-human-acceptance` and nothing is presented.
//   - `elicitationDecision` reads the decision from `content.decision` only.
//     `action: accept` alone never authorizes (the D1 live check produced
//     accept/reject from one dialog).
//   - `evaluateApprovalReceipt` checks a minted approval against the stored
//     request BEFORE it is persisted; a stale or mismatched receipt is refused
//     and nothing is written.
//   - `classifyAcceptance` says how the result may be read now; on every host
//     investigated so far that is `cooperative` (D3).
//
// The decision NEVER comes from a tool argument or from the model. The only
// input this module accepts from the client is the elicitation response the
// transport delivered, and the only input it accepts from the host is the
// `HostCapabilities` the adapter derived from the transport and host
// configuration. Nothing here is a request field.
//
// Protocol note: `presenter` is the 2025-era server-initiated
// `elicitation/create` leg. The 2026-07-28 revision replaces it with a
// multi-round-trip `InputRequiredResult`; that path is not implemented and is
// where an MRTR presenter would plug in later, behind the same `Presenter`
// seam.

import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../utils.ts";
import { engineeringPaths, newNonce, newRecordId } from "./ids.ts";
import type { EngineeringStore } from "./store.ts";
import { StoreError } from "./store.ts";
import {
	ACCEPTANCE_REQUEST_MAX_TTL_MS,
	ENGINEERING_SCHEMA_VERSION,
	JSONRPC_REQUEST_TIMEOUT_CODE,
	VERIFIED_ACCEPTANCE_INTEGRATIONS,
	type AcceptanceClass,
	type AcceptanceRequest,
	type ApprovalRecord,
	type AttemptRecord,
	type ChangeRecord,
	type CurrentStorage,
	type ElicitationOutcome,
	type ElicitationResponse,
	type HostCapabilities,
	type ProofRecord,
	type ReviewRecord,
	type SliceRecord,
	type SnapshotRecord,
	type VerifiedAcceptanceIntegration,
} from "./types.ts";
import {
	acceptanceChannelSupported,
	buildAcceptanceRequest,
	classifyAcceptance,
	elicitationDecision,
	evaluateApprovalReceipt,
	validateAcceptanceRequest,
	validateRecordOfKind,
} from "./validation.ts";

/** The form the client is asked to show. Only the decision plus an optional note; nothing else is a field. */
export interface AcceptanceForm {
	message: string;
	requestedSchema: {
		type: "object";
		properties: {
			decision: { type: "string"; title: string; description: string; enum: ["accept", "reject"] };
			note: { type: "string"; title: string; description: string };
		};
		required: ["decision"];
	};
}

/**
 * What the host adapter gives this module to reach the person. `elicit`
 * sends the form through the client and returns the client's answer AS THE
 * TRANSPORT DELIVERED IT, or the error it threw (with the structured JSON-RPC
 * code when there is one). Nothing the model supplies passes through it.
 */
export interface Presenter {
	elicit(form: AcceptanceForm, options: { timeoutMs: number }): Promise<ElicitationResponse>;
}

export interface RequestAcceptanceArgs {
	change_id: string;
	attempt_id: string;
	/** Derived by the adapter from the transport and host configuration; never from the request. */
	capabilities: HostCapabilities;
	/** How this host session is named in the receipt, e.g. `stdio session 1`. */
	host_session?: string;
	presenter: Presenter;
	/** The reader's out-of-namespace account of the storage boundary, for `classifyAcceptance`. */
	current_storage: CurrentStorage;
	/** Test seam only: the registry to consult. Production callers never pass this (@internal). */
	registry?: ReadonlyArray<VerifiedAcceptanceIntegration>;
	/** Test seam only: the clock (@internal). */
	now?: () => Date;
}

export type RequestAcceptanceResult =
	| { outcome: "needs-human-acceptance"; assurance: "verified" | "cooperative"; request_id: string; request: AcceptanceRequest; reason: string }
	| { outcome: "accepted"; assurance: "verified" | "cooperative"; request_id: string; request: AcceptanceRequest; approval: ApprovalRecord; classification: { class: AcceptanceClass; reasons: string[] } }
	| { outcome: "rejected" | "declined" | "cancelled" | "timed-out" | "invalid" | "refused"; assurance: "verified" | "cooperative"; request_id: string; request: AcceptanceRequest; reason: string; elicitation: ElicitationOutcome };

/**
 * Default TTL for a request presented through elicitation. The client's
 * observed request timeout on the D1 pair was ~150 s; the TTL must be strictly
 * below the registered `client_request_timeout_ms`, so the request is minted
 * at min(this, timeout − margin) and `checkAcceptanceRequestTtl` (inside
 * `classifyAcceptance`) confirms it. For an unsupported host the request is
 * stored for a later supported host, bounded by the contract maximum.
 */
const ELICITATION_TTL_MS = 120_000;
const TTL_MARGIN_MS = 5_000;

/** The attestation text every receipt this adapter mints carries. Discloses what was and was not verified (D1 (c)). */
function attestationText(client: { name: string; version: string }): string {
	return (
		`The connected MCP client (${client.name} ${client.version}) answered elicitation/create in the session that issued the request. ` +
		"The client's own consent UI is trusted to have shown the presentation; the adapter cannot verify that a person, rather than an auto-answering hook, filled the form, " +
		"and relies on the operator's attestation that no Elicitation or ElicitationResult hooks are configured. The person's identity was not authenticated."
	);
}

/** The presentation, rendered for the form. The Decision field is named explicitly (D1 UI note: the first free-text field swallowed a typed answer). */
export function renderAcceptanceMessage(request: AcceptanceRequest): string {
	const p = request.presentation;
	const lines = [
		`Accept or reject this candidate? Set the required "Decision" field to accept or reject; typing a decision into the note does not count.`,
		``,
		`Change: ${p.title}`,
		`Requested outcome: ${p.requested_outcome}`,
		`Slice deliverable: ${p.slice_deliverable}`,
		`Candidate: ${p.candidate_summary}`,
		`Assurance policy: ${p.assurance}`,
		`Proofs: ${p.proof_summary.length === 0 ? "none" : p.proof_summary.map((s) => `${s.obligation_id} ${s.result} (${s.collector}, ${s.attested_by}, ${s.authority})`).join("; ")}`,
		`Reviews: ${p.review_summary.length === 0 ? "none" : p.review_summary.map((r) => `${r.review_id} ${r.separation}, ${r.remaining_blockers} blockers remaining`).join("; ")}`,
		`Limitations:`,
		...p.limitations.map((l) => `- ${l}`),
		``,
		`Request ${request.id}, nonce ${request.nonce}, expires ${request.expires_at}.`,
	];
	return lines.join("\n");
}

export function buildAcceptanceForm(request: AcceptanceRequest): AcceptanceForm {
	return {
		message: renderAcceptanceMessage(request),
		requestedSchema: {
			type: "object",
			properties: {
				decision: { type: "string", title: "Decision", description: "Required. accept or reject this candidate.", enum: ["accept", "reject"] },
				note: { type: "string", title: "Note", description: "Optional. Recorded verbatim; a decision typed here is not a decision." },
			},
			required: ["decision"],
		},
	};
}

async function readRecord<T>(store: EngineeringStore, kind: "change" | "slice" | "attempt" | "snapshot" | "proof" | "review" | "approval", id: string, context: Record<string, string>): Promise<T> {
	return (await store.get(kind, id, context)).record as unknown as T;
}

async function listIds(store: EngineeringStore, changeId: string, attemptId: string, directory: "proofs" | "reviews" | "approvals" | "requests"): Promise<string[]> {
	try {
		const entries = await readdir(join(store.root, "changes", changeId, "attempts", attemptId, directory));
		return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
	} catch {
		return [];
	}
}

/** Persist the request under the attempt's `requests/` before anything is shown (receipt path step 2). */
async function persistRequest(store: EngineeringStore, request: AcceptanceRequest): Promise<void> {
	const valid = validateAcceptanceRequest(request);
	if (valid.ok === false) throw new StoreError(valid.errors[0].code, `acceptance request failed validation: ${valid.errors[0].message}`);
	const relative = engineeringPaths.acceptanceRequest(request.change_id, request.attempt_id, request.id).replace(/^engineering\//, "");
	const absolute = join(store.root, relative);
	await mkdir(dirname(absolute), { recursive: true });
	await atomicWriteFile(absolute, `${JSON.stringify(request, null, "\t")}\n`);
}

/** Read the stored copy of a request; the receipt is checked against what is on disk, not the in-memory object. */
export async function readStoredRequest(store: EngineeringStore, changeId: string, attemptId: string, requestId: string): Promise<AcceptanceRequest | null> {
	const relative = engineeringPaths.acceptanceRequest(changeId, attemptId, requestId).replace(/^engineering\//, "");
	try {
		const parsed = JSON.parse(await readFile(join(store.root, relative), "utf8")) as unknown;
		const valid = validateAcceptanceRequest(parsed);
		return valid.ok ? valid.value : null;
	} catch {
		return null;
	}
}

/**
 * Ask the host for a decision on an attempt's bound candidate.
 *
 * Order (the contract's receipt path): load and bind the records; build the
 * request and store it durably; consult `acceptanceChannelSupported`; only on
 * a supported integration present the form; map the answer with
 * `elicitationDecision`; only for `accepted` mint an approval, run
 * `evaluateApprovalReceipt` against the STORED request and the other
 * approvals' nonces, and persist only when it passes.
 */
export async function requestAcceptance(store: EngineeringStore, args: RequestAcceptanceArgs): Promise<RequestAcceptanceResult> {
	const now = args.now ?? (() => new Date());
	const capabilities = args.capabilities;
	const assurance = capabilities.assurance_policy;

	const change = await readRecord<ChangeRecord>(store, "change", args.change_id, {});
	const attempt = await readRecord<AttemptRecord>(store, "attempt", args.attempt_id, { changeId: change.id });
	if (attempt.change_id !== change.id) throw new StoreError("cross-change-reference", `attempt ${attempt.id} belongs to ${attempt.change_id}, not ${change.id}`);
	const slice = await readRecord<SliceRecord>(store, "slice", attempt.slice_id, { changeId: change.id });
	if (!attempt.candidate_snapshot_id) throw new StoreError("invalid-state", `attempt ${attempt.id} has no bound candidate snapshot; capture one before asking for acceptance`);
	if (attempt.outcome !== "ready-for-review" && attempt.outcome !== "needs-human-acceptance") {
		throw new StoreError("invalid-state", `attempt ${attempt.id} is ${attempt.outcome}; acceptance can be asked for only from ready-for-review or needs-human-acceptance`);
	}
	const candidate = await readRecord<SnapshotRecord>(store, "snapshot", attempt.candidate_snapshot_id, { changeId: change.id, attemptId: attempt.id });
	const context = { changeId: change.id, attemptId: attempt.id };
	const proofs: ProofRecord[] = [];
	for (const id of await listIds(store, change.id, attempt.id, "proofs")) proofs.push(await readRecord<ProofRecord>(store, "proof", id, context));
	const reviews: ReviewRecord[] = [];
	for (const id of await listIds(store, change.id, attempt.id, "reviews")) reviews.push(await readRecord<ReviewRecord>(store, "review", id, context));
	const otherApprovals: ApprovalRecord[] = [];
	for (const id of await listIds(store, change.id, attempt.id, "approvals")) otherApprovals.push(await readRecord<ApprovalRecord>(store, "approval", id, context));

	// Channel decision first, because it bounds the TTL: a request that will be
	// presented must expire before the client gives up, one that will only be
	// stored for a later host may live up to the contract maximum.
	let support = acceptanceChannelSupported(capabilities, args.registry);
	const issued = now();
	// The TTL must be strictly below the client's observed request timeout
	// (checkAcceptanceRequestTtl enforces it again at read time); a client
	// whose timeout leaves no usable window cannot be asked.
	const clientTimeout = support.supported ? support.integration.client_request_timeout_ms : undefined;
	if (support.supported && (typeof clientTimeout !== "number" || !Number.isFinite(clientTimeout) || clientTimeout - TTL_MARGIN_MS <= 0)) {
		support = { supported: false, reason: `the registered integration's client_request_timeout_ms (${String(clientTimeout)}) leaves no usable window for a request; the client cannot be asked` };
	}
	const ttl = support.supported ? Math.min(ELICITATION_TTL_MS, (clientTimeout as number) - TTL_MARGIN_MS) : ACCEPTANCE_REQUEST_MAX_TTL_MS;
	const request = buildAcceptanceRequest({
		id: newRecordId("acceptance-request"),
		nonce: newNonce(),
		issued_at: issued.toISOString(),
		expires_at: new Date(issued.getTime() + ttl).toISOString(),
		change,
		slice,
		attempt,
		candidate,
		proofs,
		reviews,
		assurance,
		storage_boundary: capabilities.storage_boundary,
		limitations: [],
	});
	await persistRequest(store, request);
	const base = { assurance, request_id: request.id, request };

	if (support.supported === false) {
		// The attempt record itself is create-only in the store (an observation
		// is never rewritten), so the state is carried by the stored request
		// and this result rather than by editing attempt.json.
		return { outcome: "needs-human-acceptance", ...base, reason: support.reason };
	}

	// SUPPORTED: present through the client. The TTL doubles as the request
	// timeout so the server-side error is deterministic (D1 timeout finding).
	const response = await args.presenter.elicit(buildAcceptanceForm(request), { timeoutMs: ttl });
	const responded = now();
	const decision = elicitationDecision(response);
	if (decision !== "accepted") {
		const reason =
			decision === "rejected"
				? "the person rejected the candidate"
				: decision === "declined"
					? "the prompt was dismissed; not a decision"
					: decision === "cancelled"
						? "the prompt was cancelled; not a decision"
						: decision === "timed-out"
							? `no answer arrived before the request timed out (JSON-RPC ${JSONRPC_REQUEST_TIMEOUT_CODE})`
							: "the form came back without a recognizable decision in content.decision; action alone never authorizes";
		return { outcome: decision, ...base, reason, elicitation: decision };
	}

	// ACCEPTED: mint in-process from the request and the host's own state,
	// never from the response beyond its decision and note.
	const client = { name: capabilities.client?.name ?? "unknown", version: capabilities.client?.version ?? "" };
	const note = "content" in response && response.content && typeof (response.content as { note?: unknown }).note === "string" && ((response.content as { note: string }).note.trim().length > 0)
		? (response.content as { note: string }).note
		: undefined;
	const approval: ApprovalRecord = {
		schema_version: ENGINEERING_SCHEMA_VERSION,
		kind: "approval",
		id: newRecordId("approval"),
		created_at: responded.toISOString(),
		change_id: change.id,
		slice_id: slice.id,
		attempt_id: attempt.id,
		candidate_snapshot_id: candidate.id,
		candidate_digest: candidate.digest,
		input_digest: attempt.inputs.digest,
		decision: "accepted",
		decided_at: responded.toISOString(),
		receipt: {
			request_id: request.id,
			nonce: request.nonce,
			presentation_digest: request.presentation_digest,
			channel: support.channel,
			host: capabilities.label ?? "mcp-server",
			client,
			...(args.host_session ? { host_session: args.host_session } : {}),
			issued_at: request.issued_at,
			responded_at: responded.toISOString(),
			authenticated: "host-session",
			verified_integration: capabilities.verified_integration,
			attestation: attestationText(client),
		},
		// `verified` is a claim about the whole path; over an unprotected
		// namespace the record must say cooperative (the validator refuses
		// otherwise). The reading is re-derived below by classifyAcceptance.
		assurance: assurance === "verified" && capabilities.storage_boundary === "host-enforced" && capabilities.verified_integration ? "verified" : "cooperative",
		storage: {
			boundary: capabilities.storage_boundary,
			note: capabilities.storage_boundary === "host-enforced" ? "the host's permission layer denies agent writes under .codecarto/engineering/ (declared by host configuration)" : "no host-enforced boundary is declared for .codecarto/engineering/; agent tools can rewrite this record",
		},
		...(note ? { human_note: note } : {}),
	};

	// The receipt is checked against the STORED request — the bytes a later
	// reader will check against — and the nonces of the other approvals,
	// BEFORE anything is written. A stale answer (past expires_at) or a
	// mismatch is refused here and nothing is minted.
	const stored = await readStoredRequest(store, change.id, attempt.id, request.id);
	const receipt = evaluateApprovalReceipt(approval, {
		request: stored ?? undefined,
		consumed_nonces: otherApprovals.map((a) => a.receipt.nonce),
		attempt,
		candidate,
	});
	if (receipt.ok === false) {
		return {
			outcome: "refused",
			...base,
			reason: `the client's answer did not bind to the issued request: ${receipt.errors.map((e) => `${e.code} at ${e.path}`).join("; ")}`,
			elicitation: decision,
		};
	}
	const shape = validateRecordOfKind("approval", approval);
	if (shape.ok === false) throw new StoreError(shape.errors[0].code, `minted approval failed validation: ${shape.errors[0].message}`);
	await store.put(approval);
	const classification = classifyAcceptance(approval, {
		request: stored ?? undefined,
		consumed_nonces: otherApprovals.map((a) => a.receipt.nonce),
		attempt,
		candidate,
		current_storage: args.current_storage,
		integrations: args.registry ?? VERIFIED_ACCEPTANCE_INTEGRATIONS,
		proofs,
		reviews,
	});
	return { outcome: "accepted", ...base, approval, classification };
}
