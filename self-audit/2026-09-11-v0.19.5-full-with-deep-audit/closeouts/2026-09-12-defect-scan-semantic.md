# Closeout — defect-scan-semantic

## Summary

- Primary output: `findings/defect-scan-semantic/semantic-defects.md` (PASS, 8/8).
- 38 findings: pass 3 (12), pass 4 (9), pass 5 (17). Highs: symlink fallback in the write
  guard (P1), unconditional lock release (P2), temp-name collision across every atomic
  writer (P3/P4), "no eligible phase" treated as "complete" (P6). Mediums include child
  sessions never disposed, completion artifacts written before the status rename, skill-name
  path traversal (P5), unvalidated publish containment root, prompt splicing of upstream
  findings text, Broad-Side uploads without redaction, and eight documented-versus-actual
  contract drifts.
- Six runtime probes recorded in the report.

## Routed and closed

- Closed arch-CF4, mech-CF1, mech-CF2, mech-CF3, mech-CF4, mech-CF5, mech-CF6,
  contracts-CF1, proto-CF1.
- sem-CF1 → porting (one atomic-write/lock primitive for the port).

## Coverage

- Every lock, temp-write, subprocess, fetch, and path-joining site in core and both
  wrappers; SDK dispose() read; pass-5 spec documents as cited. Skipped: dashboard inline
  script beyond escaping, lens prompt wording, dependency CVEs, synthesis templates.

## Proposed Conventions

- None this phase.

## Decisions Beyond Prompt

- Routed items were closed on runtime probes wherever a probe was cheap (P1-P6), per convention C01; the probe script lives in the session scratchpad, and each probe's inputs and outputs are transcribed into the report's Runtime probes section so the evidence survives the session.
- Pass 5 restates three mechanical findings (switch_pipeline cursor, max_cost default, wait_seconds) as documented-versus-actual violations with the spec references the mechanical rows lacked; they are cross-referenced, not double-counted in the top findings.
