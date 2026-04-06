---
name: write-reimplementation-spec
description: Convert reverse-engineering findings into a language-agnostic reimplementation plan and acceptance spec. Restate a project's features and behavior so another implementation can be built in a different language or runtime without copying the source structure.
---

# Write Reimplementation Spec

Use this skill after the architecture, behavior, and protocol passes are complete enough to trust.

Treat the source repo as evidence, not as a template.

Define concept-level modules:
- State each module's responsibility in one sentence.
- List public inputs and outputs.
- List owned state and invariants.
- List collaborators and dependencies.

Split the system into three layers of concern:
- `core semantics`: behavior that must survive the port unchanged
- `adapters`: integrations with terminal, browser, Slack, filesystem, cloud APIs, or SDKs
- `delivery surfaces`: CLI, TUI, web, bot, daemon, or deployment wrappers

Refactor the findings into target-language-friendly shapes:
- Do not mirror file names or package names unless they still make sense.
- Preserve contracts and state semantics before preserving organization.
- Collapse source-language helper layers that exist only for tooling or typing convenience.

For each external dependency, choose one stance:
- `replace`
- `wrap`
- `emulate`
- `postpone`

Write the plan in this order:
1. `System summary`
2. `Conceptual module model`
3. `Required behaviors`
4. `Protocols and persisted state`
5. `Portability hazards`
6. `Implementation sequence`
7. `Acceptance scenarios`
8. `Known unknowns`

Define scope tiers:
- `minimum viable port`
- `major-workflow parity`
- `full parity`

Write acceptance scenarios as black-box checks:
- Inputs must be concrete.
- Outputs and side effects must be observable.
- Avoid assertions that depend on internal file names, classes, or source-language idioms.

Call out deliberate non-goals:
- features intentionally deferred
- source-specific UX details not worth carrying over
- integrations that will be stubbed first

End with a spike list:
- unknown behaviors that need a prototype
- risky performance assumptions
- platform-sensitive areas that need targeted tests

Use the output template at `templates/reimplementation-spec.md`.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`). This is the repository root.
