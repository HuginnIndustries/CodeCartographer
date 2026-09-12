// Broad-Side repository collection (self-audit #248, #249, #250).
//
// #248: the file list came from `git ls-tree HEAD` while contents came from
//       the working tree, so a run mixed a committed list with uncommitted
//       contents and never saw an untracked file. Both now come from the
//       working tree, and the run records that.
// #249: the entry point was read whole into the architecture prompt while the
//       estimate used a flat 6,000 chars. The read is capped and the estimate
//       is the prompt's actual length.
// #250: an unknown language fell through to Go's globs and submitted empty
//       batches; `package.json` outranked every other manifest. Unknown is
//       refused before pricing, and the manifests present name candidates
//       that the source-file counts decide between.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
	BROADSIDE_LANGUAGES,
	collectRepoInfo,
	estimateCost,
	estimateSubmitText,
	gatherSlices,
	getLens,
	loadBroadsideState,
	broadsideDirFor,
	runBroadsideSubmit,
	statusText,
} = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);

// Git fixtures must not inherit the developer's global config (see
// release-cycle notes): a `url.insteadOf` or `commit.gpgsign` breaks them.
process.env.GIT_CONFIG_GLOBAL = join(tmpdir(), "cc-no-such-gitconfig");
process.env.GIT_CONFIG_SYSTEM = join(tmpdir(), "cc-no-such-gitconfig");

async function git(dir, ...args) {
	await execFileAsync("git", ["-C", dir, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

async function withDir(prefix, fn) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

async function write(dir, rel, content) {
	await mkdir(dirname(join(dir, rel)), { recursive: true });
	await writeFile(join(dir, rel), content, "utf8");
}

async function gitRepo(dir, files) {
	await git(dir, "init", "-q");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	for (const [rel, content] of Object.entries(files)) await write(dir, rel, content);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-q", "-m", "initial");
}

/** A fetcher that accepts every batch and reports it completed. */
function acceptingFetcher(posted) {
	return async (_url, init) => {
		if (init?.method === "POST") {
			posted.push(JSON.parse(init.body));
			return { ok: true, status: 202, json: async () => ({ id: `batch-${posted.length}`, status: "validating" }), text: async () => "" };
		}
		return { ok: true, status: 200, json: async () => ({ id: "x", status: "completed" }), text: async () => "" };
	};
}

// ---------- #248: one snapshot source ----------

test("the file list is the working tree's: untracked files are in, deleted files are out, contents match", async () => {
	await withDir("cc-bs-snapshot-", async (dir) => {
		await gitRepo(dir, {
			"go.mod": "module x\n",
			"main.go": "package main\n",
			"server/routes.go": "package server\n// committed\n",
			"server/gone.go": "package server\n",
			"notes.txt": "n\n",
		});
		// Uncommitted: one new file, one edit, one delete, one ignored file.
		await write(dir, "server/fresh.go", "package server\n// untracked\n");
		await write(dir, "server/routes.go", "package server\n// edited\n");
		await rm(join(dir, "server", "gone.go"));
		await write(dir, ".gitignore", "secret.go\n");
		await write(dir, "server/secret.go", "package server\n");

		const info = await collectRepoInfo(dir);
		assert.equal(info.snapshot, "working-tree");
		assert.match(info.fileTree, /server\/fresh\.go/, "an untracked file is scanned");
		assert.doesNotMatch(info.fileTree, /server\/gone\.go/, "a file deleted on disk is not listed");
		assert.doesNotMatch(info.fileTree, /server\/secret\.go/, "an ignored file is not listed");

		const slices = await gatherSlices(dir, getLens("defect"), info);
		const content = slices.map((s) => s.content).join("\n");
		assert.match(content, /=== server\/fresh\.go ===\npackage server\n\/\/ untracked/);
		assert.match(content, /=== server\/routes\.go ===\npackage server\n\/\/ edited/, "contents are the working tree's, as the list is");
		assert.doesNotMatch(content, /gone\.go|BINARY or UNREADABLE/);
		assert.doesNotMatch(content, /secret\.go/);
	});
});

test("a directory that is not a git repository is walked, and the run says so", async () => {
	await withDir("cc-bs-walk-", async (dir) => {
		await write(dir, "go.mod", "module x\n");
		await write(dir, "main.go", "package main\n");
		const info = await collectRepoInfo(dir);
		assert.equal(info.snapshot, "walk");
		assert.equal(info.language, "go");
		assert.equal(info.sourceFileCount, 1);
	});
});

test("submit records the snapshot source and language on the run and in its report", async () => {
	await withDir("cc-bs-run-", async (dir) => {
		await gitRepo(dir, { "go.mod": "module x\n", "main.go": "package main\n" });
		await write(dir, "extra.go", "package main\n// dirty\n");
		const posted = [];
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: acceptingFetcher(posted) });
		assert.equal(result.repo.snapshot, "working-tree");
		assert.equal(result.repo.language, "go");
		assert.equal(result.repo.sourceFiles, 2);
		assert.equal(result.repo.sourceDirty, true);
		assert.match(result.repo.sourceHead, /^[0-9a-f]{40}$/);
		const text = estimateSubmitText(result, [getLens("architecture")]);
		assert.match(text, /^Scanned as go: 2 source file\(s\) from the working tree at [0-9a-f]{8} \(dirty\)\.$/m);

		const state = await loadBroadsideState(broadsideDirFor(dir));
		assert.equal(state.runs[0].snapshot, "working-tree");
		assert.equal(state.runs[0].language, "go");
		assert.match(statusText(state), /^  scanned as go from the working tree at [0-9a-f]{8} \(dirty\)$/m);
	});
});

// ---------- #249: bounded prompt inputs, honest estimate ----------

test("a huge entry point is capped in the architecture prompt and the estimate is the prompt's real size", async () => {
	await withDir("cc-bs-main-", async (dir) => {
		await write(dir, "go.mod", "module x\n");
		await write(dir, "main.go", `package main\n// ${"x".repeat(200_000)}\n`);
		const info = await collectRepoInfo(dir);
		assert.ok(info.mainFile.length < 21_000, `entry point capped, got ${info.mainFile.length}`);
		assert.match(info.mainFile, /… \[truncated: 20,000 of 200,0\d\d chars shown\]/);

		const lens = getLens("architecture");
		const slices = await gatherSlices(dir, lens, info);
		const pricing = { inputPerM: 1, outputPerM: 1, source: "test" };
		const withInfo = estimateCost(lens, slices, pricing, undefined, info);
		const promptChars = lens.userPrompt(info, slices[0].content, slices[0].moduleName).length;
		assert.ok(promptChars > 20_000, "the prompt carries the capped entry point");
		const overhead = lens.systemPrompt(info).length;
		// Tokens are chars / 4; the schema rides along too, so allow for it.
		assert.ok(withInfo.inputTokens >= Math.ceil((promptChars + overhead) / 4), "estimate covers the whole prompt");
		assert.ok(withInfo.inputTokens < Math.ceil((promptChars + overhead) / 4) + 5_000, "and not wildly more");
		// Without info the old flat figure still applies (the old signature).
		assert.equal(estimateCost(lens, slices, pricing).inputTokens, Math.ceil(6000 / 4));
	});
});

test("a huge manifest is capped too", async () => {
	await withDir("cc-bs-manifest-", async (dir) => {
		await write(dir, "package.json", `{"name":"x","description":"${"d".repeat(100_000)}"}\n`);
		await write(dir, "index.ts", "export {};\n");
		const info = await collectRepoInfo(dir);
		assert.ok(info.manifest.content.length < 21_000);
		assert.match(info.manifest.content, /truncated: 20,000 of/);
	});
});

// ---------- #250: language detection and refusal ----------

test("an unsupported language is refused before pricing, network, or state", async () => {
	await withDir("cc-bs-unknown-", async (dir) => {
		await write(dir, "pom.xml", "<project/>\n");
		await write(dir, "src/Main.java", "class Main {}\n");
		const info = await collectRepoInfo(dir);
		assert.equal(info.language, "unknown");
		assert.equal(info.sourceGlob, "");
		assert.deepEqual(info.sourceExts, []);
		assert.equal(info.sourceFileCount, 0);
		// Every code lens finds nothing — no Go globs to fall through to.
		for (const lensId of ["defect", "conventions", "porting"]) {
			assert.deepEqual(await gatherSlices(dir, getLens(lensId), info), [], lensId);
		}

		let fetched = 0;
		await assert.rejects(
			runBroadsideSubmit(dir, "sk-fake", { fetcher: async () => { fetched++; throw new Error("must not be called"); } }),
			/^Error: Broad-Side could not tell what language this repository is: no go\.mod, package\.json, Cargo\.toml, pyproject\.toml, setup\.py, requirements\.txt and no source files in a language the lenses can scan \(go, python, rust, typescript, javascript\)\. Nothing was submitted\.$/,
		);
		assert.equal(fetched, 0);
		assert.deepEqual((await loadBroadsideState(broadsideDirFor(dir))).runs, []);
	});
});

test("a manifest with no source files behind it is refused with the count", async () => {
	await withDir("cc-bs-nosource-", async (dir) => {
		await write(dir, "Cargo.toml", "[package]\nname = \"x\"\n");
		await write(dir, "README.md", "# x\n");
		const info = await collectRepoInfo(dir);
		assert.equal(info.language, "rust");
		assert.equal(info.sourceFileCount, 0);
		await assert.rejects(
			runBroadsideSubmit(dir, "sk-fake", { fetcher: async () => { throw new Error("must not be called"); } }),
			/^Error: Broad-Side found no rust source files to scan \(detected from Cargo\.toml; the lenses look for \.rs\)\. Nothing was submitted\.$/,
		);
	});
});

test("several manifests name the candidates and the source-file counts decide", async () => {
	await withDir("cc-bs-polyglot-", async (dir) => {
		// A Python service with a package.json for its docs tooling.
		await write(dir, "package.json", '{"name":"docs"}\n');
		await write(dir, "pyproject.toml", "[project]\nname = \"svc\"\n");
		await write(dir, "docs/build.js", "console.log(1);\n");
		for (let i = 0; i < 5; i++) await write(dir, `svc/m${i}.py`, "x = 1\n");
		const info = await collectRepoInfo(dir);
		assert.equal(info.language, "python", "package.json no longer outranks the language most of the code is in");
		assert.equal(info.manifest.path, "pyproject.toml", "the prompt shows the manifest of the detected language");
		assert.equal(info.sourceFileCount, 5);
	});
});

test("package.json resolves to JavaScript when the code is JavaScript", async () => {
	await withDir("cc-bs-js-", async (dir) => {
		await write(dir, "package.json", '{"name":"x"}\n');
		await write(dir, "index.js", "module.exports = 1;\n");
		await write(dir, "lib/a.js", "module.exports = 2;\n");
		const info = await collectRepoInfo(dir);
		assert.equal(info.language, "javascript");
		assert.equal(info.sourceGlob, "**/*.js");
		assert.equal(info.sourceFileCount, 2);
		assert.equal(info.mainFile, "module.exports = 1;\n", "index.js is an entry point candidate");
	});
});

test("a lone manifest still wins a tie and a manifest-less repo goes by counts", async () => {
	await withDir("cc-bs-tie-", async (dir) => {
		await write(dir, "go.mod", "module x\n");
		await write(dir, "a.go", "package a\n");
		await write(dir, "b.ts", "export {};\n");
		assert.equal((await collectRepoInfo(dir)).language, "go", "go.mod names go; ts is not a candidate");
	});
	await withDir("cc-bs-counts-", async (dir) => {
		await write(dir, "a.rs", "fn a() {}\n");
		await write(dir, "b.rs", "fn b() {}\n");
		await write(dir, "c.py", "x = 1\n");
		assert.equal((await collectRepoInfo(dir)).language, "rust");
	});
	assert.deepEqual([...BROADSIDE_LANGUAGES], ["go", "python", "rust", "typescript", "javascript"]);
});
