---
name: apply-spec-deltas
description: Apply triaged spec deltas (from spike findings, defect-scan corrections, post-implementation discoveries, or any source proposing changes to a finished reimplementation spec) without rubber-stamping. Use this skill after the pipeline has produced a complete reimplementation-spec and a separate source has surfaced changes the spec should absorb. The skill enforces triage discipline (apply blockers, defer nice-to-haves, reject what doesn't fit), preserves traceability via [revised per <source> §<delta-id>] citations, and produces a DELTAS-APPLIED.md audit table.
---

# Apply Spec Deltas

Use this skill when:

- The pipeline has produced a complete `findings/reimplementation-spec/reimplementation-spec.md` (the spec is `complete` in status.yaml).
- A separate source has surfaced changes the spec should absorb. Common sources:
  - **Spike reports** (`spikes/<spike-id>/<scenario>.md` plus a `CONSOLIDATED-DELTA.md`).
  - **Defect-scan re-runs** that find corrections to spec text.
  - **Implementation discoveries** that contradict spec assumptions (e.g., a wire format the spec misread).
  - **Maintainer rulings** that close prior open questions.

This is a **post-pipeline** activity. `current_phase` stays `complete`. The spec is updated in place; no phase status changes.

## Core posture: triage, do not rubber-stamp

The single rule of this skill: **don't apply deltas verbatim without thinking.** Every delta gets categorized, and only some get applied. Rubber-stamping a delta list produces an incorrect spec — the discipline is the value.

Triage every delta into one of four buckets:

| Bucket | Definition | Action |
|---|---|---|
| **APPLY** | Delta is a real correction or required addition; the spec is wrong without it. | Edit the spec body. Add a `[revised per <source> §<delta-id>]` marker at the changed section. Record in DELTAS-APPLIED.md. |
| **CLARIFY** | Delta proposes wording change; the spec's *meaning* is correct but the language is ambiguous. | Edit the spec wording (not the rule). Record in DELTAS-APPLIED.md as a clarification. |
| **DEFER** | Delta is a real improvement but not load-bearing for the next implementation step. | Add to BACKLOG.md with rationale and a back-reference. Do NOT edit the spec. |
| **REJECT** | Delta is wrong on close reading (premise was incorrect, scope was misread, the rule it proposes already exists, etc.). | Document in DELTAS-APPLIED.md with a one-line rationale. Do NOT edit the spec. |

The previous wisdom: any delta you can't decisively bucket should default to DEFER. The cost of a missed correction is one re-application pass; the cost of a bad correction is shipped.

## Citation convention

Every applied or clarified delta leaves a citation marker in the spec body so a future reader can trace the change back to its source.

```
<original spec text>  [revised per spike-3-cancellation.md §Δ7]
<revised spec text>   [revised per spike-3-cancellation.md §Δ7]
```

The marker form is **canonical**, not per-session: `[revised per <source-filename> §<delta-id>]`. The citation convention list at the front-matter of the spec (or the project's `CONVENTIONS.md`) should include `[revised per ...]` as a recognized form.

## Step-by-step

### 1. Pre-flight

- Confirm `findings/reimplementation-spec/reimplementation-spec.md` is complete (PASS or PASS WITH GAPS validation block).
- Read every delta source named in the session prompt (the spike reports, the defect-scan addendum, the maintainer-decision file).
- Read the spec once end-to-end if you haven't recently. The spec's structure determines where deltas land.
- Read the project's `CONVENTIONS.md` if present — some deltas may be moved into convention entries instead of the spec body.

### 2. Triage every delta

For each delta from each source:

- **Read the delta carefully.** Is the premise correct? Does the affected spec section actually say what the delta claims it says?
- **Categorize: APPLY / CLARIFY / DEFER / REJECT.** Put each delta in exactly one bucket.
- If APPLY or CLARIFY: identify the exact spec section to edit. Note line numbers (or section anchors) for the audit table.
- If DEFER: write a one-line BACKLOG.md entry now, don't wait.
- If REJECT: write a one-paragraph rationale now, don't wait.

### 3. Apply changes (in spec-source order, not delta-order)

- Group APPLY/CLARIFY deltas by the spec section they touch.
- Edit each section once (not once per delta), even if multiple deltas converge on the same section.
- Add the `[revised per <source> §<delta-id>]` citation marker at the changed paragraph.
- After edits in a section, re-read the section in full to confirm it still hangs together — neighboring claims may need adjustment.

### 4. Re-run validation on the spec

Re-run validation per `workflow/VALIDATE.md` against the spec's `completion_criteria`. The spec was PASS or PASS WITH GAPS before; it must remain PASS or PASS WITH GAPS after. If the validation block degrades, the deltas weren't applied carefully — fix the spec body, do NOT soften the validation criteria. (This rule is load-bearing — see the discipline notes in the source feedback.)

### 5. Write DELTAS-APPLIED.md

Use `templates/deltas-applied.md`. The audit table records every delta from every source — APPLY, CLARIFY, DEFER, REJECT — with one row per delta. Future revision passes read this file to know which deltas have already been processed.

### 6. Update the spec's front-matter citation conventions list

If the spec has a "Citation Conventions" section (or similar), confirm `[revised per ...]` is listed as a recognized citation form. If not, add it.

### 7. Closeout

Per the standard closeout ritual:

- Append a one-line entry to `THREAD_LOG.md` pointing at the closeout file.
- Write `closeouts/<YYYY-MM-DD>-spec-deltas.md` using `templates/closeout-template.md`.
- Update `status.yaml` only if a delta closed an `open_questions` or `carry_forward` entry — do NOT change `current_phase` (stays `complete`).
- Append numbered entries to `DECISIONS.md` for any decisions made during triage that weren't already in the deltas (e.g., "rejected Δ7 because the spec already covered the case at §X").

## What to avoid

- **Don't rubber-stamp.** A delta list is a *proposal*. The spec-delta session decides.
- **Don't soften the spec's validation criteria** to make the post-edit spec pass. If the validation degrades, the spec body is wrong, not the criteria.
- **Don't edit deltas in the source files.** The spike report (or defect addendum, or wherever the delta came from) is read-only. DELTAS-APPLIED.md is the audit; the spike report is the evidence.
- **Don't change status.yaml's current_phase.** This is post-pipeline work; the pipeline is `complete`.
- **Don't apply deltas across spec sections without reading the neighbors.** A claim in §3.2 may depend on a claim in §3.1; editing one without the other produces silent contradictions.

## Output template

Use `templates/deltas-applied.md` for the audit table.
