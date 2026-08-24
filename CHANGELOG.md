# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Broad-Side: per-language lens prompts** (#137). The defect and conventions lenses now build their system prompts from a language profile (Go, Python, Rust, TypeScript/JavaScript, plus a neutral default) instead of hardcoding Go idioms — a Python scanner no longer hears "goroutines without ctx"; it hears bare-except and context-manager checks. Convention extraction names language-appropriate categories (crates/modules vs modules/packages) and idiom hints. Language detection gains a `.js` bucket so JavaScript repos resolve to the TypeScript profile. Schemas are unchanged, so synthesis is unaffected.
- **Broad-Side: lens batches poll concurrently** (#136). Collect previously polled one lens at a time to completion, so the slowest lens serialized the wall clock for lenses that had already finished server-side. In-flight batches now poll in parallel against one shared deadline via the new `pollBatchesConcurrently` helper, with progress callbacks tagged per lens; results still save in deterministic lens order. The poll interval is now injectable, which the new peak-concurrency regression tests use to prove the parallelism without timing flakiness.
- **Broad-Side: batch reconnaissance over the OpenRouter Batch API** (#144). New `codecarto_broadside` MCP tool (actions: `submit`, `collect`, `status`) fires six single-turn analysis lenses — architecture, API surface, security, mechanical defect scan, convention extraction, porting — at any git repository as asynchronous batch jobs on a cheap batch model (~50% of sync pricing, unattended, 24h window), slices large modules by top-level directory, saves JSON plus rendered markdown to `.codecarto/broadside/<run>/`, and optionally synthesizes a cross-lens executive report. Works without an initialized workspace; needs an OpenRouter key via the `api_key` parameter, `OPENROUTER_API_KEY`, or `.codecarto/broadside/config.yaml`. Broad-Side findings are explicitly unverified scouting signals — file:line leads for the interactive pipeline to confirm, never evidence themselves. `codecarto_init` tolerates a `.codecarto/` that holds only `broadside/` (no force/backup needed), and scaffold refresh never touches broadside state, config, or results.
- **Broad-Side: expense guardrails and live per-model pricing** (#144). `config.yaml` now accepts `model`, `max_cost`, and `pricing.input_per_m`/`output_per_m` overrides, and the MCP tool accepts `max_cost` and `force` parameters. Before submitting, Broad-Side estimates the run cost from collected file sizes (≈4 chars/token) against the configured model's per-token pricing — looked up live from OpenRouter's model catalog (cached 24h), so models like `openai/gpt-5.2-pro:batch` at ~$84/M output are priced correctly, not at the default model's rates. A submit whose estimate exceeds `max_cost` refuses with a per-lens breakdown and creates no run entry unless `force: true`. The submit response now reports the pricing used and its source (built-in/config/live/cache).
- **Broad-Side: model catalog action and capability pre-flight** (#144). New `models` action lists every `:batch` model on OpenRouter — pricing per million tokens, context window, completion ceiling, structured-output support, and optional Artificial Analysis coding indices (via `GET /api/v1/benchmarks`, attribution preserved) — cheapest first with the configured model marked. Submits now pre-flight the chosen model against that catalog: lens `max_tokens` clamps to the provider's completion ceiling, deprecated models are flagged, and models that do not advertise structured-output support are refused outright, since every lens depends on `json_schema` response_format. The catalog cache is shared between the `models` action and submit-time pricing resolution.
- **Broad-Side: truncation detection with fence-tolerant parsing** (#144, #133). Lens output is now parsed tolerantly — markdown code fences are stripped before JSON parsing, mirroring the tolerance in OpenRouter's headless-agent scaffold. Parseable output is saved as clean JSON; output that still does not parse (the signature of a `max_tokens` cutoff) is saved verbatim but marked `truncated`. The collect summary and `run-meta.json` report truncation counts, and the synthesis prompt is told which modules are unrepresented rather than clean. Also documented the retry-safety invariant (batch requests are pure, resubmission always safe) and the distinction between Broad-Side's pre-flight `max_cost` estimate and OpenRouter's runtime cost accounting.
- **Broad-Side: triage pass** (#144, #135). Collect now runs a second cross-lens post-pass alongside synthesis (skip with `include_triage: false`): every finding is scored by impact × fix difficulty and turned into a prioritized work order — P0–P3 priority, effort estimate, per-module grouping, deduplicated leads, and explicit `omitted` notes for dropped items — saved as `triage.json`/`triage.md` and surfaced in the collect summary. The triage prompt frames the queue as a starting point for re-verification, never a commitment. Both post-passes submit as separate batches together and poll independently, and the state file tracks each so a resumed collect can finish whichever is still pending.

### Fixed

- **Windows: `writeLibraryConfig` no longer ENOENTs on parentless paths** (#128). The hand-rolled `includes("/")` separator check treated every Windows path as a bare filename, leaving `mkdir` a no-op before the write failed. Now derives the parent directory with `dirname()`.
- **`isWithinPath` accepts subpaths of filesystem roots** (#130). Appending a separator to an already-terminated root (`/` → `//`, `C:\` → `C:\\`) produced a prefix no real path starts with, rejecting every legitimate subpath. Trailing separators are now respected before prefixing.
- **`acquireLock` closes the lock descriptor when `writeFile` throws** (#131). A non-EEXIST write failure previously leaked the file handle until GC.
- **Phase continuation no longer burns the full compaction settle timeout** (#129). When a phase run ends without a compaction event, the pending compaction promise is now settled with `false`, so `waitForCompaction` returns immediately instead of waiting out `COMPACTION_SETTLE_TIMEOUT_MS` on every continuation.
- **Completion re-validates under the status lock** (#132). `completeValidatedPhase` now re-runs `validatePhaseOutput` inside the atomic status update; a stale PASS whose output changed since the caller's validation refuses to complete (and leaves status untouched) instead of completing a phase on evidence that no longer holds. Validations that never touched a file on disk (no `outputPath`) keep the legacy path, matching the synthetic-validation contract in unit tests.
- **Publish refuses to append one project's spec to another project's history** (#123). Slugs derive from the trailing path segment of `source_repo`, so `acme/whisper` and `openai/whisper` both produce `whisper`. Publishing the second wrote it as `v2` of the first: the entry's version history then spanned two unrelated codebases, and because `index.yaml` carries only the newest version's metadata, the index attributed the whole entry to whichever repo published last. `publishEntry` now compares the incoming `source_repo` against the one recorded on the newest version and fails before writing anything. The comparison is normalized across scheme, embedded credentials (`git@`, `user:token@`), `git@host:path` SCP syntax, a default port, a `www.` prefix, a trailing `.git`, repeated and trailing slashes, and separators, so re-publishing the same repository spelled differently is unaffected. A non-default port still distinguishes two services on one host. Casing is folded for hosts, forge-served repository paths and Windows drive paths, but not for absolute POSIX paths, where `/srv/Repos/tool` and `/srv/repos/tool` are two directories — Pi records the analyzed directory as `source_repo`, so local paths are the common shape on that surface. It is checked ahead of the content-hash branch, because a metadata-only update overwrote the wrong entry just as quietly. Unreadable or malformed recorded metadata skips the check rather than blocking the publish. `force_new_version` does not bypass it. A genuine repository move opts out with `allow_source_repo_change` (`allowSourceRepoChange` in `PublishOptions`). `docs/library-format.md` previously promised auto-suffixing (`-2`, `-3`) for this case, which was never implemented; it now documents the refusal instead.

## [0.16.0] — 2026-08-17

The field-test round. Immediately after 0.15.0 shipped, the same 7-phase deepseek-harness analysis was re-run on a fresh worktree through the published binary — this time with the driving chat as orchestrator — and the run's own gaps became this release (#111–#114): the very first completion appended decision rows without their promised heading, both full runs ended with no dashboard ever rendered, the analysis→publish→synthesis library loop was unreachable from any served text, and the terminal completion message named nothing actionable while skills, amendments, a publishable spec, and the usage log all sat unused.

### Fixed

- **Orchestrator-file headings are detected as visible lines, not substrings** (#111, #115). The decisions template *mentions* `## Completion log` in running prose, so the raw `includes()` presence check never inserted the real heading and `D<NNN>` rows glued to the template's closing sentence. All three heading-sensitive sites now share a line-anchored, comment-stripped check, and `countPendingProposals` counts bullets only below the real heading line so a prose mention cannot open the section early.

### Added

- **The dashboard regenerates on completion and amendment** (#112, #116). `codecarto_complete` and `codecarto_amend` refresh `.codecarto/dashboard.html` best-effort — exactly the two operations that change the numbers it shows. `writeDashboard` now reports whether a fresh render actually landed, results only claim refreshes that happened, a blocked dashboard path never fails the triggering operation, and the explicit `codecarto_dashboard` tool fails loud instead of claiming success over a swallowed render failure.
- **The library loop is discoverable** (#113, #117). New `library` guide topic covering the library anatomy, all four tools (`codecarto_library_init`, `codecarto_publish` with its content-hash idempotence and provenance fields, `codecarto_library_list`, `codecarto_library_reindex`), the publish moment at pipeline completion, and the distinction from the product-repo snapshot flow; the served overview now states the publish step where rewrites are discussed.
- **The terminal boundary routes to the post-pipeline surfaces** (#114, #118). Completing the last phase now writes dynamic `next_actions`: the skills surface always, `codecarto_amend` with live open-question/post-pipeline counts when work is pending, `codecarto_publish` when the pipeline produced a reimplementation-spec, and the dashboard/usage surfaces. `applyAmendment` rebuilds the list after closures so stored status never shows stale counts, and `codecarto_status`'s text view renders every stored action instead of only the first (#119). Previously one static sentence ("Review findings…") dead-ended every completed pipeline.

## [0.15.0] — 2026-08-17

The orchestrator round. A real 7-phase MCP-driven run (deepseek-harness) followed the workspace GUIDE's first-run role interview, correctly declined the orchestrator role — its user had asked one chat to drive every phase, which the old role definition forbade — and spent the whole pipeline in "degraded no-orchestrator mode": ~12 proposed conventions and 23 decisions stranded in closeout prose, a declared secondary output silently dropped, a mislabeled open question carrying a false premise through four phases into a wrong high-severity finding, four post-pipeline resolutions with no way to reach `status.yaml`, and a usage log reporting zero runs. Every change below is one of those failures made structurally impossible or mechanically visible (#97–#102).

### Changed

- **The orchestrator is defined by duties, not by who executes phases** (#97, #103). The workspace GUIDE's role model — orchestrator never executes phases, first-run role interview, human-paste thread mediation — contradicted the served skill's own role table and was written for the Pi sub-agent workflow, never updated for the MCP single-chat reality. The driving chat now IS the orchestrator by default; execution strategy (inline vs delegated) is orthogonal; the first-run interview is gone; "degraded no-orchestrator mode" is renamed the session-by-session fallback and reserved for explicit user opt-out or a model that cannot hold cross-phase context. New `orchestration` guide topic documents the duties and the four-phase label-propagation failure that motivates them.
- The maintainer release process now requires driving one real phase through each client surface — Pi, Claude Code, Codex, Hermes — against merged `main` before pushing a tag, pasting the actual tool returns into the release PR rather than checking a box. Added `docs/client-surfaces.md` recording how each surface reaches the framework and which MCP result field each client reads, with Codex's behavior marked unverified. Prompted by #94, which shipped a `codecarto_next` returning no phase prompt in one client and survived four releases because every test read the payload from the field the tests themselves chose.
- `buildPhasePrompt`'s `auto: true` may now differ from the interactive prompt by exactly one line on any phase (the orchestrator-duties header); previously auto was byte-identical outside the reimplementation-spec hook.

### Added

- **Mechanized orchestrator loop** (#98, #104). Handoffs gain optional `proposed_conventions` (`{name, rule, evidence?}`; malformed entries fail completion). Completion appends `decisions` to `DECISIONS.md` as numbered `D<NNN>` rows under `## Completion log` (numbering shared with curated categories, comment examples excluded, idempotent) and stages proposals in `CONVENTIONS.md` under `## Pending proposals` — promotion stays an orchestrator judgment. Phase prompts carry an "Orchestrator duties" block: pending-proposal count, open questions whose kind warrants label re-triage, the phase's declared secondary outputs with exists/missing status, and the contradiction-sweep instruction. Completion results carry an "Orchestrator checkpoint" line. `codecarto_init` and `/codecarto-init` seed `CONVENTIONS.md`/`DECISIONS.md`.
- **`codecarto_amend`** (#99, #105) — post-pipeline amendments from `scratch/amendments/<slug>.yaml`: close open questions resolved on evidence and retire finished `post_pipeline` items, under the completion lock, with an amendment closeout and THREAD_LOG entry. Refused while the pipeline is incomplete; idempotent on re-run. Ships `templates/amendment.yaml`; the spec-delta skill's closeout step now ends with the tool call. Template BACKLOG item B2.
- **`codecarto_refresh_scaffold`** (#102, #108, #109) — the executable form of the action every scaffold-staleness notice instructs: refresh framework-owned files from the packaged template without touching project state, user config, session outputs, or the orchestrator files. Both staleness notices now name the tool. Previously the only scaffold writer was `codecarto_init force:true`, which backs up the entire workspace.
- **MCP-driven runs reach the usage log** (#100, #106). `codecarto_complete` appends a completion receipt (`recorded_by: "mcp-complete"`, zeroed counters — MCP hosts execute phases in their own context and report no tokens); Pi-runner entries are tagged `pi-runner`; `codecarto_usage` says how many runs carry no token data so zeros read as unknowns, not free runs. Previously a fully completed 7-phase MCP run reported "No phase runs recorded yet."
- **Spike template and declared-output visibility** (#101, #107). `templates/spike-report.md` (Goal / Method / Measurements / Findings / Recommended Deltas) with the `scratch/spikes/<spike-id>/<scenario>.md` convention — template BACKLOG item B1 in its recorded smallest viable form. `codecarto_validate` gains a non-gating NOTE naming declared-but-unwritten secondary outputs (`ValidationResult.secondaryOutputs`).

## [0.14.1] — 2026-08-16

### Fixed

- Tools whose payload is prose returned nothing usable to MCP clients that read `structuredContent` in preference to `content` (#94). `codecarto_next` returned `{phase, forced}` and no phase prompt, making the pipeline undriveable in such a client; `codecarto_phase`, `codecarto_skill`, `codecarto_vision`, and `codecarto_guide` were affected the same way. `textResult` now carries the rendered text in `structuredContent` under a `text` key, so both client styles receive the payload. Tools whose `structuredContent` already carried their data (`codecarto_status`, `codecarto_validate`, `codecarto_complete`, the library operations) were unaffected and are unchanged apart from the added key.
- Four of the five predate 0.14.0. The existing gates could not see it: the smoke test and the unit tests both read `content[0].text` directly, so they confirm the payload exists without confirming it survives a client that reads the other field. A new test walks each tool's result and asserts the payload is reachable from `structuredContent` alone.

## [0.14.0] — 2026-08-16

### Added

- Agent skill for driving the server, shipped in the package at `agent-skill/codecartographer/` (SKILL.md plus references for pipeline selection, executor choice, the handoff contract, and phase recovery). Copy it into `~/.claude/skills/`, `~/.hermes/skills/`, or wherever your agent loads skills.
- Three further references covering what to do with a completed run, generalized from patterns proven in a third-party integration: `deep-audit-synthesis.md` (defect dispositions as porting inputs, hazards converted into normative rules and acceptance tests, reporting shape), `kernel-first-rewrite.md` (strategic-assumption classification, the kernel/ports/adapters/extensions ring model, fake-driven acceptance harness before adapters, milestone ordering), and `carrying-results-forward.md` (starting implementation from a completed spec, autonomy boundaries, and publishing a curated `docs/codecarto/` snapshot instead of the raw workspace).
- `codecarto_guide` MCP tool serving that same skill, so an agent with the server configured can learn the drive loop without installing anything. Takes an optional `topic`; every response lists the others. It needs no workspace — call it before `codecarto_init`.

### Changed

- `docs/mcp-quickstart.md` Step 3 now includes writing the phase handoff, which the canonical flow had omitted since v0.12.0, and points integrators at `codecarto_guide`.

### Why

Integrations were reverse-engineering the drive loop from tool descriptions because no specification shipped. At least one documented writing and repairing `workflow/status.yaml` directly and never mentioned `scratch/handoffs/<phase>.yaml` — guidance that fails outright against the v0.13.0 completion gate. The guide makes the contract explicit and versioned alongside the code that enforces it.

## [0.13.0] — 2026-08-16

### Security

- MCP `codecarto_publish` arbitrary file read via `spec_path`, second path (#76, PR #79). The v0.12.11 fix skipped its containment check when `allowedRoots` resolved empty, leaving the same arbitrary-read reachable in that configuration. Containment is now mandatory: an empty root set rejects rather than permits. Merged 2026-08-03, after v0.12.11 was tagged on 2026-07-23, and unreleased until now.
- Cleared four dependency advisories, including high-severity `undici` (response desynchronization, cache-directive disclosure, CRLF injection) and `ip-address` (SSRF and trust-boundary bypass via leading-zero octets, CIDR suffixes, and IPv4-mapped IPv6), by overriding `undici` to a patched 8.x (PR #82). `npm audit --omit=dev` reports zero vulnerabilities.

### Added

- Stale-scaffold detection (#85). The template now ships `workflow/scaffold-version.yaml`, stamped with the releasing version and asserted against `package.json` by the release-metadata tests. `codecarto_status` (MCP), the Pi status line, and the phase prompt warn when a workspace's scaffold has no marker (pre-marker scaffolds may predate the v0.12.0 handoff contract), is older than the running framework, or is newer than it. The phase prompt also stops listing `templates/phase-handoff.yaml` as a required read when the file is missing and instead warns that the scaffold predates the handoff contract, naming the handoff path completion will require and the framework-owned files to refresh. Warn-only: unversioned workspaces keep working.

### Changed

- The framework-owned-state invariant test now scans every instruction file a session reads — `templates/*.md`, `findings/*/SKILL.md`, `skills/*/SKILL.md`, `VALIDATE.md`, `GUIDE.md`, `NEW_THREAD_BLURB.md`, and `CONTRIBUTING.md` — instead of only the pipeline YAMLs and `NEW_THREAD_BLURB.md`. It matches both `status.yaml` and `workflow/status.yaml`, skips negated forms so prohibitions read naturally, and exempts post-pipeline skills from the `THREAD_LOG.md` rule (they never reach `completeValidatedPhase`, so they do own their closeout).

### Fixed

- The pre-v0.12.0 "write it into `status.yaml` yourself" wording survived #83 in the files a session reads while producing output: all five phase output templates, `closeout-template.md`, `thread-log-entry-template.md`, `VALIDATE.md` (including its worked PARTIAL example), `GUIDE.md`, and two SKILL.md files (#89). `templates/mechanical-defects.md` was the proximate cause of the routing loss reported in #84 — a real run echoed its "Mirror these into status.yaml" sentence into a validation Evidence cell and produced a prose table instead of state. All twelve sites now route through the phase handoff, `VALIDATE.md`'s worked example shows the handoff YAML and the `carry_forward_closures` closure path, and `thread-log-entry-template.md` documents what completion produces plus how to write a useful `closeout_summary`. Reads of `status.yaml` are unchanged.
- Shipped pipeline `handoff_requirements` still instructed agents to `Update workflow/status.yaml.` and `Append a summary entry to THREAD_LOG.md.` — the two edits the v0.12.0 handoff contract forbids, rendered into the same phase prompt that forbids them (#83). All 24 stale triplets across the six phase pipelines now route state through `scratch/handoffs/<phase>.yaml`, the deep-audit routing criterion targets the phase handoff instead of `status.yaml`, and `NEW_THREAD_BLURB.md` is rewritten to the handoff contract. A pipeline invariant test guards against the pre-v0.12.0 wording resurfacing.
- `completeValidatedPhase` silently completed phases with `carry_forward: []` and no agent-supplied `open_questions` when `scratch/handoffs/<phase>.yaml` was absent, even for phases whose pipeline declares `handoff_requirements` — severing the cross-phase routing channel for an entire run without a trace (#84). Completion now refuses with an actionable error naming the expected handoff path and minimal shape. Phases without `handoff_requirements` keep the lenient path, so custom pipelines are unaffected.
## [0.12.11] — 2026-07-23

### Fixed

- MCP `codecarto_publish` arbitrary file read via `spec_path` (security). The `readSpecArg` function accepted any absolute file path for `spec_path` without enforcing containment, allowing an MCP client to read any file on the filesystem (e.g. `/etc/passwd`). Added path containment check using `isWithinPathResolved`: `spec_path` must be within the workspace `.codecarto/` directory or the configured library path. Regression tests verify both rejection of paths outside allowed roots and acceptance of paths within the workspace. Discovered during the v0.12.9 self-analysis case study security triage.

## [0.12.10] — 2026-07-23

### Fixed

- Symlink sandbox bypass in `isWithinPath` (security). The Pi extension's tool-call sandbox used lexical path comparison (`resolve()`) without resolving symlinks, allowing a sub-agent to create a symlink inside `.codecarto/` pointing to a file outside the allowed root and write through it. Added `isWithinPathResolved` which uses `realpath` before comparison, and updated the Pi tool-call hook to use it. Regression tests verify both the vulnerability (documented) and the fix. Discovered during the v0.12.9 self-analysis case study, independently confirmed, and fixed with regression coverage.

## [0.12.9] — 2026-07-23

### Fixed

- Smoke test now includes all 18 MCP tools in EXPECTED_TOOLS, fixing the CI release workflow that was stuck at the smoke-test step since v0.12.5. The previous hardcoded list only had 10 tools and used `assert.deepEqual`, causing a hard failure when the server returned additional tools.

## [0.12.8] — 2026-07-23

### Added

- MCP `codecarto_open` tool — activate existing workspace without resetting state (parity with Pi `/codecarto-open`).
- MCP `codecarto_usage` tool — cumulative and per-phase token usage telemetry (parity with Pi `/codecarto-usage`).
- MCP `codecarto_dashboard` tool — regenerate `.codecarto/dashboard.html` (parity with Pi `/codecarto-dashboard`).
- MCP `codecarto_list_skills` tool — list available post-pipeline skills (parity with Pi `/codecarto-skill` with no args).

## [0.12.7] — 2026-07-23

### Added

- `/codecarto-vision` (Pi) and `codecarto_vision` (MCP) command to run a guided product discovery interview before the synthesis pipeline. A new `INTERVIEW.md` skill in `findings/vision-capture/` guides the LLM through structured questions (audience, problem, outcomes, scope, constraints, success measures) and writes a rich brief to `inputs/vision.md`. The Pi version is interactive (conducted in the orchestrator chat); the MCP version takes raw text and returns a prompt for the host's agent.

## [0.12.6] — 2026-07-23

### Added

- `/codecarto-library-init <path> [--namespace <name>]` (Pi) and `codecarto_library_init` (MCP) command to initialize a CodeCartographer library: creates the directory, writes the `.codecarto-library` marker, and writes the config. Idempotent — safe to re-run on an existing library. Closes the first-publish dead end.
- `/codecarto-config` (Pi) and `codecarto_config` (MCP) command to show the effective merged configuration (library.path, namespace, publish_confirm, llm_steer_next_phase) and whether the library marker was found.

## [0.12.5] — 2026-07-23

### Added

- `/codecarto-switch-pipeline <variant>` (Pi) and `codecarto_switch_pipeline` (MCP) command to switch the active pipeline in-place without losing findings, handoffs, usage data, closeouts, or phase progress. Phases that exist in both the old and new pipelines preserve their completion status. Replaces the README's broken advice to hand-edit `status.yaml`.

### Changed

- README pipeline switching instructions now point to the new command instead of telling users to hand-edit the framework-owned `status.yaml`.

## [0.12.4] — 2026-07-23

### Fixed

- MCP server handshake now reports `PACKAGE_VERSION` instead of a hardcoded stale `0.2.0` string that hadn't been updated since early development.
- `/codecarto-init` on an existing workspace now backs up the old `.codecarto/` to `.codecarto-backup-TIMESTAMP/` instead of permanently deleting it with `rm -rf`. The confirmation dialog now explicitly warns about data loss and suggests `/codecarto-open` as a non-destructive alternative. The MCP `codecarto_init` tool with `force: true` also backs up instead of deleting, and its tool description now enumerates what is affected.
- Synthesis preflight error messages now include actionable remediation guidance: the missing-vision error references `templates/vision.md`, the missing-library error includes an example config and marker JSON, the empty-library error names the commands to run, and the confirmed-selection error names the file to edit.

### Changed

- `/codecarto-publish` error messages for missing or misconfigured library now mention the required `.codecarto-library` marker file, not just the config path.

## [0.12.3] — 2026-07-22

### Fixed

- Single-shot `/codecarto-next` (without `--auto`) now auto-validates and auto-completes the phase after the sub-agent finishes, instead of leaving `status.yaml` stuck at `pending` and requiring the user to manually run `/codecarto-validate` then `/codecarto-complete`. The `--auto` loop already did this; the single-shot path now matches.

## [0.12.2] — 2026-07-22

### Fixed

- Corrected the case-sensitive MCP Registry namespace to match the GitHub organization owner grant, keeping `package.json`, `server.json`, and the README aligned.

## [0.12.1] — 2026-07-22

### Added

- Official MCP Registry metadata and release invariants that keep the registry server name, npm package, stdio transport, binary, version, and discoverability keywords aligned.

### Changed

- Repositioned the npm package and README around both evidence-backed reverse engineering and human-gated forward synthesis instead of describing the package as a Pi-only workflow wrapper.
- Added MCP, software-planning, code-analysis, and synthesis discovery metadata for the npm and MCP ecosystems.
- Removed stale README language that described the shipped library and synthesis workflows as development-branch or upcoming functionality.

## [0.12.0] — 2026-07-21

### Added

- Four-phase forward synthesis workflow (`vision-capture` → `goal-synthesis-propose` → `spec-merge` → `goal-synthesis-finalize`) for turning a product vision and reusable library specs into an implementation-ready `project-plan.md`.
- Runtime preflight gates shared by Pi and MCP: synthesis requires a completed vision brief and a valid non-empty library, while merge and finalization refuse to start until a user explicitly checks at least one proposal entry.
- Provenance ledger, conflict register, normalized merge artifact, synthesis templates, phase skills, and cross-surface regression tests.
- Structured per-phase handoffs under `.codecarto/scratch/handoffs/` for owner notes, questions, routed work, closure IDs, decisions, and closeout content.
- Status schema versioning with migration for v0.11 workspaces and rejection of unsupported future schemas.

### Changed

- Phase completion now owns canonical `status.yaml`, closeout, and `THREAD_LOG.md` updates, uses host-generated timestamps, rejects malformed handoffs and duplicate YAML keys, and remains idempotent across retries.
- Carry-forward targets are now limited to real downstream pipeline phases; optional spikes, amendments, deltas, decisions, and reruns live in a distinct `post_pipeline` backlog shown separately by status and the dashboard.
- Open questions now support canonical IDs (auto-assigned if missing), cross-phase deduplication by ID, and `open_question_closures` to atomically remove resolved questions from all phases during completion.

### Planned

- Dashboard library-state surfacing.
- `pipeline-spec-mutate.yaml` for applying deltas to an existing spec and republishing it as a new library version.

## [0.11.0] — 2026-07-20

### Added

- Phase-aware Pi compaction for isolated CodeCartographer phase sessions, with atomic continuation checkpoints under `.codecarto/scratch/checkpoints/`.
- Pi `/codecarto-open` command for safely attaching a new orchestrator session to an existing workspace without resetting phase progress.
- Backward-compatible compaction telemetry in local usage records, `/codecarto-usage`, phase summaries, the live widget, and the dashboard.
- Explicit `Coverage and limits` accounting in every phase template and completion rubric.
- Pipeline invariant tests that pin coverage accounting and the porting bundle's role as the final synthesis compression boundary.

### Changed

- `reimplementation-spec` now reads the porting bundle by default and deep-reads lower-level findings only for named gaps, conflicts, missing acceptance detail, or defect rationale.
- The porting bundle now includes a source index, targeted deep-read triggers, and explicit defect design consequences.
- Raised the Pi peer requirement to `^0.80.10`, migrated child-session construction to the current SDK, and refreshed transitive dependencies to patched Hono, Undici, and protobufjs releases.
- Updated GitHub Actions to Node 24-native action releases and added a high-severity production dependency audit gate.

### Fixed

- Packed-package MCP smoke tests now ignore lifecycle scripts and sanitize inherited npm `allow-scripts` configuration.
- Explicitly loaded phase-resilience and write-boundary guards into isolated child sessions, preserving phase-aware summaries, checkpoints, and read-only source safety when CodeCartographer itself was loaded with `pi -e`.
- Phase runners now retain telemetry during delayed post-tool compaction and recover runs that stop before their required output, using the durable checkpoint when compaction occurred.
- Declared primary-output checks reject path traversal and symlink escapes outside `.codecarto/`.

### Tests

- Test count: **191 → 207**.
- Added regression coverage for phase compaction, checkpoints, interrupted provider runs, nondestructive workspace recovery, output-path containment, coverage accounting, and bundle-first final synthesis.

## [0.10.0] — 2026-05-28

### Added

- **Polished dashboard health summary.** The generated `.codecarto/dashboard.html`
  now opens with a higher-signal Pipeline Health panel that summarizes overall
  status, phase completion, artifact gaps, open questions, carry-forward items,
  tool uses, runtime, and token availability before the detailed phase cards.
- **Dashboard issue surfacing.** Completed phases whose required primary output
  is missing are promoted into an attention-required health issue instead of
  being buried in the phase details.

### Changed

- **Token accounting now distinguishes unavailable data from zero usage.** When
  local usage records do not include token counts, the dashboard reports tokens
  as `unavailable` rather than showing a misleading numeric total.
- **Completed pipeline labels are friendlier.** `current_phase: complete` now
  renders as `Pipeline complete` in dashboard header metadata.
- **Activity and usage presentation is clearer.** The activity timeline and usage
  panels now include stronger visual grouping, kind chips, and summary cues while
  preserving the self-contained static HTML/no-network/no-framework contract.

### Tests

- Test count: **190 → 191**.
- Added dashboard regression coverage for health-panel missing-output escalation
  and completed-pipeline label rendering.

## [0.9.1] — 2026-05-25

### Fixed

- **Pi overlay is no longer always-on for repositories that already contain `.codecarto/`.** The CodeCartographer status widget, session label, safe-tool mode, and read-only tool policy now activate only after `/codecarto-init` runs in the current Pi session instead of auto-enabling on `session_start` whenever `.codecarto/workflow/status.yaml` exists.

### Tests

- Test count: **187 → 190**.
- Added regression coverage for Pi overlay activation gating.

## [0.9.0] — 2026-05-25

### Added

- **MCP library tools.** Three new tools on the MCP server expose the
  `core/library.ts` primitives to any MCP-capable host (Claude Code, Codex,
  opencode, Cursor, Claude Desktop):
  - `codecarto_publish` — publish a `reimplementation-spec.md` to a library
    with content-hash idempotence. Accepts inline `spec` or absolute
    `spec_path`. Derives the slug from `source_repo` if not provided. Defaults
    `pipeline` and `namespace` from `cwd`'s `status.yaml` / `config.yaml` when
    available. Accepts an optional `model_metadata` object so the host can
    record which agent + model produced the spec; omitted fields default to
    `unknown` and `generation.surface` is always `mcp-server`. Required:
    `source_repo`, `headline`, and either `spec` or `spec_path`.
  - `codecarto_library_list` — list library entries with optional filters
    (`namespace`, `tag`, `slug`, `source_repo`). Returns the full
    `LibraryIndexEntry` array in `structuredContent`.
  - `codecarto_library_reindex` — regenerate `index.yaml` + `INDEX.md`
    explicitly (useful after manual edits or to resolve a git merge conflict
    on `index.yaml`).
  All three tools resolve the library either from an explicit absolute
  `library_path` argument or from `library.path` in the workspace's or
  user-global `config.yaml`. 18 tests in `tests/mcp-library.test.mjs` cover
  derived-slug publish, idempotence, content-bump v2, the `generation:` block
  (defaults + host-passed values), `spec_path` flow, missing-field rejections,
  namespacing rules, filtered listing, and reindex round-trips.
- **Library format spec.** New `docs/library-format.md` documents the on-disk
  contract for the upcoming synthesis library: `.codecarto-library` marker file,
  versioned namespaced/single-tenant entry layout, `metadata.yaml` schema with
  `generation:` block (surface / agent / agent_version / model / model_vendor /
  reasoning), derived `index.yaml` + `INDEX.md`, content-hash-based version
  increments. Marked **experimental, may break before v2**.
- **`core/library.ts` (~840 LOC).** Library helpers used by both Pi and MCP
  wrappers — `discoverLibrary`, `readMarker` / `writeMarker`, `publishEntry`
  (content-hash idempotent, atomic temp-dir-then-rename, namespacing enforced
  per marker), `readEntry` (latest or specific version), `listEntries` (filter
  by namespace / tag / slug / source_repo), `reindex` (regenerates `index.yaml`
  + `INDEX.md` from filesystem state, sorted by `(namespace, slug)`),
  `commitPublish` (optional git commit, non-fatal on missing git). Cross-platform
  `latest` pointer is a regular file (not a symlink) containing the version
  directory name. Slug validation rejects bad names and reserved names
  (`latest`, `index`, `entries`).
- **Library config block in `core/orchestrator-config.ts`.** `CodecartoConfig`
  gains a `library:` section (`path`, `namespace`, `publish_confirm`). Two
  config layers now load: user-global at `~/.codecarto/config.yaml` (new) and
  per-workspace at `.codecarto/workflow/config.yaml` (existing). Resolution
  order is per-workspace > user-global > defaults. Library `path` values are
  tilde-expanded and resolved to absolute paths automatically. The existing
  `orchestrator.llm_steer_next_phase` toggle is unchanged. New
  `loadUserConfig()` reads user-global directly for onboarding flows.
- **`expandTilde` helper in `core/utils.ts`.** Expands a leading `~` or `~/`
  to the user's home directory. Used by the config loader; promoted to
  `core/utils.ts` so future user-facing path inputs can normalize the same way.
- **Surface-priority reframe in README + CLAUDE.md.** README install section now
  leads with Pi (recommended) → MCP (for other coding agents) → drop-in template
  (one-off / evaluation), with explicit "when to use this" framing per surface
  and a limitation note that library + synthesis workflows require Pi or MCP.
  CLAUDE.md keeps the code-architecture "three surfaces, byte-identical phase
  prompts" invariant intact and adds a `Surface priority` subsection
  documenting the user-facing ordering for new-feature UX work. The "At a
  glance" table and "Compatible environments" matrix are updated to match.
- **Synthesis implementation tracker.** `docs/synthesis-roadmap.md` lays out
  five milestones (M0 docs → M1 library foundations → M2 surface publish UX →
  M3 synthesis phases → M4 spec-mutate → M5 release polish) with checkboxes,
  dependencies, acceptance criteria, and risk notes. The original
  `docs/design-synthesis-phases.md` is kept as the historical record of the
  pre-revision design with a pointer at the top to the roadmap.

### Fixed

- **`/codecarto-next --auto` no longer wedges at `reimplementation-spec`.** The Strategic Alignment Hook (which asks the user whether the spec should be language-agnostic or opinionated) is now suppressed under `--auto`. The sub-agent defaults to **language-agnostic** (using `templates/reimplementation-spec.md`), tags the spec front-matter with `selection: auto-default` for later traceability, and captures any unresolved stack/name/scope choices as `open_questions` entries rather than blocking the run. Interactive `/codecarto-next` and `/codecarto-phase reimplementation-spec` paths still prompt the user as before. The fix threads a new `BuildPhasePromptOptions.auto` flag through `buildPhasePrompt` (in `core/prompts.ts`), propagated from `runAuto` → `runSinglePhase` → `buildPhasePrompt`; the MCP server byte-identical-prompt invariant is preserved (MCP still calls without the flag).
- **Release smoke test now tracks the v0.9.0 MCP tool surface.** `scripts/smoke-mcp.mjs` expects the new library tools alongside the workflow tools and now exits non-zero on setup failures before the first TAP step.

### Tests

- Test count: **119 → 187**.
- Added coverage for library primitives, library config loading, MCP library tools,
  phase resolution aliases, and the auto-mode `reimplementation-spec` prompt
  behavior.

### Notes

- Library and synthesis schemas remain **experimental, may break before v2**.
- Drop-in users still get full analysis-side functionality, but library publish /
  list / reindex require MCP in v0.9.0. Pi publish UX and project-plan synthesis
  remain future work.

## [0.8.0] — 2026-05-13

### Added

- **`/codecarto-next --auto`** runs the full pipeline end-to-end without manual intervention. For each next-eligible phase the loop spawns the sub-agent, auto-validates the output, and auto-marks-complete (mirroring `/codecarto-complete`'s `PASS`/`PASS WITH GAPS` rule). It advances until the pipeline finishes, validation reports `FAIL`/`MISSING`, the sub-agent errors, or the user aborts. Re-running `--auto` after a stop resumes from `getNextEligiblePhase` — `status.yaml` is the implicit checkpoint.
- **`--strict` modifier** (requires `--auto`) flips the `PASS WITH GAPS` rule: the loop pauses on PWG and emits a recovery hint telling the user to review the gaps and run `/codecarto-complete <phase>` manually before resuming with `--auto`. Default (without `--strict`) auto-advances on PWG.
- **`--auto` composes with `--llm-steer` / `--no-llm-steer`** as independent flags. `--auto --llm-steer` runs the rewriter on every phase transition; `--auto` alone leaves steering at the workspace-config default (`orchestrator.llm_steer_next_phase`).
- **`codecarto-auto-summary` custom message type** renders the run summary in the orchestrator transcript: heading (`complete` / `stopped at <phase>` / `aborted at <phase>`), stats (`⟳ N/M phases · X tokens · wall-time`), recovery hints for the stop and abort paths, and a dashboard link + skill suggestion for the complete path. Same `display: true`, no-`triggerTurn` discipline as the existing per-phase summary.
- **Tab completion** for `/codecarto-next` now suggests `--auto` and `--strict` alongside the existing `--llm-steer` / `--no-llm-steer`.

### Internal

- New `extensions/codecarto/auto-runner.ts` (~410 LOC) — owns `runAuto`, `runSinglePhase` (the awaitable phase-execution helper now shared between the one-shot `/codecarto-next` path and the auto loop), `autoCompletePhase` (programmatic `/codecarto-complete`, no UI notifies), `buildAutoSummary` (the markdown body for the new custom message), and `decideAfterPhase` (the pure per-iteration decision function — the testable seam for the validation matrix).
- **`/codecarto-next`** handler shrinks from ~150 lines to ~30. The inline phase-spawn chain (`runPhase` + post-runner `.then`/`.catch`/`.finally`) is replaced by `void runSinglePhase(...)`, keeping the one-shot path fire-and-forget for TUI responsiveness.
- **`/codecarto-complete`** handler delegates the atomic-status update to `autoCompletePhase` and keeps the UI notifies inline.
- **`extensions/codecarto/next-flags.ts`** gains `auto` / `strict` / `error` fields and the `--strict requires --auto` validation rule.

### Fixed

- **`ctx.signal` is now threaded through `/codecarto-next` to the phase sub-agent.** Previously the one-shot path didn't pass the signal to `runPhase`, so a user-initiated abort during a phase wasn't actually delivered to the sub-agent. The refactor that extracted `runSinglePhase` corrects this for both the one-shot and the new auto paths. Mid-phase aborts now actually cancel.

### Tests

- **`tests/auto-runner.test.mjs`** (10 tests) — the `decideAfterPhase` validation-decision matrix: aborted / errored / completed × `PASS` / `PASS WITH GAPS` / `FAIL` / `MISSING` × strict-on / strict-off, plus the "completed but validation missing" guard.
- **`tests/auto-summary.test.mjs`** (7 tests) — `buildAutoSummary` covers complete / stopped / aborted paths, skill-suggestion presence/absence, validation-summary block inclusion, the FAIL vs `PASS WITH GAPS` recovery-hint branches, and tabular token/duration formatting.
- **`tests/next-flags.test.mjs`** extended (+6 tests) — `--auto`, `--auto --strict`, `--strict` alone (error), `--auto --llm-steer`, `--auto --strict --llm-steer`, unknown-flag mixed with `--auto`.

Test count: **96 → 119**.

### Notes / deferred (target 0.8.x or 0.9.0+)

- **DAG-parallel auto mode** — `getNextEligiblePhase` returns one phase; parallel needs a `getEligiblePhases` variant and concurrent `runSinglePhase` calls.
- **Retry-on-fail** — `--auto --retry-failed N` with per-phase attempt counter + backoff.
- **Budget caps** — `--max-tokens`, `--max-turns-per-phase`, `--max-wall-time`.
- **Pre-phase confirmation prompts** — `--auto --confirm`.
- **Post-pipeline auto-skill chaining** — `--auto --then-skill <name>`.

## [0.7.0] — 2026-05-13

### Added

- **HTML dashboard.** `.codecarto/dashboard.html` is regenerated on every state change — `/codecarto-init` (initial empty render), `/codecarto-next` `.then`/`.catch` callbacks (after phase success or error), and `/codecarto-complete` (after a phase is marked done). The dashboard aggregates everything a human wants to see at a glance: project header (name / pipeline / current phase / last-updated / generation timestamp / package version), a pipeline-progress strip with per-phase status badges, collapsible per-phase cards (closed for complete, open for current/running) showing outputs / open questions / carry-forward / owner notes / last-run usage, an aggregate usage panel with per-phase breakdown, an activity timeline (newest 10 visible, older inside `<details>`), an open-questions roll-up grouped by source phase, a reverse-chronological closeouts list with relative-path links, and a footer with the package version. Self-contained: embedded `<style>`, no JavaScript, no external assets; works opened directly from `file://`. Light/dark via `@media (prefers-color-scheme: dark)`. Mobile single-column collapse at `<720px`. All disk-sourced strings (phase IDs, owner notes, open-question descriptions, carry-forward `target_phase`, closeout filenames, paths in href attributes) pass through `escapeHtml`.
- **`/codecarto-dashboard` command.** Manual regenerate (useful after editing `status.yaml` by hand) plus the `--narrate` flag for the opt-in LLM executive summary. Tab-completion suggests `--narrate`.
- **`/codecarto-dashboard --narrate` — opt-in LLM-narrated executive summary.** Runs the orchestrator's model as a one-shot in-memory `AgentSession` with `tools: []` (same pattern as the 0.5.0 rewriter), reads up to 3 most recent closeouts + status + usage totals, and produces a 200-400 word Markdown summary. The summary is cached to `.codecarto/.dashboard-narration.local.md` with a YAML frontmatter recording `generatedAt` and `phaseCountAtGeneration`. Subsequent deterministic re-renders surface the cached narration with a "(N runs since)" staleness note computed from the current completed-phase count. On any failure (no closeouts, session error, empty output) toasts the skip reason and proceeds with a deterministic render — never throws, never blocks.
- **`core/dashboard.ts`** (~430 LOC, pure). `renderDashboard(inputs) → string`. No I/O. The MCP server can adopt it later without touching the renderer.
- **`extensions/codecarto/dashboard-writer.ts`** (~120 LOC). Gathers inputs (fresh workspace state, usage log, closeouts directory listing parsed against the `closeoutFileName` regex from `core/prompts.ts:116`, per-phase output existence checks, narration cache + frontmatter parse) and atomic-rename-writes to `.codecarto/dashboard.html`. Failures are swallowed — same best-effort discipline as `recordUsage`.
- **`extensions/codecarto/dashboard-narrator.ts`** (~150 LOC). Opt-in narrator session; never throws.
- **`extensions/codecarto/dashboard-flags.ts`** (~25 LOC). `parseDashboardFlags` recognizes `--narrate`; collects unknown flags for caller to surface as errors.
- **`core/workspace.ts`** exports `PACKAGE_VERSION`, read once at module load from the same `package.json` that `findPackageRoot` locates. Used by the dashboard footer.
- **`core/utils.ts`** gains `formatTokenCount` and `formatMillis`. The renderer reuses them; the extension's existing `formatUsageTokens` / `formatUsageDuration` stay in place (they have slightly different output shapes that downstream call sites depend on).
- **Template `.gitignore`** picks up `dashboard.html` and `.dashboard-narration.local.md`. Both surface data from `workflow/.usage.local.yaml` (absolute Pi session paths); committing them would transitively leak those paths.
- **10 new unit tests in `tests/dashboard.test.mjs`** covering escape coverage, empty-state markers, full-state with HTML-special owner note (XSS guard), output-link presence vs missing, carry-forward `target_phase` rendering, open-questions roll-up grouping, usage panel totals, timeline visible/overflow split, narration staleness, and closeout reverse-chronological ordering. The `default-pipeline.test.mjs` command-registration invariant now requires `dashboard` alongside the existing 8 commands. Test count: **86 → 96**.

### Notes

- **Pi-only for v1.** The dashboard is tied to the sub-agent lifecycle, which only the Pi path runs. The MCP server returns prompt text for the host to dispatch and has no per-phase state changes to react to. The renderer lives in `core/` so MCP can adopt it later (deferred to 0.8.0+) by exposing a `dashboard` tool that returns the rendered HTML — trivial wrapper, just not on the critical path.
- **Hybrid LLM strategy.** The dashboard's "facts" (token counts, paths, status badges) are always deterministic — they read from disk on every regen. The "story" is opt-in: only `/codecarto-dashboard --narrate` produces a narrative, and that narrative is cached so subsequent deterministic re-renders preserve it across phase finishes until the next `--narrate`.
- **No JavaScript.** Collapsibles use `<details>`/`<summary>`. Keeps the file diff-friendly, tamper-evident, and viewable in any browser without script execution.

### Deferred (target 0.8.0+)

- MCP `dashboard` tool — trivial wrapper on `renderDashboard` returning the HTML string.
- JS-enhanced dashboard — sortable timeline columns, filter-by-phase, live-reload via filesystem-watch script.
- Per-run drilldown pages — clicking a UsageRun row opens `dashboard-run-<timestamp>.html` with the full transcript excerpt.
- Auto-narrate-on-finish config knob (`orchestrator.dashboard_narrate_on_finish`) mirroring `llm_steer_next_phase` for users who want fresh narration on every state change at orchestrator-side token cost.

## [0.6.1] — 2026-05-09

### Fixed

- **`--llm-steer` now surfaces its customized seed prompt in the orchestrator transcript.** Previously the rewriter ran silently — the only signal that anything happened was a transient "LLM rewriter customized X seed prompt." toast — and the rewritten prompt itself was visible only by `/resume`-ing into the phase sub-agent and reading its first user message. The user couldn't tell what the rewriter chose to emphasize, what prior findings it surfaced, or whether it had hallucinated something the closeout didn't say. `/codecarto-next` now injects the full customized prompt into the orchestrator's session via `pi.sendMessage({ customType: "codecarto-steering", display: true })` whenever the rewriter succeeds. The skip path keeps using a transient toast — those cases (no prior phase, missing closeout, empty output, rewriter session error) are uninteresting and shouldn't clutter the transcript.
- New `buildSteeringMessage()` helper in `extensions/codecarto/agent-rewriter.ts` (~20 LOC). Markdown header names the next phase and the closeout source (`from \`<prevPhase>\`'s closeout`); a horizontal rule separates header from the verbatim rewritten prompt. Same `display: true`, no `triggerTurn` pattern as the phase-completion summary, so the orchestrator's LLM picks it up as context on the user's next message but doesn't auto-respond.
- `RewritePhasePromptResult` gained a `prevPhaseId` field so the message header can name the closeout source. Backward-compatible (optional field).
- 4 new unit tests in `tests/agent-rewriter.test.mjs` covering the header naming, full-prompt embedding, missing-prevPhaseId fallback, and structural format. Test count: 82 → **86**.

### Notes

- The orchestrator's LLM now sees the rewritten prompt in context on the next user turn. That's bounded (~5–15k tokens for a typical phase prompt) and is the whole point of the visibility — the orchestrator can answer "what was the rewriter looking at?" without re-reading the closeout.
- Pi's default custom-message rendering is used (no registered renderer). The TUI shows `[codecarto-steering]` followed by the formatted block, the same way `[codecarto-phase-summary]` blocks render today.

## [0.6.0] — 2026-05-08

### Added

- **Per-phase usage tracking.** `/codecarto-next` now appends a record to `.codecarto/workflow/.usage.local.yaml` every time a phase sub-agent finishes (completed, aborted, or errored). Each record holds the timestamp, phase ID, status, turn count, tool-use count, duration, and full token breakdown (`input` / `output` / `cache_write`). Append failures are swallowed — local logging is best-effort and never escalates to a phase error the user sees.
- **`/codecarto-usage` command.** Reads the local usage log and renders cumulative + per-phase totals to the status widget and an info notification: total runs, total tokens (input + output + cache-write, k/M-formatted), total duration, total tool uses, and a per-phase breakdown sorted by appearance order. On a fresh workspace with no recorded runs, surfaces an explicit "No phase runs recorded yet." message.
- **`core/usage.ts`** (~115 LOC). `loadUsage`, `appendUsageRun`, `computeTotals`, `computePerPhaseTotals`. Schema is intentionally narrow (`{ version, runs: UsageRun[] }`); totals are computed on read so the file never holds a number that contradicts the runs. Malformed YAML and entries missing required fields fall back to the empty case rather than blocking the command. Atomic-rename write (`.tmp` + `rename`) so a crash mid-write can't leave a partial file.
- **Template `.gitignore` entry** for `workflow/.usage.local.yaml` — the file holds absolute Pi session paths and machine-local timestamps; useless to share, easy to leak by accident.
- **6 new unit tests in `tests/usage.test.mjs`** covering tmp-dir round-trips for missing/present/malformed YAML, totals math, per-phase grouping, and entry validation. The Pi-extension command-registration invariant test in `tests/default-pipeline.test.mjs` was extended to require `usage` alongside the other 7 commands. Test count: 57 → **63**.

### Notes

- This is the **observability** half of the orchestrator-experience plan. Pairs naturally with the phase-summary injection (Option A) and opt-in LLM steering (Option B), but doesn't depend on either — the usage log is populated regardless of what other features are enabled.
- The MCP server is unchanged. The MCP path returns prompt text for the host to dispatch and never runs sub-agents itself, so there's no per-phase usage to track on that side. `/codecarto-usage` is a Pi-only command.
- The schema carries a `version: 1` field. If the shape grows breaking later, bump the version and have `loadUsage` migrate or reject. For now everything is forward-compatible: extra keys are ignored, missing optional keys default to zero.
- "Best-effort" really means best-effort — a full disk, permission denied, or read-only filesystem will silently lose the record. The orchestrator's own model-side billing and Pi's own session log remain the canonical accounting; this file is a convenience.

## [0.5.0] — 2026-05-08

### Added

- **Opt-in LLM-steered seed prompt for `/codecarto-next`.** When enabled, the orchestrator's LLM is run as a one-shot rewriter that reads the previous phase's closeout + the next phase's stock prompt and produces a customized seed prompt that names the specific findings, open questions, and carry-forward items the next phase should pay attention to. Off by default. The user controls the trade-off (extra orchestrator-side tokens vs. context-aware customization) per workspace and per invocation.
- **Workspace config at `.codecarto/workflow/config.yaml`.** New file shipped in the packaged template with `orchestrator.llm_steer_next_phase: false`. Loaded by `core/orchestrator-config.ts` (`loadCodecartoConfig`); missing file or unrecognized keys fall back to defaults, so existing workspaces keep working unchanged. Malformed YAML is non-fatal — falls back to defaults rather than blocking the command.
- **Per-invocation flag overrides** for `/codecarto-next`:
  - `/codecarto-next --llm-steer` — force on for this run regardless of config.
  - `/codecarto-next --no-llm-steer` — force off for this run.
  - Unknown flags surface a clear error rather than being silently ignored.
  - Tab-completion: the slash-command argument completer now suggests `--llm-steer` and `--no-llm-steer`.
- **`extensions/codecarto/agent-rewriter.ts` (~140 LOC).** One-shot in-memory `AgentSession` with `tools: []` (no extensions, no skills, no prompt templates, no themes, no context files) on the orchestrator's model. Reads the latest closeout matching the previous-phase ID under `.codecarto/closeouts/` (truncates to 8 KB before passing to the rewriter to keep the cost bounded) and asks the rewriter to emit a customized seed prompt — Markdown only, no commentary. On any failure (no prior phase, missing closeout, rewriter session error, empty output) returns the stock prompt with a `skipReason` and a `warning` notification — the command never aborts because of rewriter trouble.
- **`extensions/codecarto/next-flags.ts`.** Small parser for `/codecarto-next` args; pure, exhaustively tested. Last-flag-wins resolution lets the user safely chain overrides.
- **12 new unit tests** — 6 in `tests/orchestrator-config.test.mjs` (tmp-dir round-trips for missing/present/malformed YAML, plus pure `mergeConfig` shape checks), 6 in `tests/next-flags.test.mjs` (override matrix, last-wins, unknown collection, whitespace tolerance). Test count: 57 → 69.

### Notes

- The rewriter is **opt-in by design** — Option B from the orchestrator-visibility plan. Option A (always-on phase-completion summary injection, no LLM call) ships separately and is independently toggleable. Run them together for full visibility + steered prompts; run only A for the cheap visibility win; run only B if you want steering without the summary.
- The rewriter prompt explicitly forbids inventing findings the closeout doesn't state and forbids changing the next phase's structure or completion criteria — guardrails against the "LLM rewriter wanders off" failure mode.
- Closeout truncation (8 KB) was chosen by inspection of the closeout-template stub — it leaves headroom for one or two long phase outputs, well under typical orchestrator context windows. Tunable in `agent-rewriter.ts` if needed.
- The new config schema is intentionally narrow (one knob). Future toggles should slot in alongside `llm_steer_next_phase` in the same `orchestrator:` block; `mergeConfig`'s "default-then-override" pattern means adding a key requires no migration.

## [0.4.0] — 2026-05-08

### Added

- **Phase-completion summary is now injected into the orchestrator's session.** When `/codecarto-next` runs a phase sub-agent to completion (or it aborts, or it errors), the extension calls `pi.sendMessage({ customType: "codecarto-phase-summary", display: true })` with a Markdown summary block. The block becomes a `CustomMessageEntry` in the orchestrator's session: it renders in the TUI scrollback so the user sees `Phase X finished. ⟳ 5 · 12 tool uses · 2.3k tokens · 1m30s`, and on the user's next message it shows up in the orchestrator LLM's context as a prior user message. No `triggerTurn` — the orchestrator does **not** auto-respond, which keeps the user fully in control of when the next action happens. Closes the gap between "phase ran" and "user can ask the orchestrator about it" without forcing a closeout-file read on every follow-up question.
- **`extensions/codecarto/agent-summary.ts` (~95 LOC).** Pure formatter — no I/O, no session manipulation. Owns the `buildPhaseSummary()` helper. Three header variants (finished / aborted / failed); error path includes the error message and skips the excerpt/trailer; completed path includes the response excerpt (truncated to 2000 chars with a "transcript truncated; resume the phase session" tail), the session file path with a `/resume` hint, and validate/complete next-step pointers. Sessions without a recorded `sessionFile` (e.g. resumed before 0.3.0's persistent-session change lands) just drop the transcript line and keep the rest.
- **7 new unit tests in `tests/agent-summary.test.mjs`** covering the header variants, the truncation path, zero-activity formatting, missing session file, and the k/M token threshold formatting. Test count: 57 → 64.

### Notes

- This is **Option A** from the orchestrator-visibility plan — always on, no LLM calls (so no extra orchestrator-side tokens), works regardless of whether the phase session is in-memory or persisted.
- Option B (opt-in LLM-steered customization of the next phase's seed prompt) is a separate change set, expected next.
- The `display: true` rendering uses Pi's default custom-message styling. Registering a dedicated `pi.registerMessageRenderer("codecarto-phase-summary", ...)` for codecarto-themed rendering is intentionally deferred — the default already reads cleanly and the TUI affordance can be tuned without an API change.

## [0.3.0] — 2026-05-08

### Changed (minor bump per pre-1.0 convention)

- **Phase sub-agents now persist to the same Pi session directory the orchestrator uses.** `extensions/codecarto/agent-runner.ts` swaps `SessionManager.inMemory(cwd)` for `SessionManager.create(cwd)`, which writes a JSONL file under `~/.pi/agent/sessions/<encoded-cwd>/`. Pi's `/resume`, `/tree`, and `/export` already read that directory, so phase transcripts become first-class browsable artifacts: open the picker and resume into a previous phase, view its tool-call tree, export to HTML, etc. — no codecarto-side plumbing needed. In-memory sessions left no trace once `/codecarto-next` returned, so the rich event stream rendered in the live widget vanished the moment the spinner aged out; this closes that gap.
- **Phase sessions are tagged for the picker.** Each spawn calls `sessionManager.appendSessionInfo("CodeCartographer phase: <id>")` so the session shows up in `/resume` with a meaningful name (rather than the default first-message preview), and rewrites the header with `parentSession: <orchestrator's session file>` so Pi's `SessionInfo.parentSessionPath` exposes provenance to any UI that wants to render lineage.
- **`PhaseRunResult.sessionFile`** added — the absolute path to the on-disk session JSONL. Useful for follow-on tooling (the planned `/codecarto-usage` command, downstream session viewers) that wants to point at a phase's transcript without rebuilding the path from `cwd`.
- **`runPhase()` signature** gained a `PhaseRunOptions` argument (currently `{ sessionName?: string }`) between callbacks and signal. The single internal caller (`/codecarto-next`) passes the phase ID-derived name; all other args remain backward compatible.

### Notes

- The session directory is shared between the orchestrator's TUI session and every phase sub-agent run — by design, so `/resume` lists them together. The `parentSession` header makes the relationship discoverable; the explicit `appendSessionInfo` name keeps them visually distinct from regular orchestrator sessions in the picker.
- Phase sub-agent session files are stored in `~/.pi/agent/sessions/`, **not** inside the project's `.codecarto/`. Nothing new lands in the repo's gitignore; existing Pi cleanup (the user's session-directory hygiene practices, if any) applies unchanged.
- 57/57 tests pass — no schema changes touch the on-disk workspace state.

## [0.2.1] — 2026-05-08

### Fixed

- **Agents-widget turn count now renders with a space** (`⟳ 5` instead of `⟳5`). The unspaced glyph collided with the digits on terminals whose font mapped `⟳` to a slightly wider cell than nominal, making the count hard to read at a glance.
- **Main status widget now refreshes when a phase sub-agent finishes.** The "Open questions / Carry-forward / Next" lines were stale until the user manually ran `/codecarto-status` (or any other command that re-rendered the widget), even when the sub-agent had written new findings, owner_notes, or carry-forward items into `status.yaml`. `/codecarto-next`'s `.finally()` now calls `refreshWorkspaceUi(ctx)` after the phase resolves, so the orchestrator's status widget tracks reality without user action. The `agent_end` handler already covered the orchestrator's own turns; this closes the gap for phase sub-agents whose lifecycle is independent of `agent_end`.


## [0.2.0] — 2026-05-07

### Changed (breaking — minor bump per pre-1.0 convention)

- **`/codecarto-next` now runs phases as in-process AgentSession instances with a live "Agents" widget above the editor.** Replaces the 0.1.3/0.1.4 session-switching design (which used `ctx.newSession()` and produced a context-isolated child but flipped the user's TUI to it, which was invisible during normal flow). The new path uses the SDK's `createAgentSession()` + `SessionManager.inMemory()` to spawn an isolated child session that runs in parallel with the orchestrator's TUI; the orchestrator's transcript stays clean and visible while the phase works. Architecture and event-subscription pattern adapted from `@tintinweb/pi-subagents` (forked into our codebase, not added as a dependency).
  - New `extensions/codecarto/agent-runner.ts` (~165 LOC): builds a `DefaultResourceLoader` + `SessionManager.inMemory()`, calls `createAgentSession`, subscribes to the session's event stream (tool start/end, turn end, message updates, message end usage), forwards events to caller-provided callbacks. The runner is fire-and-forget; `/codecarto-next` returns immediately.
  - New `extensions/codecarto/agent-state.ts` (~70 LOC): module-scoped `Map<phaseId, PhaseActivity>` tracking running and recently-finished phases. Mutated by runner callbacks; read by the widget.
  - New `extensions/codecarto/agent-widget.ts` (~265 LOC): persistent widget registered via `ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })`. Renders a tree of running and recently-finished phases with spinner, tool-use count, token usage, elapsed time. 80ms tick for animation; `tui.requestRender()` for active updates without re-registration. Auto-unregisters when no phase is active and finished phases have lingered out (~6.4s). Widget is torn down on `session_shutdown` to avoid leaking the timer.
- **Tier A (session-switching) code removed.** `core/orchestrator.ts` deleted; its `loadOrchestratorState` / `writeOrchestratorState` helpers are gone. `extensions/codecarto/index.ts` no longer reads or writes `.codecarto/workflow/.orchestrator.local.yaml`. `tests/orchestrator-state.test.mjs` deleted (7 round-trip tests no longer relevant). The gitignore entry for the local-state file remains in the template — existing 0.1.3 / 0.1.4 workspaces may have a leftover file on disk, and ignoring it keeps stale local state out of git.
- **Peer dep `@earendil-works/pi-coding-agent` pinned to `~0.74.0` (was `^0.74.0`).** Tilde locks the minor lane. `0.2.0` imports several SDK exports beyond the standard `ExtensionContext` surface (`createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `getAgentDir`, `AgentSession`, `AgentSessionEvent`); these are public top-level exports of the package's `index.d.ts` but the SDK is pre-1.0 and minor-version churn in those internals is plausible. The smoke test (`npm run smoke`) plus the daily cron in `smoke.yml` remain the safety net for future Pi minor bumps; consider unpinning once a major version of the Pi SDK lands and the API surface stabilizes.

### Notes

- Test count drops from 64 → 57 because the 7 `orchestrator-state` tests were deleted alongside the module they covered. The 57 surviving tests cover pipeline invariants, default pipeline shape, MCP server tool definitions, and documentation cross-references.
- The phase sub-agent inherits codecarto's tool-interception logic via `bindExtensions()` — `bash` is blocked, `edit`/`write` are confined to `.codecarto/`, same rules the orchestrator's TUI session has had since 0.1.0. The runner explicitly limits the child's tool list to `["read", "edit", "write", "grep", "find", "ls"]` as a defense-in-depth against tool drift.

## [0.1.4] — 2026-05-07

### Fixed

- **`/codecarto-next` no longer crashes with `extension ctx is stale after session replacement`.** The 0.1.3 sub-agent handler called `ctx.ui.notify(...)` and `setUiState(ctx, ...)` *after* `await ctx.newSession(...)` (and similarly after `ctx.switchSession(...)` on the phase-child path). Per the Pi SDK contract, the original `ctx` is invalidated as soon as the session-replacing call returns; touching it raises a runtime error that aborts the handler. The spawn itself succeeded — the child session was created with the phase prompt — but the post-spawn notification crashed loudly, making the feature look broken. Reordered: all outer-session UI updates (`lastFeedbackLines`, `setUiState`, `ctx.ui.notify`) now run *before* the session-replacing call; the `withSession` callback owns all post-replacement work via its own fresh ctx; the original `ctx` is never touched after the await. Same fix applied to the phase-child branch's `switchSession` plus the inner `orchestratorCtx.newSession` (which invalidates the outer `withSession` callback's ctx — so the inner spawn must be the last statement in that callback). The `result.cancelled` notifications were dropped from both branches since there's no live ctx to notify with on a cancelled spawn.

## [0.1.3] — 2026-05-07

### Added

- **Sub-agent orchestrator mode for the Pi extension.** When `/codecarto-init` runs from Pi, the current Pi session is recorded as the workspace's *orchestrator*; every subsequent `/codecarto-next` spawns the phase as a child session via `ctx.newSession({ parentSession })` instead of injecting the phase prompt into the current conversation. The phase's tool calls, file reads, and reasoning land in the child's own context window — the orchestrator only sees the phase entry/exit, not the work. When `/codecarto-next` is invoked *from inside* a phase child, the handler switches the TUI back to the orchestrator and chains the next phase atomically (single `ctx.switchSession({ withSession })` followed by `newSession`). The orchestrator pointer is written to `.codecarto/workflow/.orchestrator.local.yaml` (gitignored — it holds a machine-local absolute path to the Pi session file). Workspaces created by 0.1.0–0.1.2 have no orchestrator file and fall back to the legacy in-place phase prompt; re-run `/codecarto-init` to opt in. The MCP-server path is unaffected (it has no session concept; the host application is always the orchestrator). 7 unit tests added for the load/write round-trip.

### Changed

- **Release workflow now smoke-tests the packed tarball before publishing.** `release.yml` now runs `npm pack` after the unit tests, then exercises `scripts/smoke-mcp.mjs --tarball` against the resulting `.tgz` *before* `npm publish`. A failing smoke kills the run before anything reaches the npm registry — preventing the 0.1.1 class of bug where the build pipeline broke template resolution but the existing post-publish smoke (under `workflow_run`) didn't surface the failure visibly. Removed the `workflow_run: ['Release']` trigger from `smoke.yml`; the daily cron + `workflow_dispatch` paths stay in place to catch registry-side regressions caused by transitive-dep updates after publish.
- **`scripts/smoke-mcp.mjs --tarball <path>`**: smoke now accepts a local tarball as an alternative to `--version <ver>`. Same nine-step suite either way; `--version` and `--tarball` are mutually exclusive.

## [0.1.2] — 2026-05-07

### Fixed

- **`/codecarto-init` and the `codecarto_init` MCP tool now actually find the packaged `.codecarto/` template after install.** `0.1.1` shipped the template at the package root (`<package>/.codecarto/`) but the compiled `core/workspace.js` resolved its sibling directory via a single `..` from `dist/core/` — landing at `<package>/dist/.codecarto/`, which doesn't exist. Every `/codecarto-init` failed with `Error: Packaged .codecarto assets are missing.` (and the MCP path threw `McpError(InternalError)`). The 57/57 invariant tests pass against the source tree, so this only manifested after the build pipeline added in 0.1.1 — and the published smoke test was checking the response shape rather than the actual template-copy behavior. Replaced the fragile `..` walk with a `findPackageRoot(import.meta.dir)` that walks up to the first `package.json`, which lands on `<package>/` in both source and `dist/` layouts.
- **Remove `codecartographer-pi` self-dependency from `package.json`.** Running `npm install codecartographer-pi` from inside the repo (e.g., to verify a published artifact) caused npm to write the package as a direct dependency of itself. Left in, the `0.1.2` tarball would have nested a copy of `codecartographer-pi@0.1.1` under its own `node_modules/`, with the outer package's `bin` and `pi.extensions` paths potentially resolving against the wrong copy depending on host walk order.

### Changed

- Pin `@modelcontextprotocol/sdk` to `^1.29.0` (was `*`). The wildcard let `npm install` resolve to anything and made the npmjs.com dependency panel for `codecartographer-pi` link to the SDK's draft-spec docs. The pinned range covers SDK 1.29.x, which advertises MCP `2025-11-25` as `LATEST_PROTOCOL_VERSION` while still accepting `2024-10-07` through `2025-11-25` from clients.
- **Release workflow now creates a git tag and a GitHub Release on every publish.** Previously `release.yml` only ran `npm publish`, so the GitHub repo's "Releases" sidebar stayed empty. The workflow is now idempotent end-to-end: `npm publish` skips if the version is already on the registry, `gh release create` skips if the tag's release already exists. Notes for the GitHub Release are extracted from the matching `## [VERSION]` section of `CHANGELOG.md`. Permissions widened from `contents: read` to `contents: write` so the runner can create tags and releases.
- **Migrate Pi peer dependency from `@mariozechner/*` to `@earendil-works/*`.** The `@mariozechner/pi-coding-agent` package was deprecated upstream in favor of `@earendil-works/pi-coding-agent`; `pi update` now emits five deprecation warnings on every install. Switched our peer dep declaration and the one extension import (`extensions/codecarto/index.ts`) over to the new namespace at `^0.74.0`. Type names (`ExtensionAPI`, `ExtensionCommandContext`, `ExtensionContext`) are unchanged across the rename — drop-in replacement, no behavior change.

### Documentation

- README: explicitly document the MCP spec revision the package implements, and link to the released spec at `modelcontextprotocol.io/specification/2025-11-25`.
- **README: clarify Pi vs. MCP install paths.** Added `pi install npm:codecartographer-pi` as the primary install command for the Pi use case alongside the existing local-checkout and git-URL options, and added an explicit warning that plain `npm install codecartographer-pi` does NOT register the package with Pi (it has to be `pi install npm:...` so Pi writes it into its own `settings.json`). Plain `npm install` is still the correct command for the MCP-server use case.

## [0.1.1] — 2026-05-07

### Fixed

- **`codecarto-mcp` is now actually runnable when installed from npm.** `0.1.0` shipped TypeScript source files and relied on Node's `--experimental-strip-types` to load them at runtime. Node refuses to strip types from any file inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the bin failed to start on every Node version. Caught by the new end-to-end smoke test against the published artifact (PR #11).

### Changed

- Build pipeline added: `tsc` compiles `core/`, `extensions/`, and `mcp-server/` to `dist/`. The published tarball ships compiled JavaScript instead of TypeScript source. `prepublishOnly` enforces a fresh build at publish time.
- `package.json#bin.codecarto-mcp` now points at `./dist/mcp-server/bin.mjs`. `pi.extensions` points at `./dist/extensions`. `files` ships `dist/**/*` instead of the source directories.
- `mcp-server/bin.mjs` shebang simplified to `#!/usr/bin/env node` (no flags needed once the imports resolve to `.js`).
- `engines.node` lowered from `>=22.6.0` to `>=20.0.0`. The published artifact is plain JavaScript, so the `--experimental-strip-types` floor only applies to local development and CI.

### Notes

- TypeScript `^5.7` (specifically requires `rewriteRelativeImportExtensions`, introduced in 5.7) is now a `devDependency`. Consumers don't see it.
- The smoke test (`npm run smoke`) installs the published package into a temp dir and exercises the bin via the MCP SDK's stdio client. Daily cron in `.github/workflows/smoke.yml` will catch any registry-side regressions within 24 hours.

## [0.1.0] — 2026-05-06

Initial public release under the MIT license.

### Added

- **Framework core** (`core/`): pipeline state machine, YAML pipeline validators, prompt assembly, workspace utilities. Imported by both the Pi extension and the MCP server so phase prompts and validation logic stay byte-identical across surfaces.
- **Pi extension** (`extensions/codecarto/`): `/codecarto-init`, `/codecarto-status`, `/codecarto-next`, `/codecarto-phase`, `/codecarto-validate`, `/codecarto-complete`, and `/codecarto-skill` slash commands. Includes a footer widget showing the active phase and tool interception that blocks edits outside `.codecarto/`.
- **MCP server** (`mcp-server/`): seven tools mirroring the Pi extension (`codecarto_init`, `codecarto_status`, `codecarto_next`, `codecarto_phase`, `codecarto_validate`, `codecarto_complete`, `codecarto_skill`) so any MCP-compatible host (Claude Code, Claude Desktop) can drive a CodeCartographer workflow.
- **Default pipeline**: `pipeline-full-with-deep-audit.yaml` (7 phases). Splits the defect scan into a mechanical early pass and a semantic late pass so the reimplementation spec can design around defects with full contracts and protocols context.
- **Pipeline variants**: `architecture-only` (1 phase), `lite` (3 phase), `defect-scan` (2 phase), `full` (5 phase), `full-with-audit` (6 phase, single early defect scan), and `full-with-deep-audit` (7 phase, default).
- **Invariant tests** (`tests/`): default-pipeline, doc-mention, mcp-server, pipeline-invariants. Catch cross-wrapper drift between template, Pi extension, and MCP server.
- **CI** (`.github/workflows/ci.yml`): runs `npm ci && npm test` on every PR and push to `main`.
- **Documentation**: README with quick-start, pipeline variants, model-compatibility tiers, token-cost guidance; MANUAL for human users; per-phase SKILL.md and template files inside `.codecarto/`.

### Notes

- Node 20+ is required.
- The Pi runtime and `@sinclair/typebox` are peer dependencies — install them in your host environment, not as direct dependencies of this package.

[Unreleased]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.7.0...v0.8.0
[0.1.0]: https://github.com/HuginnIndustries/CodeCartographer/releases/tag/v0.1.0
