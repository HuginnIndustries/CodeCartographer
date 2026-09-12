# Closeout — defect-scan-mechanical

## Summary

- Primary output: `findings/defect-scan-mechanical/mechanical-defects.md` (PASS, 8/8).
- 40 findings: 0 critical, 7 high, 17 medium, 16 low (pass 1: 15, pass 2: 11, pass 6: 14).
- Highs: (1) `core/yaml.ts` emits scalar-looking strings unquoted, so a digit-only repo
  name breaks every later load; (2) `copyPackagedWorkspace` does not exclude findings, so
  a checkout install seeds new workspaces with existing findings and validation passes on
  them — reproduced as 18 test failures in this clone vs 0 on a pristine one; (3)
  `.codecarto/.gitignore` is not in the npm tarball; (4) `wait_seconds: 0` on collect becomes
  a 25-minute block; (5) no `max_cost` by default on MCP; (6) a malformed Broad-Side config
  silently drops a configured cap; (7) a corrupt `state.json` is overwritten, orphaning paid
  runs.
- Runtime evidence: two test-suite runs, four YAML/status probes, one `npm pack --dry-run`,
  all recorded in the report's §Runtime probes.

## Routed

- mech-CF1..CF6 → defect-scan-semantic (lock release ownership, symlink fallback in the
  write guard, publish containment root, ctx invalidation, collect run selection, library
  publish races).
- q-pi-ctx-invalidation registered (needs-runtime-test); mech-CF4 derives from it.

## Coverage

- All of core/, mcp-server/, extensions/codecarto/ scanned; tests executed and excerpted;
  dashboard CSS/inline script and demo scripts skipped.

## Proposed Conventions

- cheap-runtime-probe-before-severity (staged by completion).

## Decisions Beyond Prompt

- The scan used runtime evidence in addition to reading: npm ci + npm test in the scratch clone (twice, once on a pristine second clone), node probe scripts importing core/yaml.ts and core/status.ts, and npm pack --dry-run. None modifies source; node_modules/ now exists in the clone. Findings resting on these cite the command in their Defect cell.
- Severity for Broad-Side findings assumes the MCP posture (no human confirm hook); the same defects on Pi are one severity lower because the spend dialog intervenes.
