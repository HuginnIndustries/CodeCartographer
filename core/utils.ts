// General-purpose helpers used by yaml/status/prompts and by wrapper-specific
// path-boundary enforcement (Pi tool interception, MCP cwd validation).

import { randomBytes } from "node:crypto";
import { access, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

export function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

let tempSequence = 0;

/**
 * A temp-file suffix that is unique within and across processes: pid, a
 * per-process sequence number, and random bytes. `<pid>.<Date.now()>` alone
 * collides whenever two writers hit one target inside a millisecond, and the
 * loser's rename then either fails with ENOENT or clobbers the winner (#226).
 */
export function uniqueTempSuffix(): string {
	tempSequence = (tempSequence + 1) % 0x7fffffff;
	return `${process.pid}.${tempSequence}.${randomBytes(4).toString("hex")}`;
}

/**
 * Write `content` to `path` atomically: a uniquely named sibling temp file,
 * then a rename over the target. Readers see the old bytes or the new bytes,
 * never a truncated file. On failure the temp file is removed best-effort and
 * the error propagates. Every framework file that is rewritten in place goes
 * through this so no caller hand-rolls the temp name.
 */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
	const tempPath = `${path}.${uniqueTempSuffix()}.tmp`;
	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

export function normalizeForComparison(path: string): string {
	const normalized = normalize(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithinPath(path: string, root: string): boolean {
	const normalizedPath = normalizeForComparison(resolve(path));
	const normalizedRoot = normalizeForComparison(resolve(root));
	if (normalizedPath === normalizedRoot) return true;
	// A filesystem root (e.g. "/" or "C:\") already ends in a separator;
	// appending another one produced a prefix ("//" / "C:\\") that no real
	// path starts with, falsely rejecting every legitimate subpath (#130).
	const prefix = normalizedRoot.endsWith("/") || normalizedRoot.endsWith("\\")
		? normalizedRoot
		: `${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`;
	return normalizedPath.startsWith(prefix);
}

/**
 * Resolve a path the way the kernel will when something is written to it:
 * every component that already exists is followed through symlinks
 * (`realpath`), and the not-yet-existing tail is appended lexically. A `..`
 * is applied to the *resolved* prefix, not the spelled one, because
 * `link/..` means the link target's parent on disk. A relative `path` is
 * taken against `base` without normalisation for the same reason.
 *
 * `realpath` alone throws for a file that does not exist yet, and a lexical
 * fallback let `.codecarto/link/new.md` through when `link` was a symlink to
 * somewhere outside the workspace — the file landed outside (#223).
 */
export async function resolveExistingPrefix(path: string, base: string = process.cwd()): Promise<string> {
	const raw = isAbsolute(path) ? path : `${base}${sep}${path}`;
	const { root } = parse(raw);
	const segments = raw
		.slice(root.length)
		.split(/[\\/]+/)
		.filter((segment) => segment !== "" && segment !== ".");
	let current = await canonicalPath(root || sep);
	const tail: string[] = [];
	for (const segment of segments) {
		if (segment === "..") {
			if (tail.length > 0) tail.pop();
			else current = dirname(current);
			continue;
		}
		if (tail.length > 0) {
			// Once one component is missing, nothing below it can exist either.
			tail.push(segment);
			continue;
		}
		try {
			current = await realpath(join(current, segment));
		} catch {
			tail.push(segment);
		}
	}
	return tail.length === 0 ? current : join(current, ...tail);
}

/**
 * Symlink-aware version of isWithinPath for paths that may not exist yet:
 * the existing prefix of `path` is resolved through symlinks
 * ({@link resolveExistingPrefix}), the root through `realpath`, and the two
 * are compared lexically. A symlinked ancestor that points outside the root
 * fails whether or not the target file exists.
 */
export async function isWithinPathResolved(path: string, root: string): Promise<boolean> {
	const [resolvedPath, resolvedRoot] = await Promise.all([resolveExistingPrefix(path), canonicalPath(root)]);
	return isWithinPath(resolvedPath, resolvedRoot);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uniqueStrings(items: string[]): string[] {
	return [...new Set(items.filter(Boolean))];
}

export function dateOnly(timestamp: string): string {
	return timestamp.slice(0, 10);
}

/**
 * The separator to put before a line appended to file content `current` so
 * the line starts at column 0. A file whose last line lacks a trailing newline
 * (a hand-edited THREAD_LOG.md, an editor that strips final newlines) would
 * otherwise have the appended entry glued onto that line (#134). Empty or
 * absent content needs no separator.
 */
export function newlineIfUnterminated(current: string): string {
	return current === "" || current.endsWith("\n") ? "" : "\n";
}

/**
 * Expand a leading `~` or `~/` to the user's home directory. Node's `path`
 * module deliberately doesn't do this (it's a shell convention, not a path
 * primitive), so callers that accept user-typed paths (config files,
 * `library.path`) need to expand explicitly before passing to `resolve`.
 * Paths without a leading tilde are returned unchanged.
 */
export function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

/**
 * Format an integer as `2.50M` / `2.3k` / `500`. Used by the HTML dashboard
 * for compact numeric cells. The widget and notify paths have their own
 * formatters that include " tokens" / unit suffixes inline; this helper is
 * deliberately suffix-free so callers attach units in surrounding markup.
 */
export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${count}`;
}

/**
 * Format a millisecond duration as `2m30s` / `1.5s` / `500ms`. Matches the
 * extension widget's `formatDuration` shape; promoted to `core/` so the
 * dashboard renderer can reuse without crossing the core/extensions boundary.
 */
export function formatMillis(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/**
 * Compare two dotted `major.minor.patch` versions. Returns -1, 0, or 1, or
 * null when either side is not a plain three-part version (pre-release tags,
 * hand-edited markers) so callers can fall back to string equality.
 */
export function compareDottedVersions(a: string, b: string): number | null {
	const parse = (version: string): number[] | null => {
		const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
	};
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return null;
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
	}
	return 0;
}
