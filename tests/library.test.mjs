// Tests for core/library.ts — the on-disk library store for
// reimplementation-spec artifacts.
//
// Covers: marker round-trips, discovery, publish v1 / v2 paths,
// content-hash idempotence (including the provenance carry-forward on a
// metadata-only re-publish), force-new-version override, namespacing
// (on and off), slug validation, readEntry (latest + specific version),
// listEntries filters, reindex from a hand-edited tree, INDEX.md row links
// and summary line, malformed
// metadata graceful fallback, commitPublish in a non-git directory, the
// source_repo collision guard that stops one project's spec landing in
// another's version history, the confidentiality guard that stops an
// entry landing in a library more widely visible than the entry is, and the
// reindex-time report of entries the collision already merged before the
// guard existed (#148).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
	normalizeSourceRepo,
	sameSourceRepo,
	ConfidentialityMismatchError,
	detectProvenanceConflicts,
} = lib;

async function makeLibrary({ namespaced = true, name = "test-library", visibility = undefined } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-library-"));
	await writeMarker(dir, {
		schema_version: 1,
		name,
		namespaced,
		...(visibility ? { visibility } : {}),
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

test("metadata-only re-publish carries the version's recorded provenance forward", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1 content\n", sampleInput());
		const v2 = await publishEntry(libraryRoot, "# v2 content\n", sampleInput());
		assert.equal(v2.version, 2);
		const metaPath = join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", "v2", METADATA_FILE);
		assert.match(await readFile(metaPath, "utf8"), /prior_version: 1/, "the new-version publish records where v2 came from");

		// Identical bytes, new tags, no provenance on the input — exactly what
		// both surfaces send. The in-place rewrite must not drop the block.
		const again = await publishEntry(libraryRoot, "# v2 content\n", sampleInput({ tags: ["retagged"] }));
		assert.equal(again.version, 2);
		assert.equal(again.isNewVersion, false);
		const rewritten = await readFile(metaPath, "utf8");
		assert.match(rewritten, /retagged/, "the metadata-only update still lands");
		assert.match(rewritten, /prior_version: 1/);
		assert.match(rewritten, /mutation_source: null/);
		const { metadata } = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
		assert.deepEqual(metadata.provenance, { prior_version: 1, mutation_source: null });

		// A publish that does supply provenance still wins over the recorded block.
		await publishEntry(libraryRoot, "# v2 content\n", sampleInput({ provenance: { prior_version: 1, mutation_source: "manual-edit" } }));
		const overridden = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
		assert.deepEqual(overridden.metadata.provenance, { prior_version: 1, mutation_source: "manual-edit" });
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
		assert.match(indexMd, /\| \[manual\]\(entries\/james\/manual\/v1\/\) \| v1 \|/);
		assert.match(indexMd, /Manually constructed entry/);
	} finally {
		await cleanup();
	}
});

test("INDEX.md rows link to the newest version directory, never to the latest pointer file", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput());
		await publishEntry(libraryRoot, "# v2\n", sampleInput());
		await publishEntry(libraryRoot, "# only\n", sampleInput({ slug: "payment-router" }));

		const indexMd = await readFile(join(libraryRoot, LIBRARY_INDEX_MD_FILE), "utf8");
		// `latest` is a one-line regular file, so `entries/<ns>/<slug>/latest/`
		// resolves to nothing on a forge; the row must point at v<latest_version>/.
		assert.match(indexMd, /\| \[hexbridge\]\(entries\/james\/hexbridge\/v2\/\) \| v2 \|/);
		assert.match(indexMd, /\| \[payment-router\]\(entries\/james\/payment-router\/v1\/\) \| v1 \|/);
		assert.doesNotMatch(indexMd, /\/latest\//);
		assert.match(indexMd, /^\*\*2 entries\*\* across 1 namespace\.$/m);
	} finally {
		await cleanup();
	}
});

test("INDEX.md for a single-tenant library links rows without a namespace segment and pluralizes from the shown count", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ namespaced: false });
	try {
		const input = sampleInput();
		delete input.namespace;
		await publishEntry(libraryRoot, "# spec\n", input);

		const indexMd = await readFile(join(libraryRoot, LIBRARY_INDEX_MD_FILE), "utf8");
		assert.match(indexMd, /\| \[hexbridge\]\(entries\/hexbridge\/v1\/\) \| v1 \|/);
		// index.namespaces is empty here and the summary shows "1", so the noun
		// must be singular — it used to read "across 1 namespaces".
		assert.match(indexMd, /^\*\*1 entry\*\* across 1 namespace\.$/m);
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

// ─── source_repo collision guard ───────────────────────────────────────────

test("normalizeSourceRepo collapses spellings of the same repository", () => {
	const canonical = "github.com/acme/tool";
	for (const variant of [
		"https://github.com/acme/tool",
		"https://github.com/acme/tool.git",
		"https://github.com/acme/tool/",
		"http://github.com/acme/tool",
		"ssh://github.com/acme/tool.git",
		"git@github.com:acme/tool.git",
		"https://www.github.com/acme/tool",
		"github.com/acme/tool",
		"https://GitHub.com/Acme/Tool",
		"github.com\\acme\\tool",
		"  https://github.com/acme/tool.git  ",
		// Scheme plus credentials. These have to survive the userinfo strip, and
		// the scheme has to come off before the SCP branch sees the colon.
		"ssh://git@github.com/acme/tool.git",
		"ssh://git@github.com:22/acme/tool.git",
		"https://git@github.com/acme/tool",
		"https://user:token@github.com/acme/tool.git",
		"https://oauth2:x-oauth-basic@github.com/acme/tool.git",
		"git+https://github.com/acme/tool.git",
		"git://github.com/acme/tool.git",
		"https://github.com:443/acme/tool",
		"http://github.com:80/acme/tool",
		// Repeated separators name the same location.
		"https://github.com//acme//tool",
		"github.com/acme//tool/",
	]) {
		assert.equal(normalizeSourceRepo(variant), canonical, `variant: ${variant}`);
	}
});

test("normalizeSourceRepo folds case only where the target is case-insensitive", () => {
	// Hosts and the repository paths the forges serve over them are
	// case-insensitive, so these collapse.
	assert.equal(sameSourceRepo("https://GitHub.com/Acme/Tool", "https://github.com/acme/tool"), true);
	assert.equal(sameSourceRepo("git@GitHub.com:Acme/Tool.git", "github.com/acme/tool"), true);
	// Windows drive paths are case-insensitive too.
	assert.equal(sameSourceRepo("C:\\Repos\\Tool", "c:/repos/tool"), true);

	// A POSIX absolute path is not. /srv/Repos/tool and /srv/repos/tool are two
	// directories on Linux, and folding them would hide the very collision this
	// comparison exists to catch. Pi records the analyzed directory as
	// source_repo, so this is the common shape there, not a curiosity.
	assert.equal(sameSourceRepo("/srv/Repos/tool", "/srv/repos/tool"), false);
	assert.equal(sameSourceRepo("~/Work/tool", "~/work/tool"), false);
	// Same path, same case, reached via file:// — still one location.
	assert.equal(sameSourceRepo("file:///srv/Repos/tool", "/srv/Repos/tool"), true);
	// A leading `//` is a UNC share on Windows, not /server/share.
	assert.equal(sameSourceRepo("//server/share/tool", "/server/share/tool"), false);
});

test("normalizeSourceRepo keeps genuinely different repositories distinct", () => {
	assert.equal(sameSourceRepo("https://github.com/openai/whisper", "https://github.com/acme/whisper"), false);
	assert.equal(sameSourceRepo("https://github.com/acme/tool", "https://gitlab.com/acme/tool"), false);
	assert.equal(sameSourceRepo("https://github.com/acme/tool", "https://github.com/acme/tool-2"), false);
	assert.equal(sameSourceRepo("/home/a/tool", "/home/b/tool"), false);
	// A non-default port distinguishes two services on one host, so it survives
	// normalization even though 22/80/443 do not.
	assert.equal(sameSourceRepo("https://git.internal:8080/a/tool", "https://git.internal:9090/a/tool"), false);
	// Windows drive letters must not be read as SCP host:path syntax.
	assert.equal(sameSourceRepo("C:/repos/tool", "D:/repos/tool"), false);
	assert.equal(sameSourceRepo("git@github.com:acme/tool", "git@github.com:acme/other"), false);
	assert.equal(sameSourceRepo("https://github.com/acme/tool", "https://github.com/acme"), false);
});

test("publish is not refused when the same repo is re-published over SSH", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		// The realistic shape of the false positive: one clone uses HTTPS, a later
		// one uses an ssh:// remote carrying a git@ user. Same repository.
		await publishEntry(libraryRoot, "# v1\n", sampleInput({
			source_repo: "https://github.com/myorg/hexbridge",
		}));
		const result = await publishEntry(libraryRoot, "# v2\n", sampleInput({
			source_repo: "ssh://git@github.com/myorg/hexbridge.git",
		}));
		assert.equal(result.version, 2);
		assert.equal(result.isNewVersion, true);
	} finally {
		await cleanup();
	}
});

test("publish refuses a second project that derived the same slug", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		// Both repos end in "whisper", so deriveSlug produces one slug for both.
		assert.equal(deriveSlug("https://github.com/openai/whisper"), "whisper");
		assert.equal(deriveSlug("https://github.com/acme/whisper"), "whisper");

		await publishEntry(libraryRoot, "# spec A\n", sampleInput({
			slug: "whisper",
			source_repo: "https://github.com/openai/whisper",
		}));

		await assert.rejects(
			() => publishEntry(libraryRoot, "# spec B\n", sampleInput({
				slug: "whisper",
				source_repo: "https://github.com/acme/whisper",
			})),
			/Refusing to publish.*openai\/whisper.*acme\/whisper/s,
		);

		// The first project's entry is untouched: still v1, still its own repo.
		const entry = await readEntry(libraryRoot, { slug: "whisper", namespace: "james" });
		assert.equal(entry.metadata.version, 1);
		assert.equal(entry.metadata.source_repo, "https://github.com/openai/whisper");
		assert.equal(entry.spec, "# spec A\n");
	} finally {
		await cleanup();
	}
});

test("publish refuses two local directories that differ only in case", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		// The Pi shape of the bug: source_repo is the analyzed directory, and slug
		// derives from the same string, so sibling trees collide. Case is the part
		// a naive fold would throw away.
		await publishEntry(libraryRoot, "# spec A\n", sampleInput({
			slug: "tool",
			source_repo: "/srv/Repos/tool",
		}));
		await assert.rejects(
			() => publishEntry(libraryRoot, "# spec B\n", sampleInput({
				slug: "tool",
				source_repo: "/srv/repos/tool",
			})),
			/Refusing to publish/,
		);
	} finally {
		await cleanup();
	}
});

test("the refusal names where the override actually lives", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# spec A\n", sampleInput({
			slug: "whisper",
			source_repo: "https://github.com/openai/whisper",
		}));
		await assert.rejects(
			() => publishEntry(libraryRoot, "# spec B\n", sampleInput({
				slug: "whisper",
				source_repo: "https://github.com/acme/whisper",
			})),
			(err) => {
				// Both spellings, so the reader can act on whichever surface they are
				// on. The message must not tell them to "pass" an option the caller
				// may not expose: /codecarto-publish in Pi takes no arguments.
				assert.match(err.message, /allow_source_repo_change/);
				assert.match(err.message, /allowSourceRepoChange/);
				assert.doesNotMatch(err.message, /Pass an explicit/);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("the collision guard also covers the metadata-only path", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		const spec = "# identical bytes\n";
		await publishEntry(libraryRoot, spec, sampleInput({
			slug: "whisper",
			source_repo: "https://github.com/openai/whisper",
		}));

		// Identical spec bytes would otherwise take the in-place metadata update
		// branch and silently rewrite the other project's source_repo.
		await assert.rejects(
			() => publishEntry(libraryRoot, spec, sampleInput({
				slug: "whisper",
				source_repo: "https://github.com/acme/whisper",
				headline: "A different project entirely.",
			})),
			/Refusing to publish/,
		);

		const entry = await readEntry(libraryRoot, { slug: "whisper", namespace: "james" });
		assert.equal(entry.metadata.source_repo, "https://github.com/openai/whisper");
		assert.equal(entry.metadata.headline, sampleInput().headline);
	} finally {
		await cleanup();
	}
});

test("publish accepts the same repository spelled differently", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput({
			source_repo: "https://github.com/myorg/hexbridge",
		}));
		// A later run reporting the SCP form plus .git must not read as a new project.
		const result = await publishEntry(libraryRoot, "# v2\n", sampleInput({
			source_repo: "git@github.com:myorg/hexbridge.git",
		}));
		assert.equal(result.version, 2);
		assert.equal(result.isNewVersion, true);
	} finally {
		await cleanup();
	}
});

test("allowSourceRepoChange permits a genuine repository move", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput({
			source_repo: "https://github.com/oldorg/hexbridge",
		}));
		const result = await publishEntry(
			libraryRoot,
			"# v2\n",
			sampleInput({ source_repo: "https://github.com/neworg/hexbridge" }),
			{ allowSourceRepoChange: true },
		);
		assert.equal(result.version, 2);
		const entry = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
		assert.equal(entry.metadata.source_repo, "https://github.com/neworg/hexbridge");
	} finally {
		await cleanup();
	}
});

test("the collision guard stays out of the way when metadata is unreadable", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput());
		// Corrupt the recorded metadata: source_repo becomes undeterminable, so the
		// guard has nothing to compare and must not block the publish.
		const metaPath = join(libraryRoot, ENTRIES_DIR, "james", "hexbridge", "v1", METADATA_FILE);
		await writeFile(metaPath, ":::not valid yaml:::\n", "utf8");

		const result = await publishEntry(libraryRoot, "# v2\n", sampleInput({
			source_repo: "https://github.com/someoneelse/hexbridge",
		}));
		assert.equal(result.version, 2);
	} finally {
		await cleanup();
	}
});

test("forceNewVersion does not bypass the collision guard", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishEntry(libraryRoot, "# spec A\n", sampleInput({
			slug: "whisper",
			source_repo: "https://github.com/openai/whisper",
		}));
		await assert.rejects(
			() => publishEntry(
				libraryRoot,
				"# spec B\n",
				sampleInput({ slug: "whisper", source_repo: "https://github.com/acme/whisper" }),
				{ forceNewVersion: true },
			),
			/Refusing to publish/,
		);
	} finally {
		await cleanup();
	}
});

// ─── Confidentiality vs library visibility ─────────────────────────────────

// Least to most widely visible. An entry may sit in a library at or below its
// own level; one above it would expose the entry to everyone the library reaches.
const VISIBILITY_LEVELS = ["internal", "shared", "public"];
const leaksInto = (confidentiality, libraryVisibility) =>
	VISIBILITY_LEVELS.indexOf(confidentiality) < VISIBILITY_LEVELS.indexOf(libraryVisibility);

test("exactly three of the nine level combinations leak", () => {
	// Pins the matrix the loop below runs against, so a change to the ordering
	// cannot silently turn the nine generated tests into a different rule.
	const leaking = [];
	for (const libraryVisibility of VISIBILITY_LEVELS) {
		for (const confidentiality of VISIBILITY_LEVELS) {
			if (leaksInto(confidentiality, libraryVisibility)) leaking.push(`${confidentiality} -> ${libraryVisibility}`);
		}
	}
	assert.deepEqual(leaking, ["internal -> shared", "internal -> public", "shared -> public"]);
});

const article = (word) => (/^[aeiou]/.test(word) ? "an" : "a");

for (const libraryVisibility of VISIBILITY_LEVELS) {
	for (const confidentiality of VISIBILITY_LEVELS) {
		const leaks = leaksInto(confidentiality, libraryVisibility);
		test(`${article(confidentiality)} ${confidentiality} entry into ${article(libraryVisibility)} ${libraryVisibility} library ${leaks ? "is refused" : "publishes"}`, async () => {
			const { libraryRoot, cleanup } = await makeLibrary({ visibility: libraryVisibility });
			try {
				const publish = () => publishEntry(libraryRoot, "# spec\n", sampleInput({ confidentiality }));
				if (leaks) {
					await assert.rejects(publish, ConfidentialityMismatchError);
				} else {
					const result = await publish();
					assert.equal(result.version, 1);
					const entry = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
					assert.equal(entry.metadata.confidentiality, confidentiality);
				}
			} finally {
				await cleanup();
			}
		});
	}
}

test("a marker with no visibility is treated as internal", async () => {
	// No visibility field is the shape every marker had before the field
	// mattered. Internal is the floor, so every level lands and nothing that
	// published before is refused now.
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		for (const confidentiality of [undefined, ...VISIBILITY_LEVELS]) {
			const slug = `entry-${confidentiality ?? "unset"}`;
			const result = await publishEntry(libraryRoot, "# spec\n", sampleInput({ slug, confidentiality }));
			assert.equal(result.version, 1);
		}
	} finally {
		await cleanup();
	}
});

test("an entry with no declared confidentiality is treated as internal", async () => {
	// The documented default. Pi never declares one, so this is the shape a Pi
	// publish into a shared or public library takes.
	const { libraryRoot, cleanup } = await makeLibrary({ visibility: "public" });
	try {
		await assert.rejects(
			() => publishEntry(libraryRoot, "# spec\n", sampleInput({ confidentiality: undefined })),
			(err) => {
				assert.ok(err instanceof ConfidentialityMismatchError);
				assert.equal(err.entryConfidentiality, "internal");
				assert.equal(err.libraryVisibility, "public");
				assert.match(err.message, /the default when none is declared/);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("the confidentiality refusal names both levels and where the override lives", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ name: "team-shelf", visibility: "shared" });
	try {
		await assert.rejects(
			() => publishEntry(libraryRoot, "# spec\n", sampleInput({ confidentiality: "internal" })),
			(err) => {
				assert.equal(err.name, "ConfidentialityMismatchError");
				assert.match(err.message, /^Refusing to publish/);
				assert.match(err.message, /entry "james\/hexbridge" has confidentiality "internal"/);
				assert.doesNotMatch(err.message, /the default when none is declared/);
				assert.match(err.message, /library "team-shelf" has visibility "shared"/);
				// Both spellings, for the same reason the collision guard gives both:
				// the reader may be on either surface, and Pi's command takes no
				// arguments, so the message must not tell them to "pass" anything.
				assert.match(err.message, /allow_confidentiality_mismatch/);
				assert.match(err.message, /allowConfidentialityMismatch/);
				assert.doesNotMatch(err.message, /Pass an explicit/);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("a confidentiality refusal writes nothing to a fresh library", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ visibility: "public" });
	try {
		await assert.rejects(
			() => publishEntry(libraryRoot, "# spec\n", sampleInput({ confidentiality: "internal" })),
			ConfidentialityMismatchError,
		);
		// No entries tree, no index, no staging leftovers: only the marker.
		assert.deepEqual(await readdir(libraryRoot), [LIBRARY_MARKER_FILE]);
	} finally {
		await cleanup();
	}
});

test("a confidentiality refusal leaves an existing entry untouched", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ visibility: "shared" });
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput({ confidentiality: "shared" }));
		await assert.rejects(
			() => publishEntry(libraryRoot, "# v2\n", sampleInput({ confidentiality: "internal", headline: "Reclassified." })),
			ConfidentialityMismatchError,
		);
		const entryDir = join(libraryRoot, ENTRIES_DIR, "james", "hexbridge");
		assert.deepEqual((await readdir(entryDir)).sort(), [LATEST_POINTER_FILE, "v1"]);
		const entry = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
		assert.equal(entry.metadata.confidentiality, "shared");
		assert.equal(entry.metadata.headline, sampleInput().headline);
	} finally {
		await cleanup();
	}
});

test("the confidentiality guard also covers the metadata-only path", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ visibility: "public" });
	try {
		const spec = "# identical bytes\n";
		await publishEntry(libraryRoot, spec, sampleInput({ confidentiality: "public" }));
		// Identical bytes would otherwise take the in-place metadata branch and
		// quietly stamp an internal classification onto a public library's entry.
		await assert.rejects(
			() => publishEntry(libraryRoot, spec, sampleInput({ confidentiality: "internal" })),
			ConfidentialityMismatchError,
		);
		const entry = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
		assert.equal(entry.metadata.confidentiality, "public");
	} finally {
		await cleanup();
	}
});

test("allowConfidentialityMismatch publishes the entry anyway", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ visibility: "public" });
	try {
		const result = await publishEntry(
			libraryRoot,
			"# spec\n",
			sampleInput({ confidentiality: "internal" }),
			{ allowConfidentialityMismatch: true },
		);
		assert.equal(result.version, 1);
		// The override permits the placement; it does not reclassify the entry.
		const entry = await readEntry(libraryRoot, { slug: "hexbridge", namespace: "james" });
		assert.equal(entry.metadata.confidentiality, "internal");
	} finally {
		await cleanup();
	}
});

test("forceNewVersion does not bypass the confidentiality guard", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ visibility: "public" });
	try {
		await assert.rejects(
			() => publishEntry(libraryRoot, "# spec\n", sampleInput({ confidentiality: "internal" }), { forceNewVersion: true }),
			ConfidentialityMismatchError,
		);
	} finally {
		await cleanup();
	}
});

test("the two publish overrides are independent of each other", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ visibility: "public" });
	try {
		await publishEntry(libraryRoot, "# v1\n", sampleInput({
			confidentiality: "public",
			source_repo: "https://github.com/oldorg/hexbridge",
		}));
		const moved = sampleInput({ confidentiality: "internal", source_repo: "https://github.com/neworg/hexbridge" });

		// Allowing the repo change still trips the confidentiality guard...
		await assert.rejects(
			() => publishEntry(libraryRoot, "# v2\n", moved, { allowSourceRepoChange: true }),
			ConfidentialityMismatchError,
		);
		// ...and allowing the mismatch still trips the collision guard.
		await assert.rejects(
			() => publishEntry(libraryRoot, "# v2\n", moved, { allowConfidentialityMismatch: true }),
			(err) => {
				assert.ok(!(err instanceof ConfidentialityMismatchError));
				assert.match(err.message, /source_repo/);
				return true;
			},
		);
		const result = await publishEntry(libraryRoot, "# v2\n", moved, {
			allowSourceRepoChange: true,
			allowConfidentialityMismatch: true,
		});
		assert.equal(result.version, 2);
	} finally {
		await cleanup();
	}
});

// ─── Provenance conflicts (#148) ───────────────────────────────────────────

// Reproduce the shape a slug collision left behind before the guard existed:
// two projects whose source_repo shares a trailing path segment, published
// into one entry. allowSourceRepoChange is the only way to write that today,
// and it produces exactly the on-disk state of the original bug — v1's
// metadata names one repository, v2's names another, the index names v2's.
async function publishCollidedWhisper(libraryRoot, overrides = {}) {
	await publishEntry(libraryRoot, "# openai whisper\n", sampleInput({
		slug: "whisper",
		source_repo: "https://github.com/openai/whisper",
		...overrides,
	}));
	await publishEntry(libraryRoot, "# acme whisper\n", sampleInput({
		slug: "whisper",
		source_repo: "https://github.com/acme/whisper",
		...overrides,
	}), { allowSourceRepoChange: true });
}

test("reindex reports an entry whose versions disagree about source_repo", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishCollidedWhisper(libraryRoot);
		await publishEntry(libraryRoot, "# healthy\n", sampleInput({ slug: "healthy" }));

		const idx = await reindex(libraryRoot);
		assert.deepEqual(idx.provenance_conflicts, [{
			slug: "whisper",
			namespace: "james",
			latest_version: 2,
			source_repo: "https://github.com/acme/whisper",
			disagreeing_versions: [{ version: 1, source_repo: "https://github.com/openai/whisper" }],
		}]);

		// The index is exactly what it was before: the entry is still listed,
		// still attributed to the newest version, and the report never lands
		// in either derived file — their shapes are ABI.
		const whisper = idx.entries.find((e) => e.slug === "whisper");
		assert.deepEqual(whisper.versions, [1, 2]);
		assert.equal(whisper.source_repo, "https://github.com/acme/whisper");
		assert.equal(idx.entry_count, 2);
		const indexYaml = await readFile(join(libraryRoot, LIBRARY_INDEX_FILE), "utf8");
		assert.doesNotMatch(indexYaml, /provenance_conflicts|disagreeing/);
		const indexMd = await readFile(join(libraryRoot, LIBRARY_INDEX_MD_FILE), "utf8");
		assert.doesNotMatch(indexMd, /conflict/i);
	} finally {
		await cleanup();
	}
});

test("every disagreeing version is reported, in a single-tenant library too", async () => {
	const { libraryRoot, cleanup } = await makeLibrary({ namespaced: false });
	try {
		const openai = { slug: "whisper", namespace: undefined, source_repo: "https://github.com/openai/whisper" };
		await publishEntry(libraryRoot, "# v1\n", sampleInput(openai));
		await publishEntry(libraryRoot, "# v2\n", sampleInput(openai));
		await publishEntry(libraryRoot, "# v3\n", sampleInput({ ...openai, source_repo: "https://github.com/acme/whisper" }), {
			allowSourceRepoChange: true,
		});

		const idx = await reindex(libraryRoot);
		assert.deepEqual(idx.provenance_conflicts, [{
			slug: "whisper",
			latest_version: 3,
			source_repo: "https://github.com/acme/whisper",
			disagreeing_versions: [
				{ version: 1, source_repo: "https://github.com/openai/whisper" },
				{ version: 2, source_repo: "https://github.com/openai/whisper" },
			],
		}]);
		assert.equal("namespace" in idx.provenance_conflicts[0], false);
	} finally {
		await cleanup();
	}
});

test("reindex reports no conflict when one repository is spelled two ways", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		// No override needed: the publish guard already accepts these as the
		// same repository, and the report must agree with it.
		await publishEntry(libraryRoot, "# v1\n", sampleInput({ source_repo: "https://github.com/myorg/hexbridge.git" }));
		await publishEntry(libraryRoot, "# v2\n", sampleInput({ source_repo: "git@github.com:MyOrg/HexBridge" }));

		const idx = await reindex(libraryRoot);
		assert.deepEqual(idx.entries.map((e) => e.versions), [[1, 2]]);
		assert.deepEqual(idx.provenance_conflicts, []);
	} finally {
		await cleanup();
	}
});

test("a version with missing or unreadable metadata is skipped, and reindex still succeeds", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		const openai = { slug: "whisper", source_repo: "https://github.com/openai/whisper" };
		await publishEntry(libraryRoot, "# v1\n", sampleInput(openai));
		await publishEntry(libraryRoot, "# v2\n", sampleInput(openai));
		await publishEntry(libraryRoot, "# v3\n", sampleInput(openai));
		await publishEntry(libraryRoot, "# v4\n", sampleInput({ ...openai, source_repo: "https://github.com/acme/whisper" }), {
			allowSourceRepoChange: true,
		});
		const entryDir = join(libraryRoot, ENTRIES_DIR, "james", "whisper");
		await writeFile(join(entryDir, "v1", METADATA_FILE), ":::not valid yaml:::\n", "utf8");
		await rm(join(entryDir, "v2", METADATA_FILE));

		// Neither the corrupt v1 nor the metadata-less v2 is reported or fatal;
		// v3 still is, because it can be read and it disagrees.
		const idx = await reindex(libraryRoot);
		assert.equal(idx.entries.length, 1);
		assert.deepEqual(idx.entries[0].versions, [1, 2, 3, 4]);
		assert.deepEqual(idx.provenance_conflicts[0].disagreeing_versions, [
			{ version: 3, source_repo: "https://github.com/openai/whisper" },
		]);
	} finally {
		await cleanup();
	}
});

test("an entry whose newest metadata is unreadable is not checked — there is nothing to compare against", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishCollidedWhisper(libraryRoot);
		await writeFile(join(libraryRoot, ENTRIES_DIR, "james", "whisper", "v2", METADATA_FILE), ":::not valid yaml:::\n", "utf8");

		// buildIndexEntry already drops the entry; the direct check reaches the
		// same answer for the same reason.
		const idx = await reindex(libraryRoot);
		assert.deepEqual(idx.entries, []);
		assert.deepEqual(idx.provenance_conflicts, []);
		assert.deepEqual(await detectProvenanceConflicts(libraryRoot, [{ slug: "whisper", namespace: "james" }]), []);
	} finally {
		await cleanup();
	}
});

test("detectProvenanceConflicts is read-only and works from index entries", async () => {
	const { libraryRoot, cleanup } = await makeLibrary();
	try {
		await publishCollidedWhisper(libraryRoot);
		await publishEntry(libraryRoot, "# healthy\n", sampleInput({ slug: "healthy" }));
		const entries = await listEntries(libraryRoot);
		await rm(join(libraryRoot, LIBRARY_INDEX_FILE));
		await rm(join(libraryRoot, LIBRARY_INDEX_MD_FILE));

		const conflicts = await detectProvenanceConflicts(libraryRoot, entries);
		assert.deepEqual(conflicts.map((c) => c.slug), ["whisper"]);
		// Only the entries handed in are checked — the list tool passes its
		// filtered set — and nothing was regenerated along the way.
		assert.deepEqual(await detectProvenanceConflicts(libraryRoot, entries.filter((e) => e.slug === "healthy")), []);
		await assert.rejects(readFile(join(libraryRoot, LIBRARY_INDEX_FILE), "utf8"), { code: "ENOENT" });
		await assert.rejects(readFile(join(libraryRoot, LIBRARY_INDEX_MD_FILE), "utf8"), { code: "ENOENT" });
	} finally {
		await cleanup();
	}
});

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
