# Backlog

Project-level deferrals: work this project decided **not** to do yet, with the reasoning
that made deferring the right call. One entry per deferral.

This is the project's backlog, not CodeCartographer's. Items about the framework itself —
a phase prompt that misled you, a validation criterion that does not fit — belong in
feedback to the framework, not here.

**BACKLOG vs DECISIONS.** `DECISIONS.md` records what the project decided to **do**;
this file records what it decided to **defer**. Deferrals get no `D` number. If a deferred
item is later picked up, remove its entry here and record the decision in `DECISIONS.md`.

## Format

```
## <ID>. <Short title>

**Raised by:** <closeout file, phase, or DECISIONS.md entry that produced this deferral>

**Why deferred:** <the reasoning — what made this not worth doing now, not just "later">

**Preconditions:** <what has to land before this can be revisited: a module, an artifact,
a decision, an answer to an open question. "None" is a valid answer, but say so.>

**Smallest viable form:** <the least you could build that would settle the item, so whoever
picks it up does not have to redesign it from scratch>
```

## Entries

<!--
  Append entries below this marker. Number them however the project prefers (B1, B2, … is
  the convention the framework's own backlog uses).

  Example:

  ## B1. Retry policy for the upload path

  **Raised by:** closeouts/2026-03-14-contracts.md

  **Why deferred:** The contracts phase found no documented retry behavior, but nothing
  downstream depends on knowing it — the porting phase can treat uploads as at-most-once
  and flag the gap.

  **Preconditions:** A protocols-phase answer on whether the server deduplicates by
  request id. Without that, any retry policy written here is a guess.

  **Smallest viable form:** One paragraph in the contracts report stating the observed
  behavior and the assumption downstream phases should hold.
-->
