# Review: reconciled defect list

Source: [findings/porting/reverse-engineering-bundle.md §Defect Synthesis](findings/porting/reverse-engineering-bundle.md),
which reconciles 40 mechanical and 38 semantic findings into 11 high roots, 28 medium roots,
and 7 low groups. Line numbers refer to commit `f6f8484` (v0.19.5).

Every high and all but one medium are **confirmed by reading**; ten roots were also
reproduced with the runtime probes in `probes/` (see §Runtime probes in each scan report).
The single **plausible** row is D-M19. Dispositions use the porting vocabulary: fix before
porting, port differently, leave behind, verify at runtime (unused: no disposition rests on
an unsettled diagnosis).

## High severity

| ID | Location | Defect | Disposition | Fix |
|---|---|---|---|---|
| D-H1 | `core/utils.ts:57-68` (guards at `extensions/codecarto/index.ts:433-448`, `phase-compaction.ts:74-84`) | Write sandbox admits a not-yet-existing file under a symlinked directory inside `.codecarto/`. Probe P1 wrote outside the root. | fix | Resolve the nearest existing ancestor with realpath, then check the remaining path tail lexically. |
| D-H2 | `core/workspace.ts:137-182` | Init copies findings, handoffs, and the dashboard from the packaged template. Any checkout with a finished phase seeds every new workspace with it; 18 of 696 tests fail. | fix | Copy from a manifest of framework-owned paths (the refresh set), never the live tree. |
| D-H3 | `core/yaml.ts:355-364`, `core/status.ts:229` | Scalar-looking strings are emitted bare and re-read as number, boolean, or null. A repo named `2048` bricks the workspace with `project_name?.trim is not a function`. | fix | Quote any string the reader would not return unchanged; coerce with `String()` before `.trim()`. |
| D-H4 | `core/usage.ts:88`, `core/library.ts:186,439,693,1208`, `core/workspace.ts:368,452`, `extensions/codecarto/dashboard-writer.ts:58`, `core/broadside.ts:1691` | Eight hand-rolled writers use `<pid>.<ms>` temp names. Same-millisecond writers collide and lose writes silently (probes P3, P4). | fix | One atomic-write primitive with a unique suffix, failures propagated. |
| D-H5 | `core/status.ts:424-426,433-437` | Lock release removes whoever's lock is present. After a stale break the old holder deletes the new holder's lock (probe P2). | fix | Owner token in the lock file; release only your own; log stale breaks. |
| D-H6 | `core/pipeline.ts:37-49` as consumed by `core/completion.ts:496-500`, `mcp-server/server.ts:346-351`, `core/amendment.ts:141-147`, `core/status.ts:195-209` | "No eligible phase" is treated as "pipeline complete" everywhere. A DAG with an unmet dependency reports 1/2 complete and unlocks skills (probe P6). | fix | Engine returns eligible, complete, or stuck; every consumer handles stuck. |
| D-H7 | `package.json` `files` | `.codecarto/.gitignore` is not in the tarball, so npm-installed workspaces commit dashboards, usage logs with absolute paths, and key-bearing config. | fix | Add it to the manifest and pin with a packaging test. |
| D-H8 | `mcp-server/server.ts:1201-1204`, `extensions/codecarto/index.ts:1175-1176`, `core/broadside.ts:2686` | `wait_seconds: 0` on collect becomes the 25-minute default. | fix | Pass explicit zero through; core treats zero as "read state, no poll". |
| D-H9 | `core/broadside.ts:1790`, `mcp-server/server.ts:1235,2329-2340` | No default spend cap on the MCP surface, which cannot ask a human. | fix | Ship a non-zero default; MCP refuses over it unless forced; explicit 0 means unlimited. |
| D-H10 | `core/broadside.ts:1756-1765,1790` | A malformed Broad-Side config silently drops the configured cap and lens routing. | fix | A config that exists but fails to parse refuses a submit and reports the error. |
| D-H11 | `core/broadside.ts:1657-1667,1735-1741` | Corrupt `state.json` is read as empty and overwritten, orphaning paid runs. | fix | Never persist over an unparseable state file; keep a backup and surface the error. |

## Medium severity

Ordered by the order I would act on them.

| ID | Location | Defect | Disposition | Fix |
|---|---|---|---|---|
| D-M20 | `core/completion.ts:502` vs `core/workspace.ts:365-370` | Closeout, THREAD_LOG, and DECISIONS are written before the status rename; a failed rename leaves artifacts for an incomplete phase. | fix | Rename status first; write artifacts after, idempotently. |
| D-M21 | `mcp-server/server.ts:457-492`, `extensions/codecarto/index.ts:928-997` | Skill names are not validated; `../findings/architecture` splices arbitrary files into the prompt (probe P5). | fix | Resolve names against the installed list only. |
| D-M1 | `core/workspace.ts:402-463` | Switching pipelines resets `current_phase`/`next_actions` to the first phase despite carried completions. | fix | Recompute the cursor after carrying statuses. |
| D-M2 | `core/workspace.ts:425-440` | Carry-forwards targeting dropped phases dangle silently after a switch. | fix | Re-route or surface dangling entries at switch time. |
| D-M7 | `core/usage.ts:72-91` | Usage log: unlocked read-modify-write, corrupt file overwritten, colliding temp names. | fix | Append-only lines under the shared lock; never overwrite a corrupt log. |
| D-M3 | `core/completion.ts:467-480` | Every PARTIAL row becomes a `needs-maintainer-decision` question even when the handoff routed the same gap. | port differently | Auto-questions only for PARTIAL rows whose evidence names no handoff entry. |
| D-M18 | `core/library.ts:588-726,933-993` | Concurrent publishes to one slug race; the loser gets a raw filesystem error. | fix | Per-entry lock; retry version assignment; typed error. |
| D-M28 | `mcp-server/server.ts:704-708` | Unvalidated relative `cwd` widens the publish containment root. | fix | Validate `cwd` wherever it becomes a root. |
| D-M8 | `core/orchestrator-config.ts:103-110` | A malformed config layer is silently dropped. | fix | Report parse failures; `codecarto_config` shows them. |
| D-M12 | `core/orchestrator-config.ts:144` | Relative `library.path` resolves against the process cwd. | fix | Resolve relative to the config file's directory, or refuse relative. |
| D-M15 | `mcp-server/server.ts:937-939`, `extensions/codecarto/index.ts:1401-1402` | Library-init writes `publish_confirm: true`, flipping the MCP confirm gate on. | port differently | Document that init enables the gate, or write only what was asked. |
| D-M17 | `mcp-server/server.ts:192-197,229-241`, `extensions/codecarto/index.ts:533-566` | Init on the packaged template itself resets status without backup. | fix | Treat `sameWorkspace` like any existing workspace (refuse/confirm). |
| D-M10 | `core/yaml.ts:246-247,333-337` | Valid YAML nesting indents are rejected as "Invalid YAML indentation". | port differently | Accept any consistent nesting indent; message names the construct. |
| D-M9 | `core/pipeline.ts:151-157,184-186` | Any decoration on `**Overall:**` fails with an unhelpful message. | fix | Tolerant parse; error names the line. |
| D-M5 | `core/broadside.ts:1188-1196,1493` | Broad-Side file list from `git ls-tree HEAD`, contents from the working tree. | port differently | Snapshot from one source and record which. |
| D-M6 | `core/broadside.ts:1314-1325,1606` | Unbounded `mainFile` read; flat 6,000-char estimate for the architecture lens. | fix | Cap the read; estimate from actual sizes. |
| D-M13 | `core/broadside.ts:1340,1170-1177` | Unknown language falls through to Go globs and silently scans nothing; `package.json` precedence misclassifies. | fix | Explicit "unsupported language" refusal; precedence by file counts. |
| D-M14 | `core/broadside.ts:1919-1931,2106-2113` | Auth failure masked as pricing/timeout. | fix | Surface HTTP status on catalog and poll errors. |
| D-M23 | `core/broadside.ts:939-1098,1463-1517` | Repository content uploaded without secret scanning. | port differently | Redaction pass (or opt-in allowlist) before upload; document. |
| D-M22 | `core/prompts.ts:201-207,75-80` | Upstream findings text is spliced into later prompts undelimited. | port differently | Delimit and label spliced text as data; bound its size. |
| D-M24 | `mcp-server/server.ts:316-341` vs `extensions/codecarto/index.ts:645` | MCP switch does not re-render the dashboard. | fix | Dashboard refresh is a core completion/switch side effect. |
| D-M25 | `extensions/codecarto/auto-runner.ts:170,387` | `ctx.cwd` read after a phase at two sites, captured elsewhere. | fix | Use the captured cwd everywhere post-phase. |
| D-M19 | `extensions/codecarto/agent-runner.ts:167-288`, rewriter, narrator | Child sessions never disposed. **Plausible**: the leak is read from code; what dispose frees is an inference about the SDK. | fix | Dispose every child after use. |
| D-M4 | `core/library.ts:925` | `source_repo` list filter compares raw strings while everything else normalizes. | fix | Use the same normalizer. |
| D-M11 | `core/workspace.ts:33-37`; test init helpers | Tests initialize from the live template; workspace state in the checkout fails 18/696. | fix | Tests copy a synthetic template. |
| D-M16 | `.codecarto/.gitignore:1-13` | Findings gitignored in checkout installs; status and findings diverge across clones. | port differently | One policy: findings committed by default with a documented opt-out. |
| D-M26 | `MANUAL.md:136-158,235-239,247-252,271-272` | The manual teaches the pre-0.12 hand-edit contract. | fix | Rewrite drop-in guidance; state that drop-in mode has no completion executable. |
| D-M27 | `README.md:37`, `docs/mcp-quickstart.md:125` | Docs describe validation as checking criteria; it parses self-attestation plus two cross-checks. | fix | Docs say what the gate is. |

## Low severity (grouped by root)

| Group | Source rows | Disposition | Consequence |
|---|---|---|---|
| L1 Dead code and dead protocol states (`running`, `partial`/`in-progress`, `resolved`, `threadLogEntry`, `.github` exemption, unused args, unreachable emitter branches, unused `state.runs.push`) | mech 1.10–1.15, sem 5.9 | leave behind | Do not port; implement `resolved` only if amendments are meant to keep history. |
| L2 Error observability (InternalError for user errors, generic dashboard failure, temp files left on rename failure, stale `latest` after partial publish, catalog auth masked, `timeout` for dead network, git without timeout, no cancel on long MCP calls, headless 30 s timer) | mech 2.8–2.11, sem 3.7–3.9, 3.11, 3.12 | fix (mapping) / leave behind (timers) | Map user-fixable failures to the client-visible error class; clean temp files; timeouts on subprocesses. |
| L3 Config/environment (hardcoded operational constants, phase-id regex narrower than allowed ids, zero not expressible per call, `PACKAGE_VERSION` fallback, hand tilde expansion) | mech 6.10–6.14 | leave behind / fix (regex, zero) | One constants module; one tilde helper; allow explicit zero. |
| L4 Documentation drift (No JavaScript; default pipeline; four levels; mechanical scope; completion wording; session links; complete-tool description; folded scalars unreadable; `codecarto library-reindex`) | sem 5.4, 5.6, 5.7, 5.11, 5.12, 5.17 | fix (docs) | Regenerate docs from the contracts; update the library spec's YAML dialect section. |
| L5 State-machine hygiene (three literal terminal-status arrays; catalog cache schema 2 unchecked; cache TTL refresh) | sem 5.8, 5.10, mech 1.9 | fix | One terminal-status constant; per-entry TTL; check what you write. |
| L6 Trust posture (`api_key` as a tool argument; repo-committed `library.path` widening the sandbox; no cwd allowlist; key in template config) | sem 4.6–4.9 | port differently / leave behind | Adapter policy per host; document the trusted-host posture. |
| L7 Collect targets the last run only | sem 3.10 | leave behind | Add a run-id parameter if multi-run collection is wanted. |
| L8 (new, from the clone's git status) `.codecarto/.gitignore:3` ignores the stale path `findings/defect-scan/defect-report.md`; under the deep-audit pipeline the two defect-scan reports are the only findings a checkout would commit. | this review | fix | Ignore the paths the shipped pipelines actually write. |

## The three to fix first

1. **D-H4 plus D-H5 together** as one state-store primitive in `core/`: owned lock and
   unique-suffix atomic write. Eight copies collapse into one, and the primitive also fixes
   D-M7, D-M18, and D-M20.
2. **D-H2 plus D-H7 together** as one template manifest: init and the npm tarball copy the
   same explicit list, which includes the ignore file and excludes outputs. It also fixes
   D-M11 so the suite passes in a checkout with a finished phase.
3. **D-H1**, the symlink bypass in the sandbox. It is the only enforcement of the
   LLM-to-filesystem boundary on the Pi surface and the fix is a few lines.

D-H6 is fourth. It is a one-enum change in the engine but touches five consumers.

## Issue index

One GitHub issue per finding, label `self-audit`.

| ID | Issue | Title |
|---|---|---|
| D-H1 | [#223](https://github.com/HuginnIndustries/CodeCartographer/issues/223) | Write sandbox admits a new file under a symlinked directory inside .codecarto/ |
| D-H2 | [#224](https://github.com/HuginnIndustries/CodeCartographer/issues/224) | codecarto-init copies findings, handoffs, and the dashboard from the packaged template |
| D-H3 | [#225](https://github.com/HuginnIndustries/CodeCartographer/issues/225) | YAML emitter writes scalar-looking strings bare; a digit-named repo bricks the workspace |
| D-H4 | [#226](https://github.com/HuginnIndustries/CodeCartographer/issues/226) | Eight hand-rolled atomic writers use <pid>.<ms> temp names and lose concurrent writes |
| D-H5 | [#227](https://github.com/HuginnIndustries/CodeCartographer/issues/227) | Status lock release removes whoever's lock is present, including a newer holder's |
| D-H6 | [#228](https://github.com/HuginnIndustries/CodeCartographer/issues/228) | 'No eligible phase' is treated as 'pipeline complete' across status, next, complete, skills, amend |
| D-H7 | [#229](https://github.com/HuginnIndustries/CodeCartographer/issues/229) | .codecarto/.gitignore is not in the npm tarball |
| D-H8 | [#230](https://github.com/HuginnIndustries/CodeCartographer/issues/230) | Broad-Side collect with wait_seconds: 0 waits the 25-minute default |
| D-H9 | [#231](https://github.com/HuginnIndustries/CodeCartographer/issues/231) | No default spend cap for Broad-Side on the MCP surface |
| D-H10 | [#232](https://github.com/HuginnIndustries/CodeCartographer/issues/232) | A malformed Broad-Side config silently drops the configured spend cap and lens routing |
| D-H11 | [#233](https://github.com/HuginnIndustries/CodeCartographer/issues/233) | A corrupt broadside/state.json is read as empty and overwritten, orphaning paid runs |
| D-M20 | [#234](https://github.com/HuginnIndustries/CodeCartographer/issues/234) | Completion writes closeout, THREAD_LOG, and DECISIONS before the status rename |
| D-M21 | [#235](https://github.com/HuginnIndustries/CodeCartographer/issues/235) | Skill name is not validated: path traversal splices arbitrary files into the prompt |
| D-M1 | [#236](https://github.com/HuginnIndustries/CodeCartographer/issues/236) | switch_pipeline resets current_phase and next_actions to the first phase despite carried completions |
| D-M2 | [#237](https://github.com/HuginnIndustries/CodeCartographer/issues/237) | Carry-forwards targeting phases dropped by a pipeline switch dangle silently |
| D-M7 | [#238](https://github.com/HuginnIndustries/CodeCartographer/issues/238) | Usage log: unlocked read-modify-write, corrupt file overwritten, colliding temp names |
| D-M3 | [#239](https://github.com/HuginnIndustries/CodeCartographer/issues/239) | Every PARTIAL coverage row becomes an auto open question even when the handoff already routed it |
| D-M18 | [#240](https://github.com/HuginnIndustries/CodeCartographer/issues/240) | Concurrent publishes to one library slug race; the loser gets a raw filesystem error |
| D-M28 | [#241](https://github.com/HuginnIndustries/CodeCartographer/issues/241) | Unvalidated relative cwd widens the publish containment root |
| D-M8 | [#242](https://github.com/HuginnIndustries/CodeCartographer/issues/242) | A malformed orchestrator config layer is silently dropped |
| D-M12 | [#243](https://github.com/HuginnIndustries/CodeCartographer/issues/243) | Relative library.path resolves against the process cwd |
| D-M15 | [#244](https://github.com/HuginnIndustries/CodeCartographer/issues/244) | library_init writes publish_confirm: true, flipping the MCP confirm gate on |
| D-M17 | [#245](https://github.com/HuginnIndustries/CodeCartographer/issues/245) | codecarto-init on the packaged template itself resets status without a backup |
| D-M10 | [#246](https://github.com/HuginnIndustries/CodeCartographer/issues/246) | Valid YAML nesting indents are rejected as 'Invalid YAML indentation' |
| D-M9 | [#247](https://github.com/HuginnIndustries/CodeCartographer/issues/247) | Any decoration on the **Overall:** line fails validation with an unhelpful message |
| D-M5 | [#248](https://github.com/HuginnIndustries/CodeCartographer/issues/248) | Broad-Side lists files from git ls-tree HEAD but reads contents from the working tree |
| D-M6 | [#249](https://github.com/HuginnIndustries/CodeCartographer/issues/249) | Broad-Side reads mainFile unbounded and estimates the architecture lens at a flat 6,000 chars |
| D-M13 | [#250](https://github.com/HuginnIndustries/CodeCartographer/issues/250) | Unknown language falls through to Go globs and silently scans nothing |
| D-M14 | [#251](https://github.com/HuginnIndustries/CodeCartographer/issues/251) | Broad-Side auth failures are masked as pricing or timeout errors |
| D-M23 | [#252](https://github.com/HuginnIndustries/CodeCartographer/issues/252) | Broad-Side uploads repository content with no secret scanning |
| D-M22 | [#253](https://github.com/HuginnIndustries/CodeCartographer/issues/253) | Upstream findings text is spliced into later phase prompts undelimited |
| D-M24 | [#254](https://github.com/HuginnIndustries/CodeCartographer/issues/254) | MCP switch_pipeline does not re-render the dashboard |
| D-M25 | [#255](https://github.com/HuginnIndustries/CodeCartographer/issues/255) | auto-runner reads ctx.cwd after a phase at two sites instead of the captured value |
| D-M19 | [#256](https://github.com/HuginnIndustries/CodeCartographer/issues/256) | Child AgentSessions are never disposed |
| D-M4 | [#257](https://github.com/HuginnIndustries/CodeCartographer/issues/257) | Library source_repo list filter compares raw strings while the publish guard normalizes |
| D-M11 | [#258](https://github.com/HuginnIndustries/CodeCartographer/issues/258) | Tests initialize workspaces from the live packaged template |
| D-M16 | [#259](https://github.com/HuginnIndustries/CodeCartographer/issues/259) | Findings are gitignored in checkout installs but committed in npm installs |
| D-M26 | [#260](https://github.com/HuginnIndustries/CodeCartographer/issues/260) | MANUAL.md teaches the pre-0.12 hand-edit completion contract |
| D-M27 | [#261](https://github.com/HuginnIndustries/CodeCartographer/issues/261) | Docs describe validation as checking criteria; it parses the artifact's self-attestation |
| L1 | [#262](https://github.com/HuginnIndustries/CodeCartographer/issues/262) | Dead code and dead protocol states (low, grouped) |
| L2 | [#263](https://github.com/HuginnIndustries/CodeCartographer/issues/263) | Error observability (low, grouped) |
| L3 | [#264](https://github.com/HuginnIndustries/CodeCartographer/issues/264) | Config and environment lows (low, grouped) |
| L4 | [#265](https://github.com/HuginnIndustries/CodeCartographer/issues/265) | Documentation drift (low, grouped) |
| L5 | [#266](https://github.com/HuginnIndustries/CodeCartographer/issues/266) | State-machine hygiene (low, grouped) |
| L6 | [#267](https://github.com/HuginnIndustries/CodeCartographer/issues/267) | Trust posture (low, grouped) |
| L7 | [#268](https://github.com/HuginnIndustries/CodeCartographer/issues/268) | Broad-Side collect targets only the last run (low, grouped) |
| L8 | [#269](https://github.com/HuginnIndustries/CodeCartographer/issues/269) | .codecarto/.gitignore ignores a stale defect-scan path (low, grouped) |
