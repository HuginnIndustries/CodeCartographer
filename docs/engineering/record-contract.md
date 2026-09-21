# Engineering records: v1 contract

**Status:** candidate contract; **E01 acceptance pending** ([#399](https://github.com/HuginnIndustries/CodeCartographer/issues/399)). The executable form is `core/engineering/` (`types.ts`, `ids.ts`, `digest.ts`, `validation.ts`, exported through `core/index.ts`) and the fixtures under `tests/fixtures/engineering/v1/`; `tests/engineering-contract.test.mjs` pins every rule below. Where this page and the code disagree, the code and its fixtures are the contract and this page has a bug. Nothing here is frozen until #399 is closed: the [decision record](#decision-record) lists what is still open, and E02/E03 do not start before that. Once closed, a new field, enum value, or error code is a contract amendment that lands with a fixture and a change to this page. Read [vision](vision.md) and [implementation plan](implementation-plan.md) first.

The design rationale that preceded this candidate is kept in [§ Design notes](#design-notes) at the end. The sections before it are normative for the candidate.

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
| `attested_by` | `adapter` \| `caller` | adapter-set (see § Claims, observation source, and attestation); a snapshot is never a tool result, so `host-tool-result` is `invalid-enum`; only an `adapter` candidate can bind an acceptance |
| `captured_at` | timestamp | |
| `digest` | | recomputed over `{ coverage, manifest, repository }`; an error elsewhere on the record does not suppress a mismatch |

The engineering namespace and generated evidence are excluded from the manifest (they would self-invalidate); the brief, plan, and selected references are in `attempt.inputs` instead. The host collects; the framework validates and compares.

#### Collection semantics (E03)

`core/engineering/snapshots.ts` turns what a host observed into that identity. It is pure: the host walks the tree, this normalizes, excludes, orders, and judges coverage. `collectSnapshot` validates every path **before** deciding anything about it, refuses a duplicate path in any combination of kinds (a collector that reports one path twice cannot say what it saw), sorts the manifest in UTF-8 byte order, and records a symlink's link text without ever following it.

Order matters in one specific way: an absolute, traversing, or NUL-bearing string must be refused *before* it can be matched against an exclusion or a secret name, because the exclusion it would land in is itself inside the digest. The same applies to the inputs the caller supplies — `repository` is shape-checked rather than passed through, and an exclusion pattern the matcher cannot actually apply is refused instead of recorded, since a disclosure that is never honoured claims narrower coverage than the snapshot really has.

Two consequences of that rule are easy to miss, and both were real collisions before they were closed:

- **Nothing is coerced into an identity.** A non-boolean `executable` is refused, not read as `false`; a `head` that is not a string is refused, not stringified. Coercion means two different observations share one digest — exactly the failure the snapshot exists to prevent.
- **A path must be orderable.** `compareUtf8` encodes to UTF-8, which maps every unpaired surrogate to U+FFFD, so two distinct strings can compare equal. A comparator that is not a total order makes the manifest sort depend on enumeration order, and the same tree yields two digests. Paths and patterns carrying an unpaired surrogate or a literal U+FFFD are refused.

Exclusions are deduplicated by **pattern**, not by pattern-and-reason: one pattern has one meaning, and re-declaring a built-in rule under a different reason is a contradiction rather than a second coverage entry. A whole-tree `**` exclusion is refused outright — it would empty the manifest and give every repository the same identity.

| Rule | Why |
|---|---|
| `coverage` is inside the digest | A capture that quietly stopped covering a path would otherwise be byte-identical to one where the path was read and unchanged |
| An unreadable file becomes an `uncovered_relevant_input`, never an omission | The file we could not read is exactly the one whose change we would miss |
| A secret file is excluded by name and its digest is **never** recorded | A digest of a credential file is still an oracle for it; the exclusion is disclosed so the reader knows coverage is partial |
| `stability` is outside the digest | A re-capture of an unchanged tree must not look edited merely because the first capture raced |
| A non-empty `uncovered_relevant_inputs` blocks acceptance (`candidateMayBindAcceptance`) | The collector knows it did not look at something relevant, so an unchanged digest cannot mean an unchanged tree |
| An **absent or unreadable** `coverage` blocks acceptance too | A reader that cannot see the coverage cannot conclude the tree was fully observed; a degradation must lower trust, never raise it |
| The same exclusion declared twice is one exclusion | Otherwise an identical tree gets two identities depending on how the host phrased its configuration |

`diffSnapshots` explains what moved — added, removed, modified, mode-changed, type-changed, and coverage drift — so a freshness failure can be read by a person. It does not replace `checkCandidateFreshness`, which answers *whether* the tree moved; the gate uses that, the presentation uses this.

**Documented limitations.** Collection is only as honest as the host: a host that under-reports its own gaps produces a confident-looking snapshot, which is why `uncovered_relevant_inputs` blocks rather than warns. An excluded secret's *content* is outside the identity, so rotating a credential does not change the tree digest — the exclusion is disclosed instead. A symlink's target is recorded, never resolved, so a link pointing outside the repository is identified but its destination is not covered. Revalidation is conservative by construction: any doubt resolves to a different digest and a re-run, never to reuse.

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
| `provenance` | `{ source, run_reference?, attested_by, tool_call_id? }` | `run_reference` required for `ci-reported`; `attested_by` adapter-set — a caller cannot vouch for itself; `tool_call_id` required with, and only with, `host-tool-result`, from the host payload (`unknown-field` on requests); on a caller-reported record `source` is part of the claim |

`agent-claimed` is a legal record so that a claim can be kept and later contradicted; it satisfies no obligation (`OBSERVED_COLLECTORS` excludes it, and no obligation may name it as its minimum). A record containing `result: passed` is a proof only by its collector, never by its text — and its collector is only as good as `provenance.attested_by` says.

### Claims, observation source, and attestation

Three things are kept apart on every proof, and only their combination says what the record establishes:

| Layer | Field | Who writes it | What it means |
|---|---|---|---|
| The claim | `collector`, `result`, `exit_code`, `check`, `artifacts` | whoever supplied the record — on the tool path, the caller | what is *said* to have happened and how it was *said* to be observed |
| The attestation | `provenance.attested_by` | the adapter, never the payload (`unknown-field` on every input) | who can actually vouch for the claim: `adapter`, `host-tool-result`, or `caller` |
| The authority | `proofAuthority(proof)` — derived, not stored | the validator | `observed` only when the collector is an observed kind **and** the attestation is `adapter` or `host-tool-result`; otherwise `claimed` |

A caller-reported record is `claimed` whatever `collector` it names. Relabelling `agent-claimed` as `host-observed` changes the claim, not the authority; the test suite pins this for every collector value. Claimed records are retained — they are useful, contradictable history — but under the default policy they discharge nothing.

**What each attestation requires of the adapter:**

- `adapter` — the adapter itself produced the observation with its own read-only utilities: a snapshot of the working directory (E03), or a CI run it read from the CI system rather than from the caller's text (`ci-reported`), or a procedure it presented to a person in its own UI (`manual-observation`). The MCP server never runs commands, so `adapter` on a `host-observed` check is `invalid-value`.
- `host-tool-result` — the host's own tool-execution layer delivered the observation: a hook or extension event that receives the tool's actual exit code and output (a post-tool-use hook, or a Pi `tool_result` event in a future build mode) and submits it through a **host-side ingestion entry that the model's tools cannot reach**, configured **somewhere agent tools cannot write**. These are requirements for observed authority, not assurances: the adapter declares `HostCapabilities.tool_result_path` as `protected` only when both hold, and `attestationForHostObservation` yields `host-tool-result` for `protected` and `caller` for `unprotected`, `none`, or undeclared. An entry the model can invoke from its own shell tool with fabricated input, or a hook the model can install or edit (for example hook configuration in an agent-writable project file), is `unprotected`: what arrives that way is `caller`. The host payload carries the executed command, working directory, exit code, an output digest, and the host's tool-call identifier; the adapter fills `check.command`, `check.working_directory`, `exit_code`, and `provenance.tool_call_id` from that payload, never from the caller. `host-tool-result` attests `host-observed` checks only (`invalid-value` otherwise) and requires `tool_call_id`. E05 defines the entry and must demonstrate the unreachability; this contract fixes what the record must carry. CodeCartographer executes nothing on any surface.
- `caller` — the values arrived in `record-proof`. On MCP v1 without a qualifying host hook this is every proof.

**Discharge rule** (`proofDischarges(proof, obligation, policy)`): `result: passed`, the right `obligation_id`, `collectorSatisfies` the obligation's minimum, and — under the `verified` policy — authority `observed`. See § Assurance policy for the only way a claim can count.

The **candidate snapshot** must be `attested_by: adapter`: the adapter re-reads the tree itself (`request-acceptance` carries no snapshot; a caller-supplied `capture-candidate.snapshot` is ignored whenever the adapter can read the working directory, is recorded `caller` otherwise, and never binds an acceptance).

### Assurance policy

`verified` is the default and the only meaning of "verified" in this contract: observed proof for every obligation, an adapter-captured candidate, a decision on a trusted channel whose host/client pair passed the integration check, and a host-enforced storage boundary at mint time and at read time.

`cooperative` is a separate, weaker policy under which claimed proofs may discharge obligations and an unprotected namespace is tolerated. It exists so that a host with no tool-result path can still run the loop honestly. It is **not** the default, it is **never** spelled "verified", and it is chosen by the host operator in host/user-level configuration outside the workspace (`HostCapabilities.assurance_policy`) — a request cannot select it (`unknown-field`), and the pilot does not authorize it until the maintainer says so (§ Decision record). Every artifact produced under it says so: the presentation's `assurance`, the approval's `assurance`, `CheckResult.assurance`, and the `standardLimitations` lines. Under `cooperative`, `proofDischarges` still applies `collectorSatisfies` to the caller's *claimed* collector, so an honestly labelled `agent-claimed` record discharges nothing while the same record relabelled `host-observed` would; whether that is the intended reading of a cooperative claim, or whether all caller-reported records should count equally there, is D5's to settle.

### review (`rvw_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `attempt_id` | | |
| `candidate_snapshot_id`, `candidate_digest`, `input_digest` | | must equal the attempt's bound candidate, its digest, and the attempt's input digest (bundle check: `invalid-value` / `digest-mismatch`) |
| `reviewer` | `{ context, separation, label, note? }` | `context` ∈ `separate-session` \| `separate-agent` \| `human` \| `same-session`; `separation` ∈ `declared-separate` \| `same-context`; `same-session` + `declared-separate` is `invalid-value` |
| `objections` | `{ id, severity, statement, evidence, disposition, resolution_evidence?, disposition_note?, class_sweep? }[]` | unique `id`; `evidence` non-empty; `severity` ∈ `blocking` \| `advisory`; `disposition` ∈ `open` \| `resolved` \| `withdrawn` \| `deferred`; `resolution_evidence` present iff `resolved` |
| `objections[].class_sweep` | `{ class_statement, instances: { locus, disposition, note? }[] }` | optional; when present `class_statement` is non-empty, `instances` is non-empty (a sweep that enumerated nothing is not a sweep), each `disposition` ∈ `closed` \| `out-of-scope`, and `note` is required for `out-of-scope` |
| `remaining_blockers` | LocalId[] | must equal exactly the `blocking` objections whose disposition is `open` or `deferred`, in objection order (`deriveRemainingBlockers`) — a hand-written empty list over an open blocker is `invalid-value` |
| `summary` | non-empty string | |

`separation` is a declaration the framework records. It is not authenticated and the review record cannot say it is.

`class_sweep` answers rubric gate **R11**. A fix that closes the reported instance while a sibling of the same kind sits one identifier away is the most common way a green-CI change stays broken — it happened in three consecutive review rounds on this project, most sharply when a test-isolation fix landed with `GIT_CONFIG_PARAMETERS` still live and the original failure reproduced byte-for-byte on the fixed branch. The field records the *class*, not the instance, and every place that class can occur in the changed surface, each closed or explicitly out of scope with a reason.

Four evasions are refused at the schema, because each lets the sweep be claimed without being done: an empty `instances` list, an `out-of-scope` instance with no `note`, a `note` on a `closed` instance (the field means *why this was not done*, so attaching it to finished work is a contradiction), and a repeated `locus` — listing one place five times is not enumerating a surface. The sweep is validated through the same object gate as every other record field, so a non-plain object and any key outside the shape are refused too; a hand-rolled first version accepted a prototype-backed sweep that validated `ok: true` and then serialized to `{}`, storing a record whose own bytes no longer validated.

**Nothing in the code enforces R11 itself.** The field is **optional**, and no derivation, cross-field rule, or gate requires it — unlike `remaining_blockers` one row above, which *is* derived and refuses a hand-written empty list over an open blocker. That is deliberate: R11 is an evaluator gate, and a review that omits the sweep is a valid record with an R11 finding against it, not a malformed one. Records written before R11 existed stay valid. What the schema guarantees is narrower than the gate: *if* a sweep is recorded, it cannot be a hollow one. Widening a fix without bound is its own defect; what R11 forbids is leaving the question unasked, since an implementer who never named the class cannot claim the remaining instances are out of scope.

### approval (`apr_`)

| Field | Type | Rule |
|---|---|---|
| `change_id`, `slice_id`, `attempt_id`, `candidate_snapshot_id`, `candidate_digest`, `input_digest` | | bound to the attempt (bundle check) and to the request (receipt evaluation) |
| `decision` | `accepted` \| `rejected` | |
| `decided_at` | timestamp | |
| `receipt` | see below | |
| `assurance` | `verified` \| `cooperative` | adapter-set from `HostCapabilities.assurance_policy`; `verified` requires `storage.boundary: host-enforced` and `receipt.verified_integration: true`, else `invalid-value` — a record may not call itself verified over an unprotected namespace or an unverified integration |
| `storage` | `{ boundary: host-enforced \| none, note }` | the boundary the adapter observed at mint time; readers re-check the current one (§ Channel trust versus at-rest trust) |
| `human_note` | non-empty string | optional, verbatim from the person |

`receipt`: `{ request_id: acr_…, nonce, presentation_digest, channel, host, client: { name, version }, host_session?, issued_at, responded_at, authenticated, verified_integration, attestation }`. `client.version` is required: the registry is keyed by exact version. `verified_integration` says whether `(host, client.name, client.version, channel)` was in `VERIFIED_ACCEPTANCE_INTEGRATIONS` at mint time; it is informational — a reader re-derives it against the current registry (`classifyAcceptance`), so a de-verified or re-versioned pair downgrades old approvals to cooperative. `channel` ∈ `mcp-elicitation` | `host-native` | `cooperative-file` | `agent-declared`. `authenticated` ∈ `none` | `host-session` and is determined by the channel: a trusted channel (`mcp-elicitation`, `host-native`) must say `host-session`, an untrusted one must say `none`; either mislabel is `invalid-value`. A malformed nonce is `invalid-value` (not `invalid-id`). `responded_at` ≥ `issued_at`. `attestation` is the adapter's own plain-language statement of what it did and did not verify, shown to the reader of the record.

## Acceptance request (`acr_`)

Not a record kind; the object the core issues (`buildAcceptanceRequest`, pure) and the host presents. Stored by E06 under `requests/` so a receipt can be checked against it.

```text
{ schema_version: 1, id, change_id, slice_id, attempt_id, candidate_snapshot_id,
  candidate_digest, input_digest, nonce, issued_at,
  expires_at (> issued_at, at most ACCEPTANCE_REQUEST_MAX_TTL_MS = 24 h later),
  presentation: { title, requested_outcome, slice_deliverable, candidate_summary,
                  assurance,
                  proof_summary: { obligation_id, result, collector, attested_by, authority }[],
                  review_summary: { review_id, separation, remaining_blockers }[],
                  limitations: string[] },
  presentation_digest }
```

`candidate_summary` is `"<n> manifest entries (<f> files, <s> symlinks); <dirty|clean> tree at <head8>|no VCS; digest <full digest>"`. `limitations` begin with the lines `standardLimitations({ proofs, reviews, candidate, assurance, storage_boundary })` derives from the records and the host state — a candidate that is not adapter-captured, stable, and observed; claimed-proof count ("…no observed execution backs them, whatever collector they name; under the verified policy they discharge nothing"); the cooperative policy when in force; an unprotected storage boundary; and "reviewer separation is declared by the review's author, not authenticated" — followed by whatever the gate adds; a caller can add lines, never remove the standard ones. The fixture `valid/acceptance-request.json` is byte-for-byte what `buildAcceptanceRequest` produces from the fixture bundle.

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
| proof | one per obligation that `proofDischarges` it: `result: passed`, `collector` at or above the obligation's `minimum_collector` (`COLLECTOR_RANK`: `host-observed` 3 > `ci-reported` 2 > `manual-observation` 1 > `agent-claimed` 0; `collectorSatisfies`), `snapshot_id` = the candidate, `scenario_ids` naming the obligation's scenario, and — under `verified` — `proofAuthority` of `observed`; a caller-reported record is `claimed` whatever its label and discharges nothing under `verified` |
| review | at least one with `separation: declared-separate`, bound to the candidate and input digests, `remaining_blockers` empty |
| approval | `decision: accepted`; receipt passes `evaluateApprovalReceipt` (trusted channel, known request, unconsumed nonce, all bindings equal); `classifyAcceptance` is `verified` — currently registered integration, `verified` policy, host-enforced boundary at mint, and the reader's out-of-namespace `CurrentStorage` host-enforced with `protection: continuous-since-initialization` — or, only under an operator-set `cooperative` policy, `cooperative` |

Missing any row is `blocked`/`needs-human-acceptance`, never `failed`, and never `accepted`. Old acceptance stays historical; it is not current approval for different bytes. An acceptance reached under `cooperative` is reported as cooperative in every result and record; "verified" is reserved for the full path.

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
| `proofAuthority(proof)` / `proofDischarges(proof, obligation, policy)` | `observed` vs `claimed`; whether a proof discharges an obligation under a policy |
| `acceptanceChannelSupported(capabilities [, registry])` | whether a decision may be asked for at all: a trusted channel **and** a registry entry in `VERIFIED_ACCEPTANCE_INTEGRATIONS` for this host/client pair **at the exact live client version** |
| `elicitationDecision(response)` | the outcome of an elicitation round trip, from `content.decision` only; a thrown response is `timed-out` only on the structured JSON-RPC code, never on error prose that merely contains the words |
| `acceptanceTtlWithin(request, integration)` / `checkAcceptanceRequestTtl(request, integration)` | the predicate, and the enforcement form `classifyAcceptance` calls: whether the request's TTL fits inside the client's observed request timeout. A `client_request_timeout_ms` that is not a finite positive number is not a measurement and fails closed — a numeric string, `Infinity`, or a one-element array would otherwise coerce past the comparison |
| `checkPresentationDisclosure(request, { proofs, reviews, candidate, assurance, storage_boundary })` | whether the presentation the person answered carried every line `standardLimitations` requires for this state, and named the policy the acceptance is read under. Extra disclosure is allowed; less is not. Called by `classifyAcceptance` |
| `classifyAcceptance(approval, context + current_storage + proofs + reviews [+ integrations])` | `verified` / `cooperative` / `invalid` for the reader, now: re-derives the integration from the registry; refuses a tuple registered more than once and enforces the TTL against the **strictest** matching entry; re-derives the presentation's disclosure from the bound `proofs`/`reviews`, which are **required** for a `verified` reading; requires `current_storage.protection` of `continuous-since-initialization` (a record-internal timestamp never substitutes) |
| `attestationForHostObservation(capabilities)` | `host-tool-result` only for a `protected` tool-result path; otherwise `caller` |

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
| `check` | `change_id, attempt_id?` | `CheckResult { outcome: eligible \| blocked \| needs-human-acceptance \| accepted, assurance, evidence: { observed, claimed }, requirements: AcceptanceRequirementStatus[], errors, next: { action, reason } }` — one requirement row per entry of the acceptance table |
| `request-acceptance` | `change_id, attempt_id` | `{ outcome: accepted \| rejected \| needs-human-acceptance, assurance, request, approval?, reason? }` — the adapter re-reads the tree and runs `checkCandidateFreshness` before presenting anything; `acceptanceChannelSupported` false is `needs-human-acceptance` with its reason |

Mutating actions (all but `status` and `check`) accept `idempotency_key` (1–200 chars): a retry with the same key and payload returns the first result; the same key with a different payload is `idempotency-conflict`. A lost acknowledgement never implies re-running an external command.

Every result uses `ChangeResult<A>`: `{ ok: true, action, result: ChangeResults[A] }` or `{ ok: false, action?, errors }`; `ChangeResults` in `types.ts` maps each action to its result payload. The MCP adapter mirrors it in `structuredContent` and renders `text` from the same object, so both carry the same semantic result.

**Capability negotiation.** `HostCapabilities { human_acceptance, label?, client?, verified_integration, storage_boundary, assurance_policy, tool_result_path }` is supplied by the adapter per session: `human_acceptance` from the transport (for MCP: whether the client declared `elicitation.form` at initialize), `client` from the transport's client info, `verified_integration` from `VERIFIED_ACCEPTANCE_INTEGRATIONS` and nothing else, `storage_boundary` and `assurance_policy` from host/user-level configuration outside the workspace. `tool_result_path` from whether D4's requirements hold. None is a request field: `host`, `assurance`, `verified_integration`, `storage`, `attested_by`, `tool_result_path`, `current_storage`, and `protection` on any request are `unknown-field`. A model cannot raise its host's capability, declare its integration verified, pick a policy, or vouch for its own proof.

**No approval field.** There is no `approve` action. `approve`, `approved`, `approval`, `decision`, `receipt`, `human_accepted`, `attested_by`, and any other field outside the table are `unknown-field` on every action. `request-acceptance` asks; it never grants.

## Human approval and threat boundary

### What is being protected

The claim "a person accepted exactly this candidate, having seen exactly this presentation". The assets are the binding (change, slice, attempt, candidate digest, input digest, presentation digest) and the channel through which the decision arrived.

### Actors and what they can do

| Actor | Can | Cannot (by this contract) |
|---|---|---|
| The model, through ordinary tool calls | call any `codecarto_change` action with any payload — including a proof whose `collector` says `host-observed`; write any file the host lets it write | put a decision into a request; mint an approval through the tool; raise host capability; declare its integration verified or pick the assurance policy; vouch for its own claims (`attested_by`) or turn a claim into an observation by relabelling it; supply the candidate the gate accepts; change a nonce or presentation after issue |
| The host adapter (MCP server process, Pi extension) | issue requests, present them, obtain the decision on its own channel, mint the approval in-process | claim `authenticated: host-session` on a cooperative or agent-declared channel |
| The MCP client (Claude Code, Codex, Cursor, …) | answer `elicitation/create` after showing it to the user, or decline | be verified by the server to have actually shown it |
| A person at the keyboard | approve or reject in the host's UI; edit files on disk | be identified by name or credential — v1 has no identity |
| Any process running as the same OS user | write or edit anything under `.codecarto/engineering/` | be distinguished from the adapter by the bytes on disk |

### The receipt path

1. The gate (E06) verifies the required records, then the adapter re-reads the tree and runs `checkCandidateFreshness` against the bound (adapter-attested) candidate; on any gap or a moved tree it returns `blocked`/`needs-human-acceptance` and no request is issued.
2. The core builds an `AcceptanceRequest` with a fresh `acr_` ID and nonce, a bounded `expires_at`, and the presentation; the store durably writes it under `requests/` before anything is shown.
3. If `acceptanceChannelSupported(capabilities)` is false — no channel, or a host/client pair not in `VERIFIED_ACCEPTANCE_INTEGRATIONS` — the outcome is `needs-human-acceptance` with the reason and nothing is presented. Otherwise the adapter presents `presentation` verbatim through a channel the model does not control:
   - **`mcp-elicitation`**: the server sends `elicitation/create` (a server-initiated JSON-RPC request; SDK 1.30's `Server.elicitInput`, which requires the client to have declared the `elicitation.form` capability at initialize) with a form whose only field is the decision plus an optional note. The client's UI shows it; the answer returns over the transport as the client's JSON-RPC response. The model's tool-call arguments are never the channel.
   - **`host-native`**: an in-process UI such as Pi's `ctx.ui.confirm` is called by the adapter's own code with the presentation.
4. The adapter — not the caller — mints the `ApprovalRecord` in-process with the receipt fields copied from the request, the decision copied from the channel, and `assurance`/`storage` copied from its own capabilities; runs `evaluateApprovalReceipt` against the nonces already bound by *other* approvals; and only then stores it. The `request-acceptance` result carries the record and its `assurance`.
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
| Approval labelled `verified` over `storage.boundary: none` or `verified_integration: false` | `invalid-value` at that field |
| Channel on a host/client pair absent from `VERIFIED_ACCEPTANCE_INTEGRATIONS` | `acceptanceChannelSupported` false → `needs-human-acceptance` |
| Caller-reported proof relabelled `host-observed` | `proofAuthority` stays `claimed`; `proofDischarges` false under `verified` |
| `host-tool-result` on anything but a `host-observed` check, or without `tool_call_id`; `adapter` on a `host-observed` check; `tool_call_id` on a caller record | `invalid-value` / `missing-field` at `/provenance/…` |
| Approval read under a boundary of `none`, or under a boundary whose `protection` is anything but `continuous-since-initialization` — including a pair forged while unprotected with times chosen to post-date a later epoch | `classifyAcceptance` → `cooperative` |
| Proof ingested through an `unprotected` or undeclared tool-result path | `attested_by: caller`; `proofAuthority` `claimed` |
| Receipt's `(host, client, channel)` absent from the current registry, whatever `verified_integration` says | `classifyAcceptance` → `cooperative` |

### What is attested versus authenticated

| Channel | Authenticated | Attested by the adapter | Not established |
|---|---|---|---|
| `mcp-elicitation` | the answer arrived over the same transport session that issued the request (`host-session`) | the client declared the elicitation capability and returned `accept` with the decision | that the client showed the form to a person rather than auto-answering; who the person is |
| `host-native` | the adapter's own UI call returned in-process (`host-session`) | the adapter presented the request in its UI | who the person is; that nobody else was at the keyboard |
| `cooperative-file` | nothing (`none`) | nothing | anything — a useful note, never acceptance |
| `agent-declared` | nothing (`none`) | nothing | anything — kept only so the refusal can name it |

Hashes prove identity of bytes, not human intent. A reviewer ID string proves nothing about independence. Neither channel authenticates a person; v1 deliberately has no `user-identity` value and no credential, token, or signature stored in `.codecarto/`.

### Unsupported hosts

An adapter for which `acceptanceChannelSupported` is false — `human_acceptance: none` (an MCP client without elicitation, a headless run, a drop-in template) **or** a channel on a host/client pair that has not passed the integration check — returns `{ outcome: "needs-human-acceptance", assurance, request, reason }` from `request-acceptance`. The request is stored, the attempt becomes `needs-human-acceptance`, and nothing is minted. A person may later accept through a supported host against the same request while it is unexpired; the acceptance still binds to the same candidate digest, so any edit in between is refused. The template surface documents the procedure and cannot claim enforcement.

### Acceptance channel: a conditional pilot policy

MCP elicitation and Pi's native confirm are the *proposed* trusted channels. Neither is approved for the pilot yet, and a client advertising a capability is not a supported client. The policy, pending the maintainer's decision:

- Support is per **verified host/client combination at an exact client version**, recorded in `VERIFIED_ACCEPTANCE_INTEGRATIONS` (`types.ts`; empty today). `acceptanceChannelSupported` consults that list and nothing else; an adapter's own `verified_integration: true` without a registry entry, or a live `clientInfo.version` that differs from the entry's, is unsupported.
- The decision derives only from `content.decision` (`elicitationDecision`); `action` alone never authorizes; a submitted form with a missing or unrecognized decision is `invalid`; a timeout is `timed-out`, not a decline. The adapter's TTL stays below the client's observed request timeout.
- An entry is added only by a contract amendment attaching evidence of a real integration check on the actual client at the recorded version: (1) the presentation was shown to a person as issued; (2) an acceptance came back and minted a bound approval; (3) a rejection and a cancellation/decline each came back as `rejected`/`declined` with nothing minted; (4) a stale response (after `expires_at`) and a mismatched response (different nonce or presentation digest) were each refused by `evaluateApprovalReceipt` and nothing was minted; (5) the client's request timeout was observed and recorded as `client_request_timeout_ms`.
- Unsupported or unverified paths stop at `needs-human-acceptance`. They never downgrade the requirement and never mint.
- Even on a verified integration the claim is *host/session-attested*: the answer came through the client over the session that issued the request. No channel in v1 authenticates a human identity, and the records say so (`receipt.authenticated`, `receipt.attestation`).

### Channel trust versus at-rest trust

A legitimate UI interaction says something about the moment of decision. It says nothing about the file that records it afterwards. The two are kept apart:

| Question | Answered by | Field |
|---|---|---|
| Did the decision enter through a channel the model does not control? | the channel and its integration check | `receipt.channel`, `receipt.verified_integration` |
| Can ordinary agent tools rewrite the record now? | the host's permission layer, not the channel | `storage.boundary` at mint; `HostCapabilities.storage_boundary` at read |
| Under what policy was "accepted" produced? | host/user-level configuration | `assurance` |

`classifyAcceptance(approval, context)` is how a downstream reader (E06's gate, E07's status, E08's resume) tells them apart. It is `verified` only when the receipt binds; the receipt's `(host, client.name, channel)` is in `VERIFIED_ACCEPTANCE_INTEGRATIONS` **now**; the policy was `verified`; the record says the boundary was host-enforced at mint; **and** the reader's `CurrentStorage` — from host configuration outside the namespace — is `{ boundary: "host-enforced", enforced_since, protection: "continuous-since-initialization" }`. Any other bound receipt is `cooperative`; a receipt that does not bind is `invalid`. A real elicitation answer stored in a namespace agent tools can write is therefore `cooperative` — the channel does not protect the file, and neither `host-native` nor `mcp-elicitation` implies that it does.

### Protection before authoritative initialization

The proposed initial policy: **a namespace is authoritative only if the storage boundary was enforced before its first write and has never lapsed since.** Nothing weaker survives this counterexample: while the namespace is unprotected, an agent pre-writes a request/approval pair whose `issued_at`, `responded_at`, and `decided_at` are chosen to post-date the epoch at which the operator will later enable protection. Every timestamp a reader might compare is inside the records the agent wrote. Comparing `decided_at` with `enforced_since` therefore proves nothing; neither does any other timestamp or flag in the record set, and the fix is not to trust one more of them. The test suite runs exactly this forgery and requires `cooperative`.

So `CurrentStorage.protection` is the host's account, kept outside the namespace, of the whole history:

| `protection` | Meaning | Every record in the namespace is |
|---|---|---|
| `continuous-since-initialization` | the namespace was created after the boundary was enforced, and the boundary has not lapsed since | eligible for `verified` (subject to the other legs) |
| `enabled-after-initialization` | the boundary was enabled on a namespace that already held records | `cooperative` |
| `interrupted` | the boundary lapsed at any point (disabled, permission rule removed, namespace restored or moved) | `cooperative` |
| `imported-history` | records were imported, restored from backup, or edited outside the adapter | `cooperative` |

Existing unprotected records never become `verified` because protection is enabled later; the way to an authoritative namespace is to initialize a fresh one under protection. An interruption is permanent for that namespace. The `decided_at`-before-`enforced_since` comparison is kept only as a consistency check — under continuous protection no record can legitimately predate the epoch — and it can lower trust, never establish it. A context that omits `protection` fails closed.

**Mechanism decision (D3), answered:** this contract fixes what the reader must be told and what it does with it. How the host establishes and keeps `protection` — where the initialization marker and the boundary's history live so that agent tools cannot write them, how a lapse is detected and recorded, how a fresh namespace is initialized under protection — is a host mechanism. **It was investigated against Claude Code 2.1.277 under [E12](https://github.com/HuginnIndustries/CodeCartographer/issues/418) and the answer is that this host cannot provide it.** The epoch check does not solve it and this contract does not claim it does.

What the investigation established, in the order it matters:

- **A `SessionStart` hook cannot observe the boundary.** Its payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `source` — no permission mode, no settings paths, no sandbox state. Hooks run *outside* the sandbox, so the hook's own write into the protected path succeeds and proves nothing. The initialization-marker candidate recorded here previously is **withdrawn**, not deferred.
- **A per-call boundary check does exist.** A `PreToolUse` hook can rewrite every Bash invocation through `updatedInput` to prefix a probe that runs *inside* the sandbox and reads `/proc/self/mountinfo`. Observed fail-closed in both directions: boundary in force → `PostToolUse`, exit 0; boundary absent → `PostToolUseFailure`, exit 97. This is genuine kernel-sourced evidence the model did not author.
- **It is not continuity, and it has preconditions.** The probe answers "was the boundary in force for *this call*", never "has it held since initialization": a session launched without the protected settings source runs no hooks and leaves **no negative record at all**. Silent absence of evidence is not evidence of absence. Its preconditions are also wider than E5's — the probe calls `grep` and reads `$SANDBOX_RUNTIME`, and a shell function can shadow either, so the developer's rc files and shell-snapshot directory must be inside the protected set or the probe must depend on nothing the environment can redefine.
- **A consumer of that probe must key on the event kind and exit status, never on marker text.** A model can print any marker it likes; appended command text can also make the compound command a *syntax* error, which exits non-zero without the probe ever running. The only sound rule is `PostToolUse` with exit 0, and anything else — non-zero, a failure event, or an absent event — is unverified.

**The only routes that could ever make `verified` reachable** are platform-administrator attestations, not host self-reports: **managed settings** (root-owned policy files that a `--settings` argument cannot override) and **`auditd`** on the namespace (which yields a real no-lapse record, though only since the watch started, never since initialization). Neither has been tested. A host claiming continuity on any other basis is claiming something it cannot know.

The **same rule governs proofs**: a proof file attested `host-tool-result` is in the same writable namespace, so its attestation is only as good as the namespace's protection history. A `host-tool-result` record under anything but `continuous-since-initialization` is byte-indistinguishable from a forgery. E01 encodes this on approvals (`classifyAcceptance`); for proofs it is an **E06 requirement**: the gate evaluates `proofDischarges` under `verified` only when the reader's `CurrentStorage.protection` is `continuous-since-initialization`, and treats the whole namespace as cooperative otherwise. The forgery could not coexist with a truthful `continuous-since-initialization` — that value means no unprotected write ever happened — which is why the host's attestation, and not anything in the record, is what carries `verified`.

The declarations themselves — `storage_boundary`, `enforced_since`, `protection`, `tool_result_path`, `assurance_policy`, and the registry-derived `verified_integration` — are only as trustworthy as where they live. "Host/user-level configuration outside the workspace" is not automatically beyond an agent with a shell tool. **D3 asked for such a location and the answer for this host is that none exists** (see the decision record below): the E5/E6 configuration gives a real *boundary*, so `storage_boundary: host-enforced` is honest for the namespace's contents, but it does not give a protected home for the declarations' own history, which is why `protection` never reaches `continuous-since-initialization` here. A host that cannot name such a location declares `storage_boundary: none`; a host that has the boundary but not the history declares `host-enforced` and lives with `cooperative`.

A host-enforced boundary means the host's own permission layer denies the agent edit/write access to `.codecarto/engineering/` (for an MCP client, a permission rule the user configures in the client; the server cannot enforce it, because the model writes through the client's tools) or the namespace lives outside every agent-writable root. It is declared by the adapter from host configuration and is never a request field. The Pi analysis guard is unchanged by E01 (EV-D03): it confines agent writes to `.codecarto/`, which *includes* the engineering namespace, so a Pi session today has `storage_boundary: none` and any acceptance read there is `cooperative`. Whether and how a Pi build mode narrows that is a separate guard-policy decision (E08), not something this contract assumes.

### The same-user filesystem limitation

Every record, including approvals, requests, and consumed nonces, is a file the same OS user can write. In-session, the channel guarantee holds: a decision cannot enter through the model's tool arguments. At rest, with `storage_boundary: none`, an approval minted by the adapter and one written by hand are byte-indistinguishable; the validators cannot tell them apart and this contract does not claim they can. That is exactly why `classifyAcceptance` refuses to call such a record `verified` — the caveat is not used to satisfy the stronger requirement. Tamper evidence at rest (a signature under a key the adapter holds outside the workspace) is a possible later addition and is explicitly out of v1; it must not be a homemade credential system or a token stored in `.codecarto/`.

### Decision record

The design above is a candidate. The maintainer recorded the following on 2026-09-18 after the [Claude Code 2.1.263 spike](spike-claude-code-2026-09-18.md). E01 stays open until the D1 live check passes; E02/E03 stay blocked until E01 closes; E09 stays on maintainer hold. Nothing below registers an integration or changes code.

| # | Question | Decision (2026-09-18) | What the contract does |
|---|---|---|---|
| D1 | Is MCP elicitation on a specific verified host/client pair an acceptable pilot channel? | **Yes** for the named pair **claude-code/2.1.277 with the codecarto MCP server**, session-attested and not authenticated human identity. The maintainer ran the live interactive check on 2026-09-18 (§ D1 live check below); it passed. Conditional on three items, all now in the contract: (a) the **version-match check** — the adapter compares the live `clientInfo.version` against the registered `client_version` at session start and falls back to `needs-human-acceptance` on any mismatch; (b) the **`content.decision` rule** — the decision derives only from `content.decision`, `action` alone never authorizes, and a submitted form with a missing or unrecognized decision is not an acceptance; (c) the **operator attestation** that no `Elicitation` or `ElicitationResult` hooks are configured in any merged settings source — the adapter cannot verify this (it cannot see hooks), so the receipt's `attestation` text must disclose that it rests on the operator's claim. **Register the pair only after (a)–(c) are implemented and tested**; they are, in `acceptanceChannelSupported`, `elicitationDecision`, and the fixtures under `valid/elicitation/`, so the entry may be added by amendment with the live-check evidence attached. | registry still empty pending that amendment; `request-acceptance` → `needs-human-acceptance` |
| D2 | Is Pi `host-native` an acceptable pilot channel? | **Deferred.** No second channel is built for the pilot. | same as D1 |
| D3 | Which storage-boundary and protection-history mechanism will the pilot host provide? | **Boundary accepted:** the E5/E6 configuration (OS sandbox with `denyWrite` on the namespace, the ingestion entry, and the settings file; matching deny rules; hardened hook) is the session-level mechanism and yields `storage_boundary: host-enforced`. **Continuity: answered NO** (E12/#418, investigated on 2.1.277). The `SessionStart` initialization-marker candidate is **withdrawn** — that hook cannot observe sandbox state at all. A `PreToolUse` kernel probe gives genuine *per-call* boundary verification, fail-closed, but says nothing about initialization order or cross-session continuity. Only managed settings or `auditd` could ever reach `verified`, both as platform-administrator attestations; neither tested. | `protection` is never `continuous-since-initialization` on this host; `classifyAcceptance` → `cooperative` |
| D4 | What counts as a protected observed-evidence path? | **Accepted:** "user or managed settings + no `bypassPermissions`" is protected configuration, together with the full E5/E6 requirement list — everything the unsandboxed hook reads, executes, **and writes** is protected; fresh uniquely named files opened `O_CREAT\|O_EXCL`; nothing sourced. **E5 and E6 must be re-run wherever the real ingestion entry is placed**, and on the client version the pilot actually runs (they were re-run on 2.1.277 on 2026-09-18 with identical results; see the spike report). | `tool_result_path: protected` only for such a configuration; `attestationForHostObservation` → `host-tool-result` |
| D5 | Is the `cooperative` policy permitted for the pilot? | **No.** `assurance_policy` stays `verified`, so only `observed` proofs discharge obligations. | `proofDischarges` refuses claims; `cooperative` stays unauthorized |

**Consequence, stated plainly:** with D3 answered *no* and D5 answered no, the pilot runs with **genuinely observed proofs** (host-tool-result under the E6 configuration) and **acceptances that classify `cooperative`** (no continuity attestation, and no registry entry until D1's live check). That is the intended, honest outcome and needs no code change. D3 is now settled rather than pending: `verified` is unreachable on this host by design of the host, not by an unfinished decision, and E02 must not carry a placeholder for a continuity mechanism that does not exist. **Scoping requirement for E06:** the gate *surfaces* the `cooperative` classification in its result — `CheckResult.assurance`, the presentation's `assurance`, the `standardLimitations` lines — rather than refusing to proceed; `verified` remains unreachable until the host provides continuity.

#### D1 live check (maintainer, 2026-09-18, claude-code 2.1.277)

Run interactively by the maintainer on the spike host against the spike MCP server; log of five lines (`sha256 cc4bb665…`), paired against what was seen on screen (screenshots held locally, not published). The dialog showed the message verbatim — `SPIKE: accept or reject this candidate? (nonce 0123456789abcdef)` — with a required `Decision` field.

| # | Time (UTC) | Event | Contract consequence |
|---|---|---|---|
| 1 | 21:29:05 | `initialize` — client `claude-code` **2.1.277** | the host had auto-updated from 2.1.263 three minutes earlier; see *registry design gap* |
| 2 | 21:31:42 | `elicit` threw `MCP error -32001: Request timed out` (~2.5 min, while the UI was being worked out) | failed closed, nothing minted — correct — but the server cannot tell a timeout from a decline; see *timeout* |
| 3 | 21:32:35 | `action: accept`, `content.decision: accept` | accepted |
| 4 | 21:35:20 | `action: accept`, `content.decision: reject` | **rejected** — the form-level Accept button submitted a form whose Decision was reject; see *action vs decision* |
| 5 | 21:35:35 | `action: decline`, no content | declined (dismissed); not a decision |

Three findings, each now in the contract:

- **Registry design gap: version drift.** A client updates itself; a version-pinned registry entry goes stale silently. `VerifiedAcceptanceIntegration.client_version` is exact, `acceptanceChannelSupported` refuses any live `clientInfo.version` that differs from it (and a client that reports no version), and `classifyAcceptance` re-derives against `(host, client, client_version, channel)` so a receipt minted on another version classifies `cooperative`. The receipt's `client.version` is required. Contract test: registered 2.1.263, live 2.1.277 → unsupported with both versions named.
- **Timeout is a third outcome.** `ElicitationOutcome` has `timed-out` distinct from `rejected`, `declined`, and `cancelled`; `AcceptanceRequestOutcome.outcome` carries `declined` and `timed-out`; neither mints a record. The request's TTL must be shorter than the client's request timeout (`VerifiedAcceptanceIntegration.client_request_timeout_ms`, observed ~150 s on this pair), **and the rule is enforced in `classifyAcceptance` via `checkAcceptanceRequestTtl`, not left to an adapter that is trusted to call a helper**: a window that outlives the client's timeout reads `cooperative`, and an entry that never recorded a timeout fails closed, because an unmeasured client bounds nothing. The adapter should also pass that TTL as the `elicitInput` request timeout so the server-side error is deterministic. A person at an approval prompt routinely takes minutes; E06's TTL for this channel is bounded by the client, not by the 24 h contract maximum. A thrown response is read as a timeout only on the structured JSON-RPC code (`JSONRPC_REQUEST_TIMEOUT_CODE`), since error prose is host-formatted and can quote caller text.
- **An honest presentation is enforced, not merely composed.** `buildAcceptanceRequest` prepends `standardLimitations`, but the presentation digest only proves the person saw *a* presentation — not a truthful one. A request minted by any other path could show an empty `limitations` list over a caller-reported proof or an unprotected namespace, validate byte-for-byte, and bind a receipt. `classifyAcceptance` therefore re-derives the required disclosure from the records the acceptance binds to (`checkPresentationDisclosure`) and refuses `verified` when a required line was withheld or the presentation named a different policy than the acceptance is read under. The bound `proofs` and `reviews` are **required in the context**: a reader that omits them cannot re-derive the proof and reviewer lines, so the reading degrades to `cooperative` with an explicit reason rather than silently narrowing to the lines that happen to be derivable. Pass `[]` to assert there are none. A degradation must lower trust, never raise it — "the reader is trusted to pass the records" is the same defect as "the adapter is trusted to call the helper", one level down.
- **Registry shape is checked, not assumed.** A host/client/version/channel tuple must be registered exactly once: with duplicates, array order would decide which timeout applies, so `classifyAcceptance` names the duplication as a reason and evaluates the TTL against the strictest matching entry — an entry that never measured a timeout cannot be sidestepped by a sibling that did. The registry is adapter-supplied data, so `client_request_timeout_ms` is type-checked before it is compared.

**Known limitation (not enforced).** The disclosure check compares required lines by exact string equality, so a presentation may carry every required line *and* additional text that contradicts them ("disregard the note above"). The validator cannot distinguish clarification from contradiction; "extra lines allowed" is deliberate, and reviewing presentation copy for honesty is an operator responsibility the contract does not automate.
- **Action and decision can disagree — observed, not theoretical.** `elicitationDecision` derives the outcome only from `content.decision`: `accept`/`accept` → accepted, `accept`/`reject` → rejected, `decline` → declined, `cancel` → cancelled, `-32001` → timed-out, and `accept` with a missing, empty, or unrecognized decision → **invalid**, never an acceptance. The client enforced the required field in the live check; that is client behaviour the adapter must not assume. Fixtures for every shape are under `tests/fixtures/engineering/v1/valid/elicitation/`, the first three verbatim from the log. UI note for the presentation: the Decision field defaulted to "not set" and the first free-text field swallowed an answer typed into it; the presentation text must make the required field unambiguous, and `accept-decision-in-note` is a fixture.

**Forward-looking notes from the spike** (not blockers; binding on the issues named):

- **E02/E05 — record parsing scope.** Under the E6 configuration, `hook-logs/*.err` and `*.status` sit inside the evidence namespace and `.err` contains text derived from the model's own command output. E02 and E05 must not parse `.err` or `.status` as records; record parsing is scoped to the inbox's record shape (`validateRecord` on `inbox/*.json` only), and everything else in the namespace is opaque to the store.
- **E05 — retention.** The model can trigger unbounded hook writes (one inbox file and two log files per Bash call) into a namespace it cannot clean. E05 needs retention/rotation for the inbox and `hook-logs/`, performed by the adapter or the hook, never by the model.
- **Per-host `O_EXCL` proof.** `/usr/bin/sh` is bash on the spike host and dash on Debian-family hosts; the `set -C` → `O_CREAT|O_EXCL` behaviour was proved on this host only. Re-prove it alongside E5/E6 on the real pilot host, or open with `O_EXCL|O_NOFOLLOW` from a program rather than relying on the shell.

Spike evidence against one host (Claude Code 2.1.263, re-run on 2.1.277) for D1, D3, and D4 is in [spike-claude-code-2026-09-18.md](spike-claude-code-2026-09-18.md); it registers nothing. Which clients implement form elicitation beyond that pair is not settled by this contract.

## What the code proves and what the host must enforce

| The validators and tests prove (pure, against fixtures) | The eventual host must enforce (D1–D5; nothing here checks it) |
|---|---|
| No `codecarto_change` request can carry a decision, an attestation, a policy, a capability, a storage boundary, a protection history, or a tool-result path; all are `unknown-field`. | That the adapter, not the model, supplies those values from configuration the model cannot write. |
| A caller-reported proof is `claimed` under every collector label and discharges nothing under `verified`; only `host-tool-result`/`adapter` attestation on an observed collector is `observed`. | That `host-tool-result` is set only through an ingestion entry unreachable by the model, configured outside agent-writable roots (`tool_result_path: protected`). |
| `acceptanceChannelSupported` refuses every host/client pair absent from the registry, which is empty. | Running the integration check and amending the registry with its evidence; showing the presentation to a person. |
| `classifyAcceptance` is `verified` only with a bound receipt, current registry membership, the `verified` policy, and `protection: continuous-since-initialization`; the forged pre-dated pair, an enabled-later boundary, an interruption, imported history, and an omitted history all classify `cooperative`. | Actually denying agent writes to the namespace; initializing the namespace only after protection; keeping the initialization marker and lapse history where agent tools cannot write; reporting `protection` truthfully; and (E06) applying the same history to proof files — under any other history the gate counts no proof as `observed`. |
| A record cannot label itself `verified` over `storage.boundary: none` or `verified_integration: false`. | That the labels are true when written. |
| Every presentation discloses claimed proofs, a weak candidate, the cooperative policy, and an unprotected boundary; the caller cannot remove those lines. | That the presentation is shown unaltered. |

Everything in the right-hand column is outside the validators' reach by construction. A host that cannot enforce a row reports the corresponding capability honestly (`none`, `unprotected`, `enabled-after-initialization`, …) and its results are cooperative; that is the intended failure mode, not a gap the validators paper over.

## Compatibility

Additive only. No existing `.codecarto/` path, pipeline YAML, `status.yaml` field, phase prompt, `validatePhaseOutput` behavior, synthesis preflight, or Pi guard changes. `core/index.ts` gains one `export *`. The module graph test and every existing test are unchanged and green.

## Design notes

The paragraphs below are the reasoning behind the candidate's rules; they are informative.

*Identity and freshness.* Record the Git base but never identify an implementation with HEAD alone: dirty tracked bytes, relevant untracked files, deleted files, executable bits, and symlink targets matter, which is why the manifest carries all of them and the digest covers the manifest. The engineering namespace and generated output are excluded from the implementation fingerprint to avoid self-invalidation; the brief, plan, and selected references form a separate input digest so that a changed plan invalidates acceptance as surely as a changed file. Unknown coverage is recorded, not assumed away. Capture must detect a moving source and record it as `unstable`; pre-acceptance recheck stops a candidate edited after proof from inheriting that proof. Resume locates existing attempts; it does not rerun external commands.

*Structure is not semantics.* The deterministic half checks record shape, reference existence, identity bindings, scenario coverage, dependencies, outcomes, objection dispositions, and receipt bindings. It does not claim to prove semantic correctness of code or tests. Independent review examines whether tests meaningfully exercise requested and preserved behavior; the record only carries the declaration of context separation. A blocking objection remains blocking until evidence resolves it — `deferred` still blocks, and v1 has no waiver path. The existing analysis `validatePhaseOutput` stays backward compatible; engineering gates use explicit records rather than a model-written PASS table.

*Why no extension bag.* A downstream implementer must be able to consume the schema without inventing fields; the cheapest way to make that true is for the validator to refuse fields it does not know. Amendments are cheap (a type, a fixture, a row here) and visible.

*Storage, security, export* (E02 and later). Reuse the atomic write, containment, and locking primitives where their contracts fit. Test truncated, cross-linked, and unsupported records; crashes before and after the commit point; duplicate requests; stale revisions; concurrent attempts. Raw stdout, environment variables, commands with embedded credentials, and private repository identity are not exportable by default; a retained log keeps the digest of its raw bytes distinct from the digest of its sanitized export. Export is an explicit reviewed operation, never a side effect of acceptance or library publication. No new database, network service, telemetry backend, provider dependency, release automation, or credential vault is needed for the first pilot.
