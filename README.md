# CodeCartographer

[![CI](https://github.com/HuginnIndustries/CodeCartographer/actions/workflows/ci.yml/badge.svg)](https://github.com/HuginnIndustries/CodeCartographer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/codecartographer-pi.svg)](https://www.npmjs.com/package/codecartographer-pi)

A structured reverse-engineering toolkit for understanding unfamiliar codebases using LLMs. Drop it into any repository, point an LLM at the guide, and get a comprehensive analysis: architecture map, behavioral contracts, protocol documentation, defect report, porting synthesis, and reimplementation spec.

## What It Does

CodeCartographer guides an LLM through a phased analysis of your source code, producing structured documentation at each step. Instead of asking an LLM "explain this codebase" and getting a vague summary, you get a systematic evaluation with evidence-tagged findings, validated outputs, and cross-session continuity.

Each phase builds on the last. The architecture map feeds into behavioral contracts, which feed into protocol documentation, which feeds into a porting bundle, which feeds into a reimplementation spec. At the end, you have a complete evaluation bundle that a human or another LLM can use to understand, maintain, or rewrite the codebase.

## Quick Start

**1. Copy `.codecarto/` into your repository:**

```bash
cp -r /path/to/CodeCartographer/.codecarto /path/to/your-repo/
```

**2. Choose a pipeline** (optional — defaults to the full 7-phase with split defect scan):

```yaml
# Edit .codecarto/workflow/status.yaml and set the pipeline field:
pipeline: workflow/pipeline-full-with-deep-audit.yaml  # 7-phase with split defect scan (default; depth-first)
pipeline: workflow/pipeline-full-with-audit.yaml       # 6-phase with single early defect scan
pipeline: workflow/pipeline.yaml                       # 5-phase without defect scan — remove defect-scan phases
pipeline: workflow/pipeline-defect-scan.yaml           # 2-phase defect audit — remove contracts through reimplementation-spec
pipeline: workflow/pipeline-lite.yaml                  # 3-phase understanding — remove defect-scan phases, porting, and reimplementation-spec
pipeline: workflow/pipeline-architecture-only.yaml     # 1-phase quick overview — keep only architecture
```

**3. Point an LLM at the guide:**

```
Read .codecarto/GUIDE.md and begin the analysis.
```

That's it. The LLM reads the guide, checks `workflow/status.yaml` for progress, and starts the next phase automatically. Each phase produces a validated output in `.codecarto/findings/`.

## Pi Package

This branch also packages CodeCartographer for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) without changing `.codecarto/` itself. Pi is an **optional peer dependency** — if you only want the template or the MCP server, you don't need Pi installed.

Install from npm, a local checkout, or a git URL:

```bash
pi install npm:codecartographer-pi
# or, from a local checkout:
pi install /absolute/path/to/CodeCartographer
# or, from a git URL:
pi install git:github.com/your-user/CodeCartographer
```

> **Don't run `npm install codecartographer-pi` for the Pi use case.** Plain `npm install` puts the package on disk but doesn't register it with Pi, so it never appears in the TUI. Use `pi install npm:codecartographer-pi` instead — Pi handles the npm install internally and writes the package into its own `settings.json` (`~/.pi/agent/settings.json` by default). Plain `npm install` is the right command only for the MCP-server use case described below.

For extension development, you can also point Pi directly at the extension entrypoint or place it in an auto-discovered extensions directory and use `/reload`:

```bash
pi -e /absolute/path/to/CodeCartographer/extensions/codecarto/index.ts
```

The extension is self-contained at runtime. It uses only Node built-ins plus Pi's peer dependencies, so direct loading and `/reload` do not require a separate `npm install`.

Then in the target repository:

```text
/codecarto-init [full-with-deep-audit|full-with-audit|full|defect-scan|lite|architecture-only]
/codecarto-status
/codecarto-next
```

If you install the whole repository as a Pi package, Pi may still run package installation steps for the package itself, but the CodeCartographer extension does not depend on any third-party runtime modules.

What the Pi extension adds:

- `/codecarto-init` to copy `.codecarto/` into the current repository
- `/codecarto-next` to queue the next eligible phase prompt
- `/codecarto-status` to show current phase progress
- `/codecarto-validate` and `/codecarto-complete` for validation-gated status updates
- a footer/widget showing the active CodeCartographer phase
- tool interception that blocks `edit` and `write` outside `.codecarto/`
- direct phase prompts that tell Pi exactly which `.codecarto/findings/<phase>/SKILL.md` file to read, without registering those internal files as global Pi skills

## MCP Server

The same framework is also packaged as a [Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP-compatible host (Claude Code, Claude Desktop, etc.) can drive a CodeCartographer workflow without the Pi runtime. The server imports the same `core/` primitives the Pi extension uses, so phase prompts and validation are byte-identical across both surfaces.

Implements MCP spec revision [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25) via `@modelcontextprotocol/sdk` ≥ 1.29.0. The negotiated `protocolVersion` reflects whatever the connecting client requests; the server accepts every revision the SDK supports (currently `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`).

Install and wire it up:

```bash
npm install --global codecartographer-pi
# or, in a project: npm install codecartographer-pi
```

Add it to your MCP host config (Claude Code: `~/.config/claude-code/config.json`, Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "codecartographer": {
      "command": "codecarto-mcp"
    }
  }
}
```

The server exposes seven tools, each accepting an absolute `cwd` for the target repository:

| Tool | Purpose | Pi equivalent |
|---|---|---|
| `codecarto_init` | Copy `.codecarto/` into the target repo and select a pipeline | `/codecarto-init` |
| `codecarto_status` | Current phase, active pipeline, progress, open questions | `/codecarto-status` |
| `codecarto_next` | Return the next eligible phase prompt as text | `/codecarto-next` |
| `codecarto_phase` | Return a specific phase's prompt (forced, even out of order) | `/codecarto-phase` |
| `codecarto_validate` | Validate a phase output, returning structured criteria rows | `/codecarto-validate` |
| `codecarto_complete` | Atomically mark a phase complete after validation passes | `/codecarto-complete` |
| `codecarto_skill` | Return a post-pipeline skill prompt | `/codecarto-skill` |

`codecarto_init` requires `force: true` to overwrite an existing `.codecarto/` (instead of Pi's interactive confirmation).

## What It Produces

| Artifact | Description |
|---|---|
| Architecture map | Layers, dependency direction, public surfaces, runtime lifecycle, concurrency model |
| Defect report | Multi-pass scan for logic errors, security issues, concurrency bugs, API violations |
| Defect fix tracker | Remediation log mapping each fix, deferral, or acceptance back to the defect report |
| Behavioral contracts | Feature-by-feature behavior with defaults, error handling, and acceptance tests |
| Protocols and state | Event flows, state machines, persistence formats, compatibility hazards |
| Porting bundle | Everything synthesized into a porting-oriented view with priority rankings |
| Reimplementation spec | Language-agnostic build plan with modules, acceptance scenarios, and known unknowns |

Every finding is tagged with an evidence level: **observed fact**, **strong inference**, **portability hazard**, or **open question**. Every phase output is validated against explicit completion criteria before the pipeline advances.

## Pipeline Variants

Not every project needs the full analysis. The default is the 7-phase **full-with-deep-audit** pipeline, which splits the defect scan into an early mechanical pass and a deep semantic pass so the reimplementation can design around defects with full contracts and protocols context. Scale back if you want less, or use the legacy single-scan pipeline if you don't need the deeper context-grounded defect findings:

| Variant | Phases | Use when |
|---|---|---|
| **Full with deep audit** (default) | 7 | Complete analysis with split defect scan; reimplementation grounded in contracts/protocols-aware defect findings |
| **Full with audit** | 6 | Single early defect scan; cheaper than the deep variant when the defects are mostly mechanical |
| **Full** | 5 | Porting or reimplementation without any defect scan |
| **Defect scan** | 2 | Maintenance audit to surface latent problems |
| **Lite** | 3 | You need to understand behavior without porting plans |
| **Architecture only** | 1 | Quick structural overview |

## Compatible Environments

CodeCartographer works with any LLM that can read and write files:

| Environment | Notes |
|---|---|
| **Claude Code** | Point it at `.codecarto/GUIDE.md`. Works out of the box. |
| **OpenCode** | Same as Claude Code — file read/write is built in. |
| **Cursor / Windsurf / IDE copilots** | Open the repo. Point the LLM at `.codecarto/GUIDE.md` in chat. |
| **Aider** | Run from the repo root. |
| **Claude.ai / ChatGPT (web chat)** | Paste file contents manually. Tedious for multi-phase runs. |
| **API-based agents** | Load files programmatically, pass to the model, write outputs back. |

## Token Usage and Cost

CodeCartographer is token-intensive. It reads your source code multiple times across phases and produces thousands of words of structured output. Here's what to expect:

### Template Overhead (Fixed Cost)

Every session reads the guide, pipeline definition, status file, and validation protocol. On top of that, each phase reads its own SKILL.md and output template. This overhead is fixed regardless of codebase size:

| Component | Tokens (input) |
|---|---|
| Per-session base (GUIDE + pipeline + status + VALIDATE) | ~2,600 |
| Architecture phase instructions | ~1,500 |
| Defect scan phase instructions (includes 6 pass files) | ~5,000 |
| Contracts phase instructions | ~1,500 |
| Protocols phase instructions | ~1,200 |
| Porting phase instructions | ~1,200 |
| Reimplementation spec phase instructions | ~1,100 |
| **Total template overhead for a 6-phase run** | **~27,000** |

### Source Code Reading (Variable Cost)

This is the dominant cost. Each phase reads some or all of your source code. The architecture phase reads the most (full structural scan); later phases are more targeted but also read prior findings.

Rough guide: **expect to read 1-3x your codebase size in tokens per phase**. A 50k-token codebase might consume 100-200k input tokens across a full pipeline run.

### Output Generation

Each phase produces a structured findings document. From a real 6-phase run (CodeCartographer analyzing itself — a small ~14k-word template):

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

### Cost Estimates

For a medium-sized codebase (~100k tokens of source):

| Pipeline | Estimated Input | Estimated Output | Total |
|---|---|---|---|
| Architecture only | ~130k | ~5k | ~135k tokens |
| Defect scan (2-phase) | ~260k | ~10k | ~270k tokens |
| Lite (3-phase) | ~370k | ~15k | ~385k tokens |
| Full (5-phase) | ~570k | ~22k | ~592k tokens |
| Full with audit (6-phase) | ~700k | ~27k | ~727k tokens |

At current API pricing (~$3/M input, ~$15/M output for Claude Sonnet), a full 5-phase run on a 100k-token codebase costs roughly **$2-4**. Larger codebases scale linearly.

### Tips to Reduce Token Usage

- **Start with architecture-only** to see if the output quality is useful before committing to a full run.
- **Use one session per phase** — each phase gets a fresh context window, so you're not paying to carry stale context.
- **For very large codebases** (500k+ tokens of source), the LLM can't read everything anyway. It will use the architecture map to prioritize and produce partial results. Check `open_questions` in status.yaml to see what it skipped.
- **The lite pipeline (3 phases) gives 80% of the value** for understanding a codebase without the porting-specific phases.

## Model Compatibility

CodeCartographer is LLM-agnostic by design, but model choice affects both what you can analyze and how good the results are. There are two independent constraints: context window size and model capability.

### Context Window

Each phase runs in its own session, so the context window limits how much source code can be read per phase — not across the whole pipeline. After subtracting template overhead, prior-phase findings, and output generation, here's how much room remains for reading source code:

| Phase | Available for Source Code (128k model) | Available (200k model) |
|---|---|---|
| Architecture | ~121k | ~193k |
| Defect scan | ~115k | ~187k |
| Contracts | ~114k | ~186k |
| Protocols | ~115k | ~187k |
| Porting | ~104k | ~176k |
| Reimplementation spec | ~103k | ~175k |

Since each phase reads 1–3x the codebase, practical limits by context window:

| Codebase Size | 128k Context | 200k Context |
|---|---|---|
| <30k tokens | All phases comfortable | All phases comfortable |
| 30–60k tokens | Feasible, some PARTIAL results | Comfortable |
| 60–100k tokens | Marginal — heavy PARTIAL use | Feasible with prioritization |
| >100k tokens | Not viable | Feasible, later phases may PARTIAL |

The pipeline handles context exhaustion gracefully: phases can write `PARTIAL` validation and log remaining work in `open_questions` in status.yaml.

### Model Capability

Context window is the easier problem. The harder constraint is whether the model can handle the cognitive demands of each phase. The tasks that degrade fastest on weaker models:

1. **Evidence classification** (high risk) — distinguishing `observed fact` from `strong inference` from `open question` requires calibrated self-awareness about certainty. Weaker models tend to over-classify inferences as facts and skip `open question` tagging.
2. **Defect scan** (high risk) — the 6-pass scan demands domain-specific reasoning (concurrency, security, API contracts). Weaker models produce more false positives, miss subtle bugs, and over-report style issues as defects.
3. **Architecture synthesis** (medium-high risk) — abstracting a coherent layer map from many files is high-order reasoning. Weaker models produce flatter, shallower descriptions with poor dependency direction analysis.
4. **Structured output adherence** (medium risk) — filling templates correctly with all required sections and consistent formatting.
5. **Cross-phase coherence** (medium risk) — later phases build on earlier findings. Weak architecture output compounds errors downstream.

### Recommended Model Tiers

| Model Tier | Examples | Recommended Pipeline | Notes |
|---|---|---|---|
| Frontier | Claude Opus 4.6, Claude Sonnet 4.6 | Full-with-deep-audit (default) or full-with-audit | Full quality on codebases up to ~100k tokens; the deep audit's semantic pass benefits most from frontier reasoning |
| Strong mid-tier | Claude Haiku 4.5, GPT-4o | Lite (3-phase) | Architecture and contracts are solid. Skip defect scan — false positive rate too high. Evidence classification less reliable. |
| Smaller / faster | GPT-4o-mini, Gemini Flash, small open-weight models | Architecture only | Fair structural overview. Multi-phase pipelines produce significant quality loss. Defect scan not recommended. |

### What to Expect Below Sonnet 4.6

- **Architecture phase**: Usually passable. The layer map and public surfaces will be present but may lack nuance in dependency direction and porting priorities.
- **Contracts and protocols**: Quality depends heavily on how well architecture was captured. Expect missing edge cases and less precise error-behavior documentation.
- **Defect scan**: Not recommended. The six specialized passes require strong domain reasoning. Weaker models produce noisy reports that cost more time to triage than they save.
- **Porting and reimplementation**: These synthesis phases amplify upstream quality. If earlier phases are weak, these will be too.

If you're testing a new model, start with `pipeline-architecture-only.yaml` on a codebase you already understand, and compare the output against your own knowledge. That gives you a fast signal on whether to trust the model with deeper phases.

## How It Works

CodeCartographer is a pure template — no CLI, no runtime, no dependencies. The "code" is structured Markdown and YAML files that tell an LLM what to analyze, in what order, and how to format the results.

The workflow is driven by flat files inside `.codecarto/`:

- **`GUIDE.md`** — the LLM entry point. Every session starts here.
- **`workflow/pipeline.yaml`** — phase definitions, dependencies, and output paths.
- **`workflow/status.yaml`** — mutable per-project state. Single source of truth for progress.
- **`workflow/VALIDATE.md`** — validation protocol run after every phase.
- **`findings/<phase>/SKILL.md`** — detailed analysis instructions per phase.
- **`templates/`** — output templates that enforce consistent structure.

Phases form a DAG: `contracts` and `protocols` can run in parallel after `architecture`; `porting` waits for both; `reimplementation-spec` is last.

### Multi-Session Workflows

Large codebases typically need one LLM session per phase. Start a new session and point it at `.codecarto/GUIDE.md` — it reads `status.yaml`, sees what's done, and picks up the next phase automatically. You don't need to explain what happened in previous sessions.

For follow-up sessions, you can also use `NEW_THREAD_BLURB.md` as a lighter entry point — it's a compact checklist that saves tokens by skipping the full guide.

### The Defect Scan

The defect-scan phase runs six sequential analysis passes: logic and correctness, error handling, concurrency, security, API contract violations, and configuration hazards. Each finding gets a severity (critical/high/medium/low) and a recommended action (fix before porting / port differently / leave behind).

## Design Principles

- **LLM-agnostic**: works with any model that can read/write files.
- **Phase-gated**: one phase per session, validated before advancing.
- **Single source of truth**: `status.yaml` tracks progress; no duplicated state.
- **Evidence-classified**: every finding is tagged as observed fact, strong inference, portability hazard, or open question.
- **Template-driven**: consistent output structure across projects and sessions.
- **Drop-in**: lives inside your repo as `.codecarto/`. No symlinking or copying source code.

## Repository Structure

```
.codecarto/                  # The drop-in template (Markdown + YAML).
  GUIDE.md                   # LLM entry point.
  findings/
    architecture/            # System structure, layers, dependency direction.
    defect-scan/             # Multi-pass defect report with severity and actions.
      passes/                # Per-category analysis instructions (6 pass files).
    contracts/               # User-visible behavior, defaults, acceptance checks.
    protocols/               # Event streams, state machines, persistence formats.
    porting/                 # Reverse-engineering synthesis bundle.
    reimplementation-spec/   # Final language-agnostic build spec.
  scratch/                   # Disposable analysis notes.
  templates/                 # Output structure templates.
  workflow/                  # Pipeline definitions, status, validation.
  THREAD_LOG.md              # Cross-session summary log.
core/                        # Pipeline state machine, validators, prompt assembly.
extensions/codecarto/        # Pi extension surface (slash commands, widget, tool gating).
mcp-server/                  # MCP server surface (seven tools mirroring the Pi commands).
tests/                       # Invariant tests catching cross-wrapper drift.
docs/                        # Roadmap, design notes.
CONTRIBUTING.md              # How to contribute to CodeCartographer itself.
SECURITY.md                  # Security policy and reporting.
CHANGELOG.md                 # Version history.
```

## Git

The `.codecarto/.gitignore` excludes generated findings and scratch files by default. The template files (workflow definitions, skills, templates) are safe to commit so other team members can run their own analysis.

## For Automated Agents

1. Load the active pipeline YAML and `workflow/status.yaml`.
2. Select the first phase whose status is not `complete` and whose dependencies are all `complete`.
3. Feed the phase's `skill_path` and `required_reads` to the agent.
4. Write outputs to the declared paths. Run validation. Update status.
5. Repeat until all phases are complete. Set `current_phase` to `complete` when done.

## Contributing

Bug reports, feature requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, branch model, and the maintainer release process. All participants are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues, please follow [SECURITY.md](SECURITY.md) instead of filing a public issue.

## License

MIT — see [LICENSE](LICENSE).
