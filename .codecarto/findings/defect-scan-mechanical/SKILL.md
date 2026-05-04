---
name: scan-for-defects-mechanical
description: Run the early, mechanical subset of the multi-pass defect scan — local bugs that do not need contracts or protocols context to spot. Run after the architecture phase, before contracts. Covers logic and correctness, error handling and resilience, and configuration and environment hazards. The semantic subset (concurrency, security, API contract violations) runs later in the `defect-scan-semantic` phase, after protocols.
---

# Scan For Defects — Mechanical Pass

This phase runs the **early, mechanical** half of the defect-scan methodology. It catches the bugs that are visible from local code reading without needing the contracts or protocols phases to be done first. The deeper passes (concurrency, security, API contract violations) live in the later `defect-scan-semantic` phase.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`).

## Prerequisites

**Required:**
- `findings/architecture/architecture-map.md` — for the layer map and public surfaces.

You do **not** need contracts or protocols for this phase. If those exist already, skim them as bonus context, but do not block on them — the mechanical pass is by design context-light.

## Pass Execution Order

Run these three passes sequentially. Read the pass file, scan the source, record findings, then move to the next pass. Each pass file is the same one used by the legacy `defect-scan` phase — only the subset is different.

| Pass | File | Focus |
|------|------|-------|
| 1 | `findings/defect-scan/passes/01-logic-and-correctness.md` | Dead code, boundary errors, null handling, boolean logic, control flow |
| 2 | `findings/defect-scan/passes/02-error-handling.md` | Swallowed errors, missing cleanup, uncaught exceptions, retry gaps |
| 6 | `findings/defect-scan/passes/06-config-and-environment.md` | Hardcoded values, missing validation, dangerous defaults, OS assumptions |

Passes 3, 4, and 5 are deferred to `defect-scan-semantic` because they benefit from contracts/protocols context.

## Prioritization

Use the architecture map to decide emphasis:
- **Pure library with no config?** Skim pass 6.
- **Heavy generic-types or branching logic?** Spend extra time on pass 1.
- **No surfaced error model in architecture?** Pass 2 may surface that gap as a finding.

## Evidence and Severity Classification

Use the same scheme as the legacy defect-scan SKILL:

- **Evidence levels:** `observed fact`, `strong inference`, `open question`.
- **Severity:** `critical`, `high`, `medium`, `low`.
- **Action (pre-porting pipelines):** `fix before porting`, `port differently`, `leave behind`.

See `findings/defect-scan/SKILL.md` for the full criteria; this phase intentionally does not duplicate them.

## Output

Write findings to the primary output using `templates/mechanical-defects.md`. Organize by pass, then by severity within each pass. End with a summary table covering only passes 1, 2, and 6.

If the semantic phase later finds related defects, those go in its own report — do not amend this one after this phase is complete.

## What to defer to the semantic phase

- Concurrency, race conditions, and lock issues → pass 3 in `defect-scan-semantic`.
- Auth, input validation, secrets, and trust boundary defects → pass 4 in `defect-scan-semantic`.
- API/spec/state-machine drift → pass 5 in `defect-scan-semantic`.

If you spot something semantic during this phase, record it as a `carry_forward` entry in `workflow/status.yaml` with `target_phase: defect-scan-semantic` so the later phase picks it up.
