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
>
> Everything below describes what `core/library.ts` and the two
> executable surfaces (the Pi extension and the MCP server) actually
> write and read as of the version in `package.json`. Where a surface
> does not fill a field, the document says so rather than describing
> the field's intended future use.

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
repository — and is referenced by absolute path (tilde-expanded on
load) from user-global config or per-workspace config.

## Detecting a library

A directory is a valid library if and only if it contains a file named
`.codecarto-library` at its root. CodeCartographer locates a library by
reading the configured `library.path` (or the explicit `library_path`
argument on the MCP library tools) and checking for this marker;
nothing about the parent path is interpreted.

### Creating a library

The easiest way is the init command:

- **Pi:** `/codecarto-library-init <path> [--namespace <name>]`
- **MCP:** `codecarto_library_init` with `library_path` (and optional
  `name` and `namespace`)

This creates the directory, writes the marker file, and writes a
`library:` block into your user-global config (`~/.codecarto/config.yaml`):
`path`, `publish_confirm: true`, and `namespace` when one was given.
Passing a namespace is what makes the new library namespaced. Init is
idempotent — re-running it on an existing library preserves the existing
marker and rewrites only the config block.

Init writes the marker and nothing else. `index.yaml` and `INDEX.md`
first appear on the first publish or reindex; a `README.md` and a
`.gitignore` are yours to add.

You can also create one manually:

1. Create the directory: `mkdir -p ~/codecarto-library`
2. Write the marker file (see format below)
3. Set `library.path` in `~/.codecarto/config.yaml`:

```yaml
library:
  path: ~/codecarto-library    # tilde-expanded and made absolute on load
  namespace: james             # optional; required to publish into a namespaced library
  publish_confirm: true        # confirmation gate before writing — see below (default true)
```

Configuration has two layers: the user-global file above, and
`.codecarto/workflow/config.yaml` inside a workspace, which overrides
individual keys. `publish_confirm` gates the write on both executable
surfaces, in the only way each can ask: the Pi command shows a yes/no
preview dialog, and the MCP server — which cannot prompt — refuses a
`codecarto_publish` call that lacks `confirm: true` and returns the
preview as the error text instead (library, entry, whether a new
version or a metadata-only update, `source_repo`, headline,
confidentiality), writing nothing. The MCP gate applies only when the
key is actually set in one of the two files; the loader's default
(`true`) drives Pi's dialog alone, so a host that never configured the
key is not gated. `codecarto_library_init` and
`/codecarto-library-init` write the key, so a library initialized
through the tooling has the gate on. No config key controls git
behavior, because publish never touches git (see "Git interaction").

### Marker file format

```json
{
  "schema_version": 1,
  "name": "james-personal-library",
  "namespaced": true,
  "visibility": "internal",
  "created_at": "2026-05-14T18:32:00.000Z"
}
```

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Integer. Currently `1`. Bumped on breaking format changes. |
| `name` | yes | Human-readable label. Init defaults it to the directory basename. Surfaced in `index.yaml`, `INDEX.md`, and listings. |
| `visibility` | no | One of `internal`, `shared`, `public`; absent means `internal`. Publish compares it against each entry's `confidentiality` and refuses an entry more restricted than the library — see "Confidentiality conflicts". |
| `created_at` | no | ISO 8601 UTC timestamp. Informational only. |
| `namespaced` | yes | Boolean. If `true`, entries live under `entries/<namespace>/<slug>/` and publish requires a namespace. If `false`, entries live under `entries/<slug>/` and publish refuses a non-empty namespace. |

Single-tenant libraries (one user, no sharing) should set
`namespaced: false`. Shared libraries (team or community) should set
`namespaced: true`.

The reader is tolerant: a marker missing `name` reads as
`codecarto-library`, missing `namespaced` reads as `false`, missing
`schema_version` reads as `1`, and a `visibility` outside the three
values is dropped. A marker that is not a JSON object is treated as
"no library here".

## Directory layout

### Namespaced library

```
codecarto-library/
├── .codecarto-library            # marker file
├── README.md                     # optional; not generated, not consumed by tooling
├── INDEX.md                      # generated browsable TOC
├── index.yaml                    # generated machine-readable registry
├── entries/
│   └── <namespace>/
│       └── <slug>/
│           ├── latest            # regular file containing "v2" — never a symlink
│           ├── v1/
│           │   ├── reimplementation-spec.md
│           │   └── metadata.yaml
│           └── v2/
│               ├── reimplementation-spec.md
│               └── metadata.yaml
└── .gitignore                    # optional; not generated (see recommendations below)
```

### Single-tenant library

```
codecarto-library/
├── .codecarto-library            # marker file (namespaced: false)
├── INDEX.md
├── index.yaml
├── entries/
│   └── <slug>/
│       ├── latest                # regular file containing "v2"
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

Namespaces follow exactly the same rules, reserved names included.
Directories under `entries/` whose names break these rules are ignored
by reindex.

Slugs are derived from a repository reference by default: the MCP
server derives from `source_repo` unless the host passes `slug`
explicitly; the Pi command derives from the value it records as
`source_repo` — the analyzed directory's git remote when it has one,
its path otherwise (see the field table) — and offers no override.
Derivation drops a trailing `.git`, takes the last path segment
(splitting on the colon of a slash-less `git@host:name` form),
lowercases it, turns every run of characters
outside `[a-z0-9-]` into one `-`, trims and collapses dashes, and cuts at
64 characters. A result that is empty or does not start with a letter is
prefixed with `entry-`; a result that is a reserved name gets `-entry`
appended (`my-cool-tool` from `github.com/acme/my-cool-tool`;
`entry-2fa` from `acme/2fa`). If the namespace differs, the same slug is
permitted across namespaces.

Derivation uses only the trailing path segment, so two unrelated
repositories can land on one slug (`acme/whisper` and `openai/whisper`
both give `whisper`). CodeCartographer does not auto-suffix these.
Instead, publish refuses when the target entry already records a
different `source_repo`, because the alternative is appending one
project's spec to another project's version history. To shelve the
second project, pass an explicit distinct slug (MCP `slug`; the Pi
command cannot). See "Source repo conflicts" below.

### Version directories

Versions are named `v1`, `v2`, `v3`, ... — monotonically increasing
integers. Publish always writes highest-existing-plus-one, so a library
written only by CodeCartographer has no gaps; readers tolerate gaps and
treat any `v<digits>` directory as a version.

The `latest` pointer is a **regular file, never a symlink**. Its content
is the version directory name followed by a newline (`v2\n`). It is
written as a temp file and renamed into place every time a new version
directory lands, and at no other time. This is deliberate: a plain file
behaves identically on every platform and avoids the elevation
requirement for symlink creation on Windows. Consumers should read the
file and trim it, not `readlink` it.

Re-publishing the same content does not create a new version
(idempotence is enforced by content hash on `reimplementation-spec.md`;
see "Idempotence and version increments").

## `metadata.yaml` — per-entry-version

Every version directory contains exactly one `metadata.yaml`. This is
the **source of truth** for everything queryable about the entry.

The example below is a composite showing every field, in the key order
publish writes them (required fields first, optional fields appended
after `generation`). Which surface fills which optional field is in the
tables that follow; readers must not depend on key order.

```yaml
slug: hexbridge
version: 2
source_repo: "https://github.com/myorg/hexbridge"
analyzed_at: "2026-05-14T14:00:00.000Z"      # ISO 8601 UTC
pipeline: workflow/pipeline-full-with-deep-audit.yaml
codecarto_version: 0.17.0                    # package version at publish time
headline: "Bridge service that fans out events from Kafka into per-tenant Redis streams with lag-based backpressure."
tags:
  - event-routing
  - multi-tenant
  - kafka
  - redis
  - backpressure
capabilities:
  - "tenant-isolated fanout"
  - "at-least-once delivery"
  - "lag-based backpressure"
generation:
  surface: pi-extension                      # pi-extension | mcp-server | drop-in
  agent: pi                                  # free-form; pi, claude-code, codex, opencode, cursor, manual, unknown
  agent_version: unknown
  model: claude-opus-4-6
  model_vendor: anthropic                    # free-form; anthropic, openai, google, ollama, local, unknown
  reasoning: unknown                         # high | medium | low | default | unknown
  notes: ""
namespace: james                             # present iff the library is namespaced
source_commit: abc1234                       # optional, MCP host-passed
source_branch: main                          # optional, MCP host-passed
source_dirty: false                          # optional, MCP host-passed
scope_tier_counts:                           # optional; no surface writes it today
  p0: 4
  p1: 7
  p2: 3
confidentiality: internal                    # optional; internal | shared | public
provenance:
  prior_version: 1                           # null for v1
  mutation_source: null                      # reserved; always null today
```

### YAML dialect

CodeCartographer reads and writes every YAML file in a library with a
small hand-rolled subset of YAML (`core/yaml.ts`), not a full parser.
External writers — including anyone hand-editing `metadata.yaml` — should
stay inside it.

**Written:** block mappings and block sequences only (one item per line;
an object inside a sequence is a bare `-` line followed by an indented
mapping). Scalars are written unquoted when they match
`[A-Za-z0-9_./-]+` and as JSON-style double-quoted strings otherwise, so
URLs, timestamps and any value containing a space come out quoted.
Empty values are `""`, `[]`, `{}`; `null`, integers and booleans are
written bare.

**Read:** everything above, plus single-quoted strings, `|` / `|-`
literal blocks, and `#` comments. **Not read:** `>` folded scalars, flow
sequences such as `[a, b]`, flow mappings, anchors and aliases, and
multi-document streams. A folded scalar makes the whole file fail to
parse (reindex then skips the entry; a direct read throws); a flow
sequence parses as a string and is dropped where an array is expected,
so `tags: [kafka, redis]` silently becomes `tags: []`.

### Required fields

Every version CodeCartographer writes carries `slug`, `version`,
`source_repo`, `analyzed_at`, `pipeline`, `codecarto_version`,
`headline`, `tags`, `capabilities`, and a complete `generation` block
(all seven keys). `namespace` is present iff the library is namespaced.
All other fields are optional and absent unless supplied.

The reader is tolerant: at least one of `slug`, `source_repo`,
`headline`, `pipeline` must be a non-empty string or the file is
rejected as malformed; every other field falls back (`slug`, `version`
and `namespace` to the directory they were read from, strings to `""`,
`codecarto_version` to `0.0.0`, arrays to `[]`, `generation` to the
drop-in defaults described in the capture matrix). Unknown keys are
ignored and are not preserved on rewrite.

### Field semantics

| Field | Type | Notes |
|---|---|---|
| `slug` | string | Matches the directory name. Redundant on purpose for readability. |
| `namespace` | string | Present iff the library is namespaced. Same rules as a slug. |
| `version` | integer | Matches the directory name (`v<N>`). Assigned by publish, never by the caller. |
| `source_repo` | URL or path | Where the analyzed code lives. The Pi command records the fetch URL of the analyzed directory's git remote, verbatim as git reports it — `origin`, else the remote the current branch tracks — when the directory is the root of a git work tree; when it is not a git repository, has no remote, or is a subdirectory of a work tree, it records the directory's absolute path. Entries Pi published before it resolved remotes hold the path, so the first publish after upgrading trips the source-repo check and asks whether the repository moved — see "Source repo conflicts". The MCP server records whatever the host passes. Compared, normalized, against every later publish to the same slug. Local paths are permitted but discouraged for shared libraries: they mean nothing on another machine. |
| `source_commit` | string | Optional. Written only when the MCP host passes it; the Pi command does not record it. Intended as the commit SHA the analysis ran against. |
| `source_branch` | string | Optional. Same provenance as `source_commit`. Informational only — no lookup is performed against it. |
| `source_dirty` | boolean | Optional. Written only when the MCP host passes it; the Pi command does not record it. `true` means the analysis ran against a working tree with uncommitted changes, so `source_commit` names the parent commit rather than the analyzed state. |
| `analyzed_at` | ISO 8601 UTC | MCP: the host's `analyzed_at`, else the publish time. Pi: the publish time. Neither surface records when the analysis run actually finished. |
| `pipeline` | string | The active pipeline as recorded in the workspace's `status.yaml` — a workspace-relative path such as `workflow/pipeline-full-with-deep-audit.yaml`. MCP: the host's `pipeline` argument, else read from `cwd`'s `status.yaml`, else the literal `unknown`. |
| `codecarto_version` | semver | The `codecartographer-pi` version at publish time. |
| `headline` | string | One-or-two-sentence summary, surfaced in `INDEX.md`, listings and the synthesis propose phase's shortlist. Pi derives it from the spec: the first non-comment line under `## System Summary`, whitespace-collapsed and cut at 280 characters, falling back to `Reimplementation specification for <directory>.` MCP requires the host to pass it. Not LLM-generated by either surface. |
| `tags` | string[] | Filtering hints. Pi writes `[]`; MCP writes the host's `tags` (default `[]`). |
| `capabilities` | string[] | Higher-level than tags — what the system *does*. Pi writes `[]`; MCP writes the host's `capabilities` (default `[]`). |
| `scope_tier_counts` | object | Optional `p0`/`p1`/`p2` counts. No surface writes it today (the MCP tool does not accept it); preserved on read when present. |
| `confidentiality` | string | Optional: `internal`, `shared`, or `public`. Written only when the MCP host passes it; the Pi command never sets it. Treat absence as `internal`. Ordered `internal` < `shared` < `public`. Publish refuses an entry below the library's `visibility` — an `internal` entry into a `shared` or `public` library, a `shared` entry into a `public` one — unless `allow_confidentiality_mismatch` is set; an entry at or above it passes. See "Confidentiality conflicts". |
| `generation.*` | mixed | Provenance of the LLM run. See "Generation capture matrix" below. |
| `provenance.prior_version` | integer or null | Written when a new version is created: the previous highest version, or `null` for `v1`. |
| `provenance.mutation_source` | null | Reserved for a future spec-mutation workflow. Nothing writes a non-null value today. |

Hand edits to `headline`, `tags` and `capabilities` are picked up by the
next reindex, but they do not survive a re-publish: a later publish of
identical spec bytes rewrites the version's `metadata.yaml` from the
incoming publish (see "Idempotence and version increments"). The
exception is `provenance`: the in-place rewrite preserves the version's
recorded `provenance` block unless the publish supplies a new one, so a
re-publish from either surface — neither passes `provenance` — leaves
the block the version's original publish wrote in place.

## Generation capture matrix

The `generation:` block records which agent + model produced the spec.
Capture is asymmetric across delivery surfaces. The drop-in template has
no publish command at all; the third column describes what a
hand-written entry reads back as.

| Field | Pi extension | MCP server | Hand-written entry |
|---|---|---|---|
| `surface` | `pi-extension` | `mcp-server` | as written; `drop-in` when the block or value is missing or unrecognized |
| `agent` | `pi` | host passes via `model_metadata.agent`; else `unknown` | as written; `unknown` if absent |
| `agent_version` | always `unknown` — Pi does not expose it | host passes; else `unknown` | as written; `unknown` if absent |
| `model` | the session's model id; `unknown` if unavailable | host passes; else `unknown` | as written; `unknown` if absent |
| `model_vendor` | the session's model provider; `unknown` if unavailable | host passes; else `unknown` | as written; `unknown` if absent |
| `reasoning` | always `unknown` — Pi exposes the model but not the active thinking level | host passes one of `high`, `medium`, `low`, `default`, `unknown`; anything else, or nothing, becomes `unknown` | as written if one of the five values; otherwise `unknown` |
| `notes` | `""` | host passes; else `""` | as written; `""` if absent |

`agent` and `model_vendor` are free-form strings; the values listed in
the example are conventions, not an enforced enumeration. `reasoning`
and `surface` are enumerations and unrecognized values are normalized
away on read.

When a field cannot be captured automatically, the value `unknown` is
written. Consumers treating `unknown` as a neutral signal (not "low
quality") preserves interop with hand-written entries.

Nothing prompts for these fields. With `publish_confirm: true` (the
default) the Pi command shows a yes/no confirmation before writing —
the target `<namespace>/<slug>` and library path, the source it will
record (the git remote, or the directory), the spec path, the derived
headline, and a `Provenance: Pi / <vendor> / <model>` line — but there
is no step that asks the user to fill in `unknown` values. The MCP
server, when `publish_confirm` is set in config, refuses a call that
lacks `confirm: true` and returns an equivalent preview as text (see
"Creating a library"); otherwise it writes immediately. No display
string is derived from the generation block in
dashboards or listings; `codecarto_library_list` shows
`<namespace>/<slug> v<N> — <headline> [tags]`.

## `index.yaml` — derived registry

`index.yaml` is **regenerated** from filesystem state by the MCP tool
`codecarto_library_reindex` and by every publish (the Pi extension has
no separate reindex command; a publish from Pi reindexes as a side
effect). It must never be hand-edited. Conflict resolution between
concurrent publishers is: pull, regenerate, commit (see "Git
interaction").

```yaml
schema_version: 1
library_name: james-personal-library
generated_at: "2026-05-14T19:02:00.000Z"
entry_count: 14
namespaces:
  - james
entries:
  -
    slug: hexbridge
    latest_version: 2
    versions:
      - 1
      - 2
    source_repo: "https://github.com/myorg/hexbridge"
    headline: "Bridge service that fans out events from Kafka into per-tenant Redis streams with lag-based backpressure."
    tags:
      - event-routing
      - multi-tenant
      - kafka
      - redis
      - backpressure
    capabilities:
      - "tenant-isolated fanout"
      - "at-least-once delivery"
      - "lag-based backpressure"
    last_analyzed_at: "2026-05-14T14:00:00.000Z"
    last_codecarto_version: 0.17.0
    namespace: james
    confidentiality: internal
  -
    slug: payment-router
    ...
```

Each entry is built from the metadata of its highest-numbered version
directory (not from the `latest` pointer): `latest_version` is that
number, `versions` lists every version directory ascending, and the
remaining fields copy that version's `source_repo`, `headline`, `tags`,
`capabilities`, `confidentiality` (only when present), `analyzed_at` and
`codecarto_version`. `namespace` is present on each entry iff the library
is namespaced; a single-tenant library has `namespaces: []`. An entry
whose newest version has no readable `metadata.yaml` is omitted from the
index rather than failing the reindex.

The `entries[]` array is sorted by `(namespace, slug)` in plain
code-point order (slugs are lowercase ASCII, so this is alphabetical).
External consumers can rely on stable ordering across regenerations
given the same filesystem state.

Listing (`codecarto_library_list`, and the synthesis pipeline's library
preflight) is served from `index.yaml` when the file exists and parses,
and triggers a reindex only when it is missing or unparseable. A stale
index therefore yields stale listings until the next publish or
reindex.

Reindex also reads every `v<N>/metadata.yaml` and compares each recorded
`source_repo` against the newest version's (normalized as in "Source repo
conflicts" below). An entry whose versions disagree is reported on the
reindex result and flagged by `codecarto_library_list` — never written
into `index.yaml` or `INDEX.md`, whose shapes are stable. Such an entry is
what a slug collision left behind before publish refused cross-project
appends: two repositories sharing a trailing path segment
(`openai/whisper`, `acme/whisper`) derived one slug, the second landed as
the next version of the first, and the index attributes both codebases to
whichever published last. A version whose metadata is missing or
unreadable is skipped rather than reported. Repair is manual — split the
entry by hand — because inventing a slug, renumbering versions, and
repointing `latest` would change paths this document treats as ABI. A
repository that genuinely moved and was re-published with the source-repo
override leaves the same shape and is reported the same way.

## `INDEX.md` — derived browsable TOC

`INDEX.md` is the human-readable counterpart of `index.yaml`,
regenerated alongside it. It is markdown formatted for GitHub
rendering. For a namespaced library:

```markdown
# james-personal-library — Library Index

_Generated 2026-05-14T19:02:00.000Z. Do not edit by hand — regenerate with `codecarto library-reindex`._

**14 entries** across 1 namespace.

## james (14 entries)

| Slug | Latest | Headline | Tags |
|---|---|---|---|
| [hexbridge](entries/james/hexbridge/v2/) | v2 | Bridge service that fans out events from Kafka into per-tenant Redis streams with lag-based backpressure. | event-routing, multi-tenant, kafka, redis, backpressure |
| [payment-router](entries/james/payment-router/v1/) | v1 | ... | ... |
```

The heading carries the marker's `name`. A namespaced library gets one
`## <namespace> (N entries)` section per namespace, in sorted order; a
single-tenant library gets a single table directly under the summary
line, with rows linking to `entries/<slug>/v<N>/`. Every tag is listed;
`|` and `\` in headlines and tags are escaped and newlines are collapsed
to spaces. Each row links to the entry's newest version directory,
`v<N>/` where `N` is its `latest_version`, rather than to `latest`: the
pointer is a regular file, not a directory or symlink (see "Version
directories"), so a link to `latest/` has no directory to land on when
the library is browsed on a forge.

## Version resolution

Reading an entry:

- **Latest:** read `entries/<ns>/<slug>/latest`, trim it, and expect a
  version directory name of the form `v<N>`; open that directory.
- **Specific version:** `entries/<ns>/<slug>/v<N>/`.

This is what the core read API (`readEntry`) does, and its fallbacks
are the contract for external readers:

- If `latest` is missing, empty, or not of the form `v<N>`, fall back to
  the highest-numbered `v<N>` directory present. An entry directory with
  no version directories is an error.
- If `latest` names a version directory that does not exist, or one
  missing either `reimplementation-spec.md` or `metadata.yaml`, the read
  fails with an "incomplete entry" error. There is **no** fallback for a
  pointer that parses but dangles.

Reindex never reads or rewrites the pointer: `latest_version` in
`index.yaml` is computed from the directory listing. The pointer is
rewritten only by the next publish that creates a new version, so a
dangling or stale pointer persists — and can disagree with `index.yaml` —
until then. Repairing it by hand means writing the version directory
name and a newline into the file.

## Idempotence and version increments

Both surfaces publish through `publishEntry` in the core, which runs in
this order:

1. Validate: the marker must exist; the slug must be valid; a namespace
   must be present iff the marker says `namespaced: true`, and must
   itself be a valid slug.
2. Apply the source-repo guard (next section). A mismatch fails the
   publish before anything is written.
3. Unless a new version is forced: if the highest-numbered version
   directory holds a `reimplementation-spec.md` whose SHA-256 equals
   that of the incoming spec, rewrite that version's `metadata.yaml`
   from the incoming publish (version number retained; the recorded
   `provenance` block is carried forward unless the publish supplies
   one), regenerate `index.yaml` + `INDEX.md`, and report a metadata-only
   update. The comparison is against the highest-numbered directory,
   not the `latest` pointer.
4. Otherwise stage `reimplementation-spec.md` and `metadata.yaml` in a
   sibling directory named `<slug>.publish.<pid>.<timestamp>`, rename it
   into place as `v<N+1>/`, rewrite `latest`, and regenerate
   `index.yaml` + `INDEX.md`. A failure at any step up to and including
   the rename removes the staging directory (best effort) and propagates
   the error; a `*.publish.*` directory left behind means that cleanup
   itself failed. A failure after the rename leaves `v<N+1>/` in place
   with `latest` and the index possibly stale; a retry then takes the
   metadata-only branch (the content hash matches), which regenerates
   the index but does not touch `latest`.

`force_new_version` on `codecarto_publish` (`forceNewVersion` in
`PublishOptions`) skips step 3 and always creates a version. The Pi
command exposes neither this nor any other publish option; the two
guards below are answered through confirmation dialogs instead.

## Source repo conflicts

Before either branch above, publish compares the incoming `source_repo`
against the one recorded on the entry's newest version. If they denote
different repositories, publish fails and writes nothing.

Comparison is normalized, so these are all the same repository and none
of them trip the check: a `https://`, `http://`, `ssh://`, `git://` or
`file://` scheme or none at all, embedded credentials (`git@`,
`user:token@`), `git@host:owner/name` SCP syntax, a default port (`22`,
`80`, `443`), a `www.` host prefix, a trailing `.git`, repeated and
trailing slashes, backslash separators, and any letter casing in a host,
a forge-served repository path, or a Windows drive path. A non-default
port still distinguishes two services on one host.

Case in an absolute POSIX path (or a `~` home reference) is *not*
folded, because `/srv/Repos/tool` and `/srv/repos/tool` are two
directories on a case-sensitive filesystem. Folding them would hide the
collision the check exists to catch, and the Pi surface records the
analyzed directory as `source_repo` whenever it has no git remote to
record — and did so unconditionally before it resolved remotes — so
local paths are a common shape there rather than an edge case.

Normalization is deliberately conservative: it collapses only spellings
that are unambiguously the same target. Host aliases (`ssh.github.com`
for `github.com`) and provider-specific SSH path layouts (Azure DevOps
`v3/org/proj/name` against the HTTPS `org/proj/_git/name`) are left
distinct, so re-publishing through one of those will need the override
below.

The check is skipped when the recorded `source_repo` cannot be read at
all (absent, unreadable, or malformed metadata), since there is nothing
to compare. It is *not* skipped by the force-new-version override, which
means "another version of this entry", not "overwrite a different
project".

A repository that genuinely moved (rename, org transfer, host change) is
the one legitimate case for changing the recorded value. Override it
with `allow_source_repo_change` on `codecarto_publish`, or
`allowSourceRepoChange` in `PublishOptions` when calling the core
directly. The refusal is a typed `SourceRepoMismatchError` carrying the
recorded and incoming values, so a wrapper can ask from the values
rather than by matching the message. The Pi command takes no flags;
`/codecarto-publish` catches the refusal, shows both values, and asks
whether the repository moved — yes retries with the change allowed, no
writes nothing.

Expect that question once after upgrading a Pi that recorded the
analyzed directory to one that records the git remote (see the
`source_repo` row): the entry's newest version holds the path, the
publish carries the URL, and the check cannot tell a moved repository
from a different one. Answering yes appends the new version with the
URL recorded; every later publish from any clone of that remote then
compares equal.

## Confidentiality conflicts

Publish also compares the entry's `confidentiality` against the
library marker's `visibility`. The levels are ordered
`internal` < `shared` < `public`, and a side that declares nothing
counts as `internal` — the default a newly initialized library's
marker carries, and the default this document gives the entry field.

An entry may sit in a library at or below its own level. An entry
*more* restricted than its library may not: an `internal` spec in a
`shared` or `public` library, or a `shared` spec in a `public` one,
would be exposed to everyone the library reaches. That direction
fails and writes nothing. A `public` entry in an `internal` library is
fine, and a library with no `visibility` field accepts every entry it
did before.

Like the source-repo check, this runs ahead of the content-hash
branch, so a metadata-only update cannot reclassify an entry past it,
and `force_new_version` does not skip it. The Pi extension declares no
`confidentiality`, so `/codecarto-publish` into a `shared` or `public`
library asks whether to publish anyway and treats a yes as the
override. On MCP, set `allow_confidentiality_mismatch` on
`codecarto_publish`; when calling the core directly, set
`allowConfidentialityMismatch` in `PublishOptions`. The override
permits the placement — it does not change the recorded
`confidentiality`.

## Git interaction

Publish is a filesystem operation. Nothing in either shipped surface
runs git against the library:

| Operation | Behavior |
|---|---|
| File writes | Always performed. Every file is written to a temp sibling and renamed into place; a new version is staged as a directory and renamed into place (see "Idempotence and version increments"). |
| `git add` + `git commit` | Never performed by publish, on either surface, and no config key enables it. The library working tree is left modified for the user to review and commit. Rationale: a tool writing into someone else's repository should not commit on their behalf by default. |
| `git push` | Never. The user runs `cd <library> && git push` when ready. |
| `git pull` | Never. Nothing in CodeCartographer checks the library for unpushed commits or upstream changes; there is no staleness or "N unpushed commits" hint in the dashboard or anywhere else. |

For embedders who do want a commit, the core exports
`commitPublish(libraryRoot, message, { addAll? })`. It returns
`{ ok: false, skipped: "not-a-git-repo" }` when `<library>/.git` is
absent, runs `git add -- .` unless `addAll: false`, returns
`{ ok: false, skipped: "nothing-to-commit" }` when `git status
--porcelain` is empty, and otherwise runs `git commit -m <message>` and
returns `{ ok: true }`. Any other failure returns `{ ok: false }` with
`skipped` set to `error` (git's stderr in `message`) or `git-missing`;
it never throws and never pushes. The commit message is whatever the
caller passes — the core generates no message format, and neither
shipped surface calls this function.

When a library shared by several publishers hits a merge conflict on
`index.yaml` or `INDEX.md`, the resolution is to regenerate rather than
to merge by hand:

1. `cd <library> && git pull` (resolve the conflict by accepting either
   side — the files are about to be regenerated).
2. Regenerate: `codecarto_library_reindex` from an MCP host, or any
   publish, which reindexes as a side effect.
3. `git add index.yaml INDEX.md && git commit -m "reindex after merge"
   && git push`.

Publish does not detect git conflicts and prints no recipe; the conflict
surfaces in git, not in CodeCartographer.

## `.gitignore` recommendations

The library should gitignore:

- `.DS_Store`, OS metadata
- Editor temp files (`*.swp`, `.idea/`, `.vscode/` if not committed elsewhere)
- Any local config that holds machine-specific paths
- Leftovers from an interrupted publish: `*.tmp` (temp siblings of
  `metadata.yaml`, `index.yaml`, `INDEX.md`, `latest` and the marker,
  named `<file>.<pid>.<timestamp>.tmp`) and `*.publish.*` staging
  directories. A successful publish leaves none of these behind.

The library should **not** gitignore:

- `index.yaml` or `INDEX.md` — these are derived but committed so
  they're browsable on GitHub. They will conflict during concurrent
  publishes; the regen recipe above resolves conflicts deterministically.
- `latest` — it is a tracked regular file, not a symlink, and consumers
  read it.

## Schema versioning

Two files carry a `schema_version` integer: the `.codecarto-library`
marker and `index.yaml` (both currently `1`). `metadata.yaml` carries no
`schema_version` of its own; its shape is versioned by the marker's.
Changes:

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
  origin spec needs explicit representation. `provenance.mutation_source`
  is reserved for this and is always `null` today.
- **Signed entries.** For shared / public libraries, cryptographic
  signatures on `metadata.yaml` would let consumers verify that a
  spec was actually produced by the claimed analyzer.
