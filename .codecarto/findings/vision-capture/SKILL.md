---
name: capture-product-vision
description: Convert a user's intended product into bounded outcomes, constraints, acceptance scenarios, assumptions, and non-goals before selecting reusable specifications.
---

# Capture Product Vision

Produce `findings/vision-capture/vision.md` using `templates/vision.md`.

Treat user-stated intent as the primary evidence. Do not inspect or choose library entries in this phase; selection comes later so the available implementation ingredients do not distort the problem definition.

Capture:

- the specific audience and problem,
- desired user-visible outcomes,
- scope boundaries and deliberate non-goals,
- technical, operational, timeline, privacy, and compatibility constraints,
- measurable success criteria,
- black-box acceptance scenarios,
- assumptions and decisions that still require confirmation.

Do not invent missing product choices. If this phase is running without a sufficiently detailed user vision, use the current conversation and any explicitly supplied inputs, mark unsupported details as assumptions, and return `PASS WITH GAPS`. Record truly blocking choices as stable open-question IDs in the phase handoff.

Keep architecture preferences separate from required outcomes unless the user made them explicit. The next phases need freedom to compare multiple library specifications against the same neutral vision.

End with Coverage and limits and the validation table from the template.
