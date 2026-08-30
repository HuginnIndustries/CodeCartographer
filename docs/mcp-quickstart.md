# Add CodeCartographer to your coding agent in 30 seconds

CodeCartographer works with any MCP-capable agent. The MCP server returns phase prompts and validation; your agent drives the conversation and runs the model. One install, one config block, done.

## Step 1 — Install

```bash
npm install --global codecartographer-pi
```

Verify the binary is on your `PATH`:

```bash
which codecarto-mcp
```

`codecarto-mcp` is a stdio MCP server — running it directly will start it and wait for JSON-RPC input rather than printing anything. That's expected; your agent launches it for you. Press Ctrl-C if you started it by hand.

## Step 2 — Add to your agent

Pick your agent below and paste the config block into the right file. That's it.

### Claude Code

Add it with the CLI — no config file editing needed:

```bash
claude mcp add codecartographer -- codecarto-mcp
```

Add `--scope user` to make it available in every project instead of just the current one. To check it registered, run `claude mcp list`.

To share the server with everyone working on a repo, commit a `.mcp.json` at the repo root instead:

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

Edit `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` in a repo root for just that project:

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

Codex uses TOML, not JSON. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.codecartographer]
command = "codecarto-mcp"
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

opencode uses an `mcp` key with its own shape — not `mcpServers`, and `command` is an array. Edit `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "codecartographer": {
      "type": "local",
      "command": ["codecarto-mcp"],
      "enabled": true
    }
  }
}
```

## Step 3 — Run

In the repo you want to understand, ask your agent to run the pipeline. The canonical flow:

1. **`codecarto_init`** — copies `.codecarto/` into the repo, picks the pipeline variant.
2. **`codecarto_next`** — returns the next phase's prompt. Your agent runs it (reads source, writes findings).
3. **Write the phase handoff** at `.codecarto/scratch/handoffs/<phase-id>.yaml` — owner notes, open questions, and any routing to a later phase. The framework owns `status.yaml`, the closeouts, and `THREAD_LOG.md`; this file is how a session proposes changes to them.
4. **`codecarto_validate`** — checks the phase output against completion criteria.
5. **`codecarto_complete`** — applies the handoff to `status.yaml` and writes the closeout and log entry.
6. Repeat `codecarto_next` → handoff → validate → complete until the pipeline finishes.

**Building an integration?** Call **`codecarto_guide`** — the server returns these instructions in full, including the handoff schema, executor choice, and recovery patterns. Nothing to install; it takes no workspace. The same content ships as an installable agent skill at `agent-skill/codecartographer/` inside the package, which you can copy into `~/.claude/skills/`, `~/.hermes/skills/`, or wherever your agent loads skills from.

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

- `findings/architecture/architecture-map.md` — layers, dependency direction, public surfaces
- `findings/defect-scan-mechanical/mechanical-defects.md` — logic, security, concurrency, API bugs with file:line evidence
- `findings/contracts/behavioral-contracts.md` — behavioral contracts with defaults and acceptance tests
- `findings/protocols/protocols-and-state.md` — event flows, state machines, persistence formats
- `findings/defect-scan-semantic/semantic-defects.md` — deeper semantic defects, run after protocols
- `findings/porting/reverse-engineering-bundle.md` — synthesis bundle with priority rankings
- `findings/reimplementation-spec/reimplementation-spec.md` — the final build spec

Every finding is tagged: `observed fact`, `strong inference`, `portability hazard`, or `open question`.

## Optional: scout first with Broad-Side

On a repository too large to skim, `codecarto_broadside` fires six analysis lenses at it as cheap asynchronous batch jobs over the OpenRouter Batch API and produces an executive report plus a prioritized work order — a map of where the expensive interactive run should spend its attention.

```
codecarto_broadside {cwd: "/abs/path/to/repo", action: "submit"}
codecarto_broadside {cwd: "/abs/path/to/repo", action: "collect"}
```

It needs an OpenRouter API key (`api_key` parameter, `OPENROUTER_API_KEY`, or `.codecarto/broadside/config.yaml`) and works on any git repository, with or without a workspace. Submit prices the run first and refuses anything over `max_cost`. Its findings are **unverified leads, not evidence** — see the [Broad-Side section](../README.md#broad-side-batch-reconnaissance) in the README.

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
