# Phase Validation

Run this check after completing a phase's primary output, before marking the phase as complete.

## Steps

1. Re-read the phase's `completion_criteria` from the active pipeline YAML (check the `pipeline` field in `workflow/status.yaml` for the file path).
2. Re-read the primary output you just produced.
3. For each criterion, answer one of:
   - **PASS**: the output clearly satisfies this criterion. Cite the section or line.
   - **PARTIAL**: the output addresses this but is incomplete or shallow. State what is missing.
   - **FAIL**: the output does not address this criterion at all.
4. Append a validation block to the end of the primary output file (see format below).
5. If any criterion is FAIL, do not mark the phase as complete. Fix the output first.
6. If any criterion is PARTIAL, route the gap appropriately:
   - If the gap is **still genuinely unknown** (needs a runtime test, maintainer decision, or spec ruling that no later phase will close), record it under `open_questions` in your phase handoff at `scratch/handoffs/<phase>.yaml`.
   - If the gap is **deferred to a specific later phase** in this pipeline (the next phase's rubric is the right place to close it), record it under `carry_forward` in the same handoff with an explicit `target_phase` field. See GUIDE.md "Open Questions vs Carry-Forward" for the entry shape.
   - You may still mark the phase complete if the gaps are documented under one of the two lists and are non-blocking for downstream phases.

## Validation Block Format

Append this to the end of every primary output file:

```markdown
---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | [criterion text from pipeline.yaml] | PASS / PARTIAL / FAIL | [section reference or note] |
| 2 | ... | ... | ... |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
```

## Worked PARTIAL Example

Below is what a real PASS WITH GAPS block looks like — useful when a phase finishes meaningful work but is honest about its incompleteness. Note how the PARTIAL row's `Evidence` cell *names what is missing*, not just "incomplete."

```markdown
---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | The system intent is documented. | PASS | §System Intent (paragraph). |
| 2 | The layer map and dependency direction are documented. | PASS | §Layer Map; dependency direction in §Layer Map → "Dependency Direction." |
| 3 | Public surfaces are identified. | PARTIAL | CLI commands and HTTP routes enumerated (§Public Surfaces). MCP server endpoints and the websocket subscription channel are listed by name only — schemas not extracted. Routed to `carry_forward` as `arch-CF2` with `target_phase: protocols`. |
| 4 | Runtime lifecycle, concurrency model, and porting priorities are summarized. | PASS | §Runtime Lifecycle, §Concurrency Model, §Porting Priorities (table). |
| 5 | Findings are marked with evidence levels. | PASS | All inferences marked `observed fact` / `strong inference` / `portability hazard` / `open question`. |

**Validated by:** 2026-05-02 (architecture phase, session 1)
**Overall:** PASS WITH GAPS
```

You record the `arch-CF2` entry in your phase handoff at `scratch/handoffs/architecture.yaml`:

```yaml
schema_version: 1
phase_id: architecture
carry_forward:
  - id: arch-CF2
    kind: defer-to-phase
    target_phase: protocols
    description: MCP server endpoints and websocket subscription channel listed by name only; schemas not extracted.
    deferred_reason: Wire-format extraction is the protocols phase's rubric; deferring avoids guessing at shapes here.
closeout_summary: Architecture mapped; wire formats deferred to protocols.
```

Completion validates the handoff and applies the entry to `workflow/status.yaml` under the architecture phase's `carry_forward`. Never write that file yourself — see GUIDE.md "Trust Boundaries."

The protocols phase then receives `arch-CF2` in its phase prompt as a routed item. It either resolves it (addressing it in the phase output and listing the id under `carry_forward_closures` in its own handoff, so completion removes the entry atomically) or re-defers it by writing a fresh `carry_forward` entry naming a later `target_phase`.

## Rules

- Do not skip validation. Every primary output must end with a validation block.
- Do not inflate results. A criterion you are uncertain about is PARTIAL, not PASS.
- If the output file already has a validation block from a prior session, replace it with a fresh one.
- Validation checks the output against the pipeline's criteria only. It does not re-evaluate the source code.
- For automated agents: a phase with any FAIL result must not be completed. Completion refuses FAIL and MISSING validations outright.
- A PARTIAL row's `Evidence` cell must name what is missing and (if applicable) which `open_questions` or `carry_forward` entry tracks the gap. "Incomplete" alone is not honest enough. Record that entry in the phase handoff — an evidence cell that only *describes* the routing does not perform it.
