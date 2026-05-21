// Local-only phase usage log. Lives at
// `.codecarto/workflow/.usage.local.yaml` (gitignored). Append-only —
// each finished phase sub-agent contributes one entry. Totals are computed
// on read so the file never holds a number that contradicts the runs.
//
// Concurrency: /codecarto-next rejects re-entry on a phase that's already
// running, and phases run sequentially against this file, so a plain
// read-modify-write is safe enough. If parallel-phase dispatch ever ships,
// switch this to atomic-rename (see core/workspace.ts for the pattern).

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./utils.ts";
import { parseSimpleYaml, stringifySimpleYaml } from "./yaml.ts";

export const USAGE_RELATIVE_PATH = "workflow/.usage.local.yaml";
const SCHEMA_VERSION = 1;

export type UsageRunStatus = "completed" | "aborted" | "error";

export interface UsageTokens {
	input: number;
	output: number;
	cache_write: number;
}

export interface UsageRun {
	timestamp: string;
	phase: string;
	status: UsageRunStatus;
	turn_count: number;
	tool_uses: number;
	duration_ms: number;
	tokens: UsageTokens;
	session_file?: string;
}

export interface UsageFile {
	version: number;
	runs: UsageRun[];
}

export interface UsageTotals {
	runs: number;
	tokens: UsageTokens;
	tool_uses: number;
	duration_ms: number;
}

export async function loadUsage(workspaceDir: string): Promise<UsageFile> {
	const path = join(workspaceDir, USAGE_RELATIVE_PATH);
	if (!(await pathExists(path))) return emptyUsage();
	try {
		const raw = await readFile(path, "utf8");
		const parsed = parseSimpleYaml(raw) as Partial<UsageFile> | null | undefined;
		return normalize(parsed);
	} catch {
		// Malformed file: treat as empty rather than blocking the user. They
		// can fix or delete the file; corrupt local state shouldn't stop work.
		return emptyUsage();
	}
}

export async function appendUsageRun(workspaceDir: string, run: UsageRun): Promise<void> {
	const current = await loadUsage(workspaceDir);
	current.runs.push(run);
	const path = join(workspaceDir, USAGE_RELATIVE_PATH);
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	const serialized = `${stringifySimpleYaml(current)}\n`;
	await writeFile(tempPath, serialized, "utf8");
	await rename(tempPath, path);
}

export function computeTotals(file: UsageFile): UsageTotals {
	const totals: UsageTotals = {
		runs: file.runs.length,
		tokens: { input: 0, output: 0, cache_write: 0 },
		tool_uses: 0,
		duration_ms: 0,
	};
	for (const r of file.runs) {
		totals.tokens.input += r.tokens?.input ?? 0;
		totals.tokens.output += r.tokens?.output ?? 0;
		totals.tokens.cache_write += r.tokens?.cache_write ?? 0;
		totals.tool_uses += r.tool_uses ?? 0;
		totals.duration_ms += r.duration_ms ?? 0;
	}
	return totals;
}

export function computePerPhaseTotals(file: UsageFile): Map<string, UsageTotals> {
	const byPhase = new Map<string, UsageTotals>();
	for (const r of file.runs) {
		const t = byPhase.get(r.phase) ?? {
			runs: 0,
			tokens: { input: 0, output: 0, cache_write: 0 },
			tool_uses: 0,
			duration_ms: 0,
		};
		t.runs += 1;
		t.tokens.input += r.tokens?.input ?? 0;
		t.tokens.output += r.tokens?.output ?? 0;
		t.tokens.cache_write += r.tokens?.cache_write ?? 0;
		t.tool_uses += r.tool_uses ?? 0;
		t.duration_ms += r.duration_ms ?? 0;
		byPhase.set(r.phase, t);
	}
	return byPhase;
}

function emptyUsage(): UsageFile {
	return { version: SCHEMA_VERSION, runs: [] };
}

function normalize(raw: Partial<UsageFile> | null | undefined): UsageFile {
	if (!raw || typeof raw !== "object") return emptyUsage();
	const runs = Array.isArray(raw.runs) ? raw.runs.filter(isUsageRun) : [];
	return {
		version: typeof raw.version === "number" ? raw.version : SCHEMA_VERSION,
		runs,
	};
}

function isUsageRun(x: unknown): x is UsageRun {
	if (!x || typeof x !== "object") return false;
	const r = x as Partial<UsageRun>;
	return (
		typeof r.timestamp === "string" &&
		typeof r.phase === "string" &&
		(r.status === "completed" || r.status === "aborted" || r.status === "error") &&
		isFiniteNumber(r.turn_count) &&
		isFiniteNumber(r.tool_uses) &&
		isFiniteNumber(r.duration_ms) &&
		isUsageTokens(r.tokens) &&
		(r.session_file === undefined || typeof r.session_file === "string")
	);
}

function isUsageTokens(x: unknown): x is UsageTokens {
	if (!x || typeof x !== "object") return false;
	const t = x as Partial<UsageTokens>;
	return isFiniteNumber(t.input) && isFiniteNumber(t.output) && isFiniteNumber(t.cache_write);
}

function isFiniteNumber(x: unknown): x is number {
	return typeof x === "number" && Number.isFinite(x);
}
