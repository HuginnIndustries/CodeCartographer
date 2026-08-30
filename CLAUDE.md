# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                  # install (lockfile-strict)
npm run build           # tsc compile to dist/ (required before publish; CI runs this)
npm test                # node --experimental-strip-types --test tests/*.test.mjs
npm run smoke           # end-to-end MCP smoke test against the published npm package
npm run smoke:broadside # opt-in live Broad-Side run (spends real money; needs OPENROUTER_API_KEY + a target repo)

# Run a single test file:
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/pipeline-invariants.test.mjs

# Run the Pi extension locally against the in-tree source (no rebuild needed):
pi -e /absolute/path/to/CodeCartographer/extensions/codecarto/index.ts
```

Node >= 20 is the floor; CI tests on Node 22 and 24. There is no linter.

## Architecture

CodeCartographer is one framework shipped through **three delivery surfaces** that produce byte-identical phase prompts and validation behavior. The numbering below reflects code-architecture (source-of-truth-out) ordering; the user-facing recommendation ordering in README.md is different — see "Surface priority" below.

1. **`.codecarto/`** — the drop-in template (Markdown + YAML, no executable code). This is both the source of truth committed in this repo *and* the directory that gets copied into a user's target repo on `codecarto-init`. `core/workspace.ts` exposes it as `packagedWorkspaceDir`, resolved at runtime by walking up from `core/` to find the nearest `package.json`.
2. **`extensions/codecarto/`** — Pi extension. Registers `/codecarto-*` slash commands, runs phases as isolated `AgentSession` sub-agents (`auto-runner.ts`), renders the live widget (`agent-widget.ts`), and writes the HTML dashboard (`dashboard-writer.ts`). The `tool_call` hook in `index.ts` blocks `bash` outright and confines `edit`/`write` to `.codecarto/` plus the configured library path.
3. **`mcp-server/`** — MCP server exposing the workflow, library, and Broad-Side operations as JSON-RPC tools over stdio. Never spawns sub-agents; returns prompt text for the host to dispatch.

Both wrappers import everything they share from `core/index.ts` (barrel re-export). **If you add a primitive used by both surfaces, it goes in `core/` and must be re-exported through `index.ts`.** Wrapper-specific logic (UI, sub-agent lifecycle, MCP plumbing) stays in the wrapper.

### Surface priority (for user-facing docs)

The byte-identical-prompts invariant above is a *code-architecture* property — all three surfaces ship the same phase prompts and the same validation logic, and the invariant tests catch any drift. But the three surfaces are **not** equally polished from a user perspective, and README.md / CHANGELOG / new-feature UX work should treat them in this order:

1. **Pi extension (recommended user surface).** First-class UX: slash commands, live widget, isolated sub-agents, auto-runner, dashboard, per-phase usage tracking, opt-in LLM steering. New features land here first.
2. **MCP server (for other coding agents).** Same prompts, same validation, same outputs. Intended for Claude Code, Codex, opencode, Cursor, and any other MCP-capable host. The host drives; the framework provides phase prompts plus library publish/list/reindex operations. New features reach parity here second.
3. **Drop-in template (one-off / evaluation).** Pure `.codecarto/` markdown + YAML, no executable code. For trying CodeCartographer in any repo before installing anything. Library and synthesis workflows are **not available** in pure drop-in mode — those require Pi or MCP. The analysis side works fully drop-in.

When adding a feature, the question to ask is "does this work on all three surfaces, or only the executable ones?" Pure prompt + template work lands in `.codecarto/` and propagates to all three. Anything that needs runtime code (publish, dashboard, sub-agents) only lands on Pi and MCP, with documentation in the drop-in path explaining the limitation.

### Core modules

- `core/pipeline.ts` — pipeline alias table (`PIPELINE_ALIASES`), DAG walking (`getNextEligiblePhase`), validation parser (`validatePhaseOutput` reads the markdown `## Validation` table from the phase's primary output).
- `core/status.ts` — `status.yaml` normalization + atomic update with file lock (`updateStatusAtomically`).
- `core/prompts.ts` — phase and skill prompt assembly. Output here is what the LLM actually sees; tests check byte-identical assembly across surfaces.
- `core/workspace.ts` — `getWorkspaceState`, `packagedWorkspaceDir`, `PACKAGE_VERSION` (read from `package.json` at module load).
- `core/dashboard.ts` — single-file HTML renderer for `.codecarto/dashboard.html` (no JS, no external assets, light/dark via `prefers-color-scheme`).
- `core/usage.ts` — per-phase token/duration log at `.codecarto/workflow/.usage.local.yaml`.
- `core/orchestrator-config.ts` — loads `.codecarto/workflow/config.yaml` (the `orchestrator.llm_steer_next_phase` flag lives here).
- `core/library.ts` — versioned library discovery, publication, reads, listing, reindexing, and optional git commits shared by Pi and MCP.
- `core/synthesis.ts` — vision/library/proposal preflight and exact confirmed-version resolution for the four-phase synthesis workflow.
- `core/broadside.ts` — Broad-Side batch reconnaissance: lens registry and prompts, repo slicing, OpenRouter Batch API submit/poll/collect, model catalog and cost pre-flight, synthesis and triage post-passes, and `.codecarto/broadside/` state. Executable surfaces only (Pi via `/codecarto-broadside`, MCP via `codecarto_broadside`); the template carries just the reading guide.

### Pipeline shape

Pipelines are YAML DAGs in `.codecarto/workflow/pipeline*.yaml`. Each `PipelinePhase` declares `depends_on`, `primary_output`, `required_reads`, `completion_criteria`, etc. The active variant is the `pipeline:` field in `status.yaml`; six analysis variants plus the forward-synthesis pipeline ship today, and the default is `pipeline-full-with-deep-audit.yaml`. Phases form a DAG (contracts and protocols run in parallel after architecture), not a linear chain — `getNextEligiblePhase` walks `phase_order` and picks the first non-`complete` phase whose deps are all `complete`.

### Invariant tests are the load-bearing guardrail

`tests/pipeline-invariants.test.mjs` and the sibling tests catch drift between:

- pipeline YAMLs (phase_order consistency, every `depends_on` references a real phase, every `required_reads` and `primary_output` path exists, every SKILL.md cites real report paths)
- the Pi and MCP wrappers (same phase prompt for the same inputs, same validation result)
- pipeline aliases vs. files on disk

**Any change to a phase prompt, validation criterion, SKILL.md path, or pipeline YAML schema must keep all three surfaces aligned and the invariant tests green.** This is the single most important review concern in this repo.

### TypeScript setup

`tsconfig.json` has `allowImportingTsExtensions: true` and `rewriteRelativeImportExtensions: true`. Source files import each other with explicit `.ts` extensions (e.g. `import { ... } from "./types.ts"`) and the compiler rewrites those to `.js` in `dist/`. `strict` is **off**. Tests are `.mjs` and use Node's experimental TS strip (`--experimental-strip-types`) to load `.ts` modules directly without a build step.

## Conventions

- **Commit message prefixes** (from `git log` history): `feat:`, `fix:`, `docs:`, `refactor:`, `ci:`, and `framework:` for changes inside `.codecarto/`.
- **PRs target `main`.** CI (`.github/workflows/ci.yml`) runs on every PR and push to `main`.
- **Release is tag-driven, not merge-driven.** Bumping `package.json` + `CHANGELOG.md` does not ship a release on its own — someone must push the matching `vX.Y.Z` tag (see CONTRIBUTING.md "Maintainer Release Process"). The npm publish + GitHub release fires only on `v*` tag pushes.
- **Don't vendor an LLM provider into the framework.** Hosts own the LLM connection — that's why MCP returns prompt text rather than calling a model itself.
- **Breaking changes to `.codecarto/` paths or pipeline YAML schema are out of scope** without prior discussion. They are ABI for every user with an existing workspace.

## Important constraints when editing in this repo

When this repo is itself opened as a CodeCartographer workspace (via the Pi extension), the `tool_call` hook in `extensions/codecarto/index.ts` blocks `bash` and confines `edit`/`write` to `.codecarto/`. That hook only fires inside the Pi extension's process — Claude Code is not constrained by it. But the *intent* of that constraint applies: when modifying files under `.codecarto/`, treat them as the canonical template that gets copied verbatim into users' repos, not as scratch space.
