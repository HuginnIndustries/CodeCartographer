# Change plan — {{TITLE}}

<!--
The executable half of a change: what gets built, in what order, and what
would prove each piece.

A slice that proves nothing is not planning. Every slice names at least one
acceptance scenario from the brief and carries the obligations that would
discharge it.
-->

## Slices

{{SLICES}}

Each slice above carries:

- **Delivers** — the one reviewable artifact this slice produces.
- **Proves** — which acceptance scenarios from the brief it claims.
- **Depends on** — other slices that must land first. Dependencies must form a
  DAG; a cycle is a plan with no executable first step and is refused.
- **Proof obligations** — what would establish the claim, each with a minimum
  collector. `agent-claimed` is never an acceptable minimum: an obligation
  whose weakest evidence is the agent's own word is not an obligation.

## Unproved acceptance scenarios

{{UNPROVED}}

A scenario listed here is not proved by any slice in this plan. That may be
deliberate — deferred, out of scope for this pass, or covered elsewhere — but
it is stated rather than left to be noticed by its absence.

## Execution readiness

{{READINESS}}

A plan naming a `test` obligation in a workspace with no test command is not
executable. Saying so here costs one line; discovering it at proof time costs
the attempt.

<!--
Not in this template: deriving slices from an existing reimplementation spec
or project plan. That seam belongs to E09 and is not implemented. Analysis
artifacts may be attached to the brief as disclosed context, with staleness
marked, but nothing reads their content to generate a plan.
-->
