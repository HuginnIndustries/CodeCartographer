# E11 end-to-end pilot fixtures

Synthetic test data for `tests/engineering-e2e.test.mjs` (E11, #409).

- `plan-widgets.md` — a small planning artifact (Acceptance Scenarios and
  Slices tables, including a Verification route column) that `liftSlices`
  reads into slice inputs for `buildChangePlan`.
- `plan-widgets-no-route.md` — the same artifact with the slice's route written
  as `none`, used by the N07 (unavailable environment) control.
- `manifest.json` — an in-memory working tree the tests hand to
  `collectSnapshot`; the digests are of the literal `body` strings.

None of this is evidence of a human gate. No approval record is produced by
any test in the suite, and `VERIFIED_ACCEPTANCE_INTEGRATIONS` stays empty.
The record shapes themselves are E01-owned and are read from
`tests/fixtures/engineering/v1/valid/`; the files here only supply the
planning text and the tree contents.
