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
