// Engineering records: the frozen v1 contract (E01, #399).
//
// This module is the schema. Every field, enum spelling, ID prefix, and
// invariant that a downstream issue (E02–E08) consumes is declared here and
// enforced by ./validation.ts; the prose in docs/engineering/record-contract.md
// describes the same contract and must not disagree with it. A change to any
// of these shapes is a contract amendment: bump nothing silently, add a
// fixture under tests/fixtures/engineering/v1/, and update the document.
//
// Scope of this module: data. Nothing here reads a file, runs a command, or
// talks to a host. The vocabulary:
//
//   change    one requested outcome against one baseline; mutable projection
//   slice     one reviewable deliverable of a change, with proof obligations
//   attempt   one implementation candidate; immutable once it leaves `running`
//   snapshot  the identity of a working tree (baseline or candidate)
//   proof     one observed check bound to a snapshot; never a bare claim
//   review    one author-separated read of a candidate, with objections
//   approval  one human decision, bound to exactly what was presented
//
// Trust levels stay distinct on purpose: an agent claim, a deterministic
// structural check, an observed execution result, an independent review, and
// an authorized human acceptance are five different things, and no field here
// lets one be spelled as another.

/** The only schema version this validator accepts. Any other value is `unsupported-schema-version`. */
export const ENGINEERING_SCHEMA_VERSION = 1 as const;

export const RECORD_KINDS = ["change", "slice", "attempt", "snapshot", "proof", "review", "approval"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/**
 * Prefix per identified thing. Record IDs are `<prefix>_<24 lowercase hex>`:
 * opaque, path-safe, and self-describing, so a `change_id` that does not start
 * with `chg_` is rejected before any lookup. Artifacts and acceptance requests
 * are identified the same way without being records of their own.
 */
export const RECORD_ID_PREFIXES = {
	change: "chg",
	slice: "slc",
	attempt: "att",
	snapshot: "snp",
	proof: "prf",
	review: "rvw",
	approval: "apr",
	artifact: "art",
	"acceptance-request": "acr",
} as const;
export type IdentifiedKind = keyof typeof RECORD_ID_PREFIXES;

/** `chg_0123456789abcdef01234567` — see {@link RECORD_ID_PREFIXES}. */
export type RecordId = string;
/** `sha256:<64 lowercase hex>`. The only digest algorithm in v1. */
export type Digest = string;
/** RFC 3339 UTC instant with a trailing `Z`; fractional seconds optional. */
export type Timestamp = string;
/** A repository-relative POSIX path: no leading `/`, no `.`/`..` segments, no backslash, no control characters. */
export type RepoRelativePath = string;
/** A {@link RepoRelativePath} that may also contain `*` and `**` segments. */
export type ScopePattern = string;
/** A change-local identifier for scenarios, obligations, and objections: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Display-safe, never a path. */
export type LocalId = string;

export const CHANGE_MODES = ["fix", "feature", "refactor", "migration", "investigation"] as const;
export type ChangeMode = (typeof CHANGE_MODES)[number];

export const CHANGE_STATES = ["draft", "planned", "active", "blocked", "accepted", "abandoned"] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

export const SLICE_STATES = ["pending", "active", "blocked", "accepted", "abandoned"] as const;
export type SliceState = (typeof SLICE_STATES)[number];

export const ATTEMPT_OUTCOMES = ["running", "failed", "blocked", "ready-for-review", "needs-human-acceptance", "accepted", "superseded"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Attempt outcomes that require a candidate snapshot to be bound. */
export const ATTEMPT_OUTCOMES_REQUIRING_CANDIDATE: readonly AttemptOutcome[] = ["ready-for-review", "needs-human-acceptance", "accepted"];

/**
 * Who observed a result. `agent-claimed` is a legal record so that a claim can
 * be kept and later contradicted, but it satisfies no proof obligation; see
 * {@link OBSERVED_COLLECTORS}.
 */
export const COLLECTORS = ["host-observed", "ci-reported", "manual-observation", "agent-claimed"] as const;
export type Collector = (typeof COLLECTORS)[number];
export const OBSERVED_COLLECTORS: readonly Collector[] = ["host-observed", "ci-reported", "manual-observation"];
/**
 * How strongly a collector binds a result to the exact candidate: a host
 * observes the snapshot it just captured; CI observes a remote copy tied back
 * by `run_reference`; a person follows a procedure. A proof satisfies an
 * obligation when its collector's rank is at least the obligation's
 * `minimum_collector` rank; `agent-claimed` ranks 0 and satisfies nothing.
 */
export const COLLECTOR_RANK: Readonly<Record<Collector, number>> = { "host-observed": 3, "ci-reported": 2, "manual-observation": 1, "agent-claimed": 0 };

export const CHECK_KINDS = ["test", "build", "lint", "typecheck", "run", "manual-procedure", "other"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** `blocked` is a missing environment, permission, input, or acceptance; `failed` is a completed check that failed. */
export const PROOF_RESULTS = ["passed", "failed", "blocked"] as const;
export type ProofResult = (typeof PROOF_RESULTS)[number];

export const SNAPSHOT_ROLES = ["baseline", "candidate"] as const;
export type SnapshotRole = (typeof SNAPSHOT_ROLES)[number];

export const SNAPSHOT_STABILITIES = ["stable", "unstable"] as const;
export type SnapshotStability = (typeof SNAPSHOT_STABILITIES)[number];

export const VCS_KINDS = ["git", "none"] as const;
export type VcsKind = (typeof VCS_KINDS)[number];

export const EXCLUSION_REASONS = ["engineering-namespace", "generated", "ignored", "secret", "host-declared"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const SCENARIO_KINDS = ["behavior", "preserved", "non-functional"] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

/**
 * Where the reviewer's context stands relative to the author's. This is a
 * declaration the framework records; it is not authenticated. `same-context`
 * is legal to record and cannot satisfy the independent-review requirement.
 */
export const REVIEWER_SEPARATIONS = ["declared-separate", "same-context"] as const;
export type ReviewerSeparation = (typeof REVIEWER_SEPARATIONS)[number];

export const REVIEWER_CONTEXTS = ["separate-session", "separate-agent", "human", "same-session"] as const;
export type ReviewerContext = (typeof REVIEWER_CONTEXTS)[number];

export const OBJECTION_SEVERITIES = ["blocking", "advisory"] as const;
export type ObjectionSeverity = (typeof OBJECTION_SEVERITIES)[number];

/** `deferred` keeps a blocking objection blocking; only `resolved` (with evidence) or `withdrawn` clears it. */
export const OBJECTION_DISPOSITIONS = ["open", "resolved", "withdrawn", "deferred"] as const;
export type ObjectionDisposition = (typeof OBJECTION_DISPOSITIONS)[number];

export const APPROVAL_DECISIONS = ["accepted", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * How a human decision reached the core.
 *
 * - `mcp-elicitation`: the MCP server sent `elicitation/create` to the
 *   connected client and the client — not the model — answered over the
 *   transport. The model's tool arguments never carry the decision.
 * - `host-native`: an in-process host UI (Pi's `ctx.ui.confirm`, or an
 *   equivalent adapter) asked the user and the adapter minted the record.
 * - `cooperative-file`: a person wrote or edited the record on disk. Useful
 *   as a cooperative note; nobody is authenticated and it is never acceptance.
 * - `agent-declared`: the decision text came from a model-authored payload.
 *   Recorded only so that the attempt can be refused with a precise reason.
 */
export const APPROVAL_CHANNELS = ["mcp-elicitation", "host-native", "cooperative-file", "agent-declared"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number];
/** The channels whose receipt may satisfy the human-acceptance gate in v1. */
export const TRUSTED_APPROVAL_CHANNELS: readonly ApprovalChannel[] = ["mcp-elicitation", "host-native"];

/**
 * What the adapter actually authenticated. `host-session` means only that the
 * response arrived through the same host session that issued the request; it
 * is not a person's identity. v1 has no `user-identity` value on purpose.
 */
export const RECEIPT_AUTHENTICATIONS = ["none", "host-session"] as const;
export type ReceiptAuthentication = (typeof RECEIPT_AUTHENTICATIONS)[number];

/** How a host can obtain a human decision; declared per request by the adapter, never by the model. */
export const HUMAN_ACCEPTANCE_CAPABILITIES = ["mcp-elicitation", "host-native", "none"] as const;
export type HumanAcceptanceCapability = (typeof HUMAN_ACCEPTANCE_CAPABILITIES)[number];

// ---------- shared envelope ----------

export interface RecordEnvelope<K extends RecordKind> {
	schema_version: typeof ENGINEERING_SCHEMA_VERSION;
	kind: K;
	id: RecordId;
	created_at: Timestamp;
}

/** A library entry a change deliberately consumes. Zero references is the ordinary case. */
export interface ReferenceBinding {
	/** Library entry slug as published. */
	id: string;
	/** Exact confirmed version; never a range. */
	version: string;
	/** Digest of the reference bytes as read at planning time. */
	digest: Digest;
}

export interface BaselineReference {
	vcs: VcsKind;
	/** Required when `vcs` is `git`: the full commit hash. HEAD alone never identifies a candidate — see {@link SnapshotRecord}. */
	head?: string;
	description?: string;
}

// ---------- change ----------

export interface AcceptanceScenario {
	id: LocalId;
	kind: ScenarioKind;
	description: string;
}

export interface ChangeRecord extends RecordEnvelope<"change"> {
	/** Compare-and-swap revision; starts at 1 and increments on every projection update. */
	revision: number;
	title: string;
	mode: ChangeMode;
	state: ChangeState;
	requested_outcome: string;
	baseline: BaselineReference;
	scope: {
		in_scope: string[];
		non_goals: string[];
	};
	preserved_contracts: string[];
	/** Unique `id`s within the change. Non-empty once the change leaves `draft`. */
	acceptance_scenarios: AcceptanceScenario[];
	references: ReferenceBinding[];
	/** Required exactly when `state` is `blocked`. */
	block_reason?: string;
	updated_at: Timestamp;
}

// ---------- slice ----------

export interface ProofObligation {
	id: LocalId;
	/** Must name one of the change's acceptance scenarios and one of the slice's `scenario_ids`. */
	scenario_id: LocalId;
	check_kind: CheckKind;
	description: string;
	/** The weakest collector that may discharge this obligation; never `agent-claimed`. */
	minimum_collector: Exclude<Collector, "agent-claimed">;
}

export interface SliceRecord extends RecordEnvelope<"slice"> {
	change_id: RecordId;
	revision: number;
	title: string;
	deliverable: string;
	/** Non-empty and unique: a slice that proves nothing is invalid planning. */
	scenario_ids: LocalId[];
	/** Other slices of the same change; never itself. */
	depends_on: RecordId[];
	/** Non-empty and unique `id`s. */
	proof_obligations: ProofObligation[];
	permitted_scope: {
		paths: ScopePattern[];
		description?: string;
	};
	state: SliceState;
	block_reason?: string;
	updated_at: Timestamp;
}

// ---------- attempt ----------

/**
 * The input identity of an attempt. `digest` is the canonical digest of
 * `{ brief_digest, plan_digest, references }` — see ./digest.ts — and the
 * validator recomputes it. Changing the brief, the plan, or a selected
 * reference's bytes therefore changes the identity that proof, review, and
 * approval bind to.
 */
export interface AttemptInputs {
	brief_digest: Digest;
	plan_digest: Digest;
	/** Sorted by `id` then `version`, byte order; no duplicates. */
	references: ReferenceBinding[];
	digest: Digest;
}

export interface AttemptRecord extends RecordEnvelope<"attempt"> {
	change_id: RecordId;
	slice_id: RecordId;
	inputs: AttemptInputs;
	baseline_snapshot_id: RecordId;
	/** Required for `ready-for-review`, `needs-human-acceptance`, and `accepted`. */
	candidate_snapshot_id?: RecordId;
	outcome: AttemptOutcome;
	started_at: Timestamp;
	/** Present exactly when `outcome` is not `running`. */
	ended_at?: Timestamp;
	/** The attempt this one resumed or retried from. */
	parent_attempt_id?: RecordId;
	/** The earlier attempt whose observation this record corrects; the earlier record is never rewritten. */
	supersedes_attempt_id?: RecordId;
	/** Required exactly when `outcome` is `superseded`. */
	superseded_by_attempt_id?: RecordId;
	/** Required exactly when `outcome` is `blocked`. */
	block_reason?: string;
	failure_summary?: string;
}

// ---------- snapshot ----------

export type ManifestEntry =
	| {
			path: RepoRelativePath;
			type: "file";
			digest: Digest;
			executable: boolean;
			size: number;
	  }
	| {
			path: RepoRelativePath;
			type: "symlink";
			/** The link text as stored, never dereferenced. */
			target: string;
	  };

export interface CoverageExclusion {
	pattern: ScopePattern;
	reason: ExclusionReason;
}

/**
 * The identity of a working tree. `digest` is the canonical digest of
 * `{ coverage, manifest, repository }` and the validator recomputes it.
 * Identity is not correctness: a digest says which bytes were observed, not
 * that they work.
 */
export interface SnapshotRecord extends RecordEnvelope<"snapshot"> {
	change_id: RecordId;
	attempt_id: RecordId;
	role: SnapshotRole;
	repository: {
		vcs: VcsKind;
		head?: string;
		/** Whether tracked content differed from `head` when captured. */
		dirty: boolean;
	};
	/** Strictly ascending by `path` in UTF-8 byte order; no duplicates. */
	manifest: ManifestEntry[];
	coverage: {
		excluded: CoverageExclusion[];
		/** Relevant inputs the collector could not read or chose not to fingerprint. Non-empty means revalidate or block, never assume. */
		uncovered_relevant_inputs: RepoRelativePath[];
	};
	/** `unstable` when the tree moved during capture; an unstable candidate cannot be accepted. */
	stability: SnapshotStability;
	collector: Collector;
	captured_at: Timestamp;
	digest: Digest;
}

// ---------- proof ----------

export interface ArtifactReference {
	id: RecordId;
	label: string;
	media_type?: string;
	/** Digest of the raw local bytes. */
	raw_digest: Digest;
	raw_size: number;
	/** Digest of the sanitized export, when one was produced; differs from `raw_digest` whenever anything was redacted. */
	sanitized_digest?: Digest;
	/** Whether the raw bytes are retained locally under the attempt's `artifacts/` directory. */
	retained: boolean;
}

export interface ProofRecord extends RecordEnvelope<"proof"> {
	change_id: RecordId;
	attempt_id: RecordId;
	/** The snapshot the check ran against; must be a snapshot of `attempt_id`. */
	snapshot_id: RecordId;
	obligation_id: LocalId;
	scenario_ids: LocalId[];
	check: {
		kind: CheckKind;
		/** Required for `host-observed` and `ci-reported`. */
		command?: string;
		/** Required for `manual-observation`. */
		procedure?: string;
		working_directory?: RepoRelativePath;
	};
	collector: Collector;
	result: ProofResult;
	/** Required for `host-observed`/`ci-reported` with a `passed`/`failed` result. */
	exit_code?: number;
	started_at: Timestamp;
	ended_at: Timestamp;
	block_reason?: string;
	/** Required for `manual-observation`: who performed the procedure, as a display label. */
	observer?: string;
	artifacts: ArtifactReference[];
	environment?: {
		summary: string;
		digest: Digest;
	};
	provenance: {
		/** The collecting surface, e.g. `mcp:claude-code`, `github-actions`, `pi`. */
		source: string;
		/** Required for `ci-reported`: the run this result was read from. */
		run_reference?: string;
	};
}

// ---------- review ----------

export interface ReviewObjection {
	id: LocalId;
	severity: ObjectionSeverity;
	statement: string;
	/** A concrete trigger or unsupported contract. An objection without evidence is invalid. */
	evidence: string;
	disposition: ObjectionDisposition;
	/** Required exactly when `disposition` is `resolved`. */
	resolution_evidence?: string;
	disposition_note?: string;
}

export interface ReviewRecord extends RecordEnvelope<"review"> {
	change_id: RecordId;
	attempt_id: RecordId;
	candidate_snapshot_id: RecordId;
	candidate_digest: Digest;
	input_digest: Digest;
	reviewer: {
		context: ReviewerContext;
		separation: ReviewerSeparation;
		label: string;
		note?: string;
	};
	objections: ReviewObjection[];
	/** Exactly the `blocking` objections whose disposition is `open` or `deferred`, in objection order. */
	remaining_blockers: LocalId[];
	summary: string;
}

// ---------- approval ----------

/**
 * The host-controlled receipt. Every field binds the decision to one
 * acceptance request the core issued: the request's nonce, its presentation
 * digest, and the same change/slice/attempt/snapshot identities. See
 * ./validation.ts `evaluateApprovalReceipt` for the rejection rules.
 */
export interface ApprovalReceipt {
	request_id: RecordId;
	/** 32 lowercase hex characters, minted by the core per request; single use. */
	nonce: string;
	presentation_digest: Digest;
	channel: ApprovalChannel;
	/** The adapter that obtained the decision, e.g. `mcp-server`, `pi`. */
	host: string;
	host_session?: string;
	issued_at: Timestamp;
	responded_at: Timestamp;
	authenticated: ReceiptAuthentication;
	/** The adapter's own statement of what it did and did not verify, for the human reader. */
	attestation: string;
}

export interface ApprovalRecord extends RecordEnvelope<"approval"> {
	change_id: RecordId;
	slice_id: RecordId;
	attempt_id: RecordId;
	candidate_snapshot_id: RecordId;
	candidate_digest: Digest;
	input_digest: Digest;
	decision: ApprovalDecision;
	decided_at: Timestamp;
	receipt: ApprovalReceipt;
	human_note?: string;
}

export type EngineeringRecord = ChangeRecord | SliceRecord | AttemptRecord | SnapshotRecord | ProofRecord | ReviewRecord | ApprovalRecord;

// ---------- acceptance request ----------

/**
 * What the core hands the host adapter to show a human. The adapter presents
 * `presentation` verbatim, obtains a decision through its own channel, and
 * mints the {@link ApprovalRecord} in-process. `presentation_digest` is the
 * canonical digest of `presentation`; the receipt carries it back so that a
 * decision cannot be re-bound to a different presentation.
 */
export interface AcceptancePresentation {
	title: string;
	requested_outcome: string;
	slice_deliverable: string;
	candidate_summary: string;
	proof_summary: Array<{ obligation_id: LocalId; result: ProofResult; collector: Collector }>;
	review_summary: Array<{ review_id: RecordId; separation: ReviewerSeparation; remaining_blockers: number }>;
	limitations: string[];
}

export interface AcceptanceRequest {
	schema_version: typeof ENGINEERING_SCHEMA_VERSION;
	id: RecordId;
	change_id: RecordId;
	slice_id: RecordId;
	attempt_id: RecordId;
	candidate_snapshot_id: RecordId;
	candidate_digest: Digest;
	input_digest: Digest;
	nonce: string;
	issued_at: Timestamp;
	expires_at: Timestamp;
	presentation: AcceptancePresentation;
	presentation_digest: Digest;
}

// ---------- operation API (`codecarto_change`) ----------

export const CHANGE_ACTIONS = ["create", "status", "plan", "start-attempt", "record-proof", "record-review", "check", "request-acceptance"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/** Actions that write records; each accepts an `idempotency_key`. */
export const MUTATING_CHANGE_ACTIONS: readonly ChangeAction[] = ["create", "plan", "start-attempt", "record-proof", "record-review", "request-acceptance"];

/** Declared by the host adapter per request. A model cannot raise its own capability: the adapter overwrites whatever the payload says. */
export interface HostCapabilities {
	human_acceptance: HumanAcceptanceCapability;
	/** Display label of the host, e.g. `claude-code`. */
	label?: string;
}

export interface ChangeRequestBase {
	action: ChangeAction;
	/** Idempotent retry key for mutating actions; a reused key with a different payload is `idempotency-conflict`. */
	idempotency_key?: string;
}

export interface CreateChangeRequest extends ChangeRequestBase {
	action: "create";
	title: string;
	mode: ChangeMode;
	requested_outcome: string;
	baseline: BaselineReference;
	scope: ChangeRecord["scope"];
	preserved_contracts: string[];
	acceptance_scenarios: AcceptanceScenario[];
	references?: ReferenceBinding[];
}

export interface StatusChangeRequest extends ChangeRequestBase {
	action: "status";
	change_id?: RecordId;
}

export type SliceInput = Omit<SliceRecord, keyof RecordEnvelope<"slice"> | "change_id" | "revision" | "state" | "updated_at" | "block_reason"> & {
	/** Present when updating an existing slice; absent to create one. */
	id?: RecordId;
};

export interface PlanChangeRequest extends ChangeRequestBase {
	action: "plan";
	change_id: RecordId;
	expected_revision: number;
	brief_markdown?: string;
	plan_markdown?: string;
	slices: SliceInput[];
}

export type SnapshotInput = Omit<SnapshotRecord, keyof RecordEnvelope<"snapshot"> | "change_id" | "attempt_id" | "role" | "digest">;

export interface StartAttemptRequest extends ChangeRequestBase {
	action: "start-attempt";
	change_id: RecordId;
	slice_id: RecordId;
	baseline_snapshot: SnapshotInput;
	inputs: Omit<AttemptInputs, "digest">;
	parent_attempt_id?: RecordId;
}

export type ProofInput = Omit<ProofRecord, keyof RecordEnvelope<"proof"> | "change_id" | "attempt_id">;

export interface RecordProofRequest extends ChangeRequestBase {
	action: "record-proof";
	change_id: RecordId;
	attempt_id: RecordId;
	proof: ProofInput;
}

export type ReviewInput = Omit<ReviewRecord, keyof RecordEnvelope<"review"> | "change_id" | "attempt_id">;

export interface RecordReviewRequest extends ChangeRequestBase {
	action: "record-review";
	change_id: RecordId;
	attempt_id: RecordId;
	review: ReviewInput;
}

export interface CheckChangeRequest extends ChangeRequestBase {
	action: "check";
	change_id: RecordId;
	attempt_id?: RecordId;
}

/**
 * Asks the host to obtain a human decision. There is deliberately no field on
 * this request — or any other — through which the caller can supply the
 * decision: `approve`, `approval`, `decision`, `receipt`, and friends are
 * unknown fields and the request is refused. The adapter fills `host` from
 * its own knowledge of the transport.
 */
export interface RequestAcceptanceRequest extends ChangeRequestBase {
	action: "request-acceptance";
	change_id: RecordId;
	attempt_id: RecordId;
	candidate_snapshot: SnapshotInput;
}

export type ChangeRequest =
	| CreateChangeRequest
	| StatusChangeRequest
	| PlanChangeRequest
	| StartAttemptRequest
	| RecordProofRequest
	| RecordReviewRequest
	| CheckChangeRequest
	| RequestAcceptanceRequest;

/** Machine-readable error codes. The set is closed; a new code is a contract amendment. */
export const ENGINEERING_ERROR_CODES = [
	"invalid-request",
	"invalid-action",
	"unsupported-schema-version",
	"unknown-field",
	"missing-field",
	"invalid-type",
	"invalid-id",
	"invalid-local-id",
	"invalid-path",
	"invalid-enum",
	"invalid-digest",
	"invalid-timestamp",
	"invalid-value",
	"digest-mismatch",
	"duplicate-id",
	"unknown-reference",
	"cross-change-reference",
	"invalid-state",
	"invalid-transition",
	"stale-revision",
	"idempotency-conflict",
	"not-found",
	"proof-not-observed",
	"blocking-objection",
	"receipt-unknown-request",
	"receipt-replayed",
	"receipt-mismatch",
	"receipt-expired",
	"untrusted-channel",
	"needs-human-acceptance",
] as const;
export type EngineeringErrorCode = (typeof ENGINEERING_ERROR_CODES)[number];

export interface EngineeringError {
	code: EngineeringErrorCode;
	/** JSON-pointer-like location of the offending value, e.g. `/manifest/3/path`; `/` for the whole value. */
	path: string;
	message: string;
}

export type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; errors: EngineeringError[] };

export interface AcceptanceRequestOutcome {
	outcome: "accepted" | "rejected" | "needs-human-acceptance";
	request: AcceptanceRequest;
	approval?: ApprovalRecord;
	/** Why the host could not obtain a decision, when `outcome` is `needs-human-acceptance`. */
	reason?: string;
}

/** Every operation result uses this envelope; the MCP adapter (E07) mirrors it in `structuredContent` and renders `text` from it. */
export type ChangeResult<T = unknown> = { ok: true; action: ChangeAction; result: T } | { ok: false; action?: ChangeAction; errors: EngineeringError[] };

/**
 * The records the acceptance gate (E06) requires before an attempt may
 * become `accepted`. Enumerated here so the requirement is contract, not
 * gate implementation detail.
 */
export const ACCEPTANCE_REQUIRED_RECORDS = [
	{ kind: "change", requirement: "state is `active`; the slice's `depends_on` are all `accepted`" },
	{ kind: "slice", requirement: "state is `active`; every `proof_obligations[].id` is discharged" },
	{ kind: "attempt", requirement: "outcome is `ready-for-review` or `needs-human-acceptance`; `candidate_snapshot_id` set" },
	{ kind: "snapshot", requirement: "baseline and candidate both present; candidate `stability` is `stable` and `collector` is not `agent-claimed`; candidate digest equals the current tree at recheck" },
	{ kind: "proof", requirement: "one per obligation with `result: passed`, `collector` at or above the obligation's `minimum_collector`, and `snapshot_id` equal to the candidate" },
	{ kind: "review", requirement: "at least one with `separation: declared-separate`, bound to the candidate and input digests, with empty `remaining_blockers`" },
	{ kind: "approval", requirement: "`decision: accepted`, receipt on a trusted channel, unconsumed nonce, bindings equal to the request and the candidate" },
] as const;
