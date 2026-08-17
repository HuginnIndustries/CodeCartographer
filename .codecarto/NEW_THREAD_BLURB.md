# CodeCartographer - New Session Quick Start

Source code under evaluation: `../` (this repository — everything outside `.codecarto/`)

All CodeCartographer files are inside `.codecarto/`. Paths below are relative to `.codecarto/`.

**First-time project?** If `CONVENTIONS.md` and `DECISIONS.md` are missing or still template skeletons and `closeouts/` is empty, see GUIDE.md §Roles and §First-Time Project Setup before reading the rest. The chat driving the run **is the orchestrator by default** — seed `CONVENTIONS.md`/`DECISIONS.md` and pick an execution strategy (inline or delegated) from the situation; do not interview the user about whether orchestration should happen.

Read these in order before doing work:

1. `GUIDE.md` - the LLM entry point and session guide
2. `workflow/status.yaml` - current progress and routed items (framework-owned: read it, never edit it)
3. `CONVENTIONS.md` if present - cross-cutting patterns this project follows
4. The current phase's existing output file, if present
5. The current phase's `SKILL.md`
6. The output template from `templates/` for the current phase (if starting a new output)
7. Scan `carry_forward` entries in `workflow/status.yaml` whose `target_phase` matches your phase — these are items earlier phases routed to you to close.

Where to store results:

- Durable findings: `findings/<phase>/`
- Rough notes: `scratch/`
- State changes (owner notes, open questions, carry-forward routings): `scratch/handoffs/<phase>.yaml` — completion applies it to `workflow/status.yaml`; never edit `status.yaml` directly
- Closeouts and `THREAD_LOG.md`: framework-owned; supply `closeout_summary` and optional `closeout_content` in the handoff

After completing work:

1. Run validation per `workflow/VALIDATE.md`. Append the validation block to the output.
2. Write `scratch/handoffs/<phase>.yaml` (see `templates/phase-handoff.yaml`): `schema_version: 1`, the exact `phase_id`, arrays for `owner_notes`, `open_questions`, `carry_forward`, `carry_forward_closures`, `open_question_closures`, `post_pipeline`, `decisions`, and `proposed_conventions`, plus `closeout_summary` and optional multiline `closeout_content`. See GUIDE.md "Open Questions vs Carry-Forward" for the entry shape.
3. Record 2-3 key observations in the handoff's `owner_notes`.
4. Store the durable output in the declared `findings/` path.
5. Run completion. The framework verifies the primary output and validation, applies the handoff to `workflow/status.yaml`, and writes the closeout and `THREAD_LOG.md` entry.
6. If the session made cross-cutting decisions or proposed conventions, record them in the handoff's `decisions` array and the closeout content's "Decisions Beyond Prompt" and "Proposed Conventions" sections. Promoting them to `DECISIONS.md` and `CONVENTIONS.md` is the orchestrator duty at the phase boundary — in an inline run, do it yourself before the next phase.

## File-System Sync Warning

Some host setups exhibit lag between host file-tools (Read/Write/Edit) and a Linux bash mount of the same files. Symptoms include parse errors at line numbers that don't appear in the host view, files that look truncated mid-line, and duplicated trailing content after a heredoc-vs-Edit collision.

To stay safe:

- Prefer **full-file overwrites** (Write) over in-place patches (Edit) when host/mount disagreement appears.
- Verify writes by running `wc -l` and `md5sum` from both sides if you suspect drift.
- **Never chain Edit and bash heredocs against the same file in a single session** — pick one writer and stick with it.
- Keep test code in a separate file from production code so a sync gap on one doesn't poison the other.

This is not a CodeCartographer issue per se, but the framework's reliance on large narrative files (findings reports, primary outputs) magnifies the cost — every truncated write is a potential silent data loss in a load-bearing place.
