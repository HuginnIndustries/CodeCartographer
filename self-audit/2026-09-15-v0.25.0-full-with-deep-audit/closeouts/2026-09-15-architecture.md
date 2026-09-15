# Closeout — architecture

## Summary

Mapped the CodeCartographer framework (self-audit) into layers, dependency direction,
public surfaces, runtime lifecycle, concurrency model, build/packaging, and porting
priorities. The primary output is `.codecarto/findings/architecture/architecture-map.md`;
catalog-level detail lives in the five declared secondary outputs.

## Key findings

- **One core, three surfaces.** The drop-in `.codecarto/` template, the Pi extension, and
  the MCP server all share `core/`; byte-identical phase prompts/validation across Pi and
  MCP is the load-bearing invariant, pinned by the invariant test suite.
- **Stable base, thin wrappers.** `core/{types,utils,yaml}.ts` sit at the bottom; nothing in
  the repo depends on a wrapper. Both wrappers are adapters over shared internals.
- **One module cycle.** `core/index.ts` re-exports `core/dashboard-writer.ts`, which imports
  names from `core/index.ts`. It resolves only because bindings are used at call time — a
  portability hazard for eager-evaluation ports. Routed to `defect-scan-mechanical` as
  `cf-arch-4`.
- **Concurrency is file-lock + atomic-rename + sequential sub-agents.** Single-threaded Node,
  O_EXCL lock files with stale-break under a removal lock, temp+rename writes, sequential
  phases, and concurrent Broad-Side batch polling with per-run spend-slot claims.
- **Broad-Side is an optional, network-coupled subsystem.** 14 modules with a declared
  acyclic graph (one ordering drift noted); it is deliberately advisory, not evidence.

## Decisions beyond prompt

- All five declared secondary outputs were written as full catalog-level documents rather
  than being accounted for as absent, because this phase is their natural home.

## Open questions and carry-forward

- Open: `q-openrouter-batch-semantics`, `q-pi-sdk-execution-parity`,
  `q-node-windows-fs-semantics` (all runtime tests), `q-npm-tarball-template-parity`
  (fixture capture).
- Routed: `cf-arch-1` → contracts, `cf-arch-2` → protocols, `cf-arch-3` →
  defect-scan-semantic, `cf-arch-4` → defect-scan-mechanical.
- Post-pipeline: `post-arch-context-budget` (optional spike).

## Coverage and limits

COMPLETE. Inspected scope, skipped scope, evidence basis, and blind spots are recorded in
the primary output's `## Coverage and limits`. Broad-Side collect/verify, the dashboard
body, test bodies, and `docs/` contents were read by structure rather than line-by-line;
each is named there or routed above.

## Decisions Beyond Prompt

- Wrote all five declared secondary outputs (public-surfaces, runtime-lifecycle, state-and-storage, build-and-deploy, config-model) as full catalog-level documents for this self-audit, instead of accounting for missing ones in Coverage and limits: the architecture phase is the natural home for that detail, and the primary output summarizes and points.
