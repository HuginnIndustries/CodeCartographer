---
name: extract-behavioral-contracts
description: Recover user-visible behavior, commands, configuration semantics, defaults, error expectations, and feature contracts from docs, tests, examples, and code. Use when you need a language-agnostic behavior spec for later reimplementation, parity planning, or regression testing.
---

# Extract Behavioral Contracts

Recover what the system does from the outside in.

Prioritize sources in this order:
1. READMEs, docs, and built-in help text
2. examples, demos, screenshots, sample sessions
3. tests and fixtures
4. schemas, default settings, and changelogs
5. source code for gaps and contradictions

Split the analysis by user-facing surface:
- CLI
- TUI
- web UI
- API or SDK
- bot or background worker
- storage or export formats

For each feature, capture a contract with these fields:
- `feature`
- `trigger or input`
- `defaults`
- `observable output`
- `side effects`
- `persisted state`
- `error behavior`
- `retry or recovery behavior`

Treat tests as executable contracts:
- Prefer them for edge cases, ordering, and failure handling.
- Compare them against docs to detect drift.
- Call out any doc/test conflict instead of silently picking one.

Separate essential behavior from source-specific ergonomics:
- Preserve user-visible semantics.
- Do not overfit to exact class names, file names, or UI implementation tricks.
- Keep keyboard shortcuts, command aliases, or display details only if they matter to parity.

Pay special attention to these high-value behaviors:
- cancellation and abort handling
- streaming and partial output
- queueing or follow-up behavior
- compaction and summarization
- persistence and resume flows
- tool execution and validation

Document the security and authorization model (if the system has one):
- Authentication method(s): OAuth, API keys, session tokens, SSO, etc.
- Authorization model: RBAC, ABAC, ACLs, capability-based, etc.
- Trust boundaries: what input is trusted vs untrusted.
- Permission checks: how and where permissions are enforced.
- Secret management: how tokens, keys, and credentials are stored and rotated.
- Session lifecycle: expiration, refresh, invalidation.
- Skip this area entirely if the system has no auth model (e.g., a pure library).

Document the configuration model:
- Config sources and their precedence (env vars > config file > defaults, etc.).
- Config file format, location, and discovery mechanism.
- Feature flags and how they are toggled.
- Environment-specific overrides (dev, staging, prod).
- Config validation and error handling for malformed config.
- If the config model is complex, use the secondary output at `findings/config-model/config-model.md`.

Map every contract back to its owner:
- package or module
- shared core vs surface wrapper
- platform-specific adapter, if any

End with a black-box acceptance list:
- Write scenario-style checks that another implementation can run without referencing the source.
- Favor exact preconditions and expected outcomes over vague quality statements.

Mark every finding with one of these evidence levels:
- `observed fact`: direct statement from docs, tests, schemas, types, or code.
- `strong inference`: behavioral conclusion drawn from multiple facts.
- `portability hazard`: assumption tied to the source language, runtime, terminal, OS, or third-party SDKs.
- `open question`: missing or conflicting behavior that still needs evidence.

If behavior is hard to infer from docs alone, read the companion protocol skill next. Many user-visible quirks are really protocol or state-machine rules.

Use the output template at `templates/behavioral-contracts.md`.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`). This is the repository root.
