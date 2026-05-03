# Closeout — <YYYY-MM-DD> — <phase-or-module>

<!--
  Per-session closeout file. Place at: closeouts/<YYYY-MM-DD>-<phase-or-module>.md
  THREAD_LOG.md gets a one-line index entry pointing here.

  This pattern replaces the monolithic THREAD_LOG.md body. Per-session files
  scale forever, are individually read-budget-cheap, and avoid the heredoc-vs-edit
  sync risks that bite append-to-large-file workflows.

  Fill every section that applies. Delete sections that don't.
-->

## Summary

<!-- Two-to-four sentences. What did this session do, and what is the next session's starting point? -->

## Files Touched

<!-- Group by add/modify/delete. List paths relative to repo root. -->

- **Added:**
- **Modified:**
- **Deleted:**

## Tests / Gates

<!-- Whatever the project's "all gates green" set is. Honest reporting only. -->

| Gate | Result | Notes |
|---|---|---|
| `bun install` | | |
| `tsc --noEmit` | | |
| `oxlint` | | |
| `bun test` | | |

## Decisions Beyond Prompt

<!-- Cross-cutting decisions made this session that diverged from spec, prompt, or obvious-default.
     These become numbered entries in DECISIONS.md when the orchestrator promotes them.
     Format each entry: <one-liner> | <rationale, ~one paragraph>. -->

- **D???** | <one-liner> | <rationale>

## Proposed Conventions

<!-- Cross-cutting patterns this session reached for that may generalize.
     The orchestrator promotes these to CONVENTIONS.md when a third independent session
     reaches for the same pattern (or when the orchestrator confirms generalization sooner).
     Format: title + Why + How to apply. -->

### C? <Title>

**Why:**

**How to apply:**

## Open Questions Left Behind

<!-- Items that are still genuinely unknown after this session.
     Mirror these into workflow/status.yaml under the relevant phase's open_questions. -->

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Carry-Forward Routed

<!-- Items deferred to a specific later phase.
     Mirror these into workflow/status.yaml under the relevant phase's carry_forward. -->

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Framework Feedback (optional)

<!-- If this session encountered friction with the framework itself, write a short note here.
     Promote to a separate file under Feedback From Agents/ if the note is substantial.
     Closing the loop on the framework is itself a CodeCarto-style activity — see GUIDE.md. -->

## Next Session Pointer

<!-- One paragraph: what should the next session pick up first? Cite specific files, status.yaml entries,
     or carry_forward IDs. The next session reads this as part of pre-flight. -->
