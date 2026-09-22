// Distribution isolation for the engineering namespace (E02, #400).
//
// `.codecarto/engineering/` holds one project's private working history:
// change briefs, attempt records, proofs of what ran on someone's machine,
// review objections, and human approval receipts. None of it is template
// content. Three separate mechanisms must each keep it local, and they fail
// independently:
//
//   1. `initWorkspace` copies the packaged template into a new workspace.
//   2. `.codecarto/.gitignore` and `.codecarto/templates/gitignore` decide
//      what a user's git tracks by default.
//   3. `package.json` `files[]` decides what reaches the npm tarball.
//
// A leak through any one of them publishes another project's decision
// history. These tests assert each mechanism separately rather than trusting
// that one implies the others — the whole point is that they are independent.
//
// Nothing here uses a real record as a fixture. Every file written below is
// synthetic and obviously so.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `npm` is a shell shim on Windows (`npm.cmd`), so `execFile("npm", …)` fails
 * with `spawn npm ENOENT` there. Run the CLI's own entry point with the node
 * that is already running instead — no shell, no `shell: true` quoting
 * hazard, and identical behaviour on every platform.
 */
async function npmPack(packRoot) {
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const viaCli = await stat(npmCli).then(() => true).catch(() => false);
	const { stdout } = viaCli
		? await execFileAsync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { cwd: packRoot, maxBuffer: 32 * 1024 * 1024 })
		: await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], {
				cwd: packRoot,
				maxBuffer: 32 * 1024 * 1024,
			});
	// npm has shipped both shapes for this payload: an array of packages, and
	// an object keyed by package name. Accept either rather than index [0]
	// and silently examine `undefined`.
	const parsed = JSON.parse(stdout);
	const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	assert.ok(Array.isArray(packed?.files) && packed.files.length > 0, "npm pack must report a non-empty file list");
	return packed.files.map((entry) => entry.path.replace(/\\/g, "/"));
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A disposable package root that `npm pack` sees exactly as it sees this
 * repository: the same `package.json` (so `files[]` applies) and the same
 * `.codecarto/` tree (so `.codecarto/.gitignore` applies). `npm pack` reads
 * the directory it is run in, so a pack CONTROL that plants a record has to
 * plant it somewhere — and that somewhere must never be the live checkout.
 *
 * Why (#437): `node --test` runs files concurrently and sixteen of them
 * `cp -r` the live `.codecarto/`. A record planted and removed in the live
 * tree lands between another file's directory walk and its `lstat`, and an
 * unrelated test fails with ENOENT. Planting in a copy removes the only
 * writer, which removes the race for every reader, present and future.
 */
async function withPackRoot(fn) {
	return withTempDir(async (dir) => {
		const packRoot = join(dir, "pack-root");
		await mkdir(packRoot, { recursive: true });
		await cp(join(REPO_ROOT, "package.json"), join(packRoot, "package.json"));
		await cp(join(REPO_ROOT, ".codecarto"), join(packRoot, ".codecarto"), { recursive: true });
		return fn(packRoot);
	});
}


const { copyPackagedWorkspace } = await import(pathToFileURL(`${REPO_ROOT}/core/workspace.ts`).href);
const { ENGINEERING_NAMESPACE } = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);

/** Entries under the live `changes/` directory, `[]` when it does not exist. */
async function liveChangeRecords() {
	return readdir(join(REPO_ROOT, ".codecarto", ENGINEERING_NAMESPACE, "changes")).catch(() => []);
}

/** Ids every synthetic fixture in this suite uses; a real record never has a run of zeros this long. */
const SYNTHETIC_ID = /^chg_0{15,}/;

// Loud guard (#437). No test in this suite — or any other — may write into
// the live `REPO_ROOT/.codecarto/`. This runs at file start: the presence of
// a synthetic-shaped record means some test planted one in the live tree,
// which is exactly the class of writer that races every `cp -r` reader.
// There is no legitimate planter left for this assertion to race with, so
// a hit here is a regression, not a flake.
const recordsAtStart = await liveChangeRecords();

/** Synthetic private history, placed where a real run would put it. */
const SYNTHETIC_RECORDS = {
	"changes/chg_00000000000000000000e001/change.json":
		'{"kind":"change","id":"chg_00000000000000000000e001","title":"SYNTHETIC FIXTURE — never a real record"}\n',
	"changes/chg_00000000000000000000e001/brief.md": "# SYNTHETIC brief\n\nDescribes a change that does not exist.\n",
	"changes/chg_00000000000000000000e001/attempts/atm_00000000000000000000e001/attempt.json":
		'{"kind":"attempt","id":"atm_00000000000000000000e001"}\n',
	"changes/chg_00000000000000000000e001/attempts/atm_00000000000000000000e001/approvals/apr_00000000000000000000e001.json":
		'{"kind":"approval","decision":"accepted","receipt":{"attestation":"SYNTHETIC — not a human decision"}}\n',
	"changes/chg_00000000000000000000e001/attempts/atm_00000000000000000000e001/proofs/prf_00000000000000000000e001.json":
		'{"kind":"proof","result":"passed","command":"SYNTHETIC — nothing ran"}\n',
};

async function writeSyntheticHistory(engineeringDir) {
	for (const [relative, body] of Object.entries(SYNTHETIC_RECORDS)) {
		const target = join(engineeringDir, relative);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, body, "utf8");
	}
}

async function withTempDir(fn) {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-e02-dist-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("no test writes into the live .codecarto/engineering/changes/ (#437 guard, start)", () => {
	const synthetic = recordsAtStart.filter((entry) => SYNTHETIC_ID.test(entry));
	assert.deepEqual(
		synthetic,
		[],
		`synthetic records found in the live checkout's .codecarto/${ENGINEERING_NAMESPACE}/changes/ — a test wrote into the ` +
			`repository's own workspace. Plant fixtures in a tmp copy instead; the live tree is read-only to the suite (#437):\n${synthetic.join("\n")}`,
	);
});

after(async () => {
	// Same guard at file end: the set of live records must be exactly what it
	// was at start. A test that plants and cleans up before this hook runs is
	// invisible here — after #437 there is no such test, and the START guard
	// in every parallel run of this file makes a leftover record loud.
	const recordsAtEnd = await liveChangeRecords();
	assert.deepEqual(
		recordsAtEnd,
		recordsAtStart,
		`the live .codecarto/${ENGINEERING_NAMESPACE}/changes/ changed while the suite ran — a test wrote into the repository's own workspace (#437)`,
	);
});

test("the engineering namespace is a private runtime path, not a distributable one", () => {
	// Everything below depends on this name. If it ever moves, these tests
	// must move with it rather than silently checking nothing.
	assert.equal(ENGINEERING_NAMESPACE, "engineering", "the namespace E01 defined");
});

test("a fresh workspace inherits no engineering history from the source it was seeded from", async () => {
	await withTempDir(async (dir) => {
		// A source workspace that has done engineering work, exactly as a
		// user's checkout would look after a change.
		const source = join(dir, "source", ".codecarto");
		await mkdir(join(source, "workflow"), { recursive: true });
		await writeFile(join(source, "workflow", "status.yaml"), "project: synthetic\n", "utf8");
		await writeSyntheticHistory(join(source, ENGINEERING_NAMESPACE));

		const target = join(dir, "fresh", ".codecarto");
		await copyPackagedWorkspace(target, source);

		const leaked = join(target, ENGINEERING_NAMESPACE);
		await assert.rejects(
			() => readFile(join(leaked, "changes/chg_00000000000000000000e001/change.json"), "utf8"),
			/ENOENT/,
			"a new workspace must not receive another project's change records",
		);
		// The directory may exist as an empty scaffold, but it must carry no
		// records — an empty namespace is fine, a populated one is a leak.
		// The directory may exist as an empty scaffold; populated is a leak.
		const contents = await readdir(leaked).catch(() => []);
		assert.deepEqual(contents, [], "the namespace may be scaffolded empty, never populated");
	});
});

test("the shipped gitignore templates ignore engineering runtime state by default", async () => {
	// Both copies: the one governing this repository and the one a new
	// workspace is seeded with. They drift apart if only one is edited.
	for (const relative of [".codecarto/.gitignore", ".codecarto/templates/gitignore"]) {
		const body = await readFile(join(REPO_ROOT, relative), "utf8");
		assert.match(
			body,
			new RegExp(`^${ENGINEERING_NAMESPACE}/`, "m"),
			`${relative} must ignore ${ENGINEERING_NAMESPACE}/ so a user's history is not committed by accident`,
		);
	}
});

test("git actually ignores a populated engineering namespace in a workspace using the template", async () => {
	// Asserting on the ignore file's text is not the same as asserting git
	// honours it: a rule can be present and shadowed by a later negation.
	await withTempDir(async (dir) => {
		await execFileAsync("git", ["-C", dir, "init", "--quiet"]);
		const workspace = join(dir, ".codecarto");
		await mkdir(workspace, { recursive: true });
		await writeFile(join(workspace, ".gitignore"), await readFile(join(REPO_ROOT, ".codecarto/templates/gitignore"), "utf8"), "utf8");
		await writeSyntheticHistory(join(workspace, ENGINEERING_NAMESPACE));

		const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"]);
		const engineeringLines = stdout.split("\n").filter((line) => line.includes(ENGINEERING_NAMESPACE));
		assert.deepEqual(engineeringLines, [], `git must report nothing under ${ENGINEERING_NAMESPACE}/:\n${stdout}`);
	});
});

test("the published tarball carries no engineering records", async () => {
	// The real packing rules, not a reading of files[]. `npm pack --dry-run`
	// applies files[], .npmignore, and every default exclusion together.
	// Anchored to the namespace directory: `templates/reverse-engineering-
	// bundle.md` is a legitimate template whose NAME contains the word, and a
	// substring match would call it a leak forever.
	const prefix = `.codecarto/${ENGINEERING_NAMESPACE}/`;
	await withPackRoot(async (packRoot) => {
		const offenders = (await npmPack(packRoot)).filter((path) => path.startsWith(prefix));
		assert.deepEqual(offenders, [], `no engineering record may reach the tarball:\n${offenders.join("\n")}`);
		// The control. An empty result is worthless if the packer had nothing to
		// exclude, so a record is PLANTED and the pack re-run. A checkout has no
		// namespace at all — it is gitignored — which is why requiring one to
		// pre-exist passed locally and failed on every CI runner.
		//
		// Planted in the disposable pack root, never in the live checkout: the
		// live `.codecarto/` is copied by sixteen concurrently-running test files
		// and a record appearing and vanishing under them is #437. The control
		// still discriminates — with the `.gitignore` rule and the `files[]`
		// carve-out both removed from the copy, the planted record leaks.
		const planted = join(packRoot, ".codecarto", ENGINEERING_NAMESPACE, "changes", "chg_00000000000000000000e999");
		await mkdir(planted, { recursive: true });
		await writeFile(join(planted, "change.json"), '{"synthetic":"pack control, never a real record"}\n', "utf8");
		const stillClean = (await npmPack(packRoot)).filter((path) => path.startsWith(prefix));
		assert.deepEqual(stillClean, [], "a planted record must still not reach the tarball");
	});
});

test("each packing mechanism excludes the namespace on its own", async () => {
	// Measured, not assumed: the `.gitignore` rule and the `files[]` carve-out
	// are INDEPENDENTLY sufficient — removing either still yields a clean
	// tarball, and only removing both leaks. That is the property worth
	// having, but it means the end-to-end pack test above cannot catch the
	// loss of one of them. Each is therefore pinned directly, or the first
	// mechanism to be deleted would go unnoticed until the second followed.
	const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
	assert.ok(
		manifest.files.includes(`!.codecarto/${ENGINEERING_NAMESPACE}/**`),
		"package.json files[] must carve the namespace out explicitly, independent of any ignore file",
	);
	// The gitignore half is pinned by "the shipped gitignore templates…" above.
	// Both being present is the belt-and-braces the acceptance criteria ask for.
});

test("the pack control is not vacuous: with both mechanisms removed, a planted record leaks", async () => {
	// Proves the disposable pack root really is what `npm pack` sees. If the
	// copy silently dropped `.codecarto/` or `files[]`, the control above
	// would pass for the wrong reason; here the same copy, with the ignore
	// rule and the carve-out both stripped, must show the planted record.
	const prefix = `.codecarto/${ENGINEERING_NAMESPACE}/`;
	await withPackRoot(async (packRoot) => {
		const manifestPath = join(packRoot, "package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.files = manifest.files.filter((entry) => entry !== `!.codecarto/${ENGINEERING_NAMESPACE}/**`);
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
		const ignorePath = join(packRoot, ".codecarto", ".gitignore");
		const ignore = await readFile(ignorePath, "utf8");
		await writeFile(ignorePath, ignore.replace(new RegExp(`^${ENGINEERING_NAMESPACE}/$`, "m"), ""), "utf8");

		const planted = join(packRoot, ".codecarto", ENGINEERING_NAMESPACE, "changes", "chg_00000000000000000000e999");
		await mkdir(planted, { recursive: true });
		await writeFile(join(planted, "change.json"), '{"synthetic":"pack control, never a real record"}\n', "utf8");
		const leaked = (await npmPack(packRoot)).filter((path) => path.startsWith(prefix));
		assert.deepEqual(leaked, [`${prefix}changes/chg_00000000000000000000e999/change.json`], "with no exclusion left, the planted record must reach the tarball");
	});
});

test("distributable guidance still reaches a fresh workspace", async () => {
	// The negative control for the three tests above: an exclusion that also
	// removed the template content would pass them all while breaking init.
	await withTempDir(async (dir) => {
		const workspace = join(dir, "fresh", ".codecarto");
		await copyPackagedWorkspace(workspace, join(REPO_ROOT, ".codecarto"));

		// Real distributable content, by the source workspace's own reckoning.
		for (const expected of ["templates/gitignore", "workflow/config.yaml", "GUIDE.md"]) {
			await assert.doesNotReject(() => stat(join(workspace, expected)), `${expected} must still be seeded`);
		}
	});
});
