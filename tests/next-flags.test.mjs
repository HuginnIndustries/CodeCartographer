// Tests for /codecarto-next argument parsing. Tiny module, but the
// override-vs-config interaction in index.ts hinges on its return shape
// behaving correctly for both the present-and-absent flag cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseNextFlags } = await import(`${REPO_ROOT}/extensions/codecarto/next-flags.ts`);

test("empty args yield no override and no unknowns", () => {
	const r = parseNextFlags("");
	assert.equal(r.llmSteerOverride, undefined);
	assert.deepEqual(r.unknown, []);
});

test("--llm-steer sets override true", () => {
	assert.equal(parseNextFlags("--llm-steer").llmSteerOverride, true);
});

test("--no-llm-steer sets override false", () => {
	assert.equal(parseNextFlags("--no-llm-steer").llmSteerOverride, false);
});

test("later flag wins when both passed (last assignment in token order)", () => {
	assert.equal(parseNextFlags("--llm-steer --no-llm-steer").llmSteerOverride, false);
	assert.equal(parseNextFlags("--no-llm-steer --llm-steer").llmSteerOverride, true);
});

test("unknown flags are collected for the caller to surface", () => {
	const r = parseNextFlags("--llm-steer --bogus extra");
	assert.equal(r.llmSteerOverride, true);
	assert.deepEqual(r.unknown, ["--bogus", "extra"]);
});

test("whitespace tolerance: extra spaces don't produce empty unknowns", () => {
	const r = parseNextFlags("   --llm-steer   ");
	assert.equal(r.llmSteerOverride, true);
	assert.deepEqual(r.unknown, []);
});
