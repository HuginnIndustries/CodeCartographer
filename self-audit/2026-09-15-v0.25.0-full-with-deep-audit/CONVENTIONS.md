# Conventions

<!--
  Project-level skeleton. Copy this to `.codecarto/CONVENTIONS.md` (one level up from templates/)
  the first time the orchestrator promotes a convention. Then add entries as they accumulate.

  This file holds cross-cutting patterns that have been promoted to project-wide invariants.
  Every new session reads this file and either honors these conventions or documents why it
  diverges.

  This file is **orchestrator-maintained**. Phase executors propose additions in their session
  closeout; the orchestrator promotes them at the phase boundary. In an inline run the same chat
  does both — the rule is about *when* (between phases, deliberately), not about which thread.
-->

Cross-cutting patterns promoted to project-wide invariants. Every session reads this file at start
and either honors these conventions or documents why it diverges.

This file is **orchestrator-maintained**. Phase executors propose additions in their closeout's
"Proposed Conventions" section; the orchestrator promotes them here at the phase boundary — in an
inline run, the same chat changing hats between phases.

## How conventions get added

A new entry lands here when ONE of the following holds:

1. **Three independent sessions** reach for the same pattern (the "lift if it generalizes" rule
   applied to conventions themselves), OR
2. **One session** explicitly promotes a pattern in its closeout report and the orchestrator
   confirms it generalizes, OR
3. **The spec or framework feedback corpus** identifies a project-wide invariant that future
   implementing sessions need to know about.

The orchestrator owns this file. Implementing sessions propose; orchestrator promotes.

## Entry shape

Each convention is a numbered section (`## C<NN>. <Title>`) with three required parts:

- **Body** — the rule itself, in prose. May include a code block for shape contracts.
- **Why:** — the reason the rule exists. Often a past incident or a defect class the rule
  prevents. Future maintainers judging edge cases need to know *why* to judge whether the rule
  applies.
- **How to apply:** — when and where the rule kicks in. Should answer "is this case in scope?"

Optional:
- **Current implementers:** — files/modules that already follow the rule. Useful as worked examples.
- **Source:** — the closeout entry where the orchestrator promoted this convention.

---

## C01. Byte-identical surface prompts

The Pi extension and the MCP server must assemble identical phase prompts and return identical validation results for the same workspace state and phase. Every primitive used by both executable wrappers lives in `core/` and is re-exported through `core/index.ts`; a wrapper adds only surface framing, never its own prompt text or validation logic.

**Why:** The framework's fidelity contract is that a run under Pi and a run under any MCP host are the same run. Divergent prompt text would make the two surfaces analyze differently with no way to tell from the artifact. The invariant is pinned by the parity tests under `tests/` (`pipeline-invariants.test.mjs` and siblings).

**How to apply:** When adding or changing a phase prompt, validation rule, or shared default, put the logic in `core/` (most often `core/prompts.ts` or `core/pipeline.ts`) and reach it through `core/index.ts`. Never fork the text per surface. Surface-specific labels (for example the `Completed via <tool>` owner note) are the only permitted divergence.

**Current implementers:** `core/prompts.ts` `buildPhasePrompt`; `extensions/codecarto/index.ts` and `mcp-server/server.ts` both call it; `core/pipeline.ts` `validatePhaseOutput`.

**Source:** staged from the architecture handoff (`2026-09-15-architecture`) and promoted by the defect-scan-mechanical orchestrator pass (2026-09-15).

---

## C02. Idempotent post-commit writes

Any artifact that asserts a phase (or amendment) is complete — the closeout, the `THREAD_LOG.md` line, the `DECISIONS.md` rows, the staged `CONVENTIONS.md` proposals, the dashboard refresh — is written only after the `status.yaml` atomic rename commits, and every writer deduplicates so re-running the operation regenerates rather than duplicates its output.

**Why:** A failed commit must leave no artifact claiming success, and a crash between the status write and the artifacts must be repairable by re-running completion. The commit point is the `status.yaml` rename in `updateStatusAtomically`; everything downstream runs in its `afterCommit` hook.

**How to apply:** New completion/amendment side effects belong in the `afterCommit` callback (`core/workspace.ts` `StatusUpdate.afterCommit`) and must be idempotent — canonical file names, link-deduped index lines, text-deduped rows. Never write a "phase complete" artifact before the status rename.

**Current implementers:** `core/completion.ts` `writeCompletionArtifacts` / `appendDecisionLog` / `stageProposedConventions`; `core/amendment.ts` `applyAmendment`; `core/workspace.ts` `updateStatusAtomically`.

**Source:** staged from the architecture handoff (`2026-09-15-architecture`) and promoted by the defect-scan-mechanical orchestrator pass (2026-09-15).

---

## C03. Unsettled contracts inherit their uncertainty

A contract, finding, protocol note, or hazard that lands on a platform, OS, third-party API, or SDK behavior the source cannot settle must be marked `external-behavior claim` or `portability hazard` with the unsettled action `verify at runtime`, and must not assert one of an open question's candidate answers as settled (`fix before porting` / `fix now`).

**Why:** A source read can establish what the framework *sends* or *writes*, not what a remote provider does with it or how a foreign filesystem implements `rename`/`O_EXCL`. Shipping a candidate answer as settled suppresses the verification that would catch a wrong port and makes the hedge invisible to a downstream reader. The pairing gate in `core/findings.ts` refuses an unsettled evidence level paired with a settled action (on a scaffold ≥0.17.1), and `core/completion.ts` refuses a `needs-runtime-test` question closed without runtime evidence (on a scaffold ≥0.19.0).

**How to apply:** Whenever a claim touches the OpenRouter API, a filesystem lock/atomic rename/path containment, a bare-`git` invocation, or an SDK's negotiated behavior, tag it `external-behavior claim`/`portability hazard` and give it `verify at runtime`; list it under `## Open Questions` so the hedge travels with the finding. An upstream `not inspected`/`not decoded` does not license an `observed fact` about that scope — close the gap with cited new evidence or inherit the uncertainty.

**Current implementers:** applied by architecture, defect-scan-mechanical (findings 6.1–6.4), contracts (every `atomicWriteFile`/lock/containment/git/OpenRouter contract), and protocols (`verify at runtime` on P9–P13/P17 and every schema durability note); enforced by `core/findings.ts` `crossCheckFindings` and `core/completion.ts` D1/D3.

**Source:** staged from the contracts handoff (`2026-09-15-contracts`) and promoted by the protocols orchestrator pass (2026-09-15).

---

## C04. Markdown contracts are wire format

Every framework parser that reads a phase output keys on an exact Markdown shape — the `## Validation` / `## Coverage and limits` / `## Pass N` headings, the fixed coverage bullet labels, and table headers like `| # | Location | … | Evidence Level | Action |` — so any reimplementation must preserve those headings, labels, and column names verbatim.

**Why:** The parsers are shape-driven and silent on mismatch: `validatePhaseOutput` finds the **last** `## Validation` heading and reads the last `**Overall:**` line; `parseCoverageAndLimits` matches the five fixed bullet labels; `parseFindingsTables` only reads tables whose header normalizes to include both an `Evidence Level` and an `Action` column; `hasVisibleHeadingLine` requires `## Completion log` / `## Pending proposals` as their own exact lines. A renamed heading or column does not throw — it makes the parser see nothing, so a phase output that looks complete validates as `MISSING` or silently drops its findings from the cross-checks. This is the same class of failure C01 prevents for prompts: the artifact's *shape* is part of the interface.

**How to apply:** When porting the phase-output grammar, copy these shapes verbatim (`core/pipeline.ts`, `core/coverage.ts`, `core/findings.ts`, `core/completion.ts`, `core/dashboard-writer.ts`) and pin them with tests that feed a known-good output through each parser. When editing a template, change the template and every parser together; never rename a heading or label for prose reasons alone.

**Current implementers:** `core/pipeline.ts` `validatePhaseOutput`/`parseOverallLine`; `core/coverage.ts` `LEDGER_LABELS` + fixed bullet labels; `core/findings.ts` `parseFindingsTables`/`parseOpenQuestionsTable`; `core/completion.ts` `hasVisibleHeadingLine`/`countPendingProposals`; `core/dashboard-writer.ts` (reads the first lines under `## Summary`).

**Source:** staged from the protocols handoff (`2026-09-15-protocols`) and promoted by the defect-scan-semantic orchestrator pass (2026-09-15).

---

## C05. Every writer of a state file takes that state's lock

Any writer of a state file must take that state's lock, including writers of **derived** artifacts built from it and writers that are "only reading" until they repair a fault. Concretely: a library index rebuilt from the library takes the publish lock; a scaffold refresh that overwrites the active pipeline takes the status lock (or a dedicated scaffold lock) and appends `THREAD_LOG` under it; user-global config merged in place takes a config lock and writes atomically. A lock that excludes a writer of the same state serializes nothing.

**Why:** Three independent defects are the same failure — a lock that serializes one class of writer while another class writes the same bytes unguarded. `refreshScaffold` overwrites `workflow/pipeline*.yaml` and appends `THREAD_LOG` with no status lock while completion re-reads the pipeline and writes `status.yaml` inside one (semantic 3.3); `library_reindex`/`library_list` write the derived `index.yaml` without `.publish.lock` while `publishEntry` serializes publishers under it (semantic 3.4); `writeLibraryConfig` read-modify-writes the shared user-global config with no lock and a non-atomic `writeFile` (semantic 3.7). Derived data being regenerable does not make a lost update harmless when the artifact is the user-facing lookup.

**How to apply:** Before adding any writer of a persisted file — including a reader that "may build" a derived index, a refresh that copies framework files, or a config merge — name the lock that serializes writers of that file and take it. Derived-artifact writers are not exempt. When the write is a read-modify-write, pair the lock with the atomic-write primitive. This is the writer-side companion to C02's idempotent post-commit writers.

**Current implementers:** `core/library.ts` `publishEntry` (`.publish.lock` around `reindex`) is the positive example; the defects this convention closes are semantic findings 3.3, 3.4, 3.7, and the `listEntries` rewrite (5.3). The port's design must apply it to every path, not just the publish path.

**Source:** staged from the defect-scan-semantic handoff (`2026-09-15-defect-scan-semantic`) and promoted by the porting orchestrator pass (2026-09-15).

---

## Pending proposals

Staged by completion from each phase handoff's `proposed_conventions`. The orchestrator promotes an entry into a numbered convention above (or removes it with a note) at the phase boundary — see GUIDE.md §Roles.

_None pending._ The architecture proposals (`byte-identical-surface-prompts`, `idempotent-post-commit-writes`) were promoted to C01 and C02 at the defect-scan-mechanical boundary (2026-09-15); the contracts proposal (`unsettled-contracts-inherit-their-uncertainty`) was promoted to C03 at the protocols boundary (2026-09-15) — it had been applied by architecture, defect-scan-mechanical, and contracts and is mechanized in `core/findings.ts`. The protocols proposal (`markdown-contracts-are-wire-format`) was promoted to C04 at the defect-scan-semantic boundary (2026-09-15) — the defect templates and their header-driven parser make it a port-blocking invariant, not just a protocols observation. The defect-scan-semantic proposal (`lock-scope-covers-derived-state-writers`) was promoted to C05 at the porting boundary (2026-09-15) — it generalizes across findings 3.3, 3.4, 3.7, and 5.3 and is the writer-side companion to C02.
