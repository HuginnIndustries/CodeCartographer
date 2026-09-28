# Host-observed proof ingestion (E05, #409)

The `host-tool-result` path for Claude Code: a `PostToolUse`/`PostToolUseFailure` hook
(`hosts/claude-code/observe.mjs`) that runs outside the model's sandbox and drops one
observation file per Bash call into the protected namespace, and a reader
(`core/engineering/host-observations.ts`, `ingestHostObservations`) that turns each
observation into a proof through `ingestProof`. Requirements are in
[record-contract.md](record-contract.md) (D3, D4, D5, the forward-looking notes on
parsing scope and retention) and the evidence for the hook placement is in
[spike-claude-code-2026-09-18.md](spike-claude-code-2026-09-18.md).

**Status: the hook and reader are unit-tested and have passed one benign live run on
Claude Code 2.1.283. The adversarial E5/E6 re-runs (D4) have NOT been performed for this
hook placement.** Until a maintainer-supervised session repeats them for exactly this
layout (namespace, hook directory, interpreter, settings file), no proof from this hook
may be treated as `host-tool-result` in a pilot; declare `tool_result_path: unprotected`
and every proof it yields is `caller`, `claimed`, and discharges nothing under `verified`.

## Install

Everything below is host configuration **outside the workspace**. The model never sees
`tool_result_path`; it is an operator declaration and no request field can set it.

1. Copy `hosts/claude-code/observe.mjs` into a directory that holds nothing else —
   `{{HOOK_DIR}}` — **not** under `/tmp`, the per-user temp root, or the working
   directory (spike E5 item 7: the sandbox's default writable set is wider than the
   working directory).
2. Instantiate `hosts/claude-code/settings.template.json`, replacing:
   - `{{PROJECT_DIR}}` — absolute path of the project; the namespace is
     `{{PROJECT_DIR}}/.codecarto/engineering`;
   - `{{HOOK_DIR}}` — the directory from step 1;
   - `{{NODE}}` — the absolute path of a Node >= 22 binary (the hook needs
     `O_NOFOLLOW`; it refuses to write without it);
   - `{{SETTINGS_FILE}}` — the absolute path the instantiated file will live at.
3. Place the instantiated file in user or managed settings (or pass it with
   `claude --settings`), never only in a project file the model can edit.
4. Never run the session in `bypassPermissions`; the template sets
   `sandbox.enabled`, `allowUnsandboxedCommands: false`, and `failIfUnavailable: true`.

The template puts four things in `sandbox.filesystem.denyWrite` and mirrors the first two
with `Write`/`Edit` deny rules: the namespace, the hook directory, the interpreter, and
the settings file itself. The hook is invoked as `{{NODE}} {{HOOK_DIR}}/observe.mjs
<namespace>` — absolute interpreter, absolute script, no shebang, `PATH=/usr/bin:/bin`
pinned inside and never consulted; it spawns nothing and sources nothing.

## What the hook writes

Only inside `<namespace>`, only fresh files opened `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`
mode 0600 (an existing name or a symlink, dangling or not, is refused and logged; a
symlinked namespace/inbox/hook-logs directory is refused before anything is created):

- `inbox/<stamp>.json` — the observation: schema `codecarto.host-observation/1`, host,
  event, `tool_use_id`, `session_id`, `cwd`, `command`, `exit_code` (0 on `PostToolUse`;
  parsed from `Exit code N` on `PostToolUseFailure`, `null` when absent), sha256 digests
  and sizes of stdout/stderr (never the text), `started_at`/`ended_at`, and an `observer`
  block (pid, uid, `CLAUDE_PROJECT_DIR`).
- `hook-logs/<stamp>.status` — one line, `wrote` or `refused`.
- `hook-logs/<stamp>.err` — only on refusal; never text derived from the command output.

The hook always exits 0: an observer must not block the host.

## What the reader trusts

`ingestHostObservations(store, { capabilities, changeId, attemptId })`:

- Reads **only** `inbox/*.json`, each `lstat`ed then opened `O_NOFOLLOW` and `fstat`ed
  again; a symlink, directory, non-regular file, or file over 64 KiB is skipped and
  reported. `.err`, `.status`, `processed/`, and anything else are opaque.
- Validates the closed shape strictly; unknown fields (`authority`, `discharges`,
  `attested_by`, `provenance`, ...) refuse the file — the shipped hook never writes them.
- Matches the observation's `command` **byte-equal** to `ProofObligation.command` on the
  attempt's slice; no match or more than one match is reported and yields no proof.
- Derives `provenance.attested_by` from `attestationForHostObservation(capabilities)`
  and nothing else: `host-tool-result` (with `tool_call_id`) only for
  `tool_result_path: protected`; `caller` for `unprotected`, `none`, or undeclared.
- Submits through `ingestProof` under `assurance_policy: verified` with a deterministic
  proof id and idempotency key `(attempt, host, tool_use_id)`, so a re-read of the same
  file is a replay (one proof), and a second file with the same `tool_use_id` but
  different bytes is an idempotency conflict (refused, neither believed).
- Exit code 0 → `passed`; non-zero → `failed` (recorded, does not discharge); no exit
  code → `blocked`.

Protected vs operator-attested, in one line each:

| Property | Who vouches |
|---|---|
| The observation was written by the hook, not the model | the sandbox `denyWrite` set — host-enforced only if D4 re-runs pass for this placement |
| The hook's script, interpreter, and settings were not edited | same |
| The exit code and digests are the host's, not the caller's | the hook (host process), given the above |
| `tool_result_path: protected` | **the operator**, out of band; never the file, never a request |
| Continuity since initialization (D3) | nobody on this host — `protection` is never `continuous-since-initialization` |

The MCP surface (`change` action `ingest_observations`) has no host-configuration
channel yet, so it passes `unprotected` and states in its result that everything it
ingests is `caller` and discharges nothing. A `tool_result_path` or `capabilities`
request field is rejected.

## Retention

Processed files (proof written or replayed) are renamed into `inbox/processed/`, never
deleted or modified. Refused files stay in `inbox/` for an operator. `hook-logs/` is
append-only from the hook and is not touched by the reader. Both grow with every Bash
call the model makes and the model cannot clean either; an operator prunes `processed/`
and `hook-logs/` on their own schedule. The reader never removes anything.

## Live check on Claude Code 2.1.283 (benign only)

One `claude -p --settings <instantiated template>` session in a throwaway project under
the scratch root, asked to run `/usr/bin/true` and `/usr/bin/false` and report the exit
codes. Observed:

- the hook fired twice; `inbox/` held two files with `tool_use_id`s matching the
  session's two `tool_use` blocks, `command` `/usr/bin/true` with `event: PostToolUse`,
  `exit_code: 0`, and `/usr/bin/false` with `event: PostToolUseFailure`, `exit_code: 1`
  (parsed from the host's `Exit code 1` error); two `hook-logs/*.status` files, both
  `wrote`; no `.err`; files mode 0600; nothing written outside the namespace;
- the reader ingested both against a fixture slice whose obligations named those two
  commands: under `tool_result_path: protected` → `host-tool-result`, `observed`, the
  `true` proof `passed` and discharged, the `false` proof `failed` and did not discharge;
  re-run under `unprotected` → `attested_by: caller`, and both files were refused as
  idempotency conflicts because the stored proofs (same key) carry different attestation
  bytes — the key does its job across attestation levels too;
- the session's sandbox echo (the host's `Bash command sandbox` system reminder in the
  transcript) confirmed the sandbox was active (bubblewrap per command,
  `dangerouslyDisableSandbox` disabled) and listed the instantiated settings file in
  `denyWithinAllow`. The echo did **not** list the namespace, the hook directory, or the
  interpreter in `denyWithinAllow` — they fall outside the sandbox's `allowOnly` write
  set (`.` and `$TMPDIR` and a few device/log paths) so `denyWrite` on them is not
  visible in that list. Whether the model's Bash can in fact write to them from this
  placement is exactly what the deferred D4 re-runs must establish; this run did not
  attempt it.

What this proved: hook wiring, payload parsing on 2.1.283 (including the
`PostToolUseFailure` exit-code text), O_EXCL fresh-file writes under real host
invocation, and reader ingestion of real hook output. What it did not prove: anything
about the boundary. No write, symlink plant, or PATH/settings tamper was attempted.

## Deferred (required before pilot use as `host-tool-result`)

- D4: repeat spike E5 (thirteen tamper attempts against script, settings, interpreter,
  PATH) and E6 (hook output paths: symlink at every name the hook writes, namespace
  replaced by a symlink) against **this** layout, maintainer-supervised, and record hashes
  of the hook and settings before and after.
- A host-configuration channel for `tool_result_path` so the MCP surface can ever pass
  `protected`; until then it is `caller` by construction.
- `~/.claude/hooks/` as `{{HOOK_DIR}}` is documented as sandbox-protected but untested
  here; a pilot using it repeats E5 there.
