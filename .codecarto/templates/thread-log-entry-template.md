# THREAD_LOG.md Entry Template (legacy / one-line index form)

This template is the **one-line index entry** appended to `THREAD_LOG.md` per session.
The full body of each session lives in a separate closeout file under `closeouts/`.

For the closeout file itself, use `templates/closeout-template.md`.

## Entry format

```
- YYYY-MM-DD — <phase-or-module> — <one-line-summary> — [closeout](closeouts/YYYY-MM-DD-phase-or-module.md)
```

## Example

```
- 2026-05-02 — architecture — mapped 14 packages across 3 layers; 2 carry-forward items routed to defect-scan — [closeout](closeouts/2026-05-02-architecture.md)
```

## Rules

- One line per session, no exceptions.
- Date in ISO format (YYYY-MM-DD).
- `<phase-or-module>` matches the closeout filename's slug.
- Summary is one clause, no more than ~20 words.
- Always link to the closeout file. If there is no closeout file, the entry doesn't belong here.
- Before appending, scan the bottom 5 entries to avoid duplicating a prior session's entry.
