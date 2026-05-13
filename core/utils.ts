// General-purpose helpers used by yaml/status/prompts and by wrapper-specific
// path-boundary enforcement (Pi tool interception, MCP cwd validation).

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { normalize, resolve } from "node:path";
import { realpath } from "node:fs/promises";

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
	return normalizedPath.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`);
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
