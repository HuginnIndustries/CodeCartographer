# Build and Deploy

> Secondary output (mode: append). Owns the catalog-level build, packaging, and release
> detail. The architecture map owns the summary. Add a dated section per phase.

## 2026-09-14 — architecture phase

### Toolchain

`observed fact`: `package.json`, `tsconfig.json`, `CLAUDE.md`.

- **Package:** `codecartographer-pi` v0.25.0, `"type": "module"`, ESM throughout.
- **Runtime floor:** Node `>=20`; CI matrix Node 22 and 24; no native addons.
- **Compiler:** `typescript ^5.9.3`, `npm run build` → `tsc`. Key options:
  `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`,
  `allowImportingTsExtensions: true`, `rewriteRelativeImportExtensions: true`,
  `rootDir "."`, `outDir "dist"`, `declaration: true`, `isolatedModules: true`,
  `allowJs: true`, `strict: false`, `noEmitOnError: false`.
- `tsconfig.include`: `core/**/*`, `extensions/**/*`, `mcp-server/**/*`;
  excludes `node_modules`, `tests`, `dist`, `scripts`, `**/*.test.mjs`.
- Source imports use explicit `.ts` extensions; the compiler rewrites them to `.js` in `dist/`.

### Build steps

1. `npm ci` (lockfile-strict).
2. `npm run build` (`tsc`) → `dist/core/**`, `dist/extensions/**`, `dist/mcp-server/**`
   (JS + `.d.ts`).
3. (Release) `npm pack` → tarball, then smoke-test the packed tarball.

### Output artifacts and packaging

`observed fact`: `package.json` `files`, `bin`, `pi`.

- **npm tarball contents:** `.codecarto/**/*` with explicit exclusions
  (`BACKLOG.md`, `THREAD_LOG.md`, `CONVENTIONS.md`, `DECISIONS.md`, `closeouts/**`,
  `broadside/**` except `SKILL.md`+`config.yaml`), `agent-skill/**/*`, `dist/**/*`,
  `assets/logo.svg`, `README.md`, `LICENSE`.
- **Bin:** `codecarto-mcp` → `dist/mcp-server/bin.mjs`.
- **Pi registration:** `pi.extensions` → `./dist/extensions`.
- **Peer deps:** `@earendil-works/pi-coding-agent >=0.84.0`, `@sinclair/typebox` (peer);
  runtime dep `@modelcontextprotocol/sdk ^1.29.0`; dev dep `typescript`.
- **Overrides:** `undici ^8.10.0`, `hono ^4.13.5`.
- No Docker, no OS packages, no build matrices beyond Node version.

### Tests

`observed fact`: `package.json` `test`; `tests/`.

- `npm test` = `node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/*.test.mjs`.
- No build required: tests load `.ts` sources directly via the experimental TS strip.
- ~90 test files. Their stated purpose is **cross-wrapper drift detection**: pipeline YAML
  invariants, byte-identical Pi/MCP phase prompts and validation, pipeline-alias/file
  consistency, completion commit-point ordering, closure integrity, config problems,
  YAML round-trips, dashboard self-containment, library behavior, Broad-Side behavior,
  scaffold refresh/init isolation, sandbox/path containment, and more.
- `CLAUDE.md` calls the invariant suite "the single most important review concern":
  any change to a phase prompt, criterion, SKILL path, or pipeline schema must keep all
  three surfaces aligned.
- There is **no linter**.

### Smoke tests

`observed fact`: `scripts/`, `.github/workflows/smoke.yml`.

- `scripts/smoke-mcp.mjs` (npm `smoke`) — drives the MCP server end to end; can install a
  published version or a packed tarball (`--tarball`, `--version`).
- `scripts/smoke-broadside.mjs` (npm `smoke:broadside`) — opt-in live Broad-Side run
  (spends real money; needs `OPENROUTER_API_KEY` + a target repo).
- `scripts/create-synthesis-demo.mjs` (npm `demo:synthesis`) and
  `scripts/build-demo-dashboard.mjs` — demo generators.
- `smoke.yml`: manual dispatch + nightly cron, matrix Node 22/24.

### CI/CD

`observed fact`: `.github/workflows/{ci,release,smoke}.yml`.

- **`ci.yml`** — on PR and push to `main`: checkout, setup-node (22/24, npm cache),
  `npm ci`, `npm audit --omit=dev --audit-level=high`, `npm run build`, `npm test`.
- **`release.yml`** — on `v*` tag push or manual dispatch:
  1. Resolve `package.json` version; on a tag push the tag must equal the version.
  2. `npm ci`; audit; `npm test`; `npm run build`.
  3. `npm pack` to a temp dir and run `scripts/smoke-mcp.mjs --tarball`.
  4. Verify npm auth (`NPM_TOKEN`), then idempotent
     `npm publish --registry https://registry.npmjs.org/ --provenance --access public`.
  5. Idempotent publish to the MCP Registry (`io.github.HuginnIndustries/codecartographer`)
     via GitHub OIDC `mcp-publisher`.
  6. Extract the CHANGELOG section for the version and create an idempotent GitHub Release.
- Release is **tag-driven, not merge-driven** (`CLAUDE.md`).

### Distribution channels and platform packaging

- **npm registry** — primary distribution (`npm install --global codecartographer-pi`;
  Pi install via `pi install npm:codecartographer-pi`).
- **MCP Registry** — discovery listing for Claude Code/Cursor etc.
- **GitHub Releases** — release notes per tag.
- **Local checkout** — `pi install /absolute/path` or `pi -e extensions/codecarto/index.ts`.
- **Drop-in** — `cp -r .codecarto <target-repo>/` (no executable surfaces available).
- No platform-specific packaging (no brew, no apt, no Windows installer).

### Deploy-time considerations

- `prepublishOnly` runs `npm run build`.
- `package.json` `files` excludes live project state from the tarball; the same exclusion is
  enforced at init time by `copyPackagedWorkspace`/`listDeclaredOutputs` so a checkout
  install cannot leak one project's findings into a new workspace.
- A fresh workspace gets its ignore rules from `templates/gitignore` → `.gitignore`
  (`ensureWorkspaceGitignore`), because npm never packs a file named `.gitignore`.

## 2026-09-15 — porting phase

Port-oriented companion to `findings/porting/reverse-engineering-bundle.md`. This is the first
addendum since architecture; it records what the port must decide about building, packaging, and
release.

### What a port must reproduce

- **One compiled core + thin adapters.** The source ships one `tsc` build producing `core/`,
  `extensions/`, and `mcp-server/` JS plus `.d.ts`, one bin (`codecarto-mcp`), and a Pi extension
  registration; the `.codecarto/` template and `agent-skill/` ship as data in the same package. A
  port should preserve this shape: shared behavior in one buildable unit, delivery surfaces as
  adapters, and the protocol (`.codecarto/`, skills, templates) as data that can change without a
  rebuild.
- **Data/packaging separation.** The packaged template excludes live project state
  (`findings/`, `scratch/`, `closeouts/`, orchestrator files, dashboard), and init-time copying
  applies the same exclusion so a checkout install cannot leak one project's state into another.
  The port needs an equivalent exclusion at **both** pack time and init time.
- **`.gitignore` handling.** npm never packs a file named `.gitignore`, so the source ships
  `templates/gitignore` and writes it at init/refresh when absent. A port using a different packer
  must decide whether it can ship the ignore file directly or needs the same indirection.

### What a port may cut or change

- **No build matrix is required.** Node `>=20`, no native addons, no containers. A port targeting a
  compiled language replaces `tsc` with its own build; the CI matrix, smoke scripts, and
  tag-driven release are distribution choices, not contracts.
- **The release pipeline is optional.** The tag/version match, `npm publish --provenance`, MCP
  Registry publish, and CHANGELOG-driven GitHub Release are the reference distribution flow; a
  port needs *a* release path, not this one. The two idempotent publishes are worth copying as a
  pattern (never publish a version twice).
- **`npm test`'s no-build, experimental-strip loading is incidental.** What matters is that the
  invariant suite (byte-identical prompts, pipeline consistency, commit-point ordering, closure
  integrity, config problems, YAML round-trips, dashboard self-containment, sandbox containment)
  is ported as the port's own test suite — it is the executable form of CONVENTIONS C01–C05.

### Distribution channels

A port should pick one primary channel and keep the drop-in `.codecarto/` template usable
independently: the drop-in path carries analysis/synthesis by prompt but no executable surfaces.
