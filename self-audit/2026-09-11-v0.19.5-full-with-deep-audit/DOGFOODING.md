# Dogfooding notes

Observations about CodeCartographer as a framework, collected while driving it over its own
repository through the MCP surface. Items already covered by a defect in REVIEW.md cite the
defect id.

## Where the phase prompts left the host guessing

- **Strategic Alignment Hook on an autonomous run.** The reimplementation-spec prompt asks
  the user interactively whether the spec should be language-agnostic or opinionated. This
  run was declared autonomous, so the host recorded the language-agnostic default in the
  spec front matter and the handoff. The Pi surface has an `auto` variant that says to record
  `selection: auto-default`; the MCP prompt should carry the same instruction when the host
  says it cannot ask.
- **Who owns the storage-format catalog.** Contracts and protocols both list the architecture
  map as their input and neither says which of the two owns the on-disk format catalog. The
  host put it in contracts and cross-referenced; the protocols SKILL then asked for it again.
- **"Under one screen" vs. one disposition per defect.** The porting template caps the Defect
  Synthesis at one screen, while the phase requires every defect to carry a disposition the
  spec can design around. The host chose completeness and recorded a decision. The template
  should say which wins.
- **Probe-confirmed severity.** The semantic scan's rubric does not say whether a confirmed
  runtime probe raises or holds severity. The host promoted convention C01 (cheap runtime
  probe before assigning severity) to settle it for later phases.

## Where the validation and handoff contract fought the host

- **Template suggests carry-forward targets the gate refuses.** The reimplementation-spec
  template's Carry-Forward comment names `spike`, `delta`, and `amendment` as targets, but
  completion refuses any `target_phase` outside the active pipeline. The only working route
  is `post_pipeline` entries with `kind: spike`.
- **PARTIAL rows spawn duplicate open questions** even when the handoff already routes the
  gap (D-M3). Every phase with a PARTIAL coverage row cost an extra closure later.
- **Validation is self-attestation.** The gate parses the host's table and Overall line and
  cross-checks evidence/action pairing. It never compares the evidence cell against the
  artifact, so a phase can validate PASS with an empty report. README describes it as
  checking the criteria (D-M27).
- **Closeouts are UTC-dated.** A session on 2026-09-11 produced files named
  `2026-09-12-*.md` while the validation lines said 09-11.
- **DECISIONS rows are appended without a blank line** before the first row, so the table
  runs into the preceding paragraph in some renderers.
- **`codecarto_next` on a complete pipeline** returns a different sentence from the one the
  quickstart documents.

## Required reads: dead weight and missing

- **Dead weight:** GUIDE, `status.yaml`, and the handoff template are listed on every phase.
  After phase one they add nothing but are the first three reads each time. Listing them
  once, then "re-read if changed", would be enough.
- **Missing from the mechanical scan:** `package.json`, `tsconfig.json`, and the CI workflows.
  Three of its high findings (D-H7 and the two Broad-Side defaults) came from them.
- **Missing from the semantic scan:** `node_modules` SDK sources as a permitted evidence
  source. The SKILL's definition of runtime evidence allows "that system's own source", and
  that is how the ctx-invalidation question was closed, but nothing points the host there.
- **Missing from porting:** the two runtime-probe sections by name. They were the strongest
  evidence in the run and are only reachable by reading the whole scan reports.

## What the framework got wrong about its own repo

- **The checkout ships with its own workspace state.** `status.yaml`, THREAD_LOG, and
  closeouts from the maintainers' earlier run are tracked, so `codecarto_open` reported an
  existing workspace, the GUIDE's "first-time" heuristic was wrong from the first call, and
  this run appended to someone else's THREAD_LOG.
- **Self-running breaks the test suite** because init copies the live template including any
  finished phase (D-H2, D-M11). 678/696 in the audited clone versus 696/696 in a pristine one.
- **`.codecarto/.gitignore` names a stale path.** It ignores
  `findings/defect-scan/defect-report.md`, which no shipped pipeline writes, so under the
  default pipeline the two defect-scan reports are the only findings the checkout would commit.

## Does the reimplementation spec describe a recognisable system?

Yes, with one caveat. The six-module kernel (workspace store, dialect, engine, validator,
gate, prompt assembler) over five ports is the shape the tests already drive without either
shell, and someone who knows the repo would recognise every module and every persisted format
in it. The caveat: the spec's normative rules are the eleven high defects turned into MUSTs,
so it describes the system the maintainers meant to build rather than the one on disk. The
byte-for-byte list in its §Protocols and Persisted State is the part to trust most; it is
what an existing workspace, library, and config need in order to load unchanged.
