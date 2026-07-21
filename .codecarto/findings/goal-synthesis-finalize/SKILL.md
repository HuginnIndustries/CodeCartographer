---
name: finalize-evidence-backed-project-plan
description: Transform a confirmed product vision and merged reusable specifications into an executable project plan whose important decisions remain traceable.
---

# Finalize Evidence-Backed Project Plan

Produce `findings/goal-synthesis/project-plan.md` using `templates/project-plan.md`.

Use `findings/spec-merge/merged-spec.md` as the default compression boundary. Deep-read a confirmed library specification only when the merged intermediate names a gap, unresolved conflict, or missing acceptance detail. Record any targeted deep reads in Coverage and limits.

Create a coherent build plan:

- define the first executable vertical slice,
- identify target components and stable public boundaries,
- break delivery into dependency-ordered work packages,
- give every work package an observable acceptance gate,
- preserve open conflicts and unknowns with owners or dispositions,
- state deliberate non-goals.

The provenance ledger is mandatory. Map every load-bearing architecture, scope, behavior, and sequencing decision to one of:

- an exact confirmed library reference and version,
- an exact product-vision section,
- an explicit synthesis decision, marked `strong inference`,
- an unresolved choice, marked `open question`.

Do not hide conflicts by averaging incompatible source behaviors. Prefer a clear disposition with rationale. A complete-looking plan with missing provenance must fail validation.

End with Coverage and limits and the validation table from the template.
