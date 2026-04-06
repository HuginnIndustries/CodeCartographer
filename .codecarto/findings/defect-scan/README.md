# Defect Scan

Multi-pass analysis of the source codebase for logic errors, error handling gaps, concurrency issues, security vulnerabilities, API contract violations, and configuration hazards.

**Primary output:** `defect-report.md`

**Depends on:** architecture phase (required). Optionally leverages contracts and protocols phases for spec-grounded analysis.

**Analysis passes** (executed sequentially):

1. Logic and correctness
2. Error handling and resilience
3. Concurrency and resource management
4. Security and trust boundaries
5. API contract violations
6. Configuration and environment hazards

See `SKILL.md` for full instructions. Pass-specific guidance is in `passes/`.
