// Tests for the new MCP library handlers: handlePublish, handleLibraryList,
// handleLibraryReindex. Drives the handlers directly against tmp libraries
// (no stdio transport) and verifies the same content-shape conventions as
// the existing mcp-server.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { handlePublish, handleLibraryList, handleLibraryReindex } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { writeMarker, LIBRARY_MARKER_FILE, LIBRARY_INDEX_FILE, ENTRIES_DIR, METADATA_FILE, SPEC_FILE, ConfidentialityMismatchError } = await import(pathToFileURL(`${REPO_ROOT}/core/library.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

// handlePublish reads the user-global config for its publish_confirm gate.
// Point that at a path which does not exist so the developer's real
// ~/.codecarto/config.yaml (which library-init writes publish_confirm: true
// into) cannot leak into these tests. node --test runs each file in its own
// process, so this cannot leak out either.
process.env.CODECARTO_USER_CONFIG_PATH = join(tmpdir(), `cc-mcp-lib-no-user-config-${process.pid}`, "config.yaml");

async function makeLib({ namespaced = true, name = "mcp-test-lib", visibility = undefined } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "cc-mcp-lib-"));
	await writeMarker(dir, { schema_version: 1, name, namespaced, ...(visibility ? { visibility } : {}) });
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

// ─── handlePublish: confidentiality vs library visibility ──────────────────

test("handlePublish refuses an internal entry into a public library and writes nothing", async () => {
	const { libraryPath, cleanup } = await makeLib({ visibility: "public" });
	try {
		await assert.rejects(
			handlePublish(basePublishArgs(libraryPath, { confidentiality: "internal" })),
			(error) => {
				// Surfaced as the core's typed error, not rewrapped: the server's
				// CallTool handler turns any non-McpError into an InternalError that
				// keeps this message, and the message names the override.
				assert.ok(error instanceof ConfidentialityMismatchError);
				assert.equal(error.entryConfidentiality, "internal");
				assert.equal(error.libraryVisibility, "public");
				assert.match(error.message, /allow_confidentiality_mismatch/);
				return true;
			},
		);
		assert.deepEqual(await readdir(libraryPath), [LIBRARY_MARKER_FILE]);
	} finally {
		await cleanup();
	}
});

test("handlePublish treats an omitted confidentiality as internal", async () => {
	const { libraryPath, cleanup } = await makeLib({ visibility: "shared" });
	try {
		// basePublishArgs carries no confidentiality — the common MCP call shape.
		await assert.rejects(handlePublish(basePublishArgs(libraryPath)), ConfidentialityMismatchError);
	} finally {
		await cleanup();
	}
});

test("handlePublish accepts an entry at or above the library's visibility", async () => {
	const { libraryPath, cleanup } = await makeLib({ visibility: "shared" });
	try {
		const same = await handlePublish(basePublishArgs(libraryPath, { slug: "same-level", confidentiality: "shared" }));
		assert.equal(same.structuredContent.version, 1);
		const wider = await handlePublish(basePublishArgs(libraryPath, { slug: "wider", confidentiality: "public" }));
		assert.equal(wider.structuredContent.version, 1);
	} finally {
		await cleanup();
	}
});

test("handlePublish allow_confidentiality_mismatch publishes anyway without reclassifying", async () => {
	const { libraryPath, cleanup } = await makeLib({ visibility: "public" });
	try {
		const result = await handlePublish(basePublishArgs(libraryPath, {
			confidentiality: "internal",
			allow_confidentiality_mismatch: true,
		}));
		assert.equal(result.structuredContent.version, 1);
		const meta = await readFile(join(libraryPath, ENTRIES_DIR, "james", "sample", "v1", METADATA_FILE), "utf8");
		assert.match(meta, /^confidentiality: internal$/m);
	} finally {
		await cleanup();
	}
});

test("handlePublish only honours a boolean true as the confidentiality override", async () => {
	// Same shape as allow_source_repo_change: the flag is `=== true`, so a
	// host that passes the string "true" has not opted in.
	const { libraryPath, cleanup } = await makeLib({ visibility: "public" });
	try {
		await assert.rejects(
			handlePublish(basePublishArgs(libraryPath, { confidentiality: "internal", allow_confidentiality_mismatch: "true" })),
			ConfidentialityMismatchError,
		);
	} finally {
		await cleanup();
	}
});

// ─── handlePublish: the publish_confirm gate (#162) ────────────────────────

/** Run `fn` with the user-global config set to `content` (or absent when undefined). */
async function withUserConfig(content, fn) {
	const previous = process.env.CODECARTO_USER_CONFIG_PATH;
	const dir = await mkdtemp(join(tmpdir(), "cc-mcp-userconfig-"));
	const path = join(dir, "config.yaml");
	if (content !== undefined) await writeFile(path, content, "utf8");
	process.env.CODECARTO_USER_CONFIG_PATH = path;
	try {
		return await fn();
	} finally {
		process.env.CODECARTO_USER_CONFIG_PATH = previous;
		await rm(dir, { recursive: true, force: true });
	}
}

/** A workspace whose .codecarto/workflow/config.yaml holds `content`. */
async function makeWorkspace(content) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-mcp-ws-"));
	await mkdir(join(cwd, ".codecarto", "workflow"), { recursive: true });
	await writeFile(join(cwd, ".codecarto", "workflow", "config.yaml"), content, "utf8");
	return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

const GATE_ON = "library:\n  publish_confirm: true\n";
const GATE_OFF = "library:\n  publish_confirm: false\n";

function assertPublishConfirmRefusal(error) {
	// The shape codecarto_broadside's spend gate has: an InvalidRequest whose
	// message is the whole story, so a host that reads only the error text
	// still sees the preview and the way forward.
	assert.ok(error instanceof McpError);
	assert.equal(error.code, ErrorCode.InvalidRequest);
	assert.match(error.message, /library\.publish_confirm is set/);
	assert.match(error.message, /Nothing was written/);
	assert.match(error.message, /confirm: true/);
	assert.equal(error.data.refused, "publish_confirm");
	return true;
}

test("handlePublish refuses without confirm when publish_confirm is configured, previews, and writes nothing", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await withUserConfig(GATE_ON, async () => {
			await assert.rejects(
				handlePublish(basePublishArgs(libraryPath)),
				(error) => {
					assertPublishConfirmRefusal(error);
					// The preview is what Pi's dialog shows: where, what, and which
					// branch of the version history it would take.
					assert.match(error.message, new RegExp(`Would publish james/sample to ${libraryPath}`));
					assert.match(error.message, /Version: v1 \(first version of a new entry\)/);
					assert.match(error.message, /Source repo: https:\/\/github\.com\/myorg\/sample/);
					assert.match(error.message, /Headline: Sample library entry\./);
					assert.match(error.message, /Confidentiality: internal \(the default; none declared\)/);
					assert.match(error.message, /Spec: inline \(\d+ characters\)/);
					assert.deepEqual(
						{ ...error.data },
						{
							refused: "publish_confirm",
							libraryPath,
							namespace: "james",
							slug: "sample",
							version: 1,
							isNewVersion: true,
							latestVersion: 0,
							source_repo: "https://github.com/myorg/sample",
							headline: "Sample library entry.",
							confidentiality: null,
						},
					);
					return true;
				},
			);
		});
		assert.deepEqual(await readdir(libraryPath), [LIBRARY_MARKER_FILE], "a refusal must write nothing, not even an index");
	} finally {
		await cleanup();
	}
});

test("the publish_confirm preview tells a metadata-only update from a new version", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await withUserConfig(GATE_ON, async () => {
			const first = await handlePublish(basePublishArgs(libraryPath, { confirm: true }));
			assert.equal(first.structuredContent.version, 1);

			await assert.rejects(
				handlePublish(basePublishArgs(libraryPath, { tags: ["retagged"] })),
				(error) => {
					assertPublishConfirmRefusal(error);
					assert.match(error.message, /Version: v1 \(metadata-only update; the content hash matches the newest version\)/);
					assert.equal(error.data.isNewVersion, false);
					assert.equal(error.data.latestVersion, 1);
					return true;
				},
			);
			await assert.rejects(
				handlePublish(basePublishArgs(libraryPath, { spec: "# changed\n" })),
				(error) => {
					assertPublishConfirmRefusal(error);
					assert.match(error.message, /Version: v2 \(new content version; the newest is v1\)/);
					assert.deepEqual([error.data.version, error.data.isNewVersion], [2, true]);
					return true;
				},
			);
			await assert.rejects(
				handlePublish(basePublishArgs(libraryPath, { force_new_version: true })),
				(error) => {
					assertPublishConfirmRefusal(error);
					assert.match(error.message, /Version: v2 \(new content version/, "force_new_version is part of what would happen");
					return true;
				},
			);
			// Nothing above changed the library: the retag never landed.
			const meta = await readFile(join(libraryPath, ENTRIES_DIR, "james", "sample", "v1", METADATA_FILE), "utf8");
			assert.doesNotMatch(meta, /retagged/);
			assert.deepEqual(await readdir(join(libraryPath, ENTRIES_DIR, "james", "sample")), ["latest", "v1"]);
		});
	} finally {
		await cleanup();
	}
});

test("handlePublish with confirm: true publishes through a configured gate", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await withUserConfig(GATE_ON, async () => {
			const result = await handlePublish(basePublishArgs(libraryPath, { confirm: true, spec_path: undefined }));
			assert.equal(result.structuredContent.version, 1);
			assert.match(result.content[0].text, /Published james\/sample v1/);
		});
	} finally {
		await cleanup();
	}
});

test("handlePublish only honours a boolean true as the confirmation", async () => {
	// Same rule as every other flag on this tool: `=== true`. A host that
	// passes the string "true" has not confirmed anything.
	const { libraryPath, cleanup } = await makeLib();
	try {
		await withUserConfig(GATE_ON, async () => {
			await assert.rejects(handlePublish(basePublishArgs(libraryPath, { confirm: "true" })), assertPublishConfirmRefusal);
		});
	} finally {
		await cleanup();
	}
});

test("handlePublish is not gated when publish_confirm is unset or false", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		// Unset: the loader defaults publish_confirm to true, but that default
		// drives Pi's dialog; a host that never configured the key keeps the
		// behavior it had. No config file at all is the common MCP shape.
		await withUserConfig(undefined, async () => {
			const result = await handlePublish(basePublishArgs(libraryPath, { slug: "unset" }));
			assert.equal(result.structuredContent.version, 1);
		});
		// A file that sets other keys but not this one is still "unset".
		await withUserConfig("library:\n  namespace: james\n", async () => {
			const result = await handlePublish(basePublishArgs(libraryPath, { slug: "other-keys" }));
			assert.equal(result.structuredContent.version, 1);
		});
		await withUserConfig(GATE_OFF, async () => {
			const result = await handlePublish(basePublishArgs(libraryPath, { slug: "off" }));
			assert.equal(result.structuredContent.version, 1);
			// confirm: true is harmless when nothing asks for it.
			const again = await handlePublish(basePublishArgs(libraryPath, { slug: "off-confirmed", confirm: true }));
			assert.equal(again.structuredContent.version, 1);
		});
	} finally {
		await cleanup();
	}
});

test("the gate reads the same layered config codecarto_config reports for a cwd", async () => {
	const { libraryPath, cleanup } = await makeLib();
	const on = await makeWorkspace(GATE_ON);
	const off = await makeWorkspace(GATE_OFF);
	try {
		// Workspace sets it, user-global does not: gated.
		await withUserConfig(undefined, async () => {
			await assert.rejects(handlePublish(basePublishArgs(libraryPath, { cwd: on.cwd })), assertPublishConfirmRefusal);
		});
		// User-global sets true, workspace overrides with false: not gated.
		await withUserConfig(GATE_ON, async () => {
			const result = await handlePublish(basePublishArgs(libraryPath, { cwd: off.cwd }));
			assert.equal(result.structuredContent.version, 1);
		});
		// User-global sets false, workspace overrides with true: gated.
		await withUserConfig(GATE_OFF, async () => {
			await assert.rejects(handlePublish(basePublishArgs(libraryPath, { cwd: on.cwd, spec: "# v2\n" })), assertPublishConfirmRefusal);
		});
	} finally {
		await on.cleanup();
		await off.cleanup();
		await cleanup();
	}
});

test("the gate runs after argument validation, so a refusal previews a publish that would succeed", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await withUserConfig(GATE_ON, async () => {
			const args = basePublishArgs(libraryPath);
			delete args.headline;
			await assert.rejects(handlePublish(args), (error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams, "a bad argument is reported as such, not hidden behind the gate");
				assert.match(error.message, /headline/);
				return true;
			});
		});
	} finally {
		await cleanup();
	}
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

// ─── Provenance conflicts (#148) ───────────────────────────────────────────

// The on-disk shape a pre-guard slug collision left behind: v1 from one
// project, v2 from another, the index naming only the second. Writing it
// today takes the explicit override, which is the point of the override.
async function publishCollidedWhisper(libraryPath) {
	await handlePublish(basePublishArgs(libraryPath, {
		slug: "whisper",
		spec: "# openai whisper\n",
		source_repo: "https://github.com/openai/whisper",
	}));
	await handlePublish(basePublishArgs(libraryPath, {
		slug: "whisper",
		spec: "# acme whisper\n",
		source_repo: "https://github.com/acme/whisper",
		allow_source_repo_change: true,
	}));
}

const expectedWhisperConflict = {
	slug: "whisper",
	namespace: "james",
	latest_version: 2,
	source_repo: "https://github.com/acme/whisper",
	disagreeing_versions: [{ version: 1, source_repo: "https://github.com/openai/whisper" }],
};

test("handleLibraryReindex reports an entry whose versions disagree about source_repo", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await publishCollidedWhisper(libraryPath);
		await handlePublish(basePublishArgs(libraryPath));

		const result = await handleLibraryReindex({ library_path: libraryPath });
		const text = result.content[0].text;
		assert.match(text, /^Reindexed .*: 2 entries across namespaces \[james\]\./m);
		assert.match(text, /^Provenance conflicts — 1 entry whose versions disagree about source_repo:$/m);
		assert.match(
			text,
			/^  james\/whisper: the index advertises https:\/\/github\.com\/acme\/whisper \(v2\), but v1 records https:\/\/github\.com\/openai\/whisper\.$/m,
		);
		assert.match(text, /Repair is manual: split the entry by hand — the framework does not rename or renumber versions, because entry paths are ABI\./);
		// The healthy entry stays out of the report.
		assert.doesNotMatch(text, /james\/sample/);
		assert.deepEqual(result.structuredContent.provenance_conflicts, [expectedWhisperConflict]);
		assert.equal(result.structuredContent.entry_count, 2);
	} finally {
		await cleanup();
	}
});

test("handleLibraryReindex says nothing about provenance on a healthy library", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await handlePublish(basePublishArgs(libraryPath, { spec: "# v1\n" }));
		await handlePublish(basePublishArgs(libraryPath, { spec: "# v2\n", source_repo: "git@github.com:myorg/sample.git" }));

		const result = await handleLibraryReindex({ library_path: libraryPath });
		assert.equal(result.content[0].text, `Reindexed ${libraryPath}: 1 entry across namespaces [james].`);
		assert.deepEqual(result.structuredContent.provenance_conflicts, []);
	} finally {
		await cleanup();
	}
});

test("handleLibraryList flags a conflicted entry and leaves the healthy ones alone", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await publishCollidedWhisper(libraryPath);
		await handlePublish(basePublishArgs(libraryPath));

		const result = await handleLibraryList({ library_path: libraryPath });
		const lines = result.content[0].text.split("\n");
		const whisperLine = lines.find((l) => l.startsWith("  james/whisper v2"));
		const sampleLine = lines.find((l) => l.startsWith("  james/sample v1"));
		assert.ok(whisperLine.endsWith(" — PROVENANCE CONFLICT (see below)"), whisperLine);
		assert.doesNotMatch(sampleLine, /CONFLICT/);
		assert.match(result.content[0].text, /^Provenance conflicts — 1 entry whose versions disagree about source_repo:$/m);
		assert.match(result.content[0].text, /v1 records https:\/\/github\.com\/openai\/whisper/);
		assert.match(result.content[0].text, /Repair is manual/);
		assert.deepEqual(result.structuredContent.provenance_conflicts, [expectedWhisperConflict]);
		assert.equal(result.structuredContent.count, 2);
	} finally {
		await cleanup();
	}
});

test("handleLibraryList checks only the entries it lists", async () => {
	const { libraryPath, cleanup } = await makeLib();
	try {
		await publishCollidedWhisper(libraryPath);
		await handlePublish(basePublishArgs(libraryPath));

		const result = await handleLibraryList({ library_path: libraryPath, slug: "sample" });
		assert.equal(result.structuredContent.count, 1);
		assert.deepEqual(result.structuredContent.provenance_conflicts, []);
		assert.doesNotMatch(result.content[0].text, /conflict/i);
	} finally {
		await cleanup();
	}
});
