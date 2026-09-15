# Closeout — defect-scan-mechanical

## Summary

- Ran the mechanical defect passes (1 logic, 2 error handling, 6 configuration) over the
  CodeCartographer core, both Broad-Side subgraphs, both executable surfaces' load-bearing
  code, and the build/packaging surface. 14 findings: 1 high, 5 medium, 8 low.
- Closed the routed item `cf-arch-4`: the `core/index.ts` ↔ `core/dashboard-writer.ts` import
  cycle (finding 1.1) and the `core/broadside/state.ts` → `client.ts` ordering drift (finding
  1.2). Both work under Node/TypeScript because every shared binding is dereferenced at call
  time; both are recorded as latent portability/refactor hazards with action `port differently`.
- Performed the orchestrator duties: promoted the two pending CONVENTIONS proposals to C01
  (byte-identical surface prompts) and C02 (idempotent post-commit writes); re-triaged the four
  inherited questions and left each at its current kind, with no finding asserting a candidate
  answer to any of them; swept for contradictions and found none.

## Key findings

- **6.1 (high, verify at runtime)** — `atomicWriteFile` (`core/utils.ts:43-51`) is atomic only
  if `rename` over an existing destination succeeds, with no unlink+rename fallback. On Windows
  this can fail, and every canonical write (`status.yaml`, usage log, Broad-Side `state.json`)
  routes through it.
- **1.1 (medium, port differently)** — the barrel↔dashboard-writer cycle; an eager-evaluation
  port must break it.
- **6.2–6.4 (medium, verify at runtime)** — lock-file O_EXCL/stale-break, symlink-aware
  containment, and bare-`git` invocation are written to POSIX expectations; the portability
  question `q-node-windows-fs-semantics` remains open.
- **2.2 (medium, port differently)** — `refreshScaffold` copies framework files with no staging
  or rollback; a mid-loop failure leaves a mixed-version scaffold.

## Decisions Beyond Prompt

- Closed `cf-arch-4` with `port differently`, not `fix before porting` — latent portability
  hazard, not a live bug.
- Left the Windows/network findings at `verify at runtime`, inheriting
  `q-node-windows-fs-semantics`, `q-openrouter-batch-semantics`, and `q-pi-sdk-execution-parity`.
- Promoted the architecture proposals to C01/C02 at this boundary.

## Handoff

- Routed `cfs-mech-1..3` (lock-race and lock-scope specifics) to `defect-scan-semantic`,
  refining `cf-arch-3`.
- Added post-pipeline spikes `post-mech-windows-fs` and `post-mech-import-order`.
- No runtime probes ran this session (no execution tool); probe stubs are named in the report.

## Decisions Beyond Prompt

- Closed cf-arch-4 with action port differently rather than fix before porting: the barrel cycle and the Broad-Side ordering drift are latent portability hazards that do not fail under Node/TypeScript, so they belong in the porting bundle's dependency guidance, not in a source-fix queue.
- Marked the Windows/macOS filesystem, locking, and containment findings (6.1-6.4) as external-behavior claims with verify at runtime, inheriting q-node-windows-fs-semantics; no Pass 6 finding asserts a candidate answer to that question, per the orchestrator re-triage duty.
- Promoted the two architecture proposed_conventions to CONVENTIONS.md C01 and C02 at this phase boundary rather than leaving them pending, because both are load-bearing invariants already encoded in core and pinned by the test suite.
