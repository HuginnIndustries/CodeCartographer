# Public Surfaces

Catalog-level detail accumulated across phases (`mode: append`). The architecture map owns the summary and the claims downstream phases cite; this file owns the enumerated inventory.

## 2026-09-11 — architecture

All entries `observed fact` from source unless marked.

### Binaries

| Name | Source | Notes |
|---|---|---|
| `codecarto-mcp` | `package.json` `bin` → `dist/mcp-server/bin.mjs` | Imports `./server.js`; fails when run from the source tree (`mcp-server/bin.mjs:2-4`). Starts `StdioServerTransport`; exits non-zero on startup error. |

### MCP tools (22)

Registered in `TOOLS` (`mcp-server/server.ts:1301-1670`); dispatched via `HANDLERS` (`:1672-1695`). Every result is `textResult(text, structured)` carrying the same `text` in both `content[0].text` and `structuredContent.text` (`:155-160`).

| Tool | Required args | Optional args | Returns | Writes |
|---|---|---|---|---|
| `codecarto_init` | `cwd` | `pipeline`, `force` | init summary | `.codecarto/` (copy of template), `workflow/status.yaml`, seeds CONVENTIONS/DECISIONS/BACKLOG/THREAD_LOG; `force` renames existing dir to `.codecarto-backup-<ts>/` |
| `codecarto_switch_pipeline` | `cwd`, `pipeline` | — | switch summary (carried/new/dropped) | `status.yaml` under lock |
| `codecarto_status` | `cwd` | — | phase, progress, counts, every `next_actions` line, scaffold notice | none |
| `codecarto_next` | `cwd` | — | phase prompt text, or "all complete" | none |
| `codecarto_phase` | `cwd`, `phase` | — | forced phase prompt | none |
| `codecarto_validate` | `cwd` | `phase` | validation summary + rows/gaps/errors/secondaryOutputs | none |
| `codecarto_complete` | `cwd` | `phase` | completion summary, next phase, closeout path, orchestrator checkpoint, NOTE lines | `status.yaml`, closeout, THREAD_LOG, DECISIONS, CONVENTIONS, `.usage.local.yaml` receipt, `dashboard.html` |
| `codecarto_skill` | `cwd`, `name` | — | skill prompt; `broadside` is served ungated | none |
| `codecarto_publish` | `source_repo`, `headline` | `library_path`/`cwd`, `spec`/`spec_path`, `slug`, `namespace`, `source_commit`, `source_branch`, `source_dirty`, `analyzed_at`, `pipeline`, `tags`, `capabilities`, `confidentiality`, `model_metadata`, `force_new_version`, `allow_source_repo_change`, `allow_confidentiality_mismatch`, `confirm` | publish result or a `publish_confirm` refusal preview | library entry dir, `latest`, `index.yaml`, `INDEX.md` |
| `codecarto_library_list` | — | `library_path`/`cwd`, `namespace`, `tag`, `slug`, `source_repo` | entry list + provenance conflicts | none (may reindex if index missing) |
| `codecarto_library_reindex` | — | `library_path`/`cwd` | index summary + conflicts | `index.yaml`, `INDEX.md` |
| `codecarto_vision` | `cwd`, `raw_text` | — | interview prompt embedding `raw_text` | none |
| `codecarto_library_init` | `library_path` | `name`, `namespace` | init result | `.codecarto-library` marker; **user-global** `~/.codecarto/config.yaml` |
| `codecarto_config` | — | `cwd` | effective config + marker status | none |
| `codecarto_open` | `cwd` | — | pipeline label + current phase | none |
| `codecarto_usage` | `cwd` | — | totals, per-phase, receipt note | none |
| `codecarto_dashboard` | `cwd` | — | path | `dashboard.html` |
| `codecarto_guide` | — | `topic` | guide markdown + topic footer | none |
| `codecarto_list_skills` | `cwd` | — | skill names + broadside note | none |
| `codecarto_amend` | `cwd`, `name` | — | closures applied/unknown, closeout path | `status.yaml`, amendment closeout, THREAD_LOG, `dashboard.html` |
| `codecarto_refresh_scaffold` | `cwd` | — | files written, version transition | every framework-owned file under `.codecarto/`, THREAD_LOG entry |
| `codecarto_broadside` | `cwd`, `action` | `lenses`, `api_key`, `wait_seconds`, `include_synthesis`, `include_triage`, `retry_truncated`, `max_cost`, `force`, `incremental`, `include_benchmarks` | per-action text | `broadside/state.json`, `broadside/<run>/`, `broadside/model-catalog.json`; **spends money on submit/collect** |

Error codes: `InvalidParams` for bad arguments and validation errors, `InvalidRequest` for state/gate refusals, `InternalError` for anything else (`mcp-server/server.ts:1719-1733`).

### Pi slash commands (20)

`extensions/codecarto/index.ts`. Commands marked ★ require `codecartoModeActive` (set by init/open); the rest work without a workspace.

| Command | Args | MCP equivalent | Notes |
|---|---|---|---|
| `/codecarto-open` | — | `codecarto_open` | Activates mode, narrows tools to `SAFE_TOOL_NAMES` |
| `/codecarto-vision` | — | `codecarto_vision` | Queues the interview skill as a user message |
| `/codecarto-init` | `[pipeline]` | `codecarto_init` | Confirms before backing up an existing workspace; renders initial dashboard |
| `/codecarto-status` ★ | — | `codecarto_status` | Widget + notify |
| `/codecarto-switch-pipeline` ★ | `<variant>` | `codecarto_switch_pipeline` | |
| `/codecarto-next` ★ | `--auto`, `--strict`, `--llm-steer`, `--no-llm-steer` | `codecarto_next` (partial) | Executes the phase as a sub-agent, then auto-validates and auto-completes; MCP only returns the prompt |
| `/codecarto-phase` ★ | `<phase>` | `codecarto_phase` | Queues the prompt as a user message (does not spawn a sub-agent) |
| `/codecarto-validate` ★ | `[phase]` | `codecarto_validate` | |
| `/codecarto-complete` ★ | `[phase]` | `codecarto_complete` | |
| `/codecarto-skill` | `<name>` | `codecarto_skill` | `broadside` ungated; others ★ and pipeline-complete gated |
| `/codecarto-list-skills` ★ | — | `codecarto_list_skills` | |
| `/codecarto-guide` | `[topic]` | `codecarto_guide` | Wraps the document in a Pi-specific preamble/addendum (`guide-framing.ts`) |
| `/codecarto-broadside` | `[action] [lenses…] [flags]` | `codecarto_broadside` | Asks for spend confirmation instead of refusing over `max_cost`; no key argument |
| `/codecarto-publish` ★ | — | `codecarto_publish` | Derives slug/headline/source_repo itself; asks on collision and confidentiality mismatch |
| `/codecarto-library-init` | `<path> [--namespace <n>]` | `codecarto_library_init` | |
| `/codecarto-config` | — | `codecarto_config` | |
| `/codecarto-usage` ★ | — | `codecarto_usage` | |
| `/codecarto-dashboard` ★ | `[--narrate]` | `codecarto_dashboard` | `--narrate` runs a one-shot LLM narrator |
| `/codecarto-refresh-scaffold` ★ | — | `codecarto_refresh_scaffold` | Previews file set and confirms first |
| `/codecarto-amend` ★ | `<name>` | `codecarto_amend` | Previews and confirms first |

No Pi command for `codecarto_library_list` or `codecarto_library_reindex` (`guide-framing.ts:26`).

### Pi event hooks

`session_start`, `session_shutdown`, `agent_end`, `tool_call` in `index.ts:405-452`; `tool_call`, `session_before_compact`, `session_compact` in `phase-compaction.ts:68-135` (installed in both the parent and every phase child session).

### Exported code

No `exports` map in `package.json`; every file under `dist/` is importable. Known consumers: `scripts/create-synthesis-demo.mjs` (`dist/core/index.js`, `dist/mcp-server/server.js`), `scripts/build-demo-dashboard.mjs` (`dist/extensions/codecarto/dashboard-writer.js`, `dist/core/workspace.js`), `tests/*.mjs` (source `.ts` via strip-types). `core/index.ts` re-exports all 19 core modules.

### Network

Outbound only, all in `core/broadside.ts`: `POST https://openrouter.ai/api/beta/batches`, `GET …/batches/<id>`, `GET https://openrouter.ai/api/v1/models`, `GET https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding`. All with `AbortSignal.timeout(30_000)` and `Authorization: Bearer <key>`. Inbound: MCP over stdio only.

### Subprocesses

`git` via `spawn` in `core/library.ts:1330-1344` (`rev-parse --show-toplevel`, `remote get-url`, `symbolic-ref`, `config --get`, `add`, `status --porcelain`, `commit`) and via `execFile` in `core/broadside.ts:1190-1231` (`ls-tree`, `rev-parse HEAD`, `status --porcelain`, `diff --name-only`).

### File-format ABI (names only; shapes in protocols phase)

`workflow/status.yaml`, `workflow/pipeline*.yaml`, `workflow/scaffold-version.yaml`, `workflow/config.yaml`, `~/.codecarto/config.yaml`, `scratch/handoffs/<phase>.yaml`, `scratch/amendments/<slug>.yaml`, `scratch/checkpoints/<phase>.md`, phase output markdown (validation block, coverage ledger, findings tables), `closeouts/<date>-<phase>.md`, `THREAD_LOG.md` entry line, `DECISIONS.md` `D<NNN> |` rows, `CONVENTIONS.md` `## Pending proposals` bullets, `workflow/.usage.local.yaml`, `dashboard.html` + `<script id="cc-dashboard-data">` JSON island, `.dashboard-narration.local.md` frontmatter, library marker/metadata/index/INDEX/latest, `broadside/config.yaml`, `broadside/state.json`, `broadside/model-catalog.json`, `broadside/<run>/{requests.json,raw-<lens>.json,<custom_id>.json,<custom_id>.md,*.error.json,synthesis.*,triage.*,run-meta.json}`.

## 2026-09-11 — contracts

### Surface parity: MCP tool vs Pi command

`observed fact` from `mcp-server/server.ts` and `extensions/codecarto/index.ts`; test citations where a test pins the row.

| Operation | Deliberate divergence | Accidental divergence |
|---|---|---|
| next | MCP returns the prompt; Pi executes the phase as a sub-agent, then auto-validates and auto-completes (`tests/pi-command-handlers.test.mjs:212-232`) | — |
| phase / skill / guide / vision | MCP returns text; Pi injects it as a user message (follow-up when busy) | — |
| init | MCP `force`; Pi confirm dialog | both reset `status.yaml` without backup when the target is the packaged template (mech 6.7) |
| switch_pipeline | — | Pi re-renders the dashboard (`index.ts:645`); MCP does not (`server.ts:316-341`) |
| complete | identical core path (`tests/framework-handoff.test.mjs:366-402`); MCP adds a usage receipt | — |
| refresh_scaffold / amend | Pi previews and asks; MCP applies on call (`tests/pi-parity-commands.test.mjs`) | — |
| publish | MCP takes every field; Pi derives source_repo/slug/headline and asks on the two guards; `publish_confirm` on MCP is a refusal needing `confirm: true` | library-init on both surfaces flips the MCP gate on by writing `publish_confirm: true` (mech 6.6) |
| library_init | MCP requires an absolute path; Pi resolves relative paths and expands `~` by hand | `~user/x` mis-expands on Pi (mech 6.14) |
| library_list / library_reindex | MCP only (`guide-framing.ts:26`) | — |
| config | MCP: `cwd` optional; Pi: always the session cwd | Pi warns "not active" before init and still reports |
| broadside | Pi asks about spend; MCP refuses over `max_cost` unless `force`; Pi takes no key argument | `wait_seconds: 0` → 25-minute collect on both (mech 6.3) |
| status / usage / dashboard / list_skills / open | identical text modulo Pi widget rendering (Pi widget shows only `next_actions[0]`) | — |

## 2026-09-11 — protocols

### MCP result `structuredContent` keys per tool (`observed fact`, `mcp-server/server.ts`)

| Tool | structuredContent keys (plus `text` always) |
|---|---|
| init | `workspaceDir`, `pipeline`, `pipelineLabel`, `firstPhase`, `seededOrchestratorFiles[]` |
| status | `scaffoldNotice?`, `currentPhase`, `pipeline`, `pipelineLabel`, `completed`, `total`, `openQuestionsCurrentPhase`, `openQuestionsTerminal`, `carryForwardTotal`, `postPipelinePending`, `nextActions[]` |
| switch_pipeline | `pipeline`, `carried[]`, `newPhases[]`, `dropped[]` |
| next / phase | `phase`, `forced` (or `complete: true`) |
| validate | `phaseId`, `overall`, `exists`, `hasValidationBlock`, `primaryOutput`, `rows[]`, `gaps[]`, `errors[]`, `secondaryOutputs[]` |
| complete | `completedPhase`, `validation`, `nextPhase`, `closeoutNotice`, `orchestratorCheckpoint`, `dashboardPath`, `warnings[]` |
| skill | `skill` (+ `path`, `postPipeline: false` for broadside) |
| publish | `libraryPath`, `slug`, `namespace`, `version`, `isNewVersion`, `versionDir`; refusal `data`: `refused: "publish_confirm"`, preview fields |
| library_list | `libraryPath`, `libraryName`, `namespaced`, `count`, `entries[]`, `provenance_conflicts[]` |
| library_reindex | `libraryPath`, `libraryName`, `entry_count`, `namespaces[]`, `provenance_conflicts[]` |
| library_init | `libraryPath`, `markerName`, `namespaced`, `alreadyExisted`, `configPath` |
| vision | `cwd`, `visionPath`, `interviewPath`, `note` |
| config | `libraryPath`, `libraryNamespace`, `publishConfirm`, `llmSteerNextPhase`, `userConfigPath`, `workspaceConfigPath` |
| open | `pipeline`, `currentPhase` |
| usage | `runs`, `receiptRuns`, `tokens{}`, `toolUses`, `durationMs`, `perPhase{}` |
| dashboard | `path` |
| guide | `topic`, `topics[]` |
| list_skills | `skills[]`, `broadside` |
| amend | `openQuestionsClosed[]`, `postPipelineClosed[]`, `unknownIds[]`, `closeoutNotice`, `dashboardPath` |
| refresh_scaffold | `written[]`, `scaffoldVersionBefore?`, `scaffoldVersionAfter` |
| broadside status / models / submit / collect | `state` / `models[]`, `defaultModel`, `benchmarkMeta` / `runId`, `outputDir`, `batches{}`, `estimatedTotalCost`, `pricing`, `maxCost` / `runId`, `status`, `totalCost`, `resultCount`, `truncatedCount`, `retriedCount`, `lensOutcomes{}`, `synthesis`, `triage`, `topFindings[]`, `topTriageItems[]` |

## 2026-09-11 — porting

Port priority per surface (`strong inference` from the feature contract table in `findings/porting/reverse-engineering-bundle.md`): the MCP shell is the interoperable surface and its 22 tools are the port's first adapter; the Pi shell's sub-agent runner, sandbox, and auto loop are Pi-parity work (important on Pi, optional elsewhere); its widgets, steering, and narrator are incidental. `codecarto_library_list`/`_reindex` stay MCP-only unless the port adds them to the second shell. Every prose-returning tool keeps the dual `content`/`structuredContent` payload.
