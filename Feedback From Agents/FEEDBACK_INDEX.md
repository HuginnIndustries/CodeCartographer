# Feedback Index

Index of agent feedback files in this directory. Each entry summarizes what the
session covered, what topics the feedback raises, and where to find specific
points in the file.

---

## 1. Agent coordinating results

**File:** `Agent coordinating results - coordinating.txt`
**Lines:** 29

**What this covers:** A synthesis pass looking back across all six pipeline
phases (architecture through reimpl-spec) on the codex codebase. Identifies
load-bearing features that should never change and real architectural gaps in
the framework itself.

**Key topics:**
- Validation gate (PASS / PASS WITH GAPS / FAIL) is the single most disciplining feature
- Append-mode secondary outputs as the framework's "quiet superpower" — dated sections create a history of how understanding grew
- Pipeline variants (5) map to real use cases and keep scope honest
- Trust-boundaries table at top of GUIDE.md is small but load-bearing
- Skill files with structured prompts removed the "wrong-shape problem"
- open_questions field conflates real unknowns with deferred items — needs splitting
- Phase handoffs lack a resolutions/ mechanic so downstream phases can see what was resolved
- No "strategic alignment" hook before the synthesis phase
- Primary vs secondary output relationship is undocumented
- Subagent delegation not blessed for large codebases (>50 source files)
- Defect-scan doesn't naturally fit a single phase boundary
- Framework's biggest strength: it makes honest output the default — validation block can't be skipped

**Notable friction:** open_questions doing two jobs caused friction at every
phase handoff; the reimpl-spec template defaults to "any port to any stack"
which is the wrong tool for an opinionated port.

**Where to find it:**
- Lines 4–9: what works and why it matters
- Lines 10–17: real friction points (in priority order)
- Lines 19–26: concrete changes proposed, in priority order
- Lines 28–29: what to never change + the framework's underplayed strength

---

## 2. Agent on broad Defect Scan

**File:** `Agent on broad Defect Scan - defect-scan-broad.txt`
**Lines:** 22

**What this covers:** Running the defect-scan phase across a 91-crate,
~780K-LOC repo. Surfaces friction that the lighter architecture phase didn't
expose. Documents where the framework's template assumptions break down under
real scale.

**Key topics:**
- Phase-by-phase separation with depends_on and single status.yaml source-of-truth worked cleanly
- Carry-forward mechanism (architecture → defect-scan) was the single highest-value piece — four pre-targeted hypotheses became four confirmed findings
- Six-pass split forced category discipline (no conflation of concurrency with security)
- PASS / PARTIAL / FAIL / PASS WITH GAPS taxonomy makes "not quite finished" a first-class outcome
- Document-as-you-go workflow is not a first-class citizen — templates assume single-session fills
- Action-set switch (fix before porting vs fix now/track/accept) is ambiguous; model guesses which vocabulary to use
- Severity guidance is thin for security findings — no "trust assumption" axis
- [carry-forward] tag is widely used but undocumented in any schema
- open-question taxonomy needed: defer-to-phase-X, needs-runtime-test, needs-maintainer-decision, etc.
- Counts in summary tables are easy to miscount; no verify-counts sanity check
- Wants programmatic validator before model is allowed to mark complete in status.yaml

**Notable friction:** Template assumes one session, one fill of the table —
unrealistic at scale. Security severity ladder doesn't map to OOM-from-model
findings.

**Where to find it:**
- Lines 4–5: what worked well
- Lines 6–14: what to change (structured as numbered concerns)
- Lines 15–21: smaller things + the thing most wanted next

---

## 3. Agent on Deep Defect Scan

**File:** `Agent on Deep Defect Scan - defect-scan-deep.txt`
**Lines:** 16

**What this covers:** Running both passes (broad + deep) of defect-scan on the
same 780K-LOC codebase. Documents where the prescribed sequential-pass ordering
is wasteful and identifies gaps in the append/follow-up file conventions.

**Key topics:**
- Phase/skill/template separation is strongest part — resuming across sessions is cheap
- status.yaml as single source of truth means the index never drifts from artifacts
- Six sequential passes are misleading for large codebases — reading every file six times is wasteful; agent read by crate once and collected findings across all passes simultaneously
- Validation block conflates completion-criteria check with quality assessment — feels like "security-theater"
- No convention for appending follow-up sections — agent invented DD<pass>.<n> IDs inline
- Action-set vocabulary fuzzy between "fix before porting" and "port differently"
- open_questions field as free-text gets unwieldy after ~10 entries across phases
- Pass files for error-handling and security overlap heavily on data-leak findings
- Framework assumes single-LLM session per phase but context saturates at ~780K LOC
- No worked example for PARTIAL validation block format in VALIDATE.md

**Notable friction:** Sequential-pass framing actively misled the agent on the
first pass. The follow-up report has no template — every session re-invents the
convention.

**Where to find it:**
- Lines 4–6: what worked well
- Lines 7–10: things that got in the way
- Lines 11–15: small concrete suggestions + overall assessment

---

## 4. Agent on contracts phase

**File:** `Agent on contracts phase - contracts.txt`
**Lines:** 16

**What this covers:** Running the contracts phase after architecture and
defect-scan. Focuses on the handoff quality and identifies specification gaps
around append-mode contracts, secondary-output ownership, and context-budget
discipline.

**Key topics:**
- Phase-output → secondary-append pattern is the strongest thing in the framework
- Architecture phase's "Resolved" subsection (closing own open questions before downstream fires) paid off
- Defect-scan → contracts handoff worked exactly as designed — "what's broken" vs "what should the port guarantee" is a real and useful distinction
- VALIDATE.md's "PARTIAL not PASS when uncertain" rule is good discipline
- "Required reads" expand by phase — by contracts ~100K tokens; subagent delegation needed
- Append-mode contract is under-specified — pipeline says mode: append but doesn't say what form
- Parallel-phase warning correct but failure mode silent — concurrent status.yaml updates clobber
- Secondary-output target mismatch across phases — contracts doesn't touch build-and-deploy, porting does
- SKILL.md vs templates redundancy — agent had to read both and reconcile
- No mechanical schema validator — "LLM grades its own homework"
- status.yaml current_phase comment is misleading with sibling phases

**Notable friction:** Append-mode convention has no example in templates.
Required reads context budget balloons through pipeline phases with no guidance
on delegation.

**Where to find it:**
- Lines 3–6: what worked well
- Lines 7–14: what was awkward (8 specific items)
- Lines 15–16: THREAD_LOG entry template suggestion + net assessment

---

## 5. Agent on protocols phase

**File:** `Agent on protocols phase - protocols.txt`
**Lines:** 19

**What this covers:** Running the protocols phase as a sibling of contracts.
Pinpoints where wire-level protocol work exposes brittleness in the framework's
cross-phase consistency model and the tension between template skeletons and
the ~1450-line deliverable reality.

**Key topics:**
- Phase-gating with depends_on and next_actions made context loading deterministic
- Carry-forward routing is strongest piece — contracts deferred per-tool schemas to protocols with explicit handoff text
- Evidence-level tagging (observed fact / strong inference / portability hazard / open question) was more than ceremony
- Append-mode secondary outputs let four phases contribute on the same topics without conflicts
- Skills are terse; agent leaned heavily on contracts deliverable for calibration — without it, output would have been thinner
- Templates are skeletons — actual deliverable was ~1450 lines vs template's placeholder tables
- Cross-phase consistency is not checked — contracts and protocols both touch dispatcher, redaction, SSE and must stay aligned
- Defect IDs as cross-references are brittle — re-numbering would silently break all downstream cites
- Append-mode outputs grow without bound; no supersession rule — recency wins by unwritten convention
- Phase outputs can't correct prior phases — only add or raise; no amendment mechanism
- Heavy source reading requires subagent delegation but framework doesn't mention it
- Five pre-flagged items (DD2.1, DD5.3, DD6.1/2, DD5.1, D5.x/DD5.x) routed through defect→contracts→protocols had exactly the right shape

**Notable friction:** Terse skill files + skeleton templates = new runs would
underproduce. Phase outputs can't correct prior phases when discoveries
contradict earlier findings.

**Where to find it:**
- Lines 5–6: what worked well
- Lines 7–14: pain points (8 items)
- Lines 15–18: smaller things + the cross-phase triad worth replicating

---

## 6. Agent on porting phase

**File:** `Agent on porting phase - porting.txt`
**Lines:** 12

**What this covers:** Running the porting phase end-to-end as the synthesis
step. Identifies how the bundle template fits (and doesn't fit) the porting
phase's role, and where secondary-output accumulation becomes a real usability
problem by the fourth append.

**Key topics:**
- Phase ordering and depends_on graph created good information flow — contracts pre-flagged defects, protocols pinned wire invariants, defect-scan organized by leverage
- Citation convention across phases ([contracts §X], [protocols §X]) is load-bearing
- "Port contract vs current implementation" distinction is the single most useful innovation in the framework
- Bundle template doesn't fit porting's synthesis role — no slot for per-defect classification, hazard triage, or feature-importance refinement
- Append-mode secondary outputs accumulate overlapping descriptions — no rule for consolidate vs append
- Carry-forward mechanism is push-only — destination phase has no inbox; agent had to grep all four prior phases
- Validation is structural, not semantic — a completeness check, not a correctness check
- Pipeline YAMLs duplicate phase definitions — composition mechanism would reduce maintenance
- Deliverable file sizes outgrow read-budget (behavioral-contracts.md was 37K tokens)
- No first-class scope field per phase — scope recorded in owner_notes prose instead
- Evidence-level tags feel verbose by synthesis phases when most assertions are citations

**Notable friction:** The template asks for Domain Glossary and Observed Facts
— useful early but redundant by porting — and has zero slots for what the SKILL
actually demands.

**Where to find it:**
- Lines 3–4: what worked well
- Lines 4–11: friction (7 items in prose)
- Lines 11–12: smaller things + whether they'd use the framework again as-is

---

## 7. Agent on reimplementation spec

**File:** `Agent on reimplementation spec - reimplementation spec.txt`
**Lines:** 10

**What this covers:** Producing the reimplementation spec from all upstream
phase deliverables. Highlights where the framework assumes a language-agnostic
posture when the actual task is an opinionated, stack-locked port — and where
primary output file sizes become a read-budget tax on downstream phases.

**Key topics:**
- Phased pipeline is genuinely good cognitive scaffolding — required_reads + validation blocks kept the agent honest
- Carry-forward routing in open_questions lets each phase own only what it can responsibly close
- JSONL-style separation (THREAD_LOG, findings/, status.yaml) is a clean split worth copying
- SKILL.md pushes "language-agnostic" as default but the task was opinionated TS-on-Bun — framework didn't anticipate that mode
- Template awkward when pre-committed to a stack — External Dependencies degenerates to "wrap stdlib"
- Primary outputs grew to ~30K tokens exceeding Read tool limits; suggests <phase>-summary.md companion files
- Cross-CodeCartographer references unsupported — no formal citation mechanism for other codecarto repos
- Architecture-phase context-budget guidance too soft for 780K-LOC repos
- Validation rubric is binary about structure but soft about coverage depth — suggests 1–5 score

**Notable friction:** The dual-mode gap (language-agnostic vs opinionated) is a
real design miss — needs different templates for each posture.

**Where to find it:**
- Lines 3–4: what works
- Lines 4–10: friction worth naming (5 items)
- Line 10: non-blocking but places the framework could carry more weight

---

## 8. Apply 20 spec deltas to Thaumaturge

**File:** `Apply 20 spec deltas to Thaumaturge.txt`
**Lines:** 13

**What this covers:** A post-pipeline revision session applying 20 spec deltas
to the Thaumaturge reimplementation spec based on spike findings. Documents
the discipline of triaging deltas (apply blockers, defer nice-to-haves) and
the absence of a dedicated skill/template for this workflow.

**Key topics:**
- Phase pipeline (architecture through reimplementation-spec) earned its keep — downstream cites upstream by section anchor
- Citation convention ([contracts §X], [protocols §X], [porting Finding N]) enabled delta triage without re-reading source
- "Spike session as a separate concept, not a phase" pattern works — current_phase stays complete
- No template or SKILL.md for spec-delta-application step — agent invented DELTAS-APPLIED.md table format
- [revised per spike-N-<slug>.md §Δn] citation form should be canonical, not per-session
- "Don't apply deltas verbatim without thinking" instruction actually paid off — Δ-15 was wrong on close reading
- THREAD_LOG.md has a duplicated spike-session entry — framework has no de-dup guard
- Validation criteria are outcome-shaped, not process-shaped

**Notable friction:** Rubber-stamp application of deltas would have produced an
incorrect spec. The framework has no template for this workflow — it's entirely
prompt-driven.

**Where to find it:**
- Lines 3–6: what worked + spike-session-pattern analysis
- Lines 7–9: what to change (3 concrete gaps)
- Lines 11–12: minor items (THREAD_LOG de-dup, validation criteria shape)
- Line 13: net assessment — two gaps worth closing

---

## 9. Run three Thaumaturge implementation spikes

**File:** `Run three Thaumaturge implementation spikes.txt`
**Lines:** 21

**What this covers:** Running three pre-implementation spikes against the
completed reimplementation spec. Surfaces the biggest structural gap in the
framework: it has no first-class concept of post-pipeline iterative work
(spikes, amendments, proposed deltas).

**Key topics:**
- Trust-boundary table at top of GUIDE.md is strongest part — unambiguous about touch/cannot-touch
- mode: append on secondary outputs is clean — phases layer without re-litigating earlier facts
- Validation blocks at bottom of primary outputs give instant map of section coverage
- No first-class home for amendments — agent invented findings/spikes/CONSOLIDATED-DELTA.md; suggests findings/amendments/ directory
- Spike List in spec is forward-looking but framework treats spec as closed — no spike template, no validation rule
- THREAD_LOG.md in tension: GUIDE says "one short summary entry" but precedent is paragraph-length structured entries
- Reimpl-spec at 1100 lines in single file — Read tool refused it whole; suggests split with stable anchors or TOC
- status.yaml per-phase owner_notes and open_questions are durable — oriented agent faster than GUIDE
- Spec citations ([contracts §X], [porting Finding N], [H<N>]) make traceability cheap
- Framework solid for linear "understand codebase" path; seams show in iterative work

**Notable friction:** Post-pipeline activities (spikes, amendments) are
phase-shaped work with no phase machinery. The framework presumes linearity when
real work is iterative.

**Where to find it:**
- Lines 3–5: what works well
- Lines 7–13: two structural gaps (amendments, spike concept)
- Lines 13–19: smaller things (THREAD_LOG tension, spec file size, status.yaml durability)
- Line 21: net — needs a post-pipeline activities section in GUIDE

---

## 10. Agent on second module work — thaum-providers-ollama

**File:** `Agent on second module work - thaum-providers-ollama.txt`
**Lines:** 235

**What this covers:** Second code-producing session implementing the Ollama
provider adapter against the codecarto spec, round-2 captured fixtures, and
the thaum-protocol package. Tests the full spec→deltas→tests→behavior chain
and surfaces spec-truncation issues and next_actions scaling pain.

**Key topics:**
- Fixtures-as-vendored-stable-artifacts — replay tests produce exact NormalizedAssistantEvent sequences from captured wire bytes
- Δ-numbered deltas with traceability suffixes ([verified-on-ollama], [provisional-on-opencode-zen]) let implementer know which spec rules are empirically confirmed
- "Discipline" section in session prompt was effective: honor Origin column, pre-stream errors first-class, no engine logic, no abstract Provider machinery
- Tests cite the spec — every test file header cites the §s/Δs it verifies
- status.yaml as handoff baton — next_actions told exactly which fixtures, spec deltas, and provisional tests to use
- THREAD_LOG template with "decisions made beyond prompt" section is high-signal
- Spec file was truncated (237 lines vs expected ~1050) — spec not the single source of truth
- next_actions list scaling — 6 bullets doing the work of 4 categories
- Spec rule conflict: spec says Warning on unknown done_reason, prompt says error — agent went with prompt
- Verbatim-citation discipline hard to enforce — suggests function-level docstring + line-level slug-citation

**Notable friction:** Truncated spec file forced reconstruction from deltas +
prompt rather than canonical source. next_actions is already outgrowing "list
of next things" into a rolling log.

**Where to find it:**
- Lines 12–80: what worked really well (6 items with detailed examples)
- Lines 83–178: friction (6 items)
- Lines 180–205: what might help the next session (5 suggestions)
- Lines 208–235: overall assessment of framework value in one sentence

---

## 11. Agent on fourth module work — thaum-engine

**File:** `Agent on fourth module work - thaum-engine.txt`
**Lines:** 297

**What this covers:** Fourth code-producing session building the central engine
module (SQ/EQ orchestrator, Outcome newtype, two-tier intervention queue).
Shows where typed-seam discipline, tripwire-named stubs, and the closeout ritual
compound across sessions — and where spec file size and THREAD_LOG scaling are
now real workflow taxes.

**Key topics:**
- Typed-seam discipline as v0 anti-creep mechanism — five leaf modules stubbed at clean interfaces (StateSeam.noOp, ExecPolicySeam.allowAll, etc.)
- ExecPolicySeam.allowAll() named as tripwire — screams "v0 stub" to anyone reading the code
- Outcome newtype paid off — dispatcher arms are compile-time-enforced to call sink.respond/error/defer
- Verbatim spec quotes at load-bearing seams: dispatcher.ts, queue.ts, turn.ts, task.ts each carry the exact spec text above the implementation
- Session prompt's "Discipline" section was the single highest-signal block — resist scope creep, use Outcome religiously, no I/O without injected slot, generalize test-injection pattern
- "Lift if it generalizes; document why if it doesn't" forces an actual decision, not mechanical compliance
- Closeout ritual (THREAD_LOG → status.yaml → decisions beyond prompt) remains the right shape
- Spec file read-cost high — 42 KB / 237 lines; agent grep/offset/limit'd through it
- status.yaml next_actions scaling again — 11 entries doing 4 jobs
- Filesystem sync flake during closeout — bash heredoc vs host Edit tool disagreement
- THREAD_LOG.md at 90+ KB — Read-without-offset is risky
- Spec/code drift: 'allowedLoopback' (canonical in protocol) vs 'allowed-loopback' (still in spec text)
- Test-injection pattern documented in 3 places — needs single CONVENTIONS.md home

**Notable friction:** THREAD_LOG.md is too large for safe Read. next_actions
at 11 entries is a rolling log, not a handoff pointer. No CONVENTIONS.md for
cross-cutting patterns that have now accumulated across 4 modules.

**Where to find it:**
- Lines 17–124: what worked really well (6 items with examples)
- Lines 127–222: friction (6 items)
- Lines 225–267: what might help the next session (6 suggestions)
- Lines 269–297: overall assessment — methodology is working, friction is mechanical

---

## 12. Agent on fifth module work — thaum-state

**File:** `Agent on fifth module work - thaum-state.txt`
**Lines:** 350

**What this covers:** Fifth code-producing session implementing the durability
module (`thaum-state`) — the session that turns `thaum resume` into a real
verb. Extends the tripwire-naming convention, surfaces the biggest
file-system-sync tax yet (~30 minutes lost), and documents where the "don't
drift" rule needs sharper boundaries.

**Key topics:**
- Discriminated-union return type (absent/present/corrupt/truncated) promoted to project-wide invariant — every reader returns a typed kind union
- Agent added 'truncated' as 4th variant — partial trailing line is expected post-power-loss, not corrupt
- Engine's typed seam (StateSeam) was exactly the contract — compile error IS the spec for module N+1
- Verbatim spec quotes at 5 load-bearing seams (rollout-writer, rollout-reader, session-index, path-mutation-queue, derive-index)
- Tripwire-named v0 stubs extended: unsynced(), inMemoryNonDurable() — greppable vocabulary of test-shortcuts compounds
- "Lift if it generalizes; document why if it doesn't" forced decisions — lifted atomic file helpers to protocol, kept per-module slot records local
- Spec layout grep-friendly with H2/H3 structure
- Closeout ritual remains the right shape — agent knew exactly what next session needs (thaum-tools implements ToolsSeam)
- Bash-mount vs host-file-system sync was the biggest friction — 20–30 minutes lost to stale reads, NUL bytes, duplicate tail content
- "Don't drift into tools or exec-policy" boundary blurry — engine wiring for integration tests was arguably in-scope
- StateSeam.appendEntry contract narrow (kind: string, payload: unknown) but JSONL spec wide — mapping is an implicit contract
- SessionIndex runMigrations() bug caught only in test — test-density convention pays off
- THREAD_LOG.md approaching 100 KB; status.yaml next_actions at 12 entries
- Spec layout: real-path-mutation-queue rule split across 3 sections without cross-references

**Notable friction:** File-system sync cost was the single biggest time-tax.
The discriminator union pattern is project-wide now but has no canonical home
(CONVENTIONS.md). Engine→State seam mapping is implicit.

**Where to find it:**
- Lines 17–127: what worked really well (7 items with code examples)
- Lines 128–267: friction (7 items, the most detailed of any feedback file)
- Lines 269–321: what might help the next session (6 suggestions)
- Lines 323–350: overall assessment — fastest implementation due to prior sessions' compound conventions

---

## 13. Concatenated codex feedback (archival — redundant)

**File:** `other/Feedback From Agents working on the codex codebase.txt`
**Lines:** 144

**What this covers:** A concatenation of all codex-pipeline feedback
(reimplementation spec, coordinating, protocols, contracts, broad defect scan,
deep defect scan, porting) into one file. Content is identical to the
individual files above — this file exists as a convenience compilation but
reading the individual files is preferred for precise line-level pointers.

**Where to find it:** File is split by `---` separators. Section order matches
the numbered entries 7, 1, 5, 4, 2, 3, 6 above (in that order).

---

## 14. Existing index in other/ (archival)

**File:** `other/FEEDBACK_INDEX.md`
**Lines:** 238

**What this covers:** A predecessor index file created by a different tool.
Contains per-file topic summaries and a cross-cutting themes table. This root
index supersedes it — refer here for the authoritative version.

---

## Cross-Cutting Themes

Recurring issues raised by multiple agents, ordered by how many agents flagged
them.

**Resolution status legend** (added 2026-05-02 framework feedback pass):

- ✅ APPLIED — landed in this pass; see `.codecarto/CHANGELOG-2026-05-02-feedback-pass.md`.
- ◑ CLARIFIED — mechanical edit applied this pass.
- ➜ DEFERRED-Bxx — recorded in `.codecarto/BACKLOG.md` with rationale and smallest-viable-form sketch.

| Theme | Raised by | Most actionable suggestion | Resolution |
|---|---|---|---|
| THREAD_LOG.md / status.yaml scaling (file too large, next_actions doing too many jobs) | thaum-ollama, thaum-engine, thaum-state, coordinating, spikes, porting | Split THREAD_LOG into per-session closeout files; schema-split next_actions into completed_modules / next_module / pending_deltas / conformance_gates | ✅ APPLIED (per-session closeouts pattern; THREAD_LOG.md is now an index). Status.yaml schema-split for `next_actions` is project-shaped — left to the orchestrator at the project level. |
| Subagent delegation not blessed for large codebases | coordinating, broad defect, contracts, protocols, deep defect | One paragraph in GUIDE.md — delegate dependency mapping, file inventories, and cross-document comparisons; cite their scratch artifacts | ✅ APPLIED (GUIDE.md "Subagent Delegation for Large Codebases"). |
| open_questions doing two jobs (real unknown vs deferred to later phase) | coordinating, broad defect, deep defect, porting | Split into open_questions + carry_forward with explicit phase targets and a structured shape {id, kind, target_phase, reason} | ✅ APPLIED (status.yaml schema, all 5 templates, GUIDE.md "Open Questions vs Carry-Forward", VALIDATE.md routing rule). |
| Append-mode secondary outputs grow without bound; no consolidation rule | protocols, porting, contracts | Add a "this section supersedes earlier sections" marker or a pre-reimpl-spec reconciliation pass | ➜ DEFERRED-B7 (smallest viable form: `> SUPERSEDES <date>:<reason>` marker convention). |
| Validation is structural/completeness check, not semantic/quality check | broad defect, deep defect, porting, protocols | Add programmatic validator for mechanical checks; add quality-subagent or 1–5 coverage-depth score for semantic assessment | ➜ DEFERRED-B5 + DEFERRED-B8 (programmatic validator + semantic check both in backlog). |
| Spec file too large (single 1000+ line file); truncation issues | thaum-engine, thaum-ollama, spikes | Split into spec/ directory with INDEX.md; add bun run spec:check CI gate for required section presence | ➜ DEFERRED-B9 (project-level concern; framework template doesn't enforce single file). |
| File-system sync issues (bash mount vs host tools disagree) | thaum-engine, thaum-state | Warning paragraph in session prompt boilerplate: prefer full-file overwrites, verify via wc -l + md5sum | ◑ CLARIFIED (NEW_THREAD_BLURB.md "File-System Sync Warning" section). |
| Need for CONVENTIONS.md / SEAMS.md — cross-cutting patterns have no canonical home | thaum-engine, thaum-state, thaum-ollama | Create .codecarto/CONVENTIONS.md with project-wide invariant list; create SEAMS.md table for engine→leaf contracts | ✅ APPLIED for CONVENTIONS.md and DECISIONS.md (templates + GUIDE.md trust-boundaries + closeout integration). SEAMS.md is project-level → ➜ DEFERRED-B13. |
| Spec-delta-application has no skill or template | deltas | Create dedicated spec-delta-application skill + DELTAS-APPLIED.md template | ✅ APPLIED (`skills/spec-delta-application/SKILL.md` + `templates/deltas-applied.md`). |
| Spike / amendment activities not first-class concepts | spikes, deltas, protocols | Add findings/amendments/ directory; create spike template with validation rule | ➜ DEFERRED-B1 (spike template) + DEFERRED-B2 (amendments). Partially obviated by `carry_forward` field which now formalizes forward-routing. |
| SKILL.md and template files are redundant / drift apart | contracts, protocols, porting | Consolidate to one authoritative source per phase with the other as stub-pointer | ➜ DEFERRED-B10 (per-file judgment work; not a single sweep). |
| Primary vs secondary output relationship undocumented | coordinating, porting | Two-paragraph rule in GUIDE.md: primary owns the map and load-bearing claims; secondaries own catalog-level detail | ◑ CLARIFIED (GUIDE.md "Primary vs Secondary Output Relationship" subsection). |

---

## What Agents Unanimously Defend

Features every agent says should never change:
- **Validation gate** (PASS / PASS WITH GAPS / FAIL with criterion table)
- **Append-mode secondary outputs** (dated phase sections create a history of understanding)
- **Trust boundaries table** at top of GUIDE.md
- **Pipeline variants** (5 maps to real use cases)
- **Evidence-level discipline** (observed fact / strong inference / portability hazard / open question)
- **The closeout ritual** (THREAD_LOG → status.yaml → decisions beyond prompt)
- The framework's core strength: **it makes honest output the default** — you can't skip the validation block or leave evidence levels blank

The 2026-05-02 framework feedback pass preserved all of these. The trust-boundaries table was *extended* with new categories (closeouts, conventions, decisions, backlog), not modified in shape. The closeout ritual was *extended* to include conventions/decisions promotion and per-session closeout files; the ritual's shape (validation → status.yaml → per-session record → next pointer) is preserved.

---

## 15. Framework feedback pass (2026-05-02)

**File:** `Framework feedback pass - 2026-05-02.txt`

**What this covers:** A meta-session: instead of using CodeCartographer to analyze a codebase, the session edits CodeCartographer based on the 13 prior feedback files. Documents what the spec-delta-application discipline looks like when applied to the framework itself, and what worked / didn't / next about doing the meta-pass.

**Where to find it:**
- `.codecarto/CHANGELOG-2026-05-02-feedback-pass.md` — the audit table of applied/clarified/deferred items.
- `.codecarto/BACKLOG.md` — the deferred items with rationale.
- `closeouts/2026-05-02-framework-feedback-pass.md` — the session closeout itself.
