# Traverse record — change `<chg_...>`

A written trace of one supervised change. Fill it as you go, not at the end:
its purpose is that someone else can pick this up cold.

## What this change is

- **Change id**: `chg_...`
- **Mode**: `fix` | `feature` | `refactor` | `migration` | `investigation`
- **Requested outcome**: what someone asked for, in their words.
- **Baseline**: commit / `vcs: none` — what this started from.
- **Confirmed defect** (fix only): how it was observed failing. If this is
  empty, the mode is wrong — use `investigation`.

## Host declaration

What the executing host said it could do, and when.

| Capability | Declared | Notes |
| --- | --- | --- |
| `can_execute` | | |
| `can_obtain_human_decision` | | how a person is actually reached |
| `max_attempts` | | |
| `max_wall_clock_ms` | | |
| storage boundary | | |

Nothing verifies these. A wrong declaration here is invisible to the records.

## Slices

| Slice | Intent | State |
| --- | --- | --- |
| `slc_...` | | |

## Attempts

One row per attempt, in order. Attempts are immutable: a corrected observation
is a **new** record that supersedes the old one, never an edit.

| Attempt | Outcome | Candidate | What happened |
| --- | --- | --- | --- |
| `att_...` | `running` / `failed` / `blocked` / `ready-for-review` / `needs-human-acceptance` / `accepted` / `superseded` | `snp_...` | |

For each `failed`: the failure summary as recorded.
For each `blocked`: the block reason, and who can clear it.

## Observations

What was actually run, and what it returned. A check that did not run is not a
check that passed.

| Check | Ran at | Result | Authority |
| --- | --- | --- | --- |
| | | | `claimed` / observed by a collector |

Proof arriving through a tool call is **claimed** and discharges nothing.

## Review

- **Reviewed candidate**: `snp_...` — must be the exact bytes below.
- **Reviewer context / separation**:
- **Objections**:

| Objection | Severity | Disposition | Closed by |
| --- | --- | --- | --- |

A blocking objection needs a disposition, not an opinion.

## Acceptance

- **Gate outcome**: `may-offer` / `needs-human-acceptance` / `refused` + reason
- **Presented to**: a person, by name or handle
- **Decision**: exactly what they said, and when
- **Receipt**:

Never fill this in on someone's behalf. Everything downstream trusts it.

## Stops

Each time the loop stopped, and why. One of:

| Stop reason | When | What cleared it |
| --- | --- | --- |
| `unknown-change` | | |
| `change-concluded` | | |
| `attempt-budget-exhausted` | | |
| `host-cannot-execute` | | |
| `host-cannot-obtain-human-decision` | | |
| `awaiting-human-decision` | | |
| `blocked-needs-operator` | | |

## Resumption log

Every time a new session picked this up: when, what it resumed from, and
whether the next action matched what the previous session expected. A
disagreement here means the records lost something.

| Session | Resumed from | Next action | Agreed? |
| --- | --- | --- | --- |

## What is still not established

The honest list: what this change has NOT shown. Unproved obligations, checks
nobody ran, environments nobody tried. A change can be accepted with gaps; it
should not be accepted with *hidden* gaps.
