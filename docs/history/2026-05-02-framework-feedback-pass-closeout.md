# Closeout — 2026-05-02 — framework-feedback-pass

## Summary

This was a meta-session: instead of using CodeCartographer to analyze a codebase, the session edited CodeCartographer based on accumulated feedback from 13 prior agent sessions. Six spec-blockers landed, five spec-clarifications applied, fourteen nice-to-haves recorded in `BACKLOG.md`. The framework now formalizes the orchestrator role (CONVENTIONS.md + DECISIONS.md + spec-delta-application skill), schema-splits open_questions into open_questions + carry_forward, and replaces the monolithic THREAD_LOG body with a per-session closeouts pattern. Next session is back to project-level work (Thaumaturge `thaum-tools`) with the upgraded framework as the base.

## Files Touched

- **Added:**
  - `.codecarto/templates/closeout-template.md`
  - `.codecarto/templates/conventions-template.md`
  - `.codecarto/templates/decisions-template.md`
  - `.codecarto/templates/deltas-applied.md`
  - `.codecarto/templates/reimplementation-spec-opinionated.md`
  - `.codecarto/skills/spec-delta-application/SKILL.md`
  - `.codecarto/BACKLOG.md`
  - `.codecarto/CHANGELOG-2026-05-02-feedback-pass.md`
  - `.codecarto/closeouts/2026-05-02-framework-feedback-pass.md` (this file)
  - `Feedback From Agents/Framework feedback pass - 2026-05-02.txt`
- **Modified:**
  - `.codecarto/GUIDE.md` (trust-boundaries table extended; new subsections: Primary vs Secondary, Orchestrator-Maintained Artifacts, Subagent Delegation, Open Questions vs Carry-Forward, Strategic Alignment Hook; Session Update Protocol updated; folder layout updated)
  - `.codecarto/workflow/status.yaml` (open_questions/carry_forward schema split)
  - `.codecarto/workflow/VALIDATE.md` (carry_forward routing rule + worked PARTIAL example)
  - `.codecarto/templates/architecture-map.md` (Carry-Forward section)
  - `.codecarto/templates/behavioral-contracts.md` (Carry-Forward section)
  - `.codecarto/templates/protocols-and-state.md` (Carry-Forward section)
  - `.codecarto/templates/reverse-engineering-bundle.md` (Carry-Forward section)
  - `.codecarto/templates/reimplementation-spec.md` (Known Unknowns + Carry-Forward shapes)
  - `.codecarto/templates/thread-log-entry-template.md` (repurposed as legacy one-line index entry template)
  - `.codecarto/THREAD_LOG.md` (rewritten as one-line-pointer index)
  - `.codecarto/CONTRIBUTING.md` (THREAD_LOG dedup linter; carry_forward in testing checklist)
  - `.codecarto/NEW_THREAD_BLURB.md` (carry_forward routing; per-session closeout pattern; file-system-sync warning)
  - `Feedback From Agents/FEEDBACK_INDEX.md` (cross-cutting-themes table annotated with resolution markers; entry 15 added)
- **Deleted:** none.

## Tests / Gates

| Gate | Result | Notes |
|---|---|---|
| File-path consistency | PASS | Every path referenced in GUIDE.md, NEW_THREAD_BLURB.md, VALIDATE.md, CONTRIBUTING.md, and pipeline YAMLs resolves to a real file. |
| Schema consistency (status.yaml ↔ templates) | PASS | The `{id, kind, target_phase, deferred_reason}` shape is consistent across status.yaml, all 5 templates' Carry-Forward sections, GUIDE.md "Open Questions vs Carry-Forward", and VALIDATE.md's worked example. |
| Trust-boundaries table coverage | PASS | New artifacts (closeouts, CONVENTIONS.md, DECISIONS.md, BACKLOG.md) all listed with access columns. |
| Closeout-template self-application | PASS | This closeout file uses `templates/closeout-template.md`. |
| FEEDBACK_INDEX.md self-awareness | PASS | Cross-cutting-themes table now carries APPLIED / CLARIFIED / DEFERRED-Bxx markers; entry 15 added. |

## Decisions Beyond Prompt

- **D-meta-1** | The `spec-delta-application` skill lives at a new top-level `.codecarto/skills/` directory (sibling of `findings/`), not inside `findings/`. | The prompt suggested "or a new top-level skills location — propose where" — chosen because spec-delta-application is post-pipeline (not phase-bound), so `findings/<phase>/SKILL.md` would mis-locate it. Trust-boundaries table updated to include `skills/*/SKILL.md`.
- **D-meta-2** | Rather than create CONVENTIONS.md and DECISIONS.md as filled-in framework artifacts, the framework ships them as `templates/conventions-template.md` and `templates/decisions-template.md` (skeletons that projects copy to `.codecarto/CONVENTIONS.md` / `.codecarto/DECISIONS.md`). | Per the prompt's "generalize from working examples, don't copy" — the codex artifacts are 600+ lines of Thaumaturge-specific content. The framework version should be the skeleton (~150 lines) that projects fork.
- **D-meta-3** | Schema split landed under both fields (`open_questions` AND `carry_forward`), not as a renaming. | A renaming would have broken the convention "open_questions field is the in-your-face honesty hook." Adding `carry_forward` as a sibling preserves the friction-driving job of `open_questions` (genuinely unknown) while solving the "two jobs" problem.
- **D-meta-4** | THREAD_LOG.md was rewritten as an index, not migrated. | The framework's THREAD_LOG.md was empty (only the example comment block), so there was no historical content to migrate. A real project's THREAD_LOG.md migration is a separate, project-level operation; documented in the THREAD_LOG.md header.
- **D-meta-5** | The Strategic Alignment Hook and the dual-mode reimpl-spec template land together as one feature, not two. | The hook *picks between* the two templates. Splitting them across two backlog items would have split the user experience.
- **D-meta-6** | The "Append-mode supersession rule" (3 agents) was deferred to backlog (B7) despite meeting the 3-agent threshold. | The prompt said "Spec-blocker = raised by 3+ agents AND clean concrete edit." Append-mode supersession does not have a clean concrete edit — it implies a reconciliation pass, which is phase-shape change. Defer per the AND clause.
- **D-meta-7** | "Validation as semantic check" (4 agents) was deferred to backlog (B8) despite the highest agent-count after THREAD_LOG scaling. | Same reasoning — no clean concrete edit; the proposed solutions (quality subagent, 1–5 score) are themselves design questions.
- **D-meta-8** | The Resolutions footer (B12) is partially obviated by the new `carry_forward` field. | Documented in BACKLOG.md to wait for the next round of feedback before adding more machinery.

## Proposed Conventions

### CO-1 (framework-level) — "Schema-split a one-job-too-many field rather than renaming"

**Why:** When a field is doing two distinct jobs (e.g., `open_questions` carrying both "still unknown" and "deferred to later phase" items), the cleaner fix is to add a sibling field rather than rename or restructure. Renaming breaks discoverability and history; adding a sibling preserves the original field's identity and the muscle-memory of past sessions while resolving the conflation.

**How to apply:** When agent feedback consistently identifies a field as doing two jobs, prefer "split into A + B siblings" over "rename A to A1 and A2" or "restructure into a nested map." Tested in this pass with `open_questions` + `carry_forward`.

(This is a framework-level convention, not a project-level one. It would land in a hypothetical `.codecarto-framework/CONVENTIONS.md` if such a file existed; for now, document in CHANGELOG.)

### CO-2 (framework-level) — "Defer per AND, not OR, when a proposal mentions multiple criteria"

**Why:** The triage discipline ("3+ agents AND clean concrete edit") is an AND, not an OR. Two proposals that hit 3+ agents but lacked clean concrete edits (B7, B8) deferred this pass — preserving the apply-in-good-faith posture rather than landing speculative changes.

**How to apply:** Future framework-feedback passes treat the two clauses as conjoined. A proposal raised by many agents but lacking a clean edit goes to backlog with a smallest-viable-form sketch (which then unblocks the next pass).

## Open Questions Left Behind

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| FW-OQ1 | needs-feedback | Whether the per-session closeout pattern actually feels lighter than monolithic THREAD_LOG once a project accumulates >20 closeout files. | Need real-world usage data; revisit after Thaumaturge accumulates 10–15 more closeouts. |
| FW-OQ2 | needs-feedback | Whether the `kind` enum on open_questions/carry_forward entries is the right granularity. | Five values feels right but could prove too coarse (e.g., should `defer-to-phase` distinguish "rubric-fit" from "sequencing"?). Evaluate after 5+ projects use it. |
| FW-OQ3 | needs-feedback | Whether the spec-delta-application skill being at `skills/` (sibling of `findings/`) is the right home, or if a `skills/post-pipeline/` subdirectory is needed once more post-pipeline skills land. | One skill in the directory today; revisit when a second one (e.g., spike-template) lands. |

## Carry-Forward Routed

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| FW-CF1 | future-feedback-pass | The 14 BACKLOG.md items each have a "smallest viable form" sketch — they're ready for the next pass to execute. | Bundle scope: ship one pass per category (e.g., next pass = "post-pipeline machinery": spike template + amendments + defect-pass-N). |

## Framework Feedback (the meta-meta layer)

The framework-feedback pattern (this session) is itself a CodeCarto-style activity that the
framework currently has no first-class concept of. Things I noticed running it:

1. **The triage discipline (apply / clarify / defer / reject) ported cleanly from spec-delta-application to framework-delta-application.** The same four buckets, the same "don't rubber-stamp" posture. The fact that the pattern transfers is evidence it's load-bearing — worth pinning explicitly. Suggestion for next pass: lift the triage discipline into a shared sub-skill that both `spec-delta-application` and a future `framework-feedback-pass` skill reference. Today the discipline lives only in prompts.

2. **The "do not modify" list at the bottom of FEEDBACK_INDEX.md was load-bearing.** Without it I would have rewritten the validation gate in the name of "improvement." The unanimous-defenders list is the framework's immune system. Worth promoting to a permanent fixture in CONTRIBUTING.md (currently lives only in the index).

3. **The cross-cutting-themes table at the bottom of FEEDBACK_INDEX.md is the actual spec for this kind of pass.** Per-file feedback summaries are useful for context but the table is what drove triage. Suggestion: future framework changes should update the cross-cutting-themes table in the same edit (which this pass did, via the resolution markers — but that pattern should be standard, not invented per-pass).

4. **The framework's self-applied `.codecarto/` is a real sanity test.** Editing GUIDE.md broke nothing because the framework's own self-application is structurally trivial (no findings, no closeouts before this session). For a richer self-application, edits to the framework would have a sharper feedback loop. Suggestion for future: maintain a synthetic example project (`examples/<small-codebase>/`) with a populated `.codecarto/` so framework edits can be smoke-tested against a real artifact.

5. **There's no skill for "framework-feedback-pass" itself.** This session ran on the discipline embedded in the prompt — apply blockers, defer nice-to-haves, preserve unanimous-defenders, write a CHANGELOG with the same shape as DELTAS-APPLIED.md, update the index with resolution markers. That's a reusable workflow. Worth codifying as a skill the same way `spec-delta-application` was codified this pass. Maybe `skills/framework-feedback-pass/SKILL.md` is the next entry in `skills/`.

## Next Session Pointer

Next concrete step: back to **Thaumaturge module work — `thaum-tools`** — but now with the
upgraded framework as the base. Specifically the next session should:

1. Read this closeout file plus `.codecarto/CHANGELOG-2026-05-02-feedback-pass.md` to inherit the framework changes.
2. The codex `.codecarto/CONVENTIONS.md` and `DECISIONS.md` artifacts are now the *project-level* artifacts; the framework-level skeletons are in `templates/conventions-template.md` and `templates/decisions-template.md`. The orchestrator's discipline maintaining those project files is now first-class.
3. The `carry_forward` schema split is now usable — items routed across phases get explicit `target_phase` IDs. Use it in the next session's status.yaml updates.
4. The per-session closeout pattern means `closeouts/2026-05-XX-thaum-tools.md` is the next file to write at session close, not an append to a monolithic THREAD_LOG.
5. Pending: Δ-36 (Ollama unknown done_reason) and Δ-37 (allowed-loopback wire shape) noted as D501/D502 in codex's DECISIONS.md — next spec-revision pass picks these up using the new `spec-delta-application` skill.
