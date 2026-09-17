# Review: reconciled defect list

Source: [findings/porting/reverse-engineering-bundle.md §Defect Synthesis](findings/porting/reverse-engineering-bundle.md),
which reconciles the mechanical scan's 14 findings and the semantic scan's 13 into 1 high,
10 medium, and 16 low (the lows grouped by root cause). Line numbers refer to commit
`a159d6c` (v0.25.0 + #353).

Every `observed fact` row was **confirmed by reading** the cited lines before it became an
issue — 22 of the 27 findings. The five `external-behavior claim` rows are Windows or
symlink-timing questions the source cannot settle; they are filed as one CI request rather
than as defects, except the one whose fix is a one-liner regardless of the answer. Nothing
was reproduced at runtime: the phases could not run probes, and this review did not add any.
The `verify` pass (Broad-Side) was not part of this run.

Dispositions use the porting vocabulary the reports use: **fix** (fix before porting),
**port differently**, **verify at runtime**.

## Medium and high

Ordered by the order I would act on them.

| ID | Location | Defect | Disposition | Issue |
|---|---|---|---|---|
| 4.1 | `core/broadside/verify.ts:137-181,330-340` | `verify` uploads raw file lines to OpenRouter; `isSlurpable` excludes credential *files* only, `redactSecrets` is never called, and the config's `redact_secrets` is not read. `submit` redacts every slice. | fix | #358 |
| 3.1 | `core/status.ts:526-552,562-575` | The removal lock's own stale-break is a bare `rm`; two waiters can both take `.break`, and `breakStaleLock`'s `stat → describeLockHolder → rm` can then delete a fresh holder's lock. The race #344 left one level down. | fix (redesign) | #355 |
| 3.2 | `core/status.ts:25,496-500`; `core/library.ts:619,947-1001` | `STALE_LOCK_MS = 60_000` breaks a live long holder — the publish lock across a full `reindex` — and the mtime is never refreshed; reopens the #240 version race. | fix (redesign) | #355 |
| 3.3 | `core/workspace.ts:430-458` | `refreshScaffold` overwrites pipelines, GUIDE, VALIDATE outside the status lock via non-atomic `copyFile`; a concurrent completion re-reads the pipeline inside the lock. | fix | #356 |
| 2.2 | `core/workspace.ts:430-441` | The same refresh has no staging or rollback: a mid-loop I/O failure leaves a mixed-version scaffold. | port differently | #356 |
| 3.4 | `core/library.ts:912-1001`; `mcp-server/server.ts:977-988` | `reindex` and `listEntries` write `index.yaml`/`INDEX.md` without `.publish.lock`; a stale reindex can land after a publish and drop the new version from the index. | fix | #357 |
| 1.1 | `core/index.ts:24` ↔ `core/dashboard-writer.ts:14-27` | Barrel re-exports a module that imports eleven bindings back from the barrel; resolves only because every binding is read at call time. | port differently | #371 |
| 6.1 | `core/utils.ts:43-51` | `atomicWriteFile` has no fallback if rename-over-existing fails (Windows). **Claim.** | verify at runtime | #372 |
| 6.2 | `core/status.ts:477,496-497` | `O_EXCL` + mtime staleness assumed to hold on Windows. **Claim.** (The logic half is 3.1/3.2.) | verify at runtime | #372 |
| 6.3 | `core/utils.ts:64-92` | Containment case-folds only on `win32`; junctions, short names, drive-relative paths unverified. **Claim.** | verify at runtime | #372 |
| 6.4 | `core/broadside/repo.ts:117-160`; `core/library.ts:1342` | Bare `git` on PATH and POSIX-shaped output parsing. **Claim.** | verify at runtime | #372 |

## Low

| ID | Location | Defect | Disposition | Issue |
|---|---|---|---|---|
| L10 (3.5) | `extensions/codecarto/index.ts:797`; `auto-runner.ts:92-117,377` | Re-entry guard checked before `runSinglePhase`'s async prelude (prompt build, LLM-steer rewrite); a second run in that window spawns a duplicate sub-agent. | fix | #359 |
| L6 (3.6) | `core/completion.ts:395-505` | Closure-integrity gates (target phase, D1, D3) run on a pre-lock snapshot; the handoff is applied under the lock without re-running them. Same class as #337. | fix | #360 |
| L8 (3.7) | `core/orchestrator-config.ts:250-287` | `writeLibraryConfig`: unlocked read-modify-write of the user-global config with a plain `writeFile`. | fix | #361 |
| L9 (4.3) | `mcp-server/server.ts:673-707` | `readSpecArg` checks the canonical path and reads the original string. **Claim** on the swap window; the fix does not depend on it. | fix | #362 |
| L7 (4.2) | `extensions/codecarto/index.ts:388,444,461,504,617` | `codecartoModeActive` resets on `session_start`; the orchestrator's guard is off after a resume until init/open. | port differently | #363 |
| L11 (5.1) | `extensions/codecarto/phase-compaction.ts:78-88` | Child-session guard omits the configured-library root its comment and the contracts claim. | port differently | #364 |
| L2 (1.3) | `core/yaml.ts:483,487` vs `:340-346` | Sequence items plain-assign keys, bypassing the `__proto__` `defineProperty` guard the mapping path uses. | fix | #365 |
| L3 (1.6) | `core/broadside/collect.ts:196`; `render.ts:19` | Post-pass JSON parsed with raw `JSON.parse`; a fenced reply is an empty "completed" pass. | fix | #366 |
| L3 (1.5) | `core/broadside/submit.ts:254` | Millisecond-timestamp run ids collide; the second run replaces the first's record and shares its directory. | fix | #367 |
| L3 (1.4) | `core/broadside/repo.ts:568,606` | Slice mode chosen on bytes, slices capped on UTF-16 code units. | fix | #368 |
| L4 (2.1) | `extensions/codecarto/index.ts:1701-1704` | `/codecarto-dashboard` ignores `writeDashboard`'s boolean and reports success. | fix | #369 |
| L3 (2.3) | `core/broadside/collect.ts:433-435` | A retry submit failure is swallowed; the retry entry has no `error` field. | fix | #370 |
| L12 (5.2) | `core/workspace.ts:445-455` | Scaffold refresh appends a THREAD_LOG line every time, no dedupe. | fix | #356 |
| L13 (5.3) | `core/library.ts:919-930` | `listEntries` rewrites a corrupt index — a read command that writes. | port differently | #357 |
| L1 (1.2) | `core/broadside/state.ts:15` | `state.ts` imports a constant from the downstream `client.ts`, against the documented layer order. | port differently | #371 |
| L5 (6.5) | `core/utils.ts:221`; `core/broadside/constants.ts`, `client.ts:34,51` | Operational timeouts and poll constants are hardcoded. | port differently | — (design note; no issue) |

## Issue index

| Issue | Findings | One line |
|---|---|---|
| #355 | 3.1, 3.2 (6.2's logic half) | Stale-lock breaking is racy by construction and breaks live long holders — owned tickets with pid liveness and a heartbeat |
| #356 | 3.3, 2.2, 5.2 | `refreshScaffold` under the status lock, atomic staged copies, THREAD_LOG dedupe |
| #357 | 3.4, 5.3 | Every index writer takes the publish lock; `list` stays read-only |
| #358 | 4.1 | `verify` redacts tool output and honours `redact_secrets` |
| #359 | 3.5 | Reserve the phase slot before the async prelude |
| #360 | 3.6 | Completion gates judged on the locked read |
| #361 | 3.7 | Lock + atomic write for the user-global config |
| #362 | 4.3 | Read the canonical path that was checked |
| #363 | 4.2 | Re-arm the orchestrator guard from persisted state on resume |
| #364 | 5.1 | One guard policy for both session scopes |
| #365 | 1.3 | One `__proto__` guard on both YAML paths |
| #366 | 1.6 | Fence-tolerant post-pass parsing |
| #367 | 1.5 | Unique run ids |
| #368 | 1.4 | One unit for slice-mode choice and slice cap |
| #369 | 2.1 | Report a failed dashboard write |
| #370 | 2.3 | Record the retry submit error |
| #371 | 1.1, 1.2 | Acyclic, downward-only module graph, pinned |
| #372 | 6.1, 6.2, 6.3, 6.4 | Run the suite on `windows-latest` |

## Compared with the 2026-09-11 audit

That run (v0.19.5, Claude Fable 5.1 through MCP) produced 78 findings reconciled into 46
roots; 57 issues followed, all closed by v0.22.0. This run (v0.25.0, `deepseek-v4.1-flash`
through Pi) produced 27 findings and 18 issues, none of them a regression of a #223–#279
item. The medium findings are concentrated where the last three releases added code —
the removal lock (#344), `verify` (#331), the library index — and in the two paths
(`refreshScaffold`, the user-global config) that nothing had audited for locking since the
lock discipline was introduced. The one thing the previous audit's own findings did not
carry forward is its D-M23 ("repository content uploaded without secret scanning"): the
redaction pass it asked for shipped for `submit`, and this run found that `verify` bypasses
it.

## Outcome (2026-09-16)

All eighteen issues are resolved. Sixteen were fixed in **v0.26.0** (PRs #375–#392), each
re-verified against the code first; fourteen landed with a test that fails on the previous
code. Two of the eighteen changed shape under that verification: #364 (5.1) was a correct,
deliberately narrower guard with a wrong comment — fixed as documentation — and **#363
(4.2) was closed as designed**, because `tests/pi-extension-activation.test.mjs` pins the
guard staying off until `/codecarto-open`. #372 became the `test-windows` CI job, whose
first run settled the four `verify at runtime` rows: 6.1 (`atomicWriteFile` `EPERM` under
concurrent writers) is real and filed as #393; 6.3 (the write guard refusing a phase's own
`.codecarto/findings/…` write) is real and filed as #394; 6.2 and 6.4 produced no failure —
the lock suite and the git-listing tests pass on Windows, which is the evidence the job can
give, not a proof; eight tests carry POSIX path expectations, filed as #395. The closeout is
[`docs/history/2026-09-15-self-audit-closeout.md`](../../docs/history/2026-09-15-self-audit-closeout.md).
