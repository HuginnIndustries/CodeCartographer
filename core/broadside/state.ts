// The .codecarto/broadside/ state file (runs, claims, merging persists) and config.yaml loading.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, pathExists } from "../utils.ts";
import { acquireLock } from "../status.ts";
import { loadYamlFile } from "../yaml.ts";
import { packagedWorkspaceDir } from "../workspace.ts";
import { BROADSIDE_CONFIG_FILE, BROADSIDE_TERMINAL_ENTRY_STATUSES, BROADSIDE_DEFAULT_MAX_COST, BROADSIDE_DIR, BROADSIDE_LENS_IDS, BROADSIDE_MODEL, BROADSIDE_STATE_FILE, BROADSIDE_STATE_SCHEMA_VERSION, type BroadsideLensId } from "./constants.ts";
import { type BroadsideBatchEntry, type BroadsideConfig, BroadsideConfigError, type BroadsideReasoning, type BroadsideRetryEntry, type BroadsideRun, type BroadsideRunSlot, BroadsideStateError, type BroadsideStateFile, type BroadsideSynthesisEntry } from "./types.ts";

// ---------- state & config ----------

export function broadsideDirFor(cwd: string): string {
	return join(cwd, ".codecarto", BROADSIDE_DIR);
}

/**
 * Read the Broad-Side reading guide.
 *
 * It is deliberately not a post-pipeline skill under `.codecarto/skills/`: a
 * scout run is read *before* or *during* the interactive pipeline, and the
 * post-pipeline machinery gates on a completed run and wraps its prompt in
 * post-pipeline framing that would be false here. It is also readable on a
 * repository that has scout state and no workspace at all, which is why this
 * falls back to the packaged copy.
 *
 * @param cwd - Absolute path to the target repository.
 * @returns the skill text and the path it came from.
 * @throws when neither the workspace copy nor the packaged copy exists.
 */
export async function readBroadsideSkill(cwd: string): Promise<{ path: string; content: string }> {
	const candidates = [
		join(broadsideDirFor(cwd), "SKILL.md"),
		join(packagedWorkspaceDir, BROADSIDE_DIR, "SKILL.md"),
	];
	for (const path of candidates) {
		if (await pathExists(path)) return { path, content: await readFile(path, "utf8") };
	}
	throw new Error(
		`Broad-Side skill not found at ${candidates.join(" or ")}. Reinstall codecartographer-pi.`,
	);
}

export function defaultBroadsideState(): BroadsideStateFile {
	return { schema_version: BROADSIDE_STATE_SCHEMA_VERSION, runs: [] };
}

export async function loadBroadsideState(broadsideDir: string): Promise<BroadsideStateFile> {
	const statePath = join(broadsideDir, BROADSIDE_STATE_FILE);
	if (!(await pathExists(statePath))) return defaultBroadsideState();
	const text = await readFile(statePath, "utf8");
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new BroadsideStateError(statePath, await preserveCorruptState(statePath, text), `could not be parsed (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { runs?: unknown }).runs)) {
		throw new BroadsideStateError(statePath, await preserveCorruptState(statePath, text), "is not a state file (expected an object with a runs array)");
	}
	return raw as BroadsideStateFile;
}

/**
 * Copy an unreadable state file to `state.json.corrupt-<hash>` beside it,
 * named by content so repeated loads do not multiply copies. Returns the
 * copy's path (the existing one, when the same content was preserved before).
 */
async function preserveCorruptState(statePath: string, text: string): Promise<string> {
	const digest = createHash("sha1").update(text).digest("hex").slice(0, 8);
	const backupPath = `${statePath}.corrupt-${digest}`;
	if (!(await pathExists(backupPath))) await writeFile(backupPath, text, "utf8");
	return backupPath;
}

/**
 * Overwrite `state.json` wholesale with `state`.
 *
 * Prefer {@link persistBroadsideRun} anywhere a live operation is recording its
 * own progress — this entry point replaces the file, so any run a concurrent
 * process recorded in the meantime is erased. It remains the right call for
 * seeding a fresh workspace and for test fixtures, where "make the file exactly
 * this" is the intent.
 */
export async function saveBroadsideState(broadsideDir: string, state: BroadsideStateFile): Promise<void> {
	await mkdir(broadsideDir, { recursive: true });
	const statePath = join(broadsideDir, BROADSIDE_STATE_FILE);
	const lock = await acquireLock(`${statePath}.lock`);
	try {
		await writeBroadsideStateFile(statePath, state);
	} finally {
		await lock.release();
	}
}

/** Serialize through a temp file so a crash mid-write cannot truncate state.json. */
async function writeBroadsideStateFile(statePath: string, state: BroadsideStateFile): Promise<void> {
	await atomicWriteFile(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Read-modify-write `state.json` under a lock.
 *
 * The lock is held only for the read-modify-write, never for the surrounding
 * operation: a `collect` can poll for the better part of an hour, and holding
 * the lock across that would push every concurrent caller past the 5s lock
 * timeout.
 */
export async function updateBroadsideStateAtomically(
	broadsideDir: string,
	mutate: (state: BroadsideStateFile) => void | Promise<void>,
): Promise<BroadsideStateFile> {
	await mkdir(broadsideDir, { recursive: true });
	const statePath = join(broadsideDir, BROADSIDE_STATE_FILE);
	const lock = await acquireLock(`${statePath}.lock`);
	try {
		const state = await loadBroadsideState(broadsideDir);
		await mutate(state);
		await writeBroadsideStateFile(statePath, state);
		return state;
	} finally {
		await lock.release();
	}
}

/**
 * Record one run's current shape, merged into whatever is on disk *now*.
 *
 * Broad-Side operations are long-lived and hold their state in memory while
 * they poll. Writing that snapshot back wholesale silently erased any run a
 * concurrent operation had recorded since it was loaded, orphaning that run's
 * paid results on disk — present as files, invisible to `list`, and unreachable
 * by `collect`, which finds its run by position in `state.runs`. Observed live:
 * a submit at 23:35 was erased by a collect that had loaded state before it and
 * wrote back at 00:08.
 *
 * Merging by run id also self-heals: a run erased by an older writer is
 * restored the next time its own operation checkpoints.
 */
export async function persistBroadsideRun(broadsideDir: string, run: BroadsideRun): Promise<BroadsideStateFile> {
	return updateBroadsideStateAtomically(broadsideDir, (state) => {
		const index = state.runs.findIndex((candidate) => candidate.id === run.id);
		if (index === -1) state.runs.push(run);
		else state.runs[index] = run;
	});
}

/** Where a lens batch entry stands, for keeping the more advanced of two. */
function batchEntryRank(entry: BroadsideBatchEntry | undefined): number {
	if (!entry) return -1;
	if (BROADSIDE_TERMINAL_ENTRY_STATUSES.includes(entry.status)) return 2;
	if (entry.batchId) return 1;
	return 0;
}

/** Where a post-pass entry stands: unclaimed, claimed, submitted, settled. */
function passEntryRank(entry: BroadsideSynthesisEntry | undefined): number {
	if (!entry || entry.status === "pending") return 0;
	if (entry.status === "submitted") return entry.batchId ? 2 : 1;
	return 3;
}

/** Where the retry pass stands: absent, claimed, submitted, settled. */
function retryEntryRank(entry: BroadsideRetryEntry | undefined): number {
	if (!entry) return 0;
	if (entry.status === "submitted") return entry.batches.length > 0 ? 2 : 1;
	return 3;
}

/**
 * Record a collect's view of its run, keeping whatever is further along on
 * disk (#322).
 *
 * Two collects on one run each hold the run in memory and each used to write
 * the whole thing back, so the last writer replaced the other's post-pass
 * entries with its own — and both had submitted their own post-passes, since
 * each decided from the copy it loaded at entry. This writer merges slot by
 * slot: a post-pass or retry entry that is further along on disk (claimed
 * over pending, submitted over claimed, settled over submitted) wins and is
 * copied into `run`, so the caller reports what is true; a lens entry never
 * goes backwards from terminal to polling. A tie keeps this collect's copy,
 * so the collect that settled a pass records its cost. Submitting is guarded
 * separately by {@link claimRunSlot}.
 */
export async function persistBroadsideRunMerging(broadsideDir: string, run: BroadsideRun): Promise<BroadsideStateFile> {
	return updateBroadsideStateAtomically(broadsideDir, (state) => {
		const index = state.runs.findIndex((candidate) => candidate.id === run.id);
		const onDisk = index === -1 ? undefined : state.runs[index];
		if (onDisk) {
			if (passEntryRank(onDisk.synthesis) > passEntryRank(run.synthesis)) run.synthesis = onDisk.synthesis;
			if (passEntryRank(onDisk.triage) > passEntryRank(run.triage)) run.triage = onDisk.triage;
			if (retryEntryRank(onDisk.retry) > retryEntryRank(run.retry)) run.retry = onDisk.retry;
			// A verification pass another process recorded is never dropped by
			// a collect that never knew about it; a newer pass replaces an older.
			if (onDisk.verify && (!run.verify || onDisk.verify.at > run.verify.at)) run.verify = onDisk.verify;
			for (const [lensId, theirs] of Object.entries(onDisk.batches) as Array<[BroadsideLensId, BroadsideBatchEntry | undefined]>) {
				if (theirs && batchEntryRank(theirs) > batchEntryRank(run.batches[lensId])) run.batches[lensId] = theirs;
			}
		}
		if (index === -1) state.runs.push(run);
		else state.runs[index] = run;
	});
}

/**
 * Claim one spending slot of a run for this collect (#322).
 *
 * Read-modify-write under the state lock: if the slot on disk is still
 * unclaimed (`pending`, or absent for the retry), it is marked `submitted`
 * with no batch id *before* any network call and `true` comes back — this
 * collect owns it and may submit. Otherwise another collect got there first:
 * its entry is copied into `run` and `false` comes back. An adopted entry
 * with a batch id can be polled (polling is idempotent); one without an id
 * is a claim whose owner has not recorded the id yet, and is reported as in
 * flight elsewhere.
 */
export async function claimRunSlot(broadsideDir: string, run: BroadsideRun, slot: BroadsideRunSlot): Promise<boolean> {
	let owned = false;
	const claimedAt = new Date().toISOString();
	await updateBroadsideStateAtomically(broadsideDir, (state) => {
		const index = state.runs.findIndex((candidate) => candidate.id === run.id);
		const onDisk = index === -1 ? undefined : state.runs[index];
		const theirs = onDisk?.[slot];
		const unclaimed = slot === "retry" ? theirs === undefined : (theirs as BroadsideSynthesisEntry | undefined)?.status === "pending";
		if (onDisk && !unclaimed) {
			(run as unknown as Record<string, unknown>)[slot] = theirs;
			owned = false;
			return;
		}
		owned = true;
		if (slot === "retry") {
			run.retry = { status: "submitted", batches: [], claimedAt };
		} else {
			run[slot] = { ...run[slot], status: "submitted", batchId: undefined };
		}
		if (!onDisk) {
			state.runs.push(run);
		} else {
			(onDisk as unknown as Record<string, unknown>)[slot] = run[slot];
		}
	});
	return owned;
}

/**
 * Put a run's settled post-passes back to `pending` on disk so the next
 * claim re-runs them (#338). A pass another collect has in flight is left
 * alone — its result is still coming. The replaced results' cost moves to
 * `retiredCost`, so the run's total keeps counting money it spent. Returns
 * the passes that were reset, in the order they will be re-run.
 */
export async function resetRunPostPasses(
	broadsideDir: string,
	run: BroadsideRun,
	wanted: { synthesis: boolean; triage: boolean },
): Promise<Array<"synthesis" | "triage">> {
	const reset: Array<"synthesis" | "triage"> = [];
	await updateBroadsideStateAtomically(broadsideDir, (state) => {
		const index = state.runs.findIndex((candidate) => candidate.id === run.id);
		const onDisk = index === -1 ? run : state.runs[index];
		for (const kind of ["synthesis", "triage"] as const) {
			if (!wanted[kind]) continue;
			const theirs: BroadsideSynthesisEntry = onDisk[kind] ?? { status: "pending" };
			if (theirs.status !== "completed" && theirs.status !== "failed") {
				// pending: nothing to reset; submitted: in flight elsewhere.
				run[kind] = theirs;
				continue;
			}
			if (theirs.cost) onDisk.retiredCost = (onDisk.retiredCost ?? 0) + theirs.cost;
			onDisk[kind] = { status: "pending" };
			run[kind] = onDisk[kind];
			run.retiredCost = onDisk.retiredCost;
			reset.push(kind);
		}
		if (index === -1) state.runs.push(run);
	});
	return reset;
}

/** Read a `reasoning:` block from config.yaml, ignoring anything malformed. */
function parseReasoningConfig(raw: unknown): BroadsideReasoning | null {
	if (raw === false) return { enabled: false };
	if (raw === true) return { enabled: true };
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const out: BroadsideReasoning = {};
	if (typeof value.enabled === "boolean") out.enabled = value.enabled;
	if (value.effort === "minimal" || value.effort === "low" || value.effort === "medium" || value.effort === "high") out.effort = value.effort;
	if (typeof value.max_tokens === "number" && value.max_tokens > 0) out.max_tokens = value.max_tokens;
	return Object.keys(out).length > 0 ? out : null;
}

export async function loadBroadsideConfig(broadsideDir: string): Promise<BroadsideConfig> {
	const configPath = join(broadsideDir, BROADSIDE_CONFIG_FILE);
	let raw: Record<string, unknown> = {};
	if (await pathExists(configPath)) {
		let parsed: unknown;
		try {
			parsed = await loadYamlFile<unknown>(configPath);
		} catch (error) {
			throw new BroadsideConfigError(configPath, `could not be parsed (${error instanceof Error ? error.message : String(error)})`);
		}
		if (parsed !== null && parsed !== undefined) {
			if (typeof parsed !== "object" || Array.isArray(parsed)) throw new BroadsideConfigError(configPath, "is not a YAML mapping");
			raw = parsed as Record<string, unknown>;
		}
		// OpenRouter accepts `reasoning.effort` or `reasoning.max_tokens`, not
		// both: a request carrying both is refused per request *after* the batch
		// is accepted, so every lens fails at $0 with the reason in each
		// result's error. Seen live on 0.22.0 with the two keys set together.
		// Refuse here, where the file can be fixed, rather than submit a run
		// that cannot produce a result.
		const reasoning = raw.reasoning;
		if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
			const value = reasoning as Record<string, unknown>;
			const hasEffort = typeof value.effort === "string";
			const hasBudget = typeof value.max_tokens === "number" && value.max_tokens > 0;
			if (hasEffort && hasBudget) {
				throw new BroadsideConfigError(
					configPath,
					'sets both reasoning.effort and reasoning.max_tokens; OpenRouter accepts one or the other ("Only one of reasoning.effort and reasoning.max_tokens can be specified"), and every lens request would fail after the batch is accepted. Keep one',
				);
			}
		}
	}
	return buildBroadsideConfig(raw);
}

/** The shipped defaults: what an absent config.yaml means. */
export function defaultBroadsideConfig(): BroadsideConfig {
	return buildBroadsideConfig({});
}

function buildBroadsideConfig(raw: Record<string, unknown>): BroadsideConfig {
	const lenses = Array.isArray(raw.default_lenses)
		? (raw.default_lenses.filter((l): l is BroadsideLensId => BROADSIDE_LENS_IDS.includes(l as BroadsideLensId)))
		: [];
	const rawPricing = (raw.pricing ?? {}) as Record<string, unknown>;
	const inputOverride = typeof rawPricing.input_per_m === "number" ? rawPricing.input_per_m : undefined;
	const outputOverride = typeof rawPricing.output_per_m === "number" ? rawPricing.output_per_m : undefined;
	// A malformed value falls back to the shipped default rather than failing
	// the run: config.yaml is hand-edited, and a typo in a poll budget must not
	// cost a user their batches.
	const flag = (key: string, fallback: boolean): boolean =>
		typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;
	// An override for an unknown lens id is dropped rather than carried: it can
	// only be a typo, and a silently-ignored key that looks applied is worse
	// than one that never appears.
	const lensModels: Partial<Record<BroadsideLensId, string>> = {};
	const rawLensModels = (raw.lens_models ?? {}) as Record<string, unknown>;
	for (const lensId of BROADSIDE_LENS_IDS) {
		const value = rawLensModels[lensId];
		if (typeof value === "string" && value.trim()) lensModels[lensId] = value.trim();
	}
	return {
		model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : BROADSIDE_MODEL,
		apiKey: typeof raw.api_key === "string" ? raw.api_key.trim() : "",
		defaultLenses: lenses.length > 0 ? lenses : [...BROADSIDE_LENS_IDS],
		// Absent: the shipped default. An explicit 0 is "no limit", spelled out
		// on purpose; a negative or non-numeric value is not a limit at all.
		maxCost: typeof raw.max_cost === "number" && raw.max_cost >= 0 ? raw.max_cost : BROADSIDE_DEFAULT_MAX_COST,
		pricing:
			inputOverride !== undefined && outputOverride !== undefined
				? { inputPerM: inputOverride, outputPerM: outputOverride }
				: null,
		lensModels,
		// An escape hatch, not a knob to reach for: a model whose reasoning is
		// worth paying for needs its lens maxTokens raised to cover both the
		// thinking and the answer, or the JSON truncates exactly as before.
		reasoning: parseReasoningConfig(raw.reasoning),
		incremental: flag("incremental", false),
		retryTruncated: flag("retry_truncated", true),
		includeSynthesis: flag("include_synthesis", true),
		includeTriage: flag("include_triage", true),
		waitSeconds: typeof raw.wait_seconds === "number" && raw.wait_seconds > 0 ? raw.wait_seconds : 0,
		redactSecrets: flag("redact_secrets", true),
	};
}
