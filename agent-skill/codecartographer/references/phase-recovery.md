# Recovering a stalled or failed phase

Treat the workspace as the source of truth. Before assuming anything failed, run `codecarto_status` and `codecarto_validate`.

## First: check whether it actually failed

A delegated run that times out, is interrupted, or returns empty output **may still have written its artifact**. Executors commonly write the file and then die during cleanup or summary.

1. Does the primary output file exist?
2. If yes, run `codecarto_validate`. A `PASS` means the phase succeeded regardless of how the executor exited.
3. Only retry when the artifact is absent or validation is `MISSING`/`FAIL`.

Retrying a phase that already succeeded wastes the run and can overwrite a good artifact with a worse one.

## Diagnosing by validation result

**`MISSING`** — no primary output, or no validation block. The executor did not finish. Retry with reduced scope.

**`FAIL`** — a criterion is unmet. The validation output names which. Repair the artifact against that criterion specifically; do not regenerate the whole thing.

**`PASS WITH GAPS` you did not intend** — the executor marked criteria PARTIAL. Read the evidence cells: either the gaps are real and belong in the handoff as `open_questions`/`carry_forward`, or the executor under-read and should retry.

**Completion refuses despite `PASS`** — almost always a missing handoff. The error names the expected path. Write `.codecarto/scratch/handoffs/<phase-id>.yaml` and complete again.

## Writing a recovery prompt

Narrower than the original, not a repeat of it:

- name the exact primary output path;
- require the validation block, with the literal `**Overall:** PASS` or `**Overall:** PASS WITH GAPS` final line;
- require the handoff file, naming its path;
- constrain traversal explicitly — skip vendored code, build output, generated files, and lockfiles unless the phase needs them;
- for late phases, direct it to read prior `.codecarto/findings/` artifacts *instead of* the source tree, which is usually why the first attempt exhausted its budget;
- narrow the tool grant. For an analysis-writing retry, read/write/edit/search is typically enough; shell access is often what let the first run wander.

## Repeated failure on the same phase

If two reduced-scope attempts fail, the problem is usually scope, not the executor:

- Split the reading. Use scoped pre-passes over individual subsystems, save the notes under `.codecarto/scratch/`, and give the retry those notes as evidence.
- Consider whether the pipeline variant is right. A repository too large for one `architecture` pass may want `architecture-only` first, reviewed, then a switch.
- Check for a scaffold-staleness warning in `codecarto_status`. A workspace whose framework-owned files predate the running version can carry instructions that contradict the current contract, which produces artifacts that fail validation for reasons the executor cannot see.

## What not to do

- Do not hand-edit `workflow/status.yaml` to move past a failure. Completion is the only writer, and a manual edit is unreviewed state that the next completion may overwrite.
- Do not mark a phase complete to unblock the pipeline. Downstream phases read upstream findings; a hollow artifact propagates.
- Do not delete and re-init to escape a bad phase. `codecarto_init --force` moves the whole workspace, including phases that succeeded.
