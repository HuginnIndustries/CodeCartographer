# Post-v0.11 evidence-driven roadmap

Status: active checklist  
Updated: 2026-07-21
Authority: this file is the durable checklist for work after v0.11.0. `CHANGELOG.md` remains authoritative for shipped behavior; completed checklist items should link to their PR and release rather than duplicating release notes.

## Evidence baseline

The priorities below are based on two real `full-with-deep-audit` runs:

- Aimbroidery dogfood: exercised a real isolated-phase compaction, atomic checkpoint creation, fresh-host `/codecarto-open` recovery, provider-stop recovery, and completion through the porting-bundle boundary.
- FreeAgent dogfood with `codecartographer-pi` v0.11.0: completed 7/7 phases in a clean source tree, produced 312,044 bytes across the seven canonical primary findings, and validated as two `PASS WITH GAPS` plus five `PASS` phases. The final phase used the porting bundle by default, made one targeted lower-level findings read, and did not reopen source files.

Evidence paths for the FreeAgent run:

- `/home/jamessesler/Documents/Github/FreeAgent/.codecarto/workflow/status.yaml`
- `/home/jamessesler/Documents/Github/FreeAgent/.codecarto/workflow/.usage.local.yaml`
- `/home/jamessesler/Documents/Github/FreeAgent/.codecarto/THREAD_LOG.md`
- `/home/jamessesler/Documents/Github/FreeAgent/.codecarto/dashboard.html`
- `/home/jamessesler/Documents/Github/FreeAgent/.codecarto/findings/porting/reverse-engineering-bundle.md`
- `/home/jamessesler/Documents/Github/FreeAgent/.codecarto/findings/reimplementation-spec/reimplementation-spec.md`

## Confirmed decisions from the FreeAgent run

- [x] Keep the split mechanical/semantic deep-audit design. It produced complementary findings and closed routed items with full contract/protocol context.
- [x] Keep defect IDs and the `fix before porting` / `port differently` / `leave behind` vocabulary. The porting phase consolidated both defect reports into one disposition table, and the terminal spec mapped the resulting defect set to rules, acceptance scenarios, deliberate choices, or non-goals.
- [x] Keep the porting bundle as the normal final-synthesis boundary. The reimplementation phase read the bundle, made one targeted lower-level findings read for exact acceptance wording, and did not reopen source files.
- [x] Keep honest `PASS WITH GAPS` as a valid phase result. Architecture and contracts disclosed partial coverage while later phases closed the routed material gaps.
- [x] Keep unavailable token counts neutral. The Ollama provider reported zero token fields for all seven runs, while turns, tool uses, duration, transcript paths, and compaction counts remained useful.

## P0 — Finish and stabilize v0.11

- [ ] Merge and verify CodeCartographer-Website PR #5 now that npm and the GitHub Release publish v0.11.0.
- [ ] Observe real v0.11 usage for several days; record installation, Pi compatibility, `/codecarto-open`, checkpoint, validation, coverage, and telemetry failures.
- [ ] Keep patch releases defect-only unless evidence establishes a narrowly scoped usability blocker.

### Make workflow state framework-owned and schema-safe

FreeAgent showed that phase agents can directly mutate `workflow/status.yaml`, invent future timestamps, temporarily create duplicate YAML keys, leave collection keys as null/comment-only values, and duplicate inherited open questions under new IDs. The framework must own canonical workflow mutations.

- [x] Define a structured phase-handoff payload for owner notes, open questions, routed items, closures, decisions, and closeout content. (#46)
- [x] Stop instructing phase agents to directly add/remove entries in `workflow/status.yaml` or append `THREAD_LOG.md`. (#46)
- [x] Apply the handoff atomically in `codecarto_complete`, with the framework supplying timestamps. (#46)
- [x] Parse YAML with duplicate-key rejection and validate `status.yaml` against a strict schema before and after completion. (#46)
- [x] Add a top-level `schema_version` and explicit backward-compatible migrations for older workspaces. (#46)
- [x] Normalize absent collections to `[]`; reject null or duplicate `open_questions` / `carry_forward` keys. (#46)
- [x] Make completion idempotent and preserve unrelated phase data under the file lock. (#46)

### Separate pipeline routing from post-pipeline work

FreeAgent completed all seven phases but displayed three `carry_forward` entries targeting `spike` and `amendment`, neither of which exists in the active pipeline. This was semantically intentional but looked like unfinished pipeline work.

- [x] Require `carry_forward.target_phase` to identify a real downstream phase in the active pipeline. (#47)
- [x] Add a distinct `post_pipeline` backlog for spikes, amendments, deltas, maintainer rulings, and opinionated reruns. (#47)
- [x] Show `pipeline complete` independently from `post-pipeline work remaining` in status, summaries, widgets, and dashboards. (#47)
- [x] Migrate or tolerate legacy terminal carry-forward entries without corrupting older workspaces. (#47)

### Deduplicate and actively close inherited open questions

The FreeAgent dashboard reports 16 open questions although there are four unique terminal questions. Three questions were copied into architecture, contracts, protocols, porting, and reimplementation-spec under phase-specific IDs. At least one supposedly runtime-only terminal question was directly answerable from source: `src/FreeAgent.Server/SessionRegistry.cs` states that process restart drops the in-memory registry while disk files survive. The raw-HTTP retry question could also have been narrowed through targeted source plus platform documentation instead of being copied unchanged through five phases.

- [x] Preserve one canonical question ID and record phase ownership/history as lineage rather than cloning the question. (#48, #49)
- [x] Deduplicate equivalent legacy questions in status/dashboard summaries while retaining provenance. (#48)
- [ ] Add a targeted open-question closure sweep before porting and terminal synthesis; require evidence that source, tests, docs, or platform semantics were checked before labeling an item `needs-runtime-test`.
- [ ] Let the porting bundle identify a deep-read trigger for every inherited open question, not only protocol/acceptance gaps.
- [x] When `current_phase: complete`, report terminal unresolved questions rather than `Open questions (current phase): 0`. (#47)
- [ ] Distinguish unresolved evidence questions from answered/routed/closed history.

### Make closeouts idempotent

The FreeAgent contracts phase has both a blank framework-created closeout stub and a later populated closeout, with two `THREAD_LOG.md` entries.

- [x] Use a stable phase closeout identity or update the framework-created stub instead of creating a second date-based file. (#46)
- [x] Prevent duplicate thread-log entries programmatically rather than relying on prompt discipline. (#46)
- [x] Do not surface empty template closeouts as valid dashboard closeouts. (#46)
- [x] Use framework timestamps for filenames and metadata. (#46)

### Tighten validation and dashboard semantics

- [ ] Make `PASS WITH GAPS` require at least one machine-readable gap/open item, or explain that the status comes from coverage disposition even when every criterion row passes.
- [x] Ensure phase completion preserves `PARTIAL` honestly without making resolved downstream gaps look permanently unresolved. (#48, #49)
- [ ] Label undeclared/optional secondary outputs as `not produced (optional)`, not `bad` or `missing`, unless the pipeline marks them required.
- [x] Regenerate the dashboard after framework-owned status mutations, or show a prominent actionable refresh state rather than relying on a subtle staleness warning. (#46)
- [ ] Explain the mechanical/semantic defect split directly on dashboard phase cards: early context-light scan versus later contract-informed analysis.
- [ ] Keep unavailable token accounting neutral; do not turn provider-reported zero token counts into measured usage.
- [ ] Clarify the Strategic Alignment Hook behavior when a user resumes without answering: apply the documented auto-default or ask again, but do not leave the phase to infer the policy.

### Add deterministic resilience integration coverage

- [ ] Build a deterministic isolated-phase harness that triggers `session_before_compact` and `session_compact`.
- [ ] Verify atomic checkpoint creation, checkpoint restoration, declared-output recovery, and bounded continuation.
- [ ] Restart the host, run `/codecarto-open`, and verify the same phase resumes without workspace reset.
- [ ] Attribute compaction telemetry to the correct phase/session across restart or explicitly record that attribution as unavailable.
- [ ] Verify unrelated Pi sessions retain normal extension/skill behavior.
- [ ] Run this harness as a release gate in addition to the packed MCP smoke test.

## P1 — v0.12 publish workflow

- [ ] Implement `/codecarto-publish`.
- [ ] Preview the spec, source repository, commit, namespace, destination, version action, and provenance before publication.
- [ ] Require explicit confirmation for publication.
- [ ] Explain content-hash idempotence: unchanged content, metadata refresh, or new version.
- [ ] Surface current library publication state in the dashboard.
- [ ] Confine child writes to the configured library path with canonical-path and symlink checks.
- [ ] Add packed-package smoke coverage for the complete Pi publication flow.

## P2 — Project-plan synthesis

- [ ] Accept one or more selected library specs plus product vision, platform constraints, scope, and exclusions.
- [ ] Produce an actionable `project-plan.md` with milestones, acceptance gates, risks, and explicit non-goals.
- [ ] Preserve provenance from each plan requirement to source specs or explicit user decisions.
- [ ] Separate inherited behavior from new product design decisions.
- [ ] Validate contradictory source specs and require a ruling instead of silently blending them.

## P3 — Spec mutation

- [ ] Implement `pipeline-spec-mutate.yaml` only after project-plan synthesis is stable.
- [ ] Apply a requested delta to an existing spec and show a reviewable semantic diff.
- [ ] Preserve unchanged evidence/provenance and identify invalidated assumptions.
- [ ] Revalidate the resulting spec before publication.
- [ ] Publish as a new library version only after explicit confirmation.

## Release sequencing

1. v0.11.x: defect-only stabilization, especially state ownership, post-pipeline semantics, deduplication, and closeout integrity.
2. v0.12.0: `/codecarto-publish` plus library-state dashboard UX.
3. v0.13.0: project-plan synthesis.
4. Later minor release: validated spec mutation.

Do not bundle publishing, project-plan synthesis, and spec mutation into one release.
