# Client surfaces

CodeCartographer reaches users through four surfaces in regular use. They are not four instances of one integration — one of them never touches MCP — so a change that is safe on one can be broken on another.

| Surface | Path into the framework | Fails independently of the others because |
|---|---|---|
| **Pi** | `extensions/codecarto/`, imports `core/` directly | never constructs an MCP result; breaks on `core/` and prompt changes the MCP path tolerates |
| **Claude Code** | MCP server over stdio | reads the MCP result envelope its own way (see below) |
| **Codex** | MCP server over stdio | same |
| **Hermes** | MCP server over stdio | same |

## The MCP result envelope

A tool result can carry the same information twice:

- `content[0].text` — the human-readable payload
- `structuredContent` — machine-readable fields

Clients choose which to surface, and they do not choose alike. This is not a detail: for the tools whose payload *is* prose — `codecarto_next`, `codecarto_phase`, `codecarto_skill`, `codecarto_vision`, `codecarto_guide` — reading the wrong field means receiving labels and no payload.

Observed behavior:

| Client | Reads | Evidence |
|---|---|---|
| Claude Code (desktop) | `structuredContent` when present | `codecarto_next` returned `{phase, forced}` with no prompt on 0.14.0 (#94) |
| Hermes | `content` | ran a full `lite` architecture phase end to end on the same 0.14.0 build |
| Codex | **unknown** | its binary deserializes `structuredContent` as part of `CallToolResult`, which proves it parses the field, not that it prefers it. Not yet exercised against a running server. |
| Pi | n/a | does not go through MCP |

Since 0.14.1, `textResult` carries the rendered text in `structuredContent` under a `text` key, so both conventions receive the payload and the distinction no longer decides whether a client works. Keep that property: **a tool whose payload is prose must expose it in both fields.** `tests/structured-payload.test.mjs` asserts it per tool.

Update the table above whenever a client's behavior is actually observed. An entry here should cite what was run, not what was assumed — the Codex row is what an honest unknown looks like.

## Why this file exists

#94 survived four releases with every gate green. The smoke test and the unit tests both read `content[0].text` directly: they proved the payload existed, never that it survived a client reading the other field. The bug was only found by calling a tool through a client nobody on the project had written.

The general rule that follows: **exercise the surface through a consumer you did not author, before publishing.** Self-written probes inherit the assumptions of the code they probe.
