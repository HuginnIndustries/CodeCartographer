# Roadmap — Broad-Side

Broad-Side is CodeCartographer's batch reconnaissance feature: a cheap,
unattended multi-lens scan over the OpenRouter Batch API that produces
unverified scouting leads for the interactive pipeline to confirm. Shipped via PR #144 (branch `feat/103-broadside`, MCP surface first).

This roadmap is the working agreement on what comes next. Items are tracked
as GitHub issues labeled `feat`; status changes happen in the issues, this
file only moves when a tier completes.

## Shipped

- `codecarto_broadside` MCP tool — `submit` / `collect` / `status` actions.
- Six lenses: architecture, api, security, defect, conventions, porting.
- Directory slicing with overflow splitting (no truncation of coverage).
- Cross-lens synthesis report.
- Repo-local state file (`broadside/state.json`) with resumable collect.
- Works without an initialized workspace; `codecarto_init` tolerates a
  scout-only `.codecarto/`; scaffold refresh never touches broadside state.
- Auth-expiry fast bail, empty-lens skip, submission-throw guard.
- Live per-model pricing lookup (OpenRouter catalog, 24h cache) with
  `max_cost` expense guardrail and `force` override; configurable model
  (`config.yaml` `model` key, now wired through submissions).
- `models` action: batch-model catalog with pricing, context, output caps,
  structured-output support, and optional Artificial Analysis coding
  benchmarks; submit pre-flight refuses models without structured outputs
  and clamps lens `max_tokens` to the provider's completion ceiling.
- Triage post-pass on collect: findings scored by impact × difficulty into
  a P0–P3 work order with effort estimates, saved as triage.json/md.
- Pi surface: `/codecarto-broadside [submit|collect|status|models] [lenses…]`
  with a spend confirmation (`confirm` hook on `runBroadsideSubmit`), so Pi asks
  where MCP must refuse.
- Reading guide reachable as `codecarto_skill {name: "broadside"}` on both
  executable surfaces, exempt from the post-pipeline completion gate; agent
  doctrine as the `broadside` topic of `codecarto_guide`; README / MANUAL /
  MCP quickstart coverage.
- Repository defaults in `config.yaml` for every per-call run knob
  (`incremental`, `retry_truncated`, `include_synthesis`, `include_triage`,
  `wait_seconds`); an explicit parameter always wins.
- Tests: fake-fetcher unit suite, opt-in live smoke script (`npm run smoke:broadside`).

## Tier 1 — make Broad-Side better at what it does

| Item | Issue | Notes |
|---|---|---|
| **Triage lens** — prioritized fix queue (impact × difficulty, grouped by module) | [#135](https://github.com/HuginnIndustries/CodeCartographer/issues/135) | **Shipped**: triage pass runs on collect alongside synthesis (`include_triage` to skip) |
| **Truncation repair** — detect max_tokens-cutoff JSON, resubmit slices, report truncation in summaries | [#133](https://github.com/HuginnIndustries/CodeCartographer/issues/133) | **Shipped**: fence-tolerant parsing + `truncated` flags + automatic re-submit of truncated slices with a doubled output cap |
| **Concurrent polling** — poll all in-flight batches round-robin against one deadline | [#136](https://github.com/HuginnIndustries/CodeCartographer/issues/136) | **Shipped**: `pollBatchesConcurrently` polls in parallel with per-lens progress tags |
| **Per-language prompts** — Go/Python/Rust/TS lens prompts; globs already adapt | [#137](https://github.com/HuginnIndustries/CodeCartographer/issues/137) | **Shipped**: language profiles drive defect/conventions prompts; schemas unchanged |

## Tier 2 — integration depth

| Item | Issue | Notes |
|---|---|---|
| **Pi extension** — `/codecarto-broadside` command with lens picker and live progress | [#138](https://github.com/HuginnIndustries/CodeCartographer/issues/138) | **Shipped**: four actions with tab-completed lens picker, live per-lens progress widget, and an interactive spend confirmation in place of MCP's refuse-unless-`force` |
| **Pipeline phase** — `broadside-scout` phase feeding later phases via `required_reads` | [#139](https://github.com/HuginnIndustries/CodeCartographer/issues/139) | SKILL.md contract stays: leads, never evidence |
| **Zero-config executive** — meta-pass picks lenses and slicing resolution from repo shape | [#140](https://github.com/HuginnIndustries/CodeCartographer/issues/140) | **Shipped**: `auto` slicing collapses small repos to one slice, directory-splits large ones |

## Tier 3 — cost and coverage economics

| Item | Issue | Notes |
|---|---|---|
| **Multi-model** — DeepSeek/Anthropic batch endpoints behind the lens registry | [#141](https://github.com/HuginnIndustries/CodeCartographer/issues/141) | Partially shipped: catalog lookup, `models` action, pricing + capability pre-flight. Remaining: per-model prompt tweaks and a stronger default for semantic lenses |
| **Incremental re-scouting** — diff against previous run's HEAD, rescan changed modules only | [#142](https://github.com/HuginnIndustries/CodeCartographer/issues/142) | **Shipped**: `incremental: true` diffs against the prior run's HEAD; dirty tree falls back to full scan |
| **CodeCartoShow pipeline stage** — BATCH-SCOUT between SELECT and the interactive run | [CodeCartoShow#1](https://github.com/HuginnIndustries/CodeCartoShow/issues/1) | `scripts/batch-analyze.py` proved it; evidence rules apply unchanged |

## Tier 4 — open questions, not commitments

| Item | Issue | Notes |
|---|---|---|
| **Headless-agent lens queue** — sync-priced, tool-using variant via `@openrouter/agent` | [#143](https://github.com/HuginnIndustries/CodeCartographer/issues/143) | 2× batch pricing; overlaps the interactive pipeline. The likelier winner is the hybrid: batch sweeps + one sync-priced verification pass on the top N findings |

## Principles

1. **Leads, never evidence.** Every Broad-Side artifact carries the
   disclaimer; nothing downstream may cite a Broad-Side report as fact.
2. **Coverage is spoken, not implied.** Truncations, skipped lenses, and
   unscouted scope appear in `run-meta.json` and the collect summary.
3. **Cost before submission.** Estimates are shown on submit; no silent
   spend. The live smoke script stays opt-in.
4. **The cheap model is a feature.** Gemini batch is weak but ~50% price;
   its job is to tell the expensive run where to look, not to be right.
