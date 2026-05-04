# Behavioral Contracts

<!--
  Output template for the contracts phase.
  Fill in each section. Remove placeholder text. Keep the section headers.
  Split analysis by user-facing surface.
-->

## Surfaces Covered

<!-- List which surface types this codebase exposes (CLI, TUI, web UI, API/SDK, bot, storage formats). -->

## Feature Contracts

<!--
  For each significant feature, create a contract entry.
  Group by surface type.
-->

### [Surface Type: e.g., CLI]

#### [Feature Name]

| Field | Value |
|---|---|
| **Feature** | |
| **Trigger or input** | |
| **Defaults** | |
| **Observable output** | |
| **Side effects** | |
| **Persisted state** | |
| **Error behavior** | |
| **Retry or recovery behavior** | |
| **Owner (layer/package)** | |

<!-- Repeat for each feature. -->

## High-Value Behaviors

<!--
  Specific notes on these areas (if applicable to this codebase):
  - Cancellation and abort handling
  - Streaming and partial output
  - Queueing or follow-up behavior
  - Compaction and summarization
  - Persistence and resume flows
  - Tool execution and validation
-->

## Security and Authorization

<!--
  If the system has auth or access control, document:
  - Authentication method(s) (OAuth, API keys, session tokens, SSO)
  - Authorization model (RBAC, ABAC, ACLs, capability-based)
  - Trust boundaries (what is trusted vs untrusted input)
  - Permission system (who can do what, how permissions are checked)
  - Secret management (how tokens, keys, and credentials are stored and rotated)
  - Session security (expiration, refresh, invalidation)
  - CORS, CSP, or other web security policies (if applicable)

  Skip this section if the system has no auth model (e.g., a pure library or CLI tool).
-->

## Configuration Model

<!--
  How does configuration flow through the system?
  - Config sources and precedence (env vars > config file > defaults)
  - Config file format and location
  - Feature flags and how they're toggled
  - Environment-specific overrides (dev, staging, prod)
  - Config validation and error handling for bad config

  If the config model is complex, write detailed notes to the secondary output
  at findings/config-model/config-model.md instead.
-->

## Doc/Test Conflicts

<!-- Any cases where documentation and test behavior disagree. -->

## Black-Box Acceptance List

<!--
  Scenario-style checks that another implementation can run without referencing the source.
  Use concrete preconditions and expected outcomes.
-->

| # | Scenario | Precondition | Action | Expected Outcome |
|---|----------|--------------|--------|------------------|
| 1 | | | | |

## Open Questions

<!-- Items that are still genuinely unknown — need a runtime test, maintainer decision, or spec ruling.
     NOT items deferred to a later phase in this pipeline (those go in Carry-Forward).
     Each entry: { id, kind, description, deferred_reason }. See workflow/status.yaml schema. -->

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Carry-Forward

<!-- Items deferred to a specific later phase whose rubric is the right place to close them.
     Common targets from contracts: protocols (wire-format details), porting (synthesis-level resolution).
     Each entry: { id, kind: defer-to-phase, target_phase, description, deferred_reason }.
     Mirror these into workflow/status.yaml under this phase's carry_forward list. -->

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| | | | |

---

## Validation

<!-- Fill in this table per workflow/VALIDATE.md.
     IMPORTANT: The rows below must match the completion_criteria in your ACTIVE pipeline YAML.
     The default rows below match the full, full-with-audit, and full-with-deep-audit pipelines (6 criteria).
     For pipeline-lite.yaml (5 criteria): DELETE row 3 (security) — that criterion is not in the lite pipeline. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | User-facing surfaces are split by surface type. | PASS / PARTIAL / FAIL | |
| 2 | Feature contracts record trigger, defaults, outputs, side effects, persisted state, error behavior, and recovery behavior. | PASS / PARTIAL / FAIL | |
| 3 | Security and authorization model is documented (if applicable). | PASS / PARTIAL / FAIL | |
| 4 | Contract ownership is mapped back to a layer or package. | PASS / PARTIAL / FAIL | |
| 5 | A black-box acceptance list is included. | PASS / PARTIAL / FAIL | |
| 6 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
