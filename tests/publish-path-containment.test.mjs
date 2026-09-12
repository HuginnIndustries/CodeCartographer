import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePublish, readSpecArg } from "../mcp-server/server.ts";

// handlePublish reads the user-global config for its publish_confirm gate;
// keep the developer's real ~/.codecarto/config.yaml out of these tests.
process.env.CODECARTO_USER_CONFIG_PATH = join(tmpdir(), `cc-publish-test-no-user-config-${process.pid}`, "config.yaml");

let tmpRoot;

async function setup() {
	tmpRoot = await mkdtemp(join(tmpdir(), "cc-publish-test-"));
	const workspaceDir = join(tmpRoot, "target", ".codecarto");
	const libraryDir = join(tmpRoot, "library");
	await mkdir(join(workspaceDir, "workflow"), { recursive: true });
	await mkdir(join(workspaceDir, "findings", "reimplementation-spec"), { recursive: true });
	await mkdir(libraryDir, { recursive: true });

	await writeFile(join(libraryDir, ".codecarto-library"), JSON.stringify({
		schema_version: 1,
		name: "test-library",
		visibility: "internal",
		namespaced: false,
		created_at: "2026-01-01T00:00:00Z",
	}));

	const specContent = "# Test Spec\n\n## System Summary\n\nA test reimplementation spec.";
	await writeFile(join(workspaceDir, "findings", "reimplementation-spec", "reimplementation-spec.md"), specContent);

	await mkdir(join(tmpRoot, "outside"), { recursive: true });
	await writeFile(join(tmpRoot, "outside", "secret.txt"), "SECRET CONTENT");

	return { workspaceDir, libraryDir, specContent, secretPath: join(tmpRoot, "outside", "secret.txt") };
}

async function cleanup() {
	await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

test("codecarto_publish rejects spec_path outside workspace and library", async () => {
	const { secretPath, libraryDir } = await setup();
	try {
		await assert.rejects(
			handlePublish({
				library_path: libraryDir,
				source_repo: "https://github.com/test/repo",
				headline: "Test spec",
				spec_path: secretPath,
			}),
			(err) => {
				assert.match(err.message, /must be within the workspace/i);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("codecarto_publish accepts spec_path within workspace", async () => {
	const { workspaceDir, libraryDir } = await setup();
	try {
		await handlePublish({
			library_path: libraryDir,
			cwd: join(workspaceDir, ".."),
			source_repo: "https://github.com/test/repo",
			headline: "Test spec",
			spec_path: join(workspaceDir, "findings", "reimplementation-spec", "reimplementation-spec.md"),
		});
	} catch (err) {
		assert.doesNotMatch(err.message, /must be within the workspace/i);
	} finally {
		await cleanup();
	}
});
// ── readSpecArg defense-in-depth (issue #76) ────────────────────────────────
// Containment used to be skipped entirely when allowedRoots was empty, making
// it opt-in. These lock in that an empty root set fails closed.

test("readSpecArg refuses spec_path when allowedRoots is empty", async () => {
	await setup();
	try {
		await assert.rejects(
			() => readSpecArg({ spec_path: join(tmpRoot, "outside", "secret.txt") }, []),
			(err) => {
				assert.match(err.message, /without a containment root/i);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("readSpecArg fails closed on an empty root set without touching the filesystem", async () => {
	await setup();
	try {
		// A path that does not exist must still be refused for the same reason,
		// so the guard cannot be used to probe which files are present.
		await assert.rejects(
			() => readSpecArg({ spec_path: join(tmpRoot, "outside", "does-not-exist.txt") }, []),
			(err) => {
				assert.match(err.message, /without a containment root/i);
				assert.doesNotMatch(err.message, /does not exist/i);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("readSpecArg still reads spec_path within an allowed root", async () => {
	const { workspaceDir, specContent } = await setup();
	try {
		const out = await readSpecArg(
			{ spec_path: join(workspaceDir, "findings", "reimplementation-spec", "reimplementation-spec.md") },
			[workspaceDir],
		);
		assert.equal(out, specContent);
	} finally {
		await cleanup();
	}
});

test("readSpecArg accepts inline spec regardless of allowedRoots", async () => {
	const out = await readSpecArg({ spec: "inline spec body" }, []);
	assert.equal(out, "inline spec body");
});

// ── cwd is validated before it becomes a root (self-audit #241) ──────────────
// A relative cwd resolved against the MCP server process's working directory,
// not the caller's, and became a containment root for spec_path there before
// anything checked it. Now every library tool validates an optional cwd the
// way the workflow tools validate a required one, first.

const { handleLibraryList, handleLibraryReindex } = await import("../mcp-server/server.ts");
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

const isInvalidParams = (pattern) => (err) => {
	assert.ok(err instanceof McpError, "expected McpError");
	assert.equal(err.code, ErrorCode.InvalidParams);
	assert.match(err.message, pattern);
	return true;
};

test("codecarto_publish refuses a relative cwd before spec_path is read through it", async () => {
	const { secretPath, libraryDir } = await setup();
	try {
		// The old order built the containment root from the relative cwd (so
		// from the server process's location), read spec_path against it, and
		// only then refused the cwd. With a spec_path outside every root that
		// order surfaces as the containment error; the cwd error here proves
		// the argument is refused before readSpecArg runs at all.
		await assert.rejects(
			handlePublish({
				library_path: libraryDir,
				cwd: "target",
				source_repo: "https://github.com/test/repo",
				headline: "Test spec",
				spec_path: secretPath,
			}),
			isInvalidParams(/^MCP error -32602: cwd must be an absolute path, got: target$/),
		);
	} finally {
		await cleanup();
	}
});

test("codecarto_publish refuses a cwd that does not exist", async () => {
	const { workspaceDir, libraryDir } = await setup();
	try {
		const missing = join(workspaceDir, "..", "..", "no-such-dir");
		await assert.rejects(
			handlePublish({
				library_path: libraryDir,
				cwd: missing,
				source_repo: "https://github.com/test/repo",
				headline: "Test spec",
				spec: "# inline\n",
			}),
			isInvalidParams(/cwd does not exist: /),
		);
	} finally {
		await cleanup();
	}
});

test("codecarto_publish refuses a cwd of the wrong type instead of ignoring it", async () => {
	const { libraryDir } = await setup();
	try {
		await assert.rejects(
			handlePublish({ library_path: libraryDir, cwd: 42, source_repo: "https://github.com/test/repo", headline: "Test spec", spec: "# inline\n" }),
			isInvalidParams(/cwd must be a string when given/),
		);
	} finally {
		await cleanup();
	}
});

test("an absent or empty cwd still means 'no workspace' for the library tools", async () => {
	const { libraryDir } = await setup();
	try {
		for (const cwd of [undefined, null, "", "   "]) {
			const args = { library_path: libraryDir, source_repo: "https://github.com/test/repo", headline: "Test spec", spec: "# inline\n" };
			if (cwd !== undefined) args.cwd = cwd;
			const result = await handlePublish(args);
			assert.equal(result.structuredContent.slug, "repo");
		}
	} finally {
		await cleanup();
	}
});

test("codecarto_library_list and codecarto_library_reindex validate cwd the same way", async () => {
	const { libraryDir } = await setup();
	try {
		for (const handler of [handleLibraryList, handleLibraryReindex]) {
			await assert.rejects(
				handler({ library_path: libraryDir, cwd: "relative/path" }),
				isInvalidParams(/cwd must be an absolute path, got: relative\/path/),
			);
			await assert.rejects(
				handler({ library_path: libraryDir, cwd: join(libraryDir, "no-such-dir") }),
				isInvalidParams(/cwd does not exist: /),
			);
		}
	} finally {
		await cleanup();
	}
});
