// File-backed storage for engineering records (E02, #400).
//
// E01 fixed the record shapes, the id grammar, and the path layout; this
// module is only responsible for getting bytes onto disk and back without
// losing or corrupting anyone's history. Its guarantees, and why each one
// exists:
//
//   - **One change never writes into another.** Every path is derived from
//     `engineeringPaths`, and the derived path is re-checked against the
//     namespace root before any write, so a planted symlink cannot redirect
//     one change's write into another's directory or out of the workspace.
//   - **Publication is atomic.** Records land through `atomicWriteFile`, so
//     a reader sees the old bytes or the new ones. A crash between the temp
//     write and the rename leaves no partially-written record visible as
//     state. This is why `.tmp` names are never treated as records.
//   - **Two storage classes, because the contract has two.** `change.json`
//     and `slice.json` are versioned mutable projections: they carry an
//     integer `revision` and are replaced under compare-and-swap on it.
//     Everything under `attempts/` is **create-only** — a snapshot, proof,
//     review or approval is an observation of something that happened, and
//     editing one would be rewriting history rather than recording it. A
//     correction is a new record naming the one it supersedes.
//   - **Replays are free; collisions are loud.** The same idempotency key
//     with the same payload returns the original outcome and writes nothing.
//     The same key with a *different* payload is `idempotency-conflict` —
//     the one case where silently accepting either version would lose data.
//   - **A change's writes serialize.** Compare-and-swap is a read of the
//     current revision followed by a write, and without a lock two writers
//     can both read revision 1, both find it matches, and both write —
//     losing one update while reporting two successes. The lock is per
//     change, so unrelated changes still proceed in parallel.
//   - **Corruption is reported, not swallowed.** Enumeration returns corrupt
//     entries alongside healthy ones. A truncated record must not make its
//     siblings unreadable, and must not vanish quietly either.
//
// The CAS token is the record's own `revision` field, not a content digest:
// the contract defines it that way, and a digest would silently let two
// writers who produced identical bytes both believe they won. Idempotency
// keys still compare content digests, because there the question really is
// "is this the same request again".

import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { acquireLock } from "../status.ts";
import { atomicWriteFile } from "../utils.ts";
import { digestOf } from "./digest.ts";
import { ENGINEERING_NAMESPACE, engineeringPaths, isRecordId } from "./ids.ts";
import type { EngineeringRecord, EngineeringErrorCode, RecordKind } from "./types.ts";
import { validateRecordOfKind } from "./validation.ts";

/**
 * The kinds the contract calls versioned mutable projections. Everything
 * else is an observation under `attempts/` and is create-only.
 */
const MUTABLE_PROJECTIONS = new Set<RecordKind>(["change", "slice"]);

/** A store failure the caller is expected to handle, carrying E01's vocabulary. */
export class StoreError extends Error {
	readonly code: EngineeringErrorCode;
	readonly path?: string;
	constructor(code: EngineeringErrorCode, message: string, path?: string) {
		super(message);
		this.name = "StoreError";
		this.code = code;
		this.path = path;
	}
}

export interface PutOptions {
	/** The revision the caller believes it is replacing. Required to overwrite a projection. */
	ifRevision?: number;
	/** Makes a repeated request a no-op instead of a second write. */
	idempotencyKey?: string;
}

export interface PutOutcome {
	id: string;
	revision: number;
	/** True when an identical request had already been applied. */
	replayed: boolean;
}

export interface GetOutcome<R extends EngineeringRecord = EngineeringRecord> {
	record: R;
	revision: number;
}

export interface ListedChange {
	id: string;
	corrupt: boolean;
	/** Present only when `corrupt`; says what was wrong in the reader's words. */
	reason?: string;
}

/** Where a record of each kind lives, in terms of E01's path grammar. */
function recordPath(kind: RecordKind, id: string, context: { changeId?: string; attemptId?: string }): string {
	switch (kind) {
		case "change":
			return engineeringPaths.changeRecord(id);
		case "slice":
			return engineeringPaths.sliceRecord(requireContext(context.changeId, "slice", "changeId"), id);
		case "attempt":
			return engineeringPaths.attemptRecord(requireContext(context.changeId, "attempt", "changeId"), id);
		case "snapshot":
			return engineeringPaths.snapshotRecord(
				requireContext(context.changeId, "snapshot", "changeId"),
				requireContext(context.attemptId, "snapshot", "attemptId"),
				id,
			);
		case "proof":
			return engineeringPaths.proofRecord(requireContext(context.changeId, "proof", "changeId"), requireContext(context.attemptId, "proof", "attemptId"), id);
		case "review":
			return engineeringPaths.reviewRecord(
				requireContext(context.changeId, "review", "changeId"),
				requireContext(context.attemptId, "review", "attemptId"),
				id,
			);
		case "approval":
			return engineeringPaths.approvalRecord(
				requireContext(context.changeId, "approval", "changeId"),
				requireContext(context.attemptId, "approval", "attemptId"),
				id,
			);
		default:
			throw new StoreError("invalid-request", `no storage path for record kind ${JSON.stringify(kind)}`);
	}
}

function requireContext(value: string | undefined, kind: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new StoreError("invalid-request", `a ${kind} record needs ${field} to know where it lives`);
	}
	return value;
}

/**
 * The change a record belongs to, read from the record itself rather than
 * from the caller — a caller who names the wrong change would otherwise file
 * one change's record in another's directory.
 */
function contextOf(record: EngineeringRecord): { changeId?: string; attemptId?: string } {
	const anyRecord = record as unknown as Record<string, unknown>;
	const changeId = record.kind === "change" ? record.id : (anyRecord.change_id as string | undefined);
	const attemptId = record.kind === "attempt" ? record.id : (anyRecord.attempt_id as string | undefined);
	return { changeId, attemptId };
}

export interface EngineeringStore {
	put(record: EngineeringRecord, options?: PutOptions): Promise<PutOutcome>;
	get<K extends RecordKind>(kind: K, id: string, context?: { changeId?: string; attemptId?: string }): Promise<GetOutcome>;
	listChanges(): Promise<ListedChange[]>;
	/**
	 * Ids of the `slice` or `attempt` records belonging to one change.
	 *
	 * Enumeration belongs here rather than in a caller: every read has to pass
	 * the same containment checks as a `get`, and a caller walking the
	 * directory itself would bypass them. Unparseable entries are skipped
	 * rather than thrown, so one corrupt record cannot make a whole change
	 * unreadable — `listChanges` already reports corruption that way.
	 */
	listIds(kind: "slice" | "attempt", context: { changeId: string }): Promise<string[]>;
	/** Absolute path of the namespace root, for callers that must show it. */
	readonly root: string;
}

/**
 * Opens (creating if needed) the engineering namespace inside a workspace.
 * The directory is created eagerly so that a caller inspecting an untouched
 * workspace sees an empty namespace rather than a missing one — an absent
 * directory and an empty one read very differently to anything enumerating.
 */
export async function openStore(workspaceDir: string): Promise<EngineeringStore> {
	const root = resolve(workspaceDir, ENGINEERING_NAMESPACE);
	await mkdir(root, { recursive: true });
	const realRoot = await realpath(root);

	/**
	 * Resolves a namespace-relative path to an absolute one, refusing
	 * anything that escapes. Both halves matter: the textual check catches a
	 * traversing id before touching the filesystem, and the realpath check
	 * catches a symlink planted in a directory we already created.
	 */
	async function resolveInside(relativePath: string): Promise<string> {
		// `engineeringPaths` speaks POSIX, but callers compose with `join`,
		// which emits `\` on Windows — so the prefix strip below must accept
		// either separator. Without this the namespace prefix went
		// unrecognized on Windows and every locked path resolved to
		// `engineering\engineering\...`, which existed nowhere.
		const posix = relativePath.replace(/\\/g, "/");
		const namespacePrefix = `${ENGINEERING_NAMESPACE}/`;
		const withinNamespace = posix.startsWith(namespacePrefix) ? posix.slice(namespacePrefix.length) : posix;
		const absolute = resolve(realRoot, withinNamespace);
		const rel = relative(realRoot, absolute);
		if (rel.startsWith("..") || rel.startsWith(`${sep}..`) || resolve(realRoot, rel) !== absolute) {
			throw new StoreError("invalid-path", `path escapes the engineering namespace: ${relativePath}`, relativePath);
		}
		// A symlink anywhere along an EXISTING prefix redirects the access
		// even though the textual path looks fine, so the deepest existing
		// ancestor is resolved and re-checked.
		//
		// The LEAF is included, not just its parent: a `change.json` that is
		// itself a symlink to a file outside the namespace was read straight
		// through by `get`, and `listChanges` reported the change healthy.
		// Writes happened to survive it (rename replaces the link rather than
		// following it), which is exactly why checking only the write path
		// missed this — reads were escaping while writes were contained.
		let probe = absolute;
		for (;;) {
			try {
				const real = await realpath(probe);
				const realRel = relative(realRoot, real);
				if (realRel.startsWith("..") || (realRel !== "" && resolve(realRoot, realRel) !== real)) {
					throw new StoreError("invalid-path", `path resolves outside the engineering namespace: ${relativePath}`, relativePath);
				}
				break;
			} catch (error) {
				if (error instanceof StoreError) throw error;
				const next = dirname(probe);
				if (next === probe) break;
				probe = next;
			}
		}
		return absolute;
	}

	/** Where a replayed request's outcome is remembered. */
	async function idempotencyPath(key: string): Promise<string> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
			throw new StoreError("invalid-request", `idempotency key is not a safe file name: ${JSON.stringify(key)}`);
		}
		return await resolveInside(join("idempotency", `${key}.json`));
	}

	async function readRecordFile(absolute: string, kind: RecordKind): Promise<GetOutcome> {
		let text: string;
		try {
			text = await readFile(absolute, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") throw new StoreError("not-found", `no ${kind} record at ${absolute}`);
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new StoreError("invalid-value", `record is not parseable JSON (truncated or corrupt): ${(error as Error).message}`, absolute);
		}
		// No schema-version gate here on purpose. E01's validator checks
		// `schema_version` before any other field and reports
		// `unsupported-schema-version`, so a version check in this module
		// could never fire first — it would be a guard that reads as
		// load-bearing while being unreachable. The behaviour is still
		// asserted in this module's tests, because the store depends on it
		// even though it does not implement it.
		const outcome = validateRecordOfKind(kind, parsed);
		if (outcome.ok === false) {
			throw new StoreError(outcome.errors[0].code, `record failed validation: ${outcome.errors[0].message}`, absolute);
		}
		return { record: outcome.value as EngineeringRecord, revision: (outcome.value as { revision?: number }).revision ?? 1 };
	}

	return {
		root: realRoot,

		async put(record, options = {}) {
			const validated = validateRecordOfKind(record.kind, record);
			if (validated.ok === false) {
				throw new StoreError(validated.errors[0].code, `refusing to store an invalid record: ${validated.errors[0].message}`);
			}
			const stored = validated.value as EngineeringRecord;
			const contentDigest = digestOf(stored);
			const mutable = MUTABLE_PROJECTIONS.has(record.kind);
			const revisionOf = (value: unknown): number | undefined => (value as { revision?: number } | null)?.revision;

			const absolute = await resolveInside(recordPath(record.kind, record.id, contextOf(stored)));
			// The compare and the write must not be separable: two writers
			// reading revision 1 concurrently would both find their
			// ifRevision satisfied and both write, and the store would report
			// two winners for one revision.
			const owningChange = contextOf(stored).changeId ?? record.id;
			await mkdir(await resolveInside(engineeringPaths.changesRoot()), { recursive: true });
			// An idempotency key is GLOBAL while the change lock is not, so two
			// puts to DIFFERENT changes sharing one key never serialized and
			// both wrote: the conflict went unreported and the surviving
			// receipt named only one of them, so retrying the other re-ran it.
			// The key is locked first and always in that order, so the two
			// locks cannot deadlock against each other.
			let keyLock: Awaited<ReturnType<typeof acquireLock>> | null = null;
			if (options.idempotencyKey !== undefined) {
				// Validates the key before it is used as a file name.
				const keyPath = await idempotencyPath(options.idempotencyKey);
				await mkdir(dirname(keyPath), { recursive: true });
				keyLock = await acquireLock(`${keyPath.slice(0, -5)}.lock`, { timeoutMs: 10_000 });
			}
			try {
			if (options.idempotencyKey !== undefined) {
				const keyPath = await idempotencyPath(options.idempotencyKey);
				const existing = await readFile(keyPath, "utf8").catch(() => null);
				if (existing !== null) {
					const remembered = JSON.parse(existing) as { id: string; revision: number; digest: string };
					// Same key, same bytes: the caller is retrying, not
					// changing their mind. Same key, different bytes: one of
					// the two would be lost whichever way we chose.
					if (remembered.digest !== contentDigest) {
						throw new StoreError(
							"idempotency-conflict",
							`idempotency key ${JSON.stringify(options.idempotencyKey)} was used for a different payload`,
						);
					}
					return { id: remembered.id, revision: remembered.revision, replayed: true };
				}
			}
			const lock = await acquireLock(await resolveInside(join(engineeringPaths.changesRoot(), `${owningChange}.lock`)));
			try {
			const current = await readFile(absolute, "utf8").catch(() => null);
			if (current !== null) {
				// Create-only kinds: an observation already on disk is not
				// replaceable at all, whatever revision the caller offers.
				if (!mutable) {
					throw new StoreError(
						"invalid-state",
						`${record.kind} ${record.id} is already published and observations are immutable; record a new one that supersedes it`,
						absolute,
					);
				}
				const currentRevision = revisionOf(JSON.parse(current));
				if (options.ifRevision === undefined) {
					throw new StoreError("invalid-state", `${record.kind} ${record.id} already exists; pass ifRevision to replace it`, absolute);
				}
				if (options.ifRevision !== currentRevision) {
					throw new StoreError("stale-revision", `expected revision ${options.ifRevision} but the stored record is at ${currentRevision}`, absolute);
				}
				// Strictly greater, not merely different. Accepting a LOWER
				// revision turns compare-and-swap into an ABA race: roll the
				// stored record back to 1 and every writer still holding
				// `ifRevision: 1` — including one stalled since before the
				// intervening updates — passes its check and overwrites work
				// it never saw, with no error reported to anyone.
				const proposed = revisionOf(stored);
				if (typeof proposed !== "number" || proposed <= (currentRevision ?? 0)) {
					throw new StoreError("invalid-value", `a replacement must advance revision past ${currentRevision}, got ${proposed}`, absolute);
				}
			} else if (options.ifRevision !== undefined) {
				throw new StoreError("not-found", `cannot replace ${record.kind} ${record.id}: it does not exist`, absolute);
			}

			await mkdir(dirname(absolute), { recursive: true });
			// Re-resolved after mkdir: the directory did not exist when it was
			// first checked, so this is the first moment its real identity can
			// be confirmed.
			await resolveInside(recordPath(record.kind, record.id, contextOf(stored)));
			await atomicWriteFile(absolute, `${JSON.stringify(stored, null, "\t")}\n`);

			const revision = revisionOf(stored) ?? 1;
			if (options.idempotencyKey !== undefined) {
				const keyPath = await idempotencyPath(options.idempotencyKey);
				await mkdir(dirname(keyPath), { recursive: true });
				await atomicWriteFile(keyPath, `${JSON.stringify({ id: record.id, revision, digest: contentDigest })}\n`);
			}
			return { id: record.id, revision, replayed: false };
			} finally {
				await lock.release();
			}
			} finally {
				await keyLock?.release();
			}
		},

		async get(kind, id, context = {}) {
			const absolute = await resolveInside(recordPath(kind, id, context));
			return await readRecordFile(absolute, kind);
		},

		async listIds(kind: "slice" | "attempt", context: { changeId: string }) {
			// Both kinds are one directory-per-record under the change, so the
			// id IS the directory name. Validate each one through the same id
			// grammar a write would use: a directory planted by hand with a
			// traversing name must not come back as an id.
			const relative =
				kind === "slice"
					? `${engineeringPaths.changeDir(context.changeId)}/slices`
					: `${engineeringPaths.changeDir(context.changeId)}/attempts`;
			const dir = await resolveInside(relative);
			const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
			const ids: string[] = [];
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				// Not an id this contract could have written: ignore it rather
				// than letting a hand-planted directory break enumeration.
				if (isRecordId(entry.name, kind)) ids.push(entry.name);
			}
			return ids.sort();
		},

		async listChanges() {
			const changesRoot = await resolveInside(engineeringPaths.changesRoot());
			const entries = await readdir(changesRoot, { withFileTypes: true }).catch(() => []);
			const listed: ListedChange[] = [];
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				try {
					await readRecordFile(await resolveInside(engineeringPaths.changeRecord(entry.name)), "change");
					listed.push({ id: entry.name, corrupt: false });
				} catch (error) {
					// Reported, never skipped: a corrupt record that vanishes
					// from the listing is indistinguishable from one that was
					// never written, which is how history goes missing
					// quietly.
					listed.push({ id: entry.name, corrupt: true, reason: error instanceof Error ? error.message : String(error) });
				}
			}
			return listed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		},
	};
}
