---
phase: reimplementation-spec
variant: language-agnostic
selection: auto-default
project: selfreview (CodeCartographer `codecartographer-pi` v0.25.0)
source_bundle: findings/porting/reverse-engineering-bundle.md
---

# Reimplementation Spec — CodeCartographer

> **Strategic-alignment record.** This phase ran under `/codecarto-next --auto`. The
> Strategic Alignment Hook was suppressed by the auto runner, so the spec defaults to the
> **language-agnostic** template (`templates/reimplementation-spec.md`) and is tagged
> `variant: language-agnostic` / `selection: auto-default` in the front-matter above. Every
> choice the hook would have asked the user for — target stack, project identity, and the
> optional-subsystem scope cut — is recorded as an `open_questions` entry of kind
> `needs-maintainer-decision` in §Known Unknowns and in the phase handoff, not silently
> assumed. A later opinionated re-run should use `templates/reimplementation-spec-opinionated.md`
> and lock those three choices before re-deriving this document.
>
> **Compression boundary.** This spec is written from
> `findings/porting/reverse-engineering-bundle.md` by default. It deep-reads an upstream
> report only where the bundle names a gap, a conflict, a missing acceptance detail, or a
> defect rationale. Four such deep reads were made and are listed in §Coverage and limits:
> `core/yaml.ts` (the seven YAML constraints — `cf-porting-1`),
> `core/status.ts:442-610` (the lock protocol — `cf-porting-2`),
> `core/utils.ts:1-120` (atomic write / containment primitives — defect rows 6.1 and 6.3),
> and `core/workspace.ts:422-465` + `core/library.ts:587-625,947-1001`
> (refresh and reindex lock scope — defect rows 3.3 and 3.4). A fifth read,
> `core/broadside/verify.ts:122-181`, was pulled in for defect row 4.1's rationale.

---

## System Summary

The system to reimplement is a **portable, phase-gated reverse-engineering and
specification-synthesis framework**. It installs as a `.codecarto/` directory inside a target
repository and walks a fixed pipeline of analysis phases
(`architecture → defect-scan-mechanical → contracts → protocols → defect-scan-semantic →
porting → reimplementation-spec`, plus seven other pipeline variants). Each phase writes a
templated, evidence-tagged Markdown artifact, validates itself against an exact Markdown
grammar, and hands its state to the next phase through a YAML handoff. A durable
`workflow/status.yaml` is the single source of truth for progress, open questions,
carry-forward routings, and post-pipeline work. A second pipeline performs forward synthesis:
it merges a user vision and human-confirmed library specifications into a provenance-backed
project plan.

The framework's defining property is that **its protocol is the product**. The phase gate,
the evidence vocabulary, and two wire formats (a constrained YAML dialect and a header-driven
Markdown artifact grammar) are the load-bearing interface; the executable surfaces are thin
adapters over one shared core. A reimplementation must preserve those contracts before it
preserves any organization. Concretely, three properties must survive the port unchanged:

1. **Byte-identical behavior across delivery surfaces.** Any two surfaces that drive the same
   workspace state must assemble identical phase prompts and return identical validation
   results (CONVENTIONS C01). This is a fidelity contract, not an optimization.
2. **Exact wire formats.** The workflow-file YAML dialect (seven observable constraints,
   §External Dependencies → *Document codec*) and the Markdown artifact grammar (exact
   headings, labels, and table columns) are parsed by header-driven readers that **fail
   silently** on mismatch (CONVENTIONS C04).
3. **A concurrency model with one serialized writer-class per state file.** The source's
   advisory-lock + atomic-rename design has a catalogued set of defects; the port must adopt
   the redesign named in §Required Behaviors → *Concurrency redesign* rather than reproduce
   the source's ordering logic (CONVENTIONS C05).

**Scope of this spec.** It is a build plan and acceptance spec for a *new implementation*,
not a patch queue for the source. The source's own defects are converted into **design
consequences** or **acceptance checks** (§Defect Design Consequences); the rows whose
diagnosis is unconfirmed (`verify at runtime`) become Spike List entries only, never built
assumptions.

---

## Conceptual Module Model

Names are concepts, not source paths. A source path is given once per module in parentheses
for provenance only; the port should not mirror the folder layout.

### Document Codec

| Field | Value |
|---|---|
| **Responsibility** | Read and write the workflow-file YAML dialect with its seven observable constraints. |
| **Public inputs** | YAML text (read); a value tree (write). |
| **Public outputs** | Parsed value tree with preserved key order; canonical YAML text. |
| **Owned state** | None (pure). |
| **Invariants** | Duplicate keys refused; `__proto__`/prototype-pollution guard applies in **mappings and sequence-item merges**; scalar round-trip quoting; explicit flow-collection policy; key order preserved; tab indentation and multi-document streams rejected; deterministic output for identical input. |
| **Collaborators** | Workspace State Store, Config Provider, Pipeline Engine (reads pipeline YAML), Completion Bookkeeper (handoffs), Library (metadata/index). |

### Filesystem Primitives

| Field | Value |
|---|---|
| **Responsibility** | Provide atomic replace, symlink-aware containment, and the advisory lock as one shared interface. |
| **Public inputs** | Target path, content; a path plus an allowed root; a lock path and a critical section. |
| **Public outputs** | Durable file replacement; a boolean containment verdict; an owned lock handle with `release()`. |
| **Owned state** | The lock files and temp files it creates; the state-file → lock mapping. |
| **Invariants** | A reader sees old or new bytes, never a torn file; containment fails closed; a lock is released only by its owner (compare-and-delete by token); a stale lock is broken only when the owner is provably not alive (§Concurrency redesign). |
| **Collaborators** | Every module that persists mutable state. |

### Workspace State Store

| Field | Value |
|---|---|
| **Responsibility** | Own the `status.yaml` schema, its normalization, and the handoff/amendment exchange. |
| **Public inputs** | Workspace directory; a parsed handoff or amendment object; completion/closure events. |
| **Public outputs** | Normalized status object; durable `status.yaml`; per-phase records; the pipeline cursor inputs. |
| **Owned state** | `workflow/status.yaml` (single source of truth); `scratch/handoffs/<phase>.yaml` (consumed once, retained). |
| **Invariants** | Exactly one writer-class takes the status lock; the commit point is a single atomic replace; a failed validation leaves no artifact claiming success (CONVENTIONS C02); a handoff is applied exactly once. |
| **Collaborators** | Document Codec, Pipeline Engine, Completion Bookkeeper, Filesystem Primitives. |

### Pipeline Engine

| Field | Value |
|---|---|
| **Responsibility** | Resolve the active pipeline DAG and the eligible/stuck/complete cursor, and parse the validation grammar. |
| **Public inputs** | Pipeline definition, status records, a phase output file. |
| **Public outputs** | Next eligible phase (or `stuck` / terminal); a validation verdict (`PASS`/`PASS WITH GAPS`/`FAIL`/`MISSING`). |
| **Owned state** | Pipeline alias table and cursor; none persisted beyond `status.yaml`. |
| **Invariants** | `stuck` is distinct from `complete`; the **last** `## Validation` heading and the **last** `**Overall:**` line win; an out-of-order forced phase warns but does not block. |
| **Collaborators** | Workspace State Store, Prompt Assembler, Coverage & Findings Gate. |

### Prompt Assembler

| Field | Value |
|---|---|
| **Responsibility** | Assemble the byte-identical phase/skill prompt text, including the orchestrator-duties block and quoted spliced text. |
| **Public inputs** | Phase id, pipeline definition, workspace state, spliced text (`«…»` quoting). |
| **Public outputs** | Prompt text (one canonical string per workspace state + phase). |
| **Owned state** | None (pure). |
| **Invariants** | Identical output on every surface for identical inputs (C01); fixed section order; spliced text is quoted as data, never executed. |
| **Collaborators** | Pipeline Engine, Workspace State Store, all delivery surfaces. |

### Completion Bookkeeper

| Field | Value |
|---|---|
| **Responsibility** | Apply a validated handoff under the status lock and write the post-commit artifacts idempotently. |
| **Public inputs** | Primary output path, handoff object, validation verdict. |
| **Public outputs** | Updated `status.yaml`; closeout file; one `THREAD_LOG.md` index line; `DECISIONS.md` rows; staged `CONVENTIONS.md` proposals; dashboard refresh. |
| **Owned state** | The commit point (`status.yaml` replace) and its `afterCommit` side effects. |
| **Invariants** | Refuse `FAIL`/`MISSING` validation; refuse a `needs-runtime-test` question closed without runtime evidence; closure-integrity gates (`target_phase`, `derives_from`, runtime-evidence) hold; every artifact is written **after** the rename and is idempotent (C02). |
| **Collaborators** | Workspace State Store, Filesystem Primitives, Coverage & Findings Gate, Dashboard Renderer, Config Provider. |

### Coverage & Findings Gate

| Field | Value |
|---|---|
| **Responsibility** | Enforce cross-phase honesty: coverage-ledger grammar, declared-secondary-output presence, and the evidence/action pairing gate. |
| **Public inputs** | A phase output's `## Coverage and limits` section; finding tables. |
| **Public outputs** | Parse results; pairing errors; presence verdicts. |
| **Owned state** | None. |
| **Invariants** | Five fixed coverage bullet labels; findings tables are read only when their header normalizes to include both `Evidence Level` and `Action`; an unsettled evidence level paired with a settled fix action is an error (C03). |
| **Collaborators** | Pipeline Engine, Completion Bookkeeper. |

### Usage Telemetry

| Field | Value |
|---|---|
| **Responsibility** | Append per-phase usage records and aggregate totals. |
| **Public inputs** | A usage record; a workspace. |
| **Public outputs** | Append-only usage log; totals/per-phase aggregates. |
| **Owned state** | The usage log (append-only). |
| **Invariants** | Appends happen under the usage lock; a corrupt log refuses further appends rather than silently truncating. |
| **Collaborators** | Filesystem Primitives, Dashboard Renderer. |

### Config Provider

| Field | Value |
|---|---|
| **Responsibility** | Resolve the orchestrator and library configuration layers with per-key fault isolation. |
| **Public inputs** | Workspace config file, user-global config file, defaults. |
| **Public outputs** | Effective config; a `problems` list. |
| **Owned state** | User-global config (shared across workspaces on the host). |
| **Invariants** | A non-empty `problems` list refuses publish/library operations; any mutation of the shared config takes the config lock and writes atomically (C05). |
| **Collaborators** | Document Codec, Filesystem Primitives, Library. |

### Dashboard Renderer

| Field | Value |
|---|---|
| **Responsibility** | Render a self-contained single-file HTML dashboard with an embedded JSON export. |
| **Public inputs** | Status, coverage, findings, usage, config. |
| **Public outputs** | `dashboard.html` bytes; a best-effort success/failure result. |
| **Owned state** | The generated HTML artifact (regenerable). |
| **Invariants** | Zero external assets; deterministic section order; a write failure is surfaced, never reported as success. |
| **Collaborators** | Workspace State Store, Usage Telemetry, Secret Redactor. |

### Versioned Library

| Field | Value |
|---|---|
| **Responsibility** | Publish, list, and read versioned reimplementation specs in an external library store. |
| **Public inputs** | A spec, metadata, a library root. |
| **Public outputs** | Immutable `entries/<ns>/<slug>/v<N>/` trees; a derived index (`index.yaml`, `INDEX.md`); a `latest` pointer. |
| **Owned state** | Library marker, entry trees, index, `latest` pointer. |
| **Invariants** | Exactly one publish lock guards **every** index writer (publish, reindex, and any list path that builds a missing index) — C05; content-hash idempotence; provenance and confidentiality guards run before any write; `latest` is a regular file. |
| **Collaborators** | Document Codec, Filesystem Primitives, Config Provider. |

### Secret Redactor

| Field | Value |
|---|---|
| **Responsibility** | Redact high-confidence secrets and classify secret-bearing files for every outbound payload. |
| **Public inputs** | Text or a file path. |
| **Public outputs** | Redacted text plus counts/kinds; a boolean secret-file verdict. |
| **Owned state** | None. |
| **Invariants** | One chokepoint: no outbound path may upload content that bypassed it (defect 4.1). Redaction is idempotent. |
| **Collaborators** | Provider Adapter, Dashboard Renderer. |

### Provider Adapter (Broad-Side)

| Field | Value |
|---|---|
| **Responsibility** | Run batch reconnaissance against a remote LLM provider: submit, poll, collect, verify, post-pass, render. |
| **Public inputs** | Lenses, repo slice, run config, provider API key. |
| **Public outputs** | Run findings, run state, rendered reconnaissance report. |
| **Owned state** | `state.json` run state and spending slots (claimed before spend, merged slot-by-slot). |
| **Invariants** | One outbound redaction chokepoint; slot claimed before any spend; a synthetic `timeout` is still claimable; provider assertions live behind one adapter with explicit fallbacks; the subsystem is advisory and optional. |
| **Collaborators** | Secret Redactor, Filesystem Primitives, Document Codec. |

### Synthesis Preflight · Guide Server

| Field | Value |
|---|---|
| **Responsibility** | Synthesize: resolve vision/library/proposal inputs and preflight guards for the forward pipeline. Guide: resolve packaged documentation topics. |
| **Public inputs** | Vision text, library specs, installed guide topics. |
| **Public outputs** | A merged plan's inputs; guide topic text. |
| **Owned state** | None durable beyond the synthesis artifacts the pipeline writes. |
| **Invariants** | Vision text is embedded verbatim; the guide needs no workspace; frontmatter is stripped. |
| **Collaborators** | Workspace State Store, Library, Document Codec. |

### Delivery Surfaces (one module each)

| Module | Responsibility | Public inputs / outputs | Owned state | Invariants | Collaborators |
|---|---|---|---|---|---|
| **CLI surface** | Drive the workflow from a terminal. | argv / stdout text, exit code. | None. | No prompt or validation text of its own (C01). | Core modules. |
| **MCP surface** | Expose the workflow as stdio JSON-RPC tools. | JSON-RPC requests / responses. | Transport lifetime only. | Path containment for `spec_path` fails closed; API-key resolution never logs the key. | Core modules, Filesystem Primitives. |
| **Pi surface** | Expose slash commands, phase sub-agents, and a live widget. | Slash-command invocations / widget + sub-agent lifecycle. | Session state only. | Write confinement to `.codecarto/` + configured library; sub-agent re-entry reserved before any `await`; mode derived from persisted state. | Core modules, Filesystem Primitives. |
| **Drop-in data template** | Ship the protocol as data with no executable code. | `.codecarto/` files / a working analysis pipeline by prompt alone. | The template directory. | No code; the pipeline definitions, skills, templates, and validation protocol are data. | None (consumed by an agent host). |

### Build / Distribution

| Field | Value |
|---|---|
| **Responsibility** | Compile, package, register the surfaces, and release. |
| **Public inputs** | Source, package metadata, release tag. |
| **Public outputs** | Build output, a distributable package, registered commands/tools. |
| **Owned state** | Package version marker and tarball exclusions. |
| **Invariants** | The packaged `.codecarto/` template and skills ship byte-identical to the checkout; project state and user-owned files are excluded. |
| **Collaborators** | All modules. |

---

## Layer Split

| Module | Layer | Notes |
|---|---|---|
| Document Codec | core semantics | Wire format; no platform or surface dependency. |
| Filesystem Primitives | core semantics | Atomic replace, containment, and the lock protocol; platform-sensitive seam (spike-gated). |
| Workspace State Store | core semantics | `status.yaml` schema and handoff/amendment state machine. |
| Pipeline Engine | core semantics | DAG walk + validation grammar. |
| Prompt Assembler | core semantics | Byte-identical prompt text (C01). |
| Completion Bookkeeper | core semantics | Commit point + idempotent post-commit writers (C02). |
| Coverage & Findings Gate | core semantics | Cross-phase honesty gates. |
| Secret Redactor | core semantics | Trust boundary; pure. |
| Usage Telemetry | core semantics | Observability; never correctness-bearing. |
| Config Provider | core semantics | Layered config; shared-file mutation is locked (C05). |
| Synthesis Preflight | core semantics | Forward-pipeline control. |
| Guide Server | core semantics | Packaged docs. |
| Dashboard Renderer | adapters | Generated artifact; host-agnostic but optional. |
| Versioned Library | adapters | External storage; index writer must take the publish lock (C05). |
| Provider Adapter (Broad-Side) | adapters | Remote network integration; optional, advisory. |
| MCP surface | delivery surfaces | Thin JSON-RPC adapter. |
| Pi surface | delivery surfaces | Thin slash-command/sub-agent adapter. |
| CLI surface | delivery surfaces | New thin adapter (the port's default executable). |
| Drop-in data template | delivery surfaces | Pure data; works with no executable surface at all. |
| Build / Distribution | delivery surfaces | Packaging and registration. |

**Dependency direction (required).** `core semantics` never imports an adapter or a delivery
surface. Adapters may import core; surfaces may import core and adapters. The source graph
contains one cycle (`core/index` ↔ `core/dashboard-writer`) and one backward edge
(`core/broadside/state` → `core/broadside/client`) that resolve only because imported
bindings are dereferenced at call time; the port must produce an **acyclic** graph and must
never read a cross-module constant at module top level (defect rows 1.1 and L1).

---

## Required Behaviors

Behaviors are grouped by concern. `[core]` marks behavior required for the system to function;
`[important]` for major-workflow parity; `[optional]` for full parity. Defect ids reference
§Defect Design Consequences.

### Pipeline and phase control `[core]`

1. Resolve the active pipeline from a named alias; treat a missing pipeline file as a stop
   condition, not a fallback.
2. Walk the DAG in `phase_order`; pick the first phase whose status is not `complete` and whose
   `depends_on` are all complete. `stuck` (an eligible phase exists but cannot run) is a
   distinct, reportable outcome from `complete`.
3. Parse a phase output's validation verdict from the **last** `## Validation` heading and the
   **last** `**Overall:**` line; accept `PASS`, `PASS WITH GAPS`, `FAIL`, `MISSING`; a verdict
   the parser cannot read as `PASS*`/`FAIL` is a failure.
4. Refuse to complete a phase whose validation is `FAIL` or `MISSING`.
5. Emit an out-of-order "forced phase" prompt with a warning line when `depends_on` is unmet;
   warn, do not block.
6. Preserve shared phase records across a pipeline switch, drop old-only records, and move
   dangling carry-forward entries (or retire them with a named reason).

### Prompt fidelity `[core]`

7. Assemble one canonical prompt per `(workspace state, phase)` and return it unchanged on
   every delivery surface (C01). Surface-specific labels are the only permitted divergence.
8. Quote any spliced earlier-session or library text as data (`«…»`); never interpret it.

### State, handoff, and completion `[core]`

9. Persist `status.yaml` with the field-by-field schema in §Protocols and Persisted State,
   normalized on read so malformed/partial files recover to a valid shape.
10. Validate a handoff before taking the lock; apply it under the lock; write every
    "phase complete" artifact only **after** the `status.yaml` replace (C02).
11. Make post-commit writers idempotent: canonical closeout filename, link-deduped
    `THREAD_LOG` line, text-deduped `DECISIONS` row, text-deduped `CONVENTIONS` proposal.
12. Enforce closure integrity: a `carry_forward.target_phase` must name a later pipeline phase;
    a `derives_from` link may close only when its question is closed by the same handoff; a
    `needs-runtime-test` question closes only with non-empty runtime evidence.
13. Support post-pipeline **amendments**: complete-only under the lock, idempotent closures,
    no runtime-evidence gate (that gate belongs to completion).

### Coverage and findings gates `[core]`

14. Parse the five fixed `## Coverage and limits` bullets and report which are missing.
15. Read findings tables only when the header includes both `Evidence Level` and `Action`;
    raise a pairing error when an unsettled evidence level carries a settled fix action (C03).
16. Verify declared secondary outputs exist; never let a phase declare a secondary it did not
    write without an explicit coverage note.

### Configuration `[important]`

17. Resolve config as two layers (workspace then user-global) with per-key fault isolation; a
    malformed key reports a `problem` rather than failing the whole file.
18. Refuse publish/library operations while `problems` is non-empty.
19. Mutate the shared user-global config only under the config lock and through the atomic
    primitive (defect L8 / C05).

### Scaffold and workspace lifecycle `[important]`

20. Initialize a workspace by a **filtered** copy of the template: exclude project state,
    user config, session outputs, and user-owned top-level files. Seed the orchestrator state.
21. Open an existing workspace read-only; report scaffold staleness against the packaged
    version; never write on open.
22. Refresh the scaffold by a **staged, atomic** copy under the scaffold lock: stage the new
    files, commit them atomically, and roll back on failure so a mid-refresh crash never leaves
    a mixed-version scaffold (defect 2.2). Serialize the `THREAD_LOG` append under the same
    lock and dedupe it per refresh event (defects 3.3, L12 / C02).
23. Refresh must overwrite only framework-owned paths; leave unknown and user-owned files in
    place.

### Concurrency redesign (required design elements) `[core]`

This is the concrete form of `cf-porting-2`'s concurrency half and the writer-side companion
to C02. The port must implement it as a first-class protocol, not reproduce the source's
fixed-age mtime lock.

24. **State-file → lock mapping is explicit and total.** Every mutable persisted file names its
    lock: `status.yaml` (and the pipeline files and `THREAD_LOG` written by refresh) → status/
    scaffold lock; the library index, metadata, `latest`, and marker → publish lock; user-global
    config → config lock; the Broad-Side run state and spending slots → run/state lock; the
    usage log → usage lock. A lock that excludes only one writer-class of a file serializes
    nothing (C05).
25. **Owner-liveness, not fixed TTL.** Acquire creates the lock file atomically and writes a
    holder descriptor `{pid, host, acquiredAt, token}`. A waiter may break a lock only when the
    holder is **provably not alive** — same-host pid no longer running, or a lease/heartbeat
    whose mtime the holder refreshes at an interval well below the lease TTL. Never break a
    lock on age alone (defect 3.2).
26. **Compare-and-delete removal.** A stale-break first claims a removal token atomically
    (a `.break` file created with an exclusive create), then re-reads the lock descriptor and
    removes the lock only if the identity (token/inode) is unchanged, immediately before the
    unlink. Release removes the lock only when it still carries the releasing holder's token.
27. **Close the remover-vs-acquirer window.** The removal claim alone is not sufficient if a
    fresh acquirer can create the main lock while a remover is between its staleness check and
    its unlink. The port must ensure the identity guard is re-evaluated at the unlink (25/26)
    **and** that a fresh holder can never be deleted: either acquisitions also respect the
    removal claim, or the removal is a compare-and-delete whose token check is atomic with the
    unlink. (This is the residual of defect 3.1; see §Coverage and limits for the measured
    source state.)
28. **One writer-class per state file.** Document the writer classes per file and require every
    writer — including derived-artifact writers and readers that "may repair" a fault — to take
    the state's lock. Derived data being regenerable does not make a lost update harmless when
    the artifact is the user-facing lookup (defects 3.3, 3.4, L8, L13 / C05).
29. **Locks are neither re-entrant nor fair in the source.** Design re-entrancy and waiter
    ordering deliberately and document both.

### Atomic durability and containment `[core, spike-gated]`

30. Provide one atomic-replace primitive (`write` temp sibling → `rename` over target; remove
    the temp on failure). Keep a **non-atomic fallback seam** (lock + unlink + rename, or a
    direct write under the lock) because POSIX `rename`-over-existing is not guaranteed on
    every target OS (defect 6.1 — `verify at runtime`).
31. Provide one symlink-aware containment primitive: resolve the existing prefix of a path
    through symlinks, resolve the root through `realpath`, compare lexically, and fail closed
    on a platform-specific case/8.3/junction hazard (defect 6.3 — `verify at runtime`). Prefer
    reading through a canonical handle over re-checking a path (defect L9 —
    `verify at runtime`).

### Trust boundary and security `[core]`

32. Route **every** outbound payload through one redaction chokepoint. The reconnaissance
    `verify` tool loop must not be a second upload path that bypasses redaction (defect 4.1).
33. Classify secret-bearing files and exclude them from any outbound slice.
34. Confine host-supplied paths: an MCP `spec_path` must resolve inside an allowed root and
    fail closed; a Pi `tool_call` that would write outside `.codecarto/` (plus the configured
    library) is blocked; `bash` is blocked. The parent and child session scopes must share
    **one** guard policy (defect L11).
35. Derive the orchestrator guard's active mode from persisted workspace state (presence of a
    workspace), not from session-scoped state that resets on reload (defect L7).
36. Reserve a sub-agent's phase slot **before** any `await` in its prelude so two quick runs
    cannot spawn duplicate sub-agents for one phase (defect L10).

### Library `[optional]`

37. Publish under one publish lock: guards (slug, namespace, provenance, confidentiality,
    content-hash idempotence) run before any write; versions are immutable; `latest` is a
    regular file.
38. Every writer of the derived index — the standalone reindex and any list path that builds a
    missing index — takes the publish lock (defect 3.4 / C05).
39. Keep read commands read-only: a corrupt existing `index.yaml` is reported, not silently
    rewritten (defect L13).

### Dashboard artifact `[important]`

40. Render a deterministic, self-contained single-file HTML dashboard with an embedded JSON
    export and zero external assets.
41. Surface the write's best-effort result; never report a swallowed failure as success
    (defect L4).

### Broad-Side reconnaissance `[optional]`

42. Implement submit / poll / collect / status / models / verify with a single provider adapter;
    keep provider assertions (batch-id catalog membership, concurrency quota, reasoning
    acceptance) behind it with explicit fallbacks (`verify at runtime`,
    `q-openrouter-batch-semantics`).
43. Claim a spending slot before any spend; merge slots slot-by-slot; a synthetic `timeout` is
    still claimable.
44. Use one size unit (bytes) for slicing; content-addressed or monotonic run ids; one
    fence-tolerant JSON parser for model responses; and explicit error capture on every submit
    path, including retries (defect L3).

### Operational constants `[core]`

45. Expose operational timeouts and budgets (git timeout, HTTP timeouts, poll budget/interval)
    as overridable configuration with documented defaults (defect L5).

### Drop-in data template `[core]`

46. Ship the pipeline definitions, skills, templates, and validation protocol as data such that
    an agent host can run the workflow with **no executable surface installed**.

---

## Protocols and Persisted State

Full field-by-field schemas live in `findings/protocols/protocols-and-state.md` (P1–P17,
SM1–SM7, §Persistent Schema Notes) and the `state-and-storage` secondary. The port must
preserve the following. `verify at runtime` marks platform-sensitive durability claims (C03).

### Wire formats (must be reproduced verbatim)

- **YAML dialect (P16).** Seven constraints; see §External Dependencies → *Document codec*.
  Every workflow file is parsed by the same codec: `status.yaml`, handoffs, amendments,
  pipeline definitions, config, library metadata and index.
- **Markdown artifact grammar (C04).** Exact headings `## Validation`, `## Coverage and
  limits`, `## Pass N`; the `**Overall:**` line; the five fixed coverage bullet labels
  (`Inspected scope`, `Skipped scope`, `Evidence basis`, `Known blind spots`,
  `Coverage disposition`); finding-table headers containing both `Evidence Level` and `Action`;
  and `## Completion log` / `## Pending proposals` as their own exact lines. These parsers
  **fail silently** on a renamed heading or column: the port must copy the shapes and pin each
  parser with a known-good fixture.

### State machines

- **SM1 Pipeline cursor.** `eligible` / `stuck` / `complete` — three outcomes, not two.
- **SM2 Phase completion.** `validate → re-validate under lock → apply handoff → atomic rename
  (the commit point) → idempotent afterCommit writers`. The commit point is the `status.yaml`
  replace; closure-integrity gates should be re-run under the lock or the narrow TOCTOU
  deliberately documented (defect L6).
- **SM3 Advisory lock.** Redesign as in §Required Behaviors 24–29.
- **SM4 Broad-Side run + spending slots.** Claim-before-spend; merge slot-by-slot.
- **SM5 Library publish.** guards → content-hash branch → stage → rename → pointer → reindex.
- **SM6 Amendment.** complete-only on the locked read; idempotent.
- **SM7 Pi sub-agent/auto loop.** Reserve the phase slot before the async prelude.

### Persistence classes

- **Mutable-in-place, atomic:** `status.yaml`, usage log, Broad-Side `state.json`, library
  `metadata.yaml`/`index.yaml`/`latest`/marker, dashboard, checkpoint. Each is `verify at
  runtime` on non-POSIX atomic-replace semantics.
- **Append-only:** usage runs; `THREAD_LOG` lines (link-deduped); `DECISIONS` rows
  (text-deduped); `CONVENTIONS` proposals (text-deduped).
- **Derived/regenerable:** `index.yaml`, `INDEX.md`, `dashboard.html`, run-meta, catalog cache.
  Derived status does not exempt a writer from the state lock (C05).

`status.yaml` is the single source of truth; a handoff is consumed once but retained.

---

## External Dependencies

| Dependency | Stance | Rationale |
|---|---|---|
| YAML parser/emitter for the workflow dialect | **reproduce** (recommended) or **wrap + adapter** | A bare default library diverges on duplicate keys, coercion, flow collections, and anchors. See *Document codec* below — this closes `cf-porting-1`. |
| Target-language standard library (filesystem, process, crypto) | **wrap** | Route all atomic writes, containment, and locking through one primitive so the platform seam is single and spike-gated (6.1/6.3). |
| Remote LLM provider (batch + chat completions) | **wrap** | Keep quota/batch-id/reasoning assertions behind one adapter with fallbacks; remote contract is unverified (`q-openrouter-batch-semantics`). |
| `git` subprocess | **wrap** | Detect presence and output shape; keep the existing walk fallback; `verify at runtime` on non-POSIX (6.4). |
| Agent host SDK (phase sub-agent lifecycle) | **replace** per target | The source's Pi SDK lifecycle (sandbox, compaction, session persistence) is one host's contract; a port adapts its own (parity unverified — `q-pi-sdk-execution-parity`). |
| MCP transport / JSON-RPC SDK | **wrap** or **replace** | The wire contract is stdio JSON-RPC; any compliant transport is acceptable. |
| TypeBox-style runtime schema validation | **replace** | Use the target stack's schema facility; the contract is the validated shape, not the library. |
| Build toolchain (`tsc` + npm) | **replace** | Packaging is stack-specific; the invariant is byte-identical template/skill shipping. |
| ANSI/TUI widget primitives | **postpone** | Pi-only ergonomics; not part of core semantics. |
| Terminal browser/dashboard hosting | **postpone** | The dashboard is a static artifact; no server. |

### Document codec — the `cf-porting-1` closure

`cf-protocols-1` fixed the seven behavioral constraints; `cf-porting-1` fixes the **selection
policy** for a target stack, since this spec is language-agnostic.

**Recommendation (default): reproduce a small, explicit codec.** The dialect's surface is
small (mappings, sequences, scalars, block scalars) and reproducing it is the only way to
guarantee all seven constraints with no adapter and no new runtime dependency. The port
writes ~200–400 lines and pins them with ported round-trip/coercion tests (the source `tests/`
already pins the dialect, so those cases are the test corpus).

**Acceptable alternative: wrap a mature YAML parser in an adapter that re-imposes the
contracts.** The adapter is mandatory; it must add all of the following, and each is a test:

| # | Constraint | Adapter obligation |
|---|---|---|
| 1 | Duplicate keys refused | Configure duplicate-key rejection (or pre-scan and reject); never last-wins. |
| 2 | No prototype pollution | Guard `__proto__`/prototype keys uniformly in **mappings and sequence-item merges**; build parsed mappings as null-prototype maps or assign via a guarded setter — never a plain assign of a parsed key (defect L2). |
| 3 | Scalar round-trip quoting | On write, emit a string bare only if the reader returns the identical string; quote numeric-, boolean-, `null`-looking strings, the empty string, and a lone `-`. |
| 4 | Flow-collection policy | State the policy explicitly: either reproduce the source's coerce/reject behavior or document the deliberate divergence; never silently change hand-edit tolerance. |
| 5 | Key order preserved | Use an ordered map; preserve insertion order on write. |
| 6 | Tab/multi-document errors | Reject tab indentation and multi-document streams with a named error. |
| 7 | Determinism | Identical bytes in → identical structure out; stable serialization out. |

**Illustrative per-ecosystem candidates** (a decision aid, not a lock — the concrete pick is
`q-yaml-codec-library-choice`):

| Ecosystem | Candidate | Adapter must add |
|---|---|---|
| TypeScript/JavaScript | the source codec itself, or `yaml` (eemeli) with `uniqueKeys` + custom tags | quoting emitter, `__proto__` guard, flow policy |
| Python | `ruamel.yaml` round-trip mode (`allow_duplicate_keys=False`) | flow policy, quoting emitter |
| Go | `gopkg.in/yaml.v3` (ordered via `yaml.Node`, duplicate keys error) | quoting emitter, flow policy |
| Rust | `yaml-rust2` / `serde_yaml` with an ordered map | duplicate refusal, quoting emitter, flow policy |
| Ruby | `Psych.safe_load` with `aliases: false` | duplicate refusal, quoting emitter, flow policy |

**Non-negotiable:** substituting a full library with default settings is **not a port of this
dialect**. Default duplicate-key, scalar-coercion, flow-collection, and anchor/alias behavior
all diverge, and every workflow file is a wire format parsed by the same codec (C04).

---

## Portability Hazards

"verify at runtime" rows are `external-behavior claim`s per C03 and must not be flattened into
a settled design decision.

| Hazard | Impact | Mitigation / Design consequence |
|---|---|---|
| POSIX `rename` over an existing destination (6.1) | high — every canonical write assumes it | One atomic-replace primitive with a non-atomic fallback seam; spike-test on the target OS before any state write depends on it. |
| `O_EXCL` + mtime staleness (6.2) | medium — mutual exclusion assumes POSIX sharing | Owner-liveness lock; do not reproduce the fixed-TTL break; spike claim semantics on the target. |
| Symlink/case-aware containment (6.3, L9) | medium — junctions, 8.3 names, drive-relative paths | One containment primitive; prefer canonical-handle reads; spike on the target. |
| Bare `git` + POSIX-shaped output (6.4) | medium — provenance/scan set change | Detect and degrade explicitly; keep the walk fallback; spike `\0`/`\n` and `/` parsing. |
| Hand-rolled YAML subset (P16) | medium — flow collections, tabs, duplicate-key and coercion semantics | Reproduce the codec or wrap + re-impose the seven constraints; pin with round-trip tests (`cf-porting-1`). |
| `__proto__` gap in sequence merge (L2) | low — one path bypasses the parser's guard | One uniform guard; never plain-assign parsed keys. |
| OpenRouter Batch remote semantics | high — quota, batch-id membership, reasoning asserted not verified | `verify at runtime`; one provider adapter with explicit fallbacks. |
| Host `fetch` / timeout primitives | medium — runtime-provided | Provide a shim in a target lacking them. |
| Stream end/close detection (P2) | low — SDK transport may never see end | Reimplement lifetime abort on the target's stream API. |
| Locks neither re-entrant nor fair (P17) | low — second waiter blocks | Design re-entrancy/queuing deliberately (Required Behavior 29). |
| ANSI/TUI assumptions | low — Pi-only | Omit from non-Pi ports. |
| ISO timestamps / millisecond run ids (L3) | low — same-millisecond collision | Content-addressed or monotonic ids. |
| Byte-size vs code-unit slicing (L3) | low — non-ASCII off-by-content | One size unit everywhere. |
| Heuristic redaction; `verify` bypass (4.1) | medium — outbound uploads | One outbound chokepoint; never ship a second upload path. |
| HTML link-escaping boundary | low — percent-encoding rejects absolute/`..` | Preserve the encoding; removing it reopens Windows traversal. |
| Fixed lock death (3.2) | medium — breaks a legitimately held lock | Owner-liveness/heartbeat instead of mtime age. |
| Check-then-act windows (3.5, L6, L9) | low–medium | Reserve before await; re-check under lock; prefer handles to paths. |

---

## Implementation Sequence

Build in the dependency order the porting bundle fixes; each step is independently testable.

1. **Document codec** — the seven constraints + round-trip/coercion tests (the first thing to
   pin; every later module round-trips through it).
2. **Filesystem primitives** — atomic replace with a fallback seam, containment, owner-liveness
   lock, compare-and-delete removal, the state-file → lock map.
3. **Workspace state store** — `status.yaml` schema, normalization, handoff/amendment parse and
   apply, the under-lock commit point.
4. **Pipeline engine** — alias table, DAG walk, `eligible`/`stuck`/`complete`, validation grammar.
5. **Prompt assembler** — canonical prompt text + spliced-text quoting.
6. **Completion bookkeeper** — closure gates, `afterCommit`, idempotent artifact writers.
7. **Coverage & findings gate** — coverage bullets, pairing gate, secondary-presence check.
8. **Config provider** — two layers, fault isolation, locked shared-config mutation.
9. **Secret redactor + one outbound chokepoint.**
10. **Usage telemetry and dashboard renderer.**
11. **Workspace lifecycle** — init, open/status, staged atomic refresh.
12. **Library** — publish/reindex/list under one lock; index ABI.
13. **One delivery surface** (CLI), then **MCP**, then **Pi**, then the **drop-in data template**
    verification.
14. **Provider adapter (Broad-Side)** — last, and only if in scope; behind the redaction
    chokepoint and the provider adapter fallbacks.
15. **Synthesis preflight + guide server.**
16. **Build/packaging/release** — byte-identical template and skill shipping.

### Scope Tiers

**Minimum viable port.** Document codec; filesystem primitives with the redesigned lock;
workspace state store; pipeline engine; prompt assembler; completion bookkeeper; coverage &
findings gate; workspace init/open; one delivery surface (CLI); the drop-in `.codecarto/` data
template. This is a usable, byte-compatible workflow engine for the analysis and synthesis
pipelines. **Postponed:** dashboard renderer, config provider (defaults only), usage telemetry,
versioned library, provider adapter (Broad-Side), Pi UI, guide server, synthesis preflight.

**Major-workflow parity.** Adds the dashboard artifact, the config provider with per-key fault
isolation, staged scaffold refresh, amendments, skill/guide resolution, usage telemetry, and a
second delivery surface (MCP or Pi). At this tier the system covers the primary use cases end
to end.

**Full parity.** Adds the versioned library, the Broad-Side provider adapter, the Pi UI
specifics (widget, live auto-loop, LLM-steer), the synthesis pipeline, and every delivery
surface. `cf-porting-2`'s scope cut is stated here: the **optional subsystems** (Broad-Side,
versioned library, dashboard, Pi UI) are each independently shippable; the spec does not
require them for a working port, and the maintainer may cut any of them (`q-scope-cut`).

---

## Defect Design Consequences

Every defect in the porting bundle's §Defect Synthesis is converted into an explicit design
consequence or acceptance check here. `verify at runtime` rows are **not** converted — they
become Spike List entries only (the diagnosis is unconfirmed; building around it would bake an
unverified claim into the new system). No finding is `leave behind`, so no row is marked as
such; that is stated for completeness.

| Defect | Disposition | Design consequence / acceptance check |
|---|---|---|
| 6.1 `atomicWriteFile` no fallback (high) | verify at runtime | Spike: test atomic replace on the target OS before any state write depends on it. Design a fallback seam (Required Behavior 30). |
| 1.1 module cycle (medium) | port differently | Acyclic module graph; hoist shared symbols down; assert acyclicity + no top-level cross-module constant (Required Behaviors 24/§Layer Split). |
| 2.2 refresh no rollback (medium) | port differently | Staged, atomic scaffold refresh with rollback (Required Behavior 22). |
| 6.2 POSIX lock claim (medium) | verify at runtime | Spike: lock claim semantics on the target. Prefer owner-liveness protocol (Required Behavior 25). |
| 6.3 containment (medium) | verify at runtime | Spike: junctions/8.3/drive-relative containment on the target (Required Behavior 31). |
| 6.4 bare `git` (medium) | verify at runtime | Spike: `git` presence + output shape on the target (External Dependencies). |
| 3.1 removal-lock race (medium) | fix before porting | Owner-liveness + compare-and-delete + close the remover-vs-acquirer window (Required Behaviors 25–27); acceptance scenario 24. |
| 3.2 fixed-TTL stale break (medium) | fix before porting | No age-alone break; lease/heartbeat (Required Behavior 25); acceptance scenario 25. |
| 3.3 refresh lock scope (medium) | fix before porting | Scaffold lock + atomic write + serialized, deduped `THREAD_LOG` (Required Behavior 22 / C05); acceptance scenario 26. |
| 3.4 unlocked derived-index writers (medium) | fix before porting | Every index writer takes the publish lock (Required Behavior 38 / C05); acceptance scenario 30. |
| 4.1 `verify` redaction bypass (medium) | fix before porting | Single outbound redaction chokepoint (Required Behavior 32); acceptance scenario 33. |
| L1 (1.2) dependency direction | port differently | Enforce dependency direction; no top-level cross-module constant (1.1 row). |
| L2 (1.3) YAML `__proto__` gap | port differently | Uniform guard in mappings and sequence merges (Document codec constraint 2); acceptance scenario 2. |
| L3 (1.4/1.5/1.6/2.3) Broad-Side robustness | port differently | One size unit, monotonic/content-addressed run ids, fence-tolerant JSON, explicit retry error capture (Required Behavior 44). |
| L4 (2.1) dashboard result ignored | fix before porting | Surface the best-effort result (Required Behavior 41); acceptance scenario 31. |
| L5 (6.5) hardcoded constants | port differently | Configurable timeouts/budgets (Required Behavior 45); acceptance scenario 32. |
| L6 (3.6) pre-lock closure checks | port differently | Re-run closure gates under the lock, or document the deliberate TOCTOU (SM2). |
| L7 (4.2) mode-guard reset | port differently | Derive guard mode from persisted workspace state (Required Behavior 35). |
| L8 (3.7) unlocked config RMW | fix before porting | Config lock + atomic write (Required Behavior 19 / C05); acceptance scenario 29. |
| L9 (4.3) containment check-then-use | verify at runtime | Spike symlink-swap timing; prefer canonical-handle reads (Required Behavior 31). |
| L10 (3.5) re-entry check-then-act | fix before porting | Reserve the phase slot before any await (Required Behavior 36); acceptance scenario 28. |
| L11 (5.1) child-guard divergence | port differently | One shared guard policy for parent and child scopes (Required Behavior 34). |
| L12 (5.2) `THREAD_LOG` non-idempotence | fix before porting | Dedupe the refresh entry per event (Required Behavior 22 / C02); acceptance scenario 26. |
| L13 (5.3) `listEntries` rewrite | port differently | Read commands are read-only; corrupt index reported, not rewritten (Required Behavior 39). |

---

## Acceptance Scenarios

Black-box checks. Inputs are concrete; outputs and side effects are observable. No assertion
depends on an internal file name, class, or source-language idiom beyond the wire formats that
**are** the interface.

| # | Scenario | Input | Expected Output / Side Effect |
|---|---|---|---|
| 1 | Duplicate-key refusal | `a: 1\na: 2\n` | Read fails with a named duplicate-key error; no value is returned. |
| 2 | Prototype-pollution guard (mappings) | `__proto__: {polluted: true}\n` | The parsed tree has an own `__proto__` entry (or rejects it); `({}).polluted` is undefined after parsing. |
| 3 | Prototype-pollution guard (sequence merge) | `items:\n  - __proto__: {polluted: true}\n    id: 1\n` | No prototype mutation; the item carries the parsed entries only. |
| 4 | Scalar round-trip quoting | Write and re-read `"2048"`, `"true"`, `"null"`, `"1.5"`, `"-"`, `""` | Every value round-trips as the same string type and bytes. |
| 5 | Flow-collection policy | `list: [a, b]` where a sequence is expected | Policy-documented outcome (reproduced coercion/rejection or an explicit, documented divergence); never silent wrong-type. |
| 6 | Tab indentation rejected | `\tkey: v\n` | Named tab-indentation error. |
| 7 | Multi-document rejected | `a: 1\n---\nb: 2\n` | Named multi-document error. |
| 8 | Key order preserved | Write `{b:2, a:1}` then read | Serialized order is `b` then `a`; read preserves it. |
| 9 | Determinism | Serialize the same value tree twice | Byte-identical output. |
| 10 | Pipeline cursor outcomes | A pipeline with an eligible phase; one with unmet deps and no eligible phase; one fully complete | Reports eligible / `stuck` / `complete` as three distinct outcomes. |
| 11 | Validation grammar | A phase output with two `## Validation` sections | The **last** section's last `**Overall:**` line wins. |
| 12 | Unreadable verdict | A validation block whose `**Overall:**` line is `Green` | Treated as unreadable/failure; not completed. |
| 13 | Complete refuses `FAIL` | A primary output with `Overall: FAIL` | Completion refused; `status.yaml` unchanged. |
| 14 | Forced out-of-order phase | Force a phase whose deps are unmet | Prompt includes the warning line; run proceeds. |
| 15 | Pipeline switch | Switch to a variant sharing some phases | Shared records preserved; old-only dropped; dangling carry-forwards moved or retired with a reason. |
| 16 | Commit point + idempotence | Complete a phase; re-run completion | `status.yaml` updated once; closeout/`THREAD_LOG`/decisions/proposals regenerated, not duplicated. |
| 17 | Runtime-evidence gate | Close a `needs-runtime-test` question with empty evidence | Closure refused. |
| 18 | `derives_from` gate | Close a carry-forward whose `derives_from` question is still open | Closure refused, naming both ids. |
| 19 | Coverage bullets | A `## Coverage and limits` section missing `Known blind spots` | Gate reports the missing label. |
| 20 | Findings pairing gate | A finding row with `external-behavior claim` + `fix before porting` | Pairing error raised. |
| 21 | Declared secondary presence | A phase declaring a secondary it did not write | Presence verdict fails unless a coverage note explains it. |
| 22 | Config fault isolation | A config file with one malformed key | The bad key reports a `problem`; other keys resolve; publish/library refused while `problems` non-empty. |
| 23 | Init isolation | Init a workspace | Project state/user config/session outputs excluded from the copy; orchestrator state seeded. |
| 24 | Lock: two waiters break a stale lock | Two processes race on one lock with a pre-planted stale lock; assert exactly one holds at all times and no fresh lock is ever deleted | Serialization holds; no lock owned by a live process is removed. |
| 25 | Lock: long-held lock not broken | Process A holds a lock beyond the source's old 60 s; B calls acquire | B does not break A's lock while A is alive; B waits or times out per policy. |
| 26 | Scaffold refresh atomicity + dedupe | Refresh twice; inject a mid-refresh failure | No mixed-version scaffold after the failure; `THREAD_LOG` has one line per refresh event, not two. |
| 27 | Refresh preserves user files | Refresh a workspace with hand-edited `BACKLOG.md` and `CONVENTIONS.md` | User-owned files unchanged; framework files updated. |
| 28 | Sub-agent re-entry | Fire two runs of one phase back to back | Exactly one sub-agent is registered/spawned for that phase. |
| 29 | Config RMW atomicity | Two concurrent config mutations | Both survive (or the second sees the first's write); the file is never truncated. |
| 30 | Reindex vs publish | Run standalone reindex concurrently with a publish | Final `index.yaml` names the newly published version. |
| 31 | Dashboard best-effort surfacing | Force a dashboard write failure | Command reports failure; does not report success. |
| 32 | Configurable timeouts | Override a timeout via config | The override takes effect; the default is documented. |
| 33 | One redaction chokepoint | Run the reconnaissance `verify` tool loop over a file containing a planted secret | The outbound payload contains `[REDACTED:…]`, not the secret. |
| 34 | Containment fails closed | Request a path outside the allowed root (including via symlink) | Rejected; no read or write occurs. |
| 35 | Pi write confinement | A `tool_call` writing outside `.codecarto/` | Blocked; no file created. |
| 36 | Guard mode after reload | Reload the session with a workspace present | Confinement/block remain active without a re-init. |
| 37 | Library read-only list | List a library whose `index.yaml` is corrupt | Reported corrupt; the file is not rewritten. |
| 38 | Library publish guards | Publish with a mismatched provenance or a too-restrictive confidentiality | Refused before any write; version tree unchanged. |
| 39 | Drop-in template with no executable | Copy only the `.codecarto/` data template into a repo; drive a phase by prompt | The workflow runs; validation and status update behave as with an executable surface. |
| 40 | Byte-identical prompt fidelity | Drive one phase under two delivery surfaces with identical workspace state | The assembled prompt text is byte-identical. |
| 41 | Acyclic module graph | Static check of the port's module graph | No cycles; no top-level cross-module constant read. |

---

## Deliberate Non-Goals

- **Reproducing the source's fixed-age mtime lock.** The port replaces it; this is a design
  requirement, not a parity target.
- **Reproducing the source's module layout, file names, or package names.** Contracts and state
  semantics are preserved; organization is not.
- **A local server, web UI, authentication, authorization, or message broker.** None exists in
  the source; the only outbound network is the LLM provider and the only subprocess is `git`.
- **ANSI/TUI widget ergonomics** — Pi-only presentation, omitted from non-Pi ports.
- **Dashboard markup internals** — presentation, not protocol; the artifact contract is the
  self-contained single file plus its embedded JSON.
- **Broad-Side provider semantics as settled behavior** — the remote contract is unverified;
  the adapter exists but its provider assertions are spike-gated.
- **Byte-level compatibility with the source's internal test bodies** — the wire formats are
  the compatibility surface, not the tests.
- **Shipping the optional subsystems at minimum viable tier** — Broad-Side, versioned library,
  dashboard, and Pi UI are independently cuttable.

---

## Coverage and limits

- **Inspected scope.** Primary: `findings/porting/reverse-engineering-bundle.md` in full (system
  summary, Source Index, layer map, 27-feature contract table, P1–P17/SM1–SM7 notes, hazard
  table, Defect Synthesis, glossary, YAML codec decision, contradiction sweep). Also
  `.codecarto/GUIDE.md`, `workflow/status.yaml`, `workflow/VALIDATE.md`,
  `workflow/pipeline-full-with-deep-audit.yaml`, `CONVENTIONS.md` (C01–C05), `DECISIONS.md`
  (D001–D019), and `templates/reimplementation-spec.md`.
- **Targeted deep reads made (SKILL deep-read triggers).**
  1. `core/yaml.ts` in full — the seven YAML constraints and the sequence-merge `__proto__` gap
     (defect L2), because `cf-porting-1` requires an exact conformance list.
  2. `core/status.ts:442-610` — the lock protocol, release path, removal lock, and stale break
     (`cf-porting-2`; defects 3.1, 3.2, 6.2).
  3. `core/utils.ts:1-120` — `atomicWriteFile`, `isWithinPathResolved` (defects 6.1, 6.3, L9).
  4. `core/workspace.ts:422-465` and `core/library.ts:587-625,947-1001` — refresh and reindex
     lock scope (defects 2.2, 3.3, 3.4, L12, L13).
  5. `core/broadside/verify.ts:122-181` — the raw read path with no redaction (defect 4.1).
- **Skipped scope.** No full re-walk of `core/` or the wrappers; no dashboard renderer body
  beyond the bundle; no `docs/*` beyond `docs/library-format.md`'s already-closed parity; no
  `scripts/*`, `assets/`, `self-audit/`, or historical CHANGELOG; no ~90 test bodies (cited as
  pins only). All upstream `not inspected` scopes remain `not inspected` here.
- **Evidence basis.** Upstream findings (primary) plus the five targeted source reads above
  (secondary). **No tests were executed and no runtime probes ran this session** (no execution
  tool). Every durability, locking, containment, `git`, OpenRouter, and SDK claim is an
  `external-behavior claim` or `portability hazard` with `verify at runtime`, per C03; every
  defect disposition is inherited from the porting bundle and not re-measured unless named in
  the contradiction note below.
- **Known blind spots.**
  1. Windows/macOS behavior of the lock, atomic rename, containment, and `git`
     (`q-node-windows-fs-semantics`) — `verify at runtime`; scenarios 24–34 cannot be settled
     by reading.
  2. OpenRouter Batch API remote semantics (`q-openrouter-batch-semantics`) — `verify at
     runtime`.
  3. Pi-SDK vs MCP execution parity (`q-pi-sdk-execution-parity`) — prompt byte-identity is
     pinned; outcome parity is not.
  4. npm tarball template parity (`q-npm-tarball-template-parity`) — needs a fixture capture.
  5. The source lock findings (3.1, 3.2, 3.4) are interleavings argued from source, not
     observed; the named probes are not written or run.
  6. Unread extension/renderer bodies may hold behavior not represented in the bundle; the spec
     does not claim to cover them.
- **Contradiction note (measured this phase, routed to the handoff's `owner_notes`).** The
  current `core/status.ts` is **not** the shape the bundle's one-line 3.1 summary implies:
  `releaseOwnedLock` is already token-checked, and removals are serialized under `<lock>.break`
  (so the phrase "unguarded `.break` stale-break" describes an earlier state). The **residual**
  race the finding names is real for a different reason: the main-lock acquisition path does
  **not** consult the removal claim, so a fresh acquirer can create the lock between a
  remover's staleness re-check and its `rm`, and be deleted. The design consequence (25–27) is
  unchanged; the port must close that remover-vs-acquirer window. This is recorded rather than
  smoothed over. The bundle's other load-bearing defect reads were re-confirmed: `refreshScaffold`
  still copies one-at-a-time with no lock and an unduped `THREAD_LOG` append (3.3, L12);
  `reindex` still writes the index without `.publish.lock` (3.4); `verify`'s reader still
  returns raw lines with no redaction (4.1); `atomicWriteFile` still has no fallback (6.1); the
  sequence-merge path still plain-assigns parsed keys (L2).
- **Coverage disposition: COMPLETE** for this phase's declared scope. All eight pipeline
  completion criteria are met; `cf-porting-1` and `cf-porting-2` are closed in the body; the
  residual `verify at runtime` rows are routed to the Spike List and the handoff's
  `post_pipeline` list, and the three maintainer choices are registered as open questions.

---

## Known Unknowns

The reimplementation-spec phase is terminal, so these are terminal unknowns: they need a
prototype, runtime test, fixture capture, or a decision the maintainer owns.

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-node-windows-fs-semantics | needs-runtime-test | Do lock-file `O_EXCL`, atomic rename over an existing file, symlink-aware containment, and bare-`git` invocation behave on Windows/macOS as the POSIX-written code expects? Defect rows 6.1, 6.2, 6.3, 6.4, L9 inherit it. | Platform behavior cannot be confirmed by reading; CI runs Linux only. Re-triaged here: still `needs-runtime-test`; no scenario in this spec asserts a candidate answer with a settled action — those rows are `verify at runtime` and Spike List entries. |
| q-openrouter-batch-semantics | needs-runtime-test | The exact provider batch contract Broad-Side relies on (concurrency quota, `:batch` catalog membership, reasoning acceptance) is asserted, not verified. | External service behavior; needs a live probe. Re-triaged: still `needs-runtime-test`; the spec keeps provider assertions behind one adapter with fallbacks. |
| q-pi-sdk-execution-parity | needs-runtime-test | Do the Pi sub-agent path and an MCP host produce equivalent outcomes from byte-identical prompts? | Requires running one comparable phase under both surfaces and diffing outcomes. Re-triaged: still `needs-runtime-test`. |
| q-npm-tarball-template-parity | needs-fixture-capture | Does the packaged template and skill tree byte-match the checkout? | Needs packing and diffing — a fixture capture, not a source read. Re-triaged: still `needs-fixture-capture`. |
| q-target-stack | needs-maintainer-decision | Which target language/runtime and project identity should the opinionated spec lock? The auto runner suppressed the Strategic Alignment Hook. | The spec defaulted to language-agnostic; only the maintainer can pick the stack. Recoverable in an opinionated re-run. |
| q-scope-cut | needs-maintainer-decision | Which optional subsystems ship at minimum viable tier — Broad-Side, versioned library, dashboard, Pi UI? | `cf-porting-2`'s scope half is answered by the three scope tiers above, but the *cut* is a product decision. Default: all four postponed to major/full parity. |
| q-yaml-codec-library-choice | needs-maintainer-decision | Reproduce a small codec, or wrap a mature library in an adapter that re-imposes the seven constraints — and which library per target ecosystem? | The constraint set is fixed (`cf-porting-1`); the concrete pick depends on the locked target stack (`q-target-stack`). Default: reproduce the codec; adapter table supplied as a decision aid. |

**Re-triage result (orchestrator duty).** `q-node-windows-fs-semantics`,
`q-openrouter-batch-semantics`, and `q-pi-sdk-execution-parity` each **remain
`needs-runtime-test`** — none became answerable by the deep reads made this phase (which
confirm only what the code *does*); `q-npm-tarball-template-parity` remains
`needs-fixture-capture`. No row in this spec asserts one of their candidate answers with a
settled action: every claim that lands on an OpenRouter API, a lock/rename, containment, or
`git` carries `verify at runtime` and appears in the Spike List. Three **new**
`needs-maintainer-decision` questions are registered for the choices the suppressed hook would
have asked (`q-target-stack`, `q-scope-cut`, `q-yaml-codec-library-choice`).

---

## Carry-Forward

Reimplementation-spec is the terminal phase in this pipeline, so this table is empty. Work for
after the pipeline is routed through the handoff's `post_pipeline` list (see the framework's
existing spikes plus the new ones below).

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| — | — | — | — |

---

## Spike List

Prototypes, risky assumptions, and platform-sensitive areas that need targeted tests.

1. **Atomic replace on the target OS** (defect 6.1, `q-node-windows-fs-semantics`). Prototype
   `write temp → rename over existing`; measure failure modes; confirm the fallback seam works.
2. **Owner-liveness lock prototype** (defects 3.1, 3.2, 6.2). Two-process probe with a
   pre-planted stale lock and a long-held lock; assert exactly one holder at all times, no
   live holder's lock deleted, and the remover-vs-acquirer window closed.
3. **Removal compare-and-delete** (defect 3.1). Re-run the named `sem-removal-lock-race` probe
   against the redesigned protocol.
4. **Fixed-TTL stale-break** (defect 3.2). Re-run `sem-stale-lock-ttl`; a lock held across a
   long reindex must not be broken while its owner is alive.
5. **Reindex-vs-publish race** (defect 3.4). Re-run `sem-reindex-publish-race`; the final index
   must name the new version.
6. **Symlink-swap containment** (defects 6.3, L9, `q-node-windows-fs-semantics`). Probe
   junctions, 8.3 names, drive-relative paths, and a swap between check and read.
7. **Bare-`git` output shape** (defect 6.4). Probe `git` presence and `\0`/`\n`/`/` parsing on
   the target; confirm the walk fallback.
8. **YAML codec conformance** (`cf-porting-1`). Port the source dialect's round-trip/coercion
   cases (including `__proto__` in both mappings and sequence merges, scalar quoting, tabs,
   multi-doc, flow collections, key order) into the port's test corpus.
9. **Scaffold staged refresh** (defects 2.2, 3.3, L12). Inject a mid-refresh failure; assert no
   mixed-version scaffold and a deduped `THREAD_LOG`.
10. **Redaction chokepoint** (defect 4.1). Plant a secret, run the reconnaissance `verify` tool
    loop, assert only `[REDACTED:…]` leaves.
11. **OpenRouter Batch API** (`q-openrouter-batch-semantics`). Probe quota, `:batch` catalog
    membership, and reasoning acceptance.
12. **Pi-vs-MCP outcome parity** (`q-pi-sdk-execution-parity`). Run one phase under both
    surfaces; diff the primary output and the status transition.
13. **npm tarball parity** (`q-npm-tarball-template-parity`). Pack and diff the template and
    skill tree.
14. **Acyclic module graph** (defects 1.1, L1). Static import-graph assertion with no
    top-level cross-module constant reads.

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Concept-level modules are defined. | PASS | §Conceptual Module Model defines each module's responsibility, inputs, outputs, owned state, invariants, and collaborators; §Layer Split assigns each to core/adapters/delivery. |
| 2 | Required behaviors are stated. | PASS | §Required Behaviors groups 46 numbered behaviors by concern with `[core]`/`[important]`/`[optional]` tiers; §Defect Design Consequences maps every defect to a behavior or acceptance check. |
| 3 | Protocol and persisted state expectations are stated. | PASS | §Protocols and Persisted State names the two wire formats (exact YAML constraints and Markdown grammar), SM1–SM7, the three persistence classes, and the `verify at runtime` hedges; points at the protocols report for field-by-field schemas. |
| 4 | Acceptance scenarios and known unknowns are included. | PASS | §Acceptance Scenarios has 41 black-box rows; §Known Unknowns registers seven entries with ids and kinds; §Spike List has 14 entries. |
| 5 | Defects identified in either scan are explicitly designed-around or noted as "left behind", with the choice cited. | PASS | §Defect Design Consequences covers all 24 rows of the bundle's Defect Synthesis with disposition + design consequence; each cites the relevant Required Behavior or acceptance scenario. `verify at runtime` rows are routed to the Spike List, not designed around (C03); no finding is `leave behind`, stated explicitly. |
| 6 | Findings are marked with evidence levels. | PASS | Evidence levels are carried inline (`observed fact`/`strong inference`/`external-behavior claim`/`portability hazard`/`open question`) in §Coverage and limits, §Portability Hazards, and the contradiction note; every `verify at runtime` row is an `external-behavior claim` per C03. |
| 7 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits names all four, lists the five targeted deep reads and their SKILL triggers, gives a `COMPLETE` disposition, and carries a measured contradiction note on defect 3.1. |
| 8 | Lower-level findings are deep-read only when the porting bundle identifies a gap, conflict, missing acceptance detail, or defect rationale. | PASS | Five targeted deep reads, each justified: `core/yaml.ts` (`cf-porting-1`), `core/status.ts` (`cf-porting-2`), `core/utils.ts` (6.1/6.3), `core/workspace.ts`+`core/library.ts` (3.3/3.4), `core/broadside/verify.ts` (4.1). No other upstream file was opened. |

**Validated by:** 2026-09-15 (reimplementation-spec phase, self-audit session)
**Overall:** PASS
