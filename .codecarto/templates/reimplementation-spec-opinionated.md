# Reimplementation Spec — <Project Name>

<!--
  Output template for the reimplementation-spec phase, OPINIONATED variant.

  Use this template when the orchestrator's strategic-alignment hook (see GUIDE.md) has
  pre-locked: target stack, project identity, scope cuts, named modules, and named primitives.

  This is a SIBLING of templates/reimplementation-spec.md (the language-agnostic default), not a
  replacement. Pick at session start based on the strategic-alignment conversation:

  - Default (any port to any stack)        → templates/reimplementation-spec.md
  - Opinionated (locked stack + identity)  → templates/reimplementation-spec-opinionated.md (this file)

  The differences from the default template:
    - Project identity (name, language, runtime, lint/format toolchain) is fixed at the top.
    - "External Dependencies" is replaced with "Locked Stack" — the answer is given, not chosen.
    - "Layer Split" is replaced with "Named Module Inventory" — modules have committed names.
    - "Acceptance Scenarios" stays — scenarios are independent of stack choice.
    - Adds "Spec Conventions" (citation forms, evidence-level codes, [revised per ...] marker).
    - Adds "Spike List" up-front because opinionated specs typically pre-identify spikes.

  Fill in each section. Remove placeholder text. Keep the section headers.
-->

## Project Identity

| Field | Value |
|---|---|
| **Project name** | <e.g., Thaumaturge> |
| **CLI command** | <e.g., thaum> |
| **Primary language / runtime** | <e.g., TypeScript on Bun> |
| **License** | <e.g., Apache-2.0> |
| **Lint / format / test toolchain** | <e.g., oxlint, oxfmt, bun test> |
| **Target platforms** | <e.g., macOS x64/aarch64, Linux x64/aarch64> |
| **Source we are porting** | <e.g., codex (../) — see findings/architecture/architecture-map.md> |

## System Summary

<!-- Restate the system's purpose and scope for the person who will build the new version. -->

## Spec Conventions

<!-- Up-front so a reader knows how to interpret citations and markers. -->

- **Section anchors** are H2 (`##`) and H3 (`###`). Cross-references in the spec use `§<section>`.
- **Source citations** by phase: `[contracts §X]`, `[protocols §X]`, `[porting Finding N]`,
  `[defect-scan §Pass.N]`.
- **Evidence levels** appear inline in italic: *observed fact*, *strong inference*,
  *portability hazard*, *open question*.
- **Revised markers** for post-pipeline delta applications: `[revised per <source> §<delta-id>]`
  (see `skills/spec-delta-application/SKILL.md`).
- **Required behaviors** are normative. The verb form pins the rule:
  - "MUST" = invariant, fail-build-if-violated.
  - "SHOULD" = strong default; deviation requires justification in DECISIONS.md.
  - "MAY" = permitted; both behaviors are valid.

## Named Module Inventory

<!--
  Modules have committed names because the stack is locked. List every module the
  reimplementation will produce, in dependency-from-leaf-to-root order.
-->

| Module | Responsibility | Public Inputs | Public Outputs | Owned State | Depends On |
|---|---|---|---|---|---|
| <module-name-1> | | | | | |
| <module-name-2> | | | | | |

## Locked Stack

<!--
  The opinionated equivalent of "External Dependencies." The answer is given, not chosen.
  List every external dependency with the committed choice and rationale.
-->

| Dependency | Committed Choice | Rationale | Stance (replace/wrap/emulate/postpone source) |
|---|---|---|---|
| <e.g., HTTP client> | <e.g., native fetch> | <e.g., Bun ships it; zero-dep target> | replace |
| <e.g., Sandbox primitive> | <e.g., landlock + seccomp on Linux, sandbox-exec on macOS> | <e.g., kernel-supported> | replace |

## Required Behaviors

<!-- What the reimplementation must do. Derived from contracts. Use MUST/SHOULD/MAY pinning. -->

## Protocols and Persisted State

<!-- Wire formats, state machines, and persistence rules that must be preserved.
     Derived from protocols. Cite back to protocols phase by section anchor. -->

## Portability Hazards

<!-- Risks specific to the locked stack. (In opinionated mode, "portability across stacks" is
     not a concern; "portability across OS targets within the locked stack" usually is.) -->

## Implementation Sequence

<!-- Suggested build order, named-module by named-module. -->

### Module Order

1. <module-1>  — <one-line: what unblocks after this is done>
2. <module-2>  — ...
3. ...

### Scope Tiers

**v0 (minimum viable port):**
<!-- Which named modules ship in v0; which are tripwire-stubbed (see CONVENTIONS.md). -->

**v1 (major-workflow parity):**
<!-- Which modules promote from stub to real; which new modules land. -->

**v2 (full parity):**
<!-- Final state. -->

## Acceptance Scenarios

<!--
  Black-box checks with concrete inputs and observable outputs.
  Independent of source-language internals. The acceptance scenarios are the same for both
  language-agnostic and opinionated modes — what differs is the implementation, not the
  observable contract.
-->

| # | Scenario | Input | Expected Output / Side Effect |
|---|----------|-------|-------------------------------|
| 1 | | | |

## Spike List

<!--
  In opinionated mode, the spike list is up-front (the orchestrator usually has identified
  the spikes during strategic alignment). Each spike has a goal, a success criterion, and a
  named scratch directory.
-->

| # | Spike | Goal | Success Criterion | Scratch Path |
|---|---|---|---|---|
| 1 | | | | spikes/<id>/ |

## Deliberate Non-Goals

<!--
  Features intentionally deferred, source-specific UX not worth carrying over,
  integrations that will be stubbed first.
-->

## Known Unknowns

<!-- Items that are still genuinely unknown — need a prototype, runtime test, maintainer decision,
     or spec ruling. Same shape as the language-agnostic template. -->

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Carry-Forward

<!-- Items deferred to post-pipeline work (spike, delta, amendment).
     Each entry: { id, kind: defer-to-phase, target_phase, description, deferred_reason }. -->

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| | | | |

---

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. Same criteria as the language-agnostic template;
     the opinionated form changes the body, not the validation rubric. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Concept-level modules are defined. | PASS / PARTIAL / FAIL | |
| 2 | Required behaviors are stated. | PASS / PARTIAL / FAIL | |
| 3 | Protocol and persisted state expectations are stated. | PASS / PARTIAL / FAIL | |
| 4 | Acceptance scenarios and known unknowns are included. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
