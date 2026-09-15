# Closeout — defect-scan-semantic

## Summary

- Primary output: `.codecarto/findings/defect-scan-semantic/semantic-defects.md`; validation **PASS** (9/9).
- 13 findings: 0 critical, 0 high, 5 medium, 8 low — Pass 3 (concurrency): 7, Pass 4 (security): 3, Pass 5 (contract violations): 3.
- Closed all four routed carry-forwards: `cf-arch-3`, `cfs-mech-1`, `cfs-mech-2`, `cfs-mech-3`.
- No runtime probes ran (no execution tool); every finding is a source read.

## Findings

**Concurrency (Pass 3).** 3.1 `withRemovalLock`'s unguarded `.break` stale-break (`core/status.ts:537-540`) lets two waiters both hold the removal lock, and `breakStaleLock`'s non-atomic `stat → describeLockHolder → rm` (`:562-575`) can delete a *fresh* lock — closes `cfs-mech-1`. 3.2 `STALE_LOCK_MS = 60_000` (`:25`) breaks a lock legitimately held across a long `reindex` (`core/library.ts:619`) — closes `cfs-mech-2`. 3.3 `refreshScaffold` overwrites framework files and appends `THREAD_LOG` outside the status lock via non-atomic `copyFile` (`core/workspace.ts:430-458`) — closes `cfs-mech-3`. 3.4 standalone `library_reindex`/`library_list` write the derived index without `.publish.lock`. 3.5 the sub-agent re-entry guard is check-then-act across the async prompt/LLM-rewrite prelude. 3.6 completion's closure-integrity checks run on a pre-lock snapshot. 3.7 `writeLibraryConfig` is an unlocked, non-atomic read-modify-write.

**Security (Pass 4).** 4.1 Broad-Side `verify` uploads raw file content to OpenRouter without `redactSecrets` (`core/broadside/verify.ts:147-181,340`), bypassing the guarantee `submit` honors. 4.2 `codecartoModeActive` is reset on `session_start`, so the orchestrator's write confinement and bash block are off after a reload until init/open. 4.3 `readSpecArg` containment is check-then-use on a path (`external-behavior claim`, `verify at runtime`, inherits `q-node-windows-fs-semantics`).

**Contract violations (Pass 5).** 5.1 the child-session guard's "same containment as the parent" comment omits the configured-library root the parent allows. 5.2 refresh-scaffold's `THREAD_LOG` entry is not deduped, against its idempotence contract. 5.3 `listEntries` rewrites an existing (corrupt) index, against its "read-only but may build if absent" contract.

## Carry-forward closures

| ID | Verdict |
|----|---------|
| cf-arch-3 | Addressed by 3.1–3.7; the SM2 commit point is sound, the lock/stale-break, sub-agent re-entry, and derived-writer paths are not. |
| cfs-mech-1 | Confirmed and refined (3.1); can delete a fresh lock. |
| cfs-mech-2 | Confirmed (3.2); long-held publish lock. |
| cfs-mech-3 | Lock-scope confirmed (3.3); the claimed `writeDashboard` call is not in the source — routed as a contradiction. |

## Decisions Beyond Prompt

- Kept the lock/ordering findings at `observed fact` with settled actions rather than `verify at runtime`: they are the code's own serialization logic, not platform behavior. Only 4.3 (symlink check-then-use) inherits `q-node-windows-fs-semantics`.
- Promoted `markdown-contracts-are-wire-format` to CONVENTIONS C04 (orchestrator duty) rather than leaving it pending.
- Routed the `cfs-mech-3` `writeDashboard` contradiction to porting instead of smoothing it over.

## Decisions Beyond Prompt

- Closed cf-arch-3 and cfs-mech-1/2/3 in the semantic phase with per-finding verdicts, rather than re-routing them: each named concurrency path now has a finding or an explicit 'sound' verdict, and the closures name the exact defect site.
- Kept the lock/ordering findings (3.1-3.7, 4.1, 4.2, 5.1-5.3) as observed fact with settled actions (fix before porting / port differently) rather than verify at runtime, because they are defects in the code's own serialization and lock-scope logic, not OS/platform behavior; only 4.3, whose exploitation is a symlink-swap timing property, inherits q-node-windows-fs-semantics at verify at runtime.
- Promoted the protocols proposal markdown-contracts-are-wire-format to CONVENTIONS.md C04 at this boundary rather than leaving it pending: the defect templates and the header-driven findings parser make the exact heading/label/column shape a port-blocking invariant, and the parser's silent-see-nothing failure mode is exactly what a convention should protect.
- Routed the measured contradiction in cfs-mech-3 (refreshScaffold does not call writeDashboard in the current source) to the porting phase via owner_notes instead of silently inheriting the mechanical report's description.
