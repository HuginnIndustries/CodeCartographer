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

## Trust posture: the host is trusted

The MCP server and the Pi extension both run as the user, in the user's process, driven by an agent the user chose. They do not defend against that agent or that host — they defend the *repository* from an LLM's mistakes (the write sandbox, the containment roots, the completion gates). Four consequences follow, recorded here so nobody has to rediscover them (self-audit L6):

- **Any absolute, existing directory is a valid `cwd`.** `codecarto_init` creates `.codecarto/` there and `codecarto_refresh_scaffold` overwrites framework files under it. There is no allowlist and, on MCP, no confirmation — the host asked, and the host is trusted. A host that wants a fence puts it in front of the tool call.
- **`api_key` as a tool argument lands in the host's logs.** Whatever the host records about tool calls — transcripts, traces, replay files — gets the key. The Pi slash command refuses a key argument for this reason; the MCP tool accepts one because some hosts cannot set environment variables, and its description says what happens. `OPENROUTER_API_KEY` in the server process's environment is the place for it.
- **A committed `.codecarto/workflow/config.yaml` can widen the Pi write sandbox.** Its `library.path`, when it names a directory carrying a `.codecarto-library` marker, is admitted as a write root — that is what publishing into a library needs. A cloned repository can therefore ship both the marker and the config that points at it. Relative values are refused (#243), so the widening is at least explicit and absolute; review `library.path` in a repository you did not create before running a phase from it.
- **The Broad-Side config can hold the key, and it is tracked.** `.codecarto/broadside/config.yaml` has an `api_key` slot, and the ignore rules init writes deliberately keep that file tracked (`!broadside/config.yaml`) so a repository's model and lens routing travel with it. A key written there is committed with it — the template says so beside the slot. Keep the key in the environment and the file for the routing.

None of this is a defect to fix in the server: a tool that second-guessed its host would be unusable from every client above. It is the boundary, stated.

## Why this file exists

#94 survived four releases with every gate green. The smoke test and the unit tests both read `content[0].text` directly: they proved the payload existed, never that it survived a client reading the other field. The bug was only found by calling a tool through a client nobody on the project had written.

The general rule that follows: **exercise the surface through a consumer you did not author, before publishing.** Self-written probes inherit the assumptions of the code they probe.
