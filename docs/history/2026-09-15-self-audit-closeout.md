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

## Outcome — 2026-09-16

The batch shipped as **v0.26.0** the next day (PRs #375–#392, release #396). Every issue was
re-verified against the code before it was touched, and the verification changed the outcome
three times:

- **Sixteen fixed.** Fourteen landed with a test that fails on the previous code — #358
  `verify` redaction, #355 the lock redesign (per-waiter tickets, bakery numbers, pid
  liveness, a heartbeat; the `.break` removal lock is gone), #356, #357, #359, #360, #361,
  #365, #366, #367, #368, #369, #370, #371. The other two turned out to be words rather than
  code: #362 is a one-liner with the fix pinned at the source, and #364 was a *correct*
  narrower guard with a wrong comment and README line, so the docs changed and a test now
  pins the behaviour they describe.
- **#363 closed as designed**, with the evidence: `tests/pi-extension-activation.test.mjs`
  pins that the write guard is off until `/codecarto-open`, because a repository that ships
  `.codecarto/` must not silently sandbox every Pi session opened in it, and no phase can
  start before activation anyway.
- **#372 became the `test-windows` job** (reporting, not gating), and its first run answered
  the four "verify at runtime" rows: 925/935. Two are product defects — #393 concurrent
  `atomicWriteFile` renames fail with `EPERM` on Windows (the audit's one *high*, confirmed),
  and #394 the write guard refuses a phase's own `.codecarto/findings/…` write, so the Pi
  surface does not work on Windows at all. Eight are POSIX-shaped test expectations (#395).
  The other two rows (the lock's `O_EXCL`/mtime assumptions, `git` output parsing) produced
  no failure, which is as far as a passing suite can settle them.

Two corrections of the batch's own work came out of the same discipline: the first lock
rewrite (#376) took wall-clock ticket numbers and its own suite showed a same-millisecond
double hold one run in three, so #379 takes bakery numbers (`max + 1` of what a waiter can
see); and the layer order the #353 barrel documented was aspirational, so #391 pins the
measured one in `tests/module-graph.test.mjs`.

Release verification on the tarball from a clean `dist/`: MCP smoke 9/9 and a round trip;
a Pi phase on `deepseek-v4.1-flash` (19 turns, PASS, no lock tickets left behind); a Codex
round trip.

## Open

#185 (parked) and the Windows batch the job surfaced: #393 (retry the rename on
`EPERM`/`EBUSY`/`EACCES` with a bounded backoff; the failing test is the reproduction),
#395 (make the eight expectations platform-neutral), #394 (needs a run on Windows with both
resolved paths printed before a fix is chosen); then `continue-on-error` comes off the
`test-windows` job. Each is proven by that job's log rather than locally. Still owed when a
key exists: a live `verify` → `collect --regenerate` on a real run.
