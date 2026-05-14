# CodeCartographer Synthesis Phases — Design Plan

Branch: `claude/design-synthesis-phases-mtfUw`
Status: design proposal, awaiting maintainer approval before implementation.

## Context

CodeCartographer today walks an LLM through phases that reverse-engineer a codebase into `findings/reimplementation-spec/reimplementation-spec.md` — a language-agnostic build plan. This plan extends the tool with **forward-flowing synthesis phases** that consume one or more existing reimplementation-specs (plus a user-written vision) and produce a new project plan.

End-state workflow this enables:

1. Analyze N repos with CodeCartographer.
2. Each analysis contributes a spec to a local **library**.
3. Write a vision for a new project (`vision.md`).
4. `goal-synthesis` combines library entries matching the vision into `project-plan.md`.

### Decisions locked in (Q1–Q8)

- **Q1 input model.** Single synthesis workspace + an external library directory. Library is detect-or-create; default `.codecarto/library/`, configurable.
- **Q2 pipeline shape.** New `pipeline-synthesis.yaml` for the synthesis side. The three analysis pipelines that include `reimplementation-spec` get one new terminal phase (`feature-index`) appended.
- **Q3 library mutability.** Versioned. Each entry lives at `library/entries/<slug>/v<N>/` with a `latest` pointer; re-analyzing writes a new version.
- **Q4 entry selection for goal-synthesis.** LLM-proposes-user-confirms, implemented as two phases (`goal-synthesis-propose` + `goal-synthesis-finalize`). Confirmation works by editing the proposal's validation block — no new gate machinery (see "Propose/confirm mechanism" below).
- **Q5 vision-capture depth.** Single normalizer phase. Deep staged refinement is SwarmLord's job (separately).
- **Q6 spec-merge.** Optional standalone phase; `goal-synthesis-finalize` can also merge inline.
- **Q7 library detect-or-create.** Drop-in workspace asks user where to point/create the library. Pi extension may manage location.
- **Q8 vision-capture work.** Substantive — asks clarifying questions, proposes structure, fills missing sections. Borrows section headers (Outcome / User Workflows / Implementation Direction / Interfaces / Acceptance Criteria / Test Plan) from SwarmLord's build-spec as design inspiration only.

### Scope boundary

SwarmLord is **not integrated**. CodeCartographer does not import SwarmLord, does not read SwarmLord packets, and does not ship a SwarmLord runner. The only SwarmLord influence is design inspiration for `vision-capture` section headers. Both tools remain independent and free to evolve.

## Propose/confirm mechanism (verified against existing code)

The Q4 propose/confirm pattern reuses the existing validation+gate model without adding any new machinery. Three load-bearing facts from `core/pipeline.ts`:

- `validatePhaseOutput` (`core/pipeline.ts:63-159`) parses validation purely from Markdown: it finds the last `## Validation` heading in the primary output, reads a table with `| # | Criterion | Result | Evidence |` rows, and an `**Overall:** PASS|PASS WITH GAPS|FAIL` line. The parser doesn't care whether the LLM or the user authored it.
- `getNextEligiblePhase` (`core/pipeline.ts:34-46`) advances when a phase's `phaseStatus === "complete"` — validation result is informational, not the hard gate. The hard gate is `/codecarto-complete` flipping status to `complete`.
- Phases are explicitly re-runnable. `buildPhasePrompt` (`core/prompts.ts:47`) tells the LLM to "continue instead of duplicating work" when the primary output already exists.

How this gives us propose/confirm "for free":

1. **First run** of `goal-synthesis-propose` emits `proposal.md` with a shortlist + a validation row `User confirmed selection | PARTIAL | awaiting checkbox confirmation` → `**Overall:** PASS WITH GAPS`.
2. **User edits** `proposal.md` to check the boxes on the entries they want.
3. **Re-run** of the same phase: LLM reads existing `proposal.md`, sees boxes checked, flips the validation row to PASS and overall to PASS.
4. User runs `/codecarto-complete` → propose phase marked complete.
5. `goal-synthesis-finalize` becomes eligible (its `depends_on` is satisfied).

The SKILL.md for `goal-synthesis-propose` must include explicit re-run prose: "If `proposal.md` exists and at least one entry is checked, update the validation block to PASS; if no entries are checked, prompt the user to select before re-running." Without it, the LLM might duplicate the proposal or skip the validation update.

`buildValidationSummary` (`core/pipeline.ts:161-175`, not `core/prompts.ts` as I'd assumed earlier) just formats the result for display; the source of truth is the parser above.

## Approach

### The library

**Location.** Default `.codecarto/library/` (repo-rooted, matches existing convention). Path declared in `.codecarto/workflow/config.yaml`. Pi extension can override the default.

**Layout.**

```
.codecarto/library/
├── index.yaml                       # registry: slugs, versions, tags, source repo, dates
├── entries/
│   └── <slug>/
│       ├── latest -> v2/            # symlink or "latest" key in entry's own index
│       ├── v1/
│       │   ├── reimplementation-spec.md
│       │   ├── feature-index.yaml
│       │   └── metadata.yaml
│       └── v2/
```

**Registration.** Triggered by `feature-index` completion. Atomic (temp dir → rename). Re-runs create `v(N+1)/`.

**Public read-side contract.** `index.yaml` and `entries/<slug>/v<N>/feature-index.yaml` are documented as stable schemas in `docs/library-format.md` from day one, so future tools (or scripts) can read entries without going through CodeCartographer.

### New phases

Each follows the existing model: pipeline YAML entry + `SKILL.md` under `.codecarto/findings/<phase>/` + `template.md` under `.codecarto/templates/`.

| Phase | Pipeline | Depends on | Primary output | Notes |
|---|---|---|---|---|
| `feature-index` | analysis (3 existing variants, extended) | `reimplementation-spec` | `findings/feature-index/feature-index.yaml` | Promotes Conceptual Module Model + Required Behaviors + Scope Tiers into structured YAML. Side-effect: registers to library. |
| `vision-capture` | synthesis (new) | — | `findings/vision-capture/vision.md` | Interactive: asks Qs, proposes structure, fills missing sections. |
| `spec-merge` | synthesis (optional) | library populated | `findings/spec-merge/merged-spec.md` | Optional pre-bake; can be skipped if `goal-synthesis-finalize` merges inline. |
| `goal-synthesis-propose` | synthesis | `vision-capture` | `findings/goal-synthesis/proposal.md` | Shortlist with rationales + `confirmed: [ ]` checkboxes. Gate: user confirms via validation block. |
| `goal-synthesis-finalize` | synthesis | `goal-synthesis-propose` | `findings/goal-synthesis/project-plan.md` | Priorities, milestones, MVP scope, deferred items, risk register. |
| `spec-mutate` | `pipeline-spec-mutate.yaml` (separate) | existing spec + `inputs/deltas.md` | `findings/spec-mutate/mutated-spec.md` | Applies deltas; attaches addenda to Carry-Forward / Spike List when ambiguity is introduced. |

### Pipeline YAML changes

- **Extend** the three analysis variants that produce a `reimplementation-spec`:
  - `.codecarto/workflow/pipeline.yaml`
  - `.codecarto/workflow/pipeline-full-with-audit.yaml`
  - `.codecarto/workflow/pipeline-full-with-deep-audit.yaml`
  Each gets `feature-index` appended with `depends_on: [reimplementation-spec]`.
- **Add** `.codecarto/workflow/pipeline-synthesis.yaml`: vision-capture → goal-synthesis-propose → goal-synthesis-finalize, with spec-merge as an optional intermediate.
- **Add** `.codecarto/workflow/pipeline-spec-mutate.yaml`: single phase.
- **Do not** modify `pipeline-architecture-only.yaml`, `pipeline-defect-scan.yaml`, or `pipeline-lite.yaml` — they do not produce a `reimplementation-spec`, so `feature-index` has nothing to consume.

### Workspace config

`.codecarto/workflow/config.yaml` gains:

```yaml
library:
  path: .codecarto/library    # or absolute path
  auto_register: true
```

If `library.path` is unset, `feature-index` prompts the user at first run and persists the choice.

### Dashboard

`core/dashboard.ts` gains:

- A **library** section showing entries, versions, registration timestamps.
- A **vision** section showing `vision.md` status when in a synthesis workspace.
- Synthesis-phase progress on the same status bar as analysis phases.

## Critical files

**New files**

- `.codecarto/workflow/pipeline-synthesis.yaml`
- `.codecarto/workflow/pipeline-spec-mutate.yaml`
- `.codecarto/findings/feature-index/SKILL.md`
- `.codecarto/findings/vision-capture/SKILL.md`
- `.codecarto/findings/spec-merge/SKILL.md`
- `.codecarto/findings/goal-synthesis/SKILL.md` (shared by propose + finalize, or split if prose diverges)
- `.codecarto/findings/spec-mutate/SKILL.md`
- `.codecarto/templates/feature-index.yaml`
- `.codecarto/templates/feature-index.md`
- `.codecarto/templates/vision.md`
- `.codecarto/templates/merged-spec.md`
- `.codecarto/templates/proposal.md`
- `.codecarto/templates/project-plan.md`
- `.codecarto/templates/mutated-spec.md`
- `core/library.ts` — library read/write helpers (entry registration, index update, version resolution)
- `docs/library-format.md` — public read-side contract

**Modified files**

- `.codecarto/workflow/pipeline.yaml` — append `feature-index`
- `.codecarto/workflow/pipeline-full-with-audit.yaml` — append `feature-index`
- `.codecarto/workflow/pipeline-full-with-deep-audit.yaml` — append `feature-index`
- `.codecarto/workflow/config.yaml` (template) — add `library` section
- `core/index.ts` — re-export library helpers
- `core/dashboard.ts` — library + vision sections
- `core/orchestrator-config.ts` — read library config
- `core/pipeline.ts` — add `pipeline-synthesis` and `pipeline-spec-mutate` aliases to `PIPELINE_ALIASES`
- `tests/pipeline-invariants.test.mjs` — new phase YAML / SKILL / template alignment
- `tests/default-pipeline.test.mjs` — assert `feature-index` runs after `reimplementation-spec`

No new slash commands. Existing `/codecarto-next` walks any DAG; the new pipelines are just additional YAMLs.

## Verification

### Manual end-to-end

1. Analyze repo A with `/codecarto-init` + `/codecarto-next --auto`. Confirm `library/entries/repo-a/v1/` exists with `reimplementation-spec.md`, `feature-index.yaml`, `metadata.yaml`.
2. Repeat for repo B and repo C.
3. Create a synthesis workspace at `~/my-project/.codecarto/`. Set `library.path` in `config.yaml` to point at the populated library. Run `/codecarto-next` against `pipeline-synthesis.yaml`.
4. Vision-capture asks clarifying questions; answer them; phase emits `vision.md`; mark validation PASS; `/codecarto-complete`.
5. Propose phase emits `proposal.md` with shortlist; check confirmation boxes on chosen entries; re-run the phase; LLM updates validation to PASS; `/codecarto-complete`.
6. Finalize phase emits `project-plan.md`.

### Invariant tests to add

- New pipeline YAMLs (`pipeline-synthesis.yaml`, `pipeline-spec-mutate.yaml`) pass existing structural invariants: `phase_order` consistent with `depends_on`, every `required_reads` path exists, every `primary_output` path is conventionally located.
- Modified analysis pipelines still pass invariants after `feature-index` is appended.
- New SKILL.md files cite real report paths.
- `feature-index.yaml` output validates against its template schema.
- Library registration is atomic + idempotent (re-running on the same spec content does not produce a spurious new version).
- The propose/confirm pattern's validation gate correctly blocks `goal-synthesis-finalize` until the propose phase is marked complete.

### Cross-surface tests

- Pi and MCP both produce byte-identical prompts for the new phases (the existing test pattern in `tests/pipeline-invariants.test.mjs`).
- Pi `tool_call` hook continues to confine writes to `.codecarto/` — verify it correctly accepts writes into the new `.codecarto/library/` subdir.

## Out of scope (v1)

- Multi-workspace synthesis (reaching into peer workspaces via a manifest).
- Parallelism for synthesis-pipeline phases — phases are short, run serially.
- Library entry diffing across versions (versioning is in place; no diff UX).
- SwarmLord packet ingestion (kept as a future option; design inspiration only for now).
- `~/.codecarto/library/` user-global library (repo-rooted only; defer global to v2).
- Library search CLI (open `index.yaml` manually).
- Retry/resume of proposal confirmation (user just re-runs the propose phase).

## Branch + commits

Branch: `claude/design-synthesis-phases-mtfUw`.

Logical commit slicing (single PR with stacked commits, or one PR per group):

1. `docs: design plan for synthesis phases` — this file.
2. `framework: library format + public read-side contract` — `docs/library-format.md`, schema templates, no behavior change.
3. `feat(core): library helpers in core/library.ts` — read/write primitives + tests, no pipeline integration yet.
4. `framework: feature-index phase (single variant first)` — SKILL, template, append to one default variant. Invariant tests pass.
5. `framework: feature-index across remaining variants` — extend the other two analysis variants.
6. `framework: pipeline-synthesis.yaml + vision-capture phase`.
7. `framework: goal-synthesis (propose + finalize)` — two phases, validation-gated propose/confirm wired in.
8. `framework: spec-merge optional phase`.
9. `framework: pipeline-spec-mutate.yaml`.
10. `feat(core): config.yaml library section + dashboard surfaces` — wire library into config + dashboard.
11. `docs: CHANGELOG + README updates for synthesis phases` — bump version, document end-to-end flow.

Each commit must keep `tests/pipeline-invariants.test.mjs` green.

## Appendix: pointers verified against current source

- `core/pipeline.ts:13-20` — `PIPELINE_ALIASES`. Add `pipeline-synthesis` and `pipeline-spec-mutate` aliases here.
- `core/pipeline.ts:34-46` — `getNextEligiblePhase`. The advancement gate; reads `phaseStatus === "complete"` only.
- `core/pipeline.ts:63-159` — `validatePhaseOutput`. The validation parser; reads the last `## Validation` block in the primary output.
- `core/pipeline.ts:161-175` — `buildValidationSummary`. Formats the result; consumed by both wrappers.
- `core/prompts.ts:35-114` — `buildPhasePrompt`. Phase prompt assembly. Line 47 is the "re-run continues instead of duplicating" instruction that makes propose/confirm work.
- `core/workspace.ts:50-77` — `getWorkspaceState`. How status + pipeline are loaded.
- `core/workspace.ts:79-110` — `updateStatusAtomically`. Status mutation with file lock; used by `/codecarto-complete`.
