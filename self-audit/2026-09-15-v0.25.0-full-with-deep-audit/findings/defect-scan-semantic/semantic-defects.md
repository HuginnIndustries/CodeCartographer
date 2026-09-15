# Semantic Defects Report — selfreview

> Self-audit: the analyzed source is the repository outside `.codecarto/`, i.e. the
> CodeCartographer framework itself. This is the deep, context-rich half of the defect
> scan. It uses the contracts and protocols reports as the spec the code is compared
> against, and reads the mechanical pass so it does not re-flag what was covered there.
>
> This phase closes the four routed concurrency items: `cf-arch-3` (the concurrency
> paths mapped but not audited), and `cfs-mech-1`/`cfs-mech-2`/`cfs-mech-3` (the three
> lock/scope sightings the mechanical phase routed here). §Carry-Forward Closure records
> each verdict. No runtime probes ran (no execution tool this session), so every finding
> that lands on a platform/OS behavior rather than the code's own logic carries
> `verify at runtime` per CONVENTIONS C03.

## Scan Context

- **Source:** `../` (repository root); the analyzed source is the framework itself.
- **Architecture reference:** `findings/architecture/architecture-map.md` (§Concurrency Model).
- **Contracts reference:** `findings/contracts/behavioral-contracts.md`.
- **Protocols reference:** `findings/protocols/protocols-and-state.md` (SM1–SM7, P1–P17).
- **Mechanical defects reference:** `findings/defect-scan-mechanical/mechanical-defects.md`.
- **Pipeline:** `full-with-deep-audit` (`workflow/pipeline-full-with-deep-audit.yaml`).
- **Date:** 2026-09-15 (UTC).
- **Scope:** Semantic passes only (3 concurrency/resources, 4 security/trust, 5 API
  contract violations). Mechanical passes (1 logic, 2 error handling, 6 configuration)
  were covered earlier in `defect-scan-mechanical`.
- **Evidence basis:** source inspection (primary) plus the contracts and protocols
  reports. **No tests were executed and no runtime probes ran this session** (no
  execution tool), so every claim here is a read of the code, not an observed pass.

### Carry-forward context

| ID | Source | Routed claim | Verdict in this report |
|----|--------|--------------|------------------------|
| `cf-arch-3` | architecture | Concurrency-sensitive paths (status lock/stale-break, atomic writes, completion commit point, Broad-Side slot claims/merges, sub-agent re-entry) mapped but not audited for races. | **Addressed** — findings 3.1–3.7 audit each named path; the completion commit point (SM2) is sound, the lock/stale-break, sub-agent re-entry, and reindex/publish paths are not. |
| `cfs-mech-1` | defect-scan-mechanical | `withRemovalLock` breaks a stale removal lock with an unguarded `rm`; two waiters can both remove it and defeat the removal serialization. | **Confirmed, refined** — finding 3.1. The race is real and, combined with the non-atomic `stat → describeLockHolder → rm` inside `breakStaleLock`, can delete a *fresh* lock. |
| `cfs-mech-2` | defect-scan-mechanical | `acquireLock` treats any lock older than `STALE_LOCK_MS = 60_000` as dead; a legitimately long-held lock can be broken while its owner still writes. | **Confirmed** — finding 3.2; the publish lock held across `reindex` is the concrete long-held case. |
| `cfs-mech-3` | defect-scan-mechanical | `refreshScaffold` appends `THREAD_LOG.md` and fires `writeDashboard` outside the status lock. | **Partially confirmed** — finding 3.3. The lock-scope gap is real (framework files are overwritten and `THREAD_LOG` appended with no lock, via non-atomic `copyFile`). The claimed `writeDashboard` call is **not present** in the current source; see the contradiction note in §Coverage and limits. |

---

## Pass 3: Concurrency and Resource Management

The concurrency model is single-threaded async within one process, with cross-process
coordination only through advisory lock files (`core/status.ts`) and atomic renames
(`core/utils.ts`) (`observed fact`, architecture §Concurrency Model; protocols P17). Every
finding below is a defect in that code's own ordering logic, not a POSIX-vs-Windows
question, unless the row's Evidence Level says otherwise.

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 3.1 | `core/status.ts:526-552` `withRemovalLock`; `:562-575` `breakStaleLock` | **cfs-mech-1 — the removal lock's own stale-break is unguarded, and the stale check is not atomic with the removal it authorizes.** `withRemovalLock` waits on `<lock>.break`; when it sees that file older than `BREAK_LOCK_STALE_MS = 5000` (`status.ts:31`) it does a bare `rm(breakPath, {force:true})` and retries (`status.ts:537-540`). Two waiters that both observed the `.break` file stale can both `rm` it; the second `rm` deletes the `.break` file the first just re-created, so both then `open(breakPath,"wx")` successfully and both run `remove()`. That defeats the serialization the `.break` lock was added for (#342). The harm is concrete because `breakStaleLock`'s callback is `stat(lockPath)` → **`await describeLockHolder(lockPath)` (a second async read, `status.ts:571`)** → `rm(lockPath)` (`:572`): with two removers running, one can stat the main lock as stale while a creator replaces it, and the trailing `rm` then deletes the *fresh* holder's lock. | medium | observed fact | fix before porting |
| 3.2 | `core/status.ts:25` `STALE_LOCK_MS = 60_000`; `:496-500` | **cfs-mech-2 — a fixed 60 s mtime age is treated as death, but several holders legitimately exceed it and the lock's mtime is never refreshed.** `acquireLock` compares `Date.now() - lockStat.mtimeMs > STALE_LOCK_MS` and breaks the lock. `publishEntry` holds `.publish.lock` across the whole publish *including a full `reindex`* (`core/library.ts:619` acquires the lock; `reindex` walks every namespace/slug/version directory and rewrites `index.yaml` + `INDEX.md`, `library.ts:947-1001`); a library with many entries/versions can exceed 60 s, at which point a second publisher breaks the lock and both run the version-assignment read-modify-write that #240 fixed. `updateStatusAtomically` also holds the status lock across the post-commit artifacts, and `switchPipeline` across a pipeline load + rewrite. | medium | observed fact | fix before porting |
| 3.3 | `core/workspace.ts:430-458` `refreshScaffold`; called from `mcp-server/server.ts:1218` and `extensions/codecarto/index.ts:1733` | **cfs-mech-3 — scaffold refresh runs entirely outside the status lock and copies files non-atomically.** `refreshScaffold` calls `getWorkspaceState` (a plain read) then overwrites framework-owned files with `copyFile` (`workspace.ts:441`) — including `workflow/pipeline*.yaml`, `GUIDE.md`, and `VALIDATE.md` — and appends `THREAD_LOG.md` (`:455`), all with no `acquireLock`. A concurrent `codecarto_complete` holds the status lock and, inside it, re-reads the pipeline and writes `status.yaml` (SM2): the refresh can replace the active pipeline or a template mid-completion, and `copyFile` is not atomic, so a concurrent reader can see a half-copied pipeline YAML. The appended `THREAD_LOG` line also interleaves with completion's link-deduped append. | medium | observed fact | fix before porting |
| 3.4 | `core/library.ts:912-943` `listEntries`; `:947-1001` `reindex`; `mcp-server/server.ts:977-988` `handleLibraryReindex` | **The derived index is written without the publish lock, so a standalone reindex/list can lose a just-published version.** `publishEntry` serializes publishers on `<libraryRoot>/.publish.lock` (`library.ts:619`) and calls `reindex` under that lock. But `handleLibraryReindex` calls `reindex(libraryPath)` with no lock, and `handleLibraryList` calls `listEntries`, which calls `reindex` when the index is absent or unparseable. Two writers of `index.yaml`/`INDEX.md` are then un-serialized: a reindex that read the entry directories before a publish's `rename` can write its stale index *after* the publish wrote the fresh one, silently dropping the new version from the index until the next reindex. Derived data, regenerable, but the index is the user-facing lookup. | medium | observed fact | fix before porting |
| 3.5 | `extensions/codecarto/index.ts:797,824` and `auto-runner.ts:117,215` `isPhaseRunning` | **Sub-agent re-entry guard is check-then-act across a long async prelude.** The caller checks `isPhaseRunning(phase.id)` (`index.ts:797`; `auto-runner.ts:377`) and then calls `runSinglePhase`, which does `await buildPhasePrompt(...)` and, when `--llm-steer` is on, `await rewritePhasePrompt(...)` (a model round-trip) *before* it registers the run with `startPhase(phase.id)` (`auto-runner.ts:117`). During that window `isPhaseRunning` still returns false, so a second `/codecarto-next` (or a manual run racing `--auto`) spawns a second sub-agent for the same phase; both write the same primary output/handoff and both auto-complete. The registry is also per-process, so two surfaces on one workspace are not excluded at all. | low | observed fact | fix before porting |
| 3.6 | `core/completion.ts:395-505` `completeValidatedPhase` | **Closure-integrity gates are evaluated against a pre-lock snapshot.** `initialState` and the handoff are read before the status lock (`completion.ts:395-397`), and the `target_phase`, D1 (`derives_from`), and D3 (`needs-runtime-test` evidence) checks run on that snapshot (`:420-505`); the handoff is applied under the lock without re-running them. Protocols P7 documents this ordering deliberately ("parsed and validated before the lock"), so it is a narrow TOCTOU rather than a contract breach: a concurrent completion that adds/drops a question or phase between the check and the lock can make the pre-lock verdict wrong in either direction. | low | observed fact | port differently |
| 3.7 | `core/orchestrator-config.ts:250-287` `writeLibraryConfig` | **User-global config is read-modify-written with no lock and a non-atomic `writeFile`.** `writeLibraryConfig` reads the existing file, merges `library.path`/`namespace`, and `writeFile`s the whole file (`:286`). Two concurrent `library_init` calls (two MCP hosts, or MCP + Pi) can each read the pre-write content and the second overwrites the first's write; a crash mid-write truncates the user's shared config, which is read by every workspace on the machine. | low | observed fact | fix before porting |

---

## Pass 4: Security and Trust Boundaries

The system has no authn/authz service by design; its security model is local write
confinement plus the Broad-Side upload redaction pass (contracts §Security and
Authorization). Findings below are in that model.

| # | Location | Defect | Severity | Evidence Level | Action |
|---|----------|--------|----------|----------------|--------|
| 4.1 | `core/broadside/verify.ts:137-181,330-340` `createRepoReader` / agentic tool loop | **The `verify` upload bypasses the secret-redaction pass that `submit` applies.** `createRepoReader` filters the file list with `isSlurpable` (`verify.ts:139`), which excludes only files *named* as secret stores (`core/secrets.ts` `isSecretFile`) — it never calls `redactSecrets`. Its `read_file` (`:147-156`) and `grep` (`:157-181`) tools return raw file lines, and those outputs are placed into the chat messages sent to OpenRouter (`:340`). By contrast `submit` runs `redactSecrets` over every slice and over the manifest/entry-point/README (`core/broadside/repo.ts:253-258,551-560`; `submit.ts:59-60`). A high-confidence credential in an ordinary source file (e.g. `password = "…"` in `config.ts`) that a finding points at is therefore uploaded in cleartext during `verify`, even with the documented `redact_secrets: true`. The contracts' security model says secret shapes are "replaced with `[REDACTED:<kind>]`" before upload; that guarantee does not hold for this path. | medium | observed fact | fix before porting |
| 4.2 | `extensions/codecarto/index.ts:388,443-448,460-461` | **The orchestrator's write-confinement and bash block are reset to off on every session start and only re-armed by init/open.** `codecartoModeActive` starts `false` and is set `false` again in `session_start` (`:444`); the `tool_call` guard returns early whenever it is false (`:461`). It is set `true` only by `/codecarto-init` (`:617`) and `/codecarto-open` (`:504`). A resumed or reloaded session that continues working in a workspace has no `edit`/`write` confinement and no bash block until the user re-runs open — so the guard the contracts document as active "in CodeCartographer mode" is silently absent. The phase *sub-agent* is protected independently by `phaseCompactionExtension`'s guard, so this is an orchestrator-session defense-in-depth gap, not a sub-agent escape. | low | observed fact | port differently |
| 4.3 | `mcp-server/server.ts:673-707` `readSpecArg` | **Containment is check-then-use on a path, not a handle.** `readSpecArg` canonicalizes `args.spec_path`, checks it is within an allowed root (`:695-705`), and then calls `readFile(args.spec_path, "utf8")` on the original string. A symlink component swapped between the check and the read makes the file that is read differ from the file that was checked. Whether a swap can win this window is a filesystem/timing property the source cannot settle; POSIX symlink semantics and the `win32`-only case-fold in `isWithinPath` (`core/utils.ts:64`) are the same uncertainty mechanical finding 6.3 and `q-node-windows-fs-semantics` carry. | low | external-behavior claim | verify at runtime |

No Pass 4 gap was found in the phase child-session guard (`extensions/codecarto/phase-compaction.ts:70-89`): it blocks `bash` and confines `edit`/`write` to `.codecarto/` with the same symlink-aware shape the parent guard uses. It is *narrower* than the parent (no configured-library root), which is a contract/comment divergence rather than a vulnerability, so it is recorded as Pass 5 finding 5.1 (`observed fact`, `leave behind` as a security matter).

---

## Pass 5: API Contract Violations

Spec sources are the contracts report and the protocols report (CONVENTIONS C04: their
headings/labels are wire format).

| # | Location | Defect | Severity | Evidence Level | Action | Spec Reference |
|---|----------|--------|----------|----------------|--------|----------------|
| 5.1 | `extensions/codecarto/phase-compaction.ts:78-88` | The child-session write guard's comment says "Same containment as the parent extension's hook (#223)", but it permits only `ctx.cwd/.codecarto` — it omits the configured-library root the parent guard adds (`extensions/codecarto/index.ts:477-482`). The contracts' security model describes one Pi guard that confines `edit`/`write` to "`.codecarto/` plus a configured library". A phase that legitimately writes to the library (or a port that copies the comment's claim) diverges from the documented guard. | low | observed fact | port differently | contracts §Security and Authorization (Pi `tool_call` guard); `contracts §Feature Contracts` #1 |
| 5.2 | `core/workspace.ts:445-455` `refreshScaffold` | Scaffold refresh appends a `THREAD_LOG.md` line on every invocation with no dedupe. The contract says the refresh's retry/recovery "the copy is idempotent", and every other post-commit writer (completion, amendment) link-dedupes its `THREAD_LOG` entry so re-running regenerates rather than duplicates (CONVENTIONS C02). Re-running refresh-scaffold N times produces N `scaffold-refresh` entries. | low | observed fact | fix before porting | contracts §Feature Contracts #15 (Refresh scaffold); CONVENTIONS C02 |
| 5.3 | `core/library.ts:919-930` `listEntries` | The contract describes list as "read-only but may build an index if absent". The code also *rewrites* an existing index: when `index.yaml` exists but fails to parse, `listEntries` calls `reindex`, which overwrites `index.yaml` + `INDEX.md` (`library.ts:1000-1001`). A read command that can write is a contract divergence, and it is the same unlocked write as finding 3.4. | low | observed fact | port differently | contracts §Feature Contracts #18 (Library init / list / reindex) |

---

## Summary

### Findings by Severity

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 5 |
| Low | 8 |
| **Total** | **13** |

### Findings by Pass

| Pass | Critical | High | Medium | Low | Total |
|------|----------|------|--------|-----|-------|
| 3. Concurrency and resources | 0 | 0 | 4 | 3 | 7 |
| 4. Security and trust | 0 | 0 | 1 | 2 | 3 |
| 5. API contract violations | 0 | 0 | 0 | 3 | 3 |

### Top Findings

1. **3.1** — `withRemovalLock`'s unguarded `.break` stale-break (`core/status.ts:537-540`) lets two waiters both hold the removal lock and, with the non-atomic `stat → read → rm` in `breakStaleLock` (`:562-575`), can delete a *fresh* status lock. Medium, `observed fact`, `fix before porting`. Closes `cfs-mech-1`.
2. **3.2** — `STALE_LOCK_MS = 60_000` (`core/status.ts:25`) breaks a legitimately long-held lock; the publish lock held across `reindex` (`core/library.ts:619`) is the concrete case and re-opens the #240 version race. Medium, `observed fact`, `fix before porting`. Closes `cfs-mech-2`.
3. **4.1** — Broad-Side `verify` uploads raw file content to OpenRouter without `redactSecrets` (`core/broadside/verify.ts:147-181,340`), bypassing the `redact_secrets` guarantee `submit` honors. Medium, `observed fact`, `fix before porting`.
4. **3.4** — A standalone `library_reindex`/`library_list` writes the derived index without the publish lock (`core/library.ts:912-1001`), so it can clobber a just-published index. Medium, `observed fact`, `fix before porting`.
5. **3.3** — `refreshScaffold` overwrites framework files and appends `THREAD_LOG` outside the status lock, via non-atomic `copyFile` (`core/workspace.ts:430-458`). Medium, `observed fact`, `fix before porting`. Closes `cfs-mech-3`.
6. **3.5** — The sub-agent re-entry guard is checked before `runSinglePhase`'s async prelude (`extensions/codecarto/index.ts:797` vs `auto-runner.ts:117`), so two quick runs can spawn duplicate sub-agents for one phase. Low, `observed fact`, `fix before porting`.

### Carry-Forward Closure

| ID | Source Phase | Closed Because |
|----|--------------|---------------|
| `cf-arch-3` | architecture | Findings 3.1–3.7 audit each concurrency path it named: status lock/stale-break (3.1, 3.2), completion commit point (3.6 — the SM2 commit point itself is sound; only its pre-lock integrity checks are a narrow TOCTOU), sub-agent re-entry (3.5), and the additional lock-scope gaps (3.3, 3.4, 3.7). |
| `cfs-mech-1` | defect-scan-mechanical | Confirmed and refined as finding 3.1: the `.break` stale-break race is real, and the non-atomic `stat → describeLockHolder → rm` in `breakStaleLock` can delete a freshly acquired lock. `fix before porting`. |
| `cfs-mech-2` | defect-scan-mechanical | Confirmed as finding 3.2: the 60 s mtime death rule breaks a lock held across a long `reindex`; `fix before porting`. |
| `cfs-mech-3` | defect-scan-mechanical | Confirmed as finding 3.3 for the lock-scope and non-atomic-copy parts; the claimed `writeDashboard` call is not in the current source (contradiction routed in §Coverage and limits). `fix before porting`. |

---

## Runtime probes

No probes were run this session — the phase executor had no shell/execution tool. The
findings above are source reads; the three lock findings (3.1, 3.2, 3.4) are logic races
that a deterministic multi-process probe *could* confirm before an implementation acts on
them. Named (not written) under `scratch/probes/` for the post-pipeline spike list:

| Probe | Finding | What it should do | Script |
|---|---|---|---|
| — | 3.1 | Two processes race `acquireLock` on one path with a pre-planted stale `<lock>.break`; assert exactly one holds the main lock at all times and no fresh lock is ever deleted. | `scratch/probes/sem-removal-lock-race.mjs` (not written) |
| — | 3.2 | Hold a lock for >61 s from one process while a second calls `acquireLock`; assert the second does not break it while the holder still writes. | `scratch/probes/sem-stale-lock-ttl.mjs` (not written) |
| — | 3.4 | Run `publishEntry` and a standalone `reindex` concurrently; assert the final `index.yaml` names the new version. | `scratch/probes/sem-reindex-publish-race.mjs` (not written) |

---

## Open Questions

Inherited questions are re-triaged here (orchestrator duty). None is closed: no runtime
probe ran and no dependency source was read, so no candidate answer is asserted as
settled. Finding 4.3 depends on `q-node-windows-fs-semantics`; none of the remaining
findings asserts an answer to any of these.

| ID | Kind | Question | Why source cannot settle it | Derived findings |
|----|------|----------|-----------------------------|------------------|
| q-node-windows-fs-semantics | needs-runtime-test | Do lock-file `O_EXCL`, atomic rename over an existing file, symlink-aware path containment, and bare-`git` invocation behave on Windows/macOS as the POSIX-written code expects? | Platform behavior cannot be confirmed by reading; CI runs Linux only. Re-triaged this phase: still `needs-runtime-test`. | 4.3 |
| q-openrouter-batch-semantics | needs-runtime-test | The exact OpenRouter Batch API contract Broad-Side relies on — concurrent-job quota (`job-submission-count`), which catalog ids have `:batch` endpoints, and `reasoning` acceptance — is asserted in comments. | External service behavior; needs a live probe or the provider's own source. Re-triaged: still `needs-runtime-test`. No finding here asserts a candidate answer. | none |
| q-pi-sdk-execution-parity | needs-runtime-test | Do Pi sub-agent execution (tool sandbox, compaction, session persistence) and an MCP host's execution produce equivalent *outcomes*? | Requires running the same phase under both surfaces and comparing. Re-triaged: still `needs-runtime-test`. Finding 3.5 is about the in-process Pi guard, not outcome parity, and does not answer it. | none |
| q-npm-tarball-template-parity | needs-fixture-capture | Does the published npm tarball's `.codecarto/` template and `agent-skill/` byte-match this checkout? | Needs packing and diffing — a fixture capture, not a source read. Re-triaged: still `needs-fixture-capture`. No finding here asserts template parity. | none |

**Re-triage result (orchestrator duty):** all four keep their labels. The three
`needs-runtime-test` questions were re-tested against this phase's reads — the lock and
containment code (`core/status.ts`, `core/utils.ts`) confirms only what the code
*assumes*, not what the OS does; `core/broadside/{client,verify}.ts` confirms only what is
*sent*. Finding 4.3 inherits `q-node-windows-fs-semantics` and carries `verify at runtime`;
no other finding in this phase asserts one of these questions' candidate answers.

---

## Coverage and limits

- **Inspected scope:** the concurrency and trust-boundary paths read
  line-by-line — `core/status.ts` (lock acquisition, stale break, removal lock, release,
  handoff parse), `core/utils.ts` (atomic write, temp suffix, containment primitives),
  `core/workspace.ts` (refreshScaffold, updateStatusAtomically, switchPipeline),
  `core/completion.ts`, `core/amendment.ts`, `core/usage.ts`, `core/orchestrator-config.ts`
  (writeLibraryConfig), `core/library.ts` (publishEntry's lock, reindex, listEntries),
  `core/secrets.ts`, `core/findings.ts` (the pairing gate this report must satisfy),
  `core/broadside/{state,client,verify,submit,repo}.ts` (lock scope, poll, the verify tool
  loop, the redaction call sites), `extensions/codecarto/{index,auto-runner,agent-runner,
  phase-compaction,agent-state}.ts` (re-entry guard, mode guard, child-session guard),
  `mcp-server/server.ts` (`validateCwd`, `readSpecArg`, `handleRefreshScaffold`,
  `handleLibraryReindex`/`handleLibraryList`, the API-key resolution). The contracts and
  protocols reports were read in full as the spec.
- **Skipped scope:** `core/dashboard.ts` styles/renderer internals (presentation, not
  semantics); `extensions/codecarto/*` modules other than those listed (widget, narrator,
  rewriter, summary, completions, notify, child-model-runtime, agent-summary) — the
  contracts/protocols phases read them by name/export only and this phase did not need
  them; the `mcp-server/server.ts` `TOOLS` JSON text per tool (contracts already
  extracted it); `scripts/*`, `assets/`, `docs/*` beyond `docs/library-format.md`'s
  already-closed parity; the ~90 `tests/*.test.mjs` bodies (cited as pins, not read in
  full); the repository's checked-in prior run `self-audit/2026-09-11-*` (a previous
  artifact tree, **not used as evidence** here — it is not source).
- **Evidence basis:** source inspection plus the contracts/protocols reports. No tests
  executed, no runtime probes, no dependency (`node_modules`) source read — so every
  platform/network/SDK claim stays hedged.
- **Known blind spots:**
  1. No runtime verification: the three lock findings (3.1, 3.2, 3.4) are interleavings
     argued from source, not observed; a probe could confirm or narrow their severity.
  2. Windows/macOS filesystem, locking, and containment behavior (`q-node-windows-fs-semantics`)
     — `verify at runtime`; finding 4.3 depends on it.
  3. OpenRouter Batch API remote semantics (`q-openrouter-batch-semantics`) and Pi-vs-MCP
     outcome parity (`q-pi-sdk-execution-parity`) — not touched by this phase's findings.
  4. npm tarball template parity (`q-npm-tarball-template-parity`) — not touched.
  5. The unread extension/renderer bodies listed above could hold further concurrency or
     trust-boundary defects; this phase's scope was the paths `cf-arch-3` named plus the
     security/contract passes.
- **Coverage disposition:** COMPLETE for the phase's declared scope (all three semantic
  passes produced findings; all four routed carry-forwards are addressed with verdicts).
- **Contradiction sweep:** one **measured contradiction** with a summarized upstream
  claim. `cfs-mech-3`'s description in the mechanical report and in `status.yaml` says
  `refreshScaffold` "appends `THREAD_LOG.md` and fires `writeDashboard` (fire-and-forget)
  outside the `status.yaml` lock". Reading `refreshScaffold` (`core/workspace.ts:430-458`)
  and both callers (`mcp-server/server.ts:1216-1237`, `extensions/codecarto/index.ts:1708-1743`)
  shows **no `writeDashboard` call on the refresh path** — the adjacent handlers that call
  `writeDashboard` are `handleDashboard`, `handleAmend`, `handleSwitchPipeline`, and the
  Pi init/switch/publish/amend paths, none of which is refresh. The lock-scope gap and the
  `THREAD_LOG` append are real (finding 3.3); the `writeDashboard` clause is not, and is
  routed through the handoff's `owner_notes` for the porting phase. No other contradiction
  with the architecture/mechanical/contracts/protocols `owner_notes` was found. The
  protocols closeout's two placeholder-name drifts and the C03 promotion are re-confirmed,
  not contradicted. The pending `markdown-contracts-are-wire-format` proposal was promoted
  to C04 at this boundary (orchestrator duty).

---

## Validation

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | All three semantic passes (3, 4, 5) produced findings or documented "no defects found." | PASS | Pass 3: findings 3.1–3.7; Pass 4: 4.1–4.3 (plus a prose no-gap note on the child-session guard); Pass 5: 5.1–5.3. |
| 2 | Each finding has location, severity, evidence level, and recommended action. | PASS | Every row in the three pass tables carries Location, Defect, Severity, Evidence Level, Action (Pass 5 adds Spec Reference). |
| 3 | Pass 5 findings cite the contract or protocol reference they violate. | PASS | `Spec Reference` column: 5.1 → contracts §Security and Authorization; 5.2 → contracts §Feature Contracts #15 + CONVENTIONS C02; 5.3 → contracts §Feature Contracts #18. |
| 4 | Findings are organized by pass and sorted by severity; summary tables match the detailed findings. | PASS | Three `## Pass N` sections, each sorted medium→low; §Summary counts 4 medium + 3 low (Pass 3), 1 medium + 2 low (Pass 4), 3 low (Pass 5) = 5 medium, 8 low, 13 total. |
| 5 | Any carry_forward entries that targeted defect-scan-semantic have been resolved or explicitly re-routed. | PASS | §Carry-Forward Closure lists `cf-arch-3`, `cfs-mech-1`, `cfs-mech-2`, `cfs-mech-3`, each with the finding that closes it; mirrored in the handoff's `carry_forward_closures`. No new carry-forward to this phase remains. |
| 6 | Findings are marked with evidence levels. | PASS | `observed fact` on 3.1–3.7, 4.1, 4.2, 5.1–5.3; `external-behavior claim` on 4.3. |
| 7 | Unsettled findings carry an unsettled action, never a settled one, and each appears in the Open Questions table. | PASS | 4.3 is `external-behavior claim` + `verify at runtime`, and is in §Open Questions under `q-node-windows-fs-semantics`. No `external-behavior claim`/`open question` row carries `fix before porting`. |
| 8 | Every quantitative specific in a finding cites the file and line it was read from, or is marked as an estimate. | PASS | e.g. `STALE_LOCK_MS = 60_000` (`core/status.ts:25`), `BREAK_LOCK_STALE_MS = 5000` (`core/status.ts:31`), `rm(breakPath)` (`:539`), `describeLockHolder` await (`:571`), `copyFile` (`core/workspace.ts:441`), `.publish.lock` (`core/library.ts:619`), verify tool output (`core/broadside/verify.ts:340`). No estimates asserted. |
| 9 | Coverage and limits name inspected scope, skipped scope, evidence basis, and blind spots. | PASS | §Coverage and limits names all four plus a `COMPLETE` disposition, a contradiction sweep (the `writeDashboard` claim), and the `self-audit/` non-use note. |

**Validated by:** 2026-09-15 (defect-scan-semantic phase, self-audit session)
**Overall:** PASS
