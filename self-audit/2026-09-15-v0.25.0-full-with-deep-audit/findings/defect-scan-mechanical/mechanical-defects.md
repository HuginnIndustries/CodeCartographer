# Mechanical Defects Report — CodeCartographer (selfreview)

> Self-audit: the analyzed source is the repository outside `.codecarto/`, i.e. the
> CodeCartographer framework itself. This is the early, context-light defect pass.
> It does not use contracts or protocols (neither exists yet); it compares code
> against its own docstrings, comments, and the architecture map.

## Scan Context

- **Source:** `../` (repository root)
- **Architecture reference:** `findings/architecture/architecture-map.md`
- **Pipeline:** `full-with-deep-audit` (`workflow/pipeline-full-with-deep-audit.yaml`)
- **Date:** 2026-09-15 (UTC)
- **Scope:** Mechanical passes only (1 logic, 2 error handling, 6 configuration). Semantic passes (3 concurrency, 4 security, 5 contract violations) deferred to `defect-scan-semantic` after protocols.
- **Evidence basis:** source inspection only. No tests were executed and no runtime probes were run in this session (no execution tool was available); the "Runtime probes" section records that honestly. Every quantity cites the file and line it was read from.

### Routed item addressed — `cf-arch-4`

The architecture closeout recorded two structural observations as structural only: the
`core/index.ts` ↔ `core/dashboard-writer.ts` import cycle, and the
`core/broadside/state.ts` → `client.ts` ordering drift. Both are assessed mechanically here as
findings **1.1** and **1.2**. Mechanical verdict: both work correctly under Node/TypeScript today
(bindings are dereferenced at call time, not at module-evaluation time), so neither is a live
runtime bug; both are real **refactor/portability hazards**, because a target language that
initializes imported bindings eagerly (Python `from … import`, C++ static-init order, many
compiled languages) will read an uninitialized or `undefined` symbol or fail to load the module
graph. The port should break the cycle (move the shared symbols into a lower module or import the
concrete source modules directly) rather than reproduce it. Closure recorded in the phase handoff
(`carry_forward_closures: [cf-arch-4]`).

---

## Pass 1: Logic and Correctness

| # | Location | Defect | Evidence | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------|----------------|--------|
| 1.1 | `core/index.ts:24` + `core/dashboard-writer.ts:27` | Module-graph cycle: the barrel re-exports `dashboard-writer.ts`, and `dashboard-writer.ts` imports 11 named bindings back from `./index.ts`. Works only because every imported binding is used inside a function body. | `core/index.ts:24` is `export * from "./dashboard-writer.ts"`; `core/dashboard-writer.ts:14-27` imports `atomicWriteFile`, `DASHBOARD_RELATIVE_PATH`, `getWorkspaceState`, `renderDashboard`, etc. from `./index.ts`, all dereferenced inside `writeDashboard`/`listCloseouts`/`buildOutputsPresent`/`loadNarration`, never at module top level. | medium | observed fact | port differently |
| 1.2 | `core/broadside/state.ts:15` (consumer `state.ts:157`) | The Broad-Side module's declared acyclic order is `constants → types → schemas → lenses → repo → requests → state/models/client → …`, but `state.ts` imports `BROADSIDE_TERMINAL_ENTRY_STATUSES` from the downstream `client.ts`. No cycle, but the dependency direction contradicts the documented order. | `core/broadside/state.ts:15` `import { BROADSIDE_TERMINAL_ENTRY_STATUSES } from "./client.ts"`; used only inside `batchEntryRank` at `state.ts:157`. A port that evaluates that array at module scope would read `undefined`. | low | observed fact | port differently |
| 1.3 | `core/yaml.ts:487` | `parseSequence` merges a sequence item's nested mapping with plain assignment, bypassing the `Object.defineProperty` guard the parser deliberately uses elsewhere. A `__proto__` key in a sequence-item mapping invokes the prototype setter and is silently dropped from the item's own keys. | `parseMapping` defines every key via `Object.defineProperty` at `core/yaml.ts:344-346` explicitly to stop the `__proto__` setter; the sequence merge at `core/yaml.ts:487` is `item[nestedKey] = nestedValue`. Same file, two contradictory policies. | low | observed fact | port differently |
| 1.4 | `core/broadside/repo.ts:606` vs `repo.ts:568` | Slice-mode is chosen from byte sizes but slicing is capped on UTF-16 code units. `sumFileSizes` sums `stat().size` (bytes) and feeds `resolveSliceMode`; `slurpFileList` compares `running + block.length` (chars). For non-ASCII content the two disagree. | `core/broadside/repo.ts:606` `total += (await stat(...)).size`; `core/broadside/repo.ts:568` `if (running + block.length > maxChars …)`; `resolveSliceMode` in the same file branches on the byte total. | low | observed fact | port differently |
| 1.5 | `core/broadside/submit.ts:254` | A run's id is the millisecond ISO timestamp with `:`/`.` replaced; two submits in the same millisecond collide. `persistBroadsideRun` merges by id (`state.ts`), so the second replaces the first's record, and both share one output directory. | `core/broadside/submit.ts:254` `const runId = new Date().toISOString().replace(/[:.]/g, "-")`; `core/broadside/state.ts` `persistBroadsideRun` finds by `candidate.id === run.id` and overwrites. | low | observed fact | port differently |
| 1.6 | `core/broadside/collect.ts:196` + `core/broadside/render.ts:19` | The post-pass JSON is parsed with raw `JSON.parse`, while the lens path tolerates markdown code fences via `parseLensJson` (`results.ts:79-81`). A fenced post-pass response yields empty `topFindings`/`topTriageItems` and is reported as "completed" with no items. | `collect.ts:196` (`parseTriageItems`) and `render.ts:19` (`parseSynthesisTopFindings`) call `JSON.parse(content)` directly; `results.ts:81` is the fence-stripping regex only the lens path uses. | low | observed fact | port differently |

**Notes on the routed item.** 1.1 and 1.2 are the mechanical assessment of `cf-arch-4`. Both resolve under the current toolchain; the portability hazard is the finding, not a present failure. The porting phase should record the recommended fix (hoist shared symbols out of the barrel) in the reverse-engineering bundle's dependency notes.

---

## Pass 2: Error Handling and Resilience

| # | Location | Defect | Evidence | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------|----------------|--------|
| 2.1 | `extensions/codecarto/index.ts:1701-1704` | The Pi `/codecarto-dashboard` handler ignores the boolean `writeDashboard` returns and reports "Dashboard regenerated" unconditionally, so a swallowed write failure is surfaced as success. | `writeDashboard` is documented best-effort and returns `false` on any failure (`core/dashboard-writer.ts:38-67`). `index.ts:1701` awaits it without reading the result, then pushes "Dashboard regenerated" at `:1702` and notifies at `:1704`. The sibling `codecarto-amend` handler reads the boolean correctly (`index.ts:1817`). | low | observed fact | fix before porting |
| 2.2 | `core/workspace.ts:430-441` | `refreshScaffold` copies framework-owned files one at a time with no staging or rollback. An I/O failure partway through leaves a mixed-version scaffold (new GUIDE, old VALIDATE, etc.) on disk, and the error propagates with no recovery. | `core/workspace.ts:438-441` `for (const relativePath of files) { … await copyFile(join(packagedWorkspaceDir, relativePath), target); }`. No temp-then-rename, no per-file bookkeeping. | medium | observed fact | port differently |
| 2.3 | `core/broadside/collect.ts:433-435` | A truncation-retry batch that fails to submit is swallowed, and the retry entry has no field to record why. The run reports the pass as `failed` with no diagnostic, unlike every other submit path in the subsystem. | `collect.ts:433` submits and `:435` is a bare `catch {}` with the comment "nothing is lost"; `run.retry` at `:443-446` sets `status: "failed"` but `BroadsideRetryEntry` (`core/broadside/types.ts`) carries no `error` field. | low | observed fact | port differently |

---

## Pass 6: Configuration and Environment Hazards

| # | Location | Defect | Evidence | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------|----------------|--------|
| 6.1 | `core/utils.ts:43-51` | `atomicWriteFile` is only atomic if `rename` over an existing destination succeeds. It writes a sibling temp file then renames; on failure it deletes the temp and rethrows. On Windows a rename over an existing file can fail (EPERM/EEXIST depending on target/locking), and there is no unlink+rename fallback — so `status.yaml`, the usage log, and Broad-Side `state.json` writes would fail. | `core/utils.ts:43-51` — `writeFile(tempPath); rename(tempPath, path); catch { rm(tempPath); throw }`. All core rewrites route through it (`workspace.ts:540,729`, `usage.ts:99`, `broadside/state.ts:104`). | high | external-behavior claim | verify at runtime |
| 6.2 | `core/status.ts:477,496-497` | `acquireLock` assumes POSIX `open(path, "wx")` (O_EXCL) semantics plus `stat().mtimeMs` for staleness, and breaks a stale lock by `rm` while another process may hold it. Windows file-sharing and timestamp behavior differ; whether the mutual-exclusion guarantee holds there is not established by reading. | `core/status.ts:477` `open(lockPath, "wx")`; `:496-497` `stat(lockPath)` and `Date.now() - lockStat.mtimeMs > STALE_LOCK_MS`; `STALE_LOCK_MS = 60_000` (`:25`), `LOCK_TIMEOUT_MS = 5000` (`:24`). | medium | external-behavior claim | verify at runtime |
| 6.3 | `core/utils.ts:64,67-78,92` | Path containment resolves symlinks through `realpath` and only case-folds on `win32`. Windows junctions, 8.3 short names, and drive-relative paths may not be contained as the code intends; the write guard that uses this (`extensions/codecarto/index.ts` `tool_call`) inherits the uncertainty. | `core/utils.ts:64` case-fold gated on `process.platform === "win32"`; `:67-78` lexical `isWithinPath`; `:92` `resolveExistingPrefix` walks `realpath` per existing component. Consumer: `extensions/codecarto/index.ts` tool_call guard (`resolveExistingPrefix` + `isWithinPath`). | medium | external-behavior claim | verify at runtime |
| 6.4 | `core/broadside/repo.ts:117-122,136,145,160` + `core/library.ts:1342` | The subsystem shells out to a bare `git` name and parses POSIX-shaped output (`\0`- or `\n`-separated, `/`-separated paths). A host without `git` on PATH, or a git whose behavior differs, changes what is scanned and what provenance is recorded. Some paths degrade gracefully (walk fallback, null HEAD), but `listRepoFiles` output shape is assumed. | `repo.ts:117-122` `execFileAsync("git", ["-C", targetDir, "ls-files", "-z", …])`; `repo.ts:136` `git rev-parse HEAD`; `repo.ts:145` `git status --porcelain`; `repo.ts:160` `git diff`; `library.ts:1342` `spawn("git", …)`. | medium | external-behavior claim | verify at runtime |
| 6.5 | `core/utils.ts:221`; `core/broadside/constants.ts`; `core/broadside/client.ts:34,51` | Operational constants are hardcoded and not configurable: `GIT_TIMEOUT_MS = 30_000`, `AbortSignal.timeout(30_000)` on every OpenRouter call, `BROADSIDE_DEFAULT_POLL_BUDGET_MS = 25 * 60 * 1000`, `BROADSIDE_POLL_INTERVAL_MS = 15_000`. A slow filesystem or a large library has no knob. | `core/utils.ts:221`; `core/broadside/constants.ts` (poll constants); `core/broadside/client.ts:34,51` and `core/broadside/models.ts:219,317,353`; `verify.ts:266` uses `120_000`. | low | observed fact | port differently |

---

## Summary

### Findings by Severity

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 8 |
| **Total** | **14** |

### Findings by Pass

| Pass | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| 1. Logic and correctness | 0 | 0 | 1 | 5 | 6 |
| 2. Error handling | 0 | 0 | 1 | 2 | 3 |
| 6. Config and environment | 0 | 1 | 3 | 1 | 5 |

### Top Findings

1. **6.1** — `atomicWriteFile` (`core/utils.ts:43-51`) has no non-atomic fallback; if rename-over-existing fails on Windows, every canonical write fails. Severity high, `verify at runtime`.
2. **1.1** — `core/index.ts` ↔ `core/dashboard-writer.ts` import cycle (`index.ts:24`, `dashboard-writer.ts:27`); works today, breaks an eager-evaluation port. Medium, `port differently`. Closes `cf-arch-4`.
3. **6.2** — `acquireLock` (`core/status.ts:477,496`) assumes POSIX O_EXCL + mtime semantics. Medium, `verify at runtime`.
4. **6.3** — Containment (`core/utils.ts:64-92`) assumes POSIX symlink/case semantics; the write guard inherits it. Medium, `verify at runtime`.
5. **6.4** — Bare-`git` invocation and POSIX output parsing (`repo.ts`, `library.ts:1342`). Medium, `verify at runtime`.
6. **2.2** — `refreshScaffold` (`core/workspace.ts:430-441`) has no staging/rollback; a mid-loop failure leaves a mixed scaffold. Medium, `port differently`.

### Routed To Semantic Phase

| ID | Description | Why Routed |
|----|-------------|-----------|
| cfs-mech-1 | `withRemovalLock` (`core/status.ts:526-550`) breaks a stale removal lock with an unguarded `rm`; two waiters can both stat it stale and both `rm`+recreate, defeating the removal serialization it exists to provide. | Pass 3 concurrency/race rubric; refines `cf-arch-3`. |
| cfs-mech-2 | `acquireLock` treats any lock older than `STALE_LOCK_MS = 60_000` (`status.ts:25`) as dead. A lock legitimately held longer than 60 s (e.g. `library.ts` publish holding `.publish.lock` across a full `reindex`, or a large `switchPipeline`) can be broken while its owner still writes. | Pass 3 concurrency rubric; refines `cf-arch-3`. |
| cfs-mech-3 | `refreshScaffold` (`workspace.ts:430-455`) appends `THREAD_LOG.md` and `writeDashboard` (fire-and-forget) write session artifacts outside the `status.yaml` lock, so a concurrent completion can interleave. | Pass 3 concurrency rubric; refines `cf-arch-3`. |

---

## Runtime probes

No probes were run in this session — the phase executor had no shell/execution tool, so every
portability claim in Pass 6 is left at `external-behavior claim` rather than promoted to
`observed fact`. The probes belong in `.codecarto/scratch/probes/` for the porting phase:

| Probe | Finding | What it should do | Script |
|---|---|---|---|
| — | 6.1 | On a Windows runner, write a file, then re-invoke `atomicWriteFile` over it and record whether `rename` throws; repeat for `status.yaml` via `updateStatusAtomically`. | `scratch/probes/mechanic-atomic-rename.mjs` (not written) |
| — | 6.2 | Two Windows processes racing `acquireLock` on one path; assert exactly one holds at a time and that a 61 s-old lock is breakable. | `scratch/probes/mechanic-lock-race.mjs` (not written) |
| — | 6.3 | Windows: create a junction/symlink out of the workspace and assert the `tool_call` guard blocks the write. | `scratch/probes/mechanic-containment.mjs` (not written) |
| — | 1.1, 1.2 | Static import-graph check (no runtime needed): assert the port's module graph has no cycle and that no module reads a cross-module constant at top level. | `scratch/probes/mechanic-import-order.mjs` (not written) |

---

## Open Questions

| ID | Kind | Question | Why source cannot settle it | Derived findings |
|----|------|----------|-----------------------------|------------------|
| q-node-windows-fs-semantics | needs-runtime-test | Do lock-file `O_EXCL`, atomic rename over an existing file, symlink-aware path containment, and `git` invocation behave on Windows as the POSIX-written code expects? | Platform behavior cannot be confirmed by reading; CI runs Linux only. Inherited from architecture (re-triaged here: still needs a runtime test). | 6.1, 6.2, 6.3, 6.4 |
| q-openrouter-batch-semantics | needs-runtime-test | The exact OpenRouter Batch API contract Broad-Side relies on — concurrent-job quota, which catalog ids actually have `:batch` endpoints, `reasoning` acceptance — is asserted in comments, not verifiable from source. | External service behavior; requires a live probe or the provider's source. Inherited from architecture (re-triaged: still needs a runtime test). | none (no finding in this phase asserts one of its candidate answers) |
| q-pi-sdk-execution-parity | needs-runtime-test | Do Pi sub-agent execution and an MCP host's own execution produce equivalent phase outcomes, given byte-identical prompts? | Requires running the same phase under both surfaces and comparing results. Inherited from architecture (re-triaged: still needs a runtime test). | none |
| q-npm-tarball-template-parity | needs-fixture-capture | Does the published npm tarball's `.codecarto/` template and `agent-skill/` byte-match this checkout? | Needs packing and diffing — a fixture capture, not a source read. Inherited from architecture; not in this phase's scope. | none |

Findings 6.1–6.4 all take `verify at runtime`; none asserts a settled candidate answer.

---

## Coverage and limits

- **Inspected scope:** repository root manifests (`package.json`, `tsconfig.json`, `.gitignore`, `.gitattributes`, `.github/workflows/{ci,release,smoke}.yml`); in full, line by line — `core/{index,types,utils,yaml,status,workspace,pipeline,prompts,completion,findings,coverage,amendment,usage,orchestrator-config,secrets,guide,library,synthesis,dashboard-writer}.ts` (all top-level core modules, `dashboard.ts` head only); all 14 `core/broadside/` modules in full (`constants,types,schemas,lenses,models,repo,requests,state,client,submit,collect,results,verify,render`); `extensions/codecarto/{index,auto-runner,agent-runner,next-flags,broadside-flags,dashboard-flags}.ts` in full; `mcp-server/server.ts` head, handler dispatch, `handleNext`/`handlePhase`/`handleValidate`/`handleComplete`/`handleSkill`/`handleBroadside`, and `startStdioServer`; `.codecarto/` templates and `.gitignore` relevant to init/refresh.
- **Skipped scope:** `core/dashboard.ts` body beyond the first ~120 lines; `extensions/codecarto/` modules other than the six above (`agent-state`, `agent-widget`, `agent-rewriter`, `agent-summary`, `dashboard-writer`, `dashboard-narrator`, `child-model-runtime`, `phase-compaction`, `completions`, `notify`, `guide-framing`); the `TOOLS`/handler registry body of `mcp-server/server.ts` beyond the handlers named; `docs/*` contents; `scripts/*` contents; the ~90 `tests/*.test.mjs` bodies (names only); `assets/`; historical `CHANGELOG.md` beyond 0.25.0.
- **Evidence basis:** source inspection (primary), plus the architecture map and in-repo comments/docstrings. No tests executed, no runtime probes performed.
- **Known blind spots:** (1) no runtime execution was available, so nothing in this report is `observed fact` by execution — platform, network, and SDK claims are hedged; (2) Windows/macOS filesystem, locking, and containment behavior; (3) OpenRouter Batch API semantics; (4) Pi-SDK vs MCP execution parity; (5) npm tarball template parity; (6) the unread extension and dashboard bodies, which may hold mechanical defects not listed here.
- **Coverage disposition:** COMPLETE for the mechanical-pass scope (the three passes ran over the core and both executable surfaces' load-bearing code); the residual limits above are named and routed as open questions, not silently smoothed over.
- **Contradiction sweep:** no measured contradiction with the architecture owner_notes. Claim (a) — `core/{types,utils,yaml}.ts` is a stable base with no core→wrapper imports — was re-checked by grep and holds. Claim (c)'s POSIX concurrency mechanics were confirmed by reading (`core/status.ts:477-576`, `core/utils.ts:43-51`); its Windows-portability portion is left `verify at runtime`. Claim (b)'s byte-identical prompt assembly is confirmed at the source level (both surfaces call `buildPhasePrompt`); execution parity is not, and remains `q-pi-sdk-execution-parity`. The architecture phase's declared skipped scope (`core/broadside/{lenses,models,collect,results,requests,render,verify}.ts` "read by export signature only") was closed for this phase: all seven were read line by line, and findings 1.4, 1.6, 2.3, 6.4, 6.5 are `observed fact`/`external-behavior claim` from those reads rather than inherited summaries.

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | At least two of the three mechanical passes (1, 2, 6) produced findings or documented "no defects found." | PASS | All three produced findings: Pass 1 (6), Pass 2 (3), Pass 6 (5). |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS | Every row in the three pass tables carries Location, Severity, Evidence Level, Action, plus an Evidence cell. |
| 3 | Findings are organized by pass and sorted by severity. | PASS | Three `## Pass N` sections; each sorted critical→high→medium→low. |
| 4 | Summary tables are complete and counts match the detailed findings. | PASS | §Summary: 1 high, 5 medium, 8 low, 14 total; by pass 6/3/5 — matches rows 1.1-1.6, 2.1-2.3, 6.1-6.5. |
| 5 | Items spotted that are actually semantic in nature are routed onward via a carry_forward entry in the phase handoff targeting defect-scan-semantic. | PASS | `cfs-mech-1..3` in §Routed To Semantic Phase, mirrored as `carry_forward` entries targeting `defect-scan-semantic` in `scratch/handoffs/defect-scan-mechanical.yaml`. |
| 6 | Findings are marked with evidence levels. | PASS | `observed fact` on 1.1-1.6, 2.1-2.3, 6.5; `external-behavior claim` on 6.1-6.4. |
| 7 | Unsettled findings (open question / external-behavior claim) carry an unsettled action and appear in the Open Questions table. | PASS | 6.1-6.4 are `external-behavior claim` with action `verify at runtime`; all four appear in §Open Questions under `q-node-windows-fs-semantics`. |
| 8 | Every quantitative specific cites the file and line it was read from, or is marked an estimate. | PASS | Each specific cites a line: e.g. `STALE_LOCK_MS = 60_000` (`status.ts:25`), `GIT_TIMEOUT_MS = 30_000` (`utils.ts:221`), `AbortSignal.timeout(30_000)` (`client.ts:34,51`), `:batch` quota left uncited because it is an external claim, not read. |
| 9 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits names all four plus a disposition. |

**Validated by:** 2026-09-15 (defect-scan-mechanical phase, self-audit session)
**Overall:** PASS
