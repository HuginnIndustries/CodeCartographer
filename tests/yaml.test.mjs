// Parser tests for core/yaml.ts.
//
// The YAML here is not internal plumbing: pipeline files, status.yaml and the
// Broad-Side config are all hand-editable by users, and a breaking change to
// their shape is ABI. Two defects below were found by a live Broad-Side scan of
// this repository and confirmed against the parser before being fixed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseSimpleYaml, stringifySimpleYaml } = await import(pathToFileURL(`${REPO_ROOT}/core/yaml.ts`).href);

// ---------- keys that collide with Object.prototype ----------

test("a key named after a prototype member is an ordinary key", () => {
	// `key in result` is true for every Object.prototype member before anything
	// is parsed, so these were each rejected as a duplicate on first sight.
	for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
		const parsed = parseSimpleYaml(`${key}: hello\nother: world\n`);
		assert.equal(parsed[key], "hello", `${key} must parse as a value`);
		assert.equal(parsed.other, "world");
	}
});

test("a __proto__ key becomes an entry rather than changing the prototype", () => {
	const parsed = parseSimpleYaml("__proto__: injected\nkept: yes\n");
	assert.equal(parsed.kept, "yes");
	assert.ok(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), "__proto__ must be an own property");
	assert.equal(Object.getPrototypeOf(parsed), Object.prototype, "the object's prototype must be untouched");
	assert.equal({}.injected, undefined, "nothing may leak onto Object.prototype");
});

test("a genuinely repeated key is still rejected", () => {
	assert.throws(() => parseSimpleYaml("dup: one\ndup: two\n"), /Duplicate YAML key: dup/);
	// Including one that happens to share a name with a prototype member.
	assert.throws(() => parseSimpleYaml("toString: one\ntoString: two\n"), /Duplicate YAML key: toString/);
});

// ---------- sequence item indentation ----------

test("a sequence item's mapping continues at its own content column", () => {
	// The child mapping used to be parsed at a fixed two columns past the dash,
	// so any item whose content started further in — a perfectly ordinary way to
	// align a list — threw "Invalid YAML indentation".
	const layouts = {
		"one space after the dash": "phases:\n  - id: architecture\n    primary_output: reports/architecture.md\n",
		"three spaces after the dash": "phases:\n  -   id: architecture\n      primary_output: reports/architecture.md\n",
		"four-space list indent": "phases:\n    - id: architecture\n      primary_output: reports/architecture.md\n",
		"five spaces after the dash": "phases:\n  -     id: architecture\n        primary_output: reports/architecture.md\n",
	};
	for (const [name, text] of Object.entries(layouts)) {
		const parsed = parseSimpleYaml(text);
		assert.deepEqual(
			parsed.phases,
			[{ id: "architecture", primary_output: "reports/architecture.md" }],
			`${name} must parse to the same mapping`,
		);
	}
});

test("nested sequences under an aligned item still parse", () => {
	const parsed = parseSimpleYaml("phases:\n  -   id: contracts\n      depends_on:\n        - architecture\n        - protocols\n");
	assert.deepEqual(parsed.phases, [{ id: "contracts", depends_on: ["architecture", "protocols"] }]);
});

// ---------- round trip ----------

test("the shipped emitter's output parses back to the same object", () => {
	const original = {
		project_name: "example",
		schema_version: 1,
		phases: [
			{ id: "architecture", status: "complete" },
			{ id: "contracts", status: "pending" },
		],
	};
	assert.deepEqual(parseSimpleYaml(stringifySimpleYaml(original)), original);
});

// ---------- block scalars ----------
//
// A handoff is usually written by a model, and a model reaching for a wrapped
// prose field reaches for `>-`. Before #211 that fell through to the plain
// scalar path and the block body then failed the indentation check, so valid
// YAML was rejected with a message that blamed whitespace.

test("a folded scalar joins its lines with spaces instead of being rejected", () => {
	const parsed = parseSimpleYaml("closeout_summary: >-\n  one line\n  two line\n");
	assert.equal(parsed.closeout_summary, "one line two line");
});

test("folded chomping: strip, clip and keep each behave", () => {
	assert.equal(parseSimpleYaml("k: >-\n  a\n  b\n").k, "a b", "`-` strips every trailing newline");
	assert.equal(parseSimpleYaml("k: >\n  a\n  b\n").k, "a b\n", "bare `>` clips to one trailing newline");
	assert.equal(parseSimpleYaml("k: >+\n  a\n\n\n").k, "a\n\n\n", "`+` keeps them all");
});

test("a blank line inside a folded scalar becomes a newline, and a run becomes that many", () => {
	assert.equal(parseSimpleYaml("k: >-\n  para one a\n  para one b\n\n  para two\n").k, "para one a para one b\npara two");
	assert.equal(parseSimpleYaml("k: >-\n  a\n\n\n  b\n").k, "a\n\nb");
});

test("a more-indented line inside a folded scalar keeps its breaks", () => {
	// This is what lets a folded block hold a snippet without flattening it.
	assert.equal(parseSimpleYaml("k: >-\n  intro\n    code line\n  outro\n").k, "intro\n  code line\noutro");
});

test("literal scalars are unchanged, and `|+` now works alongside them", () => {
	assert.equal(parseSimpleYaml("k: |-\n  one\n  two\n").k, "one\ntwo");
	assert.equal(parseSimpleYaml("k: |\n  one\n  two\n").k, "one\ntwo\n");
	assert.equal(parseSimpleYaml("k: |+\n  one\n\n").k, "one\n\n");
});

test("a value that merely starts with a block indicator is still a plain scalar", () => {
	assert.equal(parseSimpleYaml("k: |x\n").k, "|x");
	assert.equal(parseSimpleYaml("k: > not a header\n").k, "> not a header");
});

// A block scalar can also open a sequence item. Supporting it only as a mapping
// value (#211) left `- >-` still failing with the same indentation error, which
// is what a real handoff hit: an LLM writing a `decisions:` list reaches for
// `- >-` per entry just as readily as it reaches for `key: >-`.

test("a block scalar can open a sequence item", () => {
	assert.deepEqual(parseSimpleYaml("k:\n  - >-\n    a\n    b\n").k, ["a b"]);
	assert.deepEqual(parseSimpleYaml("k:\n  - |-\n    a\n    b\n").k, ["a\nb"]);
});

test("sequence block scalars sit alongside their siblings without swallowing them", () => {
	const parsed = parseSimpleYaml(
		"decisions:\n  - >-\n    first one wrapped\n    across two lines\n  - plain second\n  - >-\n    third one\nother: kept\n",
	);
	assert.deepEqual(parsed.decisions, ["first one wrapped across two lines", "plain second", "third one"]);
	assert.equal(parsed.other, "kept", "the key after the sequence must survive");
});

test("a block scalar inside a sequence item's mapping still parses", () => {
	const parsed = parseSimpleYaml(
		"carry_forward:\n  - id: arch-CF1\n    description: >-\n      wrapped one\n      wrapped two\n    target_phase: contracts\n",
	);
	assert.deepEqual(parsed.carry_forward, [
		{ id: "arch-CF1", description: "wrapped one wrapped two", target_phase: "contracts" },
	]);
});

test("chomping works on sequence block scalars too", () => {
	assert.deepEqual(parseSimpleYaml("k:\n  - >\n    a\n").k, ["a\n"]);
	assert.deepEqual(parseSimpleYaml("k:\n  - >-\n    a\n").k, ["a"]);
});
