// Tests for the new MCP library handlers: handlePublish, handleLibraryList,
// handleLibraryReindex. Drives the handlers directly against tmp libraries
// (no stdio transport) and verifies the same content-shape conventions as
// the existing mcp-server.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { handlePublish, handleLibraryList, handleLibraryReindex } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { writeMarker, LIBRARY_INDEX_FILE, ENTRIES_DIR, METADATA_FILE, SPEC_FILE } = await import(pathToFileURL(`${REPO_ROOT}/core/library.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

async function makeLib({ namespaced = true, name = "mcp-test-lib" } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "cc-mcp-lib-"));
	await writeMarker(dir, { schema_version: 1, name, namespaced });
	return { libraryPath: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function basePublishArgs(libraryPath, overrides = {}) {
	return {
		library_path: libraryPath,
		spec: "# spec content\n",
		source_repo: "https://github.com/myorg/sample",
		headline: "Sample library entry.",
		tags: ["sample"],
		capabilities: ["does things"],
		namespace: "james",
		...overrides,
	};
}

// ─── handlePublish ─────────────────────────────────────────────────────────

test("handlePublish creates v1 with derived slug from source_repo", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		const result = await handlePublish(basePublishArgs(libraryPath, { source_repo: "https://github.com/myorg/HexBridge.git" }));
		assert.equal(result.structuredContent.slug, "hexbridge");
		assert.equal(result.structuredContent.version, 1);
		assert.equal(result.structuredContent.isNewVersion, true);
		assert.equal(result.structuredContent.namespace, "james");
		assert.match(result.content[0].text, /Published james\/hexbridge v1/);
	} finally {
		await cleanup();
	}
});

test("handlePublish respects explicit slug argument", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		const result = await handlePublish(basePublishArgs(libraryPath, { slug: "custom-slug" }));
		assert.equal(result.structuredContent.slug, "custom-slug");
	} finally {
		await cleanup();
	}
});

test("handlePublish is content-hash idempotent — same spec stays at v1", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		const first = await handlePublish(basePublishArgs(libraryPath));
		assert.equal(first.structuredContent.version, 1);
		assert.equal(first.structuredContent.isNewVersion, true);

		const second = await handlePublish(basePublishArgs(libraryPath, { tags: ["sample", "second"] }));
		assert.equal(second.structuredContent.version, 1);
		assert.equal(second.structuredContent.isNewVersion, false);
		assert.match(second.content[0].text, /Metadata-only update/);
	} finally {
		await cleanup();
	}
});

test("handlePublish bumps version when spec content changes", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await handlePublish(basePublishArgs(libraryPath));
		const v2 = await handlePublish(basePublishArgs(libraryPath, { spec: "# different content\n" }));
		assert.equal(v2.structuredContent.version, 2);
		assert.equal(v2.structuredContent.isNewVersion, true);
	} finally {
		await cleanup();
	}
});

test("handlePublish writes generation block with mcp-server surface and unknown defaults", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await handlePublish(basePublishArgs(libraryPath));
		const meta = await readFile(join(libraryPath, ENTRIES_DIR, "james", "sample", "v1", METADATA_FILE), "utf8");
		assert.match(meta, /surface: mcp-server/);
		assert.match(meta, /agent: unknown/);
		assert.match(meta, /model: unknown/);
		assert.match(meta, /reasoning: unknown/);
	} finally {
		await cleanup();
	}
});

test("handlePublish flows model_metadata through to the generation block", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await handlePublish(basePublishArgs(libraryPath, {
			model_metadata: {
				agent: "claude-code",
				agent_version: "1.2.3",
				model: "claude-sonnet-4-6",
				model_vendor: "anthropic",
				reasoning: "high",
				notes: "smoke test",
			},
		}));
		const meta = await readFile(join(libraryPath, ENTRIES_DIR, "james", "sample", "v1", METADATA_FILE), "utf8");
		assert.match(meta, /agent: claude-code/);
		assert.match(meta, /agent_version: 1.2.3/);
		assert.match(meta, /model: "claude-sonnet-4-6"|model: claude-sonnet-4-6/);
		assert.match(meta, /model_vendor: anthropic/);
		assert.match(meta, /reasoning: high/);
	} finally {
		await cleanup();
	}
});

test("handlePublish accepts spec_path as an alternative to inline spec", async () => {
	const { libraryPath, cleanup } = await makeLib();
	const specFile = join(libraryPath, "_temp-spec.md");
	try {
		await writeFile(specFile, "# from file\n", "utf8");
		const args = basePublishArgs(libraryPath);
		delete args.spec;
		args.spec_path = specFile;
		const result = await handlePublish(args);
		assert.equal(result.structuredContent.version, 1);
		const spec = await readFile(join(libraryPath, ENTRIES_DIR, "james", "sample", "v1", SPEC_FILE), "utf8");
		assert.equal(spec, "# from file\n");
	} finally {
		await cleanup();
	}
});

test("handlePublish rejects missing source_repo", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		const args = basePublishArgs(libraryPath);
		delete args.source_repo;
		await assert.rejects(
			handlePublish(args),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams);
				assert.match(error.message, /source_repo/);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("handlePublish rejects missing headline", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		const args = basePublishArgs(libraryPath);
		delete args.headline;
		await assert.rejects(
			handlePublish(args),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams);
				assert.match(error.message, /headline/);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("handlePublish rejects when library_path is not a library", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-not-a-lib-"));
	try {
		await assert.rejects(
			handlePublish(basePublishArgs(dir)),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams);
				assert.match(error.message, /missing \.codecarto-library/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("handlePublish requires namespace for namespaced libraries", async () => {
	const { libraryPath, cleanup } = await makeLib({ namespaced: true });
	try {
		const args = basePublishArgs(libraryPath);
		delete args.namespace;
		await assert.rejects(
			handlePublish(args),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams);
				assert.match(error.message, /namespace/);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("handlePublish works in single-tenant library without namespace", async () => {
	const { libraryPath, cleanup } = await makeLib({ namespaced: false });
	try {
		const args = basePublishArgs(libraryPath);
		delete args.namespace;
		const result = await handlePublish(args);
		assert.equal(result.structuredContent.namespace, null);
		assert.equal(result.structuredContent.version, 1);
	} finally {
		await cleanup();
	}
});

test("handlePublish rejects without library_path or cwd config", async () => {
	await assert.rejects(
		handlePublish({ source_repo: "x", headline: "y", spec: "z" }),
		(error) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, ErrorCode.InvalidParams);
			assert.match(error.message, /library_path is required/);
			return true;
		},
	);
});

// ─── handleLibraryList ─────────────────────────────────────────────────────

test("handleLibraryList returns empty result on a fresh library", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		const result = await handleLibraryList({ library_path: libraryPath });
		assert.equal(result.structuredContent.count, 0);
		assert.match(result.content[0].text, /No entries match/);
	} finally {
		await cleanup();
	}
});

test("handleLibraryList lists published entries", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await handlePublish(basePublishArgs(libraryPath, { slug: "alpha", source_repo: "https://github.com/x/alpha" }));
		await handlePublish(basePublishArgs(libraryPath, { slug: "beta", source_repo: "https://github.com/x/beta", tags: ["kafka"] }));
		const result = await handleLibraryList({ library_path: libraryPath });
		assert.equal(result.structuredContent.count, 2);
		assert.match(result.content[0].text, /james\/alpha v1/);
		assert.match(result.content[0].text, /james\/beta v1/);
	} finally {
		await cleanup();
	}
});

test("handleLibraryList filters by namespace and tag", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await handlePublish(basePublishArgs(libraryPath, { slug: "alpha", source_repo: "https://github.com/x/alpha", tags: ["kafka"] }));
		await handlePublish(basePublishArgs(libraryPath, { slug: "gamma", namespace: "alice", source_repo: "https://github.com/alice/gamma", tags: ["redis"] }));

		const byNs = await handleLibraryList({ library_path: libraryPath, namespace: "alice" });
		assert.equal(byNs.structuredContent.count, 1);
		assert.equal(byNs.structuredContent.entries[0].slug, "gamma");

		const byTag = await handleLibraryList({ library_path: libraryPath, tag: "kafka" });
		assert.equal(byTag.structuredContent.count, 1);
		assert.equal(byTag.structuredContent.entries[0].slug, "alpha");
	} finally {
		await cleanup();
	}
});

// ─── handleLibraryReindex ──────────────────────────────────────────────────

test("handleLibraryReindex regenerates index.yaml", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await handlePublish(basePublishArgs(libraryPath));
		// Delete the auto-generated index, then explicitly reindex.
		await rm(join(libraryPath, LIBRARY_INDEX_FILE), { force: true });
		const result = await handleLibraryReindex({ library_path: libraryPath });
		assert.equal(result.structuredContent.entry_count, 1);
		assert.deepEqual(result.structuredContent.namespaces, ["james"]);
		// Index file exists again.
		await readFile(join(libraryPath, LIBRARY_INDEX_FILE), "utf8");
	} finally {
		await cleanup();
	}
});

test("handleLibraryReindex rejects on missing marker", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-no-lib-reindex-"));
	try {
		await assert.rejects(
			handleLibraryReindex({ library_path: dir }),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
