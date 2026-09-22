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

  Scenario IDs are stable handles (S-01, S-02, ...): slices below cite them,
  and a row number is not a handle once rows are inserted. Tier says which
  scope tier the scenario belongs to, so "every minimum-viable scenario is
  owned by a slice" is checkable rather than a hope.
-->

| Scenario ID | Tier | Scenario | Input | Expected Output / Side Effect |
|-------------|------|----------|-------|-------------------------------|
| S-01 | minimum-viable | | | |

## Slices

<!--
  The unit of reviewable work. A slice is a promise plus the scenarios that
  prove the promise was kept. This is what an engineering change is planned
  from, so the columns are the record's own vocabulary and lift directly into
  a slice record without translation.

  Rules a session must follow:
  - Slice IDs are stable (SL-01, SL-02, ...) and never renumbered.
  - "Proves scenarios" lists Scenario IDs from the table above. Every ID must
    exist there. An empty proof list is not a plan: a slice that proves
    nothing cannot be reviewed, and no proof is worse than a weak one because
    it hides that the question was never asked.
  - Every scenario tiered minimum-viable must appear in some slice's "Proves
    scenarios". An unowned minimum-viable scenario means the port can be
    "done" without it, which contradicts the tier.
  - "Depends on" lists Slice IDs that must be accepted first.
  - Obligations stay language-neutral here: name WHAT must be observed, not
    the command that observes it. Executable proof commands belong in the
    opinionated variant, where the target stack is known.
-->

| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier |
|----------|-------------|---------|------------------|------------|------|
| SL-01 | | | S-01 | | minimum-viable |

## Deliberate Non-Goals

<!--
  Features intentionally deferred, source-specific UX not worth carrying over,
  integrations that will be stubbed first.
-->

## Coverage and limits

- Inspected scope:
- Skipped scope:
- Evidence basis: source inspection | tests | runtime verification | upstream findings
- Known blind spots:
- Coverage disposition: COMPLETE | PARTIAL

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
     above. A carry_forward entry needs a target_phase that is a LATER phase of the active pipeline —
     completion refuses anything else — so in a pipeline where this phase is last, this table stays empty.
     Work for after the pipeline (spikes, deltas, amendments, maintainer rulings, opinionated reruns) goes
     in the handoff's post_pipeline list instead: { id, kind: spike | delta | amendment, description }.
     An amendment retires those entries once the pipeline is complete. -->

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
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS / PARTIAL / FAIL | |
| 7 | Lower-level findings are deep-read only when the porting bundle identifies a gap, conflict, missing acceptance detail, or defect rationale. | PASS / PARTIAL / FAIL | |
| 8 | Every slice names at least one scenario it proves, and every Scenario ID it lists exists in the Acceptance Scenarios table. | PASS / PARTIAL / FAIL | |
| 9 | Every minimum-viable scenario is owned by at least one slice. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
