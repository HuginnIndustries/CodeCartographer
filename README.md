# CodeCartographer

[![CI](https://github.com/HuginnIndustries/CodeCartographer/actions/workflows/ci.yml/badge.svg)](https://github.com/HuginnIndustries/CodeCartographer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/codecartographer-pi.svg)](https://www.npmjs.com/package/codecartographer-pi)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

> **A structured pipeline for reverse-engineering unfamiliar codebases with an LLM.** Drop it into any repo, point an LLM at the guide, and walk away with a layered analysis: architecture map, behavioral contracts, protocol documentation, defect report, porting bundle, and a language-agnostic reimplementation spec. Every finding is evidence-tagged. Every phase output is validated before the next one starts.

```text
●  CodeCartographer
├─ ✓  architecture phase    ⟳ 25 · 76 tool uses · 1.0M tokens · 4m28s
├─ ✓  defect-scan-mech.     ⟳ 39 · 91 tool uses · 2.4M tokens · 7m05s
└─ ⠹  contracts phase       ⟳ 11 · 37 tool uses · 335.1k tokens · 40.1s
       ⎿ extracting behavioral contracts from server/index.ts…
```

---

## At a glance

| What you get | Where it lives |
|---|---|
| **Layered analysis pipeline** — architecture → defect scan → behavioral contracts → protocols → porting → reimplementation spec | `.codecarto/` template |
| **Validation gates between phases** — no advancing past a `FAIL` output | `core/` state machine |
| **Three delivery surfaces** — Pi extension, MCP server, or pure template | All three share `core/` |
| **Live progress widget** while phase sub-agents work | Pi extension |
| **HTML dashboard** — single-file aggregate of progress, links, usage, narrative | `.codecarto/dashboard.html` |
| **Per-phase token tracking** | `/codecarto-usage` |
| **Opt-in LLM steering** of the next phase's seed prompt | `/codecarto-next --llm-steer` |

---

## Install

Pick the surface that matches your tooling. All three share the same `core/` and produce byte-identical phase prompts.

### Pi extension (recommended for interactive use)

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) is a TUI coding agent. The CodeCartographer extension adds slash commands, a live agents widget, and the dashboard.

```bash
pi install npm:codecartographer-pi          # from the npm registry
pi install /absolute/path/to/CodeCartographer  # from a local checkout
pi install git:github.com/your-user/CodeCartographer  # from a git URL
```

> **Don't** run `npm install codecartographer-pi` for the Pi use case. Plain `npm install` puts the package on disk but doesn't register it with Pi. Use `pi install npm:...` so Pi writes the package into its own `~/.pi/agent/settings.json`.

For extension development, point Pi directly at the entrypoint:

```bash
pi -e /absolute/path/to/CodeCartographer/extensions/codecarto/index.ts
```

### MCP server (for Claude Code, Claude Desktop, any MCP host)

```bash
npm install --global codecartographer-pi
```

Add to your host config (`~/.config/claude-code/config.json`, `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "codecartographer": {
      "command": "codecarto-mcp"
    }
  }
}
```

### Pure template (no runtime, any LLM that reads/writes files)

```bash
cp -r /path/to/CodeCartographer/.codecarto /path/to/your-repo/
```

Then in the LLM session: `Read .codecarto/GUIDE.md and begin the analysis.`

---

## How it works

The "code" is structured Markdown + YAML inside `.codecarto/`:

- **`GUIDE.md`** — LLM entry point. Every session reads this first.
- **`workflow/pipeline.yaml`** — phase definitions, dependencies, output paths.
- **`workflow/status.yaml`** — mutable per-project state. Single source of truth for progress.
- **`workflow/VALIDATE.md`** — validation protocol run after every phase.
- **`findings/<phase>/SKILL.md`** — detailed analysis instructions per phase.
- **`templates/`** — output templates that enforce consistent structure.

Phases form a DAG: `contracts` and `protocols` can run in parallel after `architecture`; `porting` waits for both; `reimplementation-spec` is last. The host (Pi, MCP, or your shell) reads the active pipeline, finds the next phase whose dependencies are all `complete`, hands the LLM that phase's instructions, validates the output, and advances `status.yaml`.

For multi-session work, every new session reads `.codecarto/GUIDE.md` (or the lighter `NEW_THREAD_BLURB.md`), checks `workflow/status.yaml`, and picks up where the last session left off. You don't explain what happened in previous sessions.

---

## Phases produce these artifacts

| Artifact | Description |
|---|---|
| **Architecture map** | Layers, dependency direction, public surfaces, runtime lifecycle, concurrency model |
| **Defect report** | Multi-pass scan for logic errors, security issues, concurrency bugs, API violations |
| **Defect fix tracker** | Remediation log mapping each fix, deferral, or acceptance back to the defect report |
| **Behavioral contracts** | Feature-by-feature behavior with defaults, error handling, and acceptance tests |
| **Protocols and state** | Event flows, state machines, persistence formats, compatibility hazards |
| **Porting bundle** | Everything synthesized into a porting-oriented view with priority rankings |
| **Reimplementation spec** | Language-agnostic build plan with modules, acceptance scenarios, and known unknowns |

Every finding is tagged with an evidence level: `observed fact`, `strong inference`, `portability hazard`, or `open question`. Every phase output is validated against explicit completion criteria before the pipeline advances.

---

## Pipeline variants

The default is a 7-phase run that splits the defect scan into a mechanical early pass and a semantic late pass — the reimplementation phase then designs around defects with full contracts and protocols context. Scale back if you want less:

| Variant | Phases | Use when |
|---|---|---|
| **Full with deep audit** (default) | 7 | Complete analysis with split defect scan; reimplementation grounded in contracts/protocols-aware defect findings |
| **Full with audit** | 6 | Single early defect scan; cheaper than the deep variant when defects are mostly mechanical |
| **Full** | 5 | Porting or reimplementation without any defect scan |
| **Defect scan** | 2 | Maintenance audit to surface latent problems |
| **Lite** | 3 | You need to understand behavior without porting plans |
| **Architecture only** | 1 | Quick structural overview |

Set the active pipeline by editing `workflow/status.yaml`'s `pipeline:` field, or pass it as the argument to `/codecarto-init`.

**On disk:**

| Variant | Pipeline file |
|---|---|
| Full with deep audit (**default**) | `workflow/pipeline-full-with-deep-audit.yaml` |
| Full with audit | `workflow/pipeline-full-with-audit.yaml` |
| Full | `workflow/pipeline.yaml` |
| Defect scan | `workflow/pipeline-defect-scan.yaml` |
| Lite | `workflow/pipeline-lite.yaml` |
| Architecture only | `workflow/pipeline-architecture-only.yaml` |

---

## The dashboard

Every state change re-renders `.codecarto/dashboard.html` — a self-contained single-file artifact you open in any browser. Aggregates everything a human wants to see at a glance:

- Pipeline progress strip with per-phase status badges
- Per-phase cards with output links, open questions, carry-forward routing, owner notes, last-run usage
- Aggregate token usage panel + per-phase breakdown
- Activity timeline with session-file links
- Open questions roll-up grouped by source phase
- Closeouts list (reverse-chronological) with relative-path links

No JavaScript. No external assets. Light/dark via `prefers-color-scheme`. Works opened directly from `file://`.

**Opt-in narrative summary.** `/codecarto-dashboard --narrate` runs the orchestrator's model as a one-shot session that writes a 200–400 word executive summary citing specific findings from recent closeouts. Cached to `.codecarto/.dashboard-narration.local.md` and preserved across deterministic re-renders with a "(N runs since)" staleness note.

---

## Pi extension features

Beyond the slash commands, the Pi extension layers on:

**Phase sub-agents.** `/codecarto-next` spawns each phase as an isolated `AgentSession`. Tool calls, file reads, and reasoning live in the child's own context window — they never accumulate in the orchestrator. Your TUI stays on the orchestrator session and remains responsive while phases work in background.

**Live agents widget** above the editor showing tool count, token usage, elapsed time, and current activity.

```text
●  CodeCartographer
└─ ⠹  architecture phase  ⟳ 3 · 5 tool uses · 12.3k tokens · 1m32s
       ⎿ reading…
```

**File-backed phase sessions.** Phase transcripts persist to the same Pi session directory the orchestrator uses, so `/resume`, `/tree`, and `/export` browse them as first-class sessions. Each appears as `CodeCartographer phase: <id>` with lineage back to the orchestrator's session.

**Phase-completion summary in the orchestrator transcript.** When a phase finishes, a Markdown closeout block is appended to the orchestrator's session via `pi.sendMessage(...)`. Visible in the TUI scrollback; available to the orchestrator's LLM as context on your next message. No auto-trigger — you stay in control.

**Opt-in LLM-steered seed prompts.** Set `orchestrator.llm_steer_next_phase: true` in `.codecarto/workflow/config.yaml` (or pass `--llm-steer` per invocation), and the orchestrator's LLM rewrites the next phase's seed prompt to highlight relevant prior findings. Off by default — extra orchestrator-side tokens, opt-in. The rewritten prompt is injected into the orchestrator transcript so you can audit what the rewriter chose to emphasize.

**Per-phase usage tracking.** Each phase run is appended to `.codecarto/workflow/.usage.local.yaml`. `/codecarto-usage` reports cumulative + per-phase totals.

**Tool interception.** `bash` is blocked outright; `edit` and `write` are confined to `.codecarto/`. Same rules apply to phase sub-agents.

### Slash commands

| Command | Purpose |
|---|---|
| `/codecarto-init [variant]` | Copy `.codecarto/` into the current repository, select pipeline variant |
| `/codecarto-status` | Current phase, progress, open questions |
| `/codecarto-next [--auto [--strict]] [--llm-steer \| --no-llm-steer]` | Spawn the next eligible phase as a sub-agent. `--auto` walks the full pipeline end-to-end (auto-validate + auto-complete + advance); `--strict` flips the `PASS WITH GAPS` rule from "advance" to "pause". |
| `/codecarto-phase <id>` | Force a specific phase, even out of pipeline order |
| `/codecarto-validate [phase]` | Validate a phase output against completion criteria |
| `/codecarto-complete [phase]` | Atomically mark a phase complete (validation must pass) |
| `/codecarto-skill <name>` | Run a post-pipeline skill once all phases are complete |
| `/codecarto-usage` | Cumulative + per-phase token usage |
| `/codecarto-dashboard [--narrate]` | Regenerate `.codecarto/dashboard.html`; `--narrate` for the LLM executive summary |

### End-to-end auto mode (0.8.0+)

`/codecarto-next --auto` walks the entire pipeline without intervention. The loop spawns each next-eligible phase, auto-validates the output, auto-marks it complete, and advances until the pipeline finishes — or until something stops it (`FAIL` / `MISSING` validation, sub-agent error, or `ctx.signal` abort). The orchestrator's TUI stays responsive throughout; per-phase summaries land in the transcript as usual, and a final `codecarto-auto-summary` block reports the outcome with cumulative tokens, wall time, and a recovery hint if the run stopped early.

- **Resumability** is implicit: re-running `--auto` reads `status.yaml` and picks up from `getNextEligiblePhase`.
- **`--strict`** (requires `--auto`) treats `PASS WITH GAPS` as a stop — useful when you want to triage gaps before advancing.
- **`--auto --llm-steer`** runs the rewriter on every phase transition; the per-phase steering blocks land in the orchestrator transcript so the run is auditable.

### Version history (Pi orchestration)

The current parallel-sub-agent design landed in 0.2.0 and has been incrementally enriched: file-backed sessions (0.3.0), summary injection (0.4.0), opt-in LLM steering (0.5.0), usage tracking (0.6.0), HTML dashboard (0.7.0), and end-to-end auto mode (0.8.0). 0.1.x workspaces don't need migration — existing `.codecarto/` directories work unchanged. See `CHANGELOG.md` for details.

---

## MCP server

The same framework is packaged as a [Model Context Protocol](https://modelcontextprotocol.io) server. The MCP path returns prompt text for the host to dispatch and never runs sub-agents itself, so the Pi-only orchestration features (sub-agents, live widget, dashboard, usage tracking) don't apply — but phase prompts and validation are byte-identical with the Pi path because both import the same `core/`.

Implements MCP spec revision [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25) via `@modelcontextprotocol/sdk` ≥ 1.29.0. The negotiated `protocolVersion` reflects whatever the connecting client requests; the server accepts every revision the SDK supports (currently `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`).

| Tool | Pi equivalent |
|---|---|
| `codecarto_init` | `/codecarto-init` |
| `codecarto_status` | `/codecarto-status` |
| `codecarto_next` | `/codecarto-next` |
| `codecarto_phase` | `/codecarto-phase` |
| `codecarto_validate` | `/codecarto-validate` |
| `codecarto_complete` | `/codecarto-complete` |
| `codecarto_skill` | `/codecarto-skill` |

Each tool accepts an absolute `cwd` for the target repository. `codecarto_init` requires `force: true` to overwrite an existing `.codecarto/` (instead of Pi's interactive confirmation).

---

## Compatible environments

| Environment | Notes |
|---|---|
| **Pi** | Native — install the extension, get slash commands + widget + dashboard. |
| **Claude Code** | MCP server, or point it at `.codecarto/GUIDE.md` directly. |
| **Claude Desktop** | MCP server. |
| **OpenCode / Aider / Cursor / Windsurf / IDE copilots** | Open the repo, point the LLM at `.codecarto/GUIDE.md`. |
| **Claude.ai / ChatGPT (web chat)** | Paste file contents manually. Tedious for multi-phase runs. |
| **API-based agents** | Load files programmatically, pass to the model, write outputs back. |

---

## Token usage and cost

CodeCartographer is token-intensive — it reads source code multiple times across phases and produces thousands of words of structured output. Plan accordingly.

### Template overhead (fixed cost)

Every session reads the guide, pipeline definition, status, and validation protocol. Each phase additionally reads its own `SKILL.md` and output template. Fixed regardless of codebase size:

| Component | Tokens (input) |
|---|---|
| Per-session base (GUIDE + pipeline + status + VALIDATE) | ~2,600 |
| Architecture phase instructions | ~1,500 |
| Defect scan phase instructions (includes 6 pass files) | ~5,000 |
| Contracts phase instructions | ~1,500 |
| Protocols phase instructions | ~1,200 |
| Porting phase instructions | ~1,200 |
| Reimplementation spec phase instructions | ~1,100 |
| **Total template overhead, 6-phase run** | **~27,000** |
| **Total template overhead, 7-phase deep-audit** | **~32,000** (split defect scan adds one more SKILL load) |

### Source code reading (variable cost)

The dominant cost. Each phase reads some or all of your source code; the architecture phase reads the most. Rough guide: **expect 1–3× your codebase size in tokens per phase**. A 50k-token codebase might consume 100–200k input tokens across a full pipeline run.

### Output generation

From a real 6-phase run (CodeCartographer analyzing itself — a small ~14k-word template):

| Phase | Output size |
|---|---|
| Architecture map | ~3,100 tokens |
| Defect report | ~2,400 tokens |
| Behavioral contracts | ~4,500 tokens |
| Protocols and state | ~3,900 tokens |
| Porting bundle | ~3,400 tokens |
| Reimplementation spec | ~4,400 tokens |
| **Total output** | **~21,800 tokens** |

Larger codebases produce proportionally larger outputs.

### Cost estimates

For a medium-sized codebase (~100k tokens of source):

| Pipeline | Estimated input | Estimated output | Total |
|---|---|---|---|
| Architecture only | ~130k | ~5k | ~135k tokens |
| Defect scan (2-phase) | ~260k | ~10k | ~270k tokens |
| Lite (3-phase) | ~370k | ~15k | ~385k tokens |
| Full (5-phase) | ~570k | ~22k | ~592k tokens |
| Full with audit (6-phase) | ~700k | ~27k | ~727k tokens |
| Full with deep audit (7-phase, default) | ~830k | ~32k | ~862k tokens |

At current API pricing (~$3/M input, ~$15/M output for Claude Sonnet), a full 5-phase run on a 100k-token codebase costs roughly **$2–4**. Larger codebases scale linearly.

### Tips to reduce token usage

- **Start with `architecture-only`** to see if the output quality is useful before committing to a full run.
- **One LLM session per phase** — each phase gets a fresh context window so you're not paying to carry stale context.
- **For very large codebases** (500k+ tokens of source), the LLM can't read everything anyway. It uses the architecture map to prioritize and produces partial results. `open_questions` in `status.yaml` shows what was skipped.
- **The `lite` pipeline (3 phases) gives 80% of the value** for understanding a codebase without porting-specific phases.
- **Skip `--llm-steer`** unless you're hitting cross-phase coherence issues — the rewriter costs orchestrator-side tokens per phase.

---

## Model compatibility

LLM-agnostic by design, but model choice affects both what you can analyze and how good the results are. Two independent constraints: **context window size** and **model capability**.

### Context window

Each phase runs in its own session, so the context window limits how much source code can be read per phase — not across the whole pipeline. After template overhead, prior-phase findings, and output generation:

| Phase | Available for source (128k model) | Available (200k model) |
|---|---|---|
| Architecture | ~121k | ~193k |
| Defect scan | ~115k | ~187k |
| Contracts | ~114k | ~186k |
| Protocols | ~115k | ~187k |
| Porting | ~104k | ~176k |
| Reimplementation spec | ~103k | ~175k |

Practical limits by codebase size:

| Codebase | 128k context | 200k context |
|---|---|---|
| <30k tokens | All phases comfortable | All phases comfortable |
| 30–60k tokens | Feasible, some `PARTIAL` results | Comfortable |
| 60–100k tokens | Marginal — heavy `PARTIAL` use | Feasible with prioritization |
| >100k tokens | Not viable | Feasible, later phases may `PARTIAL` |

The pipeline handles context exhaustion gracefully: phases write `PARTIAL` validation and log remaining work in `open_questions`.

### Model capability

The harder constraint. Tasks that degrade fastest on weaker models:

1. **Evidence classification** (high risk) — distinguishing `observed fact` from `strong inference` from `open question` requires calibrated self-awareness about certainty. Weaker models over-classify inferences as facts and skip `open question` tagging.
2. **Defect scan** (high risk) — the multi-pass scan demands domain-specific reasoning (concurrency, security, API contracts). Weaker models produce more false positives, miss subtle bugs, and over-report style issues as defects.
3. **Architecture synthesis** (medium-high risk) — abstracting a coherent layer map from many files is high-order reasoning.
4. **Structured output adherence** (medium risk) — filling templates correctly with all required sections and consistent formatting.
5. **Cross-phase coherence** (medium risk) — later phases build on earlier findings. Weak architecture compounds errors downstream.

### Recommended model tiers

| Tier | Examples | Recommended pipeline | Notes |
|---|---|---|---|
| **Frontier** | Claude Opus 4.6, Claude Sonnet 4.6 | Full-with-deep-audit (default) | Full quality on codebases up to ~100k tokens; the deep audit's semantic pass benefits most from frontier reasoning. |
| **Strong mid-tier** | Claude Haiku 4.5, GPT-4o | Lite (3-phase) | Architecture and contracts are solid. Skip defect scan — false-positive rate too high. |
| **Smaller / faster** | GPT-4o-mini, Gemini Flash, small open-weight models | Architecture only | Fair structural overview. Multi-phase runs produce significant quality loss. |

If you're testing a new model, start with `pipeline-architecture-only.yaml` on a codebase you already understand and compare the output against your own knowledge. Fast signal on whether to trust the model with deeper phases.

---

## Repository structure

```
.codecarto/                  # The drop-in template (Markdown + YAML).
  GUIDE.md                   # LLM entry point.
  findings/
    architecture/            # System structure, layers, dependency direction.
    defect-scan/             # Multi-pass defect report with severity and actions.
    contracts/               # User-visible behavior, defaults, acceptance checks.
    protocols/               # Event streams, state machines, persistence formats.
    porting/                 # Reverse-engineering synthesis bundle.
    reimplementation-spec/   # Language-agnostic build spec.
  scratch/                   # Disposable analysis notes.
  templates/                 # Output structure templates.
  workflow/                  # Pipeline definitions, status, validation, config.
  closeouts/                 # Per-session closeout files.
  THREAD_LOG.md              # Cross-session summary log.
  dashboard.html             # Generated; gitignored.
core/                        # Pipeline state machine, validators, prompt assembly,
                             # dashboard renderer, usage log, orchestrator config.
extensions/codecarto/        # Pi extension surface (slash commands, widget,
                             # tool gating, dashboard writer + narrator).
mcp-server/                  # MCP server surface (seven tools mirroring Pi commands).
tests/                       # Invariant tests catching cross-wrapper drift.
docs/                        # Roadmap, design notes.
```

The `.codecarto/.gitignore` excludes generated findings, scratch files, the dashboard, and the local usage / narration caches. Template files (workflow definitions, skills, output templates) are safe to commit so teammates can run their own analyses.

---

## For automated agents

1. Load the active pipeline YAML and `workflow/status.yaml`.
2. Select the first phase whose status is not `complete` and whose dependencies are all `complete`.
3. Feed the phase's `skill_path` and `required_reads` to the agent.
4. Write outputs to the declared paths. Run validation. Update status.
5. Repeat until all phases are complete. Set `current_phase` to `complete` when done.

The MCP server does steps 1–3 directly; the Pi extension wraps them as slash commands plus the parallel-sub-agent runner described above.

---

## Design principles

- **LLM-agnostic** — works with any model that can read and write files.
- **Phase-gated** — one phase per session, validated before advancing.
- **Single source of truth** — `status.yaml` tracks progress; no duplicated state.
- **Evidence-classified** — every finding tagged as observed fact, strong inference, portability hazard, or open question.
- **Template-driven** — consistent output structure across projects and sessions.
- **Drop-in** — lives inside your repo as `.codecarto/`. No symlinks, no copying source code, no runtime daemon.

---

## Contributing

Bug reports, feature requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, branch model, and the maintainer release process. All participants are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.

## License

MIT — see [LICENSE](LICENSE).
