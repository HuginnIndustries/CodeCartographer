// Re-reading the working tree for the acceptance path.
//
// The contract's receipt path (docs/engineering/record-contract.md, step 1)
// requires the adapter to re-read the tree at acceptance time and compare it
// to the bound candidate with `checkCandidateFreshness`. Only the adapter can
// do that read — core sees the record store, never the repository — so this
// module is the one place on the MCP surface that walks the workspace.
//
// It OBSERVES and never executes: no git process, no spawn. HEAD is resolved
// by reading `.git/HEAD` (and the ref or packed-refs it points at); a `.git`
// FILE (a `git worktree`) is followed to the git dir it names, and its
// `commondir` for shared refs. What it
// cannot observe without running git — whether tracked content differs from
// HEAD — is carried from the candidate and DISCLOSED by the caller as a
// limitation; a same-bytes tree cannot differ in dirtiness in a way that
// matters here, because every file the candidate covered is re-hashed.
//
// The scope is the candidate's own: the same exclusions the candidate was
// captured with are applied (collectSnapshot adds the built-in ones), so the
// digest is comparable. `.git/` itself is VCS metadata, never tree content,
// and is skipped at the walk.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { collectSnapshot, patternCovers, type ObservedEntry } from "../core/engineering/snapshots.ts";
import type { CoverageExclusion, SnapshotRecord } from "../core/engineering/types.ts";

export type CandidateReread = Pick<SnapshotRecord, "coverage" | "manifest" | "repository">;

export type WorkingTreeRead = { ok: true; reread: CandidateReread; limitations: string[] } | { ok: false; reason: string };

const VCS_METADATA = new Set([".git"]);
const SHA = /^[0-9a-f]{40}$/;

/**
 * Locate the git directory for `root`, by reading files only. A `.git`
 * DIRECTORY is the git dir itself. A `.git` FILE (a worktree, `git worktree
 * add`) holds `gitdir: <path>` naming the per-worktree git dir, absolute or
 * relative to the worktree root; its `commondir` file (relative to that git
 * dir) names the shared git dir that holds refs and packed-refs. Nothing
 * else is followed: a malformed `.git` file yields `undefined`, and the
 * paths are taken exactly as `gitdir:` / `commondir` name them.
 */
async function locateGitDirs(root: string): Promise<{ gitdir: string; commondir: string } | undefined> {
	const dotGit = join(root, ".git");
	let info;
	try {
		info = await lstat(dotGit);
	} catch {
		return undefined;
	}
	if (info.isDirectory()) return { gitdir: dotGit, commondir: dotGit };
	if (!info.isFile()) return undefined;
	let text: string;
	try {
		text = await readFile(dotGit, "utf8");
	} catch {
		return undefined;
	}
	const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
	if (!firstLine.startsWith("gitdir: ")) return undefined;
	const named = firstLine.slice("gitdir: ".length).trim();
	if (named.length === 0) return undefined;
	const gitdir = resolve(root, named);
	try {
		if (!(await lstat(gitdir)).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	let commondir = gitdir;
	try {
		const common = (await readFile(join(gitdir, "commondir"), "utf8")).split(/\r?\n/, 1)[0]?.trim() ?? "";
		if (common.length > 0) commondir = resolve(gitdir, common);
	} catch {
		// no commondir file: the git dir is its own common dir
	}
	return { gitdir, commondir };
}

/** Resolve HEAD by reading the repository's own files; `undefined` when there is no `.git` here or it is malformed. */
async function readGitHead(root: string): Promise<string | undefined> {
	const dirs = await locateGitDirs(root);
	if (!dirs) return undefined;
	let head: string;
	try {
		head = (await readFile(join(dirs.gitdir, "HEAD"), "utf8")).trim();
	} catch {
		return undefined;
	}
	if (SHA.test(head)) return head;
	const ref = head.startsWith("ref: ") ? head.slice(5).trim() : undefined;
	if (!ref || ref.includes("..") || ref.startsWith("/") || ref.includes("\\")) return undefined;
	const segments = ref.split("/");
	if (segments.some((s) => s.length === 0)) return undefined;
	// A worktree's own git dir may hold a per-worktree loose ref (HEAD-relative
	// refs live there); shared branches live under the common dir.
	for (const base of dirs.gitdir === dirs.commondir ? [dirs.commondir] : [dirs.gitdir, dirs.commondir]) {
		try {
			const direct = (await readFile(join(base, ...segments), "utf8")).trim();
			if (SHA.test(direct)) return direct;
		} catch {
			// fall through
		}
	}
	try {
		for (const line of (await readFile(join(dirs.commondir, "packed-refs"), "utf8")).split("\n")) {
			const [sha, name] = line.trim().split(/\s+/);
			if (name === ref && SHA.test(sha ?? "")) return sha;
		}
	} catch {
		// no packed-refs
	}
	return undefined;
}

/**
 * Walk `root` and fingerprint every path the candidate's scope covers.
 * Unreadable entries are reported as such (they become uncovered inputs in
 * collectSnapshot), never skipped.
 */
async function observe(root: string, excluded: readonly CoverageExclusion[]): Promise<ObservedEntry[]> {
	const entries: ObservedEntry[] = [];
	const covered = (path: string) => excluded.some((rule) => patternCovers(rule.pattern, path));
	async function walk(dir: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			const path = relative(root, dir).split(sep).join("/");
			entries.push({ path, type: "unreadable", reason: error instanceof Error ? error.message : String(error) });
			return;
		}
		for (const name of names.sort()) {
			const absolute = join(dir, name);
			const path = relative(root, absolute).split(sep).join("/");
			if (dir === root && VCS_METADATA.has(name)) continue;
			if (covered(path)) continue;
			let info;
			try {
				info = await lstat(absolute);
			} catch (error) {
				entries.push({ path, type: "unreadable", reason: error instanceof Error ? error.message : String(error) });
				continue;
			}
			if (info.isSymbolicLink()) {
				try {
					entries.push({ path, type: "symlink", target: await readlink(absolute) });
				} catch (error) {
					entries.push({ path, type: "unreadable", reason: error instanceof Error ? error.message : String(error) });
				}
			} else if (info.isDirectory()) {
				await walk(absolute);
			} else if (info.isFile()) {
				try {
					const bytes = await readFile(absolute);
					entries.push({ path, type: "file", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, executable: (info.mode & 0o111) !== 0, size: bytes.length });
				} catch (error) {
					entries.push({ path, type: "unreadable", reason: error instanceof Error ? error.message : String(error) });
				}
			} else {
				entries.push({ path, type: "unreadable", reason: "not a regular file, directory, or symlink" });
			}
		}
	}
	await walk(root);
	return entries;
}

/**
 * Re-read the working tree at `root` in the candidate's scope. The result is
 * what the gate compares against the candidate digest; a failure to read is a
 * reason NOT to proceed, never a pass.
 */
export async function readWorkingTree(root: string, candidate: SnapshotRecord): Promise<WorkingTreeRead> {
	const limitations: string[] = [];
	// The candidate's own exclusions, verbatim; collectSnapshot re-adds the
	// built-in ones and skips an identical redeclaration.
	const excluded = candidate.coverage.excluded;
	const entries = await observe(root, excluded);
	const head = await readGitHead(root);
	const repository: CandidateReread["repository"] =
		candidate.repository.vcs === "git"
			? { vcs: "git", ...(head ? { head } : {}), dirty: candidate.repository.dirty }
			: { vcs: "none", dirty: candidate.repository.dirty };
	if (candidate.repository.vcs === "git" && head === undefined) {
		return { ok: false, reason: `the candidate was captured from a git tree but no HEAD could be read under ${join(root, ".git")} (a git directory, or a worktree gitdir file whose git dir and refs are readable); the tree cannot be re-read in the candidate's scope` };
	}
	limitations.push("the re-read observed file bytes and HEAD by reading the repository directly; repository.dirty is carried from the candidate, not re-observed");
	const collected = collectSnapshot({
		entries,
		repository,
		excluded,
		// The candidate's own uncovered inputs stay uncovered: the re-read cannot make the scope wider than what was captured.
		uncovered_relevant_inputs: [...candidate.coverage.uncovered_relevant_inputs],
	});
	if (collected.ok === false) return { ok: false, reason: `the working tree could not be re-read in the candidate's scope: ${collected.errors.map((e) => `${e.path} ${e.message}`).join("; ")}` };
	return { ok: true, reread: { coverage: collected.value.coverage, manifest: collected.value.manifest, repository: collected.value.repository }, limitations };
}
