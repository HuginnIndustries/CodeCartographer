---
name: merge-confirmed-specifications
description: Normalize only human-confirmed reimplementation specifications into a provenance-rich, conflict-explicit intermediate for project planning.
---

# Merge Confirmed Specifications

Produce `findings/spec-merge/merged-spec.md` using `templates/merged-spec.md`.

Read the product vision, proposal, and only the library entries identified as human-confirmed in the phase prompt. The runtime preflight has already verified that at least one proposal checkbox is `[x]`; do not broaden the selection yourself.

Merge by concept, not by original repository structure:

- normalize capabilities that use different names for the same behavior,
- preserve load-bearing invariants and externally observable acceptance behavior,
- distinguish reusable semantics from adapters and source-specific delivery surfaces,
- record each incompatibility in the conflict ledger,
- choose `adopt`, `adapt`, `defer`, or `reject` only when the evidence supports it,
- keep gaps against the vision visible rather than filling them with invented behavior.

Every load-bearing row must cite an exact library reference and version, such as `team/router@v2`, or an exact section of the vision. A merged claim without provenance is a validation failure.

Treat library entries as read-only. End with Coverage and limits and the validation table from the template.
