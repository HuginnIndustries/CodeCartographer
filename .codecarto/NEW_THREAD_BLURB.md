# CodeCartographer - New Session Quick Start

Source code under evaluation: `../` (this repository — everything outside `.codecarto/`)

All CodeCartographer files are inside `.codecarto/`. Paths below are relative to `.codecarto/`.

**First-time project?** If `CONVENTIONS.md` and `DECISIONS.md` are still template skeletons and `closeouts/` is empty, see GUIDE.md §Roles and §First-Time Project Setup before reading the rest. The first LLM on a project takes a one-time role decision with the user (orchestrator vs session-by-session).

Read these in order before doing work:

1. `GUIDE.md` - the LLM entry point and session guide
2. `workflow/status.yaml` - the single source of truth for project progress
3. `CONVENTIONS.md` if present - cross-cutting patterns this project follows
4. The current phase's existing output file, if present
5. The current phase's `SKILL.md`
6. The output template from `templates/` for the current phase (if starting a new output)
7. Scan `carry_forward` entries in `workflow/status.yaml` whose `target_phase` matches your phase — these are items earlier phases routed to you to close.

Where to store results:

- Durable findings: `findings/<phase>/`
- Rough notes: `scratch/`
- Workflow status: `workflow/status.yaml` (only status file to update)
- Per-session closeouts: `closeouts/<YYYY-MM-DD>-<phase-or-module>.md` (use `templates/closeout-template.md`)
- Cross-session log: append a one-line index entry to `THREAD_LOG.md` pointing at your closeout file

After completing work:

1. Run validation per `workflow/VALIDATE.md`. Append the validation block to the output.
2. Update `workflow/status.yaml`: mark the phase `complete`, advance `current_phase` to the next pending phase (or `complete` if all phases are done), and update both `open_questions` (genuinely unknown) and `carry_forward` (deferred to a specific later phase) for the phase. See GUIDE.md "Open Questions vs Carry-Forward" for the entry shape.
3. Record 2-3 key observations in `owner_notes` for the completed phase.
4. Write a per-session closeout file at `closeouts/<YYYY-MM-DD>-<phase-or-module>.md`. Append a one-line entry to `THREAD_LOG.md` pointing at it (de-dup discipline: scan the bottom 5 entries first to avoid double-appending).
5. Store the durable output in the declared `findings/` path.
6. If the session made cross-cutting decisions or proposed conventions, fill in the closeout's "Decisions Beyond Prompt" and "Proposed Conventions" sections. The orchestrator promotes them to `DECISIONS.md` and `CONVENTIONS.md` respectively.

## File-System Sync Warning

Some host setups exhibit lag between host file-tools (Read/Write/Edit) and a Linux bash mount of the same files. Symptoms include parse errors at line numbers that don't appear in the host view, files that look truncated mid-line, and duplicated trailing content after a heredoc-vs-Edit collision.

To stay safe:

- Prefer **full-file overwrites** (Write) over in-place patches (Edit) when host/mount disagreement appears.
- Verify writes by running `wc -l` and `md5sum` from both sides if you suspect drift.
- **Never chain Edit and bash heredocs against the same file in a single session** — pick one writer and stick with it.
- Keep test code in a separate file from production code so a sync gap on one doesn't poison the other.

This is not a CodeCartographer issue per se, but the framework's reliance on append-to-narrative-files (`THREAD_LOG.md`, `status.yaml`, large primary outputs) magnifies the cost — every truncated write is a potential silent data loss in a load-bearing place.
