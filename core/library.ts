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
//    metadata.yaml in place.
//  - reindex regenerates index.yaml and INDEX.md from filesystem state.
//    Treat both as derived artifacts; never hand-edit. Resolution
//    recipe for git merge conflicts is documented in
//    docs/library-format.md.
//  - Git operations (`commitPublish`) shell out to the `git` binary.
//    Failures are non-fatal — the caller decides how to surface them.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isPlainObject, pathExists } from "./utils.ts";
import { parseSimpleYaml, stringifySimpleYaml } from "./yaml.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

export const LIBRARY_MARKER_FILE = ".codecarto-library";
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
	const tempPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
	await rename(tempPath, markerPath);
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
		visibility: options.visibility ?? "internal",
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
 */
export function deriveSlug(sourceRepo: string): string {
	const cleaned = sourceRepo.replace(/\.git$/i, "").replace(/\\/g, "/");
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
 * SCP syntax, a `www.` host prefix, a trailing `.git`, trailing slashes,
 * backslash separators, and case.
 *
 * This is deliberately conservative: it only collapses spellings that are
 * unambiguously the same target. Anything it cannot prove equivalent stays
 * distinct, because the caller treats "different" as a hard error.
 */
export function normalizeSourceRepo(sourceRepo: string): string {
	let s = sourceRepo.trim().replace(/\\/g, "/");
	// git@github.com:acme/tool -> github.com/acme/tool
	const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(s);
	if (scp) s = `${scp[1]}/${scp[2]}`;
	s = s.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
	s = s.replace(/^www\./i, "");
	s = s.replace(/\/+$/, "");
	s = s.replace(/\.git$/i, "");
	s = s.replace(/\/+$/, "");
	return s.toLowerCase();
}

/** True when two repo references denote the same repository. */
export function sameSourceRepo(a: string, b: string): boolean {
	return normalizeSourceRepo(a) === normalizeSourceRepo(b);
}

/**
 * The `source_repo` recorded on an entry's newest version, or null when it
 * cannot be determined (no metadata, unreadable, or malformed). Null means
 * "unknown", and callers treat unknown as permission to proceed rather than
 * as a mismatch.
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
	const tempPath = `${latestPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${versionDirName}\n`, "utf8");
	await rename(tempPath, latestPath);
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
}

export interface PublishResult {
	slug: string;
	namespace?: string;
	version: number;
	isNewVersion: boolean;
	entryDir: string;
	versionDir: string;
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
	const existingVersions = await listVersionDirs(entryDir);
	const latestVersion = existingVersions.length === 0 ? 0 : existingVersions[existingVersions.length - 1]!;
	const newSpecHash = sha256(spec);

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
			throw new Error(
				`Refusing to publish: entry "${label}" v${latestVersion} records source_repo ` +
					`"${recorded}", but this publish carries "${input.source_repo}". Publishing would ` +
					`append this spec to a different project's version history. Pass an explicit, ` +
					`distinct slug to shelve it separately, or set allowSourceRepoChange if the ` +
					`repository itself moved.`,
			);
		}
	}

	// Content-hash idempotence: if the latest version's spec matches bytes-for-bytes,
	// update metadata in place and return without bumping the version.
	if (latestVersion > 0 && !opts.forceNewVersion) {
		const latestVersionDir = versionDir(libraryRoot, namespace, input.slug, latestVersion);
		const latestSpecPath = join(latestVersionDir, SPEC_FILE);
		if (await pathExists(latestSpecPath)) {
			const existingSpec = await readFile(latestSpecPath, "utf8");
			if (sha256(existingSpec) === newSpecHash) {
				const metadata = buildMetadata(input, latestVersion);
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
		}
	}

	const nextVersion = latestVersion + 1;
	const finalVersionDir = versionDir(libraryRoot, namespace, input.slug, nextVersion);
	const stagingDir = `${entryDir}.publish.${process.pid}.${Date.now()}`;

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
		if (filter.source_repo !== undefined && e.source_repo !== filter.source_repo) return false;
		if (filter.tag !== undefined && !e.tags.includes(filter.tag)) return false;
		return true;
	});
}

// ─── Reindex ────────────────────────────────────────────────────────────────

export async function reindex(libraryRoot: string): Promise<LibraryIndex> {
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
	return index;
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
	lines.push(`**${index.entry_count} ${index.entry_count === 1 ? "entry" : "entries"}** across ${index.namespaces.length || 1} ${index.namespaces.length === 1 ? "namespace" : "namespaces"}.`);
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
	const path = join(libraryRoot, LIBRARY_INDEX_MD_FILE);
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, path);
}

function formatIndexRow(e: LibraryIndexEntry, namespaced: boolean): string {
	const pathPart = namespaced && e.namespace ? `${ENTRIES_DIR}/${e.namespace}/${e.slug}/latest/` : `${ENTRIES_DIR}/${e.slug}/latest/`;
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

// ─── Atomic YAML write ──────────────────────────────────────────────────────

async function atomicWriteYaml(path: string, value: unknown): Promise<void> {
	const serialized = `${stringifySimpleYaml(value)}\n`;
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, serialized, "utf8");
	await rename(tempPath, path);
}

// ─── Hash ───────────────────────────────────────────────────────────────────

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

// ─── Git ────────────────────────────────────────────────────────────────────

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
