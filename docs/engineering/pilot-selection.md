# Engineering pilot selection — preregistered tasks

**Status:** evaluation planning only. Neither task is implemented or assigned for execution by this document. E01 continues independently; E09 remains on hold at the maintainer's request. Pilot execution waits for E11's prerequisites and its own scope/host approval. See [evaluation rubric](evaluation-rubric.md), [engineering handoff](README.md), and [E11](https://github.com/HuginnIndustries/CodeCartographer/issues/409).

## Purpose and limits

Select a real bug and a bounded feature before observing how well Traverse can execute them. The first question is whether the engineering loop can preserve scope, evidence, review, recovery, and history—not whether it beats another coding agent or discovers a previously unknown bug.

The bug has a public diagnosis and suggested fix. That makes it useful as a known-answer protocol test but unsuitable for claims about unaided diagnosis. The feature requirements below are supplied deliberately. Neither task is an unbiased general software-engineering benchmark.

These briefs and checks are evaluation requirements, not a competing runtime schema. E01 owns all record/API/approval contracts. The rubric does not add fields to those contracts or weaken their trust boundary.

## Frozen target and separate engineering engine

- **Target repository:** public CodeCartographer source.
- **Initial target revision:** [`ee091ac680eef4824ad378b4aa958829a21d89cd`](https://github.com/HuginnIndustries/CodeCartographer/commit/ee091ac680eef4824ad378b4aa958829a21d89cd), the merged Windows-fix baseline.
- **Engine revision:** the future, reviewed engineering implementation being evaluated. Record its exact commit/package identity separately; it must not silently resolve to the old engine in the target checkout.
- **Target working copy:** disposable and isolated. The target's `.codecarto/` is distributable source material, not permission to overwrite it with active trial state. Use the separate active workspace/target association supported by the eventual E01/host contract. If unsupported, record a pilot blocker rather than force-initializing over source templates.
- **Reference library:** the engineering workflow starts with an empty library and needs no external specification. F01's synthetic library is the application's test data, not an input-spec prerequisite for planning the change.
- Record runtime/tool versions and the lockfile used. No machine-specific path, credential, environment dump, or raw private transcript belongs in the public report.

Use a known pinned starting point even if #412 is fixed before Traverse exists. Do not delay a useful upstream fix to preserve a benchmark. A historical replay remains explicitly labeled a replay; any later live-current task is a separate trial with a newly preregistered baseline and obligations. Never swap tasks silently after seeing results.

## B01 — Isolate Git-configuration injection in test fixtures

**Existing issue:** [#412](https://github.com/HuginnIndustries/CodeCartographer/issues/412). This is a real test-harness isolation defect, not a defect in production remote-URL resolution.

> **Run and reported.** B01 was executed on 2026-09-20 and its fix merged as [`c4030a4`](https://github.com/HuginnIndustries/CodeCartographer/commit/c4030a4); all six acceptance checks are satisfied. See the [B01 pilot report](pilot-b01-2026-09-20.md). It was run by a host agent against these checks, **not** through a CodeCartographer engine — E02 storage and E05/E06 evidence collection do not exist yet — so it measures whether the checks are usable and load-bearing, not whether an automated loop can execute them. The acceptance checks below are preserved as written; the fix having landed upstream does not invalidate a later replay from the pinned revision, which must be labeled a replay.

**Requested outcome:** Git-backed tests that already isolate global/system configuration must also prevent injected `GIT_CONFIG_COUNT` entries from rewriting fixture remotes. A contributor's command-scoped Git configuration must not make these fixtures fail or alter the intended fixture provenance.

### Selection evidence, observed at the pinned revision

A disposable checkout built successfully and passed the full suite: **948 tests, 948 pass, 0 fail**. The targeted library suite was run in two child-process environments:

| Condition | Observed result |
|---|---|
| Explicit `GIT_CONFIG_COUNT=0` control | 72 tests, 72 pass, 0 fail; exit 0 |
| One injected SSH-to-HTTPS `insteadOf` entry | 72 tests, 71 pass, 1 fail; exit 1 |

The failing case was `resolvePublishSourceRepo records origin's fetch URL verbatim`. These are selection/preflight observations, not a fix, a Traverse run, or evidence that acceptance already occurred.

Portable reproduction, from the pinned disposable checkout after dependency setup:

```bash
env GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
  GIT_CONFIG_VALUE_0=git@github.com: \
  node --experimental-strip-types --disable-warning=ExperimentalWarning \
  --test tests/library.test.mjs
```

The URLs are fixture data. The reproduction does not need an authenticated remote or network fetch. Restrict injected variables to the child process; never change the user's Git configuration to create the failure.

### Preserved behavior and allowed scope

- Keep production `resolvePublishSourceRepo`, `sameSourceRepo`, and `git remote get-url` semantics unchanged. Reading raw config instead of Git's effective remote would be a product change, not this fix.
- Keep fixture-local identities/configuration, existing file-based isolation, and normal no-injection behavior working.
- Expected scope: the seven existing guard sites named in #412 and, only if justified, a small shared **test-only** helper and regression fixtures. Inspect the current pinned source rather than assuming every file has identical fixture behavior.
- No dependency changes, new runtime configuration, CI policy change, general Git refactor, or unrelated bug fix.

### Acceptance checks

| ID | Required observation |
|---|---|
| B01-A1 | The injected baseline reproduces the named failure before the implementation exists. |
| B01-A2 | After the fix, the regression suite passes while its parent runner still supplies the injected rewrite; merely removing the injected condition from the test command does not count. |
| B01-A3 | Tests exercise the isolation boundary in a fresh child process, so an earlier test's environment cleanup cannot manufacture a pass. All relevant guard sites are covered or explicitly justified; one passing file is insufficient. |
| B01-A4 | The non-injected control, appropriate Git-backed regression tests, build, and full suite pass; actual counts are recorded after adding tests. |
| B01-A5 | The diff leaves production URL/provenance behavior and the user's Git configuration unchanged. |
| B01-A6 | Fresh review checks for masking a real failure, deleting assertions, or implementing only a harness-launch workaround instead of the requested durable test isolation. |

Do not publish a duplicate production fix if #412 has already landed. The pilot's changes remain in its disposable history unless a separate contribution is authorized.

## F01 — Filter library listings by an existing capability

**Requested outcome:** a caller can list entries whose existing `capabilities` array contains one exact capability, and combine that filter with the existing filters. This is selected as a bounded core-to-MCP integration feature, not a new library schema or E09 implementation.

### Selection evidence, observed at the pinned revision

`core/library.ts` stores capabilities in entry metadata/index records but `ListEntriesFilter` and its predicate support namespace, tag, slug, and source repository only. `mcp-server/server.ts`'s library-list schema/handler exposes the same existing filters.

A local synthetic library with `alpha` (`atomic publication`) and `beta` (`event routing`) returned both entries for an ordinary list. Supplying an unsupported `capability` property directly to the current JavaScript core function also returned both. This confirms the selected capability is unimplemented; silently ignoring an unsupported property is **not** being reclassified as a regression in today's public API. No feature code was written.

### Bounded behavior contract

- Add one optional singular `capability` filter to the core library filter and `codecarto_library_list` MCP schema/handler.
- Match an exact, case-sensitive member of the existing capabilities array. No substring, fuzzy, semantic, stemming, or case-folded search.
- Combine with namespace/tag/slug/source-repository filters using **AND**. Preserve existing source-repository equivalence semantics and result ordering.
- At the MCP boundary, omitted or empty-string capability behaves like the existing optional string filters: no filter. Non-string values are rejected by the public schema. In the core, an absent filter is no filter; a supplied string uses exact membership, consistent with the existing tag predicate.
- Missing/empty capability arrays do not match a nonempty requested capability.
- Listing remains read-only with indexed, missing-index, and unparseable-index inputs. Do not rebuild an index as a side effect.
- Existing versions, metadata format, confidentiality labels, publication semantics, and tool names remain unchanged. This pilot adds an MCP argument; it does not promise a new Pi command option or UI.

Expected scope: `core/library.ts`, existing MCP library-list schema/handler, `tests/library.test.mjs`, `tests/mcp-library.test.mjs`, focused read-only-index/transport coverage, and the relevant public API documentation. No new storage format, search backend, provider, authorization mechanism, or automatic spec selection.

### Acceptance checks

Use synthetic entries with distinct capabilities, case variants, partial substrings, tags, namespaces, and empty arrays. Pin their expected matches in evaluator-owned expectations before implementation.

| ID | Required observation |
|---|---|
| F01-A1 | New feature assertions fail against the unmodified pinned target for the intended missing behavior, not an unrelated setup error. |
| F01-A2 | Exact capability matches succeed; case variants and partial substrings do not; absent/empty metadata does not match. |
| F01-A3 | No filter preserves existing entries/order; intersections with every existing filter have the declared AND behavior. |
| F01-A4 | Missing and unparseable indexes yield the same filtered membership through their existing fallback and remain byte-for-byte unmodified by listing. |
| F01-A5 | The **packed target implementation** is exercised over real MCP stdio: tools/list advertises the optional argument; tools/call returns matching text and structured count/entries. Explicitly test omitted/empty-string no-filter behavior and schema rejection of non-string values. In-process handler tests alone do not prove this boundary. |
| F01-A6 | Filtered provenance-conflict reporting, source-repository equivalence, existing list behavior, build, and full suite remain correct. No metadata schema/version change is introduced. |
| F01-A7 | Independent review confirms the tests exercise matching, combination, and read-only behavior rather than merely confirming the new argument exists. |

This feature has no new implementation issue or assignment yet. It is an E11 evaluation target; do not create a parallel production feature branch from this planning document.

## Trial order and continuity

1. Preflight the supported engine/host, approved scope, baseline, dependency availability, human-acceptance capability, and explicit time/spend/retry bounds. Missing capabilities produce a blocker, not fabricated proof.
2. Run B01 against the pinned target, retaining baseline failure, attempts, review, and actual acceptance. Commit locally only when the host/project policy authorizes it; record dirty-state identity otherwise.
3. Start F01 as a **second change in the same project**, from B01's accepted candidate, without replacing B01's records. Record that derived baseline identity. B01 should not alter feature-related production code; verify that before F01 starts.
4. Exercise interruption/resume and stale/missing/wrong-snapshot evidence cases as defined in the rubric. Keep fault-injection attempts distinct from accepted candidates and never forge a human receipt to unblock a run.
5. Report each outcome separately. If the engine cannot honestly obtain human acceptance, record a reviewable candidate and leave end-to-end acceptance incomplete.

Do not reserve E09 as a pilot target or start it as a side effect. A later decision to resume E09 must be explicit in its issue. Normal upstream maintenance can proceed independently; frozen target revisions preserve reproducibility without freezing the project.
