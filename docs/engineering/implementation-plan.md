# Engineering evolution implementation plan

> **For Hermes:** Use the subagent-driven-development skill to implement this plan task-by-task. Other hosts should use equivalent isolated implementation and independent review. This instruction does not grant execution, publication, or approval authority.

**Goal:** prove a supervised, host-executed, evidence-backed in-place change with zero mandatory library references, durable attempts, current proof, and independent review.

**Architecture:** additive `core/engineering/` records and gates, a separate per-change workspace namespace, and thin host adapters. Existing analysis and library-synthesis behavior stays intact. The host executes; the framework records, validates, and reports eligibility.

**Tech stack:** existing TypeScript core and Node test runner; JSON engineering records, Markdown briefs/reports. No new database, provider SDK, or background service.

**Status:** planning only. New paths below are proposed creates, not claims that features exist. E01 is the contract/security review gate; dependent implementation starts only after that merged contract is satisfactory.

## Task index

Tracking issue: **[398](https://github.com/HuginnIndustries/CodeCartographer/issues/398)**. GitHub issue state is authoritative for live progress; this table is a dependency map, not a promise that code has shipped.

| ID | Task | Depends on | Issue |
|---|---|---|---|
| E01 | Freeze v1 engineering record and approval contracts — **done**, merged `b868fd9` | none | [399](https://github.com/HuginnIndustries/CodeCartographer/issues/399) |
| E02 | Persist isolated changes and immutable attempts | E01 | [400](https://github.com/HuginnIndustries/CodeCartographer/issues/400) |
| E03 | Bind records to stable input and candidate snapshots | E01 | [401](https://github.com/HuginnIndustries/CodeCartographer/issues/401) |
| E04 | Plan a repository-local change without a library | E02, E03, E09 | [402](https://github.com/HuginnIndustries/CodeCartographer/issues/402) |
| E05 | Ingest observed proof without promoting claims | E02, E03 | [403](https://github.com/HuginnIndustries/CodeCartographer/issues/403) |
| E06 | Enforce freshness, review, and acceptance gates | E02, E05; E01 approval contract | [404](https://github.com/HuginnIndustries/CodeCartographer/issues/404) |
| E07 | Expose the experimental engineering MCP surface | E04, E06 | [405](https://github.com/HuginnIndustries/CodeCartographer/issues/405) |
| E08 | Drive supervised Traverse from a capable host | E07 | [406](https://github.com/HuginnIndustries/CodeCartographer/issues/406) |
| E09 | Add slice-to-scenario traceability to planning artifacts | none | [407](https://github.com/HuginnIndustries/CodeCartographer/issues/407) |
| E10 | Assess verification seams and agent addressability | E09 (shared template/invariant files) | [408](https://github.com/HuginnIndustries/CodeCartographer/issues/408) |
| E11 | Verify the end-to-end loop and second-change continuity | E08, E10 | [409](https://github.com/HuginnIndustries/CodeCartographer/issues/409) |
| E12 | Establish and attest storage protection continuity (D3) | E01 | [418](https://github.com/HuginnIndustries/CodeCartographer/issues/418) |

Eligible now: **E02 and E03**, in parallel — they touch distinct files and share only the `core/index.ts` / engineering barrel export, which must be kept small and coordinated. **E12** is also eligible and independent; it carries D3, the one E01 decision left unresolved, so that E02 does not have to answer it. E09 remains on maintainer hold. E04/E05 open when their prerequisites are merged. Do not combine issues into one PR.

**The standing consequence of D3.** Until E12 settles how a host attests protection continuity, `CurrentStorage.protection` is never `continuous-since-initialization` on any host we have tested, so every acceptance classifies `cooperative` and `VERIFIED_ACCEPTANCE_INTEGRATIONS` stays empty. Downstream issues consume that reading and surface it; none of them may add a default, fallback, or bypass that makes `verified` reachable without the mechanism.

## Common acceptance and handoff contract

Every issue inherits [vision decisions](vision.md#decision-register), the [record contract](record-contract.md), and the following rules:

1. Read the current source and dependency PRs before editing; this plan is pinned to a v0.26.0 planning baseline, not a replacement for discovery.
2. Add the named failing behavior tests, run them and capture the actual failure, then implement the smallest change. Examples in this plan specify expected assertions, not fabricated execution output.
3. Run the targeted tests, `npm run build`, `npm test`, and `git diff --check`. For framework prompt/template changes also run init/refresh and pipeline-invariant tests; for a new tool also run the packed MCP smoke and update its expected tool inventory.
4. Preserve old workspace behavior and the source-execution boundary. No auto-confirmation, release, provider spend, GitHub write, or deployment as a side effect.
5. Obtain independent review of correctness, trust boundaries, and exact candidate identity. Review objections must have a concrete trigger or unsupported contract; clean reviews are valid.
6. Handoff includes exact PR/commit, changed paths, commands/results, expected-versus-actual behavior, pending environment/approval limitations, schema compatibility, and the next eligible issue. Do not call host-reported data independently authenticated.
7. Avoid collision hotspots: `core/index.ts`, `mcp-server/server.ts`, tool-registration files, `tests/pipeline-invariants.test.mjs`, and shared templates. Coordinate/rebase small integration edits; do not fork common contracts.

Targeted test command pattern (replace names with the task's listed files):

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/engineering-contract.test.mjs
npm run build
npm test
git diff --check
```

Expected successful outcome: every targeted assertion passes and the repository's existing suite remains green. Record the actual count at execution time; do not copy the historical dogfood count.

## E01 — Freeze v1 engineering record and approval contracts

**Objective:** give downstream agents one reviewed, executable contract, including an honest host-approval boundary.

**Status: closed.** Merged through PR #414 (candidate), #415 (claims vs observations, conditional channel, at-rest trust), and #417 (D1–D5 decisions, the live-check findings, and enforcement of the TTL, presentation-disclosure, and registry-shape rules) at `b868fd9`. The maintainer performed the D1 live interactive check; its findings are in the contract's [decision record](record-contract.md#decision-record). `VERIFIED_ACCEPTANCE_INTEGRATIONS` stays empty and the `cooperative` policy stays unauthorized, so no host produces a `verified` acceptance until D3 ([#418](https://github.com/HuginnIndustries/CodeCartographer/issues/418)) is settled — the intended, honest outcome, not a gap. Files as listed below plus `core/engineering/ids.ts`, `core/engineering/digest.ts`, and the fixture generator `tests/fixtures/engineering/v1/generate.mjs`.

**Depends on:** none. **Read:** `docs/engineering/record-contract.md`, `core/types.ts`, `core/utils.ts`, `core/status.ts`, `core/secrets.ts`, `core/synthesis.ts`, existing guard and closure tests.

**Files:** create `core/engineering/types.ts`, `core/engineering/validation.ts`, `core/engineering/index.ts`, `tests/engineering-contract.test.mjs`, `tests/fixtures/engineering/v1/`; update `docs/engineering/record-contract.md` and the minimal `core/index.ts` export when needed.

**Steps:**
1. Pin JSON envelopes, ID/path grammar, required fields, schema-version behavior, enum spellings, action/result shapes, and canonical digest inputs from the design contract. Explicitly enumerate required records for acceptance.
2. Write fixture tests for valid/minimal records and rejection of unknown versions, absent bindings, duplicate IDs, traversal, invalid states, cross-change links, and malformed proof/review records; run RED.
3. Implement pure validators with structured error results. They validate data, never run tools or write project state. Keep JSON examples valid and independently parseable.
4. Threat-model human approval and host identity. Specify a host-controlled receipt path not mintable through an ordinary agent tool call, plus unsupported-host behavior. Document the cooperative same-user-filesystem limitation, replay binding, and what is actually authenticated.
5. Have the approval contract independently reviewed; freeze it in this document with examples and negative cases, then run GREEN and full gates.

**Acceptance:** a downstream implementer can consume the merged schemas and public operation signatures without inventing fields; malformed data is rejected deterministically; no `approve: true` agent payload becomes human acceptance. If the trusted receipt design remains unresolved, keep E01 open and explicitly block E06/E07. Schema fixtures alone do not close the issue.

**Out of scope:** storage, command execution, MCP registration, UI, auto-approval, or a custom credential system.

## E02 — Persist isolated changes and immutable attempts

**Objective:** preserve one change's history while creating/resuming another, with retry-safe framework ownership.

**Depends on:** E01. **Files:** create `core/engineering/store.ts`, `tests/engineering-store.test.mjs`, `tests/engineering-distribution.test.mjs`; update the engineering barrel, `core/workspace.ts` template-copy exclusion sets, `package.json` files exclusions, `.codecarto/.gitignore`, and `.codecarto/templates/gitignore`. Extend `tests/init-workspace-isolation.test.mjs` where appropriate. Reuse appropriate primitives from `core/utils.ts`/`core/status.ts` after inspecting their actual contracts.

**Steps:**
1. Write tests creating two changes, separate slices/attempts, and immutable completed observations; assert no writes to `workflow/status.yaml` or another change.
2. Add tests for duplicate idempotency keys, conflicting payload reuse, stale CAS revisions, malformed/truncated records, symlink escape, and unknown versions; run RED.
3. Implement the smallest file-backed store, typed operations, atomic publication, per-change serialization, and directory enumeration with explicit corrupt-record reporting.
4. Add subprocess fault injection before/after the commit point and concurrent-writer tests. A success projection cannot reference an observation that was not durably published.
5. Explicitly exclude `.codecarto/engineering/` runtime state from template copying, default Git tracking, and npm packaging. Keep this exclusion distinct from distributable templates and schemas; deliberate shareable exports belong outside the private runtime namespace. Add synthetic-source initialization tests and a packed-file inventory test proving histories, approvals, and artifacts reach neither a fresh workspace nor the tarball. Never use real private records as fixtures.
6. Resume after process exit, confirm prior failed attempts remain intact, then run GREEN/full gates and the isolation/pack-inventory tests.

**Acceptance:** second change and retry do not overwrite history; duplicate ingestion is idempotent; stale revisions fail clearly; interruption leaves a recoverable state; existing analysis files remain untouched. Synthetic engineering records are ignored by default and absent from fresh-workspace copies and actual npm tarballs, while distributable guidance still arrives. Storage is not complete until these distribution-isolation checks pass.

**Out of scope:** distributed scheduling, database migration, automatic worktree management, or filesystem reorganization of legacy analyses.

## E03 — Bind records to stable input and candidate snapshots

**Objective:** identify what was actually planned/tested, including dirty state, without collecting private machine configuration.

**Depends on:** E01. **Files:** create `core/engineering/snapshots.ts`, `tests/engineering-snapshots.test.mjs`, snapshot fixtures; update the engineering barrel.

**Steps:**
1. Write digest/manifest tests: same bytes are stable; changed/deleted tracked files, mode changes, relevant untracked files, changed plan, and changed selected-reference bytes change the proper identity.
2. Test self-exclusion of `.codecarto/engineering/`, documented build-output exclusions, secret-path exclusions, uncovered relevant inputs, escaping symlinks, unstable collection, and portable path normalization; run RED.
3. Implement manifest normalization/comparison and the host collection contract. Source collection remains host-owned or uses existing read-only utilities; no arbitrary shell/proof execution is introduced.
4. Test drift between proof and pre-acceptance recheck. Dirty-tree evidence cannot be replaced by HEAD-only identity.
5. Run GREEN/full gates and document coverage limitations and conservative revalidation behavior.

**Acceptance:** same revision plus changed working bytes cannot reuse evidence silently; excluded unknown relevant inputs block rather than imply completeness; exported records contain no absolute home paths, environment dumps, or secret values.

**Out of scope:** fine-grained dependency graphs, automatic selective re-testing, global source monitoring, or a guarantee against a malicious host.

## E04 — Plan a repository-local change without a library

**Objective:** produce a bounded, repository-grounded change brief and slice plan with zero required external references.

**Depends on:** E02, E03, E09. **Files:** create `core/engineering/planning.ts`, `.codecarto/templates/change-brief.md`, `.codecarto/templates/change-plan.md`, `tests/engineering-planning.test.mjs`; update engineering exports and `core/workspace.ts` init/refresh manifest with `tests/init-template-manifest.test.mjs` as necessary.

**Steps:**
1. Define prompt/record tests for an existing-repository bug fix and feature with an empty or unconfigured library. Assert preserved contracts, intended delta, baseline, scope, acceptance IDs, and uncertainty appear.
2. Test optional references with exact versions, unsupported/stale local findings, missing build/test environment, and a bounded-investigation request; run RED.
3. Implement a change-specific planning builder. Do not repurpose the current `synthesis` pipeline or change its confirmation gates. Use per-change brief/plan paths, not the existing single synthesis output path.
4. Validate slice/scenario references, coverage, dependencies/cycles, and explicit unproved obligations. Source-language-neutral imported specs remain distinct from stack-specific proof commands.
5. Run GREEN, existing `tests/synthesis.test.mjs`, init/refresh/invariant tests, and full gates.

**Acceptance:** a small in-place change reaches an executable plan without publishing/confirming an irrelevant spec or promising to rewrite the repository. Existing library-backed synthesis still refuses unconfirmed selections.

**Out of scope:** new greenfield workflow, source edits, semantic proof of test quality, or automatically rewriting user intent.

## E05 — Ingest observed proof without promoting claims

**Objective:** retain actual check outcomes and provenance while refusing missing, malformed, or misbound evidence.

**Depends on:** E02, E03. **Files:** create `core/engineering/proofs.ts`, `tests/engineering-proofs.test.mjs`, proof fixtures; update engineering exports.

**Steps:**
1. Write tests for passing/failing host-observed checks, CI-reported checks, manual observations, blocked environments, and agent-only claims.
2. Write negative cases for absent output/exit metadata, wrong attempt/snapshot/scenario, incomplete capture, stale proof, duplicate ingestion, out-of-root artifact references, and private data in exported summaries; run RED.
3. Implement normalization and create-only ingestion under the E01 schema. Preserve raw-local versus sanitized-export digest distinctions; ingestion does not execute commands or upload logs.
4. Exercise meaningful RED/GREEN proof pairs using a small deterministic fixture executed by the test harness; the framework only consumes the resulting observations.
5. Run GREEN/full gates and record the exact trust boundary.

**Acceptance:** a prose PASS cannot satisfy an observed proof obligation; failing or blocked checks cannot be promoted; a valid recorded observation retains snapshot/environment/provenance and safe artifact identity.

**Out of scope:** command runner, arbitrary filesystem importer, automatic secret-proof export, or claiming that a dishonest host cannot fabricate observations.

## E06 — Enforce freshness, review, and acceptance gates

**Objective:** make accepted/current mean more than completed paperwork.

**Depends on:** E02, E05, and E01's resolved approval contract. **Files:** create `core/engineering/gates.ts`, `tests/engineering-gates.test.mjs`; update engineering exports and contract examples.

**Steps:**
1. Write decision-table tests for each acceptance prerequisite and distinct failure/block reason; assert missing proof, wrong snapshots, uncovered scenarios, stale inputs, invalid dependencies, and unresolved blockers refuse acceptance.
2. Add review tests requiring exact candidate binding and declared author-separated context; preserve the distinction between declared separation and authenticated identity.
3. Add approval tests for absent receipt, ordinary agent-created flags, replay, wrong change/attempt, changed candidate after review, and unsupported host capability; run RED.
4. Implement deterministic gate evaluation and serialized acceptance using the host receipt contract as closed by E01. Recheck the bound candidate before committing acceptance; unsupported hosts return `needs-human-acceptance`.
5. Test concurrent edits/acceptance and process failure around the state commit. Preserve historical acceptance without treating it as approval of new bytes; run GREEN/full gates.

**Acceptance:** neither a PASS string nor a checkbox alone can accept a candidate; stale inputs and open blockers refuse; approval is bound to exactly what was presented. Semantic correctness remains a review/test claim, not a hash guarantee.

**Out of scope:** autonomous risk waivers, expanding execution permission based on history, cryptographic claims unsupported by the adapter, or tightening every legacy analysis gate.

## E07 — Expose the experimental engineering MCP surface

**Objective:** make the shared engineering operations available without adding target execution to the server.

**Depends on:** E04, E06. **Files:** create `mcp-server/engineering.ts`, `tests/mcp-engineering.test.mjs`; make minimal registration changes in `mcp-server/server.ts` and its schema-registration site; update `scripts/smoke-mcp.mjs` and user-facing MCP docs.

**Steps:**
1. Pin E01's action/argument/result schemas in request tests, including invalid requests and unsupported host capabilities; run RED.
2. Register the additive experimental `codecarto_change` operation and thin adapters to core. No `exec`, target-code write, GitHub mutation, or provider call is introduced.
3. Test text/structuredContent parity, idempotent retries, stale revisions, and rejection of attempted approval through ordinary agent-authored fields.
4. Update the exact expected tool inventory. Build/pack and run the real stdio smoke plus a change-create/plan/proof/check round trip against the tarball.
5. Run existing MCP and synthesis tests plus full gates; document which parts are supported by which host and that drop-in is procedural only.

**Acceptance:** an MCP host can drive a zero-library local change through the supported record operations; wrong or untrusted requests are refused; the actual transported response is usable; analysis and synthesis surfaces are unchanged.

**Out of scope:** MCP SDK v2 migration (separate issue), shell tools, Pi guard changes, or claiming that all MCP clients support trusted human acceptance.

## E08 — Drive supervised Traverse from a capable host

**Objective:** join the records into a usable serial build/test/review loop, with explicit stopping and resume behavior.

**Depends on:** E07. **Files:** create `.codecarto/skills/traverse/SKILL.md`, `.codecarto/templates/traverse-record.md`, `docs/engineering/traverse-host.md`, `tests/traverse-procedure.test.mjs`; update the installed skill/init manifest and relevant guide topic.

**Steps:**
1. Write procedure/fixture tests that every next action is bounded, every proof is bound, and every acceptance requires the host's approved human path. Tests must not pretend string checks establish runtime behavior.
2. Implement the host-neutral skill contract: intake existing change, inspect capability/environment readiness, start/resume attempt, execute with host tools, ingest observations, invoke fresh review, request actual human acceptance, then advance or stop.
3. Preserve separate failed/blocked/needs-human states; impose host-configured time/spend/retry bounds and never repeat an external side effect because an acknowledgement was lost.
4. Resolve skill availability without tying an engineering change to an unrelated unfinished analysis pipeline. Add an explicit engineering eligibility path; do not globally bypass legacy post-pipeline skill gates.
5. Run procedure/manifest/invariant/full gates and a supervised dry run with actual handler/host responses. If the available host cannot complete acceptance, record that limitation and leave the pilot criterion open.

**Acceptance:** a fresh host session can resume from durable records, see prior failures and blockers, and know the next bounded action. No framework shell execution or Pi analysis-guard weakening occurs.

**Out of scope:** integrated Pi build-session mode, arbitrary plugin installation, reviewer-memory-based autonomy, or pretending host-neutral prose is enforcement.

## E09 — Add slice-to-scenario traceability to planning artifacts

**Objective:** make existing specifications and project plans produce reviewable slices with explicit proof obligations.

**Depends on:** none. **Files:** `.codecarto/templates/reimplementation-spec.md`, opinionated sibling, `project-plan.md`; their `findings/*/SKILL.md`; all pipeline definitions carrying those phases; `tests/pipeline-invariants.test.mjs`; scaffold version under release policy.

**Steps:**
1. Enumerate the actual current pipelines containing each phase; write invariant tests for the new slice/scenario instruction and matching validation row; run RED.
2. Add stable slice IDs, deliverable, modules, proved scenario IDs, dependencies, and tier. Every minimum-viable scenario must be owned; empty proof lists are invalid planning.
3. Preserve language-neutral obligations on the reimplementation-spec side. Add executable proof commands only where the target stack is known. Do not call prompt criteria deterministic execution gates.
4. Update paired templates/SKILLs/criteria together. Existing completed phases and old scaffold behavior remain compatible.
5. Run GREEN/full gates and a real phase against a disposable copy of an existing public self-audit; manually inspect whether scenarios actually prove each slice's promise. Record the output and limits.

**Acceptance:** both plan sources emit useful slices with traceable proof obligations; the language-agnostic spec stays language-agnostic; old workspaces are not reopened by adding phases.

**Out of scope:** proof collection, source implementation, whole-runtime gate hardening, or moving existing synthesis phase order.

## E10 — Assess verification seams and agent addressability

**Objective:** describe how an agent can observe relevant behavior without universally requiring a CLI.

**Depends on:** E09 to serialize shared template/invariant changes. **Files:** `.codecarto/templates/architecture-map.md`, `reverse-engineering-bundle.md`, both reimplementation-spec templates; architecture/porting/spec SKILLs and relevant pipeline criteria; invariant tests.

**Steps:**
1. Add failing invariant tests for evidence-tagged addressability assessment and appropriate observable acceptance routes; enumerate current affected pipelines.
2. Ask whether core behavior runs headlessly, state can be inspected/acted on, and programmatic seams exist. Record missing seams as hazards, not evidence of correctness.
3. Require at least one appropriate observable verification route; prefer headless checks and allow documented GUI/hardware/integration constraints. An unavailable environment remains a gap/blocker.
4. Keep Broad-Side lens/schema changes out of this PR and old-workspace behavior compatible.
5. Run GREEN/full gates and real architecture output on a small public fixture; inspect the evidence tags and recorded limitations.

**Acceptance:** outputs identify usable proof boundaries and honestly report non-headless or unavailable ones. They do not force unnecessary architectural rewrites to satisfy a checklist.

**Out of scope:** browser/simulator automation, a new scouting lens, provider calls without approval, or a universal new command-line delivery surface.

## E11 — Verify the end-to-end loop and second-change continuity

**Objective:** demonstrate the product outcome, not just the record parser.

**Depends on:** E08, E10. **Files:** create `tests/engineering-e2e.test.mjs`, `tests/fixtures/engineering/pilot/`, a sanitized public pilot report under `docs/engineering/`; update the roadmap only to the level actually verified.

**Steps:**
1. Use a disposable checkout and empty library. Choose a bounded real regression or slice-linkage feature, with the human's scope approval recorded by the supported host. Do not modify the user's active checkout without permission.
2. Produce the brief/plan, run a relevant failing baseline check, implement via the host, and record passing targeted plus applicable regression tests.
3. Run independent implementation review; resolve blockers and obtain actual human acceptance through the supported channel. Synthetic approval fixtures are test data, not evidence of this human gate.
4. Exercise interruption/resume, missing proof, wrong snapshot, stale input after proof, failed versus blocked outcomes, and a second independent change whose history preserves the first. Automated tests must cover these negative cases, not only the happy path.
5. Repeat on a feature if the first pilot was a bug, or a confirmed bug if the first was a feature. Record actual host/surface/version, observed overhead, limitations, and exact revisions. Sanitize before public publication.

**Acceptance:** both a real fix and a feature reach the locally reviewable/accepted boundary; the loop resumes and refuses stale or missing evidence; subsequent work preserves history. A test suite PASS or mocked host alone does not close this issue. Unavailable human interaction means the issue remains partially verified.

**Out of scope:** merging pilot changes upstream, production releases/deployment, cross-project library reuse, or claims of comparative productivity without measured controls.

## Deferred buildout — not secretly in the first pilot

- Reviewed synthesis: new `pipeline-synthesis-reviewed.yaml`, provenance/conflict review between merge and finalize, revision-bound dispositions. Do not edit the shipped phase list or make this ordinary-change prerequisite. Scope separately once its gate/approval design is ready.
- Knowledge refresh and reuse: record affected-knowledge deltas first; then prove reuse in a second repository while preserving descriptive/prescriptive status, original provenance, licensing, confidentiality, and fresh compatibility checks.
- Richer host UI/Pi execution: separate capability/guard-policy design after the host-executed pilot. No retrospective permission expansion.
- Team scheduling, automatic bounded autonomy, review-memory injection, and PR/release/deployment orchestration: outcome-driven later plans with explicit authority boundaries.
- Fine-grained invalidation and large-scale indexes: measure conservative behavior first; do not prebuild a dependency database.

Do not create implementation tasks for these merely to make the backlog look complete. The tracking issue records them as later planning gates.
