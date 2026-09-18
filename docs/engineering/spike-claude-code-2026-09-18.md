# Feasibility spike: Claude Code 2.1.263 as the E01 pilot host

**Status:** spike report, 2026-09-18. Evidence for the maintainer's D1–D5 decisions in [record-contract.md § Decision record](record-contract.md#decision-record). It registers nothing: `VERIFIED_ACCEPTANCE_INTEGRATIONS` stays empty, `cooperative` stays unauthorized, #399 stays open. No E02/E05/E06/E07 code was written. Fixtures: [`spikes/claude-code-2.1.263/`](../../spikes/claude-code-2.1.263/).

**Host under test:** Claude Code 2.1.263 (`claude --version`), Linux (Fedora, kernel 7.2.4), bubblewrap 0.12.0 and socat installed, unprivileged user namespaces available. The MCP client identifies itself as `{ name: "claude-code", version: "2.1.263" }` at `initialize`. One host, one client, per the policy; Pi/native was not pursued.

**Method:** every run was headless (`claude -p`) in a disposable directory with `--settings <file>` and `--mcp-config … --strict-mcp-config`; no user or managed settings, hooks, MCP registrations, or sandbox state on this machine were changed. Model: Sonnet. Seven short runs on the existing subscription; no external provider spend. Documentation claims were read from the host's own bundle (`strings` over the binary) and from code.claude.com/docs (`sandboxing`, `hooks`, `permission-modes`); each is marked *bundle*, *docs*, or *observed*.

## Results by requirement

### 1. A real user-facing presentation with accept / reject / cancel

| Evidence | Kind | Result |
|---|---|---|
| Client declares `elicitation: { form: {} }` at `initialize` | observed (E1) | yes — **also in a headless session that cannot show anything** |
| `elicitInput` with a `decision: accept \| reject` form, headless | observed (E1) | returned `{ action: "cancel" }` in ~3 s; the server minted nothing |
| A dialog exists for interactive sessions | bundle | strings `"An MCP server needs your input"`, `elicitation_dialog`, `onReject`, `decline`, `elicitation-queued`; and `"input request … needs an elicitation surface this non-interactive session has none of"` |
| A hook can answer for the user | bundle | hook output schema `hookEventName: "Elicitation", action: accept \| decline \| cancel, content` (E1b: not exercised — building it was refused by the auto-mode classifier, and running it would be a simulated acceptance) |
| A human saw a presentation and answered | **not obtained** | requires an interactive session with a person; see § The live check that is still required |

**Reading:** the protocol path is real and honest when no surface exists (`cancel`, not `accept`). The capability advertisement is not evidence of a surface — it is present headless — which is the concrete reason the contract keys support to a verified host/client pair and not to the advertised capability. Hook configuration is part of the boundary: an `Elicitation` hook is a mocked client response.

### 2. A protected authoritative namespace, with initialization/lapse history

| Evidence | Kind | Result |
|---|---|---|
| `permissions.deny` on `Write`/`Edit` only (E2) | observed | `Write` denied; `echo OK > …` denied by the command-string analyzer; **`python3 -c "open(…).write('OK')"` succeeded** — the file was on disk. A deny rule for a write tool does not block the shell. |
| Sandbox on, `filesystem.denyWrite` on the namespace (E3) | observed | redirect, `python3`, `cp` from `$TMPDIR`, `mkdir` all failed with `EROFS: Read-only file system`; `touch` one directory up succeeded |
| Enforcement layer | docs | "The operating system enforces the sandbox boundary on the running process … even if an allowed command does more than its name suggests"; applies to Bash, PowerShell, Monitor and child processes |
| The model's own configuration files | docs | the sandbox denies writes to `.claude` settings files, `.claude/hooks`, `.mcp.json`, and most of `~/.claude` "with no way to exempt"; the permission layer treats `.claude`, `.mcp.json`, `.claude.json` as protected paths — prompted in `default`, classifier-routed in `auto`, denied in `dontAsk`, **allowed in `bypassPermissions`** |
| Sandbox unavailable | docs | off by default; `sandbox.failIfUnavailable: true` makes a missing dependency a hard failure instead of a silent unsandboxed run (not exercised: dependencies were present) |
| Initialization / lapse history | **not provided by the host** | nothing records when the boundary was enabled, whether it held across sessions, or whether the namespace pre-dates it; sandbox settings live in settings files a person (or the `/sandbox` panel) can change between sessions |

**Reading:** the boundary itself exists and is OS-enforced — this host can provide `storage_boundary: host-enforced` for a session. It cannot, by itself, provide `protection: continuous-since-initialization`: there is no host mechanism attesting continuity, so under the contract every acceptance on this host today classifies `cooperative`. Closing that gap is D3 (candidate below), not something the spike can assert.

### 3. A tool-result observation path the model cannot fabricate

| Evidence | Kind | Result |
|---|---|---|
| `PostToolUse` hook, matcher `Bash`, writing into the `denyWrite` inbox (E4) | observed | five observations written by the hook while the model's Bash got `EROFS` on the same directory; hooks run outside the sandbox ("Handlers run in the current directory with Claude Code's environment") |
| Payload fields (success) | observed | `session_id`, `cwd`, `tool_use_id` (`toolu_…`), `tool_name`, `tool_input.command`, `tool_response.{stdout, stderr, interrupted}`, `transcript_path`, `permission_mode`, `duration_ms` |
| Non-zero exit | observed (E4b/E4c) | `PostToolUse` does **not** fire; `PostToolUseFailure` fires with `tool_use_id`, `tool_input.command`, and `error: "Exit code 7\nsome-output"` — the exit code arrives as parseable text, not a field |
| Forgery: model writes the inbox directly | observed (E4) | `EROFS` |
| Forgery: model runs the hook script itself with fabricated stdin | observed (E4) | the script ran inside the model's sandbox; its inbox write failed (`hook-wrote-1`, no file) |
| Forgery: model rewrites the hook configuration | docs | `.claude` settings and `.claude/hooks` are sandbox-protected from Bash with no exemption, and permission-layer protected for `Write`/`Edit` (see requirement 2); `--settings` on the CLI and managed settings are outside the model entirely |

**Reading:** this host has a genuine `host-tool-result` path: the hook receives the tool result from the host, carries the tool-call id, and can deliver it into storage the model cannot write. Two conditions make it `tool_result_path: protected` in the contract's sense: the hook must be configured in a source the model cannot edit (user settings or managed settings — **not** a project `.claude/settings.json` edited from a `bypassPermissions` session), and the session must not run in `bypassPermissions`. Two limitations for E05: RED runs arrive on `PostToolUseFailure` with the exit code as text; successful runs carry no exit code field (exit 0 is implied by the event).

### 4. Honest unsupported behavior

| Situation | Result |
|---|---|
| No elicitation surface (headless) | `{ action: "cancel" }` — server receives a non-acceptance; nothing minted (observed) |
| Host/client pair not in the registry | `acceptanceChannelSupported` false → `needs-human-acceptance` (contract; the registry is empty, so this is every pair today) |
| Sandbox dependencies missing | hard failure with `failIfUnavailable: true` (docs; not exercised) |
| No hook / hook config unprotected | `tool_result_path: unprotected \| none` → every proof `caller` → nothing discharges under `verified` (contract) |
| Boundary present but history unknown | `protection` ≠ `continuous-since-initialization` → `cooperative` (contract) |

## The live check that is still required (D1)

A mocked or headless response is protocol evidence, not proof that a person saw the presentation. The integration check the contract requires needs a human at an **interactive** Claude Code 2.1.263 session. Exact interaction, all inside a disposable directory and with no global configuration change:

1. In `$SPIKE_ROOT/project`, start `claude` interactively with `--mcp-config "$SPIKE_ROOT/mcp-config.json" --strict-mcp-config` (the spike server; the real `codecarto-mcp` is not registered for this check).
2. Ask it to call `ask_decision`. Confirm on screen that a dialog titled like "An MCP server needs your input" shows the message text verbatim (`SPIKE: accept or reject this candidate? (nonce 0123456789abcdef)`) and a `Decision` field. Choose **accept**. Expected in `$SPIKE_ROOT/mcp.log`: `result.action: "accept"`, `content.decision: "accept"`.
3. Ask again; choose **reject**. Expected: `action: "accept"` with `content.decision: "reject"` (the form was submitted; the decision is reject).
4. Ask again; press **Escape / cancel** the dialog. Expected: `action: "cancel"` or `"decline"`, no content.
5. Stale: ask again, wait longer than the request's `expires_at` would allow (the real adapter's TTL; the spike server has none, so this step is a note for the E06 adapter check), then answer. Expected from the real adapter: `receipt-expired`, nothing minted.
6. Mismatched: not producible by a person through the dialog — the client binds its answer to the JSON-RPC request id. It is covered by the contract's receipt fixtures (`approval-nonce-mismatch`, `approval-presentation-digest-mismatch`) and must be re-run against a captured real response in the E06 adapter check.

The person reports what they saw on screen for steps 2–4; the log records what the server received. Only that pairing — screen plus log — is the evidence D1 asks for. This spike did not perform it.

## Smallest feasible pilot configuration (proposal, not a registration)

For Claude Code 2.1.263 on Linux, WSL2, or macOS, all in **user-level** (`~/.claude/settings.json`) or managed settings — never only in a project file — and never in a `bypassPermissions` session:

```json
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "failIfUnavailable": true,
    "filesystem": { "denyWrite": ["<repo>/.codecarto/engineering"] }
  },
  "permissions": {
    "deny": ["Write(<repo>/.codecarto/engineering/**)", "Edit(<repo>/.codecarto/engineering/**)"]
  },
  "hooks": {
    "PostToolUse":        [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "<host-side ingestion entry>" }] }],
    "PostToolUseFailure": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "<host-side ingestion entry>" }] }]
  }
}
```

plus: no `Elicitation`/`ElicitationResult` hooks anywhere in the merged settings (the adapter should refuse to present if the host reports one — it cannot see hooks, so this is an operator attestation); the `codecarto-mcp` server registered with elicitation as its acceptance channel; interactive sessions only for acceptance. The ingestion entry (E05) writes into `<namespace>/inbox/`, which the model cannot write; it must accept `PostToolUseFailure` payloads and parse `Exit code N` from `error`.

With that configuration this host provides, per session: `human_acceptance: mcp-elicitation` (unverified until the live check), `storage_boundary: host-enforced`, `tool_result_path: protected`. It does **not** provide `protection: continuous-since-initialization`.

## What remains unresolved

- **D1** — the live check above. Until it is recorded, the registry stays empty and every acceptance is `needs-human-acceptance`.
- **D3** — continuity. Candidate mechanism for the maintainer to accept or reject: the operator enables the configuration above *before* the adapter initializes the namespace; the adapter writes an initialization marker into the protected namespace at first use (hook-delivered, so the model cannot forge it) recording the settings source it was told; a `SessionStart` hook — configured in the same protected source — re-checks on every session that the sandbox and deny rules are in force and appends a session line; any session without that line, or any change to the sandbox settings source, is recorded as a lapse and the namespace becomes `interrupted` permanently. This is an E02-owned design and an operator attestation at its root; the spike verified only that the write boundary and the hook path it relies on exist.
- **D4** — demonstrated for this host: a hook outside the sandbox delivering into a path the model cannot write, with the hook configuration itself protected. What remains is the maintainer's acceptance of "user or managed settings + no `bypassPermissions`" as the definition of *protected configuration*.
- **D5** — untouched; `cooperative` remains unauthorized and unused.
- **Not covered:** macOS/WSL2 behaviour (docs only), Windows native (unsupported by the sandbox), any other MCP client, and whether the desktop app surfaces the elicitation dialog the same way the terminal does.
