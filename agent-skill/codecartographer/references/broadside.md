# Broad-Side: scouting a repository before you spend on it

Broad-Side is CodeCartographer's batch reconnaissance pass. It fires six
analysis lenses — architecture, API surface, security, mechanical defect scan,
convention extraction, and porting — at a repository as single-turn prompts
over the OpenRouter Batch API, then cross-references them into one executive
report and a prioritized work order.

It is not a phase, and it does not replace one. It is the cheap sweep that
tells the expensive interactive run where to look.

## Leads, never evidence

Every Broad-Side finding is an **unverified scouting signal**. Each lens is one
shot: no cross-file traversal, no runtime verification, no builds, no tests, no
follow-up questions. The batch model is chosen for price, not strength.

This is the rule the whole feature rests on: a finding is a `file:line` lead
that a phase — or you — must confirm against the source before it is a fact.
Cite the source you confirmed it from, never the Broad-Side report. A "high"
you can neither confirm nor dismiss becomes an open question in your handoff,
not a finding in your report.

## When to fire it

- **Before `codecarto_init`,** on a repository nobody on the team knows. The
  synthesis report is a map of where the risk sits, which makes the pipeline
  choice an informed one instead of a guess.
- **Before an expensive phase,** when the repository is large enough that the
  architecture or defect phases would otherwise read blind.
- **Not at all,** when the repository is small enough to read directly. A sweep
  that costs more than the reading it saves is waste.

It works on any git repository — no workspace required — and `codecarto_init`
tolerates a `.codecarto/` that holds nothing but scout state.

## Driving it

```
codecarto_broadside {cwd, action: "models"}                    # compare batch models first
codecarto_broadside {cwd, action: "submit", lenses: [...]}     # fire the batches
codecarto_broadside {cwd, action: "status"}                    # what is in flight
codecarto_broadside {cwd, action: "collect"}                   # poll, save, synthesize, triage
```

(The Pi extension exposes the same four actions as `/codecarto-broadside <action> [lenses…]`.)

Submit and collect are separate on purpose: batch jobs routinely take tens of
minutes, and nothing is lost by returning between them. Pass `wait_seconds` to
poll inline when you would rather block. Collect is resumable — call it again
and it picks up the batches the recorded state still lists as in flight.

Requires an OpenRouter API key via the `api_key` parameter, the
`OPENROUTER_API_KEY` environment variable, or `api_key` in
`.codecarto/broadside/config.yaml`.

## Cost is a first-class parameter

Submit prices the run before it fires: it estimates from the collected file
sizes against the model's live per-token pricing (cached 24h) and refuses when
the estimate exceeds `max_cost`, printing the per-lens breakdown. `force: true`
overrides. This is a pre-flight estimate, not a runtime stop — actual spend
lands in the run's `run-meta.json`.

**Never pass `force: true` on the user's behalf without telling them what the
estimate was.** The guardrail exists because the expensive end of the batch
model catalog runs past $80 per million output tokens. On MCP the refusal is
the only protection there is — the server cannot ask, which is exactly why
`force` must be the user's decision rather than your retry. (Pi has a human to
ask, so it shows the breakdown and prompts instead of refusing.)

Two more economies worth knowing:

- `incremental: true` diffs against the previous run's git HEAD and scans only
  the modules whose files changed, falling back to a full scan on a dirty tree.
- Every knob above has a repository default in `.codecarto/broadside/config.yaml`
  (`model`, `default_lenses`, `max_cost`, `lens_models`, `incremental`,
  `retry_truncated`, `include_synthesis`, `include_triage`, `wait_seconds`). An
  explicit parameter on the call always wins.
- `lens_models` runs individual lenses on their own model. Spending more on the
  security and defect lenses while the cheap default carries architecture and
  conventions is usually a better trade than raising the model for everything.
  Overrides are priced and capability-checked individually, and the estimate
  breaks cost out per lens.

## Reading a run

Results land in `.codecarto/broadside/<run>/`. Read them in this order:

1. `synthesis.md` — executive summary, severity counts, top cross-lens
   findings, per-module risk.
2. `triage.md` — the same findings scored by impact × difficulty into a P0–P3
   work order with effort estimates. A starting point for re-verification, not
   a commitment.
3. The per-lens `*.json` / `*.md` behind whatever matters to the phase you are
   about to run: `architecture-*` seeds the architecture phase, `api-*` the
   contracts and protocols phases, `security-*` and `defect-*` the defect
   scans, `conventions-*` the convention candidates, `porting-*` the porting
   phase.
4. `run-meta.json` — scope: which lenses ran, at what cost, with what coverage
   caps.

`codecarto_skill {cwd, name: "broadside"}` returns the full reading guide.
Unlike post-pipeline skills, that one is not gated on a completed pipeline,
because a scout run is meant to be read before the pipeline and during it.

## Coverage is spoken, not implied

- A lens output whose JSON does not parse is saved verbatim and marked
  `truncated`. The collect summary counts it, `run-meta.json` records it, and
  the synthesis prompt is told that module is unrepresented — not clean. By
  default a truncated slice is resubmitted once with a doubled output cap.
- A skipped lens, a capped slice, and unscanned scope are all reported. Scope
  outside the sweep is **unscouted, not clean**, and saying otherwise in a phase
  report is the one way Broad-Side can actively mislead a run.
