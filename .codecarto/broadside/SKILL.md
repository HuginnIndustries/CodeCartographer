---
name: broadside
description: Interpret a Broad-Side batch reconnaissance run. Use after codecarto_broadside collect has produced .codecarto/broadside/<run>/ results, to triage scouting signals before or during an interactive CodeCartographer pipeline run.
---

# Broad-Side

Broad-Side is CodeCartographer's batch reconnaissance pass. It fires six
analysis lenses — architecture, API surface, security, mechanical defect scan,
convention extraction, and porting — at the repository as single-turn prompts
over the OpenRouter Batch API (~50% of sync pricing, asynchronous, unattended),
then synthesizes one cross-lens report. Results live under
`.codecarto/broadside/<run>/` alongside this file.

## What Broad-Side findings are — and are not

Broad-Side findings are **unverified scouting signals**, not validated claims.
Every lens is one shot: no cross-file traversal, no runtime verification, no
builds, no tests, no follow-up questions. The batch model is cheap, not strong.
Treat every finding as a lead with a file:line pointer that the interactive
pipeline — or you — must confirm before it is a fact.

This is the division of labor: Broad-Side is cheap enough to run on any repo to
decide where the expensive interactive run should spend its attention. It does
not replace any phase; it tells phases where to look.

## Reading a Broad-Side run

1. Read `synthesis.md` first. It carries the executive summary, severity counts,
   the top cross-lens findings, and per-module risk levels.
2. Read the per-lens files behind anything that matters to your current phase:
   - `architecture-*.json` → the architecture phase's seed of prior knowledge
   - `api-*.json` → endpoints and data types (contracts/protocols phases)
   - `security-*.json` → auth, trust boundaries (defect-scan-semantic pass 5)
   - `defect-*.json` → mechanical defect leads (defect-scan-mechanical)
   - `conventions-*.json` → naming/idiom candidates for CONVENTIONS.md
   - `porting-*.json` → platform coupling (porting phase)
3. `run-meta.json` records scope: which lenses ran, at what cost, with what
   coverage caps.

## How to use the leads

- **A finding that matches your phase's scope is a starting point, not an answer.**
  Re-derive it from the source yourself; cite the source, not the Broad-Side
  report. Broad-Side output is not evidence.
- **Route, don't believe.** A Broad-Side "high" that your phase can neither
  confirm nor dismiss becomes an open question with `needs-runtime-test` or
  `needs-maintainer-decision` — never a finding.
- **Promotable conventions are candidates only.** CONVENTIONS.md promotions
  still require the orchestrator's review against the code, per the usual
  promotion rules.
- **Coverage caps are real.** Directory-sliced lenses cap each slice's input;
  `run-meta.json` and the synthesis `coverage` field say what was scanned.
  Everything outside that is unscouted, not clean.

## Running Broad-Side

Broad-Side is an executable-surface feature (MCP today):

```
codecarto_broadside {cwd, action: "submit", lenses: [...]}   # fire the batches
codecarto_broadside {cwd, action: "collect"}                  # poll, save, synthesize
codecarto_broadside {cwd, action: "status"}                   # show recorded runs
codecarto_broadside {cwd, action: "models"}                   # compare batch models
```

The `models` action lists every `:batch` variant on OpenRouter — pricing per
million tokens, context window, output ceiling, structured-output support, and
(optionally) Artificial Analysis coding indices — cheapest first, with the
configured model marked. Use it before switching models in `config.yaml`.
Submits pre-flight the chosen model: pricing comes from the live catalog
(cached 24h), requests clamp to the provider's completion ceiling, and a
model that does not advertise structured-output support is refused outright,
because every lens depends on `json_schema` response_format.

It works on any git repository — no initialized workspace required — and needs
an OpenRouter API key via the `api_key` parameter, the `OPENROUTER_API_KEY`
environment variable, or `api_key` in this directory's `config.yaml`.

Submits are priced before they fire: Broad-Side estimates the run from the
collected file sizes against the model's live per-token pricing and refuses
when the estimate exceeds `max_cost` (`config.yaml` or the tool parameter)
unless `force` is passed. See `config.yaml` for the model, limit, and manual
pricing-override keys.
