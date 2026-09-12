# Conventions

<!--
  Project-level skeleton. Copy this to `.codecarto/CONVENTIONS.md` (one level up from templates/)
  the first time the orchestrator promotes a convention. Then add entries as they accumulate.

  This file holds cross-cutting patterns that have been promoted to project-wide invariants.
  Every new session reads this file and either honors these conventions or documents why it
  diverges.

  This file is **orchestrator-maintained**. Phase executors propose additions in their session
  closeout; the orchestrator promotes them at the phase boundary. In an inline run the same chat
  does both — the rule is about *when* (between phases, deliberately), not about which thread.
-->

Cross-cutting patterns promoted to project-wide invariants. Every session reads this file at start
and either honors these conventions or documents why it diverges.

This file is **orchestrator-maintained**. Phase executors propose additions in their closeout's
"Proposed Conventions" section; the orchestrator promotes them here at the phase boundary — in an
inline run, the same chat changing hats between phases.

## How conventions get added

A new entry lands here when ONE of the following holds:

1. **Three independent sessions** reach for the same pattern (the "lift if it generalizes" rule
   applied to conventions themselves), OR
2. **One session** explicitly promotes a pattern in its closeout report and the orchestrator
   confirms it generalizes, OR
3. **The spec or framework feedback corpus** identifies a project-wide invariant that future
   implementing sessions need to know about.

The orchestrator owns this file. Implementing sessions propose; orchestrator promotes.

## Entry shape

Each convention is a numbered section (`## C<NN>. <Title>`) with three required parts:

- **Body** — the rule itself, in prose. May include a code block for shape contracts.
- **Why:** — the reason the rule exists. Often a past incident or a defect class the rule
  prevents. Future maintainers judging edge cases need to know *why* to judge whether the rule
  applies.
- **How to apply:** — when and where the rule kicks in. Should answer "is this case in scope?"

Optional:
- **Current implementers:** — files/modules that already follow the rule. Useful as worked examples.
- **Source:** — the closeout entry where the orchestrator promoted this convention.

---

## C01. Cheap runtime probe before severity

When a finding rests on how a parser, serializer, normalizer, or path helper treats a specific input, run a one-line probe against the module before assigning severity and evidence level, and cite the probe output in the finding. A probe that takes under a minute is not optional evidence; it is the difference between `strong inference` and `observed fact`.

**Why:** In the mechanical scan, reading alone left three findings about `core/yaml.ts` and `core/status.ts` at `strong inference`; four probes settled all three as `observed fact` (one as a hard crash) in under a minute. The framework's own evidence discipline says an unsettled level must carry an unsettled action, so a skipped probe costs the finding its `fix before porting` action for the rest of the pipeline.

**How to apply:** Any finding whose Defect cell says "parses as", "serializes as", "resolves to", "treats X as Y", or "falls back to". Load the module with `node --experimental-strip-types` (no build needed in this repo), call the function, paste the result into a `§Runtime probes` section of the report, and reference the probe from the finding. Not for claims about external systems (OpenRouter, the Pi runtime): those need a probe against that system or a read of that system's own source, and stay `external-behavior claim` until then.

**Current implementers:** `findings/defect-scan-mechanical/mechanical-defects.md` §Runtime probes.

**Source:** closeouts/2026-09-12-defect-scan-mechanical.md; promoted at the mechanical → contracts boundary.

---

<!-- Repeat the C<NN> block for each convention. Number sequentially. -->

## Pending proposals

Staged by completion from each phase handoff's `proposed_conventions`. The orchestrator promotes an entry into a numbered convention above (or removes it with a note) at the phase boundary — see GUIDE.md §Roles.

- cheap-runtime-probe-before-severity (defect-scan-mechanical, 2026-09-12): promoted as C01 at the contracts boundary.
