# Closeout — architecture

## Summary

- Primary output: `findings/architecture/architecture-map.md` (PASS, 6/6 criteria).
- Secondary outputs written with a dated 2026-09-11 section: public-surfaces,
  runtime-lifecycle, state-and-storage, build-and-deploy, config-model.
- System shape: a filesystem-backed pipeline state machine in `core/` (19 modules, no
  internal cycles, only Node built-ins) wrapped by an MCP server (22 tools, stateless per
  call) and a Pi extension (20 commands, in-process sub-agents, bash blocked, writes confined
  to `.codecarto/`). Library and Broad-Side are adjacent subsystems on the same core.
- Load-bearing base: `core/yaml.ts`, a hand-rolled parser every persisted YAML file passes
  through; `core/status.ts` + `core/workspace.ts` for the lock/atomic-write discipline;
  `core/pipeline.ts` + `core/completion.ts` for the validation and completion gates.

## Routed

- arch-CF1 → protocols (schemas by name only).
- arch-CF2 → porting (mcp-server imports from extensions/; barrel bypassed).
- arch-CF3 → contracts (per-command contracts).
- arch-CF4 → defect-scan-semantic (unlocked usage-log read-modify-write).

## Coverage

- Read in full: core/, mcp-server/, extensions/codecarto/, scripts/, .github/workflows/,
  package/tsconfig/server.json.
- Not read: tests/ bodies, docs/ beyond README and self-review-prompt, CHANGELOG, MANUAL,
  ROADMAP, CONTRIBUTING, any SDK source.

## Proposed Conventions

- None this phase.

## Decisions Beyond Prompt

- tests/ (52 files, 639 tests) was inventoried by name and count only in the architecture phase; reading test bodies is deferred to the defect scans, where they are evidence for or against a finding rather than structure.
- Claims about Pi SDK and MCP SDK behavior (ctx invalidation after a session swap, session continuation, structuredContent preference) are carried as external-behavior claims sourced from the code's own comments; no SDK source was read.
