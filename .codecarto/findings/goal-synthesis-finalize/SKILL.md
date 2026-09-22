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
- restate the work packages as slices: a `Slice ID`, the work package it delivers, the modules it touches, the `Scenario ID`s from the acceptance plan it proves, the slices it depends on, and a tier,
- preserve open conflicts and unknowns with owners or dispositions,
- state deliberate non-goals.

Scenarios in the acceptance plan carry a stable `Scenario ID` and a `Tier`, because slices cite them and a row number stops being a handle the moment a row is inserted. Every slice's `Proves scenarios` must name at least one existing Scenario ID: **an empty proof list is not a plan**, since a slice that proves nothing cannot be reviewed. Every `minimum-viable` scenario must be owned by some slice, or the plan can be called complete without it.

The provenance ledger is mandatory. Map every load-bearing architecture, scope, behavior, and sequencing decision to one of:

- an exact confirmed library reference and version,
- an exact product-vision section,
- an explicit synthesis decision, marked `strong inference`,
- an unresolved choice, marked `open question`.

Do not hide conflicts by averaging incompatible source behaviors. Prefer a clear disposition with rationale. A complete-looking plan with missing provenance must fail validation.

End with Coverage and limits and the validation table from the template.
