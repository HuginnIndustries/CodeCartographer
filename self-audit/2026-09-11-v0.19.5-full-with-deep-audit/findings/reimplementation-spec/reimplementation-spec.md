---
variant: language-agnostic
selection: run-instructed default (the run's instructions require completing every phase without pausing for the user; the Strategic Alignment Hook's interactive question was therefore not asked, and port-CF1 pre-recorded the default)
platform_assumption: local POSIX-like filesystem with atomic same-filesystem rename and O_EXCL create; Windows behavior is a spike, not a requirement
architecture_inspiration: shape-only (the source's ring structure), not a behavior clone of its file layout
build_order: kernel-first with a fake-LLM acceptance harness before any adapter
source_commit: f6f8484 (codecartographer-pi 0.19.5)
---

# Reimplementation Spec

Evidence markers: `[fact]` observed fact (from the bundle and, where named, a targeted deep read), `[inference]` strong inference, `[external]` external-behavior claim, `[hazard]` portability hazard, `[open]` open question. Defect ids `D-H*`/`D-M*` and low groups are from `findings/porting/reverse-engineering-bundle.md` §Defect Synthesis; every disposition there appears below as a normative rule (**MUST**/**MUST NOT**) with an acceptance scenario, except `verify at runtime`, which the bundle did not use and which this spec reserves for the Spike List. Routed items closed here: **port-CF1** (front matter above), **port-CF2** (§Conceptual Module Model rings and §Acceptance Scenarios H-tests).

## System Summary

Build a **pipeline state machine for LLM-driven code analysis**. It owns a per-repository workspace directory, a YAML status document, and a DAG of phases, each with a prompt to hand a host LLM and a markdown artifact to receive back. It never reads the analyzed code and never calls a model. Its value is discipline: it names what the LLM must read, surfaces what earlier phases routed forward, parses the artifact's self-validation, refuses completion unless a structured handoff accompanies a validating artifact, applies that handoff atomically to canonical state, and leaves an auditable trail (closeout, index line, decisions, convention proposals). Two delivery surfaces must exist from the start in shape, one in code: an RPC surface for foreign hosts (stateless per call) and an in-process surface for a host that can run sub-agents and sandbox their writes. Three optional extensions ride on the kernel: a versioned spec library with a synthesis workflow, a paid batch-reconnaissance sweep, and a self-contained HTML dashboard.

The port's scope is the analysis pipeline and its two shells at full parity, with the library, synthesis, Broad-Side, and dashboard as later tiers. The eleven high-severity defects in the source are all design-out-able without changing any contract; they become rules R-S1…R-S11 below.

## Conceptual Module Model

Rings (closes port-CF2): **kernel** modules K1–K6 must build and pass the acceptance harness with no adapter present; **ports** P1–P5 are the interfaces the kernel talks through; **adapters** A1–A5 implement ports for real hosts; **extensions** X1–X6 are optional and depend on the kernel only through its public API; **delivery** modes D1–D4 are how a user reaches a shell.

### K1 — Workspace Store

| Field | Value |
|---|---|
| **Responsibility** | Load, normalize, and atomically persist the workspace's canonical status document and framework-owned scaffold. |
| **Public inputs** | workspace root path; status document; scaffold manifest; a status mutation function. |
| **Public outputs** | normalized workspace state (status + active pipeline + scaffold version); mutation results; scaffold-refresh file list; init/switch results. |
| **Owned state** | `workflow/status.yaml` (schema 1), `workflow/scaffold-version.yaml`, the lock beside the status file. |
| **Invariants** | Every status write happens under an **owned** lock and lands by unique-suffix temp + rename (R-S4, R-S5). `schema_version` > 1 is refused on read and write. Phases present in the file but absent from the pipeline are kept; missing ones are backfilled `pending`. Init copies **only** the scaffold manifest (R-S2) and never the template's own state. A workspace targeted by init that already exists is refused or confirmed, never silently reset (D-M17). |
| **Collaborators** | K2 (dialect), P1 (document store), P2 (lock), P3 (clock). |

### K2 — Document Dialect

| Field | Value |
|---|---|
| **Responsibility** | Read and write the YAML subset every persisted framework file uses, round-trip safe. |
| **Public inputs** | text; plain data. |
| **Public outputs** | plain data; text. |
| **Owned state** | none. |
| **Invariants** | **Read** is a superset of the source dialect (E22): block collections, plain/single/double-quoted scalars, comments outside quotes, block scalars `\|`, `\|-`, `\|+`, `>`, `>-`, `>+` as mapping values and sequence items, duplicate keys rejected, prototype/reserved keys safe, nested keys at any consistent indent (D-M10). **Write** emits bare scalars only for strings the reader returns unchanged and quotes every other string, so `"2048"`, `"true"`, `"null"` survive (R-S3). Parse errors name the construct, not "indentation". |
| **Collaborators** | none (leaf). |

### K3 — Pipeline Engine

| Field | Value |
|---|---|
| **Responsibility** | Walk the phase DAG and report the next eligible phase, completion, or a stuck state. |
| **Public inputs** | pipeline definition (`phase_order`, phases with `depends_on`), phase statuses, an optional phase name or output-file name. |
| **Public outputs** | one of `eligible(phase)`, `complete`, `stuck(phases with unmet dependencies)` (R-S6); phase resolution by id, output basename, or pasted output path; alias table. |
| **Owned state** | none. |
| **Invariants** | The cursor is the first phase in `phase_order` that is not complete and whose dependencies are all complete. `stuck` is never reported as `complete` by any consumer. |
| **Collaborators** | K1. |

### K4 — Artifact Validator

| Field | Value |
|---|---|
| **Responsibility** | Parse a phase artifact's self-validation, coverage ledger, and findings tables; report PASS / PASS WITH GAPS / FAIL / MISSING with gating errors and non-gating notes. |
| **Public inputs** | artifact text; phase definition (primary and secondary outputs, criteria); scaffold version. |
| **Public outputs** | overall result, criterion rows, gaps, errors, warnings, declared-secondary-output presence, coverage gaps. |
| **Owned state** | none. |
| **Invariants** | Grammars E3–E5 exactly as the source (last `## Validation`, ≥ 4-cell rows, `FAIL` anywhere fails, five ledger labels, findings tables by header). The `**Overall:**` literal is matched after stripping trailing decoration and a failed parse says which line failed (D-M9). Evidence/action pairing: unsettled evidence never pairs with a settled action; on a scaffold at or above the vocabulary version it is an error, below it a note. |
| **Collaborators** | K1 (scaffold version), P1. |

### K5 — Handoff and Completion Gate

| Field | Value |
|---|---|
| **Responsibility** | Validate a phase handoff, refuse on every integrity rule, then apply it and the completion side effects as one transaction. |
| **Public inputs** | validation result; handoff document; workspace state. |
| **Public outputs** | updated state, closeout path, orchestrator checkpoint line, non-gating warnings; refusals naming the rule and the ids involved. |
| **Owned state** | closeouts, THREAD_LOG, DECISIONS completion log, CONVENTIONS pending proposals (formats E9–E11). |
| **Invariants** | Refusals happen before the lock and mutate nothing: missing handoff on a phase that requires one; `phase_id` mismatch; non-array collections; `target_phase` not later in `phase_order`; `post_pipeline` without id; D1 (closing a routed item whose `derives_from` question is open and not closed in the same handoff); D3 (`needs-runtime-test` closure without evidence, gated by scaffold version); malformed proposed conventions. Under the lock the artifact is **re-validated**; the status rename is the commit point and every other artifact is written **after** it, idempotently (R-S7 / D-M20). PARTIAL rows become auto-questions only when no handoff entry already tracks the gap (D-M3). Re-running completion is idempotent: one closeout per phase, one index line per closeout link, deduplicated decision rows and proposals. |
| **Collaborators** | K1, K3, K4, P1, P2, P3. |

### K6 — Prompt Assembler

| Field | Value |
|---|---|
| **Responsibility** | Produce the phase prompt and skill prompt text that a host LLM receives. |
| **Public inputs** | workspace state, phase (or skill name), `forced` flag, `auto` flag, optional preflight result. |
| **Public outputs** | prompt text in the fixed section order of E2. |
| **Owned state** | none. |
| **Invariants** | Byte-identical across shells for the same inputs. Required reads always begin GUIDE, status, handoff template. Routed items, pending proposals, re-triage questions, declared secondary outputs with presence, upstream coverage gaps (capped at 10 each with a count), contradiction-sweep line after any completion, stale-scaffold warnings, the auto-mode variant of the strategic hook. **Spliced upstream text (routed descriptions, coverage bullets, library headlines) is delimited and labeled as data, and bounded in size** (D-M22). |
| **Collaborators** | K1, K3, K4 (coverage), K5 (pending-proposal count), X2 (synthesis preflight), P4. |

### Ports

| Port | Responsibility | Invariant |
|---|---|---|
| **P1 Document Store** | read/write text files under the workspace, library, and user-config roots; enumerate directories | One atomic-write primitive: temp file with a **unique** suffix (counter or random, never pid+ms alone), written, then renamed; failures propagate to the caller (R-S4). Containment checks resolve the nearest existing ancestor with realpath and verify the remaining tail lexically (R-S1). |
| **P2 Lock** | mutual exclusion around a document | Owner token written into the lock; release removes only a lock carrying the caller's token; stale-break (age > 60 s) is logged and re-acquires with a fresh token (R-S5). Timeout 5 s, retry 125 ms are defaults in one constants module. |
| **P3 Clock** | timestamps and dates | Host clock, ISO 8601 UTC; the framework owns every canonical timestamp; closeout dates are UTC dates. |
| **P4 Text Sink** | how prompt text reaches the LLM | RPC: returned in both `content[0].text` and `structuredContent.text`; in-process: sent as the child's first user message. |
| **P5 Subprocess** | run `git` probes | Every call has a timeout; a missing binary degrades to "record the directory" / "walk the tree". |

### Adapters

| Adapter | Responsibility | Notes |
|---|---|---|
| **A1 RPC Shell** (today: MCP over stdio) | expose 22 operations; validate arguments (absolute existing `cwd`, string phase, non-empty required strings, **skill names resolved against the installed list** D-M21, `cwd` validated wherever it becomes a containment root D-M28); map refusals to `InvalidRequest`, argument errors to `InvalidParams`, workspace-load failures to `InvalidRequest` (low group), unknown to `InternalError`; carry text in both envelope fields | stateless per call; re-renders the dashboard on every state change including pipeline switch (D-M24) |
| **A2 In-process Shell** (today: Pi extension) | activation gate; write sandbox; phase sub-agent runner; auto loop with the decision matrix; steering, summaries, widgets; headless notify fallback | disposes every child session (D-M19); reads the captured workspace root after a phase, never the possibly-stale ctx (D-M25); asks a human where A1 refuses |
| **A3 Git** | remote resolution, work-tree detection, tracked-file listing, HEAD/dirty/diff | via P5 |
| **A4 OpenRouter Batch** | submit, poll, model catalog, benchmarks | `[external]` shapes; pure, re-submittable requests; key-ordered payload |
| **A5 Dashboard I/O** | gather inputs, render, write via P1 | lives with the kernel's renderer, not under a shell |

### Extensions

| Extension | Responsibility | Depends on |
|---|---|---|
| **X1 Spec Library** | marker, versioned entries, `latest` pointer, derived index, publish guards (repo collision, confidentiality), idempotence by content hash, provenance conflicts | K2, P1, P2 (per-entry lock, D-M18), A3 |
| **X2 Synthesis Preflight** | vision/library/proposal checks and confirmed-selection resolution | X1, K6 |
| **X3 Broad-Side** | lens registry, slicing, cost pre-flight, state and run files, post-passes | K2, P1, P2, A3, A4 |
| **X4 Amendment** | post-pipeline closures under the completion lock | K1, K5 |
| **X5 Usage Ledger** | append-only run records | P1 (append-only lines, D-M7) |
| **X6 Dashboard Renderer** | pure HTML from state | none |

### Delivery modes

D1 RPC over stdio (any MCP host); D2 interactive TUI (Pi); D3 headless TUI (`-p`, notifications to stderr); D4 drop-in template (no executable; the GUIDE is the contract and the manual **MUST** say so, D-M26).

## Layer Split

| Module | Layer | Notes |
|---|---|---|
| K1 Workspace Store, K2 Dialect, K3 Engine, K4 Validator, K5 Gate, K6 Prompt Assembler | core semantics | must survive the port unchanged in behavior; buildable with fakes for P1–P5 |
| P1–P5 | core semantics (interfaces) | fakes exist in the harness before any adapter |
| A1 RPC Shell, A2 In-process Shell, A3 Git, A4 OpenRouter, A5 Dashboard I/O | adapters | A1 first; A2 only for a host with an agent SDK |
| X1–X6 | extensions | tiers 2–3 |
| D1–D4 | delivery surfaces | D1 with A1; D2/D3 with A2; D4 is data only |
| Template (`.codecarto/`) | data, shipped from a manifest | ABI; copied verbatim; includes its ignore file (R-S8) |

## Required Behaviors

Derived from `behavioral-contracts.md` (contract ids in parentheses) with the bundle's dispositions folded in as rules. R-S rules are the eleven high defects; R-M rules are the medium ones.

**Workflow**

- R1 (Init). Create a workspace from the scaffold manifest, select a pipeline (alias or path; default the seven-phase deep-audit variant), write a fresh status with every phase `pending`, seed the four orchestrator files from templates, create an empty `closeouts/`. Refuse an existing workspace without `force`/confirmation; back up on force. **R-S2:** the copied set MUST exclude findings outputs, handoffs, checkpoints, and the dashboard even when the template directory contains them. **R-M17:** a target that is the template itself is treated like any existing workspace. **R-S8:** the shipped template MUST include its `.gitignore`.
- R2 (Open/Status). Report the engine's result, progress `n/N`, terminal open questions, carry-forward count, pending post-pipeline items, every `next_actions` line, and a scaffold-staleness notice. **R-S6:** `stuck` is reported as "stuck: <phases> depend on <missing>" and never as complete.
- R3 (Next/Phase). Return (RPC) or execute (in-process) the prompt for the engine's eligible phase, or a forced phase with the explicit-request line and a dependency warning. On `complete` say so; on `stuck` say so (R-S6).
- R4 (Validate). Apply K4; report the summary lines including NOTE lines for declared-but-missing secondary outputs. **R-M9:** an unparsable Overall line is reported as such.
- R5 (Complete). Apply K5. Wrappers append a usage record and re-render the dashboard best-effort after the transaction. **R-S7:** status rename before artifacts. **R-S4/R-S5:** via P1/P2.
- R6 (Switch pipeline). Carry shared phases' records, start new ones pending, preserve post-pipeline; **R-M1:** recompute the cursor and next actions; **R-M2:** re-route or surface carry-forwards whose target was dropped; re-render the dashboard on both shells (**R-M24**).
- R7 (Skills). List installed skills; run one only when the engine reports `complete` (not `stuck`, R-S6); the reconnaissance reading guide is exempt from both the gate and the workspace requirement. **R-M21:** names resolve against the installed list only.
- R8 (Guide). Serve the driving guide by topic, whole, with the topic footer; the in-process shell wraps it as reference material with a surface addendum.
- R9 (Refresh scaffold). Overwrite framework-owned files from the manifest, never the protected set; one index line; the in-process shell previews and asks.
- R10 (Amend). Only when the engine reports `complete`; closures by id; unknown ids reported; idempotent; closeout and index line; rebuild terminal actions.
- R11 (Usage). Append one record per run; MCP records are receipts with zero counters and are labeled as such. **R-M7:** append-only records, one per line, never rewritten from a parse; a corrupt file is reported, never overwritten.
- R12 (Dashboard). Single self-contained HTML with relative links only; re-rendered on every state change; failure never fails the state change; the failure cause is reported when asked directly.
- R13 (Config). Two layers, per-call reads, key-by-key merge. **R-M8:** a layer that fails to parse is reported, not treated as absent. **R-M12:** relative `library.path` resolves against the config file's directory or is refused. **R-M15:** library-init writes only the keys it was asked to, or documents that it enables the confirm gate.

**Library and synthesis (tier 2)**

- R14 (Publish). Slug derivation, content-hash idempotence with provenance carried, source-repo collision guard (normalized comparison), confidentiality guard (`internal < shared < public`), confirm gate on RPC only when configured, questions on the in-process shell. **R-M18:** a per-entry lock and a typed "version taken, retry" error. **R-M4:** the list filter uses the same normalizer as the guard.
- R15 (List/Reindex/Init). Derived index regenerated from disk; provenance conflicts reported, never written; init idempotent; relative paths refused on RPC.
- R16 (Synthesis preflight). Vision present and meaningful; library configured, marked, non-empty; proposal present with ≥ 1 confirmed `[x]` row whose version exists.

**Broad-Side (tier 3)**

- R17. Six lenses; slice by module when over the lens cap; price from actual sizes (**R-M6**) against live/cached/built-in rates; refuse models without structured output; **R-S9:** a non-zero default `max_cost`, refuse over it on RPC unless forced, explicit zero spellable; **R-S10:** a config file that exists but does not parse refuses a submit; **R-S8 wrapper rule (R-S8b):** explicit `wait_seconds: 0` passes through as "no poll"; **R-S11:** never persist over an unparseable state file; **R-M13:** unsupported language is a refusal; **R-M5:** one snapshot source, recorded; **R-M14:** HTTP status surfaced on catalog/poll errors; **R-M23:** redaction pass or allowlist before upload, documented. Collect is resumable (terminal lenses skipped, saved results reloaded, `submitted` post-passes claimed, one truncation retry, one shared deadline).

**In-process shell (tier 2, host-dependent)**

- R18 (Sandbox). `bash` blocked; `edit`/`write` confined to the workspace plus a marker-validated library. **R-S1:** containment resolves the nearest existing ancestor; a symlinked ancestor outside the root fails.
- R19 (Phase runner). Isolated child session with the read/edit/write/grep/find/ls allowlist; one continuation prompt when the primary output is absent or the transcript ended mid-tool-call; summaries; usage; **R-M19:** child disposed after use; **R-M25:** post-phase work uses the captured workspace root.
- R20 (Auto loop). The decision matrix (aborted → aborted; error → stop; FAIL/MISSING → stop; PASS WITH GAPS + strict → stop; else continue); the strategic hook suppressed with `selection: auto-default` recorded.
- R21 (Headless). With no UI every notification goes to stderr as `[<name>] <level>: <message>`; stdout is never used for prose.

**Documentation as contract**

- **R-M26/R-M27 (docs).** The manual MUST describe the handoff contract and state that drop-in mode has no completion executable; user docs MUST describe validation as parsing the artifact's self-attestation plus cross-checks, not as evaluating criteria. The low doc-drift group is fixed in the same pass.

## Protocols and Persisted State

Preserve **byte-for-byte** (any existing workspace, library, or config must load unchanged): the status document schema (E8), handoff (E6) and amendment (E7) schemas including auto-id patterns `oq-<phase>-N` / `cf-<phase>-N`, the template paths, the THREAD_LOG line `- <date> — <phase> — <summary> — [closeout](closeouts/<file>)` and its link-based dedupe, the DECISIONS `D<NNN> | text | stem | closeouts/<file> §Decisions Beyond Prompt (<phase>)` row and max-visible numbering, the CONVENTIONS pending bullet `- **name** (phase, date) — rule`, the library format (marker JSON, `metadata.yaml` keys and order, `index.yaml`, `INDEX.md` table with links to `v<N>/`, `latest` as a regular file), Broad-Side `state.json` and run-directory file names, the three markdown grammars E3–E5 as parsed today (with the tolerant Overall parse), and the YAML dialect on the **read** side. `[fact: protocols §Persistent Schema Notes; bundle §Protocol and State Notes]`

May be **re-encoded** with the pinning tests updated and the library spec's dialect section corrected: the usage log (recommended: one record per line), the dashboard data island, the catalog cache (declare and check one schema version), the narration cache, checkpoints, prompt wording.

State machines to preserve: SM1 (phase `pending → complete` only; no other value is ever written, and `partial`/`in-progress`/`running`/`resolved` are dropped from the port's types unless implemented), SM2 with the `stuck` outcome added, SM3 with the reordered commit point, SM4 (question/carry-forward/post-pipeline lifecycle, D1/D3), SM6 (Broad-Side statuses with one terminal-status constant), SM7 (publish decision with the per-entry lock). Version axes: status and handoff gate; scaffold version selects rule strictness at the two documented thresholds; every other file declares one version and the reader checks it.

## External Dependencies

| Dependency | Stance (replace/wrap/emulate/postpone) | Rationale |
|---|---|---|
| MCP SDK (server, stdio transport, error codes) | wrap | A1 is a thin shell; the port's language will have an MCP library; keep the dual-payload envelope regardless of library |
| Pi coding-agent SDK (sessions, hooks, widgets) | wrap, then postpone until tier 2 | Only meaningful on that host; the kernel must not know it exists |
| YAML | emulate on read (the dialect is the ABI), own emitter on write | A full YAML library would accept more than the source and emit different bytes; if one is used, wrap it to enforce the dialect and quoting rules |
| Node `fs` atomic patterns | replace with P1/P2 | The eight hand-rolled copies are the defect root (D-H4, D-H5) |
| `git` binary | wrap | Probes only; degrade gracefully; timeouts |
| OpenRouter Batch API | wrap; postpone to tier 3 | `[external]` shapes; keep requests pure |
| Markdown | emulate the three grammars | They are the LLM-facing contract; no markdown library reproduces "last heading anchors the block" |
| HTML dashboard | postpone to tier 3 | Optional; pure renderer |

## Portability Hazards

From the bundle §Portability Hazards, restated as what the port must test: markdown-as-protocol fixtures (every template's validation block, a decorated Overall, a wrapped cell); YAML round-trip property tests including scalar-looking strings and every block-scalar form; owned-lock tests including the stale-break sequence; unique-suffix atomic writes under concurrency; the reordered completion commit point under injected failure; UTC dating; the ctx-invalidation and disposal behavior of the in-process host `[external]`; OpenRouter shapes `[external]`; RPC envelope read by at least one client the port did not author; install-path-independent `.gitignore`; a template manifest that cannot leak the framework's own state; git-config-independent provenance; dead protocol states removed.

## Implementation Sequence

Kernel-first. The first artifact is a **deterministic acceptance harness**: a fake LLM that returns scripted artifacts (passing, PARTIAL, decorated Overall, missing block, unsettled-evidence rows, coverage ledgers with gaps), fake P1/P2/P3/P5 with failure injection (rename failure after artifact write, same-millisecond writers, stale locks, symlinked directories), and the black-box scenarios below. Milestones, each one reviewable slice with its tests:

1. K2 dialect with round-trip property tests (R-S3, R-M10).
2. P1/P2 primitives with concurrency and failure-injection tests (R-S4, R-S5, R-S1).
3. K1 store: load/normalize/commit; init from manifest (R-S2, R-S8, R-M17); switch (R-M1, R-M2).
4. K3 engine with the `stuck` outcome (R-S6).
5. K4 validator: the three grammars from fixtures, pairing rule, scaffold gating (R-M9).
6. K5 gate: refusal matrix, transaction ordering (R-S7), idempotence, PARTIAL policy (R-M3), side-effect formats.
7. K6 assembler: byte-fixed prompt fixtures, delimited splices (R-M22).
8. A1 RPC shell over the kernel; argument validation (R-M21, R-M28); envelope; dashboard on switch (R-M24). **Minimum viable port ends here.**
9. X5 usage (R-M7), X6+A5 dashboard, X4 amendment, config (R-M8, R-M12, R-M15).
10. X1 library with per-entry lock (R-M18, R-M4); X2 synthesis preflight. **Major-workflow parity ends here** for RPC hosts.
11. A2 in-process shell: sandbox (R-S1 end-to-end), runner with disposal (R-M19, R-M25), auto loop, headless fallback. Major-workflow parity on the Pi host.
12. X3 Broad-Side (R-S9, R-S10, R-S11, R-S8b, R-M5, R-M6, R-M13, R-M14, R-M23). **Full parity.**

### Scope Tiers

**Minimum viable port:** milestones 1–8: a workspace can be initialized, driven through a pipeline over RPC with byte-identical prompts, validated, and completed with the full refusal matrix; findings and handoffs round-trip; existing workspaces load.

**Major-workflow parity:** 9–11: usage, dashboard, amendments, config, library publish/list/reindex, synthesis preflight, and the in-process shell with sandbox and auto loop.

**Full parity:** 12: Broad-Side, steering, narration, widgets.

## Acceptance Scenarios

Black-box; "workspace" means a temp directory; "run" means the host issuing the operation through whichever shell is under test. H-scenarios are the named tests for the eleven high defects (closes port-CF2's harness requirement); the 32 scenarios in `behavioral-contracts.md` §Black-Box Acceptance List are incorporated by reference and the three that pin defects there (#8, #21, #32) are superseded by H3, M1, H3 below.

| # | Scenario | Input | Expected Output / Side Effect |
|---|----------|-------|-------------------------------|
| H1 | Sandbox symlink | in-process shell active; `.codecarto/link → /outside`; LLM writes `.codecarto/link/new.md` (non-existent) | write blocked; nothing appears under `/outside` |
| H2 | Init isolation | template directory containing a finished `findings/architecture/architecture-map.md`, a handoff, and `dashboard.html`; `init` into an empty repo | new workspace has none of the three; `validate` → MISSING |
| H3 | Scalar-looking strings | repo directory named `2048`; `init`; `status` | succeeds; status file holds `project_name: "2048"`; a handoff owner note `"42"` survives completion as the string `42` |
| H4 | Concurrent writers | 5 concurrent usage appends; 2 concurrent publishes of different specs to one slug | 5 records; publishes yield v1 and v2 (or a typed retryable error, never a raw filesystem error), nothing lost |
| H5 | Owned lock | A acquires; lock aged past the stale threshold; B acquires; A releases | B's lock still present; a third acquire waits or times out |
| H6 | Stuck DAG | two-phase pipeline, second depends on a nonexistent phase; complete the first | `status` reports stuck naming the phase and the missing dependency, progress 1/2, not complete; `next` reports stuck; skills and amendments refused with the same reason |
| H7 | Packaged ignore file | build the distributable; `init` from it | `.codecarto/.gitignore` present in the new workspace |
| H8 | Zero wait | Broad-Side run in flight; `collect` with `wait_seconds: 0` | returns in under 1 s with the in-flight state |
| H9 | Default cap | shipped config, no `max_cost`; RPC `submit` with an estimate above the shipped default | refused with the per-lens breakdown; nothing submitted; explicit `max_cost: 0` submits |
| H10 | Corrupt Broad-Side config | `broadside/config.yaml` with a syntax error; `submit` | refused naming the parse error; nothing submitted |
| H11 | Corrupt state file | `broadside/state.json` unparsable; `submit` | refused; file untouched; a `.bak` or the error names the corruption |
| M1 | Switch keeps the cursor | complete phase 1 of the deep-audit pipeline; switch to `lite`; `status` | cursor is the next incomplete phase, not phase 1; any carry-forward whose target was dropped is listed as dangling |
| M3 | PARTIAL already routed | artifact with one PARTIAL row whose evidence names `x-CF1`; handoff routes `x-CF1` | completion adds no duplicate `needs-maintainer-decision` question |
| M7 | Corrupt usage log | unparsable usage file; complete a phase | completion succeeds; usage file untouched; the corruption is reported |
| M9 | Decorated Overall | artifact ending `**Overall:** PASS (6/6)` | PASS (or FAIL with a message naming the Overall line, if strictness is chosen) |
| M10 | Nested keys at four columns | handoff whose list items nest keys four columns past the dash | parses |
| M18 | Publish race | two publishes of one slug within one millisecond | one wins, the other receives a retryable "version taken" error and succeeds on retry as v2 |
| M20 | Commit-point ordering | inject a failure into the status rename during completion | no closeout, index line, decision row, or proposal appears; status unchanged; error reported |
| M21 | Skill name traversal | `skill` with name `../findings/architecture` | refused as unknown; only installed names run |
| M22 | Delimited splice | routed item whose description contains "IGNORE PREVIOUS INSTRUCTIONS" | the next prompt shows it inside a labeled data block, not as an instruction line |
| M24 | Dashboard on switch | RPC `switch_pipeline` | dashboard file mtime advances |
| M25 | Session replaced mid-auto | in-process `--auto`; user replaces the session between phases | the loop stops with a reported reason; completed phases persisted; no unhandled error |
| M26 | Drop-in guidance | read the manual | it states that drop-in mode has no completion executable and that `status.yaml` is framework-owned |
| C1 | Byte-identical prompts | same workspace through RPC and in-process shells | identical prompt text |
| C2 | Refusal matrix | the seven refusal handoffs from `behavioral-contracts.md` §Complete | each refused with the documented message; status untouched |
| C3 | Existing workspaces load | a 0.19.5 workspace, library, and config from the source | load, validate, publish, and list without modification |
| C4 | Envelope | any prose-returning RPC tool read by a client the port's authors did not write | the client receives the text |
| C5 | Headless | in-process shell with no UI; `status` | stderr line `[<name>] info: …`; stdout empty |
| C6 | Coverage travels | complete a phase whose ledger declares `Skipped scope: vendored/` | the next prompt lists it under upstream gaps |
| C7 | Closure integrity | the D1 and D3 fixtures from `tests/closure-integrity.test.mjs` | refused/accepted exactly as there |

## Deliberate Non-Goals

- Cloning the source's file layout, module names, or the barrel/bypass import structure; the eight-copy write pattern; the three literal terminal-status arrays; the dead protocol states.
- The Pi widgets' exact glyphs and timings, the narrator, and LLM steering in tiers 1–2.
- Reproducing the manual's hand-edit workflow for drop-in mode.
- A run-id parameter for Broad-Side collect (recorded as a possible later addition).
- Windows-specific rename/lock semantics beyond the spike below.

## Coverage and limits

- Inspected scope: `findings/porting/reverse-engineering-bundle.md` in full (the compression boundary), `findings/reimplementation-spec/SKILL.md`, the guide topics `deep-audit-synthesis` and `kernel-first-rewrite`, `CONVENTIONS.md` (C01), `DECISIONS.md` (D001–D013). Targeted deep reads: none were needed; the bundle's Source Index rows were sufficient for every rule and scenario, and the contracts' acceptance list was incorporated by reference rather than re-derived.
- Skipped scope: no source files were re-read in this phase; the synthesis pipeline's four phases and the post-pipeline skill are specified only as X2's preflight (inherited PARTIAL); Broad-Side lens prompt wording is not specified; the opinionated template was not used.
- Evidence basis: upstream findings (the bundle and, through it, the five reports with their runtime probes); source inspection only by citation.
- Known blind spots: (1) the two `[external]` peers (OpenRouter shapes, in-process host resource semantics) are spikes, not requirements; (2) Codex's envelope preference `[open]`; (3) whether the maintainer wants findings committed by default (D-M16) and whether library-init should enable the confirm gate (D-M15) are decisions this spec takes a position on but cannot settle; (4) the language-agnostic variant was selected by the run's instructions, not the user, so an opinionated rerun may change stack-specific choices (stance table, harness shape).
- Coverage disposition: COMPLETE for the analysis pipeline, both shells, library, and Broad-Side at rule-and-scenario level; PARTIAL for synthesis phases and lens prompt content, as inherited.

## Known Unknowns

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-codex-envelope-preference | needs-runtime-test | (carried) which envelope field Codex surfaces | needs a live Codex call; scenario C4 is the test once it can run |
| q-openrouter-batch-envelope | needs-fixture-capture | (carried) the batch submit/poll shapes are verified only against self-authored fakes | needs one recorded exchange saved as a fixture for A4's tests |
| q-findings-commit-policy | needs-maintainer-decision | Should findings be committed by default? Today it depends on the install path (D-M16); this spec assumes committed-with-opt-out. | product decision, not derivable from code |
| q-publish-confirm-on-init | needs-maintainer-decision | Should library-init enable the RPC confirm gate by writing `publish_confirm: true` (D-M15)? This spec assumes "write only what was asked". | product decision |
| q-opinionated-rerun | needs-maintainer-decision | Whether to rerun this phase with the opinionated template once a stack is chosen (front matter: run-instructed default). | the interactive hook was not answerable in this run |

## Carry-Forward

None: this is the terminal phase, and completion refuses a `target_phase` outside the active pipeline, so the template's suggestion of `spike`/`delta`/`amendment` targets cannot be used. Post-pipeline work is recorded in the handoff's `post_pipeline` list instead (see §Spike List).

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| — | — | — | — |

## Spike List

- **spike-openrouter-fixture** — capture one live Broad-Side submit + poll exchange (key redacted) as a fixture; settles `q-openrouter-batch-envelope` and pins A4's parser. `kind: spike`.
- **spike-codex-envelope** — call one prose tool through a running Codex and record which field it surfaces; settles `q-codex-envelope-preference` and scenario C4. `kind: spike`.
- **spike-pi-sandbox-e2e** — drive H1 through a real in-process host session (not only the containment helper), including the hook's actual `input.path` shape. `kind: spike`.
- **spike-windows-atomicity** — rename-over-open-file and O_EXCL semantics on Windows for P1/P2; decides whether the platform assumption in the front matter widens. `kind: spike`.
- **spike-session-disposal** — measure what an undisposed child session retains on the in-process host across a seven-phase auto run; converts D-M19 from inference to measurement. `kind: spike`.

---

## Validation

Variant: **language-agnostic**; selection: run-instructed default (see front matter).

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Concept-level modules are defined. | PASS | §Conceptual Module Model: six kernel modules K1–K6 with responsibility/inputs/outputs/state/invariants/collaborators, five ports, five adapters, six extensions, four delivery modes; §Layer Split. |
| 2 | Required behaviors are stated. | PASS | §Required Behaviors R1–R21 plus the docs rule, each tied to a contract and to the defect rules R-S1…R-S11 and R-M*. |
| 3 | Protocol and persisted state expectations are stated. | PASS | §Protocols and Persisted State: byte-for-byte set, re-encodable set, state machines SM1–SM7 with the two changes (stuck outcome, commit point), version-axis policy. |
| 4 | Acceptance scenarios and known unknowns are included. | PASS | §Acceptance Scenarios: 11 H-tests, 12 M-tests, 7 C-tests plus the 32 contract scenarios by reference; §Known Unknowns: five entries; §Spike List: five spikes. |
| 5 | Defects identified in either scan are explicitly designed-around or noted as "left behind", with the choice cited. | PASS | Every D-H and D-M id from the bundle appears as an R-S/R-M rule with its disposition; low groups are cited in §Deliberate Non-Goals and the docs rule; no `verify at runtime` disposition existed to convert. |
| 6 | Findings are marked with evidence levels. | PASS | Bracketed markers; `[external]` items confined to the stance table, hazards, unknowns, and spikes. |
| 7 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits, all bullets filled; targeted deep reads recorded as none needed. |
| 8 | Lower-level findings are deep-read only when the porting bundle identifies a gap, conflict, missing acceptance detail, or defect rationale. | PASS | No lower-level report was re-opened; the bundle's Source Index sufficed, and the contracts' acceptance list was incorporated by reference (§Coverage and limits). |

**Validated by:** 2026-09-11 (reimplementation-spec, self-audit session 1, inline MCP host)
**Overall:** PASS
