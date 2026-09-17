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

Unknown fields are refused everywhere (`unknown-field`); there is no extension bag. Every record carries `schema_version: 1`. Any other value — including a missing field or the string `"1"` — is `unsupported-schema-version` and the record is not read further.

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
| `scope` | `{ in_scope: string[], non_goals: string[] }` | |
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
| `failure_summary` | string | optional |

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
| `captured_at` | timestamp | |
| `digest` | | recomputed over `{ coverage, manifest, repository }` |

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
| `provenance` | `{ source, run_reference? }` | `run_reference` required for `ci-reported` |

`agent-claimed` is a legal record so that a claim can be kept and later contradicted; it satisfies no obligation (`OBSERVED_COLLECTORS` excludes it, and no obligation may name it as its minimum). A record containing `result: passed` is a proof only by its collector, never by its text.

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
| `human_note` | string | optional, verbatim from the person |

`receipt`: `{ request_id: acr_…, nonce, presentation_digest, channel, host, host_session?, issued_at, responded_at, authenticated, attestation }`. `channel` ∈ `mcp-elicitation` | `host-native` | `cooperative-file` | `agent-declared`. `authenticated` ∈ `none` | `host-session`; a `cooperative-file` or `agent-declared` receipt with anything but `none` is `invalid-value`. `responded_at` ≥ `issued_at`. `attestation` is the adapter's own plain-language statement of what it did and did not verify, shown to the reader of the record.

## Acceptance request (`acr_`)

Not a record kind; the object the core issues (`buildAcceptanceRequest`, pure) and the host presents. Stored by E06 under `requests/` so a receipt can be checked against it.

```text
{ schema_version: 1, id, change_id, slice_id, attempt_id, candidate_snapshot_id,
  candidate_digest, input_digest, nonce, issued_at, expires_at (> issued_at),
  presentation: { title, requested_outcome, slice_deliverable, candidate_summary,
                  proof_summary: { obligation_id, result, collector }[],
                  review_summary: { review_id, separation, remaining_blockers }[],
                  limitations: string[] },
  presentation_digest }
```

`candidate_summary` is `"<n> manifest entries (<f> files, <s> symlinks); <dirty|clean> tree at <head8>|no VCS; digest <full digest>"`. `limitations` are supplied by the gate and shown verbatim; they say what the evidence does not cover. The fixture `valid/acceptance-request.json` is byte-for-byte what `buildAcceptanceRequest` produces from the fixture bundle.

## Required records for acceptance

`ACCEPTANCE_REQUIRED_RECORDS` in `types.ts`; E06 implements the gate from this list and adds the live recheck.

| Record | Requirement |
|---|---|
| change | state `active`; every slice in the slice's `depends_on` is `accepted` |
| slice | state `active`; every `proof_obligations[].id` discharged |
| attempt | outcome `ready-for-review` or `needs-human-acceptance`; `candidate_snapshot_id` set |
| snapshot | baseline and candidate present; candidate `stability: stable`, `collector` ≠ `agent-claimed`; candidate digest equals the tree re-read at acceptance time |
| proof | one per obligation with `result: passed`, `collector` at or above the obligation's `minimum_collector` (`COLLECTOR_RANK`: `host-observed` 3 > `ci-reported` 2 > `manual-observation` 1 > `agent-claimed` 0, which satisfies nothing; `collectorSatisfies`), `snapshot_id` = the candidate |
| review | at least one with `separation: declared-separate`, bound to the candidate and input digests, `remaining_blockers` empty |
| approval | `decision: accepted`; receipt passes `evaluateApprovalReceipt` (trusted channel, known request, unconsumed nonce, all bindings equal) |

Missing any row is `blocked`/`needs-human-acceptance`, never `failed`, and never `accepted`. Old acceptance stays historical; it is not current approval for different bytes.

## Validation API

All pure; all deterministic (the same value yields the same error list, in traversal order).

| Function | Checks |
|---|---|
| `validateRecord(value)` / `validateRecordOfKind(kind, value)` / `parseRecord(text)` | one record: version gate, kind, shape, grammar, enums, its own cross-field rules |
| `validateChangeBundle({ change, slices, attempts, snapshots, proofs, reviews, approvals })` | every record, then references: unique IDs, `change_id` equality (`cross-change-reference`), slice deps/scenarios, snapshot roles and ownership, proof obligation/snapshot, review/approval candidate and digest bindings |
| `validateAcceptanceRequest(value)` | shape, `expires_at` > `issued_at`, presentation digest |
| `validateChangeRequest(value)` | one `codecarto_change` request: action, the action's fields only |
| `evaluateApprovalReceipt(approval, { request, consumed_nonces, attempt, candidate })` | the receipt against the issued request; see § Human approval |
| `buildAcceptanceRequest(args)` | the request from bound records; throws if the candidate is not the attempt's |

Result shape: `{ ok: true, value }` or `{ ok: false, errors: { code, path, message }[] }`, `path` a JSON-pointer-like location (`/manifest/3/path`). Error codes (closed set, `ENGINEERING_ERROR_CODES`): `invalid-request`, `invalid-action`, `unsupported-schema-version`, `unknown-field`, `missing-field`, `invalid-type`, `invalid-id`, `invalid-local-id`, `invalid-path`, `invalid-enum`, `invalid-digest`, `invalid-timestamp`, `invalid-value`, `digest-mismatch`, `duplicate-id`, `unknown-reference`, `cross-change-reference`, `invalid-state`, `invalid-transition`, `stale-revision`, `idempotency-conflict`, `not-found`, `proof-not-observed`, `blocking-objection`, `receipt-unknown-request`, `receipt-replayed`, `receipt-mismatch`, `receipt-expired`, `untrusted-channel`, `needs-human-acceptance`. `invalid-state`, `invalid-transition`, `stale-revision`, `idempotency-conflict`, `not-found`, `proof-not-observed`, `blocking-objection`, and `needs-human-acceptance` are reserved for the store, gate, and adapter (E02, E06, E07); the validators emit the others.

## Operation API: `codecarto_change`

One additive, experimental MCP tool (E07 registers it) over typed core operations. Requests are one object with an `action` discriminator; only that action's fields are accepted.

| Action | Arguments | Result |
|---|---|---|
| `create` | `title, mode, requested_outcome, baseline, scope, preserved_contracts, acceptance_scenarios, references?` | `{ change }` in state `draft` |
| `status` | `change_id?` | `{ changes: summary[] }` or one change's bundle plus corrupt-record report |
| `plan` | `change_id, expected_revision, brief_markdown?, plan_markdown?, slices: SliceInput[]` | `{ change, slices }`; stale `expected_revision` is `stale-revision` |
| `start-attempt` | `change_id, slice_id, baseline_snapshot: SnapshotInput, inputs: { brief_digest, plan_digest, references }, parent_attempt_id?` | `{ attempt, snapshot }` |
| `record-proof` | `change_id, attempt_id, proof: ProofInput` | `{ proof }` |
| `record-review` | `change_id, attempt_id, review: ReviewInput` | `{ review }` |
| `check` | `change_id, attempt_id?` | the gate's eligibility report (E06) |
| `request-acceptance` | `change_id, attempt_id, candidate_snapshot: SnapshotInput` | `{ outcome: accepted \| rejected \| needs-human-acceptance, request, approval?, reason? }` |

Mutating actions (all but `status` and `check`) accept `idempotency_key` (1–200 chars): a retry with the same key and payload returns the first result; the same key with a different payload is `idempotency-conflict`. A lost acknowledgement never implies re-running an external command.

Every result uses `ChangeResult`: `{ ok: true, action, result }` or `{ ok: false, action?, errors }`. The MCP adapter mirrors it in `structuredContent` and renders `text` from the same object, so both carry the same semantic result.

**Capability negotiation.** `HostCapabilities { human_acceptance: mcp-elicitation | host-native | none, label? }` is supplied by the adapter from what it knows about the transport (for MCP: whether the client declared the `elicitation` capability at initialize). It is not a request field: `host` on any request is `unknown-field`. A model cannot raise its own host's capability.

**No approval field.** There is no `approve` action. `approve`, `approved`, `approval`, `decision`, `receipt`, `human_accepted`, and any other field outside the table are `unknown-field` on every action. `request-acceptance` asks; it never grants.

## Human approval and threat boundary

### What is being protected

The claim "a person accepted exactly this candidate, having seen exactly this presentation". The assets are the binding (change, slice, attempt, candidate digest, input digest, presentation digest) and the channel through which the decision arrived.

### Actors and what they can do

| Actor | Can | Cannot (by this contract) |
|---|---|---|
| The model, through ordinary tool calls | call any `codecarto_change` action with any payload; write any file the host lets it write | put a decision into a request; mint an approval through the tool; raise host capability; change a nonce or presentation after issue |
| The host adapter (MCP server process, Pi extension) | issue requests, present them, obtain the decision on its own channel, mint the approval in-process | claim `authenticated: host-session` on a cooperative or agent-declared channel |
| The MCP client (Claude Code, Codex, Cursor, …) | answer `elicitation/create` after showing it to the user, or decline | be verified by the server to have actually shown it |
| A person at the keyboard | approve or reject in the host's UI; edit files on disk | be identified by name or credential — v1 has no identity |
| Any process running as the same OS user | write or edit anything under `.codecarto/engineering/` | be distinguished from the adapter by the bytes on disk |

### The receipt path

1. The gate (E06) verifies the required records and re-reads the candidate; on any gap it returns `blocked`/`needs-human-acceptance` and no request is issued.
2. The core builds an `AcceptanceRequest` with a fresh `acr_` ID and nonce, a bounded `expires_at`, and the presentation; the store durably writes it under `requests/` before anything is shown.
3. The adapter presents `presentation` verbatim through a channel the model does not control:
   - **`mcp-elicitation`**: the server sends `elicitation/create` (a server-initiated JSON-RPC request the SDK already supports as `elicitInput`) with a form whose only field is the decision plus an optional note. The client's UI shows it; the answer returns over the transport. The model's tool-call arguments are never the channel.
   - **`host-native`**: an in-process UI such as Pi's `ctx.ui.confirm` is called by the adapter's own code with the presentation.
4. The adapter — not the caller — mints the `ApprovalRecord` in-process with the receipt fields copied from the request and the decision copied from the channel, then stores it and marks the nonce consumed. The `request-acceptance` result carries the record.
5. Any later reader runs `evaluateApprovalReceipt` with the stored request and the consumed-nonce set.

### Rejections (each is a fixture under `tests/fixtures/engineering/v1/invalid/`)

| Situation | Refused as |
|---|---|
| Receipt names a request the store never issued | `receipt-unknown-request` |
| Nonce already bound to an approval (replay, duplicate ingestion, copied file) | `receipt-replayed` |
| Nonce, slice, attempt, snapshot, candidate digest, input digest, presentation digest, or issue time differs from the request | `receipt-mismatch` at that field |
| Approval, request, or attempt name different changes | `cross-change-reference` |
| Candidate re-read after presentation has a different digest (edited after proof/review) | `receipt-mismatch /candidate_digest` |
| Attempt re-bound to another candidate, or inputs changed | `receipt-mismatch` |
| Answered after `expires_at`, or decided outside the window | `receipt-expired` |
| Answered before issue | `receipt-mismatch /receipt/responded_at` |
| Candidate `unstable` or `agent-claimed` | `invalid-value /candidate_snapshot_id` |
| Channel `cooperative-file` or `agent-declared` | `untrusted-channel` |
| `approve: true`, `approval: {…}`, `decision`, `receipt`, or `host` in any request; `action: approve` | `unknown-field` / `invalid-action` |
| Untrusted channel claiming `authenticated: host-session` | `invalid-value /receipt/authenticated` |

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

## Compatibility

Additive only. No existing `.codecarto/` path, pipeline YAML, `status.yaml` field, phase prompt, `validatePhaseOutput` behavior, synthesis preflight, or Pi guard changes. `core/index.ts` gains one `export *`. The module graph test and every existing test are unchanged and green.

## Design notes

The paragraphs below are the reasoning behind the frozen rules; they are informative.

*Identity and freshness.* Record the Git base but never identify an implementation with HEAD alone: dirty tracked bytes, relevant untracked files, deleted files, executable bits, and symlink targets matter, which is why the manifest carries all of them and the digest covers the manifest. The engineering namespace and generated output are excluded from the implementation fingerprint to avoid self-invalidation; the brief, plan, and selected references form a separate input digest so that a changed plan invalidates acceptance as surely as a changed file. Unknown coverage is recorded, not assumed away. Capture must detect a moving source and record it as `unstable`; pre-acceptance recheck stops a candidate edited after proof from inheriting that proof. Resume locates existing attempts; it does not rerun external commands.

*Structure is not semantics.* The deterministic half checks record shape, reference existence, identity bindings, scenario coverage, dependencies, outcomes, objection dispositions, and receipt bindings. It does not claim to prove semantic correctness of code or tests. Independent review examines whether tests meaningfully exercise requested and preserved behavior; the record only carries the declaration of context separation. A blocking objection remains blocking until evidence resolves it — `deferred` still blocks, and v1 has no waiver path. The existing analysis `validatePhaseOutput` stays backward compatible; engineering gates use explicit records rather than a model-written PASS table.

*Why no extension bag.* A downstream implementer must be able to consume the schema without inventing fields; the cheapest way to make that true is for the validator to refuse fields it does not know. Amendments are cheap (a type, a fixture, a row here) and visible.

*Storage, security, export* (E02 and later). Reuse the atomic write, containment, and locking primitives where their contracts fit. Test truncated, cross-linked, and unsupported records; crashes before and after the commit point; duplicate requests; stale revisions; concurrent attempts. Raw stdout, environment variables, commands with embedded credentials, and private repository identity are not exportable by default; a retained log keeps the digest of its raw bytes distinct from the digest of its sanitized export. Export is an explicit reviewed operation, never a side effect of acceptance or library publication. No new database, network service, telemetry backend, provider dependency, release automation, or credential vault is needed for the first pilot.
