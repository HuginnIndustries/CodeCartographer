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
import { EXCLUSION_REASONS } from "./types.ts";
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

/**
 * A string safe to use as an identity component. `compareUtf8` encodes to
 * UTF-8 before comparing, and that encoding maps every lone surrogate to
 * U+FFFD — so `"a\uD800"` and `"a\uFFFD"` compare EQUAL while canonicalizing
 * differently. A comparator that says two distinct strings are equal is not
 * a total order, and the manifest sort built on it stops being deterministic:
 * the same tree, enumerated in two orders, yields two digests. Refuse them.
 */
function isSortableIdentity(value: string): boolean {
	return !/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")) && !value.includes("\uFFFD");
}

/**
 * The pattern shapes this module can actually apply. Anything else is
 * refused at collection rather than recorded: an exclusion the matcher
 * silently never applies would disclose narrower coverage than the snapshot
 * really has, which is the one thing coverage exists to prevent.
 *
 * Supported: an exact path, `dir/**` (the directory and everything under
 * it), `dir/*` (one level), a `*.ext` basename suffix, `**​/*.ext` at any
 * depth, and `**` alone.
 */
export function isSupportedPattern(pattern: unknown): pattern is string {
	if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\0")) return false;
	// A pattern that is only whitespace cannot name anything; the path
	// grammar tolerates it, the matcher must not.
	if (pattern.trim() !== pattern || pattern.trim().length === 0) return false;
	if (!isSortableIdentity(pattern)) return false;
	// `**` excludes the entire tree, producing an empty manifest that is
	// identical for every repository. It has no legitimate use here.
	if (pattern === "**") return false;
	// A suffix pattern must actually have a suffix: `*.` and `**/*.` match a
	// trailing dot and nothing useful.
	if (pattern === "*." || pattern === "**/*.") return false;
	if (pattern.startsWith("**/*.")) return !pattern.slice(5).includes("/") && !pattern.slice(5).includes("*");
	if (pattern.startsWith("*.")) return !pattern.slice(2).includes("/") && !pattern.slice(2).includes("*");
	if (pattern.endsWith("/**")) return isRepoRelativePath(pattern.slice(0, -3));
	if (pattern.endsWith("/*")) return isRepoRelativePath(pattern.slice(0, -2));
	// An exact path, and only an exact path. A bare directory name would be
	// disclosed as an exclusion but match nothing inside it — coverage
	// narrower than reality, which is finding 4's defect in another shape.
	// A directory must say so: `dir/**` or `dir/*`. (`isRepoRelativePath`
	// already refuses any remaining `*`, so no extra guard is needed here —
	// adding one would be unreachable code that looks load-bearing.)
	return isRepoRelativePath(pattern);
}

/** Whether a supported scope pattern covers a path. Unsupported patterns never reach here. */
export function patternCovers(pattern: string, path: string): boolean {
	if (pattern === path) return true;
	// `**/*.log` and `*.log` must agree on what a `.log` basename is. Both
	// require a non-empty stem, so a file literally named `.log` is NOT
	// covered by either; disagreeing would make coverage depend on which
	// spelling the host happened to use.
	if (pattern.startsWith("**/*.")) {
		const base = path.slice(path.lastIndexOf("/") + 1);
		return base.endsWith(pattern.slice(4)) && base.length > pattern.length - 4;
	}
	if (pattern.startsWith("*.")) {
		const base = path.slice(path.lastIndexOf("/") + 1);
		return base.endsWith(pattern.slice(1)) && base.length > pattern.length - 1;
	}
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return path === prefix || path.startsWith(prefix + "/");
	}
	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -2);
		if (!path.startsWith(prefix + "/")) return false;
		return !path.slice(prefix.length + 1).includes("/");
	}
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
		// Coercing a non-boolean here would be a collision: a host that reports
		// `executable: 1` would produce the identity of a NON-executable file,
		// and a file that gains the executable bit is a behaviour change.
		if (typeof entry.executable !== "boolean") return { ok: false, reason: "executable is not a boolean" };
		return { ok: true, entry: { path: entry.path, type: "file", digest: entry.digest, executable: entry.executable, size: entry.size } };
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
	const uncovered = new Set<string>();
	const dropped: { path: string; reason: ExclusionReason }[] = [];
	const byPath = new Map<string, ManifestEntry>();
	const seenPath = new Set<string>();

	// The repository block is digested verbatim, so its shape is checked
	// rather than trusted: an unvalidated pass-through would let a caller put
	// arbitrary keys (or a non-boolean `dirty`) inside the identity.
	const repo = input.repository;
	if (repo === null || typeof repo !== "object" || Object.getPrototypeOf(repo) !== Object.prototype) {
		errors.push({ path: "/repository", message: "repository must be an object" });
	} else {
		const extra = Object.keys(repo).filter((k) => !["vcs", "head", "dirty"].includes(k));
		if (extra.length > 0) errors.push({ path: "/repository", message: `unknown field(s): ${extra.join(", ")}` });
		if (repo.vcs !== "git" && repo.vcs !== "none") errors.push({ path: "/repository/vcs", message: "vcs must be `git` or `none`" });
		if (typeof repo.dirty !== "boolean") errors.push({ path: "/repository/dirty", message: "dirty must be a boolean" });
		// `String(head)` would accept `["a".repeat(40)]`, which then reaches the
		// digest as an array: the shape must be checked, not stringified.
		if (repo.vcs === "git" && repo.head !== undefined && (typeof repo.head !== "string" || !/^[0-9a-f]{40}$/.test(repo.head))) {
			errors.push({ path: "/repository/head", message: "head must be a 40-character lowercase hex revision" });
		}
		if (repo.vcs === "none" && repo.head !== undefined) errors.push({ path: "/repository/head", message: "head is meaningless without a vcs" });
	}

	// Exclusions are validated before any are applied. An unsupported pattern
	// is refused, never recorded: a disclosure the matcher cannot honour would
	// claim narrower coverage than the snapshot actually has.
	const excluded: CoverageExclusion[] = [...ALWAYS_EXCLUDED];
	for (const rule of input.excluded ?? []) {
		if (rule === null || typeof rule !== "object") {
			errors.push({ path: "/excluded", message: "each exclusion must be an object" });
			continue;
		}
		if (!isSupportedPattern(rule.pattern)) {
			errors.push({ path: "/excluded", message: `unsupported exclusion pattern ${JSON.stringify(rule.pattern)}; it would be disclosed but never applied` });
			continue;
		}
		if (!EXCLUSION_REASONS.includes(rule.reason as never)) {
			errors.push({ path: "/excluded", message: `unknown exclusion reason ${JSON.stringify(rule.reason)}` });
			continue;
		}
		// Deduped by PATTERN, not by pattern+reason: one pattern has one
		// meaning. Keying on the pair would let a host re-declare a built-in
		// rule under another reason and get a second coverage entry — a
		// spurious second identity for an identical tree.
		const already = excluded.find((e) => e.pattern === rule.pattern);
		if (already) {
			if (already.reason !== rule.reason) {
				errors.push({ path: "/excluded", message: `pattern ${JSON.stringify(rule.pattern)} is declared twice with different reasons (${already.reason}, ${rule.reason}); one pattern has one meaning` });
			}
			continue;
		}
		excluded.push({ pattern: rule.pattern, reason: rule.reason });
	}

	for (const raw of input.uncovered_relevant_inputs ?? []) {
		if (!isRepoRelativePath(raw) || !isSortableIdentity(raw)) errors.push({ path: `/uncovered_relevant_inputs`, message: `not a repository-relative POSIX path: ${JSON.stringify(raw)}` });
		else uncovered.add(raw);
	}

	for (const entry of input.entries) {
		const path = entry.path;
		// Validate the path FIRST. Deciding to exclude or drop a path before
		// establishing that it *is* a repository-relative path would let an
		// absolute, traversing, or NUL-bearing string reach `coverage` — and
		// `coverage` is inside the digest.
		if (!isRepoRelativePath(path)) {
			errors.push({ path: "/entries", message: `not a repository-relative POSIX path: ${JSON.stringify(path)}` });
			continue;
		}
		// A path the sort cannot order deterministically cannot be an identity
		// component; without this the same tree yields two digests depending on
		// the order the host happened to enumerate it in.
		if (!isSortableIdentity(path)) {
			errors.push({ path: "/entries", message: `path contains an unpaired surrogate or replacement character and cannot be ordered deterministically: ${JSON.stringify(path)}` });
			continue;
		}
		// One path, one observation: a collector that reports the same path
		// twice — in any combination of kinds — cannot say what it saw.
		if (seenPath.has(path)) {
			errors.push({ path: `/entries/${path}`, message: "duplicate path: the collector reported one path twice" });
			continue;
		}
		seenPath.add(path);
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
			uncovered.add(path);
			continue;
		}
		const normalized = normalizeEntry(entry);
		if (normalized.ok === false) {
			errors.push({ path: `/entries/${path}`, message: normalized.reason });
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
	// Coverage is required, not optional. A reader that cannot see the
	// coverage cannot conclude the tree was fully observed, so an absent or
	// malformed one must block rather than default to "nothing uncovered" —
	// a degradation may lower trust, never raise it.
	const uncovered = (candidate as { coverage?: { uncovered_relevant_inputs?: unknown } }).coverage?.uncovered_relevant_inputs;
	if (!Array.isArray(uncovered)) {
		reasons.push("coverage.uncovered_relevant_inputs is missing or not a list; a candidate whose coverage cannot be read may not bind an acceptance");
	} else if (uncovered.length > 0) {
		const shown = uncovered.slice(0, 3).map((value) => String(value));
		reasons.push(`${uncovered.length} relevant input(s) were not covered (${shown.join(", ")}${uncovered.length > 3 ? ", …" : ""}); an unchanged digest cannot mean an unchanged tree`);
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
