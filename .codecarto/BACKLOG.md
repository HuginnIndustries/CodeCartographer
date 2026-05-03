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

**Why deferred:** Defect-scan today expects "one pass = one phase output." Multi-pass (broad → deep) is a real pattern that emerged in Thaumaturge. Bless it, but the shape is project-specific (which passes? what naming?). Worth designing once another project does multi-pass.

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

## How to use this backlog

A future framework-feedback pass picks items up from here. Each item has a "Smallest viable
form" line so the pass doesn't have to re-design from scratch — the design work was done in this
pass; the next pass executes.

Add new entries below as agents raise items in future feedback files. When promoting an item to
"applied," remove the entry from this file and document in the relevant CHANGELOG.
