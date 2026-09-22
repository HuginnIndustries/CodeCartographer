# CodeCartographer — product roadmap

This is the **product-level roadmap**. Start implementation sessions at [Engineering evolution — start here](engineering/README.md). The root [Broad-Side roadmap](../ROADMAP.md) remains its subsystem tracker; the [synthesis roadmap](synthesis-roadmap.md) preserves implementation history. GitHub issues carry live task status, not this document's prose.

## Shipped baseline

At the v0.26.0 planning baseline, CodeCartographer provides selectable repository-analysis pipelines, phase artifacts/handoffs and validation, Pi/MCP delivery surfaces, a versioned spec library, reference-backed forward synthesis, and Broad-Side scouting/verification. See [README](../README.md), [CHANGELOG](../CHANGELOG.md), and [client surface requirements](client-surfaces.md) for current released behavior.

It does **not** yet provide the engineering lifecycle described below. The [dogfood trial](engineering/dogfood-2026-09-17.md) exercised current handlers and selected existing tests, not a completed Traverse loop.

## Product direction

Help an agent make a specific, verifiable change to a repository, keep its evidence valid as work evolves, and improve reusable project knowledge afterward.

Three entry paths share engineering primitives without identical prerequisites:

- Understand a system with selectable analysis depth.
- Change an existing system using repository-local evidence and **zero or more** external references.
- Build from a vision and deliberately selected reusable specifications.

Preserve existing synthesis confirmation gates. An ordinary feature/bug request is a separate path, not a reason to force library publication or a full reimplementation spec.

## Staged outcomes

| Stage | User-visible outcome | Evidence required to claim it | Status |
|---|---|---|---|
| Foundation | Existing specs/plans expose useful slice/scenario links and verification seams | Real phase output plus invariant/compatibility tests, not only template edits | E09 delivered (slice tables, ids, lifter, compatibility test against shipped self-audit specs); E10 delivered (Agent Addressability table with evidence levels in architecture and porting, Verification route per slice lifted in E01 `check_kind` vocabulary, `none` refused as a gap; hand-filled dogfood against this repo); E11 next |
| Engineering contracts | Changes, attempts, snapshots, proof, review, and human authority have one usable contract | Executable schemas and reviewed authority design; no generic agent approval flag | Planned: E01 |
| First local loop | A host can plan, implement, verify, review, and present a bounded change without a library | Real fix and feature; failed attempt/resume, stale-proof refusal, actual acceptance, second-change history | Planned: E02–E08, E11 |
| Reuse and refreshed knowledge | A proven capability transfers to a second repository without confusing design with current facts | Explicit source/version, applicability, conflict disposition, safe publication, and new project proof | Later design gate |
| Integrated host/team experience | Supported hosts present one coherent workflow; teams can hand off safely | Capability-specific end-to-end runs and permission boundaries; no silent Pi guard relaxation | Later design gate |
| Delivery lifecycle | PR/CI/release/rollout records connect to accepted changes | Separate authorization and exact-revision evidence at each external boundary | Later design gate |

[Implementation tasks and dependency graph](engineering/implementation-plan.md#task-index) define the first buildout. A stage is not complete merely because its schemas exist, CI passes, or a document says PASS.

## First buildout principles

- Host-executed, framework-tracked. No arbitrary target command execution added to MCP.
- Supervised first. A host without a trusted human-acceptance path stops honestly.
- Basic identity/freshness before accepted execution, not after an autonomous loop has shipped.
- Local change package is the initial delivery boundary. A plan does not authorize push, merge, release, deployment, or provider spend.
- Small main-targeted PRs, additive experimental surfaces, and opt-in variants. No long-lived `dev` fork or wholesale rewrite is required.
- Separate current facts, intended changes, proposed designs, and verified outcomes. Publish useful knowledge deliberately, not every execution log.
- Keep old workspace ABI and analysis guards. New phase lists arrive as new variants, not changes that reopen completed workspaces.

## Parallel and deferred workstreams

### Reviewed reference synthesis

Retain the [Helix/Traverse design history](plans/2026-09-17-helix-patterns.md): a new reviewed synthesis variant can place provenance/conflict review between spec merge and plan finalization. It is not a dependency of ordinary zero-library changes. Its exact objection-disposition/approval and revision-binding design must be reviewed before implementation; a recorded owner or checked box is not itself resolution.

### Validation and recovery

New engineering gates must distinguish claims, structural validation, observed results, review, and acceptance. Existing analysis validation hardening remains useful but is separate, backward-compatible work: section/criterion checks, source citation checks, output-path checks, and conservative invalidation. Do not retrospectively label legacy completed phases invalid without a versioned migration policy.

Retain the earlier backlog for phase concurrency, interrupted-completion reconciliation, cascade invalidation, scoped/incremental analysis, and optional structured findings. Implement only when an issue has a bounded contract and observed need; do not combine those projects with engineering state storage.

### Library and knowledge

Library schema stabilization, original-analysis-versus-import provenance, descriptive/prescriptive claim status, dashboard library visibility, and mutation/publication workflows remain candidates. The historical `pipeline-spec-mutate.yaml` proposal is not shipped; post-pipeline `spec-delta-application` exists and must not be confused with that proposal. Avoid creating a broad new entry taxonomy before real reuse demonstrates its value.

### Existing compatibility work

The engineering evolution does not absorb these separately tracked issues:

- [#393](https://github.com/HuginnIndustries/CodeCartographer/issues/393): Windows atomic replacement behavior.
- [#394](https://github.com/HuginnIndustries/CodeCartographer/issues/394): Pi write-guard path behavior on Windows.
- [#395](https://github.com/HuginnIndustries/CodeCartographer/issues/395): POSIX-specific test expectations.
- [#185](https://github.com/HuginnIndustries/CodeCartographer/issues/185): MCP SDK/spec upgrade.

Check live issue state before working. Do not interpret this list as a new assignment or as permission to fold compatibility changes into a documentation PR.

### Distribution and launch evidence

Keep release verification and discovery work independent from feature claims. The [launch plan](plans/2026-07-21-v0.12.1-discoverability-launch.md), public self-audits, and synthesis demonstrations are historical/evidence inputs; validate their current status before scheduling promotional work. No release/tag is implied by merging this roadmap.

## How to advance this roadmap

1. Complete and independently review one dependency-ready task.
2. Verify the exact candidate and the relevant real host boundary; label unverified surfaces.
3. Update its GitHub issue with commit/PR, commands, observed results, and remaining limits.
4. Advance an outcome row only when its full acceptance scenario is demonstrated.
5. Write a new bounded design before opening later-stage implementation work. Deferred questions are decisions to revisit, not worker permission to invent architecture.
