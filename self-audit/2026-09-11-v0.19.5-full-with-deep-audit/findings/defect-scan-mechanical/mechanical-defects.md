# Mechanical Defects Report — codecarto-self

## Scan Context

- **Source:** `../` (repository root, commit `f6f8484`, v0.19.5)
- **Architecture reference:** `findings/architecture/architecture-map.md`
- **Pipeline:** full-with-deep-audit
- **Date:** 2026-09-11 (session clock; framework closeouts are stamped in UTC and may read 2026-09-12)
- **Scope:** Mechanical passes only (1 logic, 2 error handling, 6 configuration). Semantic passes (3 concurrency, 4 security, 5 contract violations) deferred to `defect-scan-semantic` after protocols.
- **Evidence basis beyond reading:** the repo's own suite was run twice (`npm test`: 678/696 in this clone after one phase of outputs, 696/696 on a pristine clone at the same commit); four `node` probes against `core/yaml.ts` and `core/status.ts` (recorded under §Runtime probes); `npm pack --dry-run`. Findings that rest on those are marked `observed fact` with the command named in the Defect cell.

Severity scale per pass file: critical = incorrect results / data loss in normal use; high = incorrect results or silent failure in edge cases or normal operation; medium = latent risk, missing cleanup, hardcoded value that breaks elsewhere; low = dead code, observability, undocumented behavior.

---

## Pass 1: Logic and Correctness

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | `core/yaml.ts:355-364` `formatYamlScalar`; `core/status.ts:229` `normalizeStatus` | Strings that look like YAML scalars are emitted unquoted and re-parsed as numbers/booleans/null. `project_name` defaults to `basename(cwd)` (`core/status.ts:229`), so a repository directory named e.g. `2048` is serialized as `project_name: 2048`, and the next load throws `status.project_name?.trim is not a function` on every tool call (probe A2, §Runtime probes). Owner notes such as `"42"` or `"true"` are likewise dropped by `ensureArray` on reload (probe B2). | high | observed fact | fix before porting |
| 2 | `core/workspace.ts:137-182` `copyPackagedWorkspace` (`INIT_EXCLUDED_TOP_LEVEL`, `INIT_EXCLUDED_DIR_CONTENTS`) | The init filter excludes four top-level files, `closeouts/`, and `broadside/` state, but not `findings/**` outputs, `scratch/handoffs/`, or `dashboard.html`. Initializing from a checkout that holds a live workspace copies that checkout's findings into every new workspace, and `codecarto_validate` then passes on them. Runtime-verified: after this run's architecture phase, 18 of 696 tests fail because `codecarto_init` inside the tests copies `findings/architecture/architecture-map.md` (`tests/mcp-server.test.mjs:79` reports `'PASS' !== 'MISSING'`); a pristine clone passes 696/696. | high | observed fact | fix before porting |
| 3 | `core/workspace.ts:402-463` `switchPipeline` | `freshStatus` comes from `createEmptyStatus`, so `current_phase` is the new pipeline's first phase and `next_actions` says "Begin <first> phase" even when carried phases are already `complete` (probe F). `handleStatus` recomputes via `getNextEligiblePhase` so the text is right, but the persisted `current_phase`/`next_actions` and the dashboard header (`core/dashboard.ts:135,150`) are wrong until the next completion rewrites them. No test asserts `current_phase` after a switch (`tests/mcp-uncovered-handlers.test.mjs:70-100`). | medium | observed fact | fix before porting |
| 4 | `core/workspace.ts:425-440` `switchPipeline` | Carried phases keep their `carry_forward` entries verbatim; an entry whose `target_phase` is one of the dropped phases stays in `status.yaml` with a target no prompt will ever surface (`collectRoutedCarryForward` matches on `target_phase`, `core/prompts.ts:103-111`) and no completion will ever validate. | medium | observed fact | fix before porting |
| 5 | `core/completion.ts:467-480` | Every PARTIAL validation row is converted into a `needs-maintainer-decision` open question, even when the handoff already routes that same gap as a `carry_forward`. The duplicate then appears in every later phase's re-triage duty (`core/prompts.ts:47-59`) and in the terminal open-question count. Pinned as intended by `tests/open-questions.test.mjs:196-230`, so this is a design gap rather than a regression. | medium | observed fact | port differently |
| 6 | `core/library.ts:925` `listEntries` | The `source_repo` filter is an exact string comparison while every other repo comparison in the module goes through `sameSourceRepo` (`:362-364`); filtering by `https://github.com/x/y.git` misses an entry recorded as `git@github.com:x/y`. | medium | observed fact | fix before porting |
| 7 | `core/broadside.ts:1188-1196` `listRepoFiles`, `:1493` `slurpFileList` | The file list comes from `git ls-tree -r HEAD` but each file's content is read from the working tree. Untracked files are never scanned and modified tracked files are scanned in their uncommitted state; `sourceDirty` (`:2237`) is recorded but does not change what is scanned. | medium | observed fact | port differently |
| 8 | `core/broadside.ts:1314-1325` `collectRepoInfo`; `:1606` `estimateCost` | `mainFile` is read whole with no size cap, and the architecture lens's input is estimated at a flat 6,000 characters (`:1606`, `lens.maxChars === 0 ? 6000`). A large entry file (any `src/index.ts`) makes the priced estimate wrong by its full size and can push the request past the model's context. | medium | observed fact | fix before porting |
| 9 | `core/broadside.ts:1933-1941` `resolveCatalogEntry` | Writing one freshly fetched model entry rewrites the whole cache with a new `fetched_at`, so every other cached model's pricing inherits a fresh 24 h TTL (`:73`) each time any model is looked up; a stale price can persist indefinitely. | low | observed fact | fix before porting |
| 10 | `core/broadside.ts:1251` vs `:1113` `walkFiles` | The dotfile skip exempts `.github`, but `SKIP_DIR_NAMES` (`:1113`) skips `.github` on the next line, so the exemption is dead. | low | observed fact | leave behind |
| 11 | `core/broadside.ts:2342-2343` `runBroadsideSubmit` | `state.runs.push(run)` mutates a loaded state object that is never written; `persistBroadsideRun` re-reads from disk. Dead mutation left over from the wholesale-save era. | low | observed fact | leave behind |
| 12 | `core/workspace.ts:342-392` `updateStatusAtomically` | The `threadLogEntry` result field and its dedupe/append branch (`:372-386`) have no callers (`grep threadLogEntry` finds only this file); completion and amendment write THREAD_LOG themselves. Dead path. | low | observed fact | leave behind |
| 13 | `core/dashboard.ts:672-678` `phaseRenderState`; `:226-245` `collectDashboardIssues` | Both branch on a phase status of `"running"`, which no writer in `core/` ever produces (`grep '"running"' core/*.ts` matches only `dashboard.ts`); `PhaseStatusValue` (`core/types.ts:5`) has no such member. Dead branch, and the issue-severity rule that depends on it. | low | observed fact | leave behind |
| 14 | `core/dashboard.ts:432,530` + `:752-757` `safeRelativeHref` | `run.session_file` is the Pi session file path, which the runner's own comment places under `~/.pi/agent/sessions/…` (`extensions/codecarto/agent-runner.ts:105-107`), i.e. absolute; `safeRelativeHref` refuses absolute paths, so the "Session"/"transcript" link can never render. | low | strong inference | leave behind |
| 15 | `core/yaml.ts:358-359`; `mcp-server/server.ts:918`; `extensions/codecarto/index.ts:1397` | Dead code: `formatYamlScalar`'s array/object branches are unreachable from `stringifySimpleYaml` (which handles collections itself at `:368-396`); `handleLibraryInit` declares a `cwd` argument it never reads; the Pi library-init spreads `...(namespace ? {} : {})`, always empty. | low | observed fact | leave behind |

---

## Pass 2: Error Handling and Resilience

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | `core/broadside.ts:1756-1765` `loadBroadsideConfig`; `:1790` | A `broadside/config.yaml` that fails to parse is swallowed to `{}` (comment: "a typo … must not cost a user their batches"), so every knob reverts to its default, including `max_cost` → 0 = no limit and `lens_models` → none. On MCP there is no confirm hook, so a YAML typo silently removes the only spend guard and any per-lens model routing before a submit. | high | observed fact | fix before porting |
| 2 | `core/broadside.ts:1657-1667` `loadBroadsideState`; `:1735-1741` `persistBroadsideRun` | A `state.json` that fails to parse loads as the empty default; the next `persistBroadsideRun` then writes a file containing only the current run. Every prior run's batch ids, costs, and output-dir references are discarded silently, orphaning paid results on disk. | high | observed fact | fix before porting |
| 3 | `core/usage.ts:72-91` `loadUsage` / `appendUsageRun` | Same pattern: a usage log that fails to parse is read as empty and overwritten by the next append, losing all recorded runs without any signal. | medium | observed fact | fix before porting |
| 4 | `core/orchestrator-config.ts:103-110` `loadRawIfExists` | Malformed config at either layer is dropped with no signal (module comment: "logs nothing"). A typo in `~/.codecarto/config.yaml` surfaces later as "no library.path is configured" (`core/synthesis.ts:136`, `mcp-server/server.ts:517-520`), which misdirects the user to write config they already have. | medium | observed fact | fix before porting |
| 5 | `core/broadside.ts:1919-1931` `resolveCatalogEntry`; `:2106-2113` `pollBatchUntilTerminal` | A 401/403 or non-JSON catalog response is caught as "no live entry": for the default model it silently falls back to built-in pricing (`:1946-1947`), for any other model it throws "Could not resolve per-token pricing" (`:1949-1953`), hiding the auth failure. The poller likewise swallows every fetch error until the deadline and then reports `timeout` (`:2111`), so a dead network reads as a slow batch. | medium | observed fact | fix before porting |
| 6 | `core/pipeline.ts:151-157,184-186` `validatePhaseOutput` | The `**Overall:**` value must be exactly `PASS` or `PASS WITH GAPS`; any decoration (`PASS (6/6)`, `PASS.`) is classified FAIL and the only error emitted is "Validation overall result is FAIL.", which does not say the line was unparsed. The host model gets a refusal with no hint of the cause. | medium | observed fact | fix before porting |
| 7 | `core/yaml.ts:246-247` `parseMapping`; `:333-337` `parseSequence` | Layouts valid in YAML are rejected with "Invalid YAML indentation near: …": a sequence item's nested keys indented other than exactly two columns past the dash (probes C, C2) and a plain multi-line scalar continued on the next line (probe D). The message blames whitespace for a parser limitation; a model writing a handoff has no way to tell which. | medium | observed fact | port differently |
| 8 | `mcp-server/server.ts:136-139` `requireWorkspace` | User-fixable errors thrown by `getWorkspaceState` (missing `pipeline:`, nonexistent pipeline file, YAML parse error in `status.yaml`) are re-thrown as `InternalError` (-32603) rather than `InvalidRequest`, so hosts that key retry/reporting on the code treat a config problem as a server bug. | low | observed fact | fix before porting |
| 9 | `extensions/codecarto/dashboard-writer.ts:62-67`; `mcp-server/server.ts:1079-1081` | `writeDashboard` swallows the cause of any failure and returns `false`; `codecarto_dashboard` then reports a fixed two-cause guess ("state could not be gathered or … not writable"). | low | observed fact | leave behind |
| 10 | `core/workspace.ts:367-370,451-454`; `core/usage.ts:88-90`; `core/library.ts:1206-1211`; `dashboard-writer.ts:58-60` | Temp-file-then-rename writers do not remove the temp file when `rename` fails, leaving `<file>.<pid>.<ts>.tmp` beside the target. | low | observed fact | leave behind |
| 11 | `core/library.ts:715-716` `publishEntry` | After the version directory is renamed into place, a failure in `writeLatestPointer` or `reindex` leaves the entry published with a stale `latest` pointer or index; `readEntry` (pointer, `:776-788`) and `buildIndexEntry` (max version dir, `:1001-1003`) then disagree about which version is latest. | low | observed fact | leave behind |

---

## Pass 6: Configuration and Environment Hazards

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 1 | `package.json` `files`; `.codecarto/.gitignore` | `.codecarto/.gitignore` is not in the published tarball (`npm pack --dry-run`: 100 files, 122.5 kB, zero matches for `.codecarto/.gitignore`), so every workspace created by an npm-installed server or Pi package lacks the rules that keep `dashboard.html` and `workflow/.usage.local.yaml` (both carry absolute Pi session paths, per the ignore file's own comments), `broadside/` state, and an `api_key`-bearing config out of the user's git history. | high | observed fact | fix before porting |
| 2 | `core/broadside.ts:1790` `loadBroadsideConfig`; `mcp-server/server.ts:1235`, `core/broadside.ts:2329-2340` | `max_cost` defaults to 0 = no limit and the shipped `config.yaml` leaves it commented out; on MCP there is no confirm hook, so a default-config `submit` fires paid batches with no cap at all. The spend guard is opt-in on the surface that has no human to ask. | high | observed fact | fix before porting |
| 3 | `mcp-server/server.ts:1201-1204`; `extensions/codecarto/index.ts:1175-1176`; `core/broadside.ts:2686` | `wait_seconds: 0` is documented in the shipped `broadside/config.yaml` as "returns as soon as … the recorded state is read", but both wrappers map any non-positive value to `undefined`, and `runBroadsideCollect` then applies the 25-minute default (`BROADSIDE_DEFAULT_POLL_BUDGET_MS`, `:86`). A `collect` meant to be non-blocking blocks an MCP call for up to 25 minutes. Core itself honors `waitMs: 0` (`tests/broadside.test.mjs:1492`), so the loss is in the wrappers. | high | observed fact | fix before porting |
| 4 | `core/orchestrator-config.ts:144` `applyRaw` | A relative `library.path` is passed through `resolve()`, i.e. resolved against the *server process's* working directory, not the workspace or the config file's directory. Undocumented, and different per host. | medium | observed fact | fix before porting |
| 5 | `core/broadside.ts:1340` `collectRepoInfo`; `:1170-1177` `MANIFEST_CANDIDATES` | An unrecognized language falls back to Go source globs (`SOURCE_SPECS[language] ?? SOURCE_SPECS.go`), so the `defect`, `conventions`, and `porting` lenses on e.g. a Java, C#, or Ruby repository collect nothing and are reported as `skipped`. Manifest precedence also classifies any repository with a `package.json` (docs tooling in a Python project) as TypeScript. | medium | observed fact | fix before porting |
| 6 | `mcp-server/server.ts:937-939`, `extensions/codecarto/index.ts:1401-1402` → `core/orchestrator-config.ts:170-186` `writeLibraryConfig` | Both library-init surfaces write `publish_confirm: true` explicitly into the user-global config (the helper's default parameter), which flips `publish_confirm_configured` on. From then on every MCP `codecarto_publish` refuses without `confirm: true`, although the tool text and the loader comment describe the gate as applying only to hosts that "actually configured the key". The test file acknowledges the leak (`tests/mcp-library.test.mjs:19-23`). | medium | observed fact | port differently |
| 7 | `mcp-server/server.ts:192-197,229-241` `handleInit`; `extensions/codecarto/index.ts:533-566` | When the target `.codecarto/` *is* the packaged template (`sameWorkspace`, i.e. the server or extension runs from a source checkout whose cwd is that checkout), init skips the backup and the copy but still overwrites `workflow/status.yaml` with a fresh status, resetting in-progress state without confirmation or `force`. | medium | observed fact | fix before porting |
| 8 | `.codecarto/.gitignore:1-13` (checkout installs only, see 6.1) | The template ignore file excludes every primary and secondary findings output, so a committed workspace carries a `status.yaml` that says phases are complete while the artifacts it references are absent in every other clone; the dashboard's own health check flags exactly that state as a blocker (`core/dashboard.ts:233-241`). Combined with 6.1, whether findings are ignored depends on how the package was installed. | medium | observed fact | port differently |
| 9 | `core/workspace.ts:33-37` `packagedWorkspaceDir`; `tests/*` init helpers | The test suite initializes workspaces from the live `packagedWorkspaceDir`, which in a checkout is the repository's own `.codecarto/`. Any workspace state present in the checkout changes test outcomes: 18/696 fail in this clone after one phase of outputs versus 696/696 on a pristine clone at the same commit (command output, §Runtime probes). Only `tests/init-workspace-isolation.test.mjs` uses a synthetic template. | medium | observed fact | fix before porting |
| 10 | `core/status.ts:22-24`; `core/broadside.ts:49,64-65,69-70,73,85-86` | Operational constants with no override: lock retry 125 ms / timeout 5 s / stale 60 s; poll interval 15 s / budget 25 min; catalog TTL 24 h; OpenRouter URLs; built-in pricing 0.375/1.875 USD per M (the comment at `:57-63` records these having been wrong by 2× once). | low | observed fact | leave behind |
| 11 | `extensions/codecarto/phase-compaction.ts:12` `phaseIdFromSessionName` | Phase ids are matched with `^[a-z0-9][a-z0-9-]*$`, while `assertSafePhaseId` (`core/status.ts:27`) admits `.`, `_`, and uppercase; a custom pipeline using such an id silently loses the child session's bash block, write confinement, and checkpointing. | low | observed fact | fix before porting |
| 12 | `mcp-server/server.ts:1201-1203,1235` | The `> 0` guards mean a caller cannot express zero for `wait_seconds` or `max_cost` on the tool: both fall through to the config value. There is no way to say "no limit" or "no wait" per call. | low | observed fact | leave behind |
| 13 | `core/workspace.ts:42-49` `PACKAGE_VERSION` | If `package.json` is unreadable the version becomes `0.0.0`, and `describeScaffoldStaleness` (`:336-339`) then tells every workspace its scaffold is newer than the framework and to upgrade. | low | observed fact | leave behind |
| 14 | `extensions/codecarto/index.ts:1392` | Pi's library-init expands `~` by hand (`~user/x` becomes `<home>/user/x`) while `core/utils.ts:100-106` `expandTilde` exists for exactly this; MCP requires an absolute path instead. Two behaviors for one command. | low | observed fact | leave behind |

---

## Summary

### Findings by Severity

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 7 |
| Medium | 17 |
| Low | 16 |
| **Total** | 40 |

### Findings by Pass

| Pass | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| 1. Logic and correctness | 0 | 2 | 6 | 7 | 15 |
| 2. Error handling | 0 | 2 | 5 | 4 | 11 |
| 6. Config and environment | 0 | 3 | 6 | 5 | 14 |

### Top Findings

1. **Pass 1 #2** — `core/workspace.ts:137-182`: init copies findings outputs from the packaged template; a checkout-based install seeds every new workspace with the checkout's findings and validation passes on them. High; fix before porting (add `findings/**` outputs, `scratch/`, `dashboard.html` to the init exclusion set, or seed from a template manifest instead of the live tree).
2. **Pass 6 #1** — `package.json` `files`: `.codecarto/.gitignore` is not shipped, so npm-installed workspaces commit dashboards and usage logs that embed absolute paths. High; fix before porting (add the path explicitly to `files`).
3. **Pass 1 #1** — `core/yaml.ts:355-364` + `core/status.ts:229`: unquoted emission of scalar-looking strings; a digit-only repo name bricks the workspace on the next load. High; fix before porting (quote any string `parseYamlScalar` would not return unchanged; make `normalizeStatus` coerce with `String()`).
4. **Pass 6 #3** — `mcp-server/server.ts:1201-1204` / `extensions/codecarto/index.ts:1175-1176`: `wait_seconds: 0` on collect becomes a 25-minute block. High; fix before porting (pass `0` through as `waitMs: 0`).
5. **Pass 6 #2 / Pass 2 #1** — `core/broadside.ts:1790,1756-1765`: no spend cap by default, and a config typo removes a configured cap, on the surface that cannot ask. High; fix before porting (ship a default `max_cost`, and refuse to submit when the config file exists but failed to parse).
6. **Pass 2 #2** — `core/broadside.ts:1657-1667,1735-1741`: a corrupt `state.json` is silently replaced, orphaning paid runs. High; fix before porting (refuse to persist over an unparseable state file; keep a `.bak`).

### Routed To Semantic Phase

Mirrored as `carry_forward` entries in `scratch/handoffs/defect-scan-mechanical.yaml`; the table documents, the handoff routes.

| ID | Description | Why Routed |
|----|-------------|-----------|
| mech-CF1 | `core/status.ts:424-426`: `release()` removes the lock file unconditionally. After another process breaks a stale lock (`:433-437`) and acquires its own, the original holder's release deletes the new holder's lock. | Lock/race analysis is pass 3. |
| mech-CF2 | `core/utils.ts:57-68` `isWithinPathResolved` falls back to a lexical check when the target does not exist; a not-yet-existing file under a symlinked directory inside `.codecarto/` passes the Pi write guard (`extensions/codecarto/index.ts:436-448`). `tests/symlink-sandbox.test.mjs` covers only existing paths. | Trust-boundary analysis is pass 4. |
| mech-CF3 | `mcp-server/server.ts:704-708` `handlePublish` adds `join(args.cwd, ".codecarto")` to the `spec_path` containment roots without validating `cwd` is absolute when `library_path` is supplied; a relative `cwd` resolves against the server process's directory. | Containment/trust boundary is pass 4. |
| mech-CF4 | `extensions/codecarto/auto-runner.ts:170,387` read `ctx.cwd` after a phase sub-agent has run, while `:321-323` and `index.ts:755-760` capture `cwd` beforehand because "the sub-agent replaces the session, which invalidates this ctx"; `agent-runner.ts:2-3` says the runner deliberately does *not* replace the session. Whether the ctx is invalidated decides whether `--auto` crashes at the first validation. Candidate answer to `q-pi-ctx-invalidation`. | Needs the Pi SDK's actual behavior (runtime) and pass 3/5 framing. |
| mech-CF5 | `core/broadside.ts:2678` `runBroadsideCollect` always targets `state.runs[last]`; a `submit` that lands between a collect's load and its persist retargets the collect to the new run (the lost-update fix at `:1721-1741` protects the file, not the selection). | Interleaving analysis is pass 3. |
| mech-CF6 | `core/library.ts:588-726,933-993`: publish and reindex have no cross-process lock; two publishes of the same slug can both compute `nextVersion` from the same `listVersionDirs` and one `rename` into `v<N>` fails or the index is written from a partial view. | Race analysis is pass 3. |

---

## Open Questions

| ID | Kind | Question | Why source cannot settle it | Derived findings |
|----|------|----------|-----------------------------|------------------|
| q-pi-ctx-invalidation | needs-runtime-test | Does running a phase through `createAgentSession` (not `ctx.newSession`) invalidate the orchestrator's `ExtensionContext`, so that `ctx.cwd` throws afterwards? | The repository's own comments contradict each other (`agent-runner.ts:2-3` vs `auto-runner.ts:321-323`, `index.ts:755-760`), the SDK source was not read, and the test harness cannot spawn a real sub-agent (`tests/pi-command-handlers.test.mjs:170-177`). | none in this report carry a settled action on it; mech-CF4 is routed with `derives_from` |

---

## Runtime probes

Recorded so the evidence cells above can be checked. All run in the scratch clone on 2026-09-11 with Node v22.22.3.

1. `npm ci && npm test` in this clone (after the architecture phase wrote its outputs): `# tests 696 / # pass 678 / # fail 18`. Failing names include `handleValidate returns MISSING for a fresh workspace` (`tests/mcp-server.test.mjs:79`, actual `PASS`), `refresh restores framework-owned files byte-identically to the packaged template`, `updateStatusAtomically accepts a handoff and writes it to the phase`.
2. Same command on a fresh `git clone` of this clone at commit `f6f8484` with no workspace outputs: `# tests 696 / # pass 696 / # fail 0`.
3. `node --experimental-strip-types` probe script importing `core/yaml.ts` and `core/status.ts`:
   - A: `parseSimpleYaml("project_name: 2048\n…")` → `{"project_name":2048,…}`.
   - A2: `normalizeStatus(<that>, …)` → throws `status.project_name?.trim is not a function`.
   - B: `stringifySimpleYaml({project_name:"2048", note:"true", n:"null"})` → `project_name: 2048\nnote: true\nn: null`.
   - B2: round trip of `owner_notes: ["true","42","real note"]` → `[true, 42, "real note"]`.
   - C / C2: sequence item `- id: x` followed by `kind: y` indented 3 or 4 columns → throws `Invalid YAML indentation near: kind: y`.
   - D: `k: first line\n  second line` → throws `Invalid YAML indentation near: second line`.
   - F: `createEmptyStatus(...).current_phase` → first phase id.
4. `npm pack --dry-run`: `npm notice total files: 100`, `package size: 122.5 kB`, `grep -c '\.codecarto/\.gitignore'` → `0`.

---

## Coverage and limits

- Inspected scope: all 19 `core/` modules, both `mcp-server/` files, all 16 `extensions/codecarto/` files, `scripts/smoke-mcp.mjs` and `scripts/smoke-broadside.mjs`, the three workflows, `package.json`, `tsconfig.json`, `.codecarto/.gitignore`, `.codecarto/broadside/config.yaml` (as config surface). Tests: the suite was executed twice; bodies read for `tests/open-questions.test.mjs:196-230`, `tests/mcp-uncovered-handlers.test.mjs:70-116`, `tests/mcp-library.test.mjs:15-30`, `tests/pi-command-handlers.test.mjs:165-200`, `tests/symlink-sandbox.test.mjs` (case names), `tests/broadside.test.mjs:496-549,1492,1541`; the rest of `tests/` was consulted by grep only.
- Skipped scope: `core/dashboard.ts` CSS and the inline dashboard script (`:628-666,780-911`) were not scanned for logic; `extensions/codecarto/agent-widget.ts` rendering was skimmed; the two demo scripts under `scripts/` beyond their headers; `docs/`; `.codecarto/` prompts, templates, and skills (out of scope). Concurrency, security, and API-contract angles were noted but not analyzed (routed).
- Evidence basis: source inspection; tests (executed and excerpted); runtime verification (the four probes above); upstream findings (architecture map §Concurrency Model for the lock/atomic-write inventory).
- Known blind spots: (1) every claim about what OpenRouter returns (HTTP 202, `usage.cost`, `request_counts`) is read off the code's parsing and is untested here; (2) Pi SDK behavior is unverified — see `q-pi-ctx-invalidation`; (3) `core/broadside.ts` collect/retry/post-pass branches (`:2663-3021`) were traced for the findings listed but not exhaustively for every status combination; (4) severity for Broad-Side findings assumes MCP-driven runs without a human confirm, which is the surface's documented posture.
- Coverage disposition: COMPLETE for passes 1, 2, and 6 at file granularity; branch-level exhaustiveness inside Broad-Side collect is PARTIAL and inherited by the semantic scan.

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | At least two of the three mechanical passes (1, 2, 6) produced findings or documented "no defects found." | PASS | All three passes have findings tables: Pass 1 (15), Pass 2 (11), Pass 6 (14). |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS | Every row in the three tables fills Location (file:line + symbol), Severity, Evidence Level, Action. |
| 3 | Findings are organized by pass and sorted by severity. | PASS | Three `## Pass N` sections; each table ordered high → medium → low. |
| 4 | Summary tables are complete and counts match the detailed findings. | PASS | §Summary: 7 high + 17 medium + 16 low = 40; per-pass 15 + 11 + 14 = 40, matching the numbered rows. |
| 5 | Findings are marked with evidence levels. | PASS | Evidence Level column on every row; 39 `observed fact`, 1 `strong inference` (Pass 1 #14). |
| 6 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits, all bullets filled; disposition COMPLETE/PARTIAL split stated. |
| 7 | Unsettled findings (evidence level open question or external-behavior claim) carry an unsettled action (verify at runtime or port differently on pre-porting pipelines; investigate on maintenance pipelines), never a settled one, and each appears in the Open Questions table. | PASS | No row uses `open question` or `external-behavior claim`; the one runtime unknown (`q-pi-ctx-invalidation`) is registered in §Open Questions and routed as mech-CF4 with `derives_from`, carrying no settled action. |
| 8 | Every quantitative specific in a finding (size, count, default, version, timeout) cites the file and line or command output it was read from, or is marked as an estimate. | PASS | Timeouts/limits cite `core/status.ts:22-24`, `core/broadside.ts:64-65,73,85-86,1606`; counts (18/696, 696/696, 100 files, 122.5 kB, 0 matches) cite the commands in §Runtime probes. |

**Validated by:** 2026-09-11 (defect-scan-mechanical, self-audit session 1, inline MCP host)
**Overall:** PASS
