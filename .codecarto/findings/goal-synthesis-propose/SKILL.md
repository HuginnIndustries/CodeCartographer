---
name: propose-synthesis-inputs
description: Rank reusable CodeCartographer library specifications against a captured product vision and create an explicit human confirmation gate.
---

# Propose Synthesis Inputs

Produce `findings/goal-synthesis/proposal.md` using `templates/proposal.md`.

Read `findings/vision-capture/vision.md` first. Use the library index and entry paths supplied in the phase prompt. Start with metadata for all entries; deep-read a specification only when its headline, tags, or capabilities indicate a credible fit that metadata cannot resolve.

For each serious candidate:

- map its reusable capabilities to concrete vision needs,
- state the benefit of including it,
- identify likely conceptual conflicts, irrelevant surface details, and integration costs,
- identify vision needs no candidate covers,
- rank it relative to the other candidates.

Write every candidate row with an unchecked `[ ]` box. Never confirm on the user's behalf, including in auto mode. The user confirms by editing one or more boxes to `[x]` after reviewing the proposal.

On a re-run, preserve existing `[x]` selections unless the user explicitly changed them. Re-evaluate the proposal and mark validation PASS only when the shortlist is coherent; confirmation itself is enforced structurally by the next phase, not by optimistic prose.

Treat library entries as read-only. Do not merge them yet. End with Coverage and limits and the validation table from the template.
