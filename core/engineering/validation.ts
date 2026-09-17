// Pure validators for the v1 engineering contract (E01, #399).
//
// Everything here is a function of its arguments: no file is read, no
// command runs, no host is consulted, and nothing is written. The store
// (E02), the snapshot collector (E03), the proof ingester (E05), the gate
// (E06), and the MCP adapter (E07) all call these before trusting a record,
// and they get the same answer for the same bytes every time — errors are
// collected in traversal order, so two runs over one value produce one list.
//
// Three layers, each stricter than the last:
//
//   validateRecord        one record's shape, enums, grammar, and its own
//                         cross-field rules (a blocked attempt has a reason;
//                         a snapshot's digest matches its identity fields)
//   validateChangeBundle  one change's records against each other: every
//                         reference resolves inside the change, roles match,
//                         digests agree
//   evaluateApprovalReceipt
//                         one approval against the acceptance request the
//                         core issued: nonce, bindings, expiry, channel
//
// Structure is not semantics. Passing all three says the records are
// well-formed and consistent; it does not say the code is correct, the tests
// are meaningful, or that a person meant what the receipt says.

import { compareUtf8, computeInputDigest, computePresentationDigest, computeSnapshotDigest, isDigest } from "./digest.ts";
import { isLocalId, isNonce, isRecordId, isRepoRelativePath, isScopePattern } from "./ids.ts";
import {
	APPROVAL_CHANNELS,
	APPROVAL_DECISIONS,
	ATTEMPT_OUTCOMES,
	ATTEMPT_OUTCOMES_REQUIRING_CANDIDATE,
	CHANGE_ACTIONS,
	CHANGE_MODES,
	CHANGE_STATES,
	CHECK_KINDS,
	COLLECTORS,
	COLLECTOR_RANK,
	ENGINEERING_SCHEMA_VERSION,
	EXCLUSION_REASONS,
	MUTATING_CHANGE_ACTIONS,
	OBJECTION_DISPOSITIONS,
	OBJECTION_SEVERITIES,
	OBSERVED_COLLECTORS,
	PROOF_RESULTS,
	RECEIPT_AUTHENTICATIONS,
	RECORD_KINDS,
	REVIEWER_CONTEXTS,
	REVIEWER_SEPARATIONS,
	SCENARIO_KINDS,
	SLICE_STATES,
	SNAPSHOT_ROLES,
	SNAPSHOT_STABILITIES,
	TRUSTED_APPROVAL_CHANNELS,
	VCS_KINDS,
	type AcceptancePresentation,
	type AcceptanceRequest,
	type ApprovalRecord,
	type AttemptRecord,
	type ChangeRecord,
	type ChangeRequest,
	type Collector,
	type EngineeringError,
	type EngineeringErrorCode,
	type EngineeringRecord,
	type IdentifiedKind,
	type ProofRecord,
	type RecordKind,
	type ReviewRecord,
	type SliceRecord,
	type SnapshotRecord,
	type ValidationOutcome,
} from "./types.ts";

// ---------- collectors ----------

/** Whether a proof by `actual` discharges an obligation whose minimum is `minimum`. `agent-claimed` never does. */
export function collectorSatisfies(actual: Collector, minimum: Collector): boolean {
	if (actual === "agent-claimed" || minimum === "agent-claimed") return false;
	return COLLECTOR_RANK[actual] >= COLLECTOR_RANK[minimum];
}

// ---------- error collection ----------

class Errors {
	readonly list: EngineeringError[] = [];
	fail(path: string, code: EngineeringErrorCode, message: string): void {
		this.list.push({ code, path, message });
	}
	get ok(): boolean {
		return this.list.length === 0;
	}
}

function outcome<T>(errors: Errors, value: T): ValidationOutcome<T> {
	return errors.ok ? { ok: true, value } : { ok: false, errors: errors.list };
}

/** `/a/b` + `c` → `/a/b/c`; the root is `/`. */
function at(path: string, key: string | number): string {
	return path === "/" ? `/${key}` : `${path}/${key}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

// ---------- field checks ----------

type Check = (value: unknown, path: string, errors: Errors) => void;
type Shape = Record<string, { required: boolean; check: Check }>;

const req = (check: Check) => ({ required: true, check });
const opt = (check: Check) => ({ required: false, check });

/**
 * Checks `value` is a plain object with exactly the fields `shape` names:
 * every required one present, every present one passing its check, and no
 * other keys. Returns the object when it is one, for the caller's
 * cross-field rules; those rules must tolerate fields that failed.
 */
function checkObject(value: unknown, path: string, shape: Shape, errors: Errors): Record<string, unknown> | null {
	if (!isPlainObject(value)) {
		errors.fail(path, "invalid-type", "expected an object");
		return null;
	}
	for (const [key, spec] of Object.entries(shape)) {
		if (!(key in value)) {
			if (spec.required) errors.fail(at(path, key), "missing-field", `missing required field ${key}`);
			continue;
		}
		if (value[key] === undefined) {
			if (spec.required) errors.fail(at(path, key), "missing-field", `missing required field ${key}`);
			continue;
		}
		spec.check(value[key], at(path, key), errors);
	}
	for (const key of Object.keys(value)) {
		if (!(key in shape)) errors.fail(at(path, key), "unknown-field", `unknown field ${key}`);
	}
	return value;
}

const string: Check = (value, path, errors) => {
	if (typeof value !== "string") errors.fail(path, "invalid-type", "expected a string");
};

const nonEmptyString: Check = (value, path, errors) => {
	if (typeof value !== "string") errors.fail(path, "invalid-type", "expected a string");
	else if (value.trim().length === 0) errors.fail(path, "invalid-value", "expected a non-empty string");
};

const boolean: Check = (value, path, errors) => {
	if (typeof value !== "boolean") errors.fail(path, "invalid-type", "expected a boolean");
};

const nonNegativeInteger: Check = (value, path, errors) => {
	if (typeof value !== "number" || !Number.isInteger(value)) errors.fail(path, "invalid-type", "expected an integer");
	else if (value < 0) errors.fail(path, "invalid-value", "expected a non-negative integer");
};

const integer: Check = (value, path, errors) => {
	if (typeof value !== "number" || !Number.isInteger(value)) errors.fail(path, "invalid-type", "expected an integer");
};

const revision: Check = (value, path, errors) => {
	if (typeof value !== "number" || !Number.isInteger(value)) errors.fail(path, "invalid-type", "expected an integer");
	else if (value < 1) errors.fail(path, "invalid-value", "revisions start at 1");
};

const oneOf =
	(values: readonly string[]): Check =>
	(value, path, errors) => {
		if (typeof value !== "string") errors.fail(path, "invalid-type", "expected a string");
		else if (!values.includes(value)) errors.fail(path, "invalid-enum", `expected one of ${values.join(", ")}`);
	};

const recordId =
	(kind: IdentifiedKind): Check =>
	(value, path, errors) => {
		if (!isRecordId(value, kind)) errors.fail(path, "invalid-id", `expected a ${kind} id`);
	};

const localId: Check = (value, path, errors) => {
	if (!isLocalId(value)) errors.fail(path, "invalid-local-id", "expected a local id: [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
};

const digest: Check = (value, path, errors) => {
	if (!isDigest(value)) errors.fail(path, "invalid-digest", "expected sha256:<64 lowercase hex>");
};

const nonce: Check = (value, path, errors) => {
	if (!isNonce(value)) errors.fail(path, "invalid-value", "expected a nonce of 32 lowercase hex characters");
};

const repoRelativePath: Check = (value, path, errors) => {
	if (!isRepoRelativePath(value)) errors.fail(path, "invalid-path", "expected a repository-relative POSIX path");
};

const workingDirectory: Check = (value, path, errors) => {
	if (value !== "." && !isRepoRelativePath(value)) errors.fail(path, "invalid-path", "expected `.` or a repository-relative POSIX path");
};

const scopePattern: Check = (value, path, errors) => {
	if (!isScopePattern(value)) errors.fail(path, "invalid-path", "expected a repository-relative path or glob");
};

const GIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const gitHash: Check = (value, path, errors) => {
	if (typeof value !== "string" || !GIT_HASH.test(value)) errors.fail(path, "invalid-value", "expected a full lowercase hex commit hash");
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** RFC 3339, UTC only, with a `Z` suffix, and a real calendar instant. */
export function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) return false;
	// Date.parse accepts 2026-02-30; round-tripping the date part catches it.
	return new Date(ms).toISOString().slice(0, 10) === value.slice(0, 10);
}
const timestamp: Check = (value, path, errors) => {
	if (!isTimestamp(value)) errors.fail(path, "invalid-timestamp", "expected an RFC 3339 UTC timestamp ending in Z");
};

/** Compares two timestamps that already passed {@link isTimestamp}. */
function before(a: string, b: string): boolean {
	return Date.parse(a) < Date.parse(b);
}

const arrayOf =
	(item: Check, options: { nonEmpty?: boolean } = {}): Check =>
	(value, path, errors) => {
		if (!Array.isArray(value)) {
			errors.fail(path, "invalid-type", "expected an array");
			return;
		}
		if (options.nonEmpty && value.length === 0) errors.fail(path, "invalid-value", "expected at least one entry");
		value.forEach((entry, i) => item(entry, at(path, i), errors));
	};

const objectOf =
	(shape: Shape, post?: (obj: Record<string, unknown>, path: string, errors: Errors) => void): Check =>
	(value, path, errors) => {
		const obj = checkObject(value, path, shape, errors);
		if (obj && post) post(obj, path, errors);
	};

/** Flags the second and later occurrences of a key among `items[i][key]`. */
function uniqueBy(items: unknown, path: string, key: string, errors: Errors): void {
	if (!Array.isArray(items)) return;
	const seen = new Set<string>();
	items.forEach((item, i) => {
		const value = isPlainObject(item) ? item[key] : undefined;
		if (typeof value !== "string") return;
		if (seen.has(value)) errors.fail(at(at(path, i), key), "duplicate-id", `duplicate ${key} ${value}`);
		seen.add(value);
	});
}

function uniqueStrings(items: unknown, path: string, errors: Errors): void {
	if (!Array.isArray(items)) return;
	const seen = new Set<string>();
	items.forEach((item, i) => {
		if (typeof item !== "string") return;
		if (seen.has(item)) errors.fail(at(path, i), "duplicate-id", `duplicate entry ${item}`);
		seen.add(item);
	});
}

function requiredWhen(obj: Record<string, unknown>, path: string, key: string, condition: boolean, why: string, errors: Errors): void {
	const present = obj[key] !== undefined;
	if (condition && !present) errors.fail(at(path, key), "missing-field", `${key} is required ${why}`);
	if (!condition && present) errors.fail(at(path, key), "invalid-value", `${key} is only allowed ${why}`);
}

// ---------- shared sub-shapes ----------

const REFERENCE_SHAPE: Shape = { id: req(nonEmptyString), version: req(nonEmptyString), digest: req(digest) };

const BASELINE_SHAPE: Shape = { vcs: req(oneOf(VCS_KINDS)), head: opt(gitHash), description: opt(nonEmptyString) };
const baselinePost = (obj: Record<string, unknown>, path: string, errors: Errors) => {
	if (obj.vcs === "git" || obj.vcs === "none") requiredWhen(obj, path, "head", obj.vcs === "git", "when vcs is git", errors);
};

const SCENARIO_SHAPE: Shape = { id: req(localId), kind: req(oneOf(SCENARIO_KINDS)), description: req(nonEmptyString) };

const OBLIGATION_SHAPE: Shape = {
	id: req(localId),
	scenario_id: req(localId),
	check_kind: req(oneOf(CHECK_KINDS)),
	description: req(nonEmptyString),
	minimum_collector: req(oneOf(OBSERVED_COLLECTORS)),
};

const PERMITTED_SCOPE_SHAPE: Shape = { paths: req(arrayOf(scopePattern)), description: opt(nonEmptyString) };

const REPOSITORY_SHAPE: Shape = { vcs: req(oneOf(VCS_KINDS)), head: opt(gitHash), dirty: req(boolean) };

const FILE_ENTRY_SHAPE: Shape = {
	path: req(repoRelativePath),
	type: req(oneOf(["file"])),
	digest: req(digest),
	executable: req(boolean),
	size: req(nonNegativeInteger),
};
const SYMLINK_ENTRY_SHAPE: Shape = { path: req(repoRelativePath), type: req(oneOf(["symlink"])), target: req(nonEmptyString) };
const manifestEntry: Check = (value, path, errors) => {
	if (!isPlainObject(value)) {
		errors.fail(path, "invalid-type", "expected an object");
		return;
	}
	if (value.type === "symlink") checkObject(value, path, SYMLINK_ENTRY_SHAPE, errors);
	else if (value.type === "file") checkObject(value, path, FILE_ENTRY_SHAPE, errors);
	else errors.fail(at(path, "type"), "invalid-enum", "expected file or symlink");
};
const manifest: Check = (value, path, errors) => {
	arrayOf(manifestEntry)(value, path, errors);
	if (!Array.isArray(value)) return;
	let previous: string | null = null;
	value.forEach((entry, i) => {
		const entryPath = isPlainObject(entry) && typeof entry.path === "string" ? entry.path : null;
		if (entryPath === null) return;
		if (previous !== null) {
			const order = compareUtf8(previous, entryPath);
			if (order === 0) errors.fail(at(at(path, i), "path"), "duplicate-id", `duplicate manifest path ${entryPath}`);
			else if (order > 0) errors.fail(at(at(path, i), "path"), "invalid-value", "manifest paths must ascend in UTF-8 byte order");
		}
		previous = entryPath;
	});
};

const COVERAGE_SHAPE: Shape = {
	excluded: req(arrayOf(objectOf({ pattern: req(scopePattern), reason: req(oneOf(EXCLUSION_REASONS)) }))),
	uncovered_relevant_inputs: req(arrayOf(repoRelativePath)),
};

const ARTIFACT_SHAPE: Shape = {
	id: req(recordId("artifact")),
	label: req(nonEmptyString),
	media_type: opt(nonEmptyString),
	raw_digest: req(digest),
	raw_size: req(nonNegativeInteger),
	sanitized_digest: opt(digest),
	retained: req(boolean),
};

const CHECK_SHAPE: Shape = { kind: req(oneOf(CHECK_KINDS)), command: opt(nonEmptyString), procedure: opt(nonEmptyString), working_directory: opt(workingDirectory) };

const ENVIRONMENT_SHAPE: Shape = { summary: req(nonEmptyString), digest: req(digest) };

const PROVENANCE_SHAPE: Shape = { source: req(nonEmptyString), run_reference: opt(nonEmptyString) };

const REVIEWER_SHAPE: Shape = {
	context: req(oneOf(REVIEWER_CONTEXTS)),
	separation: req(oneOf(REVIEWER_SEPARATIONS)),
	label: req(nonEmptyString),
	note: opt(nonEmptyString),
};

const OBJECTION_SHAPE: Shape = {
	id: req(localId),
	severity: req(oneOf(OBJECTION_SEVERITIES)),
	statement: req(nonEmptyString),
	evidence: req(nonEmptyString),
	disposition: req(oneOf(OBJECTION_DISPOSITIONS)),
	resolution_evidence: opt(nonEmptyString),
	disposition_note: opt(nonEmptyString),
};

const RECEIPT_SHAPE: Shape = {
	request_id: req(recordId("acceptance-request")),
	nonce: req(nonce),
	presentation_digest: req(digest),
	channel: req(oneOf(APPROVAL_CHANNELS)),
	host: req(nonEmptyString),
	host_session: opt(nonEmptyString),
	issued_at: req(timestamp),
	responded_at: req(timestamp),
	authenticated: req(oneOf(RECEIPT_AUTHENTICATIONS)),
	attestation: req(nonEmptyString),
};

const PRESENTATION_SHAPE: Shape = {
	title: req(nonEmptyString),
	requested_outcome: req(nonEmptyString),
	slice_deliverable: req(nonEmptyString),
	candidate_summary: req(nonEmptyString),
	proof_summary: req(arrayOf(objectOf({ obligation_id: req(localId), result: req(oneOf(PROOF_RESULTS)), collector: req(oneOf(COLLECTORS)) }))),
	review_summary: req(arrayOf(objectOf({ review_id: req(recordId("review")), separation: req(oneOf(REVIEWER_SEPARATIONS)), remaining_blockers: req(nonNegativeInteger) }))),
	limitations: req(arrayOf(nonEmptyString)),
};

// ---------- record shapes and cross-field rules ----------

function envelope(kind: RecordKind, extra: Shape): Shape {
	return {
		schema_version: req(() => {}), // checked first by the version gate; listed so it is not an unknown field
		kind: req(oneOf([kind])),
		id: req(recordId(kind)),
		created_at: req(timestamp),
		...extra,
	};
}

const CHANGE_BODY: Shape = {
	revision: req(revision),
	title: req(nonEmptyString),
	mode: req(oneOf(CHANGE_MODES)),
	state: req(oneOf(CHANGE_STATES)),
	requested_outcome: req(nonEmptyString),
	baseline: req(objectOf(BASELINE_SHAPE, baselinePost)),
	scope: req(objectOf({ in_scope: req(arrayOf(nonEmptyString)), non_goals: req(arrayOf(nonEmptyString)) })),
	preserved_contracts: req(arrayOf(nonEmptyString)),
	acceptance_scenarios: req(arrayOf(objectOf(SCENARIO_SHAPE))),
	references: req(arrayOf(objectOf(REFERENCE_SHAPE))),
	block_reason: opt(nonEmptyString),
	updated_at: req(timestamp),
};
function changePost(obj: Record<string, unknown>, path: string, errors: Errors): void {
	uniqueBy(obj.acceptance_scenarios, at(path, "acceptance_scenarios"), "id", errors);
	if (typeof obj.state === "string" && CHANGE_STATES.includes(obj.state as never)) {
		requiredWhen(obj, path, "block_reason", obj.state === "blocked", "when state is blocked", errors);
		if (obj.state !== "draft" && Array.isArray(obj.acceptance_scenarios) && obj.acceptance_scenarios.length === 0) {
			errors.fail(at(path, "acceptance_scenarios"), "invalid-value", "a change past draft declares at least one acceptance scenario");
		}
	}
	if (isTimestamp(obj.created_at) && isTimestamp(obj.updated_at) && before(obj.updated_at, obj.created_at)) {
		errors.fail(at(path, "updated_at"), "invalid-value", "updated_at precedes created_at");
	}
}

const SLICE_INPUT_BODY: Shape = {
	title: req(nonEmptyString),
	deliverable: req(nonEmptyString),
	scenario_ids: req(arrayOf(localId, { nonEmpty: true })),
	depends_on: req(arrayOf(recordId("slice"))),
	proof_obligations: req(arrayOf(objectOf(OBLIGATION_SHAPE), { nonEmpty: true })),
	permitted_scope: req(objectOf(PERMITTED_SCOPE_SHAPE)),
};
const SLICE_BODY: Shape = {
	change_id: req(recordId("change")),
	revision: req(revision),
	...SLICE_INPUT_BODY,
	state: req(oneOf(SLICE_STATES)),
	block_reason: opt(nonEmptyString),
	updated_at: req(timestamp),
};
function slicePost(obj: Record<string, unknown>, path: string, errors: Errors): void {
	uniqueStrings(obj.scenario_ids, at(path, "scenario_ids"), errors);
	uniqueStrings(obj.depends_on, at(path, "depends_on"), errors);
	uniqueBy(obj.proof_obligations, at(path, "proof_obligations"), "id", errors);
	if (Array.isArray(obj.depends_on) && typeof obj.id === "string") {
		obj.depends_on.forEach((dep, i) => {
			if (dep === obj.id) errors.fail(at(at(path, "depends_on"), i), "invalid-value", "a slice cannot depend on itself");
		});
	}
	const scenarios = new Set(Array.isArray(obj.scenario_ids) ? obj.scenario_ids.filter((s): s is string => typeof s === "string") : []);
	if (Array.isArray(obj.proof_obligations)) {
		obj.proof_obligations.forEach((obligation, i) => {
			if (!isPlainObject(obligation) || typeof obligation.scenario_id !== "string") return;
			if (!scenarios.has(obligation.scenario_id)) {
				errors.fail(at(at(at(path, "proof_obligations"), i), "scenario_id"), "unknown-reference", `obligation names scenario ${obligation.scenario_id}, which the slice does not prove`);
			}
		});
	}
	if (typeof obj.state === "string" && SLICE_STATES.includes(obj.state as never)) {
		requiredWhen(obj, path, "block_reason", obj.state === "blocked", "when state is blocked", errors);
	}
}

const INPUTS_BODY: Shape = { brief_digest: req(digest), plan_digest: req(digest), references: req(arrayOf(objectOf(REFERENCE_SHAPE))) };
function inputsPost(obj: Record<string, unknown>, path: string, errors: Errors, expectDigest: boolean): void {
	const refs = obj.references;
	if (!Array.isArray(refs)) return;
	let previous: { id: string; version: string } | null = null;
	let sorted = true;
	refs.forEach((ref, i) => {
		if (!isPlainObject(ref) || typeof ref.id !== "string" || typeof ref.version !== "string") {
			sorted = false;
			return;
		}
		if (previous) {
			const order = compareUtf8(previous.id, ref.id) || compareUtf8(previous.version, ref.version);
			if (order === 0) {
				errors.fail(at(at(path, "references"), i), "duplicate-id", `duplicate reference ${ref.id}@${ref.version}`);
				sorted = false;
			} else if (order > 0) {
				errors.fail(at(at(path, "references"), i), "invalid-value", "references must be sorted by id then version in UTF-8 byte order");
				sorted = false;
			}
		}
		previous = { id: ref.id, version: ref.version };
	});
	if (expectDigest && sorted && isDigest(obj.brief_digest) && isDigest(obj.plan_digest) && isDigest(obj.digest)) {
		const expected = computeInputDigest({ brief_digest: obj.brief_digest, plan_digest: obj.plan_digest, references: refs as never });
		if (expected !== obj.digest) errors.fail(at(path, "digest"), "digest-mismatch", `input digest is ${obj.digest}, recomputed ${expected}`);
	}
}

const ATTEMPT_BODY: Shape = {
	change_id: req(recordId("change")),
	slice_id: req(recordId("slice")),
	inputs: req(objectOf({ ...INPUTS_BODY, digest: req(digest) }, (obj, path, errors) => inputsPost(obj, path, errors, true))),
	baseline_snapshot_id: req(recordId("snapshot")),
	candidate_snapshot_id: opt(recordId("snapshot")),
	outcome: req(oneOf(ATTEMPT_OUTCOMES)),
	started_at: req(timestamp),
	ended_at: opt(timestamp),
	parent_attempt_id: opt(recordId("attempt")),
	supersedes_attempt_id: opt(recordId("attempt")),
	superseded_by_attempt_id: opt(recordId("attempt")),
	block_reason: opt(nonEmptyString),
	failure_summary: opt(nonEmptyString),
};
function attemptPost(obj: Record<string, unknown>, path: string, errors: Errors): void {
	const outcome = obj.outcome;
	if (typeof outcome !== "string" || !ATTEMPT_OUTCOMES.includes(outcome as never)) return;
	requiredWhen(obj, path, "ended_at", outcome !== "running", "once the attempt is no longer running", errors);
	requiredWhen(obj, path, "block_reason", outcome === "blocked", "when outcome is blocked", errors);
	requiredWhen(obj, path, "superseded_by_attempt_id", outcome === "superseded", "when outcome is superseded", errors);
	if (ATTEMPT_OUTCOMES_REQUIRING_CANDIDATE.includes(outcome as never) && obj.candidate_snapshot_id === undefined) {
		errors.fail(at(path, "candidate_snapshot_id"), "missing-field", `candidate_snapshot_id is required when outcome is ${outcome}`);
	}
	if (isTimestamp(obj.started_at) && isTimestamp(obj.ended_at) && before(obj.ended_at, obj.started_at)) {
		errors.fail(at(path, "ended_at"), "invalid-value", "ended_at precedes started_at");
	}
	if (obj.baseline_snapshot_id !== undefined && obj.baseline_snapshot_id === obj.candidate_snapshot_id) {
		errors.fail(at(path, "candidate_snapshot_id"), "invalid-value", "baseline and candidate are the same snapshot");
	}
	for (const key of ["parent_attempt_id", "supersedes_attempt_id", "superseded_by_attempt_id"]) {
		if (obj[key] !== undefined && obj[key] === obj.id) errors.fail(at(path, key), "invalid-value", `${key} names the attempt itself`);
	}
}

const SNAPSHOT_INPUT_BODY: Shape = {
	repository: req(objectOf(REPOSITORY_SHAPE, baselinePost)),
	manifest: req(manifest),
	coverage: req(objectOf(COVERAGE_SHAPE)),
	stability: req(oneOf(SNAPSHOT_STABILITIES)),
	collector: req(oneOf(COLLECTORS)),
	captured_at: req(timestamp),
};
const SNAPSHOT_BODY: Shape = {
	change_id: req(recordId("change")),
	attempt_id: req(recordId("attempt")),
	role: req(oneOf(SNAPSHOT_ROLES)),
	...SNAPSHOT_INPUT_BODY,
	digest: req(digest),
};
function snapshotPost(obj: Record<string, unknown>, path: string, errors: Errors, identityErrorsBefore: number): void {
	// Only recompute over identity fields that passed their own checks;
	// otherwise the mismatch would just restate an error already reported.
	if (errors.list.length !== identityErrorsBefore) return;
	if (!isDigest(obj.digest)) return;
	const expected = computeSnapshotDigest(obj as never);
	if (expected !== obj.digest) errors.fail(at(path, "digest"), "digest-mismatch", `snapshot digest is ${obj.digest}, recomputed ${expected}`);
}

const PROOF_INPUT_BODY: Shape = {
	snapshot_id: req(recordId("snapshot")),
	obligation_id: req(localId),
	scenario_ids: req(arrayOf(localId, { nonEmpty: true })),
	check: req(objectOf(CHECK_SHAPE)),
	collector: req(oneOf(COLLECTORS)),
	result: req(oneOf(PROOF_RESULTS)),
	exit_code: opt(integer),
	started_at: req(timestamp),
	ended_at: req(timestamp),
	block_reason: opt(nonEmptyString),
	observer: opt(nonEmptyString),
	artifacts: req(arrayOf(objectOf(ARTIFACT_SHAPE))),
	environment: opt(objectOf(ENVIRONMENT_SHAPE)),
	provenance: req(objectOf(PROVENANCE_SHAPE)),
};
const PROOF_BODY: Shape = { change_id: req(recordId("change")), attempt_id: req(recordId("attempt")), ...PROOF_INPUT_BODY };
function proofPost(obj: Record<string, unknown>, path: string, errors: Errors): void {
	uniqueStrings(obj.scenario_ids, at(path, "scenario_ids"), errors);
	uniqueBy(obj.artifacts, at(path, "artifacts"), "id", errors);
	const collector = typeof obj.collector === "string" && COLLECTORS.includes(obj.collector as never) ? obj.collector : null;
	const result = typeof obj.result === "string" && PROOF_RESULTS.includes(obj.result as never) ? obj.result : null;
	const check = isPlainObject(obj.check) ? obj.check : null;
	if (collector === "host-observed" || collector === "ci-reported") {
		if (check && check.command === undefined) errors.fail(at(at(path, "check"), "command"), "missing-field", `check.command is required for a ${collector} check`);
		if ((result === "passed" || result === "failed") && obj.exit_code === undefined) {
			errors.fail(at(path, "exit_code"), "missing-field", `exit_code is required for a ${collector} ${result} result`);
		}
	}
	if (collector === "manual-observation") {
		if (check && check.procedure === undefined) errors.fail(at(at(path, "check"), "procedure"), "missing-field", "check.procedure is required for a manual observation");
		if (obj.observer === undefined) errors.fail(at(path, "observer"), "missing-field", "observer is required for a manual observation");
	}
	if (collector === "ci-reported" && isPlainObject(obj.provenance) && obj.provenance.run_reference === undefined) {
		errors.fail(at(at(path, "provenance"), "run_reference"), "missing-field", "provenance.run_reference is required for a ci-reported result");
	}
	if (result !== null) requiredWhen(obj, path, "block_reason", result === "blocked", "when result is blocked", errors);
	if (isTimestamp(obj.started_at) && isTimestamp(obj.ended_at) && before(obj.ended_at, obj.started_at)) {
		errors.fail(at(path, "ended_at"), "invalid-value", "ended_at precedes started_at");
	}
}

const REVIEW_INPUT_BODY: Shape = {
	candidate_snapshot_id: req(recordId("snapshot")),
	candidate_digest: req(digest),
	input_digest: req(digest),
	reviewer: req(objectOf(REVIEWER_SHAPE)),
	objections: req(arrayOf(objectOf(OBJECTION_SHAPE))),
	remaining_blockers: req(arrayOf(localId)),
	summary: req(nonEmptyString),
};
const REVIEW_BODY: Shape = { change_id: req(recordId("change")), attempt_id: req(recordId("attempt")), ...REVIEW_INPUT_BODY };
/** The blocking objections still standing, in objection order: `open` and `deferred` both still block. */
export function deriveRemainingBlockers(objections: ReviewRecord["objections"]): string[] {
	return objections.filter((o) => o.severity === "blocking" && (o.disposition === "open" || o.disposition === "deferred")).map((o) => o.id);
}
function reviewPost(obj: Record<string, unknown>, path: string, errors: Errors): void {
	uniqueBy(obj.objections, at(path, "objections"), "id", errors);
	if (isPlainObject(obj.reviewer) && obj.reviewer.context === "same-session" && obj.reviewer.separation === "declared-separate") {
		errors.fail(at(at(path, "reviewer"), "separation"), "invalid-value", "a same-session reviewer cannot declare separation from the author");
	}
	if (!Array.isArray(obj.objections)) return;
	let derivable = true;
	obj.objections.forEach((objection, i) => {
		if (!isPlainObject(objection)) {
			derivable = false;
			return;
		}
		if (typeof objection.disposition === "string" && OBJECTION_DISPOSITIONS.includes(objection.disposition as never)) {
			requiredWhen(objection, at(at(path, "objections"), i), "resolution_evidence", objection.disposition === "resolved", "when disposition is resolved", errors);
		} else derivable = false;
		if (typeof objection.severity !== "string" || typeof objection.id !== "string") derivable = false;
	});
	if (derivable && Array.isArray(obj.remaining_blockers)) {
		const expected = deriveRemainingBlockers(obj.objections as never);
		const actual = obj.remaining_blockers;
		if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
			errors.fail(at(path, "remaining_blockers"), "invalid-value", `remaining_blockers must be exactly [${expected.join(", ")}]`);
		}
	}
}

const APPROVAL_BODY: Shape = {
	change_id: req(recordId("change")),
	slice_id: req(recordId("slice")),
	attempt_id: req(recordId("attempt")),
	candidate_snapshot_id: req(recordId("snapshot")),
	candidate_digest: req(digest),
	input_digest: req(digest),
	decision: req(oneOf(APPROVAL_DECISIONS)),
	decided_at: req(timestamp),
	receipt: req(objectOf(RECEIPT_SHAPE)),
	human_note: opt(nonEmptyString),
};
function approvalPost(obj: Record<string, unknown>, path: string, errors: Errors): void {
	const receipt = isPlainObject(obj.receipt) ? obj.receipt : null;
	if (!receipt) return;
	const receiptPath = at(path, "receipt");
	if (isTimestamp(receipt.issued_at) && isTimestamp(receipt.responded_at) && before(receipt.responded_at, receipt.issued_at)) {
		errors.fail(at(receiptPath, "responded_at"), "invalid-value", "responded_at precedes issued_at");
	}
	const untrusted = receipt.channel === "cooperative-file" || receipt.channel === "agent-declared";
	if (untrusted && receipt.authenticated !== undefined && receipt.authenticated !== "none") {
		errors.fail(at(receiptPath, "authenticated"), "invalid-value", `a ${receipt.channel} receipt authenticates nothing`);
	}
}

const RECORD_SHAPES: Record<RecordKind, { shape: Shape; post: (obj: Record<string, unknown>, path: string, errors: Errors) => void }> = {
	change: { shape: envelope("change", CHANGE_BODY), post: changePost },
	slice: { shape: envelope("slice", SLICE_BODY), post: slicePost },
	attempt: { shape: envelope("attempt", ATTEMPT_BODY), post: attemptPost },
	snapshot: { shape: envelope("snapshot", SNAPSHOT_BODY), post: () => {} },
	proof: { shape: envelope("proof", PROOF_BODY), post: proofPost },
	review: { shape: envelope("review", REVIEW_BODY), post: reviewPost },
	approval: { shape: envelope("approval", APPROVAL_BODY), post: approvalPost },
};

function checkSchemaVersion(value: unknown, path: string, errors: Errors): boolean {
	if (value !== ENGINEERING_SCHEMA_VERSION) {
		errors.fail(at(path, "schema_version"), "unsupported-schema-version", `expected schema_version ${ENGINEERING_SCHEMA_VERSION}, got ${JSON.stringify(value)}`);
		return false;
	}
	return true;
}

/**
 * Validates one record of any kind. The schema version and kind are checked
 * first and alone: an unsupported version or unknown kind is refused without
 * reading further, so a future record is never half-interpreted.
 */
export function validateRecord(value: unknown, path: string = "/"): ValidationOutcome<EngineeringRecord> {
	const errors = new Errors();
	if (!isPlainObject(value)) {
		errors.fail(path, "invalid-type", "expected a record object");
		return outcome(errors, value as never);
	}
	if (!checkSchemaVersion(value.schema_version, path, errors)) return outcome(errors, value as never);
	if (typeof value.kind !== "string" || !RECORD_KINDS.includes(value.kind as never)) {
		errors.fail(at(path, "kind"), "invalid-enum", `expected one of ${RECORD_KINDS.join(", ")}`);
		return outcome(errors, value as never);
	}
	const kind = value.kind as RecordKind;
	const { shape, post } = RECORD_SHAPES[kind];
	const errorsBefore = errors.list.length;
	const obj = checkObject(value, path, shape, errors);
	if (!obj) return outcome(errors, value as never);
	if (kind === "snapshot") snapshotPost(obj, path, errors, errorsBefore);
	post(obj, path, errors);
	return outcome(errors, value as unknown as EngineeringRecord);
}

/** {@link validateRecord} for a record of a known kind; a record of another kind is `invalid-enum` at `/kind`. */
export function validateRecordOfKind<K extends RecordKind>(kind: K, value: unknown, path: string = "/"): ValidationOutcome<Extract<EngineeringRecord, { kind: K }>> {
	const result = validateRecord(value, path);
	if (result.ok && result.value.kind !== kind) {
		return { ok: false, errors: [{ code: "invalid-enum", path: at(path, "kind"), message: `expected a ${kind} record, got ${result.value.kind}` }] };
	}
	return result as ValidationOutcome<Extract<EngineeringRecord, { kind: K }>>;
}

/** Parses JSON text and validates it as a record. A parse failure is `invalid-request` at `/`. */
export function parseRecord(text: string): ValidationOutcome<EngineeringRecord> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, errors: [{ code: "invalid-request", path: "/", message: `not JSON: ${(error as Error).message}` }] };
	}
	return validateRecord(parsed);
}

// ---------- acceptance request ----------

const ACCEPTANCE_REQUEST_SHAPE: Shape = {
	schema_version: req(() => {}),
	id: req(recordId("acceptance-request")),
	change_id: req(recordId("change")),
	slice_id: req(recordId("slice")),
	attempt_id: req(recordId("attempt")),
	candidate_snapshot_id: req(recordId("snapshot")),
	candidate_digest: req(digest),
	input_digest: req(digest),
	nonce: req(nonce),
	issued_at: req(timestamp),
	expires_at: req(timestamp),
	presentation: req(objectOf(PRESENTATION_SHAPE)),
	presentation_digest: req(digest),
};

export function validateAcceptanceRequest(value: unknown, path: string = "/"): ValidationOutcome<AcceptanceRequest> {
	const errors = new Errors();
	if (!isPlainObject(value)) {
		errors.fail(path, "invalid-type", "expected an acceptance request object");
		return outcome(errors, value as never);
	}
	if (!checkSchemaVersion(value.schema_version, path, errors)) return outcome(errors, value as never);
	const errorsBefore = errors.list.length;
	const obj = checkObject(value, path, ACCEPTANCE_REQUEST_SHAPE, errors);
	if (!obj) return outcome(errors, value as never);
	if (isTimestamp(obj.issued_at) && isTimestamp(obj.expires_at) && !before(obj.issued_at, obj.expires_at)) {
		errors.fail(at(path, "expires_at"), "invalid-value", "expires_at must be after issued_at");
	}
	if (errors.list.length === errorsBefore && isDigest(obj.presentation_digest)) {
		const expected = computePresentationDigest(obj.presentation as AcceptancePresentation);
		if (expected !== obj.presentation_digest) errors.fail(at(path, "presentation_digest"), "digest-mismatch", `presentation digest is ${obj.presentation_digest}, recomputed ${expected}`);
	}
	return outcome(errors, value as unknown as AcceptanceRequest);
}

/**
 * The request the core hands a host adapter to present. Pure: the caller
 * supplies the id, nonce, and clock. `limitations` are shown verbatim and
 * should say what the evidence does not cover — the summary lines below
 * already carry what it does.
 */
export function buildAcceptanceRequest(args: {
	id: string;
	nonce: string;
	issued_at: string;
	expires_at: string;
	change: ChangeRecord;
	slice: SliceRecord;
	attempt: AttemptRecord;
	candidate: SnapshotRecord;
	proofs: ProofRecord[];
	reviews: ReviewRecord[];
	limitations: string[];
}): AcceptanceRequest {
	const { change, slice, attempt, candidate } = args;
	if (attempt.candidate_snapshot_id !== candidate.id) throw new Error("buildAcceptanceRequest: candidate is not the attempt's bound candidate snapshot");
	const files = candidate.manifest.filter((e) => e.type === "file").length;
	const symlinks = candidate.manifest.length - files;
	const tree = candidate.repository.vcs === "git" ? `${candidate.repository.dirty ? "dirty" : "clean"} tree at ${candidate.repository.head.slice(0, 8)}` : "no VCS";
	const presentation: AcceptancePresentation = {
		title: change.title,
		requested_outcome: change.requested_outcome,
		slice_deliverable: slice.deliverable,
		candidate_summary: `${candidate.manifest.length} manifest entries (${files} files, ${symlinks} symlinks); ${tree}; digest ${candidate.digest}`,
		proof_summary: args.proofs.map((p) => ({ obligation_id: p.obligation_id, result: p.result, collector: p.collector })),
		review_summary: args.reviews.map((r) => ({ review_id: r.id, separation: r.reviewer.separation, remaining_blockers: r.remaining_blockers.length })),
		limitations: [...args.limitations],
	};
	return {
		schema_version: ENGINEERING_SCHEMA_VERSION,
		id: args.id,
		change_id: change.id,
		slice_id: slice.id,
		attempt_id: attempt.id,
		candidate_snapshot_id: candidate.id,
		candidate_digest: candidate.digest,
		input_digest: attempt.inputs.digest,
		nonce: args.nonce,
		issued_at: args.issued_at,
		expires_at: args.expires_at,
		presentation,
		presentation_digest: computePresentationDigest(presentation),
	};
}

// ---------- approval receipt ----------

export interface ReceiptContext {
	/** The request the core issued with this id, if the store still has it. */
	request: AcceptanceRequest | undefined;
	/** Nonces already bound to an approval; a second use is a replay. */
	consumed_nonces: Iterable<string>;
	attempt: AttemptRecord;
	candidate: SnapshotRecord;
}

/**
 * Whether an approval's receipt binds to the request the core issued, in
 * this order: known request, unconsumed nonce, matching nonce, same change,
 * same slice/attempt/snapshot/digests/presentation, issued as recorded,
 * answered after issue and before expiry, stable candidate, trusted channel.
 * A structurally valid approval on an untrusted channel is refused here with
 * `untrusted-channel`; it is never silently downgraded to a warning.
 *
 * `accepted` reports the human's decision; a `rejected` decision passes every
 * check and is simply not an acceptance.
 */
export function evaluateApprovalReceipt(approval: ApprovalRecord, context: ReceiptContext): { ok: true; accepted: boolean } | { ok: false; errors: EngineeringError[] } {
	const errors = new Errors();
	const receipt = approval.receipt;
	const request = context.request;
	if (!request || request.id !== receipt.request_id) {
		errors.fail("/receipt/request_id", "receipt-unknown-request", `no acceptance request ${receipt.request_id} was issued`);
		return outcome(errors, undefined as never) as never;
	}
	for (const used of context.consumed_nonces) {
		if (used === receipt.nonce) {
			errors.fail("/receipt/nonce", "receipt-replayed", "this nonce has already been bound to an approval");
			return outcome(errors, undefined as never) as never;
		}
	}
	if (receipt.nonce !== request.nonce) errors.fail("/receipt/nonce", "receipt-mismatch", "nonce differs from the request's nonce");
	if (approval.change_id !== request.change_id || context.attempt.change_id !== approval.change_id) {
		errors.fail("/change_id", "cross-change-reference", "approval, request, and attempt do not name the same change");
	}
	const bindings: Array<[keyof ApprovalRecord & keyof AcceptanceRequest, string]> = [
		["slice_id", "/slice_id"],
		["attempt_id", "/attempt_id"],
		["candidate_snapshot_id", "/candidate_snapshot_id"],
		["candidate_digest", "/candidate_digest"],
		["input_digest", "/input_digest"],
	];
	for (const [key, path] of bindings) {
		if (approval[key] !== request[key]) errors.fail(path, "receipt-mismatch", `${key} differs from the request`);
	}
	if (receipt.presentation_digest !== request.presentation_digest) errors.fail("/receipt/presentation_digest", "receipt-mismatch", "presentation digest differs from the request");
	if (receipt.issued_at !== request.issued_at) errors.fail("/receipt/issued_at", "receipt-mismatch", "issued_at differs from the request");
	if (context.attempt.id !== approval.attempt_id) errors.fail("/attempt_id", "receipt-mismatch", "context attempt is not the approved attempt");
	if (context.attempt.candidate_snapshot_id !== approval.candidate_snapshot_id) errors.fail("/candidate_snapshot_id", "receipt-mismatch", "attempt's bound candidate differs");
	if (context.attempt.inputs.digest !== approval.input_digest) errors.fail("/input_digest", "receipt-mismatch", "attempt's input digest differs");
	if (context.candidate.id !== approval.candidate_snapshot_id) errors.fail("/candidate_snapshot_id", "receipt-mismatch", "context snapshot is not the approved candidate");
	if (context.candidate.digest !== approval.candidate_digest) errors.fail("/candidate_digest", "receipt-mismatch", "candidate digest differs from the snapshot's");
	if (before(receipt.responded_at, request.issued_at)) errors.fail("/receipt/responded_at", "receipt-mismatch", "responded before the request was issued");
	else if (before(request.expires_at, receipt.responded_at)) errors.fail("/receipt/responded_at", "receipt-expired", `responded after the request expired at ${request.expires_at}`);
	if (before(approval.decided_at, request.issued_at) || before(request.expires_at, approval.decided_at)) {
		errors.fail("/decided_at", "receipt-expired", "decided outside the request's validity window");
	}
	if (context.candidate.stability !== "stable") errors.fail("/candidate_snapshot_id", "invalid-value", "an unstable candidate cannot bind an acceptance");
	if (context.candidate.collector === "agent-claimed") errors.fail("/candidate_snapshot_id", "invalid-value", "an agent-claimed candidate snapshot cannot bind an acceptance");
	if (!TRUSTED_APPROVAL_CHANNELS.includes(receipt.channel)) {
		errors.fail("/receipt/channel", "untrusted-channel", `${receipt.channel} is a cooperative record, not human acceptance`);
	}
	if (!errors.ok) return { ok: false, errors: errors.list };
	return { ok: true, accepted: approval.decision === "accepted" };
}

// ---------- bundle ----------

export interface ChangeBundle {
	change: ChangeRecord;
	slices: SliceRecord[];
	attempts: AttemptRecord[];
	snapshots: SnapshotRecord[];
	proofs: ProofRecord[];
	reviews: ReviewRecord[];
	approvals: ApprovalRecord[];
}

const BUNDLE_SLOTS: Array<[keyof ChangeBundle, RecordKind]> = [
	["slices", "slice"],
	["attempts", "attempt"],
	["snapshots", "snapshot"],
	["proofs", "proof"],
	["reviews", "review"],
	["approvals", "approval"],
];

/**
 * Validates every record of one change and then their references to each
 * other. Structural errors in any record stop the reference pass, since a
 * half-parsed record cannot be resolved against. Nothing here consults the
 * acceptance request; see {@link evaluateApprovalReceipt} for that.
 */
export function validateChangeBundle(value: unknown): ValidationOutcome<ChangeBundle> {
	const errors = new Errors();
	if (!isPlainObject(value)) {
		errors.fail("/", "invalid-type", "expected a bundle object");
		return outcome(errors, value as never);
	}
	const shape: Shape = { change: req(() => {}) };
	for (const [slot] of BUNDLE_SLOTS) shape[slot] = req(arrayOf(() => {}));
	checkObject(value, "/", shape, errors);
	const change = validateRecordOfKind("change", value.change, "/change");
	if (!change.ok) errors.list.push(...(change as { errors: EngineeringError[] }).errors);
	const slots = {} as { [K in keyof ChangeBundle]: ChangeBundle[K] };
	for (const [slot, kind] of BUNDLE_SLOTS) {
		const items = Array.isArray(value[slot]) ? value[slot] : [];
		const parsed: EngineeringRecord[] = [];
		items.forEach((item, i) => {
			const result = validateRecordOfKind(kind, item, `/${slot}/${i}`);
			if (result.ok) parsed.push(result.value);
			else errors.list.push(...(result as { errors: EngineeringError[] }).errors);
		});
		(slots as Record<string, unknown>)[slot] = parsed;
	}
	if (!errors.ok || !change.ok) return outcome(errors, value as never);
	const bundle: ChangeBundle = { change: change.value, ...slots };
	checkBundleReferences(bundle, errors);
	return outcome(errors, bundle);
}

function checkBundleReferences(bundle: ChangeBundle, errors: Errors): void {
	const changeId = bundle.change.id;
	const seen = new Map<string, string>([[changeId, "/change/id"]]);
	for (const [slot] of BUNDLE_SLOTS) {
		const records = bundle[slot] as Array<Exclude<EngineeringRecord, ChangeRecord>>;
		records.forEach((record, i) => {
			const path = `/${slot}/${i}`;
			if (seen.has(record.id)) errors.fail(`${path}/id`, "duplicate-id", `id ${record.id} already used at ${seen.get(record.id)}`);
			else seen.set(record.id, `${path}/id`);
			if (record.change_id !== changeId) errors.fail(`${path}/change_id`, "cross-change-reference", `record belongs to ${record.change_id}, not ${changeId}`);
		});
	}
	if (!errors.ok) return;

	const scenarios = new Set(bundle.change.acceptance_scenarios.map((s) => s.id));
	const slices = new Map(bundle.slices.map((s) => [s.id, s]));
	const attempts = new Map(bundle.attempts.map((a) => [a.id, a]));
	const snapshots = new Map(bundle.snapshots.map((s) => [s.id, s]));

	bundle.slices.forEach((slice, i) => {
		slice.depends_on.forEach((dep, j) => {
			if (!slices.has(dep)) errors.fail(`/slices/${i}/depends_on/${j}`, "unknown-reference", `no slice ${dep} in this change`);
		});
		slice.scenario_ids.forEach((id, j) => {
			if (!scenarios.has(id)) errors.fail(`/slices/${i}/scenario_ids/${j}`, "unknown-reference", `no scenario ${id} in this change`);
		});
	});

	bundle.snapshots.forEach((snapshot, i) => {
		if (!attempts.has(snapshot.attempt_id)) errors.fail(`/snapshots/${i}/attempt_id`, "unknown-reference", `no attempt ${snapshot.attempt_id} in this change`);
	});

	const bindSnapshot = (attempt: AttemptRecord, key: "baseline_snapshot_id" | "candidate_snapshot_id", role: SnapshotRecord["role"], path: string) => {
		const id = attempt[key];
		if (id === undefined) return;
		const snapshot = snapshots.get(id);
		if (!snapshot) {
			errors.fail(`${path}/${key}`, "unknown-reference", `no snapshot ${id} in this change`);
			return;
		}
		if (snapshot.attempt_id !== attempt.id) errors.fail(`${path}/${key}`, "invalid-value", `snapshot ${id} belongs to attempt ${snapshot.attempt_id}`);
		if (snapshot.role !== role) errors.fail(`${path}/${key}`, "invalid-value", `snapshot ${id} has role ${snapshot.role}, expected ${role}`);
	};
	bundle.attempts.forEach((attempt, i) => {
		const path = `/attempts/${i}`;
		if (!slices.has(attempt.slice_id)) errors.fail(`${path}/slice_id`, "unknown-reference", `no slice ${attempt.slice_id} in this change`);
		bindSnapshot(attempt, "baseline_snapshot_id", "baseline", path);
		bindSnapshot(attempt, "candidate_snapshot_id", "candidate", path);
		for (const key of ["parent_attempt_id", "supersedes_attempt_id", "superseded_by_attempt_id"] as const) {
			const id = attempt[key];
			if (id !== undefined && !attempts.has(id)) errors.fail(`${path}/${key}`, "unknown-reference", `no attempt ${id} in this change`);
		}
	});

	bundle.proofs.forEach((proof, i) => {
		const path = `/proofs/${i}`;
		const attempt = attempts.get(proof.attempt_id);
		if (!attempt) {
			errors.fail(`${path}/attempt_id`, "unknown-reference", `no attempt ${proof.attempt_id} in this change`);
			return;
		}
		const snapshot = snapshots.get(proof.snapshot_id);
		if (!snapshot || snapshot.attempt_id !== attempt.id) errors.fail(`${path}/snapshot_id`, "unknown-reference", `no snapshot ${proof.snapshot_id} of attempt ${attempt.id}`);
		const slice = slices.get(attempt.slice_id);
		if (slice && !slice.proof_obligations.some((o) => o.id === proof.obligation_id)) {
			errors.fail(`${path}/obligation_id`, "unknown-reference", `slice ${slice.id} declares no obligation ${proof.obligation_id}`);
		}
		proof.scenario_ids.forEach((id, j) => {
			if (!scenarios.has(id)) errors.fail(`${path}/scenario_ids/${j}`, "unknown-reference", `no scenario ${id} in this change`);
		});
	});

	const bindCandidate = (record: ReviewRecord | ApprovalRecord, path: string) => {
		const attempt = attempts.get(record.attempt_id);
		if (!attempt) {
			errors.fail(`${path}/attempt_id`, "unknown-reference", `no attempt ${record.attempt_id} in this change`);
			return null;
		}
		const snapshot = snapshots.get(record.candidate_snapshot_id);
		if (!snapshot) errors.fail(`${path}/candidate_snapshot_id`, "unknown-reference", `no snapshot ${record.candidate_snapshot_id} in this change`);
		else if (attempt.candidate_snapshot_id !== snapshot.id) errors.fail(`${path}/candidate_snapshot_id`, "invalid-value", `attempt ${attempt.id} is bound to candidate ${attempt.candidate_snapshot_id ?? "(none)"}`);
		else if (snapshot.digest !== record.candidate_digest) errors.fail(`${path}/candidate_digest`, "digest-mismatch", `candidate ${snapshot.id} has digest ${snapshot.digest}`);
		if (attempt.inputs.digest !== record.input_digest) errors.fail(`${path}/input_digest`, "digest-mismatch", `attempt ${attempt.id} has input digest ${attempt.inputs.digest}`);
		return attempt;
	};
	bundle.reviews.forEach((review, i) => bindCandidate(review, `/reviews/${i}`));
	bundle.approvals.forEach((approval, i) => {
		const attempt = bindCandidate(approval, `/approvals/${i}`);
		if (attempt && approval.slice_id !== attempt.slice_id) errors.fail(`/approvals/${i}/slice_id`, "invalid-value", `attempt ${attempt.id} belongs to slice ${attempt.slice_id}`);
	});
}

// ---------- operation requests (`codecarto_change`) ----------

const REQUEST_SHAPES: Record<ChangeRequest["action"], Shape> = {
	create: {
		title: req(nonEmptyString),
		mode: req(oneOf(CHANGE_MODES)),
		requested_outcome: req(nonEmptyString),
		baseline: req(objectOf(BASELINE_SHAPE, baselinePost)),
		scope: CHANGE_BODY.scope,
		preserved_contracts: CHANGE_BODY.preserved_contracts,
		acceptance_scenarios: CHANGE_BODY.acceptance_scenarios,
		references: opt(arrayOf(objectOf(REFERENCE_SHAPE))),
	},
	status: { change_id: opt(recordId("change")) },
	plan: {
		change_id: req(recordId("change")),
		expected_revision: req(revision),
		brief_markdown: opt(string),
		plan_markdown: opt(string),
		slices: req(arrayOf(objectOf({ id: opt(recordId("slice")), ...SLICE_INPUT_BODY }, slicePost))),
	},
	"start-attempt": {
		change_id: req(recordId("change")),
		slice_id: req(recordId("slice")),
		baseline_snapshot: req(objectOf(SNAPSHOT_INPUT_BODY)),
		inputs: req(objectOf(INPUTS_BODY, (obj, path, errors) => inputsPost(obj, path, errors, false))),
		parent_attempt_id: opt(recordId("attempt")),
	},
	"record-proof": {
		change_id: req(recordId("change")),
		attempt_id: req(recordId("attempt")),
		proof: req(objectOf(PROOF_INPUT_BODY, proofPost)),
	},
	"record-review": {
		change_id: req(recordId("change")),
		attempt_id: req(recordId("attempt")),
		review: req(objectOf(REVIEW_INPUT_BODY, reviewPost)),
	},
	check: { change_id: req(recordId("change")), attempt_id: opt(recordId("attempt")) },
	"request-acceptance": {
		change_id: req(recordId("change")),
		attempt_id: req(recordId("attempt")),
		candidate_snapshot: req(objectOf(SNAPSHOT_INPUT_BODY)),
	},
};

const idempotencyKey: Check = (value, path, errors) => {
	if (typeof value !== "string") errors.fail(path, "invalid-type", "expected a string");
	else if (value.length === 0 || value.length > 200) errors.fail(path, "invalid-value", "expected 1–200 characters");
};

/**
 * Validates one `codecarto_change` request. Only the action's own fields are
 * accepted: there is no `approve`, `approval`, `decision`, `receipt`, or
 * `host` field on any action, so a caller cannot smuggle a decision or raise
 * its own capability — those arrive from the adapter, out of band.
 */
export function validateChangeRequest(value: unknown): ValidationOutcome<ChangeRequest> {
	const errors = new Errors();
	if (!isPlainObject(value)) {
		errors.fail("/", "invalid-type", "expected a request object");
		return outcome(errors, value as never);
	}
	if (value.action === undefined) {
		errors.fail("/action", "missing-field", "missing required field action");
		return outcome(errors, value as never);
	}
	if (typeof value.action !== "string" || !CHANGE_ACTIONS.includes(value.action as never)) {
		errors.fail("/action", "invalid-action", `expected one of ${CHANGE_ACTIONS.join(", ")}`);
		return outcome(errors, value as never);
	}
	const action = value.action as ChangeRequest["action"];
	const shape: Shape = { action: req(() => {}), ...REQUEST_SHAPES[action] };
	if (MUTATING_CHANGE_ACTIONS.includes(action)) shape.idempotency_key = opt(idempotencyKey);
	checkObject(value, "/", shape, errors);
	return outcome(errors, value as unknown as ChangeRequest);
}
