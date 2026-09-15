# Public Surfaces

> Secondary output (mode: append). Owns the catalog-level inventory of every boundary the
> outside world touches. The architecture map (`findings/architecture/architecture-map.md`)
> owns the summary and the load-bearing claims. Add a new dated section per phase; never
> rewrite earlier sections.

## 2026-09-14 — architecture phase

### 1. Binaries and executables

| Binary | Source | Runtime | Notes |
|---|---|---|---|
| `codecarto-mcp` | `dist/mcp-server/bin.mjs` (built from `mcp-server/bin.mjs` + `mcp-server/server.ts`) | Node `>=20`, stdio | The only `bin` entry (`package.json`). Starts the MCP stdio server. |
| Pi extension | `dist/extensions/codecarto/index.ts` (built from `extensions/codecarto/index.ts`) | Pi TUI process | Registered via `package.json` `pi.extensions`; source runnable with `pi -e …/index.ts`. No standalone bin. |

There are **no CLI subcommands** beyond the MCP server itself; all user interaction is through
Pi slash commands or MCP tool calls (`observed fact`).

### 2. MCP tools (stdio JSON-RPC)

`observed fact`: `mcp-server/server.ts` `TOOLS` array and `HANDLERS` map. Every tool takes an
absolute `cwd` (validated: must be absolute and exist) unless noted.

| Tool | Required args | Optional args | Surface effect |
|---|---|---|---|
| `codecarto_init` | `cwd` | `pipeline` (alias or path), `force` | Copies the packaged template into `cwd/.codecarto`, seeds orchestrator files, writes `status.yaml`. `force` backs up an existing workspace. |
| `codecarto_open` | `cwd` | — | Reads workspace; returns pipeline + current phase. |
| `codecarto_vision` | `cwd`, `raw_text` | — | Returns a prompt to synthesize `inputs/vision.md` from the interview skill. |
| `codecarto_status` | `cwd` | — | Returns phase, pipeline state, progress, open-question/carry-forward/post-pipeline counts, next actions, staleness, missing outputs. |
| `codecarto_switch_pipeline` | `cwd`, `pipeline` | — | Rewrites `status.yaml` to a new pipeline in place; re-renders dashboard. |
| `codecarto_next` | `cwd` | `unattended` | Returns the next eligible phase's prompt text (suppresses interactive hooks when `unattended`). |
| `codecarto_phase` | `cwd`, `phase` | `unattended` | Returns a specific phase's prompt even if out of order. |
| `codecarto_validate` | `cwd` | `phase` | Parses the `## Validation` table + cross-checks; returns PASS/PASS WITH GAPS/FAIL/MISSING. |
| `codecarto_complete` | `cwd` | `phase` | Validates, applies the handoff, updates `status.yaml` under lock, writes closeout/THREAD_LOG/decisions/conventions, appends a usage receipt, refreshes dashboard. |
| `codecarto_skill` | `cwd`, `name` | — | Returns a post-pipeline skill prompt; `broadside` is exempt from the completion gate. |
| `codecarto_list_skills` | `cwd` | — | Lists installed post-pipeline skills + the ungated Broad-Side guide. |
| `codecarto_guide` | — | `topic` | Returns the packaged agent guide (overview or a reference topic). No workspace needed. |
| `codecarto_config` | — | `cwd` | Returns the effective merged config + library marker status + config problems. |
| `codecarto_usage` | `cwd` | — | Cumulative + per-phase token/tool/duration totals from `.usage.local.yaml`. |
| `codecarto_dashboard` | `cwd` | — | Regenerates `.codecarto/dashboard.html`. |
| `codecarto_amend` | `cwd`, `name` | — | Applies a post-pipeline amendment; refused while pipeline is incomplete. |
| `codecarto_refresh_scaffold` | `cwd` | — | Overwrites framework-owned files from the packaged template; never touches project state. |
| `codecarto_publish` | `source_repo`, `headline` | `library_path`, `cwd`, `spec`, `spec_path`, `slug`, `namespace`, `source_commit`, `source_branch`, `source_dirty`, `analyzed_at`, `pipeline`, `tags`, `capabilities`, `confidentiality`, `model_metadata`, `force_new_version`, `allow_source_repo_change`, `allow_confidentiality_mismatch`, `confirm` | Publishes a spec into a versioned library. `confirm: true` required when `library.publish_confirm` is configured. |
| `codecarto_library_init` | `library_path` | `name`, `namespace` | Creates a library marker and writes `library.path`/`library.namespace` to user config. MCP-only counterpart to the Pi command. |
| `codecarto_library_list` | — | `library_path`, `cwd`, `namespace`, `tag`, `slug`, `source_repo` | Lists library entries + provenance-conflict report. MCP-only. |
| `codecarto_library_reindex` | — | `library_path`, `cwd` | Regenerates `index.yaml` + `INDEX.md`; reports provenance conflicts. MCP-only. |
| `codecarto_broadside` | `cwd`, `action` (`submit`\|`collect`\|`status`\|`models`\|`verify`) | `lenses`, `api_key`, `run_id`, `top`, `wait_seconds`, `include_synthesis`, `include_triage`, `retry_truncated`, `regenerate_post_passes`, `max_cost`, `force`, `incremental`, `include_benchmarks`, `model`, `lens_models` | OpenRouter batch reconnaissance; works without a workspace. |

Every tool returns `content:[{type:"text"}]` plus a `structuredContent` object (prose is also
carried under a stable `text` key so structured-content-preferring clients still receive it)
(`observed fact`: `textResult` in `mcp-server/server.ts`).

### 3. Pi slash commands

`observed fact`: `pi.registerCommand` calls in `extensions/codecarto/index.ts`.

| Command | Args / flags | Notes |
|---|---|---|
| `/codecarto-init` | `[variant]` | Copies template, seeds orchestrator files, writes status, renders dashboard. Confirms before overwriting. |
| `/codecarto-open` | — | Activates an existing workspace without resetting; enables CodeCartographer mode + safe tools. |
| `/codecarto-vision` | — | Queues the guided vision interview prompt. |
| `/codecarto-status` | — | Status widget + notification; names missing completed outputs. |
| `/codecarto-switch-pipeline` | `<variant>` | In-place pipeline switch; reports carried/dropped/new phases and dangling carry-forwards. |
| `/codecarto-next` | `[--auto] [--strict] [--llm-steer\|--no-llm-steer]` | Single phase or full auto run; auto-validates + auto-completes. |
| `/codecarto-phase` | `<phase>` | Queues a specific phase prompt (forced). |
| `/codecarto-validate` | `[phase]` | Runs the validator; reports summary. |
| `/codecarto-complete` | `[phase]` | Validates + applies the handoff; surfaces refusal messages. |
| `/codecarto-skill` | `<name>` | Post-pipeline skill prompt; `broadside` ungated. |
| `/codecarto-list-skills` | — | Lists skills + Broad-Side guide. |
| `/codecarto-guide` | `[topic]` | Reads the packaged guide with Pi-surface framing. |
| `/codecarto-broadside` | `[submit\|collect\|status\|models\|verify] [lenses…] [--model=ID] [--lens-model=LENS:ID] [--top=N] [--regenerate] [flags]` | Batch reconnaissance; confirms spend interactively. |
| `/codecarto-publish` | — | Publishes the reimplementation spec; interactive guards for source-repo/confidentiality mismatch. |
| `/codecarto-library-init` | `<path> [--namespace <name>]` | Creates a library + writes config; refuses malformed `--namespace`. |
| `/codecarto-config` | — | Shows merged config + problems. |
| `/codecarto-usage` | — | Token/tool/duration totals. |
| `/codecarto-dashboard` | `[--narrate]` | Regenerates dashboard; `--narrate` adds an LLM summary. |
| `/codecarto-refresh-scaffold` | — | Previews + refreshes framework-owned files. |
| `/codecarto-amend` | `<name\|path>` | Previews + applies an amendment. |

Also registered as Pi hooks/events: `session_start`, `session_shutdown`, `agent_end`,
`tool_call` (blocks `bash` and confines `edit`/`write` to `.codecarto/` plus a configured
library) (`observed fact`).

### 4. Exported libraries

- `core/index.ts` is the barrel re-exporting `types, utils, yaml, status, amendment, pipeline,
  findings, coverage, prompts, workspace, completion, orchestrator-config, usage, guide,
  dashboard, library, synthesis, broadside, secrets, dashboard-writer` (`observed fact`).
- `mcp-server/server.ts` exports `buildServer`, `startStdioServer`, and every `handle*` handler.
- `extensions/codecarto/index.ts` default-exports the extension factory.
- `core/broadside.ts` re-exports the 14-module Broad-Side subsystem.

### 5. Agent guide topics

`observed fact`: `agent-skill/codecartographer/`. Served by `core/guide.ts` (frontmatter
stripped) through `codecarto_guide` / `/codecarto-guide`.

- `overview` (`SKILL.md`)
- `broadside`, `carrying-results-forward`, `deep-audit-synthesis`, `executors`,
  `handoff-contract`, `kernel-first-rewrite`, `library`, `orchestration`,
  `phase-recovery`, `pipeline-selection`.

### 6. File formats and persistent artifacts

See `findings/state-and-storage/state-and-storage.md` for the full durable-state catalog.
Formats that are effectively ABI:

- `workflow/status.yaml` (schema_version 1) — progress, open questions, carry-forward, post-pipeline.
- `workflow/pipeline*.yaml` — the phase DAG (`phase_order`, `phases[].{depends_on, primary_output, secondary_outputs, required_reads, completion_criteria, handoff_requirements, preflight}`).
- `scratch/handoffs/<phase>.yaml` (schema_version 1) — phase handoff contract.
- `scratch/amendments/<slug>.yaml` (schema_version 1).
- Library: `.codecarto-library` (JSON marker), `entries/<ns>/<slug>/v<N>/{reimplementation-spec.md,metadata.yaml}`, `latest` (pointer file), `index.yaml`/`INDEX.md` (derived). `docs/library-format.md` is the authoritative public contract.
- Broad-Side: `broadside/state.json` (schema_version 1), `broadside/config.yaml`, `broadside/model-catalog.json`, `broadside/batch-endpoints.json`, `broadside/<run>/**`.
- `dashboard.html` — self-contained single-file HTML; no external assets.

### 7. Network / RPC interfaces

| Endpoint | Method | Used by |
|---|---|---|
| MCP over stdio (JSON-RPC) | `tools/list`, `tools/call` | MCP host ↔ `codecarto-mcp` |
| `https://openrouter.ai/api/beta/batches` | POST submit, GET poll | Broad-Side lens batches |
| `https://openrouter.ai/api/v1/chat/completions` | POST | Broad-Side `verify` (sync, read-only tools) |
| `https://openrouter.ai/api/v1/models` | GET | Broad-Side model catalog/pricing |
| `https://openrouter.ai/api/v1/benchmarks` | GET | Optional coding benchmarks |

(`observed fact`: `core/broadside/constants.ts`, `client.ts`, `verify.ts`.)

### 8. External processes and registries

- `git` subprocess: `rev-parse`, `remote get-url`, `symbolic-ref`, `config --get`, `add`,
  `status --porcelain`, `commit`, `ls-files`, `rev-parse HEAD`, `diff --name-only`
  (`observed fact`: `core/library.ts`, `core/broadside/repo.ts`).
- npm registry publish, MCP Registry publish, GitHub Release creation (release workflow).
- `~/.codecarto/config.yaml` user-global config path (overridable via
  `CODECARTO_USER_CONFIG_PATH`).

### 9. Environment variables

`OPENROUTER_API_KEY` (Broad-Side key), `CODECARTO_USER_CONFIG_PATH` (config override),
`HOME` (config + Pi session paths) (`observed fact`).

## 2026-09-15 — contracts phase

Catalog-level extraction of per-argument defaults, side effects, and error behavior for both
surfaces (this is the closure of routed item `cf-arch-1`; the narrative form is in
`findings/contracts/behavioral-contracts.md` §cf-arch-1).

### MCP tool argument defaults, effects, and errors

Every tool takes an absolute, existing `cwd` unless noted; every result carries its rendered text
under a stable `text` key in `structuredContent`. Error codes: `IP` = InvalidParams,
`IR` = InvalidRequest, `IE` = InternalError, `MN` = MethodNotFound (`observed fact`:
`mcp-server/server.ts` `validateCwd`, `optionalCwd`, `requireWorkspace`, `buildServer`).

| Tool | Required | Optional → default | Side effects | Errors |
|---|---|---|---|---|
| `codecarto_init` | `cwd` | `pipeline` → default; `force` → false | copy template, seed orchestrator files, write status.yaml | IP (bad cwd/unknown pipeline/missing pipeline file), IR (exists w/o force), IE (packaged assets) |
| `codecarto_open` | `cwd` | — | none | IP (cwd), IR (no status.yaml) |
| `codecarto_status` | `cwd` | — | none | IP (cwd), IR (workspace) |
| `codecarto_next` | `cwd` | `unattended` → false | none (prompt) | IP (cwd/preflight), IR (stuck) |
| `codecarto_phase` | `cwd`, `phase` | `unattended` → false | none | IP (phase missing/non-string/unknown, cwd) |
| `codecarto_validate` | `cwd` | `phase` → next eligible | none | IP (non-string/unknown phase), IR (workspace) |
| `codecarto_complete` | `cwd` | `phase` → next eligible | commit status.yaml; closeout/THREAD_LOG/decisions/conventions; usage receipt; dashboard | IP (phase/cwd), IR (FAIL/MISSING, no handoff, bad target_phase, missing post_pipeline id, closure D1/D3) |
| `codecarto_skill` | `cwd`, `name` | — | none | IP (name missing/unknown), IR (pipeline incomplete/stuck, broadside guide missing) |
| `codecarto_list_skills` | `cwd` | — | none | IP/IR (cwd/workspace) |
| `codecarto_guide` | — | `topic` → overview | none | IP (unknown topic / packaged skill missing); no workspace needed |
| `codecarto_config` | — | `cwd` → user-global only | none | IP (non-absolute/missing cwd) |
| `codecarto_vision` | `cwd`, `raw_text` | — | none | IP (raw_text/cwd), IR (interview skill missing) |
| `codecarto_usage` | `cwd` | — | none | IP/IR (cwd/workspace) |
| `codecarto_dashboard` | `cwd` | — | writes dashboard.html | IP (cwd), IR (render failed) |
| `codecarto_refresh_scaffold` | `cwd` | — | copy framework files, THREAD_LOG entry, .gitignore if absent | IR (workspace/template missing) |
| `codecarto_amend` | `cwd`, `name` | — | commit status.yaml; amendment closeout + THREAD_LOG; dashboard | IP (name missing), IR (malformed/absent amendment, incomplete/stuck) |
| `codecarto_publish` | `source_repo`, `headline`, (`spec`\|`spec_path`) | `library_path`→config, `cwd`→none, `slug`→derived, `namespace`→config, `source_commit`/`source_branch`/`source_dirty`, `analyzed_at`→now, `pipeline`→status.yaml, `tags`/`capabilities`→[], `confidentiality`→internal, `model_metadata`→all unknown, `force_new_version`→false, `allow_source_repo_change`→false, `allow_confidentiality_mismatch`→false, `confirm`→false | .publish.lock; version dir + latest; reindex | IP (relative library_path/spec_path, out-of-containment spec_path, invalid slug/namespace, missing arg, wrong type, namespaced w/o namespace), IR (config problems, missing marker, publish_confirm refusal), IE (spec_path w/o containment root) |
| `codecarto_library_init` | `library_path` | `name`→dirname, `namespace`→none | marker; user config library.path/namespace | IP (library_path missing/relative, invalid namespace), IR (unparsable config) |
| `codecarto_library_list` | — | `library_path`→config, `cwd`→none, `namespace`/`tag`/`slug`/`source_repo`→unfiltered | none (may build index) | IP (relative library_path, cwd, missing marker), IR (config problems) |
| `codecarto_library_reindex` | — | `library_path`→config, `cwd`→none | writes index.yaml/INDEX.md | IP/IR as list |
| `codecarto_broadside` | `cwd`, `action` | `lenses`→all six, `api_key`→env/config, `run_id`→latest, `top`→10, `wait_seconds`→config 0, `include_synthesis`/`include_triage`/`retry_truncated`→config true, `regenerate_post_passes`→false, `max_cost`→config $1, `force`→false, `incremental`→config false, `include_benchmarks`→false, `model`→config default, `lens_models`→{} | network; run state/results | IP (unknown action/lens/model/top, lens_models shape, missing key, regenerate misuse), IR (config error non-status, corrupt state.json, submit/collect failure) |

Notable cross-argument behavior (`observed fact`): `library_path`/optional `cwd` follow the same
absolute+existing rule as a required `cwd`; `codecarto_publish` builds allowed roots from the
library path plus `cwd/.codecarto` and `readSpecArg` fails closed on an empty root set;
`codecarto_broadside` honors an explicit `0` for `wait_seconds`/`max_cost`.

### Pi slash-command grammars and flag-parser defaults

| Command | Grammar | Defaults | Invalid behavior |
|---|---|---|---|
| `/codecarto-init` | `[variant]` | default pipeline | unknown variant → error; existing → confirm |
| `/codecarto-next` | `[--auto] [--strict] [--llm-steer\|--no-llm-steer]` | auto/strict false; llmSteerOverride undefined (config) | unknown flags reported; `--strict` w/o `--auto` → error |
| `/codecarto-broadside` | `[submit\|collect\|status\|models\|verify] [lenses…] [flags]` | action submit; lenses [] (config); incremental/includeSynthesis/includeTriage/retryTruncated/maxCost/waitSeconds undefined (config); benchmarks/regeneratePostPasses false | unknown tokens reported; contradictions/action mismatches/malformed numerics → error |
| `/codecarto-dashboard` | `[--narrate]` | narrate false | unknown flags → error |
| `/codecarto-library-init` | `<path> [--namespace <name>]` | namespace none | missing value/invalid namespace/stray flag/extra positional → warning |
| `/codecarto-amend` | `<name\|path>` | — | empty → usage; path outside scratch/amendments/ → error |
| `/codecarto-phase`, `/codecarto-validate`, `/codecarto-complete`, `/codecarto-skill` | `<arg>?` | next eligible / none | unknown phase/skill → error |
| `/codecarto-switch-pipeline` | `<variant>` | — | empty → usage; unknown → error |

Flag-parser return shapes and the completer contract are in
`findings/contracts/behavioral-contracts.md` §cf-arch-1 (Pi).

## 2026-09-15 — protocols phase

Protocol-boundary catalog companion to `findings/protocols/protocols-and-state.md` §Event Catalog.
This section adds the wire-level surfaces and corrects two stale summaries; it is `observed fact`
from source inspection, with the usual `verify at runtime` hedge on OpenRouter and non-POSIX
filesystem behavior.

### Network / RPC interfaces (detail)

- **MCP over stdio.** `@modelcontextprotocol/sdk` `Server` (name `codecartographer`, version
  `PACKAGE_VERSION`) + `StdioServerTransport`. `ListTools` returns the static `TOOLS` array;
  `CallTool` dispatches by `params.name`. **Every** result is
  `{content:[{type:"text",text}], structuredContent:{…, text}}` — the rendered prose is always
  carried under a stable `text` key so a `structuredContent`-preferring client still receives it.
  A handler-thrown `McpError` passes through; any other throw becomes `InternalError`; unknown
  tool → `MethodNotFound`. `startStdioServer` aborts its lifetime `AbortController` on
  `server.onclose` and on `process.stdin` `end`/`close`. `observed fact`:
  `mcp-server/server.ts`.
- **OpenRouter Batch API** (`https://openrouter.ai/api/beta/batches`). Submit `POST {endpoint:
  "/v1/chat/completions", model, requests[]}` — **key order matters** (the provider stream-parses
  the body); a 202 returns `{id,status}`; poll `GET /{batchId}`. 30 s `AbortSignal.timeout` per
  call. Terminal statuses `completed`/`failed`/`expired`/`cancelled`; the client adds synthetic
  `auth-failed` (401/403) and `timeout` (budget/abort — the batch keeps running server-side).
  `external-behavior claim` → `q-openrouter-batch-semantics`, `verify at runtime`.
- **OpenRouter catalog/benchmarks** (`/api/v1/models`, `/api/v1/benchmarks`). `models` filters to
  `:batch` ids; pricing resolves config → per-entry 24 h cache → live → compile-time built-in
  (default model). `observed fact` for the local handling; `external-behavior claim` for the
  responses.
- **OpenRouter Chat Completions.** Verify runs a bounded tool loop (`BROADSIDE_VERIFY_MAX_TOOL_CALLS`)
  then a schema-forced verdict; synthesis/triage are single schema-forced calls.

### External processes

- **`git`** via `spawn`/`execFile`, `timeout = GIT_TIMEOUT_MS = 30_000`. Publish never runs git;
  `commitPublish` is exported and uncalled by both surfaces; Broad-Side reads HEAD/dirty/ls-files.
  `portability hazard` + `external-behavior claim` (finding 6.4), `verify at runtime`.

### Correction: Pi slash-command count is 20, not "~21"

The architecture phase and this file's 2026-09-14 section said "~21 slash commands". The measured
fact is **20**: `extensions/codecarto/index.ts` registers exactly 20 `pi.registerCommand` calls
(`init`, `open`, `vision`, `status`, `switch-pipeline`, `next`, `phase`, `validate`, `complete`,
`skill`, `list-skills`, `guide`, `broadside`, `publish`, `library-init`, `config`, `usage`,
`dashboard`, `refresh-scaffold`, `amend`), `tests/pi-parity-commands.test.mjs` pins
`commands.size === 20`, and `README.md` lists 20. Use **20** (`observed fact`).

### Correction: Broad-Side actions include `verify`

`README.md` lists Broad-Side actions as `submit, collect, status, models`; the MCP schema and the
Pi flag parser both implement five actions — `submit, collect, status, models, verify`. The code is
authoritative; the README is stale by one action (`observed fact`).

## 2026-09-15 — porting phase

Port-oriented companion to `findings/porting/reverse-engineering-bundle.md`. This phase added no
new source claims about surfaces; it fixes the surface *priority* and the two wire-format
constraints a port must honor.

### Surface priority for a port

- **Core (build first):** the phase-control tool/command set that reads and writes workspace state
  — init, open, status, next/phase, validate, complete — and the shared `core/` they drive. MCP
  path containment (`readSpecArg`) is core because it is the only authorization decision on that
  surface.
- **Important:** switch-pipeline, dashboard, config, refresh-scaffold, amend, and the library
  init/list/reindex command shapes.
- **Optional:** Broad-Side (network-coupled; a port can stub it and still deliver analysis),
  publish, skill/guide, usage, vision, and the entire Pi TUI surface (widget, completions,
  narration).
- **Drop-in `.codecarto/` data template** is core but is not an executable surface: it carries the
  protocol by prompt alone.

### Wire-format constraints on the surface boundary (C04)

A port must reproduce the MCP result envelope `{content:[{type:"text",text}],
structuredContent:{…, text}}` (the rendered prose is always under a stable `text` key), and must
keep the parser-visible Markdown headings/labels/table headers verbatim. A renamed heading or a
dropped `text` key does not throw — the reader sees nothing.

### Carried corrections

Pi exposes **20** commands (not "~21"); Broad-Side implements five actions including `verify`.
Both were re-affirmed by the porting phase's source spot-checks.

