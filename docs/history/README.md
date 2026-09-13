# Framework history

Records of sessions that worked on CodeCartographer itself, kept out of `.codecarto/`.

This repository's `.codecarto/` is the template that `codecarto-init` copies into a user's repository, and it doubles as the workspace when CodeCartographer analyzes itself. Init has seeded the orchestrator files and `closeouts/` fresh from templates since #283, so nothing here ever reached a user — but the tracked copies still made a fresh clone report an existing workspace, put the GUIDE's first-time heuristic wrong from the first call, and had a self-audit appending to a 2026 session's thread log (#276). The workspace files in `.codecarto/` are now the pristine templates; what they used to carry lives here.

- [`2026-05-02-framework-feedback-pass.md`](2026-05-02-framework-feedback-pass.md) — the changelog of the pass that applied thirteen agent sessions' feedback to the framework.
- [`2026-05-02-framework-feedback-pass-closeout.md`](2026-05-02-framework-feedback-pass-closeout.md) — that session's closeout (formerly `.codecarto/closeouts/`).
- [`framework-backlog-2026-05-02.md`](framework-backlog-2026-05-02.md) — the deferrals B1–B14 that pass recorded (formerly `.codecarto/BACKLOG.md`); several have since shipped, noted inline. New framework work is tracked in GitHub issues and [`ROADMAP.md`](../../ROADMAP.md), not here.

Self-analysis runs keep their own state under [`self-audit/`](../../self-audit/).
