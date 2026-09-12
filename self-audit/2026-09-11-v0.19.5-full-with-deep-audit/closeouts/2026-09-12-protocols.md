# Closeout — protocols

## Summary

- Primary output: `findings/protocols/protocols-and-state.md` (PASS, 6/6).
- Event catalog E1-E22 over nine boundaries (host↔MCP, framework↔LLM text, LLM↔state
  files, framework-owned state, Pi orchestrator↔child, library, OpenRouter, git, config).
- State machines SM1-SM7: phase lifecycle, pipeline cursor, the completion transaction and
  its write ordering, the question/carry-forward lifecycle including the dead
  `resolved` value, Pi activity, Broad-Side run/batch/post-pass, library publish.
- Persistent schema notes for 12 stores and the six schema-version axes.
- Sixteen compatibility hazards; the two high ones are markdown-as-protocol and the
  asymmetric YAML round trip.
- Secondary outputs appended: public-surfaces (structuredContent keys per tool),
  config-model (config propagation as a protocol), state-and-storage (version axes).

## Routed and closed

- Closed arch-CF1.
- proto-CF1 → defect-scan-semantic (six protocol/state-machine drifts).
- proto-CF2 → porting (the compatibility surface).
- q-openrouter-batch-envelope registered (needs-fixture-capture).

## Coverage

- All parsers/serializers read; docs/library-format.md in full; real samples from this
  run used as writer-side evidence. Peer shapes (OpenRouter, Pi SDK) remain external.

## Proposed Conventions

- None this phase.

## Decisions Beyond Prompt

- Wire and persisted shapes are recorded as field tables and grammar sketches keyed to the parser lines that enforce them, not as formal JSON Schema; the parsers are the schema in this codebase and a schema document that outran them would be a second source of truth.
- OpenRouter and Pi SDK shapes are recorded from this repository's own parsing code and test fakes and marked external throughout; the one runtime-checkable gap is registered as a fixture-capture question rather than a runtime-test question, because a saved exchange is what would settle it.
