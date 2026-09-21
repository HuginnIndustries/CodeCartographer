// TEMPORARY probe: proves branch protection blocks a failing PR.
// Deleted immediately after the check; never merged.
import { test } from "node:test";
import assert from "node:assert/strict";

test("deliberate failure proving the required checks gate", () => {
	assert.equal(1, 2, "this must fail");
});
