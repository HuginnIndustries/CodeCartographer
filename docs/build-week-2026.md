# OpenAI Build Week 2026

CodeCartographer existed before the July 13–21 submission period. This document separates the established project from the meaningful extension built during Build Week so reviewers can evaluate the new work directly.

## Existing foundation

Before Build Week, CodeCartographer already provided phased reverse engineering, validation gates, Pi and MCP surfaces, durable phase state, HTML dashboards, and a versioned library for publishing completed reimplementation specifications.

## Build Week extension

The new forward synthesis workflow closes the loop from understanding software to planning new software:

1. `vision-capture` converts a raw brief into bounded outcomes and black-box acceptance scenarios.
2. `goal-synthesis-propose` ranks library specifications against that vision while leaving every selection unchecked.
3. A core runtime preflight refuses to proceed until a human changes at least one `[ ]` selection to `[x]`.
4. `spec-merge` reads only confirmed specs and creates a normalized intermediate with explicit conflicts, gaps, and per-claim provenance.
5. `goal-synthesis-finalize` produces an implementation-ready plan with work packages, acceptance gates, an unresolved-conflict register, and a decision-level provenance ledger.

The preflight implementation is shared by Pi and MCP. It also verifies that the vision brief is filled in and the configured library exists and contains entries. The same core prompt builder supplies both surfaces, preserving the existing byte-equivalence invariant.

## Why this is not a generic “merge these documents” prompt

- Library candidates are proposed separately from the merge and require explicit human confirmation.
- Only confirmed versioned specs may influence the merge.
- Conflicts remain visible and receive an explicit `adopt`, `adapt`, `defer`, or `reject` disposition.
- Every load-bearing plan decision must cite a confirmed spec version, the product vision, or an explicitly labeled synthesis inference.
- The finalizer uses the merged spec as a compression boundary and deep-reads source specs only for named gaps.

## Reproduce the demo

Requirements: Node.js 20 or newer and Pi for the recommended interactive surface.

```bash
git clone https://github.com/HuginnIndustries/CodeCartographer.git
cd CodeCartographer
npm ci
npm run demo:synthesis
```

The command prints `DEMO_WORKSPACE`. Start Pi in that directory using this checkout's extension:

```bash
cd "$DEMO_WORKSPACE"
pi -e /absolute/path/to/CodeCartographer/extensions/codecarto/index.ts
```

Then run:

```text
/codecarto-open
/codecarto-next --auto
```

The first run intentionally stops at the confirmation gate. Review `.codecarto/findings/goal-synthesis/proposal.md`, check the desired candidates, and resume:

```text
/codecarto-next --auto
```

Inspect `.codecarto/findings/goal-synthesis/project-plan.md`, especially its Provenance ledger and Conflict and unknowns register.

## Codex and GPT-5.6 use

The synthesis runtime, pipeline schema, phase skills, templates, tests, demo fixture, and documentation were designed and implemented collaboratively in Codex with GPT-5.6 during the submission period. Codex was used to inspect the existing architecture and roadmap, narrow the scope against the judging criteria, implement the shared Pi/MCP preflight path, build regression tests, and verify the packaged workflow.

The submission's `/feedback` session ID and dated commit history provide the corresponding build evidence.
