---
name: extract-protocols-and-state
description: Extract message formats, event streams, state machines, file formats, and cross-boundary protocols from a system. Use when you need to port event-driven agents, session formats, RPC or JSONL interfaces, storage schemas, or tool-calling systems into another language or runtime.
---

# Extract Protocols And State

Treat every boundary as a protocol boundary.

Enumerate the boundaries first:
- process to process
- UI to core
- core to provider
- tool layer to runtime
- runtime to persistence
- local files to exported artifacts

Prefer type definitions, schemas, and docs before implementation code:
- Read event and message types first.
- Read file format docs next.
- Use source to fill ordering, retry, and recovery gaps.

For each protocol, record:
- `producer`
- `consumer`
- `transport or carrier`
- `ordering guarantees`
- `required fields`
- `optional fields`
- `identifiers and timestamps`
- `error cases`
- `restart or resume behavior`

Convert control flow into a state machine:
- Name the states.
- Name the transitions.
- Record guards and side effects.
- Separate synchronous barriers from observational events.

Capture persistence semantics explicitly:
- append-only vs mutable
- branching vs linear history
- compaction or summarization
- replay or resume behavior
- locking, deduplication, or conflict handling

Look for these protocol-heavy areas:
- streamed assistant events
- tool call validation and execution
- session files
- JSONL or RPC framing
- queueing semantics
- background event scheduling
- transport fallbacks

Treat configuration propagation as a protocol when it crosses boundaries:
- How config values flow from files or env vars into runtime behavior.
- Whether config changes require a restart or are hot-reloaded.
- How config is validated and what happens on invalid input.
- If the config propagation model is complex, use the secondary output at `findings/config-model/config-model.md`.

Flag portability hazards that frequently break ports:
- ANSI terminal semantics
- IME or cursor positioning rules
- filesystem locking assumptions
- async ordering guarantees
- OAuth token refresh behavior
- shell quoting and OS differences
- encoding, width, or Unicode handling

Produce four outputs:
1. `Event catalog`
2. `State machine`
3. `Persistent schema notes`
4. `Compatibility hazards`

Mark every finding with one of these evidence levels:
- `observed fact`: direct statement from docs, tests, schemas, types, or code.
- `strong inference`: protocol conclusion drawn from multiple facts.
- `portability hazard`: assumption tied to the source language, runtime, terminal, OS, or third-party SDKs.
- `open question`: missing or conflicting behavior that still needs evidence.

Do not copy the wire syntax blindly. Preserve the meaning of the interaction, then decide how the target language should encode it.

Use the output template at `templates/protocols-and-state.md`.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`). This is the repository root.
