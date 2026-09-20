// Snapshot collection semantics for the v1 engineering contract (E03, #401).
//
// E01 defined what a snapshot *is* and recomputes its digest; this module
// defines how one is built from a working tree and how two are compared.
// Everything here is a function of its arguments: no file is read, no command
// runs, no host is consulted. The host walks the tree and hands us what it
// saw; we normalize, exclude, order, and judge coverage.
//
// The rule that shapes the whole module: identity must not silently overstate
// what was observed. A path the collector could not read is recorded as an
// uncovered relevant input, never dropped; a tree that moved during capture is
// `unstable`; a manifest that omits a relevant file must not produce the same
// digest as one that includes it. Where we cannot be sure, we say so and the
// gate blocks — E03 owns the collection semantics, E06 owns what to do about
// them.

import { compareUtf8, computeSnapshotDigest } from "./digest.ts";
import { isRepoRelativePath } from "./ids.ts";
import { isSecretFile } from "../secrets.ts";
import type { Collector, CoverageExclusion, ExclusionReason, ManifestEntry, RepoRelativePath, SnapshotRole, VcsKind } from "./types.ts";

/**
 * What the host observed at one path. `unreadable` is not an error the
 * collector may swallow: it becomes an uncovered relevant input, because a
 * file we could not read is precisely the one whose change we would miss.
 */
export type ObservedEntry =
	| { path: string; type: "file"; digest: string; executable: boolean; size: number }
	| { path: string; type: "symlink"; target: string }
	| { path: string; type: "unreadable"; reason: string };

/** What the host hands the collector for one capture. */
export interface CollectionInput {
	entries: ObservedEntry[];
	repository: { vcs: VcsKind; head?: string; dirty: boolean };
	/** Host-declared exclusions beyond the built-in ones, e.g. a configured build directory. */
	excluded?: CoverageExclusion[];
	/**
	 * Paths the host knows are relevant but did not fingerprint — a file it
	 * skipped for size, a directory it could not traverse. Merged with the
	 * unreadable entries above.
	 */
	uncovered_relevant_inputs?: string[];
	/**
	 * Whether the tree was observed to change during capture (a mtime moved, a
	 * second pass disagreed). The host decides; we record it faithfully.
	 */
	moved_during_capture?: boolean;
}

export interface CollectionResult {
	manifest: ManifestEntry[];
	coverage: { excluded: CoverageExclusion[]; uncovered_relevant_inputs: RepoRelativePath[] };
	repository: { vcs: VcsKind; head?: string; dirty: boolean };
	stability: "stable" | "unstable";
	digest: string;
	/** Paths dropped by an exclusion, with the reason — for the presentation, not the digest. */
	dropped: { path: string; reason: ExclusionReason }[];
}

/**
 * Always excluded, with the reason the contract names:
 *
 * - the engineering namespace itself, because a snapshot that covered its own
 *   records would change every time one was written and never be re-derivable;
 * - generated evidence under it, same reason.
 *
 * The brief, plan, and selected references are *not* here: they live in
 * `attempt.inputs` and are digested separately, so a changed plan changes the
 * input digest rather than the tree digest.
 */
export const ALWAYS_EXCLUDED: readonly CoverageExclusion[] = [{ pattern: ".codecarto/engineering/**", reason: "engineering-namespace" }];

/**
 * A secret file is excluded from the manifest by path, and its *digest* is
 * never recorded — a digest of a credential file is still an oracle for it.
 * The path is disclosed as an exclusion so the reader knows something was
 * withheld; an undisclosed exclusion would let a changed secret file pass as
 * an unchanged tree.
 */
function secretExclusion(path: string): CoverageExclusion {
	return { pattern: path, reason: "secret" };
}

/** Whether a glob-ish scope pattern covers a path. Supports a trailing `**`, a `*` segment, and exact paths. */
export function patternCovers(pattern: string, path: string): boolean {
	if (pattern === path) return true;
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return path === prefix || path.startsWith(prefix + "/");
	}
	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -2);
		if (!path.startsWith(prefix + "/")) return false;
		return !path.slice(prefix.length + 1).includes("/");
	}
	if (pattern === "**") return true;
	return false;
}

/**
 * Normalize one host observation into a manifest entry, or explain why it
 * cannot be one. Returns `null` for an entry that is excluded rather than
 * rejected — the caller records the exclusion.
 */
function normalizeEntry(entry: ObservedEntry): { ok: true; entry: ManifestEntry } | { ok: false; reason: string } {
	if (!isRepoRelativePath(entry.path)) {
		return { ok: false, reason: `not a repository-relative POSIX path: ${JSON.stringify(entry.path)}` };
	}
	if (entry.type === "symlink") {
		if (typeof entry.target !== "string" || entry.target.length === 0) return { ok: false, reason: "symlink target is empty" };
		// The link text is recorded verbatim and never followed: a link that
		// escapes the repository is data about the tree, not a path to read.
		return { ok: true, entry: { path: entry.path, type: "symlink", target: entry.target } };
	}
	if (entry.type === "file") {
		if (!Number.isInteger(entry.size) || entry.size < 0) return { ok: false, reason: "size is not a non-negative integer" };
		if (typeof entry.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) return { ok: false, reason: "digest is not sha256:<64 hex>" };
		return { ok: true, entry: { path: entry.path, type: "file", digest: entry.digest, executable: entry.executable === true, size: entry.size } };
	}
	return { ok: false, reason: entry.reason || "unreadable" };
}

/**
 * Build a snapshot's identity from what the host observed.
 *
 * Exclusions are applied by pattern, secrets are excluded by name, unreadable
 * and host-declared gaps become `uncovered_relevant_inputs`, entries are sorted
 * strictly ascending in UTF-8 byte order, and duplicates are a hard error —
 * two entries for one path mean the collector cannot say what it saw.
 */
export function collectSnapshot(input: CollectionInput): { ok: true; value: CollectionResult } | { ok: false; errors: { path: string; message: string }[] } {
	const errors: { path: string; message: string }[] = [];
	const excluded: CoverageExclusion[] = [...ALWAYS_EXCLUDED, ...(input.excluded ?? [])];
	const uncovered = new Set<string>();
	const dropped: { path: string; reason: ExclusionReason }[] = [];
	const byPath = new Map<string, ManifestEntry>();

	for (const raw of input.uncovered_relevant_inputs ?? []) {
		if (!isRepoRelativePath(raw)) errors.push({ path: `/uncovered_relevant_inputs`, message: `not a repository-relative POSIX path: ${JSON.stringify(raw)}` });
		else uncovered.add(raw);
	}

	for (const entry of input.entries) {
		const path = entry.path;
		const hit = excluded.find((rule) => patternCovers(rule.pattern, path));
		if (hit) {
			dropped.push({ path, reason: hit.reason });
			continue;
		}
		if (isSecretFile(path)) {
			// Disclosed, never digested.
			if (!excluded.some((rule) => rule.pattern === path && rule.reason === "secret")) excluded.push(secretExclusion(path));
			dropped.push({ path, reason: "secret" });
			continue;
		}
		if (entry.type === "unreadable") {
			if (!isRepoRelativePath(path)) errors.push({ path: "/entries", message: `unreadable entry has an invalid path: ${JSON.stringify(path)}` });
			else uncovered.add(path);
			continue;
		}
		const normalized = normalizeEntry(entry);
		if (normalized.ok === false) {
			errors.push({ path: `/entries/${path}`, message: normalized.reason });
			continue;
		}
		if (byPath.has(path)) {
			errors.push({ path: `/entries/${path}`, message: "duplicate path: the collector reported one path twice" });
			continue;
		}
		byPath.set(path, normalized.entry);
	}

	if (errors.length > 0) return { ok: false, errors };

	const manifest = [...byPath.values()].sort((a, b) => compareUtf8(a.path, b.path));
	const coverage = {
		excluded: [...excluded].sort((a, b) => compareUtf8(a.pattern, b.pattern) || compareUtf8(a.reason, b.reason)),
		uncovered_relevant_inputs: [...uncovered].sort(compareUtf8) as RepoRelativePath[],
	};
	const repository = input.repository;
	const identity = { coverage, manifest, repository };
	return {
		ok: true,
		value: {
			manifest,
			coverage,
			repository,
			stability: input.moved_during_capture === true ? "unstable" : "stable",
			digest: computeSnapshotDigest(identity as never),
			dropped,
		},
	};
}

/**
 * Whether a snapshot may bind an acceptance, and why not when it may not.
 * This restates the contract's snapshot row in one callable place so the gate
 * (E06) cannot approximate it: a candidate must be a stable, adapter-attested,
 * non-agent-claimed capture with no uncovered relevant inputs.
 *
 * The uncovered-inputs rule is the load-bearing one. An uncovered relevant
 * input means the collector knows it did not look at something that matters —
 * so an unchanged digest cannot mean an unchanged tree, and evidence bound to
 * it must not be reused.
 */
export function candidateMayBindAcceptance(candidate: {
	role: SnapshotRole;
	stability: string;
	collector: Collector;
	attested_by: string;
	coverage: { uncovered_relevant_inputs: readonly string[] };
}): { ok: true } | { ok: false; reasons: string[] } {
	const reasons: string[] = [];
	if (candidate.role !== "candidate") reasons.push(`role is ${candidate.role}; only a candidate snapshot binds an acceptance`);
	if (candidate.stability !== "stable") reasons.push("the tree moved during capture; an unstable candidate cannot bind an acceptance");
	if (candidate.collector === "agent-claimed") reasons.push("collector is agent-claimed; an agent's account of the tree is not an observation of it");
	if (candidate.attested_by !== "adapter") reasons.push(`attested_by is ${candidate.attested_by}; only an adapter-captured candidate binds an acceptance`);
	const uncovered = candidate.coverage?.uncovered_relevant_inputs ?? [];
	if (uncovered.length > 0) {
		reasons.push(`${uncovered.length} relevant input(s) were not covered (${uncovered.slice(0, 3).join(", ")}${uncovered.length > 3 ? ", …" : ""}); an unchanged digest cannot mean an unchanged tree`);
	}
	return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** What changed between two captures, in terms a person can read. */
export interface SnapshotDiff {
	identical: boolean;
	added: string[];
	removed: string[];
	modified: string[];
	/** Same bytes, different mode — a file that became executable is a behaviour change. */
	mode_changed: string[];
	/** Same path, different kind (file became a symlink or vice versa). */
	type_changed: string[];
	/** Coverage moved: something excluded or uncovered that was not before, or the reverse. */
	coverage_changed: boolean;
}

/**
 * Compare two captures. Used to explain a freshness failure: E01's
 * `checkCandidateFreshness` answers *whether* the tree moved, this answers
 * *what* moved, without either replacing the other.
 *
 * Coverage is compared too, because a capture that silently started excluding
 * a path would otherwise look like a tree that lost a file.
 */
export function diffSnapshots(
	before: { manifest: readonly ManifestEntry[]; coverage: { excluded: readonly CoverageExclusion[]; uncovered_relevant_inputs: readonly string[] } },
	after: { manifest: readonly ManifestEntry[]; coverage: { excluded: readonly CoverageExclusion[]; uncovered_relevant_inputs: readonly string[] } },
): SnapshotDiff {
	const a = new Map(before.manifest.map((e) => [e.path, e]));
	const b = new Map(after.manifest.map((e) => [e.path, e]));
	const added: string[] = [];
	const removed: string[] = [];
	const modified: string[] = [];
	const mode_changed: string[] = [];
	const type_changed: string[] = [];

	for (const [path, entry] of b) {
		const prior = a.get(path);
		if (!prior) {
			added.push(path);
			continue;
		}
		if (prior.type !== entry.type) {
			type_changed.push(path);
			continue;
		}
		if (entry.type === "file" && prior.type === "file") {
			if (prior.digest !== entry.digest) modified.push(path);
			else if (prior.executable !== entry.executable) mode_changed.push(path);
		} else if (entry.type === "symlink" && prior.type === "symlink") {
			if (prior.target !== entry.target) modified.push(path);
		}
	}
	for (const path of a.keys()) if (!b.has(path)) removed.push(path);

	const key = (c: { excluded: readonly CoverageExclusion[]; uncovered_relevant_inputs: readonly string[] }) =>
		JSON.stringify([[...c.excluded].map((e) => [e.pattern, e.reason]).sort(), [...c.uncovered_relevant_inputs].sort()]);
	const coverage_changed = key(before.coverage) !== key(after.coverage);

	added.sort(compareUtf8);
	removed.sort(compareUtf8);
	modified.sort(compareUtf8);
	mode_changed.sort(compareUtf8);
	type_changed.sort(compareUtf8);

	return {
		identical: added.length === 0 && removed.length === 0 && modified.length === 0 && mode_changed.length === 0 && type_changed.length === 0 && !coverage_changed,
		added,
		removed,
		modified,
		mode_changed,
		type_changed,
		coverage_changed,
	};
}
