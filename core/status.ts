// Status normalization, atomic writes, and file-lock primitives. Pure
// framework logic shared by every wrapper.

import { open, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
	CarryForwardEntry,
	NormalizedStatus,
	OpenQuestionEntry,
	PipelineFile,
	PipelinePhase,
	StatusFile,
	StatusPhase,
} from "./types.ts";
import { sleep } from "./utils.ts";

export const LOCK_RETRY_MS = 125;
export const LOCK_TIMEOUT_MS = 5000;
export const STALE_LOCK_MS = 60_000;

export function ensureArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function coerceEntry(value: unknown, allowTargetPhase: boolean): OpenQuestionEntry | CarryForwardEntry | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		return { description: trimmed };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const entry: CarryForwardEntry = {};
	if (typeof raw.id === "string" && raw.id.trim()) entry.id = raw.id.trim();
	if (typeof raw.kind === "string" && raw.kind.trim()) entry.kind = raw.kind.trim();
	if (typeof raw.description === "string" && raw.description.trim()) entry.description = raw.description.trim();
	if (typeof raw.deferred_reason === "string" && raw.deferred_reason.trim()) entry.deferred_reason = raw.deferred_reason.trim();
	if (allowTargetPhase && typeof raw.target_phase === "string" && raw.target_phase.trim()) entry.target_phase = raw.target_phase.trim();
	return Object.keys(entry).length > 0 ? entry : null;
}

export function ensureEntryArray<T extends OpenQuestionEntry>(value: unknown, allowTargetPhase: boolean = false): T[] {
	if (!Array.isArray(value)) return [];
	const result: T[] = [];
	for (const item of value) {
		const coerced = coerceEntry(item, allowTargetPhase);
		if (coerced) result.push(coerced as T);
	}
	return result;
}

export function ensurePhaseRecord(value: unknown): Record<string, StatusPhase> {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	const result: Record<string, StatusPhase> = {};
	for (const [phaseId, phaseValue] of Object.entries(record)) {
		const phase = (phaseValue ?? {}) as Partial<StatusPhase>;
		result[phaseId] = {
			status: typeof phase.status === "string" ? phase.status : "pending",
			owner_notes: ensureArray(phase.owner_notes),
			outputs_present: ensureArray(phase.outputs_present),
			open_questions: ensureEntryArray<OpenQuestionEntry>(phase.open_questions, false),
			carry_forward: ensureEntryArray<CarryForwardEntry>(phase.carry_forward, true),
		};
	}
	return result;
}

export function createEmptyStatus(projectName: string, pipelinePath: string, pipeline: PipelineFile): NormalizedStatus {
	const phases: Record<string, StatusPhase> = {};
	for (const phaseId of pipeline.phase_order) {
		phases[phaseId] = {
			status: "pending",
			owner_notes: [],
			outputs_present: [],
			open_questions: [],
			carry_forward: [],
		};
	}

	const firstPhase = pipeline.phase_order[0] ?? "complete";
	const phaseMap = new Map<string, PipelinePhase>(pipeline.phases.map((phase) => [phase.id, phase]));
	const firstPhaseConfig = phaseMap.get(firstPhase);

	return {
		project_name: projectName,
		pipeline: pipelinePath,
		current_phase: firstPhase,
		last_updated: "",
		phases,
		next_actions: firstPhaseConfig?.primary_output
			? [`Begin ${firstPhase} phase by producing ${firstPhaseConfig.primary_output}`]
			: ["Begin the first pending phase."],
	};
}

export function normalizeStatus(status: StatusFile, pipeline: PipelineFile, pipelinePath: string, cwd: string): NormalizedStatus {
	const phases = ensurePhaseRecord(status.phases);
	for (const phaseId of pipeline.phase_order) {
		if (!phases[phaseId]) {
			phases[phaseId] = {
				status: "pending",
				owner_notes: [],
				outputs_present: [],
				open_questions: [],
				carry_forward: [],
			};
		}
	}

	return {
		project_name: status.project_name?.trim() || basename(cwd),
		pipeline: status.pipeline?.trim() || pipelinePath,
		current_phase: status.current_phase?.trim() || pipeline.phase_order[0] || "complete",
		last_updated: status.last_updated?.trim() || "",
		phases,
		next_actions: ensureArray(status.next_actions),
	};
}

export async function acquireLock(lockPath: string): Promise<{ release: () => Promise<void> }> {
	const startedAt = Date.now();

	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
			await handle.close();
			return {
				release: async () => {
					await rm(lockPath, { force: true }).catch(() => undefined);
				},
			};
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== "EEXIST") throw error;

			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
					await rm(lockPath, { force: true }).catch(() => undefined);
					continue;
				}
			} catch {
				continue;
			}

			if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}

			await sleep(LOCK_RETRY_MS);
		}
	}
}
