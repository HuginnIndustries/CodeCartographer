# Add CodeCartographer to your coding agent in 30 seconds

CodeCartographer works with any MCP-capable agent. The MCP server returns phase prompts and validation; your agent drives the conversation and runs the model. One install, one config block, done.

## Step 1 — Install

```bash
npm install --global codecartographer-pi
```

Verify:

```bash
codecarto-mcp --version
```

## Step 2 — Add to your agent

Pick your agent below and paste the config block into the right file. That's it.

### Claude Code

Edit `~/.config/claude-code/config.json`:

```json
{
  "mcpServers": {
    "codecartographer": {
      "command": "codecarto-mcp"
    }
  }
}
```

Then in any repo you want to analyze:

```
Use the codecartographer MCP server to analyze this repo. Start with codecarto_init, then run codecarto_next repeatedly until the pipeline finishes.
```

### Cursor

Edit `~/.cursor/config.json` (or `~/.config/cursor/config.json` on Linux):

```json
{
  "mcpServers": {
    "codecartographer": {
      "command": "codecarto-mcp"
    }
  }
}
```

Then in the Cursor chat, in the repo you want to analyze:

```
Use the codecartographer MCP tools to analyze this codebase. Start with codecarto_init, then walk the pipeline with codecarto_next.
```

### Codex (OpenAI)

Edit `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "codecartographer": {
      "command": "codecarto-mcp"
    }
  }
}
```

Then in the repo you want to analyze:

```
Use the codecartographer MCP server. Run codecarto_init to set up the workspace, then run codecarto_next to advance through the analysis phases.
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "codecartographer": {
      "command": "codecarto-mcp"
    }
  }
}
```

Then ask Claude to analyze a repo's code (point it at a local checkout).

### opencode

Edit `~/.config/opencode/config.json`:

```json
{
  "mcpServers": {
    "codecartographer": {
      "command": "codecarto-mcp"
    }
  }
}
```

## Step 3 — Run

In the repo you want to understand, ask your agent to run the pipeline. The canonical flow:

1. **`codecarto_init`** — copies `.codecarto/` into the repo, picks the pipeline variant.
2. **`codecarto_next`** — returns the next phase's prompt. Your agent runs it (reads source, writes findings).
3. **`codecarto_validate`** — checks the phase output against completion criteria.
4. **`codecarto_complete`** — advances `status.yaml`.
5. Repeat `codecarto_next` → validate → complete until the pipeline finishes.

The final artifact is `.codecarto/findings/reimplementation-spec/reimplementation-spec.md` — a language-agnostic build spec with module inventory, acceptance scenarios, and known unknowns.

## Pipeline variants

| Variant | Phases | Use when |
|---|---|---|
| **Full with deep audit** (default) | 7 | Complete analysis with split defect scan |
| **Lite** | 3 | Understand behavior without porting plans |
| **Architecture only** | 1 | Quick structural overview |
| **Synthesis** | 4 | Turn a vision + library specs into an implementation plan |

Pass `pipeline: "<variant>"` to `codecarto_init` to choose. See the [pipeline variants table](../README.md#pipeline-variants) in the README for the full list.

## What you get

- `findings/architecture/architecture.md` — layers, dependency direction, public surfaces
- `findings/defect-scan/defects.md` — logic, security, concurrency, API bugs with file:line evidence
- `findings/contracts/contracts.md` — behavioral contracts with defaults and acceptance tests
- `findings/protocols/protocols.md` — event flows, state machines, persistence formats
- `findings/porting/porting-bundle.md` — synthesis bundle with priority rankings
- `findings/reimplementation-spec/reimplementation-spec.md` — the final build spec

Every finding is tagged: `observed fact`, `strong inference`, `portability hazard`, or `open question`.

## No agent? Use the drop-in template

If your tool doesn't speak MCP, copy the template directly:

```bash
cp -r /path/to/CodeCartographer/.codecarto /path/to/your-repo/
```

Then in any LLM session: `Read .codecarto/GUIDE.md and begin the analysis.`

The analysis pipeline works fully in drop-in mode. Library publish and synthesis workflows require the MCP server or Pi extension.

## Troubleshooting

- **`codecarto_init` says the workspace exists** — pass `force: true` to overwrite (backs up the old `.codecarto/` first).
- **`codecarto_next` returns "no eligible phase"** — all phases are complete. Check `codecarto_status`.
- **`codecarto_validate` returns FAIL** — open the phase's output file, fix the gap, re-run validation. The pipeline won't advance past a FAIL.
- **Agent can't find the MCP server** — confirm `codecarto-mcp` is on your `PATH` (`which codecarto-mcp`). If not, reinstall globally or use the full path in the config.

## Official MCP Registry

[io.github.HuginnIndustries/codecartographer](https://registry.modelcontextprotocol.io/?search=CodeCartographer)