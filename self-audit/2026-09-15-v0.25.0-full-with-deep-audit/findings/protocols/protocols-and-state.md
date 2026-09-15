# Protocols and State — CodeCartographer (`codecartographer-pi` v0.25.0)

> Self-audit: the analyzed source is the repository outside `.codecarto/`, i.e. the
> CodeCartographer framework itself. This phase treats every boundary as a protocol boundary:
> it catalogs the event streams, names the state machines, specifies every on-disk and wire
> format field-by-field, and records the portability hazards a reimplementation must decide
> about explicitly.
>
> Evidence levels are marked inline as `observed fact`, `strong inference`,
> `external-behavior claim`, `portability hazard`, or `open question`. Catalog-level detail for
> this phase's declared secondary outputs is appended to `findings/public-surfaces/`,
> `findings/runtime-lifecycle/`, `findings/state-and-storage/`, and `findings/config-model/`;
> this report owns the protocol map and the load-bearing claims. Every claim that lands on the
> OpenRouter API, a filesystem lock/rename, path containment, or a bare-`git` invocation carries
> `verify at runtime`, inheriting `q-openrouter-batch-semantics` and `q-node-windows-fs-semantics`.
>
> This phase closes three routed items: `cf-arch-2` (field-by-field serialized shapes, §Persistent
> Schema Notes + §Routed Item Closures), `cf-contracts-1` (`docs/library-format.md` vs
> `core/library.ts`, §cf-contracts-1), and `cf-contracts-2` (dashboard HTML body catalog,
> §cf-contracts-2).

## Boundaries Identified

| # | Boundary | Producer → Consumer | Carrier |
|---|---|---|---|
| B1 | Host ↔ workflow engine | MCP host / Pi TUI → `core/` | Tool call arguments / slash-command text |
| B2 | MCP server ↔ MCP client | `mcp-server/server.ts` ↔ any MCP host | stdio JSON-RPC (`Server` + `StdioServerTransport`) |
| B3 | Prompt assembly ↔ agent | `core/prompts.ts` → sub-agent / host | UTF-8 prompt text (byte-identical across surfaces, CONVENTIONS C01) |
| B4 | Phase output ↔ validator | agent → `core/pipeline.ts` | Markdown `## Validation` table + `## Coverage and limits` ledger |
| B5 | Phase executor ↔ completion | `scratch/handoffs/<phase>.yaml` → `core/completion.ts` | Hand-rolled YAML |
| B6 | Post-pipeline ↔ amendment | `scratch/amendments/<slug>.yaml` → `core/amendment.ts` | Hand-rolled YAML |
| B7 | Core ↔ OpenRouter Batch API | `core/broadside/client.ts` ↔ `openrouter.ai` | HTTPS JSON |
| B8 | Core ↔ OpenRouter catalog/benchmarks | `core/broadside/models.ts` ↔ `openrouter.ai` | HTTPS JSON |
| B9 | Core ↔ OpenRouter Chat Completions | `core/broadside/verify.ts` ↔ `openrouter.ai` | HTTPS JSON, tool-calling loop |
| B10 | Pi extension ↔ Pi SDK / child sessions | `extensions/codecarto/*` ↔ `AgentSession` | In-process event subscription |
| B11 | Core ↔ `git` | `core/library.ts`, `core/broadside/repo.ts` ↔ OS process | `spawn`/`execFile` subprocess |
| B12 | Workspace state ↔ filesystem | all writers → `status.yaml`, lock files, atomic renames | POSIX file primitives |
| B13 | Workspace ↔ dashboard artifact | `dashboard-writer.ts` → `dashboard.html` | Self-contained HTML + embedded JSON |
| B14 | Config files ↔ runtime | user-global / workspace / Broad-Side config → loaders | Hand-rolled YAML |
| B15 | Library ↔ external consumer | `.codecarto-library`, `metadata.yaml`, `index.yaml`, `latest` | JSON + hand-rolled YAML + plain files |

There is **no network server, no web UI, no authentication service, and no message broker**.
The only outbound network is OpenRouter; the only subprocess is `git`; the only cross-process
coordination is advisory lock files in the workspace (CONVENTIONS C02).

---

## Event Catalog

Each protocol records producer, consumer, carrier, ordering guarantees, required/optional
fields, identifiers and timestamps, error cases, and restart/resume behavior.

### P1. Phase-control request/response (host → core)

| Field | Value |
|---|---|
| **Producer** | MCP tool handlers (`mcp-server/server.ts`) and Pi command handlers (`extensions/codecarto/index.ts`) |
| **Consumer** | `core/{pipeline,prompts,completion,status,workspace,library,orchestrator-config,usage,amendment,guide}.ts` |
| **Transport or carrier** | In-process function calls; arguments are MCP `inputSchema` objects or parsed slash-command tokens |
| **Ordering guarantees** | `init → open → status → next → validate → complete` is the intended sequence, but only `next`/`validate`/`complete` enforce DAG order (`resolvePipelineOutcome`). Completion is the only state-mutating step besides `switch_pipeline`, `amend`, and `refresh_scaffold`; each of those takes the status lock. |
| **Required fields** | Every tool/handler validates its own arguments (`validateCwd`, `requireOptionalPhase`, `asStringArray`, per-field `typeof` checks). `cwd` is absolute+existing except where noted (`codecarto_guide`, `codecarto_config`, `codecarto_broadside`, `codecarto_publish`, `codecarto_library_*`). |
| **Optional fields** | Per `cf-arch-1` closure in `findings/contracts/behavioral-contracts.md` (22 MCP tools, 20 Pi commands). |
| **Identifiers and timestamps** | Phase id (regex `^[A-Za-z0-9][A-Za-z0-9._-]*$`, `assertSafePhaseId`); amendment slug (same alphabet); `last_updated` = ISO from the host clock at completion/switch/amendment. |
| **Error cases** | `InvalidParams` (-32602) for a malformed argument; `InvalidRequest` (-32600) for a workspace/validation/closure refusal; `InternalError` (-32603) for an unexpected throw or missing packaged assets; `MethodNotFound` (-32601) for an unknown tool. Pi surfaces the same as `error`/`warning` notifications. |
| **Restart or resume behavior** | Idempotent except `init`/`switch_pipeline`; re-running `complete` regenerates post-commit artifacts (CONVENTIONS C02); a failed phase run leaves no state change. |

`observed fact`: `mcp-server/server.ts` helpers + `buildServer`/`startStdioServer`; `core/completion.ts`; `extensions/codecarto/index.ts`.

### P2. MCP stdio JSON-RPC transport

| Field | Value |
|---|---|
| **Producer** | `mcp-server/server.ts` `buildServer()` |
| **Consumer** | Any MCP-capable host over a child process's stdio |
| **Transport or carrier** | `@modelcontextprotocol/sdk` `Server` + `StdioServerTransport`; newline-delimited JSON-RPC on stdin/stdout |
| **Ordering guarantees** | SDK framing; request handlers are async and independent. `ListTools` returns the static `TOOLS` array; `CallTool` dispatches by `params.name` to `HANDLERS`. |
| **Required fields** | `CallTool` requires `params.name`; handlers read `params.arguments ?? {}`. Every result is `{content:[{type:"text",text}], structuredContent:{…, text}}`. |
| **Optional fields** | `structuredContent` extras per tool (e.g. `{phase, forced, unattended}`, `{complete:true}`, validation counts). |
| **Identifiers and timestamps** | Server name `codecartographer`, version = `PACKAGE_VERSION`; no request ids beyond JSON-RPC's own. |
| **Error cases** | A handler-thrown `McpError` passes through unchanged; any other throw becomes `InternalError` with the message. Unknown tool → `MethodNotFound`. A stuck pipeline returns `InvalidRequest`, deliberately not a text result, so a looping host cannot read "done". |
| **Restart or resume behavior** | `startStdioServer` sets a `serverLifetime: AbortController` aborted on `server.onclose`, `process.stdin` `end`, and `process.stdin` `close`. Batches already accepted server-side keep running and are claimable by a later `collect`. Handlers invoked directly (tests/in-process) see no signal. |

`observed fact`: `mcp-server/server.ts:1957-2008`. The SDK's negotiated protocol version is not
read here (`open question`, upstream blind spot; see Coverage).

### P3. Phase prompt text (assembly → agent)

| Field | Value |
|---|---|
| **Producer** | `buildPhasePrompt` / `buildSkillPrompt` (`core/prompts.ts`) |
| **Consumer** | Pi sub-agent `AgentSession` (`agent-runner.ts`) or an MCP host's own agent |
| **Transport or carrier** | Plain UTF-8 text, byte-identical for both executable surfaces (CONVENTIONS C01; test-pinned) |
| **Ordering guarantees** | Fixed section order: intro → required reads → routed carry-forward → orchestrator duties → synthesis library context → alignment hook → rules → handoff requirements → primary output target. Later-phase runs collapse the three framework-owned first reads to a "skim" note. |
| **Required fields** | Phase id, `GUIDE.md` path, `status.yaml` path; conditional sections only when their precondition holds (routed items exist, proposals pending, secondary outputs declared, coverage gaps exist, checkpoint exists, stale scaffold). |
| **Optional fields** | `depends_on` warning, `handoff_requirements`, forced-phase line, `--auto` alignment-hook variant. |
| **Identifiers and timestamps** | No timestamps written into the prompt (byte-identity requires it). |
| **Error cases** | Preflight (`runPhasePreflight`) may throw `PhasePreflightError` (`InvalidRequest` on MCP); missing pipeline/status files throw earlier. |
| **Restart or resume behavior** | Recomputable from workspace state at any time; no side effects. |

`observed fact`: `core/prompts.ts`. Spliced earlier-session text (routed items, coverage gaps,
library headlines) is wrapped in `«…»` and capped at `SPLICED_TEXT_LIMIT = 400` chars
(`quoteSpliced`); this is a prompt-injection mitigation, not a parser (`strong inference`).

### P4. Validation-table grammar (phase output → validator)

| Field | Value |
|---|---|
| **Producer** | Phase executor (the agent writing the primary output) |
| **Consumer** | `validatePhaseOutput` (`core/pipeline.ts`), `crossCheckFindings` (`core/findings.ts`), `parseCoverageAndLimits` (`core/coverage.ts`) |
| **Transport or carrier** | Markdown inside the primary output |
| **Ordering guarantees** | The **last** `## Validation` heading wins (`content.lastIndexOf`). Table rows are read in order; the **last** `**Overall:**` line wins. |
| **Required fields** | A `## Validation` block; ≥1 pipe-table row with ≥4 cells; an `**Overall:**` line whose value starts (after stripping `*_` backticks and whitespace) with `PASS`, `PASS WITH GAPS`, or `FAIL`. |
| **Optional fields** | Decorated verdicts (`PASS (6/6)`, `**PASS WITH GAPS** — see §3`, leading list marker); a trailing `Spec Reference` column; `## Open Questions` table. |
| **Identifiers and timestamps** | `**Validated by:**` is free prose (conventionally a UTC date); not parsed. Phase id, not the prompt, ties the output to the pipeline. |
| **Error cases** | Missing block → `FAIL` "missing a ## Validation block"; no rows → `FAIL`; unreadable/`FAIL` Overall → `FAIL` with the quoted line; any row containing `FAIL` → `overall = FAIL`. Findings pairing violation (unsettled evidence + settled action) → `FAIL` on a scaffold ≥0.17.1, else a warning. |
| **Restart or resume behavior** | Read-only; re-running validation over the same bytes yields the same verdict. |

`observed fact`: `core/pipeline.ts` `parseOverallLine`/`validatePhaseOutput`;
`core/findings.ts` `parseFindingsTables`. The grammar is a **wire format**: a reimplementation
must preserve the exact heading text and table headers (`| # | Location | … | Evidence Level |
Action |`) or the parsers silently see no rows (`strong inference`).

### P5. Coverage-ledger grammar (phase output → next phase's prompt)

| Field | Value |
|---|---|
| **Producer** | Phase executor's `## Coverage and limits` section |
| **Consumer** | `collectCoverageGaps` → `buildOrchestratorDuties` (`core/coverage.ts`, `core/prompts.ts`) |
| **Transport or carrier** | Markdown bullets |
| **Ordering guarantees** | Walks `pipeline.phase_order` (upstream-first, deterministic). |
| **Required fields** | A `## Coverage and limits` section; the five fixed bullet labels `Inspected scope`, `Skipped scope`, `Evidence basis`, `Known blind spots`, `Coverage disposition` (label normalized by stripping `` ` ``/`*`/`_`, lowercasing). |
| **Optional fields** | Sub-bullets and wrapped continuation lines fold onto the labelled value (sub-bullets joined with `; `). |
| **Identifiers and timestamps** | Only `Skipped scope` and `Known blind spots` are collected and bind later phases. |
| **Error cases** | None — a missing file/section/bullet yields nothing; nothing throws. |
| **Restart or resume behavior** | Read-only, recomputed each prompt build. |

`observed fact`: `core/coverage.ts`, `core/prompts.ts` `buildOrchestratorDuties`.

### P6. Findings-table cross-check (defect reports → validation)

| Field | Value |
|---|---|
| **Producer** | Defect-scan pass tables |
| **Consumer** | `crossCheckFindings` (`core/findings.ts`) via `validatePhaseOutput` |
| **Transport or carrier** | Markdown tables under `## Pass N` headings |
| **Ordering guarantees** | Header-driven: only tables whose header normalizes to include both `evidence level` and `action` columns are read. |
| **Required fields** | Header cells `#`, `Evidence Level`, `Action`. |
| **Optional fields** | Trailing `Spec Reference` column; placeholder rows (both evidence and action empty) are skipped. |
| **Identifiers and timestamps** | Row `#` cell, `## Pass N` heading; 1-based line number computed for messages. |
| **Error cases** | An unsettled evidence level (`open question`, `external-behavior claim`) paired with a settled action (`fix before porting`, `fix now`) → error on a scaffold ≥0.17.1, else warning. `observed fact` + `verify at runtime` → warning (self-contradiction). Unsettled findings with an empty `## Open Questions` table → warning. |
| **Restart or resume behavior** | Read-only. |

`observed fact`: `core/findings.ts`. This is the mechanism behind CONVENTIONS C03
(unsettled findings inherit uncertainty).

### P7. Phase-handoff exchange (executor → completion)

| Field | Value |
|---|---|
| **Producer** | Phase executor's `scratch/handoffs/<phase>.yaml` |
| **Consumer** | `parseHandoff` → `applyHandoff` (`core/status.ts`) via `completeValidatedPhase` (`core/completion.ts`) |
| **Transport or carrier** | Hand-rolled YAML (`core/yaml.ts`) |
| **Ordering guarantees** | Parsed and validated **before** the lock (target-phase and closure-integrity checks); applied **inside** the lock, after the authoritative re-validation and before the `status.yaml` rename; handoff-driven artifacts written in `afterCommit`. |
| **Required fields** | `phase_id` (must equal the validated phase). Every collection must be an array if present. Each `carry_forward` entry needs a `target_phase` that is a downstream active phase; each `post_pipeline` entry needs a non-empty `id`; each `proposed_conventions` entry needs non-empty `name` and `rule`. |
| **Optional fields** | `schema_version` (default 1; >1 rejected); `timestamp` (deprecated/ignored); `closeout_content`, `closeout_summary`. |
| **Identifiers and timestamps** | Ids auto-assigned when absent: `oq-<phase>-N` and `cf-<phase>-N` (`autoAssignIds`). The framework stamps canonical timestamps; a model-supplied `timestamp` is ignored. |
| **Error cases** | Non-object/`phase_id` missing → `parseHandoff` throws; malformed collection (non-array) → throws; `target_phase` not downstream → completion throws; missing `post_pipeline.id` → throws; `proposed_conventions` stub → throws; D1 (close a `derives_from` item while its question is open and not closed in the same handoff) → throws; D3 (`needs-runtime-test` question closed without evidence on scaffold ≥0.19.0) → throws, else warning. |
| **Restart or resume behavior** | Consumed once at completion, **retained on disk**; re-running completion is idempotent (canonical closeout, link-deduped THREAD_LOG line, text-deduped decision rows/proposals). A handoff whose `phase_id` mismatches is refused. |

`observed fact`: `core/status.ts`, `core/completion.ts`; `templates/phase-handoff.yaml`. Full field
list in §Persistent Schema Notes → Handoff.

### P8. Amendment exchange (post-pipeline → status)

| Field | Value |
|---|---|
| **Producer** | `scratch/amendments/<slug>.yaml` (user/agent), discovered by `listAmendmentNames` |
| **Consumer** | `loadAmendmentFile` → `applyAmendment` (`core/amendment.ts`) |
| **Transport or carrier** | Hand-rolled YAML |
| **Ordering guarantees** | Refuses unless the pipeline is `complete` (judged on the state read **under** the lock); closures applied under the lock; closeout + THREAD_LOG written in `afterCommit`; terminal `next_actions` rebuilt from the new counts. |
| **Required fields** | At least one non-empty entry across `open_question_closures`, `post_pipeline_closures`, `notes`. Those three must be arrays if present. |
| **Optional fields** | `schema_version` (default 1; >1 rejected); `closeout_summary`, `closeout_content` (generated when omitted). |
| **Identifiers and timestamps** | Slug from the filename (regex-same alphabet as phase ids); date-only closeout name `<YYYY-MM-DD>-amendment-<slug>.md`. |
| **Error cases** | Malformed/absent file → throw; non-array field → throw; pipeline incomplete/stuck → `Cannot amend`; ids that match nothing → reported in `unknownIds`, not fatal (idempotent). |
| **Restart or resume behavior** | Idempotent: re-running reports already-closed ids and does not duplicate the THREAD_LOG entry. |

`observed fact`: `core/amendment.ts`; `templates/amendment.yaml`.

### P9. OpenRouter Batch API (Broad-Side submit/fetch/poll)

| Field | Value |
|---|---|
| **Producer** | `core/broadside/client.ts` (`submitBatch`, `fetchBatch`, `pollBatchUntilTerminal`, `pollBatchesConcurrently`) |
| **Consumer** | `openrouter.ai/api/beta/batches` |
| **Transport or carrier** | HTTPS JSON; `Authorization: Bearer <key>`; `AbortSignal.timeout(30_000)` per call |
| **Ordering guarantees** | Submit payload key order is contractual (`endpoint`, `model`, `requests`); OpenRouter stream-parses the body. One batch per lens; batches are polled **concurrently** against one shared deadline. |
| **Required fields** | Submit: `endpoint:"/v1/chat/completions"`, `model`, `requests: BatchRequest[]`. Each request: `custom_id`, `body{model, messages, response_format{json_schema}, max_tokens, reasoning?}`. |
| **Optional fields** | `reasoning` (always sent in practice; `defaultReasoningFor()` = `{effort:"low"}`); per-lens model override and `outputCap`. |
| **Identifiers and timestamps** | Batch id from the 202 response `{id,status}`; `custom_id` = `<lens>-<moduleTag>[-<index>]` (sanitized); submit/poll timestamps recorded in `state.json` (ISO). |
| **Error cases** | HTTP != 202 → `{batchId:"", status:"rejected", error}`; 401/403 during poll → synthetic `auth-failed` (stops retrying); HTTP ≥400 → retry within budget, remembering the last error; non-JSON body → `{error:"non-JSON response (…)"}`; budget expiry / abort → synthetic `status:"timeout"` (still running server-side, claimable). `explainBatchError` maps `does not have a :batch endpoint` and `job-submission-count` refusals to a user-facing cause. |
| **Restart or resume behavior** | `collect` again resumes; already-accepted batches keep running server-side. `BROADSIDE_TERMINAL_ENTRY_STATUSES` marks when collect stops polling. |

`observed fact` for local behavior: `core/broadside/client.ts`; `core/broadside/requests.ts`;
`core/broadside/schemas.ts`. The **remote** contract — per-account concurrent-job quota, which
catalog ids actually have `:batch` endpoints, and reasoning acceptance — is an
`external-behavior claim` → `q-openrouter-batch-semantics`, action `verify at runtime`. The
timeouts and TLS behavior are `portability hazard`s on unusual platforms.

### P10. OpenRouter catalog and benchmarks

| Field | Value |
|---|---|
| **Producer** | `core/broadside/models.ts` (`resolveCatalogEntry`, `listBatchModels`, `fetchCodingBenchmarks`) |
| **Consumer** | `openrouter.ai/api/v1/models`, `openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding` |
| **Transport or carrier** | HTTPS JSON; 30 s timeout |
| **Ordering guarantees** | Pricing resolution order: config override → on-disk cache (per-entry 24 h TTL) → live catalog → compile-time built-in (default model only) → throw naming the model. |
| **Required fields** | Catalog entry parse requires an `id` and numeric `pricing.prompt`/`pricing.completion`. Benchmark rows require `model_permaslug`. |
| **Optional fields** | `pricing.cached_input`, `context_length`, `top_provider.max_completion_tokens`, `supported_parameters`, `expiration_date`; benchmark `coding_index`/`intelligence_index` and `meta`. |
| **Identifiers and timestamps** | Model id (with `:batch` variant suffix); per-entry `fetched_at` (schema 3). |
| **Error cases** | 401/403 → `BroadsideAuthError`; other failure → `catalogFailure` then built-in fallback or a throw telling the user to set manual pricing. A 24 h-stale cache is not used. |
| **Restart or resume behavior** | Cache persists in `model-catalog.json`; `listBatchModels` rewrites the whole cache. |

`observed fact` for local handling; `external-behavior claim` for the endpoint's response shapes
(→ `q-openrouter-batch-semantics`).

### P11. OpenRouter Chat Completions with a tool loop (verify + post-passes)

| Field | Value |
|---|---|
| **Producer** | `core/broadside/verify.ts` (`verifyFinding` agentic loop), `core/broadside/collect.ts` (`buildSynthesisRequest`, `buildTriageRequest`) |
| **Consumer** | Chat Completions endpoint (verify reads files via a tool loop; post-passes are single schema-forced calls) |
| **Transport or carrier** | HTTPS JSON; `response_format: {type:"json_schema", json_schema: …}` |
| **Ordering guarantees** | Verify: up to `BROADSIDE_VERIFY_MAX_TOOL_CALLS` tool rounds, then a forced schema call, then one no-tools schema call if the model answered in prose. Post-passes read the `verified.json` verdicts written by an earlier verify pass (`loadPostPassVerdicts`) and are gated on all lens batches being terminal. |
| **Required fields** | Verdict object `{verdict, confidence, evidence[], reasoning}` with `verdict ∈ {confirmed, not-a-defect, discarded, unclear}`. Post-pass requests carry the findings text plus a `truncatedNote` and optional rendered verdicts. |
| **Optional fields** | Per-verdict `evidence[].file/lines/note`; synthesis `max_tokens: 12_000`, triage `max_tokens: 10_000`. |
| **Identifiers and timestamps** | `custom_id` `synthesis` / `triage`; verdict `error` when the budget is spent without a JSON verdict; `verify.at` timestamp. |
| **Error cases** | A thrown verify attempt becomes `{verdict:"error", …}`; parse failure after fence-stripping → unknown verdict → `unclear`. A non-JSON/fenced post-pass body is parsed with raw `JSON.parse` (mechanical finding 1.6) → empty findings reported as "completed". |
| **Restart or resume behavior** | Verify is read-only over the repo; post-pass slots are claimed under the state lock so a re-run does not double-pay (`claimRunSlot`, `resetRunPostPasses`). |

`observed fact`: `core/broadside/verify.ts`, `core/broadside/collect.ts`;
`external-behavior claim` for the provider's tool-call/reasoning behavior.

### P12. Pi sub-agent execution and compaction events

| Field | Value |
|---|---|
| **Producer** | `extensions/codecarto/agent-runner.ts` (`createAgentSession`) and `phase-compaction.ts` |
| **Consumer** | The Pi SDK `AgentSession` event stream; the orchestrator TUI |
| **Transport or carrier** | In-process event subscription (`AgentSessionEvent`) + file-backed sessions under `~/.pi/agent/sessions/…` |
| **Ordering guarantees** | One `AgentSession` per phase, run sequentially; the session name is `CodeCartographer phase: <phaseId>` (`appendSessionInfo`), which the compaction hooks key on. Compaction: `session_before_compact` returns phase-aware instructions, `session_compact` writes the checkpoint. |
| **Required fields** | Session name must match `^CodeCartographer phase: ([A-Za-z0-9][A-Za-z0-9._-]*)$` for the bash-block/write-confinement/checkpoint hooks to apply. |
| **Optional fields** | `primaryOutput` for the continuation prompt; model/API-key availability for compaction (absent → host default). |
| **Identifiers and timestamps** | Phase id from the session name; checkpoint frontmatter `phase`, `updated_at`, `tokens_before`, `source: pi-compaction`. |
| **Error cases** | Compaction unavailable → warning + host default, never a phase failure. Dispose failures are swallowed. Re-entry blocked by `isPhaseRunning`. |
| **Restart or resume behavior** | `/resume` reopens a file-backed session; `buildPhasePrompt` points a resumed session at `scratch/checkpoints/<phase>.md`; `shouldContinuePhase` re-prompts when the provider stops with a `toolResult`/`toolUse` tail and the primary output is absent. |

`observed fact`: `agent-runner.ts`, `phase-compaction.ts`, `auto-runner.ts`. Whether Pi execution
and an MCP host's own execution produce equivalent **outcomes** is an `external-behavior claim` →
`q-pi-sdk-execution-parity`, `verify at runtime`.

### P13. `git` subprocess protocol

| Field | Value |
|---|---|
| **Producer** | `core/library.ts` (`runGit`, `resolvePublishSourceRepo`, `commitPublish`), `core/broadside/repo.ts` |
| **Consumer** | The `git` binary on `PATH` |
| **Transport or carrier** | `spawn`/`execFile` with `stdio: ["ignore","pipe","pipe"]`, `timeout: GIT_TIMEOUT_MS = 30_000` |
| **Ordering guarantees** | Library publish **never** runs git; only `commitPublish` (exported, uncalled by surfaces) and source-repo resolution do. Broad-Side reads HEAD/dirty/ls-files. |
| **Required fields** | Command + args; `-C <dir>` for Broad-Side repo reads. |
| **Optional fields** | None. |
| **Identifiers and timestamps** | Commit SHA / remote URL / branch names verbatim; `\0`-separated `ls-files` output. |
| **Error cases** | Timeout or spawn error → `{ok:false, …}`/fallback to the directory path; never throws from `resolvePublishSourceRepo`; `commitPublish` returns `skipped` reasons. |
| **Restart or resume behavior** | Read-only for repo inspection; publish is a filesystem op the user commits/pushes manually. |

`observed fact`: `core/library.ts`, `core/broadside/repo.ts`; `external-behavior claim` +
`portability hazard` for git's presence and POSIX-shaped output (`q-node-windows-fs-semantics`,
finding 6.4), `verify at runtime`.

### P14. Dashboard artifact (workspace → HTML + embedded JSON)

| Field | Value |
|---|---|
| **Producer** | `core/dashboard-writer.ts` `writeDashboard` → `core/dashboard.ts` `renderDashboard` |
| **Consumer** | A human browser (file://), and the embedded JSON export |
| **Transport or carrier** | One self-contained `.codecarto/dashboard.html` (inline `<style>` and `<script>`; no external assets) |
| **Ordering guarantees** | Sections render in fixed order (see §cf-contracts-2). Best-effort: any gather/render/write failure returns `false`; callers decide whether to surface it. |
| **Required fields** | Workspace state (`status.yaml` + pipeline), usage file, closeouts list, output-presence map, package version, `generatedAt`. |
| **Optional fields** | Narration (`.dashboard-narration.local.md`), staleness warning, post-pipeline section, timeline session column. |
| **Identifiers and timestamps** | `generatedAt` ISO; narrative `generatedAt` + `phaseCountAtGeneration`; phase anchors `phase-<id>`; closeout date `YYYY-MM-DD`. |
| **Error cases** | Swallowed to `false`; MCP names failure, Pi reports success unconditionally (mechanical finding 2.1). |
| **Restart or resume behavior** | Regenerated on init, completion, amendment, pipeline switch, phase run, and on demand; idempotent. |

`observed fact`: `core/dashboard.ts`, `core/dashboard-writer.ts`. Full body catalog in
§cf-contracts-2.

### P15. Config propagation (files → runtime)

| Field | Value |
|---|---|
| **Producer** | User (config files), `writeLibraryConfig` (`core/orchestrator-config.ts`), `loadBroadsideConfig` |
| **Consumer** | Orchestrator/library loader, Broad-Side, pipeline engine |
| **Transport or carrier** | Hand-rolled YAML: `~/.codecarto/config.yaml` (or `CODECARTO_USER_CONFIG_PATH`), `.codecarto/workflow/config.yaml`, `.codecarto/broadside/config.yaml`, `workflow/pipeline*.yaml` |
| **Ordering guarantees** | Orchestrator/library: workspace > user-global > defaults, per key. Broad-Side: per-call parameter > config key > shipped default. Pi flag overrides (`--llm-steer`/`--no-llm-steer`, `--incremental`/`--no-incremental`) win per invocation. |
| **Required fields** | None; an absent file yields defaults. |
| **Optional fields** | See §Persistent Schema Notes → Config. |
| **Identifiers and timestamps** | File paths only; `ConfigProblem.path` names the offending file. |
| **Error cases** | Orchestrator/library: a fault is dropped **per key** and recorded in `problems`; the loader never throws; publish + library tools refuse while `problems` is non-empty. Broad-Side: a present-but-unparseable file throws `BroadsideConfigError` and refuses every action except `status`; `reasoning.effort` + `reasoning.max_tokens` together is refused at load. |
| **Restart or resume behavior** | Read per operation (no hot reload, no restart requirement — each tool call re-reads). |

`observed fact`: `core/orchestrator-config.ts`, `core/broadside/state.ts`, `core/pipeline.ts`.
Catalog detail in `findings/config-model/config-model.md`.

### P16. YAML dialect (file transport for workflow data)

| Field | Value |
|---|---|
| **Producer** | `stringifySimpleYaml` (`core/yaml.ts`) |
| **Consumer** | `parseSimpleYaml` / `loadYamlFile` |
| **Transport or carrier** | Text files: `status.yaml`, handoffs, amendments, pipeline definitions, config, library `metadata.yaml`/`index.yaml` |
| **Ordering guarantees** | Key order preserved on write; readers are tolerant of hand edits. **Not** a full YAML parser. |
| **Required fields** | Written: block mappings/sequences, scalars, nested maps. Read additionally: single-quoted strings, `|`/`>` block scalars with any chomping, wrapped/next-line plain scalars, same-column sequences, sequences of sequences, `#` comments. |
| **Optional fields** | Not read: flow sequences (`[a, b]` parses as a string and is dropped where an array is expected), flow mappings, anchors/aliases, tabs in indentation (error), multi-document streams. |
| **Identifiers and timestamps** | Scalars round-trip-checked: a string is written bare only if the reader returns the same string; `"2048"`, `"true"`, `"null"`, `"1.5"`, `"-"` are quoted (`formatYamlScalar`). |
| **Error cases** | Parse errors name the line, quote it, and name the expected construct; duplicate mapping keys are refused; `__proto__` assignment is guarded in `parseMapping` (`Object.defineProperty`), but **not** in `parseSequence`'s nested merge (mechanical finding 1.3). |
| **Restart or resume behavior** | Deterministic; no version marker of its own. |

`observed fact`: `core/yaml.ts`; `portability hazard` for any port that substitutes a full YAML
library (semantics differ on flow collections, duplicate keys, and scalar coercion). Cataloged in
`docs/library-format.md` "YAML dialect".

### P17. Filesystem lock + atomic-rename protocol

| Field | Value |
|---|---|
| **Producer** | `acquireLock` / `releaseOwnedLock` / `withRemovalLock` (`core/status.ts`), `atomicWriteFile` (`core/utils.ts`) |
| **Consumer** | `status.yaml`, usage log, Broad-Side `state.json`, library publish (`.publish.lock`) |
| **Transport or carrier** | Lock files recording `pid\nISO timestamp\ntoken\n`; sibling temp file + `rename` |
| **Ordering guarantees** | `open(path,"wx")` (O_EXCL) is the mutual-exclusion primitive; every **removal** (release or stale break) runs under `<lock>.break` and re-checks what it will remove; a release only removes a lock carrying its own token. |
| **Required fields** | Lock content lines: pid (line 0), ISO timestamp (line 1), token (line 2). |
| **Optional fields** | None. |
| **Identifiers and timestamps** | Token `${pid}.${randomBytes(8)}`; `mtimeMs` staleness; `LOCK_TIMEOUT_MS=5000`, `LOCK_RETRY_MS=125`, `STALE_LOCK_MS=60_000`, `BREAK_LOCK_STALE_MS=5000`. |
| **Error cases** | Timeout → throw `Timed out waiting for lock`; a lock that cannot be read is left to go stale rather than removed unverified. `atomicWriteFile` removes the temp and rethrows on failure. |
| **Restart or resume behavior** | A lock older than 60 s is broken; `brokeStale` reports the previous holder. Temp files are best-effort removed; leftovers match `*.tmp`. |

`observed fact`: `core/status.ts`, `core/utils.ts`. **`portability hazard`, action
`verify at runtime`**: `rename` over an existing destination and O_EXCL semantics differ on
Windows (`q-node-windows-fs-semantics`, mechanical findings 6.1–6.2).

---

## State Machine

### SM1. Pipeline cursor (the phase gate)

States are derived, not stored, from `phase.status` values plus the DAG. The **only** stored
cursor fields are `status.yaml`'s `current_phase` and `next_actions`, both recomputed by
`recomputeCursor`.

| Current state | Event / trigger | Guard | Next state | Side effects |
|---|---|---|---|---|
| any | `recomputeCursor` runs (init, completion, switch, amendment) | an incomplete phase has all `depends_on` complete | `eligible` | `current_phase = phase.id`; `next_actions = [beginPhaseAction]` |
| any | same | all phases `complete` | `complete` | `current_phase = "complete"`; terminal `next_actions` (skills/amend/publish/dashboard/usage) |
| any | same | no phase eligible and some incomplete | `stuck` | `current_phase =` first blocked phase; `next_actions = [describeStuckPipeline]` |
| `eligible` | `validate` PASS/PASS WITH GAPS | `## Validation` parses | unchanged | none |
| `eligible` | `complete` | validation not FAIL/MISSING, under the lock | phase → `complete`; cursor advances | status rename (commit point), then closeout/THREAD_LOG/decisions/conventions/dashboard |
| `eligible` | `complete` | validation FAIL/MISSING, missing handoff, bad `target_phase`, missing `post_pipeline.id`, D1/D3 violation | unchanged | refusal; nothing written |
| `stuck` | `next` | — | unchanged | MCP returns `InvalidRequest` (not text) so a host cannot mistake it for done; Pi notifies |
| `complete` | `amend` | pipeline complete | `complete` | open-question/post-pipeline ids removed; closeout + THREAD_LOG; dashboard |

`observed fact`: `core/pipeline.ts` `resolvePipelineOutcome`/`recomputeCursor`;
`core/completion.ts`; `core/amendment.ts`. Note there are only **three** outcomes, not two:
the `stuck` state was added so a DAG with an unmet dependency is not read as complete.

### SM2. Phase completion (validate → commit → afterCommit)

| Current state | Event / trigger | Guard | Next state | Side effects |
|---|---|---|---|---|
| unvalidated | `codecarto_complete` | primary output exists and `## Validation` parses to PASS / PASS WITH GAPS | locked-validating | acquires `status.yaml.lock`; **re-validates under the lock** |
| locked-validating | re-validation result | overall FAIL/MISSING | unchanged | throw; lock released; nothing written |
| locked-validating | re-validation result | PASS / PASS WITH GAPS | committing | builds next status; applies handoff; turns untracked PARTIAL rows into `needs-maintainer-decision` questions; recomputes cursor |
| committing | `atomicWriteFile(statusPath)` | rename succeeds | committed | **commit point** — status change stands |
| committed | `afterCommit` | — | complete | canonical closeout, link-deduped THREAD_LOG line, text-deduped decision rows, staged convention proposals; a failure here throws but the status change stands, repaired by re-running |
| any | `switch_pipeline` | — | cursor recomputed | preserves shared phase records, drops old-only phases (findings stay on disk), moves dangling carry-forwards to `post_pipeline` |

`observed fact`: `core/completion.ts` `completeValidatedPhase`; `core/workspace.ts`
`updateStatusAtomically`; CONVENTIONS C02.

### SM3. Advisory lock

| Current state | Event / trigger | Guard | Next state | Side effects |
|---|---|---|---|---|
| free | `open(lockPath,"wx")` | succeeds | held | write pid/timestamp/token; return token-checked release |
| held | `open` | `EEXIST` and lock age ≤ 60 s | held | sleep 125 ms, retry until 5 s → throw |
| held | `open` | `EEXIST` and lock age > 60 s | breaking | `withRemovalLock` takes `<lock>.break` |
| breaking | `withRemovalLock` | takes `<lock>.break` | re-checking | re-`stat` the lock; if still stale, remove and return the previous holder |
| re-checking | re-stat | no longer stale | held | fall through to wait (the holder released) |
| held | release | lock vanished | free | no-op |
| held | release | lock carries another token | held (other) | leave it |
| held | release | lock carries own token | free | remove under `<lock>.break`; if the removal lock times out, token-checked removal alone |

`observed fact`: `core/status.ts`; the stale-break and removal-lock mechanics are the fix for the
race the mechanical phase routed as `cfs-mech-1`/`cfs-mech-2`. The mutual-exclusion guarantee on
non-POSIX is `verify at runtime` (`q-node-windows-fs-semantics`).

### SM4. Broad-Side run and spending slots

| Current state | Event / trigger | Guard | Next state | Side effects |
|---|---|---|---|---|
| (none) | `submit` | estimate under `max_cost` (or `force`) | run `in-flight` | run persisted; per-lens batches submitted; `requests.json` written; endpoints memory updated |
| `in-flight` | `collect` polls a lens batch | status `completed` | batch terminal | results saved (`<customId>.json/.md`); `raw-<lens>.json` |
| `in-flight` | poll | status in `{failed,expired,cancelled,auth-failed}` | batch dead | recorded, not retried |
| `in-flight` | budget/abort | budget spent or signal aborted | synthetic `timeout` | still running server-side, claimable later |
| `in-flight` | all lens batches terminal | — | post-passes | `synthesis`/`triage` slots claimed under the state lock before any network call |
| slot `pending` | `claimRunSlot` | slot unclaimed on disk | slot `submitted` | no batch id yet; owned by this collect |
| slot `submitted` | poll settles | completed | slot `completed` | `synthesis.json/.md` / `triage.json/.md` written; cost recorded |
| slot `submitted` | another collect | — | adopted | its entry copied into this run; no double-submit |
| any | `regenerate_post_passes` | pass settled | slot `pending` | old cost moved to `retiredCost`; re-run next collect |
| `in-flight` | no batch has an id | — | `failed` | status listing cannot show a phantom in-flight run |
| terminal | `verify` | — | `verify` entry written | `verified.json`/`.md`; `run.verify` recorded; merged slot-by-slot |

`observed fact`: `core/broadside/{submit,collect,state,verify}.ts`. Remote status vocabulary is an
`external-behavior claim` (`q-openrouter-batch-semantics`).

### SM5. Library publish

| Current state | Event / trigger | Guard | Next state | Side effects |
|---|---|---|---|---|
| validate | `publishEntry` | marker exists; slug valid; namespaced↔namespace consistent | guarded | acquires `.publish.lock` in the library root |
| guarded | source-repo check | recorded repo equals incoming (normalized), or override | guarded | — |
| guarded | source-repo check | mismatch | refused | `SourceRepoMismatchError`; nothing written |
| guarded | confidentiality check | entry ≥ library visibility, or override | choosing | — |
| guarded | confidentiality check | entry more restricted | refused | `ConfidentialityMismatchError`; nothing written |
| choosing | content hash | latest spec bytes equal incoming, no `force_new_version` | metadata-only | rewrite `v<N>/metadata.yaml` carrying provenance forward; reindex |
| choosing | content hash | new bytes | staging | write spec+metadata under `<entry>.publish.<suffix>/` |
| staging | `rename(staging, v<N+1>)` | succeeds | versioned | rewrite `latest` (`v<N+1>\n`); reindex |
| staging | rename fails | — | unchanged | best-effort `rm` staging; rethrow |

`observed fact`: `core/library.ts` `publishEntry`/`previewPublishVersion`. The staging rename and
pointer write are `portability hazard` (`q-node-windows-fs-semantics`, findings 6.1–6.2).

### SM6. Amendment

| Current state | Event / trigger | Guard | Next state | Side effects |
|---|---|---|---|---|
| pre-check | `applyAmendment` | workspace exists; amendment file parses and is non-empty | acquiring | — |
| acquiring | under `status.yaml.lock` | pipeline complete on the **locked** read | applying | — |
| acquiring | under the lock | pipeline eligible or stuck | refused | `Cannot amend`; nothing written (this is the fix for the pre-lock race) |
| applying | closures loop | id matches | committed | id removed from every phase / `post_pipeline`; terminal `next_actions` rebuilt; `last_updated` set |
| committed | `afterCommit` | — | complete | amendment closeout `<date>-amendment-<slug>.md`; one link-deduped THREAD_LOG entry; dashboard refresh |

`observed fact`: `core/amendment.ts`.

### SM7. Pi sub-agent / auto loop

| Current state | Event / trigger | Guard | Next state | Side effects |
|---|---|---|---|---|
| idle | `/codecarto-next` | `!isPhaseRunning(phase.id)` | running | spawn `AgentSession` named `CodeCartographer phase: <id>`; widget attached |
| running | session prompts | provider stops with tool tail and primary output absent | continuing | `session.prompt(buildPhaseContinuationPrompt(...))` |
| running | compaction | `session_compact` fires | running | checkpoint written to `scratch/checkpoints/<phase>.md`; telemetry accumulated |
| running | session settles | aborted by `ctx.signal` | aborted | dispose in `finally`; usage run recorded with status `aborted` |
| running | session settles | completed | validating | `validatePhaseOutput` |
| validating | `decideAfterPhase` | valid, or `--strict` and PASS WITH GAPS | completing | `autoCompletePhase` commits; loop continues |
| validating | `decideAfterPhase` | FAIL/MISSING, or `--strict` gap | stopped | loop ends; recovery hint printed |
| any | auto loop | `ctx.signal.aborted` | aborted | stop, report reason |
| any | cursor | stuck | stuck | loop ends; stuck sentence |

`observed fact`: `extensions/codecarto/{agent-runner,auto-runner}.ts`. Outcome parity with an
MCP host is `q-pi-sdk-execution-parity`, `verify at runtime`.

---

## Persistent Schema Notes

This section is the field-by-field catalog routed here by `cf-arch-2`. Types cite the TypeScript
declarations they mirror; readers are quoted because the framework tolerates hand edits.

### status.yaml — `.codecarto/workflow/status.yaml`

Writer: init, completion, pipeline switch, amendment. Reader: every surface. Mutable, rewritten
in place under the status lock through `atomicWriteFile`. `schema_version` read rejects >1;
write (`assertCanonicalStatus`) requires exactly `1`.

```yaml
project_name: selfreview          # string; defaults to basename(cwd)
pipeline: workflow/pipeline-full-with-deep-audit.yaml   # workspace-relative
current_phase: protocols          # phase id, or "complete"
last_updated: "2026-09-15T05:04:41.954Z"   # ISO; "" until first completion
schema_version: 1
phases:
  <phase-id>:
    status: pending               # pending | complete | partial | in-progress (any string tolerated)
    owner_notes: [string]
    outputs_present: [string]      # workspace-relative primary output paths
    open_questions:
      - id: q-example              # optional; auto-assigned oq-<phase>-N if absent
        kind: needs-runtime-test   # optional; see OPEN_QUESTION_KINDS
        description: string
        deferred_reason: string
    carry_forward:
      - id: cf-example             # optional; auto-assigned cf-<phase>-N if absent
        kind: defer-to-phase
        description: string
        deferred_reason: string
        target_phase: <phase-id>   # required for completion on a handoff entry
        derives_from: <open-question-id>   # optional; carry-forward only
next_actions: [string]             # one begin-phase line, the stuck sentence, or terminal routing
post_pipeline:
  - id: post-example               # required
    kind: spike
    description: string
    deferred_reason: string
    source_phase: <phase-id>       # defaulted from the handoff phase
    status: pending                # pending | resolved
```

`observed fact`: `core/types.ts` `StatusFile`/`NormalizedStatus`/`StatusPhase`; `core/status.ts`
`normalizeStatus`/`ensurePhaseRecord`/`ensurePostPipelineArray`; `core/workspace.ts`
`assertCanonicalStatus`. Tolerant reads: a non-array collection becomes `[]`; numeric/boolean
scalars are read as text (`textOf`); a missing phase record is created `pending`.

### Phase handoff — `.codecarto/scratch/handoffs/<phase>.yaml`

Writer: phase executor. Reader: completion. Consumed once, retained on disk; gitignored.

```yaml
schema_version: 1                   # >1 rejected
phase_id: protocols                 # required; must equal the validated phase
timestamp: "..."                    # optional/deprecated — ignored
owner_notes: [string]
open_questions: [{id?, kind?, description?, deferred_reason?}]
carry_forward: [{id?, kind?, description?, deferred_reason?, target_phase, derives_from?}]
carry_forward_closures: [<id>]
open_question_closures: [<id>]      # or [{id, evidence}]
post_pipeline: [{id, kind?, description?, deferred_reason?, source_phase?, status?}]
decisions: [string]
proposed_conventions: [{name, rule, evidence?}]   # name+rule required
closeout_summary: string
closeout_content: |-                # optional full Markdown
  # Closeout — protocols
```

`observed fact`: `core/types.ts` `PhaseHandoff`/`ClosureEntry`/`ProposedConventionEntry`;
`core/status.ts` `parseHandoff`/`ensureClosureArray`/`ensureProposedConventionArray`.
`ensureClosureArray` accepts both a bare string (`{id}`) and `{id, evidence}`; a `needs-runtime-test`
question needs non-empty `evidence` to close on scaffold ≥0.19.0 (`core/completion.ts`).
`template`: `.codecarto/templates/phase-handoff.yaml`.

### Amendment — `.codecarto/scratch/amendments/<slug>.yaml`

Writer: user/agent. Reader: `applyAmendment`. Post-pipeline only; gitignored.

```yaml
schema_version: 1                   # >1 rejected
open_question_closures: [<id>]
post_pipeline_closures: [<id>]
notes: [string]
closeout_summary: string
closeout_content: |-                # optional; generated when omitted
  # Amendment — <slug>
```

`observed fact`: `core/amendment.ts` `Amendment`/`loadAmendmentFile`;
`templates/amendment.yaml`. At least one closure/note is required; ids that match nothing are
reported in `unknownIds`.

### Broad-Side state — `.codecarto/broadside/state.json`

Writer: `saveBroadsideState` (whole-file) and `persistBroadsideRun`/`persistBroadsideRunMerging`/
`claimRunSlot`/`resetRunPostPasses` (read-modify-write under `state.json.lock`). Reader: every
Broad-Side action. Machine-local; gitignored. JSON, not YAML.

```jsonc
{
  "schema_version": 1,                 // BROADSIDE_STATE_SCHEMA_VERSION
  "runs": [
    {
      "id": "2026-09-15T05-04-41-954Z",   // ms ISO with ":"/"." replaced by "-"
      "createdAt": "2026-09-15T05:04:41.954Z",
      "model": "google/gemini-3.7-flash:batch",
      "lenses": ["architecture","api","security","defect","conventions","porting"],
      "status": "in-flight",              // in-flight | completed | partial | failed
      "outputDir": "<run-id>",            // relative to .codecarto/broadside/
      "batches": { "<lensId>": {
        "batchId": "string", "requests": 1, "status": "string",
        "submittedAt": "ISO", "completedAt": "ISO?",
        "estimatedCost": 0.0, "cost": 0.0, "resultCount": 0,
        "error": {}, "reason": "string?", "fallback": "string?",
        "model": "string?", "outputCap": 65536
      }},
      "synthesis": { "batchId?": "string", "status": "pending|submitted|completed|failed",
                     "cost?": 0.0, "error?": "string", "verdicts?": 0 },
      "triage":    { "same shape as synthesis" },
      "retry?":    { "status": "submitted|completed|failed",
                     "batches": [{"model":"string","batchId":"string"}],
                     "claimedAt": "ISO", "cost?": 0.0 },
      "verify?":   { "status": "completed|partial", "model": "string", "top": 10,
                     "verified": 0, "confirmed": 0, "cost": 0.0, "at": "ISO" },
      "retiredCost?": 0.0, "totalCost?": 0.0,
      "pricing?": { "inputPerM": 0.0, "outputPerM": 0.0, "source": "built-in|config|live|cache" },
      "maxCost?": 1, "outputCap?": 65536,
      "sourceHead?": "sha|null", "sourceDirty?": false, "baseHead?": "sha|null",
      "snapshot?": "working-tree|walk", "language?": "string",
      "redaction?": { "enabled": true, "values": 0, "files": 0, "skippedFiles": 0 }
    }
  ]
}
```

`observed fact`: `core/broadside/types.ts` `BroadsideStateFile`/`BroadsideRun`/`BroadsideBatchEntry`/
`BroadsideSynthesisEntry`/`BroadsideRetryEntry`/`BroadsideVerifyEntry`; `core/broadside/state.ts`;
`core/broadside/constants.ts` `BROADSIDE_STATE_SCHEMA_VERSION = 1`. Corruption handling: a
`state.json` that does not parse or lacks a `runs` array throws `BroadsideStateError` and is
copied to `state.json.corrupt-<sha1-8>` before anything can overwrite it.

### Broad-Side run directory — `.codecarto/broadside/<run-id>/`

Writer: submit/collect/verify. Reader: collect resume, verify, the skill. Machine-local.

| File | Shape | Writer |
|---|---|---|
| `requests.json` | `Record<customId, BatchRequest>` — the exact requests submitted | submit |
| `raw-<lensId>.json` | the raw polled batch object (including `results[]`) | collect |
| `<sanitizedCustomId>.json` | parsed lens JSON, or the raw content verbatim when unparseable | collect |
| `<sanitizedCustomId>.md` | `renderFindingsMarkdown` of the same content | collect |
| `<sanitizedCustomId>.error.json` | the per-request `error` object | collect |
| `synthesis.json` / `synthesis.md` | parsed `synthesis_report` content / rendered markdown | collect |
| `triage.json` / `triage.md` | parsed `triage_report` content / rendered markdown | collect |
| `verified.json` | `{status, model, top, verified, confirmed, cost, at, run_id, candidates, findings:[{index,title,location,verdict,confidence,evidence:[{file,lines,note}],reasoning,toolCalls,cost}]}` | verify |
| `verified.md` | verdict report | verify |
| `run-meta.json` | `{experimental:true, method, model, pricing, max_cost, run_id, created_at, status, total_cost, result_count, truncated_count, retried_count, synthesis, triage, lenses, lens_models, disclaimer}` | collect |

`observed fact`: `core/broadside/{submit,collect,verify,results}.ts`. `loadSavedLensResults`
rebuilds lens results from `<id>.json` files, treating `requests.json`, `run-meta.json`,
`synthesis.json`, `triage.json` and `raw-*` as reserved.

### Broad-Side config — `.codecarto/broadside/config.yaml`

```yaml
model: google/gemini-3.7-flash:batch
api_key: ""                          # may hold a key; template ships this file TRACKED (stated risk)
default_lenses: [architecture, api, security, defect, conventions, porting]
max_cost: 1                          # USD; 0 = no limit; negative/non-numeric → default
pricing: { input_per_m: 0.375, output_per_m: 1.875 }   # both required to take effect
lens_models: { security: "…:batch" }
reasoning: { effort: low }           # or { max_tokens: N }; NOT both
incremental: false
retry_truncated: true
include_synthesis: true
include_triage: true
wait_seconds: 0
redact_secrets: true
```

`observed fact`: `core/broadside/state.ts` `loadBroadsideConfig`/`buildBroadsideConfig`;
`core/broadside/constants.ts`. An absent file yields defaults; an unreadable one throws
`BroadsideConfigError`; malformed booleans/numbers silently fall back to shipped defaults.

### Library marker — `<library>/.codecarto-library`

Writer: `writeMarker`/`initLibrary`. Reader: `readMarker`/`discoverLibrary`. JSON.

```json
{ "schema_version": 1, "name": "james-personal-library", "namespaced": true,
  "visibility": "internal", "created_at": "2026-05-14T18:32:00.000Z" }
```

`observed fact`: `core/library.ts` `LibraryMarker`/`normalizeMarker`. Read-tolerant: missing
`name` → `"codecarto-library"`, missing `namespaced` → `false`, missing `schema_version` → 1, an
invalid `visibility` dropped, a non-object treated as "no library".

### Library metadata.yaml

Writer: `publishEntry` (`buildMetadata`). Reader: `readEntry`, `reindex`, guards. Mutable only by
a metadata-only re-publish; provenance carried forward.

```yaml
slug: hexbridge
version: 2
source_repo: "https://github.com/myorg/hexbridge"
analyzed_at: "2026-05-14T14:00:00.000Z"
pipeline: workflow/pipeline-full-with-deep-audit.yaml
codecarto_version: 0.25.0
headline: "..."
tags: []
capabilities: []
generation: { surface: pi-extension|mcp-server|drop-in, agent: "", agent_version: "",
              model: "", model_vendor: "", reasoning: high|medium|low|default|unknown, notes: "" }
namespace: james                     # present iff the library is namespaced
source_commit: "abc1234"             # optional (MCP host-passed)
source_branch: main                  # optional
source_dirty: false                  # optional
scope_tier_counts: { p0: 4, p1: 7, p2: 3 }   # optional; no surface writes it today
confidentiality: internal            # optional; internal|shared|public
provenance: { prior_version: 1, mutation_source: null }
```

**No `schema_version`** — the marker's versions the shape. `observed fact`: `core/library.ts`
`EntryMetadata`/`buildMetadata`/`normalizeMetadata`. Read requires ≥1 non-empty string among
`slug`, `source_repo`, `headline`, `pipeline`, else malformed; unknown keys are ignored and not
preserved on rewrite.

### Library index.yaml

Writer: `reindex`. Reader: `listEntries` (prefers an existing parseable index). Derived; never
hand-edited.

```yaml
schema_version: 1
library_name: james-personal-library
generated_at: "2026-05-14T19:02:00.000Z"
entry_count: 14
namespaces: [james]
entries:
  - slug: hexbridge
    latest_version: 2
    versions: [1, 2]
    source_repo: "..."
    headline: "..."
    tags: []
    capabilities: []
    confidentiality: internal          # only when present on the newest metadata
    last_analyzed_at: "..."
    last_codecarto_version: 0.25.0
    namespace: james                   # only on a namespaced library
```

`observed fact`: `core/library.ts` `LibraryIndex`/`LibraryIndexEntry`/`buildIndexEntry`/`reindex`.
`entries[]` is sorted by `(namespace, slug)`. Provenance conflicts are **reported on the return
value only**, never written into the index. The `latest` pointer is a **regular file** containing
`v<N>\n` (`LATEST_POINTER_FILE`), written by temp+rename.

### Usage log — `.codecarto/workflow/.usage.local.yaml`

Writer: Pi runner and MCP completion (`appendUsageRun`). Reader: `/codecarto-usage`, dashboard.
Append-only under `path.lock`; a corrupt log refuses appends.

```yaml
version: 1
runs:
  - timestamp: "ISO"
    phase: protocols
    status: completed            # completed | aborted | error
    turn_count: 0
    tool_uses: 0
    duration_ms: 0
    tokens: { input: 0, output: 0, cache_write: 0 }
    session_file: "…"            # optional
    compactions: { successful: 0, failed: 0, aborted: 0,
                   reasons: { threshold: 0, overflow: 0, manual: 0 } }   # optional
    recorded_by: pi-runner       # optional; pi-runner | mcp-complete
```

`observed fact`: `core/usage.ts` `UsageFile`/`UsageRun`/`appendUsageRun`/`isUsageRun`. Totals are
computed on read; an entry failing `isUsageRun` is filtered out of the display but the file is not
rewritten empty.

### Scaffold marker — `.codecarto/workflow/scaffold-version.yaml`

```yaml
scaffold_version: 0.25.0         # string or number; read tolerantly
```

`observed fact`: `core/workspace.ts` `getWorkspaceState`; `describeScaffoldStaleness` compares it
to `PACKAGE_VERSION` with `compareDottedVersions`.

### Config files

Orchestrator/library (both layers share one shape):

```yaml
orchestrator: { llm_steer_next_phase: false }
library: { path: ~/codecarto-library, namespace: james, publish_confirm: true }
```

`observed fact`: `core/orchestrator-config.ts` `RawConfig`/`applyRaw`. `library.path` is
tilde-expanded and must be absolute; a relative value is a recorded problem. The loader reports
`problems[]`; publish and the library tools refuse while non-empty. Broad-Side config is above.

### Pipeline definition — `.codecarto/workflow/pipeline*.yaml`

```yaml
workflow_name: codebase-reverse-engineering-with-deep-audit
workflow_version: 1
workflow_goal: "..."
source_location: ../
validation_protocol: workflow/VALIDATE.md
phase_order: [architecture, defect-scan-mechanical, contracts, protocols, defect-scan-semantic, porting, reimplementation-spec]
phases:
  - id: protocols
    purpose: "..."
    skill_path: findings/protocols/SKILL.md
    output_template: templates/protocols-and-state.md
    depends_on: [architecture]
    primary_output: findings/protocols/protocols-and-state.md
    secondary_outputs: [{ path: findings/public-surfaces/public-surfaces.md, mode: append }, …]
    required_reads: [...]
    completion_criteria: [...]
    handoff_requirements: [...]
    preflight: [requires-vision-input | requires-library | requires-confirmed-proposal]
```

`observed fact`: `core/types.ts` `PipelineFile`/`PipelinePhase`; `core/pipeline.ts`. Aliases live
in `PIPELINE_ALIASES`.

### Model catalog cache — `.codecarto/broadside/model-catalog.json`

Writer: `writeCatalogCache`/`listBatchModels`. Reader: `resolveCatalogEntry`. Machine-local.

```jsonc
{ "schema_version": 3, "fetched_at": "ISO",
  "models": { "<id>": { "id": "…", "name": "…", "inputPerM": 0.375, "outputPerM": 1.875,
             "cachedInputPerM": 0.0, "contextLength": 0, "maxCompletionTokens": 0,
             "supportedParameters": [], "expirationDate": null, "fetched_at": "ISO" } } }
```

`observed fact`: `core/broadside/models.ts`. Schema 3 stamps each entry; a schema-2 file is still
read with the file stamp standing in for each entry; any other version is treated as absent.
TTL 24 h per entry.

### Batch-endpoint memory — `.codecarto/broadside/batch-endpoints.json`

```jsonc
{ "schema_version": 1,
  "models": { "<id>": { "status": "accepted|rejected", "at": "ISO", "error": "…" } } }
```

`observed fact`: `core/broadside/models.ts` `readBatchEndpoints`/`recordBatchEndpoints`. An
unreadable file is an empty memory (it only annotates a listing).

### Phase checkpoint — `.codecarto/scratch/checkpoints/<phase>.md`

Writer: Pi compaction (`writePhaseCheckpoint`). Reader: the resuming session (prompt points at it).

```markdown
---
phase: protocols
updated_at: ISO
tokens_before: 0
source: pi-compaction
---

# Phase checkpoint

<summary>
```

`observed fact`: `extensions/codecarto/phase-compaction.ts`; `templates/phase-checkpoint.md`.

### Persistence semantics (append vs mutable, compaction, replay, locking)

- **Mutable in place, atomic:** `status.yaml`, usage log, `state.json`, `metadata.yaml`,
  `index.yaml`, `latest`, marker, dashboard, checkpoint. Readers see old-or-new bytes, never a
  truncated file (`atomicWriteFile`). `observed fact`.
- **Append-only:** usage `runs[]` (each finished phase appends one entry); `THREAD_LOG.md` lines
  (link-deduped); `DECISIONS.md` rows (text-deduped); `CONVENTIONS.md` proposals (text-deduped).
- **Derived/regenerable:** `index.yaml`, `INDEX.md`, `dashboard.html`, run-meta files, model
  catalog cache.
- **Compaction/summarization:** the only compaction is host-driven (Pi SDK session compaction);
  the framework writes a checkpoint summary, it does not compact the artifacts. Dashboard
  narration is an opt-in cached summary with a stale count.
- **Replay/resume:** a handoff is consumed once but retained; a completed phase re-run is
  refused unless validation is redone; a Broad-Side `collect` is replayable (batches persist
  server-side); a publish re-run hits the content-hash branch; an amendment re-run reports
  already-closed ids.
- **Locking/dedup/conflict:** `status.yaml.lock` (completion/switch/amendment), usage `path.lock`,
  Broad-Side `state.json.lock`, library `.publish.lock`; lock removal is serialized by
  `<lock>.break`; publish dedups by SHA-256 of the spec; provenance conflicts are detected, not
  auto-repaired. Every lock/rename claim is `verify at runtime` on non-POSIX.

---

## Compatibility Hazards

| Hazard | Where It Appears | Severity | Notes |
|---|---|---|---|
| POSIX `rename` over an existing file | `core/utils.ts` `atomicWriteFile`; every in-place rewrite | high | `external-behavior claim`; no unlink+rename fallback. On Windows a locked destination can fail (`q-node-windows-fs-semantics`, mechanical 6.1). `verify at runtime`. |
| POSIX `O_EXCL` (`open(path,"wx")`) + `mtimeMs` staleness | `core/status.ts` `acquireLock` | medium | Mutual exclusion and stale-break assume POSIX sharing semantics (6.2). `verify at runtime`. |
| Symlink-aware containment / case folding | `core/utils.ts` `resolveExistingPrefix`/`isWithinPath`, Pi `tool_call` guard | medium | Windows junctions, 8.3 short names, drive-relative paths (6.3). `verify at runtime`. |
| Bare `git` on `PATH` + POSIX-shaped output | `core/library.ts`, `core/broadside/repo.ts` | medium | `\0`/`\n`-separated, `/`-separated paths (6.4). `verify at runtime`. |
| Hand-rolled YAML subset | `core/yaml.ts`; every workflow file | medium | Not a full parser: flow collections silently become strings, tabs are errors, duplicate keys refused. A port that swaps in a real YAML library changes coercion and duplicate-key semantics. |
| `__proto__` in a sequence-item mapping | `core/yaml.ts:487` | low | Bypasses the `defineProperty` guard used in `parseMapping` (mechanical 1.3). `port differently`. |
| OpenRouter Batch API semantics | `core/broadside/client.ts` | high | Quota (`job-submission-count`), which ids have `:batch`, reasoning acceptance — `external-behavior claim` (`q-openrouter-batch-semantics`). `verify at runtime`. |
| Node `fetch`/`AbortSignal.timeout` | `core/broadside/*`, `mcp-server/server.ts` | medium | Runtime-provided; a target without `fetch` needs a shim. `portability hazard`. |
| `process.stdin` end/close detection | `mcp-server/server.ts` `startStdioServer` | low | The SDK transport never sees stream end; the server adds `stdin` listeners. `portability hazard`. |
| Advisory locks are not re-entrant or fair | `core/status.ts` | low | One holder per path; a second in-process waiter blocks up to 5 s. |
| ANSI/TUI assumptions | `extensions/codecarto/*` widget | low | Terminal rendering and completions are Pi-surface only; the drop-in and MCP paths do not need them. |
| ISO timestamps as identifiers | `core/broadside/submit.ts:254` run id | low | Two submits in the same millisecond collide; `persistBroadsideRun` overwrites by id (mechanical 1.5). `port differently`. |
| Byte-size vs code-unit slicing | `core/broadside/repo.ts` | low | `stat().size` (bytes) feeds slice-mode choice but slicing caps `block.length` (chars) (mechanical 1.4). `port differently`. |
| Secret redaction is heuristic | `core/secrets.ts` | medium | Accident mitigation, not a scanner; Broad-Side uploads depend on it. A port must not weaken it. |
| HTML link-escaping is a boundary | `core/dashboard.ts` `safeRelativeHref` | low | Rejects absolute/URL/`.`/`..`; percent-encodes each segment. Removing the encoding reopens a Windows-`\..\` traversal (the code says so explicitly). |

---

## Routed Item Closures

### cf-arch-2 — field-by-field serialized shapes (CLOSED)

`cf-arch-2` asked for the exact serialized shapes of `status.yaml`, `scratch/handoffs/<phase>.yaml`,
`scratch/amendments/<slug>.yaml`, Broad-Side `state.json`, and library `metadata.yaml`/`index.yaml`.
§Persistent Schema Notes specifies each field-by-field, with the TypeScript declaration and the
reader/writer it mirrors, plus the sibling formats (marker, latest, usage, catalog, endpoints, run
files, checkpoint, config, pipeline). Catalog-level detail is appended to
`findings/state-and-storage/state-and-storage.md §2026-09-15 — protocols phase` and the protocol
map to `findings/runtime-lifecycle/runtime-lifecycle.md`. Closure recorded in the phase handoff as
`carry_forward_closures: [cf-arch-2]`.

### cf-contracts-1 — `docs/library-format.md` vs `core/library.ts` (CLOSED)

`cf-contracts-1` asked whether `docs/library-format.md`, the declared authoritative library ABI,
matches what `core/library.ts` reads and writes. **It does**, by reading the doc against the code:

| Doc claim | Code | Verdict |
|---|---|---|
| Detected by `.codecarto-library`; nothing about the parent path interpreted | `discoverLibrary`/`readMarker` | match |
| Marker JSON: `schema_version`, `name`, `namespaced` required; `visibility`, `created_at` optional; tolerant read | `LibraryMarker`/`normalizeMarker` | match |
| Layout `entries/[<ns>/]<slug>/latest` + `v<N>/{reimplementation-spec.md,metadata.yaml}`; `latest` a regular file containing `v<N>\n` | `entryRoot`/`versionDir`/`writeLatestPointer`/`readLatestPointer` | match |
| `metadata.yaml` fields and required/optional split; **no** `schema_version`; `generation` 7 keys with drop-in defaults; `namespace` iff namespaced; `provenance.prior_version` null at v1, `mutation_source` null | `EntryMetadata`/`buildMetadata`/`normalizeMetadata`/`normalizeGeneration` | match |
| Read requires ≥1 of `slug`/`source_repo`/`headline`/`pipeline`; unknown keys ignored, not preserved | `normalizeMetadata` `requiredOneOf` | match |
| `index.yaml` schema + entry fields; built from the **newest version directory**, not the pointer; sorted `(namespace, slug)`; `INDEX.md` links to `v<N>/` | `reindex`/`buildIndexEntry`/`writeIndexMarkdown` | match |
| Version resolution: read `latest`, trim, expect `v<N>`; fall back to highest `v<N>` when missing/empty/invalid; a dangling-but-parseable pointer is an error (no fallback) | `readEntry` | match |
| Idempotence order (validate → source guard → content-hash branch → stage → rename → pointer → reindex); `force_new_version` skips the hash branch but not the guards | `publishEntry`/`previewPublishVersion` | match |
| Source-repo normalization (scheme, userinfo, SCP, default port, `www.`, `.git`, slashes, host/Windows case; POSIX path case preserved); conflict refused with `SourceRepoMismatchError` | `normalizeSourceRepo`/`sameSourceRepo` | match |
| Confidentiality ordering `internal < shared < public`; absent = internal; refuse entry below library; `ConfidentialityMismatchError` | `VISIBILITY_RANK`/guard | match |
| Git: publish never runs git; `commitPublish` exported, never pushes | module header + `commitPublish`; neither surface calls it | match |
| Slug rules (`^[a-z][a-z0-9-]{0,63}$`, reserved `latest`/`index`/`entries`) and derivation | `SLUG_RE`/`RESERVED_SLUGS`/`deriveSlug` | match |
| Schema versioning table (optional field no bump; required/rename/semantic major bump) | `MARKER_SCHEMA_VERSION`/`INDEX_SCHEMA_VERSION` = 1 | match |
| YAML dialect written/read lists | `core/yaml.ts` | match |

Two **cosmetic** drifts, both in placeholder naming only, neither a shape mismatch:

1. The doc describes the publish staging directory as `<slug>.publish.<pid>.<timestamp>`; the code
   uses `<entryDir>.publish.<pid>.<sequence>.<random-hex>` (`uniqueTempSuffix`). The doc's
   `.gitignore` advice (`*.publish.*`) covers it.
2. The doc describes atomic temp siblings as `<file>.<pid>.<timestamp>.tmp`; the code uses
   `<path>.<pid>.<sequence>.<random-hex>.tmp`. The doc's `*.tmp` advice covers it.

Verdict: the doc is accurate at the level of every field, path, ordering, and guard that
`core/library.ts` reads or writes; it stays authoritative. No schema change is required. The two
placeholder drifts are recorded as a decision (D008) rather than a defect. Closure recorded as
`carry_forward_closures: [cf-contracts-1]`.

### cf-contracts-2 — dashboard HTML body catalog (CLOSED)

`cf-contracts-2` asked for the byte-level catalog of the dashboard's rendered content and its data
sources. `core/dashboard.ts` was read in full (previously only the first ~120 lines) and
`core/dashboard-writer.ts` supplies the data. The artifact is one self-contained
`.codecarto/dashboard.html` with inline `<style>` and one inline `<script>`; no external assets
(`observed fact`).

**Data sources** (`dashboard-writer.ts` `writeDashboard`, gathered in parallel):

| Input | Source | Notes |
|---|---|---|
| `status` | `getWorkspaceState(cwd).status` | normalized `status.yaml` |
| `pipeline` | `getWorkspaceState(cwd).pipeline` | active pipeline YAML |
| `usage` | `loadUsage(workspaceDir)` | `.usage.local.yaml` |
| `closeouts` | `listCloseouts(workspaceDir)` | `closeouts/*.md` matching `^(\d{4}-\d{2}-\d{2})-(.+)\.md$`; summary = first lines under `## Summary`, collapsed, capped at 280 chars |
| `outputsPresent` | `buildOutputsPresent` | `pathExists` per declared primary + secondary output |
| `narration` | `loadNarration` | `.dashboard-narration.local.md` frontmatter `generatedAt`, `phaseCountAtGeneration` |
| `packageVersion`, `generatedAt` | `PACKAGE_VERSION`, host clock | footer + header meta |

**Sections, in render order** (`renderDashboard` `sections[]`): sidebar → header (`#summary`) →
staleness warning (conditional) → health panel → narration (conditional) → key results
(`#key-results`) → progress bar → phase cards (`#phases`) → usage panel (`#usage`) → activity
timeline → open-questions rollup → post-pipeline work (`#post-pipeline`, conditional) → closeouts
(`#closeouts`) → footer.

| Section | Rendered content | Counts / citations |
|---|---|---|
| Sidebar | brand, search box, status filters (all/complete/current/pending), nav links (one per phase with derived state), export button, "no network calls" foot | one nav link per `pipeline.phase_order` |
| Header | eyebrow, `<h1>` project name, workflow goal, 6 stat cells (Pipeline, Current phase, Progress `<completed>/<total> phases`, Recorded tokens, Tool uses, Package `v<version>`), meta details (status last updated, dashboard generated, status file, next actions list) | `computeTotals(usage)`, `completedPhaseCount` |
| Health panel | derived `health` ∈ {attention required, review recommended, complete, on track}; ring `<completed>/<total>`; 7 metrics (Artifacts needing attention, Open questions, Carry-forward items, Post-pipeline work, Tool uses, Runtime, Tokens); issue list with severity pills | `collectDashboardIssues` (blocker when a complete/current phase's primary output is missing), `countOpenQuestions`, `countCarryForward`, non-resolved `post_pipeline` |
| Narration | `<h2>Executive summary</h2>`, staleness (`current` or `<n> runs since`), `Narrated <generatedAt>.`, `<pre>` body | `runsSince = completedPhaseCount − phaseCountAtGeneration` |
| Key results | one row per phase whose primary exists or is complete: phase link, path (or missing), available/missing pill, closeout link or "no closeout" | — |
| Progress bar | one `<li>` per phase with derived state chip and the phase `purpose` as a title | — |
| Phase cards | per-phase `<details>`: id + derived state; purpose; depends-on pills + required-reads; outputs (primary/secondary link or "missing" pill); closeout; open questions (`(n)`); carry-forward (`(n)`, with target-phase pill); owner notes; last run (timestamp/status/turns/tools/tokens/duration/compactions/session) | counts from the phase record |
| Usage | totals (runs; tokens in/out/cache; total tokens; tool uses; duration; compactions; reasons), 3 insights (longest phase, most tool-heavy, current-phase usage), table `Phase | Runs | Tokens | Tools | Duration | Compactions | State` with bars | `computeTotals`/`computePerPhaseTotals`; "unavailable" when the host reported no token/compaction accounting |
| Activity timeline | newest-first table `When | Phase | Status | Turns | Tools | Tokens | Duration | Session`; first 10 visible, older in a `<details>` | `TIMELINE_VISIBLE_COUNT = 10`; session column only when at least one safe session link exists |
| Open-questions rollup | kind chips (count per kind) + one bucket per phase, de-duplicated by `id` or `kind|description|deferred_reason` | "`<total>` unique" |
| Post-pipeline work | `<pending> pending · <total> total`, one row per item: kind, id, description, source-phase pill, status pill | non-resolved count |
| Closeouts | newest-first rows: date, phase/module link, closeout link, file name, summary, output links (primary/secondary present pills) | — |
| Footer | `Generated by codecartographer-pi v<version> at <generatedAt>.`, regenerate/narrate hints | — |

**Embedded machine-readable export** (`renderExportData`): `<script id="cc-dashboard-data"
type="application/json">` containing `{project, generatedAt, packageVersion, phases:[{id, status,
purpose, primary_output, primary_output_exists, secondary_outputs}], post_pipeline, usage,
closeouts}`, with `&`, `<`, `>`, U+2028, U+2029 escaped for in-script safety. The export button
wraps `JSON.parse(textContent)` and downloads `codecartographer-dashboard.json`.

**Citations/links** (`renderSafeLink`/`safeRelativeHref`): a path is refused if empty, absolute,
backslash-leading, scheme-bearing, or containing an empty/`.`/`..` segment; otherwise each `/`
segment is `encodeURIComponent`-ed. Phase anchors are `phase-<id with non [a-zA-Z0-9_-] → ->`.
All text and attributes go through `escapeHtml`/`escapeAttr`.

**Derived phase state** (`phaseRenderState`): `complete` if `phase.status === "complete"`;
`running` if `"running"`; `current` if `current_phase` equals the id; else `pending`. The dashboard
therefore distinguishes four states where `status.yaml` stores at most `complete`/`running`.

Closure recorded as `carry_forward_closures: [cf-contracts-2]`.

---

## Coverage and limits

- **Inspected scope (this phase):** the persistence and protocol layer line-by-line —
  `core/types.ts`, `core/status.ts`, `core/yaml.ts`, `core/workspace.ts`, `core/amendment.ts`,
  `core/pipeline.ts`, `core/prompts.ts`, `core/completion.ts`, `core/coverage.ts`,
  `core/findings.ts`, `core/usage.ts`, `core/orchestrator-config.ts`, `core/utils.ts`,
  `core/library.ts`, `core/dashboard.ts` (now in full), `core/dashboard-writer.ts`; all of
  `core/broadside/{types,constants,state,client,requests,results,schemas,models,collect,submit,verify}.ts`
  at the protocol level (already read line-by-line by the mechanical phase; re-read here for wire
  shapes); `mcp-server/server.ts` transport/handler boundary; `extensions/codecarto/{index,
  agent-runner,auto-runner,phase-compaction}.ts` at the event/lifecycle protocol; `docs/library-format.md`
  in full; `.codecarto/templates/{amendment,phase-handoff,phase-checkpoint,closeout-template,
  thread-log}.md` and `.codecarto/workflow/scaffold-version.yaml`.
- **Skipped scope:** `core/dashboard.ts` styles beyond the section renderers (the `<style>` block
  is presentation, not protocol; its shape is not cataloged); `extensions/codecarto/*` beyond the
  four modules above (`agent-widget`, `agent-rewriter`, `agent-summary`, `dashboard-narrator`,
  `child-model-runtime`, `completions`, `notify`, `guide-framing`) — read by name/export only;
  `core/broadside/{repo,lenses}.ts` line-by-line (protocol-relevant `git`/slice facts are cited
  from the mechanical phase's findings and re-confirmed at the callsites read here); the
  `mcp-server/server.ts` `TOOLS` JSON text verbatim (~the contracts phase already extracted per-
  argument defaults); the ~90 `tests/*.test.mjs` bodies (cited as pins, not read in full);
  `scripts/*`; `assets/`; historical `CHANGELOG.md`.
- **Evidence basis:** source inspection (primary) plus in-repo docs (`docs/library-format.md`,
  templates) and test names as executable contract pins. **No tests were executed and no runtime
  probes ran this session** (no execution tool), so every test citation is "the test file pins X,"
  never "X passed here."
- **Known blind spots:**
  1. No runtime verification: every durability/mutual-exclusion/containment claim is
     `external-behavior claim` + `portability hazard`, action `verify at runtime`
     (`q-node-windows-fs-semantics`, mechanical 6.1–6.4).
  2. OpenRouter Batch API remote semantics (`q-openrouter-batch-semantics`) — `verify at runtime`.
  3. Pi-SDK vs MCP execution parity (`q-pi-sdk-execution-parity`) — `verify at runtime`.
  4. The MCP SDK's negotiated protocol version and `AgentSession` runtime details were not read
     from the dependency source.
  5. npm tarball template parity (`q-npm-tarball-template-parity`) — needs a fixture capture.
  6. The `core/dashboard.ts` `<style>` block and the unread extension modules may hold
     presentation/behavior not cataloged here.
- **Coverage disposition:** COMPLETE for the phase's declared scope. All four required outputs are
  present (event catalog P1–P17, state machines SM1–SM7, field-by-field persistent schemas,
  compatibility hazards); `cf-arch-2`, `cf-contracts-1`, and `cf-contracts-2` are closed with cited
  evidence; the residual limits are named and routed as open questions/post-pipeline, not smoothed
  over.
- **Contradiction sweep:** the one measured upstream contradiction remains the Pi command count —
  the architecture map and `public-surfaces.md` say "~21", but `tests/pi-parity-commands.test.mjs`
  pins 20 and `README.md` lists 20. This phase re-affirms **20** (`observed fact`: the 20
  `pi.registerCommand` calls counted in `extensions/codecarto/index.ts`) and carries the correction
  into the `public-surfaces.md` addendum. The second: `README.md`'s Broad-Side action list omits
  `verify`, which the code and parsers implement; the code is authoritative. No new contradiction
  with the architecture, mechanical, or contracts `owner_notes` was found. The mechanical phase's
  Windows-portability findings and the contracts phase's hedges are inherited unchanged, not
  re-litigated.

---

## Open Questions

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-openrouter-batch-semantics | needs-runtime-test | The exact OpenRouter Batch API contract Broad-Side relies on — concurrent-job quota (`job-submission-count`), which catalog ids actually have `:batch` endpoints, and reasoning acceptance — is asserted in comments, not verifiable from this source. Every P9/P10/P11 external-behavior claim inherits it. | Re-triaged this phase: still needs a live probe or the provider's source; reading `client.ts`/`models.ts`/`verify.ts` confirms only what the code *sends* and how it parses, not what the provider does. |
| q-pi-sdk-execution-parity | needs-runtime-test | Byte-identical phase prompts are test-pinned, but whether Pi sub-agent execution (tool sandbox, compaction, session persistence) and an MCP host's execution produce equivalent *outcomes* is not established by reading. | Re-triaged: still needs the same phase run under both surfaces and compared. P12 asserts prompt/session behavior, not outcome parity. |
| q-node-windows-fs-semantics | needs-runtime-test | Do lock-file `O_EXCL`, atomic rename over an existing file, symlink-aware path containment, and bare-`git` invocation behave on Windows/macOS as the POSIX-written code expects? Every P17/P13 claim and every durability contract inherits it. | Re-triaged: still requires a Windows/macOS run; CI is Linux-only. Carried as `verify at runtime` throughout. |
| q-npm-tarball-template-parity | needs-fixture-capture | Whether the published npm tarball's `.codecarto/` template and `agent-skill/` byte-match this checkout is not verified here. | Inherited from architecture/contracts; needs packing the tarball and diffing — a fixture capture, not a source read. |

**Re-triage result (orchestrator duty):** `q-openrouter-batch-semantics`,
`q-pi-sdk-execution-parity`, and `q-node-windows-fs-semantics` each **remain `needs-runtime-test`**
— none became answerable by reading this phase's sources. No finding, schema note, or hazard row
in this report asserts one of their candidate answers with a settled action; every claim that lands
on the OpenRouter API, a lock/rename, containment, or `git` carries `verify at runtime`.
`q-npm-tarball-template-parity` remains `needs-fixture-capture`. This phase registers **no new**
open question: the only candidate, `docs/library-format.md` parity, is answerable by reading and is
closed as `cf-contracts-1`.

---

## Carry-Forward

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| cf-protocols-1 | porting | The exact hand-rolled YAML subset (what it reads, what it silently coerces or drops, and the `__proto__` sequence-merge gap) is cataloged here; whether the port adopts a full YAML library or reproduces the subset — and how it preserves duplicate-key and scalar-coercion behavior — is a synthesis-level decision made per target language. | The port's language choice determines the parser strategy; the porting bundle is where cross-module dependency/refactor decisions are consolidated. |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | An event catalog is documented. | PASS | §Event Catalog P1–P17, each with producer, consumer, carrier, ordering, required/optional fields, identifiers, errors, and restart behavior; §Boundaries Identified B1–B15 maps them. |
| 2 | A state machine is documented. | PASS | §State Machine SM1–SM7 (pipeline cursor, phase completion, lock, Broad-Side run/slots, publish, amendment, Pi sub-agent) with states, triggers, guards, transitions, and side effects. |
| 3 | Persistent schema notes are documented. | PASS | §Persistent Schema Notes specifies `status.yaml`, handoff, amendment, Broad-Side `state.json`, run directory, library marker/`metadata.yaml`/`index.yaml`/`latest`, usage log, scaffold marker, config files, pipeline definition, caches, checkpoint — field-by-field with reader/writer pairs and version markers. Closes `cf-arch-2`. |
| 4 | Compatibility hazards are documented. | PASS | §Compatibility Hazards table: POSIX rename/O_EXCL/containment, bare `git`, hand-rolled YAML, `__proto__`, OpenRouter semantics, `fetch`/stdin, timestamps-as-ids, byte-vs-char slicing, redaction, HTML link-escaping — each with location, severity, and an unsettled action where applicable. |
| 5 | Findings are marked with evidence levels. | PASS | Evidence levels inline throughout (`observed fact`, `strong inference`, `external-behavior claim`, `portability hazard`, `open question`); every platform/network claim carries `verify at runtime`. |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits names all four plus a `COMPLETE` disposition and a contradiction sweep (Pi 20 vs "~21"; README missing `verify`). |

**Validated by:** 2026-09-15 (protocols phase, self-audit session)
**Overall:** PASS
