# Shopify's Helix and agent-addressable architecture — what transfers, with a CodeCartographer slant

**Status:** historical design discussion, recorded against v0.26.0; no feature is shipped by publishing this document. The subsequent [engineering vision](../engineering/vision.md), [record contract](../engineering/record-contract.md), and [implementation plan](../engineering/implementation-plan.md) take precedence for new work. Reviewer count and richer host integration remain deliberately open.

**Post-dogfood precedence:** retain the name Traverse, the slice vocabulary, host-owned execution, unchanged analysis guards, and the separate reviewed-synthesis variant. P1 maps to E09 and P3 to E10. P6's single `scratch/traverse/<slice-id>.md` record is superseded by per-change/per-attempt records; the ordinary change path needs no library and is not gated by the whole synthesis pipeline. Minimum identity, proof integrity, and freshness precede accepted execution. P3 prefers a headless seam but allows the appropriate observable GUI/hardware/integration check and recorded limitations. P4 is deferred and never grants new permissions automatically. In P2, a blocking objection with an owner is still blocking for affected work; approval and resolution must bind to the reviewed inputs. Below is the original proposal and rationale, not a second competing implementation contract.
**Source:** ["Native is now the future of mobile at Shopify"](https://shopify.engineering/back-to-native) (2026-09-10), plus the follow-up promised on Helix and agent-addressable architecture.
**Reported against:** v0.26.0.
**In one paragraph:** "our own version of Helix" is **Traverse** — a forward build-and-verify loop over a *slice plan* that both the analysis spec and the synthesis plan emit in the same shape, executed by the host and recorded by the framework, never a rewrite of the analysis pipeline. Adversarial review lands on the forward side as a synthesis-pipeline phase between `spec-merge` and `goal-synthesis-finalize`. Agent addressability is both an analysis dimension and a spec requirement. The framework never runs commands or edits the target repository on any surface.

---

## 1. What Helix actually is, decoded

The article is a migration announcement; Helix is described in three paragraphs. Reduced to mechanisms:

1. **Checkpoint plan.** The developer points Helix at a screen. It reads the React Native reference and proposes a sequence of checkpoints — small, ordered slices reviewable in minutes — before building anything.
2. **Gated build loop.** Each checkpoint must, in order: prove behavior with tests, match the running app in a visual review, survive **two adversarial code reviewers**, and get a **human nod** — before it is committed and the next one starts.
3. **Review memory.** Feedback from every review is remembered, so the loop gets more autonomous as the migration progresses — the gates are training data for later checkpoints.
4. **Anti-slop thesis.** Gathering context, freezing specs and task files, then implementing one-shot "doesn't work" — even with specs, the first output is wrong and the spec alone cannot save it. The loop, not the prompt, is what prevents unmaintainable output.
5. **Agent-addressable architecture.** Business logic decoupled from UI and runnable headlessly on desktop, exposed to agents through a CLI for inspect/navigate/act in **milliseconds instead of minutes**, with simulators driven by commands rather than the accessibility tree. "It doesn't matter how good the model is if it can't test its work quickly." The architecture is designed for humans **and** agents, as a product decision, not tooling bolted on.

Mechanisms 1–3 are a process. Mechanism 5 is a property of the software being built. CodeCartographer has partial analogues of both, but they are not joined up: the analysis side produces a porting-oriented spec and stops; the synthesis side produces a plan and stops.

## 2. What CodeCartographer already has (at 0.26.0)

| Helix mechanism | Nearest existing thing | Where it lives |
|---|---|---|
| Checkpoint plan | `## Implementation Sequence` + Scope Tiers in the spec template; `## Work packages` + `## Implementation sequence` + `### First executable slice` in the plan template | `templates/reimplementation-spec.md:69`, `templates/project-plan.md:7-29` |
| Tests per checkpoint | Acceptance scenarios (spec), acceptance plan (plan) | `templates/reimplementation-spec.md:84`, `templates/project-plan.md:31` |
| Reference match | Evidence levels, `required_reads`, `verify at runtime`, runtime probes, provenance ledger | every SKILL + `templates/project-plan.md:37` |
| Adversarial reviewers | Broad-Side `verify` (`core/broadside/verify.ts`): a separate model with read-only tools, verdicts `confirmed / not-a-defect / discarded / unclear`, and the rule "'confirmed' without a trigger you found in the code is not allowed"; self-assessment (`workflow/VALIDATE.md`); deterministic pairing checks (`core/findings.ts`); coverage-gap ledger injection (`core/prompts.ts:89-99`, `core/coverage.ts`) | `verify` **is** adversarial by construction — but only over Broad-Side leads, only on OpenRouter. Nothing adversarial reads a pipeline artifact. Its verdict vocabulary is the rubric to reuse, not reinvent |
| Human nod | Handoff/validation gate, `--strict` (Pi's auto-runner only; MCP hosts drive themselves), Pi confirm hooks, the `[ ]` → `[x]` confirmation in `proposal.md` — **mechanically enforced** by `preflight: requires-confirmed-proposal` (`core/synthesis.ts` `runPhasePreflight`) before `spec-merge`/`goal-synthesis-finalize` may start; `--auto` stops cleanly at a preflight refusal (`auto-runner.ts`, outcome `stopped`) | phase-granularity, not slice-granularity — but the pattern (a human edits a file, a preflight reads it, `--auto` halts and resumes) is exactly what a per-slice nod needs |
| Review memory | `DECISIONS.md`, `CONVENTIONS.md`, `BACKLOG.md`, closeouts, `open_questions` and `carry_forward` with evidence-bearing closures (`derives_from`, closure evidence — #122 Stage 3, shipped via #186), `--llm-steer` (an LLM rewrite of the next phase's prompt, Pi only), amendments | questions and carry-forwards are remembered with their closures; *reviewer objections* are not a category anywhere |
| Fast feedback | `validatePhaseOutput` (parses the rows the model wrote and the `**Overall:**` line; the only deterministic gate is `crossCheckFindings`, version-gated on `scaffold_version`), `codecarto_broadside verify`, `self-audit/` | validation never compares the table to the YAML's `completion_criteria` — a criterion is prompt text, not a check; phases are self-graded and slow; no cheap regression fixture |
| Agent-addressable architecture | Layer Split already names `core semantics / adapters / delivery surfaces`; porting hazards | never assessed as a property of the analyzed system; never required of the rebuilt one |

Three facts sharpen the picture:

- The spec's `## Implementation Sequence` carries **no completion criterion**: `pipeline-full-with-deep-audit.yaml` has eight criteria for `reimplementation-spec` (modules, behaviors, protocols, acceptance, defect dispositions, evidence levels, coverage, deep-read discipline; the `full` and `full-with-audit` variants have seven) and the sequence is not one of them. The plan side is asymmetric: `goal-synthesis-finalize` already has "The implementation sequence identifies an executable first slice." The ordering advice on the spec side is unvalidated prose today.
- The plan's work packages are closer to Helix checkpoints (dependency-ordered, each with an acceptance gate) but are not decomposed into reviewable slices with proof obligations.
- A completion criterion is **prompt-only**. `validatePhaseOutput` (`core/pipeline.ts:216`) never reads `completion_criteria`; it parses whatever rows the model wrote, the Overall verdict, and runs `crossCheckFindings`. Adding a criterion (P1) changes what the model is asked; making it a gate is separate code (P5), version-gated per the #122 precedent (`findingsPairingGateActive`).

## 3. What does not transfer, and why

- **Simulator/GUI automation and visual diffing.** No UI boundary exists in the framework's scope. The nearest honest analogue is "run the slice's declared proof and attach the observed result" — host-side execution, outside the framework's tool boundary.
- **Commit-per-checkpoint.** Git policy belongs to the project and host. The loop may *require* a slice be committed before the next begins; the framework does not run git in the target repository (it runs `git ls-files` there read-only, and commits only inside a library it owns).
- **Sub-agents everywhere.** MCP never runs sub-agents by design; the only rule it places on a skill is the prose line "Do not modify source files outside .codecarto/" in `buildSkillPrompt`. On Pi there are **two** guards and both block `bash` outright: the orchestrator's hook confines `edit`/`write` to `.codecarto/` plus the configured library, and the phase sub-agent's hook to `.codecarto/` alone (deliberate, 0.26.0 #390). So on Pi nothing in CodeCartographer mode can run a proof command *or* touch the target — a build loop there is a new session kind with its own guard policy, not a config flag on the analysis guard. The repo's existing shape for "the host executes, the framework keeps the record" is the **spike loop**: the spec names spikes, the host runs them outside the framework, reports land in `scratch/spikes/<id>/<scenario>.md` (`templates/spike-report.md`), and `skills/spec-delta-application` triages the deltas back into the spec.
- **A fixed two-platform reference.** Helix's reference is a running app. A generic reference here is: contracts + acceptance scenarios (analysis side), and confirmed, version-pinned library specs + vision sections (forward side). The provenance ledger is already that reference.

## 4. The CodeCarto slant

Shopify's Helix is app-migration machinery. Ours should be built from what is already different about CodeCartographer:

1. **Evidence levels and provenance are the review rubric.** Helix's reviewers check behavior against a running app. Ours check claims against their declared evidence: resolving `file:line` citations on the analysis side, resolving plan decisions to an exact confirmed specification version or vision section on the forward side.
2. **Gates are already a framework primitive.** Phase validation, `preflight:` checks, handoff closure integrity (D1/D3), `--strict`, amendments — the slice gate is a finer instance of the existing pattern, not a new system. The human nod in particular already has its mechanism: a human edits a file, a preflight reads it, `--auto` halts and resumes.
3. **Host-owned execution is a feature.** The slice plan must be usable by any capable host (Claude Code, Codex, opencode, Pi), because the framework returns procedure and artifacts, not agent runs. The spike loop is the precedent.
4. **Slices are the join between the two halves.** A slice is where the analysis-side spec and the forward-side plan meet an executor. Both templates emit the same slice shape so one skill can drive either.

## 5. Proposals

### P1 — The slice plan as a first-class artifact (all three surfaces)

Promote the sequence sections into a table both templates share: `id`, slice, modules, satisfied contract/scenario ids, **proof obligation**, dependency on prior slices, and exit gate (the Helix-shaped review pair + human nod). The unit is a **slice** — the repo's own word (`### First executable slice`); "checkpoint" is already taken by `scratch/checkpoints/<phase>.md`, the phase-compaction continuation checkpoint.

- The proof obligation cannot be a literal command on the spec side: the spec is language-agnostic by rule ("no references to source-language internals"; acceptance scenarios are black-box). On the spec side it is the acceptance-scenario ids the slice must pass and how each is observed; the host turns those into commands at build time. The plan side can carry a command when the target stack is fixed.
- Spec side: `templates/reimplementation-spec.md` (+ `reimplementation-spec-opinionated.md`), `findings/reimplementation-spec/SKILL.md`, and a new completion criterion in the four pipelines that carry the phase (`pipeline.yaml`, `full-with-audit`, `full-with-deep-audit`, `scout-first`) plus a regex line in `tests/pipeline-invariants.test.mjs` (the pattern the deep-read criterion uses). Template rows and pipeline YAML move together; `scaffold-version.yaml` bumps.
- Plan side: `templates/project-plan.md` work packages gain the same shape (they are already dependency-ordered with acceptance gates).
- Drop-in reach: full, because it is template + SKILL prose.

### P2 — Adversarial review on the forward side: a synthesis phase (decided 2026-09-17)

The review Helix runs per checkpoint, applied to CodeCartographer's forward flow. Two postures, in a fresh session that did not write the artifact:

- **Provenance falsifier** — for every load-bearing claim, try to break the mapping to its confirmed library version / vision section. A claim that cannot be traced, or traces to a version other than the confirmed one, is an objection. The mechanical half of this (does the cited `ref@vN` exist among `confirmedSelections`?) is deterministic and belongs in P5; the reviewer's job is the semantic half — does that section actually support the claim?
- **Conflict auditor** — find averaged or hidden incompatibilities between merged specs, and check that the merged spec's `## Conflict ledger` / `## Gaps against the vision` and the plan's `## Conflict and unknowns register` still carry owners or dispositions.
- (Analysis side, optional reuse) **Evidence falsifier** — resolve every `file:line` citation in a findings artifact and try to overturn each evidence tag. This is B8's gap ("LLM grades its own homework") with a falsifying stance rather than B8's own proposal of criterion-by-criterion grading; #186 is closed and not a vehicle.

Which artifact is under review fixes where the phase can sit. Between `spec-merge` and `goal-synthesis-finalize` the reviewable artifacts are `merged-spec.md` and `proposal.md`; `project-plan.md` does not exist yet, because finalize is the last phase. A review *of the plan* is therefore either a terminal phase after finalize or post-pipeline work. And the post-pipeline route has three properties the draft did not account for: skills are refused until the **whole pipeline** is complete (`resolvePipelineOutcome` on both surfaces: "Cannot run skill: pipeline is not complete"); on Pi a skill runs in the **orchestrator's own session** (`pi.sendUserMessage`), not a fresh sub-agent, so it is not context-isolated from whatever wrote the artifact; and "post-pipeline lifecycle state is not yet framework-managed" — a skill has no state to gate on. Only a phase gets isolation (Pi spawns a fresh `AgentSession` per phase), a `preflight:` hook, validation, a handoff, and `--auto` participation.

**Decided shape** (the details are proposals for the reviewers; the placement is not):

- A new phase, proposed id `spec-merge-review`, `depends_on: [spec-merge]`; `goal-synthesis-finalize` depends on it and reads its output. It reviews `merged-spec.md` and `proposal.md` against the vision and the *confirmed* library versions (`preflight: requires-confirmed-proposal` gives it the exact `ref@vN` list, so it reads the same specs finalize will).
- Primary output `findings/spec-merge-review/review.md` from a new `templates/merge-review.md`: `## Provenance objections` and `## Conflict objections`, one row per objection — id, target (merged-spec section or proposal row), the objection, severity `blocking` / `advisory`, evidence (the confirmed version and section actually read), and an acceptance box. Verdict discipline is `verify`'s: an objection without a cited section is not allowed. Reviewers write only their own artifact (§6).
- Finalize consumes it: a new finalize criterion — every `blocking` objection has a disposition in the plan's `## Conflict and unknowns register` (resolved with rationale, or carried as an open question with an owner). P5 later makes the id-containment half of that deterministic.
- The human nod reuses the proposal's mechanism: a `[ ]` box per blocking objection, and a preflight on finalize (`requires-reviewed-merge`) that refuses while any blocking box is unchecked. `--auto` stops there the way it stops at the proposal today. Whether a second nod is worth its friction is a reviewer question (§7).
- **The one ABI-sensitive move:** `normalizeStatus` adds any phase in the pipeline file that `status.yaml` lacks as `pending`, so inserting the phase into the shipped `pipeline-synthesis.yaml` would make a completed synthesis workspace incomplete on its next scaffold refresh. Ship it as a new variant (`pipeline-synthesis-reviewed.yaml`, the analysis side's pattern) and move the default alias in a later release with a CHANGELOG note. New SKILL directory and template also join the init/refresh manifest (`tests/init-template-manifest.test.mjs`).
- Isolation is real on Pi (sub-agent). On MCP the prompt says to run the phase in a session that did not write the merged spec; the host owns that. Drop-in: prose.

### P3 — Agent-addressability as an analysis dimension and a spec requirement (all three surfaces)

- Analysis: add an "Agent addressability" item to `templates/architecture-map.md` under `## Public Surfaces` (its comment already enumerates binaries/CLI, exported libraries, network interfaces — the headless seam is a public surface) and to `templates/reverse-engineering-bundle.md` under Portability Hazards — can core semantics run headlessly? is state inspectable and actionable without a GUI? is there a CLI or programmatic seam? Evidence-tagged like everything else.
- Forward: the spec requires it — at least one delivery surface is headless/CLI, core semantics are exercisable without the UI, and at least one acceptance scenario runs headlessly. The Layer Split section already anticipates this; it just never asserts it.
- Cheap scout support: extend the Broad-Side `architecture` and `porting` lens prompts (`core/broadside/lenses.ts`; six lenses ship) with the two probes, not a seventh lens.

### P4 — Review memory / the autonomy ratchet (prompt side all surfaces; injection Pi+MCP)

A durable `scratch/review-memory.md` (or equivalent) recording recurring objections and their resolutions, written by P2 sessions. Distilled rules are injected into later seeds the way coverage gaps are today (`core/prompts.ts`), and stable rules graduate to `CONVENTIONS.md`. This is the "loop gets more autonomous" mechanism made explicit; `--llm-steer` is the per-run precursor, not the durable form.

### P5 — Fast feedback for the framework itself (core; Pi+MCP)

- **Deterministic pre-flight** before self-grading: citation resolution, section presence, evidence-tag coverage, slice-plan shape (every slice names a scenario; every minimum-viable scenario is owned by a slice), plan provenance completeness (every cited `ref@vN` is a confirmed selection), review-objection containment (every blocking objection id appears in the plan's register). Warn-first; version-gate anything that gates, per the #122 precedent. This is `docs/ROADMAP.md` §Validation hardening and B5, now with Helix's "test in milliseconds" as the rationale.
- **Golden fixtures**: a pinned mini-repo with known-answer lite-pipeline outputs so prompt/scaffold changes can be reviewed without an expensive `self-audit/` run.

### P6 — Traverse: the host-executed slice loop (largest scope; only after P1–P3 land; needs an explicit go-ahead)

Decided 2026-09-17: **host-executed, framework-tracked.** The slice plan is the handoff point. Traverse is a procedure and a record format, modeled on the spike loop, and no guard changes on any surface.

- `skills/traverse/SKILL.md` (post-pipeline: a slice plan exists only once the pipeline that writes it is complete) and `templates/traverse-record.md`; one record per slice at `scratch/traverse/<slice-id>.md` holding what was run and what was observed for each scenario the slice proves, the review pair's objections (P2's postures applied to the slice's change against the spec or plan — this is where Helix's *code* reviewers land), the human's acceptance box, and the outcome. A slice's record must be accepted before the next slice's record is opened; what the build teaches the spec goes back through `spec-delta-application`.
- The framework's part: the plan (P1), the record format, deterministic checks over the records (P5: every slice has a record, every record has proof + review + nod before its successor exists), and the memory (P4). Not the framework's part: running commands, editing the target, committing.
- On Pi the loop is followed outside CodeCartographer mode — both Pi guards block `bash` — or by an MCP host; the Pi surface's contribution is showing the records (dashboard) later. A config-gated Pi "build session" kind is explicitly *not* in scope; if the host-executed loop proves itself on a real project, that becomes its own plan.

## 6. Invariants any of this must respect

- Three surfaces stay byte-identical on prompts and validation (`tests/pipeline-invariants.test.mjs`).
- Template + pipeline YAML + `scaffold-version.yaml` move together whenever a criterion is added; no gating heuristic may wedge `--auto`.
- `.codecarto/` paths and pipeline schema are ABI; additions are optional and additive.
- Reviewers write only their own artifacts; they never edit `status.yaml`, `THREAD_LOG.md`, or `closeouts/`.
- Nothing downstream may cite a Broad-Side artifact as evidence; the same rule applies to reviewer verdicts.
- The framework never runs commands in, edits, or commits the target repository, on any surface. Traverse does not change this.
- A shipped pipeline file's phase list is workspace state: new phases arrive as new variants, not as edits to a file existing workspaces already run.

## 7. Decisions (2026-09-17) and what stays open

Taken by the maintainer after the code was read (the *what the code says* notes under each are the evidence, kept for the reviewers):

1. **Adversarial review placement — a synthesis phase between `spec-merge` and `goal-synthesis-finalize`**, reviewing the merged spec and proposal; finalize consumes the objections. Not a post-pipeline skill: a skill cannot gate anything (whole-pipeline-complete gate, no framework state) and is not isolated on Pi. A review *of the plan itself* would have to come after finalize; the plan's provenance gets deterministic checks in P5 instead, and a post-pipeline plan-review skill can follow later at no ABI cost. The proposal's confirmation gate is a preflight; the review gate is the same mechanism, not a replacement.
2. **Execution — host-executed, framework-tracked.** The slice plan is the handoff; Traverse (P6) is a procedure and a record format modeled on the spike loop. The framework names the work, the host runs it outside the framework, the result comes back as an artifact the framework consumes.
3. **Write guard — unchanged, on every surface.** Both Pi guards block `bash` as well as target writes, so "relaxing the write guard" understated the question: executing on Pi would be a new session kind that runs commands and edits the user's repository, which the framework has never done anywhere. Not now; a separate plan if the host-executed loop earns it.
4. **Reviewer count — open, on purpose.** One fresh session carrying both postures (one phase id; independence from the *author*, which is the first-order win; cheaper) versus two parallel phases with the same `depends_on` (the `contracts` ∥ `protocols` pattern; genuinely independent objection sets; two phase ids become ABI; a second short phase per review). The DAG supports either without new machinery. What would settle it: run both on the same merged spec and count distinct objections that survive the human's reading, against the cost difference.
5. **Name — Traverse.** A surveying traverse is a chain of stations, each fixed from the last before the next is measured. The unit is a *slice*; "checkpoint" is taken in-repo.

### For the reviewers

This document goes to several agents and models before anything is built. Things worth attacking rather than admiring:

- The ABI argument in §9 (additive sections, criteria, columns; no path, id, or schema change; older scaffolds keep validating because no gate reads the new rows). Find the workspace it breaks.
- Whether the slice plan's proof obligation on the spec side — scenario ids, not commands — is strong enough to stop a model from writing slices that prove nothing, given that validation is self-graded until P5.
- Whether a second human nod (per blocking objection, before finalize) is friction the forward flow can bear, or whether the proposal's nod plus a visible objection list is enough.
- Question 4 above.
- Whether the "headless surface or a recorded reason there cannot be one" criterion (§9, P3) is the right strength for a spec that may describe a firmware or GUI-only port.
- Anything in §2 that still misreads the code. Every claim there names a file; check it.

## 8. Sources and prior art in-repo

- `docs/plans/2026-08-21-issue-122-unverifiable-claims.md` — the evidence/action and closure-integrity work; Stages 1–2 shipped in v0.17.1 and Stage 3 (D1 `derives_from`, D3 closure evidence) closed as #186 on 2026-09-08. Its version-gating of a new mechanical check (`findingsPairingGateActive`) is the precedent P5 follows.
- `docs/history/framework-backlog-2026-05-02.md` — B5 (programmatic validator), B8 (semantic/quality review), B14 (cross-phase consistency).
- `docs/ROADMAP.md` §Validation hardening; root `ROADMAP.md` Tier 4 (sync-priced verification pass, since shipped as `codecarto_broadside verify`).
- `docs/synthesis-roadmap.md`, `docs/design-synthesis-phases.md` — forward-flow design. M4 (`pipeline-spec-mutate.yaml`) is still unshipped there; the shipped post-pipeline skill is `skills/spec-delta-application`, and `preflight:` is the "structural defense" M3 asked for.
- The spike loop — `templates/spike-report.md`, `scratch/spikes/<id>/<scenario>.md`, `skills/spec-delta-application` — the only place today where work is executed outside the framework and its result is absorbed back as an artifact.
- `core/broadside/verify.ts` — the verdict prompt and vocabulary (`confirmed` needs a trigger found in the code; `not-a-defect` for literally-true-but-unreachable; `discarded`; `unclear`), the closest thing in the repo to a Helix reviewer.

## 9. First slice — the slice plan and agent addressability (P1 + P3)

All three surfaces; template, SKILL, pipeline-criteria, and test changes only; no code path changes; no new files. Proposed as two PRs (`framework: …`) released together as a minor version, because users see new prompts.

### P1 — the slice plan

- `templates/reimplementation-spec.md` and `templates/reimplementation-spec-opinionated.md`: `## Implementation Sequence` gains a **slice plan** table — `Slice | Delivers | Modules | Proves (scenario #s) | Depends on | Tier` — under a fixed gate sentence: *a slice is complete when every scenario it proves is observed passing, review has no open blocking objection, and a human has accepted it; the next slice does not start before that.* Scope Tiers stay and each tier names the slice it ends at. A new validation row.
- `findings/reimplementation-spec/SKILL.md`: how to cut slices — the first slice is the smallest end-to-end path through the minimum viable port; a slice is one module or one behaviour cluster, reviewable in minutes; every slice names at least one acceptance scenario; every minimum-viable-tier scenario is owned by some slice; order follows dependencies.
- The four pipelines carrying the phase (`pipeline.yaml`, `pipeline-full-with-audit.yaml`, `pipeline-full-with-deep-audit.yaml`, `pipeline-scout-first.yaml`): completion criterion *"The implementation sequence is a dependency-ordered slice plan in which every slice names the acceptance scenarios that prove it."*
- `templates/project-plan.md`: `## Work packages` gains `Proves (acceptance plan #s)`; the same gate sentence above `## Implementation sequence`, whose `Exit evidence` column already carries the per-slice proof. `findings/goal-synthesis-finalize/SKILL.md`: every work package names the acceptance-plan rows that prove it, and a proof command when the target stack is fixed. `pipeline-synthesis.yaml`: criterion *"Every work package names the acceptance-plan scenarios that prove it."* plus the validation row. (Adding a criterion to the shipped synthesis file is safe — criteria are prompt text; the phase list is what §6 protects.)
- `tests/pipeline-invariants.test.mjs`: the deep-read pattern — assert the criterion exists in every pipeline carrying the phase, and that the templates' validation tables carry the row.

### P3 — agent addressability

- `templates/architecture-map.md`, under `## Public Surfaces`: `### Agent addressability` with the three probes as the template's usual comment — can core semantics run headlessly? is state inspectable and actionable without a GUI? is there a CLI or programmatic seam an agent could drive? — each answer evidence-tagged. `findings/architecture/SKILL.md`'s "Identify public surfaces early" list gains the headless seam. The six pipelines carrying `architecture`: criterion *"Agent addressability — whether core semantics run headlessly and are inspectable and actionable without the UI — is assessed with evidence."* plus the validation row.
- `templates/reverse-engineering-bundle.md`, `## Portability Hazards`: the comment names *no headless seam* as a hazard to record; one sentence in `findings/porting/SKILL.md`. No new porting criterion.
- `templates/reimplementation-spec.md` (+ opinionated), `## Layer Split` and `## Acceptance Scenarios`: the delivery-surfaces row must include a headless surface through which core semantics are exercisable without a UI, and at least one scenario runs through it. Spec criterion (the four pipelines): *"At least one delivery surface is headless and exercises core semantics without a UI, and at least one acceptance scenario runs through it — or the spec records why this port cannot have one."*
- Broad-Side lens probes (`core/broadside/lenses.ts`) are **not** in this slice: they are core code and the lens result schemas would need an optional field. Second slice.

### Why it is ABI-safe

No `.codecarto/` path, phase id, or pipeline-schema field changes. Sections, table columns, criteria, and validation rows are additive; nothing mechanical reads them (`validatePhaseOutput` parses whatever rows the model wrote). `scaffold_version` bumps with the templates and pipeline files, `refreshScaffold` brings existing workspaces forward, and a workspace that stays on the old scaffold keeps validating exactly as before. Completed phases are not re-validated.

### Verification before release

1. `npm run build` + `npm test` (invariants, byte-identical prompts across surfaces, manifest).
2. A real spec phase: re-run `reimplementation-spec` on a copy of the 2026-09-15 self-audit workspace (porting is complete there) with the new scaffold, through Pi with an explicitly selected, authorized model — CodeCartographer's own slice plan; check every slice names scenario ids, every minimum-viable scenario is owned, and the new rows are graded honestly rather than PASSed by reflex.
3. A real architecture phase: `architecture-only` on the `notesd` fixture (or this repository) — `### Agent addressability` filled with evidence tags.
4. The usual release verification (MCP smoke and round trip, one Pi phase, Codex round trip).

### What this slice does not do

No adversarial review (P2), no memory (P4), no deterministic checks (P5), no Traverse (P6). It gives every later piece the artifact it operates on, and it is the first thing the reviewers can judge against real output.
