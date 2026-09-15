# Runtime Lifecycle

> Secondary output (mode: append). Owns the sequence-level catalog of how each surface
> boots, runs, and stops, including the concurrency primitives' lifecycle. The architecture
> map owns the summary and load-bearing claims. Add a dated section per phase.

## 2026-09-14 — architecture phase

### Boot sequences

#### MCP server (`mcp-server/server.ts`, `bin.mjs`)
1. `bin.mjs` (from `dist/`) imports `./server.js` and calls `startStdioServer()`.
2. `startStdioServer()` → `buildServer()` constructs a `@modelcontextprotocol/sdk` `Server`
   named `codecartographer` at `PACKAGE_VERSION`, registering `ListToolsRequestSchema` and
   `CallToolRequestSchema` handlers.
3. A `StdioServerTransport` connects; a module-level `AbortController` (`serverLifetime`) is
   created and `server.onclose` aborts it.
4. `process.stdin` `end`/`close` also abort `serverLifetime`, so a long Broad-Side poll stops
   when the client exits (the SDK's stdio transport never sees end-of-stream).
5. Each tool call validates its arguments, resolves `cwd` (absolute + existing), and runs a
   `handle*` function. Unknown handlers → `MethodNotFound`; thrown `McpError`s pass through;
   other errors → `InternalError`.

#### Pi extension (`extensions/codecarto/index.ts`)
1. Pi loads the default-exported `codeCartographerExtension(pi)`.
2. `phaseCompactionExtension(pi)` registers the phase-aware compaction prompt + checkpoint writer.
3. Lifecycle hooks register: `session_start` (reset mode, clear widget), `session_shutdown`
   (dispose the agents widget), `agent_end` (refresh widget), `tool_call` (guard).
4. ~21 `pi.registerCommand(...)` calls register the slash commands with argument completers.
5. CodeCartographer "mode" is inactive until `/codecarto-init` or `/codecarto-open`; the
   `tool_call` guard only applies while active and only when `.codecarto/` exists.

### Steady-state operation

#### Phase execution (Pi)
- `/codecarto-next` resolves the outcome (`resolvePipelineOutcome`), runs `runPhasePreflight`,
  rejects re-entry if the phase is running, then `void runSinglePhase(...)` (fire-and-forget
  so the TUI stays responsive). After it resolves, the handler re-reads state, validates,
  and auto-completes.
- `runSinglePhase`: optionally rewrites the seed prompt (LLM steering), `startPhase`
  (in-memory activity), attaches the widget, then `runPhase(...)`.
- `runPhase`: builds a `DefaultResourceLoader` isolating the child from global
  extensions/skills/themes, creates a file-backed `SessionManager` session (parent-linked,
  named `CodeCartographer phase: <id>`), spawns an `AgentSession` with tools
  `read/edit/write/grep/find/ls` and the child model runtime, subscribes to events
  (tool/turn/message/compaction) and forwards them to callbacks. It prompts once; if the
  primary output is missing or the last message was a tool result/`toolUse`, it waits for
  compaction and prompts a continuation. Finally it unsubscribes, aborts, and disposes the
  child session.
- `runSinglePhase` then emits the phase-summary message, records usage
  (`appendUsageRun`, `recorded_by: pi-runner`), refreshes the dashboard, and schedules a
  30 s lingering `clearPhase` tied to that run's activity entry.

#### Auto loop (Pi `--auto`)
- `runAuto` loops: check abort signal → `resolvePipelineOutcome` (stops on `stuck`/`complete`)
  → preflight → re-entry guard → `runSinglePhase(auto:true)` → accumulate tokens → validate
  (only if completed) → `decideAfterPhase` (pure decision matrix) → on `continue`,
  `autoCompletePhase` and notify `onPhaseAdvanced`.
- `strict` treats `PASS WITH GAPS` as a stop. `finish()` returns outcome/reason/phasesRun/tokens.

#### Phase completion (all surfaces)
`completeValidatedPhase`:
1. Load workspace + handoff (`scratch/handoffs/<phase>.yaml`); refuse if a phase with
   `handoff_requirements` has no handoff.
2. Pre-lock checks: carry-forward targets must be downstream active phases; post-pipeline
   entries need ids; closure-integrity rules (`derives_from` question still open; a
   `needs-runtime-test` closure needs evidence on a ≥0.19.0 scaffold); warn when a claimed
   closure id is never mentioned in the primary output.
3. Under the status lock (`updateStatusAtomically`): re-validate the output, build the next
   status record, `applyHandoff`, turn any untracked PARTIAL rows into
   `needs-maintainer-decision` questions, set `last_updated`, `recomputeCursor`.
4. `atomicWriteFile` renames `status.yaml` into place — **the commit point**.
5. `afterCommit` (idempotent): write the canonical closeout (handoff `closeout_content` or a
   template stub), append one deduped `THREAD_LOG` entry, append decision rows to
   `DECISIONS.md`, stage proposals in `CONVENTIONS.md`.
6. Caller-side: Pi also records usage; MCP appends a zeroed `mcp-complete` receipt; both
   refresh the dashboard.

#### Amendment (post-pipeline)
`applyAmendment` loads `scratch/amendments/<slug>.yaml`, refuses if the pipeline is not
complete (judged on the state read *under* the lock), removes matching open-question ids and
post-pipeline ids, rebuilds terminal `next_actions`, commits `status.yaml`, then writes an
amendment closeout + `THREAD_LOG` entry.

#### Broad-Side run
1. `submit`: load config + state (refuse if state.json is corrupt), collect repo info
   (working-tree file list via git, or a bounded walk), detect language, refuse unknown
   language/zero source files, resolve a catalog entry per distinct model (pricing +
   structured-output support + output cap), optionally compute an incremental changed-file
   set, slice per lens, price the run, call the `confirm` hook (Pi asks; MCP refuses over
   `max_cost` unless `force`), persist the run, then submit one batch per lens in parallel
   (`Promise.allSettled`), mark skipped lenses, persist, record batch-endpoint outcomes,
   and write `requests.json` for later retry.
2. `collect`: load the run, poll batches concurrently to a shared deadline (each poll honors
   an `AbortSignal`; HTTP 401/403 → `auth-failed`; server errors retried; budget expiry →
   synthetic `timeout` so a later collect can claim the still-running batch), save results,
   re-submit truncated slices once with a lowered reasoning effort, then claim and run the
   synthesis and triage post-passes (built from `verified.json` verdicts when present).
3. `verify`: rank the top defect/security findings, read each against the repo with a bounded
   read-only tool loop (≤8 tool calls), write `verified.md`/`verified.json`; `max_cost` is a
   running cap.
4. `models`/`status`: read-only catalog/state answers.

#### Dashboard
`writeDashboard` gathers status/pipeline/usage/closeouts/output availability/narration and
atomically writes a self-contained HTML file. Best-effort: it returns a boolean and never
throws to the caller. Refreshed on init, completion, amendment, pipeline switch, phase run,
and on demand. `--narrate` runs a one-shot LLM summary cached at
`.dashboard-narration.local.md`.

### Shutdown and cleanup

- `session_shutdown` → `disposeAgentsWidget()`.
- Each phase child session is `dispose()`d in a `finally` (swallowing dispose errors).
- Locks release via token-checked removal; stale locks (>60 s) are broken under `<lock>.break`.
- Temp files from `atomicWriteFile` use unique suffixes and are removed on failure.
- The MCP server's `serverLifetime` abort stops Broad-Side polling when the client goes away.
- Broad-Side batches already submitted keep running server-side and are claimable by a later
  `collect`.

### Background / scheduled work

- Broad-Side batch jobs (remote, asynchronous).
- Broad-Side poll loops with a default 25-minute budget and a 15 s interval.
- Pi's 30 s lingering phase-activity clear timer (`unref`'d).
- Dashboard narration (opt-in, one-shot).
- Git subprocesses bounded at 30 s; HTTP calls bounded at 30 s.

### Concurrency detail (summary-owned by the architecture map)

- **Model:** single-threaded Node event loop, `async`/`await`; no worker threads.
- **Lock primitive:** `acquireLock` (O_EXCL, pid+timestamp+token, 125 ms retry, 5 s timeout,
  60 s stale-break under a removal lock, token-checked release). Constants in `core/status.ts`.
- **Atomic write:** `atomicWriteFile` (unique temp suffix = pid + sequence + random, rename).
- **Ordering:** completion commit point; idempotent post-commit writers.
- **Parallelism:** concurrent batch polling; concurrent sub-agent? no — phases are sequential.
- **Guards:** phase re-entry (`isPhaseRunning`), run-slot claims (`claimRunSlot`), run-state
  merge (`persistBroadsideRunMerging`), read-state checks before writes.
- **Abort:** external `AbortSignal` (auto run, MCP client lifetime); `AbortSignal.timeout(30s)`.
- **Portability hazards:** O_EXCL lock files, rename atomicity, symlink resolution, `git` on
  `PATH`, `fetch`, `process.stdin` end events, and SDK event ordering are platform- or
  runtime-specific.

## 2026-09-15 — contracts phase

The lifecycle contracts a reimplementation must preserve (narrative form in
`findings/contracts/behavioral-contracts.md` §High-Value Behaviors):

- **Completion ordering is contractual.** Re-validation runs *under* the status lock; the
  `status.yaml` rename is the commit point; closeout/THREAD_LOG/decisions/conventions run in
  `afterCommit` and are idempotent (CONVENTIONS C02). A failure before the rename leaves no
  completion artifact; a failure after it leaves the status change standing and is repaired by
  re-running. `observed fact`: `core/completion.ts`, `core/workspace.ts`.
- **Abort surfaces.** Pi honors `ctx.signal` between phases and in Broad-Side polls; the MCP server
  aborts a Broad-Side wait on `stdin` `end`/`close` and `server.onclose`. Already-submitted batches
  keep running server-side and are claimable by a later `collect`. The status lock/write is not
  interruptible. `observed fact`: `mcp-server/server.ts`, `auto-runner.ts`.
- **Spending slots are single-owner.** `synthesis`, `triage`, and `retry` are claimed under the
  state lock before any network call, and run state is merged slot-by-slot, so two concurrent
  collects cannot double-pay or clobber each other. `observed fact`: `core/broadside/state.ts`.
- **Sub-agent isolation.** One Pi `AgentSession` per phase, disposed in a `finally`; the auto loop
  is sequential; a re-entry guard prevents a duplicate sub-agent. `observed fact`:
  `agent-runner.ts`, `auto-runner.ts`.

The mutex/rename portions of this lifecycle inherit `q-node-windows-fs-semantics` (findings 6.1,
6.2): the ordering above is `observed fact` from the code, but whether the lock and rename hold on
non-POSIX filesystems is `verify at runtime`.

## 2026-09-15 — protocols phase

The runtime **state machines** cataloged by `findings/protocols/protocols-and-state.md`
§State Machine, and the ordering guarantees a reimplementation must preserve. All `observed fact`
from source; lock/rename/network portions carry `verify at runtime`.

- **Pipeline cursor (SM1) — three outcomes, not two.** `recomputeCursor` sets `current_phase` +
  `next_actions` from `resolvePipelineOutcome`: `eligible` (a downstream phase is reachable) →
  `current_phase = <id>` + `beginPhaseAction`; `complete` (all complete) → terminal routing;
  `stuck` (no phase eligible, some incomplete) → first blocked phase + `describeStuckPipeline`.
  `current_phase` and the phase records can never disagree because both derive from the same walk.
- **Phase completion (SM2).** Re-validation runs **under** `status.yaml.lock`; the `status.yaml`
  rename is the commit point; closeout/THREAD_LOG/decision rows/convention staging run in
  `afterCommit` and are idempotent (CONVENTIONS C02). Refusals happen before the lock mutates
  anything (FAIL/MISSING, missing handoff, bad `target_phase`, missing `post_pipeline.id`, D1/D3).
- **Advisory lock (SM3).** `open(path,"wx")` is the primitive; removals (release and stale break)
  serialize under `<lock>.break` and re-check what they remove; a release removes only a lock
  carrying its own token. `LOCK_TIMEOUT_MS=5000`, `LOCK_RETRY_MS=125`, `STALE_LOCK_MS=60_000`.
- **Broad-Side run + spending slots (SM4).** `synthesis`/`triage`/`retry` are claimed under the
  state lock **before** any network call; run state merges slot-by-slot
  (`persistBroadsideRunMerging`); a budget/abort yields a synthetic `timeout` that stays claimable.
- **Library publish (SM5).** Guards (source-repo, confidentiality) run before the content-hash
  branch; new versions stage under a sibling directory and rename into `v<N>`; the `latest`
  pointer is rewritten only when a new version lands.
- **Amendment (SM6).** Refused unless the pipeline is complete *on the locked read* (the fix for
  the pre-lock race); closures + terminal `next_actions` under the lock; closeout + THREAD_LOG in
  `afterCommit`.
- **Pi sub-agent / auto loop (SM7).** One `AgentSession` per phase, sequential; re-entry blocked by
  `isPhaseRunning`; continuation on a tool-tail stop with the primary output absent; compaction
  writes the checkpoint; abort honors `ctx.signal`; dispose in `finally`.

**Event/hook ordering (Pi surface).** `session_start` resets mode; `tool_call` blocks `bash` and
confines `edit`/`write` (parent and phase-child hooks); `session_before_compact` supplies
phase-aware instructions; `session_compact` writes the checkpoint; `agent_end` refreshes the UI;
`session_shutdown` disposes the widget. Child sessions get the phase-compaction extension so an
`pi -e` load behaves like a global install. `observed fact`:
`extensions/codecarto/{index,phase-compaction}.ts`.

## 2026-09-15 — porting phase

Port-oriented companion to `findings/porting/reverse-engineering-bundle.md` §Protocol and State
Notes. No new runtime source walk; the phase confirmed the ordering claims below by targeted reads
(`core/status.ts:520-575`, `core/workspace.ts:425-458`, `core/library.ts:610-625,905-1005`).

### Concurrency redesign the port must make (not reproduce)

The source ordering is correct in the common case but has three settled defects that a port must
re-decide rather than copy:

1. **Stale-lock death is age-based** (`STALE_LOCK_MS = 60_000`, `mtimeMs`), so a lock legitimately
   held across a long library `reindex` can be broken while its owner still writes (semantic 3.2).
   Port design: owner-liveness/heartbeat, or an explicit holder protocol.
2. **Removal serialization is not atomic with the removal** (`withRemovalLock`'s unguarded `.break`
   `rm`; `breakStaleLock`'s `stat → describeLockHolder → rm`), so two waiters can both hold and a
   *fresh* lock can be deleted (semantic 3.1). Port design: claim the stale-break atomically and
   compare-and-delete by token/inode immediately before unlink.
3. **Not every writer takes the relevant lock** — refresh-scaffold/copyFile/`THREAD_LOG` outside the
   status lock (3.3), standalone `reindex`/`listEntries` outside `.publish.lock` (3.4), and
   `writeLibraryConfig`'s unlocked non-atomic RMW (3.7). Port design per CONVENTIONS C05: one
   writer-class per state file, each taking that file's lock.

The sub-agent re-entry guard is also check-then-act across the async prelude (3.5): reserve the
phase slot before any `await`. All lock/rename mechanics remain `verify at runtime` on non-POSIX
(`q-node-windows-fs-semantics`); the interleavings above are `observed fact` from the code's own
ordering logic.
