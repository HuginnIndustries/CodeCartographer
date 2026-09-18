# Engineering records: v1 contract

**Status:** v1 frozen by E01 ([#399](https://github.com/HuginnIndustries/CodeCartographer/issues/399)). The executable form is `core/engineering/` (`types.ts`, `ids.ts`, `digest.ts`, `validation.ts`, exported through `core/index.ts`) and the fixtures under `tests/fixtures/engineering/v1/`; `tests/engineering-contract.test.mjs` pins every rule below. Where this page and the code disagree, the code and its fixtures are the contract and this page has a bug. No later issue may independently redefine these shapes: a new field, enum value, or error code is a contract amendment that lands with a fixture and a change to this page. Read [vision](vision.md) and [implementation plan](implementation-plan.md) first.

The design rationale that preceded the freeze is kept in [§ Design notes](#design-notes) at the end. The sections before it are normative.

## Ownership and layout

Runtime code lives under `core/engineering/` with a one-way barrel that `core/index.ts` re-exports. Existing `core/status.ts`, analysis completion, and `workflow/status.yaml` are not repurposed; the engineering namespace is additive and separate. New MCP registration (E07) delegates to a focused adapter module rather than widening the existing handler file.

The workspace namespace, relative to `.codecarto/` (`engineeringPaths` in `ids.ts` builds these and throws on any ID that fails the grammar):

```text
engineering/
  changes/<change-id>/
    change.json
    brief.md
    plan.md
    slices/<slice-id>/slice.json
    attempts/<attempt-id>/
      attempt.json
      snapshots/<snapshot-id>.json
      proofs/<proof-id>.json
      reviews/<review-id>.json
      approvals/<approval-id>.json
      requests/<request-id>.json
      artifacts/<artifact-id>
```

`change.json` and `slice.json` are versioned mutable projections updated with compare-and-swap on `revision`. Everything under `attempts/` is create-only once finalized; a corrected observation is a new record that names the one it supersedes. There is no global registry: a store enumerates `changes/` and reports a corrupt directory explicitly without hiding the others. Distribution isolation of this namespace (template copy, npm files, ignore rules) is E02.

## Grammar

| Thing | Grammar | Notes |
|---|---|---|
| Record ID | `<prefix>_<24 lowercase hex>` | Prefixes: `chg` change, `slc` slice, `att` attempt, `snp` snapshot, `prf` proof, `rvw` review, `apr` approval, `art` artifact, `acr` acceptance request. 96 bits from the core's CSPRNG (`newRecordId`). The prefix names the kind: a `change_id` that starts with `slc_` is `invalid-id` before any lookup. |
| Local ID | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` | Scenario, obligation, and objection IDs. Unique within their record; display-safe; never a path. |
| Nonce | `[0-9a-f]{32}` | One per acceptance request, single use. |
| Digest | `sha256:` + 64 lowercase hex | The only algorithm in v1. |
| Timestamp | RFC 3339, UTC, `Z` suffix, optional fractional seconds, real calendar date | `2026-09-17T10:00:00Z`. Offsets and naive times are `invalid-timestamp`. |
| Git hash | 40 or 64 lowercase hex | Full commit hash; abbreviations refused. |
| Repository-relative path | non-empty, `/`-separated; no empty, `.`, or `..` segment; no leading `/`; no `\`; no `*`; no NUL or other control character; no drive prefix; ≤ 4096 chars | Manifest entries, uncovered inputs, `check.working_directory` (which also accepts `.`). `~` is an ordinary character. |
| Scope pattern | as above, `*` and `**` allowed | `permitted_scope.paths`, `coverage.excluded[].pattern`. |
| Revision | integer ≥ 1 | CAS token on change and slice. |

Unknown fields are refused everywhere (`unknown-field`, checked with own-property semantics so `constructor` or `toString` cannot slip past); there is no extension bag. Every record carries `schema_version: 1`. Any other value — including a missing field or the string `"1"` — is `unsupported-schema-version` and the record is not read further.

## Canonical digests

`digest.ts` defines one encoding: canonical JSON — object keys sorted by UTF-16 code unit, no whitespace, strings escaped as `JSON.stringify` escapes them (control characters, `"` and `\`; U+2028 and non-ASCII stay raw), `undefined` properties omitted, integers only (a float throws), `-0` written as `0` — hashed with SHA-256. The fixture generator reimplements these rules without importing the core and the test requires both to agree.

| Digest | Input (canonical JSON of) | Recomputed by the validator |
|---|---|---|
| `snapshot.digest` | `{ coverage, manifest, repository }` — nothing else on the snapshot | yes (`digest-mismatch` at `/digest`) |
| `attempt.inputs.digest` | `{ brief_digest, plan_digest, references }`; `brief_digest`/`plan_digest` are digests of the raw `brief.md`/`plan.md` bytes; `references` sorted by `id` then `version` in UTF-8 byte order | yes |
| `acceptance_request.presentation_digest` | `presentation` | yes |
| `proof.artifacts[].raw_digest` / `sanitized_digest` | raw local bytes / sanitized export bytes | no (the store has the bytes) |
| `proof.environment.digest` | a host-defined environment descriptor | no |

Manifest paths sort strictly ascending in UTF-8 byte order (`compareUtf8`); a repeat is `duplicate-id`, a descent is `invalid-value`. A digest establishes byte identity, not correctness, execution, reviewer independence, or human intent.

## Records

Every record has the envelope `schema_version: 1`, `kind`, `id` (of the kind's prefix), `created_at`. Field tables list the rest. "Required" is unconditional unless a rule says otherwise.

### change (`chg_`)

| Field | Type | Rule |
|---|---|---|
| `revision` | integer ≥ 1 | CAS token |
| `title`, `requested_outcome` | non-empty string | |
| `mode` | `fix` \| `feature` \| `refactor` \| `migration` \| `investigation` | |
| `state` | `draft` \| `planned` \| `active` \| `blocked` \| `accepted` \| `abandoned` | |
| `baseline` | `{ vcs: git \| none, head?, description? }` | `head` required iff `vcs` is `git` |
| `scope` | `{ in_scope: string[], non_goals: string[] }` | entries non-empty |
| `preserved_contracts` | string[] | |
| `acceptance_scenarios` | `{ id: LocalId, kind: behavior \| preserved \| non-functional, description }[]` | unique `id`; non-empty once `state` ≠ `draft` |
| `references` | `{ id, version, digest }[]` | may be empty — zero references is the ordinary in-place change |
| `block_reason` | string | present iff `state` is `blocked` |
| `updated_at` | timestamp | ≥ `created_at` |

### slice (`slc_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `revision` | | |
| `title`, `deliverable` | non-empty string | |
| `scenario_ids` | LocalId[] | non-empty, unique; each must be a change scenario (bundle check) |
| `depends_on` | slice ID[] | unique, never itself; each must be a slice of the same change (bundle check) |
| `proof_obligations` | `{ id, scenario_id, check_kind, description, minimum_collector }[]` | non-empty, unique `id`; `scenario_id` ∈ `scenario_ids`; `minimum_collector` ∈ `host-observed` \| `ci-reported` \| `manual-observation` — `agent-claimed` is `invalid-enum` |
| `permitted_scope` | `{ paths: ScopePattern[], description? }` | |
| `state` | `pending` \| `active` \| `blocked` \| `accepted` \| `abandoned` | |
| `block_reason` | | iff `blocked` |
| `updated_at` | | |

`check_kind` everywhere: `test` | `build` | `lint` | `typecheck` | `run` | `manual-procedure` | `other`.

### attempt (`att_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `slice_id` | | |
| `inputs` | `{ brief_digest, plan_digest, references, digest }` | `references` sorted and unique; `digest` recomputed |
| `baseline_snapshot_id` | snapshot ID | role `baseline`, same attempt (bundle check) |
| `candidate_snapshot_id` | snapshot ID | required for `ready-for-review`, `needs-human-acceptance`, `accepted`; role `candidate`; ≠ baseline |
| `outcome` | `running` \| `failed` \| `blocked` \| `ready-for-review` \| `needs-human-acceptance` \| `accepted` \| `superseded` | |
| `started_at` | timestamp | |
| `ended_at` | timestamp | present iff `outcome` ≠ `running`; ≥ `started_at` |
| `parent_attempt_id` | attempt ID | the attempt this resumed or retried; never itself |
| `supersedes_attempt_id` | attempt ID | the observation this corrects; the earlier record is never rewritten |
| `superseded_by_attempt_id` | attempt ID | present iff `outcome` is `superseded` |
| `block_reason` | | iff `blocked` |
| `failure_summary` | non-empty string | optional |

`blocked` is a missing environment, permission, input, or acceptance. `failed` is a completed check that failed. They are never merged.

### snapshot (`snp_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `attempt_id` | | |
| `role` | `baseline` \| `candidate` | |
| `repository` | `{ vcs, head?, dirty: boolean }` | `head` iff `git`; HEAD alone never identifies a candidate — the manifest does |
| `manifest` | `ManifestEntry[]` | strictly ascending by path; file: `{ path, type: "file", digest, executable, size }`; symlink: `{ path, type: "symlink", target }` — a symlink carries its raw link text and never a digest (`unknown-field`) |
| `coverage` | `{ excluded: { pattern, reason }[], uncovered_relevant_inputs: path[] }` | `reason` ∈ `engineering-namespace` \| `generated` \| `ignored` \| `secret` \| `host-declared`; a non-empty `uncovered_relevant_inputs` means revalidate or block, never assume freshness |
| `stability` | `stable` \| `unstable` | `unstable` when the tree moved during capture; an unstable candidate cannot bind an acceptance |
| `collector` | see proof | an `agent-claimed` snapshot cannot bind an acceptance |
| `attested_by` | `adapter` \| `caller` | adapter-set (see § Attestation); only an `adapter` candidate can bind an acceptance |
| `captured_at` | timestamp | |
| `digest` | | recomputed over `{ coverage, manifest, repository }`; an error elsewhere on the record does not suppress a mismatch |

The engineering namespace and generated evidence are excluded from the manifest (they would self-invalidate); the brief, plan, and selected references are in `attempt.inputs` instead. The host collects; the framework validates and compares (E03 owns collection semantics).

### proof (`prf_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `attempt_id` | | |
| `snapshot_id` | snapshot ID | must be a snapshot of `attempt_id` (bundle check) |
| `obligation_id` | LocalId | must be declared by the attempt's slice (bundle check) |
| `scenario_ids` | LocalId[] | non-empty, unique, change scenarios |
| `check` | `{ kind, command?, procedure?, working_directory? }` | `command` required for `host-observed`/`ci-reported`; `procedure` required for `manual-observation` |
| `collector` | `host-observed` \| `ci-reported` \| `manual-observation` \| `agent-claimed` | exact spelling |
| `result` | `passed` \| `failed` \| `blocked` | |
| `exit_code` | integer | required for `host-observed`/`ci-reported` with `passed`/`failed` |
| `started_at`, `ended_at` | timestamp | `ended_at` ≥ `started_at` |
| `block_reason` | | iff `result` is `blocked` |
| `observer` | string | required for `manual-observation` |
| `artifacts` | `{ id: art_…, label, media_type?, raw_digest, raw_size, sanitized_digest?, retained }[]` | unique `id`; referenced by ID only — a `path` is `unknown-field`, so a host-supplied path is never an output destination |
| `environment` | `{ summary, digest }` | optional |
| `provenance` | `{ source, run_reference?, attested_by }` | `run_reference` required for `ci-reported`; `attested_by` adapter-set (see § Attestation) — a caller cannot vouch for itself |

`agent-claimed` is a legal record so that a claim can be kept and later contradicted; it satisfies no obligation (`OBSERVED_COLLECTORS` excludes it, and no obligation may name it as its minimum). A record containing `result: passed` is a proof only by its collector, never by its text — and its collector is only as good as `provenance.attested_by` says.

### Attestation: who vouches for `collector`, `result`, and `stability`

`collector`, `result`, `exit_code`, and `stability` are caller text on the tool path: a model calling `record-proof` can spell `host-observed`. The contract does not pretend otherwise; it labels it. `attested_by` is set by the adapter and is `unknown-field` on every input shape:

- `adapter` — the adapter itself captured the snapshot with its read-only repository utilities (E03), or observed the command's exit (no v1 adapter does the latter; the MCP server never runs commands).
- `caller` — the values arrived in a tool payload and are the caller's claim; the adapter recorded them as such.

Rules: the acceptance gate requires the **candidate snapshot** to be `attested_by: adapter` — the adapter re-reads the tree itself (`request-acceptance` carries no snapshot; `capture-candidate`'s `snapshot` is ignored whenever the adapter can read the working directory, and a caller-supplied one is recorded `caller` and cannot bind acceptance). **Proofs** may be `caller`-attested — on MCP v1 they always are — and `buildAcceptanceRequest` then adds a fixed limitation line to the presentation ("*n* of *m* proofs are caller-attested: the host session reported the result; the framework did not observe the command."), so the person deciding sees exactly that. "Host-reported" is never spelled "independently authenticated" anywhere in a record or a presentation.

### review (`rvw_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `attempt_id` | | |
| `candidate_snapshot_id`, `candidate_digest`, `input_digest` | | must equal the attempt's bound candidate, its digest, and the attempt's input digest (bundle check: `invalid-value` / `digest-mismatch`) |
| `reviewer` | `{ context, separation, label, note? }` | `context` ∈ `separate-session` \| `separate-agent` \| `human` \| `same-session`; `separation` ∈ `declared-separate` \| `same-context`; `same-session` + `declared-separate` is `invalid-value` |
| `objections` | `{ id, severity, statement, evidence, disposition, resolution_evidence?, disposition_note? }[]` | unique `id`; `evidence` non-empty; `severity` ∈ `blocking` \| `advisory`; `disposition` ∈ `open` \| `resolved` \| `withdrawn` \| `deferred`; `resolution_evidence` present iff `resolved` |
| `remaining_blockers` | LocalId[] | must equal exactly the `blocking` objections whose disposition is `open` or `deferred`, in objection order (`deriveRemainingBlockers`) — a hand-written empty list over an open blocker is `invalid-value` |
| `summary` | non-empty string | |

`separation` is a declaration the framework records. It is not authenticated and the review record cannot say it is.

### approval (`apr_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `slice_id`, `attempt_id`, `candidate_snapshot_id`, `candidate_digest`, `input_digest` | | bound to the attempt (bundle check) and to the request (receipt evaluation) |
| `decision` | `accepted` \| `rejected` | |
| `decided_at` | timestamp | |
| `receipt` | see below | |
| `human_note` | non-empty string | optional, verbatim from the person |

`receipt`: `{ request_id: acr_…, nonce, presentation_digest, channel, host, host_session?, issued_at, responded_at, authenticated, attestation }`. `channel` ∈ `mcp-elicitation` | `host-native` | `cooperative-file` | `agent-declared`. `authenticated` ∈ `none` | `host-session` and is determined by the channel: a trusted channel (`mcp-elicitation`, `host-native`) must say `host-session`, an untrusted one must say `none`; either mislabel is `invalid-value`. A malformed nonce is `invalid-value` (not `invalid-id`). `responded_at` ≥ `issued_at`. `attestation` is the adapter's own plain-language statement of what it did and did not verify, shown to the reader of the record.

## Acceptance request (`acr_`)

Not a record kind; the object the core issues (`buildAcceptanceRequest`, pure) and the host presents. Stored by E06 under `requests/` so a receipt can be checked against it.

```text
{ schema_version: 1, id, change_id, slice_id, attempt_id, candidate_snapshot_id,
  candidate_digest, input_digest, nonce, issued_at,
  expires_at (> issued_at, at most ACCEPTANCE_REQUEST_MAX_TTL_MS = 24 h later),
  presentation: { title, requested_outcome, slice_deliverable, candidate_summary,
                  proof_summary: { obligation_id, result, collector, attested_by }[],
                  review_summary: { review_id, separation, remaining_blockers }[],
                  limitations: string[] },
  presentation_digest }
```

`candidate_summary` is `"<n> manifest entries (<f> files, <s> symlinks); <dirty|clean> tree at <head8>|no VCS; digest <full digest>"`. `limitations` begin with the lines `standardLimitations` derives from the records (caller-attested proof count; "reviewer separation is declared, not authenticated") followed by whatever the gate adds; a caller can add lines, never remove the standard ones. The fixture `valid/acceptance-request.json` is byte-for-byte what `buildAcceptanceRequest` produces from the fixture bundle.

## State transitions

`CHANGE_STATE_TRANSITIONS`, `SLICE_STATE_TRANSITIONS`, and `ATTEMPT_OUTCOME_TRANSITIONS` in `types.ts` are the closed tables; `isAllowedTransition(kind, from, to)` reads them and the store emits `invalid-transition` for anything else. The same state is never a transition; `accepted` and `abandoned`/`superseded` are terminal.

| Kind | From → to |
|---|---|
| change | `draft` → `planned`, `abandoned`; `planned` → `active`, `draft`, `abandoned`; `active` → `blocked`, `accepted`, `abandoned`; `blocked` → `active`, `abandoned` |
| slice | `pending` → `active`, `abandoned`; `active` → `blocked`, `accepted`, `abandoned`; `blocked` → `active`, `abandoned` |
| attempt | `running` → `failed`, `blocked`, `ready-for-review`, `needs-human-acceptance`, `superseded`; `failed`/`blocked` → `superseded`; `ready-for-review` → `needs-human-acceptance`, `accepted`, `blocked`, `superseded`; `needs-human-acceptance` → `accepted`, `blocked`, `superseded` |

A change becomes `accepted` only when the store records an acceptance, never through a `plan` update. An attempt is never `accepted` straight from `running`. A `failed` or `blocked` attempt has no way back: the retry is a **new** attempt started with `parent_attempt_id` naming it (and, when the new one corrects an observation, `supersedes_attempt_id`), so the old record and its evidence stay exactly as they were.

For the store (E02): when re-checking an approval already on disk, `consumed_nonces` must be the nonces of the *other* approvals in the change — including the approval's own nonce would make every stored approval self-reject as replayed.

## Required records for acceptance

`ACCEPTANCE_REQUIRED_RECORDS` in `types.ts`; E06 implements the gate from this list and adds the live recheck.

| Record | Requirement |
|---|---|
| change | state `active`; every slice in the slice's `depends_on` is `accepted` |
| slice | state `active`; every `proof_obligations[].id` discharged |
| attempt | outcome `ready-for-review` or `needs-human-acceptance`; `candidate_snapshot_id` set |
| snapshot | baseline and candidate present; candidate `stability: stable`, `collector` ≠ `agent-claimed`, `attested_by: adapter`; `checkCandidateFreshness(candidate, reread)` passes against the tree the adapter re-reads at acceptance time |
| proof | one per obligation with `result: passed`, `collector` at or above the obligation's `minimum_collector` (`COLLECTOR_RANK`: `host-observed` 3 > `ci-reported` 2 > `manual-observation` 1 > `agent-claimed` 0, which satisfies nothing; `collectorSatisfies`), `snapshot_id` = the candidate, `scenario_ids` naming the obligation's scenario; caller-attested proofs count and are disclosed in the presentation |
| review | at least one with `separation: declared-separate`, bound to the candidate and input digests, `remaining_blockers` empty |
| approval | `decision: accepted`; receipt passes `evaluateApprovalReceipt` (trusted channel, known request, unconsumed nonce, all bindings equal) |

Missing any row is `blocked`/`needs-human-acceptance`, never `failed`, and never `accepted`. Old acceptance stays historical; it is not current approval for different bytes.

## Validation API

All pure; all deterministic (the same value yields the same error list, in traversal order).

| Function | Checks |
|---|---|
| `validateRecord(value)` / `validateRecordOfKind(kind, value)` / `parseRecord(text)` | one record: version gate, kind, shape, grammar, enums, its own cross-field rules |
| `validateChangeBundle({ change, slices, attempts, snapshots, proofs, reviews, approvals })` | every record, then references: unique IDs, `change_id` equality (`cross-change-reference`), slice deps/scenarios, snapshot roles and ownership, proof obligation/snapshot/scenario, review/approval candidate and digest bindings, one approval per nonce (`receipt-replayed`) |
| `validateAcceptanceRequest(value)` | shape, `expires_at` > `issued_at`, presentation digest |
| `validateChangeRequest(value)` | one `codecarto_change` request: action, the action's fields only, plus the record-level rules that apply to the body (a `create` with duplicate scenario IDs fails at the request path) |
| `evaluateApprovalReceipt(approval, { request, consumed_nonces, attempt, candidate })` | re-validates all four inputs (an invalid one is `invalid-request`), then the receipt against the issued request; see § Human approval. `consumed_nonces` are the nonces bound by approvals *other than* the one under evaluation |
| `checkCandidateFreshness(candidate, reread)` | the adapter's re-read tree against the bound candidate: `digest-mismatch /digest` when the bytes moved |
| `buildAcceptanceRequest(args)` / `standardLimitations(proofs, reviews)` | the request from bound records (throws if the candidate is not the attempt's); the limitation lines every presentation carries |
| `isAllowedTransition(kind, from, to)` | the state tables |

Result shape: `{ ok: true, value }` or `{ ok: false, errors: { code, path, message }[] }`, `path` a JSON-pointer-like location (`/manifest/3/path`). Error codes (closed set, `ENGINEERING_ERROR_CODES`): `invalid-request`, `invalid-action`, `unsupported-schema-version`, `unknown-field`, `missing-field`, `invalid-type`, `invalid-id`, `invalid-local-id`, `invalid-path`, `invalid-enum`, `invalid-digest`, `invalid-timestamp`, `invalid-value`, `digest-mismatch`, `duplicate-id`, `unknown-reference`, `cross-change-reference`, `invalid-state`, `invalid-transition`, `stale-revision`, `idempotency-conflict`, `not-found`, `proof-not-observed`, `blocking-objection`, `receipt-unknown-request`, `receipt-replayed`, `receipt-mismatch`, `receipt-expired`, `untrusted-channel`, `needs-human-acceptance`. `invalid-state`, `invalid-transition`, `stale-revision`, `idempotency-conflict`, `not-found`, `proof-not-observed`, `blocking-objection`, and `needs-human-acceptance` are reserved for the store, gate, and adapter (E02, E06, E07); the validators emit the others.

## Operation API: `codecarto_change`

One additive, experimental MCP tool (E07 registers it) over typed core operations. Requests are one object with an `action` discriminator; only that action's fields are accepted.

| Action | Arguments | Result |
|---|---|---|
| `create` | `title, mode, requested_outcome, baseline, scope, preserved_contracts, acceptance_scenarios, references?` | `{ change }` in state `draft` |
| `status` | `change_id?` | `StatusResult { changes: ChangeSummary[], change?: ChangeBundle, corrupt: CorruptChangeReport[] }` — a corrupt change directory is reported, never hidden |
| `plan` | `change_id, expected_revision, brief_markdown?, plan_markdown?, slices: SliceInput[]` | `{ change, slices }`; stale `expected_revision` is `stale-revision` |
| `start-attempt` | `change_id, slice_id, inputs: { brief_digest, plan_digest, references }, baseline_snapshot?: SnapshotInput, parent_attempt_id?` | `{ attempt, snapshot }` — the adapter captures the baseline itself when it can read the tree |
| `capture-candidate` | `change_id, attempt_id, snapshot?: SnapshotInput` | `{ attempt, snapshot }` — binds `candidate_snapshot_id`; the attempt stays `running`; repeatable until a proof references the candidate |
| `record-proof` | `change_id, attempt_id, proof: ProofInput` | `{ proof }` — `proof.snapshot_id` must be the attempt's bound candidate (or baseline for a RED run) |
| `record-review` | `change_id, attempt_id, review: ReviewInput` | `{ review }` |
| `check` | `change_id, attempt_id?` | `CheckResult { outcome: eligible \| blocked \| needs-human-acceptance \| accepted, requirements: AcceptanceRequirementStatus[], errors, next: { action, reason } }` — one requirement row per entry of the acceptance table |
| `request-acceptance` | `change_id, attempt_id` | `{ outcome: accepted \| rejected \| needs-human-acceptance, request, approval?, reason? }` — the adapter re-reads the tree and runs `checkCandidateFreshness` before presenting anything |

Mutating actions (all but `status` and `check`) accept `idempotency_key` (1–200 chars): a retry with the same key and payload returns the first result; the same key with a different payload is `idempotency-conflict`. A lost acknowledgement never implies re-running an external command.

Every result uses `ChangeResult<A>`: `{ ok: true, action, result: ChangeResults[A] }` or `{ ok: false, action?, errors }`; `ChangeResults` in `types.ts` maps each action to its result payload. The MCP adapter mirrors it in `structuredContent` and renders `text` from the same object, so both carry the same semantic result.

**Capability negotiation.** `HostCapabilities { human_acceptance: mcp-elicitation | host-native | none, label? }` is supplied by the adapter from what it knows about the transport (for MCP: whether the client declared the `elicitation` capability at initialize). It is not a request field: `host` on any request is `unknown-field`. A model cannot raise its own host's capability.

**No approval field.** There is no `approve` action. `approve`, `approved`, `approval`, `decision`, `receipt`, `human_accepted`, `attested_by`, and any other field outside the table are `unknown-field` on every action. `request-acceptance` asks; it never grants.

## Human approval and threat boundary

### What is being protected

The claim "a person accepted exactly this candidate, having seen exactly this presentation". The assets are the binding (change, slice, attempt, candidate digest, input digest, presentation digest) and the channel through which the decision arrived.

### Actors and what they can do

| Actor | Can | Cannot (by this contract) |
|---|---|---|
| The model, through ordinary tool calls | call any `codecarto_change` action with any payload — including a proof whose `collector` says `host-observed`; write any file the host lets it write | put a decision into a request; mint an approval through the tool; raise host capability; vouch for its own claims (`attested_by`); supply the candidate the gate accepts; change a nonce or presentation after issue |
| The host adapter (MCP server process, Pi extension) | issue requests, present them, obtain the decision on its own channel, mint the approval in-process | claim `authenticated: host-session` on a cooperative or agent-declared channel |
| The MCP client (Claude Code, Codex, Cursor, …) | answer `elicitation/create` after showing it to the user, or decline | be verified by the server to have actually shown it |
| A person at the keyboard | approve or reject in the host's UI; edit files on disk | be identified by name or credential — v1 has no identity |
| Any process running as the same OS user | write or edit anything under `.codecarto/engineering/` | be distinguished from the adapter by the bytes on disk |

### The receipt path

1. The gate (E06) verifies the required records, then the adapter re-reads the tree and runs `checkCandidateFreshness` against the bound (adapter-attested) candidate; on any gap or a moved tree it returns `blocked`/`needs-human-acceptance` and no request is issued.
2. The core builds an `AcceptanceRequest` with a fresh `acr_` ID and nonce, a bounded `expires_at`, and the presentation; the store durably writes it under `requests/` before anything is shown.
3. The adapter presents `presentation` verbatim through a channel the model does not control:
   - **`mcp-elicitation`**: the server sends `elicitation/create` (a server-initiated JSON-RPC request; SDK 1.30's `Server.elicitInput`, which requires the client to have declared the `elicitation.form` capability at initialize) with a form whose only field is the decision plus an optional note. The client's UI shows it; the answer returns over the transport as the client's JSON-RPC response. The model's tool-call arguments are never the channel.
   - **`host-native`**: an in-process UI such as Pi's `ctx.ui.confirm` is called by the adapter's own code with the presentation.
4. The adapter — not the caller — mints the `ApprovalRecord` in-process with the receipt fields copied from the request and the decision copied from the channel, runs `evaluateApprovalReceipt` against the nonces already bound by *other* approvals, and only then stores it. The `request-acceptance` result carries the record.
5. Any later reader runs `evaluateApprovalReceipt` with the stored request and the nonces of every other approval in the change; `validateChangeBundle` independently refuses two approvals on one nonce.

### Rejections (each is a fixture under `tests/fixtures/engineering/v1/invalid/`)

| Situation | Refused as |
|---|---|
| Receipt names a request the store never issued (the store knows only what is under `requests/`; see the same-user limitation — a hand-written request plus a matching hand-written approval is exactly that bypass) | `receipt-unknown-request` |
| Nonce already bound to another approval (replay, duplicate ingestion, copied file); two approvals on one nonce in a bundle | `receipt-replayed` |
| Nonce, slice, attempt, snapshot, candidate digest, input digest, presentation digest, or issue time differs from the request | `receipt-mismatch` at that field |
| Approval, request, or attempt name different changes | `cross-change-reference` |
| Tree re-read by the adapter differs from the bound candidate (edited after proof/review) — E06 runs this before issuing and again before minting | `digest-mismatch /digest` from `checkCandidateFreshness` |
| Stored candidate record rewritten with the same ID, attempt re-bound to another candidate or slice, or inputs changed | `receipt-mismatch` at that field |
| Answered after `expires_at`, or decided outside the window; request valid longer than 24 h | `receipt-expired`; `invalid-value /expires_at` |
| Answered before issue | `invalid-value /receipt/responded_at` (record-level) |
| Candidate `unstable`, `agent-claimed`, or not adapter-attested | `invalid-value /candidate_snapshot_id` |
| Any of approval, attempt, candidate, or request fails its own validator | `invalid-request` — the receipt is not evaluated on malformed inputs |
| Channel `cooperative-file` or `agent-declared` | `untrusted-channel` |
| `approve: true`, `approval: {…}`, `decision`, `receipt`, or `host` in any request; `action: approve` | `unknown-field` / `invalid-action` |
| Untrusted channel claiming `authenticated: host-session`, or trusted channel claiming `none` | `invalid-value /receipt/authenticated` |
| Prototype-named field (`constructor`, `toString`) used to carry a payload | `unknown-field` |

### What is attested versus authenticated

| Channel | Authenticated | Attested by the adapter | Not established |
|---|---|---|---|
| `mcp-elicitation` | the answer arrived over the same transport session that issued the request (`host-session`) | the client declared the elicitation capability and returned `accept` with the decision | that the client showed the form to a person rather than auto-answering; who the person is |
| `host-native` | the adapter's own UI call returned in-process (`host-session`) | the adapter presented the request in its UI | who the person is; that nobody else was at the keyboard |
| `cooperative-file` | nothing (`none`) | nothing | anything — a useful note, never acceptance |
| `agent-declared` | nothing (`none`) | nothing | anything — kept only so the refusal can name it |

Hashes prove identity of bytes, not human intent. A reviewer ID string proves nothing about independence. Neither channel authenticates a person; v1 deliberately has no `user-identity` value and no credential, token, or signature stored in `.codecarto/`.

### Unsupported hosts

An adapter whose `human_acceptance` is `none` (an MCP client without elicitation, a headless run, a drop-in template) returns `{ outcome: "needs-human-acceptance", request, reason }` from `request-acceptance`. The request is stored, the attempt becomes `needs-human-acceptance`, and nothing is minted. A person may later accept through a supported host against the same request while it is unexpired; the acceptance still binds to the same candidate digest, so any edit in between is refused. The template surface documents the procedure and cannot claim enforcement.

### The same-user filesystem limitation

Every record, including approvals and consumed nonces, is a file the same OS user can write. In-session, the channel guarantee holds: a decision cannot enter through the model's tool arguments. At rest, an approval minted by the adapter and one written by hand with `channel: mcp-elicitation` are byte-indistinguishable; the validators cannot tell them apart and this contract does not claim they can. Consequences:

- The Pi analysis guard confines agent writes to `.codecarto/`, which *includes* `.codecarto/engineering/`. Hosts that run an agent with write access must deny it `.codecarto/engineering/` (a host policy for E08; the Pi guard itself is unchanged by E01 per EV-D03) or accept that at-rest records are cooperative.
- Acceptance is only as trustworthy as the adapter that minted it and the store it wrote to. The honest label is *host-attested, session-bound, unauthenticated*; the records say so in `receipt.authenticated` and `receipt.attestation`, and nothing in this repository may advertise them as tamper-proof.
- Tamper evidence at rest (a signature over the approval under a key the adapter holds outside the workspace) is a possible later addition and is explicitly out of v1; it must not be a homemade credential system or a token stored in `.codecarto/`.

### Decision record

The receipt design above is proposed as the v1 trusted path and is what the fixtures and validators implement. The maintainer's remaining call is whether **MCP elicitation, which trusts the connected client to have shown the form, is an acceptable pilot channel** given the consequence table. If it is not, E06/E07 stay blocked on a channel that E01 does not have: there is no cross-client mechanism by which an MCP server can verify a human saw a prompt. Pi's `host-native` channel does not depend on that call.

Two inputs the decision should weigh, neither settled by this contract: (a) which target clients implement form elicitation today — this commit verifies the SDK's server side only, not any client; (b) that on MCP every proof is caller-attested (the server never runs commands), so the human's decision rests on the host session's report plus the adapter's own re-read of the tree, and the presentation says so.

## Compatibility

Additive only. No existing `.codecarto/` path, pipeline YAML, `status.yaml` field, phase prompt, `validatePhaseOutput` behavior, synthesis preflight, or Pi guard changes. `core/index.ts` gains one `export *`. The module graph test and every existing test are unchanged and green.

## Design notes

The paragraphs below are the reasoning behind the frozen rules; they are informative.

*Identity and freshness.* Record the Git base but never identify an implementation with HEAD alone: dirty tracked bytes, relevant untracked files, deleted files, executable bits, and symlink targets matter, which is why the manifest carries all of them and the digest covers the manifest. The engineering namespace and generated output are excluded from the implementation fingerprint to avoid self-invalidation; the brief, plan, and selected references form a separate input digest so that a changed plan invalidates acceptance as surely as a changed file. Unknown coverage is recorded, not assumed away. Capture must detect a moving source and record it as `unstable`; pre-acceptance recheck stops a candidate edited after proof from inheriting that proof. Resume locates existing attempts; it does not rerun external commands.

*Structure is not semantics.* The deterministic half checks record shape, reference existence, identity bindings, scenario coverage, dependencies, outcomes, objection dispositions, and receipt bindings. It does not claim to prove semantic correctness of code or tests. Independent review examines whether tests meaningfully exercise requested and preserved behavior; the record only carries the declaration of context separation. A blocking objection remains blocking until evidence resolves it — `deferred` still blocks, and v1 has no waiver path. The existing analysis `validatePhaseOutput` stays backward compatible; engineering gates use explicit records rather than a model-written PASS table.

*Why no extension bag.* A downstream implementer must be able to consume the schema without inventing fields; the cheapest way to make that true is for the validator to refuse fields it does not know. Amendments are cheap (a type, a fixture, a row here) and visible.

*Storage, security, export* (E02 and later). Reuse the atomic write, containment, and locking primitives where their contracts fit. Test truncated, cross-linked, and unsupported records; crashes before and after the commit point; duplicate requests; stale revisions; concurrent attempts. Raw stdout, environment variables, commands with embedded credentials, and private repository identity are not exportable by default; a retained log keeps the digest of its raw bytes distinct from the digest of its sanitized export. Export is an explicit reviewed operation, never a side effect of acceptance or library publication. No new database, network service, telemetry backend, provider dependency, release automation, or credential vault is needed for the first pilot.
