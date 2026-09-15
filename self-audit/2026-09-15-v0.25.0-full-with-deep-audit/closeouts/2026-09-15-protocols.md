# Closeout — protocols

## Summary

The phase extracted CodeCartographer's protocol and storage layer: a 17-protocol event catalog, seven state machines, field-by-field schemas for every persistent and wire format, and a compatibility-hazard table. It closed the three items routed to it — `cf-arch-2`, `cf-contracts-1`, and `cf-contracts-2` — and promoted the pending contracts convention to `CONVENTIONS.md` C03. The next phase (`defect-scan-semantic`) starts from a specified protocol surface with every runtime/platform/network claim still carrying `verify at runtime`.

## Files Touched

- **Added:** `.codecarto/findings/protocols/protocols-and-state.md`; `.codecarto/scratch/checkpoints/protocols.md`; `.codecarto/scratch/handoffs/protocols.yaml`.
- **Modified (append):** `.codecarto/findings/public-surfaces/public-surfaces.md`, `.codecarto/findings/runtime-lifecycle/runtime-lifecycle.md`, `.codecarto/findings/state-and-storage/state-and-storage.md`, `.codecarto/findings/config-model/config-model.md`.
- **Modified (orchestrator):** `.codecarto/CONVENTIONS.md` (promoted C03).
- **Deleted:** none.

## Tests / Gates

| Gate | Result | Notes |
|---|---|---|
| Phase validation (6 criteria) | PASS | Appended to the primary output; no test execution available this session. |
| Runtime probes | not run | No execution tool; all platform/network claims remain `verify at runtime`. |

## Decisions Beyond Prompt

- **docs/library-format.md parity accepted.** Reading the doc against `core/library.ts` shows every field, path, ordering, and guard matches; only two cosmetic placeholder drifts (staging/temp suffix naming) remain, both covered by the doc's ignore globs. No schema change; the doc stays authoritative.
- **Promoted the contracts convention to C03.** `unsettled-contracts-inherit-their-uncertainty` has been applied by three independent phases and is mechanized in `core/findings.ts`, meeting the promotion bar.
- **cf-arch-2 closed in this phase, not deferred.** Persistence-format extraction is the protocols rubric; the porting bundle should cite the schemas rather than re-derive them.
- **YAML parser decision routed to porting.** Whether to adopt a full YAML library is a per-language synthesis decision (`cf-protocols-1`).

## Proposed Conventions

### C? `markdown-contracts-are-wire-format`

**Why:** Several framework parsers read phase outputs by exact Markdown shape; a reimplementation that changes a heading, bullet label, or table header makes the parser silently see nothing.

**How to apply:** Preserve `## Validation`, `## Coverage and limits`, `## Pass N`, the five coverage bullet labels, and the findings table header (`Evidence Level` / `Action`) verbatim in any port.

## Open Questions Left Behind

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-openrouter-batch-semantics | needs-runtime-test | OpenRouter Batch API quota/`:batch`/reasoning contract | Needs a live probe |
| q-pi-sdk-execution-parity | needs-runtime-test | Pi vs MCP execution outcome parity | Needs both surfaces run |
| q-node-windows-fs-semantics | needs-runtime-test | Windows/macOS lock/rename/containment/git behavior | Platform behavior |
| q-npm-tarball-template-parity | needs-fixture-capture | npm tarball template byte-parity | Needs packing + diffing |

## Carry-Forward Routed

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| cf-protocols-1 | porting | Hand-rolled YAML subset vs a full YAML library | Per-language synthesis decision |

## Next Session Pointer

`defect-scan-semantic` reads `findings/protocols/protocols-and-state.md` (required read) alongside contracts and mechanical defects. Its Pass 3 (concurrency/resources) rubric owns the lock/stale-break/commit-point races mapped in SM2/SM3/SM4 and the carry-forwards `cf-arch-3`, `cfs-mech-1`, `cfs-mech-2`, `cfs-mech-3`; the protocol catalog names the exact lock primitives and ordering those findings must cite. Every finding landing on the OpenRouter API or non-POSIX filesystem must inherit `verify at runtime` per CONVENTIONS C03.

## Decisions Beyond Prompt

- Accepted docs/library-format.md as accurate against core/library.ts at every field, path, ordering, and guard, closing cf-contracts-1 without a schema change; the only drifts are cosmetic placeholder names (docs say `<slug>.publish.<pid>.<timestamp>` / `<file>.<pid>.<timestamp>.tmp`, code uses `<pid>.<sequence>.<random-hex>`), both still matched by the doc's `*.publish.*`/`*.tmp` ignore advice.
- Promoted the contracts proposed convention `unsettled-contracts-inherit-their-uncertainty` to CONVENTIONS.md C03 rather than leaving it pending, because it has now been applied by three independent phases and is mechanized in core/findings.ts.
- Closed cf-arch-2 by specifying every serialized shape field-by-field in the protocols primary output and the state-and-storage secondary, rather than deferring the remaining shapes to porting: persistence-format extraction is this phase's declared rubric, and the porting bundle is a compression boundary that should cite the schemas, not re-derive them.
- Routed the hand-rolled-YAML-vs-real-parser decision to porting (cf-protocols-1) instead of choosing here, because the answer depends on the target language's YAML ecosystem and scalar semantics.
