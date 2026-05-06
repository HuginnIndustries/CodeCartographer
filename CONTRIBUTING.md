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

1. Update `CHANGELOG.md` under a new version heading.
2. Bump `version` in `package.json`.
3. `git tag vX.Y.Z && git push --tags`.
4. The release workflow (`.github/workflows/release.yml`) publishes to npm using the `NPM_TOKEN` repo secret.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
