# State and Storage

> Secondary output (mode: append). Owns the catalog-level inventory of every durable
> artifact: where it lives, who writes it, its lifecycle, and whether it is committed.
> The architecture map owns the summary. Add a dated section per phase.

## 2026-09-14 — architecture phase

### Workspace filesystem map

```
<repo>/
  .codecarto/
    GUIDE.md                         # framework entry point (template, committed)
    CONVENTIONS.md                   # orchestrator-maintained (seeded, committed)
    DECISIONS.md                     # orchestrator-maintained append-only log (committed)
    BACKLOG.md                       # deferred work (committed)
    THREAD_LOG.md                    # closeout index (committed)
    dashboard.html                   # generated (gitignored)
    .dashboard-narration.local.md    # LLM summary cache (gitignored)
    inputs/                          # user-maintained (synthesis vision)
    findings/<phase>/{SKILL.md,README.md,<primary>.md,<secondary>.md}
    skills/<name>/SKILL.md           # post-pipeline skills
    templates/*.md, templates/gitignore
    workflow/{status.yaml, pipeline*.yaml, VALIDATE.md, config.yaml,
              scaffold-version.yaml, .usage.local.yaml, .orchestrator.local.yaml}
    scratch/{handoffs/<phase>.yaml, checkpoints/<phase>.md,
             amendments/<slug>.yaml, spikes/…, .gitkeep}
    closeouts/<YYYY-MM-DD>-<phase-or-module>.md
    broadside/{SKILL.md, config.yaml, state.json,
               model-catalog.json, batch-endpoints.json, <run-id>/**}
```

`observed fact`: `.codecarto/.gitignore`, `GUIDE.md` "Folder Layout", `core/workspace.ts`,
`core/dashboard-writer.ts`, `core/broadside/state.ts`.

### Durable artifacts catalog

| Artifact | Writer | Reader(s) | Committed? | Lifecycle |
|---|---|---|---|---|
| `workflow/status.yaml` | init; completion; pipeline switch; amendment | all surfaces | Yes (framework default) | Single source of truth; rewritten atomically under lock |
| `workflow/scaffold-version.yaml` | release/init | staleness check | Yes | Never hand-edited |
| `workflow/pipeline*.yaml` | framework template | pipeline engine, validation | Yes | Framework-owned; refreshable |
| `workflow/config.yaml` | user / library-init | config loader | Yes | Optional; workspace layer over user-global |
| `workflow/.usage.local.yaml` | Pi runner; MCP completion | `/codecarto-usage`, dashboard | No (gitignored) | Append-only; locked read-modify-write |
| `workflow/.orchestrator.local.yaml` | Pi init | Pi | No (gitignored) | Session pointer (absolute paths) |
| `findings/**/*.md` | phase sub-agents | later phases, porting, spec | No (gitignored by default) | Per-phase primary/secondary outputs |
| `scratch/handoffs/<phase>.yaml` | phase executor | completion | No (scratch gitignored) | Consumed once at completion; retained on disk |
| `scratch/checkpoints/<phase>.md` | Pi compaction | resuming session | No | Durable in-phase progress |
| `scratch/amendments/<slug>.yaml` | user/agent | amendment applier | No | Post-pipeline closure channel |
| `closeouts/<date>-<phase>.md` | completion / amendment | humans; dashboard summaries | Yes | One canonical file per phase/amendment |
| `THREAD_LOG.md` | completion / amendment / refresh | humans; index | Yes | Idempotent one-line entries |
| `DECISIONS.md` | completion (append); orchestrator | humans | Yes | `D<NNN> | …` rows under `## Completion log` |
| `CONVENTIONS.md` | completion (stage); orchestrator (promote) | humans; prompts | Yes | Staged under `## Pending proposals`; promoted by hand |
| `dashboard.html` | `writeDashboard` at lifecycle points | humans | No | Regenerated; self-contained |
| `.dashboard-narration.local.md` | `--narrate` | dashboard | No | Stale-counted cache |
| `broadside/state.json` | Broad-Side state writer | Broad-Side ops/dashboard | No | schema_version 1; locked atomic writes; corrupt copy preserved |
| `broadside/config.yaml` | user | Broad-Side | Template tracked (**API key risk**) | Defaults + per-repo policy |
| `broadside/model-catalog.json` | Broad-Side | pricing | No | 24 h TTL cache |
| `broadside/batch-endpoints.json` | Broad-Side | `models` action | No | Learned `:batch` endpoint accept/refuse |
| `broadside/<run>/**` | Broad-Side | collect/verify/skill | No | `requests.json`, lens results, `verified.{md,json}`, synthesis/triage |
| `inputs/vision.md` | user / vision interview | synthesis preflight | User-maintained | Raw brief; never rewritten by phases |

### Versioned library layout (external, shared across repos)

`observed fact`: `core/library.ts`; authoritative contract in `docs/library-format.md`.

```
<library>/
  .codecarto-library                # JSON marker: {schema_version, name, visibility?, created_at?, namespaced}
  entries/
    [<namespace>/]<slug>/
      latest                        # regular file containing "v<N>"
      v<N>/{reimplementation-spec.md, metadata.yaml}
  index.yaml                        # derived; INDEX_SCHEMA_VERSION 1
  INDEX.md                          # derived; do not hand-edit
  .publish.lock                     # transient lock during publish
```

Publish is content-hash idempotent: identical spec bytes update `metadata.yaml` in place
(version unchanged); new bytes create `v<latest+1>`. Two guards refuse before writing:
cross-project `source_repo` mismatch (`SourceRepoMismatchError`) and entry confidentiality
more restricted than library visibility (`ConfidentialityMismatchError`). Reindex reports —
but never rewrites — entries whose versions disagree about `source_repo`.

### In-memory / process state

- `extensions/codecarto/agent-state.ts`: per-phase activity (status, tokens, tools,
  compactions, timestamps) for the widget; not persisted.
- `mcp-server/server.ts` `serverLifetime: AbortController | null`: process-level, drives
  Broad-Side poll aborts.
- `core/utils.ts` `tempSequence`: per-process counter for unique temp suffixes.
- `core/status.ts` lock files: `<path>.lock` with pid/ISO timestamp/token, plus
  `<path>.lock.break` removal lock.
- Pi child `AgentSession`s + file-backed session files under
  `~/.pi/agent/sessions/<encoded-cwd>/` (transcripts browseable via `/resume`).

### Config state (see also `findings/config-model/config-model.md`)

- User-global `~/.codecarto/config.yaml` (or `CODECARTO_USER_CONFIG_PATH`): `orchestrator.llm_steer_next_phase`, `library.{path,namespace,publish_confirm}`.
- Workspace `workflow/config.yaml`: overrides user-global keys.
- Broad-Side `broadside/config.yaml`: `model`, `api_key`, `default_lenses`, `max_cost`,
  `pricing`, `lens_models`, `reasoning`, `incremental`, `retry_truncated`, `include_synthesis`,
  `include_triage`, `wait_seconds`, `redact_secrets`.

### Retention and cleanup

- `status.yaml`/`THREAD_LOG.md`/`DECISIONS.md`/`CONVENTIONS.md` are idempotent under re-run.
- Init's `copyPackagedWorkspace` excludes declared phase outputs, session state, usage,
  closeouts, dashboard, orchestrator files, and Broad-Side run state, so a fresh workspace
  never inherits another project's state.
- Forced re-init on the packaged template itself moves session state to
  `.codecarto-backup-<timestamp>/` file-by-file (`backupWorkspaceState`).
- A corrupt `broadside/state.json` is copied to `state.json.corrupt-<hash>` and never
  overwritten.
- A usage log that fails to parse refuses appends rather than being rewritten empty.

## 2026-09-15 — contracts phase

Durability semantics a reimplementation must preserve (narrative form in
`findings/contracts/behavioral-contracts.md` §High-Value Behaviors › Persistence and resume):

- **Every canonical in-place rewrite routes through `atomicWriteFile`** (sibling temp file +
  `rename`): `status.yaml`, the usage log, Broad-Side `state.json`, library `metadata.yaml`/
  `index.yaml`, and the dashboard. Readers see old-or-new bytes, never a truncated file. `observed
  fact`: `core/utils.ts`.
- **Read-modify-write is lock-protected** for `status.yaml` (`.lock`), the usage log
  (`.lock`), Broad-Side `state.json` (`.lock`), and library publish (`.publish.lock`). The lock file
  records pid/timestamp/token; release is token-checked; a lock older than 60 s is broken under a
  `<lock>.break` removal lock. `observed fact`: `core/status.ts`.
- **Idempotence on re-run**: the canonical closeout name, the link-deduped THREAD_LOG entry, the
  text-deduped decision rows/convention proposals, and content-hash-idempotent publish (CONVENTIONS
  C02; `core/completion.ts`, `core/library.ts`).
- **Corruption handling is non-destructive**: a corrupt `broadside/state.json` is copied to
  `state.json.corrupt-<hash>` and never overwritten; a usage log that cannot be parsed is refused
  for append (not rewritten empty); an unparsable config file is refused for rewrite.

**Hedge (inherited, `q-node-windows-fs-semantics` / findings 6.1, 6.2):** the `atomicWriteFile`
implementation is atomic *only if* `rename` over an existing destination succeeds and has no
unlink+rename fallback; the lock relies on `open(path,"wx")` O_EXCL and `mtimeMs` staleness. Both are
written to POSIX expectations. Every durability/mutual-exclusion contract above is therefore
`external-behavior claim` / `portability hazard` with action `verify at runtime` until a Windows run
confirms it (post-pipeline spike `post-mech-windows-fs`).

## 2026-09-15 — protocols phase

Catalog-level companion to `findings/protocols/protocols-and-state.md` §Persistent Schema Notes.
This section is the field-by-field serialization catalog routed here by **`cf-arch-2`**, and it
closes that item. Evidence: source inspection of the writer/reader pair named for each format; no
runtime probes, no test execution.

### Field-by-field schemas

**`workflow/status.yaml`** (`core/types.ts` `NormalizedStatus`; `core/status.ts`
`normalizeStatus`/`ensurePhaseRecord`/`ensurePostPipelineArray`; `core/workspace.ts`
`assertCanonicalStatus`). Top level: `project_name` (defaults to `basename(cwd)`), `pipeline`
(workspace-relative), `current_phase` (phase id or `complete`), `last_updated` (ISO, empty at
init), `schema_version` (read rejects >1; write requires exactly 1), `phases` (mapping),
`next_actions` (string[]), `post_pipeline` (array). Phase record: `status`, `owner_notes[]`,
`outputs_present[]`, `open_questions[]` (`id?`,`kind?`,`description?`,`deferred_reason?`),
`carry_forward[]` (same plus `target_phase?`,`derives_from?`). `post_pipeline` entry:
`id`, `kind?`, `description?`, `deferred_reason?`, `source_phase?`, `status`
(`pending`|`resolved`).

**`scratch/handoffs/<phase>.yaml`** (`core/types.ts` `PhaseHandoff`; `core/status.ts`
`parseHandoff`). `schema_version` (default 1, >1 rejected), `phase_id` (required; must equal the
validated phase), `timestamp` (deprecated/ignored), `owner_notes[]`, `open_questions[]`,
`carry_forward[]` (each entry's `target_phase` must be a downstream active phase),
`carry_forward_closures[]` (ids), `open_question_closures[]` (bare id or `{id, evidence}`),
`post_pipeline[]` (each needs `id`), `decisions[]`, `proposed_conventions[]` (`name`+`rule`
required), `closeout_summary`, `closeout_content`. Ids auto-assigned `oq-<phase>-N` / `cf-<phase>-N`.

**`scratch/amendments/<slug>.yaml`** (`core/amendment.ts`). `schema_version` (default 1, >1
rejected), `open_question_closures[]`, `post_pipeline_closures[]`, `notes[]`, `closeout_summary`,
`closeout_content`. At least one closure/note is required; the slug comes from the filename
(same alphabet as a phase id).

**`broadside/state.json`** (`core/broadside/types.ts` `BroadsideStateFile`/`BroadsideRun`).
`schema_version: 1`, `runs[]`. Each run: `id`, `createdAt`, `model`, `lenses[]`, `status`
(`in-flight`|`completed`|`partial`|`failed`), `outputDir`, `batches{lensId:{batchId,requests,
status,submittedAt,completedAt?,estimatedCost,cost?,resultCount?,error?,reason?,fallback?,
model?,outputCap?}}`, `synthesis`/`triage` `{batchId?,status,cost?,error?,verdicts?}`,
`retry?{status,batches[{model,batchId}],claimedAt,cost?}`, `verify?{status,model,top,verified,
confirmed,cost,at}`, `retiredCost?`, `totalCost?`, `pricing?`, `maxCost?`, `outputCap?`,
`sourceHead?`, `sourceDirty?`, `baseHead?`, `snapshot?`, `language?`, `redaction?{enabled,values,
files,skippedFiles}`. Corruption → `BroadsideStateError` + `state.json.corrupt-<sha1-8>`.

**Library `.codecarto-library` marker** (`core/library.ts` `LibraryMarker`): JSON
`{schema_version:1, name, namespaced, visibility?, created_at?}`; read-tolerant defaults.
**`metadata.yaml`** (`EntryMetadata`): required `slug`, `version`, `source_repo`, `analyzed_at`,
`pipeline`, `codecarto_version`, `headline`, `tags[]`, `capabilities[]`, `generation{surface,
agent,agent_version,model,model_vendor,reasoning,notes}`; optional `namespace` (iff namespaced),
`source_commit`, `source_branch`, `source_dirty`, `scope_tier_counts{p0,p1,p2}`,
`confidentiality`, `provenance{prior_version,mutation_source}`. **No `schema_version`.**
**`index.yaml`** (`LibraryIndex`): `schema_version:1`, `library_name`, `generated_at`,
`entry_count`, `namespaces[]`, `entries[]{slug,namespace?,latest_version,versions[],source_repo,
headline,tags[],capabilities[],confidentiality?,last_analyzed_at,last_codecarto_version}`;
sorted by `(namespace, slug)`. **`latest`**: regular file containing `v<N>\n`.

**`workflow/.usage.local.yaml`** (`core/usage.ts`): `version:1`, `runs[]{timestamp,phase,status,
turn_count,tool_uses,duration_ms,tokens{input,output,cache_write},session_file?,compactions?
{successful,failed,aborted,reasons{threshold,overflow,manual}},recorded_by?}`. Append-only under
`path.lock`; a corrupt log refuses appends.
**`workflow/scaffold-version.yaml`**: `{scaffold_version: "x.y.z"}` (string or number).
**`workflow/config.yaml` + `~/.codecarto/config.yaml`**: `orchestrator.llm_steer_next_phase`,
`library.{path,namespace,publish_confirm}`. **`broadside/config.yaml`**: `model`, `api_key`,
`default_lenses`, `max_cost`, `pricing{input_per_m,output_per_m}`, `lens_models`, `reasoning`,
`incremental`, `retry_truncated`, `include_synthesis`, `include_triage`, `wait_seconds`,
`redact_secrets`. **`model-catalog.json`**: schema 3 (2 read), per-entry `fetched_at`.
**`batch-endpoints.json`**: `{schema_version:1, models{model:{status,at,error?}}}`.
**`scratch/checkpoints/<phase>.md`**: frontmatter `phase`, `updated_at`, `tokens_before`,
`source`.

### Persistence semantics

- **Mutable in place, atomic (temp+rename):** `status.yaml`, usage log, `state.json`,
  `metadata.yaml`, `index.yaml`, `latest`, marker, dashboard, checkpoint.
- **Append-only:** usage `runs[]`; `THREAD_LOG.md` lines (link-deduped); `DECISIONS.md` rows
  (text-deduped); `CONVENTIONS.md` proposals (text-deduped).
- **Derived/regenerable:** `index.yaml`, `INDEX.md`, `dashboard.html`, run-meta files, catalog
  cache.
- **Compaction:** host-driven (Pi session compaction) only; the framework writes a checkpoint
  summary, it never compacts artifacts. Dashboard narration is an opt-in cached summary with a
  stale count (`phaseCountAtGeneration`).
- **Replay/resume:** handoff consumed once, retained; Broad-Side `collect` replayable; publish
  re-run hits the content-hash branch; amendment re-run reports already-closed ids.
- **Locking/dedup/conflict:** `status.yaml.lock`, usage `path.lock`, `state.json.lock`,
  `.publish.lock`; removal serialized by `<lock>.break`; publish dedups by SHA-256; provenance
  conflicts detected, never auto-repaired.

**Hedge (unchanged):** every lock/rename/containment claim above is `portability hazard` with
action `verify at runtime` on non-POSIX (`q-node-windows-fs-semantics`).

**`cf-arch-2` closed here** (and in the primary output's §Persistent Schema Notes): the five
formats named in the routed item — plus their sibling formats — are now specified field-by-field.

## 2026-09-15 — porting phase

Port-oriented companion to `findings/porting/reverse-engineering-bundle.md` §Protocol and State
Notes and §YAML Codec Decision. No new schema walk; the porting phase re-confirmed three write-path
facts by source read and fixed the codec policy a port must follow.

### Re-confirmed write-path facts

- `reindex` (`core/library.ts:947-1001`) does not itself take `.publish.lock`; `publishEntry`
  (`:619`) takes it and calls `reindex` under it, but standalone `library_reindex`/`library_list`
  call `reindex`/`listEntries` unlocked (semantic 3.4). `listEntries` also calls `reindex` when the
  existing index fails to parse (`:919-930`), so a **read** command can rewrite `index.yaml` —
  against its "read-only, may build if absent" contract (5.3).
- `writeLibraryConfig` writes the user-global config with a plain `writeFile`, no lock
  (semantic 3.7).
- `refreshScaffold` (`core/workspace.ts:430-458`) copies framework files with `copyFile` and
  appends `THREAD_LOG` with no lock and no dedupe; it does **not** call `writeDashboard` (the
  `cfs-mech-3` contradiction, resolved in the bundle §Contradiction Sweep).

### Codec policy for a port (closes `cf-protocols-1`)

Every persisted workflow shape is parsed by the same hand-rolled codec, so the codec is a wire
format (C04), not an implementation detail. The port must refuse duplicate keys, apply one
`__proto__`/prototype-pollution guard everywhere (mappings **and** sequence merges), preserve the
scalar round-trip quoting rule, decide the flow-collection policy explicitly, preserve key order,
and reject tabs/multi-document streams. Either reproduce the dialect or wrap a full parser in an
adapter that re-imposes these contracts; a bare default YAML library is not a port. The per-stack
library choice is routed to `reimplementation-spec` as `cf-porting-1`.
