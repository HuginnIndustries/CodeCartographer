# CodeCartographer Synthesis + Library Upgrade — Implementation Roadmap

Working tracker for the synthesis-phases upgrade. Supersedes the
implementation plan in [`docs/design-synthesis-phases.md`](./design-synthesis-phases.md)
(kept as the historical record of the original proposal).

Status: planning approved 2026-05-14. Implementation not yet started.

## Context

CodeCartographer today walks an LLM through phases that reverse-engineer
a codebase into `findings/reimplementation-spec/reimplementation-spec.md`.
This upgrade adds the **forward direction**: take N existing specs from
a shared library plus a user-written vision and produce a project plan
for a new build. The library is reframed as its own git-backed repo so
it can be accumulated, versioned, and shared across teammates.

Three concurrent shifts make this a coherent release rather than a
single feature:

1. **Synthesis pipeline.** New `pipeline-synthesis.yaml` that produces
   `project-plan.md` from a vision + library entries.
2. **Library as git repo.** Promoted from "embedded folder in
   `.codecarto/`" to its own git-trackable repository with a marker
   file, structured metadata, and derived index artifacts.
3. **Surface priority reframe.** Pi extension positioned as the
   recommended user surface, MCP server positioned for other coding
   agents, drop-in template positioned for one-off evaluation. README
   and CLAUDE.md restructured to reflect this.

## Revised target shape (decisions locked in)

Differences from the original design doc, captured here so the roadmap
is self-contained:

- **Three synthesis phases, not six.** Dropped `feature-index` as a
  dedicated phase — its "promote spec into structured form" goal
  collapses to a lightweight `metadata.yaml` written at publish time.
  Made `spec-merge` mandatory rather than optional so `goal-synthesis-finalize`
  becomes a pure transform with a debuggable intermediate.
- **Library publication is a separate concern from the pipeline.** A
  standalone `codecarto publish` step (Pi slash command + MCP tool)
  writes entries. Re-analysis or `spec-mutate` produces a spec; publish
  decides when it enters the library.
- **Library is its own git repo,** detected via a `.codecarto-library`
  marker file. Default location is user-global (`~/codecarto-library/`
  or whatever the user configures in `~/.codecarto/config.yaml`).
  Per-workspace override is allowed for vendored / self-contained
  synthesis workspaces.
- **`index.yaml` and `INDEX.md` are derived artifacts.** Regenerated
  from `entries/**/metadata.yaml` by `codecarto library-reindex`. No
  hand-edits. Resolves the multi-publisher merge conflict problem.
- **Namespacing is optional but recommended for shared libraries.**
  Default namespace = git user.email local-part or configured value.
  Single-namespace mode skips the namespace directory level.
- **`metadata.yaml` captures generation context.** Surface, agent,
  agent version, model, model vendor, reasoning budget,
  codecarto_version. Captured automatically on Pi; passed by host on
  MCP; user-edited on drop-in.
- **Library schemas are marked experimental in v1.** Freeze pressure
  applies once the first external consumer appears, not before.
- **Defense-in-depth on the propose/confirm gate.** `goal-synthesis-finalize`
  refuses to start if no entries are marked confirmed in `proposal.md`,
  independent of phase status.
- **Drop-in surface does not support library workflows.** Drop-in is
  for evaluation. Library and synthesis require Pi or MCP (or a future
  standalone CLI).

## Surface priority (load-bearing for README + contributor docs)

```
1. Pi extension (recommended).
   First-class UX. Slash commands, live widget, isolated sub-agents,
   auto-runner, dashboard. Library state surfaced in the widget.

2. MCP server (for other coding agents).
   Same prompts, same validation, same outputs. For Claude Code,
   Codex, opencode, Cursor, and anything that speaks MCP. Host
   drives; framework provides phase prompts and library tools.

3. Manual drop-in (one-off / evaluation).
   .codecarto/ markdown + YAML, no executable code. For trying
   CodeCartographer in any repo before installing anything. Library
   and synthesis workflows require Pi or MCP — drop-in users can
   still run the analysis side fully.
```

## Milestones

Sequenced for dependency, not time. Each milestone should leave
`tests/pipeline-invariants.test.mjs` green and ship as one or more
commits. Commit prefixes from CLAUDE.md: `feat:`, `fix:`, `docs:`,
`refactor:`, `ci:`, `framework:`.

### M0 — Docs + design freeze

Goal: lock the revised shape in writing before any code moves. Anyone
opening the repo after this milestone should see the new plan and the
new positioning.

- [ ] Update `docs/design-synthesis-phases.md` with a "Revised
      2026-05-14" header pointing at this roadmap as the source of
      truth for the revised shape.
- [ ] Write `docs/library-format.md` — public read-side contract for
      `.codecarto-library` marker, `metadata.yaml`, `index.yaml`,
      `INDEX.md`. Marked **experimental, may break before v2**.
- [ ] Update `CLAUDE.md` — replace "three delivery surfaces" parity
      framing with the surface priority. Add note on `tool_call` hook
      change coming in M2.
- [ ] Rewrite `README.md` lead with surface-priority ordering: Pi
      install first, MCP setup second, drop-in third. Each section
      framed by "when to use this," not feature parity.
- [ ] Stub `CHANGELOG.md` entry for the upcoming release noting the
      positioning shift and new synthesis surface.

Acceptance: a new contributor reading `docs/` + `README.md` + `CLAUDE.md`
can describe the target shape and which surface they should reach for.

### M1 — Library foundations

Goal: working `core/library.ts` and config plumbing, fully tested, with
no pipeline integration yet. Everything downstream rests on this.

- [ ] `core/library.ts`:
  - [ ] `discoverLibrary(configuredPath)` — walks for `.codecarto-library`
        marker file, returns library root or `null`.
  - [ ] `readEntry(libraryRoot, slug, version?)` — returns metadata +
        spec content. Resolves `latest` if no version given.
  - [ ] `listEntries(libraryRoot, filter?)` — filterable by namespace,
        tag, source repo.
  - [ ] `publishEntry(libraryRoot, spec, metadata, opts)` — idempotent
        write, atomic temp-dir-then-rename, version increment.
  - [ ] `reindex(libraryRoot)` — regenerates `index.yaml` + `INDEX.md`
        from filesystem state.
  - [ ] Optional `commitPublish(libraryRoot, message)` — runs `git add`
        + `git commit` with a structured message. Never pushes.
- [ ] `.codecarto-library` marker file format (small JSON: schema
      version + library name + visibility hint).
- [ ] `metadata.yaml` schema with `generation:` block:
      ```yaml
      generation:
        surface: pi-extension | mcp-server | drop-in
        agent: pi | claude-code | codex | opencode | cursor | manual | other
        agent_version: <semver-or-unknown>
        model: <model-id>
        model_vendor: ollama | anthropic | openai | google | local | unknown
        reasoning: high | medium | low | default | null
        notes: <free-form>
      codecarto_version: <pkg-version-at-publish>
      ```
- [ ] `~/.codecarto/config.yaml` schema:
      ```yaml
      library_path: ~/codecarto-library
      namespace: <git-user-or-configured>
      publish_confirm: true
      ```
- [ ] `.codecarto/workflow/config.yaml` per-workspace override schema
      (just `library_path` and `namespace`).
- [ ] `core/orchestrator-config.ts` reads user-global config and merges
      with per-workspace. Resolution order: per-workspace >
      user-global > prompt-on-first-use.
- [ ] `core/index.ts` re-exports library helpers.
- [ ] Tests:
  - [ ] `tests/library.test.mjs` — discover, read, publish, list, reindex
        round-trips.
  - [ ] Atomicity: publish under simulated mid-write failure leaves the
        library readable.
  - [ ] Idempotence: re-publishing the same spec content does not
        produce a spurious version.
  - [ ] Reindex from a hand-edited entries tree converges to a known
        `index.yaml`.

Acceptance: `node` REPL can create a library, publish two entries,
list them by tag, regenerate the index. Tests green.

### M2 — Surface publish UX

Goal: real users on Pi and MCP can publish entries with model/harness
metadata captured automatically (Pi) or passed by host (MCP).

#### M2a — Pi extension

- [ ] `/codecarto-publish` slash command in `extensions/codecarto/index.ts`.
- [ ] Model + harness capture from Pi session context — fill
      `generation:` block automatically.
- [ ] Update `tool_call` hook: allow `edit`/`write` to the resolved
      `library_path` in addition to `.codecarto/`. Verify the
      allow-list logic correctly rejects writes outside both. **Treat
      this as a security-adjacent change — review carefully.**
- [ ] `publish_confirm` y/N prompt before commit, displaying slug,
      source repo, library path, and (if `unknown`) missing
      `generation:` fields.
- [ ] Dashboard surfaces library state:
  - [ ] Entry count + last-published timestamp.
  - [ ] "N unpushed commits" hint if local library is ahead of remote.
  - [ ] "N stale entries" hint for entries whose source repo HEAD has
        moved since analysis (best-effort — requires source_commit).

#### M2b — MCP server

- [ ] `codecarto_publish` MCP tool — accepts optional `model_metadata`
      argument that the host fills in if it can.
- [ ] `codecarto_library_list` MCP tool — paginated listing with
      filters (namespace, tag, slug, source repo).
- [ ] `codecarto_library_reindex` MCP tool — explicit reindex for
      hosts that want to bypass auto-regen.
- [ ] If `model_metadata` not provided, leave `generation:` fields as
      `unknown` and surface a "fill in before commit?" prompt back to
      the host.

#### M2c — Drop-in docs

- [ ] Add section to `README.md` explaining that library + synthesis
      workflows require Pi or MCP. Drop-in users still get full
      analysis-side functionality.
- [ ] Update `.codecarto/findings/reimplementation-spec/SKILL.md` (or
      its successor) with a note: "If you want this spec in a shared
      library, install Pi or the MCP server and run publish; manual
      drop-in does not support library publication."

Acceptance: end-to-end manual test. Analyze a small repo with Pi,
publish, see entry land in `~/codecarto-library/` with full
`generation:` block populated. Repeat with Claude Code via MCP,
verify model_metadata flows through.

### M3 — Synthesis pipeline phases

Goal: the three synthesis phases land, byte-identical across Pi and
MCP, with structural defense on the confirmation gate.

- [ ] `.codecarto/workflow/pipeline-synthesis.yaml` — three phases:
      `vision-capture` → `spec-merge` → `goal-synthesis-propose` →
      `goal-synthesis-finalize`. (Four phases total; three are
      net-new, `spec-merge` is positioned between vision and propose.)
- [ ] `PIPELINE_ALIASES` entry in `core/pipeline.ts` for
      `pipeline-synthesis`.
- [ ] `vision-capture` phase:
  - [ ] `.codecarto/findings/vision-capture/SKILL.md` — interactive:
        asks clarifying questions, proposes structure, fills missing
        sections. Section headers borrowed from SwarmLord build-spec
        as design inspiration only.
  - [ ] `.codecarto/templates/vision.md`.
- [ ] `spec-merge` phase (mandatory, not optional):
  - [ ] `.codecarto/findings/spec-merge/SKILL.md` — reads library
        entries selected later in the proposal phase. Round-trip
        question: how does spec-merge know what to merge before
        proposal exists? **Resolution: spec-merge runs after proposal
        is confirmed, taking the confirmed entries as input.** Reorder
        accordingly: `vision-capture` → `goal-synthesis-propose` →
        `spec-merge` → `goal-synthesis-finalize`.
  - [ ] `.codecarto/templates/merged-spec.md`.
- [ ] `goal-synthesis-propose` phase:
  - [ ] `.codecarto/findings/goal-synthesis/SKILL.md` (shared with
        finalize, or split if prose diverges meaningfully).
  - [ ] `.codecarto/templates/proposal.md` — shortlist with rationale
        + `confirmed: [ ]` checkboxes + validation block.
  - [ ] Explicit re-run prose: "If `proposal.md` exists and at least
        one entry is checked, update the validation row to PASS and
        overall to PASS. If no entries checked, prompt user to
        select."
- [ ] `goal-synthesis-finalize` phase:
  - [ ] SKILL.md.
  - [ ] `.codecarto/templates/project-plan.md`.
  - [ ] **Structural defense:** before the LLM runs, the phase
        wrapper reads `proposal.md` and refuses to start if no
        entries are marked confirmed. Implementation: a small
        pre-flight check in `core/pipeline.ts` or as a phase property
        in the YAML (`preflight: requires-confirmed-proposal`).
- [ ] Tests:
  - [ ] Structural invariants: `phase_order` consistent with
        `depends_on`, every `required_reads` path exists, every
        `primary_output` path conventionally located.
  - [ ] Byte-identical prompts across Pi and MCP for all three new
        phases (existing test pattern).
  - [ ] Propose/confirm gate: simulated `proposal.md` with no
        checkboxes → finalize phase refuses. With at least one
        checkbox → finalize proceeds.
  - [ ] Re-run of propose with checkboxes → validation flips to PASS.

Acceptance: manual end-to-end. Publish 3 entries from real repos.
Create a synthesis workspace. Run vision-capture → propose → confirm
→ merge → finalize. Project plan emits.

### M4 — Spec mutation pipeline

Goal: `pipeline-spec-mutate.yaml` lands as its own pipeline. Mutated
specs publish as new library versions.

- [ ] `.codecarto/workflow/pipeline-spec-mutate.yaml` — single phase.
- [ ] `PIPELINE_ALIASES` entry for `pipeline-spec-mutate`.
- [ ] `spec-mutate` phase:
  - [ ] `.codecarto/findings/spec-mutate/SKILL.md` — applies deltas
        from `inputs/deltas.md`. Attaches addenda to Carry-Forward /
        Spike List when ambiguity is introduced.
  - [ ] `.codecarto/templates/mutated-spec.md`.
- [ ] Publish integration: mutated specs go through the same publish
      path, producing v+1 in the library with `generation.notes`
      reflecting the mutation source.
- [ ] Tests for the single phase + publish round-trip.

Acceptance: take a v1 library entry, run spec-mutate against deltas,
publish v2. Library shows both versions with `latest -> v2/`.

### M5 — Polish + release

Goal: ship.

- [ ] Run the M0 → M4 end-to-end manual test on a real workflow.
      Capture any UX papercuts as inline TODO comments or issues, fix
      anything blocking.
- [ ] Cross-surface prompt-parity test passes for all new phases.
- [ ] `tests/pipeline-invariants.test.mjs` green; new phase YAML /
      SKILL / template alignment covered.
- [ ] Complete `CHANGELOG.md` entry: surface positioning, library
      format (experimental), synthesis pipeline, spec-mutate pipeline,
      metadata.yaml capture matrix.
- [ ] Bump `package.json` version per CONTRIBUTING.md.
- [ ] Final `README.md` pass — make sure surface-priority intro is
      clean, library quickstart is concrete, synthesis quickstart
      shows the propose/confirm UX explicitly so first-time users
      know what to expect.
- [ ] Push `vX.Y.Z` tag (tag-driven release per CLAUDE.md).

Acceptance: tag pushed, CI green, npm package + GitHub release fire.

## Risks

- **Pi extension `tool_call` hook change is security-adjacent.** The
  hook today confines writes to `.codecarto/`. Extending the
  allow-list to include `library_path` is necessary but needs
  careful verification — especially that user-configured paths can't
  escape via `..` or symlink trickery into arbitrary filesystem
  locations.
- **`index.yaml` merge-conflict UX.** Theoretically resolved by
  "regenerate, don't merge." In practice, two contributors pushing
  simultaneously will still hit the conflict before discovering the
  regen workflow. Make the error message in `codecarto publish`
  spell it out: "library/index.yaml conflicts with origin —
  run `git checkout --theirs index.yaml && codecarto library-reindex`."
- **`metadata.yaml` capture asymmetry.** Drop-in users will have
  `unknown` for most `generation:` fields. The propose phase's tier
  filtering will under-weight those entries unless we handle
  `unknown` as a neutral signal rather than as "low quality."
- **Schema marked experimental, but freeze pressure mounts fast.**
  Once one external tool builds against `metadata.yaml`, breakage
  becomes painful. Be explicit about the experimental window's
  expected duration (e.g. "frozen at v2.0.0 unless concerns
  surface").
- **Reordered synthesis pipeline.** I changed the order during M3
  drafting (`propose` now before `merge`). Verify this reordering
  is the right call before locking phase YAML — the original design
  had merge as an optional pre-bake. With propose-first, merge
  becomes a consumer of confirmed selections, which is cleaner but
  needs the SKILLs to be written for that flow.

## Out of scope (v1)

Carried forward from the original design doc, still excluded:

- Multi-workspace synthesis via a manifest (reaching into peer
  workspaces).
- Parallelism for synthesis-pipeline phases — phases are short, run
  serially.
- Library entry diffing across versions (versioning is in place; no
  diff UX yet).
- SwarmLord packet ingestion (design inspiration only).
- Library search CLI beyond `grep` / `yq` against `index.yaml`.
- Retry/resume of proposal confirmation (user just re-runs the
  propose phase).
- git-lfs migration for large libraries (deferred until specs get
  large enough to justify it).
- Standalone CLI for drop-in users to publish without installing Pi
  or MCP (acknowledged future option).
- Public read-side schema freeze (deferred until first external
  consumer).

## Open questions

Things that aren't blocking M0 but should be resolved before the
corresponding milestone closes.

- **M2:** Should the Pi dashboard's "stale entries" check actually
  fetch source-repo HEADs, or just compare `source_commit` against a
  cached value? Network access pattern decides.
- **M3:** Should `goal-synthesis-finalize`'s structural defense live
  in `core/pipeline.ts` (a new `preflight:` property on phases) or as
  ad-hoc logic in the finalize phase's wrapper? Generic vs. specific.
- **M4:** When `spec-mutate` runs, does it auto-publish on
  completion, or require an explicit `codecarto publish` step like
  the original analysis path? Consistency argument says explicit.
- **M5:** Version bump — minor (1.x → 1.y) or major (1.x → 2.0)?
  The surface-priority reframe is documentation-only, library
  format is experimental, synthesis is additive. Leaning minor.
