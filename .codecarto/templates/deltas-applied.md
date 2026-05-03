# Deltas Applied — <YYYY-MM-DD>

<!--
  Output of a spec-delta-application session. See skills/spec-delta-application/SKILL.md.

  One row per delta from every source. APPLY, CLARIFY, DEFER, REJECT all recorded.
  Future revision passes read this file to know which deltas have already been processed.

  Place at: findings/reimplementation-spec/DELTAS-APPLIED.md
  (Sibling of the spec; the spec itself stays at reimplementation-spec.md.)

  If multiple delta-application passes happen over the project's life, append a new dated
  section below the existing one rather than overwriting. Same append-mode discipline as
  secondary outputs.
-->

## Sources

<!-- List every source file containing deltas processed in this session. -->

| Source | Delta count | Notes |
|---|---|---|
| spike-1-<slug>.md | | |
| spike-2-<slug>.md | | |
| <other-source>.md | | |

## Triage Summary

| Bucket | Count | Notes |
|---|---|---|
| APPLY | | |
| CLARIFY | | |
| DEFER | | |
| REJECT | | |
| **Total** | | |

## Audit Table

<!-- One row per delta. Order: by source, then by delta ID within source. -->

| # | Source | Δ ID | Bucket | Spec Section Touched | Disposition / Rationale |
|---|---|---|---|---|---|
| 1 | spike-1-<slug>.md | Δ1 | APPLY | §X.Y | Applied — spec said X, real behavior is Y. |
| 2 | spike-1-<slug>.md | Δ2 | REJECT | n/a | Premise wrong on close reading — three of eleven sites have no IPC. |
| 3 | spike-2-<slug>.md | Δ3 | CLARIFY | §A.B | Reworded "may" → "must" to match the actual normative rule. |
| 4 | spike-2-<slug>.md | Δ4 | DEFER | n/a | Real improvement but not load-bearing for next module; in BACKLOG.md. |

## Citation Markers Added

<!-- For audit: list every spec section that received a `[revised per <source> §<delta-id>]` marker
     in this pass. Future readers can grep for these. -->

- §X.Y — `[revised per spike-1-<slug>.md §Δ1]`
- §A.B — `[revised per spike-2-<slug>.md §Δ3]`

## Re-Validation Result

<!-- Summary of the re-validation check. The spec's validation block must still be PASS or
     PASS WITH GAPS after delta application. If it degrades, deltas weren't applied carefully —
     fix the spec body, NOT the validation criteria. -->

- Pre-edit spec validation: PASS / PASS WITH GAPS
- Post-edit spec validation: PASS / PASS WITH GAPS
- Criteria changed: yes / no  (must be `no` — if `yes`, document why)

## Decisions Beyond Triage

<!-- Decisions made during this session that weren't directly in the delta list — e.g., "rejected
     Δ7 because §X already covers the case." These also become numbered entries in DECISIONS.md. -->

- **D???** | <one-liner> | <rationale>
