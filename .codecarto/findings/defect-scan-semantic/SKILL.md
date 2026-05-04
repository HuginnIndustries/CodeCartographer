---
name: scan-for-defects-semantic
description: Run the deep, semantic subset of the multi-pass defect scan — bugs that need contracts and protocols context to spot. Run after protocols, before porting. Covers concurrency and resource management, security and trust boundaries, and API contract violations (including state machine drift). The mechanical subset (logic, error handling, config) runs earlier in the `defect-scan-mechanical` phase, after architecture.
---

# Scan For Defects — Semantic Pass

This phase runs the **deep, semantic** half of the defect-scan methodology. The findings here only become legible once you know what the code is *supposed* to do — that is what the contracts and protocols phases give you. The early mechanical bugs (passes 1, 2, 6) were caught in the earlier `defect-scan-mechanical` phase.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`).

## Prerequisites

**Required:**
- `findings/architecture/architecture-map.md`
- `findings/contracts/behavioral-contracts.md` — pass 5 needs this to define "violation."
- `findings/protocols/protocols-and-state.md` — passes 3 and 5 need this for state machine and event-ordering analysis.
- `findings/defect-scan-mechanical/mechanical-defects.md` — read so you do not re-flag what the mechanical phase already covered.

If any prerequisite is missing, stop and surface the gap. The semantic pass is the *paid-for* benefit of running the mechanical phase early; do not regress it by running the semantic pass blind.

## Pass Execution Order

Run these three passes sequentially. Read the pass file, scan the source, record findings, then move to the next pass. Each pass file is reused from the legacy `defect-scan` phase.

| Pass | File | Focus |
|------|------|-------|
| 3 | `findings/defect-scan/passes/03-concurrency-and-resources.md` | Race conditions, lock issues, async pitfalls, resource leaks |
| 4 | `findings/defect-scan/passes/04-security-and-trust.md` | Input validation, auth gaps, secrets in code, trust boundaries |
| 5 | `findings/defect-scan/passes/05-api-contract-violations.md` | Spec vs. implementation drift, return type mismatches, state machine violations |

## Prioritization

Use the contracts and protocols outputs to decide emphasis:
- **No concurrency model in protocols?** Skim pass 3, focus elsewhere.
- **No auth system in contracts?** Skip the auth sections of pass 4, still check input validation.
- **Heavy state machine in protocols?** Spend extra time on pass 5.
- **Many features in contracts marked "core" or "important"?** Pass 5 spec-vs-impl drift on those is high-value.

## Evidence, Severity, and Action Classification

Use the scheme from `findings/defect-scan/SKILL.md`. The severity and action sets are the same as the legacy defect-scan phase.

When citing a contract or protocol violation, include the contract ID or state-machine reference from the upstream finding so the porting phase can trace the chain.

## Honor the carry_forward routing

Read the `carry_forward` entries in `workflow/status.yaml` whose `target_phase` is `defect-scan-semantic`. The mechanical phase may have routed semantic-flavored sightings here for closure.

## Output

Write findings to the primary output using `templates/semantic-defects.md`. Organize by pass, then by severity within each pass. End with a summary table covering only passes 3, 4, and 5.

The porting phase's reverse-engineering bundle has a "Defect Synthesis" section that consolidates this report and the mechanical report — do not pre-fill that here.
