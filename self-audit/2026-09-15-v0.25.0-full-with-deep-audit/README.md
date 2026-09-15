# Self-audit: CodeCartographer run on itself (2026-09-15, v0.25.0)

This folder is the complete output of running CodeCartographer's `full-with-deep-audit`
pipeline **on this repository**, driven headlessly through the Pi extension with
`ollama-cloud/deepseek-v4.1-flash` as the phase model and `--llm-steer` on. It is a snapshot
of one run, kept outside `.codecarto/` on purpose: the template directory is the framework's
ABI and must not carry the outputs of an evaluation run.

Nothing in here is consumed by the build, the tests, or the npm package.

## What was audited

Source at commit `a159d6c` — v0.25.0 plus the `core/broadside/` split (#353): `core/`,
`core/broadside/`, `extensions/codecarto/`, `mcp-server/`, the CI workflows, and the shipped
docs. The `.codecarto/` template content (prompts, pipelines, skills) was not under review,
though `DOGFOODING.md` records where it shaped the run.

## How the run was performed

- A detached `git worktree` of `main` was opened with `/codecarto-open` (the repository
  already carries the template `.codecarto/`, so `/codecarto-init` would have asked a confirm
  that a headless session answers no to), then `/codecarto-next --auto --llm-steer` ran all
  seven phases unattended:

  ```
  script -qec "pi -ne -e ~/.pi/agent/extensions/ollama-cloud.ts --model ollama-cloud/deepseek-v4.1-flash \
    -e <checkout>/extensions/codecarto/index.ts -p '/codecarto-open' '/codecarto-next --auto --llm-steer'" /dev/null
  ```

  (`pi -ne` disables extension discovery, so the provider extension goes on the command line too.)
- Each phase ran as an isolated sub-agent that read the code directly, wrote the report and
  the handoff, and was validated and completed by the framework (`status.yaml`, closeouts,
  THREAD_LOG, DECISIONS — the runner never edited them). The tool-call hook blocked `bash`,
  so no test or probe was executed by the phases; `REVIEW.md` records what was then confirmed
  by reading.
- A seed run of the `architecture-only` pipeline on `glm-5.3-flash` preceded it to size the
  job: 20 turns, 3 minutes, 0.7M input tokens, `PASS WITH GAPS` with coverage `PARTIAL` — a
  docs-derived map that named the module bodies it had skipped. That map was discarded and the
  full run started from a pristine workspace.

## Usage

| phase | turns | tool uses | minutes | input tokens | output tokens |
|---|---|---|---|---|---|
| architecture | 40 | 97 | 8.3 | 5.8M | 39k |
| defect-scan-mechanical | 67 | 131 | 14.2 | 11.5M | 67k |
| contracts | 51 | 94 | 10.6 | 8.5M | 51k |
| protocols | 52 | 85 | 14.7 | 8.3M | 52k |
| defect-scan-semantic | 61 | 103 | 13.0 | 10.0M | 64k |
| porting | 38 | 67 | 8.7 | 4.4M | 44k |
| reimplementation-spec | 19 | 41 | 7.2 | 1.2M | 36k |
| **total** | **328** | **618** | **77** | **49.7M** | **353k** |

No compaction was needed in any phase (1M-token context). Every phase validated `PASS` with
coverage disposition `COMPLETE`.

## Start here

| File | What it is |
|---|---|
| [REVIEW.md](REVIEW.md) | The reconciled defect list — 27 findings (1 high, 10 medium, 16 low) — each confirmed by reading or marked as a claim, with the issue it became. |
| [DOGFOODING.md](DOGFOODING.md) | Notes on the framework itself: what the run showed about the model choice, headless driving, and the template's own behaviour on this repository. |
| [findings/porting/reverse-engineering-bundle.md](findings/porting/reverse-engineering-bundle.md) | The compression boundary. §Defect Synthesis is the run's own reconciliation of both scans. |
| [findings/defect-scan-semantic/semantic-defects.md](findings/defect-scan-semantic/semantic-defects.md) | The phase this run was for: concurrency, trust boundaries, contract violations — 13 findings, all `observed fact` with file:line. |
| [findings/reimplementation-spec/reimplementation-spec.md](findings/reimplementation-spec/reimplementation-spec.md) | The language-agnostic spec: 20 conceptual modules, 46 required behaviours. |

## Layout

```
findings/            the seven primary reports, five secondary catalogs, and the six per-pass defect files
handoffs/            the seven phase handoffs (schema v1) the sub-agents wrote
closeouts/           the seven closeouts the framework generated
workflow/status.yaml the final status document (7/7 complete, 7 open questions, 12 post-pipeline items)
CONVENTIONS.md       five conventions promoted during the run (C01–C05)
DECISIONS.md         decisions the framework appended at each completion
THREAD_LOG.md        this run's seven index lines
```

Phase order: architecture → defect-scan-mechanical → contracts, protocols (parallel) →
defect-scan-semantic → porting → reimplementation-spec.

## What is deliberately not here

`dashboard.html` and `workflow/.usage.local.yaml` carry absolute paths to the Pi session
files on the machine that ran the audit; the numbers above are the usage log's, and the
dashboard is the README hero image (`docs/demo-dashboard-hero.png`, rendered from it).
The `scratch/checkpoints/` files are the phase-compaction hook's periodic checkpoints and
say nothing the closeouts do not.
