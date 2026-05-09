# CodeCartographer — Roadmap

This document tracks future-facing work. For the current shipped surface, see [README.md](../README.md).

## Where We Are (v0.6.0)

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
- **MCP server** (`mcp-server/`): seven primitives exposed to any MCP host (Claude Code, Claude Desktop). Imports the same `core/` as the Pi extension, so phase prompts and validation are byte-identical. The phase-orchestration features above are Pi-only — the MCP path returns prompt text for the host to dispatch and never runs sub-agents itself.
- **Pipelines**: `architecture-only`, `lite`, `defect-scan`, `full`, `full-with-audit`, and `full-with-deep-audit` (default). The deep-audit variant splits the defect scan into a mechanical early pass and a semantic late pass.
- **CI**: invariant tests (`tests/`) catch cross-wrapper drift between the template, Pi extension, and MCP server. Release pipeline is tag-driven (`v*` tag pushes only) — see `CONTRIBUTING.md` for the maintainer release process.

## What's Next

The original implementation plan called for a standalone CLI. That role is now filled by the Pi extension and MCP server, both of which delegate file access and LLM invocation to the host. We don't plan to ship a separate CLI unless a clear user need surfaces.

Open future-facing items:

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
