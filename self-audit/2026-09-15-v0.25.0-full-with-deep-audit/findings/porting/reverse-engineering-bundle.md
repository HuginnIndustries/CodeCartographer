# Reverse-Engineering Bundle — CodeCartographer (`codecartographer-pi` v0.25.0)

> Self-audit synthesis. The analyzed source is the repository outside `.codecarto/` — the
> CodeCartographer framework itself. This bundle is the pipeline's **intentional compression
> boundary**: `reimplementation-spec` starts here and deep-reads an upstream report only when a
> row below names a gap, conflict, or detail this bundle cannot represent responsibly.
>
> Evidence levels are carried from the upstream reports and marked inline: `observed fact`,
> `strong inference`, `portability hazard`, `external-behavior claim`, `open question`. This
> phase performed **targeted source spot-checks** of the load-bearing defect and contradiction
> claims (`core/findings.ts`, `core/status.ts`, `core/workspace.ts`, `core/orchestrator-config.ts`,
> `core/library.ts`, `core/broadside/verify.ts`, `extensions/codecarto/phase-compaction.ts`,
> `mcp-server/server.ts`); it did **not** re-run the full source walk, and ran **no tests and no
> runtime probes**. Every platform/network/SDK claim stays hedged per CONVENTIONS C03.
>
> This bundle closes the routed item **`cf-protocols-1`** (§YAML Codec Decision) and reconciles
> the **`cfs-mech-3` writeDashboard contradiction** (§Contradiction Sweep).

---

## System Summary

CodeCartographer is a **portable, phase-gated reverse-engineering and specification-synthesis
framework** that installs as a `.codecarto/` directory inside a target repository. It walks a fixed
pipeline of analysis phases (`architecture → defect-scan-mechanical → contracts → protocols →
defect-scan-semantic → porting → reimplementation-spec`, or one of seven other variants); each
phase writes a templated, evidence-tagged Markdown artifact to disk, validates itself against a
`## Validation` grammar, and hands its state to the next phase through a YAML handoff. A durable
`workflow/status.yaml` is the single source of truth for progress, open questions, carry-forward
routings, and post-pipeline work. A second pipeline runs forward synthesis: it merges a user
vision with human-confirmed library specifications into a provenance-backed project plan
(`observed fact`: `README.md`, `.codecarto/GUIDE.md`, `.codecarto/workflow/pipeline-full-with-deep-audit.yaml`, `core/pipeline.ts`, `core/synthesis.ts`).

The architecture separates **one reusable core** from **delivery surfaces**. All semantics live in
`core/` (19 TypeScript modules plus a 14-module Broad-Side subpackage): the pipeline DAG and
validation parser, prompt assembly, the status/handoff state machine, the completion commit point,
coverage/findings cross-checks, config loading, a versioned spec library, a dashboard renderer, and
the OpenRouter batch-reconnaissance adapter. Two executable wrappers consume that core through a
single barrel — a **Pi extension** (slash commands, isolated phase sub-agents, live widget) and an
**MCP stdio JSON-RPC server** (22 tools) — and a third, non-executable **drop-in `.codecarto/`
data template** carries the analysis/synthesis protocol by prompt alone. The load-bearing fidelity
invariant is that Pi and MCP assemble **byte-identical phase prompts and validation results**
(CONVENTIONS C01), pinned by the ~90-file invariant test suite (`observed fact`: `core/prompts.ts`, `mcp-server/server.ts`, `extensions/codecarto/index.ts`, `tests/`).

For a reimplementer, the framework's *shape* is its interface: the exact Markdown headings, coverage
bullet labels, and defect-table columns are parsed by header-driven readers that fail silently on
mismatch (CONVENTIONS C04), and the hand-rolled YAML dialect is the wire format for every workflow
file (CONVENTIONS C04, §YAML Codec Decision). The hardest porting risks are therefore not
algorithms but **(1) preserving two wire formats exactly**, **(2) reproducing or redesigning a
POSIX-oriented advisory-lock + atomic-rename protocol whose defects are catalogued below**, and
**(3) deciding per target stack how much of the optional surface area (Broad-Side, library,
dashboard, Pi UI) to build at all**.

---

## Source Index

Each load-bearing claim points at its canonical upstream section. The "Deep-read trigger" column is
the exact condition under which `reimplementation-spec` should open the upstream file rather than
trust this summary.

| Area | Canonical upstream section | Summary carried forward | Deep-read trigger |
|---|---|---|---|
| Architecture | `findings/architecture/architecture-map.md` §Layer Map, §Dependency Direction, §Porting Priorities | Shared `core/` + two wrappers + drop-in data; base layer `types/utils/yaml`; one `index ↔ dashboard-writer` cycle; Broad-Side declared-acyclic subgraph with one ordering drift; tiered port priorities. | A module's role or dependency direction is unclear, or the port is choosing its package boundaries. |
| Contracts | `findings/contracts/behavioral-contracts.md` §Feature Contracts, §cf-arch-1 closures, §Black-Box Acceptance List | 19 shared workflow-control features + drop-in/library/dashboard; per-argument defaults/side-effects/errors for all 22 MCP tools and 20 Pi commands; 30 black-box scenarios. | An acceptance scenario needs exact defaults/errors, or the port must match a specific surface's argument grammar. |
| Protocols and state | `findings/protocols/protocols-and-state.md` §Event Catalog, §State Machine, §Persistent Schema Notes, §Compatibility Hazards | Boundaries B1–B15; protocols P1–P17; state machines SM1–SM7; field-by-field serialization for every on-disk/wire format. | A persistent shape, event ordering, or state transition must be reproduced byte-for-byte. |
| Mechanical defects | `findings/defect-scan-mechanical/mechanical-defects.md` §Pass 1/2/6 | 14 findings (1 high, 5 medium, 8 low): the import cycle, YAML `__proto__` gap, Broad-Side robustness, refresh no-rollback, dashboard result ignored, hardcoded constants; 6.1–6.4 are `verify at runtime`. | A low-grouped defect needs its row-level evidence, or a hazard's exact line citation. |
| Semantic defects | `findings/defect-scan-semantic/semantic-defects.md` §Pass 3/4/5 | 13 findings (0 high, 5 medium, 8 low): the removal-lock race, fixed-TTL stale break, refresh lock-scope gap, unlocked derived-index writers, verify redaction bypass, plus lower-severity guard/config gaps. | A `fix before porting` defect needs its interleaving argument or an exact site. |
| Defect dispositions | this bundle §Defect Synthesis | Single porting view: 1 high + 10 medium rows, 13 low groups; every disposition and required design consequence. | The spec needs the *required design consequence* for a specific defect id. |
| Public surfaces (secondary) | `findings/public-surfaces/public-surfaces.md` §2026-09-15 (contracts/protocols addenda) | Full per-argument MCP/Pi catalogs; corrected Pi count (20, not "~21"); Broad-Side `verify` action. | The port's API table needs the exhaustive per-tool argument catalog. |
| Runtime lifecycle (secondary) | `findings/runtime-lifecycle/runtime-lifecycle.md` §2026-09-15 (contracts/protocols) | Pi hook ordering; MCP stdio lifetime; SM1–SM7 runtime sequences. | The port must reproduce a hook/lifecycle ordering not shown in SM1–SM7. |
| State and storage (secondary) | `findings/state-and-storage/state-and-storage.md` §2026-09-15 (contracts/protocols) | Field-by-field serialization catalog + persistence semantics (mutable-atomic, append-only, derived). | A format's field list is needed in full. |
| Config model (secondary) | `findings/config-model/config-model.md` §2026-09-15 (contracts/protocols) | Three independent config systems and their precedence/failure modes. | The port needs the full precedence matrix. |
| Build and deploy (secondary) | `findings/build-and-deploy/build-and-deploy.md` §2026-09-14 + §2026-09-15 (porting) | Toolchain, packaging, CI/CD, distribution, and the port's build/packaging implications. | The port is choosing a build/packaging/release pipeline. |
| Library ABI doc | `docs/library-format.md` (read in full by protocols; `cf-contracts-1` closed) | Authoritative library ABI, accurate at every field/path/ordering/guard; two cosmetic placeholder-name drifts only. | The port implements the library and needs the public ABI text. |
| Conventions | `.codecarto/CONVENTIONS.md` C01–C05 | Byte-identical prompts; idempotent post-commit writes; unsettled findings inherit uncertainty; Markdown contracts are wire format; every writer of a state file takes that state's lock. | The port is designing its own invariants and needs the promoted rules. |
| Decisions | `.codecarto/DECISIONS.md` D001–D018 | The run's numbered cross-cutting decisions, including this phase's D016–D018. | A decision's rationale is needed to judge an edge case. |
| Wire-format parser | `core/findings.ts` (targeted read this phase) | The findings pairing gate reads only tables whose header has both `Evidence Level` and `Action`; unsettled evidence + settled fix action is an error (CONVENTIONS C03). | The port must reproduce the validation cross-checks. |

---

## Layer Map With Ownership

Concept names, not source paths — the port should not mirror the folder layout. "Owns" names the
state or behavior the layer is the sole authority for.

| Layer / Module (concept) | Role | Owns |
|---|---|---|
| **Workspace state store** | Durable memory | `status.yaml` schema + normalization, per-phase records, open questions, carry-forward, post-pipeline, the cursor; handoff parse/apply; amendments. |
| **Document codec** | Wire-format codec | The hand-rolled YAML dialect: read/write, scalar quoting round-trip rule, duplicate-key refusal, prototype-pollution guard, key order. |
| **Filesystem primitives** | Durability + containment | Atomic replace (temp+rename); path canonicalization + symlink-aware containment; the advisory lock (acquire/release/stale-break/removal lock). |
| **Pipeline engine** | Control plane | Pipeline alias table, DAG walk, eligible/stuck/complete resolution, cursor recomputation, `## Validation` grammar, phase resolution. |
| **Prompt assembler** | Fidelity surface | Byte-identical phase/skill prompt text; orchestrator-duties block; spliced-text quoting; closeout naming. |
| **Completion bookkeeper** | Commit point | Under-lock re-validation, handoff application, closure-integrity gates D1/D3, the `afterCommit` artifact writers (closeout, THREAD_LOG, decisions, proposals). |
| **Coverage & findings gate** | Cross-phase honesty | Coverage-ledger parse; findings evidence/action pairing; declared-secondary-output presence. |
| **Usage telemetry** | Observability | Append-only usage log; totals/per-phase aggregation; compaction counters. |
| **Config provider** | Configuration | Two-layer orchestrator/library config, per-key fault isolation, `problems` reporting, user-config mutation. |
| **Dashboard renderer** | Generated artifact | Self-contained single-file HTML + embedded JSON export; best-effort write. |
| **Versioned library** | External storage | Library marker, publish (content-hash idempotence, provenance/confidentiality guards), read/list/reindex, index ABI. |
| **Synthesis preflight** | Forward-synthesis control | Vision/library/proposal resolution and preflight guards. |
| **Guide server** | Documentation surface | Packaged agent-guide topic resolution. |
| **Secret redactor** | Trust boundary | High-confidence secret redaction + secret-file classification for outbound payloads. |
| **Provider adapter (Broad-Side)** | Batch integration | OpenRouter Batch/Chat adapters, model catalog + pricing, repo slicing + redaction, submit/poll/collect, run state + spending slots, verify tool loop, post-passes, render. |
| **MCP delivery surface** | Adapter | stdio JSON-RPC transport, 22 `codecarto_*` tools, path containment for `spec_path`, API-key resolution. |
| **Pi delivery surface** | Adapter | 20 slash commands, phase sub-agent lifecycle, auto-runner, compaction, live widget, `tool_call` write confinement, argument parsers. |
| **Drop-in data template** | Product shell (data) | GUIDE, pipeline DAGs, skills, templates, validation protocol — the protocol as data, no executable code. |
| **Build / distribution** | Packaging | `tsc` build, npm tarball + exclusions, one MCP bin, Pi extension registration, tag-driven release, smoke tests. |

### Dependency order and composition

- **Lowest reusable core (port first):** document codec → filesystem primitives → workspace state
  store → pipeline engine → prompt assembler → completion bookkeeper → coverage/findings gate.
- **Shared middle layers (port second):** config provider → usage → dashboard → library →
  synthesis → guide → secret redactor → provider adapter.
- **Delivery surfaces (port last, or drop):** MCP surface and Pi surface are thin adapters over the
  same core; the drop-in data template is pure data.
- **Invariant the port must add:** the source module graph has one cycle
  (`core/index.ts` ↔ `core/dashboard-writer.ts`) and one backward ordering edge
  (`core/broadside/state.ts` → `core/broadside/client.ts`). Both resolve only because imported
  bindings are dereferenced at call time. **A port must produce an acyclic module graph** (hoist
  the shared symbols into the lower layer) and must never read a cross-module constant at module
  top level. See Defect Synthesis rows 1.1 and L1.

---

## Feature Contract Table

Priority: **core** = required for the system to function; **important** = parity on major
workflows; **optional** = valuable but not required for a first viable port; **incidental** =
source-specific ergonomics. Defect ids reference §Defect Synthesis.

| Feature | Surface | Porting priority | Key contracts | Defect refs | Notes |
|---|---|---|---|---|---|
| Pipeline DAG, cursor, validation parser | shared | core | SM1; three outcomes (eligible/stuck/complete); last `## Validation` heading + last `**Overall:**` line win | — | The phase gate is the product; reproduce `stuck` as distinct from `complete`. |
| Prompt assembly (phase + skill) | shared | core | Byte-identical across surfaces (C01); fixed section order; `«…»` spliced-text quoting | — | Any per-surface prompt fork breaks the fidelity contract. |
| Status/handoff/amendment persistence + YAML codec | shared | core | C04; hand-rolled dialect; field-by-field schemas | L2, cf-protocols-1 | Two wire formats; parser swap is high-risk (§YAML Codec Decision). |
| Advisory lock + atomic write | shared | core | SM3; P17; O_EXCL + temp+rename; `<lock>.break` removal | 6.1, 6.2, 3.1, 3.2, 3.7 | Redesign required; do not port the fixed-TTL/unguarded-break design. |
| Workspace init | shared | core | Filtered copy, backup, orchestrator seeding, status write | — | Init isolation is how one project's state does not leak into another. |
| Workspace open / status | shared | core | Read-only; stuck sentence; missing-output naming; scaffold staleness | — | Read-only reattach. |
| Next-phase prompt | shared | core | Byte-identical prompt; stuck is an error, terminal is a text success | — | Drive loop. |
| Forced phase prompt | shared | important | Out-of-order prompt with warning line | — | Depends-on unmet warns, does not block. |
| Validate | shared | core | PASS / PASS WITH GAPS / FAIL / MISSING; findings pairing gate | — | The verdict grammar is wire format. |
| Complete | shared | core | SM2: under-lock re-validate → apply handoff → atomic rename → `afterCommit` (C02) | 3.6, L12 | Commit point + idempotent post-commit writers. |
| Switch pipeline | shared | important | Preserves shared phase records, drops old-only, moves dangling carry-forwards | — | Findings stay on disk. |
| Skill / list skills | shared | optional | Completion-gated except `broadside`; name resolved against installed list only | — | Never join a traversal name onto a path. |
| Guide | shared | optional | Packaged topics; needs no workspace | — | Frontmatter stripped; surface-specific footer. |
| Config | shared | important | Two layers, per-key fault isolation, `problems` refusal | 3.7 | Publish/library refuse while `problems` non-empty. |
| Vision interview | shared | optional | Synthesis pipeline only; embeds raw text verbatim | — | Tool writes no file. |
| Usage | shared | optional | Append-only log under lock; corrupt log refuses appends | — | Observability, not correctness. |
| Dashboard artifact | shared | important | Self-contained HTML + embedded JSON; best-effort | L4 | Zero external assets is a stated product property. |
| Refresh scaffold | shared | important | Protected-set exclusion; idempotent copy | 2.2, 3.3, L12 | Needs staging/rollback + lock + dedupe. |
| Amend (post-pipeline) | shared | important | SM6; complete-only under lock; idempotent closures | — | No runtime-evidence gate (that is completion's). |
| Publish | shared | optional | SM5; content-hash idempotence; provenance/confidentiality guards; `.publish.lock` | 3.4 | Library workflow only. |
| Library init/list/reindex | shared | optional | Marker, index ABI, read-only list | 3.4, L13 | Derived index is user-facing. |
| Broad-Side | shared | optional | P9–P11; submit/poll/collect/verify + post-pass slots | 1.4, 1.5, 1.6, 2.3, 4.1 | Network-coupled, advisory; a port can stub it. |
| Drop-in `.codecarto/` workspace | storage | core | Protocol-as-data; no executor | — | Analysis/synthesis work without any executable surface. |
| Versioned library | external storage | optional | `docs/library-format.md` is authoritative | — | `latest` is a regular file (deliberate Windows mitigation). |
| Dashboard | generated artifact | important | Deterministic render order; embedded export | — | Renderer body is presentation, not protocol. |
| Pi `tool_call` guard | Pi surface | optional | Blocks bash; confines edit/write to `.codecarto/` + configured library | 4.2, 5.1, L9 | Defense-in-depth; the sub-agent guard is separate. |
| MCP path containment | MCP surface | core | Absolute spec_path within allowed roots; fail closed | L9 | Authorization is capability-by-path. |
| Build / packaging / release | infra | important | `tsc`; tarball exclusions; tag-driven release | — | No containers/native builds. |

---

## Protocol and State Notes

A reimplementation must preserve these protocols and state machines. Full detail is in
`findings/protocols/protocols-and-state.md` (P1–P17, SM1–SM7, §Persistent Schema Notes).

**Boundaries (B1–B15).** Host↔workflow engine; MCP stdio JSON-RPC; prompt assembly→agent (byte-
identical); phase output→validator (Markdown grammar); handoff→completion; amendment→status; core↔
OpenRouter Batch/Catalog/Chat; Pi↔SDK child sessions; core↔`git`; workspace↔filesystem; workspace↔
dashboard artifact; config files↔runtime; library↔consumer. There is **no local server, no web UI,
no authn/authz, no message broker**; the only outbound network is OpenRouter and the only subprocess
is `git`.

**Protocols (P1–P17).** P1 phase-control request/response; P2 MCP stdio JSON-RPC (`serverLifetime`
AbortController aborted on stdin end/close); P3 phase prompt text (byte-identical, fixed section
order); P4 validation-table grammar (**last** heading/`**Overall:**` wins); P5 coverage-ledger
grammar (five fixed bullet labels); P6 findings cross-check (header-driven pairing gate); P7 handoff
exchange (validated pre-lock, applied under lock); P8 amendment exchange; P9 OpenRouter Batch
(submit/fetch/poll); P10 catalog/benchmarks; P11 Chat Completions tool loop (verify + post-passes);
P12 Pi sub-agent/compaction events; P13 `git` subprocess (30 s timeout); P14 dashboard artifact; P15
config propagation (three systems); P16 YAML dialect; P17 filesystem lock + atomic rename.

**State machines (SM1–SM7).** SM1 pipeline cursor (eligible/stuck/complete — three outcomes, not
two); SM2 phase completion (validate → under-lock re-validate → handoff → atomic rename **commit
point** → idempotent `afterCommit`); SM3 advisory lock (free/held/breaking/re-checking); SM4
Broad-Side run + spending slots (claim-before-spend, merge slot-by-slot, synthetic `timeout` still
claimable); SM5 library publish (guards → content-hash branch → stage → rename → pointer → reindex);
SM6 amendment (complete-only on the locked read, idempotent); SM7 Pi sub-agent/auto loop.

**Persistence essentials.** Mutable-in-place-atomic: `status.yaml`, usage log, Broad-Side
`state.json`, library `metadata.yaml`/`index.yaml`/`latest`/marker, dashboard, checkpoint.
Append-only: usage runs; `THREAD_LOG` lines (link-deduped); `DECISIONS` rows (text-deduped);
`CONVENTIONS` proposals (text-deduped). Derived/regenerable: `index.yaml`, `INDEX.md`,
`dashboard.html`, run-meta, catalog cache. `status.yaml` is the single source of truth; a handoff is
consumed once but retained; every lock/rename claim is `verify at runtime` on non-POSIX.

**Wire-format invariants the port must copy verbatim (C04).** The `## Validation`,
`## Coverage and limits`, and `## Pass N` headings; the `**Overall:**` line; the five coverage
bullet labels; the defect-table headers that include `Evidence Level` and `Action`; and
`## Completion log` / `## Pending proposals` as exact lines. These are parsed by
`core/pipeline.ts`, `core/coverage.ts`, `core/findings.ts`, and `core/completion.ts`, all of which
fail silently on mismatch.

---

## Portability Hazards

Risks, not certainties. "verify at runtime" rows are external-behavior claims per CONVENTIONS C03
and must not be flattened into a settled design decision.

| Hazard | Source phase | Impact | Mitigation |
|---|---|---|---|
| POSIX `rename` over an existing destination | mechanical 6.1 / protocols | high — every canonical write (`status.yaml`, usage, `state.json`, library) assumes it | Specify a per-platform atomic-replace primitive; verify on the target OS before relying on it; keep temp+replace behind one interface. |
| POSIX `O_EXCL` + `mtimeMs` staleness | mechanical 6.2 / protocols | medium — mutual exclusion and stale-break assume POSIX sharing semantics | Prefer OS-native advisory locking; verify claim semantics on target; do not reproduce the fixed-TTL break. |
| Symlink/case-aware containment | mechanical 6.3 / protocols / semantic L9 | medium — Windows junctions, 8.3 names, drive-relative paths | Verify containment on target; prefer canonical-handle/fd reads; one shared containment policy. |
| Bare `git` on `PATH` + POSIX-shaped output | mechanical 6.4 / protocols | medium — provenance and scan set change | Detect and degrade explicitly; verify `\0`/`\n` and `/` parsing on target. |
| Hand-rolled YAML subset | protocols P16 | medium — flow collections silently become strings, tabs error, duplicate keys refused; a real YAML library changes coercion/duplicate-key semantics | Adopt one policy: reproduce the dialect, or re-impose its contracts behind an adapter (§YAML Codec Decision); pin with ported round-trip tests. |
| `__proto__` prototype-pollution gap in sequence merge | mechanical 1.3 | low — parser's own guard bypassed in one path | Apply one guard uniformly; never plain-assign parsed keys. |
| OpenRouter Batch API remote semantics | protocols P9/P10/P11 / architecture | high — quota, which ids have `:batch`, reasoning acceptance are asserted, not verified | `verify at runtime` (`q-openrouter-batch-semantics`); keep provider assertions behind one adapter with explicit fallbacks. |
| Node `fetch` / `AbortSignal.timeout` | protocols | medium — runtime-provided | Provide a shim in a target without them. |
| `process.stdin` end/close detection | protocols P2 | low — SDK transport never sees stream end | Reimplement lifetime abort on the target's stream API. |
| Advisory locks are neither re-entrant nor fair | protocols P17 | low — second waiter blocks 5 s | Design re-entrancy/queuing deliberately. |
| ANSI/TUI assumptions | architecture | low — widget/completions are Pi-only | Omit from non-Pi ports. |
| ISO timestamps as identifiers | mechanical 1.5 | low — same-millisecond collision | Content-addressed / monotonic ids. |
| Byte-size vs code-unit slicing | mechanical 1.4 | low — non-ASCII off-by-content | One unit everywhere. |
| Secret redaction is heuristic | contracts / semantic 4.1 | medium — Broad-Side uploads depend on it; `verify` currently bypasses it | One outbound redaction chokepoint; do not weaken it. A port must not ship a second upload path. |
| HTML link-escaping is a boundary | protocols | low — `safeRelativeHref` rejects absolute/`..` and percent-encodes segments | Preserve the encoding; removing it reopens Windows `\..\` traversal. |
| Fixed 60 s lock death | semantic 3.2 | medium — breaks a legitimately held lock (publish across reindex) | Owner-liveness/heartbeat instead of mtime age. |
| Unguarded removal-lock stale-break | semantic 3.1 | medium — two waiters can both hold, and a fresh lock can be deleted | Claim the stale-break atomically; compare-and-delete by token/inode. |
| Check-then-act windows (re-entry, closure integrity, containment) | semantic 3.5/3.6/L9 | low–medium | Reserve before await; re-check under lock; prefer handles to paths. |

---

## Defect Synthesis

Consolidates **both** scans (27 findings: 1 high, 10 medium, 16 low) into one porting view. Every
high and medium finding has its own row; the 16 lows are grouped by shared root cause, naming the
source rows. The `Action` column is the porting disposition — `fix before porting`, `port
differently`, `leave behind`, or `verify at runtime`. Rows with an `external-behavior claim` keep
`verify at runtime` as written (C03); they are **not** flattened into a settled fix. No fix was
applied to the source (read-only workspace), so `templates/defect-fix-tracker.md` was not needed;
the `fix before porting` rows are the worklist a tracker would consume.

| Defect ID | Source Report | One-line Description | Severity | Evidence Level | Action | Required design consequence |
|---|---|---|---|---|---|---|
| 6.1 | mechanical §Pass 6 | `atomicWriteFile` has no non-atomic fallback; `rename` over an existing destination can fail on Windows, so every canonical write could fail. | high | external-behavior claim | verify at runtime | Define a per-platform atomic-replace primitive and verify it on the target OS before any state write depends on it; keep an unlink+rename or lock+write fallback seam. |
| 1.1 | mechanical §Pass 1 | `core/index.ts` ↔ `core/dashboard-writer.ts` module-graph cycle resolves only because bindings are read at call time. | medium | observed fact | port differently | Produce an acyclic module graph: hoist shared symbols into the lower module; never mirror an eager-evaluation cycle. |
| 2.2 | mechanical §Pass 2 | `refreshScaffold` copies framework files one at a time with no staging or rollback; a mid-loop failure leaves a mixed-version scaffold. | medium | observed fact | port differently | Stage the refresh and commit it atomically (temp tree or journal); a partial failure must not leave a mixed scaffold. |
| 6.2 | mechanical §Pass 6 | `acquireLock` assumes `O_EXCL` + `mtime` staleness and breaks a stale lock non-atomically with respect to its holder. | medium | external-behavior claim | verify at runtime | Re-verify lock claim semantics on the target OS; prefer native advisory locking; do not assume `mtime` fidelity. |
| 6.3 | mechanical §Pass 6 | Path containment resolves symlinks through `realpath` and case-folds only on `win32`. | medium | external-behavior claim | verify at runtime | Verify containment for junctions, short names, and drive-relative paths on the target; keep one containment policy. |
| 6.4 | mechanical §Pass 6 | The subsystem shells out to a bare `git` and parses POSIX-shaped output. | medium | external-behavior claim | verify at runtime | Verify `git` presence and output shape on the target; degrade explicitly (walk fallback already exists). |
| 3.1 | semantic §Pass 3 | `withRemovalLock`'s unguarded `.break` stale-break lets two waiters both hold; `breakStaleLock`'s non-atomic `stat → describeLockHolder → rm` can delete a *fresh* lock. | medium | observed fact | fix before porting | Reimplement removal serialization so the stale-break is itself claimed atomically and removal re-verifies identity immediately before unlink (compare-and-delete by token/inode). |
| 3.2 | semantic §Pass 3 | Fixed `STALE_LOCK_MS = 60_000` treats a lock older than 60 s as dead; a legitimately long-held lock (publish across `reindex`) can be broken while its owner still writes. | medium | observed fact | fix before porting | Replace fixed-age death with an owner-liveness/heartbeat or explicit holder protocol; never break a lock whose owner is alive. |
| 3.3 | semantic §Pass 3 | `refreshScaffold` overwrites framework files and appends `THREAD_LOG` outside the status lock via non-atomic `copyFile`. | medium | observed fact | fix before porting | Take the status (or scaffold) lock and write through the atomic primitive; serialize the `THREAD_LOG` append. |
| 3.4 | semantic §Pass 3 | Standalone `library_reindex`/`library_list` write the derived `index.yaml` without `.publish.lock`; a reindex can clobber a just-published index. | medium | observed fact | fix before porting | Every writer of the index takes the publish lock (CONVENTIONS C05); derived writers are not exempt. |
| 4.1 | semantic §Pass 4 | Broad-Side `verify` uploads raw file content to OpenRouter without `redactSecrets`, bypassing the `submit` redaction guarantee. | medium | observed fact | fix before porting | Route every outbound payload through one redaction chokepoint; the port must not have two upload paths. |
| L1 (1.2) | mechanical §Pass 1 | `core/broadside/state.ts` imports a downstream `client.ts` constant, contradicting the declared module order. | low | observed fact | port differently | Declare and enforce dependency direction; evaluate no cross-module constant at module top level; assert acyclicity statically. |
| L2 (1.3) | mechanical §Pass 1 | `parseSequence`'s nested merge bypasses the parser's deliberate `__proto__` `defineProperty` guard. | low | observed fact | port differently | Apply one prototype-pollution guard uniformly; never plain-assign parsed keys. |
| L3 (1.4, 1.5, 1.6, 2.3) | mechanical §Pass 1/2 | Broad-Side robustness cluster: byte-vs-char slicing; millisecond-timestamp run ids collide; post-pass JSON parsed with raw `JSON.parse` (fenced responses silently empty); a failed retry submit is swallowed with no error field. | low | observed fact | port differently | Use one size unit, content-addressed/monotonic run ids, one fence-tolerant JSON parser, and explicit error capture on every submit path. |
| L4 (2.1) | mechanical §Pass 2 | Pi `/codecarto-dashboard` ignores the boolean `writeDashboard` returns and reports success unconditionally. | low | observed fact | fix before porting | Surface the best-effort result; never report a swallowed write failure as success. |
| L5 (6.5) | mechanical §Pass 6 | Operational constants (git/HTTP timeouts, poll budget/interval) are hardcoded with no knob. | low | observed fact | port differently | Make operational timeouts configurable/overridable. |
| L6 (3.6) | semantic §Pass 3 | Completion's closure-integrity gates (target-phase, D1, D3) run on a pre-lock snapshot; a concurrent completion can invalidate them. | low | observed fact | port differently | Re-run integrity checks under the lock, or accept and document the narrow TOCTOU. |
| L7 (4.2) | semantic §Pass 4 | `codecartoModeActive` resets on `session_start`; the orchestrator's write confinement and bash block are off after a reload until init/open. | low | observed fact | port differently | Derive mode from persisted workspace state (presence of `.codecarto/`), not session state. |
| L8 (3.7) | semantic §Pass 3 | `writeLibraryConfig` read-modify-writes the shared user-global config with no lock and a non-atomic `writeFile`. | low | observed fact | fix before porting | Lock + atomic write for any shared-config mutation; the file is read by every workspace on the machine. |
| L9 (4.3) | semantic §Pass 4 | `readSpecArg` containment is check-then-use on a path: a symlink swapped between the check and the read defeats it. | low | external-behavior claim | verify at runtime | Verify symlink-swap timing on the target; prefer reading through a canonical handle/fd or re-checking after open. |
| L10 (3.5) | semantic §Pass 3 | The sub-agent re-entry guard is check-then-act across the async prompt/LLM-rewrite prelude; two quick runs can spawn duplicate sub-agents for one phase. | low | observed fact | fix before porting | Reserve the phase slot before any `await`; the registry must be authoritative across the prelude. |
| L11 (5.1) | semantic §Pass 5 | The child-session guard's "same containment as the parent" comment omits the configured-library root the parent allows. | low | observed fact | port differently | One shared guard policy used by both session scopes, with the comment generated from the policy. |
| L12 (5.2) | semantic §Pass 5 | Scaffold refresh appends a `THREAD_LOG` line with no dedupe, violating its idempotence contract. | low | observed fact | fix before porting | Dedupe the refresh entry keyed on the refresh event (CONVENTIONS C02). |
| L13 (5.3) | semantic §Pass 5 | `listEntries` rewrites an existing (corrupt) `index.yaml`, against its "read-only, may build if absent" contract. | low | observed fact | port differently | Keep read commands read-only; require an explicit reindex, or document the build-on-corrupt behavior. |

**Counts.** 1 high + 10 medium + 16 low = 27 findings (mechanical 14, semantic 13). No finding is
`leave behind`: every defect here is either a logic/ordering defect the port must re-decide or an
external-behavior claim the port must verify. The `verify at runtime` rows (6.1, 6.2, 6.3, 6.4, L9)
all inherit `q-node-windows-fs-semantics` and appear under §Open Questions.

---

## Observed Facts vs. Inferred Structure

### Observed Facts

- Three delivery surfaces over one `core/`; Pi and MCP call the same `buildPhasePrompt` and
  `validatePhaseOutput` (C01, test-pinned) (`observed fact`).
- `status.yaml` is the single source of truth; completion's commit point is the `status.yaml`
  rename in `updateStatusAtomically`, with idempotent writers in `afterCommit` (C02) (`observed fact`).
- The validation/coverage/findings parsers are shape-driven and fail silently on heading/column
  mismatch (C04); the findings pairing gate reads only tables with both `Evidence Level` and
  `Action` (`observed fact`: targeted read of `core/findings.ts` this phase).
- The hand-rolled YAML dialect refuses duplicate keys, guards `__proto__` in mappings but **not** in
  the sequence merge, quotes scalars only when a round-trip check requires it (protocols P16).
- The lock is `O_EXCL` + temp+rename with a `<lock>.break` removal lock; `STALE_LOCK_MS = 60_000`,
  `BREAK_LOCK_STALE_MS = 5000`, retry 125 ms, timeout 5 s (protocols P17; **re-confirmed** by
  reading `core/status.ts:520-575` this phase).
- `refreshScaffold` copies files one at a time and appends `THREAD_LOG` with no lock and no dedupe,
  and calls **no** `writeDashboard` (**re-confirmed** by reading `core/workspace.ts:430-458` this
  phase).
- `reindex` does not itself take `.publish.lock`; the lock is taken by `publishEntry`
  (**re-confirmed** by reading `core/library.ts:610-625,912-1001` this phase).
- `writeLibraryConfig` read-modify-writes with no lock and a plain `writeFile`
  (**re-confirmed**: `core/orchestrator-config.ts:250-289`).
- `createRepoReader` (the `verify` tool loop) returns raw file lines and never calls
  `redactSecrets` (**re-confirmed**: `core/broadside/verify.ts:133-181`).
- The child-session guard allows only `ctx.cwd/.codecarto` and does not add the library root
  (**re-confirmed**: `extensions/codecarto/phase-compaction.ts:70-89`).
- The library ABI (`docs/library-format.md`) matches `core/library.ts` at every field/path/ordering/
  guard; two cosmetic placeholder-name drifts only (`cf-contracts-1` closed).
- Pi exposes **20** slash commands (test-pinned), not the architecture map's "~21".

### Inferred Structure

- The framework's **product is its protocol**: the phase gate, the evidence vocabulary, and the two
  wire formats are what a port must preserve; the executable wrappers are adapters (`strong inference`).
- Broad-Side is **deliberately advisory and optional**: it is network-coupled, its remote contract is
  unverified, and the analysis pipeline works without it (`strong inference` from its tiering and the
  drop-in path).
- The concurrency defects cluster on **one root cause**: a fixed-age mtime lock plus non-atomic
  removal logic. A port that redesigns the lock (owner-liveness + compare-and-delete + one writer
  per state file) dissolves 3.1, 3.2, 3.4, 3.7, and 5.3 together (`strong inference`).
- The library's `latest`-as-a-regular-file choice is a **deliberate Windows mitigation**, evidence
  that the authors were already reasoning cross-platform (`strong inference`, contracts §Surface 5).

---

## Domain Glossary

| Term | Definition | Where used |
|---|---|---|
| Phase | One gated analysis step in a pipeline; writes a primary output ending in `## Validation`. | `pipeline*.yaml`, `core/pipeline.ts` |
| Pipeline / variant | A named DAG of phases; `status.yaml.pipeline` names the active file. | `core/pipeline.ts` `PIPELINE_ALIASES` |
| Primary / secondary output | The phase's canonical artifact / append-mode catalog documents. | pipeline `primary_output`/`secondary_outputs` |
| Handoff | `scratch/handoffs/<phase>.yaml`, the executor's proposed state change; consumed once, retained. | `core/status.ts`, `core/completion.ts` |
| Cover / commit point | The `status.yaml` atomic rename after which the phase's completion stands. | `core/workspace.ts` `updateStatusAtomically` |
| `afterCommit` | The post-rename hook that writes closeout, THREAD_LOG, decisions, proposals. | CONVENTIONS C02 |
| Closeout / THREAD_LOG | Per-session summary / link-deduped index of closeouts. | `core/completion.ts` |
| Open question | A genuinely unknown item (`needs-runtime-test`, `needs-maintainer-decision`, `needs-spec-ruling`, `needs-fixture-capture`). | `status.yaml` |
| Carry-forward | Work deferred to a specific later phase (`defer-to-phase`, `target_phase`). | `status.yaml` |
| Post-pipeline | Optional work after the active pipeline (spikes, amendments). | `status.yaml` |
| Coverage ledger | The `## Coverage and limits` section; `Skipped scope`/`Known blind spots` bind later phases. | `core/coverage.ts` |
| Findings pairing gate | Error when an unsettled evidence level carries a settled fix action. | `core/findings.ts`, CONVENTIONS C03 |
| Evidence level | `observed fact` / `strong inference` / `portability hazard` / `external-behavior claim` / `open question`. | every phase output |
| Scaffold | The packaged `.codecarto/` template copied into a workspace; refresh overwrites framework files. | `core/workspace.ts` |
| Library | A versioned external store of published specs (`.codecarto-library` marker). | `core/library.ts`, `docs/library-format.md` |
| Broad-Side | OpenRouter batch reconnaissance subsystem (lenses in, findings out). | `core/broadside/` |
| Lens | One reconnaissance angle (architecture, api, security, defect, conventions, porting). | `core/broadside/lenses.ts` |
| Run slot | An atomically claimed spending entitlement (`synthesis`/`triage`/`retry`) preventing double-pay. | `core/broadside/state.ts` |
| Post-pass | The synthesis/triage/verify passes run after all lens batches are terminal. | `core/broadside/collect.ts` |
| Status lock / publish lock / removal lock | `status.yaml.lock` / `.publish.lock` / `<lock>.break`. | `core/status.ts` |
| Atomic write / containment | Temp+rename / symlink-resolved path-in-root check. | `core/utils.ts` |
| Amendment | A post-pipeline YAML that closes open questions / retires post-pipeline items. | `core/amendment.ts` |
| Synthesis pipeline | The forward vision→plan pipeline (four phases). | `pipeline-synthesis.yaml`, `core/synthesis.ts` |

---

## YAML Codec Decision (closes `cf-protocols-1`)

`cf-protocols-1` asked whether the port adopts a full YAML library or reproduces the hand-rolled
subset, and how it preserves duplicate-key and scalar-coercion behavior. This phase closes it with a
**decision framework plus a fixed set of behavioral constraints**, because the concrete library
choice is per target language and belongs to `reimplementation-spec` (routed as `cf-porting-1`).

**Constraints any choice must satisfy (non-negotiable — these are the dialect's observable contracts):**

1. **Duplicate keys are refused**, not last-wins. A full parser configured for last-wins silently
   changes semantics; the port must reject duplicates on read.
2. **No prototype pollution.** The `__proto__` key must never invoke a prototype setter, in mappings
   **or** sequence-item merges. The source's mapping guard is correct; the sequence-merge path is
   the defect (row L2 / mechanical 1.3) and must not be reproduced.
3. **Scalar quoting round-trip.** On write, a string stays bare only if the reader returns the same
   string; numeric-looking, boolean-looking, `null`-looking, and bare `-` strings are quoted. A full
   YAML library's emitter will differ; the port must re-impose the round-trip rule.
4. **No flow collections.** The source does not read `[a, b]`/`{a: b}` as collections; it coerces
   them to strings and drops them where an array is expected. A full library will parse them,
   changing hand-edit tolerance. The port must either reproduce the coercion/rejection or document
   the deliberate divergence.
5. **Key order is preserved on write**, and readers tolerate hand edits (single-quoted strings,
   `|`/`>` block scalars with any chomping, wrapped plain scalars, same-column sequences).
6. **Tabs in indentation are an error**; multi-document streams are not supported.
7. **Determinism** — the same bytes in must produce the same structure out; the format carries no
   version marker of its own.

**Recommended policy (language-agnostic):**

- **Preferred:** implement a small, explicit codec that reproduces the seven constraints above and
  is pinned by ported round-trip/coercion tests (`tests/` already pins the source dialect). This
  keeps `status.yaml`/handoffs byte-compatible with the drop-in path and with any existing workspace.
- **Acceptable alternative:** wrap a mature YAML parser in an adapter that **re-imposes** constraints
  1–5 (duplicate rejection, `__proto__` guard, quoting on write, flow-collection policy, key order).
  The adapter is mandatory; a bare `YAML.load`/`safe_load` is not a port of this dialect.
- **Not acceptable:** substituting a full library with default settings. Default duplicate-key,
  scalar-coercion, flow-collection, and anchor/alias behavior all diverge, and every workflow file
  (`status.yaml`, handoffs, amendments, pipeline definitions, config, library metadata/index) is a
  wire format parsed by the same codec (C04).

Closure recorded in the phase handoff as `carry_forward_closures: [cf-protocols-1]`; the per-stack
library selection is routed to `reimplementation-spec` as `cf-porting-1`.

---

## Contradiction Sweep

- **`cfs-mech-3` / `writeDashboard` (resolved here).** `status.yaml`, `mechanical-defects.md`
  §Routed To Semantic Phase, and the mechanical report's summary say `refreshScaffold` appends
  `THREAD_LOG.md` **and fires `writeDashboard` (fire-and-forget)** outside the status lock. The
  semantic phase flagged the `writeDashboard` clause as absent. **This phase independently confirms
  the semantic read:** `core/workspace.ts:430-458` contains no `writeDashboard` call — only the
  `copyFile` loop, `ensureWorkspaceGitignore`, and the `THREAD_LOG` append. The adjacent handlers
  that do call `writeDashboard` are dashboard/amend/switch-pipeline/init/publish, not refresh.
  The mechanical report's clause is a **summarized claim contradicted by a measured source read**.
  Porting reproduces **finding 3.3** (lock-scope gap + non-atomic `copyFile`, both real) and **not**
  the `writeDashboard` clause. No downstream action is owed; the contradiction is closed, not
  smoothed over.
- **Pi command count (carried).** Architecture and `public-surfaces.md` say "~21"; a test pins the
  size at **20** and `README.md` lists 20. The bundle uses **20**.
- **README Broad-Side actions (carried).** `README.md` lists four actions; the code implements
  five (adds `verify`). Code is authoritative.
- **Placeholder-name drifts (carried, non-conflicting).** `docs/library-format.md`'s staging/temp
  suffixes differ cosmetically from `core/library.ts`; the globs still cover both. The doc stays
  authoritative.
- **No new contradiction** between this phase's required reads and any completed phase's
  `owner_notes`. The lock findings' source sites were re-read and match the semantic report.

---

## Coverage and limits

- **Inspected scope:** this phase synthesized the five upstream reports in full
  (`architecture-map.md`, `behavioral-contracts.md`, `protocols-and-state.md`,
  `mechanical-defects.md`, `semantic-defects.md`), `CONVENTIONS.md`, `DECISIONS.md`,
  `workflow/status.yaml`, the active pipeline, and `VALIDATE.md`. It performed **targeted source
  spot-checks** to confirm the load-bearing claims it could not take on trust: `core/findings.ts`
  (the pairing gate), `core/status.ts:520-575` (removal lock / stale break), `core/workspace.ts:425-458`
  (refresh path, no `writeDashboard`), `core/orchestrator-config.ts:245-289` (config RMW),
  `core/library.ts:610-625,905-1005` (publish lock vs. standalone reindex), `core/broadside/verify.ts:133-188`
  (raw read path, no redaction), `extensions/codecarto/phase-compaction.ts:70-89` (child guard), and
  `mcp-server/server.ts:673-710` (`readSpecArg` check-then-use).
- **Skipped scope:** no full re-walk of `core/` or the wrappers was attempted — the bundle is a
  synthesis, not a second scan; every upstream `not inspected` remains `not inspected` here. The
  bundle does not reproduce the dashboard renderer body, the ~90 test bodies, `docs/*` beyond
  `library-format.md`, `scripts/*`, `assets/`, or the historical CHANGELOG.
- **Evidence basis:** upstream phase findings (primary) plus targeted source inspection (secondary)
  for the defect and contradiction claims above. **No tests were executed and no runtime probes
  ran this session**; every test citation remains "the test file pins X," never "X passed here."
- **Known blind spots:**
  1. Windows/macOS behavior of the lock, atomic rename, containment, and `git`
     (`q-node-windows-fs-semantics`) — `verify at runtime`; rows 6.1–6.4 and L9 depend on it.
  2. OpenRouter Batch API remote semantics (`q-openrouter-batch-semantics`) — `verify at runtime`.
  3. Pi-SDK vs MCP execution parity (`q-pi-sdk-execution-parity`) — the bundle asserts prompt
     byte-identity (`observed fact`), not outcome parity.
  4. npm tarball template parity (`q-npm-tarball-template-parity`) — needs a fixture capture.
  5. The source lock findings (3.1, 3.2, 3.4) are interleavings argued from source, not observed;
     the named probes were not written or run.
  6. Unread extension/renderer bodies may hold behavior not represented here.
- **Coverage disposition:** **COMPLETE** for the porting phase's declared scope. All seven
  pipeline completion criteria are met; `cf-protocols-1` is closed with a decision framework; the
  `cfs-mech-3` contradiction is resolved; the residual limits are named and routed as open questions
  / carry-forward, not smoothed over.

---

## Open Questions

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| q-node-windows-fs-semantics | needs-runtime-test | Do lock-file `O_EXCL`, atomic rename over an existing file, symlink-aware path containment, and bare-`git` invocation behave on Windows/macOS as the POSIX-written code expects? Defect rows 6.1, 6.2, 6.3, 6.4, and L9 inherit it. | Platform behavior cannot be confirmed by reading; CI runs Linux only. Re-triaged this phase: still `needs-runtime-test`. No bundle row asserts a candidate answer with a settled action. |
| q-openrouter-batch-semantics | needs-runtime-test | The exact OpenRouter Batch API contract Broad-Side relies on — concurrent-job quota (`job-submission-count`), which catalog ids have `:batch` endpoints, and reasoning acceptance — is asserted in comments. | External service behavior; needs a live probe or the provider's source. Re-triaged: still `needs-runtime-test`; the `verify` redaction finding (4.1) is about what the code sends, not what the provider does. |
| q-pi-sdk-execution-parity | needs-runtime-test | Do Pi sub-agent execution (tool sandbox, compaction, session persistence) and an MCP host's execution produce equivalent outcomes given byte-identical prompts? | Re-triaged: still `needs-runtime-test`; requires running the same phase under both surfaces and comparing outcomes. The bundle asserts prompt byte-identity, not outcome parity. |
| q-npm-tarball-template-parity | needs-fixture-capture | Whether the published npm tarball's `.codecarto/` template and `agent-skill/` byte-match this checkout. | Inherited from architecture/contracts/protocols; needs packing and diffing — a fixture capture, not a source read. Re-triaged: still `needs-fixture-capture`. |

**Re-triage result (orchestrator duty):** `q-node-windows-fs-semantics`, `q-openrouter-batch-semantics`,
and `q-pi-sdk-execution-parity` each **remain `needs-runtime-test`** — none became answerable by
reading this phase's sources (the targeted reads confirm only what the code *does*). No row in this
bundle asserts one of their candidate answers with a settled action; every claim that lands on the
OpenRouter API, a lock/rename, containment, or `git` carries `verify at runtime`. No **new** open
question is registered: `cf-protocols-1` was answerable as a design decision and is closed.

---

## Carry-Forward

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| cf-porting-1 | reimplementation-spec | Select the concrete YAML parser/library for the target stack against the seven dialect constraints in §YAML Codec Decision (duplicate-key refusal, prototype-pollution guard, scalar round-trip quoting, flow-collection policy, key order, tab/multi-doc errors, determinism), and pin it with ported round-trip/coercion tests. | The dialect's constraints are fixed here, but the library choice is language-specific and the spec is where the target stack is locked. |
| cf-porting-2 | reimplementation-spec | Decide the scope cut for the optional subsystems (Broad-Side provider adapter, versioned library, dashboard, Pi UI) and pin the concurrency redesign's concrete choices (owner-liveness lock, compare-and-delete removal, one writer per state file, staging for refresh) as required design elements. | The porting bundle fixes each defect's required design consequence and each feature's priority; the spec decides what ships and names the primitives. |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | The system summary, layer map, contract table, protocol notes, and porting findings are synthesized. | PASS | §System Summary; §Layer Map With Ownership (+ dependency order); §Feature Contract Table (27 features); §Protocol and State Notes (P1–P17, SM1–SM7, persistence); §Defect Synthesis; §YAML Codec Decision; §Carry-Forward. |
| 2 | Portability hazards and open questions are separated from facts. | PASS | §Portability Hazards is a risk table distinct from §Observed Facts vs. Inferred Structure; §Open Questions carries the four unsettled questions separately; every `verify at runtime` row is an `external-behavior claim`. |
| 3 | Feature importance is sorted for porting. | PASS | §Feature Contract Table's `Porting priority` column (core/important/optional) on every row, plus the §Layer Map "Dependency order and composition" port-first ordering. |
| 4 | Defect Synthesis consolidates mechanical-defects.md and semantic-defects.md with porting recommendations (fix before porting / port differently / leave behind / verify at runtime). | PASS | §Defect Synthesis: 24 rows covering all 27 findings — 1 high + 10 medium individually, 16 lows in 13 shared-root-cause groups — each with Evidence Level, Action, and a required design consequence; no finding is `leave behind`, and that is stated. |
| 5 | Findings are marked with evidence levels. | PASS | Inline `observed fact` / `strong inference` / `external-behavior claim` / `portability hazard` / `open question` throughout, plus the Defect Synthesis `Evidence Level` column; the targeted source re-checks are labelled as such. |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits names all four explicitly, lists the targeted source reads, and gives a `COMPLETE` disposition plus the carried blind spots. |
| 7 | The Source Index makes the bundle a self-contained compression boundary and identifies targeted deep-read triggers. | PASS | §Source Index: 15 rows mapping each area to its canonical upstream section, the summary carried forward, and the exact condition that should trigger a deep read. |

**Validated by:** 2026-09-15 (porting phase, self-audit session)
**Overall:** PASS
