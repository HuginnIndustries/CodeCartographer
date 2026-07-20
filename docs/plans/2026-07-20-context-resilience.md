# Context Resilience Implementation Plan

> **For Hermes:** Execute this plan with strict RED-GREEN-REFACTOR cycles and independent final review.

**Goal:** Make CodeCartographer’s progressive-distillation model operationally observable and resilient to compaction, while keeping the public website synchronized with the product.

**Architecture:** Keep cross-phase state file-backed. Add Pi-only phase-aware compaction handling and telemetry without changing MCP/drop-in semantics; improve the portable template with checkpoint, coverage, and synthesis-boundary instructions. Add a separate website consistency test that checks the static site against a sibling or CI-checkout of the authoritative CodeCartographer repository.

**Tech Stack:** TypeScript, Node test runner, Pi extension SDK, Markdown/YAML templates, static HTML, GitHub Actions.

---

## Actionable checklist

### Task 1: Website source-boundary consistency tests

**Files:**
- Create: `CodeCartographer-Website/package.json`
- Create: `CodeCartographer-Website/tests/upstream-consistency.test.mjs`
- Create: `CodeCartographer-Website/.github/workflows/ci.yml`
- Modify: `CodeCartographer-Website/index.html`
- Modify: `CodeCartographer-Website/features.html`
- Modify: `CodeCartographer-Website/docs.html`

**Steps:**
- [ ] Write tests that read the authoritative upstream `package.json`, MCP tool registrations, pipeline YAML files, and `.codecarto/GUIDE.md`.
- [ ] Verify the tests fail on the current stale version, MCP tool count/list, and THREAD_LOG wording.
- [ ] Update the site to match upstream v0.10.0 behavior and terminology.
- [ ] Add a compact FAQ covering distillation, compaction, and Pi/MCP/drop-in differences.
- [ ] Run `npm test` and a local HTML/link validation pass.

### Task 2: Compaction telemetry model

**Files:**
- Modify: `tests/usage.test.mjs`
- Modify: `tests/dashboard.test.mjs`
- Modify: `core/usage.ts`
- Modify: `core/dashboard.ts`
- Modify: `extensions/codecarto/agent-state.ts`
- Modify: `extensions/codecarto/agent-runner.ts`
- Modify: `extensions/codecarto/auto-runner.ts`
- Modify: `extensions/codecarto/agent-widget.ts`
- Modify: `extensions/codecarto/agent-summary.ts`
- Modify: `extensions/codecarto/index.ts`

**Steps:**
- [ ] Add failing tests for backward-compatible compaction telemetry normalization and aggregation.
- [ ] Add failing dashboard tests for compaction counts/reasons in run details and timelines.
- [ ] Capture Pi `compaction_start`/`compaction_end` events and retain lifetime counts through the phase.
- [ ] Persist successful/aborted/failed compaction counts and reasons in `.usage.local.yaml`.
- [ ] Surface counts in `/codecarto-usage`, the live widget, phase summary, and dashboard.
- [ ] Run focused tests, then the full test suite and build.

### Task 3: Phase-aware compaction and durable checkpoints

**Files:**
- Create: `extensions/codecarto/phase-compaction.ts`
- Create: `tests/phase-compaction.test.mjs`
- Create: `.codecarto/templates/phase-checkpoint.md`
- Modify: `extensions/codecarto/index.ts`
- Modify: `core/prompts.ts`
- Modify: `.codecarto/GUIDE.md`

**Steps:**
- [ ] Add failing tests for phase-session detection, phase-aware compaction instructions, and checkpoint rendering.
- [ ] Register Pi compaction hooks only for sessions named `CodeCartographer phase: <id>`.
- [ ] Use Pi’s normal compaction implementation with CodeCartographer-specific summary instructions that preserve phase goal, evidence, files inspected, output progress, unresolved work, and validation gaps.
- [ ] Write each completed compaction summary to `.codecarto/scratch/checkpoints/<phase>.md` atomically.
- [ ] Include an existing checkpoint in the next phase prompt and document manual checkpoint behavior for MCP/drop-in hosts.
- [ ] Keep orchestrator and non-CodeCartographer sessions on the host’s default compaction path.

### Task 4: Explicit coverage accounting

**Files:**
- Modify: `.codecarto/GUIDE.md`
- Modify: `core/prompts.ts`
- Modify: relevant `.codecarto/templates/*.md`
- Modify: relevant `.codecarto/workflow/pipeline*.yaml`
- Modify: `tests/pipeline-invariants.test.mjs`

**Steps:**
- [ ] Add a failing invariant requiring every primary output template and phase completion criteria to include coverage-and-limits accounting.
- [ ] Add a standard `Coverage and limits` section covering inspected scope, skipped scope, evidence basis, and blind spots.
- [ ] Require `PARTIAL` plus open-question/carry-forward routing when a material scope gap remains.
- [ ] Verify every pipeline variant stays internally consistent.

### Task 5: Stronger porting-bundle compression boundary

**Files:**
- Modify: `.codecarto/findings/porting/SKILL.md`
- Modify: `.codecarto/findings/reimplementation-spec/SKILL.md`
- Modify: `.codecarto/templates/reverse-engineering-bundle.md`
- Modify: `.codecarto/templates/reimplementation-spec.md`
- Modify: `.codecarto/workflow/pipeline.yaml`
- Modify: `.codecarto/workflow/pipeline-full-with-audit.yaml`
- Modify: `.codecarto/workflow/pipeline-full-with-deep-audit.yaml`
- Modify: `tests/pipeline-invariants.test.mjs`

**Steps:**
- [ ] Add a failing invariant that terminal reimplementation phases require the porting bundle as their default synthesis input and do not require every lower-level artifact.
- [ ] Make the porting bundle carry a concise source index, defect dispositions, coverage gaps, and targeted deep-read pointers.
- [ ] Tell reimplementation sessions to start from the porting bundle and open lower-level findings only when resolving a cited gap or ambiguity.
- [ ] Preserve defect-design-around validation without loading all defect prose by default.

### Task 6: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md` if project conventions require an unreleased entry
- Modify: `CodeCartographer-Website/README.md`

**Steps:**
- [ ] Document automatic Pi behavior versus host-controlled MCP/drop-in behavior.
- [ ] Document checkpoints, coverage accounting, telemetry, and the porting compression boundary.
- [ ] Run CodeCartographer `npm test`, `npm run build`, and `npm run smoke` when available.
- [ ] Run website tests, HTML parsing, local-link checks, browser console checks, and responsive visual review.
- [ ] Request independent review of both diffs and fix all blocking findings.
- [ ] Commit scoped changes, push branches, open PRs, monitor CI, and merge only when green.
