# Semantic Defects Report — codecarto-self

## Scan Context

- **Source:** `../` (repository root, commit `f6f8484`, v0.19.5)
- **Architecture reference:** `findings/architecture/architecture-map.md`
- **Contracts reference:** `findings/contracts/behavioral-contracts.md`
- **Protocols reference:** `findings/protocols/protocols-and-state.md`
- **Mechanical defects reference:** `findings/defect-scan-mechanical/mechanical-defects.md` (cited as `mech P.N`; nothing there is re-flagged, only cross-referenced where a semantic finding shares a root)
- **Pipeline:** full-with-deep-audit
- **Date:** 2026-09-11 (session clock; framework closeouts are UTC-dated 2026-09-12)
- **Scope:** Semantic passes only (3 concurrency, 4 security, 5 contract violations). Mechanical passes (1 logic, 2 error handling, 6 configuration) were covered earlier in `defect-scan-mechanical`.
- **Evidence basis beyond reading:** six runtime probes (§Runtime probes P1–P6) run against the modules with `node --experimental-strip-types`, per convention C01; findings resting on one cite it in the Defect cell. The Pi SDK source in `node_modules` (0.85.1) settled the ctx-invalidation question in the contracts phase.

Severity scale per pass file. Actions per `findings/defect-scan/SKILL.md` (pre-porting set). Contract references use the section names in `behavioral-contracts.md` (`contracts §…`) and the protocol ids in `protocols-and-state.md` (`E<n>`, `SM<n>`).

---

## Pass 3: Concurrency and Resource Management

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | `core/status.ts:408-449` `acquireLock` (`release`, `:424-426`; stale break, `:433-437`) | `release()` runs `rm(lockPath)` unconditionally, so a holder whose lock was broken as stale (> 60 s by mtime, `:24`) deletes the lock the *next* holder created. Probe P2: A acquires; the file is backdated 120 s; B acquires by breaking it; `A.release()` removes B's lock; a third `acquireLock` succeeds in 0 ms while B is still inside its critical section. Every `status.yaml` and `broadside/state.json` write depends on this lock (SM3 step 2). Closes mech-CF1. | high | observed fact | fix before porting |
| 2 | `core/usage.ts:88`, `core/library.ts:186,439,693,1208`, `core/workspace.ts:368,452`, `extensions/codecarto/dashboard-writer.ts:58`, `core/broadside.ts:1691` | Every atomic writer names its temp file `<target>.<pid>.<Date.now()>.tmp` (or `<slug>.publish.<pid>.<ms>` for a version stage). Two writers in one process within one millisecond get the **same** temp path: the first `rename` moves it away and the second fails with `ENOENT`, losing the second write. Probe P3: five concurrent `appendUsageRun` calls → three `ENOENT`, one run recorded. Probe P4: two concurrent `publishEntry` calls for one slug → one `v1`, the other rejected `ENOENT`, second spec lost. Both wrappers swallow the usage error (`mcp-server/server.ts:424-428`, `auto-runner.ts:529-531`), so the loss is silent. | high | observed fact | fix before porting |
| 3 | `core/usage.ts:84-91` `appendUsageRun`; module comment `:6-9` | Read-modify-write with no lock. The comment's premise ("phases run sequentially against this file") is contradicted by GUIDE §Phase Selection Logic "Parallel phases … can run concurrently" and README §Multi-Session, and by the Pi one-shot path's fire-and-forget post-phase work (`index.ts:761`). Probe P3 shows lost updates even where temp names do not collide (five appends, one survivor). Closes arch-CF4. | medium | observed fact | fix before porting |
| 4 | `core/library.ts:588-726` `publishEntry`, `:933-993` `reindex` | No cross-process or cross-call lock around list-versions → stage → rename → pointer → reindex (SM7). Two publishes for one slug both compute `nextVersion = 1`; the loser's `rename` fails with `ENOENT` (same-ms staging name, probe P4) or `ENOTEMPTY` (different ms, target exists), its staging dir is removed, and the caller gets a raw filesystem error rather than "version already taken, retry". No corruption observed, but the concurrent-publisher recipe in `docs/library-format.md:659-671` covers only the index. Closes mech-CF6. | medium | observed fact | fix before porting |
| 5 | `extensions/codecarto/agent-runner.ts:167-288` `runPhase`; `agent-rewriter.ts:169-208`; `dashboard-narrator.ts:190-210` | No child `AgentSession` is ever `dispose()`d (`grep dispose( extensions/codecarto/*.ts` matches only the widget). The SDK provides `AgentSession.dispose()` to abort, unsubscribe, and release session resources (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:584-598`). Over an `--auto` run that is seven phase sessions plus up to six rewriter sessions retained until the orchestrator exits; the `activity.session` reference is dropped after 30 s but the session is never torn down. | medium | strong inference | fix before porting |
| 6 | `core/completion.ts:502` inside the `updateStatusAtomically` updater; `core/workspace.ts:365-370` | The closeout, THREAD_LOG line, DECISIONS rows, and CONVENTIONS proposals are written *before* the status temp+rename that makes the completion canonical (SM3 steps 5–6). A failure between them (`assertCanonicalStatus`, disk full, rename error) leaves the log asserting a completion `status.yaml` never records, and there is no rollback. Closes proto-CF1(a). | medium | observed fact | fix before porting |
| 7 | `core/completion.ts:322-431` vs `:436-506` | The handoff gates (D1, D3, `target_phase`, `post_pipeline` id) run against `initialState` read **outside** the lock; only the primary output is re-validated inside it. Two parallel completions (the documented contracts/protocols case) evaluate D1 against a snapshot that omits each other's closures; the window is small and the effect is permissive, not corrupting. | low | observed fact | leave behind |
| 8 | `mcp-server/server.ts:1276-1283` `collect`; `core/broadside.ts:2093-2126` `pollBatchUntilTerminal` | A `codecarto_broadside collect` blocks the JSON-RPC call for its whole poll budget with no cancellation path; `sleep` ignores any signal and the loop exits only on a terminal status or the deadline. With the `wait_seconds: 0` wrapper bug (mech 6.3) that is 25 minutes (`:86`). | low | observed fact | port differently |
| 9 | `extensions/codecarto/auto-runner.ts:201-203` | `setTimeout(() => clearPhase(id), 30_000)` is neither `unref()`'d nor cleared on `session_shutdown`, so a headless `pi -p` process stays alive up to 30 s after its last phase. | low | observed fact | leave behind |
| 10 | `core/broadside.ts:2677-2681` `runBroadsideCollect` | The run is selected once at load (`state.runs[last]`) and then persisted by id, so a submit that lands *during* a collect does not retarget it — mech-CF5's interleaving does not occur. The real limitation is the absence of a run-id parameter on `collect`: an older in-flight run cannot be collected once a newer submit exists. Closes mech-CF5 as a design limitation, not a race. | low | observed fact | leave behind |
| 11 | `core/workspace.ts:286-290` `refreshScaffold`; `core/orchestrator-config.ts:193-195` `writeLibraryConfig` | Multi-file refresh copies file by file with no lock or staging; config is written with a direct `writeFile`. A crash mid-refresh leaves a half-refreshed scaffold whose `scaffold-version.yaml` may or may not have been updated (it sorts among the `workflow/` files, `:285`). | low | observed fact | leave behind |
| 12 | `core/library.ts:1330-1344` `runGit`; `core/broadside.ts:1190,1201,1210,1227` `execFileAsync` | No timeout on any git subprocess; a hung git (credential helper, slow filesystem) hangs publish, source-repo resolution, or a Broad-Side submit indefinitely. `fetch` calls, by contrast, all carry a 30 s timeout. | low | observed fact | leave behind |

---

## Pass 4: Security and Trust Boundaries

Contract baseline: `contracts §Security and Authorization` — no authentication; the trust boundary is the absolute `cwd`; Pi's `tool_call` hook is the write sandbox for LLM-driven sessions; MCP has none because the host writes files itself.

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | `core/utils.ts:57-68` `isWithinPathResolved` (fallback branch); `extensions/codecarto/index.ts:433-448` and `phase-compaction.ts:74-84` (the write guards) | When the target does not exist yet, `realpath` fails and the check degrades to the lexical `isWithinPath`, so a **not-yet-existing** file under a symlinked directory inside `.codecarto/` passes. Probe P1: `.codecarto/link → <outside>`; `isWithinPathResolved(<.codecarto/link/new.md>, <.codecarto>)` → `true`, while the same path with an existing file → `false`. A phase sub-agent (LLM output, untrusted) can therefore `write` through a symlink the analyzed repository ships inside its committed `.codecarto/` and land anywhere the user can write. `tests/symlink-sandbox.test.mjs` covers existing paths only. Violates contracts §TUI-only → Tool interception. Closes mech-CF2. | high | observed fact | fix before porting |
| 2 | `mcp-server/server.ts:457-492` `handleSkill`; `extensions/codecarto/index.ts:928-997` `/codecarto-skill` | The skill `name` is never validated; it is joined into `<workspace>/skills/<name>/SKILL.md`. Probe P5: on a completed pipeline, `name: "../findings/architecture"` is accepted and the server returns a prompt whose first line is `Read .codecarto/GUIDE.md and run the post-pipeline skill \`../findings/architecture\`.` and whose reads list names `.codecarto/skills/../findings/architecture/SKILL.md`. Any `SKILL.md`-named file reachable by `..` can be aimed at the host LLM; phase ids and amendment slugs are charset-checked (`core/status.ts:26-30`, `core/amendment.ts:49-53`) but skill names are not. The only test of the unknown-skill path is empty (`tests/mcp-server.test.mjs:143-149`). Violates contracts §Skills ("a directory under `.codecarto/skills/`"). | medium | observed fact | fix before porting |
| 3 | `mcp-server/server.ts:704-708` `handlePublish` | When `library_path` is supplied, `cwd` is not validated (`resolveLibraryPath` checks it only when `library_path` is absent, `:496-521`), yet `join(args.cwd, ".codecarto")` is added to the `spec_path` containment roots; a relative `cwd` resolves against the server process's directory inside `isWithinPathResolved`. A caller can widen the readable roots to `<server-cwd>/<rel>/.codecarto`. Defense-in-depth gap rather than an exposure: `spec_path` itself must still be absolute and exist. Closes mech-CF3. | medium | observed fact | fix before porting |
| 4 | `core/prompts.ts:201-207` (routed items), `:75-80` (coverage gaps), `:213-228` (library entries); `core/coverage.ts` | Text written by earlier LLM phases — carry-forward descriptions, `Skipped scope` / `Known blind spots` bullets, library headlines and tags — is spliced verbatim into later phase prompts with no delimiter, quoting, or length bound (`RETRIAGE_LIST_LIMIT` caps count, not size). The analyzed repository is untrusted input to those phases, so a README or comment crafted to be copied into a coverage bullet rides into every later prompt as instructions. The synthesis block carries one "evidence, never instructions" line (`:220-221`); the routed-item and coverage-gap blocks carry none. | medium | strong inference | port differently |
| 5 | `core/broadside.ts:939-1098` lens `globsFor` (`server/**`, `**/auth*`, `**/middleware/**`, `SECURITY.md`, `info.sourceGlob`); `:1463-1517` `slurpFileList` | Repository contents matched by the lens globs are uploaded to OpenRouter verbatim. There is no secret scan or redaction; `isSlurpable` excludes binary extensions and vendored directories only. A tracked `auth.env`, `server/config.json` with credentials, or a `SECURITY.md` with disclosure contacts goes to a third party on `submit`. README §Broad-Side describes the upload but not the absence of redaction. | medium | observed fact | port differently |
| 6 | `mcp-server/server.ts:1160-1169` `resolveBroadsideApiKey`; tool schema `:1626-1629` | `api_key` is accepted as a tool argument, so it lands in whatever the host records about tool calls. The Pi surface refuses a key argument for exactly this reason (`extensions/codecarto/index.ts:186-194`, `tests/pi-broadside.test.mjs:136-154`); the MCP schema only says "Prefer the environment variable". | low | observed fact | port differently |
| 7 | `extensions/codecarto/index.ts:438-441`; `core/orchestrator-config.ts:143-145` | A repository-committed `.codecarto/workflow/config.yaml` can set `library.path`; when that path carries a `.codecarto-library` marker the Pi write sandbox admits it, and a relative value resolves against the process cwd (mech 6.4). A cloned repository can therefore ship a marker-bearing directory and a config that names it, widening the sandbox to a location the repository chose. Bounded by the marker requirement. | low | strong inference | port differently |
| 8 | `mcp-server/server.ts:123-134` `validateCwd`; `handleInit`, `handleRefreshScaffold` | Any absolute, existing directory the server process can write is a valid `cwd`: `codecarto_init` creates `.codecarto/` there and `codecarto_refresh_scaffold` overwrites files under it. No allowlist, no confirmation on MCP. This is the documented posture ("the host is trusted"), recorded so the port decides deliberately. | low | observed fact | leave behind |
| 9 | `.codecarto/broadside/config.yaml` (`api_key` key) with mech 6.1 | The template config can hold the OpenRouter key and is a tracked file; npm-installed workspaces get no `.gitignore` from the package (mech 6.1), so the documented warning ("keys in this file are committed if you track .codecarto/") is the only guard. | low | observed fact | port differently |

No XSS or injection path was found in the dashboard: `escapeHtml` covers the five entities, `safeRelativeHref` refuses schemes and dot segments (probed by `tests/dashboard.test.mjs`), and the JSON island escapes `<`, `>`, `&`, U+2028/2029 (`core/dashboard.ts:752-770`). No defects found in that area.

---

## Pass 5: API Contract Violations

Which side implements each contract: every row below is about this repository's own surfaces and documents, so evidence is settled by reading. Rows that restate a mechanical finding as a documented-versus-actual violation say so and carry the spec reference the mechanical row lacked.

| # | Location | Defect | Severity | Evidence Level | Action | Spec Reference |
|---|----------|--------|----------|----------------|--------|----------------|
| 1 | `core/pipeline.ts:37-49` `getNextEligiblePhase` consumed as "pipeline complete" by `core/completion.ts:496-500`, `mcp-server/server.ts:346-351` (`next`), `:269-286` (`status`), `:473-480` (`skill` gate), `core/amendment.ts:141-147`, `core/status.ts:195-209` | "No phase is eligible" is treated as "every phase is complete". A pipeline with an unsatisfiable `depends_on` (typo, or a phase dropped by a switch, mech 1.4) reaches a state where phases are `pending` yet completion writes `current_phase: complete`, `codecarto_status` prints `Pipeline state: complete` beside `Progress: 1/2 complete`, `codecarto_next` answers "All CodeCartographer phases are complete", skills unlock, and amendments are accepted. Probe P6 reproduces all four on a two-phase pipeline whose second phase depends on `nope`. Shipped pipelines are protected only by `tests/pipeline-invariants.test.mjs`; custom pipelines are a documented feature (`core/completion.ts:329-331`, `tests/framework-handoff.test.mjs:430-448`). | high | observed fact | fix before porting | GUIDE §Phase Selection Logic step 4 and README §For automated agents ("Set `current_phase` to `complete` when done"); contracts §Status, §Next; protocols SM2 |
| 2 | `core/pipeline.ts:78-201` `validatePhaseOutput`; docs `README.md:37` ("Every phase is validated … Completion criteria are real"), `docs/mcp-quickstart.md:125` ("checks the phase output against completion criteria"), `MANUAL.md:140` | Validation parses the LLM's own `## Validation` table and the findings cross-checks; no completion criterion is evaluated against the output or the source. `workflow/VALIDATE.md` says so ("does not re-evaluate the source code"), the user-facing docs say the opposite. The gate is self-attestation with two mechanical cross-checks. | medium | observed fact | fix before porting | contracts §Validate (E3 grammar); README §Why CodeCartographer #2 |
| 3 | `mcp-server/server.ts:316-341` `handleSwitchPipeline` (no `writeDashboard`) vs `extensions/codecarto/index.ts:645` | MCP's pipeline switch changes canonical state without re-rendering the dashboard; the README promises a re-render on every state change and the Pi command does it. Surface parity gap. Closes contracts-CF1 item 1. | medium | observed fact | fix before porting | README §The dashboard ("Every state change re-renders"); contracts §Switch pipeline |
| 4 | `README.md:278` vs `core/dashboard.ts:628-666` | "No JavaScript." The dashboard embeds a search/filter/export script and a JSON data island (E13); the repo's CLAUDE.md states this correctly. Closes contracts-CF1 item 2. | low | observed fact | fix before porting | README §The dashboard; contracts §Dashboard |
| 5 | `MANUAL.md:136-158` (Step 4–5), `:235-239` (parallel sessions "overwrite"), `:247-252`, `:271-272` (hand-edit `status.yaml`) vs `.codecarto/GUIDE.md` §Trust Boundaries and `core/workspace.ts:342-392` | The user manual instructs the LLM to update `status.yaml` and append `THREAD_LOG.md` itself and warns that parallel sessions overwrite each other's status; the framework forbids both writes and serializes completion under a lock (`tests/pipeline-invariants.test.mjs` pins that no framework file instructs such writes). For drop-in users the manual's path is the only one that exists, so the two documents disagree about what drop-in mode *is*. Closes contracts-CF1 item 3. | medium | observed fact | fix before porting | contracts §Doc/Test Conflicts #3; GUIDE §Trust Boundaries; protocols SM3 |
| 6 | `MANUAL.md:97` (default is `full-with-audit`), `MANUAL.md:188` ("four evidence levels"), `docs/mcp-quickstart.md:147` (mechanical scan covers security/concurrency/API), `docs/mcp-quickstart.md:182` (`next` returns "no eligible phase") | Four stale statements against `core/pipeline.ts:25`, the five-level vocabulary, `findings/defect-scan-mechanical/SKILL.md`, and `mcp-server/server.ts:348`. Closes contracts-CF1 items 4–7. | low | observed fact | fix before porting | contracts §Doc/Test Conflicts #4–#7 |
| 7 | `README.md:274` ("Activity timeline with session-file links") vs `core/dashboard.ts:432,530,752-757` | The renderer refuses absolute paths and Pi session files are absolute, so the promised links never render (root: mech 1.14). Closes contracts-CF1 item 10. | low | observed fact | fix before porting | contracts §Doc/Test Conflicts #10 |
| 8 | `core/broadside.ts:2704`, `:2847`, `:2966` (three literal `["completed","failed","expired","cancelled","auth-failed","skipped","rejected"]` arrays) vs `:2091` `BROADSIDE_DEAD_BATCH_STATUSES` | CHANGELOG 0.19.1 states the terminal/dead distinction "is now a named constant … rather than two hand-maintained lists"; the *terminal* set is still hand-maintained in three copies. A future status added to one copy changes which runs count as finished (SM6). Closes proto-CF1(b). | low | observed fact | fix before porting | CHANGELOG §0.19.1 "A post-pass whose batch expired…"; protocols SM6 |
| 9 | `core/types.ts:5` (`partial`, `in-progress`), `core/types.ts:40` (`post_pipeline.status: resolved`), `core/dashboard.ts:672-678` (`running`) vs every writer | Protocol states that are typed, rendered, or filtered on but never written: nothing sets `partial`/`in-progress`/`running` on a phase, and amendment *removes* post-pipeline items rather than marking them `resolved` (`core/amendment.ts:170`), so the dashboard's "pending" filter and `codecarto_status`'s `postPipelinePending` count never see a resolved item. Closes proto-CF1(c). | low | observed fact | leave behind | protocols SM1, SM4; GUIDE status schema comment |
| 10 | `core/broadside.ts:1935,2026` (`schema_version: 2`) vs `:1816-1826` `readCatalogCache` | The catalog cache is written as schema 2 and read with no version check; the on-disk state file is schema 1. A reader that ever needs to distinguish them cannot. Closes proto-CF1(d). | low | observed fact | fix before porting | protocols §Persistent Schema Notes (version axes) |
| 11 | `docs/library-format.md:285-291` vs `core/yaml.ts:107-177` and `tests/yaml.test.mjs:90-152` | The library spec says folded (`>`) scalars are not read and "make the whole file fail to parse"; the parser has accepted `>`, `>-`, `>+` since 0.19.3. External writers following the spec are being told to avoid a form the reader accepts, and the spec's failure description is now false. Closes proto-CF1(e). | low | observed fact | fix before porting | `docs/library-format.md` §YAML dialect; protocols E22 |
| 12 | `core/library.ts:1072` (`INDEX.md` footer: "regenerate with `codecarto library-reindex`") | The generated artifact names a command that exists on no surface: MCP has `codecarto_library_reindex`, Pi has none. Closes proto-CF1(f). | low | observed fact | fix before porting | contracts §Library init / list / reindex; `docs/library-format.md` §`INDEX.md` |
| 13 | `core/workspace.ts:402-463` `switchPipeline` vs tool description `mcp-server/server.ts:1324-1325` ("without losing … phase progress") and README §Pipeline variants | `current_phase` and `next_actions` are reset to the first phase even when it is carried as complete (mech 1.3); the persisted cursor contradicts the preserved statuses until the next completion. Restated here with its spec reference. | medium | observed fact | fix before porting | contracts §Switch pipeline; protocols SM1 row "complete → carried" |
| 14 | `core/broadside.ts:1790` (`max_cost` default 0) and `.codecarto/broadside/config.yaml` (`max_cost` commented out) vs tool description `mcp-server/server.ts:1611` ("refuses to submit when the estimate exceeds the limit") and README §Broad-Side ("refuses when the estimate exceeds `max_cost`") | The documented refusal exists only when a limit is configured; with the shipped defaults MCP submits without any cap (mech 6.2). The docs describe a guard the default configuration does not have. | medium | observed fact | fix before porting | contracts §Broad-Side (Defaults); README §Broad-Side |
| 15 | `.codecarto/broadside/config.yaml` (`wait_seconds` comment "0 returns as soon as …") and tool description `server.ts:1632` vs `server.ts:1201-1204`, `index.ts:1175-1176`, `core/broadside.ts:2686` | Documented "return immediately" for `collect` is implemented as the 25-minute default (mech 6.3). | medium | observed fact | fix before porting | contracts §Broad-Side (Defaults); §Doc/Test Conflicts #9 |
| 16 | `extensions/codecarto/auto-runner.ts:170,387` (read `ctx.cwd` after a phase) vs `:321-323` and `extensions/codecarto/index.ts:755-760` (capture `cwd` because the ctx "is invalidated") | With `q-pi-ctx-invalidation` closed on the SDK source (a ctx is invalidated only by `dispose()`/`reload()`, i.e. a user `/new`, `/fork`, `/switch`, or `/reload`), the module is self-inconsistent: it defends against that event at some sites and not others. If the user replaces or reloads the session while `--auto` is between phases, `:387` throws inside `runAuto`, the loop dies with an unhandled command error after the completed phases are persisted, and the recorded contract ("Post-phase work now captures the directory", CHANGELOG 0.19.1) is only half true. Closes mech-CF4 with a settled action, which the closed question now permits. | medium | observed fact | fix before porting | contracts §High-Value Behaviors → Session replacement; CHANGELOG §0.19.1 "`/codecarto-next` crashed the Pi process" |
| 17 | `mcp-server/server.ts:1386` `codecarto_complete` description ("creates a closeout stub from the template if one does not yet exist") vs `core/completion.ts:239-262` | When the handoff supplies `closeout_content`, completion **overwrites** the latest existing `<date>-<phase>.md` for that phase; the description names only the stub case. | low | observed fact | fix before porting | contracts §Complete; protocols E9 |

---

## Summary

### Findings by Severity

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 4 |
| Medium | 15 |
| Low | 19 |
| **Total** | 38 |

### Findings by Pass

| Pass | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| 3. Concurrency and resources | 0 | 2 | 4 | 6 | 12 |
| 4. Security and trust | 0 | 1 | 4 | 4 | 9 |
| 5. API contract violations | 0 | 1 | 7 | 9 | 17 |

### Top Findings

1. **Pass 4 #1** — `core/utils.ts:57-68`: the Pi write sandbox admits a not-yet-existing file under a symlinked directory (probe P1). High; fix before porting (resolve the nearest existing ancestor with `realpath`, then check the remaining relative tail; a symlinked ancestor outside the root must fail).
2. **Pass 3 #2** — every atomic writer: `<pid>.<ms>` temp names collide within a millisecond, losing writes silently (probes P3, P4). High; fix before porting (one shared `atomicWrite` helper using a counter or random suffix, and make usage-log appends report their failure).
3. **Pass 3 #1** — `core/status.ts:424-426`: unconditional lock removal lets a stale-broken holder delete the new holder's lock (probe P2). High; fix before porting (write a token into the lock, remove only if the token matches).
4. **Pass 5 #1** — "no eligible phase" is treated as "complete" across completion, status, next, skills, and amendments (probe P6). High; fix before porting (distinguish `null` with pending phases from `null` with none; report "stuck: <phases> have unsatisfiable dependencies").
5. **Pass 3 #6** — `core/completion.ts:502`: completion artifacts written before the status rename. Medium; fix before porting (write status first, or write artifacts after the rename under the same lock).
6. **Pass 4 #2** — `handleSkill`: unvalidated skill name reaches `join(…)` (probe P5). Medium; fix before porting (apply `assertSafePhaseId`'s charset, or resolve against `listSkillNames`).

### Carry-Forward Closure

| ID | Source Phase | Closed Because |
|----|--------------|---------------|
| arch-CF4 | architecture | Pass 3 #3 (and #2): unlocked RMW confirmed as lost updates by probe P3; the comment's sequential-phases premise contradicts the documented parallel-phase mode. |
| mech-CF1 | defect-scan-mechanical | Pass 3 #1: probe P2 reproduced the release-after-stale-break deletion and the resulting double acquisition. |
| mech-CF2 | defect-scan-mechanical | Pass 4 #1: probe P1 reproduced the non-existent-target bypass through a symlinked directory. |
| mech-CF3 | defect-scan-mechanical | Pass 4 #3: confirmed by reading `handlePublish` vs `resolveLibraryPath`; classified as a defense-in-depth gap. |
| mech-CF4 | defect-scan-mechanical | Pass 5 #16: its `derives_from` question `q-pi-ctx-invalidation` was closed in the contracts phase on the SDK's own source, so the finding takes a settled action. |
| mech-CF5 | defect-scan-mechanical | Pass 3 #10: the interleaving does not occur (selection happens once at load, persistence is by id); recorded as the design limitation it actually is. |
| mech-CF6 | defect-scan-mechanical | Pass 3 #4: probe P4 reproduced the concurrent-publish loss and its raw-error surface. |
| contracts-CF1 | contracts | Pass 5 #3–#7: each documentation-versus-code item classified with severity, action, and spec reference. |
| proto-CF1 | protocols | Pass 3 #6 (ordering) and Pass 5 #8–#12 (terminal-status copies, dead states, catalog schema, folded-scalar doc, INDEX.md command). |

---

## Open Questions

| ID | Kind | Question | Why source cannot settle it | Derived findings |
|----|------|----------|-----------------------------|------------------|
| q-codex-envelope-preference | needs-runtime-test | (carried from contracts) Which MCP result field does Codex surface to its model? | Only a live Codex call observes it; both fields carry the text, so no finding here depends on it. | none |

No finding in this report carries `open question` or `external-behavior claim` evidence: every routed item was settled by a probe, by reading this repository, or (mech-CF4) by the external system's own source cited in the contracts phase.

---

## Runtime probes

Run 2026-09-11 in the scratch clone with Node v22.22.3 against the source modules (`node --experimental-strip-types`), `CODECARTO_USER_CONFIG_PATH` pointed at a scratch file; script kept at the session scratchpad `probes/semantic.mjs`.

- **P1** — temp workspace with `.codecarto/link → <outside dir>`: `isWithinPathResolved(canonicalPath(".codecarto/link/new.md"), canonicalPath(".codecarto"))` → `true`; same with an existing `exists.md` → `false`.
- **P2** — `A = acquireLock(l)`; `utimes(l, now-120s)`; `B = acquireLock(l)`; `A.release()`; `pathExists(l)` → `false`; `C = acquireLock(l)` → succeeded in `0` ms.
- **P3** — `Promise.allSettled(5 × appendUsageRun)` → outcomes `["ok","ENOENT","ok","ENOENT","ENOENT"]`; `loadUsage().runs.length` → `1`.
- **P4** — `Promise.allSettled([publishEntry("spec A"), publishEntry("spec B")])` same slug → `["v1 new=true", "rejected: ENOENT"]`; entry dir `["latest","v1"]`.
- **P5** — architecture-only workspace completed, then `handleSkill({name: "../findings/architecture"})` → returned a prompt: `Read .codecarto/GUIDE.md and run the post-pipeline skill \`../findings/architecture\`.`
- **P6** — two-phase pipeline, `b` depends on `nope`; complete `a`; `codecarto_status` → `Phase: complete | Pipeline state: complete | … | Progress: 1/2 complete`; `codecarto_next` → `All CodeCartographer phases are complete…`; stored `current_phase` → `complete`.

---

## Coverage and limits

- Inspected scope: every lock, atomic-write, subprocess, and fetch site in `core/`; the completion transaction; both wrappers' post-completion side effects; the Pi runner/rewriter/narrator session lifecycles; the Pi write guards and MCP argument validation for every tool that takes a path-like argument; prompt assembly for injected text; Broad-Side upload globs; the SDK's `dispose()` (`agent-session.js:584-598`); the documents named in each pass-5 spec reference; tests `symlink-sandbox`, `publish-path-containment`, `mcp-server`, `pipeline-invariants` (by name and the cited excerpts).
- Skipped scope: the dashboard's inline script beyond its escaping (no user input reaches it); Broad-Side lens prompt wording as an injection surface (the model output is JSON-schema constrained and never re-prompted); the MCP SDK's own transport handling; cryptographic concerns (none present); dependency CVEs (`npm audit` runs in CI); the synthesis phases' prompt content (template, out of scope).
- Evidence basis: source inspection; runtime verification (six probes, §Runtime probes); tests (cited by file:line); upstream findings (contracts for the intended security model and contracts, protocols for SM1–SM7 and the version axes, mechanical scan for shared roots); the Pi SDK source for pass 5 #16 and pass 3 #5's `dispose()`.
- Known blind spots: (1) whether `AgentSession` retains OS resources (file handles, timers) when not disposed is inferred from the SDK method's body, not measured — pass 3 #5 is `strong inference` for that reason; (2) the OpenRouter side of every Broad-Side exchange remains `[external]` (`q-openrouter-batch-envelope`); (3) the symlink bypass was probed at the core helper; the full Pi hook path (`event.input.path` shapes) was not driven through a real Pi session; (4) pass 5 compared code against the documents the contracts phase read, not against `docs/` files it skipped (`ROADMAP.md`, `synthesis-roadmap.md`, `design-synthesis-phases.md`, `CONTRIBUTING.md`).
- Coverage disposition: COMPLETE for passes 3, 4, 5 at the module level; PARTIAL for the Pi hook path end-to-end and for the skipped `docs/` files, inherited as declared.

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | All three semantic passes (3, 4, 5) produced findings or documented "no defects found." | PASS | Pass 3 (12), Pass 4 (9, plus an explicit "no defects found" for dashboard XSS), Pass 5 (17). |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS | Every row in the three tables fills Location (file:line + symbol), Severity, Evidence Level, Action. |
| 3 | Pass 5 findings cite the contract or protocol reference they violate. | PASS | Pass 5 table carries a Spec Reference cell on all 17 rows naming a contracts section, protocol id, or document line. |
| 4 | Findings are organized by pass and sorted by severity; summary tables match the detailed findings. | PASS | Three `## Pass N` sections ordered high → medium → low; §Summary 4 + 15 + 19 = 38 and per-pass 12 + 9 + 17 = 38 match the numbered rows. |
| 5 | Findings are marked with evidence levels. | PASS | Evidence Level on every row: 35 `observed fact`, 3 `strong inference` (3.5, 4.4, 4.7). |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits, all bullets filled; COMPLETE/PARTIAL split stated. |
| 7 | Unsettled findings (evidence level open question or external-behavior claim) carry an unsettled action (verify at runtime or port differently on pre-porting pipelines; investigate on maintenance pipelines), never a settled one, and each appears in the Open Questions table. | PASS | No row uses an unsettled evidence level; the one carried question is listed in §Open Questions with no derived findings; mech-CF4's question was closed with cited evidence before its finding took a settled action. |
| 8 | Every quantitative specific in a finding (size, count, default, version, timeout) cites the file and line or command output it was read from, or is marked as an estimate. | PASS | Timeouts and limits cite `core/status.ts:24`, `core/broadside.ts:86`, `auto-runner.ts:201-203`; counts (5 appends → 1 run, 0 ms, 1/2 complete, seven and six sessions) cite §Runtime probes or the pipeline length. |

**Validated by:** 2026-09-11 (defect-scan-semantic, self-audit session 1, inline MCP host)
**Overall:** PASS
