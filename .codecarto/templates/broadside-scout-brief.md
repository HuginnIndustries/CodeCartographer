# Broad-Side Scout Brief — [project_name]

<!--
  Output template for the `broadside-scout` phase.
  Distills a Broad-Side batch reconnaissance run into leads routed to later
  phases. See findings/broadside-scout/SKILL.md for instructions.

  Every entry here is an UNVERIFIED lead from a cheap batch model, not a
  finding. No later phase may cite this file as a source.
-->

## Scout Context

- **Run:** `broadside/[run-id]/` (or: no completed run — see Scout Coverage)
- **Model:** [batch model id]
- **Lenses that ran:** [list]
- **Recorded cost:** [from run-meta.json]
- **Pipeline:** [pipeline variant name]
- **Date:** [date]

> These are unverified scouting leads. Each one is a place to look, not a
> fact. The receiving phase confirms it against the source and cites the
> source — never this brief.

---

## Leads by Phase

<!--
  One row per lead. Target must be a phase in the active pipeline.
  Source pointer is the file:line (or module) the receiving phase starts from.
  Confidence is the scout's, not yours: high / medium / low.
  Drop anything the target phase would find in its own first pass.
-->

| # | Target phase | Lead | Source pointer | Lens | Scout confidence |
|---|--------------|------|----------------|------|------------------|
| 1 | | | | | |

---

## Convention Candidates

<!--
  From the conventions lens. These route to the orchestrator's CONVENTIONS.md
  promotion review, not to a phase. Candidates only — promotion still requires
  the orchestrator's review against the code.
-->

| # | Candidate convention | Where the scout saw it |
|---|----------------------|------------------------|
| 1 | | |

---

## Leads Dropped

<!--
  What you chose not to forward, and why. This is the record that keeps the
  brief short without hiding the discard.
-->

| # | Lead | Why dropped |
|---|------|-------------|
| 1 | | |

---

## Coverage and limits

<!--
  What the scout scanned, what it did not, and what came back unusable. A
  later phase must be able to tell "the scout found nothing there" from "the
  scout never looked there." Sourced from broadside/<run>/run-meta.json.
-->

- Inspected scope: [modules scanned, or "whole repository in one slice"]
- Skipped scope: [modules the lens globs, slicing cap, or incremental diff excluded; lenses skipped, with reason]
- Evidence basis: batch-model scouting signals only — no source inspection, no tests, no runtime verification
- Known blind spots: [truncated slices and the modules they covered; everything under Skipped scope is unscouted, not clean]
- Coverage disposition: COMPLETE | PARTIAL | NONE (no completed Broad-Side run)

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the broadside-scout scope. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Every forwarded lead names a target phase in this pipeline and a source pointer the target phase can start from. | PASS / PARTIAL / FAIL | |
| 2 | Every lead is marked as an unverified scouting signal; none is stated as a fact or cited as evidence. | PASS / PARTIAL / FAIL | |
| 3 | Leads dropped rather than forwarded are recorded with a reason. | PASS / PARTIAL / FAIL | |
| 4 | Convention candidates are routed to the orchestrator's CONVENTIONS.md review, not to a phase. | PASS / PARTIAL / FAIL | |
| 5 | When no completed Broad-Side run exists, the brief says so explicitly and forwards no leads. | PASS / PARTIAL / FAIL | |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
