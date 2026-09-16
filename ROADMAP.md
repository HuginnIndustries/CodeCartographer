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
- Per-lens model overrides (`lens_models`): each lens can run on its own batch
  model, pre-flighted and priced independently, recorded in `run-meta.json`, and
  honored by the truncation retry.
- `scout-first` pipeline variant: a `broadside-scout` phase distills a completed
  run into `findings/broadside-scout/scout-brief.md`; architecture, both defect
  scans, contracts, protocols, and porting read it and account for their leads at
  validation. The phase never submits and never spends.
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
| **Truncation repair** — detect max_tokens-cutoff JSON, resubmit slices, report truncation in summaries | [#133](https://github.com/HuginnIndustries/CodeCartographer/issues/133) | **Shipped**: fence-tolerant parsing + `truncated` flags + automatic re-submit of truncated slices with a doubled output cap; since 0.22.1 the retry runs as one batch per model (#206) at low reasoning effort, because a token cap is ignored by Gemini 3.x and doubling the budget doubled the thinking (#320) |
| **Concurrent polling** — poll all in-flight batches round-robin against one deadline | [#136](https://github.com/HuginnIndustries/CodeCartographer/issues/136) | **Shipped**: `pollBatchesConcurrently` polls in parallel with per-lens progress tags; retries and post-passes poll the same way (0.22.1, 0.22.2) |
| **Reasoning control** — stop thinking from eating the output budget | [#320](https://github.com/HuginnIndustries/CodeCartographer/pull/320) | **Shipped**: every lens request asks for `effort: low`; measured on `gemini-3.8-flash:batch`, a `max_tokens` cap was ignored (11,518 thinking tokens under a 5,800 cap) while low effort reasoned 0 tokens at a twelfth of the cost |
| **Lens scope fallback** — a security review for repositories with no `server/` | [#319](https://github.com/HuginnIndustries/CodeCartographer/issues/319) | **Shipped** (0.23.0): the security and API lenses read every source file when their targeted globs match nothing, priced and reported as such. 0.24.1 (#335) extends it to a match with no *source* file — on this repository the security lens had been reading `SECURITY.md` alone |
| **Ask the scan for the trigger** — the verifier's rubric in the defect lens prompt | [#341](https://github.com/HuginnIndustries/CodeCartographer/pull/341) | **Shipped** (0.24.1), measured two runs per arm on this repository: findings 24, 26 → 10, 13; medium precision 2/12, 3/13 → 1/4, 3/6; real defects per run 2, 3 → 1, 4; same cost. Type hygiene is filed at low under `type-hygiene` |
| **Verdicts feed the work order** — triage and synthesis read `verified.json` when it exists | [#338](https://github.com/HuginnIndustries/CodeCartographer/issues/338) | **Shipped** (0.25.0): confirmed first with the trigger in the rationale, unclear kept and marked, discarded and not-a-defect listed in `omitted`; each pass records the verdicts it was built from; `collect --regenerate` re-runs a collected run's passes with them (the reset lands on disk first, since post-passes are claimed per run). Live check on a real run still owed |
| **Split `core/broadside.ts`** — 4,300 lines into lenses / repo / client / models / state / submit / collect / post-passes / render | [#339](https://github.com/HuginnIndustries/CodeCartographer/issues/339) | **Done** (#353, unreleased): `core/broadside.ts` is a barrel over fourteen modules in `core/broadside/` with an acyclic runtime import graph; exports unchanged, suite untouched. The 2026-09-15 self-audit's #371 asks for the last two structural edges to be removed and the graph pinned |
| **Concurrent-collect safety** — two collects on one run must not pay twice | [#322](https://github.com/HuginnIndustries/CodeCartographer/issues/322) | **Shipped** (0.22.2): post-passes and the retry are claimed in the run's state before submission; writes merge slot by slot; a server whose client is gone stops polling |
| **Per-language prompts** — Go/Python/Rust/TS lens prompts; globs already adapt | [#137](https://github.com/HuginnIndustries/CodeCartographer/issues/137) | **Shipped**: language profiles drive defect/conventions prompts; schemas unchanged |

## Tier 2 — integration depth

| Item | Issue | Notes |
|---|---|---|
| **Pi extension** — `/codecarto-broadside` command with lens picker and live progress | [#138](https://github.com/HuginnIndustries/CodeCartographer/issues/138) | **Shipped**: four actions with tab-completed lens picker, live per-lens progress widget, and an interactive spend confirmation in place of MCP's refuse-unless-`force` |
| **Pipeline phase** — `broadside-scout` phase feeding later phases via `required_reads` | [#139](https://github.com/HuginnIndustries/CodeCartographer/issues/139) | **Shipped**: `pipeline-scout-first.yaml`. The phase distills a run into a stable brief (run dirs are timestamped, so no YAML could name one), six phases read it, and each must confirm, dismiss, or carry forward every lead routed to it. Leads, never evidence — enforced at validation |
| **Zero-config executive** — meta-pass picks lenses and slicing resolution from repo shape | [#140](https://github.com/HuginnIndustries/CodeCartographer/issues/140) | **Shipped**: `auto` slicing collapses small repos to one slice, directory-splits large ones |

## Tier 3 — cost and coverage economics

| Item | Issue | Notes |
|---|---|---|
| **Multi-model** — DeepSeek/Anthropic batch endpoints behind the lens registry | [#141](https://github.com/HuginnIndustries/CodeCartographer/issues/141) | **Shipped**: catalog lookup, `models` action, pricing + capability pre-flight, per-lens model overrides (`lens_models`) priced, clamped, and retried per lens, and `model` / `lens_models` as submit parameters on both surfaces (Pi `--model=`, `--lens-model=`). The catalog is advisory — some `:batch` ids have no endpoint — so submits remember what OpenRouter accepted or refused and the listing tags it; the no-endpoint and job-quota refusals are explained on the lens. **Deliberately not shipped**: a stronger default for the semantic lenses, and per-model prompt tweaks — the measured variable is whether a model holds a JSON schema for 8k tokens (reasoning spend, see `reasoning:` in config.yaml), not prompt wording |
| **Incremental re-scouting** — diff against previous run's HEAD, rescan changed modules only | [#142](https://github.com/HuginnIndustries/CodeCartographer/issues/142) | **Shipped**: `incremental: true` diffs against the prior run's HEAD; dirty tree falls back to full scan |
| **CodeCartoShow pipeline stage** — BATCH-SCOUT between SELECT and the interactive run | [CodeCartoShow#1](https://github.com/HuginnIndustries/CodeCartoShow/issues/1) | `scripts/batch-analyze.py` proved it; evidence rules apply unchanged |

## Tier 4 — open questions, not commitments

| Item | Issue | Notes |
|---|---|---|
| **Headless-agent lens queue** — sync-priced, tool-using variant via `@openrouter/agent` | [#143](https://github.com/HuginnIndustries/CodeCartographer/issues/143) | **Shipped as the hybrid** (0.24.0, #331): batch sweeps, then `verify` — one sync-priced, read-only-tools pass over the top-N defect and security findings writing `verified.md` beside `triage.md`. The comparison run that settled it: the batch pass's top twelve on this repository were two real defects and ten dismissals (17%); the verifier agreed with a reviewer on all twelve for $0.13, and the rubric mattered more than the model. The full tool-using sweep was not built: the weakness was precision, and precision is a pass, not a lens |

## Principles

1. **Leads, never evidence.** Every Broad-Side artifact carries the
   disclaimer; nothing downstream may cite a Broad-Side report as fact.
2. **Coverage is spoken, not implied.** Truncations, skipped lenses, and
   unscouted scope appear in `run-meta.json` and the collect summary.
3. **Cost before submission.** Estimates are shown on submit; no silent
   spend. The live smoke script stays opt-in.
4. **The cheap model is a feature.** Gemini batch is weak but ~50% price;
   its job is to tell the expensive run where to look, not to be right.
