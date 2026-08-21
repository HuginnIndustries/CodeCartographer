# Issue #122 — unverifiable claims ship as settled findings

**Status:** investigation + proposed plan (not yet implemented)
**Issue:** [#122](https://github.com/HuginnIndustries/CodeCartographer/issues/122)
**Reported against:** v0.16.0, MCP surface, `pipeline-full-with-deep-audit.yaml`
**Reported by:** a GobboNet audit whose two highest-ranked findings were both wrong under runtime test

**Goal:** make a run unable to ship a claim as settled when the run's own record says the
claim is not settlable from source — without wedging `--auto` on a heuristic.

---

## What actually happened

Two contradictions from one run, both from the same habit:

1. `defect-scan-mechanical` registered `q-logit-bias-root-cause` (`kind: needs-runtime-test`)
   whose description ends *"source alone cannot determine which"*, and routed the shape
   hypothesis onward as `mech-CF3`. `defect-scan-semantic` closed `mech-CF3` by asserting one
   of that question's three candidates — `logit_bias` map-vs-array — as `strong inference` /
   `fix before porting`, with a one-line reshape as the fix. Runtime test inverted it: the
   shape the client already sends works, the recommended shape is silently ignored.
2. `defect-scan-mechanical` declared in `Coverage and limits` that *"the encoded search-proxy
   command (launch.bat:1608) was not fully decoded."* `defect-scan-semantic` then asserted an
   `observed fact` about what that exact component does with headers, and called the project's
   privacy claim false. Decoding it showed the claim substantially true.

Both artifacts validated PASS on their own criteria. Nothing in the framework compared the
confident finding against the run's own hedge.

## Root cause: six independent gaps

Each is separately sufficient to let this through; the run hit all six.

### Gap 1 — the pre-porting action vocabulary has no "not settled yet" option

`.codecarto/findings/defect-scan/SKILL.md` §Action Classification gives **maintenance**
pipelines four actions, including `investigate` ("needs runtime testing or deeper analysis to
confirm"). **Pre-porting** pipelines (`full-with-audit`, `full-with-deep-audit`) get three:
`fix before porting`, `port differently`, `leave behind`. All three assert the diagnosis is
settled.

The evidence ladder already admits `open question` ("the code is suspicious but would need
runtime testing to confirm") — but a finding tagged `open question` still has to fill an Action
cell, and every available value overstates. The vocabulary forces the contradiction the issue
reports.

### Gap 2 — the evidence ladder has no rung for a claim about a system outside the source tree

`observed fact` / `strong inference` / `open question` are all degrees of confidence in reading
*the analyzed code*. A claim about how `llama-server` parses a payload is not a weaker reading
of the client — it is a claim about a different artifact, unreachable at any read depth of this
one.

Worse, `strong inference` ("highly likely based on multiple code observations") was *literally
satisfied*: the client source does send a map, and the OpenAI-compatible spec does document an
array. The label was not a misuse of the definition as written. The ladder is under-specified,
not misapplied — which is why re-reading the SKILL would not have caught it.

Pass 5 (`passes/05-api-contract-violations.md`) actively invites this class of claim
("APIs documented to return a specific shape, but error cases return a different shape") and
says nothing about the analyzed code not being the thing that implements the contract.

### Gap 3 — the defect templates have no Open Questions section, so the hedge never reaches the reader

Five templates carry a `## Open Questions` table: `architecture-map.md`,
`behavioral-contracts.md`, `protocols-and-state.md`, `reverse-engineering-bundle.md`,
`closeout-template.md`. The three defect templates — `mechanical-defects.md`,
`semantic-defects.md`, `defect-report.md` — do **not**.

So a defect scan's `needs-runtime-test` question exists only in
`scratch/handoffs/<phase>.yaml` → `workflow/status.yaml`. The report a human reads, and the
report the next phase reads as a required read, carries the finding with no adjacent hedge.
This is mechanically why "the confident label survived; the hedge did not travel with it."

### Gap 4 — nothing verifies a claimed closure

`applyHandoff` (`core/status.ts:321-334`) removes `carry_forward` and `open_questions` entries
by id, unconditionally. Completion never checks that the phase output mentions the closed id,
and never checks whether the closed carry-forward derived from a question that is still open.
`validatePhaseOutput` (`core/pipeline.ts`) reads only the `## Validation` table — never the
findings tables.

So closing `mech-CF3` while `q-logit-bias-root-cause` stays unresolved in `status.yaml` is not
merely undetected; there is no code path that could detect it.

### Gap 5 — a declared coverage gap does not constrain downstream phases

Every primary output must carry `## Coverage and limits` with `Skipped scope`,
`Evidence basis`, and `Known blind spots` (enforced by
`tests/pipeline-invariants.test.mjs:166`). The mechanical phase used it correctly. But that
ledger is carried nowhere: not into the next phase's prompt, not into `status.yaml`, not into
validation.

The existing "Contradiction sweep" duty (`core/prompts.ts:67`) compares the incoming phase's
required reads against completed phases' **`owner_notes`** only. A declared blind spot is not
an owner note, so the sweep as written could not have seen it.

### Gap 6 — quantitative specifics need no citation

Nothing requires a number in a finding (a file size, a default value, a call-site count) to
cite where it was read. The issue's three smaller misses — a 32.8 MB zip recorded as ~300 MB,
a `-5` example where the product default is `-20`, "the call site" where there are two — are
all the same shape: a plausible specific stated in the same register as a read one.

## Why the existing safeguards missed it

- **Re-triage duty** (`core/prompts.ts:19-56`, GUIDE.md §Roles, `references/orchestration.md`):
  it asks whether a `needs-runtime-test` label *has become answerable by reading*. This run
  effectively answered "yes" and closed it by inference. The duty was written for the inverse
  defect — a mislabel that suppressed verification for four phases — and points *toward* this
  failure, not away from it. It has no counterpart: "and when the answer is genuinely no, no
  finding in this phase may assert one of its candidates."
- **Validation**: both reports' `## Validation` tables were honestly filled and did PASS.
  Criterion 5 is "Findings are marked with evidence levels" — satisfied. No criterion reads
  what the levels *say*.
- **Completion**: refuses only `FAIL` and `MISSING`.

## Prior art in the repo

- `docs/plans/post-0.11-evidence-roadmap.md` already carries two unchecked items in this exact
  family: *"Add a targeted open-question closure sweep before porting and terminal synthesis;
  require evidence that source, tests, docs, or platform semantics were checked before labeling
  an item `needs-runtime-test`"* and *"Let the porting bundle identify a deep-read trigger for
  every inherited open question."*
- `docs/ROADMAP.md` §Validation hardening already plans *"automated structural pre-checks
  (section presence, evidence-tag coverage, table completeness)"* — Option C below is that line
  item, aimed at this defect.
- The **spike** machinery is already built and is the correct destination for a
  `needs-runtime-test` item: `post_pipeline` entries with `kind: spike`,
  `templates/spike-report.md`, `skills/spec-delta-application/`, `codecarto_amend`. Nothing
  currently routes a runtime question into it.

---

## Options

Ordered by leverage per unit of risk. Surface reach matters: prompt/template changes land on
all three surfaces, `core/` changes land on Pi + MCP only (CLAUDE.md §Surface priority).

### Option A — add the missing action label, and make it travel

`verify at runtime`: the diagnosis names behavior of a system outside the analyzed source; a
runtime probe must confirm it before any fix is designed.

Rule: a finding whose Evidence Level is `open question` (or Option B's new rung) **must** take
`verify at runtime`. Its destination is the spec's Spike List plus a `post_pipeline`
`kind: spike` entry — not a design change.

The label is worthless if `porting` flattens it back into three. It has to travel the whole
chain:

- `findings/defect-scan/SKILL.md` §Action Classification
- `findings/defect-scan-mechanical/SKILL.md:44` (mirrors the set)
- `templates/reverse-engineering-bundle.md:89` (Defect Synthesis disposition cell) and `:162`
  (validation row 4)
- `templates/mechanical-defects.md`, `semantic-defects.md`, `defect-report.md` (Action column
  comments)
- `findings/porting/SKILL.md:42`, `findings/reimplementation-spec/SKILL.md:72`
- `agent-skill/codecartographer/references/deep-audit-synthesis.md` disposition table
- `workflow/pipeline-full-with-audit.yaml:162`, `pipeline-full-with-deep-audit.yaml:199`
  (completion criteria naming the disposition set)
- `MANUAL.md:178`, `README.md`, `docs/mcp-quickstart.md`

**Cost:** ~12 files, no code. **Reach:** all three surfaces. **Risk:** low; additive —
`tests/guide.test.mjs:83` asserts the existing three, which keep passing.

### Option B — add the missing evidence rung

`external-behavior claim` (name to settle; `unverifiable from source` is the other candidate):
the claim is about a component outside the analyzed source tree — a server, engine, driver,
third-party API, OS — including how it parses a payload, what it silently ignores, and
version-dependent behavior. Not obtainable at any read depth of this source. Settling it needs
a runtime probe against the pinned version, or that system's own source at that version.

Hard pairing rule: `external-behavior claim` ⇒ action is `verify at runtime` or
`port differently`, **never** `fix before porting`.

Files: the six `passes/0*.md` "Evidence level:" lines and pass 05's "How to report";
`findings/defect-scan/SKILL.md`; `architecture/SKILL.md:86`, `contracts/SKILL.md:81`,
`protocols/SKILL.md:79`, `porting/SKILL.md:20`; `workflow/VALIDATE.md:53`; `README.md:38,231,542`;
`MANUAL.md:156`; `docs/mcp-quickstart.md:154`; the `templates/*` evidence-level comments.

**Cost:** ~15 files, no code. **Reach:** all three surfaces. **Risk:** low, but it widens a
vocabulary every surface documents, so the doc sweep has to be complete or the surfaces
disagree.

### Option C — mechanical evidence/action cross-check in `validatePhaseOutput`

The findings tables are header-identical across all three defect templates
(`| # | Location | Defect | Severity | Evidence Level | Action |`, plus an optional
`Spec Reference`), so a header-driven parse is deterministic, not a heuristic.

- **C1 (gating `FAIL`)** — Evidence Level in {`open question`, `external-behavior claim`}
  paired with Action `fix before porting`. The model wrote both cells itself; there is no
  ambiguity to get wrong.
- **C2 (warning)** — a finding with `verify at runtime` / `open question` and no matching row
  in the report's own `## Open Questions` table (which Option D-template adds).
- **C3 (warning)** — the report's `Evidence basis:` omits `runtime verification` while a
  finding asserts `observed fact` about external behavior.

Implementation: add `warnings?: string[]` to `ValidationResult` and a line in
`buildValidationSummary` — precedent is the non-gating secondary-outputs `NOTE:`
(`core/pipeline.ts`). Both executable surfaces pick it up for free: Pi and MCP both route
through `validatePhaseOutput` + `buildValidationSummary`.

**Constraint:** a gating `FAIL` stops `--auto` (`decideAfterPhase`,
`extensions/codecarto/auto-runner.ts:294`). C1 is safe to gate *because* it is deterministic;
C2/C3 stay warnings. Version-gate C1 on `state.scaffoldVersion` (`compareDottedVersions` in
`core/workspace.ts`) so a pre-`verify at runtime` workspace, which had no honest action to
choose, warns instead of failing mid-run.

**Cost:** ~80-120 lines in `core/pipeline.ts` (or a new `core/findings.ts`) + tests.
**Reach:** Pi + MCP.

### Option D — closure integrity at completion

- **D1** — add optional `derives_from: <open-question-id>` to `CarryForwardEntry`
  (`core/types.ts`). When a handoff closes a carry-forward whose `derives_from` question is
  still unresolved and is not in the same handoff's `open_question_closures`, refuse completion
  naming both ids. Deterministic, and exactly issue #122's shape. Its weakness is that it needs
  the *upstream* phase to fill `derives_from` — but that phase writes both entries in the same
  handoff, which is the cheapest possible moment to ask.
- **D2 (warning first)** — require the primary output to contain the id string of every claimed
  closure. `templates/semantic-defects.md` already has a Carry-Forward Closure table with an ID
  column; nothing checks it. Catches "closed in the handoff, addressed nowhere."
- **D3** — let `open_question_closures` carry evidence: accept `{id, evidence}` alongside bare
  strings (back-compatible). For a question whose `kind` is `needs-runtime-test`, require the
  evidence to name a spike report or runtime observation, not a source read. This is the
  post-0.11 roadmap's "closure sweep" item.

Files: `core/types.ts`, `core/status.ts`, `core/completion.ts`,
`.codecarto/templates/phase-handoff.yaml`, `.codecarto/GUIDE.md`,
`agent-skill/codecartographer/references/handoff-contract.md`, tests.

**Cost:** moderate. **Reach:** Pi + MCP (the schema docs reach drop-in, unenforced).
**Note:** additive optional fields only — `.codecarto/` schema is ABI for every existing
workspace (CLAUDE.md).

### Option E — carry the coverage-gap ledger into the next phase

`## Coverage and limits` uses fixed bullet labels (`- Inspected scope:`, `- Skipped scope:`,
`- Evidence basis:`, `- Known blind spots:`, `- Coverage disposition:`) in every template, so
parsing it is deterministic.

- Parse completed phases' ledgers and render them in `buildPhasePrompt`'s Orchestrator-duties
  block: *"Upstream declared coverage gaps — a finding inside one of these must either close it
  with cited new evidence or inherit its uncertainty."* This is the duty the Contradiction
  sweep is missing.
- Optional mechanical companion: extract path-like tokens from those bullets and compare against
  the `Location` column of the downstream report's findings; a match plus `observed fact` → a
  warning. Heuristic, so warning only — it would have caught Case 2 (`launch.bat:1608`).

**Cost:** ~60 lines (`core/coverage.ts` + `core/prompts.ts`) + tests. **Reach:** prompt reaches
Pi + MCP; the template rule reaches drop-in.

### Option F — cite-or-hedge rule for quantities

Any number in a finding (size, count, default, version, timeout) cites the `file:line` or
command output it was read from, or is written as an explicit estimate. Add to the defect
SKILLs, the pass files' "How to report", and one validation row.

**Cost:** ~6 files, no code. **Reach:** all three surfaces. **Enforceability:** prose only —
but it targets the third failure family, which nothing else here touches.

### Option G — surface the contradiction in status/dashboard

Badge an unresolved `needs-runtime-test` question next to the count of `fix before porting`
findings. Cheap, but it informs after the fact rather than gating. Take it only as a follow-on
to C.

---

## Recommendation

Three stages, smallest-blast-radius first. Stage 1 alone addresses the issue's stated
"Expected behavior"; Stages 2-3 are what make it hold when a model is careless.

### Stage 1 — vocabulary and document structure (no code, all three surfaces)

Options **A + B + F**, plus the Gap 3 fix: add `## Open Questions` to `mechanical-defects.md`,
`semantic-defects.md`, and `defect-report.md`, with a `Derived findings` column so a question
and the findings that touch it sit in one document.

Also add the missing counterpart duty to `GUIDE.md` §Roles and
`references/orchestration.md`: re-triage that concludes *"still needs a runtime test"* forbids
any finding in that phase from asserting one of the question's candidates with a settled
action.

This is where most of the leverage is, and it is the only part the drop-in surface can receive.

### Stage 2 — deterministic mechanical checks (core; Pi + MCP)

**C1** gating (version-gated on `scaffoldVersion`), **C2/C3** and **D2** as warnings. All
deterministic table reads; no heuristics in a gating path. Add `warnings[]` to
`ValidationResult` and one summary line, mirroring the secondary-outputs `NOTE:`.

### Stage 3 — schema and cross-phase ledger

**D1** (`derives_from`) and **D3** (closure evidence), then **E**. These are the real
enforcement, and they change the handoff schema — additive only, and worth its own discussion
per CLAUDE.md before implementation.

## Invariants any of this must not break

- All three surfaces keep producing byte-identical phase prompts and identical validation
  results (`tests/pipeline-invariants.test.mjs`, `tests/framework-handoff.test.mjs`).
- Every `depends_on`, `required_reads`, and `primary_output` path stays real; every SKILL.md
  cites a path some pipeline produces (`tests/pipeline-invariants.test.mjs:108`).
- Every phase keeps a coverage completion criterion and every template its `Coverage and
  limits` section plus matching validation row (`tests/pipeline-invariants.test.mjs:166`).
- Adding a completion criterion to a pipeline YAML changes the validation rows a template is
  expected to carry, so template and YAML must move together — and `scaffold-version.yaml`
  must bump so `describeScaffoldStaleness` tells an in-flight workspace to refresh.
- No new instruction may tell a session to write `workflow/status.yaml`, `THREAD_LOG.md`, or
  `closeouts/` (`tests/pipeline-invariants.test.mjs:200,241`).
- `--auto` must not wedge: no heuristic check may return a gating `FAIL`.

## Open questions for the maintainer

1. Name for the new evidence rung: `external-behavior claim` or `unverifiable from source`?
   The first says what it is about; the second says why it matters. It appears in six pass
   files, five SKILLs, three templates, and four docs, so the choice is worth making once.
2. Name for the new action: `verify at runtime` reads as an instruction and parallels the
   maintenance set's `investigate`. Alternative: `needs-runtime-test`, which matches the
   existing `open_questions.kind` value exactly — one vocabulary instead of two, at the cost of
   reading oddly in an Action column.
3. Should C1 gate (`FAIL`) or only warn on a current scaffold? Gating is the issue's stronger
   ask; warning cannot wedge anything.
4. Is Stage 3's `derives_from` field worth the handoff-schema addition, given it depends on the
   upstream phase filling it in?
