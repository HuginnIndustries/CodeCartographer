# Reverse-Engineering Bundle

Source: CodeCartographer at commit `f6f8484` (v0.19.5), everything outside `.codecarto/`. This bundle is the compression boundary for `reimplementation-spec`: it carries every load-bearing claim, hazard, and defect disposition from the five upstream reports and points at them only for detail. Evidence markers: `[fact]` observed fact, `[inference]` strong inference, `[external]` external-behavior claim, `[hazard]` portability hazard, `[open]` open question. Upstream ids: `arch`, `contracts §…`, `E<n>`/`SM<n>` (protocols), `mech P.N`, `sem P.N`.

Routed items closed here: **arch-CF2** (boundary breaches → §Layer Map "Composition decisions"), **contracts-CF2** (surface parity → §Feature Contract Table "Surface" column and §Portability Hazards), **proto-CF2** (compatibility surface → §Protocol and State Notes "Preserve byte-for-byte vs re-encode"), **sem-CF1** (one atomic-write/lock primitive → §Defect Synthesis D-H4/D-H5 design consequence and §Layer Map "state-store primitive").

## System Summary

CodeCartographer is a filesystem-backed pipeline state machine that turns "analyze this repository with an LLM" into a sequence of validated, evidence-tagged markdown artifacts. It never reads the target repository and never calls a model `[fact: arch §System Intent]`. Its kernel does five things: select the next eligible phase from a YAML DAG; assemble a phase prompt that names required reads, routed items, and orchestrator duties; parse the markdown the LLM writes back (a validation table, a coverage ledger, findings tables); gate completion on that parse plus a structured handoff file with closure-integrity rules; and apply the handoff to a single canonical status file under a lock, writing a closeout, an index line, decisions, and convention proposals as side effects. Around that kernel sit three delivery surfaces that share it byte-for-byte: an MCP server (22 stateless tools over stdio; the host LLM executes phases), a Pi coding-agent extension (20 slash commands; phases run as isolated in-process sub-agents with a write sandbox, an auto loop, a live widget, and a dashboard), and the bare `.codecarto/` template for any file-capable LLM. Two adjacent subsystems reuse the kernel's state and YAML primitives: a versioned, git-friendly **library** of finished reimplementation specs that a forward-synthesis pipeline consumes, and **Broad-Side**, a paid batch-reconnaissance sweep over the OpenRouter Batch API whose output is explicitly unverified leads.

For a reimplementer the load-bearing insight is that the product's real wire protocol is markdown and a hand-rolled YAML subset: three text grammars the host LLM must satisfy and one YAML dialect every persisted file passes through (E3–E5, E22). The audit's high-severity defects cluster exactly there (scalar coercion, temp-name collisions, an unowned lock, a self-attesting validation gate, a stuck DAG that reads as "complete"), plus two packaging faults (findings copied by init, `.gitignore` not shipped) and Broad-Side's silent-default posture on the surface that cannot ask a human. None is architectural; all are design-out-able in a port that keeps the same contracts.

## Source Index

| Area | Canonical upstream section | Summary carried forward | Deep-read trigger |
|---|---|---|---|
| Architecture: layers, dependency direction, boundaries | `findings/architecture/architecture-map.md` §Layer Map, §Dependency Direction | 19 core modules, no internal cycles, Node built-ins only; two boundary breaches (`mcp-server` imports `extensions/…/dashboard-writer.ts`; wrappers bypass the barrel) — closed here as composition decisions | Only if the spec needs the exact import graph or module line counts |
| Architecture: runtime lifecycle, concurrency | same, §Runtime Lifecycle, §Concurrency Model; `findings/runtime-lifecycle/runtime-lifecycle.md` (all three dated sections) | MCP is stateless per call; Pi lifecycle and the `--auto` decision matrix; lock/rename discipline per state file | When an acceptance scenario needs a step the §Protocol and State Notes below compress (e.g. the exact Pi continuation prompt) |
| Architecture: build, packaging, CI | `findings/build-and-deploy/build-and-deploy.md` | tsc-only build, one npm package, tag-driven release, nightly smoke, five version-bearing files | If the port must reproduce the release pipeline rather than just the runtime |
| Contracts: per-operation behavior | `findings/contracts/behavioral-contracts.md` §Feature Contracts (16 tables), §TUI-only behaviors, §Storage formats | Summarized in §Feature Contract Table; error texts and defaults are **not** repeated here | Whenever the spec writes an acceptance scenario for a specific operation's error text, defaults, or refusal order |
| Contracts: acceptance list, security model, doc conflicts | same, §Black-Box Acceptance List (32), §Security and Authorization, §Doc/Test Conflicts (11) | The 32 scenarios are the seed of the spec's acceptance suite; the security model is "no auth, absolute cwd, Pi sandbox" | Always, for the acceptance section of the spec |
| Protocols: grammars, schemas, envelopes | `findings/protocols/protocols-and-state.md` §Event Catalog E1–E22 | Compressed in §Protocol and State Notes; grammars E3–E5 and dialect E22 restated there in full because they are the contract | For field-level schemas (E6 handoff, E8 status, E18 library, E19 batch, E20 state) |
| Protocols: state machines, persistence, version axes | same, §State Machine SM1–SM7, §Persistent Schema Notes, §Compatibility Hazards; `findings/state-and-storage/state-and-storage.md` (three dated sections) | SM3 (completion transaction) and SM4 (question/carry-forward lifecycle) restated; the six version axes restated | For SM6 (Broad-Side) and SM7 (library publish) detail |
| Public surfaces, config | `findings/public-surfaces/public-surfaces.md` (three sections), `findings/config-model/config-model.md` (three sections) | Tool/command inventories, parity table, structuredContent keys, config keys and precedence | For the exact tool argument lists or config key semantics |
| Defects | `findings/defect-scan-mechanical/mechanical-defects.md` (40), `findings/defect-scan-semantic/semantic-defects.md` (38), both with §Runtime probes | Reconciled in §Defect Synthesis (11 high, 27 medium roots, low groups) with dispositions | For a defect's full evidence cell, probe transcript, or the exact line ranges when writing the normative rule and its test |

Conflicts and gaps the index must not hide: (1) the two defect reports overlap on three items (mech 1.3/6.2/6.3 restated as sem 5.13/5.14/5.15) — reconciled below; (2) `MANUAL.md` and `GUIDE.md` disagree about whether an LLM may write `status.yaml` (contracts §Doc/Test Conflicts #3, sem 5.5); (3) OpenRouter and Pi SDK shapes remain `[external]` (`q-openrouter-batch-envelope`; contracts §High-Value Behaviors for what the SDK source did settle).

## Layer Map With Ownership

Concept names, not source names; the "source today" column is for tracing only.

| Layer / Module | Role | Owns | Source today |
|---|---|---|---|
| **Workspace store** | persistence / state | canonical status document, its normalization, the owned lock, atomic writes, pipeline selection, scaffold copy/refresh/version marker | `core/status.ts`, `core/workspace.ts`, `core/types.ts` |
| **Document dialect** | protocol / normalization | the YAML subset read and written everywhere (E22) | `core/yaml.ts` |
| **Pipeline engine** | core semantics | DAG walk (next eligible phase), phase resolution by id or output name, alias table | `core/pipeline.ts` (walk half) |
| **Artifact validator** | core semantics | validation-block parse (E3), findings cross-checks (E5), coverage ledger parse (E4), secondary-output visibility | `core/pipeline.ts` (parse half), `core/findings.ts`, `core/coverage.ts` |
| **Handoff and completion gate** | core semantics | handoff parse, closure-integrity rules D1/D3, target-phase check, PARTIAL→question, the completion transaction (SM3), closeout/index/decision/convention writers, terminal routing lines | `core/completion.ts`, `core/status.ts:parseHandoff/applyHandoff` |
| **Prompt assembler** | core semantics | the phase prompt (E2) and skill prompt, orchestrator-duties block, synthesis preflight context, auto-mode variant | `core/prompts.ts`, `core/synthesis.ts` |
| **Post-pipeline amendment** | core semantics | amendment parse and apply under the same lock | `core/amendment.ts` |
| **Config resolver** | persistence (config) | two-layer library/orchestrator config, tilde expansion, `writeLibraryConfig` | `core/orchestrator-config.ts` |
| **Usage ledger** | persistence | append-only run log and totals | `core/usage.ts` |
| **Guide server** | integration adapter | packaged driving guide by topic | `core/guide.ts` + `agent-skill/` |
| **Dashboard renderer** | UI / rendering | pure HTML from state; I/O wrapper gathers inputs and writes atomically | `core/dashboard.ts`; `extensions/codecarto/dashboard-writer.ts` (shared by both surfaces) |
| **Spec library** | persistence / state | marker, versioned entries, `latest` pointer, derived index, publish guards, provenance conflicts, git probes | `core/library.ts` |
| **Batch reconnaissance (Broad-Side)** | integration adapter | lens registry and schemas, repo slicing, cost pre-flight, OpenRouter batch client, state/run files, synthesis/triage post-passes | `core/broadside.ts` |
| **MCP shell** | product shell | 22 tools, argument validation, dual-payload result envelope (E1), error-code mapping | `mcp-server/server.ts`, `bin.mjs` |
| **Pi shell** | product shell + UI | 20 commands, activation gate, tool sandbox, status widget/line, agents widget, phase sub-agent runner, auto loop, LLM steering, narrator, headless notify fallback | `extensions/codecarto/*` |
| **Template (data)** | data | GUIDE, pipelines, skills, templates, pass files — the ABI every module above reads | `.codecarto/` (out of review scope) |

### Composition decisions (closes arch-CF2)

- The **dashboard I/O wrapper** is core-shaped and consumed by both shells; a port places it with the dashboard renderer in the shared layer, not under a shell. `[fact: arch §Dependency Direction; sem 3.2 shows it shares the temp-name root]`
- The barrel-bypass imports are harmless in the source (no cycles, `[fact: arch]`) and carry no behavior; a port defines the shared layer's public API once and has both shells consume only that.
- A **state-store primitive** (owned lock + unique-suffix atomic write + single serializer) must exist as one module in the shared layer; the source has the same three-line pattern copied into eight writers (sem 3.2; sem-CF1 closed here).
- The kernel is buildable without either shell: nothing in the shared layer imports a shell except the dashboard wrapper noted above `[fact]`.

## Feature Contract Table

Surface column: `MCP`, `Pi`, `both` (same core path), `drop-in` (template-only). Priority is for a first viable port of the analysis pipeline; library and synthesis are `important` only if the port targets those workflows. Defect references point at §Defect Synthesis ids.

| Feature | Surface | Priority | Key Contracts | Notes |
|---|---|---|---|---|
| Workspace init (template copy, pipeline choice, seed orchestrator files) | both | core | contracts §Init; init exclusion set; backup on force/confirm | D-H2 (copies live findings), D-M17 (resets status on the template itself) |
| Open / status / next / phase | both | core | contracts §Open, §Status, §Next, §Forced phase; prompt shape E2; `getNextEligiblePhase` | D-H6 (stuck DAG reads as complete); D-M1 (switch cursor) |
| Validate | both | core | E3 grammar exactly; E4 ledger; E5 cross-checks and scaffold gates; NOTE lines for secondary outputs | D-M9 (Overall decoration), D-M27 (docs overclaim what validation is) |
| Complete (handoff gate + transaction) | both | core | contracts §Complete refusal list; E6 handoff schema; SM3 ordering; SM4 closures; E9–E11 side-effect formats; idempotence | D-H4/H5 (write primitive, lock), D-M20 (artifact ordering), D-M3 (PARTIAL duplicates) |
| Switch pipeline | both | important | carry statuses; recompute cursor; preserve post_pipeline | D-M1, D-M2; MCP dashboard gap D-M24 |
| Skills (list/run, `broadside` exemption) | both | important | completion gate; name resolution | D-M21 (name traversal) |
| Guide by topic | both | important | whole document, topic footer; Pi framing | — |
| Refresh scaffold | both | important | protected-set semantics; THREAD_LOG line | low (atomicity) |
| Amend | both | important | refusal while incomplete; idempotent closures; rebuilt terminal actions | — |
| Usage log and report | both | optional | E12 shape; MCP receipts zeroed | D-M7 (unlocked/corruptible/colliding) |
| Dashboard | both | optional | self-contained HTML; relative links only; JSON island | D-low (session links never render) |
| Config resolve/show | both | important | layer precedence; malformed layer dropped | D-M8, D-M12 |
| Library init/publish/list/reindex | both (list/reindex MCP-only) | important† | E18 format (ABI); publish guards; idempotence by hash; confirm gate | D-M18 (publish race), D-M4 (list filter), D-M15 (init flips gate) |
| Synthesis preflight | both | optional† | vision/library/proposal checks; confirmed selection grammar | — |
| Broad-Side submit/collect/status/models | both | optional | E19/E20; SM6; cost pre-flight; resumable collect; Pi asks, MCP refuses | D-H8..H11, D-M5, D-M6, D-M13, D-M14, D-M23 |
| Pi phase sub-agent + auto loop | Pi | important (Pi parity) / optional (other hosts) | isolated session, tool allowlist, continuation prompt, decision matrix, summaries | D-M19 (sessions never disposed), D-M25 (ctx reads) |
| Pi write sandbox and activation gate | Pi | core (for any host that lets the LLM write) | bash blocked; edit/write confined to `.codecarto/` + marker-validated library; refuse before init/open | D-H1 (symlink bypass), D-M22 (prompt splicing is the other half of the trust boundary) |
| Pi widgets, notify fallback, steering, narrator | Pi | incidental | headless stderr fallback is the one behavior worth keeping | — |
| Drop-in template | drop-in | core (data) | copied verbatim; GUIDE is the contract | D-M26 (MANUAL contradicts GUIDE) |

† important only when the port targets the library/synthesis workflows.

## Protocol and State Notes

What a reimplementation must preserve, compressed from protocols E1–E22 and SM1–SM7 (all `[fact]` unless marked):

- **Validation block (E3).** Anchor on the *last* `## Validation` heading; a criterion row is any table row with ≥ 4 cells whose first cell is neither `#` nor a separator; `**Overall:**` must be exactly `PASS` or `PASS WITH GAPS` after trim/uppercase; a `FAIL` anywhere in a Result cell fails; `PARTIAL` rows become gaps and later auto-questions. Port decision: keep the grammar (the templates and every existing workspace depend on it) but make the Overall parse tolerant of trailing decoration and say *why* a parse failed (D-M9).
- **Coverage ledger (E4).** `## Coverage and limits` with five fixed bullet labels; continuation and sub-bullets fold; only `Skipped scope` and `Known blind spots` of completed phases travel into later prompts.
- **Findings tables (E5).** Any table whose header contains `evidence level` and `action`; unsettled evidence (`open question`, `external-behavior claim`) may not pair with `fix before porting`/`fix now` (error at scaffold ≥ 0.17.1); `observed fact` + `verify at runtime` warns; unsettled rows with an empty Open Questions table warn.
- **Phase prompt (E2).** Fixed section order; byte-identical across surfaces (a test pins it); routed items and duties are mechanically surfaced, capped at 10 each. Port decision: delimit spliced upstream text (D-M22).
- **Handoff (E6) and amendment (E7).** `schema_version ≤ 1`; arrays default empty; ids auto-assigned `oq-<phase>-N`/`cf-<phase>-N`; `target_phase` must be later in `phase_order`; D1 (`derives_from` question must be closed in the same handoff) and D3 (`needs-runtime-test` closure needs `evidence`, gated at scaffold ≥ 0.19.0); all refusals before the lock.
- **Status document (E8, SM1, SM2).** Schema 1 gated both ways; phases only ever go `pending → complete`; the cursor is the first non-complete phase with complete deps, `complete` when none — **but "none eligible" must be distinguished from "all complete"** (D-H6).
- **Completion transaction (SM3).** Gates → lock → re-validate → build status → *artifacts* → *status rename* → release. Port decision: rename first or make artifacts idempotent-after (D-M20).
- **Side-effect formats (E9–E11).** THREAD_LOG line `- <date> — <phase> — <summary> — [closeout](closeouts/<file>)` deduped by link; closeout overwritten per phase (latest by date); `D<NNN> |` rows numbered from the max visible; pending-convention bullets `- **name** (phase, date) — rule`. Dates are UTC host time.
- **YAML dialect (E22).** Read: block collections, three quoting styles, comments, six block-scalar forms in values and items, duplicate-key rejection, prototype-safe keys, item nesting at the item's content column; not flow collections, anchors, plain multi-line scalars. Write: bare for `[A-Za-z0-9_./-]+`, JSON-quoted otherwise, `-` + indented mapping for objects. **Port decision (closes proto-CF2):** the *read* side must stay a superset of this dialect for every existing workspace, library, and config file; the *write* side may change only if the tests that pin emitter bytes are re-pinned and `docs/library-format.md` §YAML dialect is updated; and the emitter must quote any string the reader would coerce (D-H3).
- **Preserve byte-for-byte:** library on-disk format (marker JSON, `metadata.yaml` keys, `index.yaml`, `INDEX.md` table shape, `latest` as a regular file), status/handoff/amendment schemas, the `.codecarto/` template paths (ABI for every workspace), the THREAD_LOG/DECISIONS/CONVENTIONS line formats, Broad-Side `state.json` and run-dir names. **May re-encode:** the usage log, the dashboard data island, the catalog cache, Pi custom-message bodies, prompt wording (with the pinning test updated).
- **Version axes.** Six independent ones; only status and handoff/amendment gate; scaffold version thresholds 0.17.1 and 0.19.0 select rule strictness. Port decision: one declared policy per file, and check what you write (D-low catalog schema 2).
- **Broad-Side (E19, E20, SM6).** Requests are pure and re-submittable; `custom_id` = `<lens>-<module>[-n]`; batch statuses with a synthetic `timeout` that is *not* terminal; post-passes claimable across collects; merge-by-run-id persistence under its own lock. Peer shapes `[external]`.
- **Pi child protocol (E15–E17).** Event names and hook shapes are the SDK's `[external]`; the ctx is invalidated only by user session replacement/reload (contracts, settled on SDK source).

## Portability Hazards

| Hazard | Source Phase | Impact | Mitigation |
|---|---|---|---|
| Markdown grammars as the LLM-facing protocol (E3–E5) | protocols, contracts | A renderer that wraps cells, drops the leading pipe, or decorates `**Overall:**` silently fails validation | Keep the grammars; add a tolerant Overall parse with an explanatory error; ship the grammar as a documented contract with fixtures |
| Hand-rolled YAML subset with an asymmetric round trip (E22) | architecture, mechanical, protocols | Scalar-looking strings coerce (D-H3); layouts YAML allows are refused with a whitespace error (D-M10) | Quote on write whatever the reader would coerce; accept nested keys at any consistent indent; or adopt a real YAML library on the read side while keeping the emitter's bytes |
| O_EXCL lock file with mtime staleness and unowned release | architecture, semantic | Double acquisition after a stale break (D-H5); unreliable on network filesystems | Ownership token in the lock; release only one's own; document local-filesystem assumption |
| `<pid>.<ms>` temp names in eight writers | semantic | Same-millisecond writers lose data silently (D-H4) | One atomic-write primitive with a unique suffix; surface write failures |
| `rename` atomicity and Windows semantics | architecture | Rename over an open file differs | Same primitive; test on Windows |
| UTC host dates in closeouts/THREAD_LOG | protocols | Session-local dates differ from framework dates | Document; never match by date |
| Artifacts written before the status rename (SM3) | protocols, semantic | Log and closeout can assert an unrecorded completion (D-M20) | Reorder or make artifacts idempotent-after |
| Pi SDK: ctx invalidation, event shapes, `dispose()` | contracts, semantic | A port to another host has none of these; on Pi, sessions leak if not disposed (D-M19) | Treat as adapter concerns; dispose children |
| OpenRouter: key-ordered batch payload, `:batch` ids that exist in the catalog but are unsubmittable, unverified response shapes | protocols | `[external]`; a port must re-probe | Fixture capture (`q-openrouter-batch-envelope`); keep the pure-request invariant |
| MCP result envelope read differently by clients (`content` vs `structuredContent`) | contracts | A prose tool must carry text in both | Keep the dual payload; Codex preference `[open]` (`q-codex-envelope-preference`) |
| Surface parity (closes contracts-CF2) | contracts | Deliberate: Pi asks / MCP refuses; Pi executes `next`; Pi derives publish inputs; list/reindex MCP-only. Accidental: MCP switch without dashboard (D-M24), library-init path/tilde handling, config warning before activation | Port the deliberate ones as *adapter policy* ("can this surface ask?"), fix the accidental ones (D-M24 and lows) |
| Install-path-dependent `.gitignore` | mechanical | npm installs commit dashboards/usage logs; checkout installs ignore findings (D-H7, D-M16) | Ship the ignore file; decide once whether findings are committed |
| Template doubles as the framework's live workspace | mechanical | Init copies live findings (D-H2); tests are not hermetic (D-M11) | Init from a manifest or exclude outputs; tests copy a synthetic template |
| Git config leakage into recorded provenance | protocols | `url.insteadOf` rewrites `remote get-url` | Record both raw and normalized forms, or document |
| Dead protocol states (`running`, `partial`, `in-progress`, `resolved`) | mechanical, protocols | A port copying the types ports states no writer produces | Drop or implement each deliberately |

## Defect Synthesis

Reconciled from `mechanical-defects.md` (40 findings) and `semantic-defects.md` (38 findings) into one porting view: 78 findings → 11 high roots, 27 medium roots, and low groups. Overlaps (mech 1.3 ≡ sem 5.13, mech 6.2 ≡ sem 5.14, mech 6.3 ≡ sem 5.15, mech 2.3 + sem 3.3 + sem 3.2 sharing the usage-log root) are merged. Evidence: every row is `observed fact` unless marked; ten roots are probe-confirmed (mech §Runtime probes, sem §Runtime probes). No row carries `verify at runtime`: the two external-behavior questions in this run (`q-openrouter-batch-envelope`, `q-codex-envelope-preference`) produced no defect claim, so nothing here rests on an unconfirmed diagnosis; that vocabulary is preserved for the spec's Spike List, which will hold those two.

### High

| Defect ID | Source Report | One-line Description | Severity | Disposition | Required design consequence |
|-----------|---------------|----------------------|----------|-------------|-----------------------------|
| D-H1 | sem 4.1 (`core/utils.ts:57-68`; guards at `extensions/codecarto/index.ts:433-448`, `phase-compaction.ts:74-84`) | Write sandbox admits a not-yet-existing file under a symlinked directory inside `.codecarto/` (probe P1) | high | fix before porting | Containment MUST resolve the nearest existing ancestor with realpath and check the remaining tail; a symlinked ancestor outside the root fails. Acceptance: symlink-dir + new file → blocked. |
| D-H2 | mech 1.2 (`core/workspace.ts:137-182`) | Init copies findings outputs, handoffs, and the dashboard from the packaged template; a checkout install seeds every workspace with them and validation passes on them (18/696 tests fail once any phase exists) | high | fix before porting | Init MUST copy from a manifest of framework-owned paths (the refresh set) rather than the live tree, or exclude `findings/**` outputs, `scratch/`, `dashboard.html`. Acceptance: init from a template holding a finished phase → fresh workspace validates MISSING. |
| D-H3 | mech 1.1 (`core/yaml.ts:355-364`; `core/status.ts:229`) | Scalar-looking strings are emitted bare and re-parsed as number/boolean/null; a digit-named repo bricks the workspace (probe A2/B2) | high | fix before porting | Emitter MUST quote any string the reader would not return unchanged; normalizers MUST coerce with `String()` before `.trim()`. Acceptance: `project_name: "2048"` round-trips. |
| D-H4 | sem 3.2 (`core/usage.ts:88`, `core/library.ts:186,439,693,1208`, `core/workspace.ts:368,452`, `dashboard-writer.ts:58`, `core/broadside.ts:1691`) | `<pid>.<ms>` temp names collide within a millisecond; concurrent usage appends and a concurrent publish lose writes silently (probes P3, P4) | high | fix before porting | One atomic-write primitive with a unique suffix (counter or random); failures propagate. Acceptance: N concurrent appends → N runs. (Closes sem-CF1.) |
| D-H5 | sem 3.1 (`core/status.ts:424-426,433-437`) | Lock release removes whoever's lock is there; after a stale break the previous holder deletes the new holder's lock (probe P2) | high | fix before porting | Lock MUST carry an owner token and release only its own; stale-break MUST be logged. Acceptance: the P2 sequence leaves B's lock in place. |
| D-H6 | sem 5.1 (`core/pipeline.ts:37-49` as consumed by `completion.ts:496-500`, `server.ts:346-351,269-286,473-480`, `amendment.ts:141-147`, `status.ts:195-209`) | "No eligible phase" is treated as "pipeline complete" across completion, status, next, skills, amendments (probe P6) | high | fix before porting | The engine MUST return `{eligible: phase}` \| `{complete}` \| `{stuck: [phases with unmet deps]}`; every consumer handles `stuck`. Acceptance: P6 pipeline → status "stuck: b (depends on nope)". |
| D-H7 | mech 6.1 (`package.json` `files`; `npm pack --dry-run` = 0 matches) | `.codecarto/.gitignore` is not in the npm tarball, so npm-installed workspaces commit dashboards, usage logs (absolute session paths), and key-bearing config | high | fix before porting | The template manifest MUST include the ignore file; packaging test asserts it. |
| D-H8 | mech 6.3 ≡ sem 5.15 (`server.ts:1201-1204`, `index.ts:1175-1176`, `core/broadside.ts:2686`) | `wait_seconds: 0` on collect becomes the 25-minute default | high | fix before porting | Wrappers MUST pass explicit zero through; core MUST treat 0 as "read state, no poll". Acceptance: collect with 0 returns in < 1 s. |
| D-H9 | mech 6.2 ≡ sem 5.14 (`core/broadside.ts:1790`; `server.ts:1235,2329-2340`) | No spend cap by default on the surface that cannot ask | high | fix before porting | Ship a non-zero default `max_cost`; MCP refuses over it; explicit 0 means unlimited and must be spellable. |
| D-H10 | mech 2.1 (`core/broadside.ts:1756-1765,1790`) | A malformed Broad-Side config silently drops a configured cap and lens routing | high | fix before porting | A config file that exists but fails to parse MUST refuse a submit (and report the parse error); only an absent file yields defaults. |
| D-H11 | mech 2.2 (`core/broadside.ts:1657-1667,1735-1741`) | A corrupt `state.json` is read as empty and overwritten, orphaning paid runs | high | fix before porting | Never persist over an unparseable state file; keep a `.bak`; surface the corruption. |

### Medium

| Defect ID | Source Report | One-line Description | Severity | Disposition | Required design consequence |
|-----------|---------------|----------------------|----------|-------------|-----------------------------|
| D-M1 | mech 1.3 ≡ sem 5.13 (`core/workspace.ts:402-463`) | Switch resets `current_phase`/`next_actions` to the first phase despite carried completions | medium | fix before porting | Recompute the cursor after carrying statuses. |
| D-M2 | mech 1.4 (`core/workspace.ts:425-440`) | Carry-forwards targeting dropped phases dangle silently after a switch | medium | fix before porting | Re-route or surface dangling entries at switch time. |
| D-M3 | mech 1.5 (`core/completion.ts:467-480`) | Every PARTIAL row becomes a `needs-maintainer-decision` question even when the handoff routed the same gap | medium | port differently | Auto-questions only for PARTIAL rows whose evidence cell names no handoff entry, or none at all: the handoff is the routing. |
| D-M4 | mech 1.6 (`core/library.ts:925`) | `source_repo` list filter compares raw strings while everything else normalizes | medium | fix before porting | Use the same normalizer. |
| D-M5 | mech 1.7 (`core/broadside.ts:1188-1196,1493`) | File list from `git ls-tree HEAD`, contents from the working tree | medium | port differently | Snapshot from one source (HEAD blobs, or the working tree with untracked files) and record which. |
| D-M6 | mech 1.8 (`core/broadside.ts:1314-1325,1606`) | Unbounded `mainFile` read and a flat 6,000-char estimate for the architecture lens | medium | fix before porting | Cap the read; estimate from actual sizes. |
| D-M7 | mech 2.3 + sem 3.3 (`core/usage.ts:72-91`) | Usage log: unlocked read-modify-write, corrupt file overwritten, colliding temp names | medium (high root in D-H4) | fix before porting | Append-only file (one record per line) or the shared lock; never overwrite a corrupt log. |
| D-M8 | mech 2.4 (`core/orchestrator-config.ts:103-110`) | Malformed config layer silently dropped | medium | fix before porting | Report parse failures; `codecarto_config` shows them. |
| D-M9 | mech 2.6 (`core/pipeline.ts:151-157,184-186`) | Any decoration on `**Overall:**` → FAIL with an unhelpful message | medium | fix before porting | Tolerant parse; error names the line. |
| D-M10 | mech 2.7 (`core/yaml.ts:246-247,333-337`) | Valid YAML layouts rejected as "Invalid YAML indentation" | medium | port differently | Accept any consistent nesting indent; message names the construct. |
| D-M11 | mech 6.9 (`core/workspace.ts:33-37`; test init helpers) | Tests initialize from the live template; workspace state in the checkout fails 18/696 | medium | fix before porting | Tests copy a synthetic template (as `init-workspace-isolation` already does). |
| D-M12 | mech 6.4 (`core/orchestrator-config.ts:144`) | Relative `library.path` resolved against the process cwd | medium | fix before porting | Resolve relative to the config file's directory, or refuse relative. |
| D-M13 | mech 6.5 (`core/broadside.ts:1340,1170-1177`) | Unknown language → Go globs (silently scans nothing); `package.json` precedence misclassifies | medium | fix before porting | Explicit "unsupported language" refusal; manifest precedence by file counts. |
| D-M14 | mech 2.5 (`core/broadside.ts:1919-1931,2106-2113`) | Auth failure masked as pricing/timeout | medium | fix before porting | Surface HTTP status on catalog and poll errors. |
| D-M15 | mech 6.6 (`server.ts:937-939`, `index.ts:1401-1402`) | Library-init writes `publish_confirm: true`, flipping the MCP gate on | medium | port differently | Either document that init enables the gate, or write only what was asked. |
| D-M16 | mech 6.8 (`.codecarto/.gitignore:1-13`) | Findings gitignored in checkout installs → status/findings diverge across clones | medium | port differently | One policy: findings committed (default) with a documented opt-out. |
| D-M17 | mech 6.7 (`server.ts:192-197,229-241`; `index.ts:533-566`) | Init on the packaged template itself resets status without backup | medium | fix before porting | Treat `sameWorkspace` like any existing workspace (refuse/confirm). |
| D-M18 | sem 3.4 (`core/library.ts:588-726,933-993`) | Concurrent publishes to one slug race; loser gets a raw fs error | medium | fix before porting | Lock per entry; retry version assignment; typed error. |
| D-M19 | sem 3.5 (`agent-runner.ts:167-288`, rewriter, narrator) | Child sessions never disposed (`[inference]` on what dispose frees) | medium | fix before porting | Dispose every child after use. |
| D-M20 | sem 3.6 (`core/completion.ts:502` vs `workspace.ts:365-370`) | Completion artifacts written before the status rename | medium | fix before porting | Rename status first; artifacts after, idempotent. |
| D-M21 | sem 4.2 (`server.ts:457-492`, `index.ts:928-997`) | Skill name unvalidated → path traversal into the prompt (probe P5) | medium | fix before porting | Resolve names against `listSkillNames` only. |
| D-M22 | sem 4.4 (`core/prompts.ts:201-207,75-80`) | Upstream findings text spliced into later prompts undelimited | medium | port differently | Delimit and label spliced text as data; bound its size. |
| D-M23 | sem 4.5 (`core/broadside.ts:939-1098,1463-1517`) | Repository content uploaded without secret scanning | medium | port differently | Redaction pass (or opt-in allowlist) before upload; document. |
| D-M24 | sem 5.3 (`server.ts:316-341` vs `index.ts:645`) | MCP switch does not re-render the dashboard | medium | fix before porting | Dashboard refresh is a core completion/switch side effect, not a shell duty. |
| D-M25 | sem 5.16 (`auto-runner.ts:170,387`) | `ctx.cwd` read after a phase at two sites, captured elsewhere | medium | fix before porting | Use the captured cwd everywhere post-phase. |
| D-M26 | sem 5.5 (`MANUAL.md:136-158,235-239,247-252,271-272`) | Manual teaches the pre-0.12 hand-edit contract | medium | fix before porting | Rewrite drop-in guidance; state that drop-in mode has no completion executable. |
| D-M27 | sem 5.2 (`README.md:37`, `docs/mcp-quickstart.md:125`) | Docs describe validation as checking criteria; it parses self-attestation plus two cross-checks | medium | fix before porting | Docs say what the gate is; the spec keeps the gate honest by name. |
| D-M28 | sem 4.3 (`server.ts:704-708`) | Unvalidated relative `cwd` widens publish containment roots | medium | fix before porting | Validate `cwd` wherever it becomes a root. |

### Low (grouped by root; individual rows in the source reports)

| Group | Source rows | Disposition | Design consequence |
|---|---|---|---|
| Dead code and dead protocol states (`running`, `partial`/`in-progress`, `resolved`, `threadLogEntry`, `.github` exemption, unused args, unreachable emitter branches, unused `state.runs.push`) | mech 1.10–1.15, sem 5.9 | leave behind | Do not port; implement `resolved` only if amendments are meant to keep history. |
| Error observability (InternalError for user errors, generic dashboard failure, temp files left on rename failure, stale `latest` after partial publish, catalog auth masked, `timeout` for dead network, git without timeout, no cancel on long MCP calls, headless 30 s timer) | mech 2.8–2.11, sem 3.7–3.9, 3.11, 3.12 | fix before porting (message and code mapping) / leave behind (timers) | Map user-fixable failures to the client-visible error class; clean temp files; timeouts on subprocesses. |
| Config/environment lows (hardcoded operational constants, phase-id regex narrower than allowed ids, zero not expressible per call, `PACKAGE_VERSION` fallback, hand tilde expansion) | mech 6.10–6.14 | leave behind / fix before porting (regex, zero) | One constants module; one tilde helper; allow explicit zero. |
| Documentation drift (No JavaScript; default pipeline; four levels; mechanical scope; completion wording; session links; complete-tool description; folded scalars unreadable; `codecarto library-reindex`) | sem 5.4, 5.6, 5.7, 5.11, 5.12, 5.17 | fix before porting (docs) | Docs regenerated from the contracts; the library spec's YAML dialect section updated. |
| State-machine hygiene (three literal terminal-status arrays; catalog cache schema 2 unchecked; cache TTL refresh) | sem 5.8, 5.10, mech 1.9 | fix before porting | One terminal-status constant; per-entry TTL; check what you write. |
| Trust lows (`api_key` as a tool argument; repo-committed `library.path` widening the sandbox; no cwd allowlist; key in template config) | sem 4.6–4.9 | port differently / leave behind | Adapter policy per host; document the trusted-host posture. |
| Collect targets the last run only | sem 3.10 | leave behind | Add a run-id parameter if multi-run collection is wanted. |

## Observed Facts vs. Inferred Structure

### Observed Facts

- Both shells produce byte-identical phase prompts and validation results from one core (`tests/mcp-server.test.mjs:53-65`; contracts §Next).
- The completion gate refuses seven ways before any write and re-validates the output under the lock (contracts §Complete; SM3).
- The suite passes 696/696 on a pristine clone and 678/696 once the checkout holds one finished phase (mech §Runtime probes 1–2).
- Ten defect roots reproduce at runtime with one-line probes (mech A2/B2/C/D, sem P1–P6, `npm pack`).
- The Pi ctx is invalidated only by user session replacement or reload (SDK 0.85.1 source; contracts §High-Value Behaviors).
- The library format, status schema, and handoff schema are versioned; only the last two refuse anything (protocols §Persistent Schema Notes).

### Inferred Structure

- The system decomposes into a testable kernel (workspace store, dialect, engine, validator, gate, prompt assembler) and two adapter shells; nothing in the kernel needs a host `[inference: arch §Dependency Direction, confirmed by the tests driving core without either shell]`.
- The eight-writer temp-name pattern and the unowned lock are one design omission (no state-store primitive), not eight bugs `[inference: sem 3.1–3.2]`.
- The trust boundary that matters is "LLM output → files": the Pi sandbox is its only enforcement and the prompt-splicing path is its inverse `[inference: sem 4.1, 4.4]`.
- Broad-Side's silent defaults are a product of building the feature on Pi (which asks) and exposing it on MCP (which cannot) without re-deriving the defaults per surface `[inference: mech 6.2, 6.3, 2.1; contracts parity table]`.

## Domain Glossary

| Term | Definition | Where Used |
|---|---|---|
| Workspace | The `.codecarto/` directory inside an analyzed repository: template files plus project state and outputs | everywhere |
| Template / scaffold | The framework-owned subset of a workspace (GUIDE, pipelines, skills, templates), stamped with `scaffold_version` | init, refresh, staleness notice |
| Phase | One node of a pipeline DAG with a SKILL, template, primary output, and completion criteria | pipeline YAML, status |
| Pipeline / variant | A YAML DAG; eight ship, selected by alias | `PIPELINE_ALIASES` |
| Primary / secondary output | The phase's validated artifact vs. append-mode catalogs it may extend | validation, prompts |
| Validation block | The `## Validation` table + `**Overall:**` the LLM appends; the gate's input | E3 |
| Coverage ledger | The five-bullet `## Coverage and limits` section whose gaps travel forward | E4 |
| Handoff | The per-phase YAML a session writes to propose state changes | E6 |
| Completion | The framework transaction that applies a handoff under the lock | SM3 |
| Open question / carry-forward / post-pipeline | Unknown needing external evidence / routed to a later phase / deferred past the pipeline | SM4 |
| Closure integrity (D1, D3) | Rules refusing closures that outrun their question or lack runtime evidence | completion |
| Orchestrator duties | Boundary-time judgments (promote conventions, re-triage labels, sweep contradictions, route gaps) surfaced in the prompt | E2 |
| Closeout / THREAD_LOG | Per-phase markdown record / one-line index of records | E9 |
| Amendment | Post-pipeline closure file applied under the same lock | E7 |
| Library / entry / version / latest | Versioned spec store / one slug / `vN` directory / regular-file pointer | E18 |
| Provenance conflict | An entry whose versions record different repositories | library list/reindex |
| Broad-Side / lens / slice / post-pass | Batch reconnaissance / one analysis prompt type / one request's file bundle / synthesis or triage batch | E19, E20, SM6 |
| Evidence level / disposition | The five-value claim vocabulary / the four porting actions | everywhere |
| Drop-in | Using the template with no executable surface | MANUAL |

## Coverage and limits

- Inspected scope: the five primary upstream reports and five secondary catalogs in full (all written this run and re-read for synthesis); the two guide topics `deep-audit-synthesis` and `kernel-first-rewrite`; the source lines cited in §Defect Synthesis re-checked where a disposition depended on them (`core/pipeline.ts:37-49` consumers, `core/completion.ts:496-502`, `core/workspace.ts:365-370`).
- Skipped scope: no new source reading beyond the citations above; `docs/ROADMAP.md`, `docs/synthesis-roadmap.md`, `docs/design-synthesis-phases.md`, `CONTRIBUTING.md` remain unread (inherited from contracts); the synthesis pipeline and post-pipeline skill are represented only by their preflight contracts; Broad-Side lens prompt wording is not synthesized.
- Evidence basis: upstream findings (primary); source inspection for the cited lines; runtime verification inherited by citation (mech and sem §Runtime probes); tests by citation.
- Known blind spots: (1) the OpenRouter and Pi SDK sides remain `[external]` (`q-openrouter-batch-envelope`, and the SDK's resource semantics behind D-M19); (2) Codex's envelope preference `[open]`; (3) the drop-in surface's behavior is the GUIDE's text plus a contradicting manual (D-M26), with no executable to review; (4) severity for Broad-Side defects assumes the MCP posture, as declared upstream.
- Coverage disposition: COMPLETE as a compression boundary for the analysis pipeline, library, and Broad-Side; PARTIAL for the synthesis pipeline's phase-level behavior, inherited as declared.

## Open Questions

None new. Carried: `q-codex-envelope-preference` (needs-runtime-test, contracts) and `q-openrouter-batch-envelope` (needs-fixture-capture, protocols); both become Spike List entries in the spec. Neither underlies a defect disposition.

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| — | — | — | — |

## Carry-Forward

Mirrored in `scratch/handoffs/porting.yaml`. Closed here: **arch-CF2**, **contracts-CF2**, **proto-CF2**, **sem-CF1**.

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| port-CF1 | reimplementation-spec | Strategic assumptions to classify before writing (kernel-first guide): platform (POSIX rename/O_EXCL assumed today), architecture inspiration (shape-only), stack lock (none — the user's instructions ask for the language-agnostic default in this run), build order (kernel-first with a fake-LLM acceptance harness). Record the variant in the spec front matter. | The Strategic Alignment Hook is the spec phase's own rubric; the user's run instructions pre-empt the interactive question. |
| port-CF2 | reimplementation-spec | The rings for this system: kernel = workspace store + dialect + engine + validator + gate + prompt assembler; ports = document store, lock, clock, LLM-facing text sink, subprocess; adapters = MCP shell, Pi shell, git, OpenRouter, dashboard I/O; extensions = library, synthesis, Broad-Side, steering, narrator; delivery = MCP stdio, Pi TUI, headless, drop-in. Each high defect maps to a named acceptance test in the harness. | Ring assignment and milestone order are the spec's deliverable, not the bundle's. |

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | The system summary, layer map, contract table, protocol notes, and porting findings are synthesized. | PASS | §System Summary, §Layer Map With Ownership (15 concept rows + composition decisions), §Feature Contract Table (19 rows), §Protocol and State Notes, §Portability Hazards, §Defect Synthesis. |
| 2 | Portability hazards and open questions are separated from facts. | PASS | §Portability Hazards is its own table; §Observed Facts vs. Inferred Structure separates the two; §Open Questions names the two carried questions and states they underlie no disposition. |
| 3 | Feature importance is sorted for porting. | PASS | §Feature Contract Table Priority column (core / important / optional / incidental, with the † qualifier for library/synthesis). |
| 4 | Defect Synthesis consolidates mechanical-defects.md and semantic-defects.md with porting recommendations (fix before porting / port differently / leave behind / verify at runtime). | PASS | §Defect Synthesis: 78 findings reconciled into 11 high + 28 medium rows and 7 low groups, each with a disposition and a design consequence; overlaps merged and named; `verify at runtime` explained as unused because no disposition rests on an unsettled diagnosis. |
| 5 | Findings are marked with evidence levels. | PASS | Bracketed markers throughout; §Defect Synthesis states rows are `observed fact` unless marked, with D-M19 marked `[inference]`. |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits, all bullets filled; COMPLETE/PARTIAL split stated. |
| 7 | The Source Index makes the bundle a self-contained compression boundary and identifies targeted deep-read triggers. | PASS | §Source Index: 8 rows with canonical section, carried summary, and an explicit deep-read trigger each; conflicts listed beneath it. |

**Validated by:** 2026-09-11 (porting, self-audit session 1, inline MCP host)
**Overall:** PASS
