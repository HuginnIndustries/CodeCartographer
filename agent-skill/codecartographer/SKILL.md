---
name: codecartographer
description: Drive the CodeCartographer MCP server to reverse-engineer a repository or synthesize a new project through validated analysis phases. Use when asked to run CodeCartographer, analyze or reverse-engineer a codebase, produce architecture/contracts/protocols/defect/porting/reimplementation artifacts, or operate a .codecarto/ workspace.
version: 1.0.0
license: MIT
---

# Driving CodeCartographer

CodeCartographer is a pipeline state machine, not an agent. It hands you a phase prompt, checks the artifact you produce against that phase's criteria, and gates completion. **It never reads your repository and never writes your findings** — you do that.

Three roles, and you hold two of them:

| Role | Who | Does |
|---|---|---|
| State machine | the MCP server | phase order, prompts, validation parsing, completion gate, canonical state |
| Orchestrator | you | pick the pipeline, drive the loop, choose an executor, verify, and hold the cross-phase duties (`references/orchestration.md`) |
| Executor | you, or a model you delegate to | read the repo, write the phase artifact |

Being the orchestrator does not preclude executing phases yourself — a single chat driving these tools inline is the normal case, and it holds both the Orchestrator and Executor rows. What makes a run orchestrated is performing the phase-boundary duties (convention promotion, open-question re-triage, contradiction sweeps, gap routing), not delegating the work. If the workspace `GUIDE.md` predates this contract and says the orchestrator must not execute phases, trust this guide.

## The drive loop

```
codecarto_status  →  codecarto_init (first time only)
                          ↓
        ┌──────── codecarto_next ────────┐
        │              ↓                  │
        │         execute the phase       │
        │       (write primary output)    │
        │              ↓                  │
        │      write the phase handoff    │
        │              ↓                  │
        │       codecarto_validate        │
        │              ↓                  │
        │       codecarto_complete        │
        └───────── repeat until ──────────┘
             status reports "complete"
```

0. **`codecarto_broadside`** — optional, and only worth it on a repository too large to read directly. A cheap batch reconnaissance sweep that produces unverified leads telling the pipeline where to look, before you commit to a pipeline choice. Costs real money and is priced before it fires — `references/broadside.md`.
1. **`codecarto_status`** — always start here. It reports the active pipeline, progress, next action, and any scaffold-staleness warning. Every tool takes an absolute `cwd` pointing at the target repository.
2. **`codecarto_init`** — only when no `.codecarto/` exists. Choose the pipeline deliberately (see `references/pipeline-selection.md`). Never pass `force: true` without the user's explicit approval; it moves an existing workspace, findings and all, to a backup directory.
3. **`codecarto_next`** — returns the prompt for the next eligible phase. It returns *text*; it does not execute anything. Use `codecarto_phase` only to force a specific phase out of order, and only when the user asked for that.
4. **Execute** — see "Executing a phase" below.
5. **Write the handoff** — see "The handoff contract" below. This is the step integrations most often miss, and completion now refuses without it.
6. **`codecarto_validate`** — parses the validation block you appended to the primary output. Returns `PASS`, `PASS WITH GAPS`, `FAIL`, or `MISSING`.
7. **`codecarto_complete`** — marks the phase done, applies your handoff to canonical state, and writes the closeout and `THREAD_LOG.md` entry. It refuses anything worse than `PASS WITH GAPS`.

When `codecarto_status` reports all phases complete, post-pipeline skills become available via `codecarto_list_skills` and `codecarto_skill`. One name that tool answers to is exempt from that gate: `codecarto_skill {name: "broadside"}` returns the reading guide for a batch reconnaissance run, which is meant to be read *before* the pipeline and during it.

## The handoff contract

Since v0.12.0 the framework owns `workflow/status.yaml`, `closeouts/`, and `THREAD_LOG.md`. **Never write those files.** A session proposes state changes in one file:

```
.codecarto/scratch/handoffs/<phase-id>.yaml
```

```yaml
schema_version: 1
phase_id: architecture
owner_notes:
  - Mapped 14 packages across 3 layers.
open_questions: []
carry_forward:
  - id: arch-CF2
    kind: defer-to-phase
    target_phase: protocols
    description: MCP endpoints listed by name only; schemas not extracted.
    deferred_reason: Wire-format extraction is the protocols phase's rubric.
closeout_summary: Architecture mapped; wire formats deferred to protocols.
```

Omitted arrays default to empty. `phase_id` must match the phase exactly. `carry_forward` targets must be a *later* phase in the active pipeline — anything else belongs in `post_pipeline`. Full schema and closure semantics: `references/handoff-contract.md`.

Two failure modes worth naming, because both have happened in the field:

- **No handoff written.** Completion fails with an error naming the expected path. Earlier versions completed silently with empty state, which severed cross-phase routing for an entire run without a trace.
- **Routing described but not performed.** Writing "routed to the semantic phase" in your report's prose table does *not* route anything. The handoff entry is the routing; the table documents it.

## Executing a phase

A phase executor takes the prompt from `codecarto_next` plus the repository path, and must:

1. read the repository (or, for late synthesis phases, the prior `findings/` artifacts);
2. write the exact primary output path the prompt names;
3. append a validation block whose last line is `**Overall:** PASS` or `**Overall:** PASS WITH GAPS`;
4. write the phase handoff;
5. touch nothing outside `.codecarto/`.

Anything satisfying that contract works. Choose per phase, by weight and context budget rather than by brand — see `references/executors.md` for adapters (running it in your own context, delegating to a CLI agent, using local models for scoped pre-passes) and for the concrete selection rules.

The short version: use the strongest model available for synthesis phases (`porting`, `reimplementation-spec`) where reasoning quality drives the artifact's value, delegate the wide repository reads to whatever has the largest usable context, and reserve small local models for narrow, verifiable pre-passes whose output you treat as evidence rather than as findings.

## Validation gates

| Result | Meaning | Do |
|---|---|---|
| `PASS` | every criterion satisfied | complete |
| `PASS WITH GAPS` | some criterion PARTIAL, gaps documented | complete only if the gaps are acceptable for the user's goal; the gaps must be tracked in the handoff |
| `FAIL` | a criterion is unmet | fix the artifact, re-validate; completion will refuse |
| `MISSING` | primary output or validation block absent | the executor did not finish; see `references/phase-recovery.md` |

A PARTIAL row's evidence must name what is missing and which `open_questions` or `carry_forward` entry tracks it — and that entry must exist in the handoff, not only in the prose.

## Verify before reporting success

- `codecarto_validate` returned `PASS` or an accepted `PASS WITH GAPS`
- `codecarto_complete` succeeded
- the primary output file exists and is non-trivial
- `codecarto_status` shows the expected progress and next action
- if you delegated, the executor's own result reports success — do not infer it from exit code alone

## Pitfalls

- `codecarto_next` returns a prompt. Something still has to *do* the phase.
- Never hand-edit `workflow/status.yaml`, append `THREAD_LOG.md`, or write a second closeout. Propose through the handoff.
- Do not force phases out of DAG order unless the user asked.
- If `codecarto_status` reports a scaffold-staleness warning, refresh the workspace's framework-owned files before trusting anything written inside `.codecarto/`; a stale scaffold's `GUIDE.md` can contradict this contract.
- A delegated run that times out may still have written its artifact. Check for the file and validate before retrying.
- The drop-in `.codecarto/` template works without MCP, but the server is preferred: it owns atomic state updates, validation parsing, and the completion gate.

## When the run drives a rewrite

When the pipeline completes, the finished spec has a designed destination: publish it to a **library** (`codecarto_publish`; create one with `codecarto_library_init`) so synthesis runs and other projects can consume it — `references/library.md`. A spec that only ever lives in its workspace helps exactly one repository.

If the goal is to rebuild or refactor rather than to understand, two phases carry that weight and both have their own reference:

- the defect scans feed `porting` and `reimplementation-spec` as inputs, not as an appendix — `references/deep-audit-synthesis.md`;
- the spec should describe the least error-prone build order, not a clone — `references/kernel-first-rewrite.md`.

## References

Running the pipeline:

- `references/broadside.md` — batch reconnaissance: when to scout, cost guardrails, and why its findings are leads rather than evidence
- `references/orchestration.md` — the orchestrator's duties, inline vs delegated execution, and the session-by-session fallback's real costs
- `references/pipeline-selection.md` — choosing a variant, and switching without losing work
- `references/executors.md` — the executor contract, adapters, and model selection
- `references/handoff-contract.md` — full handoff schema, routing, and closure semantics
- `references/phase-recovery.md` — stalled, interrupted, and failed phase runs

Using what it produces:

- `references/deep-audit-synthesis.md` — defect dispositions, hazards as normative rules, reporting
- `references/kernel-first-rewrite.md` — rings, build order, acceptance harness, strategic assumptions
- `references/carrying-results-forward.md` — starting implementation, autonomy boundaries, publishing findings
- `references/library.md` — publishing finished specs to a library and consuming them from synthesis runs

This guide is also served by the `codecarto_guide` MCP tool, so an agent with the server configured can read it without installing anything.
