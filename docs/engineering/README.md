# Engineering evolution — start here

**Status:** approved direction for incremental planning; implementation is not shipped by this documentation change. The first delivery target is a locally reviewable, evidence-backed change, not an automatic merge or deployment.

## Read in this order

1. [Product vision and decision register](vision.md): intent, constraints, settled direction, provisional defaults, and deferred decisions.
2. [Sanitized dogfood findings](dogfood-2026-09-17.md): what actually ran, what did not, and why the roadmap changed.
3. [Engineering record contract](record-contract.md): the v1 candidate vocabulary, record schemas, operation API, and proof/approval trust model (E01 — **candidate contract, acceptance pending**; executable in `core/engineering/` with fixtures under `tests/fixtures/engineering/v1/`; its decision record lists what keeps #399 open).
4. [Incremental implementation plan](implementation-plan.md): bounded tasks, prerequisites, paths, tests, and acceptance criteria.
5. [Product roadmap](../ROADMAP.md): outcome-level sequencing and links to other workstreams.

For E11 evaluation, read the [preregistered pilot tasks](pilot-selection.md) and [evaluation rubric](evaluation-rubric.md). These are planning and measurement documents, not permission to execute pilots or start held tasks.

The [Helix/Traverse discussion](../plans/2026-09-17-helix-patterns.md) is retained as design history. Its P1–P6 proposals are not all current implementation instructions; its precedence note identifies the adjustments made after dogfooding.

## A new agent session's handoff

- Read this page, `CONTRIBUTING.md`, and the target issue in full. Use the live CodeCartographer guide when operating an analysis workspace; historical examples do not override it.
- Fetch the repository and inspect the current branch, dirty/untracked files, open PRs, and dependency issues. Issue state is live; this document's status is not a substitute for checking it.
- Choose one **unblocked and authorized** task from the implementation plan. Check the latest maintainer scheduling notes and holds in the issue and tracker; dependency eligibility is not permission to start. Do not execute a dependent issue because its parent merely has a draft PR.
- E01 owns the record/API contract. Its merged code is a candidate until #399 is resolved and closed; E02/E03 do not start before that, and E09 is on explicit maintainer hold. Downstream agents must consume the contract as closed, not independently invent names, schemas, authority rules, or file layouts.
- Preserve analysis pipelines, their state ABI, existing synthesis confirmation gates, and both Pi analysis guards. Use additive experimental surfaces. Do not repurpose `workflow/status.yaml` as engineering state.
- Work in an isolated branch/worktree. Do not overwrite another agent's files or absorb unrelated untracked work. Shared-file changes in `core/index.ts`, MCP registration, and invariant tests must be rebased and reconciled, not duplicated.
- Follow RED → GREEN → review. Record actual commands, return codes, relevant environment identifiers, scope limits, and the exact candidate revision. A model-authored PASS is not execution evidence.
- Stop on missing human authority, unresolvable input changes, unavailable required environments, or security/design ambiguity. Record a blocked outcome and what would unblock it; do not manufacture approval or broaden scope.
- Before handoff, update the issue with changed paths, commit/PR, actual verification, limitations, and the next eligible task. Do not close an umbrella milestone from a single component PR.

## What is and is not authorized

The initial engineering pilot is **supervised**: the human approves scope and acceptance; the host runs tools; CodeCartographer records and checks the workflow. Publishing a PR, merging, releasing, deploying, spending on external providers, or exporting private knowledge each needs its own applicable authority. The planning issues are not blanket authorization for those actions.

A host lacking a trustworthy human-interaction path may prepare a reviewable candidate and report `needs-human-acceptance`; it may not silently downgrade the acceptance requirement. Initial scope does not change the Pi guard or add a provider runtime.

## Status and issue map

The [task index](implementation-plan.md#task-index) is the durable code-to-issue map. The tracking issue linked there owns milestone accounting. These docs distinguish **planned**, **implemented**, **locally verified**, **host verified**, and **released**; never promote one label to another without evidence.

The roadmap does not prescribe a release date or one large `dev` branch. Use small PRs against `main`, opt-in variants, and a prerelease channel only when actual runtime work needs one. No version bump or release is required for this documentation-only handoff.

## Public information boundary

This documentation contains portable design material and a sanitized observation summary only. Raw workstation logs, chat transcripts, temporary paths, absolute home directories, private repository inventories, credentials, account identifiers, and provider configuration are not publication artifacts. Re-run the public-content review on each proposed evidence bundle; a successful test does not make its logs safe to publish.
