// Status normalization, atomic writes, and file-lock primitives. Pure
// framework logic shared by every wrapper.

import { randomBytes } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	CarryForwardEntry,
	ClosureEntry,
	NormalizedStatus,
	OpenQuestionEntry,
	PostPipelineEntry,
	PhaseHandoff,
	PipelineFile,
	PipelinePhase,
	ProposedConventionEntry,
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
	// derives_from rides the same flag as target_phase: it is a carry-forward
	// concept only — the id of the open question this routed item answers one
	// candidate of (#122, #186). An open_questions entry has nothing to derive
	// from, so the field is dropped there rather than silently carried.
	if (allowTargetPhase && typeof raw.derives_from === "string" && raw.derives_from.trim()) entry.derives_from = raw.derives_from.trim();
	return Object.keys(entry).length > 0 ? entry : null;
}

/**
 * Normalize a handoff's `open_question_closures` (#122, #186). Accepts both
 * the original bare-string shape and `{ id, evidence }`; a string becomes
 * `{ id }`, and an entry with no usable id is dropped rather than resolving
 * nothing under the lock. Values are trimmed.
 */
export function ensureClosureArray(value: unknown): ClosureEntry[] {
	if (!Array.isArray(value)) return [];
	const result: ClosureEntry[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const id = item.trim();
			if (id) result.push({ id });
			continue;
		}
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const raw = item as Record<string, unknown>;
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id) continue;
		const evidence = typeof raw.evidence === "string" && raw.evidence.trim() ? raw.evidence.trim() : undefined;
		result.push({ id, ...(evidence !== undefined && { evidence }) });
	}
	return result;
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

/**
 * Spell a tool for both executable surfaces — the shape the scaffold
 * staleness notice adopted (#177). next_actions is canonical state rendered
 * by codecarto_status on MCP and as the Pi widget's "Next:" line alike, and a
 * Pi user handed only the MCP tool name has nothing to run. Several tools
 * join with "then" so a sequence reads as one per surface. No backticks:
 * these lines render in a plain TUI line and in the HTML dashboard.
 */
function onBothSurfaces(...tools: string[]): string {
	const mcp = tools.map((tool) => `codecarto_${tool}`).join(" then ");
	const pi = tools.map((tool) => `/codecarto-${tool.replace(/_/g, "-")}`).join(" then ");
	return `${mcp} on MCP, ${pi} on Pi`;
}

/**
 * Route the terminal boundary to the post-pipeline surfaces (issue #114). The
 * moment every phase completes is exactly when skills, amendments, publishing,
 * and the dashboard apply; the prior static sentence left them undiscovered —
 * the 0.15.0 field test finished two full runs with every one of them unused.
 * Amendment recomputes this list so closure counts never go stale. Every tool
 * named here is spelled for both surfaces (see onBothSurfaces).
 */
export function buildTerminalNextActions(status: NormalizedStatus): string[] {
	const openQuestions = Object.values(status.phases).reduce((sum, phase) => sum + (phase.open_questions?.length ?? 0), 0);
	const postPipeline = status.post_pipeline.length;
	const actions = [
		`All phases complete. Review findings; post-pipeline skills: ${onBothSurfaces("list_skills", "skill")}.`,
	];
	if (openQuestions > 0 || postPipeline > 0) {
		actions.push(`${openQuestions} open question(s) and ${postPipeline} post-pipeline item(s) remain — apply resolutions with ${onBothSurfaces("amend")} (write scratch/amendments/<slug>.yaml from templates/amendment.yaml).`);
	}
	if ("reimplementation-spec" in status.phases) {
		actions.push(`Publish the finished spec to a library: ${onBothSurfaces("publish")} (create one with ${onBothSurfaces("library_init")}; see the library guide topic).`);
	}
	actions.push(`Dashboard: .codecarto/dashboard.html (refreshed on completion and amendment; re-render on demand with ${onBothSurfaces("dashboard")}). Usage totals: ${onBothSurfaces("usage")}.`);
	return actions;
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
	for (const field of ["owner_notes", "open_questions", "carry_forward", "carry_forward_closures", "open_question_closures", "post_pipeline", "decisions", "proposed_conventions"] as const) {
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
		open_question_closures: ensureClosureArray(raw.open_question_closures),
		post_pipeline: ensurePostPipelineArray(raw.post_pipeline),
		decisions: ensureArray(raw.decisions),
		proposed_conventions: ensureProposedConventionArray(raw.proposed_conventions),
		closeout_content: typeof raw.closeout_content === "string" ? raw.closeout_content : "",
		closeout_summary: typeof raw.closeout_summary === "string" ? raw.closeout_summary : "",
		schema_version: schemaVersion,
	};
}

/**
 * Parse the handoff's `proposed_conventions` collection. A present entry must
 * carry non-empty `name` and `rule` strings — a proposal the framework cannot
 * stage legibly fails completion loudly instead of being staged as a stub
 * (same posture as post_pipeline's required id). Omitted defaults to empty.
 */
export function ensureProposedConventionArray(value: unknown): ProposedConventionEntry[] {
	if (!Array.isArray(value)) return [];
	const result: ProposedConventionEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("Invalid handoff: proposed_conventions entries must be objects with name and rule");
		}
		const raw = item as Record<string, unknown>;
		const name = typeof raw.name === "string" ? raw.name.trim() : "";
		const rule = typeof raw.rule === "string" ? raw.rule.trim() : "";
		if (!name || !rule) {
			throw new Error("Invalid handoff: proposed_conventions entries require non-empty name and rule");
		}
		const evidence = typeof raw.evidence === "string" && raw.evidence.trim() ? raw.evidence.trim() : undefined;
		result.push({ name, rule, ...(evidence !== undefined && { evidence }) });
	}
	return result;
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
	// Now merge into the current phase: overwrite by id or append new. An entry
	// with neither id nor description has no key to merge on; it is kept as-is
	// rather than lost when the array is rebuilt from the map (#134).
	const localOqMap = new Map<string, OpenQuestionEntry>();
	const unkeyedOpenQuestions: OpenQuestionEntry[] = [];
	for (const entry of phase.open_questions) {
		const key = entry.id || entry.description || "";
		if (key) localOqMap.set(key, entry);
		else unkeyedOpenQuestions.push(entry);
	}
	for (const entry of handoff.open_questions) {
		const key = entry.id || entry.description || "";
		if (key) localOqMap.set(key, entry);
		else unkeyedOpenQuestions.push(entry);
	}
	phase.open_questions = [...localOqMap.values(), ...unkeyedOpenQuestions];

	// Merge carry_forward: overwrite by id or append new, same unkeyed rule
	const cfMap = new Map<string, CarryForwardEntry>();
	const unkeyedCarryForward: CarryForwardEntry[] = [];
	for (const entry of phase.carry_forward) {
		const key = entry.id || entry.description || "";
		if (key) cfMap.set(key, entry);
		else unkeyedCarryForward.push(entry);
	}
	for (const entry of handoff.carry_forward) {
		const key = entry.id || entry.description || "";
		if (key) cfMap.set(key, entry);
		else unkeyedCarryForward.push(entry);
	}
	phase.carry_forward = [...cfMap.values(), ...unkeyedCarryForward];

	// Apply closures: remove carry_forward entries from ALL phases by id
	for (const closureId of handoff.carry_forward_closures) {
		if (!closureId) continue;
		for (const ph of Object.values(status.phases)) {
			ph.carry_forward = ph.carry_forward.filter((entry) => entry.id !== closureId);
		}
	}

	// Apply open_question_closures: remove resolved questions from ALL phases by id
	for (const closure of handoff.open_question_closures) {
		const closureId = closure?.id;
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

/** What {@link acquireLock} hands back: a release that only ever removes its own lock. */
export interface LockHandle {
	release: () => Promise<void>;
	/**
	 * Set when acquiring meant breaking a lock older than {@link STALE_LOCK_MS}:
	 * the previous holder as its lock file recorded it, for callers that log.
	 */
	brokeStale?: { pid: number | null; since: string | null };
}

/**
 * Take the O_EXCL lock at `lockPath`, waiting up to {@link LOCK_TIMEOUT_MS}
 * and breaking a lock older than {@link STALE_LOCK_MS}.
 *
 * The lock file records `pid`, timestamp, and a per-acquisition token, and
 * release removes the file only while it still carries that token. Without
 * the token, release removed whoever's lock was there: after a stale break
 * the previous holder's release deleted the new holder's lock, and a third
 * writer walked straight in (#227).
 */
export async function acquireLock(lockPath: string): Promise<LockHandle> {
	const startedAt = Date.now();
	const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
	let brokeStale: LockHandle["brokeStale"];

	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			try {
				await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${token}\n`, "utf8");
			} catch (error) {
				// A non-EEXIST write failure must not leak the descriptor the
				// open just created (#131); close best-effort, then rethrow.
				await handle.close().catch(() => undefined);
				throw error;
			}
			await handle.close();
			return {
				release: () => releaseOwnedLock(lockPath, token),
				...(brokeStale && { brokeStale }),
			};
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== "EEXIST") throw error;

			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
					brokeStale = await describeLockHolder(lockPath);
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

/**
 * Remove the lock at `lockPath` only if it is still ours. A lock that vanished
 * (someone broke it as stale) or that now carries another holder's token is
 * left alone; one whose content cannot be read is left to go stale rather
 * than removed unverified.
 */
async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
	let content: string;
	try {
		content = await readFile(lockPath, "utf8");
	} catch {
		return;
	}
	if (content.split(/\r?\n/)[2] !== token) return;
	await rm(lockPath, { force: true }).catch(() => undefined);
}

async function describeLockHolder(lockPath: string): Promise<NonNullable<LockHandle["brokeStale"]>> {
	try {
		const [pidLine, sinceLine] = (await readFile(lockPath, "utf8")).split(/\r?\n/);
		const pid = Number.parseInt(pidLine ?? "", 10);
		return { pid: Number.isFinite(pid) ? pid : null, since: sinceLine?.trim() || null };
	} catch {
		return { pid: null, since: null };
	}
}
