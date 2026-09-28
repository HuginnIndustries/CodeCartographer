# Host-observed proof ingestion (E05, #409)

The `host-tool-result` path for Claude Code: a `PostToolUse`/`PostToolUseFailure` hook
(`hosts/claude-code/observe.mjs`) that runs outside the model's sandbox and drops one
observation file per Bash call — and one *activity* entry per `Edit`/`Write`/`MultiEdit`/
`NotebookEdit` call — into the protected namespace, and a reader
(`core/engineering/host-observations.ts`, `ingestHostObservations`) that turns each
observation into a proof through `ingestProof`, refusing any observation that cannot be
about the attempt's current candidate. Requirements are in
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

1. Install the hook **from a checkout of this repository at a reviewed commit**, not
   from a copy passed around out of band: `git -C <checkout> rev-parse HEAD` is the
   commit you are installing, and `git -C <checkout> status --porcelain
   hosts/claude-code/observe.mjs` must be empty. Copy `hosts/claude-code/observe.mjs`
   into a directory that holds nothing else — `{{HOOK_DIR}}` — **not** under `/tmp`, the
   per-user temp root, or the working directory (spike E5 item 7: the sandbox's default
   writable set is wider than the working directory). Record, at install time,
   `sha256sum {{HOOK_DIR}}/observe.mjs` together with the commit; the hash is computed
   from the checkout you installed from, never copied from a document (this file does not
   carry one, so nothing here can be stale). To verify later: `sha256sum
   {{HOOK_DIR}}/observe.mjs` must equal the recorded value, and `git -C <checkout> show
   <commit>:hosts/claude-code/observe.mjs | sha256sum` must produce the same value.
2. Create the namespace **as a real directory, before the first session**:
   `mkdir -p {{PROJECT_DIR}}/.codecarto/engineering`. The hook refuses to write — nothing
   written, one line on stderr, exit 0 — unless `realpath(<namespace>)` is byte-equal to
   the path it was given, which requires the directory to exist and no component of it
   (`.codecarto` included) to be a symlink. A session started before the directory exists
   records nothing, and a `.codecarto` that has been replaced by a symlink records nothing.
3. Instantiate `hosts/claude-code/settings.template.json`, replacing:
   - `{{PROJECT_DIR}}` — absolute, canonical path of the project (the output of
     `realpath`); the namespace is `{{PROJECT_DIR}}/.codecarto/engineering`;
   - `{{HOOK_DIR}}` — the directory from step 1;
   - `{{NODE}}` — the absolute path of a Node >= 22 binary (the hook needs
     `O_NOFOLLOW`; it refuses to write without it). **This must be a real file**, not a
     version-manager shim and not a symlink into a tree the model can write (`nvm`,
     `volta`, `asdf`, `fnm` and Homebrew all install symlinks or shims by default):
     `denyWrite` on a symlink protects the link, not its target. Check with
     `realpath "$(command -v node)"` and use that path, after confirming that no
     ancestor of it is writable by the session's user.
   - `{{SETTINGS_FILE}}` — the absolute path the instantiated file will live at.
4. Place the instantiated file in user or managed settings (or pass it with
   `claude --settings`), never only in a project file the model can edit.
5. Never run the session in `bypassPermissions`; the template sets
   `sandbox.enabled`, `allowUnsandboxedCommands: false`, and `failIfUnavailable: true`.

The template puts five things in `sandbox.filesystem.denyWrite` — the project's
`.codecarto` directory (so the namespace's parent cannot be renamed or replaced by a
symlink from inside the sandbox), the namespace itself, the hook directory, the
interpreter, and the settings file — and mirrors all five with `Write`/`Edit` deny rules
in `permissions.deny` (the `.codecarto` rule both as `{{PROJECT_DIR}}/.codecarto/**` and as
`./.codecarto/**`). Denying the whole `.codecarto` directory means the model's own
`Write`/`Edit`/Bash cannot touch anything under it. The MCP server writes there as a
separate process and is unaffected, but the CodeCartographer **analysis pipeline is
affected**: its phases write their primary output under `.codecarto/findings/` with the
model's `Write` tool, and that is denied. **This settings file is for engineering-pilot
sessions only.** Run analysis phases in a separate session with different settings, and
do not widen the deny back to `.codecarto/engineering` alone to make both work in one
session: denying the parent is what stops the namespace from being swapped for a symlink.
The hook is invoked as `{{NODE}}
{{HOOK_DIR}}/observe.mjs <namespace>` — absolute interpreter, absolute script, no shebang,
`PATH=/usr/bin:/bin` pinned inside and never consulted; it spawns nothing and sources
nothing. It is wired to `PostToolUse` and `PostToolUseFailure` with the matcher
`Bash|Edit|Write|MultiEdit|NotebookEdit`.

## What the hook writes

Only inside `<namespace>`, only fresh files opened `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`
mode 0600 (an existing name or a symlink, dangling or not, is refused and logged). Before
anything is created it requires `realpath(<namespace>) === <namespace>` — the path must
exist, be absolute and canonical, and pass through no symlink at any component — and,
after `mkdir`, `realpath(<namespace>/inbox)` and `realpath(<namespace>/hook-logs)` to be
exactly those paths. Any of these failing is a fail-closed refusal: nothing written, one
line on stderr, exit 0. An `lstat` of the three leaf paths alone was not enough: a
`.codecarto` replaced by a symlink leaves every leaf a real directory while redirecting
every write.

- `inbox/<stamp>.json` — for a Bash call, the observation: schema
  `codecarto.host-observation/1`, host, event, `tool_use_id`, `session_id`, `cwd`,
  `command`, `exit_code` (0 on `PostToolUse`; parsed from `Exit code N` on
  `PostToolUseFailure`, `null` when absent), sha256 digests and sizes of stdout/stderr
  (never the text), `started_at`/`ended_at`, and an `observer` block (pid, uid,
  `CLAUDE_PROJECT_DIR`). For an `Edit`/`Write`/`MultiEdit`/`NotebookEdit` call, an
  **activity entry**: `{schema, kind: "activity", host, event, tool_name, tool_use_id,
  session_id, cwd, ended_at}` and nothing else — no file path, no content, no digest of
  either; nothing from `tool_input` at all. Any other tool is refused.
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
  An activity entry (`kind: "activity"`) is held to its own closed shape with the same
  rule (a `command`, `exit_code`, `file_path` or digest on one refuses it) and is only
  ever used to gate; it is never turned into a proof.
- Refuses, with a named reason and the file left in place, any observation that cannot
  be about the attempt's current candidate:
  - `observation-predates-attempt` — `ended_at` is earlier than `attempt.created_at`;
  - `observation-outside-workspace` — the observation's `cwd` does not `realpath` to the
    workspace root the store was opened from (the directory whose `.codecarto/engineering`
    is the store; overridable with `workspaceRoot`). A symlink alias of the root is the
    root; a subdirectory or the parent is not;
  - `tree-activity-after-run` — an activity entry **or a later Bash observation** in the
    **same session** has `ended_at` strictly after the observation's `ended_at` and at or
    before the candidate snapshot's `captured_at` (with no readable candidate the bound is
    open). The message names the later `tool_use_id`. This is the contract's stability
    signal — did the tree move between the run and the capture — not an ordering rule:
    run-then-capture with nothing in between is the normal order and is accepted (E01's
    valid proof fixture has exactly that shape); anything after the capture is the gate's
    candidate-reread problem, not this one.

    **With more than one obligation, run-then-capture refuses all but the last check.**
    Every Bash call can change the tree (`eslint --fix`, `jest -u`, a build writing
    outputs), so a check command is not exempt: in `run O1, run O2, capture`, O2 is a later
    Bash and O1 is refused. The order that discharges every obligation is **capture first,
    then run the checks**. Runs after the capture are covered by the gate's re-read of the
    tree, not by this rule. Capturing between checks also works.
  There is no session binding: no record ties an attempt to a host session, so a rule
  would have nothing to compare against and was not invented.
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
| No tree change between the run and the capture **from this session's tools** | the hook's activity entries + the reader's `tree-activity-after-run` refusal |
| No tree change from anywhere else | **the operator**: the hook sees only the session that runs it. Edits from another Claude Code session (a subagent, a second window on the same project), from the user's editor, from a `git` operation outside the session, or from any process that is not a tool call of this session are **not observed** and are not refused. This is an attested limit, not a checked one. |

The MCP surface (`change` action `ingest_observations`) has no host-configuration
channel yet, so it passes `unprotected` and states in its result that everything it
ingests is `caller` and discharges nothing. A `tool_result_path` or `capabilities`
request field is rejected.

## Retention

Processed files (proof written or replayed) and activity entries are renamed into
`inbox/processed/`, never deleted or modified — except that an activity entry or ingested
Bash observation is **kept** while a refused observation it gates (same session, earlier
`ended_at`) is still in the inbox, so that observation is refused again on the next read.
Refused files stay in `inbox/` for an operator. `hook-logs/` is append-only from the hook
and is not touched by the reader. A refused Bash call that matches no obligation
(an `ls`, a `git status`) is itself an earlier observation in its session, so it pins
every later activity entry and Bash observation of that session in `inbox/` until an
operator removes it. In practice little rotates once a session has run any non-check
command. Both grow with every Bash and edit call the model makes
and the model cannot clean either; an operator prunes `processed/` and `hook-logs/` on
their own schedule. The reader never removes anything.

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
  `dangerouslyDisableSandbox` disabled). The echo listed the instantiated settings file in `denyWithinAllow`
  and truncated the list after ~50 entries ('... and 84 more'). The namespace is inside
  `.` (the working directory, which is in `allowOnly`), so if its `denyWrite` took effect
  it would appear in that list; whether it does is not visible in the truncated echo and
  this run did not test it. The hook directory and interpreter sit outside `allowOnly`
  entirely, so they are unwritable by the allow-list alone, not by `denyWrite`.

What this proved: hook wiring, payload parsing on 2.1.283 (including the
`PostToolUseFailure` exit-code text), O_EXCL fresh-file writes under real host
invocation, and reader ingestion of real hook output. What it did not prove: anything
about the boundary. No write, symlink plant, or PATH/settings tamper was attempted. That
run predates the activity entries, the ancestor-realpath check and the binding refusals;
those are unit-tested by running the hook directly with `node` in temporary directories
and have not been exercised by a live session.

## Deferred (required before pilot use as `host-tool-result`)

- D4: repeat spike E5 (thirteen tamper attempts against script, settings, interpreter,
  PATH) and E6 (hook output paths: symlink at every name the hook writes, namespace
  replaced by a symlink) against **this** layout, maintainer-supervised, and record hashes
  of the hook and settings before and after.
- A host-configuration channel for `tool_result_path` so the MCP surface can ever pass
  `protected`; until then it is `caller` by construction.
- `~/.claude/hooks/` as `{{HOOK_DIR}}` is documented as sandbox-protected but untested
  here; a pilot using it repeats E5 there.
- A live benign run with the widened matcher, confirming that Claude Code delivers
  `Edit`/`Write`/`MultiEdit`/`NotebookEdit` events to the hook with `tool_use_id` and
  `session_id` in the same shape as `Bash` events.
