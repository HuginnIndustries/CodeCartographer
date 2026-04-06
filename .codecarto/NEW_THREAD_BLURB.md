# CodeCartographer - New Session Quick Start

Source code under evaluation: `../` (this repository — everything outside `.codecarto/`)

All CodeCartographer files are inside `.codecarto/`. Paths below are relative to `.codecarto/`.

Read these in order before doing work:

1. `GUIDE.md` - the LLM entry point and session guide
2. `workflow/status.yaml` - the single source of truth for project progress
3. The current phase's existing output file, if present
4. The current phase's `SKILL.md`
5. The output template from `templates/` for the current phase (if starting a new output)

Where to store results:

- Durable findings: `findings/<phase>/`
- Rough notes: `scratch/`
- Workflow status: `workflow/status.yaml` (only status file to update)
- Cross-session log: append to `THREAD_LOG.md`

After completing work:

1. Run validation per `workflow/VALIDATE.md`. Append the validation block to the output.
2. Update `workflow/status.yaml`: mark the phase `complete`, advance `current_phase` to the next pending phase (or `complete` if all phases are done), and update `next_actions`.
3. Record 2-3 key observations in `owner_notes` for the completed phase.
4. Append one short entry to `THREAD_LOG.md`.
5. Store the durable output in the declared `findings/` path.
