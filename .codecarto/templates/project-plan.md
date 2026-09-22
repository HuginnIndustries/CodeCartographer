# Evidence-Backed Project Plan

## Product definition

## Scope

### First executable slice

### Subsequent increments

### Non-goals

## Target architecture

| Component | Responsibility | Public boundary | Owned state and invariants | Provenance |
|---|---|---|---|---|
| | | | | |

## Work packages

| ID | Deliverable | Dependencies | Acceptance gate | Risk |
|---|---|---|---|---|
| WP-01 | | | | |

## Implementation sequence

| Order | Work package | Why now | Exit evidence |
|---|---|---|---|
| 1 | | | |

## Acceptance plan

<!--
  Scenario IDs are stable handles (S-01, S-02, ...) that slices cite; a row
  number stops being a handle once rows are inserted. Tier says which scope
  tier the scenario belongs to, so minimum-viable ownership is checkable.
-->

| Scenario ID | Tier | Scenario | Input or starting state | Observable result | Source |
|---|---|---|---|---|---|
| S-01 | minimum-viable | (what is checked) | (starting state) | (observable result) | |

## Slices

<!--
  A slice is a work package restated as a promise plus the scenarios that
  prove it. It is what an engineering change is planned from, so the columns
  are the record's own vocabulary and lift straight into a slice record.

  Rules:
  - Slice IDs are stable (SL-01, SL-02, ...) and never renumbered. A slice
    normally corresponds to one work package; say which in Deliverable.
  - "Proves scenarios" lists Scenario IDs from the Acceptance plan; each must
    exist there. An empty proof list is not a plan.
  - Every minimum-viable scenario must be owned by at least one slice.
  - "Depends on" lists Slice IDs that must be accepted first.
  - Obligations are stated as what must be observed, not as commands, unless
    the target stack is already fixed by the product definition.
-->

| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier |
|---|---|---|---|---|---|
| SL-01 | WP-01 | (modules) | S-01 | | minimum-viable |

## Provenance ledger

<!-- This is the differentiating contract of the synthesis pipeline. Every load-bearing decision should map to a confirmed spec, the product vision, or an explicit synthesis decision. -->

| Decision ID | Plan decision | Source specification or vision section | Evidence level | Conflict status |
|---|---|---|---|---|
| D-01 | | | observed fact / strong inference / open question | none / resolved / open |

## Conflict and unknowns register

| ID | Issue | Disposition or owner | Blocking work package |
|---|---|---|---|
| | | | |

## Coverage and limits

- Inspected scope:
- Skipped scope:
- Evidence basis: vision | confirmed specifications | merged-spec | explicit synthesis decisions
- Known blind spots:
- Coverage disposition: COMPLETE | PARTIAL

## Validation

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | The plan defines coherent product scope, architecture, work packages, dependencies, and acceptance gates. | PASS / PARTIAL / FAIL | |
| 2 | Each load-bearing plan decision is traceable through the provenance ledger. | PASS / PARTIAL / FAIL | |
| 3 | Conflicts and unknowns remain visible with explicit dispositions. | PASS / PARTIAL / FAIL | |
| 4 | The implementation sequence identifies an executable first slice. | PASS / PARTIAL / FAIL | |
| 5 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS / PARTIAL / FAIL | |
| 6 | Every slice names at least one scenario it proves, and every Scenario ID it lists exists in the Acceptance plan. | PASS / PARTIAL / FAIL | |
| 7 | Every minimum-viable scenario is owned by at least one slice. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
