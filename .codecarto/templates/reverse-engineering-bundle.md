# Reverse-Engineering Bundle

<!--
  Output template for the porting phase.
  This is a synthesis of architecture, contracts, and protocols.
  Fill in each section. Remove placeholder text. Keep the section headers.
-->

## System Summary

<!-- One to three paragraphs summarizing the system in plain language, aimed at someone who will reimplement it. -->

## Layer Map With Ownership

<!--
  Synthesized from the architecture phase.
  Each layer/module with its role and what it owns.
-->

| Layer / Module | Role | Owns |
|---|---|---|
| | | |

## Feature Contract Table

<!--
  Synthesized from the contracts phase.
  Summary table of all features with their priority for porting.
-->

| Feature | Surface | Priority (core/important/optional/incidental) | Key Contracts | Notes |
|---|---|---|---|---|
| | | | | |

## Protocol and State Notes

<!--
  Synthesized from the protocols phase.
  Summary of protocols, state machines, and persistence that a reimplementation must preserve.
-->

## Portability Hazards

<!--
  Consolidated from all prior phases.
  Separate from facts — these are risks, not certainties.
-->

| Hazard | Source Phase | Impact | Mitigation |
|---|---|---|---|
| | | | |

## Observed Facts vs. Inferred Structure

<!--
  Explicitly separate what is documented/tested from what was inferred.
-->

### Observed Facts

<!-- Direct statements from docs, tests, schemas, types, and code. -->

### Inferred Structure

<!-- Architectural conclusions drawn from multiple facts. -->

## Domain Glossary

<!--
  Shared vocabulary of domain-specific terms used across the codebase.
  Include terms that a reimplementer needs to understand, especially:
  - Terms with project-specific meaning that differs from common usage
  - Abbreviations or acronyms used in code and docs
  - Entity names and their relationships
  - Business rules expressed as domain concepts
-->

| Term | Definition | Where Used |
|---|---|---|
| | | |

## Open Questions

<!-- Items that are still genuinely unknown — need a runtime test, maintainer decision, or spec ruling.
     NOT items deferred to a later phase in this pipeline (those go in Carry-Forward).
     Each entry: { id, kind, description, deferred_reason }. See workflow/status.yaml schema. -->

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Carry-Forward

<!-- Items deferred to a specific later phase whose rubric is the right place to close them.
     Common target from porting: reimplementation-spec (rule-pinning, opinionated decisions).
     Each entry: { id, kind: defer-to-phase, target_phase, description, deferred_reason }.
     Mirror these into workflow/status.yaml under this phase's carry_forward list. -->

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| | | | |

---

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the full pipeline.
     Adjust rows to match your active pipeline's completion_criteria if using a variant. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | The system summary, layer map, contract table, protocol notes, and porting findings are synthesized. | PASS / PARTIAL / FAIL | |
| 2 | Portability hazards and open questions are separated from facts. | PASS / PARTIAL / FAIL | |
| 3 | Feature importance is sorted for porting. | PASS / PARTIAL / FAIL | |
| 4 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
