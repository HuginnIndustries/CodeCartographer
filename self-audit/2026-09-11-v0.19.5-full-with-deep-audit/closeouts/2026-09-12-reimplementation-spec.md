# Closeout — reimplementation-spec

## Summary

- Primary output: `findings/reimplementation-spec/reimplementation-spec.md` (PASS, 8/8).
- Variant language-agnostic, run-instructed default (front matter).
- Kernel K1-K6 over ports P1-P5, adapters A1-A5, extensions X1-X6, delivery D1-D4; layer
  split; 21 required behaviors folding every defect disposition into normative rules;
  byte-for-byte vs re-encodable persisted state; dependency stances; twelve kernel-first
  milestones with three scope tiers; 30 acceptance scenarios (11 H, 12 M, 7 C) plus the
  32 contract scenarios by reference; non-goals; five spikes.

## Routed and closed

- Closed port-CF1 (strategic assumptions recorded) and port-CF2 (rings and H-tests).
- Registered q-findings-commit-policy, q-publish-confirm-on-init, q-opinionated-rerun
  (needs-maintainer-decision).
- post_pipeline: spike-openrouter-fixture, spike-codex-envelope, spike-pi-sandbox-e2e,
  spike-windows-atomicity, spike-session-disposal.

## Coverage

- Bundle read in full; no lower-level deep reads needed; synthesis phases and lens prompt
  wording remain PARTIAL as inherited.

## Proposed Conventions

- None this phase.

## Decisions Beyond Prompt

- The reimplementation-spec variant was chosen (language-agnostic) without the interactive Strategic Alignment Hook because the run's instructions forbid pausing for the user; the choice, its reason, and the three unresolved product decisions are recorded so an opinionated rerun can supersede them.
- Spikes are recorded as post_pipeline entries rather than the carry_forward targets the template suggests (spike/delta/amendment), because completion refuses any target_phase outside the active pipeline; the template guidance contradicts the gate.
