// Git-environment isolation in the test harness (#412, pilot B01; widened
// past configuration in #423).
//
// Seven test files build real Git fixtures and must not inherit the
// developer's Git environment — configuration first, and then everything
// else in the same class: an environment variable the developer set for
// their own reasons that changes what a fixture git command does
// (GIT_TEMPLATE_DIR, GIT_DIR, …). The guard they originally carried pointed
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
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The isolation helper as a file:// URL. A bare Windows path (`D:\\...`) is
 * not a valid ESM specifier, so interpolating REPO_ROOT directly into an
 * `import` inside a generated probe fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
 */
const HELPER_URL = pathToFileURL(join(REPO_ROOT, "tests/helpers/git-environment-isolation.mjs")).href;

/** A path git reads as empty config. Matches the helper's own constant. */
const ABSENT = join(tmpdir(), "codecarto-tests-absent-gitconfig");

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
		`import "${HELPER_URL}";
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
		`import "${HELPER_URL}";
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
	// `await import()` of that very code. No module under test currently
	// resolves git configuration while it is being evaluated, so that was a
	// latent hazard rather than a live failure — but it is the kind that
	// appears silently the first time one does. Here the probe imports the
	// isolation first, so the observer must see a clean environment.
	const out = await runChild(
		`import "${HELPER_URL}";
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

test("GIT_CONFIG_PARAMETERS is neutralized, not merely counted down", async () => {
	// The fourth source, and the one the first version of this fix missed.
	// Git uses it to hand `-c key=value` to its OWN subprocesses, so it
	// arrives without anyone setting it deliberately — running the suite
	// under `git bisect run` is enough. It carries its own entries, so
	// GIT_CONFIG_COUNT=0 does not disarm it.
	const injected = { GIT_CONFIG_PARAMETERS: "'url.https://github.com/.insteadOf'='git@github.com:'" };

	// First prove the vector is real: with the other three neutralized but
	// this one left alone, the rewrite still reaches a fixture.
	await withTempDir(async (dir) => {
		await execFileAsync("git", ["-C", dir, "init", "--quiet"]);
		await execFileAsync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:Acme/Tool.git"]);
		const { stdout } = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], {
			env: { ...process.env, ...injected, GIT_CONFIG_GLOBAL: ABSENT, GIT_CONFIG_SYSTEM: ABSENT, GIT_CONFIG_COUNT: "0" },
		});
		assert.equal(stdout.trim(), "https://github.com/Acme/Tool.git", "the vector is real: COUNT=0 does not disarm it");
	});

	// Then prove the helper closes it.
	const out = await runChild(
		`import "${HELPER_URL}";
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
		injected,
	);
	assert.equal(out, "git@github.com:Acme/Tool.git", "the SCP-syntax remote survives GIT_CONFIG_PARAMETERS");
});

/**
 * Configuration-only isolation: exactly what the helper guaranteed before
 * #423. Every "the vector is real" control below runs under THIS, so what it
 * proves is that the four configuration sources being neutralized is not
 * enough — the variable under test reaches the fixture anyway.
 */
const CONFIG_ONLY = { GIT_CONFIG_GLOBAL: ABSENT, GIT_CONFIG_SYSTEM: ABSENT, GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "" };

/** A probe body that builds a committing fixture; the shape every fixture file uses. */
const COMMIT_FIXTURE_PROBE = `import "${HELPER_URL}";
	import { execFile } from "node:child_process";
	import { existsSync } from "node:fs";
	import { mkdtemp, writeFile } from "node:fs/promises";
	import { tmpdir } from "node:os";
	import { join } from "node:path";
	import { promisify } from "node:util";
	const run = promisify(execFile);
	const dir = await mkdtemp(join(tmpdir(), "probe-"));
	await run("git", ["-C", dir, "init", "--quiet"]);
	await run("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	await run("git", ["-C", dir, "config", "user.name", "Test"]);
	await writeFile(join(dir, "a.txt"), "a\\n", "utf8");
	await run("git", ["-C", dir, "add", "a.txt"]);
	await run("git", ["-C", dir, "commit", "--quiet", "-m", "initial"]);
	const { stdout } = await run("git", ["-C", dir, "log", "--format=%s", "-1"]);
	process.stdout.write(stdout.trim());`;

test("GIT_TEMPLATE_DIR is neutralized: a developer's init template cannot install hooks into fixtures (#423)", async () => {
	// Not configuration, so none of the four config sources touch it — but
	// git copies the template directory, hooks/ included, into every
	// `git init`. A developer's executable hooks/pre-commit therefore runs
	// inside every fixture commit.
	await withTempDir(async (template) => {
		const hooks = join(template, "hooks");
		await mkdir(hooks, { recursive: true });
		await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\necho 'template hook ran' >&2\nexit 1\n", { mode: 0o755 });
		const injected = { GIT_TEMPLATE_DIR: template };

		// First prove the vector is real: under configuration-only isolation
		// the template still lands and its failing hook breaks the commit.
		await withTempDir(async (dir) => {
			const env = { ...process.env, ...CONFIG_ONLY, ...injected };
			await execFileAsync("git", ["-C", dir, "init", "--quiet"], { env });
			assert.ok(existsSync(join(dir, ".git", "hooks", "pre-commit")), "the template's hook was copied into the fixture");
			await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"], { env });
			await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"], { env });
			await writeFile(join(dir, "a.txt"), "a\n", "utf8");
			await execFileAsync("git", ["-C", dir, "add", "a.txt"], { env });
			const failure = await execFileAsync("git", ["-C", dir, "commit", "--quiet", "-m", "initial"], { env }).catch((error) => error);
			assert.ok(failure instanceof Error, "the vector is real: the fixture commit fails under config-only isolation");
			assert.match(String(failure.stderr), /template hook ran/, "and it fails BECAUSE the developer's hook ran");
		});

		// Then prove the helper closes it: same fixture, same injected
		// environment, fresh child — the commit goes through and the hook
		// was never installed.
		const out = await runChild(
			`${COMMIT_FIXTURE_PROBE}
			process.stdout.write(existsSync(join(dir, ".git", "hooks", "pre-commit")) ? " (hook installed)" : " (no hook)");`,
			injected,
		);
		assert.equal(out, "initial (no hook)", "the fixture commits, and the template never reached it");
	});
});

test("GIT_DIR is neutralized: an exported repository cannot capture fixture commands (#423)", async () => {
	// The second member of the class. GIT_DIR beats both `-C` and cwd, and
	// git exports it into its own hooks and `rebase -x` / `bisect run`
	// commands — so a developer running the suite from inside one of those
	// inherits it without having typed it. Every fixture command then acts
	// on THAT repository: `git -C fixture init` re-initializes it, and
	// `git -C fixture remote add` writes into it.
	await withTempDir(async (exported) => {
		await execFileAsync("git", ["-C", exported, "init", "--quiet"]);
		const injected = { GIT_DIR: join(exported, ".git") };

		// First prove the vector is real under configuration-only isolation.
		await withTempDir(async (dir) => {
			const env = { ...process.env, ...CONFIG_ONLY, ...injected };
			await execFileAsync("git", ["-C", dir, "init", "--quiet"], { env });
			await execFileAsync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:Acme/Tool.git"], { env });
			assert.ok(!existsSync(join(dir, ".git")), "the vector is real: `git -C fixture init` never created the fixture's repository");
			const { stdout } = await execFileAsync("git", ["-C", exported, "remote", "get-url", "origin"]);
			assert.equal(stdout.trim(), "git@github.com:Acme/Tool.git", "the fixture's remote landed in the developer's exported repository instead");
		});

		// Then prove the helper closes it: the fixture gets its own
		// repository and the exported one is untouched.
		const out = await runChild(
			`${COMMIT_FIXTURE_PROBE}
			process.stdout.write(existsSync(join(dir, ".git")) ? " (own repo)" : " (no repo)");`,
			injected,
		);
		assert.equal(out, "initial (own repo)", "the fixture initializes and commits in its own directory");
		const { stdout } = await execFileAsync("git", ["-C", exported, "log", "--oneline", "--all"]).catch(() => ({ stdout: "" }));
		assert.equal(stdout.trim(), "", "nothing was committed into the exported repository");
	});
});

test("GIT_INDEX_FILE is neutralized: a stray index cannot redirect fixture staging (#423)", async () => {
	// Third member, and the one git exports into every hook it runs. With
	// it set, `git add` in a fixture writes to the exported path and the
	// fixture's own index never sees the file.
	await withTempDir(async (stray) => {
		const injected = { GIT_INDEX_FILE: join(stray, "index") };

		await withTempDir(async (dir) => {
			const env = { ...process.env, ...CONFIG_ONLY, ...injected };
			await execFileAsync("git", ["-C", dir, "init", "--quiet"], { env });
			await writeFile(join(dir, "a.txt"), "a\n", "utf8");
			await execFileAsync("git", ["-C", dir, "add", "a.txt"], { env });
			assert.ok(existsSync(join(stray, "index")), "the vector is real: staging wrote the developer's exported index");
			const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain"]);
			assert.equal(stdout.trim(), "?? a.txt", "and the fixture's own index never saw the file");
		});
		// The control wrote the stray index; clear it so the closed case
		// can assert that the helper never writes it again.
		await rm(join(stray, "index"), { force: true });

		const out = await runChild(COMMIT_FIXTURE_PROBE, injected);
		assert.equal(out, "initial", "the fixture stages and commits through its own index");
		assert.ok(!existsSync(join(stray, "index")), "the exported index path was never written");
	});
});

test("GIT_EDITOR is set to a no-op: an interactive-capable fixture command cannot open the developer's editor (#423)", async () => {
	// No fixture omits `-m` today, so this is the latent member: the first
	// one that does would launch the developer's editor and hang the suite.
	// A failing "editor" stands in for one that waits on a terminal.
	const injected = { GIT_EDITOR: "false" };

	await withTempDir(async (dir) => {
		const env = { ...process.env, ...CONFIG_ONLY, ...injected };
		await execFileAsync("git", ["-C", dir, "init", "--quiet"], { env });
		await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"], { env });
		await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"], { env });
		await execFileAsync("git", ["-C", dir, "commit", "--quiet", "--allow-empty", "-m", "seed"], { env });
		const failure = await execFileAsync("git", ["-C", dir, "commit", "--quiet", "--allow-empty", "--amend", "--no-edit"], { env }).catch((error) => error);
		assert.ok(!(failure instanceof Error), "--no-edit never consults the editor; the control stays green");
		const editing = await execFileAsync("git", ["-C", dir, "commit", "--quiet", "--allow-empty", "--amend"], { env }).catch((error) => error);
		assert.ok(editing instanceof Error, "the vector is real: an interactive-capable command ran the developer's editor and failed with it");
	});

	const out = await runChild(
		`${COMMIT_FIXTURE_PROBE}
		await run("git", ["-C", dir, "commit", "--quiet", "--allow-empty", "--amend"]);
		process.stdout.write(" amended");`,
		injected,
	);
	assert.equal(out, "initial amended", "the interactive-capable command completes without an editor");
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
			'import "./helpers/git-environment-isolation.mjs";',
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
	const source = await readFile(join(REPO_ROOT, "tests/helpers/git-environment-isolation.mjs"), "utf8");
	// Scan the CODE, not the prose: the comments legitimately discuss
	// `git config` and the variables git reads, and an assertion that greps
	// the whole file fails the moment the documentation improves.
	const code = source
		.split("\n")
		.filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
		.join("\n");
	assert.ok(!/execFile|spawn|writeFile|appendFile|"git"|'git'/.test(code), "the helper runs no commands and writes no files");
	// An allow-list, not an exact set: the point is that the helper touches
	// NOTHING outside git's own environment variables. Pinning the exact
	// triple made this test fail the moment a fourth source (
	// GIT_CONFIG_PARAMETERS) had to be neutralized — a test that resists
	// widening the isolation it exists to protect. #423 widened the class
	// from configuration to everything git reads from the environment, so
	// the allow-list is now the GIT_ prefix: the helper must never touch
	// HOME, PATH, EDITOR, or anything else another tool owns.
	const touched = [
		...[...source.matchAll(/(?:delete\s+)?env\.([A-Z_]+)/g)].map((m) => m[1]),
		...[...source.matchAll(/^\s*"([A-Z_]+)",?$/gm)].map((m) => m[1]),
		...[...source.matchAll(/Object\.freeze\(\[([^\]]+)\]\)/g)].flatMap((m) => [...m[1].matchAll(/"([A-Z_]+)"/g)].map((n) => n[1])),
	];
	assert.ok(touched.length > 0, "the helper must touch something");
	for (const name of touched) {
		assert.match(name, /^GIT_[A-Z_]+$/, `${name} is outside git's own environment variables`);
	}
	// And every source git reads from the environment is actually covered:
	// the four configuration sources, then the members of the wider class
	// that #423 proved reach fixtures the same way.
	for (const required of [
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_PARAMETERS",
		"GIT_TEMPLATE_DIR",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_EDITOR",
		"GIT_SEQUENCE_EDITOR",
	]) {
		assert.ok(touched.includes(required), `${required} must be neutralized`);
	}
});
