# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-06

Initial public release under the MIT license.

### Added

- **Framework core** (`core/`): pipeline state machine, YAML pipeline validators, prompt assembly, workspace utilities. Imported by both the Pi extension and the MCP server so phase prompts and validation logic stay byte-identical across surfaces.
- **Pi extension** (`extensions/codecarto/`): `/codecarto-init`, `/codecarto-status`, `/codecarto-next`, `/codecarto-phase`, `/codecarto-validate`, `/codecarto-complete`, and `/codecarto-skill` slash commands. Includes a footer widget showing the active phase and tool interception that blocks edits outside `.codecarto/`.
- **MCP server** (`mcp-server/`): seven tools mirroring the Pi extension (`codecarto_init`, `codecarto_status`, `codecarto_next`, `codecarto_phase`, `codecarto_validate`, `codecarto_complete`, `codecarto_skill`) so any MCP-compatible host (Claude Code, Claude Desktop) can drive a CodeCartographer workflow.
- **Default pipeline**: `pipeline-full-with-deep-audit.yaml` (7 phases). Splits the defect scan into a mechanical early pass and a semantic late pass so the reimplementation spec can design around defects with full contracts and protocols context.
- **Pipeline variants**: `architecture-only` (1 phase), `lite` (3 phase), `defect-scan` (2 phase), `full` (5 phase), `full-with-audit` (6 phase, single early defect scan), and `full-with-deep-audit` (7 phase, default).
- **Invariant tests** (`tests/`): default-pipeline, doc-mention, mcp-server, pipeline-invariants. Catch cross-wrapper drift between template, Pi extension, and MCP server.
- **CI** (`.github/workflows/ci.yml`): runs `npm ci && npm test` on every PR and push to `master`.
- **Documentation**: README with quick-start, pipeline variants, model-compatibility tiers, token-cost guidance; MANUAL for human users; per-phase SKILL.md and template files inside `.codecarto/`.

### Notes

- Node 20+ is required.
- The Pi runtime and `@sinclair/typebox` are peer dependencies — install them in your host environment, not as direct dependencies of this package.

[Unreleased]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HuginnIndustries/CodeCartographer/releases/tag/v0.1.0
