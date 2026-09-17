# Vision: evidence-driven engineering across the development lifecycle

**Planning baseline:** CodeCartographer v0.26.0. **Status:** future direction, not a claim of shipped engineering capability. See [start here](README.md) for the implementation handoff.

## North star

CodeCartographer helps an agent make a specific, verifiable change to a repository, keeps the evidence valid as the work evolves, and improves the project's reusable knowledge afterward. New-product synthesis and cross-project reuse extend that core rather than serving as prerequisites for it.

A developer can bring their own, organizational, or open-source repository; request a quick architecture map or deeper investigation; then pursue a feature, confirmed defect, refactor, migration, or new build. A host agent implements through a bounded build/test/review loop. The developer can retain project history and deliberately publish reusable knowledge to a versioned library.

The differentiator is continuity from understanding to decisions, implementation, proof, and reuse—not another bundled coding model or a larger collection of prompts.

## Three entry paths, shared engineering machinery

| Intent | Starting evidence | Output and boundary |
|---|---|---|
| Understand this system | Repository source and optional scouting leads | Existing selectable analysis pipelines; no requirement to proceed to engineering |
| Change this system | Repository baseline, requested delta or confirmed defect, local constraints/tests | A bounded change brief and slices; external library references are optional, including zero |
| Build from a vision | Desired outcomes, constraints, optionally selected specifications | A plan for a new system; existing library-backed synthesis remains available with its confirmation gates intact |

Do not solve the second path by weakening the third path's legitimate reference-confirmation requirement. The first engineering increment addresses an existing repository. A vision-only greenfield planner is later work, not silently included in the same issue.

## Goal-directed investigation, not compulsory analysis

Start with desired behavior and behavior to preserve. Establish the baseline and whether the required build/test environment is available. Inspect affected contracts, callers, and tests; deepen analysis when uncertainty blocks the change. Existing findings are inputs with freshness and coverage limits, not unquestionable truth.

A small bug fix may need a reproduction, affected-code read, regression test, and review. A migration may need a broad contract map and equivalence tests. They share obligations, not a mandatory number of documents. Reuse a prior analysis only where its scope and source revision support the claim. Unexamined is not safe; stale is not current.

## The durable units

- **Project knowledge:** revision-scoped statements about a system, decisions, and explicit gaps. Long-lived and reusable across changes.
- **Change:** one requested outcome, baseline, scope, preserved contracts, intended differences, acceptance scenarios, constraints, and unresolved decisions.
- **Slice:** one reviewable behavior cluster with dependencies and an observable proof obligation. Not the existing phase-compaction “checkpoint.”
- **Attempt:** one implementation candidate and its immutable observations, review, and acceptance status. A failed attempt is retained; a retry does not rewrite its evidence.

A project can have multiple changes; the first pilot executes one slice at a time. Multiple simultaneous executors, automated worktree scheduling, and distributed state are not initial requirements.

## Traverse: host execution, framework record and checks

For a selected slice:

1. Confirm scope and baseline; make missing environments or permissions visible.
2. Bind proof obligations to concrete checks for the target stack.
3. Establish failure or baseline behavior as appropriate; implement in the host's approved workspace.
4. Collect observed results against the exact candidate, not just an authored verdict.
5. Review in a context that did not author the change; check desired and preserved behavior, test relevance, concrete failure modes, and security boundaries.
6. Resolve blockers, obtain human acceptance, and advance only while evidence is current.
7. Record knowledge deltas; refresh affected understanding rather than re-analyzing everything.

Repair and learning paths are first-class: failed tests, missing dependencies, revised requirements, oversized slices, interrupted sessions, and stale snapshots cause explicit retry/replan/block transitions. They are not smoothed into success. Scope expansion needs renewed authorization.

The framework does not acquire target-code execution authority. It may perform its existing read-only repository operations and library maintenance. The host still owns source edits, commands, commits, and external side effects. Pi analysis guards stay unchanged. A seamless future execution UX needs a separately designed host integration, not an unnoticed relaxation of analysis mode.

## Evidence and review

Keep these separate: agent claim; deterministic structural check; observed execution result; independent review; authorized human acceptance. No one label `PASS` may erase their different trust levels.

Bind proof and approval to the relevant input and implementation identities, including dirty and relevant untracked content. Start with conservative invalidation; dependency-aware selective revalidation can follow once measured. A digest proves byte identity, not correctness, execution, reviewer independence, or human intent.

Blocking objections need one of: resolved with evidence; an explicitly authorized risk exception permitted by project policy; or a deferred blocker that still blocks its affected slices. An owner name or checkbox alone is not a resolution. The first pilot has no automated risk-waiver path.

Prefer fast programmatic/headless seams. When behavior needs a GUI, hardware, or an external system, require the appropriate observable check or record the blocked environment. Do not manufacture a new CLI merely to satisfy a universal rule.

## Knowledge and library

Project history preserves all useful decisions and attempts locally. Library publication selects reusable knowledge and is a separate action. Do not publish every execution log by default.

Distinguish observed behavior, proposed design, intended change, implemented result, and verification in a named environment. Historical redesign advice must not become a current-source fact through reuse. Preserve original source/version, generation context, analysis time versus import time, applicability constraints, license/attribution information, and confidentiality. A metadata label alone is not authorization to copy or publish proprietary material.

Initially improve the quality of existing spec reuse. New library entry kinds, automatic extraction, review-memory injection, and organization-wide knowledge management are deferred until real repeated use justifies them. Rejected reviewer objections and their rationale are useful knowledge too; repetition alone does not justify a universal rule or expanded autonomy.

## Decision register

| ID | Decision | Status / rationale |
|---|---|---|
| EV-D01 | Keep analysis, in-place changes, and reference-backed new builds distinct at intake | Direction adopted after the cold-start dogfood mismatch |
| EV-D02 | Zero external references is valid for an in-place change | Required for ordinary maintenance; preserve existing synthesis gates |
| EV-D03 | Traverse is host-executed and framework-tracked; no Pi guard relaxation | Settled architectural boundary carried from the Helix discussion |
| EV-D04 | Project/change/slice/attempt identities and basic freshness precede accepted execution | Avoid overwriting history or accepting stale proof |
| EV-D05 | Initial authority is supervised and ends at a locally reviewable change package | Conservative planning default; not permission to merge/release/deploy |
| EV-D06 | Pilot requires an independent author-separated review; optimal reviewer count remains open | Do not make two model calls an unmeasured universal requirement |
| EV-D07 | New engineering state is additive and separate from analysis phase state | Existing paths and pipeline schemas are ABI |
| EV-D08 | Shared semantic rules belong in core; adapters own UI and execution | Retain consistent behavior without promising identical host capabilities |
| EV-D09 | Use JSON for new machine-validated engineering records and Markdown for human briefs/reports | New namespace only; no migration of existing YAML state |
| EV-D10 | Small main-targeted PRs and opt-in experimental surfaces, not one long-lived development fork | Keep released analysis usable throughout staged development |
| EV-D11 | Reference-backed adversarial merge review remains an optional parallel workstream | New synthesis variant; not a prerequisite for an ordinary change |
| EV-D12 | Freeze the security-sensitive record/approval contract in E01 before downstream implementation | This document defines intent; E01 settles exact fields and trusted host interface |

## Decisions still open, with explicit boundaries

| Question | Initial treatment | Revisit when |
|---|---|---|
| How much autonomous advancement? | None beyond the approved supervised pilot policy | Pilot shows useful outcomes and a separate autonomy proposal is reviewed |
| One reviewer or two? Which models? | At least one fresh reviewer; no model/vendor requirement | Compare distinct valid findings and cost on the same candidate |
| Which host gets a richer integrated build UX? | First pilot uses an MCP-capable host; Pi remains read-only in analysis mode | Host-executed loop works on a real change |
| How does a host authenticate and bind human acceptance? | E01 must threat-model it; generic model-written approval flags cannot qualify | Before E06/E07 acceptance implementation; unsupported hosts stop at needs-human-acceptance |
| When do PR/release/deployment integrations ship? | Deferred and separately authorized | Repeatable local change loop and real user demand |
| Which reusable artifact kinds are worth adding? | Preserve current spec library, classify claims explicitly | A second project actually reuses a capability |

## Success and non-goals

The first success is a real bounded fix and feature with relevant proof, independent review, honest acceptance, resume, stale-evidence rejection, and a second change whose history coexists with the first. Measure task overhead, rework, unsupported claims, and recovery as well as completion; tests passing alone is not a productivity comparison.

Not in the initial build: automatic code execution by MCP, bundled LLM providers, generic project management, distributed scheduling, autonomous deployment, automatic private-data publication, cryptographic proof that a model or human behaved honestly, or a mandatory full-repository rewrite plan.
