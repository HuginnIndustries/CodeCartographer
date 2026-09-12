// CodeCartographer library: on-disk store for reimplementation-spec
// artifacts produced by analysis runs. Versioned, optionally namespaced,
// detectable via a marker file at the library root.
//
// The schemas in this module match the public read-side contract in
// docs/library-format.md. Treat that document as authoritative — any
// breaking change here must also update the spec and bump the marker
// `schema_version`.
//
// Design notes:
//  - The `latest` pointer is always a regular file (containing the
//    version directory name as a single line), never a symlink. This
//    is deterministic across platforms and avoids the elevation
//    requirement for symlink creation on Windows.
//  - publishEntry is content-hash idempotent: re-publishing the same
//    spec bytes does not create a new version. Metadata-only changes
//    (headline, tags, capabilities) update the existing latest
//    metadata.yaml in place; the version's recorded provenance is
//    carried forward unless the publish supplies its own.
//  - reindex regenerates index.yaml and INDEX.md from filesystem state.
//    Treat both as derived artifacts; never hand-edit. Resolution
//    recipe for git merge conflicts is documented in
//    docs/library-format.md.
//  - reindex also reports, on its return value and never in the index
//    files, entries whose versions disagree about source_repo — the shape
//    a slug collision left behind before publish refused cross-project
//    appends. Repair is manual; see the "Provenance conflicts" section.
//  - Git operations (`commitPublish`, `resolvePublishSourceRepo`) shell out
//    to the `git` binary. Failures are non-fatal — the caller decides how to
//    surface them, and the resolver falls back to the directory itself.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { acquireLock } from "./status.ts";
import { atomicWriteFile, canonicalPath, isPlainObject, normalizeForComparison, pathExists, uniqueTempSuffix } from "./utils.ts";
import { parseSimpleYaml, stringifySimpleYaml } from "./yaml.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

export const LIBRARY_MARKER_FILE = ".codecarto-library";
/** Transient lock taken for the duration of one publish (see publishEntry). */
const PUBLISH_LOCK_FILE = ".publish.lock";
export const LIBRARY_INDEX_FILE = "index.yaml";
export const LIBRARY_INDEX_MD_FILE = "INDEX.md";
export const ENTRIES_DIR = "entries";
export const SPEC_FILE = "reimplementation-spec.md";
export const METADATA_FILE = "metadata.yaml";
export const LATEST_POINTER_FILE = "latest";
export const MARKER_SCHEMA_VERSION = 1;
export const INDEX_SCHEMA_VERSION = 1;

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_SLUGS = new Set<string>(["latest", "index", "entries"]);
const VERSION_DIR_RE = /^v(\d+)$/;

// ─── Types (mirror docs/library-format.md) ──────────────────────────────────

export type LibraryVisibility = "internal" | "shared" | "public";

export interface LibraryMarker {
	schema_version: number;
	name: string;
	visibility?: LibraryVisibility;
	created_at?: string;
	namespaced: boolean;
}

export type GenerationSurface = "pi-extension" | "mcp-server" | "drop-in";
export type GenerationReasoning = "high" | "medium" | "low" | "default" | "unknown";

export interface EntryGeneration {
	surface: GenerationSurface;
	agent: string;
	agent_version: string;
	model: string;
	model_vendor: string;
	reasoning: GenerationReasoning;
	notes: string;
}

export interface EntryProvenance {
	prior_version: number | null;
	mutation_source: string | null;
}

export interface ScopeTierCounts {
	p0?: number;
	p1?: number;
	p2?: number;
}

export interface EntryMetadata {
	slug: string;
	namespace?: string;
	version: number;
	source_repo: string;
	source_commit?: string;
	source_branch?: string;
	source_dirty?: boolean;
	analyzed_at: string;
	pipeline: string;
	codecarto_version: string;
	headline: string;
	tags: string[];
	capabilities: string[];
	scope_tier_counts?: ScopeTierCounts;
	confidentiality?: LibraryVisibility;
	generation: EntryGeneration;
	provenance?: EntryProvenance;
}

export interface LibraryIndexEntry {
	slug: string;
	namespace?: string;
	latest_version: number;
	versions: number[];
	source_repo: string;
	headline: string;
	tags: string[];
	capabilities: string[];
	confidentiality?: LibraryVisibility;
	last_analyzed_at: string;
	last_codecarto_version: string;
}

export interface LibraryIndex {
	schema_version: number;
	library_name: string;
	generated_at: string;
	entry_count: number;
	namespaces: string[];
	entries: LibraryIndexEntry[];
}

/** One older version whose recorded source_repo names a different repository than the newest version's. */
export interface ProvenanceConflictVersion {
	version: number;
	source_repo: string;
}

/** An entry whose version history spans more than one repository. */
export interface ProvenanceConflict {
	slug: string;
	namespace?: string;
	/** The newest version — the one whose metadata the index reports for the whole entry. */
	latest_version: number;
	/** The source_repo recorded on the newest version, i.e. what index.yaml advertises. */
	source_repo: string;
	/** Older versions that disagree with it, ascending. Versions with missing or unreadable metadata are skipped. */
	disagreeing_versions: ProvenanceConflictVersion[];
}

/**
 * What `reindex` returns: the index it wrote, plus findings that ride on the
 * return value only. `provenance_conflicts` is never serialized into
 * index.yaml or INDEX.md — both shapes are ABI (docs/library-format.md).
 */
export interface ReindexResult extends LibraryIndex {
	provenance_conflicts: ProvenanceConflict[];
}

// ─── Marker / discovery ─────────────────────────────────────────────────────

export async function discoverLibrary(libraryPath: string): Promise<LibraryMarker | null> {
	const markerPath = join(libraryPath, LIBRARY_MARKER_FILE);
	if (!(await pathExists(markerPath))) return null;
	return readMarker(libraryPath);
}

export async function readMarker(libraryRoot: string): Promise<LibraryMarker | null> {
	const markerPath = join(libraryRoot, LIBRARY_MARKER_FILE);
	if (!(await pathExists(markerPath))) return null;
	try {
		const raw = await readFile(markerPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isPlainObject(parsed)) return null;
		return normalizeMarker(parsed);
	} catch {
		return null;
	}
}

export async function writeMarker(libraryRoot: string, marker: LibraryMarker): Promise<void> {
	await mkdir(libraryRoot, { recursive: true });
	const markerPath = join(libraryRoot, LIBRARY_MARKER_FILE);
	const normalized = normalizeMarker(marker);
	await atomicWriteFile(markerPath, `${JSON.stringify(normalized, null, 2)}\n`);
}

function normalizeMarker(raw: Record<string, unknown> | LibraryMarker): LibraryMarker {
	const r = raw as Record<string, unknown>;
	const schemaVersion = typeof r.schema_version === "number" ? r.schema_version : MARKER_SCHEMA_VERSION;
	const name = typeof r.name === "string" && r.name.trim() !== "" ? r.name.trim() : "codecarto-library";
	const namespaced = typeof r.namespaced === "boolean" ? r.namespaced : false;
	const out: LibraryMarker = { schema_version: schemaVersion, name, namespaced };
	if (typeof r.visibility === "string" && isVisibility(r.visibility)) out.visibility = r.visibility;
	if (typeof r.created_at === "string") out.created_at = r.created_at;
	return out;
}

function isVisibility(v: string): v is LibraryVisibility {
	return v === "internal" || v === "shared" || v === "public";
}

/**
 * The level a marker's `visibility` or an entry's `confidentiality` is taken
 * to have when it declares none. It is the default `initLibrary` writes and
 * the default docs/library-format.md gives the entry field.
 */
export const DEFAULT_VISIBILITY: LibraryVisibility = "internal";

// Ordered from most to least restricted. An entry may sit in a library at or
// below its own level; one above it would expose the entry to everyone the
// library reaches.
const VISIBILITY_RANK: Record<LibraryVisibility, number> = { internal: 0, shared: 1, public: 2 };

// ─── Library initialization ────────────────────────────────────────────────

export interface InitLibraryOptions {
	/** Library name (defaults to basename of the path). */
	name?: string;
	/** Visibility level. Default "internal". */
	visibility?: LibraryVisibility;
	/** Whether this is a namespaced (shared) library. Default false. */
	namespaced?: boolean;
}

export interface InitLibraryResult {
	libraryPath: string;
	marker: LibraryMarker;
	/** True if the marker already existed (idempotent re-run). */
	alreadyExisted: boolean;
}

/**
 * Initialize a CodeCartographer library at the given path: create the
 * directory if needed, write the `.codecarto-library` marker if missing,
 * and return the marker. Idempotent — re-running on an existing library
 * is safe and preserves the existing marker.
 */
export async function initLibrary(libraryPath: string, options: InitLibraryOptions = {}): Promise<InitLibraryResult> {
	const existing = await discoverLibrary(libraryPath);
	if (existing) {
		return { libraryPath, marker: existing, alreadyExisted: true };
	}

	const name = options.name?.trim() || basename(libraryPath);
	const marker: LibraryMarker = {
		schema_version: MARKER_SCHEMA_VERSION,
		name,
		namespaced: options.namespaced ?? false,
		visibility: options.visibility ?? DEFAULT_VISIBILITY,
		created_at: new Date().toISOString(),
	};

	await writeMarker(libraryPath, marker);
	return { libraryPath, marker, alreadyExisted: false };
}

// ─── Slug helpers ───────────────────────────────────────────────────────────

export function isValidSlug(slug: string): boolean {
	if (typeof slug !== "string") return false;
	if (RESERVED_SLUGS.has(slug)) return false;
	return SLUG_RE.test(slug);
}

/**
 * Derive a slug from a source repo URL or path. The last meaningful path
 * component is lowercased and non-`[a-z0-9-]` characters are coerced to `-`.
 * Caller is responsible for collision handling — derived slugs may already
 * exist in the library and the calling UX (Pi or MCP) is the right place
 * to ask the user about it.
 *
 * A clone's remote URL and its checkout directory derive the same slug
 * (`…/whisper.git`, `git@host:acme/whisper`, and `/path/whisper` all give
 * `whisper`), which is what lets the Pi command switch from recording the
 * directory to recording the remote without renaming anyone's entry.
 */
export function deriveSlug(sourceRepo: string): string {
	let cleaned = sourceRepo.replace(/\.git$/i, "").replace(/\\/g, "/");
	// SCP shorthand for a repository at the root of a host (`git@host:whisper`)
	// has no slash at all, so the colon is the only separator to split on. Any
	// form with a slash already yields the right trailing segment below.
	if (!cleaned.includes("/")) cleaned = cleaned.replace(/^[^:]*:/, "");
	const parts = cleaned.split("/").filter((p) => p.length > 0);
	const last = parts[parts.length - 1] ?? "entry";
	const slug = last
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 64);
	const safe = slug.length === 0 || !/^[a-z]/.test(slug) ? `entry-${slug}`.slice(0, 64) : slug;
	return RESERVED_SLUGS.has(safe) ? `${safe}-entry` : safe;
}

/**
 * Reduce a repo reference to a comparable form so that spellings of the same
 * repository do not read as different projects. Handles scheme, `git@host:path`
 * SCP syntax, a `www.` host prefix, a trailing `.git`, repeated and trailing
 * slashes, backslash separators, and case.
 *
 * This is deliberately conservative: it only collapses spellings that are
 * unambiguously the same target. Anything it cannot prove equivalent stays
 * distinct, because the caller treats "different" as a hard error. Case is the
 * one place that cuts the other way — see the note above the return.
 */
export function normalizeSourceRepo(sourceRepo: string): string {
	let s = sourceRepo.trim().replace(/\\/g, "/");

	// Order matters here. The scheme comes off first so that the SCP branch
	// below sees only genuine `host:path` syntax, and the userinfo strip runs
	// before either interpretation of a colon. Getting this order wrong makes
	// `ssh://git@host/acme/tool` and `https://host/acme/tool` read as two
	// different repositories, which would refuse a legitimate re-publish.
	const hadScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s);
	s = s.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");

	// git@, user:token@, oauth2:x-oauth-basic@ ...
	s = s.replace(/^[^/@]+@/, "");

	// SCP syntax (git@github.com:acme/tool) only ever appears without a scheme,
	// where the colon separates host from path rather than naming a port. The
	// dot requirement keeps a Windows drive letter (C:/repos/tool) out of this
	// branch.
	if (!hadScheme) s = s.replace(/^([^:/]+\.[^:/]+):(.+)$/, "$1/$2");

	// A default port for the transports in play is not a distinguishing part of
	// the address. Any other port is left alone, since two services on one host
	// may genuinely differ by port.
	s = s.replace(/^([^/]+):(?:22|80|443)(?=\/|$)/, "$1");

	s = s.replace(/^www\./i, "");
	s = s.replace(/\.git$/i, "");

	// Repeated separators name the same location. A leading `//` is the one
	// exception: on Windows that is a UNC share (\\server\share), which is not
	// the same place as /server/share.
	s = s.startsWith("//") ? `/${s.replace(/\/{2,}/g, "/")}` : s.replace(/\/{2,}/g, "/");
	s = s.replace(/\/+$/, "");

	// Case folding is only safe where the target is case-insensitive. Hosts are,
	// as are the repository paths the major forges serve over them, and so are
	// Windows drive paths. A POSIX absolute path is not: /srv/Repos/tool and
	// /srv/repos/tool are two directories on Linux, and folding them together
	// would hide exactly the cross-project collision this comparison exists to
	// catch. Pi records the analyzed directory as source_repo whenever it has
	// no git remote to record instead, and every entry Pi published before it
	// resolved remotes holds one, so local paths are a common case here rather
	// than a curiosity.
	return isCaseSensitivePath(s) ? s : s.toLowerCase();
}

/** An absolute POSIX path (or a `~` home reference), where case is significant. */
function isCaseSensitivePath(s: string): boolean {
	return s.startsWith("/") || s === "~" || s.startsWith("~/");
}

/** True when two repo references denote the same repository. */
export function sameSourceRepo(a: string, b: string): boolean {
	return normalizeSourceRepo(a) === normalizeSourceRepo(b);
}

/**
 * The `source_repo` recorded on one version of an entry, or null when it
 * cannot be determined (no metadata, unreadable, or malformed). Null means
 * "unknown", and callers treat unknown as permission to proceed rather than
 * as a mismatch — the publish guard lets the publish through, and conflict
 * detection skips the version.
 */
async function readRecordedSourceRepo(
	libraryRoot: string,
	namespace: string | undefined,
	slug: string,
	version: number,
): Promise<string | null> {
	const metaPath = join(versionDir(libraryRoot, namespace, slug, version), METADATA_FILE);
	if (!(await pathExists(metaPath))) return null;
	try {
		const raw = parseSimpleYaml(await readFile(metaPath, "utf8"));
		if (!isPlainObject(raw)) return null;
		const recorded = raw.source_repo;
		return typeof recorded === "string" && recorded.trim() !== "" ? recorded : null;
	} catch {
		return null;
	}
}

/**
 * The `provenance` block recorded on one version of an entry, or undefined
 * when there is none to carry forward (no metadata, unreadable, malformed,
 * or a version that never had the block — a hand-built entry, say). The
 * metadata-only publish branch uses this so an identical re-publish, which
 * neither surface sends `provenance` with, rewrites `metadata.yaml` without
 * dropping what the version's original publish recorded.
 */
async function readRecordedProvenance(
	libraryRoot: string,
	namespace: string | undefined,
	slug: string,
	version: number,
): Promise<EntryProvenance | undefined> {
	const metaPath = join(versionDir(libraryRoot, namespace, slug, version), METADATA_FILE);
	if (!(await pathExists(metaPath))) return undefined;
	try {
		const raw = parseSimpleYaml(await readFile(metaPath, "utf8"));
		return normalizeMetadata(raw, { slug, namespace, version }).provenance;
	} catch {
		return undefined;
	}
}

// ─── Path helpers ───────────────────────────────────────────────────────────

function entryRoot(libraryRoot: string, namespace: string | undefined, slug: string): string {
	return namespace ? join(libraryRoot, ENTRIES_DIR, namespace, slug) : join(libraryRoot, ENTRIES_DIR, slug);
}

function versionDir(libraryRoot: string, namespace: string | undefined, slug: string, version: number): string {
	return join(entryRoot(libraryRoot, namespace, slug), `v${version}`);
}

async function listVersionDirs(entryDir: string): Promise<number[]> {
	if (!(await pathExists(entryDir))) return [];
	const entries = await readdir(entryDir, { withFileTypes: true });
	const versions: number[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const m = VERSION_DIR_RE.exec(e.name);
		if (m) versions.push(Number.parseInt(m[1]!, 10));
	}
	return versions.sort((a, b) => a - b);
}

async function writeLatestPointer(entryDir: string, versionDirName: string): Promise<void> {
	const latestPath = join(entryDir, LATEST_POINTER_FILE);
	await atomicWriteFile(latestPath, `${versionDirName}\n`);
}

async function readLatestPointer(entryDir: string): Promise<string | null> {
	const latestPath = join(entryDir, LATEST_POINTER_FILE);
	if (!(await pathExists(latestPath))) return null;
	try {
		const raw = await readFile(latestPath, "utf8");
		const trimmed = raw.trim();
		return trimmed === "" ? null : trimmed;
	} catch {
		return null;
	}
}

// ─── Publish ────────────────────────────────────────────────────────────────

export interface PublishInput {
	slug: string;
	namespace?: string;
	source_repo: string;
	source_commit?: string;
	source_branch?: string;
	source_dirty?: boolean;
	analyzed_at: string;
	pipeline: string;
	codecarto_version: string;
	headline: string;
	tags: string[];
	capabilities: string[];
	scope_tier_counts?: ScopeTierCounts;
	confidentiality?: LibraryVisibility;
	generation: EntryGeneration;
	provenance?: EntryProvenance;
}

export interface PublishOptions {
	/** Force a new version even if content matches the latest. */
	forceNewVersion?: boolean;
	/** Skip the regen of index.yaml + INDEX.md (caller will batch). */
	skipReindex?: boolean;
	/**
	 * Permit publishing when the target entry's recorded `source_repo` differs
	 * from the incoming one. Off by default: a mismatch usually means two
	 * different projects derived the same slug, and continuing would append
	 * one project's spec to the other's version history. Set this only when
	 * the repository genuinely moved (rename, org transfer, host change).
	 */
	allowSourceRepoChange?: boolean;
	/**
	 * Permit publishing when the entry's `confidentiality` is more restricted
	 * than the library's `visibility` — an `internal` entry into a `shared` or
	 * `public` library, a `shared` entry into a `public` one. Off by default:
	 * that direction exposes the spec to everyone the library reaches. Set
	 * this only when the exposure is intended. It does not change the
	 * confidentiality recorded on the entry.
	 */
	allowConfidentialityMismatch?: boolean;
}

export interface PublishResult {
	slug: string;
	namespace?: string;
	version: number;
	isNewVersion: boolean;
	entryDir: string;
	versionDir: string;
}

/**
 * Thrown by `publishEntry` when the entry is more restricted than the library
 * it is headed for. Nothing has been written when this is raised. It carries
 * the two compared levels so a wrapper with a user to ask (Pi) can pose the
 * question from the values rather than by matching the message.
 */
export class ConfidentialityMismatchError extends Error {
	readonly entryConfidentiality: LibraryVisibility;
	readonly libraryVisibility: LibraryVisibility;

	constructor(message: string, entryConfidentiality: LibraryVisibility, libraryVisibility: LibraryVisibility) {
		super(message);
		this.name = "ConfidentialityMismatchError";
		this.entryConfidentiality = entryConfidentiality;
		this.libraryVisibility = libraryVisibility;
	}
}

/**
 * Thrown by `publishEntry` when the target entry's newest version records a
 * `source_repo` that denotes a different repository than the incoming one.
 * Nothing has been written when this is raised. It carries both values so a
 * wrapper with a user to ask (Pi) can pose "did the repository move?" from
 * the values rather than by matching the message.
 */
export class SourceRepoMismatchError extends Error {
	/** The `source_repo` the entry's newest version records. */
	readonly recorded: string;
	/** The `source_repo` this publish carries. */
	readonly incoming: string;

	constructor(message: string, recorded: string, incoming: string) {
		super(message);
		this.name = "SourceRepoMismatchError";
		this.recorded = recorded;
		this.incoming = incoming;
	}
}

/** What `publishEntry` would do to an entry's version history, without doing it. */
export interface PublishVersionPreview {
	/** Highest version directory present, or 0 for a new entry. */
	latestVersion: number;
	/** The version the publish would write or update. */
	version: number;
	/** True when a new version directory would be created; false for a metadata-only update. */
	isNewVersion: boolean;
}

/**
 * Read-only preview of the version a publish would land on. This is the same
 * content-hash decision `publishEntry` makes (it calls this), so a wrapper
 * that has to describe a publish before performing it — the MCP server's
 * `publish_confirm` refusal — shows what would actually happen. Neither the
 * collision nor the confidentiality guard is evaluated here; those still run
 * on the real publish.
 */
export async function previewPublishVersion(
	libraryRoot: string,
	spec: string,
	ref: { slug: string; namespace?: string },
	opts: Pick<PublishOptions, "forceNewVersion"> = {},
): Promise<PublishVersionPreview> {
	const entryDir = entryRoot(libraryRoot, ref.namespace, ref.slug);
	const existingVersions = await listVersionDirs(entryDir);
	const latestVersion = existingVersions.length === 0 ? 0 : existingVersions[existingVersions.length - 1]!;
	if (latestVersion > 0 && !opts.forceNewVersion) {
		const latestSpecPath = join(versionDir(libraryRoot, ref.namespace, ref.slug, latestVersion), SPEC_FILE);
		if (await pathExists(latestSpecPath)) {
			const existingSpec = await readFile(latestSpecPath, "utf8");
			if (sha256(existingSpec) === sha256(spec)) {
				return { latestVersion, version: latestVersion, isNewVersion: false };
			}
		}
	}
	return { latestVersion, version: latestVersion + 1, isNewVersion: true };
}

export async function publishEntry(
	libraryRoot: string,
	spec: string,
	input: PublishInput,
	opts: PublishOptions = {},
): Promise<PublishResult> {
	const marker = await readMarker(libraryRoot);
	if (!marker) {
		throw new Error(`Not a CodeCartographer library: ${LIBRARY_MARKER_FILE} missing at ${libraryRoot}`);
	}
	if (!isValidSlug(input.slug)) {
		throw new Error(`Invalid slug: "${input.slug}" (must match ${SLUG_RE.source}, not in ${[...RESERVED_SLUGS].join(",")})`);
	}
	if (marker.namespaced && (!input.namespace || input.namespace.trim() === "")) {
		throw new Error(`Library is namespaced — input.namespace is required`);
	}
	if (!marker.namespaced && input.namespace) {
		throw new Error(`Library is not namespaced — input.namespace must be omitted (got "${input.namespace}")`);
	}
	if (input.namespace !== undefined && !isValidSlug(input.namespace)) {
		throw new Error(`Invalid namespace: "${input.namespace}" (same rules as slug)`);
	}

	const namespace = input.namespace;
	const entryDir = entryRoot(libraryRoot, namespace, input.slug);

	// One publisher at a time. Version assignment reads the entry directory
	// and then creates v<N+1>; two publishes of one slug in the same window
	// both picked the same N, so the loser died on a raw rename error and the
	// winner's latest pointer could be overwritten (#240). The lock lives in
	// the library root, which exists before any entry does, so a refused
	// publish still writes nothing.
	const lock = await acquireLock(join(libraryRoot, PUBLISH_LOCK_FILE));
	try {
		const preview = await previewPublishVersion(libraryRoot, spec, { slug: input.slug, namespace }, opts);
		const latestVersion = preview.latestVersion;

		// Collision guard. Slugs derive from the trailing path segment of the source
		// repo, so two unrelated projects (acme/whisper and openai/whisper) collapse
		// onto one slug. Without this check the second publish would append its spec
		// to the first project's version history, and the index would then report the
		// newcomer's source_repo as though it owned every prior version. Checked
		// before the idempotence branch below, because a metadata-only update would
		// overwrite the wrong entry just as silently.
		if (latestVersion > 0 && !opts.allowSourceRepoChange) {
			const recorded = await readRecordedSourceRepo(libraryRoot, namespace, input.slug, latestVersion);
			if (recorded !== null && !sameSourceRepo(recorded, input.source_repo)) {
				const label = namespace ? `${namespace}/${input.slug}` : input.slug;
				throw new SourceRepoMismatchError(
					`Refusing to publish: entry "${label}" v${latestVersion} records source_repo ` +
						`"${recorded}", but this publish carries "${input.source_repo}". Publishing would ` +
						`append this spec to a different project's version history. Publish this project ` +
						`under a distinct slug to shelve it separately, or — if the repository itself ` +
						`moved (rename, org transfer, host change) — re-publish with the source-repo ` +
						`change allowed: allow_source_repo_change on codecarto_publish, ` +
						`allowSourceRepoChange in PublishOptions.`,
					recorded,
					input.source_repo,
				);
			}
		}

		// Confidentiality guard. Levels are ordered internal < shared < public. An
		// entry may sit in a library at or below its own level, but one more
		// restricted than its library would be exposed to everyone the library
		// reaches: an internal spec in a public library is a leak. Either side that
		// declares nothing counts as internal — the marker default initLibrary
		// writes, and the entry default docs/library-format.md documents — so a
		// library with no visibility field accepts everything it did before. Like
		// the collision guard this runs ahead of the idempotence branch, so a
		// metadata-only update cannot reclassify an entry past it, and it fails
		// before anything is written.
		const entryConfidentiality = input.confidentiality ?? DEFAULT_VISIBILITY;
		const libraryVisibility = marker.visibility ?? DEFAULT_VISIBILITY;
		if (!opts.allowConfidentialityMismatch && VISIBILITY_RANK[entryConfidentiality] < VISIBILITY_RANK[libraryVisibility]) {
			const label = namespace ? `${namespace}/${input.slug}` : input.slug;
			const declared = input.confidentiality ? "" : " (the default when none is declared)";
			throw new ConfidentialityMismatchError(
				`Refusing to publish: entry "${label}" has confidentiality "${entryConfidentiality}"${declared}, ` +
					`but library "${marker.name}" has visibility "${libraryVisibility}". Publishing would expose a ` +
					`spec classified "${entryConfidentiality}" to everyone the "${libraryVisibility}" library reaches. ` +
					`Publish it to a library whose visibility is "${entryConfidentiality}" or narrower, declare a ` +
					`confidentiality of "${libraryVisibility}" or wider if the spec may travel that far, or — if ` +
					`this exposure is intended — re-publish with the mismatch allowed: ` +
					`allow_confidentiality_mismatch on codecarto_publish, allowConfidentialityMismatch in PublishOptions.`,
				entryConfidentiality,
				libraryVisibility,
			);
		}

		// Content-hash idempotence: if the latest version's spec matches bytes-for-bytes
		// (decided by previewPublishVersion above), update metadata in place and
		// return without bumping the version.
		if (!preview.isNewVersion) {
			const latestVersionDir = versionDir(libraryRoot, namespace, input.slug, latestVersion);
			// buildMetadata writes provenance only when the input carries it, and
			// neither surface sends it on publish — so without this the rewrite
			// would drop the block the version's original publish recorded.
			const provenance = input.provenance ?? (await readRecordedProvenance(libraryRoot, namespace, input.slug, latestVersion));
			const metadata = buildMetadata({ ...input, provenance }, latestVersion);
			await atomicWriteYaml(join(latestVersionDir, METADATA_FILE), metadata);
			if (!opts.skipReindex) await reindex(libraryRoot);
			return {
				slug: input.slug,
				namespace,
				version: latestVersion,
				isNewVersion: false,
				entryDir,
				versionDir: latestVersionDir,
			};
		}

		const nextVersion = preview.version;
		const finalVersionDir = versionDir(libraryRoot, namespace, input.slug, nextVersion);
		const stagingDir = `${entryDir}.publish.${uniqueTempSuffix()}`;

		// Stage all files under a sibling directory, then atomically rename it
		// into place as v<N>. If the rename fails partway, the staging dir is
		// left for the user to inspect or remove.
		await mkdir(stagingDir, { recursive: true });
		try {
			const metadata = buildMetadata({ ...input, provenance: input.provenance ?? { prior_version: latestVersion === 0 ? null : latestVersion, mutation_source: null } }, nextVersion);
			await writeFile(join(stagingDir, SPEC_FILE), spec, "utf8");
			await atomicWriteYaml(join(stagingDir, METADATA_FILE), metadata);
			await mkdir(entryDir, { recursive: true });
			await rename(stagingDir, finalVersionDir);
		} catch (err) {
			// Best-effort cleanup of the staging directory.
			try {
				await rm(stagingDir, { recursive: true, force: true });
			} catch {
				// swallow — leave the staging dir for diagnostics
			}
			throw err;
		}

		await writeLatestPointer(entryDir, `v${nextVersion}`);
		if (!opts.skipReindex) await reindex(libraryRoot);

		return {
			slug: input.slug,
			namespace,
			version: nextVersion,
			isNewVersion: true,
			entryDir,
			versionDir: finalVersionDir,
		};
	} finally {
		await lock.release();
	}
}

function buildMetadata(input: PublishInput & { version?: number }, version: number): EntryMetadata {
	const out: EntryMetadata = {
		slug: input.slug,
		version,
		source_repo: input.source_repo,
		analyzed_at: input.analyzed_at,
		pipeline: input.pipeline,
		codecarto_version: input.codecarto_version,
		headline: input.headline,
		tags: [...input.tags],
		capabilities: [...input.capabilities],
		generation: { ...input.generation },
	};
	if (input.namespace) out.namespace = input.namespace;
	if (input.source_commit) out.source_commit = input.source_commit;
	if (input.source_branch) out.source_branch = input.source_branch;
	if (typeof input.source_dirty === "boolean") out.source_dirty = input.source_dirty;
	if (input.scope_tier_counts) out.scope_tier_counts = { ...input.scope_tier_counts };
	if (input.confidentiality) out.confidentiality = input.confidentiality;
	if (input.provenance) out.provenance = { ...input.provenance };
	return out;
}

// ─── Read / list ────────────────────────────────────────────────────────────

export interface EntryRef {
	slug: string;
	namespace?: string;
	/** If omitted, resolves to latest. */
	version?: number;
}

export interface EntryReadResult {
	metadata: EntryMetadata;
	spec: string;
	versionDir: string;
}

export async function readEntry(libraryRoot: string, ref: EntryRef): Promise<EntryReadResult> {
	const marker = await readMarker(libraryRoot);
	if (!marker) {
		throw new Error(`Not a CodeCartographer library: ${LIBRARY_MARKER_FILE} missing at ${libraryRoot}`);
	}
	const entryDir = entryRoot(libraryRoot, ref.namespace, ref.slug);
	if (!(await pathExists(entryDir))) {
		throw new Error(`Entry not found: ${describeRef(ref)}`);
	}

	let version = ref.version;
	if (version === undefined) {
		const pointed = await readLatestPointer(entryDir);
		if (pointed && VERSION_DIR_RE.test(pointed)) {
			version = Number.parseInt(VERSION_DIR_RE.exec(pointed)![1]!, 10);
		} else {
			const versions = await listVersionDirs(entryDir);
			if (versions.length === 0) {
				throw new Error(`No versions for ${describeRef(ref)}`);
			}
			version = versions[versions.length - 1]!;
		}
	}

	const vDir = versionDir(libraryRoot, ref.namespace, ref.slug, version);
	const specPath = join(vDir, SPEC_FILE);
	const metaPath = join(vDir, METADATA_FILE);
	if (!(await pathExists(specPath)) || !(await pathExists(metaPath))) {
		throw new Error(`Incomplete entry: ${describeRef({ ...ref, version })}`);
	}
	const spec = await readFile(specPath, "utf8");
	const rawMeta = parseSimpleYaml(await readFile(metaPath, "utf8"));
	const metadata = normalizeMetadata(rawMeta, { slug: ref.slug, namespace: ref.namespace, version });
	return { metadata, spec, versionDir: vDir };
}

function describeRef(ref: EntryRef): string {
	const nsPart = ref.namespace ? `${ref.namespace}/` : "";
	const verPart = ref.version === undefined ? "latest" : `v${ref.version}`;
	return `${nsPart}${ref.slug}@${verPart}`;
}

function normalizeMetadata(raw: unknown, fallback: { slug: string; namespace?: string; version: number }): EntryMetadata {
	if (!isPlainObject(raw)) {
		throw new Error(`Malformed metadata for ${fallback.slug}`);
	}
	const r = raw;
	// A real metadata.yaml must have at least one of these string fields. If
	// not even one is present, the parsed object is structurally degenerate
	// (e.g. `:::not valid yaml:::` parses to `{"": "..."}`) and we should
	// reject rather than silently producing an empty-fields entry.
	const requiredOneOf = ["slug", "source_repo", "headline", "pipeline"] as const;
	const hasAny = requiredOneOf.some((key) => typeof r[key] === "string" && (r[key] as string).trim() !== "");
	if (!hasAny) {
		throw new Error(`Malformed metadata for ${fallback.slug}: no recognizable fields`);
	}
	const generation = normalizeGeneration(r.generation);
	const out: EntryMetadata = {
		slug: typeof r.slug === "string" ? r.slug : fallback.slug,
		version: typeof r.version === "number" ? r.version : fallback.version,
		source_repo: typeof r.source_repo === "string" ? r.source_repo : "",
		analyzed_at: typeof r.analyzed_at === "string" ? r.analyzed_at : "",
		pipeline: typeof r.pipeline === "string" ? r.pipeline : "",
		codecarto_version: typeof r.codecarto_version === "string" ? r.codecarto_version : "0.0.0",
		headline: typeof r.headline === "string" ? r.headline : "",
		tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === "string") as string[] : [],
		capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((c) => typeof c === "string") as string[] : [],
		generation,
	};
	if (typeof r.namespace === "string") out.namespace = r.namespace;
	else if (fallback.namespace) out.namespace = fallback.namespace;
	if (typeof r.source_commit === "string") out.source_commit = r.source_commit;
	if (typeof r.source_branch === "string") out.source_branch = r.source_branch;
	if (typeof r.source_dirty === "boolean") out.source_dirty = r.source_dirty;
	if (isPlainObject(r.scope_tier_counts)) {
		const stc = r.scope_tier_counts;
		const counts: ScopeTierCounts = {};
		if (typeof stc.p0 === "number") counts.p0 = stc.p0;
		if (typeof stc.p1 === "number") counts.p1 = stc.p1;
		if (typeof stc.p2 === "number") counts.p2 = stc.p2;
		out.scope_tier_counts = counts;
	}
	if (typeof r.confidentiality === "string" && isVisibility(r.confidentiality)) {
		out.confidentiality = r.confidentiality;
	}
	if (isPlainObject(r.provenance)) {
		const p = r.provenance;
		out.provenance = {
			prior_version: typeof p.prior_version === "number" ? p.prior_version : null,
			mutation_source: typeof p.mutation_source === "string" ? p.mutation_source : null,
		};
	}
	return out;
}

function normalizeGeneration(raw: unknown): EntryGeneration {
	const defaults: EntryGeneration = {
		surface: "drop-in",
		agent: "unknown",
		agent_version: "unknown",
		model: "unknown",
		model_vendor: "unknown",
		reasoning: "unknown",
		notes: "",
	};
	if (!isPlainObject(raw)) return defaults;
	const r = raw;
	const surface = isGenerationSurface(r.surface) ? r.surface : defaults.surface;
	const reasoning = isReasoning(r.reasoning) ? r.reasoning : defaults.reasoning;
	return {
		surface,
		agent: typeof r.agent === "string" ? r.agent : defaults.agent,
		agent_version: typeof r.agent_version === "string" ? r.agent_version : defaults.agent_version,
		model: typeof r.model === "string" ? r.model : defaults.model,
		model_vendor: typeof r.model_vendor === "string" ? r.model_vendor : defaults.model_vendor,
		reasoning,
		notes: typeof r.notes === "string" ? r.notes : defaults.notes,
	};
}

function isGenerationSurface(v: unknown): v is GenerationSurface {
	return v === "pi-extension" || v === "mcp-server" || v === "drop-in";
}

function isReasoning(v: unknown): v is GenerationReasoning {
	return v === "high" || v === "medium" || v === "low" || v === "default" || v === "unknown";
}

export interface ListEntriesFilter {
	namespace?: string;
	tag?: string;
	slug?: string;
	source_repo?: string;
}

export async function listEntries(
	libraryRoot: string,
	filter: ListEntriesFilter = {},
): Promise<LibraryIndexEntry[]> {
	const marker = await readMarker(libraryRoot);
	if (!marker) return [];

	// Prefer the index if it's present; fall back to a fresh reindex if not.
	const indexPath = join(libraryRoot, LIBRARY_INDEX_FILE);
	let index: LibraryIndex;
	if (await pathExists(indexPath)) {
		try {
			const raw = await readFile(indexPath, "utf8");
			index = normalizeIndex(parseSimpleYaml(raw), marker);
		} catch {
			index = await reindex(libraryRoot);
		}
	} else {
		index = await reindex(libraryRoot);
	}

	return index.entries.filter((e) => {
		if (filter.namespace !== undefined && e.namespace !== filter.namespace) return false;
		if (filter.slug !== undefined && e.slug !== filter.slug) return false;
		// Same equivalence the publish guard applies: `.git`, scheme, userinfo,
		// default port, and forge-host case do not make two references two
		// repositories, so they must not make a filter miss one either (#257).
		if (filter.source_repo !== undefined && !sameSourceRepo(e.source_repo, filter.source_repo)) return false;
		if (filter.tag !== undefined && !e.tags.includes(filter.tag)) return false;
		return true;
	});
}

// ─── Reindex ────────────────────────────────────────────────────────────────

export async function reindex(libraryRoot: string): Promise<ReindexResult> {
	const marker = await readMarker(libraryRoot);
	if (!marker) {
		throw new Error(`Not a CodeCartographer library: ${LIBRARY_MARKER_FILE} missing at ${libraryRoot}`);
	}

	const entries: LibraryIndexEntry[] = [];
	const namespacesSeen = new Set<string>();
	const entriesRoot = join(libraryRoot, ENTRIES_DIR);

	if (await pathExists(entriesRoot)) {
		if (marker.namespaced) {
			const namespaceDirs = await readdir(entriesRoot, { withFileTypes: true });
			for (const nsEntry of namespaceDirs) {
				if (!nsEntry.isDirectory()) continue;
				if (!isValidSlug(nsEntry.name)) continue;
				namespacesSeen.add(nsEntry.name);
				const nsDir = join(entriesRoot, nsEntry.name);
				const slugDirs = await readdir(nsDir, { withFileTypes: true });
				for (const slugEntry of slugDirs) {
					if (!slugEntry.isDirectory()) continue;
					if (!isValidSlug(slugEntry.name)) continue;
					const built = await buildIndexEntry(libraryRoot, nsEntry.name, slugEntry.name);
					if (built) entries.push(built);
				}
			}
		} else {
			const slugDirs = await readdir(entriesRoot, { withFileTypes: true });
			for (const slugEntry of slugDirs) {
				if (!slugEntry.isDirectory()) continue;
				if (!isValidSlug(slugEntry.name)) continue;
				const built = await buildIndexEntry(libraryRoot, undefined, slugEntry.name);
				if (built) entries.push(built);
			}
		}
	}

	entries.sort((a, b) => {
		const nsA = a.namespace ?? "";
		const nsB = b.namespace ?? "";
		if (nsA !== nsB) return nsA < nsB ? -1 : 1;
		return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
	});

	const index: LibraryIndex = {
		schema_version: INDEX_SCHEMA_VERSION,
		library_name: marker.name,
		generated_at: new Date().toISOString(),
		entry_count: entries.length,
		namespaces: [...namespacesSeen].sort(),
		entries,
	};

	await atomicWriteYaml(join(libraryRoot, LIBRARY_INDEX_FILE), index);
	await writeIndexMarkdown(libraryRoot, index, marker);

	// Reported, not written. The index files above are ABI, so the conflict
	// list travels on the return value only (see ReindexResult).
	const provenance_conflicts = await detectProvenanceConflicts(libraryRoot, entries);
	return { ...index, provenance_conflicts };
}

async function buildIndexEntry(
	libraryRoot: string,
	namespace: string | undefined,
	slug: string,
): Promise<LibraryIndexEntry | null> {
	const entryDir = entryRoot(libraryRoot, namespace, slug);
	const versions = await listVersionDirs(entryDir);
	if (versions.length === 0) return null;
	const latest = versions[versions.length - 1]!;
	const latestMetaPath = join(entryDir, `v${latest}`, METADATA_FILE);
	if (!(await pathExists(latestMetaPath))) return null;
	let metadata: EntryMetadata;
	try {
		const rawMeta = parseSimpleYaml(await readFile(latestMetaPath, "utf8"));
		metadata = normalizeMetadata(rawMeta, { slug, namespace, version: latest });
	} catch {
		return null;
	}
	const entry: LibraryIndexEntry = {
		slug,
		latest_version: latest,
		versions: [...versions],
		source_repo: metadata.source_repo,
		headline: metadata.headline,
		tags: [...metadata.tags],
		capabilities: [...metadata.capabilities],
		last_analyzed_at: metadata.analyzed_at,
		last_codecarto_version: metadata.codecarto_version,
	};
	if (namespace) entry.namespace = namespace;
	if (metadata.confidentiality) entry.confidentiality = metadata.confidentiality;
	return entry;
}

function normalizeIndex(raw: unknown, marker: LibraryMarker): LibraryIndex {
	const fallback: LibraryIndex = {
		schema_version: INDEX_SCHEMA_VERSION,
		library_name: marker.name,
		generated_at: new Date().toISOString(),
		entry_count: 0,
		namespaces: [],
		entries: [],
	};
	if (!isPlainObject(raw)) return fallback;
	const r = raw;
	const entries: LibraryIndexEntry[] = Array.isArray(r.entries) ? r.entries.filter(isPlainObject).map((e) => normalizeIndexEntry(e)) : [];
	return {
		schema_version: typeof r.schema_version === "number" ? r.schema_version : INDEX_SCHEMA_VERSION,
		library_name: typeof r.library_name === "string" ? r.library_name : marker.name,
		generated_at: typeof r.generated_at === "string" ? r.generated_at : fallback.generated_at,
		entry_count: typeof r.entry_count === "number" ? r.entry_count : entries.length,
		namespaces: Array.isArray(r.namespaces) ? r.namespaces.filter((n) => typeof n === "string") as string[] : [],
		entries,
	};
}

function normalizeIndexEntry(raw: Record<string, unknown>): LibraryIndexEntry {
	const entry: LibraryIndexEntry = {
		slug: typeof raw.slug === "string" ? raw.slug : "",
		latest_version: typeof raw.latest_version === "number" ? raw.latest_version : 1,
		versions: Array.isArray(raw.versions) ? raw.versions.filter((v) => typeof v === "number") as number[] : [],
		source_repo: typeof raw.source_repo === "string" ? raw.source_repo : "",
		headline: typeof raw.headline === "string" ? raw.headline : "",
		tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") as string[] : [],
		capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((c) => typeof c === "string") as string[] : [],
		last_analyzed_at: typeof raw.last_analyzed_at === "string" ? raw.last_analyzed_at : "",
		last_codecarto_version: typeof raw.last_codecarto_version === "string" ? raw.last_codecarto_version : "0.0.0",
	};
	if (typeof raw.namespace === "string") entry.namespace = raw.namespace;
	if (typeof raw.confidentiality === "string" && isVisibility(raw.confidentiality)) entry.confidentiality = raw.confidentiality;
	return entry;
}

async function writeIndexMarkdown(libraryRoot: string, index: LibraryIndex, marker: LibraryMarker): Promise<void> {
	const lines: string[] = [];
	lines.push(`# ${escapeMd(marker.name)} — Library Index`);
	lines.push("");
	lines.push(`_Generated ${index.generated_at}. Do not edit by hand — regenerate with \`codecarto library-reindex\`._`);
	lines.push("");
	// A single-tenant library has no namespaces but is still one namespace's
	// worth of entries; count once so the noun agrees with the number shown.
	const namespaceCount = index.namespaces.length || 1;
	lines.push(`**${index.entry_count} ${index.entry_count === 1 ? "entry" : "entries"}** across ${namespaceCount} ${namespaceCount === 1 ? "namespace" : "namespaces"}.`);
	lines.push("");

	if (marker.namespaced) {
		const grouped = new Map<string, LibraryIndexEntry[]>();
		for (const e of index.entries) {
			const ns = e.namespace ?? "(unnamespaced)";
			const bucket = grouped.get(ns) ?? [];
			bucket.push(e);
			grouped.set(ns, bucket);
		}
		const namespaces = [...grouped.keys()].sort();
		for (const ns of namespaces) {
			const bucket = grouped.get(ns)!;
			lines.push(`## ${escapeMd(ns)} (${bucket.length} ${bucket.length === 1 ? "entry" : "entries"})`);
			lines.push("");
			lines.push("| Slug | Latest | Headline | Tags |");
			lines.push("|---|---|---|---|");
			for (const e of bucket) {
				lines.push(formatIndexRow(e, marker.namespaced));
			}
			lines.push("");
		}
	} else {
		lines.push("| Slug | Latest | Headline | Tags |");
		lines.push("|---|---|---|---|");
		for (const e of index.entries) {
			lines.push(formatIndexRow(e, marker.namespaced));
		}
		lines.push("");
	}

	const content = lines.join("\n");
	await atomicWriteFile(join(libraryRoot, LIBRARY_INDEX_MD_FILE), content);
}

function formatIndexRow(e: LibraryIndexEntry, namespaced: boolean): string {
	// Link to the newest version directory, not `latest/`: the pointer is a
	// one-line regular file (see the module header), so a `latest/` link has
	// nothing to land on when the library is browsed on a forge.
	const entryPath = namespaced && e.namespace ? `${ENTRIES_DIR}/${e.namespace}/${e.slug}` : `${ENTRIES_DIR}/${e.slug}`;
	const pathPart = `${entryPath}/v${e.latest_version}/`;
	const slugLink = `[${escapeMd(e.slug)}](${pathPart})`;
	const headline = escapeMd(e.headline).replace(/\n+/g, " ");
	const tags = e.tags.length === 0 ? "" : e.tags.map(escapeMd).join(", ");
	return `| ${slugLink} | v${e.latest_version} | ${headline} | ${tags} |`;
}

function escapeMd(value: string): string {
	// Backslashes first: escaping only the pipe lets an input ending in `\`
	// turn the emitted `\|` into a literal-backslash-plus-cell-delimiter and
	// break out of the table cell (code scanning alert #3).
	return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// ─── Provenance conflicts ───────────────────────────────────────────────────
//
// Before publish refused cross-project appends (#123), two projects whose
// source_repo shared a trailing path segment derived the same slug, and the
// second publish landed as the next version of the first project's entry.
// Nothing rewrites those entries after the fact: the index reads only the
// newest version's metadata, so it advertises every version under whichever
// project published last, and a synthesis run reading the entry gets one
// project's spec history presented as another's (#148). Detection reads every
// version and reports the disagreement. Repair is deliberately manual —
// splitting an entry means inventing a slug, renumbering versions and
// repointing `latest`, all of which are paths docs/library-format.md calls
// ABI — so nothing here renames, renumbers, or moves anything.

/**
 * Read-only check over the given entries: does every version of each entry
 * record the same repository as its newest version? Comparison goes through
 * `sameSourceRepo`, so spellings of one repository (scheme, `.git`, SCP
 * syntax, casing where safe) do not count as disagreement. A version whose
 * metadata is missing, unreadable, or lacks `source_repo` is skipped rather
 * than reported — the stance the publish guard takes — and an entry whose
 * newest version is unreadable is skipped entirely, since there is nothing to
 * compare against. Never writes.
 *
 * A repository that genuinely moved and was re-published with
 * `allowSourceRepoChange` leaves the same on-disk shape as a collision and is
 * reported the same way; the history alone cannot tell the two apart.
 */
export async function detectProvenanceConflicts(
	libraryRoot: string,
	entries: ReadonlyArray<Pick<LibraryIndexEntry, "slug" | "namespace">>,
): Promise<ProvenanceConflict[]> {
	const conflicts: ProvenanceConflict[] = [];
	for (const entry of entries) {
		const conflict = await findProvenanceConflict(libraryRoot, entry.namespace, entry.slug);
		if (conflict) conflicts.push(conflict);
	}
	return conflicts;
}

async function findProvenanceConflict(
	libraryRoot: string,
	namespace: string | undefined,
	slug: string,
): Promise<ProvenanceConflict | null> {
	const versions = await listVersionDirs(entryRoot(libraryRoot, namespace, slug));
	if (versions.length < 2) return null;
	const latest = versions[versions.length - 1]!;
	const latestRepo = await readRecordedSourceRepo(libraryRoot, namespace, slug, latest);
	if (latestRepo === null) return null;

	const disagreeing: ProvenanceConflictVersion[] = [];
	for (const version of versions.slice(0, -1)) {
		const recorded = await readRecordedSourceRepo(libraryRoot, namespace, slug, version);
		if (recorded === null) continue;
		if (!sameSourceRepo(recorded, latestRepo)) disagreeing.push({ version, source_repo: recorded });
	}
	if (disagreeing.length === 0) return null;

	const conflict: ProvenanceConflict = {
		slug,
		latest_version: latest,
		source_repo: latestRepo,
		disagreeing_versions: disagreeing,
	};
	if (namespace) conflict.namespace = namespace;
	return conflict;
}

// ─── Atomic YAML write ──────────────────────────────────────────────────────

async function atomicWriteYaml(path: string, value: unknown): Promise<void> {
	await atomicWriteFile(path, `${stringifySimpleYaml(value)}\n`);
}

// ─── Hash ───────────────────────────────────────────────────────────────────

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

// ─── Git ────────────────────────────────────────────────────────────────────

/** What a Pi publish records as `source_repo`, and where the value came from. */
export interface ResolvedSourceRepo {
	/** The value to record: a remote's fetch URL verbatim, or the directory itself. */
	source_repo: string;
	/**
	 * The git remote the URL was read from (`origin`, or the current branch's
	 * upstream remote), or null when the directory was recorded instead — it
	 * is not a git work tree, is a subdirectory of one, or has no usable
	 * remote.
	 */
	remote: string | null;
}

/**
 * Resolve the repository reference a publish from `cwd` should record. The
 * remote is preferred over the path because a path means nothing outside the
 * machine that published it, and because a slug derived from the remote is
 * stable across clones of one repository, which is what lets the collision
 * guard compare something meaningful (#147).
 *
 * Resolution order: `origin`'s fetch URL, else the fetch URL of the remote
 * the current branch tracks, else `cwd`. The remote is consulted only when
 * `cwd` is the root of its work tree. A subdirectory keeps recording its
 * path: every subdirectory of one repository would otherwise resolve to the
 * same URL and the same slug, and the second one published would land as a
 * new version of the first with no guard able to tell — exactly the
 * cross-project append the guard exists to refuse.
 *
 * The URL is stored as git reports it. Spellings of one repository are
 * reconciled at comparison time by `sameSourceRepo`, not here, so the
 * recorded value stays human-readable. Never throws: a missing `git` binary
 * or any git failure falls back to the path.
 */
export async function resolvePublishSourceRepo(cwd: string): Promise<ResolvedSourceRepo> {
	const asPath: ResolvedSourceRepo = { source_repo: cwd, remote: null };
	try {
		const toplevel = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
		if (!toplevel.ok || toplevel.stdout.trim() === "") return asPath;
		const [canonicalCwd, canonicalTop] = await Promise.all([canonicalPath(cwd), canonicalPath(toplevel.stdout.trim())]);
		if (normalizeForComparison(canonicalCwd) !== normalizeForComparison(canonicalTop)) return asPath;

		const origin = await runGit(cwd, ["remote", "get-url", "origin"]);
		if (origin.ok && origin.stdout.trim() !== "") return { source_repo: origin.stdout.trim(), remote: "origin" };

		const branch = await runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
		if (!branch.ok || branch.stdout.trim() === "") return asPath;
		const upstream = await runGit(cwd, ["config", "--get", `branch.${branch.stdout.trim()}.remote`]);
		const remote = upstream.stdout.trim();
		// `.` marks a branch tracking another local branch; there is no URL behind it.
		if (!upstream.ok || remote === "" || remote === ".") return asPath;
		const url = await runGit(cwd, ["remote", "get-url", remote]);
		if (url.ok && url.stdout.trim() !== "") return { source_repo: url.stdout.trim(), remote };
		return asPath;
	} catch {
		return asPath;
	}
}

export interface CommitOptions {
	addAll?: boolean;
}

export interface CommitResult {
	ok: boolean;
	skipped?: "not-a-git-repo" | "nothing-to-commit" | "git-missing" | "error";
	message?: string;
}

/**
 * Optional convenience: stage and commit publish output. Never pushes.
 * On any failure, returns `{ ok: false, skipped: <reason> }` rather than
 * throwing — the publish itself has already succeeded, and the caller
 * decides whether to surface the commit failure to the user.
 */
export async function commitPublish(
	libraryRoot: string,
	message: string,
	opts: CommitOptions = {},
): Promise<CommitResult> {
	const cwd = resolve(libraryRoot);

	if (!(await pathExists(join(cwd, ".git")))) {
		return { ok: false, skipped: "not-a-git-repo" };
	}

	try {
		if (opts.addAll !== false) {
			const add = await runGit(cwd, ["add", "--", "."]);
			if (!add.ok) return { ok: false, skipped: "error", message: add.stderr };
		}
		const status = await runGit(cwd, ["status", "--porcelain"]);
		if (!status.ok) return { ok: false, skipped: "error", message: status.stderr };
		if (status.stdout.trim() === "") {
			return { ok: false, skipped: "nothing-to-commit" };
		}
		const commit = await runGit(cwd, ["commit", "-m", message]);
		if (!commit.ok) return { ok: false, skipped: "error", message: commit.stderr };
		return { ok: true };
	} catch {
		return { ok: false, skipped: "git-missing" };
	}
}

interface GitRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
	return new Promise<GitRunResult>((resolvePromise) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString("utf8");
		});
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString("utf8");
		});
		child.on("error", () => resolvePromise({ ok: false, stdout, stderr }));
		child.on("close", (code) => resolvePromise({ ok: code === 0, stdout, stderr }));
	});
}
