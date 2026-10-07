// The suite drives the shipped binary in dist/, so every workflow that runs
// it must build first. release.yml ran `npm test` before `npm run build` and
// the v0.27.0 tag push failed on 51 tests that found no dist/ — CI had the
// right order, so nothing caught the drift until a release.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function runLines(workflow) {
	const text = await readFile(join(REPO_ROOT, ".github", "workflows", workflow), "utf8");
	return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("run: "));
}

for (const workflow of ["ci.yml", "release.yml"]) {
	test(`${workflow} builds before it runs the test suite`, async () => {
		const runs = await runLines(workflow);
		const tests = runs.map((line, index) => (line === "run: npm test" ? index : -1)).filter((index) => index >= 0);
		assert.ok(tests.length > 0, `${workflow} runs npm test`);
		for (const testIndex of tests) {
			const build = runs.slice(0, testIndex).lastIndexOf("run: npm run build");
			assert.ok(build >= 0, `${workflow}: npm test at run step ${testIndex} has no npm run build before it`);
		}
	});
}
