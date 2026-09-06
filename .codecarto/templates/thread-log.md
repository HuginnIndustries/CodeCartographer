# Thread Log — Index

This file is an **index** of per-session closeouts. Each session writes a full closeout to
`closeouts/<YYYY-MM-DD>-<phase-or-module>.md` using `templates/closeout-template.md`, and
appends one line here pointing to it.

The body of each session lives in the closeout file, not in this index. This pattern scales
forever: per-session files are individually small and read-budget-cheap, and avoid the
heredoc-vs-edit sync risks that bite append-to-large-file workflows once the file grows past
~50 KB.

## Format

```
- YYYY-MM-DD — <phase-or-module> — <one-line-summary> — [closeout](closeouts/YYYY-MM-DD-phase-or-module.md)
```

## De-dup discipline

Before appending, scan the bottom 5 entries. If you see a line with the same date AND same
phase-or-module AND same summary, do not append — the prior session already wrote it. The
framework has no programmatic dedup gate; this is human-discipline.

A one-liner to surface duplicates from the shell:

```bash
grep -E '^- [0-9]{4}-[0-9]{2}-[0-9]{2}' .codecarto/THREAD_LOG.md | sort | uniq -d
```

## Entries

<!--
  Append one line per session below this marker.
  Example:
  - 2026-03-14 — architecture — mapped 14 packages across 3 layers; wire formats deferred to protocols — [closeout](closeouts/2026-03-14-architecture.md)
-->
