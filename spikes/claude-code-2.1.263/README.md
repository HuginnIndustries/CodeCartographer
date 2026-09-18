# Spike fixtures: Claude Code 2.1.263 as the E01 pilot host

**Not production code.** These are the disposable fixtures behind
[docs/engineering/spike-claude-code-2026-09-18.md](../../docs/engineering/spike-claude-code-2026-09-18.md).
Nothing here is imported by `core/`, `mcp-server/`, or `extensions/`; nothing
is packed (`spikes/` is not in `package.json` `files`) or type-checked
(`tsconfig.json` includes only the three surfaces). Re-running them changes
no global host configuration: every run passes its settings with
`--settings <file>` and its MCP server with `--mcp-config … --strict-mcp-config`.

Paths are parametrized. Before running, export:

```bash
export SPIKE_ROOT=/path/to/a/disposable/directory     # holds project/, mcp.log, hook logs
export CODECARTO_REPO=/path/to/this/checkout           # for the MCP SDK under node_modules
mkdir -p "$SPIKE_ROOT/project/.codecarto/engineering/inbox" "$SPIKE_ROOT/hooks"
envsubst < settings-E3-sandbox.json        > "$SPIKE_ROOT/settings-E3.json"
envsubst < settings-E4-sandbox-hooks.json  > "$SPIKE_ROOT/settings-E4.json"
envsubst < settings-E5-protected-hook.json > "$SPIKE_ROOT/settings-E5.json"
envsubst < mcp-config.json                 > "$SPIKE_ROOT/mcp-config.json"
envsubst < mcp-server.mjs > "$SPIKE_ROOT/mcp-server.mjs"
envsubst < observe.sh > "$SPIKE_ROOT/hooks/observe.sh" && chmod 755 "$SPIKE_ROOT/hooks/observe.sh"
```

The settings files reference `$SPIKE_ROOT/settings-E5.json` (its own path, in `denyWrite`) and `$SPIKE_ROOT/hooks/observe.sh`; the names above match those references.

| File | Used by | What it is |
|---|---|---|
| `mcp-server.mjs` | E1 | A stdio MCP server with one tool, `ask_decision`, that calls `server.elicitInput` and returns exactly what the client sent back; logs the client's `initialize` capabilities to `$SPIKE_ROOT/mcp.log` |
| `mcp-config.json` | E1 | Registers that server for one `claude` run only |
| `settings-E2-deny-only.json` | E2 | `permissions.deny` on `Write`/`Edit` under `.codecarto/engineering/`, no sandbox |
| `settings-E3-sandbox.json` | E3 | The same deny rules plus `sandbox.enabled`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, `filesystem.denyWrite` on the namespace |
| `settings-E4-sandbox-hooks.json` | E4 | E3 plus `PostToolUse` and `PostToolUseFailure` hooks (matcher `Bash`) running `observe.sh`. **Superseded:** review found it leaves `$SPIKE_ROOT/hooks/` unprotected, so a sandboxed model could rewrite the script that then runs unsandboxed. Kept only as the configuration E5 corrects. |
| `settings-E5-protected-hook.json` | E5 | E4 plus `denyWrite` on `$SPIKE_ROOT/hooks` and on the settings file itself, and `Write`/`Edit` deny rules on the hook directory. The only configuration this spike claims `tool_result_path: protected` for. |
| `observe.sh` | E4–E6 | The hook: writes its stdin (the host-delivered tool result) into `$SPIKE_ROOT/project/.codecarto/engineering/inbox/` — a path the sandbox denies to the model's Bash. Hardened for E5 (absolute interpreter, `PATH=/usr/bin:/bin`, absolute command paths, nothing sourced) and again for E6: **every** path it writes — payload, stderr, status — is inside the namespace, each invocation writes only fresh uniquely named files, and `set -C` (noclobber → `O_CREAT\|O_EXCL`) refuses to open through any symlink, dangling or not. The E5-era version, which wrote its error and status logs to `$SPIKE_ROOT` (writable by the model), is the one E6a attacks; it is not shipped. |

Run from `$SPIKE_ROOT/project` with `CLAUDECODE` unset (a nested launch is
refused otherwise), e.g.:

```bash
env -u CLAUDECODE claude -p --model sonnet --settings "$SPIKE_ROOT/settings-E3.json" \
  --allowedTools Bash Write Edit --max-turns 12 --output-format stream-json --verbose \
  "<the prompt recorded in the report>"
```

The E1b threat demonstration (an `Elicitation` hook that answers `accept`
with no human) is deliberately **not** included: exercising it is a simulated
acceptance, and the auto-mode classifier refused to create it. Its existence
is established from the host's hook-output schema instead; see the report.
