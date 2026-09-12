# Behavioral Contracts

Source: commit `f6f8484` (v0.19.5). Sources consulted in the SKILL's priority order: `README.md`, `MANUAL.md`, `docs/mcp-quickstart.md`, `docs/client-surfaces.md`, the packaged agent guide (via `codecarto_guide`), the CHANGELOG for 0.19.0–0.19.5, the tool descriptions in `mcp-server/server.ts:1301-1670`; then the test suite (all 52 files by name, 20 read in full — listed under §Coverage and limits); then source for gaps. Evidence markers: `[fact]` observed fact, `[inference]` strong inference, `[external]` external-behavior claim, `[hazard]` portability hazard, `[open]` open question. Upstream: `findings/architecture/architecture-map.md`, `findings/defect-scan-mechanical/mechanical-defects.md` (finding numbers cited as `mech P.N`).

This phase closes routed item **arch-CF3** (per-command defaults, side effects, error text, recovery) with the contracts below, and closes open question **q-pi-ctx-invalidation** on the Pi SDK's own source (§High-Value Behaviors → Session replacement).

## Surfaces Covered

| Surface type | Instance | Notes |
|---|---|---|
| API / RPC | MCP server: 22 tools over stdio (`codecarto-mcp`) | The interoperable surface; stateless per call `[fact]` |
| TUI | Pi extension: 20 `/codecarto-*` slash commands, status line, two widgets, tool interception | Same core; executes phases as sub-agents `[fact]` |
| CLI | none beyond the bin that starts the MCP server | `codecarto-mcp` prints nothing and waits for JSON-RPC (`docs/mcp-quickstart.md:17`) `[fact]` |
| Bot / background worker | Pi `--auto` loop; Broad-Side batch jobs on OpenRouter | Both are host-driven, no daemon `[fact]` |
| Storage / export formats | `.codecarto/` workspace files, the library on-disk format, `dashboard.html` | Catalog in `findings/state-and-storage/state-and-storage.md`; schemas are the protocols phase's (arch-CF1) |
| Drop-in template | `.codecarto/` copied by hand, driven by any file-capable LLM | No executable; the LLM must perform completion by hand (§Doc/Test Conflicts #3) |
| Web UI | none (the dashboard is a static file) | |

## Feature Contracts

Contracts are written once per operation. Where the Pi command and the MCP tool share a contract, the row carries a **Pi delta** line for the differences. "Error behavior" quotes the message the user sees. Owner is `core` unless the behavior lives in a wrapper.

### API / RPC (MCP) and TUI (Pi): workflow operations

#### Initialize workspace — `codecarto_init` / `/codecarto-init [variant]`

| Field | Value |
|---|---|
| **Feature** | Create `.codecarto/` in a target repository from the packaged template and select a pipeline. |
| **Trigger or input** | MCP: `cwd` (absolute), optional `pipeline` alias or `workflow/*.yaml` path, optional `force`. Pi: optional variant argument, tab-completed from `PIPELINE_ALIASES`. `[fact: mcp-server/server.ts:179-264; extensions/codecarto/index.ts:510-588]` |
| **Defaults** | Pipeline `workflow/pipeline-full-with-deep-audit.yaml` (`core/pipeline.ts:25`); `force: false`; `project_name` = directory basename. |
| **Observable output** | "Initialized CodeCartographer workspace at …", pipeline label, first phase (`architecture`), seeded orchestrator files. Pi additionally names the full-run command `/codecarto-next --auto --llm-steer` (`tests/pi-parity-commands.test.mjs:443-449`) and renders the initial dashboard. |
| **Side effects** | Copies the template minus `BACKLOG.md`, `THREAD_LOG.md`, `CONVENTIONS.md`, `DECISIONS.md`, `closeouts/*`, and `broadside/` state (`core/workspace.ts:137-182`); writes a fresh `status.yaml`; seeds the four orchestrator files from templates; Pi sets `codecartoModeActive`, narrows tools to read/grep/find/ls/edit/write, renames the session `CodeCartographer: architecture` (`tests/pi-extension-activation.test.mjs:93-109`). |
| **Persisted state** | `.codecarto/` tree; `workflow/status.yaml` with every phase `pending`. |
| **Error behavior** | Existing `.codecarto/` without `force`: MCP `InvalidRequest` "A .codecarto/ directory already exists at … Pass force: true to back it up and reinitialize" (`tests/mcp-server.test.mjs:151-162`); Pi asks "CodeCartographer already exists — data will be lost" and returns on decline. Unknown pipeline: `InvalidParams` "Unknown pipeline: X" / Pi error notify. Relative or missing `cwd`: `InvalidParams`. A `.codecarto/` containing only `broadside/` is merged into, not refused (`server.ts:199-227`). |
| **Retry or recovery behavior** | `force: true` (MCP) or a confirmed Pi re-init moves the old workspace to `.codecarto-backup-<ISO timestamp>/`; nothing is deleted. `[hazard: mech 6.7]` when the target is the packaged template itself, status is reset with no backup. `[hazard: mech 1.2]` findings present in the template are copied into the new workspace. |
| **Owner** | core (`copyPackagedWorkspace`, `createEmptyStatus`, `seedOrchestratorFiles`); wrappers own the confirm/force gate. |

#### Open workspace — `codecarto_open` / `/codecarto-open`

| Field | Value |
|---|---|
| **Feature** | Attach to an existing workspace without changing state. |
| **Trigger or input** | `cwd`. |
| **Defaults** | none |
| **Observable output** | "Opened existing CodeCartographer workspace: <label>. Current phase: <next eligible or complete>." |
| **Side effects** | None on disk (`tests/pi-extension-activation.test.mjs:126-142` pins `status.yaml` byte-identical). Pi: activates mode, narrows tools, renames session. |
| **Persisted state** | none |
| **Error behavior** | No `workflow/status.yaml`: MCP `InvalidRequest` "No existing CodeCartographer workspace found. Run codecarto_init first."; Pi warning of the same. A malformed workspace (missing `pipeline:`, nonexistent pipeline file, unparsable YAML) surfaces as `InternalError` on MCP `[hazard: mech 2.8]`. |
| **Retry or recovery behavior** | Idempotent. |
| **Owner** | core `getWorkspaceState`; wrappers. |

#### Status — `codecarto_status` / `/codecarto-status`

| Field | Value |
|---|---|
| **Feature** | Report the next eligible phase, progress, counts, next actions, and scaffold staleness. |
| **Trigger or input** | `cwd`. Pi requires an active mode. |
| **Defaults** | The reported "Phase" is `getNextEligiblePhase`, not the stored `current_phase` (`server.ts:269-270`). |
| **Observable output** | Lines `Phase:`, `Pipeline state: in progress|complete`, `Pipeline: <label> (<path>)`, `Progress: n/N complete`, `Open questions (terminal unresolved): n`, `Carry-forward (pipeline phases): n`, `Post-pipeline work: n pending`, then **every** `next_actions` line (first prefixed `Next:`) (`tests/terminal-next-actions.test.mjs:147-157`), and `Scaffold: <notice>` when the scaffold version differs from the running framework (`tests/scaffold-staleness.test.mjs`). Structured: `currentPhase`, `completed`, `total`, `openQuestionsCurrentPhase`, `openQuestionsTerminal`, `carryForwardTotal`, `postPipelinePending`, `nextActions`, optional `scaffoldNotice`. |
| **Side effects** | none |
| **Persisted state** | none |
| **Error behavior** | No workspace: `InvalidRequest` naming `codecarto_init`. Pi before init/open: warning "CodeCartographer is not active in this session. Run /codecarto-init first." — printed to stderr when there is no TUI (`tests/notify-fallback.test.mjs:129-137`). |
| **Retry or recovery behavior** | Read-only. |
| **Owner** | core for counts and next actions; wrappers for rendering (Pi widget shows only `next_actions[0]`, `index.ts:148`). |

#### Next phase prompt — `codecarto_next` / `/codecarto-next [flags]`

| Field | Value |
|---|---|
| **Feature** | MCP: return the prompt for the next eligible phase. Pi: **execute** that phase as an isolated sub-agent, then auto-validate and auto-complete it. |
| **Trigger or input** | MCP: `cwd`. Pi flags: `--auto`, `--strict` (only with `--auto`), `--llm-steer`, `--no-llm-steer` (`extensions/codecarto/next-flags.ts`). |
| **Defaults** | Next phase = first in `phase_order` not `complete` whose `depends_on` are all `complete` (`core/pipeline.ts:37-49`). Pi: one phase, no steering unless `orchestrator.llm_steer_next_phase: true`. |
| **Observable output** | MCP: the prompt text in both `content[0].text` and `structuredContent.text` (`tests/structured-payload.test.mjs`), byte-identical to `buildPhasePrompt(state, phase, false)` (`tests/mcp-server.test.mjs:53-65`). The prompt lists required reads (GUIDE, status.yaml, handoff template, existing output, SKILL, template, pipeline `required_reads`, checkpoint if present, CONVENTIONS/DECISIONS if present), routed carry-forward items, orchestrator duties (pending proposals, re-triage list, declared secondary outputs with existence, upstream coverage gaps, contradiction sweep), stale-scaffold `WARNING:` lines, the Strategic Alignment Hook on `reimplementation-spec`, rules, handoff requirements, and the primary output path (`core/prompts.ts:132-281`). When complete: "All CodeCartographer phases are complete. Run codecarto_skill for post-pipeline work." (`server.ts:348`). Pi: notifications for each stage, a `codecarto-phase-summary` message, then either "Phase X auto-completed (validation: …)" or the validation/completion refusal. |
| **Side effects** | MCP: none. Pi: spawns a file-backed child session under `~/.pi/agent/sessions/`, writes findings via the child, appends a usage run, re-renders the dashboard, and on PASS/PASS WITH GAPS runs completion (`index.ts:761-811`). |
| **Persisted state** | Pi: usage log, dashboard, and everything completion writes. |
| **Error behavior** | MCP: preflight failures (synthesis phases) map to `InvalidRequest` (`tests/synthesis.test.mjs:190-202`). Pi: `--strict` without `--auto` → "Flag --strict requires --auto."; unknown flag → "Unknown /codecarto-next flag: X"; phase already running → "Phase X is already running."; sub-agent spawn failure → notification, never a throw (`tests/pi-command-handlers.test.mjs:132-180`); validation FAIL/MISSING → "Phase X validation: FAIL. Fix the output, then re-run /codecarto-next."; completion refusal → "Auto-completion failed for X: <reason>. Run /codecarto-complete manually." |
| **Retry or recovery behavior** | Re-running picks up from `status.yaml`. If the sub-agent stops without writing the primary output, or ends on a tool call, the runner sends one continuation prompt (`agent-runner.ts:267-274`). `--auto` resumes from the next eligible phase (README §End-to-end auto mode). |
| **Owner** | core `buildPhasePrompt`, `getNextEligiblePhase`; Pi wrapper owns execution (`auto-runner.ts`, `agent-runner.ts`). |

#### Auto mode — `/codecarto-next --auto [--strict]` (Pi only)

| Field | Value |
|---|---|
| **Feature** | Run every remaining phase back to back. |
| **Trigger or input** | `--auto`; `--strict` changes the PASS WITH GAPS rule. |
| **Defaults** | Non-strict: PASS WITH GAPS advances. The `reimplementation-spec` prompt under auto suppresses the user question and defaults to language-agnostic, tagging `selection: auto-default` (`tests/prompts-auto.test.mjs:60-68`). |
| **Observable output** | Per-phase summaries, then a `codecarto-auto-summary` block: outcome (`complete`/`stopped`/`aborted`), `phasesRun/total`, tokens, wall time, the validation summary when stopped, and a recovery hint (`auto-runner.ts:442-499`). |
| **Side effects** | Same as one phase, repeated; widget and session name refresh between phases. |
| **Persisted state** | As above. |
| **Error behavior** | Decision matrix pinned by `tests/auto-runner.test.mjs`: aborted → aborted; sub-agent error → stop with the error; FAIL or MISSING → stop; PASS WITH GAPS + strict → stop; missing validation → stop; preflight error → stop; auto-complete refusal → stop with "Auto-complete failed on X: …". |
| **Retry or recovery behavior** | Hints: aborted → "Run /codecarto-next --auto to resume."; FAIL/MISSING → "Fix the phase output, then /codecarto-next --auto to resume."; strict PASS WITH GAPS → "Review gaps via /codecarto-validate, then /codecarto-complete <phase>, then /codecarto-next --auto." |
| **Owner** | Pi wrapper (`runAuto`, `decideAfterPhase`). |

#### Forced phase prompt — `codecarto_phase` / `/codecarto-phase <id>`

| Field | Value |
|---|---|
| **Feature** | Return the prompt for a named phase regardless of DAG order. |
| **Trigger or input** | `phase`: exact id, or the primary output's basename with or without `.md`, or a pasted primary-output path (`tests/resolve-phase.test.mjs`). |
| **Defaults** | none; the prompt adds "The user explicitly requested this phase even if it is not the next eligible phase." and a "Warning: dependencies not complete yet: …" line when applicable. |
| **Observable output** | Prompt text (MCP). Pi **queues the prompt as a user message** into the current session rather than spawning a sub-agent (`index.ts:841-845`). |
| **Side effects** | none (MCP); Pi sends a user message (immediately if idle, else as a follow-up). |
| **Error behavior** | Unknown phase: `InvalidParams` "Unknown phase: X" / Pi error. Empty: MCP `InvalidParams` "phase is required"; Pi "Usage: /codecarto-phase <phase>". |
| **Owner** | core `resolvePhase`, `buildPhasePrompt(forced=true)`. |

#### Validate — `codecarto_validate [phase]` / `/codecarto-validate [phase]`

| Field | Value |
|---|---|
| **Feature** | Parse the primary output's `## Validation` block and report PASS / PASS WITH GAPS / FAIL / MISSING. |
| **Trigger or input** | Optional `phase` (defaults to next eligible). A non-string `phase` is refused with "phase must be a string when provided" (`tests/mcp-server.test.mjs:224-241`). |
| **Defaults** | The block is found by the **last** `## Validation` heading; rows are any 4+-cell table rows after it whose first cell is not `#` or a separator; the overall comes from the last `**Overall:**` line and must be exactly `PASS` or `PASS WITH GAPS` (case-insensitive) — anything else is FAIL (`core/pipeline.ts:114-158`) `[hazard: mech 2.6]`. |
| **Observable output** | `Validation: <overall>`, `Output: .codecarto/<path>`, `Gaps: n` when any PARTIAL row, up to three error lines, `NOTE: …` lines from the findings cross-checks and for declared secondary outputs not yet written (`tests/prompts-auto.test.mjs:102-135`). Structured: `phaseId`, `overall`, `exists`, `hasValidationBlock`, `rows`, `gaps`, `errors`, `secondaryOutputs`. |
| **Side effects** | none |
| **Error behavior** | Missing file → MISSING with "Missing primary output: .codecarto/<path>"; no `## Validation` heading → FAIL "Primary output exists but is missing a ## Validation block."; any row containing `FAIL` → FAIL; a findings table (Evidence Level + Action columns) pairing `open question`/`external-behavior claim` with `fix before porting`/`fix now` → FAIL on scaffold ≥ 0.17.1, NOTE on older (`tests/findings-cross-check.test.mjs`). |
| **Retry or recovery behavior** | Edit the file and re-run; nothing is cached. |
| **Owner** | core `validatePhaseOutput`, `crossCheckFindings`. |

#### Complete — `codecarto_complete [phase]` / `/codecarto-complete [phase]`

| Field | Value |
|---|---|
| **Feature** | Gate a phase on validation plus a handoff, then apply the handoff to canonical state. |
| **Trigger or input** | Optional `phase`; a handoff at `scratch/handoffs/<phase>.yaml`. |
| **Defaults** | Handoff arrays default to empty; ids auto-assigned `oq-<phase>-N` / `cf-<phase>-N`; PARTIAL rows become `needs-maintainer-decision` questions (`tests/open-questions.test.mjs:196-230`) `[hazard: mech 1.5]`. |
| **Observable output** | "Marked X complete (validation: …)", "Next phase: Y", "Closeout: .codecarto/closeouts/<date>-X.md", an "Orchestrator checkpoint: …" line naming decisions appended, proposals pending, and open questions to re-triage, "Dashboard refreshed: …", and `NOTE:` lines for non-gating warnings. |
| **Side effects** | Under `status.yaml.lock`: phase → `complete` with three boilerplate owner notes appended; handoff applied (notes, questions with cross-phase dedupe by id, carry-forwards, closures, post_pipeline, decisions → `DECISIONS.md` `D<NNN>` rows, proposals → `CONVENTIONS.md` pending list); `current_phase` and `next_actions` recomputed (terminal actions name skills, amend, publish, dashboard for **both** surfaces, `tests/terminal-next-actions.test.mjs`); closeout written from `closeout_content` or the template, THREAD_LOG line appended once per closeout link. MCP appends a zero-token usage receipt (`recorded_by: mcp-complete`). Both surfaces re-render the dashboard, best effort. |
| **Persisted state** | `status.yaml`, closeout, `THREAD_LOG.md`, `DECISIONS.md`, `CONVENTIONS.md`, `.usage.local.yaml`, `dashboard.html`. |
| **Error behavior** | Refusals, all before any write: validation FAIL/MISSING ("Cannot complete X: validation is …"); no handoff on a phase with `handoff_requirements` (names the path and every field, `tests/framework-handoff.test.mjs:408-428`); `carry_forward.target_phase` absent, earlier, or self ("target_phase X is not a downstream active pipeline phase; use post_pipeline…", `tests/post-pipeline.test.mjs:33-46`); `post_pipeline` entry without id; closing a carry-forward whose `derives_from` question is still open and not closed here (D1, names both ids and "verify at runtime"); closing a `needs-runtime-test` question with no `evidence` on scaffold ≥ 0.19.0 (D3; warning on older scaffolds) (`tests/closure-integrity.test.mjs`); malformed handoff collections ("owner_notes must be an array", "proposed_conventions entries require non-empty name and rule"); output that no longer validates under the lock ("the output no longer validates under the status lock (now …)", `tests/broadside-scan-fixes.test.mjs` #132). MCP wraps these as `InvalidParams`; Pi shows "Completion refused: …" and never throws (`tests/pi-command-handlers.test.mjs:306-323`). |
| **Retry or recovery behavior** | Idempotent on re-run: notes deduped, closures re-applied by id, one closeout per phase (latest `<date>-<phase>.md` overwritten), THREAD_LOG entry once (`tests/framework-handoff.test.mjs:323-346`). A lock older than 60 s is broken; a held lock times out after 5 s with "Timed out waiting for lock: …". |
| **Owner** | core `completeValidatedPhase`; wrappers add the usage receipt and dashboard. |

#### Switch pipeline — `codecarto_switch_pipeline` / `/codecarto-switch-pipeline <variant>`

| Field | Value |
|---|---|
| **Feature** | Change the active pipeline in place. |
| **Trigger or input** | `pipeline` alias (`full-with-audit`, `full-with-deep-audit`, `scout-first`, `full`, `defect-scan`, `lite`, `architecture-only`, `synthesis`) or a `workflow/*.yaml` path. |
| **Defaults** | Same pipeline → "Already on pipeline: <label>" and no write. |
| **Observable output** | "Switched pipeline: <label>", then "Phases preserved (completed): …", "New phases: …", "Phases not in new pipeline: … (findings remain on disk)". |
| **Side effects** | Rewrites `status.yaml` under the lock: shared phases keep their record; new phases `pending`; `post_pipeline` preserved. `current_phase`/`next_actions` reset to the first phase `[hazard: mech 1.3]`; carry-forwards targeting dropped phases dangle `[hazard: mech 1.4]`. Pi re-renders the dashboard; **MCP does not** (`server.ts:316-341` has no dashboard call; `index.ts:645` does). |
| **Error behavior** | Unknown variant: "Unknown pipeline: X", status untouched (`tests/mcp-uncovered-handlers.test.mjs:91-100`). Pi with no argument: "Usage: /codecarto-switch-pipeline <variant> (e.g. lite, full, synthesis)". |
| **Retry or recovery behavior** | Switching back restores carried phases; dropped phases' findings stay on disk. |
| **Owner** | core `switchPipeline`. |

#### Skills — `codecarto_skill`, `codecarto_list_skills` / `/codecarto-skill`, `/codecarto-list-skills`

| Field | Value |
|---|---|
| **Feature** | List and run post-pipeline skills; serve the Broad-Side reading guide ungated. |
| **Trigger or input** | `name` = a directory under `.codecarto/skills/` with a `SKILL.md` (today: `spec-delta-application`), or `broadside`. |
| **Defaults** | Skills are gated on `getNextEligiblePhase === null`; `broadside` is exempt and needs no workspace (`tests/mcp-server.test.mjs:98-128`; `tests/pi-extension-activation.test.mjs:111-124`). |
| **Observable output** | Skill prompt (reads GUIDE, status.yaml, the SKILL, CONVENTIONS/DECISIONS; rules forbid touching phase status). List: "Available skills (n):" plus, on Pi, when they unlock; both name the ungated `broadside`. |
| **Side effects** | none (Pi queues the prompt as a user message). |
| **Error behavior** | Mid-pipeline: "Cannot run skill: pipeline is not complete (next phase: X). Finish the pipeline first." Unknown name: "Unknown skill: X. Available: … The Broad-Side reading guide is served as `broadside` and is not pipeline-gated." |
| **Owner** | core `listSkillNames`, `buildSkillPrompt`, `readBroadsideSkill`. |

#### Guide — `codecarto_guide [topic]` / `/codecarto-guide [topic]`

| Field | Value |
|---|---|
| **Feature** | Serve the packaged driving guide (overview + 10 reference topics) without a workspace. |
| **Defaults** | Topic `overview`; installer frontmatter stripped; the whole document, never a prefix (`tests/guide.test.mjs`). |
| **Observable output** | Document plus "Other guide topics: … (call codecarto_guide with topic)." Pi wraps it: a "reference material, not a task" preamble, the verbatim document, a Pi-surface addendum (no tools exist; slash-command mapping; the drive-loop difference; the four `--auto`/`--llm-steer` invocations), and a footer naming `/codecarto-guide <topic>` (`tests/pi-parity-commands.test.mjs:147-218`; `extensions/codecarto/guide-framing.ts`). |
| **Error behavior** | Unknown topic: "Unknown guide topic X. Available: overview, …" (`InvalidParams` on MCP; Pi sends nothing). |
| **Owner** | core `readGuide`; Pi wrapper owns the framing. |

#### Refresh scaffold — `codecarto_refresh_scaffold` / `/codecarto-refresh-scaffold`

| Field | Value |
|---|---|
| **Feature** | Overwrite framework-owned files from the packaged template. |
| **Defaults** | Never touches `workflow/status.yaml`, `workflow/config.yaml`, `workflow/.usage.local.yaml`, the four orchestrator files, `scratch/`, `inputs/`, `closeouts/`, `broadside/` (`core/workspace.ts:210-214`). Files the template no longer ships are left in place. |
| **Observable output** | "Refreshed N framework-owned file(s) from the packaged template (<before> → <after>)." plus up to 20 paths (MCP). Pi first shows the exact file set grouped by directory and the protected list, and asks; declining writes nothing (`tests/pi-parity-commands.test.mjs:222-286`). |
| **Side effects** | Copies each listed file; appends one THREAD_LOG line `scaffold-refresh — Refreshed N …`. Clears the staleness notice. |
| **Error behavior** | No workspace: refusal naming init. Missing packaged template: "Packaged .codecarto template is missing. Reinstall codecartographer-pi." |
| **Owner** | core `refreshScaffold`, `listScaffoldRefreshFiles`. |

#### Amend — `codecarto_amend <name>` / `/codecarto-amend <name>`

| Field | Value |
|---|---|
| **Feature** | Post-pipeline closure of open questions and `post_pipeline` items from `scratch/amendments/<slug>.yaml`. |
| **Trigger or input** | Slug, `slug.yaml`, or (Pi) a path inside `scratch/amendments/`; tab-completion lists staged files. |
| **Defaults** | Refused while any phase is eligible. Ids that match nothing are reported, not fatal; re-running is idempotent (`tests/amendment.test.mjs`). |
| **Observable output** | "Amendment applied.", "Open questions closed: …", "Post-pipeline items closed: …", "Ids that matched nothing …", closeout path, dashboard line. Pi previews every closure resolved against `status.yaml` (with kind, phase, description, "matches nothing" markers) and asks first. |
| **Side effects** | Under the completion lock: removes questions/items by id, rebuilds terminal `next_actions` with live counts, writes `closeouts/<date>-amendment-<slug>.md`, one THREAD_LOG line, dashboard. |
| **Error behavior** | "Cannot amend: the pipeline is not complete (next phase: X) …"; "No amendment at .codecarto/scratch/amendments/<slug>.yaml …"; "Invalid amendment: nothing to apply"; "… must be an array"; "Invalid amendment name: <slug>" for path-shaped names. Pi raises all of these before asking. |
| **Owner** | core `applyAmendment`. |

#### Usage — `codecarto_usage` / `/codecarto-usage`

| Field | Value |
|---|---|
| **Feature** | Totals and per-phase token/tool/duration/compaction figures from `.usage.local.yaml`. |
| **Defaults** | Empty log → "No phase runs recorded yet." MCP-recorded runs carry zeros and are called out: "Note: n run(s) recorded via codecarto_complete carry no token or activity data … zeros above are unknowns, not free runs." |
| **Observable output** | Totals, then `  <phase>: n run(s), tokens, tool uses, ms`; Pi adds compaction counts or "compactions unavailable". |
| **Error behavior** | No workspace: refusal. A corrupt log reads as empty `[hazard: mech 2.3]`. |
| **Owner** | core `usage.ts`. |

#### Dashboard — `codecarto_dashboard` / `/codecarto-dashboard [--narrate]`

| Field | Value |
|---|---|
| **Feature** | Render `.codecarto/dashboard.html`, a single self-contained file. |
| **Defaults** | Re-rendered on init (Pi), completion, amendment, publish (Pi), phase run (Pi), and on demand. Contains one JSON data island and one inline script for search, filter, export, and the sidebar toggle (`core/dashboard.ts:611-666`) — see §Doc/Test Conflicts #4. |
| **Observable output** | "Dashboard regenerated: .codecarto/dashboard.html". `--narrate` (Pi) writes a 200–400-word LLM summary cache first, or reports "LLM narration skipped (<reason>)". |
| **Side effects** | Temp-file + rename of the HTML; `.dashboard-narration.local.md` when narrating. |
| **Error behavior** | MCP: "Dashboard render failed: the workspace state could not be gathered or .codecarto/dashboard.html is not writable." (cause not surfaced `[hazard: mech 2.9]`). Never fails a completion (`tests/dashboard-on-complete.test.mjs`). |
| **Owner** | core renderer; `extensions/codecarto/dashboard-writer.ts` I/O (shared by both surfaces, arch-CF2). |

#### Config — `codecarto_config [cwd]` / `/codecarto-config`

| Field | Value |
|---|---|
| **Feature** | Show the effective merged configuration and whether the library marker exists. |
| **Defaults** | With `cwd`: workspace layer over user-global; without: user-global only. `library.publish_confirm` default `true`; `orchestrator.llm_steer_next_phase` default `false`. |
| **Observable output** | `library.path`, `library.namespace`, `library.publish_confirm`, `orchestrator.llm_steer_next_phase`, `Library marker: found ("name", namespaced: b) | MISSING | not configured`, both config paths. |
| **Error behavior** | Relative `cwd` refused ("must be an absolute path") so the server never answers from its own directory (`tests/mcp-server.test.mjs:254-256`). Malformed config layers are silently dropped `[hazard: mech 2.4]`. Pi shows a spurious "not active" warning when run before init and still reports. |
| **Owner** | core `orchestrator-config.ts`. |

#### Vision — `codecarto_vision` / `/codecarto-vision`

| Field | Value |
|---|---|
| **Feature** | Return (MCP) or queue (Pi) the guided-interview prompt that writes `inputs/vision.md`. |
| **Trigger or input** | MCP: `cwd`, non-empty `raw_text` (interpolated into the prompt). Pi: none; interactive interview. |
| **Defaults** | Requires `findings/vision-capture/INTERVIEW.md` in the workspace, which every init copies regardless of pipeline (`tests/pi-command-handlers.test.mjs:377-390`). |
| **Error behavior** | Missing/blank `raw_text`: "raw_text is required (the user's raw product description)". Missing skill: "Vision interview skill not found. Run codecarto_init with the synthesis pipeline first." |
| **Owner** | wrappers (prompt assembly is surface-local). |

### API / RPC (MCP) and TUI (Pi): library operations

#### Publish — `codecarto_publish` / `/codecarto-publish`

| Field | Value |
|---|---|
| **Feature** | Publish a reimplementation spec into a versioned library entry. |
| **Trigger or input** | MCP: `source_repo`, `headline`, and `spec` or absolute `spec_path`; `library_path` or `cwd` (config); optional `slug`, `namespace`, `tags`, `capabilities`, `confidentiality`, `model_metadata`, `force_new_version`, `allow_source_repo_change`, `allow_confidentiality_mismatch`, `confirm`. Pi: no arguments — reads `findings/reimplementation-spec/reimplementation-spec.md`, derives `source_repo` from `origin`'s URL, else the tracked remote, else the directory (`tests/pi-publish.test.mjs`), derives the slug from it, and the headline from the spec's `## System Summary` first line. |
| **Defaults** | Slug = last path segment of `source_repo`, lowercased, non-`[a-z0-9-]` → `-`, max 64, `entry-` prefix if it does not start with a letter, `-entry` suffix if reserved (`latest`, `index`, `entries`). Confidentiality `internal`. Generation `surface: mcp-server` / `pi-extension` with `unknown` fields unless supplied. |
| **Observable output** | "Published <ns/>slug vN to <path>", "New version: vN" or "Metadata-only update (content hash matched vN).", entry directory. |
| **Side effects** | New `entries/[ns/]slug/vN/{reimplementation-spec.md, metadata.yaml}` staged then renamed; `latest` pointer rewritten; `index.yaml` and `INDEX.md` regenerated. Identical spec bytes → metadata rewritten in place, provenance carried forward, no new version (`tests/library.test.mjs`). |
| **Persisted state** | The library tree; optional git commit (never a push). |
| **Error behavior** | Missing `source_repo`/`headline`; invalid slug; namespaced library without namespace ("Library is namespaced — input.namespace is required" / MCP "namespace argument is required (or set library.namespace in config.yaml)"); single-tenant with a namespace; `spec_path` outside the library or `<cwd>/.codecarto` ("spec_path must be within the workspace (.codecarto/) or the configured library path", `tests/publish-path-containment.test.mjs`); **collision guard**: the entry's newest version records a different repository → "Refusing to publish: entry X vN records source_repo …, but this publish carries … Publishing would append this spec to a different project's version history …" (spellings of one repo are reconciled by `sameSourceRepo`); **confidentiality guard**: entry more restricted than the library's visibility (internal < shared < public) → "Refusing to publish: entry X has confidentiality …, but library Y has visibility …"; **publish_confirm gate** (MCP only, only when a config layer set the key): refused with a preview naming the version it would land on, source, headline, confidentiality, spec source, and "Re-invoke codecarto_publish with the same arguments plus confirm: true" (`tests/mcp-library.test.mjs:328-`). Pi turns the two guards into questions ("Source repository changed — did it move?", "Confidentiality mismatch — publish anyway?") and cancels with "Publish cancelled. Nothing was written." on no. |
| **Retry or recovery behavior** | Re-publishing the same bytes is idempotent; `force_new_version` bumps anyway but never bypasses either guard. Nothing is written when a guard fires. |
| **Owner** | core `publishEntry`, `previewPublishVersion`, `deriveSlug`, `resolvePublishSourceRepo`; wrappers own the confirm/flag surfaces. |

#### Library init / list / reindex — `codecarto_library_init`, `codecarto_library_list`, `codecarto_library_reindex` / `/codecarto-library-init <path> [--namespace n]`

| Field | Value |
|---|---|
| **Feature** | Create a library (marker + user-global config); list entries with filters; regenerate the derived index. |
| **Trigger or input** | Init: absolute `library_path` (MCP refuses relative, `tests/self-scan-triage.test.mjs:153-176`; Pi resolves relative against the session cwd and expands `~`), optional `name`, `namespace`. List: `namespace`, `tag`, `slug`, `source_repo` filters. |
| **Defaults** | Marker `{schema_version: 1, name: basename, namespaced: !!namespace, visibility: internal, created_at}`; existing marker preserved ("Library already exists at … (marker preserved)"). Init writes `library.path`, `library.namespace`, and **`publish_confirm: true`** into `~/.codecarto/config.yaml` `[hazard: mech 6.6]`. List prefers `index.yaml` when present and parseable, else reindexes. |
| **Observable output** | List: "n entries in <path>:" then `  <ns/>slug vN — headline [tags…]`, with " — PROVENANCE CONFLICT (see below)" and a "Provenance conflicts — …" block when an entry's older versions record a different repository. Reindex: "Reindexed <path>: n entries across namespaces [...]" plus the same conflict block. |
| **Side effects** | Reindex rewrites `index.yaml` and `INDEX.md` atomically; never renames or renumbers entries (repair is manual by design). |
| **Error behavior** | "No CodeCartographer library at <path> (missing .codecarto-library marker) …"; "library_path is required (pass it explicitly, or pass cwd and configure library.path …)". |
| **Owner** | core `library.ts`. |

### Bot / background worker: Broad-Side — `codecarto_broadside` / `/codecarto-broadside [action] [lenses…] [flags]`

| Field | Value |
|---|---|
| **Feature** | Submit six single-turn analysis lenses as OpenRouter batch jobs, poll and collect them, run synthesis and triage post-passes; list batch models; show recorded runs. |
| **Trigger or input** | `action` ∈ submit (default on Pi) / collect / status / models; `lenses` ⊆ architecture, api, security, defect, conventions, porting; `api_key` (MCP param, `OPENROUTER_API_KEY`, or `broadside/config.yaml`; Pi deliberately takes no key argument, `tests/pi-broadside.test.mjs:136-154`); `wait_seconds`, `include_synthesis`, `include_triage`, `retry_truncated`, `max_cost`, `force`, `incremental`, `include_benchmarks`. Precedence: parameter → config.yaml → shipped default. Pi flags: `--incremental`/`--no-incremental` (contradiction is an error), `--max-cost=N`, `--wait=S`, `--no-synthesis`, `--no-triage`, `--no-retry-truncated`, `--benchmarks`; a flag meaningless for the action is refused, a malformed number is an error not a fallback (`tests/broadside-flags.test.mjs`). |
| **Defaults** | Model `google/gemini-3.7-flash:batch`; all six lenses; `max_cost` 0 = unlimited `[hazard: mech 6.2]`; `wait_seconds` 0 (submit returns immediately; collect then uses the 25-minute default `[hazard: mech 6.3]`); retry truncated once with doubled `max_tokens`; synthesis and triage on; reasoning capped at 25 % of each lens's `max_tokens` (min 512). Works on any git repository, no workspace needed. |
| **Observable output** | Submit: "Broad-Side submitted n batch(es)[; m lens(es) produced none]" with per-lens `batch <id>` or `skipped`, request counts and estimated cost, an "Incremental: …" line when requested (applied or why not), estimated total, pricing source, model context/output caps, run limit, output dir, the collect instruction, and the unverified-leads disclaimer (`core/broadside.ts:3104-3155`). Pi shows the per-lens estimate and asks "Broad-Side will spend about $X" first; decline submits nothing. Collect: per-lens status/cost/results/truncation, retried and still-truncated counts, synthesis and triage status with top findings and the P0–P3 work order, disclaimer. Status: the last three runs. Models: a table sorted cheapest first with pricing, context, max output, structured-output support, optional coding index. |
| **Side effects** | Submit: `broadside/state.json` run record, `broadside/<run>/requests.json`, `model-catalog.json` cache; **spends money**. Collect: `raw-<lens>.json`, per-slice `.json`/`.md`, `*.error.json`, `synthesis.*`, `triage.*`, `run-meta.json`. |
| **Persisted state** | As above; runs are append-merged by id so concurrent operations do not erase each other (`tests/broadside.test.mjs` "a checkpoint does not erase a run…"). |
| **Error behavior** | No key: "No OpenRouter API key found. Pass api_key, set the OPENROUTER_API_KEY environment variable, or add api_key to .codecarto/broadside/config.yaml."; unknown action/lens refused before any spend; estimate over `max_cost` without `force` (MCP): "Estimated Broad-Side cost ~$X exceeds the run limit $Y. Nothing was submitted." with a per-lens breakdown; model without structured-output support refused; unpriceable model: "Could not resolve per-token pricing for batch model …"; collect with no run: "No Broad-Side run recorded. Call codecarto_broadside with action 'submit' first."; a network throw during submission marks the lens `rejected`; a batch that never returns is reported as `timeout` and left claimable; dead statuses (`failed`, `expired`, `cancelled`, `auth-failed`) retire a lens or post-pass. |
| **Retry or recovery behavior** | Collect is resumable: terminal lenses are skipped, saved results are read back off disk so post-passes can run after an interrupted collect, a post-pass left `submitted` is polled and claimed, truncated slices are re-submitted once, all polls share one deadline (`tests/broadside.test.mjs` names "a resumed collect…", "a post-pass left at submitted…", "wait_seconds bounds the whole collect…"). |
| **Owner** | core `broadside.ts`; wrappers own the key resolution and the confirm-vs-refuse split. |

### TUI-only behaviors (Pi extension)

| Feature | Contract | Evidence |
|---|---|---|
| Activation gate | Every workflow command refuses until `/codecarto-init` or `/codecarto-open` in this session; the presence of `.codecarto/` alone activates nothing (`tests/pi-extension-activation.test.mjs:68-91`). `/codecarto-guide`, `/codecarto-skill broadside`, `/codecarto-broadside`, `/codecarto-vision`, `/codecarto-library-init`, `/codecarto-config` work without activation. | `[fact]` |
| Tool interception | While active: `bash` blocked with "CodeCartographer mode disables bash to keep source analysis read-only."; `edit`/`write` allowed only under `.codecarto/` or a marker-validated configured library, else "CodeCartographer mode only allows <tool> within .codecarto/ or the configured CodeCartographer library." Phase child sessions get the same guard minus the library (`phase-compaction.ts:68-86`). | `[fact]`; symlinked non-existent targets routed as mech-CF2 |
| Status widget and line | `CC <phase>` status line; widget with phase, pipeline state, progress, counts, `Next:` (first action only), optional `Scaffold:` line, and the last command's feedback lines. | `[fact: index.ts:140-184]` |
| Agents widget | While a phase runs: spinner, turns, tool uses, tokens, compactions, elapsed; finished phases linger ~6.4 s (80 ticks × 80 ms), the activity record 30 s. | `[fact: agent-widget.ts:19-23; auto-runner.ts:201-203]` |
| Headless (`pi -p`) | With no TUI every notification goes to **stderr** as `[codecarto] <level>: <message>`; stdout is left to `--mode json`. A stale ctx drops the message. | `[fact: tests/notify-fallback.test.mjs]` |
| Phase-completion summary | A `codecarto-phase-summary` message with status, stats, ≤2000-char excerpt, transcript path, and "Auto-validating and completing the phase…" lands in the orchestrator transcript; no auto-trigger. | `[fact: tests/agent-summary.test.mjs]` |
| LLM steering | `--llm-steer` or config: a tool-less one-shot session rewrites the next prompt from the previous phase's closeout (≤ 8000 bytes); the first phase reports "LLM rewriter skipped (no previous phase to steer from)"; the rewritten prompt is posted as a `codecarto-steering` message. | `[fact: agent-rewriter.ts; tests/agent-rewriter.test.mjs]` |

### Storage / export formats (user-visible contract only; schemas → protocols)

| Artifact | Contract |
|---|---|
| Phase output markdown | Must end with `## Validation` table and `**Overall:** PASS` or `PASS WITH GAPS`; must carry `## Coverage and limits` with the five fixed bullets (its Skipped scope / Known blind spots travel into later prompts, `tests/closure-integrity.test.mjs:461-503`); defect reports' findings tables are cross-checked. `[fact]` |
| Handoff YAML | `schema_version: 1`, exact `phase_id`, eight optional arrays, `closeout_summary`, optional `closeout_content`; block scalars `\|`, `\|-`, `\|+`, `>`, `>-`, `>+` accepted in mapping values and sequence items (`tests/yaml.test.mjs`); duplicate keys rejected; a sequence item's nested keys must sit exactly at the item's content column `[hazard: mech 2.7]`. `[fact]` |
| `status.yaml` | Framework-owned; hand edits are the drop-in fallback only. Legacy files lacking `post_pipeline`, `schema_version`, or per-phase arrays normalize on read; `schema_version > 1` refused. `[fact]` |
| Library | Marker JSON, `entries/[ns/]slug/vN/`, `latest` regular file, derived `index.yaml`/`INDEX.md`; ABI per `docs/library-format.md`. `[fact]` |
| `dashboard.html` | Self-contained; relative links only (absolute or dot-segment paths are refused, so Pi session transcripts never link, mech 1.14). `[fact]` |

## High-Value Behaviors

- **Cancellation and abort.** Pi passes `ctx.signal` into the phase runner; abort calls `session.abort()`, the phase is recorded `aborted`, and `--auto` returns `aborted` without validating (`agent-runner.ts:249-257`; `tests/auto-runner.test.mjs`). MCP has no cancellation: a `collect` blocks the call for its poll budget `[fact]`.
- **Session replacement (closes q-pi-ctx-invalidation).** The Pi SDK invalidates an extension ctx in exactly two places: `AgentSession.dispose()` (session replacement via newSession/fork/switchSession) and `AgentSession.reload()` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:584-595, 2217-2221`, v0.85.1); afterwards every property access throws the stale message (`runner.js:396-405`). `createAgentSession` builds a child with its own runner and never disposes the parent, so **running a phase does not invalidate the orchestrator's ctx** `[fact: SDK source]`. The captured-`cwd` and `isCtxLive` defenses in the extension therefore guard against a user issuing `/new`, `/fork`, `/switch`, or `/reload` while a phase or `--auto` run is in flight — a real and documented outcome, not the routine one. The remaining inconsistency (`auto-runner.ts:170,387` still read `ctx.cwd`) stays routed as mech-CF4 with the corrected framing: it crashes an in-flight run only after such a user action `[fact]`.
- **Streaming and partial output.** The agents widget streams tool activity and the first line of assistant text; the phase summary carries a truncated excerpt. Phase outputs themselves are all-or-nothing files; a phase that runs out of context is expected to write PARTIAL validation and route the rest (GUIDE §Context Budget) `[fact]`.
- **Queueing and follow-up.** Pi commands that inject prompts (`phase`, `skill`, `guide`, `vision`) send immediately when idle, else `deliverAs: "followUp"` (`tests/pi-parity-commands.test.mjs:182-194`). `/codecarto-next` refuses a second spawn of a running phase `[fact]`.
- **Compaction and summarization.** Only child sessions named `CodeCartographer phase: <id>` receive the phase-aware compaction prompt and write `scratch/checkpoints/<id>.md`; the next prompt lists an existing checkpoint as a required read (`tests/phase-compaction.test.mjs`; `tests/prompts-auto.test.mjs:93-100`). Compaction counts flow into usage, widget, summary, dashboard `[fact]`.
- **Persistence and resume.** `status.yaml` is the checkpoint; a new session on any surface opens it and continues. Completion re-validates under the lock so a stale PASS cannot complete a changed file. Broad-Side collect resumes from `state.json` `[fact]`.
- **Tool execution and validation.** Validation is a markdown parse, not a judgment; the gate refuses FAIL/MISSING and any of the seven handoff refusals listed under Complete `[fact]`.

## Security and Authorization

- **Authentication.** None on the framework's own surfaces: MCP trusts its stdio host; Pi trusts the local user. The only credential the framework handles is the OpenRouter key (parameter, env, or `broadside/config.yaml`); it is sent as `Authorization: Bearer` to `openrouter.ai` only and never logged or written by the framework, though `api_key` in the config file is committed if the user tracks it (`config.yaml` comment) `[fact]`.
- **Authorization / trust boundaries.** Every workflow tool requires an absolute `cwd` that exists; the server writes only under `<cwd>/.codecarto/`, the configured library, `~/.codecarto/config.yaml`, and `<cwd>/.codecarto-backup-*/`. `spec_path` reads are contained to the library and `<cwd>/.codecarto` after symlink resolution (`tests/publish-path-containment.test.mjs`; `tests/symlink-sandbox.test.mjs`). Phase ids and amendment slugs are restricted to `[A-Za-z0-9][A-Za-z0-9._-]*` so they cannot form paths (`tests/guards.test.mjs`). Pi's tool interception is the write sandbox for LLM-driven sessions; MCP has none, because the host LLM writes files itself `[fact]`. Routed to the semantic pass: symlink fallback for not-yet-existing targets (mech-CF2), an unvalidated relative `cwd` widening publish containment (mech-CF3).
- **Untrusted content.** Library metadata and specs are declared evidence, not instructions, in the synthesis prompt (`core/prompts.ts:220-221`); Broad-Side results are declared unverified leads everywhere they are rendered `[fact]`.
- **Secret management.** No storage, rotation, or expiry; `OPENROUTER_API_KEY` precedence is parameter → env → config. `[fact]`
- **Session lifecycle.** Pi phase sessions persist under `~/.pi/agent/sessions/` with the orchestrator as parent; nothing expires them `[fact]`.

## Configuration Model

Precedence, keys, and defaults are cataloged in `findings/config-model/config-model.md` §2026-09-11 (architecture) and §2026-09-11 (contracts). Contract-level summary `[fact]`: per-workspace `.codecarto/workflow/config.yaml` overrides user-global `~/.codecarto/config.yaml` (path overridable by `CODECARTO_USER_CONFIG_PATH`) overrides built-in defaults; Broad-Side has a separate per-repository `broadside/config.yaml` with no user-global layer; per-call parameters and slash flags beat both. Validation of malformed config is absent at every layer: a file that fails to parse is treated as absent `[hazard: mech 2.1, 2.4]`. There are no environment-specific overrides (dev/staging/prod) and no restart semantics: every read is fresh per call.

## Doc/Test Conflicts

| # | Documentation says | Code / tests say | Disposition |
|---|---|---|---|
| 1 | README §The dashboard: "Every state change re-renders `.codecarto/dashboard.html`". | `codecarto_switch_pipeline` on MCP does not render (`mcp-server/server.ts:316-341` has no `writeDashboard` call); Pi's `/codecarto-switch-pipeline` does (`index.ts:645`). `[fact]` | Surface parity gap; routed to the semantic pass (contracts-CF1). |
| 2 | README §The dashboard: "No JavaScript." | `core/dashboard.ts:628-666` embeds a search/filter/export script and a JSON data island; the repo's own CLAUDE.md states this. `[fact]` | Doc is wrong; routed (contracts-CF1). |
| 3 | MANUAL.md §Step 4 and §Troubleshooting: the LLM "updates `status.yaml` to mark the phase complete" and "appends a summary entry to THREAD_LOG.md"; §Multi-Session says parallel sessions "overwrite the first session's changes" and suggests hand-merging `status.yaml`. | GUIDE.md §Trust Boundaries forbids sessions writing `status.yaml`, closeouts, or THREAD_LOG; completion serializes with a lock (`core/workspace.ts:342-392`); `tests/pipeline-invariants.test.mjs` pins that no framework file instructs such writes. `[fact]` | MANUAL describes the pre-0.12 drop-in contract. In pure drop-in mode there is still no executable to apply a handoff, so the hand-edit path is the only one that exists there — the conflict is real for drop-in users. Routed (contracts-CF1). |
| 4 | MANUAL.md §Step 2: "Keep `workflow/pipeline-full-with-audit.yaml` (6 phases)" under the heading marked "(default)". | Default is `pipeline-full-with-deep-audit.yaml` (`core/pipeline.ts:25`; MANUAL's own first sentence in Step 2). `[fact]` | Stale doc line. |
| 5 | `docs/mcp-quickstart.md:147`: `mechanical-defects.md` covers "logic, security, concurrency, API bugs". | Mechanical = passes 1, 2, 6 (logic, error handling, config); security, concurrency, API are the semantic pass (`findings/defect-scan-mechanical/SKILL.md`). `[fact]` | Stale doc line. |
| 6 | `docs/mcp-quickstart.md:182`: `codecarto_next` "returns 'no eligible phase'" when complete. | Returns "All CodeCartographer phases are complete. Run codecarto_skill for post-pipeline work." (`server.ts:348`). `[fact]` | Doc wording drift. |
| 7 | MANUAL.md:188: "one of four evidence levels", then lists five. | Five levels everywhere else. | Typo. |
| 8 | README §Repository structure and MANUAL §Git: `.codecarto/.gitignore` excludes findings and the dashboard for users. | Not shipped in the npm tarball (mech 6.1); true only for checkout installs. `[fact]` | Doc/package conflict, already high in the mechanical scan. |
| 9 | `broadside/config.yaml` comment: `wait_seconds` "0 returns as soon as … the recorded state is read". | Collect with 0 uses the 25-minute default (mech 6.3). | Already a finding. |
| 10 | README §Pi extension features: dashboard "Activity timeline with session-file links". | Session files are absolute paths and `safeRelativeHref` refuses them (mech 1.14; `tests/dashboard.test.mjs` "absolute … session files are not rendered as unsafe links" pins the refusal). | Doc describes a link the renderer never produces. |
| 11 | `docs/client-surfaces.md`: Codex's preference between `content` and `structuredContent` is "unknown … not yet exercised". | Both fields carry the text since 0.14.1 (`tests/structured-payload.test.mjs`), so behavior is correct either way. | Honest unknown; registered as `q-codex-envelope-preference` for completeness. |

## Black-Box Acceptance List

| # | Scenario | Precondition | Action | Expected Outcome |
|---|----------|--------------|--------|------------------|
| 1 | Init default | Empty repo dir `R`, no `.codecarto/` | `codecarto_init {cwd: R}` | `.codecarto/` exists; `status.yaml` has `pipeline: workflow/pipeline-full-with-deep-audit.yaml`, `current_phase: architecture`, seven phases `pending`; `closeouts/` exists and is empty; `CONVENTIONS.md`, `DECISIONS.md`, `BACKLOG.md`, `THREAD_LOG.md` exist and contain no dated entries. |
| 2 | Init refuses overwrite | After #1 | `codecarto_init {cwd: R}` | Error code -32600, message contains "already exists" and "force: true"; nothing changed. |
| 3 | Init with force backs up | After #1 with a file `.codecarto/findings/x.md` | `codecarto_init {cwd: R, force: true, pipeline: "lite"}` | `.codecarto-backup-<ts>/findings/x.md` exists; new `.codecarto/` has three phases; response `pipelineLabel: lite`. |
| 4 | Relative cwd | any | `codecarto_status {cwd: "a/b"}` | -32602 with "absolute path". |
| 5 | Next prompt shape | After #1 | `codecarto_next` | Text begins "Read .codecarto/GUIDE.md and continue the CodeCartographer workflow for the phase `architecture`."; lists `.codecarto/templates/phase-handoff.yaml`; ends "Primary output target: .codecarto/findings/architecture/architecture-map.md"; `structuredContent.text` equals `content[0].text`. |
| 6 | Validate missing | After #1 | `codecarto_validate` | `overall: MISSING`, text contains "Missing primary output: .codecarto/findings/architecture/architecture-map.md". |
| 7 | Validate parses last block | Output file with two `## Validation` sections, first `**Overall:** FAIL`, last `**Overall:** PASS` | `codecarto_validate` | PASS. |
| 8 | Overall decoration | Output whose last line is `**Overall:** PASS (6/6)` | `codecarto_validate` | FAIL with "Validation overall result is FAIL." (pins mech 2.6 until fixed). |
| 9 | Complete without handoff | Passing output, no `scratch/handoffs/architecture.yaml` | `codecarto_complete` | -32602; message names `scratch/handoffs/architecture.yaml` and lists the arrays; `status.yaml` unchanged; no closeout. |
| 10 | Complete applies handoff | Passing output + handoff with one `open_questions` entry (no id), one `carry_forward` to `contracts`, one decision | `codecarto_complete` | `phases.architecture.status: complete`; question id matches `^oq-architecture-`; carry-forward present; `current_phase: defect-scan-mechanical`; `DECISIONS.md` gains a `D001 \|` row; closeout and one THREAD_LOG line exist; response has "Orchestrator checkpoint". |
| 11 | Complete is idempotent | After #10 | `codecarto_complete {phase: "architecture"}` | Succeeds; THREAD_LOG still has one architecture line; no duplicate decision row. |
| 12 | Bad carry-forward target | Handoff with `target_phase: architecture` | `codecarto_complete` | -32602 "not a downstream active pipeline phase"; status unchanged. |
| 13 | Closure gate D1 | Architecture complete with question `q1` and carry-forward `cf1` (`derives_from: q1`) to contracts; contracts output passing; contracts handoff closes `cf1` only | `codecarto_complete {phase: "contracts"}` | Refused; message names `cf1`, `q1`, and "verify at runtime"; contracts still pending. |
| 14 | Closure gate D3 | Scaffold ≥ 0.19.0; question of kind `needs-runtime-test`; handoff closes it as a bare id | `codecarto_complete` | Refused with "needs-runtime-test" and "runtime evidence"; with `{id, evidence: "spike.md"}` it completes. |
| 15 | Stale PASS | Validate PASS, then overwrite the output with no validation block, then complete | `codecarto_complete` | Refused: "no longer validates under the status lock (now FAIL)". |
| 16 | Findings pairing | Defect report row with Evidence Level `open question` and Action `fix before porting`; scaffold ≥ 0.17.1 | `codecarto_validate` | FAIL with the pairing message naming "verify at runtime". |
| 17 | Coverage gaps travel | Architecture complete with `Skipped scope: vendored/` | `codecarto_next` | Prompt contains "Upstream phases declared these coverage gaps" and "architecture (skipped scope): vendored/". |
| 18 | Skill gate | Mid-pipeline | `codecarto_skill {name: "spec-delta-application"}` | -32600 "pipeline is not complete". `codecarto_skill {name: "broadside"}` returns text containing "# Broad-Side" regardless. |
| 19 | Terminal actions | Single-phase pipeline completed with one open question and one post_pipeline item | `codecarto_status` | `Pipeline state: complete`; a line containing "1 open question(s) and 1 post-pipeline item(s)" naming both `codecarto_amend` and `/codecarto-amend`. |
| 20 | Amend | After #19, amendment closing both ids | `codecarto_amend` | Both closed; re-run reports both under "matched nothing"; THREAD_LOG has one `amendment:` line. Before completion the same call is refused with "pipeline is not complete". |
| 21 | Switch pipeline | After #10 | `codecarto_switch_pipeline {pipeline: "lite"}` | "Phases preserved (completed): architecture"; "Phases not in new pipeline: defect-scan-mechanical, …"; `status.yaml` shows `current_phase: architecture` (pins mech 1.3 until fixed); no dashboard rewrite on MCP. |
| 22 | Scaffold staleness | Workspace with `scaffold_version: 0.11.0` | `codecarto_status` | Text contains "Scaffold: … older than the running framework … codecarto_refresh_scaffold on MCP, /codecarto-refresh-scaffold on Pi". After `codecarto_refresh_scaffold`, the line is gone, `status.yaml` unchanged, THREAD_LOG has a `scaffold-refresh` line. |
| 23 | Publish idempotence | Library L with marker; spec S | `codecarto_publish` twice with S, then once with S' | v1 created; second call "Metadata-only update (content hash matched v1)"; third creates v2; `latest` reads `v2`; `index.yaml` lists versions `[1, 2]`. |
| 24 | Collision guard | Entry `tool` v1 recorded `https://github.com/acme/tool` | publish `tool` with `source_repo: https://github.com/other/tool` | Refused, message contains "Refusing to publish" and both repos; `git@github.com:acme/tool.git` instead is accepted as the same repo. |
| 25 | Confidentiality guard | Library `visibility: public` | publish with no `confidentiality` | Refused naming "internal" and "public"; `allow_confidentiality_mismatch: true` publishes and metadata still records no confidentiality. |
| 26 | publish_confirm gate | `~/.codecarto/config.yaml` has `library.publish_confirm: true` | `codecarto_publish` without `confirm` | -32600 beginning "Publish not performed"; preview names "v1 (first version of a new entry)"; nothing written; with `confirm: true` it publishes. Without the key in any config layer, no gate. |
| 27 | Broad-Side refuses over budget | `max_cost: 0.0001` in config, no `force` | `codecarto_broadside {action: "submit"}` | Error beginning "Estimated Broad-Side cost" with a per-lens breakdown; no run recorded. |
| 28 | Broad-Side key resolution | No key anywhere | `codecarto_broadside {action: "models"}` | Error naming `api_key`, `OPENROUTER_API_KEY`, and `broadside/config.yaml`; `action: "status"` succeeds with "No Broad-Side runs recorded". |
| 29 | Pi activation | Pi session in a repo with `.codecarto/` | `/codecarto-status` before init/open | Warning "not active in this session"; after `/codecarto-open`, the widget shows `Phase:` and `bash` tool calls are blocked. |
| 30 | Pi headless | `pi -p` session | `/codecarto-status` after `/codecarto-init lite` | stderr contains a line beginning `[codecarto] info: `; stdout carries no prose. |
| 31 | Pi auto stop on strict gaps | `/codecarto-next --auto --strict` with a phase that produces PASS WITH GAPS | run | Auto summary "stopped at `<phase>`" with the validation block and the strict recovery hint; the phase is not completed. |
| 32 | Digit-named repo | Repo directory `2048` | `codecarto_init` then `codecarto_status` | Currently: status fails with a TypeError message (pins mech 1.1 until fixed); expected after fix: `project_name: "2048"` round-trips. |

## Coverage and limits

- Inspected scope: docs — `README.md` (full), `MANUAL.md` (full), `docs/mcp-quickstart.md`, `docs/client-surfaces.md`, `docs/self-review-prompt.md`, `CHANGELOG.md` 0.19.0–0.19.5, the packaged guide overview, handoff-contract, and orchestration topics; tool descriptions and Pi command descriptions in source. Tests read in full: `mcp-server`, `pi-command-handlers`, `pi-parity-commands`, `framework-handoff`, `closure-integrity`, `self-scan-triage`, `pi-extension-activation`, `pi-publish`, `terminal-next-actions`, `scaffold-staleness`, `amendment`, `synthesis`, `pi-broadside`, `notify-fallback`, `init-workspace-isolation`, `prompts-auto`, `publish-path-containment`, `structured-payload`, `post-pipeline`, `open-questions` (partial); every other test file by test name. Source re-read for the SDK invalidation call sites and the dashboard call sites.
- Skipped scope: `docs/library-format.md` body (headings only; the protocols phase owns it under arch-CF1), `docs/ROADMAP.md`, `docs/synthesis-roadmap.md`, `docs/design-synthesis-phases.md`, `docs/build-week-2026.md`, `docs/brand-theme.md`, `docs/2026-05-02-framework-feedback-pass.md`, `CONTRIBUTING.md`, CHANGELOG entries older than 0.19.0; test bodies of `library`, `broadside`, `dashboard`, `yaml`, `usage`, `guide`, `findings-cross-check`, `orchestrator-promotion`, `orchestrator-config`, `agent-*`, `auto-*`, `child-model-runtime`, `phase-compaction`, `refresh-scaffold`, `resolve-phase`, `guards`, `next-flags`, `broadside-flags`, `broadside-scan-fixes`, `broadside-scout-pipeline`, `release-metadata`, `default-pipeline`, `doc-mention`, `symlink-sandbox`, `mcp-library` (beyond the header), `mcp-uncovered-handlers` (beyond the switch/usage block), `dashboard-on-complete`, `pipeline-invariants`. The synthesis pipeline's four phase prompts and the `spec-delta-application` skill were not contract-extracted beyond their preflight and gating (they are `.codecarto/` template content, out of scope by the run's definition). Broad-Side's per-lens prompt wording was not contract-extracted.
- Evidence basis: source inspection; tests (as executable contracts, cited by file and line or name); upstream findings (architecture map, mechanical scan); one read of the Pi SDK's compiled source (`node_modules/@earendil-works/pi-coding-agent@0.85.1`) for the ctx-invalidation contract. No runtime verification in this phase beyond what the mechanical scan already recorded.
- Known blind spots: (1) OpenRouter response shapes remain `[external]`; every Broad-Side "observable output" above is what the code renders from the parsed shape. (2) The Pi TUI rendering (widget text, theme colors) was read, not seen; the harness tests assert strings, not layout. (3) Which MCP clients read `structuredContent` versus `content` is documented as observed for Claude Code and Hermes only (`docs/client-surfaces.md`), unknown for Codex (`q-codex-envelope-preference`). (4) The drop-in surface's actual behavior depends entirely on the LLM following GUIDE.md; nothing executable was reviewed for it, so its contract is the GUIDE's text and the MANUAL's conflicting text (§Doc/Test Conflicts #3). (5) Library operations were contracted from `core/library.ts` and test names; the 60+ library tests were not read line by line.
- Coverage disposition: COMPLETE at the operation level for all 22 MCP tools and 20 Pi commands; PARTIAL for the synthesis pipeline's phase-level contracts and for Broad-Side prompt content, both inherited by later phases as declared here.

## Open Questions

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-codex-envelope-preference | needs-runtime-test | Which MCP result field does Codex surface to its model, `content[0].text` or `structuredContent`? `docs/client-surfaces.md:27` records it as unknown; both fields carry the text since 0.14.1, so no contract here depends on the answer, but the parity claim "any MCP-capable agent" rests on it. | Only observable by calling a prose tool through a running Codex; the SDK deserializing the field proves it parses it, not which it prefers. |

Closed this phase: **q-pi-ctx-invalidation** (see §High-Value Behaviors → Session replacement; evidence is the Pi SDK's own source, which the SKILL's definition of an external-behavior claim names as settling evidence).

## Carry-Forward

Mirrored in `scratch/handoffs/contracts.yaml`. Closed here: **arch-CF3**.

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| contracts-CF1 | defect-scan-semantic | Doc/code conflicts #1–#7 and #10 above are candidate pass-5 (API/documented-contract) findings: the MCP `switch_pipeline` dashboard gap (surface parity), the "No JavaScript" claim, MANUAL's status.yaml/THREAD_LOG hand-edit instructions and parallel-overwrite advice, the stale default-pipeline and mechanical-scope lines in MANUAL and the quickstart, the `codecarto_next` completion wording, and the dashboard session-link claim. | Classifying documented-versus-actual behavior as defects, with severity and action, is the semantic pass's pass-5 rubric. |
| contracts-CF2 | porting | Surface parity table (`findings/public-surfaces/public-surfaces.md` §2026-09-11 contracts): the deliberate divergences (Pi asks, MCP refuses; Pi executes `next`, MCP returns text; Pi derives publish inputs, MCP takes them; library list/reindex MCP-only; `phase`/`skill`/`guide`/`vision` inject on Pi) and the accidental ones (dashboard on switch; `~` handling and relative-path acceptance in library-init; config warning before activation). | Deciding which divergences a port preserves is a porting-synthesis judgment. |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | User-facing surfaces are split by surface type. | PASS | §Surfaces Covered (7 rows) and §Feature Contracts grouped as API/TUI workflow, library, background worker, TUI-only, storage formats. |
| 2 | Feature contracts record trigger, defaults, outputs, side effects, persisted state, error behavior, and recovery behavior. | PASS | 16 nine-field contract tables covering all 22 MCP tools and the 20 Pi commands (Pi deltas inline); TUI-only behaviors and storage formats in compact tables. |
| 3 | Security and authorization model is documented (if applicable). | PASS | §Security and Authorization: no auth, trust boundaries, containment, sandbox, untrusted content, secrets, sessions; two gaps routed to the semantic pass. |
| 4 | Contract ownership is mapped back to a layer or package. | PASS | Every contract table carries an **Owner** row naming core modules or the wrapper. |
| 5 | A black-box acceptance list is included. | PASS | §Black-Box Acceptance List, 32 scenarios with preconditions and expected outcomes (three pin current defects explicitly). |
| 6 | Findings are marked with evidence levels. | PASS | Bracketed markers throughout; test citations by file:line for executable contracts; `[hazard]` markers cross-reference mechanical findings. |
| 7 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits, all bullets filled; disposition COMPLETE/PARTIAL split stated. |

**Validated by:** 2026-09-11 (contracts, self-audit session 1, inline MCP host)
**Overall:** PASS
