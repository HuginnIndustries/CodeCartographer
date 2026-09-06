# Changelog — 2026-05-02 Framework Feedback Pass

Audit of which proposals from the agent feedback corpus (`Feedback From Agents/`) were applied,
clarified, deferred, or rejected in this pass. Same format as Thaumaturge's `DELTAS-APPLIED.md`
audit. Future revision passes read this file to know which proposals have already been
processed.

## Sources

| Source | Notes |
|---|---|
| `Feedback From Agents/FEEDBACK_INDEX.md` | Cross-cutting themes table is the load-bearing input. |
| `Feedback From Agents/Agent coordinating results - coordinating.txt` | Most synthesized single feedback file. |
| `Feedback From Agents/Agent on fifth module work - thaum-state.txt` | Most recent and most detailed module-work feedback. |
| `Feedback From Agents/Apply 20 spec deltas to Thaumaturge.txt` | Names the missing spec-delta-application skill explicitly. |
| (Plus the 9 other feedback files indexed in FEEDBACK_INDEX.md.) | Read at index level; specific items pulled when needed. |

## Triage Discipline Applied

Same discipline as `spec-delta-application`:

- **APPLY** = spec-blocker (raised by 3+ agents AND clean concrete edit) OR explicitly user-mandated.
- **CLARIFY** = mechanical edit; meaning is right but wording or shape is missing.
- **DEFER** = real improvement, not load-bearing for next session, written into `BACKLOG.md`.
- **REJECT** = wrong on close reading or out of scope for the framework.

## Triage Summary

| Bucket | Count | Notes |
|---|---|---|
| APPLY | 6 | Spec-blockers — see Applied table below. |
| CLARIFY | 5 | Mechanical edits — see Clarifications table. |
| DEFER | 14 | Recorded in BACKLOG.md (B1–B14). |
| REJECT | 0 | (Nothing rejected; deferred items are deferred, not rejected.) |
| **Total** | 25 | |

---

## Applied (spec-blockers)

| # | Proposal | Source(s) | Edit |
|---|---|---|---|
| 1 | **Schema-split `open_questions` into `open_questions` + `carry_forward`** with structured shape `{id, kind, target_phase, deferred_reason}`. | coordinating, broad defect, deep defect, porting (4 agents) | `workflow/status.yaml` schema updated; `workflow/VALIDATE.md` references both lists; `templates/architecture-map.md`, `behavioral-contracts.md`, `protocols-and-state.md`, `reverse-engineering-bundle.md`, `reimplementation-spec.md` all gained Carry-Forward section; GUIDE.md gained "Open Questions vs Carry-Forward" subsection; `kind` enum specified (`needs-runtime-test`, `needs-maintainer-decision`, `needs-spec-ruling`, `defer-to-phase`, `needs-fixture-capture`). |
| 2 | **`CONVENTIONS.md` and `DECISIONS.md` as first-class framework artifacts.** | thaum-engine, thaum-state, thaum-ollama (3 agents) | Created `templates/conventions-template.md` and `templates/decisions-template.md` as project-level skeletons; GUIDE.md trust-boundaries table updated to include both as "orchestrator-maintained"; GUIDE.md gained "Orchestrator-Maintained Artifacts" subsection; closeout ritual now mentions proposing entries to both. |
| 3 | **Subagent-delegation paragraph** under Context Budget for codebases over ~50 source files. | coordinating, broad defect, contracts, protocols, deep defect (5 agents) | GUIDE.md "Context Budget" gained "Subagent Delegation for Large Codebases" subsection. |
| 4 | **Per-session closeouts pattern** (`closeouts/<date>-<phase>.md`) replacing monolithic THREAD_LOG.md body. | thaum-ollama, thaum-engine, thaum-state, coordinating, spikes, porting (6 agents — top theme) | Created `templates/closeout-template.md`; rewrote `THREAD_LOG.md` as one-line-pointer index; updated `templates/thread-log-entry-template.md` to be the legacy one-line index entry; GUIDE.md Session Update Protocol and Output Placement Rules updated; folder layout in GUIDE.md updated. |
| 5 | **`spec-delta-application` SKILL** for the apply-deltas pattern (codifying the discipline used for the Thaumaturge 20-delta pass). | deltas (1 agent — user-mandated) | Created `skills/spec-delta-application/SKILL.md` and `templates/deltas-applied.md`. Skill location is a new top-level `skills/` directory (sibling of `findings/`) — chosen because spec-delta-application is post-pipeline, not phase-bound, so it doesn't fit `findings/<phase>/SKILL.md`. GUIDE.md trust-boundaries table updated with `skills/*/SKILL.md`. |
| 6 | **Dual-mode reimpl-spec template** — opinionated variant when stack/identity are pre-locked. | reimpl-spec, coordinating (2 agents) | Created `templates/reimplementation-spec-opinionated.md` as sibling of the language-agnostic default; GUIDE.md Session Update Protocol gained "Strategic Alignment Hook" subsection that picks between the two. |

## Clarifications (mechanical)

| # | Proposal | Source(s) | Edit |
|---|---|---|---|
| 7 | **Strategic-alignment hook** before reimplementation-spec phase. | coordinating (1 agent) | Folded into spec-blocker #6 — the Strategic Alignment Hook subsection in GUIDE.md is the hook *and* selects the template variant. |
| 8 | **Primary vs secondary output relationship** documentation in GUIDE.md (two-paragraph rule). | coordinating, porting (2 agents) | GUIDE.md gained "Primary vs Secondary Output Relationship" subsection under Evaluation Objective. |
| 9 | **File-system-sync warning paragraph** in session-prompt boilerplate. | thaum-engine, thaum-state (2 agents) | NEW_THREAD_BLURB.md gained "File-System Sync Warning" section with concrete mitigations. |
| 10 | **THREAD_LOG dedup linter** as a one-line script in the framework. | deltas (1 agent) | CONTRIBUTING.md gained "THREAD_LOG.md de-dup check" with the `grep ... | sort | uniq -d` one-liner. THREAD_LOG.md itself documents the human-discipline rule. |
| 11 | **VALIDATE.md PARTIAL example.** | deep defect (1 agent) | VALIDATE.md gained "Worked PARTIAL Example" section with a full PASS-WITH-GAPS validation block AND the matching `carry_forward` entry showing how the gap is routed downstream. |

## Deferred (in BACKLOG.md)

| # | Proposal | Source(s) | Backlog ID |
|---|---|---|---|
| 12 | Spike template + first-class spike concept | spikes, deltas, protocols (3) | B1 |
| 13 | Amendments mechanic (`findings/amendments/`) | spikes, protocols (2) | B2 |
| 14 | Cross-CodeCartographer references in status.yaml | reimpl-spec (1) | B3 |
| 15 | 1–5 coverage-depth score | reimpl-spec (1) | B4 |
| 16 | Programmatic markdown-regex validator | broad defect, deep defect (2) | B5 |
| 17 | CI grep gate for tripwire-named functions | thaum-state (1, project-level) | B6 |
| 18 | Append-mode supersession rule | porting, protocols, contracts (3) | B7 |
| 19 | Validation as semantic check (not just structural) | broad defect, deep defect, porting, protocols (4) | B8 |
| 20 | Spec file split into spec/ directory | thaum-engine, thaum-ollama, spikes (3, project-level) | B9 |
| 21 | SKILL.md + template consolidation | porting, protocols, contracts (3) | B10 |
| 22 | Defect-pass-N append discipline | broad defect, deep defect (2) | B11 |
| 23 | Resolutions footer / phase resolution mechanic | coordinating, contracts (2) | B12 (partially obviated by carry_forward — wait for re-feedback) |
| 24 | Engine→leaf seam contracts table | thaum-state (1, project-level) | B13 |
| 25 | Cross-phase consistency check | protocols (1) | B14 |

## What This Pass Did Not Touch

Per the prompt's "do not modify" list (the unanimous-defenders list at the bottom of
`FEEDBACK_INDEX.md`):

- **Validation gate** (PASS / PASS WITH GAPS / FAIL) — UNCHANGED. (Rules around it were extended; the gate's shape is preserved.)
- **Append-mode discipline** for secondary outputs — UNCHANGED.
- **Trust-boundaries table** — EXTENDED with new categories (closeouts, conventions, decisions, backlog), not modified in shape.
- **Pipeline variants** (5) — UNCHANGED. None added, none removed, none restructured.
- **Evidence-level discipline** (`observed fact` / `strong inference` / `portability hazard` / `open question`) — UNCHANGED.
- **Closeout ritual** — EXTENDED to include conventions/decisions promotion and per-session closeout files; the ritual's shape (validation → status.yaml → per-session record → next pointer) is preserved.
- **status.yaml-as-handoff-baton** — UNCHANGED in role; schema split adds `carry_forward` alongside existing fields.

## Re-Validation Result

The framework's own `.codecarto/` is the framework applied to itself. After this pass:

- Every file path referenced in GUIDE.md, CONTRIBUTING.md, NEW_THREAD_BLURB.md, VALIDATE.md, and the pipeline YAMLs still exists.
- Every template file referenced in pipeline YAMLs (`templates/architecture-map.md`, etc.) still exists and is well-formed.
- New files (`templates/closeout-template.md`, `templates/conventions-template.md`, `templates/decisions-template.md`, `templates/deltas-applied.md`, `templates/reimplementation-spec-opinionated.md`, `skills/spec-delta-application/SKILL.md`, `BACKLOG.md`, this CHANGELOG, the rewritten `THREAD_LOG.md`) are all present.
- `workflow/status.yaml` schema split is consistent with the templates and GUIDE.md.
- `Feedback From Agents/FEEDBACK_INDEX.md` cross-cutting-themes table has been annotated with resolution markers (✓ APPLIED / ◑ CLARIFIED / ➜ DEFERRED-Bxx).

The pass is internally consistent. The framework's own self-application still hangs together.

## Net

- 6 spec-blockers landed.
- 5 spec-clarifications applied (one folded into a blocker; 4 standalone mechanical edits).
- 14 nice-to-haves recorded in BACKLOG.md with smallest-viable-form sketches.
- 0 rejections.

The framework now formalizes the orchestrator role (CONVENTIONS.md + DECISIONS.md +
spec-delta-application skill), formalizes the schema split that has been requested since session
1 (open_questions vs carry_forward), and replaces the monolithic THREAD_LOG body with a
per-session closeouts pattern that scales forever.

The next concrete step after this pass is back to project-level work (e.g., Thaumaturge module
work — `thaum-tools`) — but now with the upgraded framework as the base and the
orchestrator-discipline artifacts as first-class supporting structure.
