// Regression cover for the path-safety guards and the scaffold version gates.
//
// These were the four load-bearing functions in core/ that no test named. All
// four were correct when this file was written — the point is not to fix them
// but to pin them, because each fails silently. A traversal guard that starts
// accepting `../` does not throw anywhere; a version comparison that regresses
// to string ordering just stops firing a refusal, and the refusal is the only
// thing that was protecting the invariant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
	assertSafePhaseId,
	assertSafeAmendmentSlug,
	compareDottedVersions,
	findingsPairingGateActive,
	closureEvidenceGateActive,
	FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION,
	CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION,
} = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);

// ---------- path safety ----------

const TRAVERSAL_ATTEMPTS = ["../escape", "..", ".", "a/b", "a\\b", "/absolute", "./relative", "", "   "];

test("phase ids that could escape the workspace are rejected", () => {
	for (const id of TRAVERSAL_ATTEMPTS) {
		assert.throws(
			() => assertSafePhaseId(id),
			/Invalid phase id/,
			`${JSON.stringify(id)} must not be accepted as a phase id`,
		);
	}
});

test("amendment slugs that could escape the amendments directory are rejected", () => {
	for (const slug of TRAVERSAL_ATTEMPTS) {
		assert.throws(
			() => assertSafeAmendmentSlug(slug),
			/Invalid amendment name/,
			`${JSON.stringify(slug)} must not be accepted as an amendment name`,
		);
	}
});

test("the phase ids the shipped pipelines actually use are still accepted", () => {
	for (const id of ["architecture", "contracts", "protocols", "deep-audit", "porting"]) {
		assert.doesNotThrow(() => assertSafePhaseId(id));
	}
	assert.doesNotThrow(() => assertSafeAmendmentSlug("my-amendment"));
});

// ---------- version comparison ----------

test("versions compare numerically, not as strings", () => {
	// The failure this guards against: string ordering puts "0.9.0" after
	// "0.10.0", which silently inverts every gate built on this function.
	assert.ok(compareDottedVersions("0.9.0", "0.10.0") < 0, "0.9.0 precedes 0.10.0");
	assert.ok(compareDottedVersions("0.10.0", "0.9.0") > 0);
	assert.ok(compareDottedVersions("0.2.0", "0.10.0") < 0);
	assert.ok(compareDottedVersions("2.0.0", "10.0.0") < 0);
	assert.ok(compareDottedVersions("0.17.1", "0.17.10") < 0);
	assert.equal(compareDottedVersions("1.0.0", "1.0.0"), 0);
});

test("versions with different segment counts are uncomparable, not guessed", () => {
	assert.equal(compareDottedVersions("1.0.0", "1.0"), null);
	assert.equal(compareDottedVersions("1.0", "1.0.0"), null);
});

// ---------- scaffold gates ----------

test("each gate turns on exactly at its own scaffold version", () => {
	for (const [gate, at] of [
		[findingsPairingGateActive, FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION],
		[closureEvidenceGateActive, CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION],
	]) {
		assert.equal(gate(at), true, `the gate must be active at ${at} itself`);
		assert.equal(gate("0.1.0"), false, "an old scaffold must only be warned, not refused");
		assert.equal(gate("99.0.0"), true, "a newer scaffold keeps the gate active");
	}
});

test("a missing or unparseable scaffold version never activates a gate", () => {
	// An unknown scaffold is the older-workspace case, which warns rather than
	// refuses. Activating on absence would refuse every pre-marker workspace.
	for (const value of [undefined, null, "", "   ", "not-a-version"]) {
		assert.equal(findingsPairingGateActive(value), false, `${JSON.stringify(value)} must not activate the gate`);
		assert.equal(closureEvidenceGateActive(value), false, `${JSON.stringify(value)} must not activate the gate`);
	}
});

test("the two gates are ordered as the changelog describes", () => {
	// findings pairing shipped first; closure evidence came later. A workspace
	// old enough to miss the second may still be new enough for the first.
	assert.ok(
		compareDottedVersions(FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION, CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION) < 0,
		"the findings gate must predate the closure gate",
	);
	const between = FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION;
	assert.equal(findingsPairingGateActive(between), true);
	assert.equal(closureEvidenceGateActive(between), false);
});
