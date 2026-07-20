# CodeCartographer 0.11.0 release notes

CodeCartographer 0.11.0 makes long reverse-engineering pipelines more resilient and auditable. Isolated Pi phase sessions can now checkpoint before compaction, recover after interrupted provider runs, and reopen an existing workspace without resetting durable state.

## Highlights

- **Durable phase recovery.** Phase-aware compaction writes atomic checkpoints under `.codecarto/scratch/checkpoints/`. A phase that stops before producing its declared output receives one bounded continuation attempt.
- **Nondestructive workspace reopening.** Run `/codecarto-open` in a fresh Pi session to attach to an existing `.codecarto/` workspace without reinitializing it.
- **Honest coverage accounting.** Every phase template and validation rubric requires inspected scope, skipped scope, evidence basis, blind spots, and explicit `PARTIAL` coverage where appropriate.
- **Bundle-first final synthesis.** The porting bundle is the normal compression boundary for the reimplementation spec. Lower-level findings are deep-read only for a named gap, conflict, missing acceptance detail, or defect rationale.
- **Compaction telemetry.** Local usage records, summaries, widgets, `/codecarto-usage`, and the dashboard understand successful, failed, and aborted compactions while remaining compatible with older usage files.
- **Security and platform maintenance.** The Pi peer requirement is now `^0.80.10`; vulnerable transitive packages were refreshed; GitHub Actions use Node 24-native releases; CI includes a production high-severity dependency audit.

## Safety improvements

- Isolated child sessions load their own CodeCartographer resilience and write-boundary guards even when the parent extension was loaded with `pi -e`.
- Child shell access remains disabled and edits remain confined to `.codecarto/`.
- Declared-output checks reject traversal and symlink escapes.
- Packed-artifact smoke installations ignore lifecycle scripts and sanitize inherited npm `allow-scripts` policy.
- Checkpoint write failures are surfaced instead of silently discarded.

## Upgrade notes

- Pi users must run `@earendil-works/pi-coding-agent` 0.80.10 or later in the compatible 0.x line.
- Existing `.codecarto/` workspaces and legacy `.usage.local.yaml` records remain supported.
- Use `/codecarto-open`, not `/codecarto-init`, when continuing an existing workspace from a fresh Pi session.

## Validation performed

- 207 automated tests.
- TypeScript build on Node 22 and Node 24.
- Nine packed-package MCP smoke assertions.
- Zero production vulnerabilities at the high audit threshold.
- Full `full-with-deep-audit` dogfood against an isolated Aimbroidery snapshot: 7/7 phases completed, every phase validated `PASS WITH GAPS`, all carry-forward items were closed, and final synthesis used the porting bundle with only two targeted source deep reads.
- Two independent correctness/security reviews returned PASS with no blockers.

## Known limitations

- Compaction is lossy by nature. Checkpoints preserve explicit evidence, progress, gaps, and next steps, but they do not guarantee lossless conversational reconstruction.
- Providers that do not report token usage are displayed as `unavailable`, not zero.
- A compaction completed after an orchestrator process has already ended cannot be retroactively attributed to that process's local usage row; the durable checkpoint remains the recovery source of truth.

This candidate is prepared but not published. The npm package, Git tag, and GitHub Release require separate authorization.
