// Status normalization, atomic writes, and file-lock primitives. Pure
// framework logic shared by every wrapper.

import { randomBytes } from "node:crypto";
import { open, readdir, readFile, rename, rm, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
/**
 * How long a lock ticket may go unrefreshed before its owner is presumed
 * hung. Owners refresh every quarter of this while they wait or hold, so a
 * live holder is never broken by age; a dead one is removed at once.
 */
export const STALE_LOCK_MS = 60_000;

export function assertSafePhaseId(phaseId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(phaseId)) {
		throw new Error(`Invalid phase id: ${phaseId}`);
	}
}

/**
 * A YAML scalar as text: strings as written, numbers and booleans spelled
 * back out. Files written before #225 hold owner notes such as `2048` or
 * `true` bare, which the reader returns as a number or a boolean; dropping
 * or crashing on those would lose real state, so they are read as the text
 * they were. Anything else (null, arrays, objects) has no text.
 */
export function textOf(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

/** Like {@link textOf}, trimmed, and "" for a value that has no text. */
function trimmedText(value: unknown): string {
	return (textOf(value) ?? "").trim();
}

export function ensureArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(textOf).filter((entry): entry is string => entry !== null);
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
	if (trimmedText(raw.id)) entry.id = trimmedText(raw.id);
	if (trimmedText(raw.kind)) entry.kind = trimmedText(raw.kind);
	if (trimmedText(raw.description)) entry.description = trimmedText(raw.description);
	if (trimmedText(raw.deferred_reason)) entry.deferred_reason = trimmedText(raw.deferred_reason);
	if (allowTargetPhase && trimmedText(raw.target_phase)) entry.target_phase = trimmedText(raw.target_phase);
	// derives_from rides the same flag as target_phase: it is a carry-forward
	// concept only — the id of the open question this routed item answers one
	// candidate of (#122, #186). An open_questions entry has nothing to derive
	// from, so the field is dropped there rather than silently carried.
	if (allowTargetPhase && trimmedText(raw.derives_from)) entry.derives_from = trimmedText(raw.derives_from);
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
		next_actions: [beginPhaseAction(firstPhaseConfig ?? { id: firstPhase })],
		post_pipeline: [],
	};
}

/**
 * The one next_actions line for a phase the engine says is eligible. Init,
 * completion, and a pipeline switch all spell it this way.
 */
export function beginPhaseAction(phase: { id: string; primary_output?: string }): string {
	return `Begin ${phase.id} phase by producing ${phase.primary_output ?? `findings/${phase.id}/`}`;
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

	// Coerced, not assumed: a status.yaml written before #225 spells a
	// digit-named project bare, and the reader returns a number for it.
	return {
		project_name: trimmedText(status.project_name) || basename(cwd),
		pipeline: trimmedText(status.pipeline) || pipelinePath,
		current_phase: trimmedText(status.current_phase) || pipeline.phase_order[0] || "complete",
		last_updated: trimmedText(status.last_updated) || "",
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

/** What {@link acquireLock} hands back: a release that only ever removes its own ticket. */
export interface LockHandle {
	release: () => Promise<void>;
	/**
	 * Set when acquiring meant removing a ticket whose holder was dead or had
	 * stopped refreshing it for {@link STALE_LOCK_MS}: the previous holder as
	 * its ticket recorded it, for callers that log.
	 */
	brokeStale?: { pid: number | null; since: string | null };
}

export interface AcquireLockOptions {
	/** How long to wait for the lock; default {@link LOCK_TIMEOUT_MS}. */
	timeoutMs?: number;
	/**
	 * How long a ticket may go unrefreshed before its holder is presumed
	 * hung; default {@link STALE_LOCK_MS}. A dead holder is removed at once.
	 */
	staleMs?: number;
	/** @internal File operations seam for deterministic lock race tests. */
	fsOps?: { stat: typeof stat; rename: typeof rename; unlink: typeof unlink };
}

/**
 * Take the lock named by `lockPath`, waiting up to `timeoutMs`.
 *
 * The lock is a queue of **tickets**: files beside `lockPath` named
 * `<lock>.t.<order>-<pid>-<token>`, one per waiter, each written by its
 * owner alone. The holder is the owner of the first ticket in name order
 * whose process is alive and whose ticket has been refreshed within
 * `staleMs`; every owner refreshes its ticket on a timer while it waits and
 * while it holds, so a live holder is never broken however long it holds
 * (#355 — a publish across a full reindex used to lose its lock at 60 s).
 * A ticket whose owner is dead, or has not refreshed it in `staleMs`, is
 * removed by whoever notices — by its own unique name, so two waiters
 * removing the same dead ticket remove the same inode and nothing else.
 * No shared path is ever removed and re-created, which is the race every
 * `rm`-then-recreate stale break carries (#342, #344, #355).
 *
 * Ordering follows Lamport's bakery: a waiter announces it is *choosing*
 * (`<lock>.c.<token>`), takes a number one larger than any ticket it can
 * see, writes its ticket, and withdraws the marker; nobody concludes it
 * holds the lock while a marker it does not own exists — so a waiter that
 * took its number but has not yet written its ticket cannot be overtaken.
 * Two tickets with the same number (chosen at the same moment) break the
 * tie on the rest of the name, which every observer sorts the same way.
 *
 * A plain `lockPath` file left by a pre-#355 process is honoured while it is
 * younger than `staleMs` and removed once it is not, so an upgrade under a
 * live older process does not let two writers in.
 */
export async function acquireLock(lockPath: string, options: AcquireLockOptions = {}): Promise<LockHandle> {
	const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? STALE_LOCK_MS;
	const fsOps = options.fsOps ?? { stat, rename, unlink };
	const startedAt = Date.now();
	const dir = dirname(lockPath);
	const base = basename(lockPath);
	const token = randomBytes(8).toString("hex");
	const choosingPath = join(dir, `${base}.c.${token}`);
	let brokeStale: LockHandle["brokeStale"];

	// The doorway: announce, take a number, write the ticket, withdraw. The
	// number is one more than the largest ticket number on the floor, taken
	// while the marker is up — so a waiter that arrives after us reads our
	// ticket and takes a larger number, and two that choose at once get the
	// same number and settle it on the token. A wall-clock number would let
	// a later arrival in the same millisecond sort ahead of a holder.
	await writeExclusive(choosingPath, `${process.pid}\n${new Date().toISOString()}\n${token}\n`);
	const numbered = (await readdir(dir).catch(() => [] as string[]))
		.filter((name) => name.startsWith(`${base}.t.`))
		.map((name) => Number.parseInt(name.slice(`${base}.t.`.length), 10))
		.filter((n) => Number.isFinite(n));
	const order = String(Math.max(0, ...numbered) + 1).padStart(15, "0");
	const ticketPath = join(dir, `${base}.t.${order}-${process.pid}-${token}`);
	const ticketName = basename(ticketPath);
	try {
		await writeExclusive(ticketPath, `${process.pid}\n${new Date().toISOString()}\n${token}\n`);
	} finally {
		await rm(choosingPath, { force: true }).catch(() => undefined);
	}

	// The heartbeat: a ticket that keeps being touched is a live owner's.
	const heartbeat = setInterval(() => {
		const now = new Date();
		void utimes(ticketPath, now, now).catch(() => undefined);
	}, Math.max(50, Math.floor(staleMs / 4)));
	heartbeat.unref?.();

	const giveUp = (): never => {
		throw new Error(`Timed out waiting for lock: ${lockPath}`);
	};

	let acquired = false;
	try {
		while (true) {
			const names = await readdir(dir).catch(() => [] as string[]);
			let blocked = false;
			// Failed cleanup must not leave permanent tombstones or claim markers.
			for (const name of names) {
				const claimPrefix = `${base}.claim.`;
				if (!name.startsWith(`${base}.reaped.`) && !name.startsWith(claimPrefix)) continue;
				const path = join(dir, name);
				const fileStat = await fsOps.stat(path).catch(() => null);
				const claimSourceGone = name.startsWith(claimPrefix)
					&& !(await pathExists(join(dir, name.slice(claimPrefix.length))));
				if (claimSourceGone || (fileStat && Date.now() - fileStat.mtimeMs > staleMs)) {
					await rm(path, { force: true }).catch(() => undefined);
				}
			}

			// A pre-#355 lock file: honour it while fresh, remove it when stale.
			if (names.includes(base)) {
				const legacyStat = await fsOps.stat(lockPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") blocked = true;
					return null;
				});
				if (legacyStat && Date.now() - legacyStat.mtimeMs <= staleMs) blocked = true;
				else if (legacyStat) {
					const holder = await describeLockHolder(lockPath);
					const claim = await removeIfPresent(lockPath, lockPath, fsOps);
					if (claim === "claimed") brokeStale = holder;
					if (claim === "busy") blocked = true;
				}
			}

			// Someone is between taking a number and writing their ticket: their
			// number may be earlier than ours. Wait, unless they died in the door.
			for (const name of names) {
				if (!name.startsWith(`${base}.c.`) || name === basename(choosingPath)) continue;
				const path = join(dir, name);
				if (await ownerIsGone(path, staleMs, fsOps)) {
					await rm(path, { force: true }).catch(() => undefined);
					continue;
				}
				blocked = true;
			}

			// Every ticket ahead of ours whose owner is alive blocks us; a dead or
			// hung owner's ticket is removed by its own name.
			if (!blocked) {
				const ahead = names.filter((name) => name.startsWith(`${base}.t.`) && name < ticketName).sort();
				for (const name of ahead) {
					const path = join(dir, name);
					if (await ownerIsGone(path, staleMs, fsOps)) {
						// Only the waiter that claims the dead ticket records its holder;
						// other waiters cannot claim the same path.
						const holder = await describeLockHolder(path);
						const claim = await removeIfPresent(path, lockPath, fsOps);
						if (claim === "claimed") brokeStale = holder;
						if (claim === "busy") {
							blocked = true;
							break;
						}
						continue;
					}
					blocked = true;
					break;
				}
			}

			if (!blocked) {
				// Our own ticket must still be there: a waiter that judged us hung
				// (the machine slept past staleMs) has already let someone in.
				if (!(await pathExists(ticketPath))) giveUp();
				acquired = true;
				return {
					release: async () => {
						clearInterval(heartbeat);
						await rm(ticketPath, { force: true }).catch(() => undefined);
					},
					...(brokeStale && { brokeStale }),
				};
			}

			if (Date.now() - startedAt > timeoutMs) giveUp();
			await sleep(LOCK_RETRY_MS);
		}
	} finally {
		if (!acquired) {
			clearInterval(heartbeat);
			await rm(ticketPath, { force: true }).catch(() => undefined);
		}
	}
}

/**
 * Atomically move a stale claim out of the queue. Only the waiter whose
 * rename succeeds reports the break. The tombstone is outside the ticket
 * namespace, so even a Windows unlink failure cannot revive the claim.
 */
async function removeIfPresent(
	path: string,
	lockPath: string,
	fsOps: NonNullable<AcquireLockOptions["fsOps"]>,
): Promise<"claimed" | "gone" | "busy"> {
	const tombstone = `${lockPath}.reaped.${randomBytes(8).toString("hex")}`;
	// Windows can let concurrent renames of the same source both report
	// success. This stable, exclusive marker decides who may claim that name.
	const claimPath = `${lockPath}.claim.${basename(path)}`;
	try {
		await writeExclusive(claimPath, `${process.pid}\n`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "busy";
		throw error;
	}
	try {
		await fsOps.rename(path, tombstone);
	} catch (error) {
		await rm(claimPath, { force: true }).catch(() => undefined);
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
		// Windows can report contention as a permission or sharing error.
		// An existing source blocks this round; a missing one lost the race.
		if (["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			try {
				await fsOps.stat(path);
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") return "gone";
				throw statError;
			}
			return "busy";
		}
		throw error;
	}
	// Keep the claim marker until stale cleanup: Windows can briefly expose
	// the source path after rename reports success. Neither file is a ticket.
	await fsOps.unlink(tombstone).catch(() => undefined);
	try {
		await fsOps.stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			await rm(claimPath, { force: true }).catch(() => undefined);
		}
	}
	return "claimed";
}

/** Create `path` exclusively with `content`; the descriptor is closed either way (#131). */
async function writeExclusive(path: string, content: string): Promise<void> {
	const handle = await open(path, "wx");
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Whether the owner of a ticket or marker is dead (its pid no longer
 * exists) or has stopped refreshing it for `staleMs`. A pid that exists but
 * cannot be signalled (another user's process) counts as alive. A file that
 * vanished while we looked is gone, and so is its owner's claim.
 */
async function ownerIsGone(path: string, staleMs: number, fsOps: NonNullable<AcquireLockOptions["fsOps"]>): Promise<boolean> {
	let fileStat;
	try {
		fileStat = await fsOps.stat(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	if (Date.now() - fileStat.mtimeMs > staleMs) return true;
	const { pid } = await describeLockHolder(path);
	if (pid === null || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
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
