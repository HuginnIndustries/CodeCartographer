# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Closure integrity in the handoff schema: a phase can no longer close a routed item while the question it came from is still open** (#122, #186). Stage 3 of the #122 investigation, held back from v0.17.1 because it changes the phase handoff — ABI for every existing workspace. Stages 1 and 2 read what a finding's own cells said; nothing verified that a *closure* was honest, and `applyHandoff` removed `carry_forward` and `open_questions` entries by id unconditionally. Three additive pieces close that. **`derives_from` on a carry-forward entry** records that the routed item is one candidate answer to a named `open_questions` id — filled in the handoff that registers the question, which is the one moment both entries are in front of the phase writing them. Completion now refuses a `carry_forward_closures` entry whose `derives_from` question is still unresolved and is not closed by the same handoff, naming both ids and saying what to do: close the question here with evidence, or leave the item routed and give the finding `verify at runtime`. That is exactly the shape #122 reported, where a routed `logit_bias` hypothesis shipped as `strong inference` / `fix before porting` while the question saying "source alone cannot determine which" stayed open. **`open_question_closures` accepts `{id, evidence}`** alongside the bare id it has always taken, and for a question whose `kind` is `needs-runtime-test` the evidence is required and must be non-empty — such a question closes on a spike report or an observation against the running system, not on another read of the same source. Presence is the gate; what the evidence *says* stays prose guidance. **Completed phases' declared coverage gaps now reach the next phase's prompt**: the new `core/coverage.ts` parses the `## Coverage and limits` ledger whose five bullet labels are fixed across every template, and the orchestrator-duties block lists each completed phase's `Skipped scope` and `Known blind spots`, with the duty that a finding inside one of them must either close it with cited new evidence or inherit its uncertainty. This is the duty the contradiction sweep was missing — that sweep compares against `owner_notes`, and a declared blind spot is not an owner note — and it is what would have caught #122's second failure, where a phase asserted an `observed fact` about a component an upstream phase had recorded as not fully decoded. It is non-gating prompt text, capped and rendered like the re-triage list, and both surfaces get it from `buildPhasePrompt`. Both refusals are deterministic reads of ids the model wrote itself and sit before the status lock, so a refusal mutates nothing and neither can wedge `--auto` on a heuristic. **Back-compatibility:** every new field is optional and the schema version is unchanged, so an existing workspace's handoffs parse exactly as before — a bare-string closure still normalizes to `{id}`, a `carry_forward` entry without `derives_from` closes without comment, and a phase output without a `## Coverage and limits` section contributes nothing to the prompt. The one deliberate behavior change on the old shape is the narrow D3 gate: closing a `needs-runtime-test` question now requires evidence however the closure is written, because a gate that only bound the new object form would be one an unchanged handoff could always sidestep.

## [0.18.0] — 2026-09-07

The parity round. Every framework operation now has a Pi slash command: `/codecarto-amend`, `/codecarto-refresh-scaffold`, `/codecarto-guide`, and `/codecarto-list-skills` join the sixteen that existed, so a Pi user is never told to invoke an MCP tool they do not have — the staleness notice and the terminal `next_actions` now name both surfaces. The publish surface closes its three gaps: MCP honors `library.publish_confirm` with a refuse-unless-confirmed preview (the same handshake Broad-Side uses for spend), Pi offers the source-repo override as a question instead of a dead end, and Pi records the repository's git remote as provenance instead of a machine-local path. The only operations still MCP-only are `codecarto_library_list` and `codecarto_library_reindex`, by design.

### Added

- **Pi: `/codecarto-amend` applies post-pipeline amendments** (#157). `codecarto_amend` had no Pi counterpart, and GUIDE.md forbids the only manual alternative ("never hand-edit `status.yaml`"), so a Pi-only user could stage `scratch/amendments/<name>.yaml` from the shipped template and never apply it. The command takes the amendment name, `name.yaml`, or a path inside `.codecarto/scratch/amendments/` (tab-completed from the files staged there), runs the same refusals `codecarto_amend` surfaces as errors — pipeline incomplete, no such file, malformed arrays, nothing to apply — and then, because Pi can ask, previews the amendment against `status.yaml` before writing: each open-question id with its phase, kind, and description, each post-pipeline id with its kind and source phase, ids that match nothing flagged as such, the notes, and the closeout and THREAD_LOG entry it will write. A refused amendment is never put to the user; declining writes nothing. On yes it calls `applyAmendment`, renders the result MCP renders (closures applied, ids that matched nothing, closeout path), regenerates the dashboard, and refreshes the widget so the open-question and post-pipeline counts move. The template sentences that named `codecarto_amend` as the way to apply an amendment (GUIDE.md, `templates/amendment.yaml`, `templates/spike-report.md`, the spec-delta skill) now name both surfaces. New core helper `listAmendmentNames`.
- **Pi: `/codecarto-refresh-scaffold` refreshes a stale scaffold** (#159). The staleness notice Pi rendered in its own widget told the user to run `codecarto_refresh_scaffold` — an MCP tool name with nothing to run on Pi. The command lists, before writing, exactly what `refreshScaffold` will overwrite — the file count and the scaffold version transition, the top-level files by name, the `workflow/` pipelines, `VALIDATE.md` and version marker by name, per-directory counts for `templates/`, `skills/`, and the `findings/` stubs — and what it never touches (`status.yaml`, `config.yaml`, the usage log, BACKLOG/THREAD_LOG/CONVENTIONS/DECISIONS, `scratch/`, `inputs/`, `closeouts/`, `broadside/`), then asks. Declining writes nothing. On yes it reports the count and the version transition, notes the THREAD_LOG entry, and re-reads state so the staleness line clears. The preview comes from new core exports `listScaffoldRefreshFiles` and `SCAFFOLD_REFRESH_PROTECTED`, the same set and exclusions the refresh itself uses, so it cannot drift from the write. `describeScaffoldStaleness` now names both remedies (`codecarto_refresh_scaffold` on MCP, `/codecarto-refresh-scaffold` on Pi), since the one string renders in both surfaces; the agent skill's refresh guidance names them too.
- **Pi: `/codecarto-guide [topic]` reads the packaged agent guide into the session** (#160). `codecarto_guide` served the drive loop, the handoff contract, executor selection, recovery patterns, and the Broad-Side reading guide to MCP hosts; Pi imported nothing from `core/guide.ts`. The command serves the same document — `overview` by default, any reference topic by name, tab-completed from `listGuideTopics` — through `pi.sendUserMessage` the way `/codecarto-skill` delivers a skill prompt (immediately when idle, as a follow-up otherwise), with the same "Other guide topics" footer MCP appends. The one divergence is deliberate: the footer says `run /codecarto-guide <topic>` rather than `call codecarto_guide with topic`, because a Pi session has no tool to call; a test pins the two payloads byte-identical apart from that phrase. An unknown topic is refused with the available list and sends nothing. Needs no workspace — the guide is packaged with the extension — so it works before `/codecarto-init`.
- **Pi: `/codecarto-list-skills` lists the post-pipeline skills** (#161). Skill discovery on Pi existed only as the usage hint `/codecarto-skill` prints when run with no argument. The command mirrors `codecarto_list_skills`: the installed skills under `.codecarto/skills/` in the same order, the ungated `broadside` reading guide listed apart from the gated set, both rendered into the widget with a notification. Two Pi additions: the listing says whether the gated skills are runnable yet ("unlock when the pipeline completes (next phase: …)" or "Run one with `/codecarto-skill <name>`"), and the Broad-Side line names `/codecarto-skill` rather than `codecarto_skill`. Same workspace requirement as the MCP tool.
- **MCP: `codecarto_publish` honors `library.publish_confirm`** (#162). The key gated `/codecarto-publish` behind a yes/no preview on Pi and did nothing on MCP — `handlePublish` never read it; only `codecarto_config` displayed it — so a host that set it saw no change and no explanation. An MCP server has no one to ask, so it now does what `codecarto_broadside` does for its spend limit: when `publish_confirm` is set and the call does not carry `confirm: true`, the tool refuses with an `InvalidRequest` error whose text is the preview Pi would have shown — library, entry, whether this would be a new version or a metadata-only update (decided read-only by the same content-hash rule `publishEntry` applies, through the new `previewPublishVersion`, which `publishEntry` itself now calls), `source_repo`, headline, confidentiality — and says to re-invoke with `confirm: true`; the same fields ride along as the error's `data`. Nothing is written by the refusal. The gate applies only when a config layer actually set the key, which `codecarto_library_init` does: the loader's default (`true`) exists to make Pi's dialog opt-out, and charging every MCP host a round trip for a key it never configured would have been a second surprise in place of the first. Hosts that never set `publish_confirm` see no change; `publish_confirm: false` drops the gate. The loaded config carries a new `library.publish_confirm_configured` flag saying whether the value came from a file, and `codecarto_config` still reports the effective value.
- **Pi: `/codecarto-publish` offers the source-repo override as a question** (#146). The collision guard (#127) refuses a publish whose `source_repo` names a different repository than the entry's newest version records, and its override existed only as `allow_source_repo_change` on MCP and `allowSourceRepoChange` in `PublishOptions`. `/codecarto-publish` takes no arguments, so a Pi user whose repository had been renamed or moved hit `Unable to publish` and had to publish through MCP once. The guard's refusal is now a typed `SourceRepoMismatchError` carrying the recorded and incoming values (the message is unchanged), mirroring `ConfidentialityMismatchError` from #124, and the Pi command handles it the same way: a second confirm shows both values and asks whether the repository moved. Yes retries with the change allowed; no writes nothing. A publish that trips both guards is asked both questions in turn.
- **Pi: `/codecarto-publish` records the git remote as `source_repo`** (#147). The command passed `ctx.cwd` straight through as the entry's provenance and derived the slug from the same string — the local-path shape `docs/library-format.md` discourages, meaningless on any other machine, and the reason two checkouts of one repository under different parents collided on one slug with two provenances. The new `resolvePublishSourceRepo` in core resolves `origin`'s fetch URL, else the fetch URL of the remote the current branch tracks, and falls back to the directory when it is not a git work tree or has no remote. The URL is stored as git reports it — normalization stays at comparison time, as #127 does — the slug derives from the same value so the two agree (`…/whisper.git`, `git@host:acme/whisper` and `/path/whisper` all give `whisper`; `deriveSlug` now also handles the slash-less `git@host:whisper` form), and the preview's `Source:` line shows what will be recorded. The remote is consulted only when the directory is the root of its work tree: every subdirectory of a monorepo would otherwise resolve to the same URL and slug, and the second one published would land as a new version of the first with no guard able to tell. **Upgrade note:** an entry published by an earlier Pi holds the local path, so the first publish after upgrading carries a URL where the entry records a path and the collision guard fires. That is the question #146 adds — recorded path, incoming URL, "did the repository move?" — and yes is the right answer when it is the same project: the entry keeps its slug and history, and its newest version records the URL from then on.

### Fixed

- **Terminal `next_actions` name both surfaces.** When the last phase completes, `buildTerminalNextActions` writes the routing lines that `codecarto_status` renders on MCP and the Pi widget shows as its `Next:` line — and every one of them named only MCP tool names (`codecarto_list_skills`, `codecarto_skill`, `codecarto_amend`, `codecarto_publish`, `codecarto_library_init`, `codecarto_dashboard`, `codecarto_usage`), so a Pi user finishing a run was told to invoke tools Pi does not have. Each line now spells every tool for both executable surfaces (`codecarto_amend` on MCP, `/codecarto-amend` on Pi), the phrasing the scaffold-staleness notice adopted in #177 for the same defect on the other status string that renders in both places. The `next_actions` shape is unchanged — same list, same order, one string per line — and the routing test now sweeps every line and fails if any `codecarto_*` name appears without its `/codecarto-*` counterpart.

## [0.17.1] — 2026-09-07

The follow-through round. Every open bug the Broad-Side cycle left behind or surfaced, plus the one that mattered most: a run can no longer ship a claim as settled when its own record says the claim is not settlable from source (#122) — a new evidence level, a new action, and mechanical cross-checks that read what the findings' cells say. The library format document now describes the library the code writes, and the guarantees it promised but the code lacked are implemented (confidentiality guard, provenance-conflict reporting) or corrected (publish does not commit). Seven defects from the Broad-Side self-scan triage, the peer-dependency floor that stops consumers installing a vulnerable `undici`, provenance surviving a metadata-only publish, and the Pi `--no-incremental` flag round it out.

### Fixed

- **Metadata-only publish keeps the version's `provenance`.** An identical re-publish — same spec bytes, new headline or tags — takes the content-hash branch of `publishEntry` and rewrites the version's `metadata.yaml` from the incoming input, but `buildMetadata` writes `provenance` only when the input carries it, and neither `codecarto_publish` nor `/codecarto-publish` sends one. So the second publish silently dropped the `{prior_version, mutation_source}` block the version's original publish recorded — the one field on the file that says where the version came from. The in-place branch now reads the block from the current `v<N>/metadata.yaml` and carries it forward; a publish that does supply `provenance` still wins, and the new-version branch, which already defaulted the block, is unchanged. Reproduced on a scratch library by the #172 doc-accuracy pass, which had documented the loss as current behavior; `docs/library-format.md` now describes the fix.

- **`INDEX.md` rows link to the newest version directory, not `latest/`.** `formatIndexRow` linked every slug to `entries/<ns>/<slug>/latest/`, but `latest` is by design a one-line regular file, never a symlink, so on GitHub and every other forge the link resolved to nothing. Rows now link to `entries/<ns>/<slug>/v<latest_version>/`, the directory the `Latest` column already names. Reproduced alongside the provenance defect in the #172 pass; the format document's example rows and prose follow.

- **`INDEX.md` summary line for a single-tenant library reads "across 1 namespace".** The count shown fell back to `1` when the index had no namespaces while the plural check looked at the raw length, so every unnamespaced library was summarized as "across 1 namespaces." The count is computed once and the noun agrees with it.

- **Pi: `/codecarto-broadside` can request a one-off full scan over a config-set `incremental: true`** (#163). The flag grammar had `--incremental` but no negative form, and the handler merged it with `||`, so once a repository set `incremental: true` in `.codecarto/broadside/config.yaml` no Pi invocation could turn it back off for a single run — while MCP's `codecarto_broadside {incremental: false}` already won over config. New `--no-incremental` flag, tab-completed next to `--incremental` and submit-only like it; the parsed value is now tri-state (absent defers to config) and the handler resolves `flags.incremental ?? config.incremental`, exactly as MCP does. Passing both forms on one command is refused as contradictory rather than letting the last one win.

- **YAML: an escaped backslash before the closing quote no longer swallows a trailing comment** (#134). `stripYamlComment` and the key-separator scan decided whether a `"` was escaped by looking at the single previous character, so `"C:\\dir\\" # note` never closed and parsed to the literal text — quotes and comment included. Quote escaping is now judged by the parity of the preceding backslash run; `"a\\b"` and `"a\\"` were already right and are pinned alongside.

- **YAML: a lone quote character is no longer parsed as the empty string** (#134). `key: "` satisfied both `startsWith` and `endsWith` on the same character and was sliced to `""`, silently emptying the value. A quoted scalar now needs at least its two quotes; a bare `"` or `'` passes through as literal text, the same treatment every other unterminated scalar gets.

- **THREAD_LOG entries always start on their own line** (#134). Completion, amendment, scaffold refresh, and `updateStatusAtomically`'s `threadLogEntry` channel appended straight after whatever the file ended with, so a log whose last line lacked a trailing newline (hand-edited, or saved by an editor that strips final newlines) had the new `- date — phase — …` entry glued onto the previous one — and the glued line then slipped past the duplicate check. The generic channel also appended the caller's entry without a newline of its own, so two entries through it landed on one line.

- **Handoff merge keeps open questions and carry-forward entries that have neither id nor description** (#134). `applyHandoff` rebuilt each array from a map keyed by id-or-description, so an existing entry carrying only `kind`/`deferred_reason` was dropped, and a handoff entry without a key was pushed onto the array the next line replaced. Unkeyed entries now survive the merge, appended after the keyed ones.

- **`codecarto_library_init` rejects a relative `library_path`** (#134). The other library tools refuse one through `resolveLibraryPath`; init accepted it, created the directory relative to the MCP server process's cwd, and persisted that relative string into `~/.codecarto/config.yaml` for every later tool to mis-resolve. It now fails with the same `InvalidParams` error before touching the filesystem.

- **Dashboard: same-date closeouts and same-timestamp runs sort stably** (#134). The newest-first comparators returned `-1` for equal keys in both directions, which left the order of rows sharing a date implementation-defined (V8 reversed them). They now return `0` for ties, so equal keys keep their input order; the narrator's recent-closeouts pick uses the same comparator.

- **Phase-aware compaction falls back silently when the session's cwd has no workspace** (#134). The `session_before_compact` hook dereferenced `getWorkspaceState`'s null return, and the resulting `TypeError` surfaced as a "Phase-aware compaction unavailable (Cannot read properties of null…)" warning before the host default took over. The hook now returns early, as it already does for a non-phase session.

- **Publish enforces the documented confidentiality check** (#124). `docs/library-format.md` said twice that an entry's `confidentiality` (`internal` default, `shared`, `public`) is compared against the library marker's `visibility` at publish time. Nothing did: `publishEntry` never read `marker.visibility`, and `confidentiality` was declared, copied into `metadata.yaml`, and propagated into `index.yaml` without ever being checked, so an `internal` spec landed in a `public` library without a word. The comparison now runs. Levels are ordered `internal` < `shared` < `public`; a side that declares nothing counts as `internal` — the marker default `initLibrary` writes, and the entry default the format document gives — so a library with no `visibility` field accepts everything it did before, and so does every library the tooling itself initialized, since neither `codecarto_library_init` nor `/codecarto-library-init` writes anything but `internal`; only a marker edited by hand to `shared` or `public` can trip the check. Publish refuses an entry more restricted than its library (an `internal` entry into a `shared` or `public` library, a `shared` entry into a `public` one) before anything is written, ahead of the content-hash branch so a metadata-only update cannot reclassify an entry past it; entries at or above the library's level pass, and `force_new_version` does not bypass it. The refusal is a typed `ConfidentialityMismatchError` carrying both levels, so wrappers ask instead of string-matching: the Pi extension, which declares no confidentiality, catches it on `/codecarto-publish`, names the two levels, and asks whether to publish anyway — a yes is the override; MCP hosts opt in with `allow_confidentiality_mismatch` on `codecarto_publish` (`allowConfidentialityMismatch` in `PublishOptions`). The override permits the placement without changing the recorded `confidentiality`. The two rows in `docs/library-format.md` now describe the rule that runs, and a "Confidentiality conflicts" section sits beside the source-repo one.

- **Reindex and list report entries whose versions disagree about `source_repo`** (#148). The publish guard (#123) stops new cross-project appends, but a library written before it can already hold an entry whose history spans two codebases: `openai/whisper` and `acme/whisper` derive the same slug, so the second landed as `v2` of the first, and because the index reads only the newest version's metadata it advertised `versions: [1, 2]` under `acme/whisper` — a synthesis run reading that entry got one project's spec history presented as another's, and reindex regenerated the index cleanly and said nothing. `reindex` now reads every version's `metadata.yaml`, compares each recorded `source_repo` against the newest version's with the same normalized comparison the guard uses, and returns the disagreements as `provenance_conflicts` on its result: the entry, the repository the index advertises, and each older version with the repository it records. `codecarto_library_reindex` prints them in a labeled section and `codecarto_library_list` flags the affected entries inline; both carry the list in structured content. `index.yaml` and `INDEX.md` are unchanged — their shapes are ABI — and a version whose metadata is missing or unreadable is skipped rather than reported, the stance the guard takes. Repair is deliberately manual: splitting an entry means inventing a slug, renumbering versions, and repointing `latest`, all paths `docs/library-format.md` calls ABI, so the report tells the operator to split by hand and the framework does not. A repository that genuinely moved and was re-published with `allow_source_repo_change` leaves the same shape and is reported the same way; the history alone cannot tell the two apart.

- **`docs/library-format.md` describes the library the code writes** (#125, #126). The format document had not been re-read against `core/library.ts` since the format landed, and an external consumer following it — the document's stated audience — would have gone wrong in several places. The `latest` pointer is now documented as what it has always been: a regular file holding the version directory name on one line, never a symlink, with the resolution rules `readEntry` actually applies (a missing or malformed pointer falls back to the highest version directory; a pointer that dangles is an error; reindex never reads or repairs it). The dirty-tree flag is `source_dirty`, not `dirty`, and appears in the field table and the example. `reasoning` allows `unknown`, not `null`, and the MCP server defaults to `unknown`, not `default`. Publish is documented as the filesystem-only operation it is: neither surface runs `git add` or `git commit`, no config key enables it, and `commitPublish` is described as the embedder API it is — taking a caller-supplied message — rather than a default-on commit with a generated message. The full pass also corrected: `pipeline` values are workspace-relative paths (`workflow/pipeline-*.yaml`), not aliases; headlines are derived from the spec's System Summary on Pi and host-supplied on MCP, never LLM-generated, and Pi writes empty `tags`/`capabilities`; `agent_version` and `reasoning` are always `unknown` on Pi; `scope_tier_counts` and a non-null `mutation_source` are written by nothing; `confidentiality` and the marker's `visibility` are recorded but never compared; `publish_confirm` gates a yes/no preview on Pi, not a fill-in-the-`unknown`s step, and the MCP server ignores it; the content-hash check and `index.yaml` are computed from the highest-numbered version directory, not the pointer; `INDEX.md`'s real heading, generated line and summary line; the YAML examples now use the block-sequence, quoted-string dialect the hand-rolled parser reads (a `>` folded scalar fails to parse and a `[a, b]` flow sequence silently becomes an empty array); `schema_version` lives on the marker and `index.yaml` only; and the dashboard hints ("N unpushed commits", staleness) and the "recipe surfaced in the publish error" claim, none of which exist, are gone.

- **A run can no longer ship a claim as settled when its own record says the claim is not settlable from source** (#122). A `full-with-deep-audit` run registered `q-logit-bias-root-cause` (`kind: needs-runtime-test`, "source alone cannot determine which"), routed one of its three candidates onward, and then closed that carry-forward as `strong inference` / `fix before porting` with a one-line reshape as the fix. Runtime testing inverted it: the payload shape the client already sent worked, and the recommended shape was silently ignored. Both artifacts had validated PASS, because nothing read what the evidence and action cells *said*. Six independent gaps let it through and each is closed here. **Vocabulary, all three surfaces:** a new evidence level, `external-behavior claim` — a claim about a component outside the analyzed source tree (a server, engine, driver, third-party API, OS): how it parses a payload, what it silently ignores, version-dependent behavior; unverifiable at any read depth of this code — joins the ladder in every SKILL, pass file, template, VALIDATE.md, README, MANUAL, and the MCP quickstart. A new pre-porting action, `verify at runtime`, gives an unsettled finding an honest destination (the spec's Spike List plus a `post_pipeline` `kind: spike` entry, never a design change) and travels the whole chain: defect templates, the porting bundle's disposition cell, the porting and reimplementation-spec SKILLs, the deep-audit-synthesis guide, and the completion criteria of every pipeline that names the set. **Pairing rules** bound the action by the evidence: `open question` or `external-behavior claim` takes `verify at runtime` or `port differently` (`investigate` on maintenance pipelines), never `fix before porting` or `fix now`; `observed fact` never takes `verify at runtime`. Pass 5 now says which side implements the contract — a divergence between what this code sends and what the other side documents is an observed fact about this code, and what the other side *does* with it is an external-behavior claim. **The hedge travels with the finding:** the three defect templates gain an `## Open Questions` table (with a `Derived findings` column) so a `needs-runtime-test` question reaches the report a human and the next phase read, not only the handoff. **Quantities cite or hedge:** every number in a finding cites the file and line or command output it came from, or is marked an estimate — the same run recorded a 32.8 MB artifact as ~300 MB and a default of -20 as -5. **The re-triage duty has its counterpart** in GUIDE.md, the orchestration guide, and the mechanically surfaced orchestrator-duties prompt: when re-triage concludes a question still needs a runtime test, no finding in that phase may assert one of its candidates with a settled action. **Two new completion criteria** on every defect phase (pairing + cite-or-hedge), mirrored as validation rows. **Mechanical checks (Pi + MCP, `core/findings.ts`):** validation now parses the findings tables (header-driven — every defect template shares `| # | Location | Defect | Severity | Evidence Level | Action |`) and fails a phase whose unsettled finding carries a settled fix action; deterministic on two cells the model wrote, so it cannot wedge `--auto` on a heuristic. It is version-gated on `scaffold-version.yaml`: a workspace scaffolded before this release had no honest action to choose, so it warns instead of failing mid-run, and refreshing the scaffold makes it gating. Non-gating `NOTE:` lines flag an `observed fact` paired with `verify at runtime`, an unsettled finding with an empty Open Questions table, and — at completion — a handoff that closes a carry-forward or open question the primary output never mentions. `ValidationResult` and `CompletionResult` gain `warnings`; both surfaces render them. Stage 3 of the linked investigation (a `derives_from` link on carry-forward entries, closure evidence on `open_question_closures`, and carrying the coverage-gap ledger into the next phase's prompt) changes the handoff schema and is deliberately left for its own discussion.

### Security

- **The `@earendil-works/pi-coding-agent` peer range is now a floor, `>=0.84.0`.** The old `^0.80.10` pinned the 0.80 minor (caret on a 0.x version), so an `npm install codecartographer-pi` auto-installed pi-coding-agent 0.80.x — whose `undici` 8.x dependency carries five high-severity advisories (response desynchronization, cross-user cache disclosure, CRLF injection, cookie attribute injection: GHSA-8xcm-r25x-g524, GHSA-4cwx-7wf7-3272, GHSA-m8rv-5g2x-5cg5, GHSA-jr45-8vmc-qm54, GHSA-v3r7-h72x-cjcm) — while the user's own `pi` (0.85.x) sat outside the range. This repository was already clean through its own `undici` override, but overrides do not travel to consumers; the peer range does. pi-coding-agent 0.84.0+ depends on undici 8.9.0, past the affected `8.0.0–8.8.0` range. The lockfile moves to 0.85.1 and the suite passes against it. Consumers who see the advisory should update `@earendil-works/pi-coding-agent` (or `pi update`) — not run `npm audit fix --force`, which downgrades codecartographer-pi to 0.10.0.

## [0.17.0] — 2026-09-06

The Broad-Side round. Batch reconnaissance grew from an MCP-only tool into a first-class capability on every executable surface: a Pi command with an interactive spend gate, a `scout-first` pipeline variant that routes leads into the interactive phases under an account-for-every-lead criterion, per-lens model overrides, incremental re-scouting, and repository defaults for every run knob — plus the paper trail (README, MANUAL, MCP quickstart, served guide topic, and a reachable reading guide) that the seven feature PRs had left behind. Ships with the workspace-init isolation fix and the publish source-repo collision guard.

### Added

- **Broad-Side: per-lens model overrides** (#141). `lens_models` in `.codecarto/broadside/config.yaml` runs individual lenses on their own batch model, so a repository can spend more where it pays — a stronger model changes security and defect findings far more than it changes an architecture map — without raising the price of every lens. Each distinct model is resolved and pre-flighted independently: priced from the live catalog, refused without structured-output support, and clamped to its own completion ceiling. The submit estimate carries a model and its rates per lens (and a `mixedModels` flag), the Pi confirmation names the overridden model on each affected row so a mixed-model run cannot be approved without seeing which lens costs what, submission fires from the priced rows rather than recomputing, `run-meta.json` records `lens_models`, and collect's truncation retry re-submits on the lens's own model and ceiling instead of the run default. An override naming an unknown lens id is dropped rather than silently ignored. **No stronger default ships with this**: which model earns its price for the semantic lenses is a comparative-evaluation question on real repositories, and choosing one for every user would spend their money on our guess — compare with the `models` action and set `lens_models` yourself.
- **Broad-Side: the `scout-first` pipeline** (#139). New `workflow/pipeline-scout-first.yaml` (alias `scout-first`) is the deep-audit run with a `broadside-scout` phase in front. That phase distills a completed batch reconnaissance run into `findings/broadside-scout/scout-brief.md`: leads addressed to a specific later phase, each with the source pointer that phase starts from, plus the coverage accounting that distinguishes "the scout found nothing there" from "the scout never looked." Architecture, defect-scan-mechanical, contracts, protocols, defect-scan-semantic, and porting read the brief and carry a completion criterion requiring every lead routed to them to be confirmed against the source, dismissed with a reason, or carried forward — none may be reported as a finding on the brief's authority. `reimplementation-spec` deliberately does not read it; the porting bundle stays its compression boundary. The distillation step exists because run directories are timestamped and gitignored, so no pipeline YAML could name one as a `required_reads` path — and because deciding which leads are worth six phases' attention is judgment work, not a file copy. The scout phase never submits a batch and never spends: with no run on disk it writes an explicitly empty brief and the pipeline proceeds exactly as `full-with-deep-audit` would. A drift test pins the new variant to the deep-audit pipeline it wraps, so the two cannot diverge silently.
- **Broad-Side on the Pi extension** (#138). New `/codecarto-broadside [submit|collect|status|models] [lenses…]` with tab-completion for actions, lens names, and flags (`--incremental`, `--max-cost=N`, `--wait=SECONDS`, `--no-synthesis`, `--no-triage`, `--no-retry-truncated`, `--benchmarks`), and a live per-lens progress widget while batches poll. Two deliberate divergences from MCP: the spend decision is interactive — Pi shows the per-lens breakdown, the rates, the limit, and whether the run exceeds it, and an approval *is* the force flag — where MCP has to refuse and wait for `force: true`; and the command takes no API key argument, because a key typed into a slash command lands in the session transcript (`OPENROUTER_API_KEY` or `config.yaml` only). Like the MCP tool, it runs on a repository with no CodeCartographer workspace, and on such a repository the result renders into its own widget rather than the phase widget. `runBroadsideSubmit` grows an optional `confirm` hook that receives the pre-flight estimate after slicing and before any state write or submission; declining throws `BroadsideCancelledError` and nothing is submitted. Surfaces without a human keep the refuse-unless-force path unchanged.
- **Broad-Side: the reading guide is reachable, and the docs say the feature exists.** Broad-Side shipped across seven PRs with its user-facing paper trail lagging behind the code. `.codecarto/broadside/SKILL.md` was written but unreachable: `codecarto_skill` resolves `.codecarto/skills/<name>/SKILL.md`, so `{name: "broadside"}` returned "Unknown skill" and `codecarto_list_skills` never mentioned it. Both surfaces now serve it under the name `broadside`, exempt from the post-pipeline completion gate — a scout run is read *before* the pipeline and during it — and readable on a repository that has scout state and no workspace at all (the packaged copy answers when the workspace has none). `codecarto_list_skills` lists it apart from the post-pipeline set, and an unknown-skill error names the exemption. New `references/broadside.md` in the packaged agent skill teaches when to scout, the cost guardrails, and the leads-never-evidence rule, served as the `broadside` topic of `codecarto_guide`; the skill overview, README, MANUAL, and the MCP quickstart now cover the feature instead of leaving a single table row as its only mention.
- **Broad-Side: every run knob has a repository default** (`.codecarto/broadside/config.yaml`). `incremental`, `retry_truncated`, `include_synthesis`, `include_triage`, and `wait_seconds` were call-parameters only, so a repo could not fix its own scouting policy without restating it on every submit and collect. All five are now config keys documented alongside `model`, `api_key`, `default_lenses`, `max_cost`, and the `pricing` overrides; an explicit tool parameter always wins, and a malformed value falls back to the shipped default rather than failing a run. A test asserts the documented key set and the parsed key set are the same, so a key can no longer be documented into existence without being read.
- **`npm run smoke:broadside`** wires the existing opt-in live Broad-Side smoke script to a script name. It still skips cleanly without `OPENROUTER_API_KEY` and still spends real money when it runs.
- **Broad-Side: incremental re-scouting** (#142). Submit records the git HEAD (and dirty flag) of each run, and `incremental: true` diffs against the previous run's HEAD to scan only the modules whose files changed — unchanged modules are skipped, so recurring scouting costs O(delta) instead of O(repo). Falls back to a full scan on a dirty tree, a non-git tree, or when no prior run exists. Repo-info lenses (architecture) always run.
- **Broad-Side: zero-config slicing** (#140). The defect, conventions, and porting lenses now slice by `auto` instead of always per-directory: a repo whose matching files fit within the lens's char cap collapses to a single whole-repo slice (one request instead of one per module), while a repo too large for one slice still splits by top-level directory. Small repos stop paying for per-module request overhead; large repos keep full coverage. The decision is deterministic from file sizes and recorded implicitly in the slice layout.
- **Broad-Side: truncated slices re-submit automatically** (#133). Submit now persists every request body to `.codecarto/broadside/<run>/requests.json`, and collect re-submits each truncated result once with a doubled output cap (bounded by the model's completion ceiling) — recovering coverage lost to a `max_tokens` cutoff instead of leaving the module silently unscouted. Recovered slices rewrite their JSON/markdown, clear their truncation flag, and report in the collect summary (`↻ N recovered`); anything still truncated after the retry stays flagged. Opt out with `retry_truncated: false` on collect.
- **Broad-Side: per-language lens prompts** (#137). The defect and conventions lenses now build their system prompts from a language profile (Go, Python, Rust, TypeScript/JavaScript, plus a neutral default) instead of hardcoding Go idioms — a Python scanner no longer hears "goroutines without ctx"; it hears bare-except and context-manager checks. Convention extraction names language-appropriate categories (crates/modules vs modules/packages) and idiom hints. Language detection gains a `.js` bucket so JavaScript repos resolve to the TypeScript profile. Schemas are unchanged, so synthesis is unaffected.
- **Broad-Side: lens batches poll concurrently** (#136). Collect previously polled one lens at a time to completion, so the slowest lens serialized the wall clock for lenses that had already finished server-side. In-flight batches now poll in parallel against one shared deadline via the new `pollBatchesConcurrently` helper, with progress callbacks tagged per lens; results still save in deterministic lens order. The poll interval is now injectable, which the new peak-concurrency regression tests use to prove the parallelism without timing flakiness.
- **Broad-Side: batch reconnaissance over the OpenRouter Batch API** (#144). New `codecarto_broadside` MCP tool (actions: `submit`, `collect`, `status`) fires six single-turn analysis lenses — architecture, API surface, security, mechanical defect scan, convention extraction, porting — at any git repository as asynchronous batch jobs on a cheap batch model (~50% of sync pricing, unattended, 24h window), slices large modules by top-level directory, saves JSON plus rendered markdown to `.codecarto/broadside/<run>/`, and optionally synthesizes a cross-lens executive report. Works without an initialized workspace; needs an OpenRouter key via the `api_key` parameter, `OPENROUTER_API_KEY`, or `.codecarto/broadside/config.yaml`. Broad-Side findings are explicitly unverified scouting signals — file:line leads for the interactive pipeline to confirm, never evidence themselves. `codecarto_init` tolerates a `.codecarto/` that holds only `broadside/` (no force/backup needed), and scaffold refresh never touches broadside state, config, or results.
- **Broad-Side: expense guardrails and live per-model pricing** (#144). `config.yaml` now accepts `model`, `max_cost`, and `pricing.input_per_m`/`output_per_m` overrides, and the MCP tool accepts `max_cost` and `force` parameters. Before submitting, Broad-Side estimates the run cost from collected file sizes (≈4 chars/token) against the configured model's per-token pricing — looked up live from OpenRouter's model catalog (cached 24h), so models like `openai/gpt-5.2-pro:batch` at ~$84/M output are priced correctly, not at the default model's rates. A submit whose estimate exceeds `max_cost` refuses with a per-lens breakdown and creates no run entry unless `force: true`. The submit response now reports the pricing used and its source (built-in/config/live/cache).
- **Broad-Side: model catalog action and capability pre-flight** (#144). New `models` action lists every `:batch` model on OpenRouter — pricing per million tokens, context window, completion ceiling, structured-output support, and optional Artificial Analysis coding indices (via `GET /api/v1/benchmarks`, attribution preserved) — cheapest first with the configured model marked. Submits now pre-flight the chosen model against that catalog: lens `max_tokens` clamps to the provider's completion ceiling, deprecated models are flagged, and models that do not advertise structured-output support are refused outright, since every lens depends on `json_schema` response_format. The catalog cache is shared between the `models` action and submit-time pricing resolution.
- **Broad-Side: truncation detection with fence-tolerant parsing** (#144, #133). Lens output is now parsed tolerantly — markdown code fences are stripped before JSON parsing, mirroring the tolerance in OpenRouter's headless-agent scaffold. Parseable output is saved as clean JSON; output that still does not parse (the signature of a `max_tokens` cutoff) is saved verbatim but marked `truncated`. The collect summary and `run-meta.json` report truncation counts, and the synthesis prompt is told which modules are unrepresented rather than clean. Also documented the retry-safety invariant (batch requests are pure, resubmission always safe) and the distinction between Broad-Side's pre-flight `max_cost` estimate and OpenRouter's runtime cost accounting.
- **Broad-Side: triage pass** (#144, #135). Collect now runs a second cross-lens post-pass alongside synthesis (skip with `include_triage: false`): every finding is scored by impact × fix difficulty and turned into a prioritized work order — P0–P3 priority, effort estimate, per-module grouping, deduplicated leads, and explicit `omitted` notes for dropped items — saved as `triage.json`/`triage.md` and surfaced in the collect summary. The triage prompt frames the queue as a starting point for re-verification, never a commitment. Both post-passes submit as separate batches together and poll independently, and the state file tracks each so a resumed collect can finish whichever is still pending.

### Fixed

- **A new workspace no longer inherits CodeCartographer's own Broad-Side scan state.** The same defect the workspace-init isolation fix closed for the orchestrator files, one directory over: this repository's `.codecarto/broadside/` holds gitignored machine-local state (`state.json`, timestamped run directories with real scan output) next to the two shipped template files, and init copied the directory wholesale — so initializing from a local checkout with live scan state handed the new workspace another project's runs, and `codecarto_broadside {action: "status"}` reported them as its own. The init filter now keeps only `SKILL.md` and `config.yaml` under `broadside/`, mirroring the carve-out `.codecarto/.gitignore` makes for the repository itself, and `package.json`'s `files` array negates `broadside/**` the same way it negates `closeouts/**`, so a tarball packed from a dirty checkout cannot transport scan state either. Found by the v0.17.0 pre-tag surface verification.
- **A new workspace no longer inherits CodeCartographer's own project state.** This repository's `.codecarto/` is two things at once: the template copied into a user's repo, and CodeCartographer's live workspace. Init copied it wholesale, so every new workspace started with ~40 KB of another project's history presented as its own — a 15 KB backlog of framework deferrals, a thread log with the framework's entries, and a closeout from a session where CodeCartographer analyzed itself. The damage was not only clutter: GUIDE.md keys First-Time Project Setup on `closeouts/` being empty, so the shipped closeout told every new session it was *not* the first to touch the project, suppressing the orchestrator role that #97/#98 made the default. Init now copies through a filter that skips the four orchestrator files and the contents of `closeouts/` (the directory is still created, empty), then seeds `BACKLOG.md` and `THREAD_LOG.md` from new templates alongside `CONVENTIONS.md` and `DECISIONS.md`. The one-off `CHANGELOG-2026-05-02-feedback-pass.md` moved to `docs/`, where framework history belongs. Existing workspaces are untouched — refresh already treated all four files as user-owned. Template backlog items B16 and B17 ship with it: `templates/backlog-project.md` carries the entry shape (rationale, raised-by, preconditions, smallest viable form), GUIDE.md distinguishes the project backlog from the framework's, and the spec-delta SKILL states that DEFER goes to BACKLOG.md with no `D` number while a refinement made during APPLY is a decision.
- **Windows: `writeLibraryConfig` no longer ENOENTs on parentless paths** (#128). The hand-rolled `includes("/")` separator check treated every Windows path as a bare filename, leaving `mkdir` a no-op before the write failed. Now derives the parent directory with `dirname()`.
- **`isWithinPath` accepts subpaths of filesystem roots** (#130). Appending a separator to an already-terminated root (`/` → `//`, `C:\` → `C:\\`) produced a prefix no real path starts with, rejecting every legitimate subpath. Trailing separators are now respected before prefixing.
- **`acquireLock` closes the lock descriptor when `writeFile` throws** (#131). A non-EEXIST write failure previously leaked the file handle until GC.
- **Phase continuation no longer burns the full compaction settle timeout** (#129). When a phase run ends without a compaction event, the pending compaction promise is now settled with `false`, so `waitForCompaction` returns immediately instead of waiting out `COMPACTION_SETTLE_TIMEOUT_MS` on every continuation.
- **Completion re-validates under the status lock** (#132). `completeValidatedPhase` now re-runs `validatePhaseOutput` inside the atomic status update; a stale PASS whose output changed since the caller's validation refuses to complete (and leaves status untouched) instead of completing a phase on evidence that no longer holds. Validations that never touched a file on disk (no `outputPath`) keep the legacy path, matching the synthetic-validation contract in unit tests.
- **Publish refuses to append one project's spec to another project's history** (#123). Slugs derive from the trailing path segment of `source_repo`, so `acme/whisper` and `openai/whisper` both produce `whisper`. Publishing the second wrote it as `v2` of the first: the entry's version history then spanned two unrelated codebases, and because `index.yaml` carries only the newest version's metadata, the index attributed the whole entry to whichever repo published last. `publishEntry` now compares the incoming `source_repo` against the one recorded on the newest version and fails before writing anything. The comparison is normalized across scheme, embedded credentials (`git@`, `user:token@`), `git@host:path` SCP syntax, a default port, a `www.` prefix, a trailing `.git`, repeated and trailing slashes, and separators, so re-publishing the same repository spelled differently is unaffected. A non-default port still distinguishes two services on one host. Casing is folded for hosts, forge-served repository paths and Windows drive paths, but not for absolute POSIX paths, where `/srv/Repos/tool` and `/srv/repos/tool` are two directories — Pi records the analyzed directory as `source_repo`, so local paths are the common shape on that surface. It is checked ahead of the content-hash branch, because a metadata-only update overwrote the wrong entry just as quietly. Unreadable or malformed recorded metadata skips the check rather than blocking the publish. `force_new_version` does not bypass it. A genuine repository move opts out with `allow_source_repo_change` (`allowSourceRepoChange` in `PublishOptions`). `docs/library-format.md` previously promised auto-suffixing (`-2`, `-3`) for this case, which was never implemented; it now documents the refusal instead.

## [0.16.0] — 2026-08-17

The field-test round. Immediately after 0.15.0 shipped, the same 7-phase deepseek-harness analysis was re-run on a fresh worktree through the published binary — this time with the driving chat as orchestrator — and the run's own gaps became this release (#111–#114): the very first completion appended decision rows without their promised heading, both full runs ended with no dashboard ever rendered, the analysis→publish→synthesis library loop was unreachable from any served text, and the terminal completion message named nothing actionable while skills, amendments, a publishable spec, and the usage log all sat unused.

### Fixed

- **Orchestrator-file headings are detected as visible lines, not substrings** (#111, #115). The decisions template *mentions* `## Completion log` in running prose, so the raw `includes()` presence check never inserted the real heading and `D<NNN>` rows glued to the template's closing sentence. All three heading-sensitive sites now share a line-anchored, comment-stripped check, and `countPendingProposals` counts bullets only below the real heading line so a prose mention cannot open the section early.

### Added

- **The dashboard regenerates on completion and amendment** (#112, #116). `codecarto_complete` and `codecarto_amend` refresh `.codecarto/dashboard.html` best-effort — exactly the two operations that change the numbers it shows. `writeDashboard` now reports whether a fresh render actually landed, results only claim refreshes that happened, a blocked dashboard path never fails the triggering operation, and the explicit `codecarto_dashboard` tool fails loud instead of claiming success over a swallowed render failure.
- **The library loop is discoverable** (#113, #117). New `library` guide topic covering the library anatomy, all four tools (`codecarto_library_init`, `codecarto_publish` with its content-hash idempotence and provenance fields, `codecarto_library_list`, `codecarto_library_reindex`), the publish moment at pipeline completion, and the distinction from the product-repo snapshot flow; the served overview now states the publish step where rewrites are discussed.
- **The terminal boundary routes to the post-pipeline surfaces** (#114, #118). Completing the last phase now writes dynamic `next_actions`: the skills surface always, `codecarto_amend` with live open-question/post-pipeline counts when work is pending, `codecarto_publish` when the pipeline produced a reimplementation-spec, and the dashboard/usage surfaces. `applyAmendment` rebuilds the list after closures so stored status never shows stale counts, and `codecarto_status`'s text view renders every stored action instead of only the first (#119). Previously one static sentence ("Review findings…") dead-ended every completed pipeline.

## [0.15.0] — 2026-08-17

The orchestrator round. A real 7-phase MCP-driven run (deepseek-harness) followed the workspace GUIDE's first-run role interview, correctly declined the orchestrator role — its user had asked one chat to drive every phase, which the old role definition forbade — and spent the whole pipeline in "degraded no-orchestrator mode": ~12 proposed conventions and 23 decisions stranded in closeout prose, a declared secondary output silently dropped, a mislabeled open question carrying a false premise through four phases into a wrong high-severity finding, four post-pipeline resolutions with no way to reach `status.yaml`, and a usage log reporting zero runs. Every change below is one of those failures made structurally impossible or mechanically visible (#97–#102).

### Changed

- **The orchestrator is defined by duties, not by who executes phases** (#97, #103). The workspace GUIDE's role model — orchestrator never executes phases, first-run role interview, human-paste thread mediation — contradicted the served skill's own role table and was written for the Pi sub-agent workflow, never updated for the MCP single-chat reality. The driving chat now IS the orchestrator by default; execution strategy (inline vs delegated) is orthogonal; the first-run interview is gone; "degraded no-orchestrator mode" is renamed the session-by-session fallback and reserved for explicit user opt-out or a model that cannot hold cross-phase context. New `orchestration` guide topic documents the duties and the four-phase label-propagation failure that motivates them.
- The maintainer release process now requires driving one real phase through each client surface — Pi, Claude Code, Codex, Hermes — against merged `main` before pushing a tag, pasting the actual tool returns into the release PR rather than checking a box. Added `docs/client-surfaces.md` recording how each surface reaches the framework and which MCP result field each client reads, with Codex's behavior marked unverified. Prompted by #94, which shipped a `codecarto_next` returning no phase prompt in one client and survived four releases because every test read the payload from the field the tests themselves chose.
- `buildPhasePrompt`'s `auto: true` may now differ from the interactive prompt by exactly one line on any phase (the orchestrator-duties header); previously auto was byte-identical outside the reimplementation-spec hook.

### Added

- **Mechanized orchestrator loop** (#98, #104). Handoffs gain optional `proposed_conventions` (`{name, rule, evidence?}`; malformed entries fail completion). Completion appends `decisions` to `DECISIONS.md` as numbered `D<NNN>` rows under `## Completion log` (numbering shared with curated categories, comment examples excluded, idempotent) and stages proposals in `CONVENTIONS.md` under `## Pending proposals` — promotion stays an orchestrator judgment. Phase prompts carry an "Orchestrator duties" block: pending-proposal count, open questions whose kind warrants label re-triage, the phase's declared secondary outputs with exists/missing status, and the contradiction-sweep instruction. Completion results carry an "Orchestrator checkpoint" line. `codecarto_init` and `/codecarto-init` seed `CONVENTIONS.md`/`DECISIONS.md`.
- **`codecarto_amend`** (#99, #105) — post-pipeline amendments from `scratch/amendments/<slug>.yaml`: close open questions resolved on evidence and retire finished `post_pipeline` items, under the completion lock, with an amendment closeout and THREAD_LOG entry. Refused while the pipeline is incomplete; idempotent on re-run. Ships `templates/amendment.yaml`; the spec-delta skill's closeout step now ends with the tool call. Template BACKLOG item B2.
- **`codecarto_refresh_scaffold`** (#102, #108, #109) — the executable form of the action every scaffold-staleness notice instructs: refresh framework-owned files from the packaged template without touching project state, user config, session outputs, or the orchestrator files. Both staleness notices now name the tool. Previously the only scaffold writer was `codecarto_init force:true`, which backs up the entire workspace.
- **MCP-driven runs reach the usage log** (#100, #106). `codecarto_complete` appends a completion receipt (`recorded_by: "mcp-complete"`, zeroed counters — MCP hosts execute phases in their own context and report no tokens); Pi-runner entries are tagged `pi-runner`; `codecarto_usage` says how many runs carry no token data so zeros read as unknowns, not free runs. Previously a fully completed 7-phase MCP run reported "No phase runs recorded yet."
- **Spike template and declared-output visibility** (#101, #107). `templates/spike-report.md` (Goal / Method / Measurements / Findings / Recommended Deltas) with the `scratch/spikes/<spike-id>/<scenario>.md` convention — template BACKLOG item B1 in its recorded smallest viable form. `codecarto_validate` gains a non-gating NOTE naming declared-but-unwritten secondary outputs (`ValidationResult.secondaryOutputs`).

## [0.14.1] — 2026-08-16

### Fixed

- Tools whose payload is prose returned nothing usable to MCP clients that read `structuredContent` in preference to `content` (#94). `codecarto_next` returned `{phase, forced}` and no phase prompt, making the pipeline undriveable in such a client; `codecarto_phase`, `codecarto_skill`, `codecarto_vision`, and `codecarto_guide` were affected the same way. `textResult` now carries the rendered text in `structuredContent` under a `text` key, so both client styles receive the payload. Tools whose `structuredContent` already carried their data (`codecarto_status`, `codecarto_validate`, `codecarto_complete`, the library operations) were unaffected and are unchanged apart from the added key.
- Four of the five predate 0.14.0. The existing gates could not see it: the smoke test and the unit tests both read `content[0].text` directly, so they confirm the payload exists without confirming it survives a client that reads the other field. A new test walks each tool's result and asserts the payload is reachable from `structuredContent` alone.

## [0.14.0] — 2026-08-16

### Added

- Agent skill for driving the server, shipped in the package at `agent-skill/codecartographer/` (SKILL.md plus references for pipeline selection, executor choice, the handoff contract, and phase recovery). Copy it into `~/.claude/skills/`, `~/.hermes/skills/`, or wherever your agent loads skills.
- Three further references covering what to do with a completed run, generalized from patterns proven in a third-party integration: `deep-audit-synthesis.md` (defect dispositions as porting inputs, hazards converted into normative rules and acceptance tests, reporting shape), `kernel-first-rewrite.md` (strategic-assumption classification, the kernel/ports/adapters/extensions ring model, fake-driven acceptance harness before adapters, milestone ordering), and `carrying-results-forward.md` (starting implementation from a completed spec, autonomy boundaries, and publishing a curated `docs/codecarto/` snapshot instead of the raw workspace).
- `codecarto_guide` MCP tool serving that same skill, so an agent with the server configured can learn the drive loop without installing anything. Takes an optional `topic`; every response lists the others. It needs no workspace — call it before `codecarto_init`.

### Changed

- `docs/mcp-quickstart.md` Step 3 now includes writing the phase handoff, which the canonical flow had omitted since v0.12.0, and points integrators at `codecarto_guide`.

### Why

Integrations were reverse-engineering the drive loop from tool descriptions because no specification shipped. At least one documented writing and repairing `workflow/status.yaml` directly and never mentioned `scratch/handoffs/<phase>.yaml` — guidance that fails outright against the v0.13.0 completion gate. The guide makes the contract explicit and versioned alongside the code that enforces it.

## [0.13.0] — 2026-08-16

### Security

- MCP `codecarto_publish` arbitrary file read via `spec_path`, second path (#76, PR #79). The v0.12.11 fix skipped its containment check when `allowedRoots` resolved empty, leaving the same arbitrary-read reachable in that configuration. Containment is now mandatory: an empty root set rejects rather than permits. Merged 2026-08-03, after v0.12.11 was tagged on 2026-07-23, and unreleased until now.
- Cleared four dependency advisories, including high-severity `undici` (response desynchronization, cache-directive disclosure, CRLF injection) and `ip-address` (SSRF and trust-boundary bypass via leading-zero octets, CIDR suffixes, and IPv4-mapped IPv6), by overriding `undici` to a patched 8.x (PR #82). `npm audit --omit=dev` reports zero vulnerabilities.

### Added

- Stale-scaffold detection (#85). The template now ships `workflow/scaffold-version.yaml`, stamped with the releasing version and asserted against `package.json` by the release-metadata tests. `codecarto_status` (MCP), the Pi status line, and the phase prompt warn when a workspace's scaffold has no marker (pre-marker scaffolds may predate the v0.12.0 handoff contract), is older than the running framework, or is newer than it. The phase prompt also stops listing `templates/phase-handoff.yaml` as a required read when the file is missing and instead warns that the scaffold predates the handoff contract, naming the handoff path completion will require and the framework-owned files to refresh. Warn-only: unversioned workspaces keep working.

### Changed

- The framework-owned-state invariant test now scans every instruction file a session reads — `templates/*.md`, `findings/*/SKILL.md`, `skills/*/SKILL.md`, `VALIDATE.md`, `GUIDE.md`, `NEW_THREAD_BLURB.md`, and `CONTRIBUTING.md` — instead of only the pipeline YAMLs and `NEW_THREAD_BLURB.md`. It matches both `status.yaml` and `workflow/status.yaml`, skips negated forms so prohibitions read naturally, and exempts post-pipeline skills from the `THREAD_LOG.md` rule (they never reach `completeValidatedPhase`, so they do own their closeout).

### Fixed

- The pre-v0.12.0 "write it into `status.yaml` yourself" wording survived #83 in the files a session reads while producing output: all five phase output templates, `closeout-template.md`, `thread-log-entry-template.md`, `VALIDATE.md` (including its worked PARTIAL example), `GUIDE.md`, and two SKILL.md files (#89). `templates/mechanical-defects.md` was the proximate cause of the routing loss reported in #84 — a real run echoed its "Mirror these into status.yaml" sentence into a validation Evidence cell and produced a prose table instead of state. All twelve sites now route through the phase handoff, `VALIDATE.md`'s worked example shows the handoff YAML and the `carry_forward_closures` closure path, and `thread-log-entry-template.md` documents what completion produces plus how to write a useful `closeout_summary`. Reads of `status.yaml` are unchanged.
- Shipped pipeline `handoff_requirements` still instructed agents to `Update workflow/status.yaml.` and `Append a summary entry to THREAD_LOG.md.` — the two edits the v0.12.0 handoff contract forbids, rendered into the same phase prompt that forbids them (#83). All 24 stale triplets across the six phase pipelines now route state through `scratch/handoffs/<phase>.yaml`, the deep-audit routing criterion targets the phase handoff instead of `status.yaml`, and `NEW_THREAD_BLURB.md` is rewritten to the handoff contract. A pipeline invariant test guards against the pre-v0.12.0 wording resurfacing.
- `completeValidatedPhase` silently completed phases with `carry_forward: []` and no agent-supplied `open_questions` when `scratch/handoffs/<phase>.yaml` was absent, even for phases whose pipeline declares `handoff_requirements` — severing the cross-phase routing channel for an entire run without a trace (#84). Completion now refuses with an actionable error naming the expected handoff path and minimal shape. Phases without `handoff_requirements` keep the lenient path, so custom pipelines are unaffected.
## [0.12.11] — 2026-07-23

### Fixed

- MCP `codecarto_publish` arbitrary file read via `spec_path` (security). The `readSpecArg` function accepted any absolute file path for `spec_path` without enforcing containment, allowing an MCP client to read any file on the filesystem (e.g. `/etc/passwd`). Added path containment check using `isWithinPathResolved`: `spec_path` must be within the workspace `.codecarto/` directory or the configured library path. Regression tests verify both rejection of paths outside allowed roots and acceptance of paths within the workspace. Discovered during the v0.12.9 self-analysis case study security triage.

## [0.12.10] — 2026-07-23

### Fixed

- Symlink sandbox bypass in `isWithinPath` (security). The Pi extension's tool-call sandbox used lexical path comparison (`resolve()`) without resolving symlinks, allowing a sub-agent to create a symlink inside `.codecarto/` pointing to a file outside the allowed root and write through it. Added `isWithinPathResolved` which uses `realpath` before comparison, and updated the Pi tool-call hook to use it. Regression tests verify both the vulnerability (documented) and the fix. Discovered during the v0.12.9 self-analysis case study, independently confirmed, and fixed with regression coverage.

## [0.12.9] — 2026-07-23

### Fixed

- Smoke test now includes all 18 MCP tools in EXPECTED_TOOLS, fixing the CI release workflow that was stuck at the smoke-test step since v0.12.5. The previous hardcoded list only had 10 tools and used `assert.deepEqual`, causing a hard failure when the server returned additional tools.

## [0.12.8] — 2026-07-23

### Added

- MCP `codecarto_open` tool — activate existing workspace without resetting state (parity with Pi `/codecarto-open`).
- MCP `codecarto_usage` tool — cumulative and per-phase token usage telemetry (parity with Pi `/codecarto-usage`).
- MCP `codecarto_dashboard` tool — regenerate `.codecarto/dashboard.html` (parity with Pi `/codecarto-dashboard`).
- MCP `codecarto_list_skills` tool — list available post-pipeline skills (parity with Pi `/codecarto-skill` with no args).

## [0.12.7] — 2026-07-23

### Added

- `/codecarto-vision` (Pi) and `codecarto_vision` (MCP) command to run a guided product discovery interview before the synthesis pipeline. A new `INTERVIEW.md` skill in `findings/vision-capture/` guides the LLM through structured questions (audience, problem, outcomes, scope, constraints, success measures) and writes a rich brief to `inputs/vision.md`. The Pi version is interactive (conducted in the orchestrator chat); the MCP version takes raw text and returns a prompt for the host's agent.

## [0.12.6] — 2026-07-23

### Added

- `/codecarto-library-init <path> [--namespace <name>]` (Pi) and `codecarto_library_init` (MCP) command to initialize a CodeCartographer library: creates the directory, writes the `.codecarto-library` marker, and writes the config. Idempotent — safe to re-run on an existing library. Closes the first-publish dead end.
- `/codecarto-config` (Pi) and `codecarto_config` (MCP) command to show the effective merged configuration (library.path, namespace, publish_confirm, llm_steer_next_phase) and whether the library marker was found.

## [0.12.5] — 2026-07-23

### Added

- `/codecarto-switch-pipeline <variant>` (Pi) and `codecarto_switch_pipeline` (MCP) command to switch the active pipeline in-place without losing findings, handoffs, usage data, closeouts, or phase progress. Phases that exist in both the old and new pipelines preserve their completion status. Replaces the README's broken advice to hand-edit `status.yaml`.

### Changed

- README pipeline switching instructions now point to the new command instead of telling users to hand-edit the framework-owned `status.yaml`.

## [0.12.4] — 2026-07-23

### Fixed

- MCP server handshake now reports `PACKAGE_VERSION` instead of a hardcoded stale `0.2.0` string that hadn't been updated since early development.
- `/codecarto-init` on an existing workspace now backs up the old `.codecarto/` to `.codecarto-backup-TIMESTAMP/` instead of permanently deleting it with `rm -rf`. The confirmation dialog now explicitly warns about data loss and suggests `/codecarto-open` as a non-destructive alternative. The MCP `codecarto_init` tool with `force: true` also backs up instead of deleting, and its tool description now enumerates what is affected.
- Synthesis preflight error messages now include actionable remediation guidance: the missing-vision error references `templates/vision.md`, the missing-library error includes an example config and marker JSON, the empty-library error names the commands to run, and the confirmed-selection error names the file to edit.

### Changed

- `/codecarto-publish` error messages for missing or misconfigured library now mention the required `.codecarto-library` marker file, not just the config path.

## [0.12.3] — 2026-07-22

### Fixed

- Single-shot `/codecarto-next` (without `--auto`) now auto-validates and auto-completes the phase after the sub-agent finishes, instead of leaving `status.yaml` stuck at `pending` and requiring the user to manually run `/codecarto-validate` then `/codecarto-complete`. The `--auto` loop already did this; the single-shot path now matches.

## [0.12.2] — 2026-07-22

### Fixed

- Corrected the case-sensitive MCP Registry namespace to match the GitHub organization owner grant, keeping `package.json`, `server.json`, and the README aligned.

## [0.12.1] — 2026-07-22

### Added

- Official MCP Registry metadata and release invariants that keep the registry server name, npm package, stdio transport, binary, version, and discoverability keywords aligned.

### Changed

- Repositioned the npm package and README around both evidence-backed reverse engineering and human-gated forward synthesis instead of describing the package as a Pi-only workflow wrapper.
- Added MCP, software-planning, code-analysis, and synthesis discovery metadata for the npm and MCP ecosystems.
- Removed stale README language that described the shipped library and synthesis workflows as development-branch or upcoming functionality.

## [0.12.0] — 2026-07-21

### Added

- Four-phase forward synthesis workflow (`vision-capture` → `goal-synthesis-propose` → `spec-merge` → `goal-synthesis-finalize`) for turning a product vision and reusable library specs into an implementation-ready `project-plan.md`.
- Runtime preflight gates shared by Pi and MCP: synthesis requires a completed vision brief and a valid non-empty library, while merge and finalization refuse to start until a user explicitly checks at least one proposal entry.
- Provenance ledger, conflict register, normalized merge artifact, synthesis templates, phase skills, and cross-surface regression tests.
- Structured per-phase handoffs under `.codecarto/scratch/handoffs/` for owner notes, questions, routed work, closure IDs, decisions, and closeout content.
- Status schema versioning with migration for v0.11 workspaces and rejection of unsupported future schemas.

### Changed

- Phase completion now owns canonical `status.yaml`, closeout, and `THREAD_LOG.md` updates, uses host-generated timestamps, rejects malformed handoffs and duplicate YAML keys, and remains idempotent across retries.
- Carry-forward targets are now limited to real downstream pipeline phases; optional spikes, amendments, deltas, decisions, and reruns live in a distinct `post_pipeline` backlog shown separately by status and the dashboard.
- Open questions now support canonical IDs (auto-assigned if missing), cross-phase deduplication by ID, and `open_question_closures` to atomically remove resolved questions from all phases during completion.

### Planned

- Dashboard library-state surfacing.
- `pipeline-spec-mutate.yaml` for applying deltas to an existing spec and republishing it as a new library version.

## [0.11.0] — 2026-07-20

### Added

- Phase-aware Pi compaction for isolated CodeCartographer phase sessions, with atomic continuation checkpoints under `.codecarto/scratch/checkpoints/`.
- Pi `/codecarto-open` command for safely attaching a new orchestrator session to an existing workspace without resetting phase progress.
- Backward-compatible compaction telemetry in local usage records, `/codecarto-usage`, phase summaries, the live widget, and the dashboard.
- Explicit `Coverage and limits` accounting in every phase template and completion rubric.
- Pipeline invariant tests that pin coverage accounting and the porting bundle's role as the final synthesis compression boundary.

### Changed

- `reimplementation-spec` now reads the porting bundle by default and deep-reads lower-level findings only for named gaps, conflicts, missing acceptance detail, or defect rationale.
- The porting bundle now includes a source index, targeted deep-read triggers, and explicit defect design consequences.
- Raised the Pi peer requirement to `^0.80.10`, migrated child-session construction to the current SDK, and refreshed transitive dependencies to patched Hono, Undici, and protobufjs releases.
- Updated GitHub Actions to Node 24-native action releases and added a high-severity production dependency audit gate.

### Fixed

- Packed-package MCP smoke tests now ignore lifecycle scripts and sanitize inherited npm `allow-scripts` configuration.
- Explicitly loaded phase-resilience and write-boundary guards into isolated child sessions, preserving phase-aware summaries, checkpoints, and read-only source safety when CodeCartographer itself was loaded with `pi -e`.
- Phase runners now retain telemetry during delayed post-tool compaction and recover runs that stop before their required output, using the durable checkpoint when compaction occurred.
- Declared primary-output checks reject path traversal and symlink escapes outside `.codecarto/`.

### Tests

- Test count: **191 → 207**.
- Added regression coverage for phase compaction, checkpoints, interrupted provider runs, nondestructive workspace recovery, output-path containment, coverage accounting, and bundle-first final synthesis.

## [0.10.0] — 2026-05-28

### Added

- **Polished dashboard health summary.** The generated `.codecarto/dashboard.html`
  now opens with a higher-signal Pipeline Health panel that summarizes overall
  status, phase completion, artifact gaps, open questions, carry-forward items,
  tool uses, runtime, and token availability before the detailed phase cards.
- **Dashboard issue surfacing.** Completed phases whose required primary output
  is missing are promoted into an attention-required health issue instead of
  being buried in the phase details.

### Changed

- **Token accounting now distinguishes unavailable data from zero usage.** When
  local usage records do not include token counts, the dashboard reports tokens
  as `unavailable` rather than showing a misleading numeric total.
- **Completed pipeline labels are friendlier.** `current_phase: complete` now
  renders as `Pipeline complete` in dashboard header metadata.
- **Activity and usage presentation is clearer.** The activity timeline and usage
  panels now include stronger visual grouping, kind chips, and summary cues while
  preserving the self-contained static HTML/no-network/no-framework contract.

### Tests

- Test count: **190 → 191**.
- Added dashboard regression coverage for health-panel missing-output escalation
  and completed-pipeline label rendering.

## [0.9.1] — 2026-05-25

### Fixed

- **Pi overlay is no longer always-on for repositories that already contain `.codecarto/`.** The CodeCartographer status widget, session label, safe-tool mode, and read-only tool policy now activate only after `/codecarto-init` runs in the current Pi session instead of auto-enabling on `session_start` whenever `.codecarto/workflow/status.yaml` exists.

### Tests

- Test count: **187 → 190**.
- Added regression coverage for Pi overlay activation gating.

## [0.9.0] — 2026-05-25

### Added

- **MCP library tools.** Three new tools on the MCP server expose the
  `core/library.ts` primitives to any MCP-capable host (Claude Code, Codex,
  opencode, Cursor, Claude Desktop):
  - `codecarto_publish` — publish a `reimplementation-spec.md` to a library
    with content-hash idempotence. Accepts inline `spec` or absolute
    `spec_path`. Derives the slug from `source_repo` if not provided. Defaults
    `pipeline` and `namespace` from `cwd`'s `status.yaml` / `config.yaml` when
    available. Accepts an optional `model_metadata` object so the host can
    record which agent + model produced the spec; omitted fields default to
    `unknown` and `generation.surface` is always `mcp-server`. Required:
    `source_repo`, `headline`, and either `spec` or `spec_path`.
  - `codecarto_library_list` — list library entries with optional filters
    (`namespace`, `tag`, `slug`, `source_repo`). Returns the full
    `LibraryIndexEntry` array in `structuredContent`.
  - `codecarto_library_reindex` — regenerate `index.yaml` + `INDEX.md`
    explicitly (useful after manual edits or to resolve a git merge conflict
    on `index.yaml`).
  All three tools resolve the library either from an explicit absolute
  `library_path` argument or from `library.path` in the workspace's or
  user-global `config.yaml`. 18 tests in `tests/mcp-library.test.mjs` cover
  derived-slug publish, idempotence, content-bump v2, the `generation:` block
  (defaults + host-passed values), `spec_path` flow, missing-field rejections,
  namespacing rules, filtered listing, and reindex round-trips.
- **Library format spec.** New `docs/library-format.md` documents the on-disk
  contract for the upcoming synthesis library: `.codecarto-library` marker file,
  versioned namespaced/single-tenant entry layout, `metadata.yaml` schema with
  `generation:` block (surface / agent / agent_version / model / model_vendor /
  reasoning), derived `index.yaml` + `INDEX.md`, content-hash-based version
  increments. Marked **experimental, may break before v2**.
- **`core/library.ts` (~840 LOC).** Library helpers used by both Pi and MCP
  wrappers — `discoverLibrary`, `readMarker` / `writeMarker`, `publishEntry`
  (content-hash idempotent, atomic temp-dir-then-rename, namespacing enforced
  per marker), `readEntry` (latest or specific version), `listEntries` (filter
  by namespace / tag / slug / source_repo), `reindex` (regenerates `index.yaml`
  + `INDEX.md` from filesystem state, sorted by `(namespace, slug)`),
  `commitPublish` (optional git commit, non-fatal on missing git). Cross-platform
  `latest` pointer is a regular file (not a symlink) containing the version
  directory name. Slug validation rejects bad names and reserved names
  (`latest`, `index`, `entries`).
- **Library config block in `core/orchestrator-config.ts`.** `CodecartoConfig`
  gains a `library:` section (`path`, `namespace`, `publish_confirm`). Two
  config layers now load: user-global at `~/.codecarto/config.yaml` (new) and
  per-workspace at `.codecarto/workflow/config.yaml` (existing). Resolution
  order is per-workspace > user-global > defaults. Library `path` values are
  tilde-expanded and resolved to absolute paths automatically. The existing
  `orchestrator.llm_steer_next_phase` toggle is unchanged. New
  `loadUserConfig()` reads user-global directly for onboarding flows.
- **`expandTilde` helper in `core/utils.ts`.** Expands a leading `~` or `~/`
  to the user's home directory. Used by the config loader; promoted to
  `core/utils.ts` so future user-facing path inputs can normalize the same way.
- **Surface-priority reframe in README + CLAUDE.md.** README install section now
  leads with Pi (recommended) → MCP (for other coding agents) → drop-in template
  (one-off / evaluation), with explicit "when to use this" framing per surface
  and a limitation note that library + synthesis workflows require Pi or MCP.
  CLAUDE.md keeps the code-architecture "three surfaces, byte-identical phase
  prompts" invariant intact and adds a `Surface priority` subsection
  documenting the user-facing ordering for new-feature UX work. The "At a
  glance" table and "Compatible environments" matrix are updated to match.
- **Synthesis implementation tracker.** `docs/synthesis-roadmap.md` lays out
  five milestones (M0 docs → M1 library foundations → M2 surface publish UX →
  M3 synthesis phases → M4 spec-mutate → M5 release polish) with checkboxes,
  dependencies, acceptance criteria, and risk notes. The original
  `docs/design-synthesis-phases.md` is kept as the historical record of the
  pre-revision design with a pointer at the top to the roadmap.

### Fixed

- **`/codecarto-next --auto` no longer wedges at `reimplementation-spec`.** The Strategic Alignment Hook (which asks the user whether the spec should be language-agnostic or opinionated) is now suppressed under `--auto`. The sub-agent defaults to **language-agnostic** (using `templates/reimplementation-spec.md`), tags the spec front-matter with `selection: auto-default` for later traceability, and captures any unresolved stack/name/scope choices as `open_questions` entries rather than blocking the run. Interactive `/codecarto-next` and `/codecarto-phase reimplementation-spec` paths still prompt the user as before. The fix threads a new `BuildPhasePromptOptions.auto` flag through `buildPhasePrompt` (in `core/prompts.ts`), propagated from `runAuto` → `runSinglePhase` → `buildPhasePrompt`; the MCP server byte-identical-prompt invariant is preserved (MCP still calls without the flag).
- **Release smoke test now tracks the v0.9.0 MCP tool surface.** `scripts/smoke-mcp.mjs` expects the new library tools alongside the workflow tools and now exits non-zero on setup failures before the first TAP step.

### Tests

- Test count: **119 → 187**.
- Added coverage for library primitives, library config loading, MCP library tools,
  phase resolution aliases, and the auto-mode `reimplementation-spec` prompt
  behavior.

### Notes

- Library and synthesis schemas remain **experimental, may break before v2**.
- Drop-in users still get full analysis-side functionality, but library publish /
  list / reindex require MCP in v0.9.0. Pi publish UX and project-plan synthesis
  remain future work.

## [0.8.0] — 2026-05-13

### Added

- **`/codecarto-next --auto`** runs the full pipeline end-to-end without manual intervention. For each next-eligible phase the loop spawns the sub-agent, auto-validates the output, and auto-marks-complete (mirroring `/codecarto-complete`'s `PASS`/`PASS WITH GAPS` rule). It advances until the pipeline finishes, validation reports `FAIL`/`MISSING`, the sub-agent errors, or the user aborts. Re-running `--auto` after a stop resumes from `getNextEligiblePhase` — `status.yaml` is the implicit checkpoint.
- **`--strict` modifier** (requires `--auto`) flips the `PASS WITH GAPS` rule: the loop pauses on PWG and emits a recovery hint telling the user to review the gaps and run `/codecarto-complete <phase>` manually before resuming with `--auto`. Default (without `--strict`) auto-advances on PWG.
- **`--auto` composes with `--llm-steer` / `--no-llm-steer`** as independent flags. `--auto --llm-steer` runs the rewriter on every phase transition; `--auto` alone leaves steering at the workspace-config default (`orchestrator.llm_steer_next_phase`).
- **`codecarto-auto-summary` custom message type** renders the run summary in the orchestrator transcript: heading (`complete` / `stopped at <phase>` / `aborted at <phase>`), stats (`⟳ N/M phases · X tokens · wall-time`), recovery hints for the stop and abort paths, and a dashboard link + skill suggestion for the complete path. Same `display: true`, no-`triggerTurn` discipline as the existing per-phase summary.
- **Tab completion** for `/codecarto-next` now suggests `--auto` and `--strict` alongside the existing `--llm-steer` / `--no-llm-steer`.

### Internal

- New `extensions/codecarto/auto-runner.ts` (~410 LOC) — owns `runAuto`, `runSinglePhase` (the awaitable phase-execution helper now shared between the one-shot `/codecarto-next` path and the auto loop), `autoCompletePhase` (programmatic `/codecarto-complete`, no UI notifies), `buildAutoSummary` (the markdown body for the new custom message), and `decideAfterPhase` (the pure per-iteration decision function — the testable seam for the validation matrix).
- **`/codecarto-next`** handler shrinks from ~150 lines to ~30. The inline phase-spawn chain (`runPhase` + post-runner `.then`/`.catch`/`.finally`) is replaced by `void runSinglePhase(...)`, keeping the one-shot path fire-and-forget for TUI responsiveness.
- **`/codecarto-complete`** handler delegates the atomic-status update to `autoCompletePhase` and keeps the UI notifies inline.
- **`extensions/codecarto/next-flags.ts`** gains `auto` / `strict` / `error` fields and the `--strict requires --auto` validation rule.

### Fixed

- **`ctx.signal` is now threaded through `/codecarto-next` to the phase sub-agent.** Previously the one-shot path didn't pass the signal to `runPhase`, so a user-initiated abort during a phase wasn't actually delivered to the sub-agent. The refactor that extracted `runSinglePhase` corrects this for both the one-shot and the new auto paths. Mid-phase aborts now actually cancel.

### Tests

- **`tests/auto-runner.test.mjs`** (10 tests) — the `decideAfterPhase` validation-decision matrix: aborted / errored / completed × `PASS` / `PASS WITH GAPS` / `FAIL` / `MISSING` × strict-on / strict-off, plus the "completed but validation missing" guard.
- **`tests/auto-summary.test.mjs`** (7 tests) — `buildAutoSummary` covers complete / stopped / aborted paths, skill-suggestion presence/absence, validation-summary block inclusion, the FAIL vs `PASS WITH GAPS` recovery-hint branches, and tabular token/duration formatting.
- **`tests/next-flags.test.mjs`** extended (+6 tests) — `--auto`, `--auto --strict`, `--strict` alone (error), `--auto --llm-steer`, `--auto --strict --llm-steer`, unknown-flag mixed with `--auto`.

Test count: **96 → 119**.

### Notes / deferred (target 0.8.x or 0.9.0+)

- **DAG-parallel auto mode** — `getNextEligiblePhase` returns one phase; parallel needs a `getEligiblePhases` variant and concurrent `runSinglePhase` calls.
- **Retry-on-fail** — `--auto --retry-failed N` with per-phase attempt counter + backoff.
- **Budget caps** — `--max-tokens`, `--max-turns-per-phase`, `--max-wall-time`.
- **Pre-phase confirmation prompts** — `--auto --confirm`.
- **Post-pipeline auto-skill chaining** — `--auto --then-skill <name>`.

## [0.7.0] — 2026-05-13

### Added

- **HTML dashboard.** `.codecarto/dashboard.html` is regenerated on every state change — `/codecarto-init` (initial empty render), `/codecarto-next` `.then`/`.catch` callbacks (after phase success or error), and `/codecarto-complete` (after a phase is marked done). The dashboard aggregates everything a human wants to see at a glance: project header (name / pipeline / current phase / last-updated / generation timestamp / package version), a pipeline-progress strip with per-phase status badges, collapsible per-phase cards (closed for complete, open for current/running) showing outputs / open questions / carry-forward / owner notes / last-run usage, an aggregate usage panel with per-phase breakdown, an activity timeline (newest 10 visible, older inside `<details>`), an open-questions roll-up grouped by source phase, a reverse-chronological closeouts list with relative-path links, and a footer with the package version. Self-contained: embedded `<style>`, no JavaScript, no external assets; works opened directly from `file://`. Light/dark via `@media (prefers-color-scheme: dark)`. Mobile single-column collapse at `<720px`. All disk-sourced strings (phase IDs, owner notes, open-question descriptions, carry-forward `target_phase`, closeout filenames, paths in href attributes) pass through `escapeHtml`.
- **`/codecarto-dashboard` command.** Manual regenerate (useful after editing `status.yaml` by hand) plus the `--narrate` flag for the opt-in LLM executive summary. Tab-completion suggests `--narrate`.
- **`/codecarto-dashboard --narrate` — opt-in LLM-narrated executive summary.** Runs the orchestrator's model as a one-shot in-memory `AgentSession` with `tools: []` (same pattern as the 0.5.0 rewriter), reads up to 3 most recent closeouts + status + usage totals, and produces a 200-400 word Markdown summary. The summary is cached to `.codecarto/.dashboard-narration.local.md` with a YAML frontmatter recording `generatedAt` and `phaseCountAtGeneration`. Subsequent deterministic re-renders surface the cached narration with a "(N runs since)" staleness note computed from the current completed-phase count. On any failure (no closeouts, session error, empty output) toasts the skip reason and proceeds with a deterministic render — never throws, never blocks.
- **`core/dashboard.ts`** (~430 LOC, pure). `renderDashboard(inputs) → string`. No I/O. The MCP server can adopt it later without touching the renderer.
- **`extensions/codecarto/dashboard-writer.ts`** (~120 LOC). Gathers inputs (fresh workspace state, usage log, closeouts directory listing parsed against the `closeoutFileName` regex from `core/prompts.ts:116`, per-phase output existence checks, narration cache + frontmatter parse) and atomic-rename-writes to `.codecarto/dashboard.html`. Failures are swallowed — same best-effort discipline as `recordUsage`.
- **`extensions/codecarto/dashboard-narrator.ts`** (~150 LOC). Opt-in narrator session; never throws.
- **`extensions/codecarto/dashboard-flags.ts`** (~25 LOC). `parseDashboardFlags` recognizes `--narrate`; collects unknown flags for caller to surface as errors.
- **`core/workspace.ts`** exports `PACKAGE_VERSION`, read once at module load from the same `package.json` that `findPackageRoot` locates. Used by the dashboard footer.
- **`core/utils.ts`** gains `formatTokenCount` and `formatMillis`. The renderer reuses them; the extension's existing `formatUsageTokens` / `formatUsageDuration` stay in place (they have slightly different output shapes that downstream call sites depend on).
- **Template `.gitignore`** picks up `dashboard.html` and `.dashboard-narration.local.md`. Both surface data from `workflow/.usage.local.yaml` (absolute Pi session paths); committing them would transitively leak those paths.
- **10 new unit tests in `tests/dashboard.test.mjs`** covering escape coverage, empty-state markers, full-state with HTML-special owner note (XSS guard), output-link presence vs missing, carry-forward `target_phase` rendering, open-questions roll-up grouping, usage panel totals, timeline visible/overflow split, narration staleness, and closeout reverse-chronological ordering. The `default-pipeline.test.mjs` command-registration invariant now requires `dashboard` alongside the existing 8 commands. Test count: **86 → 96**.

### Notes

- **Pi-only for v1.** The dashboard is tied to the sub-agent lifecycle, which only the Pi path runs. The MCP server returns prompt text for the host to dispatch and has no per-phase state changes to react to. The renderer lives in `core/` so MCP can adopt it later (deferred to 0.8.0+) by exposing a `dashboard` tool that returns the rendered HTML — trivial wrapper, just not on the critical path.
- **Hybrid LLM strategy.** The dashboard's "facts" (token counts, paths, status badges) are always deterministic — they read from disk on every regen. The "story" is opt-in: only `/codecarto-dashboard --narrate` produces a narrative, and that narrative is cached so subsequent deterministic re-renders preserve it across phase finishes until the next `--narrate`.
- **No JavaScript.** Collapsibles use `<details>`/`<summary>`. Keeps the file diff-friendly, tamper-evident, and viewable in any browser without script execution.

### Deferred (target 0.8.0+)

- MCP `dashboard` tool — trivial wrapper on `renderDashboard` returning the HTML string.
- JS-enhanced dashboard — sortable timeline columns, filter-by-phase, live-reload via filesystem-watch script.
- Per-run drilldown pages — clicking a UsageRun row opens `dashboard-run-<timestamp>.html` with the full transcript excerpt.
- Auto-narrate-on-finish config knob (`orchestrator.dashboard_narrate_on_finish`) mirroring `llm_steer_next_phase` for users who want fresh narration on every state change at orchestrator-side token cost.

## [0.6.1] — 2026-05-09

### Fixed

- **`--llm-steer` now surfaces its customized seed prompt in the orchestrator transcript.** Previously the rewriter ran silently — the only signal that anything happened was a transient "LLM rewriter customized X seed prompt." toast — and the rewritten prompt itself was visible only by `/resume`-ing into the phase sub-agent and reading its first user message. The user couldn't tell what the rewriter chose to emphasize, what prior findings it surfaced, or whether it had hallucinated something the closeout didn't say. `/codecarto-next` now injects the full customized prompt into the orchestrator's session via `pi.sendMessage({ customType: "codecarto-steering", display: true })` whenever the rewriter succeeds. The skip path keeps using a transient toast — those cases (no prior phase, missing closeout, empty output, rewriter session error) are uninteresting and shouldn't clutter the transcript.
- New `buildSteeringMessage()` helper in `extensions/codecarto/agent-rewriter.ts` (~20 LOC). Markdown header names the next phase and the closeout source (`from \`<prevPhase>\`'s closeout`); a horizontal rule separates header from the verbatim rewritten prompt. Same `display: true`, no `triggerTurn` pattern as the phase-completion summary, so the orchestrator's LLM picks it up as context on the user's next message but doesn't auto-respond.
- `RewritePhasePromptResult` gained a `prevPhaseId` field so the message header can name the closeout source. Backward-compatible (optional field).
- 4 new unit tests in `tests/agent-rewriter.test.mjs` covering the header naming, full-prompt embedding, missing-prevPhaseId fallback, and structural format. Test count: 82 → **86**.

### Notes

- The orchestrator's LLM now sees the rewritten prompt in context on the next user turn. That's bounded (~5–15k tokens for a typical phase prompt) and is the whole point of the visibility — the orchestrator can answer "what was the rewriter looking at?" without re-reading the closeout.
- Pi's default custom-message rendering is used (no registered renderer). The TUI shows `[codecarto-steering]` followed by the formatted block, the same way `[codecarto-phase-summary]` blocks render today.

## [0.6.0] — 2026-05-08

### Added

- **Per-phase usage tracking.** `/codecarto-next` now appends a record to `.codecarto/workflow/.usage.local.yaml` every time a phase sub-agent finishes (completed, aborted, or errored). Each record holds the timestamp, phase ID, status, turn count, tool-use count, duration, and full token breakdown (`input` / `output` / `cache_write`). Append failures are swallowed — local logging is best-effort and never escalates to a phase error the user sees.
- **`/codecarto-usage` command.** Reads the local usage log and renders cumulative + per-phase totals to the status widget and an info notification: total runs, total tokens (input + output + cache-write, k/M-formatted), total duration, total tool uses, and a per-phase breakdown sorted by appearance order. On a fresh workspace with no recorded runs, surfaces an explicit "No phase runs recorded yet." message.
- **`core/usage.ts`** (~115 LOC). `loadUsage`, `appendUsageRun`, `computeTotals`, `computePerPhaseTotals`. Schema is intentionally narrow (`{ version, runs: UsageRun[] }`); totals are computed on read so the file never holds a number that contradicts the runs. Malformed YAML and entries missing required fields fall back to the empty case rather than blocking the command. Atomic-rename write (`.tmp` + `rename`) so a crash mid-write can't leave a partial file.
- **Template `.gitignore` entry** for `workflow/.usage.local.yaml` — the file holds absolute Pi session paths and machine-local timestamps; useless to share, easy to leak by accident.
- **6 new unit tests in `tests/usage.test.mjs`** covering tmp-dir round-trips for missing/present/malformed YAML, totals math, per-phase grouping, and entry validation. The Pi-extension command-registration invariant test in `tests/default-pipeline.test.mjs` was extended to require `usage` alongside the other 7 commands. Test count: 57 → **63**.

### Notes

- This is the **observability** half of the orchestrator-experience plan. Pairs naturally with the phase-summary injection (Option A) and opt-in LLM steering (Option B), but doesn't depend on either — the usage log is populated regardless of what other features are enabled.
- The MCP server is unchanged. The MCP path returns prompt text for the host to dispatch and never runs sub-agents itself, so there's no per-phase usage to track on that side. `/codecarto-usage` is a Pi-only command.
- The schema carries a `version: 1` field. If the shape grows breaking later, bump the version and have `loadUsage` migrate or reject. For now everything is forward-compatible: extra keys are ignored, missing optional keys default to zero.
- "Best-effort" really means best-effort — a full disk, permission denied, or read-only filesystem will silently lose the record. The orchestrator's own model-side billing and Pi's own session log remain the canonical accounting; this file is a convenience.

## [0.5.0] — 2026-05-08

### Added

- **Opt-in LLM-steered seed prompt for `/codecarto-next`.** When enabled, the orchestrator's LLM is run as a one-shot rewriter that reads the previous phase's closeout + the next phase's stock prompt and produces a customized seed prompt that names the specific findings, open questions, and carry-forward items the next phase should pay attention to. Off by default. The user controls the trade-off (extra orchestrator-side tokens vs. context-aware customization) per workspace and per invocation.
- **Workspace config at `.codecarto/workflow/config.yaml`.** New file shipped in the packaged template with `orchestrator.llm_steer_next_phase: false`. Loaded by `core/orchestrator-config.ts` (`loadCodecartoConfig`); missing file or unrecognized keys fall back to defaults, so existing workspaces keep working unchanged. Malformed YAML is non-fatal — falls back to defaults rather than blocking the command.
- **Per-invocation flag overrides** for `/codecarto-next`:
  - `/codecarto-next --llm-steer` — force on for this run regardless of config.
  - `/codecarto-next --no-llm-steer` — force off for this run.
  - Unknown flags surface a clear error rather than being silently ignored.
  - Tab-completion: the slash-command argument completer now suggests `--llm-steer` and `--no-llm-steer`.
- **`extensions/codecarto/agent-rewriter.ts` (~140 LOC).** One-shot in-memory `AgentSession` with `tools: []` (no extensions, no skills, no prompt templates, no themes, no context files) on the orchestrator's model. Reads the latest closeout matching the previous-phase ID under `.codecarto/closeouts/` (truncates to 8 KB before passing to the rewriter to keep the cost bounded) and asks the rewriter to emit a customized seed prompt — Markdown only, no commentary. On any failure (no prior phase, missing closeout, rewriter session error, empty output) returns the stock prompt with a `skipReason` and a `warning` notification — the command never aborts because of rewriter trouble.
- **`extensions/codecarto/next-flags.ts`.** Small parser for `/codecarto-next` args; pure, exhaustively tested. Last-flag-wins resolution lets the user safely chain overrides.
- **12 new unit tests** — 6 in `tests/orchestrator-config.test.mjs` (tmp-dir round-trips for missing/present/malformed YAML, plus pure `mergeConfig` shape checks), 6 in `tests/next-flags.test.mjs` (override matrix, last-wins, unknown collection, whitespace tolerance). Test count: 57 → 69.

### Notes

- The rewriter is **opt-in by design** — Option B from the orchestrator-visibility plan. Option A (always-on phase-completion summary injection, no LLM call) ships separately and is independently toggleable. Run them together for full visibility + steered prompts; run only A for the cheap visibility win; run only B if you want steering without the summary.
- The rewriter prompt explicitly forbids inventing findings the closeout doesn't state and forbids changing the next phase's structure or completion criteria — guardrails against the "LLM rewriter wanders off" failure mode.
- Closeout truncation (8 KB) was chosen by inspection of the closeout-template stub — it leaves headroom for one or two long phase outputs, well under typical orchestrator context windows. Tunable in `agent-rewriter.ts` if needed.
- The new config schema is intentionally narrow (one knob). Future toggles should slot in alongside `llm_steer_next_phase` in the same `orchestrator:` block; `mergeConfig`'s "default-then-override" pattern means adding a key requires no migration.

## [0.4.0] — 2026-05-08

### Added

- **Phase-completion summary is now injected into the orchestrator's session.** When `/codecarto-next` runs a phase sub-agent to completion (or it aborts, or it errors), the extension calls `pi.sendMessage({ customType: "codecarto-phase-summary", display: true })` with a Markdown summary block. The block becomes a `CustomMessageEntry` in the orchestrator's session: it renders in the TUI scrollback so the user sees `Phase X finished. ⟳ 5 · 12 tool uses · 2.3k tokens · 1m30s`, and on the user's next message it shows up in the orchestrator LLM's context as a prior user message. No `triggerTurn` — the orchestrator does **not** auto-respond, which keeps the user fully in control of when the next action happens. Closes the gap between "phase ran" and "user can ask the orchestrator about it" without forcing a closeout-file read on every follow-up question.
- **`extensions/codecarto/agent-summary.ts` (~95 LOC).** Pure formatter — no I/O, no session manipulation. Owns the `buildPhaseSummary()` helper. Three header variants (finished / aborted / failed); error path includes the error message and skips the excerpt/trailer; completed path includes the response excerpt (truncated to 2000 chars with a "transcript truncated; resume the phase session" tail), the session file path with a `/resume` hint, and validate/complete next-step pointers. Sessions without a recorded `sessionFile` (e.g. resumed before 0.3.0's persistent-session change lands) just drop the transcript line and keep the rest.
- **7 new unit tests in `tests/agent-summary.test.mjs`** covering the header variants, the truncation path, zero-activity formatting, missing session file, and the k/M token threshold formatting. Test count: 57 → 64.

### Notes

- This is **Option A** from the orchestrator-visibility plan — always on, no LLM calls (so no extra orchestrator-side tokens), works regardless of whether the phase session is in-memory or persisted.
- Option B (opt-in LLM-steered customization of the next phase's seed prompt) is a separate change set, expected next.
- The `display: true` rendering uses Pi's default custom-message styling. Registering a dedicated `pi.registerMessageRenderer("codecarto-phase-summary", ...)` for codecarto-themed rendering is intentionally deferred — the default already reads cleanly and the TUI affordance can be tuned without an API change.

## [0.3.0] — 2026-05-08

### Changed (minor bump per pre-1.0 convention)

- **Phase sub-agents now persist to the same Pi session directory the orchestrator uses.** `extensions/codecarto/agent-runner.ts` swaps `SessionManager.inMemory(cwd)` for `SessionManager.create(cwd)`, which writes a JSONL file under `~/.pi/agent/sessions/<encoded-cwd>/`. Pi's `/resume`, `/tree`, and `/export` already read that directory, so phase transcripts become first-class browsable artifacts: open the picker and resume into a previous phase, view its tool-call tree, export to HTML, etc. — no codecarto-side plumbing needed. In-memory sessions left no trace once `/codecarto-next` returned, so the rich event stream rendered in the live widget vanished the moment the spinner aged out; this closes that gap.
- **Phase sessions are tagged for the picker.** Each spawn calls `sessionManager.appendSessionInfo("CodeCartographer phase: <id>")` so the session shows up in `/resume` with a meaningful name (rather than the default first-message preview), and rewrites the header with `parentSession: <orchestrator's session file>` so Pi's `SessionInfo.parentSessionPath` exposes provenance to any UI that wants to render lineage.
- **`PhaseRunResult.sessionFile`** added — the absolute path to the on-disk session JSONL. Useful for follow-on tooling (the planned `/codecarto-usage` command, downstream session viewers) that wants to point at a phase's transcript without rebuilding the path from `cwd`.
- **`runPhase()` signature** gained a `PhaseRunOptions` argument (currently `{ sessionName?: string }`) between callbacks and signal. The single internal caller (`/codecarto-next`) passes the phase ID-derived name; all other args remain backward compatible.

### Notes

- The session directory is shared between the orchestrator's TUI session and every phase sub-agent run — by design, so `/resume` lists them together. The `parentSession` header makes the relationship discoverable; the explicit `appendSessionInfo` name keeps them visually distinct from regular orchestrator sessions in the picker.
- Phase sub-agent session files are stored in `~/.pi/agent/sessions/`, **not** inside the project's `.codecarto/`. Nothing new lands in the repo's gitignore; existing Pi cleanup (the user's session-directory hygiene practices, if any) applies unchanged.
- 57/57 tests pass — no schema changes touch the on-disk workspace state.

## [0.2.1] — 2026-05-08

### Fixed

- **Agents-widget turn count now renders with a space** (`⟳ 5` instead of `⟳5`). The unspaced glyph collided with the digits on terminals whose font mapped `⟳` to a slightly wider cell than nominal, making the count hard to read at a glance.
- **Main status widget now refreshes when a phase sub-agent finishes.** The "Open questions / Carry-forward / Next" lines were stale until the user manually ran `/codecarto-status` (or any other command that re-rendered the widget), even when the sub-agent had written new findings, owner_notes, or carry-forward items into `status.yaml`. `/codecarto-next`'s `.finally()` now calls `refreshWorkspaceUi(ctx)` after the phase resolves, so the orchestrator's status widget tracks reality without user action. The `agent_end` handler already covered the orchestrator's own turns; this closes the gap for phase sub-agents whose lifecycle is independent of `agent_end`.


## [0.2.0] — 2026-05-07

### Changed (breaking — minor bump per pre-1.0 convention)

- **`/codecarto-next` now runs phases as in-process AgentSession instances with a live "Agents" widget above the editor.** Replaces the 0.1.3/0.1.4 session-switching design (which used `ctx.newSession()` and produced a context-isolated child but flipped the user's TUI to it, which was invisible during normal flow). The new path uses the SDK's `createAgentSession()` + `SessionManager.inMemory()` to spawn an isolated child session that runs in parallel with the orchestrator's TUI; the orchestrator's transcript stays clean and visible while the phase works. Architecture and event-subscription pattern adapted from `@tintinweb/pi-subagents` (forked into our codebase, not added as a dependency).
  - New `extensions/codecarto/agent-runner.ts` (~165 LOC): builds a `DefaultResourceLoader` + `SessionManager.inMemory()`, calls `createAgentSession`, subscribes to the session's event stream (tool start/end, turn end, message updates, message end usage), forwards events to caller-provided callbacks. The runner is fire-and-forget; `/codecarto-next` returns immediately.
  - New `extensions/codecarto/agent-state.ts` (~70 LOC): module-scoped `Map<phaseId, PhaseActivity>` tracking running and recently-finished phases. Mutated by runner callbacks; read by the widget.
  - New `extensions/codecarto/agent-widget.ts` (~265 LOC): persistent widget registered via `ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })`. Renders a tree of running and recently-finished phases with spinner, tool-use count, token usage, elapsed time. 80ms tick for animation; `tui.requestRender()` for active updates without re-registration. Auto-unregisters when no phase is active and finished phases have lingered out (~6.4s). Widget is torn down on `session_shutdown` to avoid leaking the timer.
- **Tier A (session-switching) code removed.** `core/orchestrator.ts` deleted; its `loadOrchestratorState` / `writeOrchestratorState` helpers are gone. `extensions/codecarto/index.ts` no longer reads or writes `.codecarto/workflow/.orchestrator.local.yaml`. `tests/orchestrator-state.test.mjs` deleted (7 round-trip tests no longer relevant). The gitignore entry for the local-state file remains in the template — existing 0.1.3 / 0.1.4 workspaces may have a leftover file on disk, and ignoring it keeps stale local state out of git.
- **Peer dep `@earendil-works/pi-coding-agent` pinned to `~0.74.0` (was `^0.74.0`).** Tilde locks the minor lane. `0.2.0` imports several SDK exports beyond the standard `ExtensionContext` surface (`createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `getAgentDir`, `AgentSession`, `AgentSessionEvent`); these are public top-level exports of the package's `index.d.ts` but the SDK is pre-1.0 and minor-version churn in those internals is plausible. The smoke test (`npm run smoke`) plus the daily cron in `smoke.yml` remain the safety net for future Pi minor bumps; consider unpinning once a major version of the Pi SDK lands and the API surface stabilizes.

### Notes

- Test count drops from 64 → 57 because the 7 `orchestrator-state` tests were deleted alongside the module they covered. The 57 surviving tests cover pipeline invariants, default pipeline shape, MCP server tool definitions, and documentation cross-references.
- The phase sub-agent inherits codecarto's tool-interception logic via `bindExtensions()` — `bash` is blocked, `edit`/`write` are confined to `.codecarto/`, same rules the orchestrator's TUI session has had since 0.1.0. The runner explicitly limits the child's tool list to `["read", "edit", "write", "grep", "find", "ls"]` as a defense-in-depth against tool drift.

## [0.1.4] — 2026-05-07

### Fixed

- **`/codecarto-next` no longer crashes with `extension ctx is stale after session replacement`.** The 0.1.3 sub-agent handler called `ctx.ui.notify(...)` and `setUiState(ctx, ...)` *after* `await ctx.newSession(...)` (and similarly after `ctx.switchSession(...)` on the phase-child path). Per the Pi SDK contract, the original `ctx` is invalidated as soon as the session-replacing call returns; touching it raises a runtime error that aborts the handler. The spawn itself succeeded — the child session was created with the phase prompt — but the post-spawn notification crashed loudly, making the feature look broken. Reordered: all outer-session UI updates (`lastFeedbackLines`, `setUiState`, `ctx.ui.notify`) now run *before* the session-replacing call; the `withSession` callback owns all post-replacement work via its own fresh ctx; the original `ctx` is never touched after the await. Same fix applied to the phase-child branch's `switchSession` plus the inner `orchestratorCtx.newSession` (which invalidates the outer `withSession` callback's ctx — so the inner spawn must be the last statement in that callback). The `result.cancelled` notifications were dropped from both branches since there's no live ctx to notify with on a cancelled spawn.

## [0.1.3] — 2026-05-07

### Added

- **Sub-agent orchestrator mode for the Pi extension.** When `/codecarto-init` runs from Pi, the current Pi session is recorded as the workspace's *orchestrator*; every subsequent `/codecarto-next` spawns the phase as a child session via `ctx.newSession({ parentSession })` instead of injecting the phase prompt into the current conversation. The phase's tool calls, file reads, and reasoning land in the child's own context window — the orchestrator only sees the phase entry/exit, not the work. When `/codecarto-next` is invoked *from inside* a phase child, the handler switches the TUI back to the orchestrator and chains the next phase atomically (single `ctx.switchSession({ withSession })` followed by `newSession`). The orchestrator pointer is written to `.codecarto/workflow/.orchestrator.local.yaml` (gitignored — it holds a machine-local absolute path to the Pi session file). Workspaces created by 0.1.0–0.1.2 have no orchestrator file and fall back to the legacy in-place phase prompt; re-run `/codecarto-init` to opt in. The MCP-server path is unaffected (it has no session concept; the host application is always the orchestrator). 7 unit tests added for the load/write round-trip.

### Changed

- **Release workflow now smoke-tests the packed tarball before publishing.** `release.yml` now runs `npm pack` after the unit tests, then exercises `scripts/smoke-mcp.mjs --tarball` against the resulting `.tgz` *before* `npm publish`. A failing smoke kills the run before anything reaches the npm registry — preventing the 0.1.1 class of bug where the build pipeline broke template resolution but the existing post-publish smoke (under `workflow_run`) didn't surface the failure visibly. Removed the `workflow_run: ['Release']` trigger from `smoke.yml`; the daily cron + `workflow_dispatch` paths stay in place to catch registry-side regressions caused by transitive-dep updates after publish.
- **`scripts/smoke-mcp.mjs --tarball <path>`**: smoke now accepts a local tarball as an alternative to `--version <ver>`. Same nine-step suite either way; `--version` and `--tarball` are mutually exclusive.

## [0.1.2] — 2026-05-07

### Fixed

- **`/codecarto-init` and the `codecarto_init` MCP tool now actually find the packaged `.codecarto/` template after install.** `0.1.1` shipped the template at the package root (`<package>/.codecarto/`) but the compiled `core/workspace.js` resolved its sibling directory via a single `..` from `dist/core/` — landing at `<package>/dist/.codecarto/`, which doesn't exist. Every `/codecarto-init` failed with `Error: Packaged .codecarto assets are missing.` (and the MCP path threw `McpError(InternalError)`). The 57/57 invariant tests pass against the source tree, so this only manifested after the build pipeline added in 0.1.1 — and the published smoke test was checking the response shape rather than the actual template-copy behavior. Replaced the fragile `..` walk with a `findPackageRoot(import.meta.dir)` that walks up to the first `package.json`, which lands on `<package>/` in both source and `dist/` layouts.
- **Remove `codecartographer-pi` self-dependency from `package.json`.** Running `npm install codecartographer-pi` from inside the repo (e.g., to verify a published artifact) caused npm to write the package as a direct dependency of itself. Left in, the `0.1.2` tarball would have nested a copy of `codecartographer-pi@0.1.1` under its own `node_modules/`, with the outer package's `bin` and `pi.extensions` paths potentially resolving against the wrong copy depending on host walk order.

### Changed

- Pin `@modelcontextprotocol/sdk` to `^1.29.0` (was `*`). The wildcard let `npm install` resolve to anything and made the npmjs.com dependency panel for `codecartographer-pi` link to the SDK's draft-spec docs. The pinned range covers SDK 1.29.x, which advertises MCP `2025-11-25` as `LATEST_PROTOCOL_VERSION` while still accepting `2024-10-07` through `2025-11-25` from clients.
- **Release workflow now creates a git tag and a GitHub Release on every publish.** Previously `release.yml` only ran `npm publish`, so the GitHub repo's "Releases" sidebar stayed empty. The workflow is now idempotent end-to-end: `npm publish` skips if the version is already on the registry, `gh release create` skips if the tag's release already exists. Notes for the GitHub Release are extracted from the matching `## [VERSION]` section of `CHANGELOG.md`. Permissions widened from `contents: read` to `contents: write` so the runner can create tags and releases.
- **Migrate Pi peer dependency from `@mariozechner/*` to `@earendil-works/*`.** The `@mariozechner/pi-coding-agent` package was deprecated upstream in favor of `@earendil-works/pi-coding-agent`; `pi update` now emits five deprecation warnings on every install. Switched our peer dep declaration and the one extension import (`extensions/codecarto/index.ts`) over to the new namespace at `^0.74.0`. Type names (`ExtensionAPI`, `ExtensionCommandContext`, `ExtensionContext`) are unchanged across the rename — drop-in replacement, no behavior change.

### Documentation

- README: explicitly document the MCP spec revision the package implements, and link to the released spec at `modelcontextprotocol.io/specification/2025-11-25`.
- **README: clarify Pi vs. MCP install paths.** Added `pi install npm:codecartographer-pi` as the primary install command for the Pi use case alongside the existing local-checkout and git-URL options, and added an explicit warning that plain `npm install codecartographer-pi` does NOT register the package with Pi (it has to be `pi install npm:...` so Pi writes it into its own `settings.json`). Plain `npm install` is still the correct command for the MCP-server use case.

## [0.1.1] — 2026-05-07

### Fixed

- **`codecarto-mcp` is now actually runnable when installed from npm.** `0.1.0` shipped TypeScript source files and relied on Node's `--experimental-strip-types` to load them at runtime. Node refuses to strip types from any file inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the bin failed to start on every Node version. Caught by the new end-to-end smoke test against the published artifact (PR #11).

### Changed

- Build pipeline added: `tsc` compiles `core/`, `extensions/`, and `mcp-server/` to `dist/`. The published tarball ships compiled JavaScript instead of TypeScript source. `prepublishOnly` enforces a fresh build at publish time.
- `package.json#bin.codecarto-mcp` now points at `./dist/mcp-server/bin.mjs`. `pi.extensions` points at `./dist/extensions`. `files` ships `dist/**/*` instead of the source directories.
- `mcp-server/bin.mjs` shebang simplified to `#!/usr/bin/env node` (no flags needed once the imports resolve to `.js`).
- `engines.node` lowered from `>=22.6.0` to `>=20.0.0`. The published artifact is plain JavaScript, so the `--experimental-strip-types` floor only applies to local development and CI.

### Notes

- TypeScript `^5.7` (specifically requires `rewriteRelativeImportExtensions`, introduced in 5.7) is now a `devDependency`. Consumers don't see it.
- The smoke test (`npm run smoke`) installs the published package into a temp dir and exercises the bin via the MCP SDK's stdio client. Daily cron in `.github/workflows/smoke.yml` will catch any registry-side regressions within 24 hours.

## [0.1.0] — 2026-05-06

Initial public release under the MIT license.

### Added

- **Framework core** (`core/`): pipeline state machine, YAML pipeline validators, prompt assembly, workspace utilities. Imported by both the Pi extension and the MCP server so phase prompts and validation logic stay byte-identical across surfaces.
- **Pi extension** (`extensions/codecarto/`): `/codecarto-init`, `/codecarto-status`, `/codecarto-next`, `/codecarto-phase`, `/codecarto-validate`, `/codecarto-complete`, and `/codecarto-skill` slash commands. Includes a footer widget showing the active phase and tool interception that blocks edits outside `.codecarto/`.
- **MCP server** (`mcp-server/`): seven tools mirroring the Pi extension (`codecarto_init`, `codecarto_status`, `codecarto_next`, `codecarto_phase`, `codecarto_validate`, `codecarto_complete`, `codecarto_skill`) so any MCP-compatible host (Claude Code, Claude Desktop) can drive a CodeCartographer workflow.
- **Default pipeline**: `pipeline-full-with-deep-audit.yaml` (7 phases). Splits the defect scan into a mechanical early pass and a semantic late pass so the reimplementation spec can design around defects with full contracts and protocols context.
- **Pipeline variants**: `architecture-only` (1 phase), `lite` (3 phase), `defect-scan` (2 phase), `full` (5 phase), `full-with-audit` (6 phase, single early defect scan), and `full-with-deep-audit` (7 phase, default).
- **Invariant tests** (`tests/`): default-pipeline, doc-mention, mcp-server, pipeline-invariants. Catch cross-wrapper drift between template, Pi extension, and MCP server.
- **CI** (`.github/workflows/ci.yml`): runs `npm ci && npm test` on every PR and push to `main`.
- **Documentation**: README with quick-start, pipeline variants, model-compatibility tiers, token-cost guidance; MANUAL for human users; per-phase SKILL.md and template files inside `.codecarto/`.

### Notes

- Node 20+ is required.
- The Pi runtime and `@sinclair/typebox` are peer dependencies — install them in your host environment, not as direct dependencies of this package.

[Unreleased]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/HuginnIndustries/CodeCartographer/compare/v0.7.0...v0.8.0
[0.1.0]: https://github.com/HuginnIndustries/CodeCartographer/releases/tag/v0.1.0
