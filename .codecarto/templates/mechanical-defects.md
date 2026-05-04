# Mechanical Defects Report — [project_name]

<!--
  Output template for the `defect-scan-mechanical` phase.
  Covers passes 1, 2, and 6 from the defect-scan methodology — the bugs visible
  from local code reading without contracts or protocols context.
  See findings/defect-scan-mechanical/SKILL.md for instructions.
-->

## Scan Context

- **Source:** `../` (repository root)
- **Architecture reference:** `findings/architecture/architecture-map.md`
- **Pipeline:** [pipeline variant name]
- **Date:** [date]
- **Scope:** Mechanical passes only (1 logic, 2 error handling, 6 configuration). Semantic passes (3 concurrency, 4 security, 5 contract violations) deferred to `defect-scan-semantic` after protocols.

---

## Pass 1: Logic and Correctness

<!-- For each finding: location, defect, evidence, severity, evidence level, action. -->
<!-- Sort by severity: critical → high → medium → low. -->
<!-- If no findings, write "No defects found in this category." -->

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | | | | | |

---

## Pass 2: Error Handling and Resilience

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

### Findings by Pass

| Pass | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| 1. Logic and correctness | | | | | |
| 2. Error handling | | | | | |
| 6. Config and environment | | | | | |

### Top Findings

<!-- List the most impactful findings across the mechanical passes, ranked by severity and confidence.
     Include: pass number, location, one-line defect description, severity, recommended action. -->

1.
2.
3.
4.
5.

### Routed To Semantic Phase

<!-- Items spotted during this phase that are actually semantic in nature
     (concurrency, security, contract drift). Mirror these into status.yaml as
     carry_forward entries with target_phase: defect-scan-semantic. -->

| ID | Description | Why Routed |
|----|-------------|-----------|
| | | |

---

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the mechanical-pass scope. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | At least two of the three mechanical passes (1, 2, 6) produced findings or documented "no defects found." | PASS / PARTIAL / FAIL | |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS / PARTIAL / FAIL | |
| 3 | Findings are organized by pass and sorted by severity. | PASS / PARTIAL / FAIL | |
| 4 | Summary tables are complete and counts match the detailed findings. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
