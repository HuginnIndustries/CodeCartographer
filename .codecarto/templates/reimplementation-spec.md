# Reimplementation Spec

<!--
  Output template for the reimplementation-spec phase.
  This is the final deliverable: a language-agnostic build plan.
  Fill in each section. Remove placeholder text. Keep the section headers.
-->

## System Summary

<!-- Restate the system's purpose and scope for the person who will build the new version. -->

## Conceptual Module Model

<!--
  For each module:
  - Responsibility (one sentence)
  - Public inputs and outputs
  - Owned state and invariants
  - Collaborators and dependencies
-->

### [Module Name]

| Field | Value |
|---|---|
| **Responsibility** | |
| **Public inputs** | |
| **Public outputs** | |
| **Owned state** | |
| **Invariants** | |
| **Collaborators** | |

<!-- Repeat for each module. -->

## Layer Split

<!--
  Assign each module to one of:
  - core semantics: behavior that must survive the port unchanged
  - adapters: integrations with terminal, browser, filesystem, cloud APIs, SDKs
  - delivery surfaces: CLI, TUI, web, bot, daemon, deployment wrappers
-->

| Module | Layer | Notes |
|---|---|---|
| | | |

## Required Behaviors

<!-- What the reimplementation must do. Derived from contracts. -->

## Protocols and Persisted State

<!-- What wire formats, state machines, and persistence rules must be preserved. Derived from protocols. -->

## External Dependencies

<!-- For each external dependency, choose a stance. -->

| Dependency | Stance (replace/wrap/emulate/postpone) | Rationale |
|---|---|---|
| | | |

## Portability Hazards

<!-- Risks specific to the reimplementation effort. -->

## Implementation Sequence

<!-- Suggested build order. -->

### Scope Tiers

**Minimum viable port:**
<!-- What must work for the system to be usable at all. -->

**Major-workflow parity:**
<!-- What must work to cover the primary use cases. -->

**Full parity:**
<!-- Everything the original does. -->

## Acceptance Scenarios

<!--
  Black-box checks with concrete inputs and observable outputs.
  No references to source-language internals.
-->

| # | Scenario | Input | Expected Output / Side Effect |
|---|----------|-------|-------------------------------|
| 1 | | | |

## Deliberate Non-Goals

<!--
  Features intentionally deferred, source-specific UX not worth carrying over,
  integrations that will be stubbed first.
-->

## Known Unknowns

<!-- Items that are still genuinely unknown — need a prototype, runtime test, maintainer decision, or spec ruling.
     This is the reimplementation-spec phase's terminal "open_questions" — items the pipeline can't close
     because they require executing code (a spike) or a decision the orchestrator owns.
     Each entry: { id, kind, description, deferred_reason }. -->

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Carry-Forward

<!-- Reimplementation-spec is the terminal phase in most pipelines, so most items belong in Known Unknowns
     above. Use this section only when post-pipeline work (spikes, deltas, amendments) is the right place
     to close an item. Each entry: { id, kind: defer-to-phase, target_phase, description, deferred_reason }.
     Allowed target_phase values for post-pipeline: "spike", "delta", "amendment". -->

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Spike List

<!--
  - Unknown behaviors that need a prototype
  - Risky performance assumptions
  - Platform-sensitive areas that need targeted tests
-->

---

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the full pipeline.
     Adjust rows to match your active pipeline's completion_criteria if using a variant. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Concept-level modules are defined. | PASS / PARTIAL / FAIL | |
| 2 | Required behaviors are stated. | PASS / PARTIAL / FAIL | |
| 3 | Protocol and persisted state expectations are stated. | PASS / PARTIAL / FAIL | |
| 4 | Acceptance scenarios and known unknowns are included. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
