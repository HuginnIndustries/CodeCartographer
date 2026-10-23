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

// #463: the MCP Registry validates against npm, and in v0.27.0 it ran seconds
// after `npm publish` and got a 404. The registry publish must sit behind the
// npm-visibility wait, and the GitHub Release must not sit behind the registry.
test("release.yml waits for npm visibility before the MCP Registry, and releases before both", async () => {
	const text = await readFile(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
	const at = (needle) => {
		const index = text.indexOf(needle);
		assert.ok(index >= 0, `release.yml contains ${needle}`);
		return index;
	};
	const npmPublish = at("npm publish --registry");
	const ghRelease = at("gh release create");
	const wait = at("scripts/wait-for-npm-version.sh");
	const mcpPublish = at("./mcp-publisher publish");
	assert.ok(npmPublish < ghRelease, "GitHub Release is created after npm publish");
	assert.ok(ghRelease < wait, "GitHub Release is not held back by the registry steps");
	assert.ok(wait < mcpPublish, "MCP Registry publish waits for npm visibility");
	assert.doesNotMatch(text, /if:\s*always\(\)/, "no step bypasses the failed-npm-publish gate");
});

// Hermetic: a fake `npm` on PATH plays back a scripted sequence of lookups.
async function runWait({ responses, timeout }) {
	const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { spawnSync } = await import("node:child_process");
	const dir = await mkdtemp(join(tmpdir(), "wait-npm-"));
	try {
		const cases = responses
			.map((r, i) => `  ${i + 1}) ${r.out ? `echo '${r.out}'; ` : ""}${r.err ? `echo '${r.err}' >&2; ` : ""}exit ${r.code ?? 0} ;;`)
			.join("\n");
		await writeFile(
			join(dir, "npm"),
			`#!/usr/bin/env bash\necho "$@" >> "${dir}/calls"\nn=$(wc -l < "${dir}/calls")\ncase "$n" in\n${cases}\n  *) exit 1 ;;\nesac\n`,
		);
		await chmod(join(dir, "npm"), 0o755);
		const result = spawnSync("bash", [join(REPO_ROOT, "scripts", "wait-for-npm-version.sh"), "pkg", "1.2.3"], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				NPM_WAIT_TIMEOUT_SECONDS: String(timeout),
				NPM_WAIT_INTERVAL_SECONDS: "0",
			},
		});
		const calls = (await readFile(join(dir, "calls"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
		return { ...result, calls };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("wait-for-npm-version succeeds once npm serves the exact version", async () => {
	const r = await runWait({
		timeout: 30,
		responses: [{ code: 1, err: "npm error code E404" }, { out: "" }, { out: "1.2.30" }, { out: "1.2.3" }],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.calls.length, 4);
	assert.equal(r.calls[0], "view pkg@1.2.3 version --prefer-online");
	assert.match(r.stdout, /pkg@1\.2\.3 is visible on npm/);
});

test("wait-for-npm-version fails with a clear message and the last npm error on timeout", async () => {
	const r = await runWait({ timeout: 0, responses: [{ code: 1, err: "npm error code E401 Unable to authenticate" }] });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /pkg@1\.2\.3 did not appear on the npm registry within 0s/);
	assert.match(r.stderr, /E401 Unable to authenticate/);
});
