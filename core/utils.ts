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
