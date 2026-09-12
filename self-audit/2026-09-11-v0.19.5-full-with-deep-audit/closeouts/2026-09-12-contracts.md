# Closeout — contracts

## Summary

- Primary output: `findings/contracts/behavioral-contracts.md` (PASS, 7/7).
- Sixteen contract tables cover every MCP tool and Pi command; TUI-only behaviors and
  storage formats in compact tables; 32 black-box acceptance scenarios, three of which pin
  current defects (Overall-line decoration, switch-pipeline current_phase, digit-named repo).
- Security model: no auth; trust boundary is the absolute cwd plus write containment to
  .codecarto/, the configured library, and the user-global config; Pi adds a tool sandbox.
- Eleven documentation-versus-code conflicts recorded; MANUAL.md still teaches the pre-0.12
  hand-edit contract.
- Secondary outputs appended: public-surfaces (parity table), config-model (doc precedence
  notes), runtime-lifecycle (auto decision matrix, SDK invalidation sites), state-and-storage
  (per-operation write matrix).

## Routed and closed

- Closed arch-CF3 (per-command contracts) and q-pi-ctx-invalidation (Pi SDK source).
- contracts-CF1 → defect-scan-semantic (doc/code conflicts as pass-5 candidates).
- contracts-CF2 → porting (surface parity decisions).
- q-codex-envelope-preference registered (needs-runtime-test).

## Coverage

- Docs read in full: README, MANUAL, mcp-quickstart, client-surfaces, CHANGELOG 0.19.x.
- Tests read in full: 20 files; the rest by name. Library-format spec left to protocols.

## Proposed Conventions

- None this phase.

## Decisions Beyond Prompt

- Contracts are written at operation granularity (one table per operation, Pi deltas inline) rather than one table per surface entry, because the two surfaces share one core path for every operation; the parity table in public-surfaces.md records the divergences.
- Where documentation and tests disagree, the test is treated as the contract and the conflict is listed rather than resolved; the eleven conflicts are routed to the semantic pass for defect classification rather than fixed in prose here.
- A needs-runtime-test question was closed on the external system's own source (the Pi SDK in node_modules) rather than a live probe, on the SKILL's definition that an external-behavior claim is settled by "a runtime probe or that system's own source".
