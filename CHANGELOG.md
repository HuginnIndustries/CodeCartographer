# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Pin `@modelcontextprotocol/sdk` to `^1.29.0` (was `*`). The wildcard let `npm install` resolve to anything and made the npmjs.com dependency panel for `codecartographer-pi` link to the SDK's draft-spec docs. The pinned range covers SDK 1.29.x, which advertises MCP `2025-11-25` as `LATEST_PROTOCOL_VERSION` while still accepting `2024-10-07` through `2025-11-25` from clients.
- README: explicitly document the MCP spec revision the package implements, and link to the released spec at `modelcontextprotocol.io/specification/2025-11-25`.
- **Release workflow now creates a git tag and a GitHub Release on every publish.** Previously `release.yml` only ran `npm publish`, so the GitHub repo's "Releases" sidebar stayed empty. The workflow is now idempotent end-to-end: `npm publish` skips if the version is already on the registry, `gh release create` skips if the tag's release already exists. Notes for the GitHub Release are extracted from the matching `## [VERSION]` section of `CHANGELOG.md`. Permissions widened from `contents: read` to `contents: write` so the runner can create tags and releases.
- **Migrate Pi peer dependency from `@mariozechner/*` to `@earendil-works/*`.** The `@mariozechner/pi-coding-agent` package was deprecated upstream in favor of `@earendil-works/pi-coding-agent`; `pi update` now emits five deprecation warnings on every install. Switched our peer dep declaration and the one extension import (`extensions/codecarto/index.ts`) over to the new namespace at `^0.74.0`. Type names (`ExtensionAPI`, `ExtensionCommandContext`, `ExtensionContext`) are unchanged across the rename — drop-in replacement, no behavior change.

### Fixed

- **Remove `codecartographer-pi` self-dependency from `package.json`.** Running `npm install codecartographer-pi` from inside the repo (e.g., to verify a published artifact) caused npm to write the package as a direct dependency of itself. Left in, the published 0.1.2 tarball would have nested a copy of `codecartographer-pi@0.1.1` under its own `node_modules/`, with the outer package's `bin` and `pi.extensions` paths potentially resolving against the wrong copy depending on host walk order.

### Documentation

- **README: clarify Pi vs. MCP install paths.** Added `pi install npm:codecartographer-pi` as the primary install command for the Pi use case alongside the existing local-checkout and git-URL options, and added an explicit warning that plain `npm install codecartographer-pi` does NOT register the package with Pi (it has to be `pi install npm:...` so Pi writes it into its own `settings.json`). Plain `npm install` is still the correct command for the MCP-server use case.

## [0.1.1] — 2026-05-07

### Fixed

- **`codecarto-mcp` is now actually runnable when installed from npm.** `0.1.0` shipped TypeScript source files and relied on Node's `--experimental-strip-types` to load them at runtime. Node refuses to strip types from any file inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the bin failed to start on every Node version. Caught by the new end-to-end smoke test against the published artifact (PR #11).

### Changed

- Build pipeline added: `tsc` compiles `core/`, `extensions/`, and `mcp-server/` to `dist/`. The published tarball ships compiled JavaScript instead of TypeScript source. `prepublishOnly` enforces a fresh build at publish time.
- `package.json#bin.codecarto-mcp` now points at `./dist/mcp-server/bin.mjs`. `pi.extensions` points at `./dist/extensions`. `files` ships `dist/**/*` instead of the source directories.
- `mcp-server/bin.mjs` shebang simplified to `#!/usr/bin/env node` (no flags needed once the imports resolve to `.js`).
- `engines.node` lowered from `>=22.6.0` to `>=20.0.0`. The published artifact is plain JavaScript, so the `--experimental-strip-types` floor only applies to local development and CI.

### Notes

- TypeScript `^5.7` (specifically requires `rewriteRelativeImportExtensions`, introduced in 5.7) is now a `devDependency`. Consumers don't see it.
- The smoke test (`npm run smoke`) installs the published package into a temp dir and exercises the bin via the MCP SDK's stdio client. Daily cron in `.github/workflows/smoke.yml` will catch any registry-side regressions within 24 hours.

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
