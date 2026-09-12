# Semantic Defects Report — [project_name]

<!--
  Output template for the `defect-scan-semantic` phase.
  Covers passes 3, 4, and 5 from the defect-scan methodology — the bugs that
  need contracts and protocols context to spot reliably.
  See findings/defect-scan-semantic/SKILL.md for instructions.
-->

## Scan Context

- **Source:** `../` (repository root)
- **Architecture reference:** `findings/architecture/architecture-map.md`
- **Contracts reference:** `findings/contracts/behavioral-contracts.md`
- **Protocols reference:** `findings/protocols/protocols-and-state.md`
- **Mechanical defects reference:** `findings/defect-scan-mechanical/mechanical-defects.md`
- **Pipeline:** [pipeline variant name]
- **Date:** [date]
- **Scope:** Semantic passes only (3 concurrency, 4 security, 5 contract violations). Mechanical passes (1 logic, 2 error handling, 6 configuration) were covered earlier in `defect-scan-mechanical`.

---

## Pass 3: Concurrency and Resource Management

<!-- For each finding: location, defect, evidence, severity, evidence level, action. -->
<!-- Cite the protocol or state-machine entry that the finding violates, when relevant. -->
<!-- If no findings, write "No defects found in this category." -->
<!-- Evidence Level: observed fact / strong inference / external-behavior claim / open question.
     Action: fix before porting / port differently / leave behind / verify at runtime.
     Pairing rule (validated mechanically): open question or external-behavior claim ⇒
     verify at runtime or port differently, never fix before porting; and list the finding
     in ## Open Questions below. A finding that closes a routed carry-forward derived from a
     still-open needs-runtime-test question inherits that uncertainty. -->

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 4: Security and Trust Boundaries

<!-- Cite the contract entry (e.g., feature ID) that the finding violates, when relevant. -->

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 5: API Contract Violations

<!-- Each finding should pair the source contract/protocol reference with the diverging code location. -->
<!-- When the analyzed code is the CALLER of a contract another system implements, what that system
     does with the payload is an external-behavior claim (action: verify at runtime) until a runtime
     probe against the pinned version says otherwise — see passes/05 "Which side implements the contract". -->

| # | Location | Defect | Severity | Evidence Level | Action | Spec Reference |
|---|----------|--------|----------|----------------|--------|----------------|
| 1 | | | | | | |

---

## Summary

### Findings by Severity

| Severity | Count |
|----------|-------|
| Critical | |
| High | |
| Medium | |
| Low | |
| **Total** | |

### Findings by Pass

| Pass | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| 3. Concurrency and resources | | | | | |
| 4. Security and trust | | | | | |
| 5. API contract violations | | | | | |

### Top Findings

<!-- List the most impactful findings across the semantic passes, ranked by severity and confidence.
     Include: pass number, location, one-line defect description, severity, recommended action. -->

1.
2.
3.
4.
5.

### Carry-Forward Closure

<!-- carry_forward entries routed to defect-scan-semantic (delivered in this phase's prompt)
     that were closed here. Address each in the findings above, then list its id under
     carry_forward_closures in your phase handoff so completion removes the entry. -->

| ID | Source Phase | Closed Because |
|----|--------------|---------------|
| | | |

---

## Runtime probes

<!-- Optional, but the strongest evidence this report can carry. One row per probe you ran to
     confirm or refute a finding before assigning its severity: a short script that drives the
     code path and shows the wrong result, the lost write, the escaped path. Keep the scripts
     under scratch/probes/ so the porting phase can rerun them, and put the finding's row number
     in the Finding column so the two can be read together. A probe that did NOT reproduce the
     read prediction is worth a row too — it is what lowers a severity honestly. -->

| Probe | Finding | What it did | What it showed | Script |
|---|---|---|---|---|
| | | | | |

---

## Open Questions

<!-- Every finding whose Evidence Level is open question or external-behavior claim gets a row
     here, so the hedge travels with the finding into this document — not only into the handoff.
     Include any still-open needs-runtime-test question a closed carry-forward derived from.
     Mirror each row into your phase handoff's open_questions. Derived findings lists the finding
     numbers (e.g. "5.2") that depend on this question; none of them may carry a settled action
     while the question stands. -->

| ID | Kind | Question | Why source cannot settle it | Derived findings |
|----|------|----------|-----------------------------|------------------|
| | | | | |

---

## Coverage and limits

- Inspected scope:
- Skipped scope:
- Evidence basis: source inspection | tests | runtime verification | upstream findings
- Known blind spots:
- Coverage disposition: COMPLETE | PARTIAL

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the semantic-pass scope. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | All three semantic passes (3, 4, 5) produced findings or documented "no defects found." | PASS / PARTIAL / FAIL | |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS / PARTIAL / FAIL | |
| 3 | Pass 5 findings cite the contract or protocol reference they violate. | PASS / PARTIAL / FAIL | |
| 4 | Findings are organized by pass and sorted by severity; summary tables match the detailed findings. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS / PARTIAL / FAIL | |
| 7 | Unsettled findings (evidence level open question or external-behavior claim) carry an unsettled action (verify at runtime or port differently on pre-porting pipelines; investigate on maintenance pipelines), never a settled one, and each appears in the Open Questions table. | PASS / PARTIAL / FAIL | |
| 8 | Every quantitative specific in a finding (size, count, default, version, timeout) cites the file and line or command output it was read from, or is marked as an estimate. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
