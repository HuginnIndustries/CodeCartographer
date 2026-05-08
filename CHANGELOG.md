# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] — 2026-05-08

### Added

- **Per-phase usage tracking.** `/codecarto-next` now appends a record to `.codecarto/workflow/.usage.local.yaml` every time a phase sub-agent finishes (completed, aborted, or errored). Each record holds the timestamp, phase ID, status, turn count, tool-use count, duration, and full token breakdown (`input` / `output` / `cache_write`). Append failures are swallowed — local logging is best-effort and never escalates to a phase error the user sees.
- **`/codecarto-usage` command.** Reads the local usage log and renders cumulative + per-phase totals to the status widget and an info notification: total runs, total tokens (input + output + cache-write, k/M-formatted), total duration, total tool uses, and a per-phase breakdown sorted by appearance order. On a fresh workspace with no recorded runs, surfaces an explicit "No phase runs recorded yet." message.
- **`core/usage.ts`** (~115 LOC). `loadUsage`, `appendUsageRun`, `computeTotals`, `computePerPhaseTotals`. Schema is intentionally narrow (`{ version, runs: UsageRun[] }`); totals are computed on read so the file never holds a number that contradicts the runs. Malformed YAML and entries missing required fields fall back to the empty case rather than blocking the command. Atomic-rename write (`.tmp` + `rename`) so a crash mid-write can't leave a partial file.
- **Template `.gitignore` entry** for `workflow/.usage.local.yaml` — the file holds absolute Pi session paths and machine-local timestamps; useless to share, easy to leak by accident.
- **6 new unit tests in `tests/usage.test.mjs`** covering tmp-dir round-trips for missing/present/malformed YAML, totals math, per-phase grouping, and entry validation. The Pi-extension command-registration invariant test in `tests/default-pipeline.test.mjs` was extended to require `usage` alongside the other 7 commands. Test count: 57 → **63**.

### Notes

- This is the **observability** half of the orchestrator-experience plan. Pairs naturally with the phase-summary injection (Option A) and opt-in LLM steering (Option B), but doesn't depend on either — the usage log is populated regardless of what other features are enabled.
- The MCP server is unchanged. The MCP path returns prompt text for the host to dispatch and never runs sub-agents itself, so there's no per-phase usage to track on that side. `/codecarto-usage` is a Pi-only command.
- The schema carries a `version: 1` field. If the shape grows breaking later, bump the version and have `loadUsage` migrate or reject. For now everything is forward-compatible: extra keys are ignored, missing optional keys default to zero.
- "Best-effort" really means best-effort — a full disk, permission denied, or read-only filesystem will silently lose the record. The orchestrator's own model-side billing and Pi's own session log remain the canonical accounting; this file is a convenience.

## [0.5.0] — 2026-05-08

### Added

- **Opt-in LLM-steered seed prompt for `/codecarto-next`.** When enabled, the orchestrator's LLM is run as a one-shot rewriter that reads the previous phase's closeout + the next phase's stock prompt and produces a customized seed prompt that names the specific findings, open questions, and carry-forward items the next phase should pay attention to. Off by default. The user controls the trade-off (extra orchestrator-side tokens vs. context-aware customization) per workspace and per invocation.
- **Workspace config at `.codecarto/workflow/config.yaml`.** New file shipped in the packaged template with `orchestrator.llm_steer_next_phase: false`. Loaded by `core/orchestrator-config.ts` (`loadCodecartoConfig`); missing file or unrecognized keys fall back to defaults, so existing workspaces keep working unchanged. Malformed YAML is non-fatal — falls back to defaults rather than blocking the command.
- **Per-invocation flag overrides** for `/codecarto-next`:
  - `/codecarto-next --llm-steer` — force on for this run regardless of config.
  - `/codecarto-next --no-llm-steer` — force off for this run.
  - Unknown flags surface a clear error rather than being silently ignored.
  - Tab-completion: the slash-command argument completer now suggests `--llm-steer` and `--no-llm-steer`.
- **`extensions/codecarto/agent-rewriter.ts` (~140 LOC).** One-shot in-memory `AgentSession` with `tools: []` (no extensions, no skills, no prompt templates, no themes, no context files) on the orchestrator's model. Reads the latest closeout matching the previous-phase ID under `.codecarto/closeouts/` (truncates to 8 KB before passing to the rewriter to keep the cost bounded) and asks the rewriter to emit a customized seed prompt — Markdown only, no commentary. On any failure (no prior phase, missing closeout, rewriter session error, empty output) returns the stock prompt with a `skipReason` and a `warning` notification — the command never aborts because of rewriter trouble.
- **`extensions/codecarto/next-flags.ts`.** Small parser for `/codecarto-next` args; pure, exhaustively tested. Last-flag-wins resolution lets the user safely chain overrides.
- **12 new unit tests** — 6 in `tests/orchestrator-config.test.mjs` (tmp-dir round-trips for missing/present/malformed YAML, plus pure `mergeConfig` shape checks), 6 in `tests/next-flags.test.mjs` (override matrix, last-wins, unknown collection, whitespace tolerance). Test count: 57 → 69.

### Notes

- The rewriter is **opt-in by design** — Option B from the orchestrator-visibility plan. Option A (always-on phase-completion summary injection, no LLM call) ships separately and is independently toggleable. Run them together for full visibility + steered prompts; run only A for the cheap visibility win; run only B if you want steering without the summary.
- The rewriter prompt explicitly forbids inventing findings the closeout doesn't state and forbids changing the next phase's structure or completion criteria — guardrails against the "LLM rewriter wanders off" failure mode.
- Closeout truncation (8 KB) was chosen by inspection of the closeout-template stub — it leaves headroom for one or two long phase outputs, well under typical orchestrator context windows. Tunable in `agent-rewriter.ts` if needed.
- The new config schema is intentionally narrow (one knob). Future toggles should slot in alongside `llm_steer_next_phase` in the same `orchestrator:` block; `mergeConfig`'s "default-then-override" pattern means adding a key requires no migration.

## [0.4.0] — 2026-05-08

### Added

- **Phase-completion summary is now injected into the orchestrator's session.** When `/codecarto-next` runs a phase sub-agent to completion (or it aborts, or it errors), the extension calls `pi.sendMessage({ customType: "codecarto-phase-summary", display: true })` with a Markdown summary block. The block becomes a `CustomMessageEntry` in the orchestrator's session: it renders in the TUI scrollback so the user sees `Phase X finished. ⟳ 5 · 12 tool uses · 2.3k tokens · 1m30s`, and on the user's next message it shows up in the orchestrator LLM's context as a prior user message. No `triggerTurn` — the orchestrator does **not** auto-respond, which keeps the user fully in control of when the next action happens. Closes the gap between "phase ran" and "user can ask the orchestrator about it" without forcing a closeout-file read on every follow-up question.
- **`extensions/codecarto/agent-summary.ts` (~95 LOC).** Pure formatter — no I/O, no session manipulation. Owns the `buildPhaseSummary()` helper. Three header variants (finished / aborted / failed); error path includes the error message and skips the excerpt/trailer; completed path includes the response excerpt (truncated to 2000 chars with a "transcript truncated; resume the phase session" tail), the session file path with a `/resume` hint, and validate/complete next-step pointers. Sessions without a recorded `sessionFile` (e.g. resumed before 0.3.0's persistent-session change lands) just drop the transcript line and keep the rest.
- **7 new unit tests in `tests/agent-summary.test.mjs`** covering the header variants, the truncation path, zero-activity formatting, missing session file, and the k/M token threshold formatting. Test count: 57 → 64.

### Notes

- This is **Option A** from the orchestrator-visibility plan — always on, no LLM calls (so no extra orchestrator-side tokens), works regardless of whether the phase session is in-memory or persisted.
- Option B (opt-in LLM-steered customization of the next phase's seed prompt) is a separate change set, expected next.
- The `display: true` rendering uses Pi's default custom-message styling. Registering a dedicated `pi.registerMessageRenderer("codecarto-phase-summary", ...)` for codecarto-themed rendering is intentionally deferred — the default already reads cleanly and the TUI affordance can be tuned without an API change.

## [0.3.0] — 2026-05-08

### Changed (minor bump per pre-1.0 convention)

- **Phase sub-agents now persist to the same Pi session directory the orchestrator uses.** `extensions/codecarto/agent-runner.ts` swaps `SessionManager.inMemory(cwd)` for `SessionManager.create(cwd)`, which writes a JSONL file under `~/.pi/agent/sessions/<encoded-cwd>/`. Pi's `/resume`, `/tree`, and `/export` already read that directory, so phase transcripts become first-class browsable artifacts: open the picker and resume into a previous phase, view its tool-call tree, export to HTML, etc. — no codecarto-side plumbing needed. In-memory sessions left no trace once `/codecarto-next` returned, so the rich event stream rendered in the live widget vanished the moment the spinner aged out; this closes that gap.
- **Phase sessions are tagged for the picker.** Each spawn calls `sessionManager.appendSessionInfo("CodeCartographer phase: <id>")` so the session shows up in `/resume` with a meaningful name (rather than the default first-message preview), and rewrites the header with `parentSession: <orchestrator's session file>` so Pi's `SessionInfo.parentSessionPath` exposes provenance to any UI that wants to render lineage.
- **`PhaseRunResult.sessionFile`** added — the absolute path to the on-disk session JSONL. Useful for follow-on tooling (the planned `/codecarto-usage` command, downstream session viewers) that wants to point at a phase's transcript without rebuilding the path from `cwd`.
- **`runPhase()` signature** gained a `PhaseRunOptions` argument (currently `{ sessionName?: string }`) between callbacks and signal. The single internal caller (`/codecarto-next`) passes the phase ID-derived name; all other args remain backward compatible.

### Notes

- The session directory is shared between the orchestrator's TUI session and every phase sub-agent run — by design, so `/resume` lists them together. The `parentSession` header makes the relationship discoverable; the explicit `appendSessionInfo` name keeps them visually distinct from regular orchestrator sessions in the picker.
- Phase sub-agent session files are stored in `~/.pi/agent/sessions/`, **not** inside the project's `.codecarto/`. Nothing new lands in the repo's gitignore; existing Pi cleanup (the user's session-directory hygiene practices, if any) applies unchanged.
- 57/57 tests pass — no schema changes touch the on-disk workspace state.

## [0.2.1] — 2026-05-08

### Fixed

- **Agents-widget turn count now renders with a space** (`⟳ 5` instead of `⟳5`). The unspaced glyph collided with the digits on terminals whose font mapped `⟳` to a slightly wider cell than nominal, making the count hard to read at a glance.
- **Main status widget now refreshes when a phase sub-agent finishes.** The "Open questions / Carry-forward / Next" lines were stale until the user manually ran `/codecarto-status` (or any other command that re-rendered the widget), even when the sub-agent had written new findings, owner_notes, or carry-forward items into `status.yaml`. `/codecarto-next`'s `.finally()` now calls `refreshWorkspaceUi(ctx)` after the phase resolves, so the orchestrator's status widget tracks reality without user action. The `agent_end` handler already covered the orchestrator's own turns; this closes the gap for phase sub-agents whose lifecycle is independent of `agent_end`.


## [0.2.0] — 2026-05-07

### Changed (breaking — minor bump per pre-1.0 convention)

- **`/codecarto-next` now runs phases as in-process AgentSession instances with a live "Agents" widget above the editor.** Replaces the 0.1.3/0.1.4 session-switching design (which used `ctx.newSession()` and produced a context-isolated child but flipped the user's TUI to it, which was invisible during normal flow). The new path uses the SDK's `createAgentSession()` + `SessionManager.inMemory()` to spawn an isolated child session that runs in parallel with the orchestrator's TUI; the orchestrator's transcript stays clean and visible while the phase works. Architecture and event-subscription pattern adapted from `@tintinweb/pi-subagents` (forked into our codebase, not added as a dependency).
  - New `extensions/codecarto/agent-runner.ts` (~165 LOC): builds a `DefaultResourceLoader` + `SessionManager.inMemory()`, calls `createAgentSession`, subscribes to the session's event stream (tool start/end, turn end, message updates, message end usage), forwards events to caller-provided callbacks. The runner is fire-and-forget; `/codecarto-next` returns immediately.
  - New `extensions/codecarto/agent-state.ts` (~70 LOC): module-scoped `Map<phaseId, PhaseActivity>` tracking running and recently-finished phases. Mutated by runner callbacks; read by the widget.
  - New `extensions/codecarto/agent-widget.ts` (~265 LOC): persistent widget registered via `ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })`. Renders a tree of running and recently-finished phases with spinner, tool-use count, token usage, elapsed time. 80ms tick for animation; `tui.requestRender()` for active updates without re-registration. Auto-unregisters when no phase is active and finished phases have lingered out (~6.4s). Widget is torn down on `session_shutdown` to avoid leaking the timer.
- **Tier A (session-switching) code removed.** `core/orchestrator.ts` deleted; its `loadOrchestratorState` / `writeOrchestratorState` helpers are gone. `extensions/codecarto/index.ts` no longer reads or writes `.codecarto/workflow/.orchestrator.local.yaml`. `tests/orchestrator-state.test.mjs` deleted (7 round-trip tests no longer relevant). The gitignore entry for the local-state file remains in the template — existing 0.1.3 / 0.1.4 workspaces may have a leftover file on disk, and ignoring it keeps stale local state out of git.
- **Peer dep `@earendil-works/pi-coding-agent` pinned to `~0.74.0` (was `^0.74.0`).** Tilde locks the minor lane. `0.2.0` imports several SDK exports beyond the standard `ExtensionContext` surface (`createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `getAgentDir`, `AgentSession`, `AgentSessionEvent`); these are public top-level exports of the package's `index.d.ts` but the SDK is pre-1.0 and minor-version churn in those internals is plausible. The smoke test (`npm run smoke`) plus the daily cron in `smoke.yml` remain the safety net for future Pi minor bumps; consider unpinning once a major version of the Pi SDK lands and the API surface stabilizes.

### Notes

- Test count drops from 64 → 57 because the 7 `orchestrator-state` tests were deleted alongside the module they covered. The 57 surviving tests cover pipeline invariants, default pipeline shape, MCP server tool definitions, and documentation cross-references.
- The phase sub-agent inherits codecarto's tool-interception logic via `bindExtensions()` — `bash` is blocked, `edit`/`write` are confined to `.codecarto/`, same rules the orchestrator's TUI session has had since 0.1.0. The runner explicitly limits the child's tool list to `["read", "edit", "write", "grep", "find", "ls"]` as a defense-in-depth against tool drift.

## [0.1.4] — 2026-05-07

### Fixed

- **`/codecarto-next` no longer crashes with `extension ctx is stale after session replacement`.** The 0.1.3 sub-agent handler called `ctx.ui.notify(...)` and `setUiState(ctx, ...)` *after* `await ctx.newSession(...)` (and similarly after `ctx.switchSession(...)` on the phase-child path). Per the Pi SDK contract, the original `ctx` is invalidated as soon as the session-replacing call returns; touching it raises a runtime error that aborts the handler. The spawn itself succeeded — the child session was created with the phase prompt — but the post-spawn notification crashed loudly, making the feature look broken. Reordered: all outer-session UI updates (`lastFeedbackLines`, `setUiState`, `ctx.ui.notify`) now run *before* the session-replacing call; the `withSession` callback owns all post-replacement work via its own fresh ctx; the original `ctx` is never touched after the await. Same fix applied to the phase-child branch's `switchSession` plus the inner `orchestratorCtx.newSession` (which invalidates the outer `withSession` callback's ctx — so the inner spawn must be the last statement in that callback). The `result.cancelled` notifications were dropped from both branches since there's no live ctx to notify with on a cancelled spawn.

## [0.1.3] — 2026-05-07

### Added

- **Sub-agent orchestrator mode for the Pi extension.** When `/codecarto-init` runs from Pi, the current Pi session is recorded as the workspace's *orchestrator*; every subsequent `/codecarto-next` spawns the phase as a child session via `ctx.newSession({ parentSession })` instead of injecting the phase prompt into the current conversation. The phase's tool calls, file reads, and reasoning land in the child's own context window — the orchestrator only sees the phase entry/exit, not the work. When `/codecarto-next` is invoked *from inside* a phase child, the handler switches the TUI back to the orchestrator and chains the next phase atomically (single `ctx.switchSession({ withSession })` followed by `newSession`). The orchestrator pointer is written to `.codecarto/workflow/.orchestrator.local.yaml` (gitignored — it holds a machine-local absolute path to the Pi session file). Workspaces created by 0.1.0–0.1.2 have no orchestrator file and fall back to the legacy in-place phase prompt; re-run `/codecarto-init` to opt in. The MCP-server path is unaffected (it has no session concept; the host application is always the orchestrator). 7 unit tests added for the load/write round-trip.

### Changed

- **Release workflow now smoke-tests the packed tarball before publishing.** `release.yml` now runs `npm pack` after the unit tests, then exercises `scripts/smoke-mcp.mjs --tarball` against the resulting `.tgz` *before* `npm publish`. A failing smoke kills the run before anything reaches the npm registry — preventing the 0.1.1 class of bug where the build pipeline broke template resolution but the existing post-publish smoke (under `workflow_run`) didn't surface the failure visibly. Removed the `workflow_run: ['Release']` trigger from `smoke.yml`; the daily cron + `workflow_dispatch` paths stay in place to catch registry-side regressions caused by transitive-dep updates after publish.
- **`scripts/smoke-mcp.mjs --tarball <path>`**: smoke now accepts a local tarball as an alternative to `--version <ver>`. Same nine-step suite either way; `--version` and `--tarball` are mutually exclusive.

## [0.1.2] — 2026-05-07

### Fixed

- **`/codecarto-init` and the `codecarto_init` MCP tool now actually find the packaged `.codecarto/` template after install.** `0.1.1` shipped the template at the package root (`<package>/.codecarto/`) but the compiled `core/workspace.js` resolved its sibling directory via a single `..` from `dist/core/` — landing at `<package>/dist/.codecarto/`, which doesn't exist. Every `/codecarto-init` failed with `Error: Packaged .codecarto assets are missing.` (and the MCP path threw `McpError(InternalError)`). The 57/57 invariant tests pass against the source tree, so this only manifested after the build pipeline added in 0.1.1 — and the published smoke test was checking the response shape rather than the actual template-copy behavior. Replaced the fragile `..` walk with a `findPackageRoot(import.meta.dir)` that walks up to the first `package.json`, which lands on `<package>/` in both source and `dist/` layouts.
- **Remove `codecartographer-pi` self-dependency from `package.json`.** Running `npm install codecartographer-pi` from inside the repo (e.g., to verify a published artifact) caused npm to write the package as a direct dependency of itself. Left in, the `0.1.2` tarball would have nested a copy of `codecartographer-pi@0.1.1` under its own `node_modules/`, with the outer package's `bin` and `pi.extensions` paths potentially resolving against the wrong copy depending on host walk order.

### Changed

- Pin `@modelcontextprotocol/sdk` to `^1.29.0` (was `*`). The wildcard let `npm install` resolve to anything and made the npmjs.com dependency panel for `codecartographer-pi` link to the SDK's draft-spec docs. The pinned range covers SDK 1.29.x, which advertises MCP `2025-11-25` as `LATEST_PROTOCOL_VERSION` while still accepting `2024-10-07` through `2025-11-25` from clients.
- **Release workflow now creates a git tag and a GitHub Release on every publish.** Previously `release.yml` only ran `npm publish`, so the GitHub repo's "Releases" sidebar stayed empty. The workflow is now idempotent end-to-end: `npm publish` skips if the version is already on the registry, `gh release create` skips if the tag's release already exists. Notes for the GitHub Release are extracted from the matching `## [VERSION]` section of `CHANGELOG.md`. Permissions widened from `contents: read` to `contents: write` so the runner can create tags and releases.
- **Migrate Pi peer dependency from `@mariozechner/*` to `@earendil-works/*`.** The `@mariozechner/pi-coding-agent` package was deprecated upstream in favor of `@earendil-works/pi-coding-agent`; `pi update` now emits five deprecation warnings on every install. Switched our peer dep declaration and the one extension import (`extensions/codecarto/index.ts`) over to the new namespace at `^0.74.0`. Type names (`ExtensionAPI`, `ExtensionCommandContext`, `ExtensionContext`) are unchanged across the rename — drop-in replacement, no behavior change.

### Documentation

- README: explicitly document the MCP spec revision the package implements, and link to the released spec at `modelcontextprotocol.io/specification/2025-11-25`.
- **README: clarify Pi vs. MCP install paths.** Added `pi install npm:codecartographer-pi` as the primary install command for the Pi use case alongside the existing local-checkout and git-URL options, and added an explicit warning that plain `npm install codecartographer-pi` does NOT register the package with Pi (it has to be `pi install npm:...` so Pi writes it into its own `settings.json`). Plain `npm install` is still the correct command for the MCP-server use case.

## [0.1.1] — 2026-05-07

### Fixed

- **`codecarto-mcp` is now actually runnable when installed from npm.** `0.1.0` shipped TypeScript source files and relied on Node's `--experimental-strip-types` to load them at runtime. Node refuses to strip types from any file inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the bin failed to start on every Node version. Caught by the new end-to-end smoke test against the published artifact (PR #11).

### Changed

- Build pipeline added: `tsc` compiles `core/`, `extensions/`, and `mcp-server/` to `dist/`. The published tarball ships compiled JavaScript instead of TypeScript source. `prepublishOnly` enforces a fresh build at publish time.
- `package.json#bin.codecarto-mcp` now points at `./dist/mcp-server/bin.mjs`. `pi.extensions` points at `./dist/extensions`. `files` ships `dist/**/*` instead of the source directories.
- `mcp-server/bin.mjs` shebang simplified to `#!/usr/bin/env node` (no flags needed once the imports resolve to `.js`).
- `engines.node` lowered from `>=22.6.0` to `>=20.0.0`. The published artifact is plain JavaScript, so the `--experimental-strip-types` floor only applies to local development and CI.

### Notes

- TypeScript `^5.7` (specifically requires `rewriteRelativeImportExtensions`, introduced in 5.7) is now a `devDependency`. Consumers don't see it.
- The smoke test (`npm run smoke`) installs the published package into a temp dir and exercises the bin via the MCP SDK's stdio client. Daily cron in `.github/workflows/smoke.yml` will catch any registry-side regressions within 24 hours.

## [0.1.0] — 2026-05-06

Initial public release under the MIT license.

### Added

- **Framework core** (`core/`): pipeline state machine, YAML pipeline validators, prompt assembly, workspace utilities. Imported by both the Pi extension and the MCP server so phase prompts and validation logic stay byte-identical across surfaces.
- **Pi extension** (`extensions/codecarto/`): `/codecarto-init`, `/codecarto-status`, `/codecarto-next`, `/codecarto-phase`, `/codecarto-validate`, `/codecarto-complete`, and `/codecarto-skill` slash commands. Includes a footer widget showing the active phase and tool interception that blocks edits outside `.codecarto/`.
- **MCP server** (`mcp-server/`): seven tools mirroring the Pi extension (`codecarto_init`, `codecarto_status`, `codecarto_next`, `codecarto_phase`, `codecarto_validate`, `codecarto_complete`, `codecarto_skill`) so any MCP-compatible host (Claude Code, Claude Desktop) can drive a CodeCartographer workflow.
- **Default pipeline**: `pipeline-full-with-deep-audit.yaml` (7 phases). Splits the defect scan into a mechanical early pass and a semantic late pass so the reimplementation spec can design around defects with full contracts and protocols context.
- **Pipeline variants**: `architecture-only` (1 phase), `lite` (3 phase), `defect-scan` (2 phase), `full` (5 phase), `full-with-audit` (6 phase, single early defect scan), and `full-with-deep-audit` (7 phase, default).
- **Invariant tests** (`tests/`): default-pipeline, doc-mention, mcp-server, pipeline-invariants. Catch cross-wrapper drift between template, Pi extension, and MCP server.
- **CI** (`.github/workflows/ci.yml`): runs `npm ci && npm test` on every PR and push to `master`.
- **Documentation**: README with quick-start, pipeline variants, model-compatibility tiers, token-cost guidance; MANUAL for human users; per-phase SKILL.md and template files inside `.codecarto/`.

### Notes

- Node 20+ is required.
- The Pi runtime and `@sinclair/typebox` are peer dependencies — install them in your host environment, not as direct dependencies of this package.

[Unreleased]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HuginnIndustries/CodeCartographer/releases/tag/v0.1.0
