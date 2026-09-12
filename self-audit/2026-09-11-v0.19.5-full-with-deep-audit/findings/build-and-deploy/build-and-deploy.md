# Build and Deploy

Catalog-level detail accumulated across phases (`mode: append`).

## 2026-09-11 — architecture

All entries `observed fact` from `package.json`, `tsconfig.json`, `server.json`, `.github/workflows/*.yml`, and `scripts/`.

### Toolchain

- Node ≥ 20 (`engines`); CI matrix Node 22 and 24. No linter, no formatter config in the repo.
- TypeScript ^5.9.3 (devDependency), `tsc` is the whole build. `tsconfig.json`: `target ES2022`, `module`/`moduleResolution NodeNext`, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (source imports `./x.ts`, emitted `./x.js`), `declaration: true`, `isolatedModules`, `allowJs`, `strict: false`, `noEmitOnError: false`, `rootDir: .`, `outDir: dist`, `include: core/**, extensions/**, mcp-server/**`, `exclude: tests, scripts, dist, **/*.test.mjs`.
- `noEmitOnError: false` means a type error still produces `dist/`; CI treats a non-zero `tsc` exit as failure.

### npm scripts

| Script | Command |
|---|---|
| `build` | `tsc` |
| `prepublishOnly` | `npm run build` |
| `test` | `node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/*.test.mjs` |
| `smoke` | `node scripts/smoke-mcp.mjs` |
| `smoke:broadside` | `node scripts/smoke-broadside.mjs` (opt-in, spends money, needs `OPENROUTER_API_KEY` + target path) |
| `demo:synthesis` | `npm run build && node scripts/create-synthesis-demo.mjs` |

### Package `codecartographer-pi`

- `files`: `.codecarto/**/*` minus `BACKLOG.md`, `THREAD_LOG.md`, `CONVENTIONS.md`, `DECISIONS.md`, `closeouts/**`, `broadside/**` (but including `broadside/SKILL.md` and `broadside/config.yaml`); `agent-skill/**/*`; `dist/**/*`; `assets/logo.svg`; `README.md`; `LICENSE`.
- `bin`: `codecarto-mcp` → `dist/mcp-server/bin.mjs`.
- `pi.extensions`: `["./dist/extensions"]` — Pi loads the compiled extension directory.
- `dependencies`: `@modelcontextprotocol/sdk ^1.29.0`. `peerDependencies`: `@earendil-works/pi-coding-agent >=0.84.0`, `@sinclair/typebox *`. `overrides`: `undici ^8.10.0`.
- `mcpName`: `io.github.HuginnIndustries/codecartographer`; `server.json` mirrors name, version 0.19.5, npm package identifier, stdio transport.
- Init-time state filter (`copyPackagedWorkspace`) is separate from the tarball filter and also excludes `closeouts/` contents and all of `broadside/` except the two template files (`core/workspace.ts:137-182`).

### CI (`.github/workflows/ci.yml`)

Trigger: `pull_request`, `push` to `main`. `permissions: contents: read`. Matrix `node-version: ['22','24']`, `fail-fast: false`. Steps: checkout@v7, setup-node@v7 (npm cache), `npm ci`, `npm audit --omit=dev --audit-level=high`, `npm run build`, `npm test`.

### Nightly smoke (`.github/workflows/smoke.yml`)

Trigger: `workflow_dispatch` (optional `version` input) and cron `17 6 * * *`. Same matrix. `npm ci` at repo root for the SDK client, then `node scripts/smoke-mcp.mjs [--version X]`, which `npm install --ignore-scripts` the published package into a temp dir, spawns the bin over `StdioClientTransport`, and asserts: handshake, `tools/list` equals the 22 expected names, `codecarto_init` (lite) → status → next, and four negative cases (missing cwd, relative cwd, complete-before-validate → MISSING, skill-before-complete).

### Release (`.github/workflows/release.yml`)

Trigger: push of tag `v*` or `workflow_dispatch`. `permissions: contents: write, id-token: write`. Steps: checkout (full depth), setup-node 22 with npm registry, resolve version and **fail if tag ≠ `package.json` version**, `npm ci`, `npm audit`, `npm test`, `npm run build`, `npm pack` into `$RUNNER_TEMP`, smoke-test the tarball via `scripts/smoke-mcp.mjs --tarball`, verify `NPM_TOKEN` non-empty and `npm whoami`, publish with `--provenance --access public` unless the version already exists, publish to the MCP Registry with `mcp-publisher v1.8.0` via `github-oidc` unless already listed, extract the `## [X.Y.Z]` section from `CHANGELOG.md` as release notes (generic fallback), `gh release create` unless it exists. Every publish step is idempotent so a rerun is safe.

### Release checklist derived from the workflows

Five places carry the version: `package.json`, `package-lock.json` (via `npm version`), `server.json` (two fields), `.codecarto/workflow/scaffold-version.yaml`, `CHANGELOG.md` heading. The release workflow checks only the first against the tag; `tests/release-metadata.test.mjs` exists (not read this phase) and presumably pins the rest `[inference]`.

### Distribution surfaces

npm (`codecartographer-pi`), MCP Registry (`io.github.HuginnIndustries/codecartographer`), GitHub Releases, Pi package install (`pi install npm:codecartographer-pi`, git URL, or local path), drop-in copy of `.codecarto/`.

## 2026-09-11 — porting

Packaging consequences from the audit (`observed fact` for the defects, `strong inference` for the consequence): the template must be shipped from a manifest that includes `.codecarto/.gitignore` and excludes outputs (D-H2, D-H7); the test suite must not read the live template (D-M11); five version-bearing files (`package.json`, `package-lock.json`, `server.json` ×2, `scaffold-version.yaml`, `CHANGELOG.md`) should be derived from one source in the port's release step; the release workflow's idempotent publish steps and tarball smoke test are worth keeping as-is.
