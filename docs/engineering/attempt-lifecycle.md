# The attempt lifecycle on the MCP surface

**Refs:** #409. Actions: `start_attempt`, `capture_candidate`, `record_review` on `codecarto_change` (`mcp-server/engineering.ts`); core in `core/engineering/lifecycle.ts`; the walker in `mcp-server/working-tree.ts`. Tests: `tests/engineering-lifecycle-mcp.test.mjs`.

Before this, the contract's Operation API named `start-attempt`, `capture-candidate` and `record-review`, `types.ts`/`validation.ts` defined their request shapes, and no surface exposed them: every test seeded attempts, snapshots and reviews straight through the store, and a real host session could not get from a plan to a gate. Now the whole loop — create → plan → start_attempt → capture_candidate → record_proof / ingest_observations → record_review → gate → request_acceptance — runs through tool calls alone, and the end-to-end test drives it against a real temporary git repository with a scripted elicitation client, ending in exactly one approval.

## The design decision: what "create-only" means for an attempt

`store.ts` said everything under `attempts/` is create-only, while the contract says `capture-candidate` *binds* `candidate_snapshot_id` onto a running attempt and is *repeatable* until a proof references the candidate. The contract's own words in § Ownership and layout resolve it: attempts are "create-only **once finalized**". An attempt is a projection while `running` and an observation once it is not.

Options weighed:

| Option | What it would have broken |
|---|---|
| **(a) attempt as a versioned mutable projection** (a `revision` CAS like change/slice, any field editable while the caller holds the revision) | The attempt has no `revision` field in the contract, so this is a schema amendment. Worse, it makes `outcome`, `inputs`, `baseline_snapshot_id` and `slice_id` editable after the fact: a review or approval bound to a candidate stays byte-valid while the attempt underneath it is re-pointed at another slice or another input digest — the contract's rejection table names exactly that ("attempt re-bound to another candidate or slice, or inputs changed") as something a reader must catch, so letting the store perform it is the wrong side of the line. |
| **(b) create-only binding records** under the attempt (a candidate-binding record; the effective candidate = the latest binding no proof precedes), every reader resolving through one helper | Keeps the attempt file frozen, but `attempt.candidate_snapshot_id` is a required field for `ready-for-review`/`needs-human-acceptance`/`accepted` and every existing reader, fixture and the review/approval bundle checks bind to *it*. The record would carry one candidate and a side file another; a reader that forgot the helper would silently read the stale one. It also adds a record kind, a path, and a bundle rule — a contract amendment larger than the problem. |
| **(c) chosen: the attempt is mutable only while `running`, only in its lifecycle fields, CAS'd on the bound candidate** | What the contract already implies. The store now allows a write over an existing attempt only when the stored outcome is `running`; it pins every identity field (`id`, `change_id`, `slice_id`, `inputs`, `baseline_snapshot_id`, `started_at`, `created_at`, `parent_attempt_id`, `supersedes_attempt_id` — `invalid-value` on any drift), checks `running → outcome` against `ATTEMPT_OUTCOME_TRANSITIONS` (`invalid-transition`), and compare-and-swaps on `ifCandidate` — the `candidate_snapshot_id` the caller last read, `null` for none (`stale-revision` on mismatch, `invalid-state` when omitted). Once the stored outcome has left `running`, no write reaches the file: a correction is a new attempt with `parent_attempt_id`/`supersedes_attempt_id`. |

What stays true under (c): a proof, review and approval each bind to a specific candidate *id and digest* (snapshots are still immutable); a re-capture after a proof references the bound candidate is refused (`invalid-state`, naming the candidate and the proof ids, remedy: a new attempt); `start_attempt` writes the baseline snapshot *before* the attempt so a crash leaves an orphan snapshot, never an attempt without a baseline.

**Contract amendment (minimal):** `record-contract.md` § Ownership and layout now spells out the "once finalized" exception in one sentence; `store.ts`'s header no longer says "everything under attempts/ is create-only" without the qualifier. No field, enum, error code or path was added.

## One resolution of "the attempt's candidate"

`boundCandidate(store, attempt)` in `lifecycle.ts` reads `attempt.candidate_snapshot_id` and returns the snapshot or `null` (absent *or unreadable* — a reader that cannot see the candidate treats it as none, which is the conservative reading). `gates.ts`, `acceptance.ts`, `host-observations.ts`, `traverse.ts` and the MCP re-read (`candidateOf`) all call it; there is no second source of truth.

## The actions

All three refuse the derived fields (`state`, `decision`, `authority`, `discharges`, `attested_by`, … plus the lifecycle-derived `outcome`, `stability`, `digest`, `candidate_snapshot_id`, `candidate_digest`, `input_digest`, `baseline_snapshot_id`, `collector`, `started_at`, `ended_at`). `request_id` makes each retry-safe through the store's idempotency key.

| Action | Arguments | Result (`structuredContent`) |
|---|---|---|
| `start_attempt` | `change_id, slice_id, inputs: { brief_digest, plan_digest, references }, parent_attempt_id?` | `{ attempt_id, outcome: "running", baseline_snapshot_id, baseline_digest, attested_by: "adapter", stability, input_digest, limitations }`. Activates a `planned` change and a `pending` slice. |
| `capture_candidate` | `change_id, attempt_id` | `{ candidate_snapshot_id, candidate_digest, attested_by: "adapter", stability, outcome: "running", superseded_candidate_id?, limitations }`. Repeatable until a proof names the bound candidate. |
| `record_review` | `change_id, attempt_id, review: { reviewer, objections, summary }` | `{ review_id, candidate_snapshot_id, candidate_digest, input_digest, remaining_blockers, outcome, finalized }`. A clean, `declared-separate` review of an adapter-attested, stable candidate finalizes the attempt to `needs-human-acceptance`. |

`plan` gained an optional write mode: with `slices` (plus `revision` and `acceptance_scenarios`) it stores the slices `pending`, moves the change `draft → planned`, writes `brief.md`/`plan.md`, and returns their digests for `start_attempt`'s inputs. Without `slices` it is the read-only brief it always was.

### Snapshots are captured by the adapter

`captureWorkingTree(cwd, excluded)` and `readWorkingTree(cwd, candidate)` share **one walker**, `observe`: same traversal, same exclusion match, same hashing, same symlink handling. Capture walks twice; if the two passes differ the snapshot is `unstable` (per the contract, outside the digest, and unable to bind an acceptance). HEAD is read from `.git` without running git; `repository.dirty` is recorded `true` on a git tree because the adapter cannot show the tree equals HEAD, and the limitation says so.

A caller-supplied `snapshot` / `baseline_snapshot` / `candidate_snapshot` / `manifest` / `coverage` / `repository` is **refused by name** on both capture actions. The contract says a caller snapshot is *ignored* when the adapter can read the tree; this adapter can always read its own `cwd`, and refusing rather than silently ignoring tells the caller its bytes did not become the record. The `caller`-attested path in `lifecycle.ts` (`SnapshotSource.attested_by: "caller"`) exists for an adapter that cannot read the tree; no MCP action reaches it.

**Where scope comes from.** The candidate's coverage is `ALWAYS_EXCLUDED` (`.codecarto/engineering/**`) plus host-declared exclusions. No change or slice field declares exclusions today (`permitted_scope` says where edits may land, not what the identity omits), and no host configuration channel reaches the MCP server, so `captureScope()` in `engineering.ts` returns `[]` and the coverage is exactly `ALWAYS_EXCLUDED`. That function is the one line to change when a scope source exists.

### Reviews bind from the store

`record_review` refuses `candidate_snapshot_id`, `candidate_digest`, `input_digest` (and the envelope) on the caller's body — `unknown-field` at `/review/<field>` — and fills them from the stored attempt and its bound candidate. `remaining_blockers` is derived (`deriveRemainingBlockers`); a supplied list that disagrees is `invalid-value`.

## What traverse now emits

| Records | Step |
|---|---|
| no slices | `plan-slices` |
| slices, no open attempt | `start-attempt` |
| running, no candidate | `resume-attempt` ("ends with capture-candidate") |
| running, candidate bound, no proof names it | `record-observations` (key: attempt + candidate) |
| running, proof names the candidate, no review of it | `request-review` (key: attempt + candidate) |
| running, review with open/deferred blockers | `address-objections` naming the review and blockers; remedy is a new attempt |
| running, reviewed clean, not yet finalized | `resume-attempt` |
| `needs-human-acceptance`, gate refuses (no observed proof, open objection, `input-stale`) | `stop` / `blocked-needs-operator` naming the gate's blockers — the host is never told to ask a person for work the gate would refuse |
| `needs-human-acceptance`, no approval | `request-human-acceptance` |
| `needs-human-acceptance`, a GENUINE accepted approval for the bound candidate (`judgeApprovals`) | `stop` / `change-concluded` naming the approval |
| `needs-human-acceptance`, an approval file that is NOT genuine (no stored request, replayed nonce, other candidate, rejected decision) | `stop` / `blocked-needs-operator` naming the file and the codes; never concluded, never silently skipped |
| failed / blocked / budget | unchanged |

`capture-candidate` was added to `TRAVERSE_ACTIONS`; the running stages above are what a host session sees between `start-attempt` and `request-human-acceptance`.

## Trust: unchanged

`VERIFIED_ACCEPTANCE_INTEGRATIONS` is `[]`; `assurance_policy` is `verified`; `cooperative` is unreachable; there is no approve/accept path; the only approval in the new test is minted by the existing `request_acceptance` adapter through the test-only registry seam. An MCP-recorded proof is still `claimed`; the end-to-end test writes its one observed proof the way E05's protected host entry would, and says so where it does it.

## What an approval file is worth

`judgeApprovals(store, attempt, candidate)` in `lifecycle.ts` is the one place a file under `approvals/` becomes "the candidate is accepted": it reads the stored request the receipt names and runs `evaluateApprovalReceipt` against it, the attempt, the CURRENT bound candidate, and the other approvals' nonces. `traverse.ts` concludes only on a genuine verdict; `acceptance.ts` counts only genuine approvals as `already-accepted`, so a schema-valid file dropped into the directory can neither conclude a change nor deny a real request — it is disclosed in the presentation's limitations (and the `request_acceptance` result) by id and codes, and traverse stops for an operator on it. A replayed nonce refuses every file sharing it, so traverse stops for an operator. That does not make the approval unique: an agent that can write `approvals/` can copy a genuine approval under a new id. Both copies then read `receipt-replayed`, traverse stops, and `request_acceptance` discloses the pair and asks the person again. The person may accept, minting a second genuine approval for the same candidate. Write access to `approvals/` already rules out `verified` (the storage boundary is unprotected), so this is disclosed, not prevented. Stopping instead of asking again when a non-genuine receipt names a stored request is tracked as a follow-up.

## Inputs are derived, then compared

`readStoredInputDigests(store, changeId)` digests the raw `brief.md`/`plan.md` bytes. `plan` reports what it stored through it; `start_attempt` derives `inputs.brief_digest`/`plan_digest` through it and refuses a caller value that differs (naming both) or a change with no stored artifacts; `update` regenerates `brief.md` when one is stored; the gate re-reads both files and refuses `input-stale` when the attempt's digests no longer match what is stored. The MCP `plan` write performs its change CAS before writing slices, so two racing planners leave one slice set.

## Limits

- `judgeApprovals` judges against the CURRENT bound candidate only; an approval genuine for a superseded candidate reads as `receipt-mismatch`, which is the intended reading (old acceptance is history).
- A non-genuine approval file is left in place and disclosed; nothing on this surface removes it.
- `plan` write: a crash between the change CAS and the slice writes leaves a `planned` change with no slices, which `plan` refuses to re-plan; an operator matter.
- The gate's `input-stale` compare is skipped with a limitation (not a refusal) when the change has no stored `brief.md`/`plan.md` (records seeded straight into the store); the MCP surface never starts an attempt without them.
- Reviewer separation is declared by the review's author, not authenticated; `record_review` and the presentation say so.
- `captureWorkingTree` has an `@internal` `seams.between_walks` hook (test only; `stripInternal` keeps it out of `dist` declarations; no MCP argument reaches it).

- `repository.dirty` is always `true` on captures from a git tree (no git is run).
- Scope is `ALWAYS_EXCLUDED` only; there is no host-declared exclusion channel on MCP yet.
- `record_review` finalizes only to `needs-human-acceptance`; `ready-for-review` is not emitted by any action (a clean review is what moves the attempt).
- `failed`/`blocked` outcomes have no MCP action yet; the store accepts them through the same running-attempt path when a surface needs them.
- Windows: the walker uses `path.join`/`relative(...).split(sep)`; the new test uses no symlink or chmod.
