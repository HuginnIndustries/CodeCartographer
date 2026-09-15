# Closeout — contracts

## Summary

- Produced `.codecarto/findings/contracts/behavioral-contracts.md` (validation PASS, 7/7).
  It splits the system into six user-facing surfaces, states 19 shared workflow-control feature
  contracts (trigger, defaults, output, side effects, persisted state, error behavior, recovery,
  owner), and adds the drop-in workspace, versioned library, and dashboard as artifact contracts.
- **Closed `cf-arch-1`.** Extracted the per-argument defaults, side effects, and error behavior
  for all 22 MCP tools and the argument grammars / flag-parser defaults for all 20 Pi slash
  commands, in the primary output and in `findings/public-surfaces/public-surfaces.md`
  §2026-09-15.
- Provided a 30-scenario black-box acceptance list with concrete preconditions and expected
  outcomes; platform/network-dependent checks are marked `[verify at runtime]`.
- Wrote dated sections to all four declared secondary outputs (public-surfaces, config-model,
  runtime-lifecycle, state-and-storage), never overwriting earlier content.

## Decisions Beyond Prompt

- Closed `cf-arch-1` in the primary output rather than only the secondary, because downstream
  phases cite the primary by anchor.
- Routed `docs/library-format.md` parity to `protocols` as `cf-contracts-1` (a read task) and the
  dashboard's content catalog as `cf-contracts-2`, rather than registering either as an open
  question.
- Inherited `verify at runtime` for every contract on atomic writes, locks, path containment,
  `git`, or the OpenRouter API; no settled action for an unresolved open question.

## Orchestrator Duties

- **Re-triage:** `q-openrouter-batch-semantics`, `q-pi-sdk-execution-parity`,
  `q-node-windows-fs-semantics` remain `needs-runtime-test`; `q-npm-tarball-template-parity`
  remains `needs-fixture-capture`. No finding asserts a candidate answer to any of them.
- **Secondary outputs:** all four written (append).
- **Contradiction sweep:** the "~21 Pi commands" summary in architecture/public-surfaces
  contradicts a test-pinned 20 and README's 20; README's Broad-Side action list omits `verify`.
  Both recorded as measured facts in Doc/Test Conflicts.

## Coverage and limits

- Inspected: both executable surfaces in full; the shared core modules that carry the contracts
  (`pipeline`, `prompts`, `completion`, `status`, `workspace`, `library`, `orchestrator-config`,
  `usage`, `amendment`, `guide`, `secrets`, `findings`, `coverage`, `utils`); the Broad-Side
  surface's user-visible text and state; representative test bodies; README/CLAUDE tables.
- Skipped: `core/dashboard.ts` body beyond ~120 lines; `core/broadside/{schemas,lenses,repo,
  requests,client,results}.ts` line-by-line; `docs/*`; `scripts/*`; most extension bodies.
- Blind spots: no runtime verification; Windows/macOS FS/lock/containment, OpenRouter semantics,
  Pi-vs-MCP parity, npm tarball parity, and the unread docs remain unsettled and are routed.

## Decisions Beyond Prompt

- Closed cf-arch-1 by extracting per-argument defaults, side effects, and error behavior into both the contracts primary output (MCP: 22 tools; Pi: 20 commands + 3 flag parsers) and the public-surfaces secondary, rather than leaving the catalog unnamed for the porting phase.
- Routed docs/library-format.md parity to protocols as a carry_forward (cf-contracts-1) instead of registering it as an open question: it is answerable by reading docs against code, so labeling it needs-runtime-test would have been a mislabeled question that suppresses verification.
- Kept every contract that lands on atomicWriteFile durability, the status/publish/usage/state lock, symlink-aware containment, bare-git invocation, or the OpenRouter API at verify at runtime, inheriting q-node-windows-fs-semantics and q-openrouter-batch-semantics; no settled action is asserted for those surfaces.
