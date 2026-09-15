# Configuration Model

> Secondary output (mode: append). Owns the catalog-level configuration and environment
> inventory. The architecture map owns the summary. Add a dated section per phase.

## 2026-09-14 — architecture phase

CodeCartographer has **three independent configuration systems**: the orchestrator/library
config (two layers), the Broad-Side run config, and the pipeline definitions themselves.
They do not share a loader.

### 1. Orchestrator + library config (`core/orchestrator-config.ts`)

Two layers, resolved **per-workspace over user-global over built-in defaults**:

| Layer | Path | Notes |
|---|---|---|
| User-global | `~/.codecarto/config.yaml` (overridable via `CODECARTO_USER_CONFIG_PATH`) | Shared across all workspaces on the machine |
| Per-workspace | `.codecarto/workflow/config.yaml` | Overrides individual keys |

```yaml
orchestrator:
  llm_steer_next_phase: false   # boolean; opt-in LLM prompt rewriting
library:
  path: /abs/path               # string; must be absolute or start with ~ (tilde-expanded)
  namespace: my-namespace       # string; required for namespaced libraries
  publish_confirm: true         # boolean; MCP gates publish on confirm:true only when this key was configured
```

Behavior (`observed fact`):
- A missing file at either layer falls back to defaults.
- A file that exists but is unusable (unparseable YAML, non-mapping root, wrong key type,
  relative `library.path`) is dropped **at the granularity of the fault** and the fault is
  recorded in `problems` (path + message) so tools can name the file/key.
- The loader never throws; `publish` and the library tools refuse while `problems` is non-empty.
- `library.path` is tilde-expanded and made absolute; a relative value is refused because it
  would resolve against the launch directory.
- `writeLibraryConfig` (used by library-init) rewrites only `library.path` and optional
  `library.namespace`, preserving every other key — notably it does not set `publish_confirm`.
- Defaults: `llm_steer_next_phase: false`; `library.path: null`; `library.namespace: null`;
  `publish_confirm: true`, `publish_confirm_configured: false`.

### 2. Broad-Side config (`core/broadside/state.ts`, `core/broadside/constants.ts`)

Per-repo file at `.codecarto/broadside/config.yaml`. An **absent** file yields defaults; a file
that exists but cannot be parsed throws `BroadsideConfigError` and refuses every action that
would act on it (`status` reports and continues) — a typo must not silently remove a spend cap
or lens routing.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | `google/gemini-3.7-flash:batch` | Default batch model |
| `api_key` | string | `""` | OpenRouter key (tracked file — stated risk) |
| `default_lenses` | string[] | all six | Lenses to run when none specified |
| `max_cost` | number | `1` | Approximate run limit USD; `0` = no limit |
| `pricing` | `{input_per_m, output_per_m}` | null | Manual override when both set |
| `lens_models` | map lens→model | `{}` | Per-lens model overrides |
| `reasoning` | `false`\|`true`\|`{enabled?,effort?,max_tokens?}` | null | OpenRouter reasoning control; setting both `effort` and `max_tokens` is refused |
| `incremental` | boolean | `false` | Diff against previous run's HEAD |
| `retry_truncated` | boolean | `true` | Re-submit truncated slices once |
| `include_synthesis` | boolean | `true` | Run the cross-lens synthesis pass |
| `include_triage` | boolean | `true` | Run the triage work-order pass |
| `wait_seconds` | number | `0` | Default poll budget |
| `redact_secrets` | boolean | `true` | Redact/skip secret material before upload |

Every per-call tool/parameter overrides its config key; each config key overrides the shipped
default (`observed fact`: `handleBroadside`). An unknown `lens_models` id is dropped, not
carried. Resolution order for a run knob: explicit parameter → `config.yaml` → built-in default.

Built-in Broad-Side constants (`core/broadside/constants.ts`):
`BROADSIDE_BATCH_URL`, `BROADSIDE_MODELS_URL`, `BROADSIDE_BENCHMARKS_URL`,
`BROADSIDE_INPUT_PRICE_PER_M = 0.375`, `BROADSIDE_OUTPUT_PRICE_PER_M = 1.875`,
`BROADSIDE_POLL_INTERVAL_MS = 15_000`, `BROADSIDE_DEFAULT_POLL_BUDGET_MS = 25*60*1000`,
`BROADSIDE_DEFAULT_MAX_COST = 1`, `BROADSIDE_CATALOG_CACHE_TTL_MS = 24h`, lens ids,
state file names, `BROADSIDE_STATE_SCHEMA_VERSION = 1`.

### 3. Pipeline definitions (`.codecarto/workflow/pipeline*.yaml`)

The pipeline file selected by `status.yaml`'s `pipeline:` field is the phase contract. Variants
(`observed fact`: `.codecarto/workflow/`): `pipeline-full-with-deep-audit.yaml` (default, 7
phases), `pipeline-scout-first.yaml` (8), `pipeline-full-with-audit.yaml` (6),
`pipeline.yaml` (5), `pipeline-defect-scan.yaml` (2), `pipeline-lite.yaml` (3),
`pipeline-architecture-only.yaml` (1), `pipeline-synthesis.yaml` (4). Aliases live in
`core/pipeline.ts` `PIPELINE_ALIASES`; `DEFAULT_PIPELINE_PATH` =
`workflow/pipeline-full-with-deep-audit.yaml`.

Each phase declares: `id`, `purpose`, `skill_path`, `output_template`, `depends_on`,
`primary_output`, `secondary_outputs[]`, `required_reads[]`, `completion_criteria[]`,
`handoff_requirements[]`, and optional `preflight[]`
(`requires-vision-input`, `requires-library`, `requires-confirmed-proposal`).

### 4. Environment variables

| Variable | Where | Effect |
|---|---|---|
| `OPENROUTER_API_KEY` | Pi process / MCP server process | Broad-Side key (preferred over config; passed over an explicit `api_key` argument) |
| `CODECARTO_USER_CONFIG_PATH` | tests/tooling | Overrides the user-global config path |
| `HOME` (`homedir()`) | all | `~` expansion, config path, Pi session dir |

### 5. Precedence and validation rules of note

- Orchestrator/library: workspace > user-global > defaults; faults dropped per-key and reported.
- Broad-Side: call parameter > config.yaml > shipped default.
- `library.publish_confirm` gate on MCP applies only when a config layer actually set the key
  (`publish_confirm_configured`), so unconfigured hosts keep prior behavior.
- Pipeline `preflight` checks run before a phase prompt is emitted: `requires-vision-input`
  (non-empty vision beyond comments), `requires-library` (configured, marked, non-empty),
  `requires-confirmed-proposal` (at least one `[x]` row resolving to a real library version).
- The Strategic Alignment Hook (language-agnostic vs opinionated spec) is **not** a config key;
  it is an interactive prompt, auto-defaulted under `--auto`/`unattended` and recorded as
  `selection: auto-default` in the spec.

## 2026-09-15 — contracts phase

User-visible configuration contracts confirmed while extracting the feature contracts
(`findings/contracts/behavioral-contracts.md` §Configuration Model). No new keys; the load/error
semantics are the contract:

- **Orchestrator/library loader never throws.** A missing file falls back to defaults; a file with a
  fault (unparseable YAML, non-mapping root, wrong key type, relative `library.path`) is dropped at
  the granularity of the fault and reported in `problems`. `codecarto_config` / `/codecarto-config`
  render every problem; `codecarto_publish` and the library tools (list/reindex/init) **refuse**
  while `problems` is non-empty. `observed fact`: `core/orchestrator-config.ts`, `mcp-server/server.ts`
  `refuseOnConfigProblems`.
- **`library.publish_confirm` gate is opt-in by presence.** The default is `true`, but the MCP
  confirm gate applies only when a config layer actually set the key
  (`publish_confirm_configured`); `library-init` deliberately does not set it. `observed fact`.
- **Broad-Side config fails loud.** An absent `broadside/config.yaml` yields defaults; a present,
  unparseable one throws `BroadsideConfigError` and refuses every action except `status` (which
  answers with a warning). `reasoning.effort` + `reasoning.max_tokens` together is refused at load.
  Per-call parameter > config key > shipped default. `observed fact`.
- **Precedence is per-call where a call exists.** Orchestrator/library is workspace > user-global >
  default; Broad-Side is parameter > config > default; Pi's `--llm-steer`/`--no-llm-steer` overrides
  `orchestrator.llm_steer_next_phase` per invocation, and `--incremental`/`--no-incremental` overrides
  the Broad-Side config's `incremental` (tri-state: absent defers). `observed fact`.

No configuration contract in this phase lands on a Windows/network behavior; the config files are
read with the same `atomicWriteFile` path where written (library-init's user-global write is a
plain `writeFile`), so durability inherits `q-node-windows-fs-semantics` where applicable
(see `findings/state-and-storage/state-and-storage.md` §2026-09-15).

## 2026-09-15 — protocols phase

Configuration as a **propagation protocol** (`findings/protocols/protocols-and-state.md` §P15):
three independent systems that do not share a loader, each with its own precedence and failure
posture. All `observed fact` from `core/orchestrator-config.ts`, `core/broadside/state.ts`, and
`core/pipeline.ts`.

| System | Files | Resolution order | Invalid input | Hot reload? |
|---|---|---|---|---|
| Orchestrator/library | `~/.codecarto/config.yaml` (or `CODECARTO_USER_CONFIG_PATH`), then `.codecarto/workflow/config.yaml` | workspace key > user-global key > default | Fault dropped **per key**, recorded in `problems`; loader never throws; publish + library tools refuse while `problems` non-empty | Re-read on each operation; no restart needed |
| Broad-Side | `.codecarto/broadside/config.yaml` | per-call parameter > config key > shipped default | Absent file → defaults; present-but-unparseable → `BroadsideConfigError`, refuses every action except `status`; `reasoning.effort`+`max_tokens` together refused at load; a malformed boolean/number silently falls back | Re-read per call |
| Pipeline | `workflow/pipeline*.yaml` (path named by `status.yaml`) | the named file is the contract; aliases in `PIPELINE_ALIASES` | Unknown alias/path → `InvalidRequest`/`Pipeline not found`; malformed YAML → parse throw | Re-read per operation; `switch_pipeline` rewrites the pointer |

- **Pi flag overrides are per-invocation:** `--llm-steer`/`--no-llm-steer` overrides
  `orchestrator.llm_steer_next_phase`; `--incremental`/`--no-incremental` overrides the Broad-Side
  config's `incremental` (tri-state: absent defers).
- **`library.publish_confirm` is opt-in by presence:** the loader default is `true` but
  `publish_confirm_configured` is `false` unless a layer set the key, and only that drives the MCP
  confirm gate; `library-init` deliberately rewrites only `library.path`/`namespace` and leaves
  `publish_confirm` alone.
- **`library.path`** is tilde-expanded and must be absolute; a relative value is a recorded
  problem (not a silent default), because it would otherwise resolve against the launch directory.
- **`CODECARTO_USER_CONFIG_PATH`** relocates the user-global layer; `HOME` drives the default; the
  Broad-Side key chain is `OPENROUTER_API_KEY` > explicit `api_key` argument (MCP only) >
  `broadside/config.yaml` (Pi takes no key argument).

No config propagation claim lands on a Windows/network behavior, so this addendum carries no new
`verify at runtime` hedge beyond the existing config-file read/write durability one.

## 2026-09-15 — porting phase

Port-oriented companion to `findings/porting/reverse-engineering-bundle.md`. The porting phase
re-confirmed one config defect by source read and fixed two precedence decisions.

### Config defect carried into the port (fix before porting)

- `writeLibraryConfig` (`core/orchestrator-config.ts:250-289`) reads the shared user-global config,
  merges `library.path`/`namespace`, and plain-`writeFile`s the whole file with **no lock and no
  atomic write** (semantic 3.7). The file is read by every workspace on the machine, so a crash
  mid-write truncates it and two concurrent `library_init` calls lose one update. Port design:
  lock + atomic replace for any shared-config mutation (CONVENTIONS C05).

### Port decisions

- **Keep the three independent config systems** (two-layer orchestrator/library, Broad-Side, and
  pipeline definitions) rather than unifying them: their failure modes are deliberately different
  (per-key fault isolation with `problems` refusal vs. a present-but-unparseable Broad-Side file
  throwing and refusing spend). A unified loader would erase the spend-safety contract.
- **Precedence is part of the port's contract:** workspace > user-global > defaults, per key;
  per-call parameter > config key > shipped default; Pi flag override wins per invocation.
- The hand-rolled YAML dialect used by every config file is a wire-format constraint (see the
  bundle's §YAML Codec Decision).
