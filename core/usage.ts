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
export type CompactionReason = "threshold" | "overflow" | "manual";

export interface UsageTokens {
	input: number;
	output: number;
	cache_write: number;
}

export interface CompactionTelemetry {
	successful: number;
	failed: number;
	aborted: number;
	reasons: Record<CompactionReason, number>;
}

export function emptyCompactionTelemetry(): CompactionTelemetry {
	return { successful: 0, failed: 0, aborted: 0, reasons: { threshold: 0, overflow: 0, manual: 0 } };
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
	compactions?: CompactionTelemetry;
}

export interface UsageFile {
	version: number;
	runs: UsageRun[];
}

export interface UsageTotals {
	runs: number;
	compaction_runs: number;
	tokens: UsageTokens;
	tool_uses: number;
	duration_ms: number;
	compactions: CompactionTelemetry;
}

export async function loadUsage(workspaceDir: string): Promise<UsageFile> {
	const path = join(workspaceDir, USAGE_RELATIVE_PATH);
	if (!(await pathExists(path))) return emptyUsage();
	try {
		const raw = await readFile(path, "utf8");
		const parsed = parseSimpleYaml(raw) as Partial<UsageFile> | null | undefined;
		return normalize(parsed);
	} catch {
		return emptyUsage();
	}
}

export async function appendUsageRun(workspaceDir: string, run: UsageRun): Promise<void> {
	const current = await loadUsage(workspaceDir);
	current.runs.push(run);
	const path = join(workspaceDir, USAGE_RELATIVE_PATH);
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${stringifySimpleYaml(current)}\n`, "utf8");
	await rename(tempPath, path);
}

export function computeTotals(file: UsageFile): UsageTotals {
	const totals = emptyTotals();
	totals.runs = file.runs.length;
	for (const run of file.runs) addRun(totals, run);
	return totals;
}

export function computePerPhaseTotals(file: UsageFile): Map<string, UsageTotals> {
	const byPhase = new Map<string, UsageTotals>();
	for (const run of file.runs) {
		const totals = byPhase.get(run.phase) ?? emptyTotals();
		totals.runs += 1;
		addRun(totals, run);
		byPhase.set(run.phase, totals);
	}
	return byPhase;
}

function emptyTotals(): UsageTotals {
	return {
		runs: 0,
		compaction_runs: 0,
		tokens: { input: 0, output: 0, cache_write: 0 },
		tool_uses: 0,
		duration_ms: 0,
		compactions: emptyCompactionTelemetry(),
	};
}

function addRun(totals: UsageTotals, run: UsageRun): void {
	totals.tokens.input += run.tokens?.input ?? 0;
	totals.tokens.output += run.tokens?.output ?? 0;
	totals.tokens.cache_write += run.tokens?.cache_write ?? 0;
	totals.tool_uses += run.tool_uses ?? 0;
	totals.duration_ms += run.duration_ms ?? 0;
	if (run.compactions) totals.compaction_runs += 1;
	addCompactions(totals.compactions, run.compactions);
}

function addCompactions(target: CompactionTelemetry, source: CompactionTelemetry | undefined): void {
	if (!source) return;
	target.successful += source.successful;
	target.failed += source.failed;
	target.aborted += source.aborted;
	target.reasons.threshold += source.reasons.threshold;
	target.reasons.overflow += source.reasons.overflow;
	target.reasons.manual += source.reasons.manual;
}

function emptyUsage(): UsageFile {
	return { version: SCHEMA_VERSION, runs: [] };
}

function normalize(raw: Partial<UsageFile> | null | undefined): UsageFile {
	if (!raw || typeof raw !== "object") return emptyUsage();
	const runs = Array.isArray(raw.runs) ? raw.runs.filter(isUsageRun) : [];
	return { version: typeof raw.version === "number" ? raw.version : SCHEMA_VERSION, runs };
}

function isUsageRun(x: unknown): x is UsageRun {
	if (!x || typeof x !== "object") return false;
	const run = x as Partial<UsageRun>;
	return (
		typeof run.timestamp === "string" &&
		typeof run.phase === "string" &&
		(run.status === "completed" || run.status === "aborted" || run.status === "error") &&
		isFiniteNumber(run.turn_count) &&
		isFiniteNumber(run.tool_uses) &&
		isFiniteNumber(run.duration_ms) &&
		isUsageTokens(run.tokens) &&
		(run.session_file === undefined || typeof run.session_file === "string") &&
		(run.compactions === undefined || isCompactionTelemetry(run.compactions))
	);
}

function isUsageTokens(x: unknown): x is UsageTokens {
	if (!x || typeof x !== "object") return false;
	const tokens = x as Partial<UsageTokens>;
	return isFiniteNumber(tokens.input) && isFiniteNumber(tokens.output) && isFiniteNumber(tokens.cache_write);
}

function isCompactionTelemetry(x: unknown): x is CompactionTelemetry {
	if (!x || typeof x !== "object") return false;
	const telemetry = x as Partial<CompactionTelemetry>;
	const reasons = telemetry.reasons as Partial<Record<CompactionReason, number>> | undefined;
	return isFiniteNumber(telemetry.successful) && isFiniteNumber(telemetry.failed) && isFiniteNumber(telemetry.aborted) &&
		Boolean(reasons) && isFiniteNumber(reasons?.threshold) && isFiniteNumber(reasons?.overflow) && isFiniteNumber(reasons?.manual);
}

function isFiniteNumber(x: unknown): x is number {
	return typeof x === "number" && Number.isFinite(x);
}
