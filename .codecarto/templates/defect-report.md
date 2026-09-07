# Defect Report — [project_name]

## Scan Context

- **Source:** `../` (repository root)
- **Architecture reference:** `findings/architecture/architecture-map.md`
- **Contracts reference:** [available / not available]
- **Protocols reference:** [available / not available]
- **Pipeline:** [pipeline variant name]
- **Date:** [date]

---

## Pass 1: Logic and Correctness

<!-- For each finding: location, defect, evidence, severity, evidence level, action. -->
<!-- Sort by severity: critical → high → medium → low. -->
<!-- If no findings, write "No defects found in this category." -->
<!-- Evidence Level: observed fact / strong inference / external-behavior claim / open question.
     Action — pre-porting pipelines: fix before porting / port differently / leave behind / verify at runtime;
     maintenance pipelines: fix now / track / accept / investigate.
     Pairing rule (validated mechanically): open question or external-behavior claim ⇒ verify at
     runtime or port differently (pre-porting) / investigate (maintenance), never fix before porting
     or fix now; and list the finding in ## Open Questions below. -->

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 2: Error Handling and Resilience

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 3: Concurrency and Resource Management

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 4: Security and Trust Boundaries

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 5: API Contract Violations

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 6: Configuration and Environment Hazards

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

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

### Findings by Category

| Pass | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| 1. Logic and correctness | | | | | |
| 2. Error handling | | | | | |
| 3. Concurrency and resources | | | | | |
| 4. Security and trust | | | | | |
| 5. API contract violations | | | | | |
| 6. Config and environment | | | | | |

### Top Findings

<!-- List the most impactful findings across all passes, ranked by severity and confidence. -->
<!-- Include: pass number, location, one-line defect description, severity, recommended action. -->

1.
2.
3.
4.
5.

---

## Open Questions

<!-- Every finding whose Evidence Level is open question or external-behavior claim gets a row
     here, so the hedge travels with the finding into this document — not only into the handoff.
     Mirror each row into your phase handoff's open_questions (kind: needs-runtime-test unless a
     maintainer decision or spec ruling is what is missing). Derived findings lists the finding
     numbers (e.g. "5.2, 4.1") that depend on this question; none of them may carry a settled
     action while the question stands. -->

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

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the full pipeline.
     Adjust rows to match your active pipeline's completion_criteria if using a variant. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | At least three analysis passes produced findings or documented "no defects found." | PASS / PARTIAL / FAIL | |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS / PARTIAL / FAIL | |
| 3 | Findings are organized by pass and sorted by severity. | PASS / PARTIAL / FAIL | |
| 4 | Summary tables are complete and counts match the detailed findings. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS / PARTIAL / FAIL | |
| 7 | Unsettled findings (evidence level open question or external-behavior claim) carry an unsettled action (verify at runtime or port differently on pre-porting pipelines; investigate on maintenance pipelines), never a settled one, and each appears in the Open Questions table. | PASS / PARTIAL / FAIL | |
| 8 | Every quantitative specific in a finding (size, count, default, version, timeout) cites the file and line or command output it was read from, or is marked as an estimate. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
