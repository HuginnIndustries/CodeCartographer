# Backlog

Deferred framework improvements with rationale and source feedback files. Items here were
proposed by one or more agents in the feedback corpus but were not load-bearing enough to land
in the 2026-05-02 framework feedback pass. Each item is a candidate for a future pass.

Format per entry: rationale + which feedback file(s) raised it + what the smallest viable form
of the change would look like.

---

## B1. Spike template + first-class spike concept

**Raised by:** `Run three Thaumaturge implementation spikes.txt`, `Apply 20 spec deltas to Thaumaturge.txt`, `Agent on protocols phase - protocols.txt` (3 agents)

**Why deferred:** A spike template would land cleanly, but "first-class spike concept" implies workflow machinery (a `spikes/` directory convention, a validation rule for spike outputs, status.yaml fields for spike tracking). The 2026-05-02 pass is already changing the closeouts pattern, the open_questions schema, and the orchestrator-maintained artifacts list. Adding spike machinery on top risks too much surface change in one revision.

**Smallest viable form:** `templates/spike-report.md` skeleton with sections for Goal, Method, Measurements, Findings, Recommended Deltas. No workflow machinery; spikes stay a per-project convention initially. Status.yaml integration deferred until a project demonstrates the need.

---

## B2. Amendments mechanic (`findings/amendments/` directory)

**Raised by:** `Run three Thaumaturge implementation spikes.txt`, `Agent on protocols phase - protocols.txt` (2 agents — under threshold but persistent)

**Why deferred:** "Phase outputs can't correct prior phases" is a real gap, but `carry_forward` (introduced in this pass) already covers the most common case (forward-routing a deferred item). True back-amendment (a later phase says "the architecture map is wrong about X") needs more design — should it edit the prior output? Append a "superseded by" marker? Live in a parallel directory? The shape isn't obvious enough to land safely.

**Smallest viable form:** A pre-reimpl-spec "reconciliation" pass that surfaces contradictions across primary outputs. Less ambitious than a full amendments directory; uses existing artifacts.

---

## B3. Cross-CodeCartographer-workspace references in status.yaml

**Raised by:** `Agent on reimplementation spec - reimplementation spec.txt` (1 agent)

**Why deferred:** Single-agent ask. The use case (one CodeCarto workspace cites another) is real but rare. Most projects have one CodeCarto workspace. Designing a citation format that works across workspaces (relative paths? URLs? content-addressed IDs?) is non-trivial.

**Smallest viable form:** A documented convention for citing across workspaces using `<other-workspace-path>/<phase>/<output>.md#<anchor>` paths, without machinery. If a project demonstrates the need, formalize.

---

## B4. 1–5 coverage-depth score (alternative to PASS WITH GAPS)

**Raised by:** `Agent on reimplementation spec - reimplementation spec.txt` (1 agent)

**Why deferred:** Validation is currently structural (PASS / PARTIAL / FAIL with criterion-by-criterion check). A semantic depth score is a real ask but conflicts with the framework's posture that "honest output is the default" — a 1–5 score invites grade inflation in a way the binary criteria do not. Worth more thought before landing.

**Smallest viable form:** Optional second column in the validation block: "Depth: 1–5" with a rubric (1 = section header only; 5 = exhaustive). Use only when the team agrees on the rubric.

---

## B5. Programmatic markdown-regex validator

**Raised by:** `Agent on Deep Defect Scan - defect-scan-deep.txt`, `Agent on broad Defect Scan - defect-scan-broad.txt` (2 agents)

**Why deferred:** A real validator (parses status.yaml, checks output paths, verifies validation blocks exist with correct criterion counts, etc.) is a separate tooling project — more than a SKILL/template change. It deserves its own scoping.

**Smallest viable form:** A `scripts/validate.sh` that runs `yq` + `grep` checks for the most common gates (every primary_output exists; every validation block has at least N rows; every status.yaml phase has a status field). Document, don't ship without consensus on scope.

---

## B6. CI grep gate for tripwire-named functions

**Raised by:** `Agent on fifth module work - thaum-state.txt` (1 agent — project-level concern)

**Why deferred:** This is a *project*-level CI concern (Thaumaturge), not a framework concern. The framework's job is to surface the convention (which the orchestrator does in CONVENTIONS.md); the project's job is to gate it. Documented for the orchestrator to pick up at the project level.

**Smallest viable form:** Document in CONVENTIONS.md template's example entry that "production code path importing any tripwire-named function should fail the build" is a known follow-up. No framework artifact.

---

## B7. Append-mode supersession rule (consolidate vs append)

**Raised by:** `Agent on porting phase - porting.txt`, `Agent on protocols phase - protocols.txt`, `Agent on contracts phase - contracts.txt` (3 agents — at threshold but defers per scope)

**Why deferred:** Real friction: secondary outputs accumulate overlapping descriptions and recency wins by unwritten convention. A "supersedes" marker would land cleanly, but it also implies a reconciliation pass before reimplementation-spec, which is a phase-shape change. Worth landing in a follow-up pass that focuses on append-mode discipline holistically.

**Smallest viable form:** A `> SUPERSEDES <date>:<reason>` block convention at the top of each new dated section in append-mode files, plus a paragraph in GUIDE.md describing it. No machinery; just convention.

---

## B8. Validation as semantic check (not just structural / completeness)

**Raised by:** `Agent on broad Defect Scan - defect-scan-broad.txt`, `Agent on Deep Defect Scan - defect-scan-deep.txt`, `Agent on porting phase - porting.txt`, `Agent on protocols phase - protocols.txt` (4 agents — at-threshold)

**Why deferred:** "LLM grades its own homework" is a real gap. The fix is either a quality-subagent (a separate LLM pass that grades against the criteria) or a coverage-depth score (B4). Both are larger changes than this pass should land. The structural check at minimum prevents the worst failure mode (skipping the criterion entirely).

**Smallest viable form:** A `quality-review` skill that delegates to a subagent for criterion-by-criterion semantic check. Optional; not in the default closeout ritual.

---

## B9. Spec file split (single 1000+ line file → spec/ directory)

**Raised by:** `Agent on fourth module work - thaum-engine.txt`, `Agent on second module work - thaum-providers-ollama.txt`, `Run three Thaumaturge implementation spikes.txt` (3 agents — at-threshold)

**Why deferred:** This is a *project*-level concern (Thaumaturge's reimplementation-spec.md is 1300+ lines). The framework's template doesn't enforce a single file; a project can split. Documented for the orchestrator to pick up at the project level.

**Smallest viable form:** A documented convention in the opinionated reimpl-spec template that says "if the spec exceeds N lines, split into spec/ with INDEX.md anchored to original section IDs." No framework machinery.

---

## B10. SKILL.md and template files redundancy / consolidation

**Raised by:** `Agent on porting phase - porting.txt`, `Agent on protocols phase - protocols.txt`, `Agent on contracts phase - contracts.txt` (3 agents — at-threshold)

**Why deferred:** "SKILL says X, template says X — agent reads both and reconciles" is a real cost. But the framework's posture is that SKILL.md is the *how* (analysis instructions) and template is the *shape* (output skeleton). Collapsing them risks losing the separation. A surgical edit (de-duplicate the obvious overlaps without merging) is hard to do without per-file judgment.

**Smallest viable form:** A pass that inspects each SKILL/template pair and removes section headers from the SKILL that exactly match the template (the template alone is canonical for shape). Per-file work; not a single sweep.

---

## B11. Defect-pass-N append discipline (multi-pass defect-scan)

**Raised by:** `Agent on Deep Defect Scan - defect-scan-deep.txt`, `Agent on broad Defect Scan - defect-scan-broad.txt` (2 agents)

**Why deferred:** Defect-scan today expects "one pass = one phase output." Multi-pass (broad → deep) is a real pattern that emerged in Thaumaturge. Partially blessed in 2026-05-04 by `pipeline-full-with-deep-audit.yaml`, which splits the scan into mechanical (passes 1, 2, 6 — after architecture, before contracts) and semantic (passes 3, 4, 5 — after protocols, before porting) phases. Different mechanism than the originally-proposed within-phase pass-N append, but it covers the broad→deep use case. Open question: do projects still need the within-phase append pattern?

**Smallest viable form:** A `templates/defect-report-pass-N.md` template with a `findings/defect-scan/passes/<pass-id>.md` directory convention. Documented; not pre-applied.

---

## B12. Resolutions footer / phase resolution mechanic

**Raised by:** `Agent coordinating results - coordinating.txt`, `Agent on contracts phase - contracts.txt` (2 agents)

**Why deferred:** Partially resolved by `carry_forward` in this pass — the routing-and-resolution loop now exists. The remaining ask (a "previously resolved" footer in each output, or a resolutions/ directory) may be obviated by `carry_forward` in practice. Wait for next-pass feedback before adding more machinery.

---

## B13. Engine→leaf seam contracts table

**Raised by:** `Agent on fifth module work - thaum-state.txt` (1 agent — project-level)

**Why deferred:** Project-level (Thaumaturge-specific). The framework's job is to surface the convention; CONVENTIONS.md template now has the shape for it. The actual SEAMS.md would live at the project level.

---

## B14. Cross-phase consistency check

**Raised by:** `Agent on protocols phase - protocols.txt` (1 agent)

**Why deferred:** "Contracts and protocols both touch dispatcher / redaction / SSE and must stay aligned" — the proposed consistency check is a pre-reimpl-spec reconciliation pass. Related to B7 (append-mode supersession). Bundle into the same future pass.

---

## B15. spec-delta-application SKILL canonical refinements (first-run friction)

**Raised by:** `Spec-delta-3 application - 2026-05-03.txt` (1 agent — first real run of the SKILL post-2026-05-02 framework pass; high-signal because the SKILL had no field exposure before this)

**Why deferred:** Six small refinements to the same SKILL.md / templates pair, all visible only after a non-spike-sourced run. Bundling makes the next pass cheap; piecemeal would churn the SKILL repeatedly.

**Smallest viable form:** A surgical pass over `skills/spec-delta-application/SKILL.md` and `templates/deltas-applied.md` covering:
- **Citation forms** — canonicalize a small family beyond the spike-sourced `[revised per <file> §<delta-id>]`. Round-3 introduced `[revised per DECISIONS.md D5XX (Δ-N), round-N]` for D-entry-sourced deltas and `[revised per closeouts/<file> §<id>, round-N]` for closeout-sourced deltas. Document both as canonical, alongside the spike form.
- **Audit file path** — explicitly cover the non-spike case. Round-3 used `findings/deltas-applied/round-N.md` (directory convention) when the deltas weren't spike-driven; the existing "sibling-of-spec DELTAS-APPLIED.md" remains a special case for spike rounds.
- **Closeout filename** — round-numbered (`closeouts/<YYYY-MM-DD>-spec-delta-N.md`) avoids the collision risk of the current `closeouts/<YYYY-MM-DD>-spec-deltas.md` when two passes happen on the same day.
- **§header naming** — the spec's `## Post-Spike Revisions` header doesn't generalize for non-spike rounds. Rename to `## Post-Pipeline Revisions` (or similar) so post-pipeline non-spike rounds don't have to add explanatory paragraphs about why "Post-Spike" still applies.
- **Step 6 prominence** — add a sentence to Step 6 ("Update the spec's front-matter citation conventions list") emphasizing this is required when the application introduces new citation forms; otherwise the audit-table marker list is unanchored.
- **APPLY may refine the proposal** — Δ-36's literal D501 text was "map to 'error'" but the application refined to "emit error event + done(error)" mirroring the existing in-stream-error pattern. The four-bucket matrix's APPLY bucket implicitly permits refinement, but the SKILL should make it explicit: APPLY may include refinements beyond the literal proposal text, with the refinement captured as a Decision-Beyond-Triage in the closeout.

---

## B16. Project-level BACKLOG.md template + GUIDE.md project-vs-framework-level clarification

**Raised by:** `Spec-delta-3 application - 2026-05-03.txt` (1 agent — first-run-of-SKILL friction)

**Why deferred:** The SKILL says "DEFER → Add to BACKLOG.md with rationale and a back-reference," but the codex workspace had no project-level BACKLOG.md and the upstream `.codecarto/BACKLOG.md` is for framework-feedback deferrals (correctly excluded from project sync). Round-3 created `.codecarto/BACKLOG.md` from scratch with a project-scoped shape. Future projects will hit the same bootstrap gap.

**Smallest viable form:**
- Ship `templates/backlog-project.md` skeleton with header + format-per-entry note + an example entry. Format-per-entry should include: rationale, raised-by (closeout file or D-entry), preconditions (which modules / artifacts need to land before the deferral can be revisited — Δ-38 demonstrated this field's value), and "smallest viable form."
- Add one paragraph to `GUIDE.md` clarifying the project-level vs framework-level distinction: framework `.codecarto/BACKLOG.md` is for framework-feedback deferrals (raised by agents about CodeCartographer itself); project `.codecarto/BACKLOG.md` is for project-decision deferrals (raised during the project's own work).
- SKILL Step 7 (DEFER bucket) explicitly references the project template.

---

## B17. SKILL clarification — DECISIONS.md vs BACKLOG.md semantics for DEFER

**Raised by:** `Spec-delta-3 application - 2026-05-03.txt` (1 agent — first-run-of-SKILL semantic ambiguity)

**Why deferred:** The SKILL's DEFER guidance and its "append numbered entries to DECISIONS.md for any decisions made during triage that weren't already in the deltas" instruction left ambiguous whether DEFER-with-rationale belongs in DECISIONS.md or BACKLOG.md. Round-3 chose: DECISIONS.md is for things the project decided to **DO** (including refinements made during application — e.g., D501's refinement); BACKLOG.md is for things the project decided to **DEFER**. DEFERs do not get a D5xx number, and DECISIONS.md's "pending spec deltas" subsection only tracks proposed → applied lifecycle.

**Smallest viable form:** A two-sentence clarification in SKILL Step 7's DEFER bucket: DEFER → BACKLOG.md (no D-number); refinements made during APPLY → DECISIONS.md "Decisions Beyond Triage" section in the audit file, lifted to DECISIONS.md only if cross-cutting. Existing D-entries for proposed deltas get their disposition updated in place (e.g., "APPLIED 2026-05-03 round-3"); they do not get superseded by new D-entries when applied.

---

## How to use this backlog

A future framework-feedback pass picks items up from here. Each item has a "Smallest viable
form" line so the pass doesn't have to re-design from scratch — the design work was done in this
pass; the next pass executes.

Add new entries below as agents raise items in future feedback files. When promoting an item to
"applied," remove the entry from this file and document in the relevant CHANGELOG.
