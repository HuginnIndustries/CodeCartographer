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

D001 | Wrote all five declared secondary outputs (public-surfaces, runtime-lifecycle, state-and-storage, build-and-deploy, config-model) as full catalog-level documents for this self-audit, instead of accounting for missing ones in Coverage and limits: the architecture phase is the natural home for that detail, and the primary output summarizes and points. | 2026-09-15-architecture | closeouts/2026-09-15-architecture.md §Decisions Beyond Prompt (architecture)
D002 | Closed cf-arch-4 with action port differently rather than fix before porting: the barrel cycle and the Broad-Side ordering drift are latent portability hazards that do not fail under Node/TypeScript, so they belong in the porting bundle's dependency guidance, not in a source-fix queue. | 2026-09-15-defect-scan-mechanical | closeouts/2026-09-15-defect-scan-mechanical.md §Decisions Beyond Prompt (defect-scan-mechanical)
D003 | Marked the Windows/macOS filesystem, locking, and containment findings (6.1-6.4) as external-behavior claims with verify at runtime, inheriting q-node-windows-fs-semantics; no Pass 6 finding asserts a candidate answer to that question, per the orchestrator re-triage duty. | 2026-09-15-defect-scan-mechanical | closeouts/2026-09-15-defect-scan-mechanical.md §Decisions Beyond Prompt (defect-scan-mechanical)
D004 | Promoted the two architecture proposed_conventions to CONVENTIONS.md C01 and C02 at this phase boundary rather than leaving them pending, because both are load-bearing invariants already encoded in core and pinned by the test suite. | 2026-09-15-defect-scan-mechanical | closeouts/2026-09-15-defect-scan-mechanical.md §Decisions Beyond Prompt (defect-scan-mechanical)
D005 | Closed cf-arch-1 by extracting per-argument defaults, side effects, and error behavior into both the contracts primary output (MCP: 22 tools; Pi: 20 commands + 3 flag parsers) and the public-surfaces secondary, rather than leaving the catalog unnamed for the porting phase. | 2026-09-15-contracts | closeouts/2026-09-15-contracts.md §Decisions Beyond Prompt (contracts)
D006 | Routed docs/library-format.md parity to protocols as a carry_forward (cf-contracts-1) instead of registering it as an open question: it is answerable by reading docs against code, so labeling it needs-runtime-test would have been a mislabeled question that suppresses verification. | 2026-09-15-contracts | closeouts/2026-09-15-contracts.md §Decisions Beyond Prompt (contracts)
D007 | Kept every contract that lands on atomicWriteFile durability, the status/publish/usage/state lock, symlink-aware containment, bare-git invocation, or the OpenRouter API at verify at runtime, inheriting q-node-windows-fs-semantics and q-openrouter-batch-semantics; no settled action is asserted for those surfaces. | 2026-09-15-contracts | closeouts/2026-09-15-contracts.md §Decisions Beyond Prompt (contracts)
D008 | Accepted docs/library-format.md as accurate against core/library.ts at every field, path, ordering, and guard, closing cf-contracts-1 without a schema change; the only drifts are cosmetic placeholder names (docs say `<slug>.publish.<pid>.<timestamp>` / `<file>.<pid>.<timestamp>.tmp`, code uses `<pid>.<sequence>.<random-hex>`), both still matched by the doc's `*.publish.*`/`*.tmp` ignore advice. | 2026-09-15-protocols | closeouts/2026-09-15-protocols.md §Decisions Beyond Prompt (protocols)
D009 | Promoted the contracts proposed convention `unsettled-contracts-inherit-their-uncertainty` to CONVENTIONS.md C03 rather than leaving it pending, because it has now been applied by three independent phases and is mechanized in core/findings.ts. | 2026-09-15-protocols | closeouts/2026-09-15-protocols.md §Decisions Beyond Prompt (protocols)
D010 | Closed cf-arch-2 by specifying every serialized shape field-by-field in the protocols primary output and the state-and-storage secondary, rather than deferring the remaining shapes to porting: persistence-format extraction is this phase's declared rubric, and the porting bundle is a compression boundary that should cite the schemas, not re-derive them. | 2026-09-15-protocols | closeouts/2026-09-15-protocols.md §Decisions Beyond Prompt (protocols)
D011 | Routed the hand-rolled-YAML-vs-real-parser decision to porting (cf-protocols-1) instead of choosing here, because the answer depends on the target language's YAML ecosystem and scalar semantics. | 2026-09-15-protocols | closeouts/2026-09-15-protocols.md §Decisions Beyond Prompt (protocols)
D012 | Closed cf-arch-3 and cfs-mech-1/2/3 in the semantic phase with per-finding verdicts, rather than re-routing them: each named concurrency path now has a finding or an explicit 'sound' verdict, and the closures name the exact defect site. | 2026-09-15-defect-scan-semantic | closeouts/2026-09-15-defect-scan-semantic.md §Decisions Beyond Prompt (defect-scan-semantic)
D013 | Kept the lock/ordering findings (3.1-3.7, 4.1, 4.2, 5.1-5.3) as observed fact with settled actions (fix before porting / port differently) rather than verify at runtime, because they are defects in the code's own serialization and lock-scope logic, not OS/platform behavior; only 4.3, whose exploitation is a symlink-swap timing property, inherits q-node-windows-fs-semantics at verify at runtime. | 2026-09-15-defect-scan-semantic | closeouts/2026-09-15-defect-scan-semantic.md §Decisions Beyond Prompt (defect-scan-semantic)
D014 | Promoted the protocols proposal markdown-contracts-are-wire-format to CONVENTIONS.md C04 at this boundary rather than leaving it pending: the defect templates and the header-driven findings parser make the exact heading/label/column shape a port-blocking invariant, and the parser's silent-see-nothing failure mode is exactly what a convention should protect. | 2026-09-15-defect-scan-semantic | closeouts/2026-09-15-defect-scan-semantic.md §Decisions Beyond Prompt (defect-scan-semantic)
D015 | Routed the measured contradiction in cfs-mech-3 (refreshScaffold does not call writeDashboard in the current source) to the porting phase via owner_notes instead of silently inheriting the mechanical report's description. | 2026-09-15-defect-scan-semantic | closeouts/2026-09-15-defect-scan-semantic.md §Decisions Beyond Prompt (defect-scan-semantic)
D016 | Closed cf-protocols-1 with a seven-constraint YAML codec decision framework (reproduce the dialect, or wrap a full parser in an adapter that re-imposes its contracts) rather than choosing a parser, because the port is language-agnostic and the library choice belongs to reimplementation-spec (routed as cf-porting-1). | 2026-09-15-porting | closeouts/2026-09-15-porting.md §Decisions Beyond Prompt (porting)
D017 | Kept the porting Defect Synthesis split exactly as the semantic phase left it — fix before porting for the code's own lock/ordering/redaction defects (3.1-3.4, 3.7, 4.1, plus lows 2.1, 3.5, 5.2) and verify at runtime for the external-behavior hazards (6.1-6.4, 4.3) — so no unsettled diagnosis is flattened into a settled one (CONVENTIONS C03). | 2026-09-15-porting | closeouts/2026-09-15-porting.md §Decisions Beyond Prompt (porting)
D018 | Resolved the cfs-mech-3 writeDashboard contradiction inside the porting bundle with an independent source read (core/workspace.ts:430-458 contains no writeDashboard on the refresh path), closing it rather than re-routing, and reproduced only the confirmed 3.3 behavior. | 2026-09-15-porting | closeouts/2026-09-15-porting.md §Decisions Beyond Prompt (porting)
D019 | Promoted the staged proposal lock-scope-covers-derived-state-writers to CONVENTIONS.md C05 at the porting boundary rather than leaving it pending: it generalizes across semantic findings 3.3, 3.4, 3.7, and 5.3 and is the writer-side companion to C02. | 2026-09-15-porting | closeouts/2026-09-15-porting.md §Decisions Beyond Prompt (porting)
D020 | Defaulted to the language-agnostic spec with selection: auto-default because /codecarto-next --auto suppresses the Strategic Alignment Hook; registered the suppressed choices (target stack, scope cut, YAML codec library) as needs-maintainer-decision open questions rather than blocking. | 2026-09-15-reimplementation-spec | closeouts/2026-09-15-reimplementation-spec.md §Decisions Beyond Prompt (reimplementation-spec)
D021 | Closed cf-porting-1 with a reproduce-the-codec default plus an adapter obligation and per-ecosystem candidate table, rather than naming one library, because the target stack is unlocked and the concrete pick is q-yaml-codec-library-choice. | 2026-09-15-reimplementation-spec | closeouts/2026-09-15-reimplementation-spec.md §Decisions Beyond Prompt (reimplementation-spec)
D022 | Closed cf-porting-2 with explicit scope tiers and pinned the concurrency redesign as required design elements (state-file-to-lock map, owner-liveness, compare-and-delete, remover-vs-acquirer closure, one writer-class per state file per C05, staged/atomic scaffold refresh), rather than leaving the optional subsystems unranked. | 2026-09-15-reimplementation-spec | closeouts/2026-09-15-reimplementation-spec.md §Decisions Beyond Prompt (reimplementation-spec)
D023 | Converted every verify-at-runtime defect row into a Spike List entry and never into a design consequence, per the write-reimplementation-spec skill and CONVENTIONS C03; fix-before-porting and port-differently rows got design consequences. | 2026-09-15-reimplementation-spec | closeouts/2026-09-15-reimplementation-spec.md §Decisions Beyond Prompt (reimplementation-spec)
D024 | Recorded the measured source drift on defect 3.1 (release already token-checked and removers already serialized; the residual race is remover-vs-fresh-acquirer) in owner_notes and Coverage and limits instead of inheriting the bundle's summarized 'unguarded .break stale-break' phrasing. | 2026-09-15-reimplementation-spec | closeouts/2026-09-15-reimplementation-spec.md §Decisions Beyond Prompt (reimplementation-spec)
