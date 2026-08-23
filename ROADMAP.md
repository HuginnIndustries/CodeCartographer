# Roadmap — Broad-Side

Broad-Side is CodeCartographer's batch reconnaissance feature: a cheap,
unattended multi-lens scan over the OpenRouter Batch API that produces
unverified scouting leads for the interactive pipeline to confirm. Shipped
behind the `feat/103-broadside` branch (MCP surface first).

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
- Tests: 18 unit tests (fake-fetcher based), opt-in live smoke script.

## Tier 1 — make Broad-Side better at what it does

| Item | Issue | Notes |
|---|---|---|
| **Triage lens** — prioritized fix queue (impact × difficulty, grouped by module) | [#135](https://github.com/HuginnIndustries/CodeCartographer/issues/135) | Highest-value next lens: turns leads into a work order |
| **Truncation repair** — detect max_tokens-cutoff JSON, resubmit slices, report truncation in summaries | [#133](https://github.com/HuginnIndustries/CodeCartographer/issues/133) | Found in the self-scan: 3/10 defect slices truncated |
| **Concurrent polling** — poll all in-flight batches round-robin against one deadline | [#136](https://github.com/HuginnIndustries/CodeCartographer/issues/136) | Submissions already parallel; polling is sequential today |
| **Per-language prompts** — Go/Python/Rust/TS lens prompts; globs already adapt | [#137](https://github.com/HuginnIndustries/CodeCartographer/issues/137) | Schemas stay shared so synthesis is unaffected |

## Tier 2 — integration depth

| Item | Issue | Notes |
|---|---|---|
| **Pi extension** — `/codecarto-broadside` command with lens picker and live progress | [#138](https://github.com/HuginnIndustries/CodeCartographer/issues/138) | Agreed order: MCP first (shipped), Pi second |
| **Pipeline phase** — `broadside-scout` phase feeding later phases via `required_reads` | [#139](https://github.com/HuginnIndustries/CodeCartographer/issues/139) | SKILL.md contract stays: leads, never evidence |
| **Zero-config executive** — meta-pass picks lenses and slicing resolution from repo shape | [#140](https://github.com/HuginnIndustries/CodeCartographer/issues/140) | Decision recorded in `run-meta.json` for reproducibility |

## Tier 3 — cost and coverage economics

| Item | Issue | Notes |
|---|---|---|
| **Multi-model** — DeepSeek/Anthropic batch endpoints behind the lens registry | [#141](https://github.com/HuginnIndustries/CodeCartographer/issues/141) | Stronger batch models for semantic lenses at ~2-3× cost |
| **Incremental re-scouting** — diff against previous run's HEAD, rescan changed modules only | [#142](https://github.com/HuginnIndustries/CodeCartographer/issues/142) | Makes recurring scans O(delta) |
| **CodeCartoShow pipeline stage** — BATCH-SCOUT between SELECT and the interactive run | [CodeCartoShow#1](https://github.com/HuginnIndustries/CodeCartoShow/issues/1) | `scripts/batch-analyze.py` proved it; evidence rules apply unchanged |

## Principles

1. **Leads, never evidence.** Every Broad-Side artifact carries the
   disclaimer; nothing downstream may cite a Broad-Side report as fact.
2. **Coverage is spoken, not implied.** Truncations, skipped lenses, and
   unscouted scope appear in `run-meta.json` and the collect summary.
3. **Cost before submission.** Estimates are shown on submit; no silent
   spend. The live smoke script stays opt-in.
4. **The cheap model is a feature.** Gemini batch is weak but ~50% price;
   its job is to tell the expensive run where to look, not to be right.
