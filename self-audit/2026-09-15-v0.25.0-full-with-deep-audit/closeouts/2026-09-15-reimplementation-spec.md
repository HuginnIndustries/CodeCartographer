# Closeout — reimplementation-spec

## Summary

- Primary output: `.codecarto/findings/reimplementation-spec/reimplementation-spec.md`; validation **PASS** (8/8 pipeline criteria).
- **Variant:** `language-agnostic`, `selection: auto-default` (the auto runner suppressed the Strategic Alignment Hook). The suppressed choices are registered as `q-target-stack`, `q-scope-cut`, and `q-yaml-codec-library-choice` (`needs-maintainer-decision`), so a later opinionated re-run is traceable rather than guessing.
- The spec turns the porting bundle into a build plan: 20 conceptual modules with a core/adapters/delivery layer split and a required acyclic dependency direction; 46 numbered required behaviors; a protocol/persistence section (two wire formats, SM1–SM7, three persistence classes); an external-dependency stance table; 19 portability hazards; 41 black-box acceptance scenarios; a 24-row Defect Design Consequences table covering every bundle finding; three scope tiers; 7 known unknowns; and a 14-entry Spike List.

## cf-porting-1 closure — YAML codec selection

The seven dialect constraints were fixed by the porting bundle; this phase fixed the **selection policy**. Recommended default: **reproduce a small explicit codec** (~200–400 lines) because that is the only way to guarantee all seven constraints without an adapter. Acceptable alternative: **wrap a mature YAML parser in an adapter that re-imposes** duplicate-key refusal, a uniform `__proto__` guard in mappings **and** sequence merges, scalar round-trip quoting, an explicit flow-collection policy, key-order preservation, tab/multi-document errors, and determinism. A per-ecosystem candidate table (TS, Python, Go, Rust, Ruby) is supplied as a decision aid. The concrete library pick is `q-yaml-codec-library-choice` because the target stack is unlocked. All seven are pinned by ported round-trip/coercion tests (Acceptance Scenarios 1–9; `post-reimpl-yaml-codec-conformance`).

## cf-porting-2 closure — scope cut and concurrency redesign

- **Scope tiers.** *Minimum viable port* = document codec + filesystem primitives (redesigned lock) + workspace state store + pipeline engine + prompt assembler + completion bookkeeper + coverage/findings gate + init/open + one CLI surface + the drop-in `.codecarto/` data template. *Major-workflow parity* adds the dashboard artifact, config provider, staged scaffold refresh, amendments, skill/guide resolution, usage telemetry, and a second delivery surface. *Full parity* adds the versioned library, Broad-Side provider adapter, Pi UI, and the synthesis pipeline. The four optional subsystems are each independently cuttable.
- **Concurrency redesign (required design elements).** An explicit state-file → lock map; owner-liveness (lease/heartbeat or same-host pid check) instead of a fixed-age mtime break; compare-and-delete removal by token/inode; closure of the remover-vs-fresh-acquirer window; exactly one writer-class per state file including derived-index writers and "repairing" readers (CONVENTIONS C05); deliberate re-entrancy/queuing; and staged, atomic, rollback-capable scaffold refresh with a deduped `THREAD_LOG` append (CONVENTIONS C02).

## Defect dispositions

- **fix before porting** → design consequences: 3.1, 3.2, 3.3, 3.4, 4.1, L4 (2.1), L8 (3.7), L10 (3.5), L12 (5.2).
- **port differently** → design consequences: 1.1, 2.2, L1 (1.2), L2 (1.3), L3 (1.4/1.5/1.6/2.3), L5 (6.5), L6 (3.6), L7 (4.2), L11 (5.1), L13 (5.3).
- **verify at runtime** → Spike List only, never a design consequence: 6.1, 6.2, 6.3, 6.4, L9 (4.3). All inherit `q-node-windows-fs-semantics`.
- **leave behind** → none, stated explicitly.

## Contradiction measured

The bundle's one-line 3.1 summary ("unguarded `.break` stale-break") no longer matches the current source: `releaseOwnedLock` is token-checked and removals are serialized under `<lock>.break`. The residual race the finding names is real for a different reason — the main-lock `open()` path does not consult the removal claim, so a fresh acquirer can be created between a remover's staleness re-check and its `rm` and then deleted. The redesign (behaviors 25–27) closes it; the contradiction is recorded in owner_notes and Coverage and limits rather than smoothed over. The other load-bearing defect reads were re-confirmed by source read.

## Decisions Beyond Prompt

- Language-agnostic default with the suppressed hook's choices registered as maintainer decisions.
- `cf-porting-1` closed by policy (reproduce-or-adapter) plus a decision aid, not by naming a library.
- `cf-porting-2` closed with three scope tiers and the concurrency redesign pinned as required elements.
- `verify at runtime` rows routed to the Spike List only, per the skill and C03.
- Source drift on defect 3.1 reported rather than inherited.

## Open questions (terminal)

`q-node-windows-fs-semantics`, `q-openrouter-batch-semantics`, `q-pi-sdk-execution-parity` (`needs-runtime-test`), `q-npm-tarball-template-parity` (`needs-fixture-capture`), and the three new `needs-maintainer-decision` entries (`q-target-stack`, `q-scope-cut`, `q-yaml-codec-library-choice`).

## Decisions Beyond Prompt

- Defaulted to the language-agnostic spec with selection: auto-default because /codecarto-next --auto suppresses the Strategic Alignment Hook; registered the suppressed choices (target stack, scope cut, YAML codec library) as needs-maintainer-decision open questions rather than blocking.
- Closed cf-porting-1 with a reproduce-the-codec default plus an adapter obligation and per-ecosystem candidate table, rather than naming one library, because the target stack is unlocked and the concrete pick is q-yaml-codec-library-choice.
- Closed cf-porting-2 with explicit scope tiers and pinned the concurrency redesign as required design elements (state-file-to-lock map, owner-liveness, compare-and-delete, remover-vs-acquirer closure, one writer-class per state file per C05, staged/atomic scaffold refresh), rather than leaving the optional subsystems unranked.
- Converted every verify-at-runtime defect row into a Spike List entry and never into a design consequence, per the write-reimplementation-spec skill and CONVENTIONS C03; fix-before-porting and port-differently rows got design consequences.
- Recorded the measured source drift on defect 3.1 (release already token-checked and removers already serialized; the residual race is remover-vs-fresh-acquirer) in owner_notes and Coverage and limits instead of inheriting the bundle's summarized 'unguarded .break stale-break' phrasing.
