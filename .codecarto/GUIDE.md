# CodeCartographer — LLM Session Guide

## What This Is

This is a structured reverse-engineering workspace embedded inside a repository. You are an LLM assistant. Your job is to analyze the source code in this repository (the parent directory, `../`) and produce a reusable evaluation bundle: an architecture map, behavioral contracts, protocol and state notes, a porting synthesis, and a reimplementation spec.

All CodeCartographer files live inside this `.codecarto/` folder. The source code is everything outside it.

**Synthesis exception.** When `workflow/status.yaml` selects `workflow/pipeline-synthesis.yaml`, this workspace is planning a new product rather than reverse-engineering the surrounding repository. Use `inputs/vision.md` and the read-only library paths supplied by the executable host. Do not treat the parent directory as source evidence for synthesis.

Work in explicit phases. Do not try to do everything at once.

## Roles

CodeCartographer distinguishes two roles. They are different jobs — but they are not different threads by default, and the framework's discipline depends on the first one existing.

**Orchestrator.** The persistent chat driving the run — normally the very session reading this guide. The role is defined by its **duties**, not by who executes phases:

- **Curate `CONVENTIONS.md` and `DECISIONS.md`**: promote patterns when they recur; append cross-cutting decisions as they land.
- **Re-triage open questions at every phase boundary.** A question's `kind` label is itself a claim that needs evidence: before accepting `needs-maintainer-decision` or `needs-runtime-test`, re-test whether the question has become answerable by reading. A mislabeled question suppresses verification for every later phase (the `orchestration` guide topic records a real four-phase failure).
- **Sweep for contradictions** between the incoming phase's required reads and earlier phases' `owner_notes`. A measured fact that contradicts a summarized claim is a gap to route, not a nuance to smooth over.
- **Route gaps**: confirm each completed phase's declared secondary outputs were written or explicitly routed, and that handoff `decisions` deferring work landed somewhere a later phase will actually see.
- **Gate strategic forks** with the user: pipeline switches, opinionated-vs-agnostic specs, scope changes.

**Phase executor.** Whoever performs one phase against its SKILL.md and template: reads the sources, writes the primary output, validates, writes the handoff. The bulk of the framework — phases, skills, templates, validation gates — is written for this role; the "You are an LLM assistant" framing in "What This Is" addresses it.

How the roles map onto threads is an **execution strategy**, chosen per run:

- **Inline** — the orchestrator executes phases itself, wearing both hats. This is the normal mode for a single chat driving the MCP tools. The duties above happen at each phase boundary: after completion, before the next phase begins.
- **Delegated** — the orchestrator dispatches each phase to a separate execution context (the Pi extension's phase sub-agents, or fresh threads the user spins up from drafted prompts) and reviews each closeout. Same duties, same boundary; only the executor differs, keeping phase context out of the orchestrator's window.

Either strategy is full orchestration. The **session-by-session fallback** — each phase in an isolated session, nobody holding the cross-phase duties — is not: `CONVENTIONS.md` stays empty, proposals die in closeout prose, and mislabeled questions go unchallenged. Use it only when the user explicitly declines orchestration or the driving model cannot sustain cross-phase context, and record the reason in the first handoff's `owner_notes`.

If you are an LLM reading this guide for the first time on a project where `CONVENTIONS.md` and `DECISIONS.md` are missing or unwritten (still showing template content) and `closeouts/` is empty, **see "First-Time Project Setup" below before starting any phase.**

## First-Time Project Setup

If this is the first LLM to touch this project — no closeouts in `closeouts/`, `CONVENTIONS.md` and `DECISIONS.md` missing or still template skeletons, `workflow/status.yaml` at defaults — **adopt the orchestrator role by default.** Do not interview the user about whether orchestration should happen. Concretely:

1. `codecarto_init` (and Pi's `/codecarto-init`) seeds `CONVENTIONS.md` and `DECISIONS.md` from their templates. On an older workspace where they are missing, initialize them from `templates/conventions-template.md` and `templates/decisions-template.md` yourself (skeletons only — they fill as patterns and decisions accumulate).
2. Confirm the project name only if the repository directory name is wrong for the project; `project_name` otherwise resolves and persists automatically on the first completion.
3. Note the run's execution strategy (inline or delegated) in the first phase handoff's `owner_notes`.

Choose the execution strategy from the situation rather than asking: a single chat driving the MCP tools runs **inline**; a host with phase sub-agent dispatch (the Pi extension) runs **delegated**. Ask the user only when their instructions genuinely conflict with both defaults — and never under `/codecarto-next --auto`, which must not block on questions.

Fall back to session-by-session mode only if the user explicitly declines orchestration or the driving model cannot hold cross-phase context. Record the reason in the first handoff's `owner_notes`, and expect the costs named under §Roles.

One operational tip for delegated runs: if your coding agent supports renaming and pinning threads, rename the orchestrator thread to "Orchestrator" and pin it — quick to find when you switch back from phase threads.

## First Read For New Sessions

Read these files in order before doing any analysis:

1. This `GUIDE.md` (you are here — `.codecarto/GUIDE.md`).
2. `workflow/status.yaml` to see which phases are done and what is next.
3. The current phase's existing output file, if one exists (to avoid repeating work).
4. `scratch/checkpoints/<phase>.md`, if present, to resume durable in-phase progress after compaction or interruption.
5. The current phase's `SKILL.md` for detailed instructions on what to analyze and produce.
6. The output template from `templates/` for the current phase (if starting a new output).
7. `broadside/synthesis.md`, if a Broad-Side batch reconnaissance run has completed — it carries unverified scouting leads (see `broadside/SKILL.md`) that tell you where the interactive phases should spend attention.

All paths in this guide are relative to `.codecarto/` unless stated otherwise.

A blank `project_name` in `workflow/status.yaml` needs no action: the framework resolves it to this repository's directory name and persists it on the first completion.

Treat this workspace as durable memory across sessions. Do not invent a new structure. Use the one that exists.

## Trust Boundaries

Some files in this workspace are **read-only instructions** and must not be modified during analysis. Others are **writable outputs** that you create or update.

| Category | Files | Access |
|---|---|---|
| Orchestration (read-only) | `GUIDE.md`, `CONTRIBUTING.md`, `LICENSE` | Read only. Never modify. |
| Skills (read-only) | `findings/*/SKILL.md`, `findings/defect-scan/passes/*.md`, `skills/*/SKILL.md`, `broadside/SKILL.md` | Read only. Never modify. |
| Templates (read-only) | `templates/*.md` | Read only. Never modify. |
| Pipeline definitions (read-only) | `workflow/pipeline*.yaml`, `workflow/VALIDATE.md` | Read only. Never modify. |
| Source code (read-only) | `../` (everything outside `.codecarto/`) | Read only. Analyze but never modify. |
| Synthesis input (user-maintained) | `inputs/vision.md` | The user fills this before the synthesis pipeline starts. Implementing phases read it but do not rewrite the raw brief. |
| Workflow state (framework-owned) | `workflow/status.yaml` | Read to understand progress. Implementing sessions never edit it directly; completion applies a validated phase handoff under a lock. |
| Scaffold version stamp (framework-owned) | `workflow/scaffold-version.yaml` | Written at release, copied by init. The framework compares it to its own version to warn about stale scaffolds. Never edit. |
| Findings (read-write) | `findings/<phase>/<primary-output>.md`, secondary output files | Create and update during phases. |
| Phase handoff (read-write) | `scratch/handoffs/<phase>.yaml` | Phase executors propose state changes and closeout content here. The framework validates and applies them. |
| Closeouts (framework-owned) | `closeouts/<date>-<phase-or-module>.md`, `THREAD_LOG.md` | Completion writes or updates one canonical closeout and one idempotent index entry. |
| Conventions (orchestrator-maintained) | `CONVENTIONS.md` | Cross-cutting patterns promoted to project-wide invariants. Phase executors propose; the orchestrator promotes at the phase boundary — in inline runs, the same chat changing hats. |
| Decisions (orchestrator-maintained, append-only) | `DECISIONS.md` | Numbered log of decisions that diverge from spec, prompt, or obvious-default. Completion appends each handoff's `decisions` under `## Completion log`; the orchestrator may re-file entries into categories. |
| Backlog (orchestrator-maintained) | `BACKLOG.md` | Work this project decided to **defer**, with the reasoning, the preconditions for revisiting, and the smallest viable form. Seeded from `templates/backlog-project.md` at init. |
| Scratch (read-write) | `scratch/*` | Working notes; `scratch/checkpoints/<phase>.md` is the durable in-phase continuation checkpoint until the phase validates; `scratch/spikes/<spike-id>/<scenario>.md` holds spike reports (`templates/spike-report.md`); `scratch/amendments/<slug>.yaml` holds post-pipeline amendments (`templates/amendment.yaml`). |

If you are uncertain whether a file should be modified, treat it as read-only.

### Two things named "backlog", and neither is the other

- **`BACKLOG.md` in this workspace** is *this project's* deferrals: work the project chose not to do yet. `DECISIONS.md` records what the project decided to **do**; `BACKLOG.md` records what it decided to **defer**. Deferrals get no `D` number. When a deferred item is later picked up, remove its entry here and record the decision in `DECISIONS.md`.
- **`status.yaml`'s `post_pipeline` list** is framework-owned lifecycle state, not this file. Items there are retired by `codecarto_amend`, never by hand.
- **CodeCartographer's own backlog** — deferred improvements to the *framework* — lives in the CodeCartographer repository, not in your workspace. If a phase prompt misled you or a validation criterion did not fit, that is feedback to the framework; it does not belong in this file.

## Pipeline Selection

Seven pipeline variants are available. Check the `pipeline` field in `workflow/status.yaml` to see which is active.

- If the field is **empty**, ask the user which scope to use.
- If the field points to a **file that does not exist**, stop and ask the user to correct it. Do not guess or fall back to the default pipeline.

| Variant | File | Phases | When to use |
|---|---|---|---|
| Full with deep audit (default) | `workflow/pipeline-full-with-deep-audit.yaml` | architecture → defect-scan-mechanical → contracts → protocols → defect-scan-semantic → porting → reimplementation-spec | Complete analysis with defect scan split into an early mechanical pass and a deep semantic pass; reimplementation designs around defects with full context |
| Full with audit | `workflow/pipeline-full-with-audit.yaml` | architecture → defect-scan → contracts → protocols → porting → reimplementation-spec | Single early defect scan; cheaper than the deep variant when you do not need contracts/protocols-grounded defect findings |
| Full | `workflow/pipeline.yaml` | architecture → contracts → protocols → porting → reimplementation-spec | Porting bundle without defect scan |
| Defect scan | `workflow/pipeline-defect-scan.yaml` | architecture → defect-scan | Maintenance audit to surface latent problems |
| Lite | `workflow/pipeline-lite.yaml` | architecture → contracts → protocols | Understanding behavior without porting plans |
| Architecture only | `workflow/pipeline-architecture-only.yaml` | architecture | Quick structural overview |
| Synthesis | `workflow/pipeline-synthesis.yaml` | vision-capture → goal-synthesis-propose → spec-merge → goal-synthesis-finalize | Convert a user vision and explicitly confirmed library specs into a provenance-backed project plan; requires Pi or MCP |

## Evaluation Objective

Produce a reusable evaluation bundle for the repository. The bundle has two purposes:

- **Immediate use**: future sessions can continue the analysis without repeating earlier work.
- **Future automation**: the same workflow can be pointed at another codebase later.

### Primary Deliverables

| Artifact | Location |
|---|---|
| Architecture map | `findings/architecture/architecture-map.md` |
| Defect report | `findings/defect-scan/defect-report.md` |
| Behavioral contracts | `findings/contracts/behavioral-contracts.md` |
| Protocols and state | `findings/protocols/protocols-and-state.md` |
| Reverse-engineering bundle | `findings/porting/reverse-engineering-bundle.md` |
| Reimplementation spec | `findings/reimplementation-spec/reimplementation-spec.md` |
| Synthesis proposal | `findings/goal-synthesis/proposal.md` |
| Merged specification | `findings/spec-merge/merged-spec.md` |
| Evidence-backed project plan | `findings/goal-synthesis/project-plan.md` |

Not all deliverables apply to every pipeline variant. Check your active pipeline YAML for which phases and outputs are included.

### Secondary Artifacts

Created only when a phase grows too large or a topic needs standalone treatment. Secondary outputs use `mode: append` — always append to these files, never overwrite content from a previous phase.

| Artifact | Location |
|---|---|
| Public surfaces notes | `findings/public-surfaces/public-surfaces.md` |
| Runtime lifecycle notes | `findings/runtime-lifecycle/runtime-lifecycle.md` |
| State and storage notes | `findings/state-and-storage/state-and-storage.md` |
| Build and deploy notes | `findings/build-and-deploy/build-and-deploy.md` |
| Configuration model | `findings/config-model/config-model.md` |

### Primary vs Secondary Output Relationship

The two output kinds have different jobs and must not duplicate each other.

- **Primary outputs own the map and the load-bearing claims.** They are the canonical reference a downstream phase cites by section anchor. Sections may *summarize* secondary content (one-paragraph synopsis with a pointer) but should not catalog every detail.
- **Secondary outputs own the catalog-level detail.** They accumulate across phases via `mode: append`, with each phase adding a dated section. A reader who wants the full inventory of public surfaces, the full SQLite migration history, or the full env-var matrix goes here, not to the primary output.

If a primary and a secondary output describe the same topic (e.g., the architecture map's `Public Surfaces` section vs. `findings/public-surfaces/public-surfaces.md`), the primary owns the *summary and the claims that downstream phases will cite*; the secondary owns the *enumerated detail*. Conflicting content is a bug — recency wins, and the primary should be updated to point to the latest secondary section.

### Orchestrator-Maintained Artifacts

Two cross-cutting files compound across sessions and live at the `.codecarto/` top level:

- **`CONVENTIONS.md`** — cross-cutting patterns that have been promoted to project-wide invariants (e.g., a shared discriminated-union return shape, a tripwire-naming vocabulary, a verbatim-spec-quote discipline). Completion **stages** each handoff's `proposed_conventions` under `## Pending proposals`; the orchestrator promotes a staged entry into a numbered convention (or removes it with a note) at the phase boundary. New conventions land when a third independent phase reaches for the same pattern, or when a spec/feedback corpus identifies a project-wide invariant.
- **`DECISIONS.md`** — append-only numbered log of cross-cutting decisions that diverge from spec, prompt, or obvious-default. Each entry: `D<NNN> | <one-liner> | <source-closeout> | <rationale-pointer>`. Completion **appends** each handoff's `decisions` as rows under `## Completion log`, numbering shared with the orchestrator-curated category sections; the orchestrator may re-file entries into categories later.

Both files are seeded from the framework templates (`templates/conventions-template.md`, `templates/decisions-template.md`) at init and become project-specific artifacts as entries accumulate. The bookkeeping half is mechanized — completion collects, so proposals can never be stranded in closeout prose — while promotion stays judged: phase executors propose, the orchestrator promotes, and in an inline run the same chat does both at the phase boundary.

## Context Budget

Before beginning a phase, estimate how much source material you need to read. For large codebases:

- Read structural files first (manifests, entrypoints, READMEs) from the repository root (`../`).
- Use the architecture map to prioritize which packages to read in detail.
- Defer deep reads until the current phase actually needs them.
- For long phases, update `scratch/checkpoints/<phase>.md` after each major subsystem or output section. Pi writes a phase-aware checkpoint automatically after phase compaction; other hosts should use `templates/phase-checkpoint.md` manually.
- Every primary output must include `Coverage and limits`: inspected scope, skipped scope, evidence basis, known blind spots, and a `COMPLETE` or `PARTIAL` disposition.
- If you are running low on context, finish the current section, write a PARTIAL validation, and document what remains in `open_questions` (truly unknown) or `carry_forward` (deferred to a specific later phase) in the phase handoff. See "Open Questions vs Carry-Forward" below.

### Synthesis compression boundary

The porting bundle is the intentional compression boundary before `reimplementation-spec`. Its Source Index must preserve load-bearing claims, defect dispositions, coverage gaps, and exact pointers for targeted deep reads. The final synthesis phase reads the bundle by default; it opens architecture, contracts, protocols, or defect reports only when the bundle names a gap or conflict, an acceptance scenario needs omitted detail, a claim needs stronger evidence, or a defect disposition needs its rationale. If the bundle cannot support that selective workflow, mark validation `PARTIAL` instead of loading every upstream report by habit.

### Subagent Delegation for Large Codebases

For codebases over roughly 50 source files or 100K LOC, do not burn primary context on bulk extraction work. Delegate dependency mapping, file inventories, manifest enumeration, and cross-document comparisons to subagents and cite their scratch artifacts (`scratch/<topic>.md`) from the primary output. The primary session reads the synthesized scratch note, not the raw walks. Bless this pattern explicitly so primary context stays for the load-bearing reasoning that the subagent can't do — naming layers, pinning invariants, classifying findings.

### Open Questions vs Carry-Forward

`open_questions` does two distinct jobs that the schema separates explicitly:

- **`open_questions`** — items that are *still genuinely unknown*. Need more evidence (a runtime test, a maintainer decision, a spec ruling). Not resolvable by any later phase in the current pipeline.
- **`carry_forward`** — items that are deferred to a specific later phase because the current phase can't responsibly close them but the pipeline naturally will. Each entry has a target phase.
- **`post_pipeline`** — optional work after the active pipeline: spikes, amendments, deltas, maintainer rulings, or opinionated reruns. These items do not make pipeline completion partial and must not be disguised as carry-forward targets.

All three collections carry structured entries. Recommended phase-state shape:

```yaml
open_questions:
  - id: arch-OQ1
    kind: needs-runtime-test
    description: Does the SSE stream emit a final `done: true` event, or does the connection just close?
    deferred_reason: cannot determine from source alone; requires live capture against the running service.
carry_forward:
  - id: arch-CF1
    kind: defer-to-phase
    target_phase: defect-scan
    description: The `loadConfig()` callsite returns `{}` on both ENOENT and parse-error — can't tell absent from corrupt.
    deferred_reason: framing this as a defect requires the defect-scan rubric; flagged here so defect-scan picks it up.
post_pipeline:
  - id: post-runtime-1
    kind: spike
    description: Capture restart behavior against a packaged build after the pipeline is complete.
```

`kind` is one of: `needs-runtime-test`, `needs-maintainer-decision`, `needs-spec-ruling`, `defer-to-phase`, `needs-fixture-capture`, or a post-pipeline work kind such as `spike` or `amendment`. Every new `carry_forward.target_phase` must be an ID in the active pipeline. Every `post_pipeline` entry requires a stable ID. Open questions should carry a stable `id` (e.g. `q-loadconfig-ambiguity`); if omitted, the framework auto-assigns one. When a later phase resolves an open question, list its id in `open_question_closures` to remove it from all phases. The downstream phase records resolved carry-forward IDs in `carry_forward_closures`; completion removes those entries atomically.

After the pipeline completes, the handoff channel closes with it. Post-pipeline resolutions — an open question answered on evidence, a finished `post_pipeline` backlog item — are applied with an **amendment**: write `scratch/amendments/<slug>.yaml` (see `templates/amendment.yaml`) and run `codecarto_amend`. It updates `workflow/status.yaml` under the same lock completion uses and writes an amendment closeout plus THREAD_LOG entry. Never hand-edit `status.yaml` for this; amendments are refused while the pipeline is still running, so the two channels cannot race.

## Phase Selection Logic

1. Load the active pipeline YAML (see `pipeline` field in `workflow/status.yaml`).
2. Load `workflow/status.yaml`.
3. Traverse `phase_order` in order.
4. Pick the first phase whose status is not `complete` and whose `depends_on` phases are all `complete`.
5. Load that phase's `skill_path` and all files listed in `required_reads`.
6. Run the phase. Write output to `primary_output`.
7. Run validation per `workflow/VALIDATE.md`. Append the validation block to the output.
8. Write `scratch/handoffs/<phase>.yaml`, then run completion. The framework verifies the primary output and validation, applies the handoff to `status.yaml`, and maintains the closeout and `THREAD_LOG.md` entry.

**Parallel phases:** Some phases share the same `depends_on` and can run concurrently. Each session writes only its phase handoff; completion serializes canonical state changes with a filesystem lock so sibling phase state is preserved.

## Session Update Protocol

When a session starts:

1. Read this GUIDE.md.
2. Read `workflow/status.yaml`.
3. Read `CONVENTIONS.md` (if it exists) — the project's accumulated cross-cutting patterns.
4. Read the current phase's existing output, if present.
5. Read the current phase's `SKILL.md`.
6. Read the output template from `templates/` for the current phase (if starting a new output).
7. Scan `carry_forward` entries in status.yaml whose `target_phase` matches your phase — these are the items earlier phases routed to you.

When a session finishes durable work:

1. Run the validation step described in `workflow/VALIDATE.md`. Append a validation block to the output.
2. Write `scratch/handoffs/<phase>.yaml` with `schema_version: 1`, the exact `phase_id`, arrays for `owner_notes`, `open_questions`, `carry_forward`, `carry_forward_closures`, `open_question_closures`, `post_pipeline`, `decisions`, and `proposed_conventions`, plus `closeout_summary` and optional multiline `closeout_content`. Omitted arrays default to empty; malformed collection shapes fail completion.
3. Record 2-3 key observations in the handoff's `owner_notes` (e.g., row counts, notable decisions, scope of analysis). Do not provide a canonical timestamp; the host clock owns timestamps.
4. Run `/codecarto-complete` (or `codecarto_complete`). The framework atomically updates `workflow/status.yaml`, writes or updates one canonical closeout, and appends one idempotent `THREAD_LOG.md` entry. Do not edit those files directly.
5. Store the durable output in the declared `findings/` path.
6. If the session made cross-cutting decisions or discovered project-wide invariants, record them in the handoff: `decisions` entries are appended to `DECISIONS.md` by completion (numbered `D<NNN>` rows under `## Completion log`), and `proposed_conventions` entries are staged in `CONVENTIONS.md` under `## Pending proposals`. Promoting a staged proposal into a numbered convention — or removing it with a note — is the orchestrator duty at the next phase boundary; in an inline run, do it yourself before starting the next phase.

### Strategic Alignment Hook (before synthesis)

Before starting `reimplementation-spec` (or any synthesis phase), confirm with the user — explicitly, in chat — whether the spec is:

- **Language-agnostic** (the default; "any port to any stack"), or
- **Opinionated** (target stack, project identity, scope cuts, named primitives are pre-locked).

This conversation produces inputs the synthesis phase actually needs (locked target stack, locked project name, locked scope cuts) and selects the right template. If the answer is "opinionated," use `templates/reimplementation-spec-opinionated.md` instead of the default. Skipping the hook produces a generic spec when the user wanted a specific one — the most informative friction the framework has produced to date. A two-question pre-flight is cheap.

**Behavior under `/codecarto-next --auto`:** the auto runner suppresses this hook to keep the loop moving. The spec defaults to **language-agnostic** and is tagged `selection: auto-default` in its front-matter; any choice the hook would otherwise have prompted for (target stack, project name, scope cuts) is captured as an `open_questions` entry on the phase rather than blocking the run. Users who want an opinionated spec should run `reimplementation-spec` interactively (via `/codecarto-phase reimplementation-spec` or by stopping `--auto` before the synthesis phase).

## Guardrails

These rules combine framework enforcement with explicit agent discipline:

1. **Validation gate:** Completion refuses FAIL or MISSING validation. Fix the output first and re-run validation. If validation is PASS WITH GAPS, document the gaps in the handoff's `open_questions`.
2. **Status recovery:** If `workflow/status.yaml` becomes malformed (bad YAML syntax, missing fields), do not guess at the intended state. Stop and ask the user to review the file. Compare against the phase outputs in `findings/` to reconstruct which phases are actually complete.
3. **Output path verification:** After writing a phase's primary output, verify the file path matches the `primary_output` field in the active pipeline YAML. Do not write findings to a path that belongs to a different phase.

## Output Placement Rules

- Durable findings go under `findings/<phase>/`.
- Rough working notes go under `scratch/`.
- The primary outputs are listed in the deliverables table above.
- Secondary outputs are created only when needed, using `mode: append`.
- Completion owns `closeouts/<YYYY-MM-DD>-<phase-or-module>.md` and `THREAD_LOG.md`; implementing sessions supply closeout content through their phase handoff.
- Cross-cutting patterns go in `CONVENTIONS.md`; numbered cross-cutting decisions go in `DECISIONS.md`. Both are orchestrator-maintained — phase executors propose in their closeout, the orchestrator promotes at the phase boundary.
- Do not store durable findings only in `THREAD_LOG.md`. The log is an index, not the primary artifact store.

## Folder Layout

```
your-repo/
  src/                         # Your source code (whatever structure it has).
  ...
  .codecarto/                  # This folder. All CodeCartographer files live here.
    GUIDE.md                   # This file. LLM entry point.
    findings/
      architecture/            # System structure, layers, dependency direction.
      defect-scan/             # Multi-pass defect report (used by the legacy single-scan pipelines).
        passes/                # Per-category analysis instructions (6 pass files; reused by the split phases below).
      defect-scan-mechanical/  # Early defect pass (passes 1, 2, 6); used by full-with-deep-audit.
      defect-scan-semantic/    # Deep defect pass (passes 3, 4, 5); used by full-with-deep-audit.
      contracts/               # User-visible behavior, defaults, acceptance checks.
      protocols/               # Event streams, state machines, persistence formats.
      porting/                 # Reverse-engineering synthesis bundle.
      reimplementation-spec/   # Final language-agnostic build spec.
      public-surfaces/         # (Optional) Extracted public interface notes.
      runtime-lifecycle/       # (Optional) Extracted runtime sequence notes.
      state-and-storage/       # (Optional) Extracted durable state notes.
      build-and-deploy/        # (Optional) Build pipeline and packaging notes.
      config-model/            # (Optional) Configuration inheritance and env behavior.
    scratch/                   # Disposable analysis notes plus framework handoffs/checkpoints.
      handoffs/<phase>.yaml    # Structured state/closeout proposal consumed by completion.
    templates/                 # Output templates and log entry templates.
    skills/
      spec-delta-application/  # Post-pipeline skill: apply triaged spec deltas with citation discipline.
        SKILL.md
    workflow/
      pipeline-full-with-deep-audit.yaml  # 7-phase pipeline with split defect scan (default).
      pipeline-full-with-audit.yaml       # 6-phase pipeline with single early defect scan.
      pipeline.yaml                       # 5-phase (no defect scan).
      pipeline-defect-scan.yaml           # 2-phase (architecture + defect scan).
      pipeline-lite.yaml                  # 3-phase (no porting or reimpl).
      pipeline-architecture-only.yaml     # 1-phase (architecture only).
      pipeline-synthesis.yaml             # 4-phase forward synthesis (Pi/MCP only).
      status.yaml              # Per-project progress. Single source of truth.
      VALIDATE.md              # Validation protocol. Run after every phase.
    closeouts/                 # Per-session closeout files (replaces monolithic THREAD_LOG body).
      <YYYY-MM-DD>-<phase-or-module>.md
    broadside/                 # Batch reconnaissance state and results (see broadside/SKILL.md).
      SKILL.md                 # How to read Broad-Side scouting leads (unverified, not evidence).
      config.yaml              # Broad-Side model/key/lens configuration.
      <run-id>/                # Per-run JSON + markdown findings, run-meta.json, synthesis report.
    CONVENTIONS.md             # (Optional, project-grown) Cross-cutting invariants. Orchestrator-maintained.
    DECISIONS.md               # (Optional, project-grown) Numbered decisions log. Orchestrator-maintained.
    BACKLOG.md                 # (Optional) Deferred items with rationale.
    THREAD_LOG.md              # Cross-session INDEX of closeout files.
    CONTRIBUTING.md            # Contribution guidelines.
    LICENSE                    # MIT License.
```
