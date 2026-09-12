# Decisions

<!--
  Project-level skeleton. codecarto_init seeds this to `.codecarto/DECISIONS.md` (one level up
  from templates/); entries accumulate as phases complete.

  This file is an append-only numbered log of cross-cutting decisions made during the project
  that diverge from spec text, prompt direction, or the obvious-default. Each entry is a
  one-liner with a back-reference to the closeout where the decision was made and the rationale
  lives.

  This file is **append-only and orchestrator-maintained**. Completion appends each phase
  handoff's `decisions` array as rows under `## Completion log` (added at first use); the
  orchestrator may re-file entries into the category sections below. Numbering is shared across
  the whole file.
-->

Append-only log of cross-cutting decisions that diverge from spec text, prompt direction, or
obvious-default. Each entry is a one-liner with a back-reference to the closeout where the
decision was made and the rationale lives.

This file is **append-only and orchestrator-maintained**. Completion appends each phase handoff's
`decisions` array as numbered rows under `## Completion log`; the orchestrator may re-file entries
into the category sections at the phase boundary.

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

Completion appends every phase handoff's `decisions` array as `D<NNN>` rows under
`## Completion log` — nothing gets stranded in closeout prose. The orchestrator may re-file an
entry into the category sections above at the phase boundary. Phase executors never edit this
file directly; they record decisions in the handoff.

If a decision is later overturned, do **not** delete the entry. Append a new `D<NNN>` superseding
it (with `Supersedes D<old-NNN>` in the one-liner) and update the old entry's one-liner to begin
`SUPERSEDED by D<new-NNN>:`. The history is the value.

## Completion log

Appended by completion from each phase handoff's `decisions` array. The orchestrator may re-file entries into the category sections above; numbering is shared with them.
D001 | tests/ (52 files, 639 tests) was inventoried by name and count only in the architecture phase; reading test bodies is deferred to the defect scans, where they are evidence for or against a finding rather than structure. | 2026-09-12-architecture | closeouts/2026-09-12-architecture.md §Decisions Beyond Prompt (architecture)
D002 | Claims about Pi SDK and MCP SDK behavior (ctx invalidation after a session swap, session continuation, structuredContent preference) are carried as external-behavior claims sourced from the code's own comments; no SDK source was read. | 2026-09-12-architecture | closeouts/2026-09-12-architecture.md §Decisions Beyond Prompt (architecture)
D003 | The scan used runtime evidence in addition to reading: npm ci + npm test in the scratch clone (twice, once on a pristine second clone), node probe scripts importing core/yaml.ts and core/status.ts, and npm pack --dry-run. None modifies source; node_modules/ now exists in the clone. Findings resting on these cite the command in their Defect cell. | 2026-09-12-defect-scan-mechanical | closeouts/2026-09-12-defect-scan-mechanical.md §Decisions Beyond Prompt (defect-scan-mechanical)
D004 | Severity for Broad-Side findings assumes the MCP posture (no human confirm hook); the same defects on Pi are one severity lower because the spend dialog intervenes. | 2026-09-12-defect-scan-mechanical | closeouts/2026-09-12-defect-scan-mechanical.md §Decisions Beyond Prompt (defect-scan-mechanical)
D005 | Contracts are written at operation granularity (one table per operation, Pi deltas inline) rather than one table per surface entry, because the two surfaces share one core path for every operation; the parity table in public-surfaces.md records the divergences. | 2026-09-12-contracts | closeouts/2026-09-12-contracts.md §Decisions Beyond Prompt (contracts)
D006 | Where documentation and tests disagree, the test is treated as the contract and the conflict is listed rather than resolved; the eleven conflicts are routed to the semantic pass for defect classification rather than fixed in prose here. | 2026-09-12-contracts | closeouts/2026-09-12-contracts.md §Decisions Beyond Prompt (contracts)
D007 | A needs-runtime-test question was closed on the external system's own source (the Pi SDK in node_modules) rather than a live probe, on the SKILL's definition that an external-behavior claim is settled by "a runtime probe or that system's own source". | 2026-09-12-contracts | closeouts/2026-09-12-contracts.md §Decisions Beyond Prompt (contracts)
D008 | Wire and persisted shapes are recorded as field tables and grammar sketches keyed to the parser lines that enforce them, not as formal JSON Schema; the parsers are the schema in this codebase and a schema document that outran them would be a second source of truth. | 2026-09-12-protocols | closeouts/2026-09-12-protocols.md §Decisions Beyond Prompt (protocols)
D009 | OpenRouter and Pi SDK shapes are recorded from this repository's own parsing code and test fakes and marked external throughout; the one runtime-checkable gap is registered as a fixture-capture question rather than a runtime-test question, because a saved exchange is what would settle it. | 2026-09-12-protocols | closeouts/2026-09-12-protocols.md §Decisions Beyond Prompt (protocols)
D010 | Routed items were closed on runtime probes wherever a probe was cheap (P1-P6), per convention C01; the probe script lives in the session scratchpad, and each probe's inputs and outputs are transcribed into the report's Runtime probes section so the evidence survives the session. | 2026-09-12-defect-scan-semantic | closeouts/2026-09-12-defect-scan-semantic.md §Decisions Beyond Prompt (defect-scan-semantic)
D011 | Pass 5 restates three mechanical findings (switch_pipeline cursor, max_cost default, wait_seconds) as documented-versus-actual violations with the spec references the mechanical rows lacked; they are cross-referenced, not double-counted in the top findings. | 2026-09-12-defect-scan-semantic | closeouts/2026-09-12-defect-scan-semantic.md §Decisions Beyond Prompt (defect-scan-semantic)
D012 | The Defect Synthesis is longer than the template's "under one screen" guidance: every high and medium root is listed individually because the run's stated deliverable is the reconciled defect list with dispositions, and the reimplementation spec must design around each; lows are grouped by root to keep the section readable. | 2026-09-12-porting | closeouts/2026-09-12-porting.md §Decisions Beyond Prompt (porting)
D013 | Surface divergences (contracts-CF2) are dispositioned as adapter policy ("can this surface ask a human?") for the deliberate ones and as defects (D-M24 and the library-init lows) for the accidental ones, rather than mandating parity. | 2026-09-12-porting | closeouts/2026-09-12-porting.md §Decisions Beyond Prompt (porting)
D014 | The reimplementation-spec variant was chosen (language-agnostic) without the interactive Strategic Alignment Hook because the run's instructions forbid pausing for the user; the choice, its reason, and the three unresolved product decisions are recorded so an opinionated rerun can supersede them. | 2026-09-12-reimplementation-spec | closeouts/2026-09-12-reimplementation-spec.md §Decisions Beyond Prompt (reimplementation-spec)
D015 | Spikes are recorded as post_pipeline entries rather than the carry_forward targets the template suggests (spike/delta/amendment), because completion refuses any target_phase outside the active pipeline; the template guidance contradicts the gate. | 2026-09-12-reimplementation-spec | closeouts/2026-09-12-reimplementation-spec.md §Decisions Beyond Prompt (reimplementation-spec)
