# Defect Scan — Mechanical Pass

Early, context-light defect pass. Runs after architecture and before contracts in the `pipeline-full-with-deep-audit` workflow. Covers logic and correctness, error handling, and configuration hazards — the bugs visible from local code reading.

**Primary output:** `mechanical-defects.md`

**Depends on:** architecture phase (required).

**Pass subset (mechanical):**

1. Logic and correctness
2. Error handling and resilience
6. Configuration and environment hazards

The deeper passes (concurrency, security, API contract violations) live in the `defect-scan-semantic` phase, which runs after protocols.

See `SKILL.md` for instructions. Pass-specific guidance is reused from `findings/defect-scan/passes/`.
