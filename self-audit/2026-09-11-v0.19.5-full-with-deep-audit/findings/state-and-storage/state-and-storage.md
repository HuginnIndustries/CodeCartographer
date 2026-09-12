# State and Storage

Catalog-level detail accumulated across phases (`mode: append`).

## 2026-09-11 — architecture

All rows `observed fact` from source. "Guard" is the concurrency/atomicity discipline the writer uses.

### Workspace (`<repo>/.codecarto/`)

| Path | Writer(s) | Reader(s) | Format | Guard | Committed? |
|---|---|---|---|---|---|
| `workflow/status.yaml` | `updateStatusAtomically`, `switchPipeline`, init (`writeFile` direct, `server.ts:241`) | every tool via `getWorkspaceState` | hand-rolled YAML, `schema_version: 1` | `status.yaml.lock` + temp/rename (init path writes without lock) | yes |
| `workflow/status.yaml.lock` | `acquireLock` | — | `<pid>\n<iso>\n` | O_EXCL; 5 s timeout; broken after 60 s mtime | no (transient) |
| `workflow/scaffold-version.yaml` | release/init copy, `refreshScaffold` | `getWorkspaceState` | YAML `scaffold_version` | plain copy | yes |
| `workflow/config.yaml` | user; `writeLibraryConfig` when pointed here | `loadCodecartoConfig` | YAML `orchestrator:`/`library:` | overwrite | yes |
| `workflow/.usage.local.yaml` | `appendUsageRun` (Pi runner with telemetry; MCP complete with zeroed receipt) | `loadUsage` | YAML `{version, runs[]}` | temp/rename, **no lock** | no (gitignored) |
| `workflow/pipeline*.yaml` | template/refresh | `getWorkspaceState`, `switchPipeline` | YAML DAG | read-only | yes |
| `scratch/handoffs/<phase>.yaml` | phase executor (LLM) | `loadHandoffFile` at completion | YAML schema 1 | none | no |
| `scratch/checkpoints/<phase>.md` | `writePhaseCheckpoint` (Pi compaction) | listed in phase prompt if present | frontmatter + markdown | temp/rename | no |
| `scratch/amendments/<slug>.yaml` | user/LLM | `loadAmendmentFile` | YAML schema 1 | none | no |
| `findings/<phase>/<primary>.md` | phase executor | `validatePhaseOutput`, `collectCoverageGaps`, later phases | markdown with validation block, coverage ledger, findings tables | none | gitignored in this repo's template `.gitignore` |
| `findings/{public-surfaces,runtime-lifecycle,state-and-storage,build-and-deploy,config-model}/*.md` | phase executor (append) | later phases | markdown, dated sections | none | gitignored |
| `closeouts/<YYYY-MM-DD>-<phase>.md` | `writeCompletionArtifacts` (from handoff `closeout_content` or template copy) | dashboard, narrator, rewriter | markdown | overwrite | excluded from npm tarball |
| `closeouts/<date>-amendment-<slug>.md` | `applyAmendment` | dashboard | markdown | overwrite | — |
| `THREAD_LOG.md` | completion, amendment, refresh (append; dedupe by closeout link / exact line) | humans | one `- <date> — <phase> — <summary> — [closeout](…)` line per event | append, unlocked for refresh | excluded from tarball |
| `DECISIONS.md` | `appendDecisionLog` (numbered `D<NNN> \|` rows under `## Completion log`) | prompt lists it as a read | markdown | overwrite | excluded |
| `CONVENTIONS.md` | `stageProposedConventions` (`- **name** (phase, date) — rule` under `## Pending proposals`) | `countPendingProposals` | markdown | overwrite | excluded |
| `BACKLOG.md` | seeded from template; user | — | markdown | — | excluded |
| `dashboard.html` | `writeDashboard` (init, next, complete, amend, dashboard, publish on Pi) | browser | self-contained HTML + JSON island | temp/rename, best-effort | gitignored |
| `.dashboard-narration.local.md` | `narrateDashboard` | `loadNarration` | frontmatter `{generatedAt, phaseCountAtGeneration}` + body | temp/rename | gitignored |
| `broadside/config.yaml` | user | `loadBroadsideConfig` | YAML | — | yes (template); may hold `api_key` |
| `broadside/state.json` | `persistBroadsideRun`, `saveBroadsideState` | submit/collect/status | JSON `{schema_version:1, runs[]}` | `state.json.lock` + temp/rename | gitignored |
| `broadside/model-catalog.json` | `writeCatalogCache` | `readCatalogCache` | JSON, 24 h TTL | plain write | gitignored |
| `broadside/<run-id>/` | submit (`requests.json`), collect (`raw-<lens>.json`, `<id>.json`, `<id>.md`, `*.error.json`, `synthesis.*`, `triage.*`, `run-meta.json`) | humans, scout phase | JSON + markdown | plain writes | gitignored |
| `inputs/vision.md` | user / `codecarto_vision` output | synthesis preflight | markdown | — | yes |

### User-global

| Path | Writer | Reader | Notes |
|---|---|---|---|
| `~/.codecarto/config.yaml` (or `$CODECARTO_USER_CONFIG_PATH`) | `codecarto_library_init`, `/codecarto-library-init` via `writeLibraryConfig` | `loadUserConfig`, `loadCodecartoConfig` (lower-precedence layer) | `library.path` stored absolute after tilde expansion (`core/orchestrator-config.ts:143-145`) |

### Library (`library.path`)

| Path | Writer | Guard |
|---|---|---|
| `.codecarto-library` | `writeMarker` | temp/rename |
| `entries/[<ns>/]<slug>/v<N>/reimplementation-spec.md` + `metadata.yaml` | `publishEntry` (staging dir → rename into place) | rename; no cross-process lock |
| `entries/[<ns>/]<slug>/latest` | `writeLatestPointer` | temp/rename; regular file, never a symlink |
| `index.yaml`, `INDEX.md` | `reindex` | temp/rename |
| git commits | `commitPublish` (opt-in; never pushes) | — |

### Pi-host state

| Path | Notes |
|---|---|
| `~/.pi/agent/sessions/<encoded-cwd>/*` | phase child sessions persisted alongside the orchestrator's, tagged `parentSession` and named `CodeCartographer phase: <id>` (`agent-runner.ts:150-165`) |
| `~/.pi/agent/auth.json`, `models.json` | read by `createChildModelRuntime` |
| `<repo>/.codecarto-backup-<ts>/` | init `force` / confirmed re-init moves the old workspace here |

### Environment variables

| Variable | Read at | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | `mcp-server/server.ts:1162`, `extensions/codecarto/index.ts:191` | Broad-Side auth; precedence: explicit param (MCP) → env → `broadside/config.yaml` |
| `CODECARTO_USER_CONFIG_PATH` | `core/orchestrator-config.ts:67` | override user-global config location (tests/tooling) |

### In-process state (Pi only)

`agent-state.ts` module Map of `PhaseActivity`; `agent-widget.ts` singleton with an 80 ms interval; extension-factory closure vars `codecartoModeActive`, `lastFeedbackLines`, `sessionCwd`. The MCP server holds no state between calls.

## 2026-09-11 — contracts

Write matrix per operation (`observed fact`; ✓ = written/modified, ✗ = never touched):

| Operation | status.yaml | closeouts/ | THREAD_LOG | DECISIONS | CONVENTIONS | .usage.local | dashboard.html | findings/ | library |
|---|---|---|---|---|---|---|---|---|---|
| init | ✓ (fresh) | dir created | seeded | seeded | seeded | ✗ | ✓ (Pi) | copied from template (mech 1.2) | ✗ |
| open / status / next (MCP) / validate / config / usage / list_skills / guide | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| next (Pi) | via completion | via completion | via completion | via completion | via completion | ✓ | ✓ | ✓ (child agent) | ✗ |
| complete | ✓ (lock) | ✓ | ✓ (once) | ✓ (rows) | ✓ (pending list) | ✓ (MCP receipt) | ✓ | ✗ | ✗ |
| switch_pipeline | ✓ (lock) | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (Pi only) | ✗ | ✗ |
| amend | ✓ (lock) | ✓ | ✓ (once) | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| refresh_scaffold | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | SKILL/README stubs only | ✗ |
| dashboard | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| publish | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (Pi) | ✗ | ✓ |
| library_init | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | marker + `~/.codecarto/config.yaml` |
| broadside submit/collect | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `broadside/` state and run dir |

## 2026-09-11 — protocols

Schema-version axes and what each gates (`observed fact`):

| File | Version field | Written value | Read behavior |
|---|---|---|---|
| `workflow/status.yaml` | `schema_version` | 1 | > 1 refused on read (`normalizeStatus`) and on write (`assertCanonicalStatus`); missing → 1 |
| `scratch/handoffs/*.yaml`, `scratch/amendments/*.yaml` | `schema_version` | (LLM) | > 1 refused; missing → 1 |
| `workflow/scaffold-version.yaml` | `scaffold_version` | package version | mismatch warns; ≥ 0.17.1 turns the findings-pairing NOTE into a FAIL; ≥ 0.19.0 turns the evidence-less runtime closure NOTE into a refusal |
| `.codecarto-library` | `schema_version` | 1 | read tolerantly, never compared |
| `index.yaml` | `schema_version` | 1 | read tolerantly, never compared |
| `broadside/state.json` | `schema_version` | 1 | never compared |
| `broadside/model-catalog.json` | `schema_version` | **2** | never compared; TTL keyed on one file-level `fetched_at` |
| `workflow/.usage.local.yaml` | `version` | 1 | never compared |

## 2026-09-11 — porting

Byte-compatibility decisions (closes proto-CF2; `strong inference`): preserve byte-for-byte — `workflow/status.yaml` schema, handoff/amendment schemas, the `.codecarto/` template paths, THREAD_LOG/DECISIONS/CONVENTIONS line formats, the library format (marker, `metadata.yaml`, `index.yaml`, `INDEX.md`, `latest`), `broadside/state.json` and run-dir names. May re-encode with tests re-pinned — `workflow/.usage.local.yaml` (append-only lines recommended, D-M7), `dashboard.html` data island, `model-catalog.json`, `.dashboard-narration.local.md`, checkpoints. All writers go through one state-store primitive (owned lock + unique-suffix atomic write), D-H4/D-H5.
