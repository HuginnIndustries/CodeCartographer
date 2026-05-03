# Protocols and State

<!--
  Output template for the protocols phase.
  Fill in each section. Remove placeholder text. Keep the section headers.
  Treat every boundary as a protocol boundary.
-->

## Boundaries Identified

<!--
  List the protocol boundaries found:
  - process to process
  - UI to core
  - core to provider
  - tool layer to runtime
  - runtime to persistence
  - local files to exported artifacts
-->

## Event Catalog

<!--
  For each protocol or event stream:
-->

### [Protocol / Event Stream Name]

| Field | Value |
|---|---|
| **Producer** | |
| **Consumer** | |
| **Transport or carrier** | |
| **Ordering guarantees** | |
| **Required fields** | |
| **Optional fields** | |
| **Identifiers and timestamps** | |
| **Error cases** | |
| **Restart or resume behavior** | |

<!-- Repeat for each protocol. -->

## State Machine

<!--
  For each significant state machine:
  - Name the states
  - Name the transitions
  - Record guards and side effects
  - Separate synchronous barriers from observational events

  ASCII diagrams or tables are both acceptable.
-->

### [State Machine Name]

| Current State | Event / Trigger | Guard | Next State | Side Effects |
|---|---|---|---|---|
| | | | | |

## Persistent Schema Notes

<!--
  For each persistence mechanism:
  - Append-only vs mutable
  - Branching vs linear history
  - Compaction or summarization rules
  - Replay or resume behavior
  - Locking, deduplication, or conflict handling
-->

## Compatibility Hazards

<!--
  Portability hazards that frequently break ports:
  - ANSI terminal semantics
  - IME or cursor positioning rules
  - Filesystem locking assumptions
  - Async ordering guarantees
  - OAuth token refresh behavior
  - Shell quoting and OS differences
  - Encoding, width, or Unicode handling
-->

| Hazard | Where It Appears | Severity | Notes |
|---|---|---|---|
| | | | |

## Open Questions

<!-- Items that are still genuinely unknown — need a runtime test, maintainer decision, or spec ruling.
     NOT items deferred to a later phase in this pipeline (those go in Carry-Forward).
     Each entry: { id, kind, description, deferred_reason }. See workflow/status.yaml schema. -->

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Carry-Forward

<!-- Items deferred to a specific later phase whose rubric is the right place to close them.
     Common target from protocols: porting (synthesis-level resolution).
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
| 1 | An event catalog is documented. | PASS / PARTIAL / FAIL | |
| 2 | A state machine is documented. | PASS / PARTIAL / FAIL | |
| 3 | Persistent schema notes are documented. | PASS / PARTIAL / FAIL | |
| 4 | Compatibility hazards are documented. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
