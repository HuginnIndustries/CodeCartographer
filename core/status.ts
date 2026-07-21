// Status normalization, atomic writes, and file-lock primitives. Pure
// framework logic shared by every wrapper.

import { open, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	CarryForwardEntry,
	NormalizedStatus,
	OpenQuestionEntry,
	PostPipelineEntry,
	PhaseHandoff,
	PipelineFile,
	PipelinePhase,
	StatusFile,
	StatusPhase,
} from "./types.ts";
import { pathExists, sleep } from "./utils.ts";
import { loadYamlFile } from "./yaml.ts";

export const LOCK_RETRY_MS = 125;
export const LOCK_TIMEOUT_MS = 5000;
export const STALE_LOCK_MS = 60_000;

export function assertSafePhaseId(phaseId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(phaseId)) {
		throw new Error(`Invalid phase id: ${phaseId}`);
	}
}

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

export function autoAssignIds(entries: OpenQuestionEntry[], prefix: string, phaseId: string): void {
	const existingIds = new Set(entries.map((e) => e.id).filter(Boolean));
	let counter = 0;
	for (const entry of entries) {
		if (!entry.id || !entry.id.trim()) {
			counter++;
			let candidate = `${prefix}-${phaseId}-${counter}`;
			while (existingIds.has(candidate)) {
				counter++;
				candidate = `${prefix}-${phaseId}-${counter}`;
			}
			existingIds.add(candidate);
			entry.id = candidate;
		}
	}
}

export function ensurePostPipelineArray(value: unknown): PostPipelineEntry[] {
	if (!Array.isArray(value)) return [];
	const result: PostPipelineEntry[] = [];
	for (const item of value) {
		const base = coerceEntry(item, false);
		if (!base) continue;
		const raw = typeof item === "object" && item && !Array.isArray(item) ? item as Record<string, unknown> : {};
		result.push({
			...base,
			source_phase: typeof raw.source_phase === "string" && raw.source_phase.trim() ? raw.source_phase.trim() : undefined,
			status: raw.status === "resolved" ? "resolved" : "pending",
		});
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
	const phaseMap = new Map<string, { id: string; primary_output?: string }>(pipeline.phases.map((phase) => [phase.id, phase]));
	const firstPhaseConfig = phaseMap.get(firstPhase);

	return {
		project_name: projectName,
		pipeline: pipelinePath,
		current_phase: firstPhase,
		last_updated: "",
		schema_version: 1,
		phases,
		next_actions: firstPhaseConfig?.primary_output
			? [`Begin ${firstPhase} phase by producing ${firstPhaseConfig.primary_output}`]
			: ["Begin the first pending phase."],
		post_pipeline: [],
	};
}

export function normalizeStatus(status: StatusFile, pipeline: PipelineFile, pipelinePath: string, cwd: string): NormalizedStatus {
	if (typeof status.schema_version === "number" && status.schema_version > 1) {
		throw new Error(`Unsupported status schema_version ${status.schema_version}. Supported: 1.`);
	}
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
		schema_version: typeof status.schema_version === "number" ? status.schema_version : 1,
		phases,
		next_actions: ensureArray(status.next_actions),
		post_pipeline: ensurePostPipelineArray(status.post_pipeline),
	};
}

export function parseHandoff(value: unknown): PhaseHandoff {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid handoff: expected object");
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.phase_id !== "string" || !raw.phase_id.trim()) {
		throw new Error("Invalid handoff: phase_id is required");
	}
	const schemaVersion = typeof raw.schema_version === "number" ? raw.schema_version : 1;
	// Reject unsupported future versions (anything > current version 1)
	if (schemaVersion > 1) {
		throw new Error(`Invalid handoff: unsupported schema_version ${schemaVersion}. Supported: 1.`);
	}
	for (const field of ["owner_notes", "open_questions", "carry_forward", "carry_forward_closures", "open_question_closures", "post_pipeline", "decisions"] as const) {
		if (raw[field] !== undefined && !Array.isArray(raw[field])) {
			throw new Error(`Invalid handoff: ${field} must be an array`);
		}
	}
	const openQuestions = ensureEntryArray<OpenQuestionEntry>(raw.open_questions, false);
	const carryForward = ensureEntryArray<CarryForwardEntry>(raw.carry_forward, true);
	autoAssignIds(openQuestions, "oq", raw.phase_id.trim());
	autoAssignIds(carryForward, "cf", raw.phase_id.trim());
	return {
		phase_id: raw.phase_id.trim(),
		timestamp: typeof raw.timestamp === "string" ? raw.timestamp.trim() : undefined,
		owner_notes: ensureArray(raw.owner_notes),
		open_questions: openQuestions,
		carry_forward: carryForward,
		carry_forward_closures: ensureArray(raw.carry_forward_closures),
		open_question_closures: ensureArray(raw.open_question_closures),
		post_pipeline: ensurePostPipelineArray(raw.post_pipeline),
		decisions: ensureArray(raw.decisions),
		closeout_content: typeof raw.closeout_content === "string" ? raw.closeout_content : "",
		closeout_summary: typeof raw.closeout_summary === "string" ? raw.closeout_summary : "",
		schema_version: schemaVersion,
	};
}

export async function loadHandoffFile(phaseId: string, workspaceDir: string): Promise<PhaseHandoff | null> {
	assertSafePhaseId(phaseId);
	const handoffPath = join(workspaceDir, "scratch", "handoffs", `${phaseId}.yaml`);
	if (!(await pathExists(handoffPath))) return null;
	const raw = await loadYamlFile(handoffPath);
	return parseHandoff(raw);
}

export function applyHandoff(status: NormalizedStatus, handoff: PhaseHandoff): NormalizedStatus {
	const phase = status.phases[handoff.phase_id];
	if (!phase) return status;

	phase.owner_notes = ensureArray([
		...phase.owner_notes,
		...handoff.owner_notes,
	]);

	// Merge open_questions: deduplicate by id across ALL phases, not just this one
	// First, collect existing questions with the same id from other phases
	const oqMap = new Map<string, { entry: OpenQuestionEntry; phase: string }>();
	for (const [pid, ph] of Object.entries(status.phases)) {
		for (const entry of ph.open_questions ?? []) {
			const key = entry.id || entry.description || "";
			if (key) oqMap.set(key, { entry, phase: pid });
		}
	}
	// Remove existing entries with matching ids from their original phases
	for (const entry of handoff.open_questions) {
		const key = entry.id || entry.description || "";
		if (key && oqMap.has(key)) {
			const existing = oqMap.get(key)!;
			if (existing.phase !== handoff.phase_id) {
				status.phases[existing.phase].open_questions = status.phases[existing.phase].open_questions.filter((e) => (e.id || e.description || "") !== key);
			}
		}
	}
	// Now merge into the current phase: overwrite by id or append new
	const localOqMap = new Map<string, OpenQuestionEntry>();
	for (const entry of phase.open_questions) {
		const key = entry.id || entry.description || "";
		if (key) localOqMap.set(key, entry);
	}
	for (const entry of handoff.open_questions) {
		const key = entry.id || entry.description || "";
		if (key) localOqMap.set(key, entry);
		else phase.open_questions.push(entry);
	}
	phase.open_questions = [...localOqMap.values()];

	// Merge carry_forward: overwrite by id or append new
	const cfMap = new Map<string, CarryForwardEntry>();
	for (const entry of phase.carry_forward) {
		const key = entry.id || entry.description || "";
		if (key) cfMap.set(key, entry);
	}
	for (const entry of handoff.carry_forward) {
		const key = entry.id || entry.description || "";
		if (key) cfMap.set(key, entry);
		else phase.carry_forward.push(entry);
	}
	phase.carry_forward = [...cfMap.values()];

	// Apply closures: remove carry_forward entries from ALL phases by id
	for (const closureId of handoff.carry_forward_closures) {
		if (!closureId) continue;
		for (const ph of Object.values(status.phases)) {
			ph.carry_forward = ph.carry_forward.filter((entry) => entry.id !== closureId);
		}
	}

	// Apply open_question_closures: remove resolved questions from ALL phases by id
	for (const closureId of handoff.open_question_closures) {
		if (!closureId) continue;
		for (const ph of Object.values(status.phases)) {
			ph.open_questions = ph.open_questions.filter((entry) => entry.id !== closureId);
		}
	}

	const postPipeline = new Map<string, PostPipelineEntry>();
	const legacyPostPipeline: PostPipelineEntry[] = [];
	for (const entry of status.post_pipeline) {
		if (entry.id) postPipeline.set(entry.id, entry);
		else legacyPostPipeline.push(entry);
	}
	for (const entry of handoff.post_pipeline) {
		const normalized: PostPipelineEntry = {
			...entry,
			source_phase: entry.source_phase ?? handoff.phase_id,
			status: entry.status ?? "pending",
		};
		if (normalized.id) postPipeline.set(normalized.id, normalized);
	}
	status.post_pipeline = [...legacyPostPipeline, ...postPipeline.values()];

	return status;
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
