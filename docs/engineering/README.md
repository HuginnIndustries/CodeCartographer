# Engineering evolution — start here

**Status:** approved direction for incremental planning; implementation is not shipped by this documentation change. The first delivery target is a locally reviewable, evidence-backed change, not an automatic merge or deployment.

## Read in this order

1. [Product vision and decision register](vision.md): intent, constraints, settled direction, provisional defaults, and deferred decisions.
2. [Sanitized dogfood findings](dogfood-2026-09-17.md): what actually ran, what did not, and why the roadmap changed.
3. [Engineering record contract](record-contract.md): the v1 vocabulary, record schemas, operation API, and proof/approval trust model (E01 — **closed**, merged at `b868fd9`; executable in `core/engineering/` with fixtures under `tests/fixtures/engineering/v1/`; its decision record carries the maintainer's D1–D5 answers and the D1 live-check evidence).
4. [Claude Code 2.1.263 feasibility spike](spike-claude-code-2026-09-18.md): what one concrete host can and cannot provide for the contract's D1–D5, with the live check still required and the smallest pilot configuration proposed (registers nothing).
5. [Incremental implementation plan](implementation-plan.md): bounded tasks, prerequisites, paths, tests, and acceptance criteria.
6. [Product roadmap](../ROADMAP.md): outcome-level sequencing and links to other workstreams.

For E11 evaluation, read the [preregistered pilot tasks](pilot-selection.md) and [evaluation rubric](evaluation-rubric.md). These are planning and measurement documents, not permission to execute pilots or start held tasks.

The first pilot has run: the [B01 report](pilot-b01-2026-09-20.md) records what the preregistered acceptance checks caught that the implementer did not, including a blocking defect found by the mandated independent review in a change whose CI was green. It was executed by a host agent against those checks rather than by a CodeCartographer engine, which does not exist yet — it measures whether the checks are usable and load-bearing, not whether an automated loop can run them.

The [Helix/Traverse discussion](../plans/2026-09-17-helix-patterns.md) is retained as design history. Its P1–P6 proposals are not all current implementation instructions; its precedence note identifies the adjustments made after dogfooding.

## A new agent session's handoff

- Read this page, `CONTRIBUTING.md`, and the target issue in full. Use the live CodeCartographer guide when operating an analysis workspace; historical examples do not override it.
- Fetch the repository and inspect the current branch, dirty/untracked files, open PRs, and dependency issues. Issue state is live; this document's status is not a substitute for checking it.
- Choose one **unblocked and authorized** task from the implementation plan. Check the latest maintainer scheduling notes and holds in the issue and tracker; dependency eligibility is not permission to start. Do not execute a dependent issue because its parent merely has a draft PR.
- E01 owns the record/API contract and is **closed** (`b868fd9`): the maintainer ran the D1 live interactive check on 2026-09-18 and the D1–D5 answers are in the contract's [decision record](record-contract.md#decision-record). **E02 ([#400](https://github.com/HuginnIndustries/CodeCartographer/issues/400)) and E03 ([#401](https://github.com/HuginnIndustries/CodeCartographer/issues/401)) are eligible now**, in parallel; E09 remains on explicit maintainer hold. Downstream agents consume the contract as merged and must not independently invent names, schemas, authority rules, or file layouts.
- **D3 is carried by E12 ([#418](https://github.com/HuginnIndustries/CodeCartographer/issues/418)), not by E02.** Until a host can attest that the storage boundary held continuously since the namespace was initialized, `classifyAcceptance` returns `cooperative` for every acceptance and `VERIFIED_ACCEPTANCE_INTEGRATIONS` stays empty. That is the contract working as designed. Surface the classification; never add a default, fallback, or "trusted" path that makes `verified` reachable without the mechanism.
- Two lessons E01 paid for, binding on every downstream issue: **a trust rule that lives in a helper nothing calls is not a rule** — enforce it where it gates the decision; and **a degradation must lower trust, never raise it** — an optional input that gates a trust decision is a bypass waiting to happen, so a reader that cannot establish a fact reports that it cannot rather than assuming the favourable value.
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
