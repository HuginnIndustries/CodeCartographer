import assert from "node:assert/strict";
import test from "node:test";
import { smokeProfile } from "../scripts/smoke-profile.mjs";

test("published 0.26.0 uses its shipped tool inventory and legacy checks", () => {
	const profile = smokeProfile({ version: "0.26.0", tarball: false });
	assert.equal(profile.expectedTools.includes("codecarto_change"), false);
	assert.equal(profile.checkModernProtocol, false);
});

test("a current tarball exercises the full tool inventory and modern protocol", () => {
	const profile = smokeProfile({ version: null, tarball: true });
	assert.equal(profile.expectedTools.includes("codecarto_change"), true);
	assert.equal(profile.checkModernProtocol, true);
});
