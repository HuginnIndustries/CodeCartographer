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

<!-- carry_forward entries in status.yaml that targeted defect-scan-semantic and were closed here. -->

| ID | Source Phase | Closed Because |
|----|--------------|---------------|
| | | |

---

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the semantic-pass scope. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | All three semantic passes (3, 4, 5) produced findings or documented "no defects found." | PASS / PARTIAL / FAIL | |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS / PARTIAL / FAIL | |
| 3 | Pass 5 findings cite the contract or protocol reference they violate. | PASS / PARTIAL / FAIL | |
| 4 | Findings are organized by pass and sorted by severity; summary tables match the detailed findings. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
