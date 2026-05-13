# Security Policy

## Supported Versions

CodeCartographer is currently in early development. Only the latest published version on npm receives fixes.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1.0 | No |

## Reporting a Vulnerability

Please **do not** report security issues through public GitHub issues, discussions, or pull requests.

Instead, report them privately by opening a [GitHub security advisory](https://github.com/HuginnIndustries/CodeCartographer/security/advisories/new) on this repository.

Include in your report:

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept if you have one.
- The version (or commit SHA) where you observed the issue.
- Any suggested mitigation, if you have one.

You should receive an acknowledgement within 72 hours. We aim to investigate and respond with a remediation plan within 14 days for confirmed issues.

## Scope

In scope:

- The published `codecartographer-pi` npm package.
- The Pi extension and the MCP server source in this repository.
- The framework template under `.codecarto/`.

Out of scope:

- Issues in third-party hosts (Pi, Claude Code, Claude Desktop, etc.). Please report those upstream.
- Issues in user-supplied LLM providers.

## Disclosure

We follow coordinated disclosure. We will credit reporters in the changelog unless they prefer to remain anonymous.
