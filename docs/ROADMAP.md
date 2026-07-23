# CodeCartographer — Roadmap

This document tracks future-facing work. For the current shipped surface, see [README.md](../README.md).

## Where We Are (v0.12.3)

Already shipped:

- **Template**: pure Markdown + YAML pipeline definitions in `.codecarto/`. LLM-agnostic.
- **`core/`**: pipeline state machine, YAML validators, prompt templates, workspace utilities, workspace-config loader (`orchestrator-config.ts`), local usage log (`usage.ts`).
- **Pi extension** (`extensions/codecarto/`):
  - Slash commands: `/codecarto-init`, `/codecarto-status`, `/codecarto-next` (with `--llm-steer` / `--no-llm-steer` flags), `/codecarto-validate`, `/codecarto-complete`, `/codecarto-phase`, `/codecarto-skill`, `/codecarto-usage`.
  - Tool interception: blocks `bash` outright and `edit`/`write` outside `.codecarto/`.
  - **Phase sub-agents (0.2.0).** `/codecarto-next` spawns each phase as a parallel `AgentSession` with a live "Agents" widget above the editor. Orchestrator's TUI stays responsive; phase context window is isolated from the orchestrator's.
  - **File-backed sessions (0.3.0).** Phase transcripts persist under `~/.pi/agent/sessions/<encoded-cwd>/` with a `CodeCartographer phase: <id>` display name and `parentSession` lineage; visible in `/resume`, `/tree`, `/export`.
  - **Phase-completion summary (0.4.0).** Markdown closeout block injected into the orchestrator's session via `pi.sendMessage` on every phase finish. No auto-trigger; user-controlled.
  - **LLM-steered seed prompt (0.5.0).** Opt-in via `orchestrator.llm_steer_next_phase` in `.codecarto/workflow/config.yaml` or `--llm-steer` per invocation. Reads the previous phase's closeout and customizes the next phase's seed prompt; falls back to the stock prompt on any failure.
  - **Local usage log (0.6.0).** Append-only `.usage.local.yaml` per workspace; `/codecarto-usage` renders cumulative + per-phase totals.
- **MCP server** (`mcp-server/`): workflow primitives exposed to any MCP host (Claude Code, Claude Desktop) plus experimental library publish / list / reindex tools. Imports the same `core/` as the Pi extension, so phase prompts and validation are byte-identical. The phase-orchestration features above are Pi-only — the MCP path returns prompt text for the host to dispatch and never runs sub-agents itself.
- **Pipelines**: `architecture-only`, `lite`, `defect-scan`, `full`, `full-with-audit`, and `full-with-deep-audit` (default). The deep-audit variant splits the defect scan into a mechanical early pass and a semantic late pass.
- **Forward synthesis**: a four-phase Pi/MCP workflow turns a product vision and explicitly confirmed, versioned library specifications into a conflict-aware `project-plan.md` with decision-level provenance. Runtime preflight enforces the human confirmation gate before merge or finalization.
- **CI**: invariant tests (`tests/`) catch cross-wrapper drift between the template, Pi extension, and MCP server. Release pipeline is tag-driven (`v*` tag pushes only) — see `CONTRIBUTING.md` for the maintainer release process.

## What's Next

The original implementation plan called for a standalone CLI. That role is now filled by the Pi extension and MCP server, both of which delegate file access and LLM invocation to the host. We don't plan to ship a separate CLI unless a clear user need surfaces.

Open future-facing items:

### Launch proof package (active)

The v0.12.3 npm, GitHub, website, and official MCP Registry release gates are
complete. The next launch milestone is durable, inspectable proof before any
short-lived promotional channel:

- [ ] Publish the CodeCartographer self-analysis case study.
- [ ] Publish the forward-synthesis case study, including the unchecked proposal,
      human confirmation, conflict ledger, and provenance-backed project plan.
- [ ] Publish the pinned `sindresorhus/p-map` analysis before Product Hunt.
- [ ] Capture the real dashboard and provenance-ledger screenshots and complete
      the concise walkthrough or video.
- [ ] Prepare Show HN, DevHunt, OpenAI Developer Community, and Product Hunt
      assets only after their proof and account-readiness gates pass.

The authoritative requirements, reproduction metadata, status, and channel
sequencing live in the
[v0.12.x discoverability and launch plan](plans/2026-07-21-v0.12.1-discoverability-launch.md).

### Forward-flow synthesis (shipped in v0.12.0)

A library + synthesis pipeline turns CodeCartographer from analysis-only into analysis + synthesis: accumulate `reimplementation-spec.md` artifacts in a git-trackable library, then synthesize a `project-plan.md` from a vision plus explicitly confirmed, version-pinned entries.

- **M0 ✅ Docs + design freeze.** `docs/library-format.md` (experimental schema), surface-priority reframe in README + CLAUDE.md, `synthesis-roadmap.md` tracker.
- **M1 ✅ Library foundations.** `core/library.ts` with publish / read / list / reindex / commit primitives. User-global `~/.codecarto/config.yaml` plumbing in `core/orchestrator-config.ts`. 23 new library tests + 7 new config tests (119 → 156).
- **M2a ✅ MCP library tools.** `codecarto_publish` / `codecarto_library_list` / `codecarto_library_reindex` expose the library primitives to MCP-capable hosts.
- **M2b ✅ Pi publish UX.** Pi `/codecarto-publish` exposes the shared library primitives with confirmation and write-boundary handling.
- **M3 ✅ Synthesis pipeline.** `vision-capture` → `goal-synthesis-propose` (markdown-checkbox confirmation gate) → `spec-merge` → `goal-synthesis-finalize`, with shared Pi/MCP preflight.
- **M5 ✅ Initial release polish.** v0.12.0 shipped the implementation, regression suite, demo fixture, Build Week documentation, and website positioning.

Remaining synthesis work:

- Dashboard library-state surfacing.
- **M4:** `pipeline-spec-mutate.yaml` — apply deltas to an existing spec and republish as a new library version.
- Live-LLM semantic evaluation of plan quality beyond the tested runtime, prompt, and artifact contracts.
- Library schema stabilization before v2.

### Validation hardening

- Automated structural pre-checks (section presence, evidence-tag coverage, table completeness) before LLM self-assessment, so a structurally broken output fails fast without burning tokens on self-grading.
- Output path verification against the active pipeline definition.

### Concurrency

- Per-phase state files to remove contention on `status.yaml` when running parallel-eligible phases (currently `contracts` and `protocols`).
- Atomic teardown / crash reconciliation: detect outputs that exist without a corresponding `complete` status and offer to reconcile.

### Additional host integrations

- Aider custom commands.
- Cursor MCP rules.
- OpenCode plugin (likely thin if it adopts Claude Code's plugin spec).

### Pipeline features

- Cascade invalidation on phase re-run, with `--no-cascade` opt-out.
- Incremental analysis for very large codebases: chunk source by architecture-map priorities, stitch partial outputs.
- Optional structured-JSON sidecar alongside the Markdown findings.

## Open Design Questions

1. **State format.** `status.yaml` is human-readable but YAML parsing has edge cases. Worth migrating mutable state to JSON while keeping pipeline definitions in YAML? (Read both, write JSON going forward.)
2. **Cascade default.** When `contracts` is re-run, should `porting` and `reimplementation-spec` auto-invalidate? Leaning yes.
3. **Defect-scan placement.** The two-pass split (mechanical early, semantic late) is now the default. Worth surfacing a tunable threshold so users can opt back into the single early scan for codebases where the second pass adds little?

## Non-goals

- A bundled LLM provider. The host owns the LLM connection.
- Replacing the template. The template remains the documentation source and the fallback mode for environments without Pi or MCP.
