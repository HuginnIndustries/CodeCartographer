# Reimplementation spec (E09 slice excerpt) — CodeCartographer v0.25.0 self-audit

<!-- A bounded conversion of the real 2026-09-15 self-audit spec into the E09
     shape. Two modules, the ones whose scenarios are most self-contained:
     the document codec and the pipeline engine. Scenario text is verbatim
     from the source spec; only the id and tier columns are new. -->

## Acceptance Scenarios

| Scenario ID | Tier | Scenario | Input | Expected Output / Side Effect |
|-------------|------|----------|-------|-------------------------------|
| S-01 | minimum-viable | Duplicate-key refusal | `a: 1\na: 2\n` | Read fails with a named duplicate-key error; no value is returned. |
| S-02 | minimum-viable | Prototype-pollution guard (mappings) | `__proto__: {polluted: true}\n` | The parsed tree has an own `__proto__` entry (or rejects it); `({}).polluted` is undefined. |
| S-03 | minimum-viable | Prototype-pollution guard (sequence merge) | `items:\n  - __proto__: {polluted: true}\n    id: 1\n` | No prototype mutation; the item carries the parsed entries only. |
| S-04 | minimum-viable | Scalar round-trip quoting | Write and re-read `"2048"`, `"true"`, `"null"`, `"1.5"`, `"-"`, `""` | Every value round-trips as the same string type and bytes. |
| S-05 | major-workflow | Flow-collection policy | `list: [a, b]` where a sequence is expected | Policy-documented outcome (reproduced coercion/rejection or an explicit, documented divergence). |
| S-06 | minimum-viable | Tab indentation rejected | `\tkey: v\n` | Named tab-indentation error. |
| S-07 | minimum-viable | Multi-document rejected | `a: 1\n---\nb: 2\n` | Named multi-document error. |
| S-08 | minimum-viable | Key order preserved | Write `{b:2, a:1}` then read | Serialized order is `b` then `a`; read preserves it. |
| S-09 | minimum-viable | Determinism | Serialize the same value tree twice | Byte-identical output. |
| S-10 | minimum-viable | Pipeline cursor outcomes | A pipeline with an eligible phase; one with unmet deps and no eligible phase; one fully complete | Reports eligible / `stuck` / `complete` respectively. |
| S-11 | minimum-viable | Validation grammar | A phase output with two `## Validation` sections | The **last** section's last `**Overall:**` line wins. |
| S-12 | minimum-viable | Unreadable verdict | A validation block whose `**Overall:**` line is `Green` | Treated as unreadable/failure; not completed. |
| S-13 | minimum-viable | Complete refuses `FAIL` | A primary output with `Overall: FAIL` | Completion refused; `status.yaml` unchanged. |
| S-14 | major-workflow | Forced out-of-order phase | Force a phase whose deps are unmet | Prompt includes the warning line; run proceeds. |
| S-16 | minimum-viable | Commit point + idempotence | Complete a phase; re-run completion | `status.yaml` updated once; closeout/`THREAD_LOG` appended once. |

## Slices

| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier |
|----------|-------------|---------|------------------|------------|------|
| SL-01 | A strict YAML-subset reader that refuses what the source refuses, with named errors | document-codec | S-01, S-06, S-07 | | minimum-viable |
| SL-02 | Prototype-safe object construction for every mapping and sequence-merge path | document-codec | S-02, S-03 | SL-01 | minimum-viable |
| SL-03 | A writer whose output the reader round-trips byte-for-byte, preserving order and scalar type | document-codec | S-04, S-08, S-09 | SL-01 | minimum-viable |
| SL-04 | Documented flow-collection policy with a reproduction or an explicit divergence | document-codec | S-05 | SL-01 | major-workflow |
| SL-05 | A pipeline cursor that reports eligible / stuck / complete from phase state and dependencies | pipeline-engine | S-10 | SL-01 | minimum-viable |
| SL-06 | A validation-verdict reader with the source's last-section-wins grammar and unreadable-as-failure rule | pipeline-engine | S-11, S-12 | SL-01 | minimum-viable |
| SL-07 | Phase completion that refuses FAIL and is idempotent at its commit point | pipeline-engine | S-13, S-16 | SL-05, SL-06 | minimum-viable |
| SL-08 | Forced out-of-order phase runs with the warning line in the prompt | pipeline-engine | S-14 | SL-05 | major-workflow |
