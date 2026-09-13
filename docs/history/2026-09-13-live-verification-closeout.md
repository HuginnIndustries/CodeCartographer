# Closeout — 2026-09-13 — live verification and the 0.22.x/0.23.0 releases

A maintainer session that closed the open-issue board and then, with a day-scoped
OpenRouter key, ran the framework against real providers for the first time in
six releases. Five releases shipped from it: 0.22.0 (the last four open issues),
0.22.1 and 0.22.2 (what the live runs found), 0.22.3 (a Pi completion bug
reported from a real session), 0.23.0 (#319). ~$0.95 of the key was spent.

## What shipped

| Release | PRs | What |
|---|---|---|
| 0.22.0 | #314–#317 | truncation retry batched per model (#206); `model`/`lens_models` on both surfaces, advisory model catalog with per-repo endpoint memory, explained refusals (#141); Codex verified headlessly via `mcp_servers.<name>.default_tools_approval_mode` (#218); the repository's own `.codecarto/` state made pristine, framework history moved here (#276) |
| 0.22.1 | #320, #321 | reasoning `effort: low` by default and on retry; headless Pi submit behaves like MCP; both-reasoning-keys refused; skipped lens names its globs; batch-less run marked failed; dialog's incremental line; MCP wait output deduplicated |
| 0.22.2 | #324 | claims before spending on a run's post-passes and retry; merging writes; a server whose client is gone stops polling; in-flight passes in the report (#322) |
| 0.22.3 | #326 | a `/codecarto-*` completion keeps the arguments typed before it |
| 0.23.0 | #328 | security and API lenses fall back to every source file when their targeted globs match nothing (#319) |

## What the live runs found that mocks could not

1. **Gemini 3.x ignores `reasoning.max_tokens`.** Under a 5,800-token cap, `google/gemini-3.8-flash:batch` reasoned 5,218 tokens, then 11,518 on the doubled-budget retry — both truncated, the retry costing twice the original for no JSON. `effort: low` reasoned 0 tokens, returned valid JSON, and cost a twelfth as much. The default changed to `effort: low`; the retry forces it.
2. **OpenRouter refuses `reasoning` carrying both `effort` and `max_tokens`** — per request, after accepting the batch, so every lens failed at $0. The shipped config comment showed the two keys together.
3. **A headless Pi Broad-Side submit could never fire**: the confirm stub under `pi -p` answers "no".
4. **Two collects on one run paid for synthesis and triage twice**, because an MCP server whose client's request timeout fired kept polling and spending — the SDK's stdio transport (v1 and v2 alike) never notices stdin ending.
5. **The security lens skipped the repository it existed for** (`src/server.js` outside `server/**`).
6. A run reported "completed" with no mention of a synthesis batch still running; post-passes were polled in turn.
7. A Pi completion erased earlier flags because Pi replaces the whole argument text with an accepted item's value.

## Decisions

- **Low reasoning effort is the default control**, not a token cap: it is the one vocabulary OpenRouter translates for every provider. Never `enabled: false` (refused outright by some endpoints).
- **Spending slots are claimed in state before the network call** (`claimRunSlot`); writes inside collect merge slot by slot rather than replace the run.
- **A fallback scan is priced as a real scan** and said so on the estimate; `max_cost` is the guard, not a silent cap.
- **The Codex row is verified per release** with the per-server approval key; the Pi row with a real model on the tarball's built extension.
- Left open by decision: #185 (SDK v2 — no stdio client sends `server/discover`; re-check per release with a stdin tee) and #143 (verification pass — needs a funded comparison run on a real repository).

## Verification recipes established

- Pi phase round trip: `script -qec "pi -ne --model openrouter/google/gemini-3.7-flash -e <dist ext> -p '/codecarto-init architecture-only' '/codecarto-next --auto'" /dev/null` (~$0.25).
- Codex: `codex exec --ephemeral --skip-git-repo-check -s read-only` with `mcp_servers.<name>.default_tools_approval_mode="approve"`, pointed at the tarball's `bin.mjs`.
- Broad-Side: drive the tarball's server over stdio with a client timeout longer than `wait_seconds`; read OpenRouter's batch list for the run (`GET /api/beta/batches?limit=10`) — it is the only place a duplicate submission shows.
- The #322 reproduction: a 30 s client timeout on a submit-with-wait, then a second collect; the server must exit within seconds and the batch list must show one post-pass pair.

## Filed, not fixed

- #319 was fixed the same day (0.23.0). Nothing else remains from this session.

## Files

CONTRIBUTING.md (surface-verification table and the live Broad-Side recipe), ROADMAP.md (Tier 1 and Tier 4 rows), docs/client-surfaces.md (Codex row), CHANGELOG.md (five entries), .codecarto/broadside/config.yaml and SKILL.md (reasoning block, lens scopes), README.md and docs/mcp-quickstart.md (model selection, wait bound, fallback), this file.
