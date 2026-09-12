# Configuration Model

Catalog-level detail accumulated across phases (`mode: append`).

## 2026-09-11 — architecture

All entries `observed fact` from source.

### Layered orchestrator/library config (`core/orchestrator-config.ts`)

Resolution order, highest first: per-workspace `.codecarto/workflow/config.yaml` → user-global `~/.codecarto/config.yaml` (path overridable by `CODECARTO_USER_CONFIG_PATH`) → built-in defaults. A missing file at either layer is skipped; a malformed file is silently dropped (`loadRawIfExists` returns null on parse error, `:103-110`).

| Key | Type | Default | Effect |
|---|---|---|---|
| `orchestrator.llm_steer_next_phase` | boolean | `false` | Pi: run the one-shot LLM rewriter before each phase; overridden per invocation by `--llm-steer` / `--no-llm-steer`. MCP: reported by `codecarto_config`, otherwise unused. |
| `library.path` | string | `null` | Library root; tilde-expanded and resolved absolute at load. Required by publish, library tools without `library_path`, and synthesis preflight. Also widens the Pi `edit`/`write` sandbox to include it. |
| `library.namespace` | string | `null` | Default namespace for namespaced libraries. |
| `library.publish_confirm` | boolean | `true` | Pi: show a confirm dialog before publish (always honored). MCP: refuse `codecarto_publish` without `confirm: true` **only when some config layer set the key** (`publish_confirm_configured`), so unconfigured hosts keep writing on call. |

`writeLibraryConfig(configPath, libraryPath, namespace, publishConfirm)` rewrites the `library:` block wholesale (dropping any unknown library keys), preserves other top-level keys, and creates parent directories (`:170-196`). Both library-init surfaces write to the **user-global** path, not the workspace.

### Broad-Side config (`.codecarto/broadside/config.yaml`, `core/broadside.ts:1756-1806`)

Per-repository only; no user-global layer. Malformed values fall back silently.

| Key | Type | Default | Notes |
|---|---|---|---|
| `model` | string | `google/gemini-3.7-flash:batch` | run default model |
| `api_key` | string | `""` | lowest-precedence key source (after MCP `api_key` param and `OPENROUTER_API_KEY`) |
| `default_lenses` | list of lens ids | all six | unknown ids dropped; empty list → all six |
| `lens_models` | map lens→model | `{}` | per-lens override; unknown lens keys dropped |
| `reasoning` | `false` / `true` / `{enabled, effort, max_tokens}` | `null` (→ per-lens cap of 25 % of `max_tokens`, min 512) | overrides every lens's reasoning field |
| `max_cost` | number > 0 | `0` (no limit) | pre-flight estimate guard |
| `pricing.input_per_m`, `pricing.output_per_m` | numbers (both required) | `null` | manual override; disables catalog capability checks |
| `incremental` | boolean | `false` | diff against previous run's HEAD |
| `retry_truncated` | boolean | `true` | one retry with doubled output cap |
| `include_synthesis` | boolean | `true` | |
| `include_triage` | boolean | `true` | |
| `wait_seconds` | number > 0 | `0` | poll budget; 0 returns immediately |

Precedence for run knobs: explicit tool parameter / slash flag → config.yaml → shipped default (`mcp-server/server.ts:1199-1208`; `index.ts:1175-1192`).

### Workspace pipeline selection (`workflow/status.yaml`)

`pipeline:` is a workspace-relative path; aliases (`PIPELINE_ALIASES`, `core/pipeline.ts:14-23`) resolve only at init/switch time. Default `workflow/pipeline-full-with-deep-audit.yaml`. Missing or nonexistent path throws from `getWorkspaceState`; the GUIDE tells the LLM not to guess.

### Scaffold version gating

`workflow/scaffold-version.yaml` `scaffold_version` vs `PACKAGE_VERSION`: equal → silent; older → warn; newer → warn "upgrade"; missing → warn "predates v0.12.11" (`core/workspace.ts:324-340`). Two validation/completion rules key on it: findings pairing gate ≥ 0.17.1 (`core/findings.ts:24`), runtime-evidence closure gate ≥ 0.19.0 (`core/completion.ts:308`). Below those versions the rule warns instead of refusing.

### Pipeline YAML schema knobs read by code

`phase_order`, `phases[].{id, purpose, skill_path, output_template, depends_on, primary_output, secondary_outputs[].{path,mode}, required_reads, completion_criteria, handoff_requirements, preflight[]}`, `workflow_name` (`evidence-backed-project-synthesis` switches prompt wording), `workflow_goal` (dashboard). `preflight` values: `requires-vision-input`, `requires-library`, `requires-confirmed-proposal` (`core/synthesis.ts:104-190`).

### Pi extension flags

`/codecarto-next`: `--auto`, `--strict` (requires `--auto`), `--llm-steer`, `--no-llm-steer`. `/codecarto-dashboard`: `--narrate`. `/codecarto-broadside`: action, lens ids, `--incremental`/`--no-incremental`, `--max-cost=N`, `--wait=S`, `--no-synthesis`, `--no-triage`, `--no-retry-truncated`, `--benchmarks`. `/codecarto-library-init`: `<path> [--namespace <n>]`.

### Environment

`OPENROUTER_API_KEY`, `CODECARTO_USER_CONFIG_PATH`. No other `process.env` reads outside those two sites.

## 2026-09-11 — contracts

Documentation-versus-code precedence notes (`observed fact`):

- `library.publish_confirm`: README says "MCP refuses a publish that lacks confirm: true" as if unconditional; the code gates only when some config layer set the key (`core/orchestrator-config.ts:44-48`, `mcp-server/server.ts:768-769`), and `codecarto_library_init` / `/codecarto-library-init` always set it (`writeLibraryConfig` default). Net effect for users who ran library-init: the README wording is true.
- `wait_seconds`: config comment says 0 returns immediately for submit and collect; true for submit only (mech 6.3).
- `max_cost`: README says submit "refuses when the estimate exceeds `max_cost`"; with the shipped config (key commented out) the limit is 0 = never (mech 6.2).
- Malformed config: no layer reports a parse failure; `codecarto_config` shows the defaults as if configured (mech 2.4).
- `CODECARTO_USER_CONFIG_PATH` is undocumented outside source and tests.
- Every config read is per call; there is no restart requirement anywhere.

## 2026-09-11 — protocols

Configuration propagation as a protocol (`observed fact`):

- Every read is per call (`loadCodecartoConfig` in each handler / command; `loadBroadsideConfig` per Broad-Side call). No caching, no restart semantics, no hot-reload distinction.
- Layer merge is key-by-key for the three library keys and the one orchestrator key only; unknown keys are ignored and **dropped on rewrite** by `writeLibraryConfig` (which rebuilds `library:` wholesale and spreads the other top-level keys through).
- Validation on invalid input: type checks only (`typeof boolean`, non-empty string); a value of the wrong type is silently replaced by the default; a file that fails to parse is silently treated as absent at every layer (mech 2.1, 2.4).
- `library.path` crosses the boundary already tilde-expanded and `resolve()`d against the process cwd (mech 6.4); the MCP `publish` gate and `codecarto_config` read the same merged object so they cannot disagree.
- Broad-Side run knobs cross three layers (call → config → constant) with `??` semantics, except numeric `wait_seconds`/`max_cost` which use `> 0 ? … : config` and so cannot carry zero from the call (mech 6.12).

## 2026-09-11 — porting

Config decisions for the port (`strong inference`): a parse failure at any layer is reported, never treated as absent (D-H10, D-M8); relative paths resolve against the config file's directory or are refused (D-M12); per-call numeric knobs can carry an explicit zero (D-H8, low 6.12); Broad-Side ships a non-zero default `max_cost` (D-H9); `library-init` writes only what was asked or documents that it enables the confirm gate (D-M15); one constants module for operational timeouts (low 6.10).
