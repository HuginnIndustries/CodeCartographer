---
name: reverse-engineer-for-porting
description: Synthesize architecture, contracts, and protocol findings into a reverse-engineering bundle oriented toward reimplementation in another language or runtime.
---

# Reverse Engineer For Porting

This phase synthesizes the outputs of architecture, contracts, and protocols. If defect reports exist, also read and integrate them: `findings/defect-scan/defect-report.md` (full-with-audit pipeline) or both `findings/defect-scan-mechanical/mechanical-defects.md` and `findings/defect-scan-semantic/semantic-defects.md` (full-with-deep-audit pipeline). The pipeline ensures all required phases are complete before this one runs. Read the prior phase artifacts before starting.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`). This is the repository root.

Keep four classes of findings separate throughout:
- `observed fact`: direct statements from docs, tests, schemas, types, and code.
- `strong inference`: architectural conclusions drawn from multiple facts.
- `portability hazard`: assumptions tied to the source language, runtime, terminal, OS, or third-party SDKs.
- `open question`: missing or conflicting behavior that still needs evidence.

Prefer concept names over source names:
- Translate file- or class-level details into concepts such as `provider adapter`, `message normalizer`, `agent loop`, `tool executor`, `session store`, `render loop`, `UI surface`, or `product shell`.
- Do not assume the target implementation should mirror the source folder layout.

Treat layered repositories as a composition problem:
- Identify the lowest reusable core first.
- Separate shared middle layers from delivery surfaces.
- Treat UI, CLI, bot, web, or deployment wrappers as adapters around shared behavior unless evidence says otherwise.
- Look for reusable layers such as provider normalization, agent runtime, UI surfaces, and product wrappers.

Sort features by porting importance:
- `core`: required for the system to function.
- `important`: required for parity on major workflows.
- `optional`: valuable, but not required for a first viable port.
- `incidental`: source-specific ergonomics or implementation accidents.

If the defect report is available, integrate defect findings into the porting bundle:
- Reference relevant defects in the feature contract table.
- Tag each referenced defect with a porting recommendation: `fix before porting` (the defect would carry into a new implementation), `port differently` (the new implementation should handle this case differently by design), or `leave behind` (the defect is specific to the source implementation and won't survive porting).
- Consolidate defect-related portability hazards alongside hazards from other phases.

Use the output template at `templates/reverse-engineering-bundle.md`. Produce:
- A system summary in plain language.
- A layer map with package or module ownership.
- A feature contract table with porting priority (include defect references if the defect report exists).
- A protocol and state note set.
- Portability hazards consolidated from all prior phases.
- Observed facts separated from inferred structure.

Bias toward evidence over cleverness:
- Prefer tests over assumptions.
- Prefer behavior over implementation detail.
- Mark uncertainty explicitly instead of flattening it away.

When fixing defects before or during porting, use the tracker template at `templates/defect-fix-tracker.md` to log each fix, deferral, or acceptance decision. The tracker uses defect IDs from the report (D{pass}.{number}) so progress maps directly back to findings.
