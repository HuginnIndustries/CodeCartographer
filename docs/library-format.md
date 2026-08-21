# CodeCartographer Library Format

> **Experimental — may break before v2.**
>
> This document specifies the on-disk layout and schemas for a
> CodeCartographer library. The format is intentionally documented from
> day one so that external tools can read library entries without going
> through CodeCartographer itself. Until the first external consumer
> appears and exercises the format, schema changes between minor
> versions of `codecartographer-pi` are allowed. Once stable consumers
> exist, the format will be frozen and breakages will require a major
> version bump. Treat the schemas below as "the canonical shape today,
> not a long-term contract."

## What a library is

A **library** is a git-trackable directory that holds versioned
`reimplementation-spec.md` artifacts produced by CodeCartographer
analysis runs. Libraries serve two purposes:

1. **Accumulation.** Specs from many repos and many analysis runs
   collect in one place over time, with version history preserved.
2. **Synthesis input.** The synthesis pipeline
   (`pipeline-synthesis.yaml`) reads library entries plus a
   user-written vision to produce a `project-plan.md` for a new
   build.

A library is independent of any CodeCartographer workspace. It lives
wherever the user clones or creates it — typically a dedicated git
repository — and is referenced by absolute path from user-global
config or per-workspace config.

## Detecting a library

A directory is a valid library if and only if it contains a file named
`.codecarto-library` at its root. CodeCartographer locates a library
by reading the configured `library_path` and checking for this marker;
nothing about the parent path is interpreted.

### Creating a library

The easiest way is the init command:

- **Pi:** `/codecarto-library-init <path> [--namespace <name>]`
- **MCP:** `codecarto_library_init` with `library_path` (and optional `namespace`)

This creates the directory, writes the marker file, and writes the
`library.path` into your config (`~/.codecarto/config.yaml`). It is
idempotent — safe to re-run on an existing library.

You can also create one manually:

1. Create the directory: `mkdir -p ~/codecarto-library`
2. Write the marker file (see format below)
3. Set `library.path` in `~/.codecarto/config.yaml`:

```yaml
library:
  path: ~/codecarto-library
  publish_confirm: true
```

### Marker file format

```json
{
  "schema_version": 1,
  "name": "james-personal-library",
  "visibility": "internal",
  "created_at": "2026-05-14T18:32:00Z",
  "namespaced": true
}
```

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Integer. Currently `1`. Bumped on breaking format changes. |
| `name` | yes | Human-readable label. Surfaced in dashboards and listings. |
| `visibility` | no | One of `internal`, `shared`, `public`. Defense-in-depth hint when CodeCartographer compares against per-entry `confidentiality`. |
| `created_at` | no | ISO 8601 UTC timestamp. Informational only. |
| `namespaced` | yes | Boolean. If `true`, entries live under `entries/<namespace>/<slug>/`. If `false`, entries live under `entries/<slug>/` and CodeCartographer refuses to publish with a non-empty namespace. |

Single-tenant libraries (one user, no sharing) should set
`namespaced: false`. Shared libraries (team or community) should set
`namespaced: true`.

## Directory layout

### Namespaced library

```
codecarto-library/
├── .codecarto-library            # marker file
├── README.md                     # human description (not consumed by tooling)
├── INDEX.md                      # generated browsable TOC
├── index.yaml                    # generated machine-readable registry
├── entries/
│   └── <namespace>/
│       └── <slug>/
│           ├── latest -> v2      # symlink to most recent version directory
│           ├── v1/
│           │   ├── reimplementation-spec.md
│           │   └── metadata.yaml
│           └── v2/
│               ├── reimplementation-spec.md
│               └── metadata.yaml
└── .gitignore
```

### Single-tenant library

```
codecarto-library/
├── .codecarto-library            # marker file (namespaced: false)
├── INDEX.md
├── index.yaml
├── entries/
│   └── <slug>/
│       ├── latest -> v2
│       ├── v1/
│       │   ├── reimplementation-spec.md
│       │   └── metadata.yaml
│       └── v2/
│           ├── reimplementation-spec.md
│           └── metadata.yaml
```

### Slug rules

- Lowercase ASCII letters, digits, and `-`.
- Must start with a letter.
- Maximum 64 characters.
- Must not equal any reserved name (`latest`, `index`, `entries`).

Slugs are derived from the source repo name by default (`my-cool-tool`
from `github.com/acme/my-cool-tool`). If the namespace differs, the same
slug is permitted across namespaces.

Derivation uses only the trailing path segment, so two unrelated
repositories can land on one slug (`acme/whisper` and `openai/whisper`
both give `whisper`). CodeCartographer does not auto-suffix these.
Instead, publish refuses when the target entry already records a
different `source_repo`, because the alternative is appending one
project's spec to another project's version history. To shelve the
second project, pass an explicit distinct slug. See "Source repo
conflicts" below.

### Version directories

Versions are named `v1`, `v2`, `v3`, ... — monotonically increasing
integers, no gaps. The `latest` symlink (or, on filesystems without
symlink support, a `latest` file containing the version directory name
as a single line) points at the highest-numbered version. Re-publishing
the same content does not create a new version (idempotence is
enforced by content hash on `reimplementation-spec.md`).

## `metadata.yaml` — per-entry-version

Every version directory contains exactly one `metadata.yaml`. This is
the **source of truth** for everything queryable about the entry.

```yaml
slug: hexbridge
namespace: james                  # omitted if library is not namespaced
version: 2
source_repo: https://github.com/myorg/hexbridge
source_commit: abc1234            # commit SHA at analysis time, if known
source_branch: main               # informational
analyzed_at: 2026-05-14T14:00:00Z # ISO 8601 UTC
pipeline: pipeline-full-with-deep-audit
codecarto_version: 0.9.0          # package version at publish time
headline: >
  Bridge service that fans out events from Kafka into per-tenant
  Redis streams with lag-based backpressure.
tags:
  - event-routing
  - multi-tenant
  - kafka
  - redis
  - backpressure
capabilities:
  - tenant-isolated fanout
  - at-least-once delivery
  - lag-based backpressure
scope_tier_counts:
  p0: 4
  p1: 7
  p2: 3
confidentiality: internal         # internal | shared | public
generation:
  surface: pi-extension           # pi-extension | mcp-server | drop-in
  agent: pi                       # pi | claude-code | codex | opencode | cursor | manual | other
  agent_version: 0.4.2
  model: claude-opus-4-6
  model_vendor: anthropic         # anthropic | openai | google | ollama | local | unknown
  reasoning: high                 # high | medium | low | default | null
  notes: ""
provenance:
  prior_version: 1                # null for v1; v of prior version on re-publish or mutation
  mutation_source: null           # null for analysis; path to deltas file for spec-mutate
```

### Required fields

`slug`, `version`, `source_repo`, `analyzed_at`, `pipeline`,
`codecarto_version`, `headline`, `tags`, `capabilities`,
`generation.surface`. All others are optional.

### Field semantics

| Field | Type | Notes |
|---|---|---|
| `slug` | string | Matches the directory name. Redundant on purpose for readability. |
| `namespace` | string | Present iff the library is namespaced. |
| `version` | integer | Matches the directory name (`v<N>`). |
| `source_repo` | URL or path | Where the analyzed code lives. Local paths permitted but discouraged for shared libraries. |
| `source_commit` | SHA | Best-effort. If the analysis ran against a dirty working tree, this is the parent commit and a `dirty: true` field should be set. |
| `source_branch` | string | Informational only — no lookup performed against it. |
| `analyzed_at` | ISO 8601 UTC | When the analysis run finished. |
| `pipeline` | string | The pipeline file the analysis used (e.g. `pipeline-full-with-deep-audit`). |
| `codecarto_version` | semver | The `codecartographer-pi` version at publish time. |
| `headline` | string | One-or-two-sentence summary. Surfaced in `INDEX.md` and the propose phase's shortlist. LLM-generated at publish, user-editable. |
| `tags` | string[] | Filtering hints. LLM-generated at publish, user-editable. |
| `capabilities` | string[] | Higher-level than tags — what the system *does*. LLM-generated at publish, user-editable. |
| `scope_tier_counts` | object | Counts of `p0`/`p1`/`p2` items from the spec's Scope Tiers section. |
| `confidentiality` | string | `internal` (default), `shared`, or `public`. Compared against library `visibility` at publish time. |
| `generation.*` | mixed | Provenance of the LLM run. See "Generation capture matrix" below. |
| `provenance.prior_version` | integer or null | The version this one was derived from. `null` for first version. |
| `provenance.mutation_source` | path or null | If the version was produced by `spec-mutate`, the relative path to the deltas file. |

## Generation capture matrix

The `generation:` block records which agent + model produced the spec.
Capture is asymmetric across delivery surfaces:

| Field | Pi extension | MCP server | Drop-in |
|---|---|---|---|
| `surface` | auto: `pi-extension` | auto: `mcp-server` | auto: `drop-in` |
| `agent` | auto: `pi` | host passes via `model_metadata`; else `unknown` | manual: user edits or `manual` |
| `agent_version` | auto from Pi session | host passes; else `unknown` | manual |
| `model` | auto from Pi session | host passes; else `unknown` | manual |
| `model_vendor` | auto from Pi session | host passes; else `unknown` | manual |
| `reasoning` | auto from Pi session | host passes; else `default` | manual |
| `notes` | empty by default | empty by default | manual |

When a field cannot be captured automatically, the value `unknown` is
written. The `codecarto publish` UX prompts the user to fill in any
`unknown` fields before commit (`publish_confirm: true`); skipping the
prompt leaves them as `unknown`. Consumers treating `unknown` as a
neutral signal (not "low quality") preserves drop-in interop.

The pretty display string used in dashboards and listings is derived
from these fields at render time:

```
Pi (anthropic) claude-opus-4-6 • high
mcp-server / claude-code (anthropic) claude-sonnet-4-6
drop-in / manual / unknown
```

## `index.yaml` — derived registry

`index.yaml` is **regenerated** from filesystem state by
`codecarto library-reindex` (or automatically by `codecarto publish`).
It must never be hand-edited. Conflict resolution between concurrent
publishers is: pull, regenerate, commit.

```yaml
schema_version: 1
library_name: james-personal-library
generated_at: 2026-05-14T19:02:00Z
entry_count: 14
namespaces: [james]
entries:
  - slug: hexbridge
    namespace: james
    latest_version: 2
    versions: [1, 2]
    source_repo: https://github.com/myorg/hexbridge
    headline: >
      Bridge service that fans out events from Kafka into per-tenant
      Redis streams with lag-based backpressure.
    tags: [event-routing, multi-tenant, kafka, redis, backpressure]
    capabilities:
      - tenant-isolated fanout
      - at-least-once delivery
      - lag-based backpressure
    confidentiality: internal
    last_analyzed_at: 2026-05-14T14:00:00Z
    last_codecarto_version: 0.9.0
  - slug: payment-router
    ...
```

The `entries[]` array is sorted alphabetically by `(namespace, slug)`.
External consumers can rely on stable ordering across regenerations
given the same filesystem state.

## `INDEX.md` — derived browsable TOC

`INDEX.md` is the human-readable counterpart of `index.yaml`,
regenerated alongside it. It is markdown formatted for GitHub
rendering: one section per namespace, one entry per row, with
clickable links to the latest version's directory.

```markdown
# Library Index

_Generated 2026-05-14T19:02:00Z. Do not edit by hand._

## james (12 entries)

| Slug | Latest | Headline | Tags |
|---|---|---|---|
| [hexbridge](entries/james/hexbridge/latest/) | v2 | Bridge service that fans out events from Kafka into per-tenant Redis streams with lag-based backpressure. | event-routing, multi-tenant, kafka, redis |
| [payment-router](entries/james/payment-router/latest/) | v1 | ... | ... |
```

## Version resolution

Reading an entry:

- **Latest:** `entries/<ns>/<slug>/latest/` (follows the symlink/pointer).
- **Specific version:** `entries/<ns>/<slug>/v<N>/`.

If `latest` is missing or dangling, fall back to the highest-numbered
`v<N>` directory present. CodeCartographer treats a dangling `latest`
as a recoverable error: `codecarto library-reindex` repairs it.

## Idempotence and version increments

`codecarto publish` is idempotent on content:

1. Compute SHA-256 of the new `reimplementation-spec.md`.
2. Compare against the SHA of `entries/<ns>/<slug>/latest/reimplementation-spec.md`.
3. If equal, no new version is created; metadata-only changes (tags,
   headline) update the existing `metadata.yaml` in place.
4. If different, a new `v(N+1)/` is written atomically (temp dir →
   rename), `latest` is repointed, and `index.yaml` + `INDEX.md` are
   regenerated.

## Source repo conflicts

Before either branch above, publish compares the incoming `source_repo`
against the one recorded on the entry's newest version. If they denote
different repositories, publish fails and writes nothing.

Comparison is normalized, so these are all the same repository and none
of them trip the check: a `https://`, `http://`, `ssh://` or `git://`
scheme or none at all, `git@host:owner/name` SCP syntax, a `www.` host
prefix, a trailing `.git`, trailing slashes, backslash separators, and
any letter casing.

The check is skipped when the recorded `source_repo` cannot be read at
all (absent, unreadable, or malformed metadata), since there is nothing
to compare. It is *not* skipped by the force-new-version override, which
means "another version of this entry", not "overwrite a different
project".

A repository that genuinely moved (rename, org transfer, host change) is
the one legitimate case for changing the recorded value. Override it
with `allow_source_repo_change` on `codecarto_publish`, or
`allowSourceRepoChange` in `PublishOptions` when calling the core
directly.

## Git interaction

CodeCartographer is conservative about git operations on the library:

| Operation | Behavior |
|---|---|
| File writes | Always performed. |
| `git add` + `git commit` | Optional, on by default. Commit message: `publish: <ns>/<slug> v<N>` or `update: <ns>/<slug> metadata`. Configurable per-workspace. |
| `git push` | Never automatic. User runs `cd <library> && git push` when ready. The dashboard surfaces an "N unpushed commits" hint. |
| `git pull` | Never silent. Dashboard surfaces staleness; user pulls manually. |

When a publish encounters a conflict on `index.yaml` (two contributors
push concurrently), the resolution recipe is:

```bash
cd <library>
git pull
codecarto library-reindex
git add index.yaml INDEX.md
git commit -m "reindex after merge"
git push
```

This recipe is surfaced verbatim in the `codecarto publish` error
message when a conflict is detected.

## `.gitignore` recommendations

The library should gitignore:

- `.DS_Store`, OS metadata
- Editor temp files (`*.swp`, `.idea/`, `.vscode/` if not committed elsewhere)
- Any local config that holds machine-specific paths

The library should **not** gitignore:

- `index.yaml` or `INDEX.md` — these are derived but committed so
  they're browsable on GitHub. They will conflict during concurrent
  publishes; the regen recipe above resolves conflicts deterministically.

## Schema versioning

Each schema-bearing file carries a `schema_version` integer. Changes:

| Change | Bump |
|---|---|
| Adding an optional field | None — consumers ignore unknown fields. |
| Adding a required field | Major schema bump. Old entries become invalid; migration required. |
| Renaming or removing a field | Major schema bump. |
| Changing field semantics | Major schema bump. |

Until `schema_version: 2` ships, the format is experimental and
breaking changes may occur between minor `codecartographer-pi`
releases with a migration note in `CHANGELOG.md`. After the first
external consumer is identified, the format is frozen until the next
major version.

## Open questions deferred to v2

These are deliberately out of scope for the v1 format and will be
addressed in a future revision:

- **Entry-level diff schema.** Comparing two versions of the same
  entry requires a standardized diff format. Today, diffing is
  whatever `git diff` produces on the spec markdown.
- **Cross-entry capability index.** A reverse lookup
  ("capability → entries") would speed up the synthesis-propose phase.
  Today, the propose phase scans `index.yaml` entries linearly.
- **Multi-library federation.** Reading entries from multiple
  libraries in one synthesis run requires a manifest format.
- **Provenance chains.** When a mutated spec is republished as a new
  entry's v1 (rather than the same entry's v+1), the link back to the
  origin spec needs explicit representation.
- **Signed entries.** For shared / public libraries, cryptographic
  signatures on `metadata.yaml` would let consumers verify that a
  spec was actually produced by the claimed analyzer.
