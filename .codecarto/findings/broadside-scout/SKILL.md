---
name: broadside-scout
description: Distill a completed Broad-Side batch reconnaissance run into a routing brief the later phases read. Runs first, before architecture, in the scout-first pipeline. Produces leads with a target phase for each — never findings, never evidence.
---

# Broad-Side Scout

This phase turns a Broad-Side batch reconnaissance run into a **routing brief**:
a short document that tells each later phase where to spend its attention
first. It runs before architecture, and everything downstream reads it.

The source code to analyze is in the parent directory (`../` relative to
`.codecarto/`).

## This phase spends no money

Broad-Side itself is fired by `/codecarto-broadside submit` (Pi) or
`codecarto_broadside` (MCP), and it is priced and confirmed there. This phase
only reads what those already wrote under `broadside/<run>/`. It never submits
a batch, and it must never instruct anyone to.

If no run exists, that is a legitimate outcome — see "When there is no run."

## What you are reading, and what it is worth

Broad-Side findings are **unverified scouting signals** produced by a cheap
batch model in a single shot: no cross-file traversal, no runtime
verification, no builds, no tests, no follow-up questions.

The entire value of this phase is routing attention. The entire risk is that a
lead gets copied forward as a fact. So the brief you write is a list of
*places to look*, each addressed to a phase, and every entry carries the
source pointer that phase must confirm for itself.

Nothing you write here is evidence. No later phase may cite this brief, or any
file under `broadside/`, as a source for a finding. A later phase cites the
code it confirmed.

## Reading the run

1. Find the most recent run directory under `broadside/`. If several exist,
   use the newest and say which one you used.
2. `broadside/<run>/synthesis.md` — the executive summary, severity counts,
   top cross-lens findings, per-module risk. Start here.
3. `broadside/<run>/triage.md` — the same findings scored by impact ×
   difficulty into a P0–P3 order with effort estimates.
4. `broadside/<run>/run-meta.json` — which lenses ran, at what cost, with what
   coverage caps. This is where you learn what was *not* scanned.
5. The per-lens files only when a lead matters enough to need its detail.

## Routing

Each lead goes to exactly one phase. Use the lens it came from as the default
routing, and override when the content says otherwise:

| Lens | Default target phase |
|---|---|
| architecture | `architecture` |
| api | `contracts`, or `protocols` for wire formats |
| security | `defect-scan-semantic` |
| defect | `defect-scan-mechanical` |
| porting | `porting` |
| conventions | none — these are candidates for the orchestrator's `CONVENTIONS.md`, not a phase |

A lead you cannot route to a phase in the active pipeline is not a lead for
this run. Drop it and say you dropped it.

## Cutting the list down

A brief that forwards everything routes nothing. Keep the leads that would
change where a phase starts looking, and drop the rest. Two filters:

- **Would this phase find it anyway in its first pass?** If yes, it is not
  worth a lead — the phase's own rubric already covers it.
- **Is it specific enough to check?** A lead without a file or a module is not
  actionable. Note the theme in coverage notes instead of forwarding noise.

Prefer 3–8 leads per target phase. If a lens produced far more than that, say
so in the coverage notes and forward the strongest.

## Coverage is spoken, not implied

`run-meta.json` records truncated slices, skipped lenses, and coverage caps.
Everything outside the sweep is **unscouted, not clean**, and the brief must
say which parts of the repository were never looked at. A later phase that
reads "no leads for module X" must be able to tell "the scout found nothing
there" from "the scout never looked."

## When there is no run

If `broadside/` holds no completed run, do not submit one and do not stall the
pipeline. Write the brief with an empty lead table, state plainly under
Coverage and limits that no run exists and therefore no module was scouted
(coverage disposition `NONE`), and validate the coverage criteria against that. Every later phase then proceeds on its own
rubric, exactly as it would in a pipeline without this phase.

## Output

Write the brief to the primary output using
`templates/broadside-scout-brief.md`. Keep it short: it is read at the top of
six later phases, and every line costs each of them context.
