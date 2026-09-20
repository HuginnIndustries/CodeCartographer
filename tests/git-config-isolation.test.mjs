// Git-configuration isolation in the test harness (#412, pilot B01).
//
// Seven test files build real Git fixtures and must not inherit the
// developer's Git configuration. The guard they carried pointed
// GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at a path that does not exist,
// which neutralizes the two FILE sources — but git has a third source,
// injected through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,
// whose origin git reports as `command line:`. Redirecting file lookups
// cannot reach it, so a contributor with
//
//     url.https://github.com/.insteadOf = git@github.com:
//
// in their environment saw `resolvePublishSourceRepo records origin's fetch
// URL verbatim` fail on a tree that is green on CI's bare runners.
//
// These tests exercise the isolation boundary itself. Every case runs the
// real thing in a FRESH CHILD PROCESS with the rewrite injected into that
// child's environment, because the boundary is about what a process inherits
// at startup: asserting on `process.env` in this process, or letting an
// earlier test's cleanup set the stage, would manufacture a pass.
//
// The injected variables never leave the child. Nothing here reads or writes
// the user's Git configuration.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The rewrite that reproduces #412: SSH-syntax remotes routed over HTTPS. */
const INJECTED = {
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
	GIT_CONFIG_VALUE_0: "git@github.com:",
};

/** The seven files that build Git fixtures and carry the guard. */
const GUARDED_FILES = [
	"tests/broadside-repo-collection.test.mjs",
	"tests/broadside.test.mjs",
	"tests/library.test.mjs",
	"tests/mcp-uncovered-handlers.test.mjs",
	"tests/pi-broadside.test.mjs",
	"tests/pi-command-handlers.test.mjs",
	"tests/pi-publish.test.mjs",
];

async function withTempDir(fn) {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-gitconfig-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Run a script in a fresh child process with `env` merged over the parent's. */
async function runChild(source, env) {
	return await withTempDir(async (dir) => {
		const file = join(dir, "probe.mjs");
		await writeFile(file, source, "utf8");
		const { stdout } = await execFileAsync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", file], {
			env: { ...process.env, ...env },
			cwd: REPO_ROOT,
		});
		return stdout.trim();
	});
}

test("the injected rewrite really does reach git — the defect is real", async () => {
	// The negative control. Without this, every assertion below could pass
	// because the rewrite never worked in the first place.
	await withTempDir(async (dir) => {
		await execFileAsync("git", ["-C", dir, "init", "--quiet"]);
		await execFileAsync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:Acme/Tool.git"]);
		const { stdout } = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], {
			env: { ...process.env, ...INJECTED, GIT_CONFIG_GLOBAL: "/nonexistent", GIT_CONFIG_SYSTEM: "/nonexistent" },
		});
		assert.equal(
			stdout.trim(),
			"https://github.com/Acme/Tool.git",
			"with only the file lookups redirected, the injected rewrite still applies — this is #412",
		);
	});
});

test("the helper neutralizes the injected rewrite in a fresh child process", async () => {
	const out = await runChild(
		`import "${REPO_ROOT}/tests/helpers/git-config-isolation.mjs";
		import { execFile } from "node:child_process";
		import { mkdtemp } from "node:fs/promises";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { promisify } from "node:util";
		const run = promisify(execFile);
		const dir = await mkdtemp(join(tmpdir(), "probe-"));
		await run("git", ["-C", dir, "init", "--quiet"]);
		await run("git", ["-C", dir, "remote", "add", "origin", "git@github.com:Acme/Tool.git"]);
		const { stdout } = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
		process.stdout.write(stdout.trim());`,
		INJECTED,
	);
	assert.equal(out, "git@github.com:Acme/Tool.git", "the SCP-syntax remote is preserved verbatim");
});

test("isolation survives a large injected config set, not just one entry", async () => {
	// GIT_CONFIG_COUNT=0 makes every KEY_n/VALUE_n inert without needing to
	// know how many were supplied. Deleting them one at a time would not.
	const many = { GIT_CONFIG_COUNT: "3" };
	for (const [i, [k, v]] of [
		["url.https://github.com/.insteadOf", "git@github.com:"],
		["core.autocrlf", "true"],
		["commit.gpgsign", "true"],
	].entries()) {
		many[`GIT_CONFIG_KEY_${i}`] = k;
		many[`GIT_CONFIG_VALUE_${i}`] = v;
	}
	const out = await runChild(
		`import "${REPO_ROOT}/tests/helpers/git-config-isolation.mjs";
		import { execFile } from "node:child_process";
		import { promisify } from "node:util";
		const run = promisify(execFile);
		const { stdout } = await run("git", ["config", "--list", "--show-origin"]);
		process.stdout.write(String(stdout.split("\\n").filter((l) => l.startsWith("command line:")).length));`,
		many,
	);
	assert.equal(out, "0", "no configuration is still arriving from the command line");
});

test("the helper runs before the modules under test, not merely at module scope", async () => {
	// The ordering property the old guard lacked. In ESM every static import
	// is evaluated before the importing module's body, so three lines at
	// module scope run AFTER the code under test has been imported — and in
	// broadside-repo-collection.test.mjs the guard sat after a dynamic
	// `await import()` of that very code. A module that reads the rewrite at
	// import time therefore saw it. Here the probe imports the isolation
	// first, so the observer module must see a clean environment.
	const out = await runChild(
		`import "${REPO_ROOT}/tests/helpers/git-config-isolation.mjs";
		import { execFile } from "node:child_process";
		import { promisify } from "node:util";
		const run = promisify(execFile);
		// Simulates a module that resolves git config during its own evaluation.
		const { stdout } = await run("git", ["config", "--get", "url.https://github.com/.insteadOf"]).catch(() => ({ stdout: "" }));
		process.stdout.write(stdout.trim() === "" ? "clean" : "leaked:" + stdout.trim());`,
		INJECTED,
	);
	assert.equal(out, "clean", "the rewrite is gone before anything else is imported");
});

test("every guarded file imports the isolation helper first", async () => {
	// One passing file is insufficient (B01-A3): assert the boundary is
	// applied at all seven sites, and that it is genuinely FIRST — the defect
	// in broadside-repo-collection.test.mjs was position, not absence.
	const { readFile } = await import("node:fs/promises");
	for (const relative of GUARDED_FILES) {
		const source = await readFile(join(REPO_ROOT, relative), "utf8");
		const firstImport = source.match(/^import .*$/m);
		assert.ok(firstImport, `${relative}: expected at least one import`);
		assert.equal(
			firstImport[0],
			'import "./helpers/git-config-isolation.mjs";',
			`${relative}: the isolation import must be the first import in the file`,
		);
		assert.ok(
			!/process\.env\.GIT_CONFIG_(GLOBAL|SYSTEM)\s*=/.test(source),
			`${relative}: the open-coded guard should be gone, replaced by the shared helper`,
		);
	}
});

test("the named failing test passes with the rewrite injected into its runner", async () => {
	// B01-A2 as an assertion rather than a claim: the regression suite passes
	// while its PARENT still supplies the rewrite. Removing the injection
	// from the command would not count.
	//
	// `node --test` refuses to recurse ("run() is being called recursively
	// within a test file. skipping running files"), so the child runs the
	// file DIRECTLY. `node:test` still executes and reports on exit, and a
	// failing assertion still yields a non-zero exit code — which is the
	// signal this case needs.
	const child = await execFileAsync(
		process.execPath,
		["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "tests/library.test.mjs"],
		{ env: { ...process.env, ...INJECTED }, cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
	).catch((error) => error);
	const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
	assert.ok(!(child instanceof Error), `library.test.mjs must pass under injection; exit ${child.code}\n${output.slice(-1500)}`);
	assert.match(output, /resolvePublishSourceRepo records origin's fetch URL verbatim/, "the named test really ran");
	assert.ok(!/^not ok/m.test(output), "no test failed");
});

test("isolation does not touch the user's Git configuration", async () => {
	// B01-A5. The helper only ever assigns to process.env of its own process.
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(join(REPO_ROOT, "tests/helpers/git-config-isolation.mjs"), "utf8");
	assert.ok(!/execFile|spawn|writeFile|git config/.test(source), "the helper runs no commands and writes no files");
	const assignments = [...source.matchAll(/env\.[A-Z_]+\s*=/g)].map((m) => m[0]);
	assert.deepEqual(
		assignments.sort(),
		["env.GIT_CONFIG_COUNT =", "env.GIT_CONFIG_GLOBAL =", "env.GIT_CONFIG_SYSTEM ="].sort(),
		"it sets exactly the three Git configuration sources and nothing else",
	);
});
