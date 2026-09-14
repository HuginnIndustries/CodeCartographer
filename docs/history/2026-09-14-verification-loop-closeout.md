# Closeout — 2026-09-14 — the verification loop turned on the repository, and 0.24.1

The session after the live-verification day. It used the last hours of the
same day-scoped OpenRouter key ($0.83 of it) to turn Broad-Side's new `verify`
pass on CodeCartographer itself, fixed what the verified findings named
rather than filing them, measured a prompt change before adopting it, and
shipped one release — 0.24.1 — instead of one per fix.

## What shipped

| PR | What |
|---|---|
| #335 | the security and API lenses fall back when their targeted paths match no *source* file, not only when they match nothing — on this repository the security lens had been reading `SECURITY.md` alone and reporting zero findings with a coverage note saying so |
| #336 | `/codecarto-library-init` refuses an incomplete or invalid `--namespace`; `codecarto_library_init` applies the same slug rule (a `verify`-confirmed finding) |
| #337 | `applyAmendment` judges pipeline completeness on the state read under the lock (the other `verify`-confirmed finding, ranked #1 by the sweep) |
| #341 | the defect lens asks the scan for the trigger up front, and files type hygiene at severity low under `type-hygiene` — adopted on the measurement below |
| #344 | every lock removal happens under a removal lock (`<lock>.break`) and re-verifies what it removes there, so two waiters breaking one stale lock cannot both take it (#342 — found by the measurement's own runs) |
| #345 | the 30 s phase linger timer clears only the run it was scheduled for (#343 — likewise) |
| #346 | release 0.24.1 |

## The measurement

The question was whether the rubric that took `verify` from 17% to 12/12
agreement — *a finding is a reachable failure; name the trigger; a cast every
caller satisfies is not a defect* — belongs in the batch prompt itself. Two
runs per arm on this repository at `bcb34ba`, `google/gemini-3.7-flash:batch`,
defect lens only, every medium-severity finding judged by hand against the
source before the verifier's verdicts were read.

| arm | findings (medium / low) | true at medium | real defects | cost |
|---|---|---|---|---|
| previous prompt, run 1 | 24 (12 / 12) | 2/12 | 2 | $0.102 |
| previous prompt, run 2 | 26 (13 / 13) | 3/13 | 3 | $0.104 |
| rubric, run 1 | 10 (4 / 6) | 1/4 | 1 | $0.097 |
| rubric, run 2 | 13 (6 / 7) | 3/6 | 4 | $0.096 |

Half the volume, roughly double the top-of-list precision, the same real
defects per run on average, the same cost — and either prompt misses a real
defect on some runs. The batch pass is a sample; `verify` and a second run are
the insurance. `verify` agreed with the hand judgment on 11/12 of each
second-sample run; its two extra "confirmed" verdicts were hypotheticals no
caller reaches (a pre-aborted signal; a `./`-prefixed `primary_output`), which
is the rubric's known soft edge. n = 2 per arm on one repository: the direction
is consistent, the magnitude is not a measurement.

Four real defects surfaced across the four runs: the amendment lock (#337), the
`--namespace` flag (#336), the stale-lock break race (#342 → #344), and the
linger timer (#343 → #345). The live check of #335 read 40 source files where
0.24.0 had read one, and its 21 unverified leads seed #340.

## Decisions

- **A prompt change is gated on a number**, and the release was held for it.
  The recipe is in CONTRIBUTING (two arms, one target checkout, hand-judged
  mediums, ~$0.40).
- **Fix what `verify` confirms in the same cycle.** The sweep found it, the
  verifier kept it, the maintainer fixed it — three PRs in an hour.
- **One release for the batch, not one per fix.** Six releases in a day was a
  lot to ask users to track; 0.24.1 carries six changes.
- **Rename-then-rm does not fix a stale-break race** — a rename takes whatever
  inode is at the path at that instant, a fresh lock included. Removals have
  to be serialized and re-verified under their own lock; creation is already
  exclusive, so what a remover verified is what it removes.
- **The fallback trigger is "no source file", not "no file"**: a policy
  document under a targeted path satisfies the globs and starves the lens.
- Filed, not fixed: #338 (triage and synthesis consume `verified.json`),
  #339 (split `core/broadside.ts`), #340 (the full self-review on the
  maintainer's own model, seeded with the security-lens leads), #347 (the auto
  loop's stop reason is invisible under `pi -p`). #185 stays parked.

## Verification recipes established

- **Pi on a provider registered by your own extension:** `pi -ne` disables
  extension discovery, so the provider extension goes on the command line too —
  `script -qec "pi -ne -e ~/.pi/agent/extensions/<provider>.ts --model <provider>/<model> -e <tarball dist ext> -p '/codecarto-init architecture-only' '/codecarto-next --auto'" /dev/null`.
  Without it every `--model` pattern fails with "No models match".
- **When the auto loop stops short under `-p`**, the reason is in the
  auto-summary message, not the notification (#347); reproduce a completion
  refusal with `validatePhaseOutput` + `completeValidatedPhase` from the
  tarball's `dist/core/index.js`. On the 0.24.1 check `glm-5.3-flash` wrote a
  duplicate `post_pipeline:` key in its handoff and the parser refused it, as
  it should.
- **Codex:** as before, plus `-c 'mcp_servers.aws-mcp.enabled=false'` when
  that server is registered; a round trip is ~19k tokens.
- **Measuring a lens prompt:** see CONTRIBUTING, "A lens prompt change is
  measured, not eyeballed."

## Files

CONTRIBUTING.md (the Pi row and the measurement recipe), ROADMAP.md (Tier 1
rows for #341, #338, #339 and the #319 extension; the #143 row marked shipped
as the hybrid), CHANGELOG.md (the 0.24.1 block), `.codecarto/broadside/SKILL.md`
(the no-source fallback and the `type-hygiene` reading note).
