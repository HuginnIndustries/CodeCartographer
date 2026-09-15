# Architecture Map — CodeCartographer (`codecartographer-pi` v0.25.0)

> Self-audit: the analyzed source is the repository outside `.codecarto/`, i.e. the
> CodeCartographer framework itself. Evidence levels are marked inline as
> `observed fact`, `strong inference`, `external-behavior claim`, `portability hazard`,
> or `open question`. Catalog-level detail for the phase's declared secondary outputs
> is split out to `findings/public-surfaces/`, `findings/runtime-lifecycle/`,
> `findings/state-and-storage/`, `findings/build-and-deploy/`, and
> `findings/config-model/`; this map owns the summary and the load-bearing claims.

## System Intent

CodeCartographer is a **portable, phase-gated reverse-engineering and specification-synthesis
framework** that lives inside a target repository as a `.codecarto/` directory. It turns an
unfamiliar codebase into a layered architecture map, behavioral contracts, protocol/state
notes, defect findings, and finally a language-agnostic `reimplementation-spec.md` that
another agent or engineer can rebuild from — with each phase writing a templated,
evidence-tagged artifact to disk and validating itself before the pipeline advances
(`observed fact`: `README.md` "Why CodeCartographer"; `GUIDE.md`; `.codecarto/workflow/pipeline-full-with-deep-audit.yaml`).
It also runs the opposite direction: a `synthesis` pipeline merges a user vision with
human-confirmed library specifications into a provenance-backed project plan
(`observed fact`: `.codecarto/workflow/pipeline-synthesis.yaml`; `core/synthesis.ts`).
It is built for people and agents who must understand, audit, or port a codebase larger than
one context window (`strong inference`: the progressive-distillation design, the
compaction/checkpoint machinery, and the evidence-level vocabulary all target that use case).

The framework ships through **three delivery surfaces over one shared core** (`observed fact`:
`CLAUDE.md` "Architecture", `core/index.ts` header):

1. **Drop-in template** — pure `.codecarto/` Markdown + YAML, no executable code.
2. **Pi extension** (`extensions/codecarto/`) — slash commands, isolated phase sub-agents,
   live widget, dashboard, usage tracking.
3. **MCP server** (`mcp-server/`) — stdio JSON-RPC tools for any MCP-capable host.

Pi and MCP produce **byte-identical phase prompts and validation results** because both import
the same `core/` (`observed fact`: `core/prompts.ts` header; invariant tests under `tests/`).
The drop-in path carries analysis and synthesis-by-prompt but not the executable library,
dashboard, sub-agent, or Broad-Side surfaces (`observed fact`: `README.md` drop-in limitation;
`extensions/codecarto/index.ts` and `mcp-server/server.ts` are the only executable entry points).

## Layer Map

### Package Inventory

| Package / Module | Role | Public Entrypoints | Key Dependencies | Runtime Surface |
|---|---|---|---|---|
| `.codecarto/` | Product shell + protocol-as-data. Ships GUIDE, pipeline DAGs, skills, templates, validation protocol, agent guide. | `GUIDE.md`, `workflow/pipeline*.yaml`, `workflow/VALIDATE.md`, `findings/*/SKILL.md`, `templates/*`, `skills/*`, `broadside/SKILL.md` | None (data); consumed by `core/` at runtime (`packagedWorkspaceDir`) | Copied into user workspaces by init; read by phase sub-agents |
| `core/` (`*.ts`, 19 modules) | Core semantics + protocol/normalization + persistence + presentation, framework-wide | `core/index.ts` barrel re-exports every primitive | Node builtins only | Imported by both wrappers |
| `core/broadside/` (14 modules) | Integration adapter (OpenRouter Batch API) | Re-exported through `core/broadside.ts` barrel → `core/index.ts` | Node builtins; `../secrets.ts`, `../status.ts`, `../utils.ts`, `../yaml.ts`, `../workspace.ts` | Pi `/codecarto-broadside`; MCP `codecarto_broadside` |
| `extensions/codecarto/` (17 modules) | Product shell for Pi: slash commands, sub-agent lifecycle, widget, dashboard narration, compaction | `index.ts` default export (`codeCartographerExtension`); `dist/extensions` (package `pi.extensions`) | `core/index.ts`, `@earendil-works/pi-coding-agent` | Pi TUI process |
| `mcp-server/` (`server.ts`, `bin.mjs`) | Integration adapter for MCP hosts | `bin.codecarto-mcp` → `dist/mcp-server/bin.mjs`; exports `buildServer`, `startStdioServer`, all `handle*` functions | `core/index.ts`, a few direct `core/*.ts`, `@modelcontextprotocol/sdk` | stdio JSON-RPC subprocess |
| `agent-skill/codecartographer/` | Packaged agent guide (documentation-as-product) | `SKILL.md` + 10 `references/*.md` topics | None (Markdown) | Served by `core/guide.ts` via `codecarto_guide` / `/codecarto-guide`; also an installer skill |
| `tests/` (~90 `*.test.mjs`) | Protocol/normalization guardrail: cross-wrapper drift invariants | `npm test` (`node --experimental-strip-types --test`) | `core/index.ts`, `extensions/…`, `mcp-server/…` | CI (Node 22/24) |
| `scripts/` | Build/deploy tooling + demo generators | `npm run smoke`, `smoke:broadside`, `demo:synthesis`; `create-synthesis-demo.mjs`, `build-demo-dashboard.mjs` | `core/`, `@modelcontextprotocol/sdk` | CI/local only |
| `docs/` | Maintainer + user documentation (library ABI, MCP quickstart, roadmap, plans) | Markdown | None | Human/agent reference |
| `assets/`, root manifests | Distribution metadata | `assets/logo.svg`, `package.json`, `server.json`, `tsconfig.json` | — | npm/MCP registries |

### Core module roles (`core/`)

| Module | Role | Key responsibilities |
|---|---|---|
| `types.ts` | Core semantics | Shared schema types (`StatusFile`, `PipelineFile`, `PhaseHandoff`, `ValidationResult`, kinds) — single source of truth for both wrappers |
| `utils.ts` | Core semantics | Atomic write, path containment/symlink resolution, version compare, `~` expansion, formatters, `GIT_TIMEOUT_MS` |
| `yaml.ts` | Persistence or state | Hand-rolled YAML parser/serializer for workflow files (block scalars, round-trips handoffs) |
| `status.ts` | Persistence or state | `status.yaml` normalization, `applyHandoff`, `parseHandoff`, id auto-assignment, and the `acquireLock` / stale-break lock primitive |
| `workspace.ts` | Persistence or state + product shell | `getWorkspaceState`, packaged-template location, init copy/filter, scaffold refresh, pipeline switch, `updateStatusAtomically` (commit point + lock) |
| `pipeline.ts` | Core semantics | Pipeline alias table, DAG walk (`getNextEligiblePhase`/`resolvePipelineOutcome`), validation parser, `recomputeCursor` |
| `prompts.ts` | Protocol or normalization | Phase/skill prompt assembly (the byte-identical fidelity surface), orchestrator-duties block, spliced-text quoting, closeout naming |
| `completion.ts` | Protocol or normalization | Completion bookkeeping: decisions → `DECISIONS.md`, proposals → `CONVENTIONS.md`, closeout + `THREAD_LOG` idempotent writes, closure-integrity gates |
| `findings.ts` | Protocol or normalization | Deterministic cross-checks over defect findings tables (evidence/action pairing) |
| `coverage.ts` | Protocol or normalization | Parses every output's `## Coverage and limits` ledger into the coverage-gap ledger |
| `amendment.ts` | Persistence or state | Post-pipeline amendment application under the completion lock |
| `usage.ts` | Persistence or state | `.usage.local.yaml` read/append with lock + atomic write, totals |
| `orchestrator-config.ts` | Persistence or state | Two-layer config loader (user-global + workspace), library/orchestrator settings, config problem reporting |
| `dashboard.ts` / `dashboard-writer.ts` | UI or rendering | Self-contained single-file HTML dashboard renderer + I/O gatherer |
| `library.ts` | Persistence or state + integration adapter | Versioned spec library: marker, publish (content-hash idempotent, guards), read/list/reindex, provenance-conflict detection, git helpers |
| `synthesis.ts` | Core semantics | Forward-synthesis preflight guards and library/vision/proposal resolution |
| `guide.ts` | Protocol or normalization | Serves the packaged `agent-skill/` documents by topic |
| `secrets.ts` | Core semantics | High-confidence secret redaction + secret-file classification for Broad-Side uploads |
| `broadside.ts` + `core/broadside/` | Integration adapter | OpenRouter batch reconnaissance (intake → slicing → pricing → submit → poll → collect → verify → synthesize) |

### Pi extension module roles (`extensions/codecarto/`)

| Module | Role | Key responsibilities |
|---|---|---|
| `index.ts` | Product shell | Registers ~21 slash commands, `tool_call` guard (blocks `bash`, confines `edit`/`write`), lifecycle hooks, status widget |
| `auto-runner.ts` | Product shell | `runSinglePhase` (one-shot) and `runAuto` (`--auto` loop), `autoCompletePhase`, decision matrix |
| `agent-runner.ts` | Integration adapter | Spawns isolated `AgentSession` sub-agents via the Pi SDK, forwards events, continuation-on-missing-output |
| `agent-state.ts` | Persistence or state | In-memory per-phase activity registry (tokens, tools, compactions) for the widget |
| `agent-widget.ts` | UI or rendering | Live agents widget |
| `agent-rewriter.ts` | Integration adapter | Opt-in LLM steering of the next phase's seed prompt |
| `agent-summary.ts` | UI or rendering | Phase-summary message bodies |
| `dashboard-writer.ts` | UI or rendering | Re-exports the core dashboard writer (surface shim) |
| `dashboard-narrator.ts` | Integration adapter | Opt-in LLM executive summary for the dashboard |
| `child-model-runtime.ts` | Integration adapter | Child-session model/runtime wiring |
| `phase-compaction.ts` | Protocol or normalization | Phase-aware compaction instructions + checkpoint writer |
| `broadside-flags.ts`, `next-flags.ts`, `dashboard-flags.ts` | Protocol or normalization | Argument parsers for slash commands |
| `completions.ts` | UI or rendering | Last-token argument completions |
| `notify.ts`, `guide-framing.ts` | UI or rendering | Notification shim + Pi-surface framing for served guide text |

### Dependency Direction

- **Stable base.** `core/types.ts`, `core/utils.ts`, and `core/yaml.ts` are the lowest layer;
  nothing in the repo depends on the wrappers, and nothing in `core/` depends on
  `extensions/` or `mcp-server/` (`observed fact`: no such imports exist).
  `core/index.ts` is the single barrel both wrappers consume (`observed fact`: file header).
- **Upward edges inside `core/`.** `status` → `types`/`utils`/`yaml`; `workspace` →
  `pipeline`, `status`, `utils`, `yaml`; `pipeline` → `findings`, `status`, `types`,
  `utils`; `completion` → `pipeline`, `status`, `workspace`, `utils`; `prompts` →
  `coverage`, `completion`, `workspace`, `synthesis`; `dashboard-writer` → `dashboard`,
  `usage`, `workspace`, `utils`, `yaml`.
- **Broad-Side subgraph.** `core/broadside.ts` is a barrel over an explicitly acyclic
  runtime graph: `constants → types → schemas → lenses → repo → requests →
  state/models/client → submit → results → verify → collect → render`
  (`observed fact`: `core/broadside.ts` header; `core/broadside/` split in #339).
  `state.ts` reads `client.ts` for terminal statuses, which is a backward edge relative
  to the stated order (`observed fact`: `core/broadside/state.ts` imports
  `BROADSIDE_TERMINAL_ENTRY_STATUSES` from `./client.ts`) — not a cycle, but a
  declaration/ordering drift worth noting.
- **Known cycle.** `core/index.ts` re-exports `./dashboard-writer.ts`, and
  `core/dashboard-writer.ts` imports named bindings from `./index.ts`
  (`observed fact`). This is a module-graph cycle; it resolves only because the imported
  functions/constants are dereferenced at call time, not at module-evaluation time
  (`strong inference`). It is a real portability hazard: a reimplementation that evaluates
  bindings eagerly at import (e.g. many static languages) must break the cycle by moving
  the shared constants into a lower module.
- **Wrappers as thin adapters.** Both wrappers are wrappers around shared internals rather
  than unique systems (`observed fact`): they add UI, sub-agent lifecycle, or JSON-RPC
  plumbing and delegate all state/validation/prompt logic to `core/`.
- **Template is data, not an import.** `.codecarto/` has no code; `core/workspace.ts`
  locates it via `packagedWorkspaceDir` and copies/reads it. This keeps the framework's
  "protocol" (pipelines, templates, skills) editable without recompiling (`strong inference`).

## Public Surfaces

Summary of the boundaries the outside world touches. Full inventories live in the
secondary outputs.

- **Binaries.** One: `codecarto-mcp` → `dist/mcp-server/bin.mjs` (stdio MCP server)
  (`observed fact`: `package.json` `bin`; `mcp-server/bin.mjs`).
- **MCP tools (22).** `codecarto_init`, `_open`, `_vision`, `_status`,
  `_switch_pipeline`, `_next`, `_phase`, `_validate`, `_complete`, `_skill`,
  `_list_skills`, `_guide`, `_config`, `_usage`, `_dashboard`, `_amend`,
  `_refresh_scaffold`, `_publish`, `_library_init`, `_library_list`,
  `_library_reindex`, `_broadside` (`observed fact`: `mcp-server/server.ts` `TOOLS`/`HANDLERS`).
- **Pi slash commands (~21).** `/codecarto-init`, `-open`, `-vision`, `-status`,
  `-switch-pipeline`, `-next`, `-phase`, `-validate`, `-complete`, `-skill`,
  `-list-skills`, `-guide`, `-broadside`, `-publish`, `-library-init`, `-config`,
  `-usage`, `-dashboard`, `-refresh-scaffold`, `-amend` (`observed fact`:
  `pi.registerCommand` calls in `extensions/codecarto/index.ts`).
- **Exported library.** `core/index.ts` re-exports ~19 modules; `mcp-server/server.ts`
  exports `buildServer`/`startStdioServer`; the extension default-exports one factory
  (`observed fact`).
- **Agent guide.** `agent-skill/codecartographer/SKILL.md` + 10 reference topics served by
  `codecarto_guide` / `/codecarto-guide` and installable as a skill (`observed fact`:
  `core/guide.ts`; `agent-skill/codecartographer/references/`).
- **File formats / persistent artifacts.** `status.yaml`, `pipeline*.yaml`,
  `scaffold-version.yaml`, `workflow/config.yaml`, `.usage.local.yaml`,
  `.orchestrator.local.yaml`, `scratch/handoffs/<phase>.yaml`,
  `scratch/checkpoints/<phase>.md`, `scratch/amendments/<slug>.yaml`,
  `findings/**/*.md`, `closeouts/*.md`, `THREAD_LOG.md`, `CONVENTIONS.md`,
  `DECISIONS.md`, `BACKLOG.md`, `dashboard.html`, `.dashboard-narration.local.md`,
  Broad-Side `broadside/{state.json,config.yaml,<run>/**}`, and the library layout
  (`.codecarto-library`, `entries/<ns>/<slug>/v<N>/…`, `latest`, `index.yaml`, `INDEX.md`)
  (`observed fact`: `core/workspace.ts`, `core/amendment.ts`, `core/dashboard.ts`,
  `core/broadside/state.ts`, `core/library.ts`, `.codecarto/.gitignore`).
- **Network / RPC interfaces.** MCP over stdio; OpenRouter Batch API
  (`/api/beta/batches`), Chat Completions, `/api/v1/models`, `/api/v1/benchmarks`
  (`observed fact`: `core/broadside/constants.ts`, `client.ts`, `verify.ts`).
- **External processes / registries.** `git` subprocess (publish source-repo resolution,
  Broad-Side snapshots/incremental); npm registry + MCP Registry + GitHub Releases
  (`observed fact`: `core/library.ts` `runGit`; `core/broadside/repo.ts`;
  `.github/workflows/release.yml`).
- **User-facing workflows.** The analysis pipeline (8 variants), the synthesis pipeline,
  publishing to a library, Broad-Side reconnaissance, dashboard review, amendments.

## Runtime Lifecycle

Full detail in `findings/runtime-lifecycle/runtime-lifecycle.md`. Summary:

- **MCP server.** `startStdioServer()` builds a `Server`, connects a `StdioServerTransport`,
  and attaches an `AbortController` aborted on `stdin` `end`/`close` so a Broad-Side wait
  cannot outlive its client (`observed fact`: `mcp-server/server.ts`).
- **Pi extension.** On load, registers commands/hooks and a compaction extension; commands
  are the entry points. `/codecarto-init` copies the packaged template, seeds orchestrator
  files, and writes `status.yaml`. `/codecarto-next` spawns an isolated `AgentSession`
  sub-agent (`runPhase`), then validates and auto-completes; `--auto` loops phases
  (`observed fact`: `extensions/codecarto/index.ts`, `agent-runner.ts`, `auto-runner.ts`).
- **Phase run.** The sub-agent reads its SKILL/template/required reads, writes the primary
  output with a `## Validation` table, and (for phases that declare it) a handoff YAML.
  The runner detects a missing primary output and prompts the session to continue
  (`observed fact`: `agent-runner.ts` `shouldContinuePhase`).
- **Completion.** `completeValidatedPhase` re-validates under the status lock, applies the
  handoff, recomputes the cursor, then (post-commit) writes the closeout, `THREAD_LOG`
  entry, decision rows, and staged conventions, and refreshes the dashboard
  (`observed fact`: `core/completion.ts`).
- **Shutdown/cleanup.** `session_shutdown` disposes the widget; each child session is
  disposed after its phase; stale locks are broken; temp files are best-effort removed
  (`observed fact`: `index.ts`, `agent-runner.ts`, `core/status.ts`, `core/utils.ts`).
- **Background work.** Broad-Side batches run server-side and are polled; dashboard
  narration is an optional one-shot LLM call (`observed fact`: `core/broadside/collect.ts`,
  `extensions/codecarto/dashboard-narrator.ts`).

## Concurrency Model

Full detail in `findings/runtime-lifecycle/runtime-lifecycle.md`. Summary:

- **Single-threaded async.** Node event loop with `async`/`await`; no worker threads,
  no cluster, no threads (`observed fact`: no `worker_threads`/`cluster` usage).
- **File locks.** `acquireLock` takes an `O_EXCL` lock file recording pid/time/token,
  waits up to 5 s, breaks a lock older than 60 s under a separate `<lock>.break` removal
  lock, and releases only if its token still owns the file (`observed fact`:
  `core/status.ts`). Used for `status.yaml`, the usage log, Broad-Side `state.json`, and
  library publish.
- **Atomic writes.** `atomicWriteFile` writes a uniquely named sibling temp file and
  renames over the target (`observed fact`: `core/utils.ts`).
- **Ordering.** The completion "commit point" is the `status.yaml` rename; closeouts,
  `THREAD_LOG`, decisions, and proposals run in `afterCommit` so a failed commit leaves none
  behind, and each writer is idempotent (`observed fact`: `core/workspace.ts`,
  `core/completion.ts`).
- **Sub-agent isolation.** Each Pi phase runs in its own `AgentSession` with its own
  context; the orchestrator TUI stays live. A re-entry guard (`isPhaseRunning`) prevents a
  duplicate sub-agent for one phase; the auto loop is sequential (`observed fact`:
  `agent-runner.ts`, `auto-runner.ts`).
- **Parallel network.** Broad-Side polls all lens batches concurrently against one shared
  deadline (`pollBatchesConcurrently` → `Promise.all`); submits sequentially; post-pass and
  retry spending is claimed atomically per run slot (`claimRunSlot`) and state is merged
  slot-by-slot (`persistBroadsideRunMerging`) so two collects cannot double-pay or
  clobber each other (`observed fact`: `core/broadside/{client,state,collect,submit}.ts`).
- **Aborts.** HTTP calls use `AbortSignal.timeout(30_000)`; poll loops honor an external
  `AbortSignal`; git subprocesses are bounded by `GIT_TIMEOUT_MS = 30_000`
  (`observed fact`: `core/broadside/client.ts`, `core/utils.ts`, `core/library.ts`).
- **Shared module state.** Module-level mutables are limited to `serverLifetime`
  (`mcp-server/server.ts`), `tempSequence` (`core/utils.ts`), and the in-process phase
  activity registry (`extensions/codecarto/agent-state.ts`) (`observed fact`).
- **Portability hazards.** POSIX-oriented lock/rename/O_EXCL semantics, `git` on `PATH`,
  `fetch`/`AbortSignal`, `process.stdin` end detection, symlink-resolution path
  containment, and Pi/MCP SDK event lifecycles do not translate 1:1.

## Build and Packaging

Full detail in `findings/build-and-deploy/build-and-deploy.md`. Summary:

- **Compiler.** `npm run build` → `tsc` (`tsconfig.json`, `target ES2022`, `module NodeNext`,
  `rootDir "."`, `outDir dist`, `strict:false`, `allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions`) (`observed fact`).
- **Artifacts.** `dist/` (JS + `.d.ts`) for `core/`, `extensions/`, `mcp-server/`; one bin
  `dist/mcp-server/bin.mjs`; the `.codecarto/` template, `agent-skill/`, and `assets/logo.svg`
  ship in the npm tarball (`observed fact`: `package.json` `files`, `bin`, `pi.extensions`).
- **Tests.** `npm test` runs `node --experimental-strip-types --test tests/*.test.mjs`
  (no build step; CI matrix Node 22/24) (`observed fact`: `package.json`, `ci.yml`).
- **Smoke.** `scripts/smoke-mcp.mjs` packs and installs the tarball and drives the MCP
  server; `smoke:mcp`/`smoke:broadside` and a scheduled `smoke.yml` workflow
  (`observed fact`).
- **Release.** Tag-driven `v*` workflow: version/tag match, `npm ci`, audit, test, build,
  pack + smoke, idempotent `npm publish --provenance`, idempotent MCP Registry publish,
  GitHub Release from CHANGELOG (`observed fact`: `.github/workflows/release.yml`).
- **Platforms.** Node `>=20`; no containers, no native builds (`observed fact`:
  `package.json` engines).

## Porting Priorities

| Component | Priority | Rationale |
|---|---|---|
| Pipeline DAG + validation parser + status/handoff state machine (`pipeline.ts`, `status.ts`, `completion.ts`, `workspace.ts`) | **core** | The phase gate is the product; without it nothing downstream is trustworthy. |
| Prompt assembly + phase/skill templates (`prompts.ts`, `.codecarto/templates/`, `.codecarto/findings/*/SKILL.md`) | **core** | Defines what each phase actually does; the byte-identical-prompt invariant is load-bearing. |
| Status/handoff YAML format + hand-rolled YAML parser (`yaml.ts`, `types.ts`) | **core** | Cross-session durable memory; hand-editing tolerance and round-tripping are contractual. |
| File-lock + atomic-write primitives (`status.ts`, `utils.ts`) | **core** | Correctness under concurrent completion/amendment/publish; concurrency hazards do not port 1:1. |
| Coverage ledger, findings cross-checks, closure-integrity gates (`coverage.ts`, `findings.ts`, `completion.ts`) | **important** | Enforce cross-phase honesty; port as behavior, not necessarily as parsers. |
| Dashboard renderer (`dashboard.ts`) | **important** | Self-contained, zero-asset HTML is a stated product property; sizable but mechanical. |
| Orchestrator config + scaffold refresh/init filtering (`orchestrator-config.ts`, `workspace.ts`) | **important** | Correct init is how the framework avoids leaking one project's state into another. |
| Usage log + compaction telemetry (`usage.ts`, `phase-compaction.ts`) | **optional** | Observability, not required for analysis correctness. |
| Library publish/read/reindex + provenance guards (`library.ts`) | **optional** | Only needed for the publish/synthesis workflow; schema documented as ABI in `docs/library-format.md`. |
| Broad-Side subsystem (`core/broadside/`) | **optional** | Large, network-coupled, deliberately advisory; a port can stub it and still deliver analysis. |
| Pi extension sub-agent/auto-runner/widget (`extensions/codecarto/`) | **optional** | Surface ergonomics; the MCP/drop-in path proves the core works without it. |
| Secrets redaction pass (`secrets.ts`) | **optional** | Security-relevant only when Broad-Side uploads content. |
| Synthesis preflight (`synthesis.ts`) | **optional** | Forward-synthesis pipeline only. |

## Durable State

Catalog-level detail in `findings/state-and-storage/state-and-storage.md`. Summary of where
durable state lives:

- **Workspace state (framework-owned, committed by default):** `.codecarto/workflow/status.yaml`
  (single source of truth), `workflow/scaffold-version.yaml`, pipeline YAMLs, templates,
  skills, `GUIDE.md`, `VALIDATE.md`.
- **Session artifacts (gitignored by default):** `findings/**/*.md`, `scratch/handoffs/*.yaml`,
  `scratch/checkpoints/*.md`, `scratch/amendments/*.yaml`, `closeouts/*.md` (committed),
  `THREAD_LOG.md`/`CONVENTIONS.md`/`DECISIONS.md`/`BACKLOG.md` (committed, orchestrator-maintained).
- **Machine-local (gitignored):** `workflow/.usage.local.yaml`, `workflow/.orchestrator.local.yaml`,
  `dashboard.html`, `.dashboard-narration.local.md`, `broadside/state.json`,
  `broadside/model-catalog.json`, `broadside/batch-endpoints.json`, `broadside/<run>/**`.
- **User config (outside any one repo):** `~/.codecarto/config.yaml` (or
  `CODECARTO_USER_CONFIG_PATH`); per-workspace `workflow/config.yaml`; Broad-Side
  `broadside/config.yaml` (may hold an API key — tracked by default in the template, a stated risk).
- **Library (external, versioned):** `.codecarto-library` marker, `entries/…/v<N>/{reimplementation-spec.md,metadata.yaml}`,
  `latest` pointer file, derived `index.yaml`/`INDEX.md`.
- **Environment:** `OPENROUTER_API_KEY`, `CODECARTO_USER_CONFIG_PATH`, `HOME`.

## Coverage and limits

- **Inspected scope:** repository root (`README.md`, `CLAUDE.md`, `package.json`,
  `tsconfig.json`, `CHANGELOG.md` head, `.github/workflows/*`); the full `core/` module set
  (all 19 top-level modules read, `dashboard.ts` head only); all 14 `core/broadside/` modules
  enumerated by export, with `constants`, `types`, `schemas`, `state`, `client`, `submit`, and
  `repo` (head) read in full; the Pi extension `index.ts` (full), `auto-runner.ts`,
  `agent-runner.ts` in full, all 17 modules enumerated by export; `mcp-server/server.ts`
  (full) and `bin.mjs`; `.codecarto/` layout (GUIDE, all pipeline YAMLs read, workflow
  markers, `.gitignore`, templates list); `agent-skill/` topic list.
- **Skipped scope:** `core/broadside/{lenses,models,collect,results,requests,render,verify}.ts`
  read by export signature only, not line-by-line; `core/dashboard.ts` body beyond the first
  120 lines; the ~90 test files' bodies (names/structure only); `docs/*` contents beyond the
  directory listing; `scripts/*` contents; most of `extensions/codecarto/*` (only three read
  in full); `assets/` and brand files; historical CHANGELOG entries beyond 0.25.0/Unreleased.
- **Evidence basis:** source inspection (primary), plus in-repo documentation
  (`README.md`, `CLAUDE.md`, `CHANGELOG.md`) and the template's own pipeline/validation
  contracts. No tests were executed and no runtime probes were performed in this phase.
- **Known blind spots:** (1) exact runtime behavior of the Pi SDK `AgentSession` lifecycle and
  the MCP SDK's negotiated protocol version; (2) OpenRouter Batch API semantics beyond what
  the code asserts; (3) line-level correctness of Broad-Side collect/verify (read by export);
  (4) Windows/macOS behavior of lock files, rename, and path containment; (5) whether the npm
  tarball's `.codecarto/` and `agent-skill/` byte-match this checkout; (6) test suite outcome
  on this tree (not run).
- **Coverage disposition:** COMPLETE.

## Open Questions

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-openrouter-batch-semantics | needs-runtime-test | The exact OpenRouter Batch API contract the Broad-Side subsystem relies on — concurrent-job quota (`job-submission-count`), which catalog ids actually have `:batch` endpoints, and `reasoning` acceptance — is asserted in code comments but not verifiable from this source alone. | External service behavior; needs a live probe or the provider's own source. No later pipeline phase owns an external API contract. |
| q-pi-sdk-execution-parity | needs-runtime-test | Byte-identical phase *prompts* are test-pinned, but whether Pi sub-agent execution (tool sandbox, compaction, session persistence) and an MCP host's own execution produce equivalent *outcomes* is not established by reading. | Requires running the same phase under both surfaces and comparing results. |
| q-node-windows-fs-semantics | needs-runtime-test | Lock-file `O_EXCL`, atomic `rename` over an existing file, symlink-aware path containment, and `git` invocation may behave differently on Windows; the code is written to POSIX expectations. | Platform behavior cannot be confirmed by source inspection; CI runs Linux only. |
| q-npm-tarball-template-parity | needs-fixture-capture | Whether the published npm tarball's `.codecarto/` template and `agent-skill/` are byte-identical to this checkout is not verified here. | Needs packing the tarball and diffing — a fixture capture, not a source read. |

## Carry-Forward

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| cf-arch-1 | contracts | MCP tool input schemas and Pi command argument grammars/flag parsers are enumerated by name in `findings/public-surfaces/` but their per-argument defaults, side effects, and error behavior are not extracted. | The contracts phase rubric owns user-visible defaults/errors for each surface. |
| cf-arch-2 | protocols | The exact serialized shapes of `status.yaml`, `scratch/handoffs/<phase>.yaml`, `scratch/amendments/<slug>.yaml`, Broad-Side `state.json`, and library `metadata.yaml`/`index.yaml` are summarized, not specified field-by-field. | Persistence-format extraction is the protocols phase rubric. |
| cf-arch-3 | defect-scan-semantic | Concurrency-sensitive paths (status lock/stale-break, atomic writes, completion commit point, Broad-Side slot claims/merges, sub-agent re-entry) are mapped but not audited for races. | Pass 3 (concurrency/resources) is the semantic defect scan's rubric. |
| cf-arch-4 | defect-scan-mechanical | The `core/index.ts` ↔ `core/dashboard-writer.ts` import cycle and the `core/broadside/state.ts` → `client.ts` ordering drift are structural observations only; mechanical correctness/refactor risk is not assessed. | Mechanical pass (logic/error handling/config) is the early defect scan's rubric. |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | The system intent is documented. | PASS | §System Intent (three-paragraph statement of purpose, audience, and the three delivery surfaces). |
| 2 | The layer map and dependency direction are documented. | PASS | §Layer Map: Package Inventory (10 packages), Core/Pi module-role tables, and §Layer Map → "Dependency Direction" (base layer, upward edges, Broad-Side subgraph, the named `index`↔`dashboard-writer` cycle). |
| 3 | Public surfaces are identified. | PASS | §Public Surfaces enumerates the binary, all 22 MCP tools, ~21 Pi slash commands, exported modules, guide topics, file formats, network endpoints, external processes, and workflows; catalog detail in `findings/public-surfaces/public-surfaces.md`. |
| 4 | Runtime lifecycle, concurrency model, and porting priorities are summarized. | PASS | §Runtime Lifecycle, §Concurrency Model, §Porting Priorities (tiered table); detail in `findings/runtime-lifecycle/runtime-lifecycle.md`. |
| 5 | Findings are marked with evidence levels. | PASS | Evidence levels marked inline throughout (`observed fact` / `strong inference` / `external-behavior claim` / `portability hazard` / `open question`). |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits names all four plus a `COMPLETE` disposition. |

**Validated by:** 2026-09-14 (architecture phase, self-audit session)
**Overall:** PASS
