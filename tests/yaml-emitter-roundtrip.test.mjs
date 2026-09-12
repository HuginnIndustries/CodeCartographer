// The emitter quotes any string the reader would not hand back unchanged,
// and the readers coerce scalar text instead of assuming it (self-audit
// #225, D-H3; probes A2 and B2).
//
// "2048", "true", "null", "1.5" went out bare and came back as a number, a
// boolean, or nothing. A repository named `2048` got `project_name: 2048` in
// status.yaml and the next load threw `project_name?.trim is not a function`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { parseSimpleYaml, stringifySimpleYaml, formatYamlScalar, normalizeStatus, textOf, ensureArray } = core;

const TRICKY = [
	"2048", "007", "-5", "1.5", "-0.25", "1e3", "0x10",
	"true", "false", "null", "True", "NULL", "yes", "no", "~", "on", "off",
	"[]", "{}", "[a, b]", "{a: 1}",
	"-", "--", "- item", "-x",
	"a:b", "a: b", "key:", "#comment", "a #b", " padded ", "  ", "tab\tin", "line\nbreak", "\"quoted\"", "it's", "back\\slash",
	"|", ">", "|-", ">-", "*ref", "&anchor", "!tag", "%directive", "@at", "`tick`",
	"plain", "with-dash_and.dot/slash", "üñíçødé", "emoji 🚀",
];

test("every tricky string round-trips through the emitter and the reader, as a value and as a list item", () => {
	for (const s of TRICKY) {
		const doc = { value: s, list: [s, "plain", s], nested: { deep: s } };
		const text = stringifySimpleYaml(doc);
		let back;
		try {
			back = parseSimpleYaml(text);
		} catch (error) {
			assert.fail(`${JSON.stringify(s)} produced YAML the reader rejects:\n${text}\n${error.message}`);
		}
		assert.deepEqual(back, doc, `${JSON.stringify(s)} did not round-trip; emitted:\n${text}`);
	}
});

test("the emitter quotes exactly the strings the reader would coerce", () => {
	for (const [value, expected] of [
		["2048", '"2048"'], ["true", '"true"'], ["null", '"null"'], ["1.5", '"1.5"'], ["-5", '"-5"'], ["[]", '"[]"'], ["{}", '"{}"'], ["-", '"-"'],
		["plain", "plain"], ["v1.2.3", "v1.2.3"], ["a/b-c_d.e", "a/b-c_d.e"], ["1e3", "1e3"], ["007x", "007x"],
	]) {
		assert.equal(formatYamlScalar(value), expected, JSON.stringify(value));
	}
	// Real numbers, booleans, and null still go out bare: that is their type.
	assert.equal(formatYamlScalar(2048), "2048");
	assert.equal(formatYamlScalar(true), "true");
	assert.equal(formatYamlScalar(null), "null");
});

test("random strings over the awkward alphabet round-trip (seeded)", () => {
	const alphabet = "ab09-_.:#/ \"'\\|>~[]{}!&*%@`\n\t";
	let seed = 20260912;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let i = 0; i < 400; i++) {
		const length = 1 + Math.floor(rand() * 8);
		let s = "";
		for (let j = 0; j < length; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
		const doc = { k: s, items: [s] };
		const back = parseSimpleYaml(stringifySimpleYaml(doc));
		assert.deepEqual(back, doc, `seed run ${i}: ${JSON.stringify(s)} → ${JSON.stringify(stringifySimpleYaml(doc))}`);
	}
});

test("normalizeStatus coerces a bare digit project_name instead of throwing (probe A2)", () => {
	const raw = parseSimpleYaml("project_name: 2048\npipeline: workflow/p.yaml\nschema_version: 1\ncurrent_phase: 7\nlast_updated: 2026\n");
	assert.equal(raw.project_name, 2048, "the pre-#225 file really holds a number");
	const status = normalizeStatus(raw, { phase_order: ["a"], phases: [{ id: "a" }] }, "workflow/p.yaml", "/tmp/x");
	assert.equal(status.project_name, "2048");
	assert.equal(status.current_phase, "7");
	assert.equal(status.last_updated, "2026");
});

test("textOf and ensureArray keep numeric and boolean scalars as text, drop the rest", () => {
	assert.equal(textOf("x"), "x");
	assert.equal(textOf(2048), "2048");
	assert.equal(textOf(true), "true");
	assert.equal(textOf(null), null);
	assert.equal(textOf(undefined), null);
	assert.equal(textOf([1]), null);
	assert.deepEqual(ensureArray(["real note", 42, true, null, { k: 1 }, "2048"]), ["real note", "42", "true", "2048"]);
});

test("entry fields written bare are read as text, not dropped", () => {
	const raw = parseSimpleYaml("carry_forward:\n  - id: 42\n    target_phase: contracts\n    description: 2048\n    kind: true\n");
	const entries = core.ensureEntryArray(raw.carry_forward, true);
	assert.deepEqual(entries, [{ id: "42", kind: "true", description: "2048", target_phase: "contracts" }]);
});

test("a repository named 2048 initializes, completes a phase, and reloads", async () => {
	const parent = await mkdtemp(join(tmpdir(), "cc-digit-repo-"));
	const cwd = join(parent, "2048");
	try {
		await mkdir(cwd);
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		assert.match(await readFile(statusPath, "utf8"), /^project_name: "2048"$/m, "the emitter quotes it");
		const status = await server.handleStatus({ cwd });
		assert.match(status.content[0].text, /^Phase: architecture$/m);

		await writeFile(join(cwd, ".codecarto", "findings", "architecture", "architecture-map.md"), "# Map\n\n## Validation\n\n| # | C | R | E |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n", "utf8");
		await mkdir(join(cwd, ".codecarto", "scratch", "handoffs"), { recursive: true });
		await writeFile(join(cwd, ".codecarto", "scratch", "handoffs", "architecture.yaml"), "phase_id: architecture\ncloseout_summary: done\nowner_notes:\n  - 2048\n  - true\n  - a real note\n", "utf8");
		await server.handleComplete({ cwd });
		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.status.project_name, "2048");
		assert.equal(state.status.phases.architecture.status, "complete");
		assert.ok(state.status.phases.architecture.owner_notes.includes("2048"), "a numeric-looking owner note survives as text");
		assert.ok(state.status.phases.architecture.owner_notes.includes("true"));
		const written = await readFile(statusPath, "utf8");
		assert.match(written, /^project_name: "2048"$/m);
		assert.match(written, /^ {6}- "2048"$/m, "the note is written quoted");
		assert.match(written, /^ {6}- "true"$/m);
	} finally {
		await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("a status.yaml written before the fix, holding the number bare, loads and is rewritten quoted", async () => {
	const parent = await mkdtemp(join(tmpdir(), "cc-digit-legacy-"));
	const cwd = join(parent, "2048");
	try {
		await mkdir(cwd);
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		// What 0.19.x wrote for this repository.
		await writeFile(statusPath, (await readFile(statusPath, "utf8")).replace('project_name: "2048"', "project_name: 2048"), "utf8");
		assert.match(await readFile(statusPath, "utf8"), /^project_name: 2048$/m);

		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.status.project_name, "2048", "the pre-fix file loads instead of throwing");
		assert.match((await server.handleStatus({ cwd })).content[0].text, /^Phase: architecture$/m);

		// The next write through the framework normalizes the file.
		await server.handleSwitchPipeline({ cwd, pipeline: "lite" });
		assert.match(await readFile(statusPath, "utf8"), /^project_name: "2048"$/m);
	} finally {
		await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
