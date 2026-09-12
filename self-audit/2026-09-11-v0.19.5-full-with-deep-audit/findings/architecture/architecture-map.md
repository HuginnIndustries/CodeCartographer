# Architecture Map

Source under review: everything outside `.codecarto/` at commit `f6f8484` (v0.19.5) — `core/`, `mcp-server/`, `extensions/`, `tests/`, `scripts/`, `agent-skill/`, `.github/`. The `.codecarto/` tree is the packaged template and doubles as this run's workspace; its prompts, pipelines, and skills are not under review here.

Evidence markers used throughout: `[fact]` observed fact, `[inference]` strong inference, `[external]` external-behavior claim, `[hazard]` portability hazard, `[open]` open question.

## System Intent

CodeCartographer is a filesystem-backed pipeline state machine for LLM-driven reverse engineering. It does not read the target repository and does not call a model `[fact: core/prompts.ts:1-3, agent-skill overview "It never reads your repository"]`. Instead it (1) selects the next eligible phase from a YAML DAG, (2) assembles a byte-identical phase prompt for whichever host LLM is driving, (3) parses the markdown `## Validation` block the LLM appends to its primary output, and (4) gates completion on that parse plus a structured handoff file, applying the handoff to canonical state under a file lock. The same core is shipped through three surfaces — a Pi coding-agent extension that spawns isolated sub-agents, an MCP server that returns prompt text over stdio, and the bare `.codecarto/` template — and two adjacent subsystems ride on it: a versioned on-disk library of finished reimplementation specs, and Broad-Side, a paid batch reconnaissance sweep over the OpenRouter Batch API `[fact: core/broadside.ts:1-33]`. The audience is a developer pointing a coding agent at an unfamiliar repository who wants durable, validated, evidence-tagged artifacts rather than a chat transcript.

## Layer Map

### Package Inventory

Line counts are from `wc -l` on the clone (command output, 2026-09-11).

| Package / Module | Role | Public Entrypoints | Key Dependencies | Runtime Surface |
|---|---|---|---|---|
| `core/` (19 modules, 9,447 lines) | core semantics + persistence/state | `core/index.ts` barrel re-export of all 19 modules `[fact: core/index.ts:5-22]` | Node built-ins only (`fs/promises`, `path`, `crypto`, `child_process`); no npm runtime deps | Library consumed in-process by both wrappers and by `scripts/` via `dist/core/index.js` |
| `core/types.ts` | core semantics (schema) | `StatusFile`, `PipelineFile`, `PhaseHandoff`, `ValidationResult` types | none | — |
| `core/yaml.ts` (403) | protocol / normalization | `parseSimpleYaml`, `stringifySimpleYaml`, `loadYamlFile` | `utils.isPlainObject` | Hand-rolled YAML subset parser used for every YAML file the framework reads or writes `[fact: core/yaml.ts:1-3]` |
| `core/status.ts` (449) | persistence / state | `normalizeStatus`, `parseHandoff`, `applyHandoff`, `acquireLock`, `buildTerminalNextActions` | `yaml`, `utils` | status.yaml normalization + O_EXCL file lock |
| `core/workspace.ts` (463) | persistence / state | `getWorkspaceState`, `updateStatusAtomically`, `copyPackagedWorkspace`, `refreshScaffold`, `switchPipeline`, `packagedWorkspaceDir`, `PACKAGE_VERSION` | `status`, `yaml`, `utils` | Locates the installed package root by walking up to `package.json` `[fact: core/workspace.ts:19-37]` |
| `core/pipeline.ts` (224) | core semantics | `PIPELINE_ALIASES`, `getNextEligiblePhase`, `resolvePhase`, `validatePhaseOutput`, `buildValidationSummary` | `findings`, `utils` | DAG walk + validation-block parser |
| `core/findings.ts` (180), `core/coverage.ts` (152) | core semantics (cross-checks) | `crossCheckFindings`, `collectCoverageGaps` | `utils` | Read-only parsers over findings tables and the `## Coverage and limits` ledger |
| `core/completion.ts` (514) | core semantics | `completeValidatedPhase`, `countPendingProposals`, `closureEvidenceGateActive` | `pipeline`, `status`, `workspace`, `utils` | The completion gate: re-validates under lock, applies handoff, writes closeout/THREAD_LOG/DECISIONS/CONVENTIONS |
| `core/prompts.ts` (333) | core semantics | `buildPhasePrompt`, `buildSkillPrompt`, `listSkillNames` | `coverage`, `completion`, `workspace`, `synthesis`, `utils` | The phase prompt both surfaces emit |
| `core/amendment.ts` (205) | core semantics | `applyAmendment`, `loadAmendmentFile` | `pipeline`, `status`, `workspace` | Post-pipeline state channel |
| `core/orchestrator-config.ts` (196) | persistence / state (config) | `loadCodecartoConfig`, `writeLibraryConfig`, `resolveUserConfigPath` | `yaml`, `utils` | Two-layer config: `~/.codecarto/config.yaml` under `.codecarto/workflow/config.yaml` `[fact: core/orchestrator-config.ts:1-15]` |
| `core/usage.ts` (185) | persistence / state | `appendUsageRun`, `loadUsage`, `computeTotals` | `yaml`, `utils` | Append-only usage log |
| `core/guide.ts` (63) | integration adapter | `readGuide`, `listGuideTopics` | `workspace.packageRoot` | Serves `agent-skill/codecartographer/*.md` verbatim |
| `core/dashboard.ts` (911) | UI / rendering | `renderDashboard`, `safeRelativeHref`, `escapeHtml` | `utils`, `usage` | Pure HTML string renderer, no I/O |
| `core/library.ts` (1,344) | persistence / state | `publishEntry`, `readEntry`, `listEntries`, `reindex`, `initLibrary`, `resolvePublishSourceRepo`, `commitPublish` | `yaml`, `utils`, `child_process` (git) | Versioned spec store; format is ABI per `docs/library-format.md` `[fact: core/library.ts:4-8]` |
| `core/synthesis.ts` (214) | core semantics (preflight) | `runPhasePreflight`, `PhasePreflightError` | `library`, `orchestrator-config` | Guards for the forward-synthesis pipeline |
| `core/broadside.ts` (3,261) | integration adapter (OpenRouter) | `runBroadsideSubmit`, `runBroadsideCollect`, `listBatchModels`, `loadBroadsideConfig` + lens registry | `status.acquireLock`, `yaml`, `workspace`, `child_process` (git), global `fetch` | Only module with network I/O; only module that spends money |
| `mcp-server/` (2 files, 1,753 lines) | product shell (MCP) | `bin.mjs` → `startStdioServer()`; 22 tools in `TOOLS` `[fact: mcp-server/server.ts:1301-1670; grep count 22]` | `@modelcontextprotocol/sdk` (the package's only runtime dependency), `core/index.ts`, and **`extensions/codecarto/dashboard-writer.ts`** `[fact: mcp-server/server.ts:105]` | JSON-RPC over stdio; every call stateless, re-reads disk |
| `extensions/codecarto/` (16 files, 4,099 lines) | product shell (Pi) + UI | default export registers 20 slash commands `[fact: grep count of `pi.registerCommand(`]` and 4 event hooks `[fact: extensions/codecarto/index.ts:405-452]` | `@earendil-works/pi-coding-agent` (peer dep), `@earendil-works/pi-tui`, `core/index.ts` | In-process TUI extension; spawns `AgentSession` sub-agents per phase |
| `extensions/codecarto/dashboard-writer.ts` (166) | integration adapter (I/O for `core/dashboard.ts`) | `writeDashboard(cwd, version)` | `core` | Shared by **both** wrappers despite living under `extensions/` `[fact: mcp-server/server.ts:105; extensions/codecarto/index.ts:10]` |
| `agent-skill/codecartographer/` (11 markdown files) | documentation served as data | `SKILL.md` + `references/*.md` | none | Read by `core/guide.ts`; also an installable skill directory |
| `tests/` (52 files, 13,217 lines, 639 `test(` calls) | verification | `npm test` (`node --test` with `--experimental-strip-types`) | imports `.ts` sources directly | Not shipped |
| `scripts/` (4 files, 643 lines) | tooling | `smoke-mcp.mjs`, `smoke-broadside.mjs`, `create-synthesis-demo.mjs`, `build-demo-dashboard.mjs` | `dist/` build output, MCP SDK client | Not shipped; smoke runs in CI/release |
| `.codecarto/` template | data (prompts, pipelines, skills, templates) | copied by `copyPackagedWorkspace` on init `[fact: core/workspace.ts:157-182]` | — | Out of scope for this review but is the ABI every module above reads |

Role classification of the whole system: **shared core + multiple delivery surfaces** with **product-specific wrappers around a shared core** `[inference]`. The pattern test in the SKILL for "shared stateful agent or execution loop" matches only the Pi surface; the MCP surface has no loop of its own.

### Dependency Direction

`[fact]` unless marked. Arrows read "depends on".

```
types ← utils ← yaml ← status ← workspace ← { pipeline, findings, coverage }
                                      ↑            ↑
                                completion ────────┘
                                      ↑
                                prompts ← synthesis ← { library, orchestrator-config }
                                      
amendment  → pipeline, status, workspace
broadside  → status (acquireLock), yaml, workspace (packagedWorkspaceDir)
dashboard  → utils, usage           (pure; no fs)
guide      → workspace (packageRoot)
usage      → yaml, utils

mcp-server/server.ts        → core/index.ts, core/{amendment,usage,library,orchestrator-config}.ts, extensions/codecarto/dashboard-writer.ts
extensions/codecarto/*.ts   → core/index.ts, core/{library,orchestrator-config,usage}.ts, @earendil-works/pi-coding-agent
scripts/*.mjs               → dist/core/index.js, dist/mcp-server/server.js, dist/extensions/codecarto/dashboard-writer.js
tests/*.test.mjs            → core/*.ts, mcp-server/server.ts, extensions/codecarto/*.ts (strip-types)
```

- **Stable base.** `core/types.ts` + `core/utils.ts` + `core/yaml.ts` depend on nothing inside the repo. `core/yaml.ts` is the load-bearing bottom of the stack: every persisted YAML file (status, handoffs, pipelines, config, usage, library metadata, broadside config) is parsed and serialized by the hand-rolled parser, not by a YAML library `[fact: core/yaml.ts:1-3, package.json dependencies has only the MCP SDK]`.
- **No import cycles inside `core/`** `[inference from reading every import line of the 19 modules]`. `workspace.ts` imports `status.ts`; `status.ts` does not import `workspace.ts`. `prompts.ts` imports `completion.ts` only for `countPendingProposals`; `completion.ts` does not import `prompts.ts`.
- **Two boundary breaches the CLAUDE.md contract does not describe.** (a) The MCP server imports `writeDashboard` from `extensions/codecarto/dashboard-writer.ts` `[fact: mcp-server/server.ts:105]`, so the MCP shell depends on the Pi shell's directory. It works because `dist/**` and `dist/extensions` are shipped `[fact: package.json files, pi.extensions]`, but the module is core-shaped (I/O wrapper around `core/dashboard.ts`, no Pi imports `[fact: extensions/codecarto/dashboard-writer.ts:6-21]`). (b) Both wrappers import four core modules directly, bypassing the barrel that `core/index.ts:1-3` says is the exclusive entry `[fact: mcp-server/server.ts:101-104; extensions/codecarto/index.ts:93-94]`. Routed to `porting` as `arch-CF2`.
- **Wrappers around shared internals.** `mcp-server/server.ts` is almost entirely argument validation + `textResult()` framing around core calls; `extensions/codecarto/index.ts` is the same plus TUI state. The only wrapper-owned logic of substance is the Pi sub-agent lifecycle (`agent-runner.ts`, `auto-runner.ts`) and the two one-shot LLM helpers (`agent-rewriter.ts`, `dashboard-narrator.ts`).
- **Third-party SDKs as shaping forces**, not architecture: the MCP SDK dictates the `content`/`structuredContent` result shape (`textResult` carries text in both because some clients read only one `[fact: mcp-server/server.ts:149-160]`); the Pi SDK dictates ctx invalidation after a session swap, which shapes `notify.ts`, `isCtxLive`, and the captured-`cwd` pattern throughout `auto-runner.ts` `[external: extensions/codecarto/notify.ts:6-14]`; OpenRouter dictates batch key ordering and `:batch` model ids `[external: core/broadside.ts:2044-2050]`.

## Public Surfaces

Catalog-level detail (every tool schema, every command, every file format) is in `findings/public-surfaces/public-surfaces.md` §2026-09-11. Summary and the claims later phases will cite:

- **Binary.** One: `codecarto-mcp` → `dist/mcp-server/bin.mjs` `[fact: package.json bin]`. It only works from `dist/` `[fact: mcp-server/bin.mjs:2-4]`.
- **MCP tools.** 22, all taking an absolute `cwd` except `codecarto_guide`, `codecarto_library_*`, `codecarto_config`, and `codecarto_publish` (which accept `library_path` or `cwd`) `[fact: mcp-server/server.ts:1301-1670]`. Prompt-returning tools (`next`, `phase`, `skill`, `vision`, `guide`) return text the host must execute; nothing in the server runs a model.
- **Pi slash commands.** 20 `codecarto-*` commands `[fact: grep]`. 18 map 1:1 onto MCP tools; `codecarto_library_list` and `codecarto_library_reindex` have no Pi command `[fact: extensions/codecarto/guide-framing.ts:26]`; `/codecarto-vision` and `/codecarto-guide` exist on both but queue text into the session on Pi rather than returning it.
- **Exported library.** `dist/core/index.js` and the two wrapper entrypoints are consumed by `scripts/` `[fact: scripts/create-synthesis-demo.mjs:8-9]`; there is no `exports` map in `package.json`, so every path under `dist/` is reachable `[fact: package.json]`.
- **Network/RPC.** Inbound: MCP JSON-RPC over stdio only. Outbound: OpenRouter `/api/beta/batches`, `/api/v1/models`, `/api/v1/benchmarks` from `core/broadside.ts` only `[fact: core/broadside.ts:49,69-70]`; `git` subprocesses from `core/library.ts:1330` and `core/broadside.ts:1190-1231`.
- **File formats and persistent artifacts (ABI).** `workflow/status.yaml` (schema_version 1), `scratch/handoffs/<phase>.yaml` (schema_version 1), `scratch/amendments/<slug>.yaml`, the phase output markdown contract (`## Validation` table + `**Overall:**` line + `## Coverage and limits` ledger + findings tables with `Evidence Level`/`Action` columns), the library on-disk format (`.codecarto-library` JSON marker, `entries/[ns/]slug/vN/{reimplementation-spec.md,metadata.yaml}`, `latest` pointer file, `index.yaml`, `INDEX.md`), `workflow/.usage.local.yaml`, `broadside/state.json` + per-run dirs, `dashboard.html`. Full inventory in `findings/state-and-storage/state-and-storage.md`.
- **User-facing workflows.** The drive loop (status → next → execute → handoff → validate → complete), `--auto` on Pi, publish → synthesis across a library, Broad-Side submit → collect.

## Runtime Lifecycle

Full sequences in `findings/runtime-lifecycle/runtime-lifecycle.md` §2026-09-11.

**MCP server** `[fact]`: `bin.mjs` → `startStdioServer()` → `buildServer()` registers `ListTools` and `CallTool` handlers and connects `StdioServerTransport` `[fact: mcp-server/server.ts:1711-1742]`. Every tool call is stateless: `validateCwd` → `getWorkspaceState(cwd)` re-reads `status.yaml`, the pipeline YAML, and `scaffold-version.yaml` from disk `[fact: core/workspace.ts:70-109]` → handler → `textResult`. There is no in-process cache, no session, and no shutdown hook; the process ends when the host closes stdio. Errors are normalized to `McpError` (`InvalidParams`, `InvalidRequest`, `InternalError`) `[fact: mcp-server/server.ts:1719-1733]`.

**Pi extension** `[fact]`: module load runs `codeCartographerExtension(pi)`, which first installs `phaseCompactionExtension` (tool guard + compaction hooks) `[fact: extensions/codecarto/index.ts:347-348]`. `session_start` resets `codecartoModeActive=false`; only `/codecarto-init` or `/codecarto-open` sets it true and narrows the tool set to `SAFE_TOOL_NAMES` `[fact: index.ts:101,466,585]`. While active, the `tool_call` hook blocks `bash` and confines `edit`/`write` to `.codecarto/` plus the configured library `[fact: index.ts:422-452]`. `/codecarto-next` builds the prompt, optionally rewrites it through a one-shot LLM session, then `runPhase` creates a file-backed `AgentSession` with only read/edit/write/grep/find/ls `[fact: agent-runner.ts:34,167-176]`, prompts it, and if the primary output is still absent or the transcript ended mid-tool-call sends one continuation prompt `[fact: agent-runner.ts:267-274]`. After the sub-agent returns, the one-shot path auto-validates and auto-completes `[fact: index.ts:761-811]`; `--auto` loops the same in `runAuto` and stops on FAIL/MISSING, error, abort, or (with `--strict`) PASS WITH GAPS `[fact: auto-runner.ts:282-312]`. `session_shutdown` disposes the agents widget timer `[fact: index.ts:412-416]`.

**Completion (both surfaces)** `[fact: core/completion.ts:317-514]`: load handoff → refuse if absent and the phase declares `handoff_requirements` → validate carry-forward targets, post_pipeline ids, `derives_from` closures, runtime-evidence closures → acquire `status.yaml.lock` → **re-validate the output under the lock** → merge PARTIAL rows as auto-generated `needs-maintainer-decision` questions → apply handoff → recompute `current_phase`/`next_actions` → write closeout, THREAD_LOG entry, DECISIONS rows, CONVENTIONS proposals → atomic temp+rename of status.yaml → release lock. Then each wrapper appends a usage receipt and re-renders the dashboard best-effort.

**Background / scheduled work.** None in the MCP server. Pi: an 80 ms `setInterval` drives the agents widget while a phase runs and unregisters itself when idle `[fact: agent-widget.ts:19-23,78-80]`; a 30 s `setTimeout` clears finished phase activity `[fact: auto-runner.ts:201-203]`. Broad-Side polls OpenRouter every 15 s for up to 25 min by default `[fact: core/broadside.ts:85-86]`.

## Concurrency Model

- **Threading.** Single Node event loop, async/await throughout; no worker threads, no child-process parallelism except short-lived `git` calls `[fact]`. Pi phase sub-agents run in the same process as the orchestrator TUI `[fact: agent-runner.ts:1-6]`.
- **Shared mutable state and its guards.**
  - `status.yaml`: every writer (`updateStatusAtomically`, `switchPipeline`) takes `status.yaml.lock` via `open(..., "wx")`, retries every 125 ms, times out at 5 s, and breaks a lock older than 60 s by mtime `[fact: core/status.ts:22-24,408-449]`; writes are temp-file + `rename` `[fact: core/workspace.ts:367-370]`. Completion re-validates under the lock precisely because the caller's validation may be stale `[fact: core/completion.ts:440-456]`.
  - `broadside/state.json`: same lock primitive on `state.json.lock`, held only for read-modify-write; `persistBroadsideRun` merges by run id because a wholesale save lost a concurrent submit in a live run `[fact: core/broadside.ts:1696-1741]`.
  - `workflow/.usage.local.yaml`: **unlocked** read-modify-write with temp+rename; the module comment declares this "safe enough" because phases run sequentially `[fact: core/usage.ts:6-9]`. Both wrappers append after completion; the MCP path appends a zero-token receipt `[fact: mcp-server/server.ts:413-428]`. Routed to `defect-scan-semantic` as `arch-CF4`.
  - Library writes: staging dir + `rename` for new versions; `latest`, `index.yaml`, `INDEX.md`, `metadata.yaml` via temp+rename; **no lock** across publish/reindex `[fact: core/library.ts:693-716,1206-1211]`.
  - `dashboard.html`, narration cache, checkpoints: temp+rename, no lock, best-effort.
  - Pi in-memory: `agent-state.ts` module-scoped `Map` is the re-entry guard (`isPhaseRunning`) `[fact: agent-state.ts:27; auto-runner.ts:211-214]`; `lastFeedbackLines`, `codecartoModeActive`, `sessionCwd` are closure variables in the extension factory `[fact: index.ts:349-353]`.
- **Backpressure / rate limiting.** None on the framework side. Broad-Side has a cost pre-flight (`max_cost`) and a shared poll deadline across lenses, retries, and post-passes `[fact: core/broadside.ts:2302-2340,2713-2717,2785-2793]`.
- **Performance-critical paths.** `getWorkspaceState` is called on every MCP tool call and re-parses the pipeline YAML each time `[fact: core/workspace.ts:70-109]`; `buildOrchestratorDuties` reads every completed phase's primary output to collect coverage gaps on every `codecarto_next` `[fact: core/prompts.ts:75; core/coverage.ts:133-152]`. Neither is a bottleneck at the file sizes involved `[inference]`.
- **Portability hazards** `[hazard]`: (1) the `wx` lock assumes O_EXCL semantics and mtime-based staleness — fine on local POSIX/NTFS, unreliable on network filesystems; (2) `rename` atomicity over an existing target is POSIX behavior, Windows semantics differ for open files; (3) temp names embed `process.pid` + `Date.now()`, so two writers in one process in the same millisecond collide `[fact: core/workspace.ts:368]`; (4) `realpath` is used for containment checks and falls back to lexical comparison when the path does not exist yet `[fact: core/utils.ts:57-68]`; (5) the Pi surface's correctness depends on the SDK invalidating a ctx after a sub-agent replaces the session, an `[external]` behavior the code defends against everywhere via `isCtxLive`.

## Build and Packaging

Details in `findings/build-and-deploy/build-and-deploy.md` §2026-09-11.

- **Build.** `tsc` only, `target ES2022`, `module NodeNext`, `strict: false`, `noEmitOnError: false`, sources import each other with explicit `.ts` and `rewriteRelativeImportExtensions` rewrites them to `.js` in `dist/` `[fact: tsconfig.json]`. Tests never build: `node --test` with `--experimental-strip-types` loads `.ts` directly `[fact: package.json scripts.test]`.
- **Artifact.** One npm package `codecartographer-pi` containing `dist/**`, the `.codecarto/` template minus this repo's own state files, `agent-skill/**`, `README.md`, `LICENSE`, `assets/logo.svg` `[fact: package.json files]`. Runtime dependency: `@modelcontextprotocol/sdk` only; `@earendil-works/pi-coding-agent` and `@sinclair/typebox` are peer deps supplied by Pi `[fact: package.json]`. `overrides.undici` pins a transitive dep `[fact]`.
- **CI.** `ci.yml` on PR and push to `main`: Node 22 and 24, `npm ci`, `npm audit --omit=dev --audit-level=high`, `npm run build`, `npm test` `[fact: .github/workflows/ci.yml]`. `smoke.yml` nightly at 06:17 UTC installs the published package into a temp dir and drives the bin over the MCP SDK client (9 TAP steps) `[fact: .github/workflows/smoke.yml; scripts/smoke-mcp.mjs:88-110,150-228]`.
- **Release.** Tag-driven `release.yml`: asserts tag == `package.json` version, tests, builds, packs, smoke-tests the tarball, verifies `NPM_TOKEN`, publishes with `--provenance` (idempotent), publishes to the MCP Registry via GitHub OIDC (idempotent), creates a GitHub release with notes extracted from `CHANGELOG.md` `[fact: .github/workflows/release.yml]`. `server.json` carries the registry listing at 0.19.5 `[fact]`.
- **Version is read at runtime** from the installed `package.json` (`PACKAGE_VERSION`) and compared against `workflow/scaffold-version.yaml` to warn about stale scaffolds `[fact: core/workspace.ts:42-49,324-340]`.

## Porting Priorities

| Component | Priority | Rationale |
|---|---|---|
| `core/yaml.ts` parser/serializer | core | Every persisted file goes through it; a port that swaps in a real YAML library must reproduce its quirks (block-scalar folding, `__proto__` guard, duplicate-key rejection, JSON-quoted string emission) or migrate the on-disk files `[hazard]` |
| `core/status.ts` + `core/workspace.ts` (normalize, lock, atomic write, handoff apply) | core | Canonical state; the lock/rename discipline is the concurrency model |
| `core/pipeline.ts` (DAG walk, validation parse) | core | Defines "next phase" and "PASS"; the markdown parse (`lastIndexOf("## Validation")`, `**Overall:**` regex) is the completion gate's contract with the LLM `[fact: core/pipeline.ts:115,151]` |
| `core/completion.ts` | core | All closure-integrity rules (D1/D3), auto-generated PARTIAL questions, closeout/THREAD_LOG/DECISIONS/CONVENTIONS writes |
| `core/prompts.ts` + `core/coverage.ts` + `core/findings.ts` | core | The prompt text is the product's behavior; cross-checks gate validation on current scaffolds |
| `.codecarto/` template contents | core (data) | ABI for every existing workspace; must be copied byte-for-byte |
| `mcp-server/server.ts` | important | The interoperable surface; 22 tools, argument validation, `textResult` dual payload |
| `core/library.ts` | important | On-disk format is ABI; collision, confidentiality, and provenance guards are behavior users rely on |
| `core/amendment.ts`, `core/orchestrator-config.ts`, `core/usage.ts` | important | Post-pipeline channel, config precedence, telemetry format |
| `core/synthesis.ts` | important | Preflight for the synthesis pipeline (Pi/MCP only) |
| `extensions/codecarto/*` sub-agent runner, auto loop, hooks | important (Pi parity) / optional (other hosts) | Only meaningful on a host with an in-process agent SDK; the guards (`bash` block, path confinement) are the security posture of that surface |
| `core/dashboard.ts` + `dashboard-writer.ts` | optional | Self-contained HTML; no downstream consumer |
| `core/broadside.ts` | optional | Vendor-specific (OpenRouter batch), money-spending, isolated behind two entrypoints |
| `agent-rewriter.ts`, `dashboard-narrator.ts`, `agent-widget.ts`, `child-model-runtime.ts` | incidental | Pi-TUI ergonomics and opt-in LLM extras |
| `scripts/`, demo builders | incidental | Release tooling |

## Durable State

Inventory with paths, owners, and lifecycles in `findings/state-and-storage/state-and-storage.md` §2026-09-11; configuration keys and precedence in `findings/config-model/config-model.md` §2026-09-11. Summary `[fact]`:

- **Workspace state** under `<repo>/.codecarto/`: `workflow/status.yaml` (canonical, locked), `workflow/scaffold-version.yaml`, `workflow/config.yaml`, `workflow/.usage.local.yaml`, `scratch/handoffs/*.yaml`, `scratch/checkpoints/*.md`, `scratch/amendments/*.yaml`, `findings/**/*.md`, `closeouts/*.md`, `THREAD_LOG.md`, `CONVENTIONS.md`, `DECISIONS.md`, `BACKLOG.md`, `dashboard.html`, `.dashboard-narration.local.md`, `broadside/{config.yaml,state.json,model-catalog.json,<run-id>/}`.
- **User-global**: `~/.codecarto/config.yaml` (overridable via `CODECARTO_USER_CONFIG_PATH`) `[fact: core/orchestrator-config.ts:56-68]`.
- **Library** at `library.path`: marker, entries tree, `latest` pointers, `index.yaml`, `INDEX.md`, optional git commits (never pushes) `[fact: core/library.ts:1289-1322]`.
- **Environment variables**: `OPENROUTER_API_KEY` (Broad-Side), `CODECARTO_USER_CONFIG_PATH` (tests/tooling) `[fact: mcp-server/server.ts:1162; core/orchestrator-config.ts:67]`.
- **Auth material**: the OpenRouter key may also live in `.codecarto/broadside/config.yaml` (`api_key`) or be passed as an MCP parameter; the Pi command deliberately has no key argument `[fact: extensions/codecarto/index.ts:186-194]`.
- **Pi-side**: phase transcripts persisted to `~/.pi/agent/sessions/<encoded-cwd>/` and tagged with the orchestrator session as parent `[fact: agent-runner.ts:150-165]`; `auth.json`/`models.json` under the Pi agent dir are read by `createChildModelRuntime` `[fact: child-model-runtime.ts:31-34]`.
- **Locks**: `status.yaml.lock`, `broadside/state.json.lock` — regular files, removed on release, broken after 60 s.

## Coverage and limits

- Inspected scope: every file under `core/` (19 modules, read in full), `mcp-server/` (both files, read in full), `extensions/codecarto/` (all 16 files, read in full), `scripts/` (all four, `smoke-mcp.mjs` and `smoke-broadside.mjs` in full, the two demo builders' headers), `.github/workflows/` (all three), `package.json`, `tsconfig.json`, `server.json`, `.gitignore`, `.codecarto/.gitignore`, `README.md` head, `agent-skill/` overview + two references (via `codecarto_guide`).
- Skipped scope: `tests/` was inventoried (52 files, 639 `test(` calls, 13,217 lines) but not read; test contents are deferred to the defect scans where they serve as evidence. `docs/` was not read beyond `self-review-prompt.md` and the README. `CHANGELOG.md`, `CONTRIBUTING.md`, `MANUAL.md`, `ROADMAP.md` not read. `.codecarto/` template content (skills, templates, pipelines other than the active one) not reviewed — out of scope by the run's definition. No `node_modules`/SDK source read, so every claim about Pi SDK or MCP SDK behavior is `[external]`.
- Evidence basis: source inspection; command output for line and symbol counts. No runtime verification, no tests executed.
- Known blind spots: (1) Pi SDK semantics (ctx invalidation, `session.prompt` continuation, `compact()`, `ModelRuntime.registerProvider`) are taken from the code's own comments and are unverified here. (2) OpenRouter batch API response shapes are taken from the code's parsing and are unverified. (3) `core/broadside.ts` lines 1100–3261 were read once for structure; its many branch conditions were not traced exhaustively and are left to the defect scans. (4) Whether `dist/` layout actually matches the `extensions/codecarto/dashboard-writer.ts` import from `mcp-server/` at runtime is inferred from `package.json` `files` and `tsconfig` `rootDir`, not from a build.
- Coverage disposition: COMPLETE for the structural map; the blind spots above are inherited by later phases rather than gaps in this phase's own criteria.

## Open Questions

None registered this phase. The `[external]` items above are candidate runtime questions but each is either already covered by the repo's tests (to be confirmed by the defect scans, which read `tests/`) or belongs to a later phase's rubric; registering them now would only add re-triage load without evidence.

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| — | — | — | — |

## Carry-Forward

Mirrored in `scratch/handoffs/architecture.yaml`.

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| arch-CF1 | protocols | The 22 MCP tool input schemas, the `textResult` dual payload, the status.yaml / handoff / amendment / library / broadside persisted schemas, and the validation-block and coverage-ledger markdown grammars are listed by name here; exact shapes, versioning, and compatibility hazards are not extracted. | Wire-format and persisted-schema extraction is the protocols rubric. |
| arch-CF2 | porting | `mcp-server/server.ts:105` imports `extensions/codecarto/dashboard-writer.ts`, and both wrappers import `core/{amendment,usage,library,orchestrator-config}.ts` directly instead of through `core/index.ts`, contradicting the documented "barrel is the exclusive entry" boundary. | Whether a port must preserve or repair this boundary is a porting-synthesis decision; not a defect by itself. |
| arch-CF3 | contracts | 20 Pi commands and 22 MCP tools enumerated by name with their headline behavior; per-command defaults, side effects (which files are written), error text, and recovery behavior are not recorded. | Feature-contract extraction is the contracts rubric. |
| arch-CF4 | defect-scan-semantic | `core/usage.ts` performs an unlocked read-modify-write of `workflow/.usage.local.yaml`; both wrappers append after completion, and the Pi one-shot path's post-phase work is fire-and-forget. The module comment asserts sequential phases make this safe. | Concurrency hazards are pass 3 of the semantic scan; needs contracts/protocols context to judge whether two writers can actually interleave. |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | The system intent is documented. | PASS | §System Intent: state machine not agent, three surfaces, two adjacent subsystems, audience. |
| 2 | The layer map and dependency direction are documented. | PASS | §Layer Map → Package Inventory (23 rows with line counts) and §Dependency Direction (graph, stable base, no-cycle claim, two boundary breaches with file:line). |
| 3 | Public surfaces are identified. | PASS | §Public Surfaces: binary, 22 MCP tools, 20 Pi commands, exported library, network endpoints, file-format ABI, workflows; catalog in `findings/public-surfaces/public-surfaces.md`. Schemas deferred via `arch-CF1`. |
| 4 | Runtime lifecycle, concurrency model, and porting priorities are summarized. | PASS | §Runtime Lifecycle (MCP, Pi, completion, background work), §Concurrency Model (guards per state file, hazards), §Porting Priorities (15-row table). |
| 5 | Findings are marked with evidence levels. | PASS | Every claim carries `[fact]`, `[inference]`, `[external]`, `[hazard]`, or `[open]`; legend at the top. |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits, all five bullets filled; `tests/` and `docs/` named as skipped. |

**Validated by:** 2026-09-11 (architecture phase, self-audit session 1, inline MCP host)
**Overall:** PASS
