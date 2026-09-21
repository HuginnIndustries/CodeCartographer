# Engineering pilot evaluation rubric

**Status:** preregistered evaluation protocol; no pilot results are claimed here. Use with [pilot selection](pilot-selection.md) and [E11](https://github.com/HuginnIndustries/CodeCartographer/issues/409). E01 owns runtime schemas, state transitions, and human-approval authority. This rubric measures their behavior; it does not redefine them.

## Evaluation question

Can the engineering workflow produce and preserve a bounded, reviewable change with meaningful proof, honest authority, interruption recovery, and a durable handoff—without excessive administration or a mandatory reference library?

The initial pilots are known-answer and supplied-requirement tasks. They can demonstrate workflow feasibility and reveal failures. They cannot establish broad coding ability, autonomous diagnosis, superiority over another agent, or a productivity improvement by themselves.

## Freeze before the evaluated implementation

Record these in an evaluator-owned brief using the available runtime contract, not a new competing schema:

- Target repository and exact source revision; engine commit/package identity separately.
- Task ID and version of the selected brief, preserved behavior, non-goals, allowed paths/scope, and acceptance-check IDs.
- Host/runtime/tool versions, selected model configuration where available, dependency/lockfile identity, test environment, and permitted external services. Use safe descriptors, not keys or raw environment dumps.
- Empty workflow reference library; any separate application test-data library identified distinctly.
- Authorized user interaction and the host's acceptance mechanism; explicit scope, spend, time, and retry bounds. These bounds require actual approval; this document does not choose a paid provider or grant spend.
- Evaluator/reviewer roles, prior exposure to the task or solution, available test expectations, interruption point, mutation/negative-control sequence, and how unavailable measurements will be reported.

A requirement change during the run creates a versioned amendment and may invalidate prior evidence. Preserve the original intent, results, and reason for change. Never revise the rubric after seeing results merely to turn failure into success.

## Hard gates and evaluated observations

“Pass” in this table is an evaluator conclusion with evidence, not permission for a generic agent to accept its own work. Use **pass**, **fail**, **blocked**, or **not evaluated**, and keep infrastructure blockers separate from observed behavioral failures.

| ID | Gate | Evidence required |
|---|---|---|
| R01 | Correct requested behavior | Every applicable B01/F01 acceptance check has observed results against its intended input and candidate; tests demonstrably exercise the requirement. |
| R02 | Preserved behavior and scope | Applicable regressions pass, the full diff is reviewed, and any out-of-scope edit is removed or explicitly re-approved. Do not claim absence of every possible bug. |
| R03 | Identity and provenance | Baseline, input/plan, implementation including dirty/relevant untracked state, environment, proof, and review bindings are available and consistent. Engine identity is distinct from target identity. |
| R04 | Evidence is more than a verdict | Actual checks have outcomes and collector provenance. Missing logs/results, prose PASS, truncated captures, or mocked transport are not promoted into observed real execution. |
| R05 | Independent implementation review | A context that did not author the candidate checks requirements, preserved behavior, test relevance, and concrete failure modes. Record the claimed separation and its limits; multiple model names alone do not prove independence. |
| R06 | Honest acceptance | The actual human sees the specific candidate/proof/review summary and accepts through the E01-approved host path. A synthetic receipt can test a parser but cannot satisfy this real-run gate. |
| R07 | Resume and side-effect discipline | A fresh session resumes the deliberately interrupted attempt from durable artifacts and knows its next bounded action; it does not repeat an external action merely because an acknowledgement was lost. |
| R08 | Missing/wrong/stale proof refusal | Negative cases below are rejected at the correct boundary, with distinguishable reasons, without silently changing accepted history. |
| R09 | Second-change continuity | F01 starts after accepted B01, records its derived baseline, and leaves B01's attempts, evidence, and decision history intact. |
| R10 | Publication boundary | Local raw data remains local; a deliberately sanitized report has no secrets, home paths, private inventory, or session URLs. Relevant redaction limits are explicit. No merge/release/deployment authority is inferred. |
| R11 | Class sweep on review findings | For each defect a review reports, the response names the **class** the defect belongs to, enumerates the other instances of that class in the **swept surface** (defined below), and for each instance either closes it or records why it is out of scope. An unanswered class is a blocking finding, not a follow-up. |

All applicable hard gates must pass before claiming the full E11 outcome. A blocked or untested gate means partial verification, not a passing milestone. Hard gates apply to the **final legitimate acceptance path**: deliberately rejected negative-control attempts are successful safety observations, not contradictions. Preserve genuine unsuccessful attempts separately; never delete them to improve the reported success rate.

### R11 in practice

R11 exists because three consecutive review rounds produced the same pattern: the fix closed the reported instance, CI went green, the author believed the work complete, and a defect of the same kind remained one identifier away.

| Round | Reviewer found | Fix closed | Same class still open |
|---|---|---|---|
| E03 first review | `repository` digested without validation | `repository` shape-checked | `executable` still coerced to `false` |
| E03 second review | `executable` coerced | non-booleans refused | — (swept) |
| B01 pilot review | `GIT_CONFIG_COUNT` not neutralized | `COUNT=0` added | `GIT_CONFIG_PARAMETERS` still live |

In the third case the original failure reproduced byte-for-byte on a branch whose author had just declared it fixed. The sweep each time was cheap — enumerate a surface the implementer already had open:

- *"`repository` reaches the digest unvalidated"* → class: **inputs that reach the digest without a shape check** → sweep `entries`, `excluded`, `uncovered_relevant_inputs`, `repository` → finds `executable` in the first round.
- *"`GIT_CONFIG_COUNT` is not neutralized"* → class: **environment-reachable git configuration sources** → enumerate all four → finds `GIT_CONFIG_PARAMETERS` before review.

R11 is **not** a mandate to widen every fix. A change that grows without bound is its own defect: the B01 pilot deliberately left `GIT_TEMPLATE_DIR` out of scope and filed it instead, which satisfies R11. What R11 forbids is leaving the question *unasked* — an implementer who never named the class cannot claim the remaining instances are out of scope, because they never looked.

**The swept surface**, since a blocking gate cannot rest on an undefined phrase: the **file or module the defect was found in, plus every call site of the function that carried it**. Not the whole repository, and not only the changed hunk. The surface is a property of where the defect lives, not of how large the diff happened to be — a one-line fix in a widely used validator sweeps every caller; a large diff confined to one module sweeps that module.

Stated that way, the earlier examples resolve unambiguously: *"`repository` reaches the digest unvalidated"* sweeps `snapshots.ts`, giving `entries`, `excluded`, `uncovered_relevant_inputs`, `repository` — and finds `executable`. *"`GIT_CONFIG_COUNT` is not neutralized"* sweeps the isolation helper, whose subject is git's environment-reachable configuration — and finds `GIT_CONFIG_PARAMETERS`. Neither reading requires auditing unrelated code.

An evaluator who believes the honest surface is wider than this definition records that as a finding with its reasoning rather than silently applying a broader standard. **A vague gate is worse than a narrow one here**: because R11 makes an unanswered class *blocking*, ambiguity pushes implementers toward the narrowest defensible class to avoid a merge block — precisely the behaviour R11 exists to stop.

**Where the sweep is recorded.** `ReviewObjection.class_sweep` hangs the answer off the objection that prompted it, which is the common case but not the only one. Two shapes it does not fit, both resolved the same way — record the sweep on the objection that *named* the class, and reference it from the others:

- **A class spanning several objections.** The E03 example is exactly this: two objections, one class. One sweep, named once; the sibling objections cite it rather than repeating it.
- **A review with no objections.** R11 says "for each defect a review reports", so a clean review has nothing to sweep and passes vacuously — correctly. A reviewer who *did* sweep a class and found nothing has no objection to attach it to; that belongs in the review `summary` until a record-level `class_sweeps[]` exists. This is a known limitation of the current shape, not an oversight.

## Required negative controls

Keep these in isolated attempts or controlled copies so the legitimate candidate and history remain available. The evaluator defines the mutation and expected refusal before implementation.

| Case | Mutation or interruption | Expected observable behavior |
|---|---|---|
| N01 Missing proof | Withhold one required proof record | Acceptance refused with the missing obligation identified |
| N02 Wrong candidate | Supply proof bound to a different snapshot/attempt | Refused as mismatched, not accepted because result says passed |
| N03 Stale input | Change a relevant requirement/plan input after proof | Previous evidence no longer establishes acceptance for the changed input |
| N04 Dirty implementation | Change a relevant working file without moving Git HEAD after proof/review | Changed bytes detected; earlier acceptance cannot apply to the new candidate |
| N05 Open blocker | Leave one concrete blocking review objection unresolved | A named owner or checked box does not resolve it; affected work cannot advance |
| N06 Interrupt/resume | End the host session after a failed or blocked attempt and recorded next action, then start a fresh session | It recovers scope, identities, failure, outstanding decisions, and next bounded action without reconstructing private chat history |
| N07 Unavailable environment | Make a required check environment unavailable through a bounded fixture/control | Mark blocked; do not report a failing test that never ran, or passing proof that does not exist |
| N08 Acceptance unavailable | Use a host path without authorized human interaction | Stop at needs-human-acceptance; no self-confirmation or fabricated receipt |

For N03/N04, collect fresh proof and review after restoring/revising the candidate; do not merely toggle a flag back to current. When N08 is intentionally exercised, return to the supported human path for the real acceptance trial. Record the negative-control outcome and legitimate run separately. If actual human participation is unavailable, the overall human gate remains blocked.

## Measures: report observations before setting numeric targets

| Dimension | Record | Interpretation limit |
|---|---|---|
| Correctness | Acceptance checks satisfied/failed/blocked with IDs; regression results; escaped defects found during evaluation | Test count or coverage percentage alone is not requirement coverage |
| Evidence quality | Unsupported claims, missing/misbound records, stale results detected, and claims corrected before acceptance | A framework rejection does not itself prove semantic correctness |
| Recovery | What the new session needed, actions replayed, information lost, and time to a bounded next action | Record prior context exposure; a warm continuation is not a fresh-session test |
| Review usefulness | Concrete objections, dispositions, fixes, false positives, and independent adjudication where disputed | Do not reward reviewers for finding more issues or claim precision when objections remain unresolved |
| Human effort | Scope decisions, clarifications, substantive corrections, acceptance interactions, and human attention time when available | Count approval clicks separately from substantive interventions; zero interaction is not automatically better |
| Workflow overhead | Setup/context preparation, planning/record administration, execution, review/rework, and waiting | Use a timeline; distinguish elapsed wall time from parallel agent work and human/provider wait |
| Resource use | Tool invocations, tokens/cost if the host reports them, retries, and stop reasons | Unknown is unknown, not zero; separate cached tokens and estimates from billed cost where available |
| Scope discipline | Changed files, unrequested edits, added dependencies, and re-approved scope changes | Small diff is not automatically better; justify necessary breadth |

Do not add overlapping time categories and call the sum elapsed time. Record intervals and overlap explicitly. Separate evaluation-only fault injection/setup effort from ordinary workflow overhead; publish both rather than hiding either.

No numerical performance threshold is invented from the selection probes. The first runs establish observations. Any later target or comparison must be declared before the next evaluated run and preserve earlier results.

## Reviewer packet and evaluation independence

Give the reviewer the task brief, preserved contracts, relevant source context, exact candidate diff, proof outputs, and known limitations. Withhold the implementer's self-congratulatory summary as a substitute for evidence. Require concrete triggers for objections; zero findings is valid.

The evaluator owns the acceptance mapping and negative-control expectations. Changes to those expectations during implementation need a recorded rationale and explicit review. Do not let the implementer weaken assertions until the suite turns green. The public B01 issue already reveals a possible solution; report that exposure rather than describing a successful replay as discovery.

The supervising host may help execute checks, but a report should state where observation or judgment came from. Avoid claims of authenticated reviewer independence or tamper-proof human approval beyond the actual E01/adapter guarantees.

## Optional comparison, not part of the first milestone

After the loop works, a separate study can compare it with a normal capable-agent workflow. Hold target/task versions, model settings, tool access, environment, and evaluation criteria constant; record prior solution exposure and counterbalance order across repeated tasks. Compare results plus human effort and overhead, not just completion time. A single easy task run once per arm does not justify a causal productivity claim.

Do not spend on a comparative study or delay E11 to build a benchmark platform without separate approval. The first output is an honest feasibility report and actionable friction list.

## Report template

Use this outline; keep all unknowns visible:

```markdown
# Engineering pilot report

## Identity and scope
- Task/brief version:
- Target baseline and final candidate:
- Engine version/commit and host:
- Runtime/dependency environment:
- Prior solution exposure:
- Actual scope/authority approvals:

## Outcome
- Completed, partial, or blocked; exact boundary reached:
- Hard gates R01–R10: result, evidence reference, limitations:
- Task acceptance IDs: observed results:

## Attempts and recovery
- Legitimate attempts, failed/blocked outcomes, and changes:
- N01–N08 controls, expected/actual outcome, isolated scope:
- Resume-session context and next action:
- Second-change baseline and preserved first-change history:

## Review and human acceptance
- Reviewer separation/provenance and limitations:
- Objections, dispositions, and remaining blockers:
- Actual bounded human acceptance or why unavailable:

## Effort and overhead
- Timeline, overlapping work, and waits:
- Human decisions/corrections/attention:
- Host-reported resource use; unknown measurements:
- Evaluation-only setup/injection overhead:

## Knowledge and next decision
- Relevant knowledge delta, not automatic library publication:
- Friction and proposed workflow improvements:
- What is not demonstrated:
- Sanitization/publication review:
```

Review the report against the frozen brief before updating E11 or the roadmap. Publish only the sanitized report and intentionally shareable fixtures. Preserve raw local evidence under the project's explicit retention policy; do not make every log a public artifact.
