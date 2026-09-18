// Record identity and the engineering namespace layout (E01, #399).
//
// IDs are opaque and path-safe by construction: a fixed three-letter prefix
// per kind, an underscore, and 24 lowercase hex characters (96 bits from the
// core's CSPRNG). The prefix lets a validator reject a `change_id` that names
// a slice before any lookup. Slugs and titles are display metadata and never
// become directory names; every path under `.codecarto/engineering/` is built
// from an ID that passed {@link isRecordId}, so traversal and separator
// tricks have nowhere to enter.

import { randomBytes } from "node:crypto";
import { RECORD_ID_PREFIXES, type IdentifiedKind, type RecordId } from "./types.ts";

const ID_BODY = /^[0-9a-f]{24}$/;
const ID_PATTERN = /^([a-z]{3})_([0-9a-f]{24})$/;
const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const MAX_PATH_LENGTH = 4096;

const PREFIX_TO_KIND: ReadonlyMap<string, IdentifiedKind> = new Map(
	(Object.entries(RECORD_ID_PREFIXES) as Array<[IdentifiedKind, string]>).map(([kind, prefix]) => [prefix, kind]),
);

/** Whether `value` is a well-formed ID of `kind` (or of any kind when omitted). */
export function isRecordId(value: unknown, kind?: IdentifiedKind): value is RecordId {
	if (typeof value !== "string") return false;
	const match = ID_PATTERN.exec(value);
	if (!match) return false;
	const found = PREFIX_TO_KIND.get(match[1]);
	if (!found) return false;
	return kind === undefined || found === kind;
}

/** The kind an ID names, or null when it is not a well-formed ID. */
export function recordKindOfId(value: unknown): IdentifiedKind | null {
	if (typeof value !== "string") return null;
	const match = ID_PATTERN.exec(value);
	return match ? (PREFIX_TO_KIND.get(match[1]) ?? null) : null;
}

/** Builds an ID from a hex body; the body must already be 24 lowercase hex characters. */
export function formatRecordId(kind: IdentifiedKind, hexBody: string): RecordId {
	if (!ID_BODY.test(hexBody)) throw new Error(`Record id body must be 24 lowercase hex characters, got ${JSON.stringify(hexBody)}`);
	return `${RECORD_ID_PREFIXES[kind]}_${hexBody}`;
}

/** A fresh ID from the CSPRNG. Together with {@link newNonce}, the only non-pure exports of the engineering modules. */
export function newRecordId(kind: IdentifiedKind): RecordId {
	return formatRecordId(kind, randomBytes(12).toString("hex"));
}

/** A fresh single-use acceptance nonce: 32 lowercase hex characters. */
export function newNonce(): string {
	return randomBytes(16).toString("hex");
}

export function isNonce(value: unknown): value is string {
	return typeof value === "string" && NONCE_PATTERN.test(value);
}

/** Change-local identifiers for scenarios, obligations, and objections. Never used as a path. */
export function isLocalId(value: unknown): value is string {
	return typeof value === "string" && LOCAL_ID_PATTERN.test(value);
}

function isPathShaped(value: unknown, allowGlob: boolean): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
	if (value.startsWith("/") || value.includes("\\") || DRIVE_PREFIX.test(value) || CONTROL_CHARS.test(value)) return false;
	if (!allowGlob && value.includes("*")) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A repository-relative POSIX path as stored in manifests and artifact
 * references: non-empty, `/`-separated, no empty, `.`, or `..` segment, no
 * leading `/`, no backslash, no `*`, no NUL or other control character, no
 * Windows drive prefix, at most 4096 characters. `~` is an ordinary character.
 */
export function isRepoRelativePath(value: unknown): value is string {
	return isPathShaped(value, false);
}

/** A {@link isRepoRelativePath} that may also carry `*` and `**` glob segments. */
export function isScopePattern(value: unknown): value is string {
	return isPathShaped(value, true);
}

/** The workspace-relative root of the engineering namespace, under `.codecarto/`. */
export const ENGINEERING_NAMESPACE = "engineering";

function assertId(value: string, kind: IdentifiedKind): string {
	if (!isRecordId(value, kind)) throw new Error(`Not a ${kind} id: ${JSON.stringify(value)}`);
	return value;
}

/**
 * Workspace-relative paths of the v1 layout. Every function throws on an ID
 * that fails the grammar, so a caller cannot build a path from a display
 * string. These are the only paths the engineering namespace uses:
 *
 *   engineering/changes/<change-id>/change.json
 *   engineering/changes/<change-id>/brief.md
 *   engineering/changes/<change-id>/plan.md
 *   engineering/changes/<change-id>/slices/<slice-id>/slice.json
 *   engineering/changes/<change-id>/attempts/<attempt-id>/attempt.json
 *   engineering/changes/<change-id>/attempts/<attempt-id>/snapshots/<snapshot-id>.json
 *   engineering/changes/<change-id>/attempts/<attempt-id>/proofs/<proof-id>.json
 *   engineering/changes/<change-id>/attempts/<attempt-id>/reviews/<review-id>.json
 *   engineering/changes/<change-id>/attempts/<attempt-id>/approvals/<approval-id>.json
 *   engineering/changes/<change-id>/attempts/<attempt-id>/requests/<request-id>.json
 *   engineering/changes/<change-id>/attempts/<attempt-id>/artifacts/<artifact-id>
 */
export const engineeringPaths = {
	changesRoot: (): string => `${ENGINEERING_NAMESPACE}/changes`,
	changeDir: (changeId: string): string => `${ENGINEERING_NAMESPACE}/changes/${assertId(changeId, "change")}`,
	changeRecord: (changeId: string): string => `${engineeringPaths.changeDir(changeId)}/change.json`,
	brief: (changeId: string): string => `${engineeringPaths.changeDir(changeId)}/brief.md`,
	plan: (changeId: string): string => `${engineeringPaths.changeDir(changeId)}/plan.md`,
	sliceRecord: (changeId: string, sliceId: string): string => `${engineeringPaths.changeDir(changeId)}/slices/${assertId(sliceId, "slice")}/slice.json`,
	attemptDir: (changeId: string, attemptId: string): string => `${engineeringPaths.changeDir(changeId)}/attempts/${assertId(attemptId, "attempt")}`,
	attemptRecord: (changeId: string, attemptId: string): string => `${engineeringPaths.attemptDir(changeId, attemptId)}/attempt.json`,
	snapshotRecord: (changeId: string, attemptId: string, snapshotId: string): string =>
		`${engineeringPaths.attemptDir(changeId, attemptId)}/snapshots/${assertId(snapshotId, "snapshot")}.json`,
	proofRecord: (changeId: string, attemptId: string, proofId: string): string =>
		`${engineeringPaths.attemptDir(changeId, attemptId)}/proofs/${assertId(proofId, "proof")}.json`,
	reviewRecord: (changeId: string, attemptId: string, reviewId: string): string =>
		`${engineeringPaths.attemptDir(changeId, attemptId)}/reviews/${assertId(reviewId, "review")}.json`,
	approvalRecord: (changeId: string, attemptId: string, approvalId: string): string =>
		`${engineeringPaths.attemptDir(changeId, attemptId)}/approvals/${assertId(approvalId, "approval")}.json`,
	acceptanceRequest: (changeId: string, attemptId: string, requestId: string): string =>
		`${engineeringPaths.attemptDir(changeId, attemptId)}/requests/${assertId(requestId, "acceptance-request")}.json`,
	artifact: (changeId: string, attemptId: string, artifactId: string): string =>
		`${engineeringPaths.attemptDir(changeId, attemptId)}/artifacts/${assertId(artifactId, "artifact")}`,
} as const;
