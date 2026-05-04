---
name: scan-for-defects
description: Run a multi-pass defect scan across the source codebase, checking for logic errors, error handling gaps, concurrency bugs, security issues, API contract violations, and configuration hazards. Use after the architecture phase is complete. Optionally leverages contracts and protocols outputs for spec-grounded analysis.
---

# Scan For Defects

This phase runs **six sequential analysis passes**, each focused on one category of defect. Read and execute the passes in the order listed below. Do not try to cover all categories at once — complete each pass before starting the next.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`). This is the repository root.

## Prerequisites

**Required:** Read `findings/architecture/architecture-map.md` before starting. You need the layer map, public surfaces, and concurrency model to know where to focus.

**Optional but valuable:** If the following files exist, read them before starting passes 5 and 4 respectively. They provide the behavioral spec to compare code against:
- `findings/contracts/behavioral-contracts.md` — enables spec-grounded analysis in passes 4 and 5.
- `findings/protocols/protocols-and-state.md` — enables state machine violation detection in pass 5.

If these files do not exist, the passes still work — they fall back to comparing code against its own documentation (docstrings, type signatures, comments, README).

## Pass Execution Order

Run these passes sequentially. Read the pass file, scan the source, record findings, then move to the next pass.

| Pass | File | Focus |
|------|------|-------|
| 1 | `findings/defect-scan/passes/01-logic-and-correctness.md` | Dead code, boundary errors, null handling, boolean logic, control flow |
| 2 | `findings/defect-scan/passes/02-error-handling.md` | Swallowed errors, missing cleanup, uncaught exceptions, retry gaps |
| 3 | `findings/defect-scan/passes/03-concurrency-and-resources.md` | Race conditions, lock issues, async pitfalls, resource leaks |
| 4 | `findings/defect-scan/passes/04-security-and-trust.md` | Input validation, auth gaps, secrets in code, trust boundaries |
| 5 | `findings/defect-scan/passes/05-api-contract-violations.md` | Spec vs. implementation drift, return type mismatches, state machine violations |
| 6 | `findings/defect-scan/passes/06-config-and-environment.md` | Hardcoded values, missing validation, dangerous defaults, OS assumptions |

## Prioritization

Not every pass applies to every codebase. Use the architecture map to decide emphasis:
- **No concurrency model?** Skim pass 3, focus elsewhere.
- **No auth system?** Skip the auth sections of pass 4, still check input validation.
- **Pure library with no config?** Skim pass 6.
- **Heavy protocol/state machine system?** Spend extra time on pass 5.

## Evidence Classification

Mark every finding with one of these evidence levels:
- `observed fact`: the defect is directly visible in the code.
- `strong inference`: the defect is highly likely based on multiple code observations.
- `open question`: the code is suspicious but would need runtime testing to confirm.

## Severity Classification

Assign one severity per finding:
- `critical`: causes wrong results, data loss, or security exposure in normal operation.
- `high`: causes wrong results or failures in edge cases or under specific conditions.
- `medium`: latent risk, dead code, defense-in-depth gap, or poor error handling.
- `low`: style issue with correctness implications, stale docs, or minor inconsistency.

## Action Classification

Tag each finding with a recommended action. Use the set that matches your pipeline:

**Pre-porting pipelines** (full-with-audit, full-with-deep-audit):
- `fix before porting`: the defect would carry into a new implementation if not addressed first.
- `port differently`: the new implementation should handle this case differently by design.
- `leave behind`: the defect is specific to the source implementation and won't survive porting.

**Maintenance pipelines** (defect-scan):
- `fix now`: the defect is actively causing or risking problems.
- `track`: the defect is real but low-urgency; add to backlog.
- `accept`: the defect is known and the team has decided to live with it.
- `investigate`: needs runtime testing or deeper analysis to confirm.

Determine which action set to use by checking the `pipeline` field in `workflow/status.yaml`.

## Output

Write findings to the primary output using the template at `templates/defect-report.md`.

Organize findings by pass (one section per pass), then by severity within each section.

End with a summary table counting findings by severity and category, and a prioritized list of the top findings across all passes.

Use the output template at `templates/defect-report.md`.

## Fix Tracking

After the defect report is complete, a fix tracker template is available at `templates/defect-fix-tracker.md`. Use it to track remediation progress when fixing the defects found in this scan. The tracker uses the same defect IDs from the report (D{pass}.{number}) so fixes map directly back to findings.
