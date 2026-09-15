# Behavioral Contracts — CodeCartographer (`codecartographer-pi` v0.25.0)

> Self-audit: the analyzed source is the repository outside `.codecarto/`, i.e. the
> CodeCartographer framework itself. This phase recovers **user-visible behavior**: what each
> surface does, its defaults, side effects, persisted state, error behavior, and recovery path,
> ending in a black-box acceptance list another implementation can run.
>
> Evidence levels are marked inline as `observed fact`, `strong inference`,
> `external-behavior claim`, `portability hazard`, or `open question`. Catalog-level detail for
> this phase's declared secondary outputs lives in `findings/public-surfaces/`,
> `findings/runtime-lifecycle/`, `findings/state-and-storage/`, and `findings/config-model/`;
> this report owns the feature contracts and the load-bearing claims.

## Surfaces Covered

CodeCartographer exposes six user-facing surfaces. Two are executable, three are storage/format
surfaces a user or another tool reads and writes, and one is a generated artifact
(`observed fact`: `package.json`, `extensions/codecarto/index.ts`, `mcp-server/server.ts`,
`core/workspace.ts`, `core/library.ts`, `core/dashboard.ts`).

| # | Surface | Kind | Entry points | Owner |
|---|---|---|---|---|
| 1 | **MCP tools** | API / JSON-RPC over stdio | 22 `codecarto_*` tools | `mcp-server/server.ts` → `core/index.ts` |
| 2 | **Pi slash commands** | CLI / TUI | 20 `/codecarto-*` commands + hooks | `extensions/codecarto/index.ts` → `core/index.ts` |
| 3 | **Broad-Side** | Background worker / network | `codecarto_broadside`, `/codecarto-broadside` | `core/broadside/` |
| 4 | **Drop-in `.codecarto/` workspace** | Storage / file format | plain files, no executable code | `.codecarto/` template + `core/workspace.ts` |
| 5 | **Versioned library** | External storage | `.codecarto-library`, `entries/…/v<N>/` | `core/library.ts` |
| 6 | **Dashboard** | Generated artifact (HTML) | `dashboard.html` | `core/dashboard.ts` / `dashboard-writer.ts` |

There is **no network server, no web UI, and no authentication service**. The two executable
surfaces are local processes; the only outbound network is OpenRouter (Broad-Side) and `git`
subprocesses (`observed fact`: `core/broadside/client.ts`, `core/library.ts`).

---

## Feature Contracts

The workflow-control features are implemented once in `core/` and exposed by both surfaces with
byte-identical prompts and validation (CONVENTIONS C01). Their contract is therefore stated once
with the surface-specific differences called out. The exhaustive per-argument catalogs are in the
two `cf-arch-1` sections below and in
`findings/public-surfaces/public-surfaces.md §2026-09-15 (contracts phase)`.

### Surface 1 + 2: MCP tools and Pi slash commands (shared workflow control)

#### 1. Workspace init

| Field | Value |
|---|---|
| **Feature** | Initialize a `.codecarto/` workspace in a repository |
| **Trigger or input** | MCP `codecarto_init {cwd, pipeline?, force?}`; Pi `/codecarto-init [variant]` |
| **Defaults** | `pipeline`: the framework default `workflow/pipeline-full-with-deep-audit.yaml` (or the existing `status.yaml`'s pipeline on re-init). `force`: `false` (MCP). Pi asks with `ctx.ui.confirm` instead of a flag. |
| **Observable output** | Text: `Initialized CodeCartographer workspace at <dir>. Pipeline: <label> (<path>). First phase: <id>.` plus seeded-file names when files were seeded. MCP also returns `{workspaceDir, pipeline, pipelineLabel, firstPhase, seededOrchestratorFiles}`. |
| **Side effects** | Copies the packaged template into `cwd/.codecarto` (filtered: project state, session outputs, dashboard, usage, orchestrator files excluded); seeds `CONVENTIONS.md`/`DECISIONS.md`/`BACKLOG.md`/`THREAD_LOG.md` from templates; writes `status.yaml`; writes `.gitignore` from `templates/gitignore` when absent; MCP renders the dashboard only implicitly through later completion, Pi renders it immediately. Pi also sets active tools to the safe set and activates CodeCartographer mode. An existing `.codecarto/` is refused (MCP) or confirmed (Pi), then moved to `.codecarto-backup-<ISO-timestamp>/` before re-init — or, when the target *is* the packaged template itself, its state is moved file-by-file. |
| **Persisted state** | The whole `.codecarto/` tree; `workflow/status.yaml` (`schema_version: 1`, all phases `pending`, `current_phase` = first pipeline phase); `workflow/scaffold-version.yaml` (from the packaged template); `CONVENTIONS.md`/`DECISIONS.md`/`BACKLOG.md`/`THREAD_LOG.md`. |
| **Error behavior** | MCP: `InvalidParams` for a non-absolute/missing `cwd` or unknown pipeline; `InvalidRequest` when `.codecarto/` exists without `force`; `InternalError` when the packaged assets are missing. Pi: `notify` at `error`/`warning`; a declined confirmation writes nothing. |
| **Retry or recovery** | Re-run with `force: true` (MCP) / confirm (Pi) to back up and reinitialize; for a `.codecarto/` holding only `broadside/` (a scout-only repo), init merges the template in without a backup. `codecarto_open` reattaches without resetting. |
| **Owner** | `core/workspace.ts` (`copyPackagedWorkspace`, `seedOrchestratorFiles`, `backupWorkspaceState`); wrappers `mcp-server/server.ts handleInit`, `extensions/codecarto/index.ts codecarto-init` |
| **Evidence** | `observed fact` (code + `tests/mcp-server.test.mjs`, `tests/init-workspace-isolation.test.mjs`, `tests/init-same-workspace.test.mjs`). The copy/backup writes go through plain `fs` calls except `status.yaml`, which is a plain `writeFile` at init (not `atomicWriteFile`). |

#### 2. Workspace open

| Field | Value |
|---|---|
| **Feature** | Activate an existing workspace without resetting it |
| **Trigger or input** | MCP `codecarto_open {cwd}`; Pi `/codecarto-open` |
| **Defaults** | None. |
| **Observable output** | Text: `Opened existing CodeCartographer workspace: <label>. Current phase: <id>.` MCP returns `{pipeline, currentPhase, stuck?}`. |
| **Side effects** | MCP: none (read-only). Pi: activates mode, sets safe tools, refreshes widget/session name. |
| **Persisted state** | None. |
| **Error behavior** | MCP: `InvalidParams` for bad `cwd`; `InvalidRequest` when no `workflow/status.yaml` exists. Pi: warning `No existing CodeCartographer workspace found. Run /codecarto-init first.` |
| **Retry or recovery** | Run `/codecarto-init`. |
| **Owner** | `handleOpen`; `getWorkspaceState`; `resolvePipelineOutcome` |
| **Evidence** | `observed fact` (code; `tests/stuck-pipeline.test.mjs` covers the stuck line). |

#### 3. Status

| Field | Value |
|---|---|
| **Feature** | Report current phase, pipeline, progress, open-question/carry-forward/post-pipeline counts, next actions, scaffold staleness, missing outputs |
| **Trigger or input** | MCP `codecarto_status {cwd}`; Pi `/codecarto-status` |
| **Defaults** | None. |
| **Observable output** | A multi-line summary. `Pipeline state` is `in progress`, `complete`, or `stuck`; a stuck pipeline appends the one-sentence `describeStuckPipeline` diagnosis naming each unmet `depends_on`. A phase recorded complete whose primary output is absent on disk is named (findings are gitignored by default). MCP returns the full count object; Pi renders the widget. |
| **Side effects** | Read-only. |
| **Persisted state** | None. |
| **Error behavior** | MCP: `InvalidParams` for bad `cwd`; `InvalidRequest` when `status.yaml` does not parse, lacks `pipeline:`, or names a missing pipeline file (the fix is the user's, so it is not an `InternalError`). Pi: error notification. |
| **Retry or recovery** | Fix `status.yaml`/pipeline, re-run. |
| **Owner** | `handleStatus`; `resolvePipelineOutcome`; `describeStuckPipeline`; `listMissingCompletedOutputs`; `describeScaffoldStaleness` |
| **Evidence** | `observed fact` (code; `tests/stuck-pipeline.test.mjs`, `tests/missing-completed-outputs.test.mjs`, `tests/scaffold-staleness.test.mjs`). |

#### 4. Next-phase prompt

| Field | Value |
|---|---|
| **Feature** | Emit the next eligible phase's prompt (the drive loop) |
| **Trigger or input** | MCP `codecarto_next {cwd, unattended?}`; Pi `/codecarto-next [--auto] [--strict] [--llm-steer\|--no-llm-steer]` |
| **Defaults** | `unattended`/`auto` false. Pi `--strict` requires `--auto`; otherwise the parser sets `error: "Flag --strict requires --auto."`. |
| **Observable output** | MCP returns the prompt text inline (also carried under `structuredContent.text`) and `{phase, forced:false, unattended}`; at the terminal it returns `All CodeCartographer phases are complete…` with `{complete:true}`. Pi spawns an isolated `AgentSession` sub-agent, then auto-validates and auto-completes; `--auto` loops until complete/stuck/abort. The prompt is **byte-identical** to `buildPhasePrompt` on both surfaces (test-pinned). |
| **Side effects** | MCP: none beyond prompt assembly. Pi: spawns a child session, records usage, refreshes the dashboard, emits a phase summary, and on success `autoCompletePhase`. |
| **Persisted state** | On Pi auto-completion: `status.yaml` advances; closeout/THREAD_LOG/decisions/conventions written post-commit. |
| **Error behavior** | MCP: `InvalidRequest` with the stuck sentence when the pipeline is stuck (not a text result, so a looping host cannot read "done"); `InvalidRequest` for preflight/`buildPhasePrompt` failures. Pi: error/warning notification; a re-entry guard refuses a second sub-agent for a phase already running. |
| **Retry or recovery** | Re-run; `codecarto_phase` forces a specific phase; `codecarto_validate`/`codecarto_complete` run manually if auto-validation fails. |
| **Owner** | `handleNext`; `buildPhasePrompt` (`core/prompts.ts`); Pi `runSinglePhase`/`runAuto` (`extensions/codecarto/auto-runner.ts`) |
| **Evidence** | `observed fact` (code; `tests/mcp-server.test.mjs` pins byte-identity, `tests/next-flags.test.mjs`, `tests/prompts-auto.test.mjs`). Prompt **assembly** is `observed fact`; whether Pi and MCP execution produce equivalent *outcomes* is `external-behavior claim` → `q-pi-sdk-execution-parity`. |

#### 5. Forced phase prompt

| Field | Value |
|---|---|
| **Feature** | Emit a specific phase's prompt even out of DAG order |
| **Trigger or input** | MCP `codecarto_phase {cwd, phase, unattended?}`; Pi `/codecarto-phase <phase>` |
| **Defaults** | `unattended` false. Phase ids may be given by id or by primary-output basename (`contracts` or `behavioral-contracts`, `.md` optional). |
| **Observable output** | The prompt, with the extra line `The user explicitly requested this phase even if it is not the next eligible phase.` MCP returns `{phase, forced:true}`. |
| **Side effects** | MCP: none. Pi: queues the prompt into the session (`sendUserMessage`, `followUp` when busy) — it does **not** spawn a sub-agent. |
| **Persisted state** | None. |
| **Error behavior** | MCP: `InvalidParams` when `phase` is absent/not a string, or unknown. Pi: error notification. Unmet `depends_on` adds a warning line but does not block. |
| **Retry or recovery** | Omit `phase` to get the next eligible. |
| **Owner** | `handlePhase`; `resolvePhase` (`core/pipeline.ts`) |
| **Evidence** | `observed fact` (code; `tests/resolve-phase.test.mjs`). |

#### 6. Validate

| Field | Value |
|---|---|
| **Feature** | Parse a phase output's `## Validation` table and cross-check it |
| **Trigger or input** | MCP `codecarto_validate {cwd, phase?}`; Pi `/codecarto-validate [phase]` |
| **Defaults** | Omitted `phase` validates the next eligible phase. |
| **Observable output** | `PASS` / `PASS WITH GAPS` / `FAIL` / `MISSING`. `MISSING` = primary output absent (`exists:false`). `FAIL` = no `## Validation` block, no parseable rows, an unreadable/FAIL `**Overall:**` line, or a findings-pairing violation. `PASS WITH GAPS` = one or more PARTIAL rows. Non-gating NOTE lines report missing declared secondary outputs, findings warnings, and stale-scaffold downgrades. |
| **Side effects** | Read-only. |
| **Persisted state** | None. |
| **Error behavior** | MCP: `InvalidParams` for unknown phase or a non-string `phase` argument (`requireOptionalPhase`); `InvalidRequest` for workspace errors. Pi: error notification. |
| **Retry or recovery** | Fix the output and re-run. |
| **Owner** | `validatePhaseOutput` (`core/pipeline.ts`); `crossCheckFindings` (`core/findings.ts`); `handleValidate` |
| **Evidence** | `observed fact` (code; `tests/overall-line.test.mjs`, `tests/findings-cross-check.test.mjs`, `tests/mcp-server.test.mjs`). |

#### 7. Complete

| Field | Value |
|---|---|
| **Feature** | Mark a validated phase complete and advance the pipeline |
| **Trigger or input** | MCP `codecarto_complete {cwd, phase?}`; Pi `/codecarto-complete [phase]` |
| **Defaults** | Omitted `phase` completes the next eligible phase. |
| **Observable output** | `Marked <phase> complete (validation: <verdict>). Next phase: <id>.` plus closeout notice, orchestrator checkpoint, dashboard line, and NOTE lines. MCP returns the structured equivalent. |
| **Side effects** | **Under the `status.yaml.lock`**: re-validate the output authoritatively, build the next status, apply the handoff, turn untracked PARTIAL rows into `needs-maintainer-decision` questions, recompute the cursor; then `atomicWriteFile` renames `status.yaml` (the **commit point**). **After commit, idempotent**: canonical closeout, one link-deduped `THREAD_LOG` entry, appended `DECISIONS.md` rows, staged `CONVENTIONS.md` proposals. Caller-side: Pi records usage; MCP appends a zeroed `mcp-complete` usage receipt; both refresh the dashboard. |
| **Persisted state** | `workflow/status.yaml`; `closeouts/<date>-<phase>.md`; `THREAD_LOG.md`; `DECISIONS.md`; `CONVENTIONS.md`; `workflow/.usage.local.yaml`; `dashboard.html`. |
| **Error behavior** | Refuses (`InvalidRequest` on MCP, error notification on Pi) when validation is `FAIL`/`MISSING`, when a phase declaring `handoff_requirements` has no handoff, when a `carry_forward.target_phase` is not a downstream active phase, when a `post_pipeline` entry lacks an id, or on a closure-integrity violation (D1: closing a `derives_from` item while its question is open; D3: closing a `needs-runtime-test` question without evidence on a ≥0.19.0 scaffold). A re-validation under the lock refuses if the output changed since the caller's snapshot. |
| **Retry or recovery** | Re-run after fixing; post-commit steps are idempotent, so a failure between commit and artifacts is repaired by re-running completion. |
| **Owner** | `completeValidatedPhase` (`core/completion.ts`); `updateStatusAtomically`, `applyHandoff` (`core/workspace.ts`/`core/status.ts`); `handleComplete` |
| **Evidence** | `observed fact` (code; `tests/completion-commit-point.test.mjs`, `tests/closure-integrity.test.mjs`, `tests/partial-row-questions.test.mjs`). **Durability** of the `status.yaml` rename and **mutual exclusion** of the lock are `external-behavior claim`/`portability hazard` → `q-node-windows-fs-semantics` (findings 6.1, 6.2), action `verify at runtime`. |

#### 8. Switch pipeline

| Field | Value |
|---|---|
| **Feature** | Change the active pipeline in place without deleting findings |
| **Trigger or input** | MCP `codecarto_switch_pipeline {cwd, pipeline}`; Pi `/codecarto-switch-pipeline <variant>` |
| **Defaults** | `pipeline` is a known alias (`full`, `lite`, `synthesis`, `scout-first`, `full-with-audit`, `full-with-deep-audit`, `defect-scan`, `architecture-only`) or any `*.yaml` path. |
| **Observable output** | `Switched pipeline: <label>`; optional lines naming carried-completed, new, and dropped phases, dangling carry-forwards moved to `post_pipeline`, the new `current_phase`, and a dashboard-refreshed line. Already on the target → `Already on pipeline: <label>` (MCP) / info notification (Pi). |
| **Side effects** | Rewrites `status.yaml` under the lock: preserves phase records present in both pipelines, drops records unique to the old pipeline (findings stay on disk), moves carry-forwards whose target was dropped to `post_pipeline`, recomputes the cursor, refreshes the dashboard (MCP does so explicitly since #254). |
| **Persisted state** | `workflow/status.yaml`; `dashboard.html`. |
| **Error behavior** | MCP: `InvalidRequest` for unknown pipeline or a missing pipeline file (`Pipeline not found: …`); Pi: error notification. |
| **Retry or recovery** | Switch back; dropped findings remain on disk. |
| **Owner** | `switchPipeline` (`core/workspace.ts`); `handleSwitchPipeline` |
| **Evidence** | `observed fact` (code; `tests/pipeline-switch-cursor.test.mjs`, `tests/switch-dashboard-and-captured-cwd.test.mjs`). |

#### 9. Post-pipeline skill and skill listing

| Field | Value |
|---|---|
| **Feature** | Run a post-pipeline skill, or list skills |
| **Trigger or input** | MCP `codecarto_skill {cwd, name}` / `codecarto_list_skills {cwd}`; Pi `/codecarto-skill <name>` / `/codecarto-list-skills` |
| **Defaults** | The `broadside` name is exempt from the completion gate and works with no workspace. Skill names are resolved against the installed list only — a traversal name is never joined onto a path. |
| **Observable output** | Skill prompt text (`buildSkillPrompt`) or the Broad-Side reading guide; the list names installed skills and, separately, the ungated `broadside` guide. |
| **Side effects** | Read-only; Pi queues the prompt. |
| **Persisted state** | None. |
| **Error behavior** | MCP: `InvalidRequest` while the pipeline is incomplete/stuck or the Broad-Side guide is missing; `InvalidParams` for an unknown name (with the available list and the Broad-Side hint). Pi: same, as notifications. |
| **Retry or recovery** | Finish the pipeline; install a skill under `.codecarto/skills/<name>/SKILL.md`. |
| **Owner** | `resolveSkillName`, `buildSkillPrompt`, `readBroadsideSkill`; `handleSkill`/`handleListSkills` |
| **Evidence** | `observed fact` (code; `tests/skill-name-resolution.test.mjs`, `tests/pi-parity-commands.test.mjs`). |

#### 10. Guide

| Field | Value |
|---|---|
| **Feature** | Serve the packaged agent guide |
| **Trigger or input** | MCP `codecarto_guide {topic?}`; Pi `/codecarto-guide [topic]` |
| **Defaults** | Omitted topic → `overview` (`agent-skill/codecartographer/SKILL.md`). Topics: `overview`, `broadside`, `carrying-results-forward`, `deep-audit-synthesis`, `executors`, `handoff-contract`, `kernel-first-rewrite`, `library`, `orchestration`, `phase-recovery`, `pipeline-selection`. Needs no workspace. |
| **Observable output** | The document, frontmatter stripped; a footer lists the other topics (spelled for the surface). Pi wraps it in "reference, not a task" framing. |
| **Side effects** | Read-only; Pi queues the message. |
| **Persisted state** | None. |
| **Error behavior** | MCP: `InvalidParams` for an unknown topic or when the packaged skill is missing. Pi: error notification. |
| **Retry or recovery** | Reinstall `codecartographer-pi` if the packaged skill is missing. |
| **Owner** | `readGuide`, `listGuideTopics` (`core/guide.ts`); `guide-framing.ts` |
| **Evidence** | `observed fact` (code; `tests/guide.test.mjs`, `tests/pi-parity-commands.test.mjs`). |

#### 11. Config

| Field | Value |
|---|---|
| **Feature** | Show the effective merged configuration |
| **Trigger or input** | MCP `codecarto_config {cwd?}`; Pi `/codecarto-config` |
| **Defaults** | No `cwd` → user-global layer only; with `cwd` → user-global overlaid by `.codecarto/workflow/config.yaml`. |
| **Observable output** | `library.path`, `library.namespace`, `library.publish_confirm`, `orchestrator.llm_steer_next_phase`, library-marker status, both config paths, and one line per config **problem**. |
| **Side effects** | Read-only. |
| **Persisted state** | None. |
| **Error behavior** | MCP: `InvalidParams` for a non-absolute/missing `cwd`. Otherwise never throws; problems are reported in the output. |
| **Retry or recovery** | Fix or remove the offending file; `problems` is non-empty until then, and publish/library tools refuse while it is. |
| **Owner** | `loadCodecartoConfig`/`loadUserConfig` (`core/orchestrator-config.ts`); `handleConfig`; `describeConfigProblems` |
| **Evidence** | `observed fact` (code; `tests/config-problems.test.mjs`, `tests/orchestrator-config.test.mjs`). |

#### 12. Vision interview

| Field | Value |
|---|---|
| **Feature** | Produce a prompt that synthesizes `inputs/vision.md` from raw product text (synthesis pipeline only) |
| **Trigger or input** | MCP `codecarto_vision {cwd, raw_text}`; Pi `/codecarto-vision` |
| **Defaults** | None. `raw_text` is required and embedded verbatim. |
| **Observable output** | A prompt embedding the interview skill and the user's text, instructing the agent to write `.codecarto/inputs/vision.md`. Pi runs the interview in-session. |
| **Side effects** | MCP: none. Pi: queues/sends the interview prompt. No file is written by the tool itself. |
| **Persisted state** | `inputs/vision.md`, written later by the agent, not the tool. |
| **Error behavior** | MCP: `InvalidParams` when `raw_text` is absent/empty or `cwd` is bad; `InvalidRequest` when the interview skill is missing (i.e. `codecarto_init` was not run with the synthesis pipeline). Pi: warning when `INTERVIEW.md` is absent. |
| **Retry or recovery** | Run `codecarto_init synthesis`. |
| **Owner** | `handleVision`; `findings/vision-capture/INTERVIEW.md` |
| **Evidence** | `observed fact` (code). |

#### 13. Usage

| Field | Value |
|---|---|
| **Feature** | Report cumulative and per-phase token/tool/duration totals from the local usage log |
| **Trigger or input** | MCP `codecarto_usage {cwd}`; Pi `/codecarto-usage` |
| **Defaults** | None. |
| **Observable output** | Totals and per-phase rows; Pi also reports compaction success/fail/abort counts when present. MCP notes how many runs are zeroed `mcp-complete` receipts (unknowns, not free runs). Empty log → `No phase runs recorded yet.` |
| **Side effects** | Read-only. |
| **Persisted state** | None (reads `workflow/.usage.local.yaml`). |
| **Error behavior** | MCP: `InvalidParams`/`InvalidRequest` on bad `cwd`/workspace. A corrupt usage file is tolerated on read (treated as empty) but **refuses appends** rather than being rewritten empty. |
| **Retry or recovery** | Move a corrupt log aside to start a new one. |
| **Owner** | `loadUsage`, `computeTotals`, `computePerPhaseTotals` (`core/usage.ts`); `handleUsage` |
| **Evidence** | `observed fact` (code; `tests/usage.test.mjs`). |

#### 14. Dashboard (and narration)

| Field | Value |
|---|---|
| **Feature** | Regenerate the self-contained HTML dashboard |
| **Trigger or input** | MCP `codecarto_dashboard {cwd}`; Pi `/codecarto-dashboard [--narrate]` |
| **Defaults** | `--narrate` off. |
| **Observable output** | `Dashboard regenerated: .codecarto/dashboard.html`; with `--narrate`, a note whether the LLM summary was written or skipped (and why). |
| **Side effects** | Writes `dashboard.html` atomically; `--narrate` may write `.dashboard-narration.local.md`. The render is **best-effort** and never throws to the caller. |
| **Persisted state** | `dashboard.html` (gitignored); `.dashboard-narration.local.md` (gitignored, stale-counted). |
| **Error behavior** | MCP: `InvalidRequest` when the workspace cannot be gathered or `dashboard.html` is not writable. Pi: reports "regenerated" unconditionally even when the boolean is false (mechanical finding 2.1); `--narrate` skip is a warning. |
| **Retry or recovery** | Re-run. |
| **Owner** | `writeDashboard` (`core/dashboard-writer.ts`); `narrateDashboard` (`extensions/codecarto/dashboard-narrator.ts`) |
| **Evidence** | `observed fact` (code; `tests/dashboard.test.mjs`, `tests/dashboard-on-complete.test.mjs`). Finding 2.1 is `observed fact`, action `fix before porting`. |

#### 15. Refresh scaffold

| Field | Value |
|---|---|
| **Feature** | Overwrite framework-owned `.codecarto/` files from the packaged template |
| **Trigger or input** | MCP `codecarto_refresh_scaffold {cwd}`; Pi `/codecarto-refresh-scaffold` |
| **Defaults** | Writes every packaged template file except protected sets: `workflow/status.yaml`, `workflow/config.yaml`, `.usage.local.yaml`, `.orchestrator.local.yaml`; top-level `BACKLOG.md`/`THREAD_LOG.md`/`CONVENTIONS.md`/`DECISIONS.md`/`dashboard.html`/`.dashboard-narration.local.md`/`.gitignore`; the `scratch/`, `inputs/`, `closeouts/`, `broadside/` directories; and declared phase outputs. |
| **Observable output** | `Refreshed <N> framework-owned file(s) from the packaged template (<before> → <after>).` plus a note that project state/user config/findings/scratch/closeouts/orchestrator files were untouched. Pi previews the exact file set and the protected set, then asks. |
| **Side effects** | Copies files one at a time (no staging/rollback — mechanical finding 2.2); appends one `THREAD_LOG` entry; writes `.gitignore` when absent. |
| **Persisted state** | Framework-owned files; `workflow/scaffold-version.yaml` (from template); `THREAD_LOG.md`. |
| **Error behavior** | MCP: `InvalidRequest` when the workspace or packaged template is missing. Pi: error notification; a declined confirmation writes nothing. A mid-loop I/O failure can leave a **mixed-version scaffold** (finding 2.2, `port differently`). |
| **Retry or recovery** | Re-run; the copy is idempotent. |
| **Owner** | `refreshScaffold`, `listScaffoldRefreshFiles` (`core/workspace.ts`); `handleRefreshScaffold` |
| **Evidence** | `observed fact` (code; `tests/refresh-scaffold.test.mjs`, `tests/pi-parity-commands.test.mjs`). No-rollback is `observed fact`, action `port differently` (finding 2.2). |

#### 16. Amend (post-pipeline)

| Field | Value |
|---|---|
| **Feature** | Apply a post-pipeline amendment that closes open questions / retires post-pipeline items on evidence |
| **Trigger or input** | MCP `codecarto_amend {cwd, name}`; Pi `/codecarto-amend <name\|path>` |
| **Defaults** | `name` is a slug under `scratch/amendments/` (with or without `.yaml`); Pi also accepts a path only inside that directory. |
| **Observable output** | `Amendment applied. Open questions closed: <ids>. Post-pipeline items closed: <ids>.` plus unknown-id and closeout notices. Pi previews each closure resolved against `status.yaml` before asking. |
| **Side effects** | Under the completion lock: refuses if the pipeline is not complete, removes matching open-question ids and post-pipeline ids, rebuilds terminal `next_actions`, commits `status.yaml`; then writes an amendment closeout and one `THREAD_LOG` entry; refreshes the dashboard. |
| **Persisted state** | `workflow/status.yaml`; `closeouts/<date>-amendment-<slug>.md`; `THREAD_LOG.md`; `dashboard.html`. |
| **Error behavior** | MCP: `InvalidParams` when `name` is missing; `InvalidRequest` for malformed/absent amendment, an incomplete/stuck pipeline, or a non-mapping file. Pi: same as notifications, before asking. A `needs-runtime-test` closure is **not** evidence-gated here (that gate is completion's); amendment is post-pipeline. |
| **Retry or recovery** | Idempotent: ids that no longer match are reported, not fatal. |
| **Owner** | `applyAmendment`, `loadAmendmentFile` (`core/amendment.ts`); `handleAmend` |
| **Evidence** | `observed fact` (code; `tests/amendment.test.mjs`, `tests/pi-parity-commands.test.mjs`). |

#### 17. Publish

| Field | Value |
|---|---|
| **Feature** | Publish a reimplementation spec into a versioned library |
| **Trigger or input** | MCP `codecarto_publish {library_path?, cwd?, spec?, spec_path?, slug?, namespace?, source_repo, headline, …}`; Pi `/codecarto-publish` (no args; reads the workspace spec) |
| **Defaults** | Library from `library_path` or config; slug derived from `source_repo`; `analyzed_at` = now; `pipeline` inherited from `status.yaml`; confidentiality defaults to `internal`; generation metadata defaults to `unknown` (MCP) / Pi model info (Pi). Required: `source_repo`, `headline`, and either `spec` or `spec_path`. |
| **Observable output** | `Published <ns>/<slug> v<N> to <library>`, plus `New version:` or `Metadata-only update (content hash matched v<N>).` and the entry directory. |
| **Side effects** | Holds `.publish.lock` for the publish. Content-hash idempotence: identical spec bytes update `metadata.yaml` in place (same version); new bytes stage under `<entry>.publish.<suffix>/` then rename into `v<N>`, update the `latest` pointer file, and reindex. Two guards refuse before writing: cross-project `source_repo` mismatch (`SourceRepoMismatchError`) and an entry more restricted than the library (`ConfidentialityMismatchError`). When `library.publish_confirm` was configured, MCP refuses without `confirm:true` and previews the publish; Pi asks via a dialog. |
| **Persisted state** | `entries/…/v<N>/{reimplementation-spec.md,metadata.yaml}`, `latest`, `index.yaml`, `INDEX.md`; `.publish.lock` (transient). |
| **Error behavior** | MCP: `InvalidParams` for a relative `library_path`/`spec_path`, an out-of-containment `spec_path`, a missing/invalid slug, a missing required arg, a wrong `tags`/`capabilities`/`model_metadata` type, a namespaced library without a namespace; `InvalidRequest` for config problems, a missing library marker, or the `publish_confirm` refusal. Pi: error notifications; the two guards are posed as confirmation questions. |
| **Retry or recovery** | Re-invoke with `confirm:true` (MCP) / approve (Pi); `allow_source_repo_change` or `allow_confidentiality_mismatch` to override a guard; `force_new_version` to bump. |
| **Owner** | `publishEntry`, `previewPublishVersion`, `initLibrary`, guards (`core/library.ts`); `handlePublish`; Pi `codecarto-publish` |
| **Evidence** | `observed fact` (code; `tests/library.test.mjs`, `tests/publish-path-containment.test.mjs`, `tests/pi-publish.test.mjs`). The `rename` staging and `.publish.lock` are `portability hazard` → `q-node-windows-fs-semantics` (6.1, 6.2), action `verify at runtime`. |

#### 18. Library init / list / reindex

| Field | Value |
|---|---|
| **Feature** | Create, list, and reindex a library |
| **Trigger or input** | MCP `codecarto_library_init {library_path, name?, namespace?}`, `codecarto_library_list {library_path?, cwd?, namespace?, tag?, slug?, source_repo?}`, `codecarto_library_reindex {library_path?, cwd?}`; Pi `/codecarto-library-init <path> [--namespace <name>]` (list/reindex are MCP-only) |
| **Defaults** | `name` defaults to the directory basename; visibility defaults to `internal`; filters absent → no filtering. |
| **Observable output** | Init: `Created library at <path> with marker "<name>".` (or `already exists…`) plus the config write. List: entry rows and a provenance-conflict report. Reindex: counts, namespaces, and a provenance-conflict report. |
| **Side effects** | Init writes the `.codecarto-library` JSON marker and rewrites **only** `library.path`/`library.namespace` in the user-global config (never `publish_confirm`). List is read-only but may build an index if absent. Reindex regenerates `index.yaml` + `INDEX.md`. |
| **Persisted state** | Marker, `index.yaml`, `INDEX.md`, user-global config. |
| **Error behavior** | MCP: `InvalidParams` for a relative `library_path` or invalid namespace; `InvalidRequest` for config problems or a missing marker; a config file that cannot be parsed is refused rather than overwritten. Pi: usage/flag errors are warnings. |
| **Retry or recovery** | Idempotent init; reindex after manual edits or a merge conflict. Repair of provenance conflicts is deliberately manual. |
| **Owner** | `initLibrary`, `listEntries`, `reindex`, `detectProvenanceConflicts`, `writeLibraryConfig`; handlers |
| **Evidence** | `observed fact` (code; `tests/library.test.mjs`, `tests/mcp-library.test.mjs`). |

#### 19. Broad-Side (batch reconnaissance)

| Field | Value |
|---|---|
| **Feature** | Submit / collect / status / models / verify asynchronous batch reconnaissance via the OpenRouter Batch API |
| **Trigger or input** | MCP `codecarto_broadside {cwd, action, …}`; Pi `/codecarto-broadside [action] [lenses…] [flags]` |
| **Defaults** | `action: submit`; model `google/gemini-3.7-flash:batch`; all six lenses; `max_cost` `$1` (0 = no limit); `wait_seconds` 0; `incremental` false (falls back to a full scan on a dirty tree/no baseline); `retry_truncated` true; `include_synthesis`/`include_triage` true; `redact_secrets` true; reasoning `effort: low`; `verify --top` 10. |
| **Observable output** | Submit: per-lens batch ids, requests, estimated cost, scanned-language/source line, redaction line, incremental outcome, estimated total and pricing, output directory, and a "unverified scouting signals" disclaimer. Collect: per-lens outcomes, costs, truncation/retry lines, synthesis/triage lines, top findings and triage items. Verify: a verdict per finding (confirmed / not-a-defect / discarded / unclear). |
| **Side effects** | Uploads repository slices (redacted) to OpenRouter; writes run state and results. Submits one batch per lens in parallel; polls concurrently to a shared deadline; claims spending slots (`synthesis`/`triage`/`retry`) under the state lock so two collects cannot double-pay; merges run state slot-by-slot. Pi confirms spend via a dialog (or, headless, approves within `max_cost` and refuses over it); MCP refuses over `max_cost` unless `force:true`. |
| **Persisted state** | `.codecarto/broadside/state.json` (`schema_version: 1`), `broadside/config.yaml` (may hold an API key — **tracked file, stated risk**), `model-catalog.json` (24 h TTL), `batch-endpoints.json`, and `broadside/<run>/**` (`requests.json`, `raw-<lens>.json`, `results-*.json`/`.md`, `verified.{md,json}`, synthesis/triage). |
| **Error behavior** | MCP: `InvalidParams` for an unknown action/lens/model/`top`/`max_cost`/`lens_models` shape or a missing API key; `InvalidRequest` for a `BroadsideConfigError` (non-`status` actions), a corrupt `state.json` (`BroadsideStateError`), or a submit/collect failure. Pi: error notifications; `status` still answers with a config warning when `config.yaml` is unreadable. Errors name their cause (auth failure ≠ slow batch). |
| **Retry or recovery** | `collect` again to resume (batches keep running server-side); `retry_truncated` re-submits once; `--regenerate` re-runs settled post-passes; submit refuses a language it cannot scan and a model without structured-output support **before** spending; a corrupt `state.json` is preserved to `state.json.corrupt-<hash>` and never overwritten. |
| **Owner** | `core/broadside/{submit,collect,verify,models,state,render,secrets}.ts`; `handleBroadside`; Pi `codecarto-broadside` |
| **Evidence** | `observed fact` for local behavior (code; `tests/broadside*.test.mjs`). **External-behavior claims** → `q-openrouter-batch-semantics`: the concurrent-job quota, which catalog `:batch` ids actually have endpoints, and reasoning acceptance cannot be confirmed by reading; action `verify at runtime`. Poll/lock/atomic-write mechanics on non-POSIX are `portability hazard` → `q-node-windows-fs-semantics` (6.1, 6.2), action `verify at runtime`. |

### Surface 4: Drop-in `.codecarto/` workspace (storage / format as behavior)

| Field | Value |
|---|---|
| **Feature** | A pure data workspace any agent can drive without the executable surfaces |
| **Trigger or input** | Reading `GUIDE.md`, `workflow/status.yaml`, `workflow/pipeline*.yaml`, `findings/*/SKILL.md`, `templates/*`; writing the primary outputs and `scratch/handoffs/<phase>.yaml`. |
| **Defaults** | On init: the default pipeline, `schema_version: 1`, all phases `pending`. |
| **Observable output** | The phase-gated workflow: a phase writes its primary output ending in a `## Validation` table and a handoff, then completion advances `status.yaml`. |
| **Side effects** | The drop-in path has no executor: it cannot spawn sub-agents, render the dashboard, run the library tools, or run Broad-Side. Analysis and synthesis-by-prompt still work. |
| **Persisted state** | The same files as the executable surfaces, minus usage/dashboard/broadside. |
| **Error behavior** | No runtime errors; the contract is carried by the templates and validation protocol. |
| **Retry or recovery** | Recovery is documented in the guide topics (`phase-recovery`). |
| **Owner** | `.codecarto/` template; consumed by `core/workspace.ts` (`packagedWorkspaceDir`, `listDeclaredOutputs`) |
| **Evidence** | `observed fact` (README "drop-in limitation"; `GUIDE.md`; `tests/init-template-manifest.test.mjs`). |

### Surface 5: Versioned library (external storage)

| Field | Value |
|---|---|
| **Feature** | A shared, versioned store of published specs |
| **Trigger or input** | Filesystem layout: `.codecarto-library` marker; `entries/[<ns>/]<slug>/latest` (a **regular file** containing `v<N>`, never a symlink); `entries/…/v<N>/{reimplementation-spec.md,metadata.yaml}`; derived `index.yaml`/`INDEX.md`. |
| **Defaults** | Visibility `internal`; `latest` pointer; `INDEX_SCHEMA_VERSION`/`MARKER_SCHEMA_VERSION` 1. `docs/library-format.md` is the authoritative public contract. |
| **Observable output** | Browsable Markdown index; `readEntry` resolves `latest` or a fallback to the highest version directory. |
| **Side effects** | Publish writes version directories and the pointer; reindex rewrites the derived index. |
| **Persisted state** | As above. |
| **Error behavior** | Missing marker → not a library; malformed metadata → rejected; an incomplete version (missing spec or metadata) → refused. |
| **Retry or recovery** | Reindex after manual edits; manual repair of provenance conflicts. |
| **Owner** | `core/library.ts`; `docs/library-format.md` |
| **Evidence** | `observed fact` (code; `tests/library.test.mjs`). The `latest`-as-regular-file choice is a deliberate **portability mitigation** (avoids Windows symlink elevation). |

### Surface 6: Dashboard (generated artifact)

| Field | Value |
|---|---|
| **Feature** | A self-contained HTML status/usage/closeout view |
| **Trigger or input** | Regenerated on init, completion, amendment, pipeline switch, phase run, and on demand. |
| **Defaults** | No external assets; footer carries the package version. |
| **Observable output** | A single `.codecarto/dashboard.html`. |
| **Side effects** | Best-effort write; never throws to the caller. Optional narration. |
| **Persisted state** | `dashboard.html`; `.dashboard-narration.local.md`. |
| **Error behavior** | Returns a boolean; callers surface it (MCP names failure; Pi does not — finding 2.1). |
| **Retry or recovery** | Re-render on demand. |
| **Owner** | `core/dashboard.ts`; `core/dashboard-writer.ts` |
| **Evidence** | `observed fact` (code; `tests/dashboard.test.mjs`). `dashboard.ts` body beyond the first ~120 lines was not read line-by-line (see Coverage). |

---

## cf-arch-1 closure — MCP tool input schemas: defaults, side effects, error behavior

This section closes the routed item `cf-arch-1` for the MCP surface. The authoritative schema is
the `TOOLS` array in `mcp-server/server.ts`; the table below extracts the defaults, side effects,
and error behavior the schema text does not carry. Every tool takes an **absolute, existing**
`cwd` unless noted (`validateCwd`). Error codes are the MCP SDK `ErrorCode` values:
`InvalidParams` = -32602, `InvalidRequest` = -32600 (`McpError(ErrorCode.InvalidRequest, …)` maps
to the server's invalid-request code), `InternalError` = -32603, `MethodNotFound` = -32601. A
thrown non-`McpError` becomes `InternalError`; an unknown tool name is `MethodNotFound`
(`observed fact`: `mcp-server/server.ts` input helpers and `buildServer`).

**Cross-cutting contract (all 22 tools):** every result is `{content:[{type:"text",text}],
structuredContent:{…, text}}` — the rendered prose is always carried under a stable `text` key so
a `structuredContent`-preferring client still receives it (test-pinned; CONVENTIONS C01).
`cwd` is required and validated absolute+existing except where noted.

| Tool | Required | Optional (default) | Side effects | Error behavior |
|---|---|---|---|---|
| `codecarto_init` | `cwd` | `pipeline` (default pipeline), `force` (false) | Copy template, seed orchestrator files, write `status.yaml` | `InvalidParams`: bad `cwd`, unknown pipeline, pipeline file missing. `InvalidRequest`: `.codecarto/` exists without `force`. `InternalError`: packaged assets missing. |
| `codecarto_open` | `cwd` | — | none | `InvalidParams`: bad `cwd`. `InvalidRequest`: no `status.yaml`. |
| `codecarto_status` | `cwd` | — | none | `InvalidParams`: bad `cwd`. `InvalidRequest`: unparsable/missing-pipeline workspace. |
| `codecarto_next` | `cwd` | `unattended` (false) | none (returns prompt) | `InvalidParams`: bad `cwd`, preflight. `InvalidRequest`: stuck pipeline. Returns `{complete:true}` at terminal (not an error). |
| `codecarto_phase` | `cwd`, `phase` | `unattended` (false) | none | `InvalidParams`: `phase` missing/not a string/unknown; bad `cwd`. |
| `codecarto_validate` | `cwd` | `phase` (next eligible) | none | `InvalidParams`: non-string `phase`, unknown phase. `InvalidRequest`: workspace error. |
| `codecarto_complete` | `cwd` | `phase` (next eligible) | Commit `status.yaml`; closeout/THREAD_LOG/decisions/conventions; usage receipt; dashboard | `InvalidParams`: bad `phase`/`cwd`. `InvalidRequest`: `FAIL`/`MISSING`, missing handoff, bad `target_phase`, missing post-pipeline id, closure-integrity D1/D3. |
| `codecarto_skill` | `cwd`, `name` | — | none | `InvalidParams`: `name` missing/unknown. `InvalidRequest`: pipeline incomplete/stuck; Broad-Side guide missing. |
| `codecarto_list_skills` | `cwd` | — | none | `InvalidParams`/`InvalidRequest`: `cwd`/workspace. |
| `codecarto_guide` | — | `topic` (overview) | none | `InvalidParams`: unknown topic / packaged skill missing. No workspace needed. |
| `codecarto_config` | — | `cwd` (user-global only when absent) | none | `InvalidParams`: non-absolute/missing `cwd`. |
| `codecarto_vision` | `cwd`, `raw_text` | — | none | `InvalidParams`: `raw_text` absent/empty; bad `cwd`. `InvalidRequest`: interview skill missing. |
| `codecarto_usage` | `cwd` | — | none | `InvalidParams`/`InvalidRequest`: `cwd`/workspace. |
| `codecarto_dashboard` | `cwd` | — | Writes `dashboard.html` | `InvalidParams`: bad `cwd`. `InvalidRequest`: render failed. |
| `codecarto_refresh_scaffold` | `cwd` | — | Copies framework files; appends `THREAD_LOG`; writes `.gitignore` if absent | `InvalidRequest`: workspace/template missing. |
| `codecarto_amend` | `cwd`, `name` | — | Commit `status.yaml`; amendment closeout + `THREAD_LOG`; dashboard | `InvalidParams`: `name` missing. `InvalidRequest`: malformed/absent amendment; pipeline incomplete/stuck. |
| `codecarto_publish` | `source_repo`, `headline`, (`spec` or `spec_path`) | `library_path` (config), `cwd` (none), `slug` (derived), `namespace` (config), `source_commit`, `source_branch`, `source_dirty`, `analyzed_at` (now), `pipeline` (from `status.yaml`), `tags` ([]), `capabilities` ([]), `confidentiality` (internal), `model_metadata` (all `unknown`), `force_new_version` (false), `allow_source_repo_change` (false), `allow_confidentiality_mismatch` (false), `confirm` (false) | `.publish.lock`; version dir + `latest`; reindex | `InvalidParams`: relative `library_path`/`spec_path`, out-of-containment `spec_path`, invalid slug/namespace, missing arg, wrong list/object type, namespaced library without namespace. `InvalidRequest`: config problems, missing marker, `publish_confirm` refusal. `InternalError`: `spec_path` without a containment root. |
| `codecarto_library_init` | `library_path` | `name` (dirname), `namespace` (none) | Writes marker; writes `library.path`/`namespace` to user config | `InvalidParams`: `library_path` missing/relative, invalid namespace. `InvalidRequest`: unparsable config. |
| `codecarto_library_list` | — | `library_path` (config), `cwd` (none), `namespace`, `tag`, `slug`, `source_repo` | none (may build index) | `InvalidParams`: relative `library_path`, bad `cwd`, missing marker. `InvalidRequest`: config problems. |
| `codecarto_library_reindex` | — | `library_path` (config), `cwd` (none) | Writes `index.yaml`/`INDEX.md` | Same as list. |
| `codecarto_broadside` | `cwd`, `action` | `lenses` (all six), `api_key` (env/config), `run_id` (latest), `top` (10), `wait_seconds` (config 0), `include_synthesis` (config true), `include_triage` (config true), `retry_truncated` (config true), `regenerate_post_passes` (false), `max_cost` (config $1), `force` (false), `incremental` (config false), `include_benchmarks` (false), `model` (config default), `lens_models` ({}) | Network; run state/results | `InvalidParams`: unknown action/lens/model/`top`, `lens_models` shape, missing API key, `regenerate_post_passes` misuse. `InvalidRequest`: `BroadsideConfigError` (non-status), corrupt `state.json`, submit/collect failure. |

**Notes that the schema text does not obviously reveal (all `observed fact`):**

- `library_path` and `optionalCwd` follow the same "given ⇒ absolute and existing" rule as a
  required `cwd`; `cwd` on the library tools is a containment root for `spec_path` and the source
  of the workspace config, so it is validated *before* anything is read through it.
- `codecarto_publish` builds `allowedRoots` from the library path plus (when `cwd` is given)
  `cwd/.codecarto`; `readSpecArg` fails closed (`InternalError`) when the root set is empty.
- `codecarto_broadside` resolves `wait_seconds`/`max_cost` with an explicit `>= 0` test so an
  explicit `0` is honored (not treated as absent).
- `codecarto_skill` serves `broadside` before the completion gate; Pi and MCP both do.

---

## cf-arch-1 closure — Pi command argument grammars and flag parsers

This section closes `cf-arch-1` for the Pi surface. The three dedicated flag parsers
(`next-flags.ts`, `broadside-flags.ts`, `dashboard-flags.ts`) never throw; they return an `unknown`
array and/or an `error` string, and the handler surfaces it as a notification. Handlers otherwise
parse arguments inline. `observed fact`: `extensions/codecarto/index.ts`,
`extensions/codecarto/{next-flags,broadside-flags,dashboard-flags}.ts`; test-pinned by
`tests/next-flags.test.mjs`, `tests/broadside-flags.test.mjs`, `tests/pi-parity-commands.test.mjs`.

| Command | Grammar | Defaults | Unknown/invalid behavior | Error behavior |
|---|---|---|---|---|
| `/codecarto-init` | `[variant]` | default pipeline | unknown variant → error | `error` notification; existing workspace → `ctx.ui.confirm` |
| `/codecarto-open` | — | — | — | warning if no workspace |
| `/codecarto-vision` | — | — | — | warning if `INTERVIEW.md` absent |
| `/codecarto-status` | — | — | — | needs active workspace |
| `/codecarto-switch-pipeline` | `<variant>` | — | empty → usage warning; unknown → error | error notification |
| `/codecarto-next` | `[--auto] [--strict] [--llm-steer\|--no-llm-steer]` | `auto` false, `strict` false, `llmSteerOverride` undefined (falls back to config) | unknown flags collected and reported; `--strict` without `--auto` → `Flag --strict requires --auto.` | error notification |
| `/codecarto-phase` | `<phase>` | — | empty → usage warning; unknown → error | error notification |
| `/codecarto-validate` | `[phase]` | next eligible | — | error notification |
| `/codecarto-complete` | `[phase]` | next eligible | — | `FAIL`/`MISSING` → error; completion refusals surfaced as error |
| `/codecarto-skill` | `<name>` | — | empty → usage warning + available hint; unknown → error | error notification |
| `/codecarto-list-skills` | — | — | — | warning if no workspace |
| `/codecarto-guide` | `[topic]` | `overview` | unknown topic → error (nothing sent) | error notification |
| `/codecarto-broadside` | `[submit\|collect\|status\|models\|verify] [lenses…] [--model=ID] [--lens-model=LENS:ID] [--top=N] [--run=ID] [--max-cost=N] [--wait=SECONDS] [--regenerate] [--incremental\|--no-incremental] [--no-synthesis] [--no-triage] [--no-retry-truncated] [--benchmarks]` | action `submit`; lenses `[]` (config); `incremental` undefined (config); `includeSynthesis`/`includeTriage`/`retryTruncated` undefined (config); `maxCost`/`waitSeconds` undefined (config); `benchmarks` false; `regeneratePostPasses` false | unknown tokens collected and reported; contradictory `--incremental`+`--no-incremental` → error; action-mismatched flags refused (lenses/`--incremental`/`--benchmarks`/`--wait`/`--run`/`--model`/`--top`/`--regenerate`/`--lens-model`); malformed numerics → error | error notification; API-key absence → error |
| `/codecarto-publish` | no args | — | — | refuses without library path/marker/namespace; guards posed as confirms |
| `/codecarto-library-init` | `<path> [--namespace <name>]` | namespace none | missing `--namespace` value → warning; invalid namespace → warning; stray `--flag` → warning; extra positional → warning | error notification on init failure |
| `/codecarto-config` | — | — | — | shows problems; warning if any |
| `/codecarto-usage` | — | — | — | needs workspace |
| `/codecarto-dashboard` | `[--narrate]` | `narrate` false | unknown flags → error | error notification |
| `/codecarto-refresh-scaffold` | — | — | — | error notification; declined confirm writes nothing |
| `/codecarto-amend` | `<name\|path>` | — | empty → usage warning + staged hint; path outside `scratch/amendments/` → error | refused amendments surfaced as errors **before** asking |

**Flag-parser return shapes (`observed fact`, test-pinned):**

- `parseNextFlags(args) → { llmSteerOverride?, auto, strict, unknown[], error? }`; last
  `--llm-steer`/`--no-llm-steer` wins; whitespace-tolerant; never throws.
- `parseBroadsideFlags(args) → { action, lenses[], incremental?, includeSynthesis?, includeTriage?,
  retryTruncated?, maxCost?, waitSeconds?, runId?, model?, lensModels?, top?, regeneratePostPasses?,
  benchmarks, unknown[], error? }`; `--lens-model` splits on the **first** colon (model ids contain
  a colon); a lens named twice is de-duplicated; a repeated identical negative flag is redundant,
  not contradictory.
- `parseDashboardFlags(args) → { narrate, unknown[] }`; never throws.
- **Completer contract:** every token the completer offers parses without an error, and accepting
  a completion keeps the flags already typed (the value is the whole argument line). Test-pinned.

**Pi-only hook contract (`observed fact`):**

- `tool_call` guard (active only in CodeCartographer mode with a `.codecarto/` present): blocks
  `bash`; confines `edit`/`write` to `.codecarto/` plus a configured, discoverable library, using
  `resolveExistingPrefix` + `isWithinPath` so a symlinked ancestor pointing outside the root is
  refused even for a not-yet-existing file. On non-POSIX this is a `portability hazard` →
  `q-node-windows-fs-semantics` (6.3), action `verify at runtime`.
- `session_start` resets mode; `session_shutdown` disposes the widget; `agent_end` refreshes the UI.

---

## High-Value Behaviors

### Cancellation and abort

- **Pi auto run** honors `ctx.signal`: `runAuto` checks it between phases and Broad-Side poll loops
  pass `ctx.signal`; a stop reports the reason. `observed fact`: `auto-runner.ts`,
  `extensions/codecarto/index.ts` verify handler.
- **MCP server lifetime**: `startStdioServer` attaches an `AbortController` aborted on `stdin`
  `end`/`close` and on `server.onclose`; a Broad-Side wait stops polling and submits nothing
  further. Batches already accepted keep running server-side and a later `collect` claims them.
  `observed fact`: `mcp-server/server.ts`.
- **HTTP calls** use `AbortSignal.timeout(30_000)`; **git** subprocesses are bounded by
  `GIT_TIMEOUT_MS = 30_000`. `observed fact`: `core/broadside/client.ts`, `core/utils.ts`.
- **Not abortable**: the `status.yaml` lock/write is not interruptible; a `complete` that has
  reached the commit point finishes its post-commit writers. `observed fact`: `updateStatusAtomically`.

### Streaming and partial output

- **Broad-Side collect** polls all in-flight batches concurrently against one shared deadline and
  returns **partial** state on budget expiry (`timeout` is synthetic and claimable later). Per-lens
  outcomes, truncation counts, and in-flight post-pass lines are reported so a run that is not done
  never reads as clean. `observed fact`: `core/broadside/collect.ts`, `render.ts`.
- **Pi** renders per-change progress into the Broad-Side widget (`onStatus`/`statusLineWriter`
  dedupes repeated poll lines) and a tally during `verify`. `observed fact`.
- **MCP** returns the whole rendered text plus its structured fields; there is no incremental
  streaming within a tool result. `observed fact`: `textResult`.

### Queueing and follow-up

- **Pi** queues a prompt as a normal message when the session is idle and as a `followUp` when
  busy, so a command run mid-agent does not interrupt it. `observed fact`: `pi.sendUserMessage(…, {deliverAs:"followUp"})` across handlers.
- **Phase re-entry guard**: `isPhaseRunning(phaseId)` refuses a second `/codecarto-next` for a
  phase already running. `observed fact`: `agent-runner.ts`.

### Compaction and summarization

- A phase-aware compaction extension registers a compaction prompt and writes
  `scratch/checkpoints/<phase>.md`; a resumed session is pointed at the checkpoint by
  `buildPhasePrompt`. Compaction telemetry (threshold/overflow/manual; success/fail/abort) lands in
  the usage log and is summed by `/codecarto-usage`. `observed fact`: `phase-compaction.ts`,
  `core/usage.ts`, `core/prompts.ts`.
- Dashboard narration is an opt-in one-shot LLM summary cached at `.dashboard-narration.local.md`
  with a stale count. `observed fact`: `dashboard-narrator.ts`.

### Persistence and resume

- `workflow/status.yaml` is the single source of truth, rewritten in place through
  `atomicWriteFile`; session artifacts (findings, handoffs, checkpoints, amendments) are
  gitignored by default, so a fresh clone can report a phase complete whose report is absent —
  both status surfaces name that gap. `observed fact`: `core/pipeline.ts`
  (`listMissingCompletedOutputs`).
- A handoff is consumed once at completion and retained on disk; re-running completion is
  idempotent (canonical closeout name, link-deduped log line, text-deduped rows) — CONVENTIONS C02.
- A Pi phase runs in a file-backed session under `~/.pi/agent/sessions/…`, resumable via `/resume`.
  `observed fact`: `agent-runner.ts`.

### Tool execution and validation

- The phase output's own `## Validation` table is the verdict; `codecarto_validate` parses it and
  adds two deterministic cross-checks: findings evidence/action pairing (gating on a ≥0.17.1
  scaffold) and declared-secondary-output presence (non-gating). `observed fact`.
- Every PARTIAL row becomes a `needs-maintainer-decision` question unless the row names a tracked
  entry id. Closure integrity is gated: D1 (a `derives_from` item closed while its question is
  open) and D3 (a `needs-runtime-test` question closed without evidence on a ≥0.19.0 scaffold).
  `observed fact`: `core/completion.ts`.
- **Unsettled findings** (`open question` / `external-behavior claim`) must carry an unsettled
  action; pairing them with `fix before porting`/`fix now` fails validation. `observed fact`:
  `core/findings.ts`.

---

## Security and Authorization

The system has **no authentication or authorization service** — it is a local developer tool.
Its security model is a set of local trust boundaries and write-confinement guards (`observed
fact`: `GUIDE.md`, `extensions/codecarto/index.ts`, `mcp-server/server.ts`, `core/utils.ts`).

- **Authentication:** none for the workflow/library surfaces. The only credential is
  `OPENROUTER_API_KEY` for Broad-Side.
- **Authorization model:** filesystem confinement (capability-by-path), not RBAC. Two enforcement
  points:
  1. **Pi `tool_call` guard** — in CodeCartographer mode, `bash` is blocked outright and
     `edit`/`write` are confined to `.codecarto/` plus a configured library discovered by marker.
     It resolves the existing path prefix through symlinks before comparing, so a symlinked
     ancestor pointing outside the root is refused even for an unborn file. Test-pinned for POSIX
     (`tests/symlink-sandbox.test.mjs`); non-POSIX is a `portability hazard` (6.3) → `verify at
     runtime`.
  2. **MCP path containment** — `readSpecArg` requires an absolute `spec_path` within an allowed
     root (the library path or `cwd/.codecarto`) and **fails closed** (refuses) when the root set
     is empty; `cwd`/`library_path` are validated absolute+existing before becoming roots.
     Test-pinned (`tests/publish-path-containment.test.mjs`).
- **Trust boundaries:**
  - The repository being analyzed is **untrusted input** to Broad-Side: before upload, files whose
    name marks them secret-bearing are skipped and high-confidence secret shapes are replaced with
    `[REDACTED:<kind>]` (`redact_secrets` default true). This is accident mitigation, not a secret
    scanner. `observed fact`: `core/secrets.ts`.
  - Spliced text from earlier sessions and library metadata is quoted (`«…»`) and must be treated
    as data, never instructions (`core/prompts.ts` `quoteSpliced`). Library files are read-only
    evidence during synthesis.
  - `broadside/config.yaml` may hold an API key and **ships tracked** — a stated risk; the
    environment variable is preferred and the MCP tool description warns that a key passed as an
    argument is recorded in the host's logs.
- **Permission checks:** publish gates are the closest thing to an authorization decision:
  `library.publish_confirm` (MCP refuses without `confirm:true` **only when a config layer set the
  key**), `SourceRepoMismatchError` (refuses appending one project's spec to another's history),
  and `ConfidentialityMismatchError` (refuses an entry more restricted than the library). Pi poses
  both guards as confirmation dialogs; MCP requires explicit override booleans.
- **Secret management:** `OPENROUTER_API_KEY` > explicit `api_key` argument > `broadside/config.yaml`
  (MCP resolution order; Pi deliberately takes no key argument, reading env or the config file).
  No rotation machinery. `observed fact`: `handleBroadside` `resolveBroadsideApiKey`,
  `resolveBroadsideKey`.
- **Session lifecycle:** a Pi phase child session is created per phase and disposed in a `finally`;
  MCP is a subprocess whose lifetime is the stdio stream. No token expiry/refresh.
- **Web security:** not applicable — no web UI, no CORS/CSP surface. The dashboard is a local
  self-contained HTML file.

---

## Configuration Model

CodeCartographer has **three independent configuration systems** that do not share a loader:
the orchestrator/library config (two layers), the Broad-Side run config, and the pipeline
definitions themselves. Full catalog in `findings/config-model/config-model.md` (architecture
phase) and its `2026-09-15 (contracts phase)` addendum. Summary of the user-visible contract:

- **Orchestrator/library:** user-global `~/.codecarto/config.yaml` (overridable via
  `CODECARTO_USER_CONFIG_PATH`) overlaid by `.codecarto/workflow/config.yaml`; defaults
  `llm_steer_next_phase: false`, `library.path: null`, `library.namespace: null`,
  `publish_confirm: true` (but `publish_confirm_configured: false`, so the MCP confirm gate is
  off unless a layer set it). A fault is dropped at key granularity and recorded in `problems`;
  the loader never throws; **publish and the library tools refuse while `problems` is non-empty**.
  `library.path` is tilde-expanded and must be absolute. `observed fact`.
- **Broad-Side:** `.codecarto/broadside/config.yaml`; an absent file yields defaults, but a file
  that exists and cannot be parsed throws `BroadsideConfigError` and refuses every action except
  `status` (a typo must not silently remove a spend cap). Per-call parameters override config keys,
  which override shipped defaults. `reasoning.effort` and `reasoning.max_tokens` set together is
  refused at load. `observed fact`.
- **Pipelines:** the file named by `status.yaml`'s `pipeline:` is the phase contract; aliases in
  `core/pipeline.ts`. `observed fact`.

---

## Doc/Test Conflicts

| # | Conflict | Doc says | Code/test says | Resolution |
|---|---|---|---|---|
| 1 | Pi command count | `findings/architecture/architecture-map.md` and `findings/public-surfaces/public-surfaces.md` say "~21 slash commands" | `tests/pi-parity-commands.test.mjs` pins `commands.size === 20`, and `README.md`'s table lists exactly 20 | **Code wins.** The architecture "~21" is an approximation, not a contradiction in substance; this report uses **20** (`observed fact`). Low impact. |
| 2 | README Broad-Side actions | `README.md:326` lists actions `submit, collect, status, models` | The MCP schema and Pi parser add **`verify`** (`TOOLS`, `broadside-flags.ts`) | README is stale by one action; the code is authoritative. `observed fact`. Note: `README.md` is documentation, not a contract the tests enforce. |
| 3 | `docs/*` | `docs/library-format.md` is declared authoritative for the library ABI | Contents were **not read** this phase (outside scope; architecture read only the directory listing) | Not a conflict — an unverified claim. Any library-format assertion here is `observed fact` from `core/library.ts` only; the doc is a known blind spot (see Coverage). |

The `README.md`/`docs/*` bodies were not the analyzed scope this phase (source code is), so
conflicts 2–3 are reported as observations, not adjudicated. Conflict 1 is a measured in-repo
contradiction between a summarized upstream claim and a test pin.

---

## Black-Box Acceptance List

Scenario checks another implementation can run without referencing the source. Preconditions
assume a fresh workspace initialized with the default pipeline unless stated. All checks are
`observed fact`-derived from the contracts above; checks that depend on a platform/network behavior
are marked `[verify at runtime]` and must not be read as settled.

| # | Scenario | Precondition | Action | Expected Outcome |
|---|---|---|---|---|
| 1 | Init creates a workspace | Empty temp dir | `codecarto_init {cwd}` | `.codecarto/workflow/status.yaml` exists with `schema_version: 1`, `current_phase` = first phase, all phases `pending`; output names the default pipeline; orchestrator files seeded. |
| 2 | Init refuses overwrite | Workspace already initialized | `codecarto_init {cwd}` (no force) | Error `InvalidRequest`; message contains `already exists` and `force: true`; no files moved. |
| 3 | Forced init backs up | Workspace with a written finding | `codecarto_init {cwd, force:true}` | A `.codecarto-backup-<timestamp>/` exists holding the prior session state; framework files remain; status reset. |
| 4 | Status counts | Two phases completed by hand | `codecarto_status {cwd}` | `Progress: 2/<total> complete`; `Pipeline state: in progress`; next action names the third phase. |
| 5 | Prompt parity | Fresh workspace | `codecarto_next {cwd}` vs. `buildPhasePrompt(state, phase, false)` | Byte-identical text. |
| 6 | Terminal prompt | All phases complete | `codecarto_next {cwd}` | Text `All CodeCartographer phases are complete…`; `structuredContent.complete === true`. |
| 7 | Stuck pipeline | `status.yaml` marks a phase complete whose dependency is incomplete | `codecarto_next {cwd}` | Error `InvalidRequest` containing `Pipeline is stuck:` and the unmet dependency; not a text success. |
| 8 | Validate MISSING | Fresh workspace | `codecarto_validate {cwd}` | `overall: "MISSING"`, `exists: false`. |
| 9 | Validate reads the table | Output with `**Overall:** PASS WITH GAPS` and one PARTIAL row | `codecarto_validate {cwd, phase}` | `overall: "PASS WITH GAPS"`; `gaps` has one entry. |
| 10 | Complete gate | Output with `**Overall:** FAIL` | `codecarto_complete {cwd, phase}` | Error `InvalidRequest` containing `Cannot complete` and `FAIL`; `status.yaml` unchanged. |
| 11 | Commit is atomic and ordered | Output `PASS`, handoff present | `codecarto_complete {cwd, phase}` | `status.yaml` shows the phase complete; closeout file exists; exactly one `THREAD_LOG` line; a second call does not duplicate. `[verify at runtime]` for the rename durability. |
| 12 | Missing handoff refusal | A phase declaring `handoff_requirements` with no handoff file | `codecarto_complete {cwd, phase}` | Error naming `scratch/handoffs/<phase>.yaml` and the required fields. |
| 13 | Closure-integrity D3 | Open question of kind `needs-runtime-test`; handoff closes it with a bare id; scaffold ≥0.19.0 | `codecarto_complete {cwd, phase}` | Error `Refusing to complete … needs-runtime-test … without evidence`. With `{id, evidence}` it succeeds. |
| 14 | Pipeline switch preserves | `lite` with one completed phase; switch to `full` | `codecarto_switch_pipeline {cwd, pipeline:"full"}` | The shared completed phase stays complete; new phases pending; cursor recomputed; a carry-forward targeting a dropped phase moves to `post_pipeline` and is named. |
| 15 | Publish idempotence | Library marker; spec bytes | Publish the same spec twice | Second returns `Metadata-only update (content hash matched v1).`; version count unchanged. |
| 16 | Publish source-repo guard | Entry `v1` records repo A | Publish same slug with repo B | `SourceRepoMismatchError` message; nothing written. With `allow_source_repo_change` it appends. |
| 17 | Publish containment | `secret.txt` outside `.codecarto/` and the library | `codecarto_publish {…, spec_path:"/…/secret.txt"}` | Error containing `must be within the workspace`; the file is not read. |
| 18 | Publish confirm gate | `library.publish_confirm: true` configured | `codecarto_publish {…}` without `confirm` | Error `InvalidRequest` containing a version/confidentiality preview and `confirm: true`; nothing written. |
| 19 | Broad-Side submit prices first | Library marker + API key; a small repo | `codecarto_broadside {cwd, action:"submit", max_cost:0.001}` | Refuses over the estimate (`InvalidRequest`) without `force`; the estimate names per-lens cost; `[verify at runtime]` for the live catalog/quota. |
| 20 | Broad-Side no-op repo | A repo with no scannable source | `codecarto_broadside {cwd, action:"submit"}` | Refuses `found no <lang> source files to scan`; nothing submitted. |
| 21 | Broad-Side resume | A run whose lens batch is still in flight | `codecarto_broadside {cwd, action:"collect", wait_seconds:0}` | Returns partial state; the batch is still claimable; a later `collect` finishes it. `[verify at runtime]` for the remote batch state. |
| 22 | Broad-Side corrupt state | `state.json` contains invalid JSON | Any action | `BroadsideStateError`; a `state.json.corrupt-<hash>` copy exists; the original is not overwritten. |
| 23 | Pi blocks bash | Active mode, `.codecarto/` present | Agent calls `bash` | Blocked with reason `CodeCartographer mode disables bash…`. |
| 24 | Pi confines write | Active mode | Agent writes outside `.codecarto/` and the library | Blocked with reason naming the allowed roots. A symlinked ancestor outside the root is also blocked. `[verify at runtime]` on non-POSIX (6.3). |
| 25 | Pi `/codecarto-next` flags | Fresh workspace | `/codecarto-next --strict` | Error notification `Flag --strict requires --auto.`; no phase runs. |
| 26 | Pi Broad-Side flag guard | Any | `/codecarto-broadside collect --incremental` | Error notification `--incremental is only meaningful for submit`; nothing submitted. |
| 27 | Amend before completion | Workspace mid-pipeline | `codecarto_amend {cwd, name}` | Error `Cannot amend: the pipeline is not complete`; nothing written. |
| 28 | Amend idempotence | Applied amendment | Re-run the same amendment | `Open questions closed: none`; the `THREAD_LOG` entry appears exactly once. |
| 29 | Usage receipt | MCP completion | `codecarto_usage {cwd}` | A run is recorded with zeroed counters and a note that MCP receipts are unknowns, not free runs. |
| 30 | Guide without workspace | No `.codecarto/` | `codecarto_guide {topic:"overview"}` | The packaged guide body is returned; other topics are listed. |

---

## Coverage and limits

- **Inspected scope (this phase):** the two executable surfaces and the shared core they call —
  `mcp-server/server.ts` in full (all 22 `TOOLS` schemas, every `handle*`, `buildServer`,
  `startStdioServer`); `extensions/codecarto/index.ts` in full (all 20 command handlers, the
  `tool_call` guard, lifecycle hooks) plus `next-flags.ts`, `broadside-flags.ts`,
  `dashboard-flags.ts`; `core/{pipeline,prompts,completion,status,workspace,library,orchestrator-config,
  usage,amendment,guide,secrets,findings,coverage,utils}.ts` read in full; the Broad-Side surface
  via `core/broadside/{constants,types,state,render}.ts` in full and
  `submit.ts`/`collect.ts`/`verify.ts`/`models.ts` at their entry points and user-facing text; the
  `tests/` suite by representative bodies (`next-flags`, `broadside-flags`, `pi-parity-commands`,
  `mcp-server`, `structured-payload`, `publish-path-containment`, `symlink-sandbox`, `guards`,
  `pi-publish`, `pi-command-handlers` names). In-repo docs: `README.md` command/tool tables,
  `CLAUDE.md` architecture summary.
- **Skipped scope:** `core/dashboard.ts` body beyond ~120 lines (renderer internals; the contract
  is the artifact, not the markup); the `mcp-server/server.ts` `TOOLS` registry already listed but
  its JSON text not quoted verbatim per tool; `core/broadside/{schemas,lenses,repo,requests,
  client,results}.ts` line-by-line (read earlier by the mechanical phase; here only the
  user-visible behavior was needed); the ~90 `tests/*.test.mjs` bodies only sampled; `docs/*`
  contents; `scripts/*`; `assets/`; most of `extensions/codecarto/*` beyond the command surface
  (`agent-widget`, `agent-summary`, `phase-compaction`, `dashboard-narrator`, `child-model-runtime`,
  `completions`, `notify`, `guide-framing`) read by name/export only.
- **Evidence basis:** source inspection (primary), plus the `## Validation` and command tables of
  the in-repo `README.md`/`CLAUDE.md`, plus the **names and selected bodies** of the test suite as
  executable contracts. **No tests were executed and no runtime probes ran this session** (no
  execution tool), so every test citation is "the test file pins X," not "X passed here."
- **Known blind spots:**
  1. No runtime verification — every test-based claim is a source read of the test, not an
     observed pass; every platform/network claim is hedged.
  2. Windows/macOS behavior of `atomicWriteFile`, the lock protocol, symlink-aware containment, and
     bare-`git` invocation (`q-node-windows-fs-semantics`, findings 6.1–6.4) — `verify at runtime`.
  3. OpenRouter Batch API semantics (`q-openrouter-batch-semantics`) — `verify at runtime`.
  4. Pi-SDK vs MCP execution parity (`q-pi-sdk-execution-parity`) — `verify at runtime`.
  5. `docs/library-format.md` and the rest of `docs/*` were not read; the declared authoritative
     ABI is unverified here.
  6. npm tarball template parity (`q-npm-tarball-template-parity`).
  7. Unread extension bodies and the dashboard renderer may hold user-visible behavior not
     contracted here.
- **Coverage disposition:** COMPLETE for the phase's declared scope (both executable surfaces and
  their storage/network features are contracted, `cf-arch-1` is closed for both surfaces, and a
  black-box acceptance list is provided). The residual limits above are named and routed as open
  questions / carry-forward, not smoothed over.
- **Contradiction sweep:** one measured contradiction with a summarized upstream claim — the
  architecture map and public-surfaces notes say "~21" Pi slash commands; a test pins **20** and
  `README.md` lists 20 (see Doc/Test Conflicts #1). No other contradiction with the architecture
  or defect-scan-mechanical owner_notes was found. The mechanical phase's coverage gap
  (`core/broadside/{lenses,models,collect,results,requests,render,verify}.ts` read by export only)
  was already closed by that phase; this phase read `render.ts` in full and the entry points of the
  rest, so contracts about Broad-Side text/output are `observed fact` rather than inherited
  summaries. The Windows-portability portions of the lock/rename/containment contracts inherit
  `verify at runtime` from `q-node-windows-fs-semantics`, exactly as the mechanical phase left
  them.

---

## Open Questions

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-node-windows-fs-semantics | needs-runtime-test | Do lock-file `O_EXCL`, atomic rename over an existing file, symlink-aware path containment, and bare-`git` invocation behave on Windows/macOS as the POSIX-written code expects? Every durability/serialization/containment contract here inherits this uncertainty. | Re-triaged this phase: still needs a runtime test (the code is written to POSIX expectations and CI runs Linux only); findings 6.1–6.4 and the contracts that route through `atomicWriteFile`/`acquireLock` carry `verify at runtime`. |
| q-openrouter-batch-semantics | needs-runtime-test | The exact OpenRouter Batch API contract Broad-Side relies on — concurrent-job quota, which catalog ids have `:batch` endpoints, and reasoning acceptance — is asserted in comments, not verifiable from source. | Re-triaged: still needs a live probe or the provider's source. The Broad-Side contract in this report states only what the code does locally; the remote behavior stays unsettled. |
| q-pi-sdk-execution-parity | needs-runtime-test | Byte-identical phase prompts are test-pinned, but whether Pi sub-agent execution (tool sandbox, compaction, session persistence) and an MCP host's execution produce equivalent *outcomes* is not established by reading. | Re-triaged: requires running the same phase under both surfaces and comparing. The contract asserts prompt parity (`observed fact`), not outcome parity. |
| q-npm-tarball-template-parity | needs-fixture-capture | Whether the published npm tarball's `.codecarto/` template and `agent-skill/` byte-match this checkout is not verified here. | Inherited from architecture; needs packing the tarball and diffing — a fixture capture, not a source read. |

**Re-triage result (orchestrator duty):** `q-openrouter-batch-semantics`,
`q-pi-sdk-execution-parity`, and `q-node-windows-fs-semantics` each **remain `needs-runtime-test`**
— none became answerable by reading this phase's sources. No contract or finding in this report
asserts a candidate answer to any of them with a settled action; every behavior that lands on
them carries `verify at runtime`. `q-npm-tarball-template-parity` remains `needs-fixture-capture`.
No **new** open question is registered by this phase: the one candidate, whether
`docs/library-format.md` matches the shapes `core/library.ts` reads and writes, is answerable by
reading (docs + code), so it is routed as `cf-contracts-1` to `protocols` rather than left as a
mislabeled runtime question.

---

## Carry-Forward

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| cf-contracts-1 | protocols | Whether `docs/library-format.md` (declared authoritative for the library ABI) matches the shapes `core/library.ts` reads and writes was not checked — `docs/*` was outside this phase's source scope, and architecture read only the directory listing. | Answerable by reading the doc against `core/library.ts`; it is a documentation-vs-code parity check, not a runtime question, so it belongs with the protocols phase's persistence-format work (`cf-arch-2`) rather than as an open question. |
| cf-contracts-2 | protocols | The dashboard's rendered content (what sections, counts, citations, and narration it shows) is contracted here as an artifact contract only; the byte-level catalog of the HTML body and its data sources is not extracted. | Renderer internals are the protocols/state rubric; the architecture phase deferred the `dashboard.ts` body beyond ~120 lines and the mechanical phase did not read it. |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | User-facing surfaces are split by surface type. | PASS | §Surfaces Covered names six surfaces (MCP tools/API, Pi commands/CLI-TUI, Broad-Side worker/network, drop-in workspace/storage, library/external storage, dashboard/artifact); §Feature Contracts is organized under them. |
| 2 | Feature contracts record trigger, defaults, outputs, side effects, persisted state, error behavior, and recovery behavior. | PASS | Every contract table in §Feature Contracts carries all eight fields plus Owner and Evidence (19 shared features, the drop-in workspace, the library, and the dashboard). The two `cf-arch-1` sections add per-argument defaults/side-effects/error behavior for all 22 MCP tools and all 20 Pi commands. |
| 3 | Security and authorization model is documented (if applicable). | PASS | §Security and Authorization documents the absence of authn/authz, the two path-confinement enforcement points (Pi `tool_call` guard, MCP `readSpecArg`), trust boundaries (secret redaction, spliced-text-as-data, tracked API key), publish gates as authorization decisions, secret management, session lifecycle, and the non-applicable web-security surface. |
| 4 | Contract ownership is mapped back to a layer or package. | PASS | Each contract's **Owner** field names the `core/` module(s) and the wrapper handler; §Surfaces Covered maps every surface to its owning package. |
| 5 | A black-box acceptance list is included. | PASS | §Black-Box Acceptance List: 30 scenario checks with preconditions and expected outcomes, none referencing source symbols; platform/network-dependent checks marked `[verify at runtime]`. |
| 6 | Findings are marked with evidence levels. | PASS | Evidence levels marked inline throughout (`observed fact`, `strong inference`, `external-behavior claim`, `portability hazard`, `open question`); each contract table has an **Evidence** row, and the acceptance list labels runtime-hedged rows. |
| 7 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits names all four plus a `COMPLETE` disposition and a contradiction sweep. |

**Validated by:** 2026-09-15 (contracts phase, self-audit session)
**Overall:** PASS
