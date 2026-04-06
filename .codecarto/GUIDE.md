# CodeCartographer — LLM Session Guide

## What This Is

This is a structured reverse-engineering workspace embedded inside a repository. You are an LLM assistant. Your job is to analyze the source code in this repository (the parent directory, `../`) and produce a reusable evaluation bundle: an architecture map, behavioral contracts, protocol and state notes, a porting synthesis, and a reimplementation spec.

All CodeCartographer files live inside this `.codecarto/` folder. The source code is everything outside it.

Work in explicit phases. Do not try to do everything at once.

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
| Skills (read-only) | `findings/*/SKILL.md`, `findings/defect-scan/passes/*.md` | Read only. Never modify. |
| Templates (read-only) | `templates/*.md` | Read only. Never modify. |
| Pipeline definitions (read-only) | `workflow/pipeline*.yaml`, `workflow/VALIDATE.md` | Read only. Never modify. |
| Source code (read-only) | `../` (everything outside `.codecarto/`) | Read only. Analyze but never modify. |
| Workflow state (read-write) | `workflow/status.yaml` | Update to track progress. |
| Findings (read-write) | `findings/<phase>/<primary-output>.md`, secondary output files | Create and update during phases. |
| Logs (read-write) | `THREAD_LOG.md` | Append entries at session end. |
| Scratch (read-write) | `scratch/*` | Disposable working notes. |

If you are uncertain whether a file should be modified, treat it as read-only.

## Pipeline Selection

Five pipeline variants are available. Check the `pipeline` field in `workflow/status.yaml` to see which is active.

- If the field is **empty**, ask the user which scope to use.
- If the field points to a **file that does not exist**, stop and ask the user to correct it. Do not guess or fall back to the default pipeline.

| Variant | File | Phases | When to use |
|---|---|---|---|
| Full (default) | `workflow/pipeline.yaml` | architecture → contracts → protocols → porting → reimplementation-spec | Complete reverse-engineering bundle for porting |
| Full with audit | `workflow/pipeline-full-with-audit.yaml` | architecture → defect-scan → contracts → protocols → porting → reimplementation-spec | Porting bundle with defect triage to avoid carrying legacy bugs |
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

## Context Budget

Before beginning a phase, estimate how much source material you need to read. For large codebases:

- Read structural files first (manifests, entrypoints, READMEs) from the repository root (`../`).
- Use the architecture map to prioritize which packages to read in detail.
- Defer deep reads until the current phase actually needs them.
- If you are running low on context, finish the current section, write a PARTIAL validation, and document what remains in `open_questions` in status.yaml.

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
3. Read the current phase's existing output, if present.
4. Read the current phase's `SKILL.md`.
5. Read the output template from `templates/` for the current phase (if starting a new output).

When a session finishes durable work:

1. Run the validation step described in `workflow/VALIDATE.md`. Append a validation block to the output.
2. Update `workflow/status.yaml` (the single source of truth for progress): mark the phase status as `complete`, advance `current_phase` to the next pending phase, and update `next_actions`. When all phases in the pipeline are complete, set `current_phase` to `complete`.
3. Record 2-3 key observations in `owner_notes` for the completed phase (e.g., row counts, notable decisions, scope of analysis).
4. Append one short summary entry to `THREAD_LOG.md`.
5. Store the durable output in the declared `findings/` path.

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
- Do not store durable findings only in `THREAD_LOG.md`. The log is a cross-session pointer, not the primary artifact store.

## Folder Layout

```
your-repo/
  src/                         # Your source code (whatever structure it has).
  ...
  .codecarto/                  # This folder. All CodeCartographer files live here.
    GUIDE.md                   # This file. LLM entry point.
    findings/
      architecture/            # System structure, layers, dependency direction.
      defect-scan/             # Multi-pass defect report with severity and actions.
        passes/                # Per-category analysis instructions (6 pass files).
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
    workflow/
      pipeline.yaml            # Full 5-phase pipeline definition.
      pipeline-full-with-audit.yaml    # 6-phase variant (adds defect scan before porting).
      pipeline-defect-scan.yaml        # 2-phase variant (architecture + defect scan).
      pipeline-lite.yaml       # 3-phase variant (no porting or reimpl).
      pipeline-architecture-only.yaml  # 1-phase variant (architecture only).
      status.yaml              # Per-project progress. Single source of truth.
      VALIDATE.md              # Validation protocol. Run after every phase.
    THREAD_LOG.md              # Cross-session summary log.
    CONTRIBUTING.md            # Contribution guidelines.
    LICENSE                    # MIT License.
```
