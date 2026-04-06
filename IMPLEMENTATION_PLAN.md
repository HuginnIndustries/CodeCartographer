# CodeCartographer — Implementation Plan

## Current State

CodeCartographer is a pure template: Markdown files, YAML pipeline definitions, and LLM-readable instructions. No executable code. It works today with any LLM that can read/write files (Claude Code, OpenCode, Aider, Cursor, etc.), but every guardrail is a "please don't" instruction rather than an enforced constraint.

The self-analysis (Demo 5) surfaced 15 defects. 10 were fixable in the template; 5 require code to enforce. This plan covers turning the template into a real tool.

## What Code Solves That the Template Can't

These are the defects that no amount of better Markdown can fix:

1. **Concurrent state corruption (high).** Two parallel phases overwrite each other's status.yaml updates. Needs file locking or per-phase state files.
2. **No validation gate enforcement (medium).** An LLM can mark a FAIL phase as complete. Needs code that reads the validation block and refuses to advance.
3. **No crash recovery (medium).** A session that dies mid-teardown leaves inconsistent state (output written, status not updated). Needs atomic teardown or reconciliation on startup.
4. **No output path verification (low).** An LLM can write findings to the wrong file path. Needs a post-write check against the pipeline definition.
5. **Self-reported validation only (portability hazard).** The LLM grades its own work. Needs automated structural checks (section presence, evidence tags, table completeness) as a first pass.

## Target Platforms

The tool should work as a wrapper around LLM coding agents, not replace them. Three viable integration paths:

### Option A: CLI Tool (Recommended First Step)

A standalone CLI that orchestrates the pipeline and delegates analysis to an LLM backend. Language: Python or TypeScript.

```
codecarto init --source ./my-repo --pipeline full-with-audit
codecarto run                    # runs next phase
codecarto run --parallel         # runs eligible parallel phases concurrently
codecarto status                 # shows pipeline progress
codecarto validate architecture  # re-validates a phase output
```

The CLI handles state management, validation gating, file locking, and crash recovery. The LLM does the actual analysis. This works with any LLM provider via an adapter.

**Pros:** Universal. Works with any LLM backend. Clean separation of concerns.
**Cons:** Requires installation. Users must configure an LLM API key or point to a local model.

### Option B: Claude Code / OpenCode Plugin

Package CodeCartographer as a plugin (bundled MCPs + skills + tools). The plugin provides:

- A `/codecarto` slash command that initializes and manages the pipeline
- MCP tools for state management (read/write status, validate, advance phase)
- Skills that wrap each phase's SKILL.md with enforcement logic

The host tool (Claude Code, OpenCode) handles file access and LLM interaction. The plugin handles orchestration.

**Pros:** Zero setup for users already in these tools. Native integration with the existing workflow.
**Cons:** Tied to specific host tools. Plugin APIs are still evolving.

### Option C: Aider / Cursor Extension

Similar to Option B but using the extension/plugin mechanisms of IDE-based tools. Aider supports custom commands; Cursor supports custom rules and MCP servers.

**Pros:** Meets users where they already work.
**Cons:** Fragmented — each tool has different extension mechanisms. Maintenance burden.

### Recommendation

Build Option A (CLI) first as the core engine. Then wrap it as a plugin (Option B) for Claude Code / OpenCode, and as extensions (Option C) for other tools. The CLI is the engine; the integrations are thin wrappers.

## Architecture

Eight modules, derived from the reimplementation spec (Demo 5):

```
┌─────────────────────────────────────────────────┐
│                   CLI / Plugin                   │
│              (thin command layer)                 │
├─────────────────────────────────────────────────┤
│                                                  │
│   M1: Pipeline Engine     M3: Phase Runner       │
│   (DAG resolution,        (orchestrates one      │
│    phase selection)        phase lifecycle)       │
│         │                       │                │
│         ▼                       ▼                │
│   M2: State Store         M4: Validator          │
│   (atomic writes,         (automated + LLM       │
│    file locking,           self-assessment)       │
│    crash recovery)                               │
│                                                  │
│   M5: LLM Adapter        M6: Skill Library      │
│   (provider abstraction,  (phase instructions,   │
│    context management)     defect-scan passes)   │
│                                                  │
│   M7: Template Library    M8: Output Store       │
│   (output schemas)        (write-once primary,   │
│                            append-only secondary)│
│                                                  │
└─────────────────────────────────────────────────┘
```

## Implementation Sequence

### Phase 1: Minimum Viable CLI (solves defects 1-4)

Build the core engine with one LLM provider (Anthropic Claude API).

**Deliverables:**
- `codecarto init` — scaffold workspace from template, select pipeline
- `codecarto run` — execute next eligible phase with validation gating
- `codecarto status` — display pipeline progress
- M1 Pipeline Engine — load YAML, resolve dependencies, select next phase
- M2 State Store — file-based with advisory locking, atomic writes, crash reconciliation on startup
- M3 Phase Runner — load skill + template + required reads, invoke LLM, collect output
- M4 Validator — automated structural checks (section headings present, evidence tags on every finding, validation table completeness) + LLM self-assessment
- M5 LLM Adapter — Anthropic Claude (single provider)
- M6 Skill Library — serve existing SKILL.md content
- M7 Template Library — serve existing template content
- M8 Output Store — write primary outputs, enforce write-once, append secondary

**Key decisions:**
- State format: JSON (not YAML) for mutable state. Avoids YAML parsing ambiguity. Pipeline definitions stay YAML (read-only, human-authored).
- Locking: `fcntl.flock()` on Unix, `msvcrt.locking()` on Windows (or use `filelock` library for cross-platform).
- Crash recovery: On startup, scan for outputs that exist but don't have a corresponding `complete` status. Offer to reconcile.

**Acceptance test:** Run the full 5-phase pipeline against a known codebase. Outputs match the quality and structure of the template-based workflow.

### Phase 2: Parallel Execution + Multi-Provider (solves defect 5)

**Deliverables:**
- `codecarto run --parallel` — run eligible parallel phases concurrently
- Per-phase state files (eliminate shared-file contention entirely)
- M5 adapters for OpenAI and local models (Ollama/vLLM)
- Automated validation: structural checks run before LLM self-assessment. If structural checks fail, skip LLM validation and return FAIL immediately.
- Output diffing: run same phase with two providers, diff the results for stability analysis

**Acceptance test:** Run contracts + protocols in parallel. Kill one mid-phase. Verify the other completes cleanly and the killed one recovers on restart.

### Phase 3: Plugin Wrappers

**Deliverables:**
- Claude Code plugin: MCP server wrapping the CLI engine + skills for each phase
- OpenCode plugin: same approach (both use Claude Code's plugin format)
- Aider integration: custom commands that shell out to the CLI
- Cursor integration: MCP server + custom rules

**Acceptance test:** A user in Claude Code can run `/codecarto` and get the same results as the CLI.

### Phase 4: Advanced Features

**Deliverables:**
- Phase re-run with automatic downstream cascade invalidation
- Incremental analysis for large codebases (analyze subsystems independently, merge)
- Web dashboard for viewing pipeline progress and outputs
- Two-pass defect scan (quick scan before contracts, deep scan after)
- Pipeline definition validation (verify referenced files exist, DAG is acyclic)

## Open Design Questions

These need decisions before or during implementation:

1. **Defect-scan placement.** Currently runs before contracts/protocols, which limits passes 4 and 5. Options: move it after (delays feedback), run it twice (expensive), or accept the weaker mode. Recommendation: run it twice in the full-with-audit pipeline — a quick pass early, a deep pass late.

2. **Cascade invalidation.** When re-running a phase, should downstream phases auto-invalidate? Recommendation: yes, with a `--no-cascade` flag for users who know what they're doing.

3. **State format migration.** Moving from YAML status.yaml to JSON state.json breaks backward compatibility with existing workspaces. Recommendation: support both on read, write only JSON going forward.

4. **Output format.** Keep Markdown for human readability, or switch to structured JSON with a Markdown renderer? Recommendation: keep Markdown as the primary output format (it's the whole point), but add a `--json` flag that outputs a structured sidecar file alongside the Markdown.

5. **Context window management.** For large codebases, the LLM can't read everything. The template says "finish the current section and write PARTIAL." The CLI should be smarter — chunk source code, prioritize by architecture map, and stitch partial outputs. This is a Phase 4 problem.

## Tech Stack Recommendation

| Component | Choice | Rationale |
|---|---|---|
| Language | Python 3.11+ | Widest LLM SDK support. Anthropic, OpenAI, and local model libraries all have first-class Python SDKs. |
| CLI framework | `click` or `typer` | Simple, well-documented, no magic. |
| LLM SDK | `anthropic` (Phase 1), `openai` + `litellm` (Phase 2) | Direct SDK for primary provider, litellm for multi-provider. |
| State storage | JSON files with `filelock` | Cross-platform locking. JSON avoids YAML ambiguity. |
| Testing | `pytest` + golden file tests | Compare CLI output against known-good runs. |
| Packaging | `pip install codecarto` (PyPI) | Standard Python distribution. |
| Plugin format | Claude Code plugin spec (`.plugin` zip) | Reusable for OpenCode. |

## Effort Estimate

| Phase | Scope | Rough Estimate |
|---|---|---|
| Phase 1: MVP CLI | Core engine + one provider | 2-3 weeks |
| Phase 2: Parallel + multi-provider | Concurrency + adapters | 1-2 weeks |
| Phase 3: Plugin wrappers | Thin integrations | 1 week per platform |
| Phase 4: Advanced features | Cascade, incremental, dashboard | Ongoing |

## Relationship to Current Template

The template doesn't go away. It remains:

- The **documentation source** for skills, templates, and pipeline definitions (the CLI reads them)
- The **fallback mode** for environments that can't run the CLI (paste into any LLM chat)
- The **reference implementation** that the CLI must match in output quality

The CLI is an orchestration layer on top of the template, not a replacement for it.
