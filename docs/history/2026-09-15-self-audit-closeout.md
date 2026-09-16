# Closeout — 2026-09-15 — the self-audit, and CodeCartographer as its own subject

The session after the verification loop closed. Nothing was released; `main` gained a
pure refactor, a self-audit of the repository by its own pipeline, eighteen issues from
it, and a README hero that is finally this project rather than another one. The website
followed the same day.

## What landed (unreleased)

| PR | What |
|---|---|
| #353 | `core/broadside.ts` split into fourteen modules under `core/broadside/` behind the same barrel; `core/broadside-verify.ts` moved to `core/broadside/verify.ts`; import graph acyclic at runtime; exports unchanged (#339) |
| #354 | README hero: CodeCartographer's own dashboard after the full deep-audit run, rendered headlessly from `dashboard.html` |
| #373 | `self-audit/2026-09-15-v0.25.0-full-with-deep-audit/` — the run's complete output with README, REVIEW (27 findings → 18 issues), DOGFOODING (#340) |
| CodeCartographer-Website#22 | "Works with Pi natively, and any other agent harness over MCP · v0.25.0", four footers, the same hero, the terminal mock's real numbers, and the dashboard copy no longer claiming "no JavaScript" |

## The self-audit

`pipeline-full-with-deep-audit` on this repository at `a159d6c`, unattended through the Pi
extension on `ollama-cloud/deepseek-v4.1-flash` with `--auto --llm-steer`: seven phases,
every one `PASS` with coverage `COMPLETE`, 328 turns, 618 tool uses, 77 minutes, 49.7M
input tokens, no compaction. A three-minute `architecture-only` seed on `glm-5.3-flash`
sized it first and was discarded — its map was `PARTIAL` and docs-derived.

Twenty-seven findings (1 high, 10 medium, 16 low); 22 confirmed by reading, 5 external
behaviour claims about Windows and symlink timing. Issues **#355–#372**, in the order to act:

1. #358 — Broad-Side `verify` uploads file content without the redaction pass `submit` applies.
2. #355 — stale-lock breaking is racy by construction (the race #344 left one level down) and a fixed 60 s age breaks live long holders; owned tickets with pid liveness and a heartbeat.
3. #356 — `refreshScaffold` outside the status lock, non-atomic, no staging, duplicate THREAD_LOG lines.
4. #357 — library index writes without the publish lock; `list` rewrites a corrupt index.
5. thirteen lows, #359–#371, each a small fix with its trigger named; #372 asks CI to run on `windows-latest`, which is the honest answer to the four "verify at runtime" rows.

None is a regression of a #223–#279 item. The mediums cluster where the last three releases
added code and in two paths nothing had audited for locking since the lock discipline arrived.

## Decisions

- **Model choice is the coverage knob**, and the coverage disposition — not the validation
  verdict — is what tells a thin map from a full one. Size a run on a flash model; audit on
  one that reads module bodies.
- **The unattended Pi route is the self-review default now.** It needs `/codecarto-open`
  (init's confirm is headless-fatal on the template repository), the provider extension
  passed with `-e`, and `project_name` set before the dashboard is rendered. Recipe in
  `docs/self-review-prompt.md`; CONTRIBUTING points at it.
- **Findings become issues only after reading confirms them**, one issue per fix, grouped
  where one change closes several rows. `REVIEW.md` in the audit folder is the record.
- **Nothing was released.** The refactor, the folder, and the hero are not user-facing
  changes; they ride the next release, which the self-audit issues will earn.

## Open

#185 (parked) and #355–#372. Still owed when a key exists: a live `verify` →
`collect --regenerate` on a real run.
