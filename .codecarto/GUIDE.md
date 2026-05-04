# CodeCartographer — LLM Session Guide

## What This Is

This is a structured reverse-engineering workspace embedded inside a repository. You are an LLM assistant. Your job is to analyze the source code in this repository (the parent directory, `../`) and produce a reusable evaluation bundle: an architecture map, behavioral contracts, protocol and state notes, a porting synthesis, and a reimplementation spec.

All CodeCartographer files live inside this `.codecarto/` folder. The source code is everything outside it.

Work in explicit phases. Do not try to do everything at once.

## Roles

CodeCartographer distinguishes two roles. They are different jobs, often held by different threads, and the framework's discipline depends on both existing.

**Implementing session.** One phase or one module of work, fresh thread, follows a SKILL.md and a template, validates, writes a closeout, ends. The bulk of the framework — phases, skills, templates, validation gates — is written for this role. The "You are an LLM assistant" framing in "What This Is" addresses this role.

**Orchestrator.** One persistent thread (typically the first LLM the user points at the project) paired with the human user. The orchestrator holds cross-session context, drafts implementing-session prompts from prior closeouts, curates `CONVENTIONS.md` and `DECISIONS.md` (promoting patterns when they recur), and gates strategic forks the user makes. **The orchestrator does not execute pipeline phases itself** — that is the implementing-session role. The orchestrator's deliverables are *prompts and curated artifacts*, not phase outputs. When the orchestrator finds itself reading a SKILL.md or producing a `findings/<phase>/<primary-output>.md`, it has slipped into the implementing-session role and should stop, draft a prompt, and hand off instead. Without an orchestrator, the framework still works phase-by-phase but cross-cutting conventions and decisions don't accumulate, and each implementing session re-discovers what prior sessions established.

If you are an LLM reading this guide for the first time on a project where `CONVENTIONS.md` and `DECISIONS.md` are unwritten (still showing template content) and `closeouts/` is empty, **see "First-Time Project Setup" below before starting any phase.**

## First-Time Project Setup

If this is the first LLM to touch this project — no closeouts in `closeouts/`, `CONVENTIONS.md` and `DECISIONS.md` still showing template skeletons, `workflow/status.yaml` at defaults — stop before starting any pipeline phase and have a one-time role conversation with the user. Combine the explanation and the ask in one structured prompt:

> "I see this is a fresh CodeCartographer-equipped project. Before I start the analysis, one one-time decision: would you like me to take on the **orchestrator role** for this project, or work session-by-session?
>
> The orchestrator role means I'd hold cross-session context across the entire project — drafting prompts for implementation threads you'll spin up, curating two project-wide files (`CONVENTIONS.md` for patterns and `DECISIONS.md` for cross-cutting calls), and gating the strategic forks where you'd want to make a call.
>
> How it works in practice: this thread becomes the orchestrator; you spin up fresh threads for each implementation session using the prompts I draft, run them, and paste the closeout report back here. I update `CONVENTIONS.md`/`DECISIONS.md` and prepare the next prompt. The framework's discipline compounds across sessions instead of being reinvented each time.
>
> One operational tip: if your coding agent supports renaming and pinning threads, rename this thread to "Orchestrator" and pin it. Keeps it organized and quick to find when you switch back from implementation threads.
>
> The alternative is session-by-session work with no cross-session context — the framework still works phase-by-phase, but `CONVENTIONS.md` stays empty and each session has to re-derive patterns from prior closeouts. Better for one-off audits; worse for long-running multi-module projects.
>
> Which would you like?"

If the user accepts the orchestrator role:

1. Initialize `CONVENTIONS.md` from `templates/conventions-template.md` and `DECISIONS.md` from `templates/decisions-template.md` (skeletons only — populate as patterns and decisions accumulate).
2. Set `project_name` in `workflow/status.yaml`.
3. **Do not run the architecture phase yourself.** The orchestrator never executes pipeline phases — that is the implementing-session role (see §Roles). Instead, **draft an implementing-session prompt for the architecture phase** that a fresh thread will execute. Hand the prompt to the user; they spin up a new thread with it; the implementing thread runs the phase, validates, writes a closeout, and reports back; you (the orchestrator) read the returned closeout, update `CONVENTIONS.md` / `DECISIONS.md` / `workflow/status.yaml` per the closeout ritual, and draft the next phase's prompt. **Phase work always happens in fresh implementing-session threads, never in the orchestration thread.** A useful self-check: if you find yourself reading a `findings/<phase>/SKILL.md` or writing a `findings/<phase>/<primary-output>.md`, you have slipped into the implementing-session role — stop, draft the prompt, hand off.

If the user declines:

1. Note in `THREAD_LOG.md` that the project runs in degraded no-orchestrator mode.
2. Proceed phase-by-phase as a standalone implementing session.
3. `CONVENTIONS.md` and `DECISIONS.md` stay as templates; closeouts accumulate but cross-cutting promotion doesn't happen.

If the user is ambivalent, default to recommending the orchestrator path for any project expected to span more than one phase or module — the framework's compounding-discipline benefits are real and the cost is just paste-and-react work for the user.

## First Read For New Sessions

Read these files in order before doing any analysis:

1. This `GUIDE.md` (you are here — `.codecarto/GUIDE.md`).
2. `workflow/status.yaml` to see which phases are done and what is next.
3. The current phase's existing output file, if one exists (to avoid repeating work).
4. The current phase's `SKILL.md` for detailed instructions on what to analyze and produce.
5. The output template from `templates/` for the current phase (if starting a new output).

All paths in this guide are relative to `.codecarto/` unless stated otherwise.

If `project_name` in `workflow/status.yaml` is blank, set it to the name of this repository before starting analysis.

Treat this workspace as durable memory across sessions. Do not invent a new structure. Use the one that exists.

## Trust Boundaries

Some files in this workspace are **read-only instructions** and must not be modified during analysis. Others are **writable outputs** that you create or update.

| Category | Files | Access |
|---|---|---|
| Orchestration (read-only) | `GUIDE.md`, `CONTRIBUTING.md`, `LICENSE` | Read only. Never modify. |
| Skills (read-only) | `findings/*/SKILL.md`, `findings/defect-scan/passes/*.md`, `skills/*/SKILL.md` | Read only. Never modify. |
| Templates (read-only) | `templates/*.md` | Read only. Never modify. |
| Pipeline definitions (read-only) | `workflow/pipeline*.yaml`, `workflow/VALIDATE.md` | Read only. Never modify. |
| Source code (read-only) | `../` (everything outside `.codecarto/`) | Read only. Analyze but never modify. |
| Workflow state (read-write) | `workflow/status.yaml` | Update to track progress. |
| Findings (read-write) | `findings/<phase>/<primary-output>.md`, secondary output files | Create and update during phases. |
| Closeouts (read-write, append-only) | `closeouts/<date>-<phase-or-module>.md`, `THREAD_LOG.md` | Each session writes a new closeout file; `THREAD_LOG.md` is an INDEX pointing to closeouts. |
| Conventions (orchestrator-maintained) | `CONVENTIONS.md` | Cross-cutting patterns promoted to project-wide invariants. Implementing sessions propose; the orchestrator writes. |
| Decisions (orchestrator-maintained, append-only) | `DECISIONS.md` | Numbered log of decisions that diverge from spec, prompt, or obvious-default. Appended at session close. |
| Backlog (read-write) | `BACKLOG.md` | Deferred items with rationale. |
| Scratch (read-write) | `scratch/*` | Disposable working notes. |

If you are uncertain whether a file should be modified, treat it as read-only.

## Pipeline Selection

Six pipeline variants are available. Check the `pipeline` field in `workflow/status.yaml` to see which is active.

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

- **`CONVENTIONS.md`** — cross-cutting patterns that have been promoted to project-wide invariants (e.g., a shared discriminated-union return shape, a tripwire-naming vocabulary, a verbatim-spec-quote discipline). Implementing sessions propose additions in their closeout; the orchestrator promotes them. New conventions land when a third independent session reaches for the same pattern, or when a spec/feedback corpus identifies a project-wide invariant.
- **`DECISIONS.md`** — append-only numbered log of cross-cutting decisions that diverge from spec, prompt, or obvious-default. Each entry: `D<NNN> | <one-liner> | <source-session> | <rationale-pointer>`. Categories partition the namespace (type system, toolchain, module-internal patterns, lifted primitives, etc.).

Both files are skeletons in the framework templates (`templates/conventions-template.md`, `templates/decisions-template.md`) and become project-specific artifacts when a session writes to them. They are *orchestrator-maintained*, not implementer-edited — implementing sessions propose, the orchestrator promotes.

## Context Budget

Before beginning a phase, estimate how much source material you need to read. For large codebases:

- Read structural files first (manifests, entrypoints, READMEs) from the repository root (`../`).
- Use the architecture map to prioritize which packages to read in detail.
- Defer deep reads until the current phase actually needs them.
- If you are running low on context, finish the current section, write a PARTIAL validation, and document what remains in `open_questions` (truly unknown) or `carry_forward` (deferred to a specific later phase) in status.yaml. See "Open Questions vs Carry-Forward" below.

### Subagent Delegation for Large Codebases

For codebases over roughly 50 source files or 100K LOC, do not burn primary context on bulk extraction work. Delegate dependency mapping, file inventories, manifest enumeration, and cross-document comparisons to subagents and cite their scratch artifacts (`scratch/<topic>.md`) from the primary output. The primary session reads the synthesized scratch note, not the raw walks. Bless this pattern explicitly so primary context stays for the load-bearing reasoning that the subagent can't do — naming layers, pinning invariants, classifying findings.

### Open Questions vs Carry-Forward

`open_questions` does two distinct jobs that the schema separates explicitly:

- **`open_questions`** — items that are *still genuinely unknown*. Need more evidence (a runtime test, a maintainer decision, a spec ruling). Not resolvable by any later phase in the current pipeline.
- **`carry_forward`** — items that are deferred to a specific later phase because the current phase can't responsibly close them but the pipeline naturally will. Each entry has a target phase.

Both lists carry structured entries. Recommended shape:

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
```

`kind` is one of: `needs-runtime-test`, `needs-maintainer-decision`, `needs-spec-ruling`, `defer-to-phase`, `needs-fixture-capture`. The downstream phase scans `carry_forward` entries whose `target_phase` matches its own ID and either resolves them (deleting the entry) or re-defers (updating `target_phase`).

## Phase Selection Logic

1. Load the active pipeline YAML (see `pipeline` field in `workflow/status.yaml`).
2. Load `workflow/status.yaml`.
3. Traverse `phase_order` in order.
4. Pick the first phase whose status is not `complete` and whose `depends_on` phases are all `complete`.
5. Load that phase's `skill_path` and all files listed in `required_reads`.
6. Run the phase. Write output to `primary_output`.
7. Run validation per `workflow/VALIDATE.md`. Append the validation block to the output.
8. Enforce completion rules: the primary output file must exist with a PASS or PASS WITH GAPS validation block, status.yaml must reflect completion, and THREAD_LOG.md must have a handoff entry.

**Parallel phase warning:** Some phases share the same `depends_on` and can run concurrently (e.g., `contracts` and `protocols` both depend only on `architecture`). If two sessions update `status.yaml` at the same time, the second write will overwrite the first. When running parallel phases, update `status.yaml` carefully — read the file immediately before writing, and preserve the status of any phase completed by a sibling session.

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
2. Update `workflow/status.yaml` (the single source of truth for progress): mark the phase status as `complete`, advance `current_phase` to the next pending phase, and update both `open_questions` and `carry_forward`. When all phases in the pipeline are complete, set `current_phase` to `complete`.
3. Record 2-3 key observations in `owner_notes` for the completed phase (e.g., row counts, notable decisions, scope of analysis).
4. Write a per-session closeout file at `closeouts/<YYYY-MM-DD>-<phase-or-module>.md` using `templates/closeout-template.md`. Append a one-line index entry to `THREAD_LOG.md` pointing at it.
5. Store the durable output in the declared `findings/` path.
6. If the session made cross-cutting decisions or discovered project-wide invariants, propose additions to `CONVENTIONS.md` (in the closeout's "Proposed Conventions" section) and `DECISIONS.md` (numbered entries in the closeout's "Decisions Beyond Prompt" section). The orchestrator promotes these to the canonical files.

### Strategic Alignment Hook (before synthesis)

Before starting `reimplementation-spec` (or any synthesis phase), confirm with the user — explicitly, in chat — whether the spec is:

- **Language-agnostic** (the default; "any port to any stack"), or
- **Opinionated** (target stack, project identity, scope cuts, named primitives are pre-locked).

This conversation produces inputs the synthesis phase actually needs (locked target stack, locked project name, locked scope cuts) and selects the right template. If the answer is "opinionated," use `templates/reimplementation-spec-opinionated.md` instead of the default. Skipping the hook produces a generic spec when the user wanted a specific one — the most informative friction the framework has produced to date. A two-question pre-flight is cheap.

## Guardrails

These rules cannot be enforced by the template — they rely on the LLM following instructions. A future code-backed implementation should enforce them programmatically.

1. **Validation gate:** Never set a phase's status to `complete` in `status.yaml` if the validation block contains any FAIL result. Fix the output first, re-run validation, and only then mark complete. If the validation is PASS WITH GAPS, document the gaps in `open_questions` before marking complete.
2. **Status recovery:** If `workflow/status.yaml` becomes malformed (bad YAML syntax, missing fields), do not guess at the intended state. Stop and ask the user to review the file. Compare against the phase outputs in `findings/` to reconstruct which phases are actually complete.
3. **Output path verification:** After writing a phase's primary output, verify the file path matches the `primary_output` field in the active pipeline YAML. Do not write findings to a path that belongs to a different phase.

## Output Placement Rules

- Durable findings go under `findings/<phase>/`.
- Rough working notes go under `scratch/`.
- The primary outputs are listed in the deliverables table above.
- Secondary outputs are created only when needed, using `mode: append`.
- Per-session closeouts go under `closeouts/<YYYY-MM-DD>-<phase-or-module>.md`. `THREAD_LOG.md` is an INDEX of one-line pointers to those closeouts, not the primary store.
- Cross-cutting patterns go in `CONVENTIONS.md`; numbered cross-cutting decisions go in `DECISIONS.md`. Both are orchestrator-maintained — implementing sessions propose in their closeout, the orchestrator promotes.
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
    scratch/                   # Disposable analysis notes.
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
      status.yaml              # Per-project progress. Single source of truth.
      VALIDATE.md              # Validation protocol. Run after every phase.
    closeouts/                 # Per-session closeout files (replaces monolithic THREAD_LOG body).
      <YYYY-MM-DD>-<phase-or-module>.md
    CONVENTIONS.md             # (Optional, project-grown) Cross-cutting invariants. Orchestrator-maintained.
    DECISIONS.md               # (Optional, project-grown) Numbered decisions log. Orchestrator-maintained.
    BACKLOG.md                 # (Optional) Deferred items with rationale.
    THREAD_LOG.md              # Cross-session INDEX of closeout files.
    CONTRIBUTING.md            # Contribution guidelines.
    LICENSE                    # MIT License.
```
