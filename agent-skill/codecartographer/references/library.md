# The library: where finished specs go

A CodeCartographer **library** is a directory of published reimplementation-specs with provenance — the bridge between analysis runs and everything downstream. An analysis pipeline ends with a spec in one workspace; publishing it makes it addressable from any other project, and the **synthesis pipeline** consumes exactly these entries ("convert a user vision and explicitly confirmed library specs into a provenance-backed project plan" — see `codecarto_guide` topic `pipeline-selection`). Without a publish step, every analysis is an island.

## Anatomy

- A directory holding a `.codecarto-library` marker, `entries/` (optionally namespaced), and a generated `index.yaml` + `INDEX.md`.
- Discovery: tools take `library_path` (absolute) directly, or resolve the library from a workspace `cwd`'s `config.yaml`; `codecarto_library_init` also writes `library.path` into the user-global config so later calls need no path at all.
- `codecarto_config` shows the effective merge (`library.path`, `library.namespace`, `publish_confirm`) and whether the marker was found.

## The four tools

| Tool | Does | Notes |
|---|---|---|
| `codecarto_library_init` | Create the directory, write the marker, record `library.path` in user-global config | Idempotent; pass `namespace` to create a namespaced library |
| `codecarto_publish` | Publish a spec as a library entry | Required: `source_repo`, `headline`, and `spec` (inline) or `spec_path` (absolute). Content-hash idempotent: identical bytes update metadata in place, no version bump. `slug` derives from `source_repo` if omitted; namespaced libraries require `namespace` (or inherit via `cwd`). Provenance (`source_commit`, `source_branch`, `source_dirty`, `analyzed_at`, `pipeline`, `model_metadata`) is recorded; omitted generation fields default to `unknown` |
| `codecarto_library_list` | List entries | Filter by `namespace`, `tag`, `slug`, or `source_repo` |
| `codecarto_library_reindex` | Regenerate `index.yaml` + `INDEX.md` from filesystem state | For manual edits and index merge conflicts |

## When to publish

The moment `reimplementation-spec` completes and validates is the publish moment — the spec is finished, the workspace still knows its provenance (`cwd` inherits `pipeline` from `status.yaml`), and the terminal `next_actions` point here. Publish with `cwd` set so provenance rides along:

```
codecarto_publish cwd:<workspace repo> source_repo:<repo URL or path> headline:"<one line>" spec_path:<abs path to reimplementation-spec.md>
```

Set `publish_confirm` in config if you want an explicit confirmation gate before writes.

## What this is not

Publishing a spec into a library is different from copying findings into a product repository you are about to build — that curated-snapshot flow is `references/carrying-results-forward.md`. The library holds *specs as reusable inputs*; a product repo holds *your implementation of one*.
