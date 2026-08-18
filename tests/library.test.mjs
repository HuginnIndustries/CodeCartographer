// Tests for core/library.ts — the on-disk library store for
// reimplementation-spec artifacts.
//
// Covers: marker round-trips, discovery, publish v1 / v2 paths,
// content-hash idempotence, force-new-version override, namespacing
// (on and off), slug validation, readEntry (latest + specific version),
// listEntries filters, reindex from a hand-edited tree, malformed
// metadata graceful fallback, and commitPublish in a non-git directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = await import(pathToFileURL(`${REPO_ROOT}/core/library.ts`).href);
const {
	LIBRARY_MARKER_FILE,
	LIBRARY_INDEX_FILE,
	LIBRARY_INDEX_MD_FILE,
	ENTRIES_DIR,
	SPEC_FILE,
	METADATA_FILE,
	LATEST_POINTER_FILE,
	deriveSlug,
	isValidSlug,
	writeMarker,
	readMarker,
	discoverLibrary,
	publishEntry,
	readEntry,
	listEntries,
	reindex,
	commitPublish,
} = lib;

async function makeLibrary({ namespaced = true, name = "test-library" } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-library-"));
	await writeMarker(dir, {
		schema_version: 1,
		name,
		namespaced,
	});
	return { libraryRoot: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function sampleInput(overrides = {}) {
	return {
		slug: "hexbridge",
		namespace: "james",
		source_repo: "https://github.com/myorg/hexbridge",
		source_commit: "abc1234",
		analyzed_at: "2026-05-14T14:00:00Z",
		pipeline: "pipeline-full-with-deep-audit",
		codecarto_version: "0.9.0",
		headline: "Fans out Kafka events to per-tenant Redis streams.",
		tags: ["event-routing", "multi-tenant", "kafka"],
		capabilities: ["tenant-isolated fanout", "at-least-once delivery"],
		generation: {
			surface: "pi-extension",
			agent: "pi",
			agent_version: "0.4.2",
			model: "claude-opus-4-6",
			model_vendor: "anthropic",
			reasoning: "high",
			notes: "",
		},
		...overrides,
	};
}

// ─── Slug helpers ──────────────────────────────────────────────────────────

test("isValidSlug accepts valid slugs and rejects invalid ones", () => {
	assert.equal(isValidSlug("hexbridge"), true);
	assert.equal(isValidSlug("payment-router"), true);
	assert.equal(isValidSlug("a"), true);

	assert.equal(isValidSlug(""), false);
	assert.equal(isValidSlug("Hexbridge"), false);    // uppercase
	assert.equal(isValidSlug("1payment"), false);     // leading digit
	assert.equal(isValidSlug("under_score"), false);  // underscore
	assert.equal(isValidSlug("space here"), false);
	assert.equal(isValidSlug("latest"), false);       // reserved
	assert.equal(isValidSlug("entries"), false);      // reserved
	assert.equal(isValidSlug("index"), false);        // reserved
});

test("deriveSlug strips .git suffix and lowercases", () => {
	assert.equal(deriveSlug("https://github.com/acme/Hex-Bridge.git"), "hex-bridge");
	assert.equal(deriveSlug("/local/path/My_Repo"), "my-repo");
	assert.equal(deriveSlug("git@github.com:acme/PaymentRouter.git"), "paymentrouter");
	// Empty / weird input still produces a valid slug.
	const empty = deriveSlug("///");
	assert.equal(isValidSlug(empty), true);
});

// ─── Marker / discovery ────────────────────────────────────────────────────

test("writeMarker + readMarker round-trips", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ name: "my-lib", namespaced: true });
	try {
		const marker = await readMarker(libraryRoot);
		assert.equal(marker.schema_version, 1);
		assert.equal(marker.name, "my-lib");
		assert.equal(marker.namespaced, true);
	} finally {
		await cleanup();
	}
});

test("discoverLibrary returns null when marker is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-not-a-lib-"));
	try {
		const marker = await discoverLibrary(dir);
		assert.equal(marker, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readMarker returns null on malformed marker JSON", async () => {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-bad-marker-"));
	try {
		await writeFile(join(dir, LIBRARY_MARKER_FILE), "{not valid json", "utf8");
		const marker = await readMarker(dir);
		assert.equal(marker, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── Publish ───────────────────────────────────────────────────────────────

test("publishEntry creates v1 with spec + metadata + latest pointer", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		const spec = "# spec content\n\nsome stuff\n";
		const result = await publishEntry(libraryRoot, spec, sampleInput());
		assert.equal(result.version, 1);
		assert.equal(result.isNewVersion, true);
		assert.equal(result.namespace, "james");

		const specPath = join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", "v1", SPEC_FILE);
		const metaPath = join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", "v1", METADATA_FILE);
		const latestPath = join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", LATEST_POINTER_FILE);

		assert.equal(await readFile(specPath, "utf8"), spec);
		const metaRaw = await readFile(metaPath, "utf8");
		assert.match(metaRaw, /slug: hexbridge/);
		assert.match(metaRaw, /version: 1/);
		assert.match(metaRaw, /surface: pi-extension/);
		const latest = (await readFile(latestPath, "utf8")).trim();
		assert.equal(latest, "v1");
	} finally {
		await cleanup();
	}
});

test("publishEntry is content-hash idempotent — same bytes does not bump version", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		const spec = "# stable content\n";
		const first = await publishEntry(libraryRoot, spec, sampleInput());
		assert.equal(first.version, 1);
		assert.equal(first.isNewVersion, true);

		// Same content, different tags — should update metadata in place, not bump version.
		const second = await publishEntry(
			libraryRoot,
			spec,
			sampleInput({ tags: ["event-routing", "multi-tenant", "kafka", "redis"] }),
		);
		assert.equal(second.version, 1);
		assert.equal(second.isNewVersion, false);

		// The latest pointer still points at v1.
		const latest = (await readFile(join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", LATEST_POINTER_FILE), "utf8")).trim();
		assert.equal(latest, "v1");

		// Metadata in v1 reflects the updated tags.
		const metaRaw = await readFile(join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", "v1", METADATA_FILE), "utf8");
		assert.match(metaRaw, /redis/);
	} finally {
		await cleanup();
	}
});

test("publishEntry bumps version when spec content changes", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1 content\n", sampleInput());
		const v2 = await publishEntry(libraryRoot, "# v2 content\n", sampleInput());
		assert.equal(v2.version, 2);
		assert.equal(v2.isNewVersion, true);

		const latest = (await readFile(join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", LATEST_POINTER_FILE), "utf8")).trim();
		assert.equal(latest, "v2");

		// v1 still exists.
		const v1Spec = await readFile(join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", "v1", SPEC_FILE), "utf8");
		assert.equal(v1Spec, "# v1 content\n");
	} finally {
		await cleanup();
	}
});

test("publishEntry forceNewVersion bypasses idempotence", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# stable\n", sampleInput());
		const forced = await publishEntry(libraryRoot, "# stable\n", sampleInput(), { forceNewVersion: true });
		assert.equal(forced.version, 2);
		assert.equal(forced.isNewVersion, true);
	} finally {
		await cleanup();
	}
});

test("publishEntry rejects invalid slugs", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await assert.rejects(
			() => publishEntry(libraryRoot, "spec", sampleInput({ slug: "Bad_Slug" })),
			/Invalid slug/,
		);
		await assert.rejects(
			() => publishEntry(libraryRoot, "spec", sampleInput({ slug: "latest" })),
			/Invalid slug/,
		);
	} finally {
		await cleanup();
	}
});

test("publishEntry requires namespace when library is namespaced", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ namespaced: true });
	try {
		const input = sampleInput();
		delete input.namespace;
		await assert.rejects(() => publishEntry(libraryRoot, "spec", input), /namespaced/);
	} finally {
		await cleanup();
	}
});

test("publishEntry forbids namespace when library is single-tenant", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ namespaced: false });
	try {
		await assert.rejects(
			() => publishEntry(libraryRoot, "spec", sampleInput()),
			/not namespaced/,
		);
	} finally {
		await cleanup();
	}
});

test("publishEntry works in a single-tenant library without namespace", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ namespaced: false });
	try {
		const input = sampleInput();
		delete input.namespace;
		const result = await publishEntry(libraryRoot, "# spec\n", input);
		assert.equal(result.namespace, undefined);
		assert.equal(result.version, 1);

		const specPath = join(libraryRoot, ENTRIES_DIR, "hexbridge", "v1", SPEC_FILE);
		assert.equal(await readFile(specPath, "utf8"), "# spec\n");
	} finally {
		await cleanup();
	}
});

test("publishEntry refuses to publish to a directory without a marker", async () => {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-no-marker-"));
	try {
		await assert.rejects(
			() => publishEntry(dir, "spec", sampleInput()),
			/Not a CodeCartographer library/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── Read / list ──────────────────────────────────────────────────────────

test("readEntry resolves to latest when version is omitted", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput());
		await publishEntry(libraryRoot, "# v2\n", sampleInput());

		const result = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
		assert.equal(result.metadata.version, 2);
		assert.equal(result.spec, "# v2\n");
	} finally {
		await cleanup();
	}
});

test("readEntry can fetch a specific older version", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput());
		await publishEntry(libraryRoot, "# v2\n", sampleInput());

		const result = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james", version: 1 });
		assert.equal(result.metadata.version, 1);
		assert.equal(result.spec, "# v1\n");
	} finally {
		await cleanup();
	}
});

test("readEntry throws on missing entry", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await assert.rejects(
			() => readEntry(libraryRoot, { slug: "missing", namespace: "james" }),
			/Entry not found/,
		);
	} finally {
		await cleanup();
	}
});

test("listEntries returns all entries from a fresh reindex", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# a\n", sampleInput({ slug: "alpha" }));
		await publishEntry(libraryRoot, "# b\n", sampleInput({ slug: "beta", tags: ["server", "go"] }));
		await publishEntry(libraryRoot, "# c\n", sampleInput({ slug: "gamma", namespace: "alice", tags: ["client"] }));

		const all = await listEntries(libraryRoot);
		assert.equal(all.length, 3);
		// Alphabetical by (namespace, slug): alice/gamma, james/alpha, james/beta
		assert.equal(all[0].namespace, "alice");
		assert.equal(all[0].slug, "gamma");
		assert.equal(all[1].namespace, "james");
		assert.equal(all[1].slug, "alpha");
		assert.equal(all[2].namespace, "james");
		assert.equal(all[2].slug, "beta");
	} finally {
		await cleanup();
	}
});

test("listEntries filters by namespace, tag, slug, and source_repo", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		// Each entry has a unique tag so filter assertions are unambiguous.
		await publishEntry(libraryRoot, "# a\n", sampleInput({ slug: "alpha", tags: ["kafka"] }));
		await publishEntry(libraryRoot, "# b\n", sampleInput({ slug: "beta", tags: ["redis"] }));
		await publishEntry(libraryRoot, "# c\n", sampleInput({ slug: "gamma", namespace: "alice", source_repo: "https://github.com/alice/gamma", tags: ["postgres"] }));

		const byNs = await listEntries(libraryRoot, { namespace: "alice" });
		assert.equal(byNs.length, 1);
		assert.equal(byNs[0].slug, "gamma");

		const byTag = await listEntries(libraryRoot, { tag: "kafka" });
		assert.equal(byTag.length, 1);
		assert.equal(byTag[0].slug, "alpha");

		const bySlug = await listEntries(libraryRoot, { slug: "beta" });
		assert.equal(bySlug.length, 1);

		const byRepo = await listEntries(libraryRoot, { source_repo: "https://github.com/alice/gamma" });
		assert.equal(byRepo.length, 1);
	} finally {
		await cleanup();
	}
});

// ─── Reindex ──────────────────────────────────────────────────────────────

test("INDEX.md escapes backslashes before pipes so a headline cannot break the table row", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		const v1Dir = join(libraryRoot, ENTRIES_DIR, "james", "hostile", "v1");
		await mkdir(v1Dir, { recursive: true });
		await writeFile(join(v1Dir, SPEC_FILE), "# hostile spec\n", "utf8");
		await writeFile(join(v1Dir, METADATA_FILE), [
			"slug: hostile",
			"namespace: james",
			"version: 1",
			"source_repo: https://github.com/james/hostile",
			"analyzed_at: '2026-05-01T10:00:00Z'",
			"pipeline: pipeline-lite",
			"codecarto_version: 0.9.0",
			"headline: 'evil\\| break | out'",
			"tags: []",
			"capabilities: []",
			"generation:",
			"  surface: drop-in",
			"  agent: manual",
			"  agent_version: unknown",
			"  model: unknown",
			"  model_vendor: unknown",
			"  reasoning: unknown",
			'  notes: ""',
			"",
		].join("\n"), "utf8");
		await writeFile(join(libraryRoot, ENTRIES_DIR, "james", "hostile", LATEST_POINTER_FILE), "v1\n", "utf8");

		await reindex(libraryRoot);
		const indexMd = await readFile(join(libraryRoot, LIBRARY_INDEX_MD_FILE), "utf8");
		// Input `evil\|` must emit `evil\\\|` (escaped backslash, then escaped
		// pipe). Escaping only the pipe emits `evil\\|` — a literal backslash
		// followed by a live cell delimiter, i.e. the breakout this pins shut.
		assert.ok(indexMd.includes("evil\\\\\\| break \\| out"), `row must escape the backslash before the pipe, got: ${indexMd.split("\n").find((l) => l.includes("hostile"))}`);
		assert.ok(!indexMd.includes("evil\\\\| break"), "the unescaped-backslash breakout form must not appear");
	} finally {
		await cleanup();
	}
});

test("reindex generates index.yaml + INDEX.md from a hand-built tree", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		// Hand-build an entry without going through publishEntry — simulates
		// importing entries from another library or a manual edit.
		const v1Dir = join(libraryRoot, ENTRIES_DIR, "james", "manual", "v1");
		await mkdir(v1Dir, { recursive: true });
		await writeFile(join(v1Dir, SPEC_FILE), "# manual spec\n", "utf8");
		const manualMeta = [
			"slug: manual",
			"namespace: james",
			"version: 1",
			"source_repo: https://github.com/james/manual",
			"analyzed_at: '2026-05-01T10:00:00Z'",
			"pipeline: pipeline-lite",
			"codecarto_version: 0.9.0",
			"headline: Manually constructed entry.",
			"tags:",
			"  - manual",
			"  - test",
			"capabilities:",
			"  - none",
			"generation:",
			"  surface: drop-in",
			"  agent: manual",
			"  agent_version: unknown",
			"  model: unknown",
			"  model_vendor: unknown",
			"  reasoning: unknown",
			'  notes: ""',
			"",
		].join("\n");
		await writeFile(join(v1Dir, METADATA_FILE), manualMeta, "utf8");
		await writeFile(join(libraryRoot, ENTRIES_DIR, "james", "manual", LATEST_POINTER_FILE), "v1\n", "utf8");

		const idx = await reindex(libraryRoot);
		assert.equal(idx.entry_count, 1);
		assert.equal(idx.entries[0].slug, "manual");
		assert.equal(idx.entries[0].latest_version, 1);
		assert.deepEqual(idx.entries[0].tags, ["manual", "test"]);

		// Files exist on disk.
		const indexYaml = await readFile(join(libraryRoot, LIBRARY_INDEX_FILE), "utf8");
		assert.match(indexYaml, /slug: manual/);
		const indexMd = await readFile(join(libraryRoot, LIBRARY_INDEX_MD_FILE), "utf8");
		assert.match(indexMd, /\| \[manual\]/);
		assert.match(indexMd, /Manually constructed entry/);
	} finally {
		await cleanup();
	}
});

test("reindex skips entries whose metadata is malformed", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		// One good entry, one with malformed metadata.
		await publishEntry(libraryRoot, "# ok\n", sampleInput({ slug: "good" }));
		const badDir = join(libraryRoot, ENTRIES_DIR, "james", "bad", "v1");
		await mkdir(badDir, { recursive: true });
		await writeFile(join(badDir, SPEC_FILE), "# bad\n", "utf8");
		await writeFile(join(badDir, METADATA_FILE), ":::not valid yaml:::", "utf8");

		const idx = await reindex(libraryRoot);
		const slugs = idx.entries.map((e) => e.slug);
		assert.ok(slugs.includes("good"));
		// The bad entry is silently dropped from the index — caller can still
		// see it on disk but it doesn't poison the registry.
		assert.equal(slugs.includes("bad"), false);
	} finally {
		await cleanup();
	}
});

test("listEntries regenerates index when it is missing", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# x\n", sampleInput({ slug: "alpha" }));
		// Delete the index file — listEntries should rebuild it.
		await rm(join(libraryRoot, LIBRARY_INDEX_FILE), { force: true });

		const result = await listEntries(libraryRoot);
		assert.equal(result.length, 1);
		assert.equal(result[0].slug, "alpha");
	} finally {
		await cleanup();
	}
});

// ─── Git ──────────────────────────────────────────────────────────────────

test("commitPublish returns not-a-git-repo when .git is missing", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# spec\n", sampleInput());
		const result = await commitPublish(libraryRoot, "publish: james/hexbridge v1");
		assert.equal(result.ok, false);
		assert.equal(result.skipped, "not-a-git-repo");
	} finally {
		await cleanup();
	}
});
