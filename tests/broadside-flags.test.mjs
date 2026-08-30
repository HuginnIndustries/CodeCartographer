// Tests for /codecarto-broadside argument parsing. The grammar mixes an
// action, bare lens names, and flags in any order, so the parse is where a
// mistyped command becomes either a clear error or a surprise batch of spend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseBroadsideFlags, KNOWN_BROADSIDE_TOKENS } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/broadside-flags.ts`).href
);

test("no arguments means submit with the repository's default lenses", () => {
	const r = parseBroadsideFlags("");
	assert.equal(r.action, "submit");
	assert.deepEqual(r.lenses, [], "empty means 'let config decide', not 'no lenses'");
	assert.equal(r.incremental, false);
	assert.equal(r.maxCost, undefined);
	assert.equal(r.waitSeconds, undefined);
	assert.deepEqual(r.unknown, []);
	assert.equal(r.error, undefined);
});

test("an action and lens names parse in either order", () => {
	assert.deepEqual(parseBroadsideFlags("submit architecture security").lenses, ["architecture", "security"]);
	const reversed = parseBroadsideFlags("architecture security submit");
	assert.equal(reversed.action, "submit", "a lens before the action still leaves submit the action");
	assert.deepEqual(reversed.lenses, ["architecture", "security"]);
});

test("a lens named twice is one lens", () => {
	assert.deepEqual(parseBroadsideFlags("submit defect defect").lenses, ["defect"]);
});

test("only the first action token is the action; a second is unknown", () => {
	const r = parseBroadsideFlags("collect status");
	assert.equal(r.action, "collect");
	assert.deepEqual(r.unknown, ["status"]);
});

test("negative flags carry false, and absence carries undefined", () => {
	const bare = parseBroadsideFlags("collect");
	assert.equal(bare.includeSynthesis, undefined, "absence must defer to config, not force true");
	assert.equal(bare.includeTriage, undefined);
	assert.equal(bare.retryTruncated, undefined);

	const off = parseBroadsideFlags("collect --no-synthesis --no-triage --no-retry-truncated");
	assert.equal(off.includeSynthesis, false);
	assert.equal(off.includeTriage, false);
	assert.equal(off.retryTruncated, false);
});

test("numeric flags parse their value", () => {
	const r = parseBroadsideFlags("submit --max-cost=2.50 --wait=900");
	assert.equal(r.maxCost, 2.5);
	assert.equal(r.waitSeconds, 900);
});

test("a malformed numeric flag is an error, never a silent config fallback", () => {
	// "--max-cost=" almost certainly means the user meant to cap the spend.
	for (const args of ["submit --max-cost=", "submit --max-cost=abc", "submit --max-cost=-1"]) {
		const r = parseBroadsideFlags(args);
		assert.match(r.error ?? "", /--max-cost needs a non-negative number/, `${args} must error`);
	}
	assert.match(parseBroadsideFlags("collect --wait=soon").error ?? "", /--wait needs a non-negative number/);
});

test("flags that mean nothing for the chosen action are refused, not ignored", () => {
	assert.match(parseBroadsideFlags("collect --incremental").error ?? "", /--incremental is only meaningful for submit/);
	assert.match(parseBroadsideFlags("collect architecture").error ?? "", /Lens names are only meaningful for submit/);
	assert.match(parseBroadsideFlags("submit --benchmarks").error ?? "", /--benchmarks is only meaningful for models/);
	assert.match(parseBroadsideFlags("status --wait=60").error ?? "", /--wait is only meaningful for submit and collect/);
	assert.equal(parseBroadsideFlags("models --benchmarks").error, undefined);
});

test("unknown tokens are collected for the caller to surface", () => {
	const r = parseBroadsideFlags("submit --bogus architecture nonsense");
	assert.deepEqual(r.unknown, ["--bogus", "nonsense"]);
	assert.deepEqual(r.lenses, ["architecture"]);
});

test("extra whitespace produces no empty unknowns", () => {
	assert.deepEqual(parseBroadsideFlags("   collect   ").unknown, []);
});

test("every completion token the command offers is one the parser accepts", () => {
	// A completer that suggests a token the parser rejects teaches the user a
	// command that fails.
	for (const token of KNOWN_BROADSIDE_TOKENS) {
		// Value-taking flags are offered as a prefix ("--max-cost="); complete
		// them with a value before parsing.
		const arg = token.endsWith("=") ? `${token}1` : token;
		const context = token === "--benchmarks" ? "models " : token === "--wait=" ? "collect " : "";
		const r = parseBroadsideFlags(`${context}${arg}`);
		assert.deepEqual(r.unknown, [], `completion token ${token} parses as unknown`);
		assert.equal(r.error, undefined, `completion token ${token} errors: ${r.error}`);
	}
});
