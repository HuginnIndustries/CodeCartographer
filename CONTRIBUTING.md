# Contributing to CodeCartographer

Thanks for your interest. This guide is for contributing to CodeCartographer itself. If you're looking for the contributor template that ships *inside* the framework (for users' target repos), see [`.codecarto/CONTRIBUTING.md`](.codecarto/CONTRIBUTING.md).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to abide by its terms.

## Reporting Issues

- **Bugs and feature requests**: open an issue on [GitHub](https://github.com/HuginnIndustries/CodeCartographer/issues).
- **Security issues**: see [SECURITY.md](SECURITY.md). Please don't open a public issue.

When filing a bug, include:

- Pipeline variant (`full-with-deep-audit`, `lite`, etc.) and which phase failed.
- Host (Pi extension, MCP server, or template-only) and version.
- Minimal reproduction or the exact `.codecarto/workflow/status.yaml` excerpt.
- LLM provider/model.

## Development Setup

```bash
git clone https://github.com/HuginnIndustries/CodeCartographer.git
cd CodeCartographer
npm ci
npm test
```

Tests run via Node's built-in test runner with TypeScript support. Node 20+ is the floor; we test against 20 and 22 in CI.

## Repository Layout

| Path | Purpose |
|---|---|
| `.codecarto/` | The drop-in template. Markdown + YAML, no executable code. |
| `core/` | Pipeline state machine, validators, prompt assembly. Imported by both wrappers. |
| `extensions/codecarto/` | Pi extension surface. |
| `mcp-server/` | MCP server surface. |
| `tests/` | Invariant tests that catch drift between template, Pi, and MCP. |
| `docs/` | Roadmap, design notes. |

The invariant tests are the most important guardrail: any change to a phase prompt, validation criterion, or pipeline definition needs to keep the Pi and MCP surfaces byte-identical with each other and with the template.

## Branches and PRs

- Default branch: `master`.
- Open PRs against `master`. CI (`.github/workflows/ci.yml`) runs `npm ci && npm test` on Node 20 and 22.
- Keep PRs focused. A bug fix and a refactor should be separate PRs.

## Commit Messages

Follow the existing style in `git log`:

```
feat: short description in lowercase imperative
fix: short description
docs: short description
refactor: short description
ci: short description
framework: short description for changes inside .codecarto/
```

Multi-line bodies are welcome for non-trivial changes. Reference issues with `Fixes #N` or `Refs #N`.

## What's In Scope

Welcome contributions:

- **Bug fixes** in `core/`, the Pi extension, the MCP server, or the template.
- **New invariant tests** that catch a drift case the existing suite missed.
- **Documentation improvements** — README, MANUAL, GUIDE, ROADMAP.
- **New host integrations** (Aider, Cursor, OpenCode plugin) provided they import `core/` rather than reimplementing pipeline logic.
- **Pipeline tweaks** with a clear rationale and a self-analysis run showing the before/after output quality.

Out of scope without prior discussion:

- Vendoring an LLM provider into the framework. Hosts own the LLM connection.
- Breaking changes to `.codecarto/` file paths or pipeline YAML schema (these are ABI for any user with an existing workspace).

## Maintainer Release Process

The release workflow at `.github/workflows/release.yml` triggers **only on `v*` tag pushes**, not on merges to `main`. A PR that bumps `version` and updates `CHANGELOG.md` does not by itself ship a release — someone has to push the matching tag. **Merging without tagging leaves the version bump dangling**, and subsequent merges will pile up version bumps with no published artifacts (see the 0.2.1 → 0.6.0 sequence for an example of this drifting silently).

### Standard release (single version)

For a PR that includes a version bump and changelog entry:

1. Merge the PR (CI green; version in `package.json` matches the new `## [VERSION]` heading in `CHANGELOG.md`).
2. From a synced clone:
   ```bash
   git fetch origin
   git tag vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```
3. Watch the run at `https://github.com/HuginnIndustries/CodeCartographer/actions`. The workflow will:
   - Verify the tag matches `package.json`'s `version`.
   - Run tests + build.
   - `npm pack` and smoke-test the tarball.
   - `npm publish --provenance --access public` (idempotent — skips if the version is already on the registry).
   - Create the GitHub Release with notes auto-extracted from the matching `## [VERSION]` block of `CHANGELOG.md`.

### Backfill (multiple unreleased versions on main)

If several version bumps merged without tags, you can ship them all at once. Each tag must point at the merge commit on `main` whose tree carries the matching `package.json` version:

```bash
git log --oneline main          # find the SHA of each "Merge pull request #..." commit

# Tag each merge commit with its version
git tag v0.2.1 <sha>
git tag v0.3.0 <sha>
# … etc

# Push them all at once
git push origin v0.2.1 v0.3.0 v0.4.0 v0.5.0 v0.6.0
```

The workflow runs in parallel for each tag. Publish + release-create are both idempotent, so re-running on a tag that's already published is a no-op.

### Why the workflow is tag-driven

A merge-driven release would fire on every merge to `main`, including non-version-bumping PRs (docs fixes, internal refactors). Requiring an explicit tag push keeps the release moment in the maintainer's hands and makes "what's published" a one-line query (`git tag --list 'v*'`). The trade-off is the failure mode you just observed: bumps without tags accumulate silently.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
