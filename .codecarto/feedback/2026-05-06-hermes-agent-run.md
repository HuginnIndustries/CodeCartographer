# Framework feedback — 2026-05-06 — hermes-agent deep-audit run

This file records framework-level feedback from a full deep-run of CodeCartographer (`pipeline-full-with-deep-audit.yaml`, 7 phases, with split mechanical/semantic defect scan) against `theamericanmaker/hermes-agent` — Nous Research's self-improving AI agent platform, ~200K LOC Python.

The actual analysis output lives on the hermes-agent side at branch `claude/codecarto-hermes-analysis-abvQm`. This note captures only the framework-relevant takeaways — what worked, what didn't, and the conventions surfaced.

## Run shape

- **Project under analysis:** hermes-agent, ~200K LOC, Python 3.11+, 11 top-level packages (agent, tools, gateway, hermes_cli, skills, plugins, cron, acp_adapter, acp_registry, web, environments).
- **Pipeline:** `pipeline-full-with-deep-audit.yaml` (default; 7 phases).
- **Mode:** orchestrator (one main session) + 7 implementing subagents.
- **Strategic Alignment Hook:** resolved as language-agnostic in planning; spec used `templates/reimplementation-spec.md`.
- **Total content produced:** ~233 KB across 7 primary outputs + 5 secondary catalogs (each appended by 3-4 phases) + defect-fix-tracker + sidecar VALIDATION.md + status.yaml + 6 phase closeouts + 1 final orchestrator closeout + CONVENTIONS.md (12 conventions) + DECISIONS.md (12 numbered decisions) + BACKLOG.md + THREAD_LOG.md.
- **Phases 2-4 ran in parallel** after architecture; Phase 5 collapsed three carry-forwards from three upstream phases into one finding (the two-guard message dispatch invariant).

## What worked

1. **Read-write segregation.** Skills, templates, pipelines stayed read-only; findings/status/closeouts/conventions/decisions were the only writable surfaces. No accidental SKILL.md edits.
2. **Evidence classification** (`observed fact` / `strong inference` / `portability hazard` / `open question`) carried cleanly across all 7 phases. Downstream phases used the labels to triage.
3. **Validation gating per phase** caught the "summary-table-vs-row-count" mismatch in defect-scan-mechanical (PARTIAL on criterion 4) without blocking the run. PASS WITH GAPS is a useful intermediate verdict.
4. **Carry-forward routing with explicit `target_phase`** prevented gap loss across phases. Notably: arch-CF8 routed through architecture → defect-scan-semantic; merged with ctr-CF5 and prot-CF1 in Phase 5 into a single critical finding (D3.1).
5. **Three-commit-per-phase incremental pattern** (primary draft → secondaries → validation block) survived two implementing-session timeouts (contracts, porting). The orchestrator could resume from the last good commit.
6. **Parallel phases 2-4** worked when secondary-output ownership was partitioned. Phase 3 owned `public-surfaces` + `config-model`; Phase 4 owned `runtime-lifecycle` + `state-and-storage`. No concurrent-write conflicts.
7. **Defect-fix-tracker** (porting phase) anchored the cross-phase defect synthesis to concrete fix/defer decisions per defect ID.

## What didn't (the timeout pattern)

5 subagent timeouts across 11 invocations. All were `API Error: Stream idle timeout - partial response received`.

Pattern:
- Implementing-session subagents that had to read >100 KB of prior outputs reliably timed out before completing the synthesis.
- Subagents asked to rewrite a 45 KB+ file (the protocols validation-block append) timed out three separate times: original implementing session, dedicated finalizer, minimal-finalizer-with-pre-computed-content-in-prompt.

**The mitigation that worked:** pre-loading prior-phase signal in the orchestrator's prompt, with a hard 6-file read budget on the implementing subagent. Phase 6 (porting) timed out on its first attempt with a 12-file budget; the retry with 6-file budget + 170 KB of prior-phase signal compressed into the prompt landed all 3 commits cleanly. Phase 7 (reimplementation-spec) was launched with the same pattern from the start and succeeded on the first attempt.

## Conventions surfaced (recommended for inclusion in framework guidance)

(Numbered to match the run's CONVENTIONS.md on the hermes-agent side.)

- **C1. Pre-load recon for implementing-session prompts.** Cuts read budget by 30–50% and prevents stream-idle timeouts.
- **C2. Incremental commits per phase.** Survives partial-write timeouts.
- **C3. Validation-block append is orchestrator-level recoverable work.** When the implementing-session subagent times out before the trailing validation commit, the orchestrator should treat that as recoverable — either retry with a finalizer subagent OR apply the block directly. A documented sidecar `VALIDATION.md` is an acceptable last-resort compromise (see hermes-agent run's `findings/protocols/VALIDATION.md` for an example).
- **C4. Disjoint secondary ownership for parallel phases.** When two parallel phases would both append to the same secondary catalog, partition ownership in the orchestrator brief.
- **C5. GitHub code search may not be indexed for private/recent repos.** Implementing-session prompts should warn agents to fall back to direct file reads when search returns 0 hits.
- **C6. Severity rollups are derived data.** Summary tables drift off-by-one when hand-tabulated; expect a PARTIAL on rollup criteria or generate them mechanically.
- **C7. COMMAND_REGISTRY-style central dispatch tables are gold for contracts phases.** Parse early; the table writes itself.
- **C8. Authorization trapdoor flags belong in contracts**, not deferred to defect-scan-security. Default-allow vs default-deny is a contract surface.
- **C9. Collapse multi-input carry-forwards that describe the same defect.** Triple-citation reflects recurring-mistake-surface better than three separate findings.
- **C10. Files >100 KB get strong-inference + second-order verification.** Mark touching findings as `strong inference` and route a verification step to the next phase that has budget for the read.
- **C11. Pre-port refactor for monolithic source files.** For source files >150 KB the port will need to decompose, recommend the decomposition in the source repo BEFORE the port begins. Separates "language port" from "structural cleanup".
- **C12. State-machines-first for protocol-heavy phases.** Define state machines first and let the event catalog reference them. State-machines-last produces redundancy.

## Compliance gap left on the hermes-agent side

`findings/protocols/protocols-and-state.md` ends with the `(Validation block appended in a follow-up commit per VALIDATE.md.)` placeholder. Three subagent attempts at the 45 KB inline rewrite timed out. The validation table lives in a sidecar `VALIDATION.md` alongside the primary; closing the gap requires one `mcp__github__create_or_update_file` call rewriting `protocols-and-state.md` with the trailing placeholder replaced by the table from `VALIDATION.md`.

This is the single least-resolved framework friction point of the run. If the framework grew an Edit-style operation (vs. full-file create_or_update), or if the implementing-session timeout were tunable, this gap would close cleanly.

## Suggestion for `BACKLOG.md` upstream

The framework BACKLOG could grow these entries:

1. **Edit-style file operation** for trailing-block appends without full-file rewrite. Single biggest reliability improvement for the validation-block step.
2. **Pre-loaded recon convention promoted into GUIDE.md.** Currently implicit; making it explicit in the orchestrator-role section would have saved the first Phase 6 attempt.
3. **Subagent timeout guidance** in CONTRIBUTING.md or a new TROUBLESHOOTING.md. The stream-idle timeout pattern is reproducible and the mitigations (pre-load recon, hard read budget, incremental commits) are concrete.

## Closing note

The framework scaled to a 200K LOC Python codebase across 7 phases with 11 subagent invocations and 5 subagent timeouts (4 of which were recoverable; 1 was deferred to a sidecar). The framework's read-write segregation, evidence classification, validation gating, and carry-forward routing all worked as designed. The biggest leverage point that the framework didn't yet codify was orchestrator-side pre-loading of recon — compressing 100+ KB of prior-phase outputs into a few hundred lines of prompt text.

— orchestrator session, 2026-05-06
