---
name: traverse
description: Run the supervised change loop for an engineering change — intake, plan, attempt, ingest observations, review, and present for human acceptance. Use this when a repository needs a bounded, resumable change tracked as evidence rather than an ad-hoc edit. CodeCartographer records and refuses; the host executes. Unlike the analysis pipeline, this is available without a completed pipeline, because a fix can be the whole reason someone opened the repository.
---

# Traverse: the supervised change loop

You are working on a change that CodeCartographer is keeping records for. This
document is the procedure. **It is prose, and prose is not enforcement** — the
refusals described here live in `core/engineering/`, and this document can only
tell you what they are. If this text and the code ever disagree, the code wins
and this document is a bug.

## What this loop is for

A change moves through a fixed shape: intake, plan, attempt, observe, review,
accept. The records exist so that a session that dies in the middle can be
picked up by a different agent, on a different machine, a week later, and reach
the same next action. That only works if you write down what you did.

**CodeCartographer never executes anything.** It does not run your build, your
tests, or your migration. You do. It records what you report and refuses
conclusions the records do not support.

## Intake

Before any work: a change record must exist, with a mode (`fix`, `feature`,
`refactor`, `migration`, `investigation`), a requested outcome in plain words,
and a baseline that identifies what you started from.

A `fix` asserts a defect exists. If you have not confirmed the defect — seen it
fail, not merely been told it fails — the honest mode is `investigation`.
Recording a fix for a defect nobody confirmed is how a change gets accepted for
solving a problem that was never there.

## Readiness

Ask `codecarto_change` for the next step and it will tell you one action. Before
you take it, check what the loop needs against what you actually have:

- **Bounds.** The loop refuses to plan at all unless you declare `max_attempts`
  and `max_wall_clock_ms`. There is no default. A loop that picks a limit for
  you hides that you never picked one.
- **Execution.** If you cannot run the work, say so (`can_execute: false`) and
  the loop stops instead of asking you to attempt something you cannot do.
- **A human.** If you have no way to reach a person for a decision, say so
  (`can_obtain_human_decision: false`). The loop will stop at the point a human
  is required rather than proceeding without one.

Declaring a capability you do not have is the one thing that breaks this
system quietly. Nothing here can check your claim.

## Execute

The loop tells you to start or resume an attempt; then **you** do the work.

The rule that matters: **an attempt already recorded as `running` is resumed,
never restarted.** If you asked to start an attempt and never saw the response,
ask for the next step again — if the attempt was recorded, you will be told to
resume it, and you will not run the migration a second time. Every step carries
an `idempotency_key` derived from the records, not the clock: the same
situation yields the same key, so you can recognise your own retry.

Record the baseline before you change anything, and the candidate after. A
candidate you cannot identify is a candidate nobody can review.

## Ingest

Report what you observed, in the words the observation actually supports.

A check that did not run is not a check that passed. A proof you send through a
tool call is recorded as **claimed**, and claimed proof discharges nothing — it
is a note that you say something happened, not evidence that it did. Authority
comes from what collected the observation and how it was attested, never from
what the payload asserts about itself.

If an earlier observation was wrong, record a new one that supersedes it. The
earlier record is never rewritten.

## Review

Review is of **these exact bytes**. A review of an earlier candidate does not
carry forward: change the code, and the review is stale.

Objections have severities, and a blocking objection must be closed with a
disposition before acceptance can be offered. "I disagree" is not a
disposition; what changed, or why the objection does not apply, is.

## Acceptance

**You cannot accept your own work.** The gate decides whether acceptance may be
*offered*; a person decides whether it is *given*. The loop will tell you to
present the candidate and wait.

Present what was actually built, and wait for a real answer. Do not record a
decision nobody made — a fabricated acceptance is the single worst thing that
can enter these records, because everything downstream trusts it.

If the gate says the work is not ready, it will name what is missing:
unproved obligations, open blocking objections, a stale or missing review, a
dependency that is not itself accepted. Fix the named thing.

## Stopping and resuming

The loop stops for exactly one of these reasons, and says which:

| Stop reason | What it means | What clears it |
| --- | --- | --- |
| `unknown-change` | No such change is recorded | Intake it first |
| `change-concluded` | Already accepted or abandoned | Open a new change |
| `attempt-budget-exhausted` | Failures reached `max_attempts` | A person decides whether to raise the budget or stop |
| `host-cannot-execute` | The next action needs execution you declared you cannot do | A host that can execute |
| `host-cannot-obtain-human-decision` | Acceptance needs a person you cannot reach | A host with a channel to one |
| `awaiting-human-decision` | Presented; waiting | The person answers |
| `blocked-needs-operator` | An external thing is broken | A person clears it |

A stop is not a failure. It is the loop declining to continue without something
it does not have.

**To resume**: ask for the next step again. The answer is computed from the
records alone, so a new session reaches the same action as the one that died,
and it will tell you what it resumed from and what failed before.

## What this document cannot do

It cannot make you honest. Every refusal in the code assumes your *reports* are
truthful; none of them can verify that the check you say you ran actually ran,
or that the person you say accepted the change actually did. The records are
only as good as what you put in them.
