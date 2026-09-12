# Protocols and State

Source: commit `f6f8484` (v0.19.5). Evidence markers: `[fact]` observed fact, `[inference]` strong inference, `[external]` external-behavior claim, `[hazard]` portability hazard, `[open]` open question. Line references are to the source outside `.codecarto/`; "real sample" means a file this run's own completions wrote (`workflow/status.yaml`, `workflow/.usage.local.yaml`, `dashboard.html`, closeouts), which is runtime evidence for the writer side. Upstream: architecture map, mechanical scan (`mech P.N`), contracts. This phase closes routed item **arch-CF1** (exact shapes, versioning rules, compatibility hazards of the wire and persisted formats).

## Boundaries Identified

| # | Boundary | Carrier | Protocols (catalog §) |
|---|---|---|---|
| B1 | Host process ↔ MCP server | JSON-RPC 2.0 over stdio | E1 tool call / result envelope |
| B2 | Framework ↔ host LLM | prompt text and the markdown it must write back | E2 phase prompt, E3 validation block, E4 coverage ledger, E5 findings tables |
| B3 | Host LLM ↔ framework state | YAML files the LLM writes, the framework applies | E6 handoff, E7 amendment |
| B4 | Framework ↔ its own canonical state | YAML/markdown files the framework alone writes | E8 status.yaml, E9 closeout + THREAD_LOG line, E10 DECISIONS row, E11 CONVENTIONS pending bullet, E12 usage log, E13 dashboard data island, E14 checkpoint |
| B5 | Pi orchestrator ↔ Pi phase child | in-process `AgentSession` events, custom messages, hooks | E15 session event stream, E16 custom messages, E17 tool_call and compaction hooks |
| B6 | Framework ↔ library on disk | files under `library.path` | E18 marker, metadata, index, INDEX.md, latest |
| B7 | Framework ↔ OpenRouter Batch API | HTTPS JSON | E19 batch request/response; E20 Broad-Side state and run files |
| B8 | Framework ↔ git | subprocess argv/stdout | E21 git probes |
| B9 | Config files ↔ runtime | YAML read per call | see `findings/config-model/config-model.md` §2026-09-11 protocols |

## Event Catalog

### E1 — MCP tool call and result envelope

| Field | Value |
|---|---|
| **Producer** | Host (request); `mcp-server/server.ts` (response). |
| **Consumer** | Server `CallTool` handler (`server.ts:1719-1733`); host client. |
| **Transport or carrier** | JSON-RPC 2.0 over stdio via `@modelcontextprotocol/sdk` `StdioServerTransport`; the server advertises `{name: "codecartographer", version: PACKAGE_VERSION, capabilities: {tools: {}}}` `[fact: server.ts:1712-1715]`. Protocol revision negotiated by the SDK (README §MCP server lists 2025-11-25 … 2024-10-07) `[external]`. |
| **Ordering guarantees** | Request/response; the server is stateless per call and re-reads disk each time, so calls are order-independent except through the files they write `[fact]`. |
| **Required fields** | `params.name` ∈ the 22 `TOOLS` names; `params.arguments` per tool `inputSchema` (`server.ts:1301-1670`); every workflow tool requires absolute, existing `cwd`. |
| **Optional fields** | Per tool; unknown arguments are ignored (no schema enforcement in the handler beyond the checks named in the contracts) `[fact]`. |
| **Identifiers and timestamps** | JSON-RPC `id` handled by the SDK; no server-side ids. |
| **Error cases** | `McpError` codes: `-32602 InvalidParams` (argument shape, validation parse errors, completion refusals), `-32600 InvalidRequest` (state/gate refusals, preflight, publish_confirm), `-32603 InternalError` (workspace load failures and anything uncaught), `-32601 MethodNotFound` (unknown tool) `[fact: server.ts:136-139,1720-1732]`. The publish_confirm refusal carries a `data` object with `refused: "publish_confirm"` and the preview fields `[fact: server.ts:792-804]`. |
| **Restart or resume behavior** | None needed; each call is a full read. |

Result shape `[fact: server.ts:155-160]`:

```json
{ "content": [{ "type": "text", "text": "<rendered>" }],
  "structuredContent": { "...tool fields...", "text": "<rendered>" } }
```

`text` is always duplicated into `structuredContent` so a client that reads either field gets the payload (`tests/structured-payload.test.mjs`). Per-tool structured keys are in `findings/public-surfaces/public-surfaces.md` §2026-09-11 protocols.

### E2 — Phase prompt

| Field | Value |
|---|---|
| **Producer** | `core/prompts.ts:buildPhasePrompt` (both surfaces, byte-identical, `tests/mcp-server.test.mjs:53-65`). |
| **Consumer** | The host LLM (MCP) or the Pi phase child session. |
| **Transport or carrier** | Plain text, `\n`-joined lines. |
| **Ordering guarantees** | Fixed section order: header (2 lines) → "Required reads before analysis:" list → optional `WARNING:` lines → optional "Items routed to `<phase>` for closure" list → optional "Orchestrator duties …" block → optional "Synthesis library context:" → optional "Strategic Alignment Hook" (reimplementation-spec only) → "Rules:" → optional forced/dependency lines → "Handoff requirements (from the active pipeline):" → "Primary output target: .codecarto/<path>" `[fact: prompts.ts:141-280]`. |
| **Required fields** | Header line `Read .codecarto/GUIDE.md and continue the CodeCartographer workflow for the phase \`<id>\`.`; reads list always begins GUIDE, status.yaml, then the handoff template when it exists. |
| **Optional fields** | Checkpoint read (`scratch/checkpoints/<phase>.md` exists); CONVENTIONS/DECISIONS reads (files exist); routed items (`collectRoutedCarryForward`); duties: pending-proposal count, re-triage list (kinds `needs-maintainer-decision`, `needs-runtime-test`, capped at 10 + "(+N more …)"), secondary outputs with `(exists|missing)`, coverage gaps (capped at 10), contradiction sweep (only after any completion). |
| **Identifiers and timestamps** | Phase id; routed item ids via `describeEntry` (`id (kind) description`). No timestamps. |
| **Error cases** | Synthesis preflight throws `PhasePreflightError` ("Cannot start <phase>: …") before any text is built `[fact: core/synthesis.ts]`. |
| **Restart or resume behavior** | Re-issued from disk on every call; the existing primary output and checkpoint are listed as reads so a resumed phase continues. |

### E3 — Validation block (LLM → framework)

Grammar the parser actually applies `[fact: core/pipeline.ts:114-171]`:

```
<anything>
## Validation                      ← the LAST occurrence of this substring anchors the block
| # | Criterion | Result | Evidence |   ← header row skipped because cells[0] === "#"
|---|---|---|---|                       ← separator skipped by /^[-:]+$/
| n | <criterion> | <PASS|PARTIAL|FAIL…> | <evidence> |   ← any row with ≥ 4 cells is a criterion row
**Overall:** PASS | PASS WITH GAPS      ← last match of /^\*\*Overall:\*\*\s*(.+)$/i, compared exactly after trim+uppercase
```

Semantics: any row whose Result contains `FAIL` → FAIL; rows containing `PARTIAL` populate `gaps` and later become auto open questions; no rows → error "Validation block found, but no validation rows could be parsed."; an Overall of anything but the two literals → FAIL with "Validation overall result is FAIL." `[hazard: mech 2.6]`. Rows are read from the *last* `## Validation` to end of file, so a table in any section after it is counted. Findings cross-checks (E5) run over the **whole** document and can add errors.

### E4 — Coverage ledger (LLM → framework → next prompt)

`[fact: core/coverage.ts:91-123]` Section heading `## Coverage and limits` (emphasis stripped, case-insensitive). Top-level bullets `- <label>: <text>` with labels `Inspected scope`, `Skipped scope`, `Evidence basis`, `Known blind spots`, `Coverage disposition` (normalized). Indented continuation lines append with a space; indented sub-bullets append with `; `; a blank line does not end a label; an unrecognized top-level bullet or unindented prose ends it. Only `Skipped scope` and `Known blind spots` of **completed** phases travel, in `phase_order`, into E2's duties (`collectCoverageGaps`). Missing section, missing bullet, or empty text → nothing (never throws). Real sample: this run's four ledger entries appear verbatim in the protocols prompt.

### E5 — Findings tables (LLM → framework)

`[fact: core/findings.ts:79-180]` Any table whose header (normalized: emphasis stripped, lowercased, whitespace collapsed) contains both `evidence level` and `action` cells, optionally under a `## Pass N` heading. Placeholder rows with both cells empty are skipped. Rules: (evidence ∈ {`open question`, `external-behavior claim`}) ∧ (action ∈ {`fix before porting`, `fix now`}) → **error** when scaffold ≥ 0.17.1, warning below; `observed fact` ∧ `verify at runtime` → warning; any unsettled row while the `## Open Questions` table has zero filled rows → warning. This applies to every phase output, including the porting bundle's Defect Synthesis table `[inference from the header-driven parse]`.

### E6 — Phase handoff (LLM → framework)

| Field | Value |
|---|---|
| **Producer** | Phase executor (LLM). |
| **Consumer** | `core/status.ts:parseHandoff` at completion (`core/completion.ts:324`). |
| **Transport or carrier** | `scratch/handoffs/<phase-id>.yaml`, parsed by the hand-rolled YAML subset (E22). Phase id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` before the path is formed `[fact: status.ts:26-30]`. |
| **Ordering guarantees** | Keys unordered; arrays keep order; open-question / carry-forward entries merge **by id, last write wins** (`applyHandoff`, `status.ts:340-370`). |
| **Required fields** | `phase_id` (string, must equal the phase being completed). Everything else defaults: `schema_version` → 1 (> 1 refused). |
| **Optional fields** | `owner_notes: string[]` (non-strings dropped); `open_questions[]` and `carry_forward[]` entries `{id?, kind?, description?, deferred_reason?}` (+ `target_phase`, `derives_from` on carry_forward only; a bare string becomes `{description}`; an entry with no recognized key is dropped); `carry_forward_closures: string[]`; `open_question_closures: (string \| {id, evidence?})[]`; `post_pipeline[]` entries with required `id`, optional `kind`, `description`, `source_phase` (defaults to `phase_id`), `status` (`resolved` or `pending`); `decisions: string[]`; `proposed_conventions[]` of `{name, rule, evidence?}` (an entry that is not an object, or lacks `name`/`rule`, **fails** completion); `closeout_summary` (~20 words, becomes the THREAD_LOG summary); `closeout_content` (markdown body); `timestamp` (parsed, ignored) `[fact: status.ts:240-302]`. |
| **Identifiers and timestamps** | Missing ids auto-assigned `oq-<phase>-N` / `cf-<phase>-N`, skipping collisions with explicit ids (`autoAssignIds`); `kind` free-form but the documented set is `needs-runtime-test`, `needs-maintainer-decision`, `needs-spec-ruling`, `defer-to-phase`, `needs-fixture-capture`. Timestamps are host-owned. |
| **Error cases** | See contracts §Complete: missing handoff on a phase with `handoff_requirements`; `phase_id` mismatch; non-array collection; bad `target_phase` (must exist in `phase_order` and be later than the completing phase); `post_pipeline` without id; D1 `derives_from` closure with its question still open; D3 evidence-less closure of a `needs-runtime-test` question (gated by scaffold ≥ 0.19.0). All are raised **before** the lock and mutate nothing `[fact: completion.ts:324-431]`. |
| **Restart or resume behavior** | Re-applying the same handoff is idempotent by id; the file is never deleted or consumed. |

### E7 — Amendment (post-pipeline, LLM/user → framework)

`scratch/amendments/<slug>.yaml`, slug `^[A-Za-z0-9][A-Za-z0-9._-]*$`; `schema_version` ≤ 1; arrays `open_question_closures`, `post_pipeline_closures`, `notes` (strings); `closeout_summary`; `closeout_content`. At least one of the three arrays must be non-empty. Refused while `getNextEligiblePhase` is non-null. Ids that match nothing are reported under `unknownIds`; re-application is idempotent; the closeout is `closeouts/<date>-amendment-<slug>.md` `[fact: core/amendment.ts]`.

### E8 — `workflow/status.yaml` (framework-owned canonical state)

Schema (v1) as normalized on read and serialized on write `[fact: core/types.ts:43-60, status.ts:126-238, real sample]`:

```yaml
project_name: <string>              # basename(cwd) when blank; NOT quoted when it matches [A-Za-z0-9_./-]+
pipeline: workflow/<file>.yaml      # workspace-relative; must exist
current_phase: <phase-id> | complete
last_updated: "<ISO 8601>"          # host clock; quoted because of ':'
schema_version: 1                   # > 1 refused on read and write
phases:
  <phase-id>:
    status: pending | complete      # "partial" and "in-progress" are read as non-complete but never written
    owner_notes: [string]
    outputs_present: [string]       # primary_output paths accepted by completion
    open_questions: [{id, kind, description, deferred_reason}]
    carry_forward: [{id, kind, description, deferred_reason, target_phase, derives_from?}]
next_actions: [string]              # "Begin <phase> phase by producing <path>" or the terminal routing lines
post_pipeline: [{id, kind, description, deferred_reason, source_phase, status}]
```

Serialization: list items that are objects are emitted as a bare `-` line followed by an indented mapping (real sample above); strings outside `[A-Za-z0-9_./-]+` are JSON-quoted; strings inside it are bare, so a value that re-parses as a number/boolean/null is coerced `[hazard: mech 1.1]`. Every write goes through `status.yaml.lock` + temp + rename except init's first write (`server.ts:241`, `index.ts:566`). Phases present in the file but absent from the pipeline are kept; phases in the pipeline but absent from the file are backfilled `pending` `[fact: status.ts:215-226]`.

### E9 — Closeout file and THREAD_LOG line

Closeout: `closeouts/<YYYY-MM-DD>-<phase>.md`, date from the host clock in UTC (`dateOnly(ISO)`), which is why this run's closeouts are dated 2026-09-12 while the session wrote 2026-09-11 `[fact: completion.ts:239-262; real sample]`. Content = handoff `closeout_content` + `\n\n## Decisions Beyond Prompt\n\n- …` when decisions exist, else the template copied once. The **latest** existing `<date>-<phase>.md` is overwritten on re-completion (one canonical closeout). Consumers parse `## Summary` (dashboard, ≤ 280 chars), read the newest `-<phase>.md` (rewriter, ≤ 8000 bytes) or the three newest by date (narrator, ≤ 4000 bytes each).

THREAD_LOG line grammar: `- <date> — <phase|amendment:<slug>|scaffold-refresh> — <summary> — [closeout](closeouts/<file>)` for completion and amendment (deduped by the `[closeout](…)` link); `- <date> — scaffold-refresh — Refreshed N …` for refresh (no link, **never deduped**) `[fact: completion.ts:268-280; amendment.ts:188-198; workspace.ts:291-299]`. Appends start on a fresh line even if the file lacked a trailing newline.

### E10 — DECISIONS.md row

`D<NNN> | <decision text> | <closeout stem> | closeouts/<file> §Decisions Beyond Prompt (<phase>)` appended under a visible `## Completion log` line (inserted if absent); `NNN` = max visible `^D(\d+)\s*\|` + 1, zero-padded to 3; a decision whose exact text already appears anywhere in the comment-stripped file is skipped `[fact: completion.ts:116-153; real sample D001–D005]`.

### E11 — CONVENTIONS.md pending bullet

Under a visible `## Pending proposals` line: `- **<name>** (<phase>, <date>) — <rule>` with optional `  - Evidence: <text>`; deduped when both `**name**` and the rule text already appear; the pending count = lines starting `- **` after the heading until the next `## ` `[fact: completion.ts:159-218]`. Promotion is manual; the orchestrator rewrites the file (this run's C01).

### E12 — Usage log `workflow/.usage.local.yaml`

```yaml
version: 1
runs:
  - timestamp: "<ISO>"; phase; status: completed|aborted|error; turn_count; tool_uses; duration_ms
    tokens: {input, output, cache_write}
    session_file?: <absolute path>          # Pi only
    compactions?: {successful, failed, aborted, reasons: {threshold, overflow, manual}}
    recorded_by?: pi-runner | mcp-complete  # absent on entries from < 0.15
```

Append-only by intent; entries failing the type guard are dropped on read; a corrupt file reads as empty and is then overwritten `[hazard: mech 2.3]`; no lock `[hazard: arch-CF4]` `[fact: core/usage.ts; real sample]`.

### E13 — Dashboard data island

`<script id="cc-dashboard-data" type="application/json">{project, generatedAt, packageVersion, phases[{id, status, purpose, primary_output, primary_output_exists, secondary_outputs[]}], post_pipeline, usage, closeouts}</script>` with `<`, `>`, `&`, U+2028/2029 escaped; read back only by the page's own export button `[fact: core/dashboard.ts:611-626; real sample]`. Narration cache `.dashboard-narration.local.md`: `---\ngeneratedAt: …\nphaseCountAtGeneration: N\n---\n<body>`.

### E14 — Phase checkpoint

`scratch/checkpoints/<phase>.md`: frontmatter `phase`, `updated_at`, `tokens_before`, `source: pi-compaction` (or `manual` per template) then `# Phase checkpoint` and the compaction summary; written atomically by the Pi `session_compact` hook; listed as a read by E2 when present; never deleted by the framework `[fact: phase-compaction.ts:33-58]`.

### E15 — Pi child session event stream

| Field | Value |
|---|---|
| **Producer** | `AgentSession` created by `createAgentSession` (`agent-runner.ts:167-176`) `[external: Pi SDK 0.85.1]`. |
| **Consumer** | `runPhase`'s subscriber → `PhaseActivity` counters → widget and summary. |
| **Transport or carrier** | In-process `session.subscribe(cb)`. |
| **Ordering guarantees** | Events observed: `tool_execution_start`/`_end` (keyed by `toolCallId`, falling back to `<tool>-<n>`), `turn_end`, `message_start`/`message_update` (`assistantMessageEvent.type === "text_delta"`)/`message_end` (assistant `usage {input, output, cacheWrite}`), `compaction_end` (`reason`, `result`, `aborted`, `errorMessage`) `[fact: agent-runner.ts:189-247]`. Order within a turn is the SDK's `[external]`. |
| **Error cases** | `session.prompt` rejection propagates as a phase `error`; abort via `signal` → `session.abort()`. |
| **Restart or resume behavior** | After `prompt()` resolves, if the primary output is absent or the last message is a tool result / a tool-use stop, one continuation prompt is sent after waiting ≤ 30 s for a compaction to settle `[fact: agent-runner.ts:260-274]`. The child session file under `~/.pi/agent/sessions/` carries `parentSession` and the display name `CodeCartographer phase: <id>` (which is also the key the compaction hooks match, `^[a-z0-9][a-z0-9-]*$` `[hazard: mech 6.11]`). |

### E16 — Pi custom messages (child/runner → orchestrator transcript)

`pi.sendMessage({customType, content, display: true})` with `customType` ∈ `codecarto-steering` (rewritten seed prompt with provenance line), `codecarto-phase-summary` (header, italic stats line, ≤ 2000-char excerpt, transcript path, validate trailer), `codecarto-auto-summary` (outcome header, stats line, validation block when stopped, reason, recovery hint) `[fact: auto-runner.ts:101-109,154-168,705-709; agent-summary.ts; tests/agent-summary.test.mjs, tests/auto-summary.test.mjs]`. None trigger a model turn.

### E17 — Pi hooks

`tool_call` → `{block: true, reason}` or `undefined` (orchestrator: `index.ts:422-452`; child: `phase-compaction.ts:68-86`); `session_before_compact` → `{compaction: result}` or `undefined` (host default); `session_compact` → writes E14. Inputs: `event.toolName`, `event.input.path` (leading `@` stripped), `event.preparation`, `event.signal`, `event.compactionEntry.{summary, tokensBefore}` `[external: hook shapes are the SDK's]`.

### E18 — Library files

Authoritative spec: `docs/library-format.md` (read in full this phase). Confirmed against `core/library.ts` `[fact]`: marker JSON `{schema_version: 1, name, namespaced, visibility?, created_at?}` (tolerant reader; non-object → "no library"); `metadata.yaml` with the required nine fields plus `generation` (seven keys), optional `namespace`, `source_commit`, `source_branch`, `source_dirty`, `scope_tier_counts`, `confidentiality`, `provenance {prior_version, mutation_source}` (reader requires at least one of `slug`/`source_repo`/`headline`/`pipeline` non-empty); `index.yaml` `{schema_version: 1, library_name, generated_at, entry_count, namespaces[], entries[{slug, namespace?, latest_version, versions[], source_repo, headline, tags[], capabilities[], confidentiality?, last_analyzed_at, last_codecarto_version}]}` sorted by `(namespace, slug)`; `INDEX.md` table with rows linking `entries/[ns/]slug/vN/`; `latest` = `v<N>\n`. Two spec-vs-code drifts found: (a) `docs/library-format.md:285-289` says folded `>` scalars are **not** read and make the file fail to parse, but the parser has read `>`/`>-`/`>+` since 0.19.3 (`tests/yaml.test.mjs:90-152`); (b) `INDEX.md`'s generated footer says "regenerate with `codecarto library-reindex`" (`core/library.ts:1072`), a command that exists on no surface (the MCP tool is `codecarto_library_reindex`; Pi has none). Both routed as proto-CF1.

### E19 — OpenRouter Batch API (B7)

All shapes below are what the code sends and what its parser expects; the peer's actual behavior is `[external]` (registered as `q-openrouter-batch-envelope`, kind `needs-fixture-capture`).

| Field | Value |
|---|---|
| **Producer / Consumer** | `core/broadside.ts:submitBatch`, `fetchBatch` ↔ `openrouter.ai`. |
| **Transport or carrier** | HTTPS JSON, `Authorization: Bearer <key>`, 30 s `AbortSignal.timeout` per request. |
| **Ordering guarantees** | Request body key order matters to the peer: `{endpoint: "/v1/chat/completions", model, requests[]}` in that order (`:2044-2050`, `tests/broadside.test.mjs` "submitBatch orders endpoint and model before requests") `[external]`. |
| **Required fields (request)** | `requests[i] = {custom_id, body: {model, messages[{role: system|user, content}], response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}, max_tokens, reasoning?: {enabled?, effort?, max_tokens?}}}`; `custom_id` = `<lens>-<sanitized module>[-<n>]`. |
| **Expected response** | Submit: HTTP 202 with `{id, status}`; anything else → `rejected` with the body as `error`. Poll: `{status, request_counts{completed,total}, results[{custom_id, response: {body: {choices[0].message.content}}, error?}], usage{cost}, error?}`; HTTP 401/403 → synthetic `auth-failed`; fetch failure until the deadline → synthetic `timeout` `[fact: :2038-2126]`. |
| **Identifiers and timestamps** | Batch `id` (opaque); `custom_id` echoed per result; run ids are ISO timestamps with `:`/`.` → `-`. |
| **Error cases** | Non-JSON body throws inside `resp.json()` → submit path marks `rejected`, catalog path falls back (mech 2.5). |
| **Restart or resume behavior** | Requests are pure (no tools) so any slice may be re-submitted (`:21-28`); `requests.json` persists the exact bodies for the truncation retry. |

### E20 — Broad-Side state and run files

`broadside/state.json`: `{schema_version: 1, runs[{id, createdAt, model, lenses[], status: in-flight|completed|partial|failed, outputDir, batches{<lens>: {batchId, requests, status, submittedAt, completedAt?, estimatedCost, cost?, resultCount?, error?, model?, outputCap?}}, synthesis{batchId?, status: pending|submitted|completed|failed, cost?, error?}, triage{same}, totalCost?, pricing{inputPerM, outputPerM, source}, maxCost?, outputCap?, sourceHead?, sourceDirty?, baseHead?}]}`, tab-indented JSON, written under `state.json.lock` by merge-by-run-id (`persistBroadsideRun`); `schema_version` is written but never checked on read `[fact: :1657-1741]`. Run dir files: `requests.json` (custom_id → request), `raw-<lens>.json` (whole poll response), `<custom_id>.json` (parsed JSON, or raw text when truncated), `<custom_id>.md` (rendered), `<custom_id>.error.json`, `synthesis.json/.md`, `triage.json/.md`, `run-meta.json` (`experimental: true`, method, model, pricing, costs, counts, `lens_models`, disclaimer). `model-catalog.json`: `{schema_version: 2, fetched_at, models{<id>: CatalogEntry}}` — written with schema 2, read without a version check, TTL is file-level `[hazard: mech 1.9]`.

### E21 — git probes (B8)

`core/library.ts:runGit` (`spawn`, stdio ignore/pipe/pipe, resolves `{ok, stdout, stderr}`, never throws): `rev-parse --show-toplevel`, `remote get-url <name>`, `symbolic-ref --short HEAD`, `config --get branch.<b>.remote`, `add -- .`, `status --porcelain`, `commit -m`. `core/broadside.ts` (`execFile`, `maxBuffer` 64 MiB / 1 MiB): `ls-tree -r --name-only HEAD`, `rev-parse HEAD`, `status --porcelain`, `diff --name-only <base> HEAD`. A missing `git` binary degrades to "record the directory" / "walk the tree" `[fact]`. Tests pin that a user's global git config (`url.insteadOf`, `gpgsign`) can change what `remote get-url` reports `[hazard]`.

### E22 — The YAML dialect (cross-cutting carrier for E6–E8, E12, E18, config)

Read: block mappings/sequences, plain/single/double-quoted scalars (double-quoted via `JSON.parse` with fallback), `#` comments outside quotes, block scalars `|`,`|-`,`|+`,`>`,`>-`,`>+` in mapping values and sequence items, duplicate keys rejected, `__proto__` safe, sequence items' nested keys at the item's own content column (`tests/yaml.test.mjs:44-67`) — but not at any other column, and no plain multi-line scalars `[hazard: mech 2.7]`; no flow collections, anchors, or multi-document streams (a flow sequence parses as a string). Written: bare scalars for `[A-Za-z0-9_./-]+`, JSON-quoted otherwise, `[]`/`{}` for empties, objects in sequences as `-` + indented mapping `[fact: core/yaml.ts]`. The round trip is pinned only for values that survive it (`tests/yaml.test.mjs:71-81`); scalar-looking strings do not `[hazard: mech 1.1]`.

## State Machine

### SM1 — Phase lifecycle (per `status.phases[<id>].status`)

| Current State | Event / Trigger | Guard | Next State | Side Effects |
|---|---|---|---|---|
| (absent) | workspace load | phase in `phase_order` | pending | record backfilled in memory (`status.ts:216-226`) |
| pending | `codecarto_complete` / `autoCompletePhase` | E3 overall ∈ {PASS, PASS WITH GAPS}; handoff present when `handoff_requirements`; E6 gates D1/D3, target_phase, post_pipeline id; lock acquired; **re-validation under the lock** still passes | complete | owner notes +3, `outputs_present` += primary, PARTIAL rows → `needs-maintainer-decision` questions, handoff applied, `last_updated`, `current_phase`/`next_actions` recomputed, E9–E11 written, then status temp+rename |
| complete | `codecarto_complete` again (forced by id) | same guards | complete | idempotent re-application; closeout overwritten; THREAD_LOG unchanged |
| complete | `codecarto_switch_pipeline` | phase exists in the new pipeline | complete (carried) | `current_phase` reset to the new first phase `[hazard: mech 1.3]` |
| complete | `codecarto_switch_pipeline` | phase absent from the new pipeline | (dropped from status) | findings stay on disk; carry-forwards targeting it dangle `[hazard: mech 1.4]` |
| any | `codecarto_init force` / Pi confirmed re-init | — | pending (fresh file) | old workspace moved to `.codecarto-backup-<ts>/` |
| pending / complete | hand edit (drop-in) | none | anything | not a framework transition; `partial`/`in-progress` read as not complete |

Observational values: `running` (dashboard-only, never written, mech 1.13); `partial`/`in-progress` (typed, never written) `[fact]`.

### SM2 — Pipeline cursor (`current_phase`)

`current_phase` = first phase in `phase_order` whose status ≠ complete and whose `depends_on` are all complete; `complete` when none (`getNextEligiblePhase`). Recomputed only by completion; `switchPipeline` and init set it to the first phase; `codecarto_status` and the Pi widget display the recomputed value, the dashboard header displays the stored one `[fact]`. Terminal barrier: when the cursor reaches `complete`, `next_actions` becomes the routing lines, amendments become legal, skills unlock, and handoffs are no longer consumed.

### SM3 — Completion transaction (ordering within one `codecarto_complete`)

| Step | Where | On failure |
|---|---|---|
| 1. Load state, handoff; run gates (handoff presence, target_phase, post_pipeline ids, D1, D3, closure-mention warning) | `completion.ts:322-431` | throw; **nothing written** |
| 2. Acquire `status.yaml.lock` (O_EXCL; retry 125 ms; timeout 5 s; break > 60 s) | `workspace.ts:349` | "Timed out waiting for lock" |
| 3. Re-validate the primary output | `completion.ts:448-456` | throw; lock released; nothing written |
| 4. Build next status in memory; apply handoff | `:459-500` | — |
| 5. **Write closeout, THREAD_LOG line, DECISIONS rows, CONVENTIONS proposals** | `:502` (`writeCompletionArtifacts`, inside the updater) | partial artifacts remain |
| 6. Assert canonical shape; write status temp file; **rename** | `workspace.ts:365-370` | if this fails, step 5's artifacts exist while `status.yaml` still says `pending` — THREAD_LOG and closeout claim a completion the status does not record `[fact: ordering read from source]` |
| 7. Release lock; wrapper appends usage receipt and renders dashboard (best effort) | `server.ts:413-434` | swallowed |

The barrier is step 6's rename; steps 5 and 7 are observational writes. Routed as proto-CF1 (artifact-before-status ordering).

### SM4 — Open question / carry-forward lifecycle

| Current State | Event | Guard | Next State | Side Effects |
|---|---|---|---|---|
| (none) | handoff `open_questions[]` at completion | — | open (in the completing phase's record) | id auto-assigned if missing; a same-id entry in another phase is moved here |
| (none) | PARTIAL validation row | — | open, `kind: needs-maintainer-decision` | even if the same gap is also routed as carry_forward (mech 1.5) |
| open | listed in E2 duties of every later phase | kind ∈ {needs-maintainer-decision, needs-runtime-test} | open | re-triage duty (capped at 10 listed) |
| open | `open_question_closures` (any phase) | D3: `needs-runtime-test` needs `evidence` on scaffold ≥ 0.19.0 | removed from **all** phases | closure id should appear in the report (warning otherwise) |
| open | amendment `open_question_closures` | pipeline complete | removed | counts rebuilt |
| (none) | handoff `carry_forward[]` | `target_phase` later in `phase_order` | routed | surfaced in the target phase's E2 "Items routed" list |
| routed | `carry_forward_closures` | D1: if `derives_from` names an open question, that question must be closed in the same handoff | removed from all phases | — |
| routed | re-defer | new entry with a later target | routed again | old entry closed separately |
| routed | pipeline switch drops the target | — | dangling (mech 1.4) | never surfaced |
| (none) | handoff `post_pipeline[]` | id required | pending | `source_phase` defaulted |
| pending (post) | amendment `post_pipeline_closures` | pipeline complete | **removed** | `status: resolved` exists in the type and dashboard filter but nothing ever writes it `[fact: amendment.ts:170; types.ts:40]` (dead value, routed proto-CF1) |

### SM5 — Pi phase activity and auto loop

`startPhase` → `running` → `finishPhase` → `completed` \| `aborted` \| `error` → `clearPhase` after 30 s; the widget ages finished entries out after 80 ticks (`agent-state.ts`, `agent-widget.ts`). Re-entry guard: `isPhaseRunning`. The auto loop's decision matrix is in `findings/runtime-lifecycle/runtime-lifecycle.md` §2026-09-11 contracts. Synchronous barriers: `runPhase` await, `validatePhaseOutput`, `autoCompletePhase`; observational: notifications, custom messages, dashboard, usage.

### SM6 — Broad-Side run, batch, and post-pass

| Machine | States | Transitions and guards |
|---|---|---|
| Run (`run.status`) | in-flight → completed \| partial \| failed | after collect: every lens terminal ∧ resultCount > 0 → completed; every lens terminal ∧ 0 results → failed; else partial (`:2964-2968`) |
| Lens batch (`batches[lens].status`) | submitting → `<peer status>` … → completed \| failed \| expired \| cancelled \| auth-failed \| timeout \| skipped \| rejected | `skipped` when a lens gathers no files (never submitted); `rejected` on non-202 or a network throw; `timeout` is **not** terminal and is re-polled by a later collect; the terminal set is spelled as a literal array in three places (`:2704`, `:2847`, `:2966`) beside the shared `BROADSIDE_DEAD_BATCH_STATUSES` (`:2091`) `[fact]` (routed proto-CF1) |
| Post-pass (`synthesis`/`triage.status`) | pending → submitted → completed \| failed | submitted only when every lens is terminal and results are in hand (from this collect or read back from disk); `failed` on rejection or a dead peer status; a `timeout` leaves it `submitted` for a later collect to claim (`:2825-2961`) |
| Truncation retry | per stored result: truncated → retried once with `min(2×max_tokens, outputCap)` → parsed \| still truncated | shares the collect deadline; never re-retried |
| Incremental | requested → applied \| not applied (dirty-worktree \| no-baseline \| diff-failed) | reported on the estimate and submit text |

### SM7 — Library publish decision

validate (marker, slug, namespace parity) → source-repo guard (newest version's recorded repo vs incoming, normalized; skipped when unreadable; `allowSourceRepoChange` bypasses) → confidentiality guard (entry ≥ library rank; `allowConfidentialityMismatch` bypasses) → content hash of the **highest-numbered** version's spec: equal ∧ ¬force → metadata-only rewrite (provenance carried) → reindex; else stage `<slug>.publish.<pid>.<ts>/` → rename to `v<N+1>/` → `latest` → reindex `[fact: core/library.ts:588-726]`. A failure after the rename leaves `latest`/index stale (`docs/library-format.md:543-546`; mech 2.11).

## Persistent Schema Notes

| Store | Mutability | History | Compaction / summarization | Replay / resume | Locking / dedupe / conflict |
|---|---|---|---|---|---|
| `status.yaml` (E8) | Mutable, whole-file rewrite | Linear; no history (closeouts + THREAD_LOG are the history) | `owner_notes` only grow (uniqueStrings) | Any surface resumes from it; `getNextEligiblePhase` is the replay | `status.yaml.lock`; temp+rename; merge-by-id for questions/carry-forwards/post_pipeline; `schema_version` 1 gate both ways |
| Handoffs (E6) | Written by the LLM, never modified by the framework | One file per phase, overwritten by the LLM | — | Re-completion re-reads it | None; only the phase-id charset check |
| Closeouts (E9) | One canonical file per phase, **overwritten** on re-completion (latest by date) | Per date only through the filename | — | Read by rewriter/narrator/dashboard | None |
| THREAD_LOG.md (E9) | Append-only | Linear | — | Index only | Dedupe by closeout link (completion, amendment); refresh lines never deduped; appends start on a fresh line |
| DECISIONS.md / CONVENTIONS.md (E10/E11) | Append (framework) + free rewrite (orchestrator) | Numbered D rows; pending bullets | — | — | Dedupe by text; numbering from max visible D; both parsers strip `<!-- -->` first |
| Usage log (E12) | Append-only by intent | Linear runs | Totals computed on read | — | **No lock**; corrupt → empty → overwritten (mech 2.3); type-guarded rows |
| Checkpoints (E14) | Overwritten per compaction | Latest only | It *is* the compaction summary | Listed as a read on resume | temp+rename |
| Dashboard + narration (E13) | Regenerated | None | Narration cached until next `--narrate` | — | temp+rename; best effort |
| Library (E18) | Versioned, append-new-version; metadata of the latest version rewritable | Linear `v1..vN`, no branching; gaps tolerated on read | — | Read via `latest` pointer, fallback to max dir | temp+rename and staging-dir rename; **no cross-process lock** (mech-CF6); derived index regenerated, conflicts resolved by regenerate |
| Broad-Side state (E20) | Mutable, merge-by-run-id | Linear list of runs | — | Collect resumes the **last** run only (mech-CF5) | `state.json.lock`; corrupt → empty → overwritten (mech 2.2) |
| Run dirs (E20) | Write-once per artifact, retried slices overwritten | Per run | — | `loadSavedLensResults` rebuilds from disk | None |
| Config (B9) | User-edited; `writeLibraryConfig` rewrites the `library:` block | None | — | Re-read per call | None; malformed layer silently dropped |

Schema-version axes (each independent) `[fact]`: status `schema_version` (1, gated read and write); handoff/amendment `schema_version` (1, gated on parse); `workflow/scaffold-version.yaml` (package version; gates the findings-pairing error at ≥ 0.17.1 and the closure-evidence refusal at ≥ 0.19.0; a mismatch only warns); library marker and `index.yaml` (1, read tolerantly, never gated); Broad-Side `state.json` (1, unchecked) and `model-catalog.json` (2, unchecked); usage `version` (1, unchecked). Only the first two refuse anything.

## Compatibility Hazards

| Hazard | Where It Appears | Severity | Notes |
|---|---|---|---|
| Markdown-as-protocol: validation, coverage, and findings grammars are substring/regex parses over LLM-written text (E3–E5) | `core/pipeline.ts`, `coverage.ts`, `findings.ts` | high | A port that renders tables differently (no leading pipe, wrapped cells, a decorated `**Overall:**`) silently fails validation; the last-heading anchor and the "any 4-cell row" rule are the exact contract `[hazard]` |
| Hand-rolled YAML subset (E22) with an asymmetric round trip | every persisted YAML file | high | Scalar-looking strings coerce (mech 1.1); only 2-space-past-dash or content-column nesting parses; a real YAML library would accept more and emit differently, changing on-disk bytes the tests pin `[hazard]` |
| O_EXCL lock file + mtime staleness (SM3 step 2) | `core/status.ts:408-449`, Broad-Side state | medium | Non-atomic on network filesystems; unconditional `rm` on release can delete another holder's lock after a stale break (mech-CF1) `[hazard]` |
| temp + `rename` atomicity | every writer | medium | POSIX semantics assumed; Windows rename over an open file differs; temp names embed pid+ms `[hazard]` |
| Closeout/THREAD_LOG dates are UTC host time | E9 | low | Session-local dates in reports (this run: 09-11) differ from framework dates (09-12); consumers matching by date must use the framework's |
| Completion artifacts written before the status rename (SM3) | `completion.ts:502` vs `workspace.ts:365-370` | medium | A crash or write failure between them leaves THREAD_LOG/closeout asserting a completion `status.yaml` lacks; no rollback `[fact]` |
| Three literal copies of the terminal batch-status set (SM6) | `core/broadside.ts:2704,2847,2966` | low | Drift between the copies and `BROADSIDE_DEAD_BATCH_STATUSES` changes which runs count as terminal `[fact]` |
| Key-order-sensitive peer (E19) | `submitBatch` payload | medium | Serialization must preserve `endpoint`, `model`, `requests` order `[external]` |
| Batch model ids advertised but unsubmittable | `models` action vs submit | low | The catalog lists `:batch` variants the peer rejects; only a probe distinguishes them (config.yaml comment) `[external]` |
| `custom_id` sanitization | `sanitizeId` `[^a-zA-Z0-9_-]` → `-` | low | Two modules that differ only in sanitized characters collide in `requestsByCustomId` and result file names `[inference]` |
| Pi session-name matching for hooks | `phase-compaction.ts:12` | low | `^[a-z0-9][a-z0-9-]*$` narrower than allowed phase ids (mech 6.11) |
| Absolute session paths in usage → refused by the dashboard's relative-link rule | E12 / E13 | low | Session links never render (mech 1.14) |
| Git config leakage into recorded provenance | E21 | low | `url.insteadOf` rewrites `remote get-url`; tests neutralize global config, production does not `[hazard]` |
| Terminal/encoding | Pi widget uses `truncateToWidth` and braille spinner glyphs; THREAD_LOG uses `—` (em dash) as the field separator | low | A port that changes the separator breaks the dedupe/parsing of E9 lines `[hazard]` |
| Dead or unreachable protocol values | `status: running`, `post_pipeline.status: resolved`, `partial`/`in-progress` | low | A port copying the type would port states no writer produces (mech 1.13; SM4) |
| Spec drift in `docs/library-format.md` and generated `INDEX.md` | E18 | low | Folded scalars now parse; `codecarto library-reindex` does not exist `[fact]` |

## Coverage and limits

- Inspected scope: every parser and serializer that defines a wire or persisted shape (`core/yaml.ts`, `pipeline.ts`, `findings.ts`, `coverage.ts`, `status.ts`, `completion.ts`, `amendment.ts`, `usage.ts`, `dashboard.ts` data island, `library.ts`, `broadside.ts` request/response/state/run-file code, `orchestrator-config.ts`); the MCP envelope in `mcp-server/server.ts`; the Pi event subscription, hooks, and custom messages in `extensions/codecarto/{agent-runner,auto-runner,agent-summary,agent-rewriter,phase-compaction}.ts`; `docs/library-format.md` in full; `tests/yaml.test.mjs` in full and the broadside/library test names; the persisted-format templates (`phase-handoff.yaml`, `amendment.yaml`, `phase-checkpoint.md`, `closeout-template.md`); real samples written by this run (`status.yaml`, `.usage.local.yaml`, `dashboard.html`, three closeouts, DECISIONS/CONVENTIONS).
- Skipped scope: the synthesis pipeline's proposal-confirmation grammar beyond `parseConfirmedProposalSelections` (`| [x] | ref | vN |` rows); Broad-Side lens JSON schemas' field-level semantics (the seven `SCHEMAS` were read structurally, not per field); the Pi SDK's own event and hook type definitions (`node_modules/.../types.d.ts` not read; shapes taken from the subscriber code); the MCP SDK's transport framing; `docs/` beyond the library format; the dashboard's inline script as a consumer of E13 beyond the export button.
- Evidence basis: source inspection; tests (yaml round-trip and block-scalar pins, structured-payload, framework-handoff, closure-integrity); runtime samples written by the framework during this run; upstream findings (mechanical scan for hazards, contracts for gate semantics).
- Known blind spots: (1) OpenRouter batch envelope shapes are `[external]` and verified only against self-authored fakes (`q-openrouter-batch-envelope`); (2) Pi SDK event names and payloads are `[external]`, taken from the subscriber's `switch` cases; (3) the exact JSON-RPC framing and error `data` propagation through real clients (Claude Code, Codex) was not observed — only the server's own result objects; (4) `git` output formats are assumed stable; (5) `docs/library-format.md` was checked against the code for the two drifts named, not line by line.
- Coverage disposition: COMPLETE for the framework-owned formats and the LLM-facing grammars; PARTIAL for the two external peers (OpenRouter, Pi SDK), inherited as declared.

## Open Questions

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-openrouter-batch-envelope | needs-fixture-capture | The batch submit (202 `{id, status}`) and poll (`status`, `request_counts`, `results[].response.body.choices[0].message.content`, `usage.cost`, `error`) shapes in E19 are asserted only by the code's parser and the test fakes that mirror it; no captured live response is checked in. | Needs one recorded submit + poll exchange (with key redacted) saved as a fixture so the parser is tested against the peer rather than against itself. |

## Carry-Forward

Mirrored in `scratch/handoffs/protocols.yaml`. Closed here: **arch-CF1**.

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| proto-CF1 | defect-scan-semantic | Protocol/state-machine drift candidates for pass 5: (a) completion writes closeout, THREAD_LOG, DECISIONS, CONVENTIONS before the status rename (SM3 steps 5–6) with no rollback; (b) the terminal batch-status set is three literal arrays plus `BROADSIDE_DEAD_BATCH_STATUSES`; (c) `post_pipeline.status: resolved` is typed and filtered on but never written; (d) `model-catalog.json` is written with `schema_version: 2` and read without a version check; (e) `docs/library-format.md:285-289` says folded scalars are unreadable, contradicted by the parser and `tests/yaml.test.mjs`; (f) generated `INDEX.md` tells readers to run `codecarto library-reindex`, which no surface provides. | Severity and action for documented-contract and state-machine violations are the semantic pass's pass-5 rubric. |
| proto-CF2 | porting | The port's compatibility surface is the set of grammars and version axes in this report: the three markdown grammars (E3–E5), the YAML subset (E22) and its emitter bytes (pinned by tests), the status/handoff/amendment schemas, the THREAD_LOG/DECISIONS/CONVENTIONS line formats, the library format (ABI per its spec), Broad-Side state, and the six independent schema-version axes of which only two gate. | Deciding which of these a port preserves byte-for-byte versus re-encodes is the porting-synthesis judgment the SKILL asks for ("preserve the meaning, then decide how the target encodes it"). |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | An event catalog is documented. | PASS | §Event Catalog E1–E22 across nine boundaries, each with producer/consumer/carrier/ordering/fields/ids/errors/resume or a grammar. |
| 2 | A state machine is documented. | PASS | §State Machine SM1–SM7 (phase lifecycle, pipeline cursor, completion transaction, question/carry-forward lifecycle, Pi activity, Broad-Side run/batch/post-pass, library publish). |
| 3 | Persistent schema notes are documented. | PASS | §Persistent Schema Notes table (12 stores × mutability/history/compaction/replay/locking) plus the schema-version axes paragraph. |
| 4 | Compatibility hazards are documented. | PASS | §Compatibility Hazards, 16 rows with location and severity. |
| 5 | Findings are marked with evidence levels. | PASS | Bracketed markers throughout; peer shapes marked `[external]`; runtime samples named as such. |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits, all bullets filled; COMPLETE/PARTIAL split stated. |

**Validated by:** 2026-09-11 (protocols, self-audit session 1, inline MCP host)
**Overall:** PASS
