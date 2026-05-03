# Decisions

<!--
  Project-level skeleton. Copy this to `.codecarto/DECISIONS.md` (one level up from templates/)
  the first time the orchestrator promotes a decision. Then add entries as they accumulate.

  This file is an append-only numbered log of cross-cutting decisions made during the project
  that diverge from spec text, prompt direction, or the obvious-default. Each entry is a
  one-liner with a back-reference to the closeout where the decision was made and the rationale
  lives.

  This file is **append-only and orchestrator-maintained**. Every implementing session's
  "Decisions Beyond Prompt" section in the closeout becomes one or more entries here.
-->

Append-only log of cross-cutting decisions that diverge from spec text, prompt direction, or
obvious-default. Each entry is a one-liner with a back-reference to the closeout where the
decision was made and the rationale lives.

This file is **append-only and orchestrator-maintained**. Every implementing session's
"Decisions Beyond Prompt" section in the closeout becomes one or more entries here. The
orchestrator updates this file at session close as part of the closeout ritual.

## Format

```
D<NNN> | <ONE-LINER> | <SOURCE-CLOSEOUT> | <RATIONALE-POINTER>
```

- `D<NNN>` — sequential within category (see Categories below). Use leading zeros to width 3.
- `<ONE-LINER>` — the decision in one sentence. Should answer "what did we decide and why is it
  not obvious?"
- `<SOURCE-CLOSEOUT>` — closeout filename (e.g., `2026-05-02-architecture`).
- `<RATIONALE-POINTER>` — short pointer to where the full rationale lives. Usually the closeout's
  "Decisions Beyond Prompt" section.

## Categories

Numbering is sequential within each category, not within the file. Future sessions add at the
end of the appropriate category.

- **D000–D099** — Type system, discriminators, cross-cutting type discipline
- **D100–D199** — Toolchain, lint, project-level config
- **D200–D299** — Module-internal patterns
- **D300–D399** — Cross-module primitives lifted into a shared module
- **D400–D499** — Native code, OS-platform-specific, sandboxing
- **D500–D599** — Pending spec deltas (proposed but not yet applied)
- **D600–D699** — Reserved for future categories — extend the table here when you open a new range

Categories are project-specific. Edit this list when the project's shape demands a new range.

---

## D000–D099: Type system and discriminator

<!-- Append entries here as they accumulate. Example:

D001 | Outcome<T,E> is a brand newtype keyed by a unique Symbol, NOT a value-union; only OutcomeSink can construct one. | 2026-05-02-protocol | Spike List #11 requires unconstructable-outside-the-sink.

-->

## D100–D199: Toolchain and lint

## D200–D299: Module-internal patterns

## D300–D399: Cross-module primitives lifted

## D400–D499: Native / platform-specific

## D500–D599: Pending spec deltas

---

## How decisions get added

Every implementing session's "Decisions Beyond Prompt" section in the closeout becomes one or
more `D<NNN>` entries here. The orchestrator promotes them at session close as part of the
closeout ritual. Implementing sessions never edit this file directly.

If a decision is later overturned, do **not** delete the entry. Append a new `D<NNN>` superseding
it (with `Supersedes D<old-NNN>` in the one-liner) and update the old entry's one-liner to begin
`SUPERSEDED by D<new-NNN>:`. The history is the value.
