# CodeCartographer — Roadmap

This document tracks future-facing work. For the current shipped surface, see [README.md](../README.md).

## Where We Are (v0.1.0)

Already shipped:

- **Template**: pure Markdown + YAML pipeline definitions in `.codecarto/`. LLM-agnostic.
- **`core/`**: pipeline state machine, YAML validators, prompt templates, workspace utilities.
- **Pi extension** (`extensions/codecarto/`): `/codecarto-init`, `/codecarto-status`, `/codecarto-next`, `/codecarto-validate`, `/codecarto-complete`, `/codecarto-phase`, `/codecarto-skill`, plus tool interception that blocks edits outside `.codecarto/`.
- **MCP server** (`mcp-server/`): same seven primitives exposed to any MCP host (Claude Code, Claude Desktop). Imports the same `core/` as the Pi extension, so phase prompts and validation are byte-identical.
- **Pipelines**: `architecture-only`, `lite`, `defect-scan`, `full`, `full-with-audit`, and `full-with-deep-audit` (default). The deep-audit variant splits the defect scan into a mechanical early pass and a semantic late pass.
- **CI**: invariant tests (`tests/`) catch cross-wrapper drift between the template, Pi extension, and MCP server.

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
