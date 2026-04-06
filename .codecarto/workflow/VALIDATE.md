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
6. If any criterion is PARTIAL, note the gap in the validation block and in `workflow/status.yaml` under `open_questions` for the phase. You may still mark the phase complete if the gaps are documented and non-blocking for downstream phases.

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

## Rules

- Do not skip validation. Every primary output must end with a validation block.
- Do not inflate results. A criterion you are uncertain about is PARTIAL, not PASS.
- If the output file already has a validation block from a prior session, replace it with a fresh one.
- Validation checks the output against the pipeline's criteria only. It does not re-evaluate the source code.
- For automated agents: a phase with any FAIL result must not have its status set to `complete` in status.yaml.
