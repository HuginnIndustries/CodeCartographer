---
name: write-reimplementation-spec
description: Convert reverse-engineering findings into a language-agnostic reimplementation plan and acceptance spec. Restate a project's features and behavior so another implementation can be built in a different language or runtime without copying the source structure.
---

# Write Reimplementation Spec

Use this skill after the architecture, behavior, and protocol passes are complete enough to trust.

Start with `findings/porting/reverse-engineering-bundle.md`; it is the default compression boundary for this phase. Do not load every lower-level finding automatically. Follow the bundle's Source Index and deep-read architecture, contracts, protocols, or defect reports only when:
- the bundle names a gap or conflict,
- an acceptance scenario needs detail the bundle deliberately omitted,
- a load-bearing claim lacks enough evidence to state safely, or
- a defect disposition needs its original rationale.

Record those targeted deep reads in the spec's Coverage and limits section. If the bundle is not self-sufficient, mark the affected validation criterion PARTIAL and route the gap through `open_questions` or `carry_forward` rather than silently reconstructing the whole pipeline in context.

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
8. `Slices`
9. `Known unknowns`

Define scope tiers:
- `minimum viable port`
- `major-workflow parity`
- `full parity`

Write acceptance scenarios as black-box checks:
- Inputs must be concrete.
- Outputs and side effects must be observable.
- Avoid assertions that depend on internal file names, classes, or source-language idioms.
- Give every scenario a stable `Scenario ID` (S-01, S-02, ...) and a `Tier`. A row number is not an id: it changes when a row is inserted, and slices cite these ids.

Then write the Slices table. A slice is a promise plus the scenarios that prove it was kept, and it is what an engineering change is planned from later, so it must be lift-able into a slice record as written:
- Every slice gets a stable `Slice ID` (SL-01, SL-02, ...), a deliverable, the modules it touches, the slice ids it depends on, and a tier. Replace the template's parenthesised placeholders; a row left with a placeholder or an empty cell is refused, not skipped.
- Keep the tables plain GFM: one row per line, no prose between rows, `\|` for a literal pipe in a cell. A row the reader cannot place is reported, never dropped, so an interrupted table is a refusal rather than a shorter plan.
- `Proves scenarios` names Scenario IDs from the table above, and every id it names must exist there. **An empty proof list is not a plan.** A slice that proves nothing cannot be reviewed; no proof is worse than a weak one because it hides that the question was never asked. If you cannot name a scenario that proves a slice, the slice is not yet defined — split it or write the scenario.
- Every scenario tiered `minimum-viable` must be owned by at least one slice. An unowned minimum-viable scenario means the port could be called done without it, which contradicts the tier.
- `Verification route` is HOW an agent observes the scenarios a slice proves, in the record's own words: `test`, `run`, `manual-procedure`, or `none`. Prefer headless routes (`test`, `run`). Use `manual-procedure` only when the bundle's Agent Addressability assessment documents why nothing headless reaches the behavior — a GUI, hardware, or integration constraint is a legitimate reason when it is written down. `none`, or a route whose environment is unavailable, is a gap or blocker on that slice: record it as such, never as a pass. Do not force an architectural rewrite to manufacture a route; the addressability hazards already say what is missing. The column header must read exactly `Verification route`: the reader treats a misspelled header as an artifact without the column, and lifts it with no route and no error.
- In the language-agnostic spec, state proof obligations as what must be observed, never as a command. Executable proof commands belong only in the opinionated variant, where the target stack is known — and even there a command written in a plan is a claim, not evidence, until a host runs it and reports.

Call out deliberate non-goals:
- features intentionally deferred
- source-specific UX details not worth carrying over
- integrations that will be stubbed first

End with a spike list:
- unknown behaviors that need a prototype
- risky performance assumptions
- platform-sensitive areas that need targeted tests

For every defect in the bundle, preserve its disposition (`fix before porting`, `port differently`, `leave behind`, or `verify at runtime`) and convert it into an explicit design consequence or acceptance check — except `verify at runtime`, which becomes a Spike List entry and a `post_pipeline` entry of `kind: spike` in your handoff, never a design consequence: the diagnosis has not been confirmed, and designing around it would build the unverified claim into the new system.

Use the output template at `templates/reimplementation-spec.md`.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`). This is the repository root.
