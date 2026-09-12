# Self-audit: CodeCartographer run on itself (2026-09-11, v0.19.5)

This folder is the complete output of running CodeCartographer's `full-with-deep-audit`
pipeline **on this repository**, driven through the MCP server by an LLM host
(Claude Code, model Claude Fable 5.1). It is a snapshot of one run, kept outside
`.codecarto/` on purpose: the template directory is the framework's ABI and must not
carry the outputs of an evaluation run.

Nothing in here is consumed by the build, the tests, or the npm package.

## What was audited

Source at commit `f6f8484` (v0.19.5): `core/`, `extensions/`, `mcp-server/`, `tests/`,
`scripts/`, the CI workflows, and the shipped docs. The `.codecarto/` template content
(prompts, pipelines, skills) was not under review, though `DOGFOODING.md` records where
it got in the way.

## How the run was performed

- A shallow scratch clone of the repo was opened with `codecarto_open`; no `codecarto_init`,
  no `force`, no pipeline switch, no `codecarto_broadside`.
- Each of the seven phases was executed by the host LLM reading the code directly
  (`codecarto_next` → read every required read → write the report and the handoff →
  `codecarto_validate` → `codecarto_complete`). The framework wrote `status.yaml`, the
  closeouts, THREAD_LOG, and the DECISIONS rows; the host never edited them.
- Runtime probes (in `probes/`) were run against the clone to confirm the defects that
  could be reproduced in one line. Ten of the high/medium roots are probe-confirmed.
- The reimplementation-spec phase took the language-agnostic variant because the run was
  autonomous and its Strategic Alignment Hook could not ask a human.

## Start here

| File | What it is |
|---|---|
| [REVIEW.md](REVIEW.md) | The reconciled defect list: 11 high, 28 medium, 7 low groups, ranked, with file:line, disposition, and the fix. Plus the issue index. |
| [DOGFOODING.md](DOGFOODING.md) | Notes on the framework itself: where prompts left the host guessing, where the handoff contract fought it, dead-weight and missing required reads, what it got wrong about its own repo. |
| [findings/porting/reverse-engineering-bundle.md](findings/porting/reverse-engineering-bundle.md) | The compression boundary. §Defect Synthesis is the source of REVIEW.md. |
| [findings/reimplementation-spec/reimplementation-spec.md](findings/reimplementation-spec/reimplementation-spec.md) | Language-agnostic spec: six-module kernel over five ports, the eleven high defects as normative rules with named acceptance tests. |

## Layout

```
findings/            the seven primary reports and five secondary catalogs, one folder per phase
handoffs/            the seven phase handoffs (schema v1) the host wrote
closeouts/           the seven closeouts the framework generated (UTC-dated, hence 09-12)
workflow/status.yaml the final status document (7/7 complete, 5 open questions, 5 post-pipeline spikes)
CONVENTIONS.md       one convention promoted during the run (C01: cheap runtime probe before severity)
DECISIONS.md         decisions the framework appended at each completion
THREAD_LOG.md        this run's seven index lines (the clone shipped with the repo's own log; those lines are not included)
probes/              the runtime probe scripts (run from the repo root with --experimental-strip-types)
```

Phase order: architecture → defect-scan-mechanical → contracts, protocols (parallel) →
defect-scan-semantic → porting → reimplementation-spec.

## What is deliberately not here

`dashboard.html` and `workflow/.usage.local.yaml` (they carry absolute paths from the
machine that ran the audit), and the `.codecarto/` template files that sit beside each
finding in a live workspace.
