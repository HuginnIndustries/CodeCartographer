# Runtime Lifecycle

Catalog-level detail accumulated across phases (`mode: append`).

## 2026-09-11 — architecture

All steps `observed fact` from source unless marked `[external]` (Pi or MCP SDK behavior taken from code comments) or `[inference]`.

### MCP server process

1. Host spawns `codecarto-mcp` (`dist/mcp-server/bin.mjs`) → `startStdioServer()` → `buildServer()`.
2. `buildServer` constructs `new Server({name:"codecartographer", version: PACKAGE_VERSION}, {capabilities:{tools:{}}})`, registers `ListTools` (returns `TOOLS`) and `CallTool` (looks up `HANDLERS[name]`, wraps non-`McpError` throws as `InternalError`) (`mcp-server/server.ts:1711-1736`).
3. `server.connect(new StdioServerTransport())`. No signal handlers, no shutdown hook; lifetime is the stdio pipe `[inference]`.
4. Per call: `validateCwd` (string, absolute, exists) → `requireWorkspace` → `getWorkspaceState(cwd)` which reads `status.yaml`, resolves `pipeline:` (throws if missing or nonexistent), loads the pipeline YAML, `normalizeStatus`, reads `scaffold-version.yaml` (`core/workspace.ts:70-109`). No caching between calls.
5. Module-load side effects: `findPackageRoot` walks up from `dist/core/` to find `package.json` (throws if absent), reads `version` into `PACKAGE_VERSION` (`core/workspace.ts:19-49`).

### `codecarto_complete` sequence (shared core, both surfaces)

1. `validatePhaseOutput` (caller side) → refuse FAIL/MISSING.
2. `completeValidatedPhase(cwd, validation, sourceLabel)` (`core/completion.ts:317`):
   - `loadHandoffFile` → `parseHandoff` (schema ≤1, arrays, auto-assign ids `oq-<phase>-N` / `cf-<phase>-N`).
   - Refuse if no handoff and phase declares `handoff_requirements` (`:332-342`).
   - Validate each `carry_forward.target_phase` is a *later* phase in `phase_order` (`:345-352`); each `post_pipeline` entry has an id (`:353-355`).
   - D1: refuse closing a carry-forward whose `derives_from` question is still open and not closed in the same handoff (`:379-388`).
   - D3: `needs-runtime-test` closures need non-empty `evidence`; refuse on scaffold ≥ 0.19.0, warn otherwise (`:400-413`).
   - Warn (non-gating) for closure ids the primary output never mentions (`:420-431`).
   - `updateStatusAtomically`: acquire lock → re-`validatePhaseOutput` under lock, refuse FAIL/MISSING (`:448-456`) → PARTIAL rows become `needs-maintainer-decision` open questions with auto ids (`:467-480`) → phase marked `complete` with three appended owner notes (`:481-492`) → `applyHandoff` → `current_phase`/`next_actions` recomputed (`:496-500`) → `writeCompletionArtifacts` (closeout file, THREAD_LOG line, DECISIONS rows, CONVENTIONS proposals) → status serialized to temp + rename → release lock.
3. Wrapper side: MCP appends a zero-token usage receipt (`mcp-server/server.ts:413-428`) and re-renders the dashboard; Pi's `autoCompletePhase` re-renders the dashboard (`auto-runner.ts:227-237`).

### Pi extension lifetime

1. Load: `codeCartographerExtension(pi)` runs `phaseCompactionExtension(pi)` then registers 20 commands and 4 hooks (`index.ts:347-1654`).
2. `session_start`: `codecartoModeActive=false`, feedback cleared, `sessionCwd` captured, widgets cleared (`:405-410`).
3. `/codecarto-init` or `/codecarto-open`: mode on, `pi.setActiveTools(SAFE_TOOL_NAMES)` = read/grep/find/ls/edit/write (`:101,466,585`), session renamed `CodeCartographer: <phase>`.
4. `tool_call` hook while active and `.codecarto/` exists: block `bash`; for `edit`/`write` canonicalize the target and require it under `.codecarto/` or the configured library (`:422-452`).
5. `/codecarto-next` (one-shot): `parseNextFlags` → `runPhasePreflight` → `isPhaseRunning` guard → `runSinglePhase` fire-and-forget → `.then` validates from fresh disk state and `autoCompletePhase`s on PASS/PASS WITH GAPS; `.catch`/`.finally` refresh UI via `notifyCtx`, which drops messages if the ctx died `[external]` (`:675-813`).
6. `runSinglePhase` (`auto-runner.ts:83-204`): `buildPhasePrompt(auto?)` → optional `rewritePhasePrompt` one-shot session → `startPhase` activity record → widget attach → `runPhase` → `finishPhase` → notify + `codecarto-phase-summary` message → `recordUsage` → `writeDashboard` → 30 s linger then `clearPhase`.
7. `runPhase` (`agent-runner.ts:124-288`): `DefaultResourceLoader` with everything off except `phaseCompactionExtension`; `SessionManager.create(cwd)` with `parentSession` = orchestrator session file; `createAgentSession` with `createChildModelRuntime` (copies parent's registered providers `[external]`), tools = read/edit/write/grep/find/ls; subscribe to events for tool/turn/token/compaction counters; `session.prompt(prompt)`; if primary output absent or transcript ended on a tool call, wait ≤30 s for a compaction to settle and send one continuation prompt.
8. `runAuto` (`auto-runner.ts:314-436`): loop `getNextEligiblePhase` → preflight → `runSinglePhase(auto:true)` → validate → `decideAfterPhase` → `autoCompletePhase` → `onPhaseAdvanced`; stops on abort/error/FAIL/MISSING/(strict) PASS WITH GAPS/preflight error/auto-complete error.
9. `agent_end`: refresh widget. `session_shutdown`: dispose agents widget (`:412-420`).
10. Compaction in a phase child: `session_before_compact` runs `compact()` with phase-aware instructions `[external]`; `session_compact` writes `scratch/checkpoints/<phase>.md` (`phase-compaction.ts:88-135`).

### Broad-Side run

`submit`: `collectRepoInfo` (git ls-tree or bounded walk) → resolve catalog entry per model (config override → 24 h cache → live → built-in) → refuse models without structured-output support → incremental diff if requested → slice per lens → estimate → confirm (Pi) or refuse over `max_cost` (MCP) → persist run → submit one batch per lens in parallel → persist → write `requests.json` (`core/broadside.ts:2163-2444`). `collect`: last run in `state.runs` → poll non-terminal lenses concurrently against one deadline → save results, mark truncated → optional one-shot retry with doubled `max_tokens` → synthesis + triage batches (or reclaim ones left `submitted`) → `run-meta.json` (`:2663-3021`).

### Amendment

`applyAmendment` refuses while `getNextEligiblePhase` is non-null; under the status lock removes open questions / post_pipeline items by id, rebuilds terminal `next_actions`, writes `closeouts/<date>-amendment-<slug>.md` and a THREAD_LOG line (`core/amendment.ts:136-205`).

## 2026-09-11 — contracts

### `--auto` decision matrix (pinned by `tests/auto-runner.test.mjs`)

| Sub-agent result | Validation | strict | Decision |
|---|---|---|---|
| aborted | (not consulted) | any | aborted |
| error | (not consulted) | any | stop, reason = error message or "Sub-agent errored." |
| completed | null | any | stop, "Validation skipped (no result)." |
| completed | FAIL / MISSING | any | stop with validation summary |
| completed | PASS WITH GAPS | false | continue (auto-complete) |
| completed | PASS WITH GAPS | true | stop with validation summary |
| completed | PASS | any | continue |

Preflight error before a phase → stop (PhasePreflightError message, no `error` field); phase already running → stop; auto-complete refusal → stop "Auto-complete failed on <phase>: …".

### Pi ctx invalidation (SDK v0.85.1, `dist/core/agent-session.js`)

`dispose()` (:584-595) and `reload()` (:2217-2221) are the only callers of `ExtensionRunner.invalidate`; both correspond to user-driven session replacement or reload. `createAgentSession` (used by `agent-runner.ts:167`) creates a sibling session and does not dispose the parent. Consequence: the orchestrator ctx stays live across a phase unless the user replaces or reloads the session mid-run.

## 2026-09-11 — porting

Kernel loop to preserve (`observed fact`, compressed): status load → next eligible (or stuck, per D-H6) → prompt assembly → [host executes] → validation parse → handoff parse and gates → lock → re-validate → status rename → artifacts (order fixed per D-M20) → release → best-effort dashboard/usage. The Pi auto loop is the same sequence driven in-process with the decision matrix in §2026-09-11 contracts; a port to another host reproduces the sequence, not the loop.
