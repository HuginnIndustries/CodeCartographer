# Orchestration

The orchestrator is the persistent chat driving the run — normally the session reading this guide. The role is defined by **duties**, not by who executes phases. A single chat that runs every phase itself and performs the duties below is fully orchestrated; a fleet of delegated sub-agents whose driver skips them is not.

## The duties

All of them happen at the **phase boundary**: after one phase completes, before the next begins. None of them happen mid-phase — a phase executor follows its SKILL.md; the orchestrator judges between phases.

1. **Promote conventions and append decisions.** Phase closeouts carry "Proposed Conventions" and "Decisions Beyond Prompt" sections; handoffs carry a `decisions` array. Promotion into `CONVENTIONS.md` (when a pattern recurs or clearly generalizes) and `DECISIONS.md` (every cross-cutting decision, numbered, append-only) is your call to make at the boundary. Proposals left in closeout prose are proposals lost — a real seven-phase run stranded ~12 proposed conventions and 23 decisions this way, because nobody held the duty.

2. **Re-triage open-question labels.** An `open_questions` entry's `kind` is itself a claim that needs evidence. Before accepting `needs-maintainer-decision` or `needs-runtime-test` into the next phase, re-test: *has this become answerable by reading?* Labels are sticky — the routing machinery faithfully carries a question forward, but nothing re-examines whether the label was right, so a mislabel suppresses verification for the rest of the pipeline.

3. **Sweep for contradictions.** Compare the incoming phase's required reads against earlier phases' `owner_notes`. A measured fact that contradicts a summarized claim (a line count that belies "this layer is pure configuration", a schema that admits a value a doc says is impossible) is a gap to route — into the next phase's work, an `open_questions` entry, or a correction — not a nuance to smooth over.

4. **Route gaps.** Confirm the completed phase's declared secondary outputs were written or explicitly routed to a later phase. Confirm any handoff decision that *defers* work names a place a later phase will actually look. A deferral recorded only as prose in a decision entry goes nowhere: the same seven-phase run deferred a declared secondary output via a handoff decision, and it was silently dropped.

5. **Gate strategic forks with the user.** Pipeline switches, the opinionated-vs-language-agnostic spec choice, scope changes, force-reinit. These are the user's calls; your job is to surface them at the right moment with a recommendation.

## The failure this section exists to prevent

In a real `full-with-deep-audit` run, the architecture phase recorded an open question — "is the absence of authentication on the web surface intended?" — labeled `needs-maintainer-decision`, on the stated ground that a threat model is not derivable from code. The label was wrong: the shipped launcher *refuses* non-loopback binds in code, with the reason in the error string, and five minutes of reading would have answered the question. But the label was never re-examined. The question rode the carry-forward machinery through four phases (`arch-OQ2` → `dss-OQ3` → `port-OQ1` → `spec-OQ1`), and its unverified premise hardened into a wrong high-severity security finding that survived into the final reimplementation spec — corrected only because the user happened to ask about it directly afterward.

Two duties would each have caught it: re-triage (duty 2) would have re-tested the label at any of four boundaries; the contradiction sweep (duty 3) had the evidence in hand, since the run's own notes contained both "the launcher owns only composition selection" and "no enforcement exists anywhere."

## Execution strategies

How the orchestrator and executor roles map onto threads is a per-run choice, orthogonal to the duties:

- **Inline** — you execute phases yourself. The normal mode for a single chat driving the MCP tools; also the right mode when the user asks one thread to do everything. Perform the duties between `codecarto_complete` and the next `codecarto_next`.
- **Delegated** — you dispatch each phase to a separate execution context (the Pi extension's phase sub-agents do this automatically; on other hosts, fresh threads run prompts you draft) and review each closeout. Keeps phase context out of your window, which matters on long pipelines and small context budgets. Same duties, same boundary.

Mixing is normal: delegate the wide-read phases, run the synthesis phases inline where your judgment is the value. See `references/executors.md` for choosing per phase.

## The session-by-session fallback

Running each phase in an isolated session with nobody holding the duties is a **fallback, not a peer mode**. Its costs are the failures above: empty `CONVENTIONS.md`, stranded proposals, unchallenged labels, dropped deferrals. It is legitimate in exactly two cases:

- the user explicitly declines orchestration, or
- the driving model cannot sustain cross-phase context.

Record the reason in the first handoff's `owner_notes` so a later session knows the mode was chosen, not defaulted into.

## First run on a fresh workspace

Adopt the orchestrator role by default — do not interview the user about whether orchestration should happen. Seed `CONVENTIONS.md` and `DECISIONS.md` from their templates if missing, pick the execution strategy from the situation (single MCP chat → inline; sub-agent host → delegated), and note the strategy in the first handoff's `owner_notes`. Ask the user only when their instructions genuinely conflict with both defaults, and never under an `--auto` run, which must not block on questions.
