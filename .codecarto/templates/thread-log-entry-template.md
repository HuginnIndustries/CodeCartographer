# THREAD_LOG.md Entry Format (framework-owned)

`THREAD_LOG.md` is written by completion, not by sessions. Completion appends one index entry per completed phase, built from the `closeout_summary` in your phase handoff and the canonical closeout filename, and skips the append when an entry already links that closeout — so retries never duplicate.

Your input to this file is the handoff's `closeout_summary`. The full body of each session lives in a separate closeout file under `closeouts/`; for that file, use `templates/closeout-template.md`.

## Entry format produced

```
- YYYY-MM-DD — <phase-or-module> — <closeout_summary> — [closeout](closeouts/YYYY-MM-DD-phase-or-module.md)
```

## Example

```
- 2026-05-02 — architecture — mapped 14 packages across 3 layers; 2 carry-forward items routed to defect-scan — [closeout](closeouts/2026-05-02-architecture.md)
```

## Writing a good closeout_summary

- One clause, no more than ~20 words — it has to read well inside the one-line entry above.
- Name what the phase established and what it routed onward, as in the example.
- Omitting it is allowed; completion falls back to `Validation: <overall>`, which carries no information about the work.

Everything else in the entry — the date, the phase slug, the closeout link, and de-duplication across retries — is supplied by the framework. Do not append to `THREAD_LOG.md` yourself; a hand-written entry will sit alongside the canonical one rather than replacing it.
