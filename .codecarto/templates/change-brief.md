# Change brief — {{TITLE}}

<!--
Written by the framework from a change request, then read by the agent doing
the work. Everything here is grounded in THIS repository: a change that needs
no external reference is the normal case, not a degraded one.

The rule that matters: state uncertainty as uncertainty. A brief that presents
an unverified premise as settled hands the agent the confidence without the
evidence, and the agent then builds on it.
-->

**Mode:** {{MODE}}

## Requested outcome

{{REQUESTED_OUTCOME}}

## Baseline

{{BASELINE}}

The baseline identifies the tree this change was planned against. A later
attempt whose tree no longer matches it is stale, and acceptance bound to the
old tree does not carry over.

## In scope

{{IN_SCOPE}}

## Non-goals

{{NON_GOALS}}

Non-goals are as load-bearing as scope. They are the record of what was
deliberately not attempted, so a reviewer can tell a gap from an omission.

## Contracts that must not break

{{PRESERVED_CONTRACTS}}

## Acceptance scenarios

{{ACCEPTANCE_SCENARIOS}}

Each scenario needs an id, because slices reference them and proof binds to
them. A scenario no slice proves stays visible in the plan rather than being
dropped.

## Open questions — not established

{{UNCERTAINTIES}}

Anything listed here is unverified. Do not plan as though it is settled; if
the work depends on one of these, resolving it is itself a slice.
