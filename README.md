# CodeCartographer

A structured reverse-engineering toolkit for understanding unfamiliar codebases using LLMs. Drop it into any repository, point an LLM at the guide, and get a comprehensive analysis: architecture map, behavioral contracts, protocol documentation, defect report, porting synthesis, and reimplementation spec.

## What It Does

CodeCartographer guides an LLM through a phased analysis of your source code, producing structured documentation at each step. Instead of asking an LLM "explain this codebase" and getting a vague summary, you get a systematic evaluation with evidence-tagged findings, validated outputs, and cross-session continuity.

Each phase builds on the last. The architecture map feeds into behavioral contracts, which feed into protocol documentation, which feeds into a porting bundle, which feeds into a reimplementation spec. At the end, you have a complete evaluation bundle that a human or another LLM can use to understand, maintain, or rewrite the codebase.

## Quick Start

**1. Copy `.codecarto/` into your repository:**

```bash
cp -r /path/to/CodeCartographer/.codecarto /path/to/your-repo/
```

**2. Choose a pipeline** (optional — defaults to the full 5-phase):

```bash
# Edit .codecarto/workflow/status.yaml and set the pipeline field:
pipeline: workflow/pipeline.yaml                    # Full 5-phase (default)
pipeline: workflow/pipeline-full-with-audit.yaml    # 6-phase with defect scan
pipeline: workflow/pipeline-defect-scan.yaml        # 2-phase defect audit only
pipeline: workflow/pipeline-lite.yaml               # 3-phase understanding only
pipeline: workflow/pipeline-architecture-only.yaml  # 1-phase quick overview
```

**3. Point an LLM at the guide:**

```
Read .codecarto/GUIDE.md and begin the analysis.
```

That's it. The LLM reads the guide, checks `workflow/status.yaml` for progress, and starts the next phase automatically. Each phase produces a validated output in `.codecarto/findings/`.

## What It Produces

| Artifact | Description |
|---|---|
| Architecture map | Layers, dependency direction, public surfaces, runtime lifecycle, concurrency model |
| Defect report | Multi-pass scan for logic errors, security issues, concurrency bugs, API violations |
| Behavioral contracts | Feature-by-feature behavior with defaults, error handling, and acceptance tests |
| Protocols and state | Event flows, state machines, persistence formats, compatibility hazards |
| Porting bundle | Everything synthesized into a porting-oriented view with priority rankings |
| Reimplementation spec | Language-agnostic build plan with modules, acceptance scenarios, and known unknowns |

Every finding is tagged with an evidence level: **observed fact**, **strong inference**, **portability hazard**, or **open question**. Every phase output is validated against explicit completion criteria before the pipeline advances.

## Pipeline Variants

Not every project needs the full analysis. Pick the scope that fits:

| Variant | Phases | Use when |
|---|---|---|
| **Full** | 5 | You plan to port or reimplement the codebase |
| **Full with audit** | 6 | Porting with defect triage to avoid carrying legacy bugs |
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
.codecarto/
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
```

## Git

The `.codecarto/.gitignore` excludes generated findings and scratch files by default. The template files (workflow definitions, skills, templates) are safe to commit so other team members can run their own analysis.

## For Automated Agents

1. Load the active pipeline YAML and `workflow/status.yaml`.
2. Select the first phase whose status is not `complete` and whose dependencies are all `complete`.
3. Feed the phase's `skill_path` and `required_reads` to the agent.
4. Write outputs to the declared paths. Run validation. Update status.
5. Repeat until all phases are complete. Set `current_phase` to `complete` when done.

## License

MIT — see [LICENSE](LICENSE).
