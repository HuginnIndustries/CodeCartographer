# Defect Scan — Semantic Pass

Deep, context-rich defect pass. Runs after protocols and before porting in the `pipeline-full-with-deep-audit` workflow. Covers concurrency, security, and API contract violations — bugs that need contracts and protocols already documented to spot reliably.

**Primary output:** `semantic-defects.md`

**Depends on:** architecture, contracts, protocols, and `defect-scan-mechanical` phases (all required).

**Pass subset (semantic):**

3. Concurrency and resource management
4. Security and trust boundaries
5. API contract violations

The early passes (logic, error handling, config) live in the `defect-scan-mechanical` phase, which runs right after architecture.

See `SKILL.md` for instructions. Pass-specific guidance is reused from `findings/defect-scan/passes/`.
