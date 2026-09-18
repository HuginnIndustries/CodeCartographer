#!/usr/bin/env node
// Regenerates the v1 engineering fixtures (E01, #399).
//
// Deliberately independent of core/engineering/: the canonical JSON and the
// digests below are computed here from the rules the contract states, so
// tests/engineering-contract.test.mjs checks two implementations against
// each other rather than one against itself. Run `node generate.mjs` from
// this directory after changing a fixture's identity-bearing fields.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- canonical JSON, written from the contract, not imported ----------

function canonical(value) {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") {
		if (!Number.isInteger(value)) throw new Error("fixture digests carry integers only");
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const digestOf = (value) => sha(canonical(value));

// ---------- fixed identities ----------

const ID = {
	change: "chg_00000000000000000000c001",
	change2: "chg_00000000000000000000c002",
	slice: "slc_00000000000000000000e001",
	slice2: "slc_00000000000000000000e002",
	attempt: "att_00000000000000000000a001",
	attempt2: "att_00000000000000000000a002",
	baseline: "snp_00000000000000000000b001",
	candidate: "snp_00000000000000000000d001",
	proof: "prf_00000000000000000000f001",
	proof2: "prf_00000000000000000000f002",
	review: "rvw_000000000000000000000e01",
	approval: "apr_000000000000000000000a01",
	artifact: "art_00000000000000000000aa01",
	request: "acr_000000000000000000000c01",
};
const T = {
	created: "2026-09-17T10:00:00Z",
	planned: "2026-09-17T10:05:00Z",
	started: "2026-09-17T10:10:00Z",
	baseline: "2026-09-17T10:10:05Z",
	proofStart: "2026-09-17T10:20:00Z",
	proofEnd: "2026-09-17T10:21:30Z",
	candidate: "2026-09-17T10:22:00Z",
	review: "2026-09-17T10:30:00Z",
	issued: "2026-09-17T10:40:00Z",
	expires: "2026-09-17T11:40:00Z",
	responded: "2026-09-17T10:45:00Z",
	ended: "2026-09-17T10:45:01Z",
};
const NONCE = "0123456789abcdef0123456789abcdef";
const BRIEF_DIGEST = sha("# Brief\n\nMake the widget count include archived widgets.\n");
const PLAN_DIGEST = sha("# Plan\n\nOne slice: fix the count and prove it.\n");

// ---------- records ----------

const change = {
	schema_version: 1,
	kind: "change",
	id: ID.change,
	created_at: T.created,
	revision: 2,
	title: "Widget count includes archived widgets",
	mode: "fix",
	state: "active",
	requested_outcome: "`countWidgets()` returns archived widgets too, as the API documentation already says it does.",
	baseline: { vcs: "git", head: "0123456789abcdef0123456789abcdef01234567", description: "main as of the report" },
	scope: { in_scope: ["src/widgets/count.ts", "tests/widgets-count.test.mjs"], non_goals: ["Changing the archived-widget storage format"] },
	preserved_contracts: ["`countWidgets({ includeArchived: false })` keeps returning only live widgets"],
	acceptance_scenarios: [
		{ id: "S1", kind: "behavior", description: "Counting with the default options includes archived widgets." },
		{ id: "S2", kind: "preserved", description: "Counting with includeArchived: false excludes archived widgets." },
	],
	references: [],
	updated_at: T.planned,
};

const minimalChange = {
	schema_version: 1,
	kind: "change",
	id: ID.change2,
	created_at: T.created,
	revision: 1,
	title: "Untitled investigation",
	mode: "investigation",
	state: "draft",
	requested_outcome: "Find out why the nightly job is slow.",
	baseline: { vcs: "none" },
	scope: { in_scope: [], non_goals: [] },
	preserved_contracts: [],
	acceptance_scenarios: [],
	references: [],
	updated_at: T.created,
};

const slice = {
	schema_version: 1,
	kind: "slice",
	id: ID.slice,
	created_at: T.planned,
	change_id: ID.change,
	revision: 1,
	title: "Fix the count and prove both scenarios",
	deliverable: "countWidgets() counts archived widgets by default; a regression test pins both behaviors.",
	scenario_ids: ["S1", "S2"],
	depends_on: [],
	proof_obligations: [
		{ id: "O1", scenario_id: "S1", check_kind: "test", description: "tests/widgets-count.test.mjs passes with the archived case added", minimum_collector: "host-observed" },
		{ id: "O2", scenario_id: "S2", check_kind: "test", description: "the includeArchived: false case still passes", minimum_collector: "host-observed" },
	],
	permitted_scope: { paths: ["src/widgets/**", "tests/widgets-count.test.mjs"], description: "the counting module and its test" },
	state: "active",
	updated_at: T.planned,
};

const inputsBody = { brief_digest: BRIEF_DIGEST, plan_digest: PLAN_DIGEST, references: [] };
const inputs = { ...inputsBody, digest: digestOf(inputsBody) };

const baselineIdentity = {
	repository: { vcs: "git", head: "0123456789abcdef0123456789abcdef01234567", dirty: false },
	manifest: [
		{ path: "src/widgets/count.ts", type: "file", digest: sha("export function countWidgets() { return live.length; }\n"), executable: false, size: 56 },
		{ path: "tests/widgets-count.test.mjs", type: "file", digest: sha("// baseline test\n"), executable: false, size: 17 },
	],
	coverage: {
		excluded: [
			{ pattern: ".codecarto/engineering/**", reason: "engineering-namespace" },
			{ pattern: "node_modules/**", reason: "ignored" },
			{ pattern: "dist/**", reason: "generated" },
		],
		uncovered_relevant_inputs: [],
	},
};
const baseline = {
	schema_version: 1,
	kind: "snapshot",
	id: ID.baseline,
	created_at: T.baseline,
	change_id: ID.change,
	attempt_id: ID.attempt,
	role: "baseline",
	...baselineIdentity,
	stability: "stable",
	collector: "host-observed",
	attested_by: "adapter",
	captured_at: T.baseline,
	digest: digestOf(baselineIdentity),
};

const candidateIdentity = {
	repository: { vcs: "git", head: "0123456789abcdef0123456789abcdef01234567", dirty: true },
	manifest: [
		{ path: "scripts/count", type: "symlink", target: "../src/widgets/count.ts" },
		{ path: "src/widgets/count.ts", type: "file", digest: sha("export function countWidgets({ includeArchived = true } = {}) { /* … */ }\n"), executable: false, size: 74 },
		{ path: "tests/widgets-count.test.mjs", type: "file", digest: sha("// archived case added\n"), executable: false, size: 23 },
		{ path: "tools/run-tests", type: "file", digest: sha("#!/bin/sh\nnode --test\n"), executable: true, size: 22 },
	],
	coverage: baselineIdentity.coverage,
};
const candidate = {
	schema_version: 1,
	kind: "snapshot",
	id: ID.candidate,
	created_at: T.candidate,
	change_id: ID.change,
	attempt_id: ID.attempt,
	role: "candidate",
	...candidateIdentity,
	stability: "stable",
	collector: "host-observed",
	attested_by: "adapter",
	captured_at: T.candidate,
	digest: digestOf(candidateIdentity),
};

const attempt = {
	schema_version: 1,
	kind: "attempt",
	id: ID.attempt,
	created_at: T.started,
	change_id: ID.change,
	slice_id: ID.slice,
	inputs,
	baseline_snapshot_id: ID.baseline,
	candidate_snapshot_id: ID.candidate,
	outcome: "needs-human-acceptance",
	started_at: T.started,
	ended_at: T.ended,
};

const proof = {
	schema_version: 1,
	kind: "proof",
	id: ID.proof,
	created_at: T.proofEnd,
	change_id: ID.change,
	attempt_id: ID.attempt,
	snapshot_id: ID.candidate,
	obligation_id: "O1",
	scenario_ids: ["S1"],
	check: { kind: "test", command: "node --test tests/widgets-count.test.mjs", working_directory: "." },
	collector: "host-observed",
	result: "passed",
	exit_code: 0,
	started_at: T.proofStart,
	ended_at: T.proofEnd,
	artifacts: [
		{ id: ID.artifact, label: "test stdout", media_type: "text/plain", raw_digest: sha("# pass 2\n# fail 0\n"), raw_size: 17, sanitized_digest: sha("# pass 2\n# fail 0\n"), retained: true },
	],
	environment: { summary: "linux x64, node 24", digest: digestOf({ node: "24", platform: "linux", arch: "x64" }) },
	provenance: { source: "mcp:claude-code", attested_by: "caller" },
};

const proof2 = {
	...proof,
	id: ID.proof2,
	obligation_id: "O2",
	scenario_ids: ["S2"],
	artifacts: [],
	environment: undefined,
};

const review = {
	schema_version: 1,
	kind: "review",
	id: ID.review,
	created_at: T.review,
	change_id: ID.change,
	attempt_id: ID.attempt,
	candidate_snapshot_id: ID.candidate,
	candidate_digest: candidate.digest,
	input_digest: inputs.digest,
	reviewer: { context: "separate-session", separation: "declared-separate", label: "review session 2", note: "fresh session, no author transcript" },
	objections: [
		{
			id: "R1",
			severity: "blocking",
			statement: "The archived case asserted the count before the fixture loaded archived widgets.",
			evidence: "tests/widgets-count.test.mjs line 14 awaited nothing; the assertion ran against the live-only fixture.",
			disposition: "resolved",
			resolution_evidence: "Candidate snapshot moves the assertion after `await loadArchived()`; proof prf_…f001 ran against that snapshot.",
		},
		{
			id: "R2",
			severity: "advisory",
			statement: "The option name `includeArchived` is not documented in README.",
			evidence: "README.md has no mention of the option.",
			disposition: "deferred",
			disposition_note: "Documentation follow-up outside this slice's permitted scope.",
		},
	],
	remaining_blockers: [],
	summary: "Both scenarios are exercised by the test; the ordering defect found on first read was fixed before proof.",
};

const presentation = {
	title: change.title,
	requested_outcome: change.requested_outcome,
	slice_deliverable: slice.deliverable,
	candidate_summary: `4 manifest entries (3 files, 1 symlinks); dirty tree at 01234567; digest ${candidate.digest}`,
	proof_summary: [
		{ obligation_id: "O1", result: "passed", collector: "host-observed", attested_by: "caller" },
		{ obligation_id: "O2", result: "passed", collector: "host-observed", attested_by: "caller" },
	],
	review_summary: [{ review_id: ID.review, separation: "declared-separate", remaining_blockers: 0 }],
	limitations: [
		"2 of 2 proofs are caller-attested: the host session reported the result; the framework did not observe the command.",
		"Reviewer separation is declared by the host, not authenticated.",
		"No CI run exists for this candidate.",
	],
};
const acceptanceRequest = {
	schema_version: 1,
	id: ID.request,
	change_id: ID.change,
	slice_id: ID.slice,
	attempt_id: ID.attempt,
	candidate_snapshot_id: ID.candidate,
	candidate_digest: candidate.digest,
	input_digest: inputs.digest,
	nonce: NONCE,
	issued_at: T.issued,
	expires_at: T.expires,
	presentation,
	presentation_digest: digestOf(presentation),
};

const approval = {
	schema_version: 1,
	kind: "approval",
	id: ID.approval,
	created_at: T.responded,
	change_id: ID.change,
	slice_id: ID.slice,
	attempt_id: ID.attempt,
	candidate_snapshot_id: ID.candidate,
	candidate_digest: candidate.digest,
	input_digest: inputs.digest,
	decision: "accepted",
	decided_at: T.responded,
	receipt: {
		request_id: ID.request,
		nonce: NONCE,
		presentation_digest: acceptanceRequest.presentation_digest,
		channel: "mcp-elicitation",
		host: "mcp-server",
		host_session: "stdio session 1",
		issued_at: T.issued,
		responded_at: T.responded,
		authenticated: "host-session",
		attestation: "The connected MCP client answered elicitation/create in the session that issued the request. The client's own consent UI is trusted; the person's identity was not authenticated.",
	},
	human_note: "Looks right; ship it.",
};

const bundle = {
	change,
	slices: [slice],
	attempts: [attempt],
	snapshots: [baseline, candidate],
	proofs: [proof, proof2],
	reviews: [review],
	approvals: [approval],
};

// ---------- operation requests ----------

const requests = {
	create: {
		action: "create",
		idempotency_key: "create-widget-count-1",
		title: change.title,
		mode: change.mode,
		requested_outcome: change.requested_outcome,
		baseline: change.baseline,
		scope: change.scope,
		preserved_contracts: change.preserved_contracts,
		acceptance_scenarios: change.acceptance_scenarios,
	},
	status: { action: "status", change_id: ID.change },
	plan: {
		action: "plan",
		idempotency_key: "plan-widget-count-1",
		change_id: ID.change,
		expected_revision: 1,
		brief_markdown: "# Brief\n\nMake the widget count include archived widgets.\n",
		plan_markdown: "# Plan\n\nOne slice: fix the count and prove it.\n",
		slices: [
			{
				title: slice.title,
				deliverable: slice.deliverable,
				scenario_ids: slice.scenario_ids,
				depends_on: [],
				proof_obligations: slice.proof_obligations,
				permitted_scope: slice.permitted_scope,
			},
		],
	},
	"start-attempt": {
		action: "start-attempt",
		idempotency_key: "attempt-1",
		change_id: ID.change,
		slice_id: ID.slice,
		inputs: inputsBody,
		baseline_snapshot: { ...baselineIdentity, stability: "stable", collector: "host-observed", captured_at: T.baseline },
	},
	"capture-candidate": {
		action: "capture-candidate",
		idempotency_key: "candidate-1",
		change_id: ID.change,
		attempt_id: ID.attempt,
	},
	"record-proof": {
		action: "record-proof",
		idempotency_key: "proof-O1-1",
		change_id: ID.change,
		attempt_id: ID.attempt,
		proof: {
			snapshot_id: ID.candidate,
			obligation_id: "O1",
			scenario_ids: ["S1"],
			check: proof.check,
			collector: "host-observed",
			result: "passed",
			exit_code: 0,
			started_at: T.proofStart,
			ended_at: T.proofEnd,
			artifacts: proof.artifacts,
			environment: proof.environment,
			provenance: { source: proof.provenance.source },
		},
	},
	"record-review": {
		action: "record-review",
		idempotency_key: "review-1",
		change_id: ID.change,
		attempt_id: ID.attempt,
		review: {
			candidate_snapshot_id: ID.candidate,
			candidate_digest: candidate.digest,
			input_digest: inputs.digest,
			reviewer: review.reviewer,
			objections: review.objections,
			remaining_blockers: [],
			summary: review.summary,
		},
	},
	check: { action: "check", change_id: ID.change, attempt_id: ID.attempt },
	"request-acceptance": {
		action: "request-acceptance",
		idempotency_key: "accept-1",
		change_id: ID.change,
		attempt_id: ID.attempt,
	},
};

// ---------- negative cases ----------
// Each: { description, subject, expect: [{ code, path }], value }. `subject`
// says which validator the test feeds it to. `expect` lists errors that must
// be present (by code and path); other errors may accompany them.

const clone = (v) => JSON.parse(JSON.stringify(v));
const withPatch = (base, patch) => Object.assign(clone(base), patch);

const invalid = {
	"record-unknown-schema-version": {
		description: "A record from a future schema is refused, not partially read.",
		subject: "record",
		expect: [{ code: "unsupported-schema-version", path: "/schema_version" }],
		value: withPatch(change, { schema_version: 2 }),
	},
	"record-missing-schema-version": {
		description: "A record with no schema_version is not assumed to be v1.",
		subject: "record",
		expect: [{ code: "unsupported-schema-version", path: "/schema_version" }],
		value: (() => {
			const v = clone(change);
			delete v.schema_version;
			return v;
		})(),
	},
	"record-unknown-kind": {
		description: "An unknown kind discriminator is refused.",
		subject: "record",
		expect: [{ code: "invalid-enum", path: "/kind" }],
		value: withPatch(change, { kind: "ticket" }),
	},
	"record-unknown-field": {
		description: "Fields outside the contract are refused so that no downstream invents one.",
		subject: "record",
		expect: [{ code: "unknown-field", path: "/approved" }],
		value: withPatch(change, { approved: true }),
	},
	"change-id-wrong-prefix": {
		description: "An id whose prefix names another kind is rejected before any lookup.",
		subject: "record",
		expect: [{ code: "invalid-id", path: "/id" }],
		value: withPatch(change, { id: ID.slice }),
	},
	"change-id-traversal": {
		description: "A path-shaped id cannot become a directory name.",
		subject: "record",
		expect: [{ code: "invalid-id", path: "/id" }],
		value: withPatch(change, { id: "chg_../../etc/passwd" }),
	},
	"change-invalid-state": {
		description: "A change state outside the enum is refused.",
		subject: "record",
		expect: [{ code: "invalid-enum", path: "/state" }],
		value: withPatch(change, { state: "done" }),
	},
	"change-blocked-without-reason": {
		description: "A blocked change must say what blocks it.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/block_reason" }],
		value: withPatch(change, { state: "blocked" }),
	},
	"change-duplicate-scenario-ids": {
		description: "Scenario ids are unique within a change.",
		subject: "record",
		expect: [{ code: "duplicate-id", path: "/acceptance_scenarios/1/id" }],
		value: withPatch(change, { acceptance_scenarios: [change.acceptance_scenarios[0], { ...change.acceptance_scenarios[1], id: "S1" }] }),
	},
	"change-planned-without-scenarios": {
		description: "A change past draft must declare at least one acceptance scenario.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/acceptance_scenarios" }],
		value: withPatch(change, { acceptance_scenarios: [] }),
	},
	"change-git-baseline-without-head": {
		description: "A git baseline names its commit.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/baseline/head" }],
		value: withPatch(change, { baseline: { vcs: "git" } }),
	},
	"change-revision-zero": {
		description: "Revisions start at 1.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/revision" }],
		value: withPatch(change, { revision: 0 }),
	},
	"change-bad-timestamp": {
		description: "Timestamps are RFC 3339 UTC with a trailing Z.",
		subject: "record",
		expect: [{ code: "invalid-timestamp", path: "/updated_at" }],
		value: withPatch(change, { updated_at: "2026-09-17 10:05" }),
	},
	"slice-empty-scenarios": {
		description: "A slice that proves no scenario is invalid planning.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/scenario_ids" }],
		value: withPatch(slice, { scenario_ids: [] }),
	},
	"slice-empty-obligations": {
		description: "A slice with no proof obligation is invalid planning.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/proof_obligations" }],
		value: withPatch(slice, { proof_obligations: [] }),
	},
	"slice-depends-on-itself": {
		description: "A slice cannot depend on itself.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/depends_on/0" }],
		value: withPatch(slice, { depends_on: [ID.slice] }),
	},
	"slice-obligation-agent-claimed-minimum": {
		description: "agent-claimed is never an acceptable minimum collector.",
		subject: "record",
		expect: [{ code: "invalid-enum", path: "/proof_obligations/0/minimum_collector" }],
		value: withPatch(slice, { proof_obligations: [{ ...slice.proof_obligations[0], minimum_collector: "agent-claimed" }, slice.proof_obligations[1]] }),
	},
	"slice-obligation-unknown-scenario": {
		description: "An obligation must name a scenario the slice proves.",
		subject: "record",
		expect: [{ code: "unknown-reference", path: "/proof_obligations/0/scenario_id" }],
		value: withPatch(slice, { proof_obligations: [{ ...slice.proof_obligations[0], scenario_id: "S9" }, slice.proof_obligations[1]] }),
	},
	"slice-scope-traversal": {
		description: "Permitted-scope patterns are repository-relative.",
		subject: "record",
		expect: [{ code: "invalid-path", path: "/permitted_scope/paths/0" }],
		value: withPatch(slice, { permitted_scope: { paths: ["../other-repo/**"] } }),
	},
	"attempt-input-digest-mismatch": {
		description: "The input digest is recomputed; a stored digest that disagrees is refused.",
		subject: "record",
		expect: [{ code: "digest-mismatch", path: "/inputs/digest" }],
		value: withPatch(attempt, { inputs: { ...inputs, plan_digest: sha("a different plan") } }),
	},
	"attempt-ready-without-candidate": {
		description: "An attempt cannot be ready for review without a candidate snapshot.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/candidate_snapshot_id" }],
		value: (() => {
			const v = withPatch(attempt, { outcome: "ready-for-review" });
			delete v.candidate_snapshot_id;
			return v;
		})(),
	},
	"attempt-running-with-end": {
		description: "A running attempt has no end time.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/ended_at" }],
		value: withPatch(attempt, { outcome: "running" }),
	},
	"attempt-blocked-without-reason": {
		description: "A blocked attempt says what blocks it.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/block_reason" }],
		value: withPatch(attempt, { outcome: "blocked" }),
	},
	"attempt-superseded-without-successor": {
		description: "A superseded attempt names its successor.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/superseded_by_attempt_id" }],
		value: withPatch(attempt, { outcome: "superseded" }),
	},
	"attempt-invalid-outcome": {
		description: "Outcome spelling is fixed.",
		subject: "record",
		expect: [{ code: "invalid-enum", path: "/outcome" }],
		value: withPatch(attempt, { outcome: "passed" }),
	},
	"attempt-references-unsorted": {
		description: "Input references are stored sorted so the digest is canonical.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/inputs/references/1" }],
		value: (() => {
			const refs = [
				{ id: "zeta-spec", version: "1.0.0", digest: sha("zeta") },
				{ id: "alpha-spec", version: "2.1.0", digest: sha("alpha") },
			];
			const body = { brief_digest: BRIEF_DIGEST, plan_digest: PLAN_DIGEST, references: refs };
			return withPatch(attempt, { inputs: { ...body, digest: digestOf(body) } });
		})(),
	},
	"snapshot-digest-mismatch": {
		description: "A snapshot digest that does not match its identity fields is refused.",
		subject: "record",
		expect: [{ code: "digest-mismatch", path: "/digest" }],
		value: withPatch(candidate, { repository: { ...candidate.repository, dirty: false } }),
	},
	"snapshot-manifest-unsorted": {
		description: "Manifest entries are strictly ascending by path in UTF-8 byte order.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/manifest/1/path" }],
		value: (() => {
			const identity = clone(baselineIdentity);
			identity.manifest.reverse();
			return { ...baseline, ...identity, digest: digestOf(identity) };
		})(),
	},
	"snapshot-manifest-duplicate-path": {
		description: "A path appears at most once in a manifest.",
		subject: "record",
		expect: [{ code: "duplicate-id", path: "/manifest/1/path" }],
		value: (() => {
			const identity = clone(baselineIdentity);
			identity.manifest = [identity.manifest[0], { ...identity.manifest[0] }];
			return { ...baseline, ...identity, digest: digestOf(identity) };
		})(),
	},
	"snapshot-manifest-traversal": {
		description: "A manifest path cannot escape the repository.",
		subject: "record",
		expect: [{ code: "invalid-path", path: "/manifest/0/path" }],
		value: (() => {
			const identity = clone(baselineIdentity);
			identity.manifest[0].path = "../secrets/.env";
			return { ...baseline, ...identity, digest: digestOf(identity) };
		})(),
	},
	"snapshot-manifest-absolute-path": {
		description: "A manifest path is never absolute.",
		subject: "record",
		expect: [{ code: "invalid-path", path: "/manifest/0/path" }],
		value: (() => {
			const identity = clone(baselineIdentity);
			identity.manifest[0].path = "/home/someone/repo/src/widgets/count.ts";
			return { ...baseline, ...identity, digest: digestOf(identity) };
		})(),
	},
	"snapshot-manifest-backslash": {
		description: "Backslashes are not path separators in a manifest.",
		subject: "record",
		expect: [{ code: "invalid-path", path: "/manifest/0/path" }],
		value: (() => {
			const identity = clone(baselineIdentity);
			identity.manifest[0].path = "src\\widgets\\count.ts";
			return { ...baseline, ...identity, digest: digestOf(identity) };
		})(),
	},
	"snapshot-symlink-with-digest": {
		description: "A symlink entry carries its raw target, never a content digest.",
		subject: "record",
		expect: [{ code: "unknown-field", path: "/manifest/0/digest" }],
		value: (() => {
			const identity = clone(candidateIdentity);
			identity.manifest[0].digest = sha("resolved");
			return { ...candidate, ...identity, digest: digestOf(identity) };
		})(),
	},
	"snapshot-git-without-head": {
		description: "A git snapshot names its commit.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/repository/head" }],
		value: (() => {
			const identity = clone(baselineIdentity);
			delete identity.repository.head;
			return { ...baseline, ...identity, digest: digestOf(identity) };
		})(),
	},
	"snapshot-invalid-exclusion-reason": {
		description: "Exclusion reasons are enumerated.",
		subject: "record",
		expect: [{ code: "invalid-enum", path: "/coverage/excluded/0/reason" }],
		value: (() => {
			const identity = clone(baselineIdentity);
			identity.coverage.excluded[0].reason = "whatever";
			return { ...baseline, ...identity, digest: digestOf(identity) };
		})(),
	},
	"proof-observed-without-exit-code": {
		description: "A host-observed pass or fail carries its exit code.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/exit_code" }],
		value: (() => {
			const v = clone(proof);
			delete v.exit_code;
			return v;
		})(),
	},
	"proof-observed-without-command": {
		description: "A host-observed check names the command that ran.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/check/command" }],
		value: withPatch(proof, { check: { kind: "test" } }),
	},
	"proof-manual-without-procedure-or-observer": {
		description: "A manual observation names its procedure and observer.",
		subject: "record",
		expect: [
			{ code: "missing-field", path: "/check/procedure" },
			{ code: "missing-field", path: "/observer" },
		],
		value: (() => {
			const v = withPatch(proof, { collector: "manual-observation", check: { kind: "manual-procedure" } });
			delete v.exit_code;
			return v;
		})(),
	},
	"proof-ci-without-run-reference": {
		description: "A CI-reported result names the run it was read from.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/provenance/run_reference" }],
		value: withPatch(proof, { collector: "ci-reported", provenance: { source: "github-actions" } }),
	},
	"proof-blocked-without-reason": {
		description: "A blocked check says what was missing.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/block_reason" }],
		value: (() => {
			const v = withPatch(proof, { result: "blocked" });
			delete v.exit_code;
			return v;
		})(),
	},
	"proof-invalid-collector": {
		description: "Collector spelling is fixed.",
		subject: "record",
		expect: [{ code: "invalid-enum", path: "/collector" }],
		value: withPatch(proof, { collector: "host_observed" }),
	},
	"proof-ends-before-start": {
		description: "A check cannot end before it started.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/ended_at" }],
		value: withPatch(proof, { ended_at: "2026-09-17T10:19:59Z" }),
	},
	"proof-artifact-with-path": {
		description: "Artifacts are referenced by id; a host-supplied path is never an output destination.",
		subject: "record",
		expect: [{ code: "unknown-field", path: "/artifacts/0/path" }],
		value: withPatch(proof, { artifacts: [{ ...proof.artifacts[0], path: "/tmp/out.log" }] }),
	},
	"proof-empty-scenarios": {
		description: "A proof names the scenarios it exercised.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/scenario_ids" }],
		value: withPatch(proof, { scenario_ids: [] }),
	},
	"review-objection-without-evidence": {
		description: "An objection without evidence is not an objection.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/objections/0/evidence" }],
		value: withPatch(review, { objections: [{ ...review.objections[0], evidence: "" }, review.objections[1]] }),
	},
	"review-resolved-without-evidence": {
		description: "Resolving a blocking objection needs evidence, not a checkbox.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/objections/0/resolution_evidence" }],
		value: (() => {
			const v = clone(review);
			delete v.objections[0].resolution_evidence;
			return v;
		})(),
	},
	"review-remaining-blockers-disagree": {
		description: "remaining_blockers is derived from the objections; a hand-written empty list over an open blocker is refused.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/remaining_blockers" }],
		value: withPatch(review, { objections: [{ ...review.objections[0], disposition: "open", resolution_evidence: undefined }, review.objections[1]], remaining_blockers: [] }),
	},
	"review-deferred-blocker-still-blocks": {
		description: "A deferred blocking objection is still a remaining blocker.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/remaining_blockers" }],
		value: withPatch(review, { objections: [{ ...review.objections[0], disposition: "deferred", resolution_evidence: undefined }, review.objections[1]], remaining_blockers: [] }),
	},
	"review-same-session-declared-separate": {
		description: "A same-session reviewer cannot declare separation.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/reviewer/separation" }],
		value: withPatch(review, { reviewer: { ...review.reviewer, context: "same-session", separation: "declared-separate" } }),
	},
	"review-duplicate-objection-ids": {
		description: "Objection ids are unique within a review.",
		subject: "record",
		expect: [{ code: "duplicate-id", path: "/objections/1/id" }],
		value: withPatch(review, { objections: [review.objections[0], { ...review.objections[1], id: "R1" }] }),
	},
	"review-bad-digest": {
		description: "Digest spelling is `sha256:` plus 64 lowercase hex characters.",
		subject: "record",
		expect: [{ code: "invalid-digest", path: "/candidate_digest" }],
		value: withPatch(review, { candidate_digest: "sha256:ABC" }),
	},
	"approval-agent-declared-channel": {
		description: "A model-authored decision is a legal record so it can be refused precisely; it is not human acceptance.",
		subject: "receipt",
		expect: [{ code: "untrusted-channel", path: "/receipt/channel" }],
		value: withPatch(approval, { receipt: { ...approval.receipt, channel: "agent-declared", authenticated: "none", attestation: "The model wrote approve: true in its tool call." } }),
	},
	"approval-cooperative-file-channel": {
		description: "A hand-edited approval file is a cooperative note, not acceptance.",
		subject: "receipt",
		expect: [{ code: "untrusted-channel", path: "/receipt/channel" }],
		value: withPatch(approval, { receipt: { ...approval.receipt, channel: "cooperative-file", authenticated: "none", attestation: "Edited on disk by the workspace user." } }),
	},
	"approval-unknown-request": {
		description: "A receipt must name a request the core issued.",
		subject: "receipt",
		expect: [{ code: "receipt-unknown-request", path: "/receipt/request_id" }],
		value: withPatch(approval, { receipt: { ...approval.receipt, request_id: "acr_000000000000000000000c02" } }),
	},
	"approval-replayed-nonce": {
		description: "A nonce is single use; a second approval with the same nonce is a replay.",
		subject: "receipt-replay",
		expect: [{ code: "receipt-replayed", path: "/receipt/nonce" }],
		value: withPatch(approval, { id: "apr_000000000000000000000a02" }),
	},
	"approval-nonce-mismatch": {
		description: "The receipt's nonce must equal the request's nonce.",
		subject: "receipt",
		expect: [{ code: "receipt-mismatch", path: "/receipt/nonce" }],
		value: withPatch(approval, { receipt: { ...approval.receipt, nonce: "ffffffffffffffffffffffffffffffff" } }),
	},
	"approval-cross-change": {
		description: "A receipt issued for one change cannot accept an attempt of another.",
		subject: "receipt",
		expect: [{ code: "cross-change-reference", path: "/change_id" }],
		value: withPatch(approval, { change_id: ID.change2 }),
	},
	"approval-wrong-attempt": {
		description: "A receipt binds one attempt; re-pointing it at another attempt is a mismatch.",
		subject: "receipt",
		expect: [{ code: "receipt-mismatch", path: "/attempt_id" }],
		value: withPatch(approval, { attempt_id: ID.attempt2 }),
	},
	"approval-candidate-digest-mismatch": {
		description: "A candidate edited after presentation has a different digest and does not inherit the decision.",
		subject: "receipt",
		expect: [{ code: "receipt-mismatch", path: "/candidate_digest" }],
		value: withPatch(approval, { candidate_digest: sha("edited after review") }),
	},
	"approval-presentation-digest-mismatch": {
		description: "A decision cannot be re-bound to a different presentation.",
		subject: "receipt",
		expect: [{ code: "receipt-mismatch", path: "/receipt/presentation_digest" }],
		value: withPatch(approval, { receipt: { ...approval.receipt, presentation_digest: sha("another presentation") } }),
	},
	"approval-expired": {
		description: "A decision after the request expired is stale.",
		subject: "receipt",
		expect: [{ code: "receipt-expired", path: "/receipt/responded_at" }],
		value: withPatch(approval, { decided_at: "2026-09-17T12:00:00Z", receipt: { ...approval.receipt, responded_at: "2026-09-17T12:00:00Z" } }),
	},
	"approval-responded-before-issued": {
		description: "A decision cannot precede the request it answers; the record itself is inconsistent.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/receipt/responded_at" }],
		value: withPatch(approval, { decided_at: "2026-09-17T10:39:00Z", receipt: { ...approval.receipt, responded_at: "2026-09-17T10:39:00Z" } }),
	},
	"approval-unknown-field-approve": {
		description: "There is no `approve` field on an approval record.",
		subject: "record",
		expect: [{ code: "unknown-field", path: "/approve" }],
		value: withPatch(approval, { approve: true }),
	},
	"approval-bad-nonce-grammar": {
		description: "A nonce is 32 lowercase hex characters.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/receipt/nonce" }],
		value: withPatch(approval, { receipt: { ...approval.receipt, nonce: "not-a-nonce" } }),
	},
	"bundle-slice-cross-change": {
		description: "A slice of another change cannot appear in this change's bundle.",
		subject: "bundle",
		expect: [{ code: "cross-change-reference", path: "/slices/0/change_id" }],
		value: withPatch(bundle, { slices: [withPatch(slice, { change_id: ID.change2 })] }),
	},
	"bundle-duplicate-record-ids": {
		description: "Record ids are unique across the bundle.",
		subject: "bundle",
		expect: [{ code: "duplicate-id", path: "/proofs/1/id" }],
		value: withPatch(bundle, { proofs: [proof, withPatch(proof2, { id: ID.proof })] }),
	},
	"bundle-attempt-unknown-slice": {
		description: "An attempt binds a slice that exists in the change.",
		subject: "bundle",
		expect: [{ code: "unknown-reference", path: "/attempts/0/slice_id" }],
		value: withPatch(bundle, { attempts: [withPatch(attempt, { slice_id: ID.slice2 })] }),
	},
	"bundle-attempt-candidate-missing": {
		description: "A bound candidate snapshot must exist.",
		subject: "bundle",
		expect: [{ code: "unknown-reference", path: "/attempts/0/candidate_snapshot_id" }],
		value: withPatch(bundle, { snapshots: [baseline] }),
	},
	"bundle-snapshot-role-swapped": {
		description: "The attempt's candidate binding must name a snapshot whose role is candidate.",
		subject: "bundle",
		expect: [{ code: "invalid-value", path: "/attempts/0/candidate_snapshot_id" }],
		value: withPatch(bundle, { attempts: [withPatch(attempt, { baseline_snapshot_id: ID.candidate, candidate_snapshot_id: ID.baseline })] }),
	},
	"bundle-proof-wrong-snapshot": {
		description: "A proof binds a snapshot of its own attempt.",
		subject: "bundle",
		expect: [{ code: "unknown-reference", path: "/proofs/0/snapshot_id" }],
		value: withPatch(bundle, { proofs: [withPatch(proof, { snapshot_id: "snp_00000000000000000000d009" }), proof2] }),
	},
	"bundle-proof-unknown-obligation": {
		description: "A proof discharges an obligation the slice declares.",
		subject: "bundle",
		expect: [{ code: "unknown-reference", path: "/proofs/0/obligation_id" }],
		value: withPatch(bundle, { proofs: [withPatch(proof, { obligation_id: "O9" }), proof2] }),
	},
	"bundle-review-stale-candidate-digest": {
		description: "A review's candidate digest must equal the bound snapshot's digest.",
		subject: "bundle",
		expect: [{ code: "digest-mismatch", path: "/reviews/0/candidate_digest" }],
		value: withPatch(bundle, { reviews: [withPatch(review, { candidate_digest: sha("older candidate") })] }),
	},
	"bundle-review-stale-input-digest": {
		description: "A review's input digest must equal the attempt's input digest.",
		subject: "bundle",
		expect: [{ code: "digest-mismatch", path: "/reviews/0/input_digest" }],
		value: withPatch(bundle, { reviews: [withPatch(review, { input_digest: sha("older inputs") })] }),
	},
	"bundle-slice-unknown-dependency": {
		description: "A slice dependency names a slice of the same change.",
		subject: "bundle",
		expect: [{ code: "unknown-reference", path: "/slices/0/depends_on/0" }],
		value: withPatch(bundle, { slices: [withPatch(slice, { depends_on: [ID.slice2] })] }),
	},
	"bundle-slice-unknown-scenario": {
		description: "A slice proves scenarios the change declares.",
		subject: "bundle",
		expect: [{ code: "unknown-reference", path: "/slices/0/scenario_ids/2" }],
		value: withPatch(bundle, { slices: [withPatch(slice, { scenario_ids: ["S1", "S2", "S7"] })] }),
	},
	"bundle-approval-wrong-slice": {
		description: "An approval's slice must be the attempt's slice.",
		subject: "bundle",
		expect: [{ code: "invalid-value", path: "/approvals/0/slice_id" }],
		value: withPatch(bundle, { slices: [slice, withPatch(slice, { id: ID.slice2, title: "another" })], approvals: [withPatch(approval, { slice_id: ID.slice2 })] }),
	},
	"request-approve-true": {
		description: "There is no field through which a caller can approve; `approve: true` is an unknown field.",
		subject: "request",
		expect: [{ code: "unknown-field", path: "/approve" }],
		value: { ...requests["request-acceptance"], approve: true },
	},
	"request-approval-payload": {
		description: "A caller cannot hand the core an approval record.",
		subject: "request",
		expect: [{ code: "unknown-field", path: "/approval" }],
		value: { ...requests["request-acceptance"], approval },
	},
	"request-host-capabilities-from-caller": {
		description: "Host capabilities are declared by the adapter, never by the payload.",
		subject: "request",
		expect: [{ code: "unknown-field", path: "/host" }],
		value: { ...requests["request-acceptance"], host: { human_acceptance: "host-native" } },
	},
	"request-unknown-action": {
		description: "There is no `approve` action.",
		subject: "request",
		expect: [{ code: "invalid-action", path: "/action" }],
		value: { action: "approve", change_id: ID.change, attempt_id: ID.attempt },
	},
	"request-plan-without-revision": {
		description: "Updating a projection requires the revision the caller read.",
		subject: "request",
		expect: [{ code: "missing-field", path: "/expected_revision" }],
		value: (() => {
			const v = clone(requests.plan);
			delete v.expected_revision;
			return v;
		})(),
	},
	"request-record-proof-agent-claimed-passes-validation": {
		description: "An agent-claimed proof is a valid request; the gate, not the parser, refuses it. Listed here so nobody 'fixes' the parser to hide claims.",
		subject: "request-valid",
		expect: [],
		value: (() => {
			const v = clone(requests["record-proof"]);
			v.proof.collector = "agent-claimed";
			delete v.proof.exit_code;
			v.proof.check = { kind: "test" };
			return v;
		})(),
	},
	"record-unknown-field-prototype-name": {
		description: "A field named like an Object.prototype member is still an unknown field.",
		subject: "record",
		expect: [{ code: "unknown-field", path: "/constructor" }],
		value: withPatch(change, { constructor: { approve: true } }),
	},
	"request-prototype-name-smuggle": {
		description: "`in` would have let a prototype name through; the request shape uses own-property checks.",
		subject: "request",
		expect: [{ code: "unknown-field", path: "/toString" }],
		value: { ...requests.status, toString: { approve: true } },
	},
	"request-create-duplicate-scenarios": {
		description: "Record-level rules apply to the request body too, so the caller sees the error at the request path.",
		subject: "request",
		expect: [{ code: "duplicate-id", path: "/acceptance_scenarios/1/id" }],
		value: { ...requests.create, acceptance_scenarios: [change.acceptance_scenarios[0], { ...change.acceptance_scenarios[1], id: "S1" }] },
	},
	"request-proof-attested-by-from-caller": {
		description: "attested_by is set by the adapter; a caller cannot vouch for itself.",
		subject: "request",
		expect: [{ code: "unknown-field", path: "/proof/provenance/attested_by" }],
		value: (() => {
			const v = clone(requests["record-proof"]);
			v.proof.provenance.attested_by = "adapter";
			return v;
		})(),
	},
	"request-capture-candidate-attested-by-from-caller": {
		description: "A caller-supplied snapshot cannot declare itself adapter-attested.",
		subject: "request",
		expect: [{ code: "unknown-field", path: "/snapshot/attested_by" }],
		value: { ...requests["capture-candidate"], snapshot: { ...candidateIdentity, stability: "stable", collector: "host-observed", attested_by: "adapter", captured_at: T.candidate } },
	},
	"request-acceptance-with-snapshot": {
		description: "request-acceptance carries no snapshot: the adapter re-reads the tree itself.",
		subject: "request",
		expect: [{ code: "unknown-field", path: "/candidate_snapshot" }],
		value: { ...requests["request-acceptance"], candidate_snapshot: { ...candidateIdentity, stability: "stable", collector: "host-observed", captured_at: T.candidate } },
	},
	"approval-trusted-channel-unauthenticated": {
		description: "A trusted channel binds to the host session; `none` on it is a mislabel.",
		subject: "record",
		expect: [{ code: "invalid-value", path: "/receipt/authenticated" }],
		value: withPatch(approval, { receipt: { ...approval.receipt, authenticated: "none" } }),
	},
	"approval-caller-attested-candidate": {
		description: "A candidate the adapter did not capture itself cannot bind an acceptance.",
		subject: "receipt-caller-candidate",
		expect: [{ code: "invalid-value", path: "/candidate_snapshot_id" }],
		value: clone(approval),
	},
	"snapshot-missing-attested-by": {
		description: "A stored snapshot always says who captured it.",
		subject: "record",
		expect: [{ code: "missing-field", path: "/attested_by" }],
		value: (() => {
			const v = clone(candidate);
			delete v.attested_by;
			return v;
		})(),
	},
	"snapshot-bad-timestamp-keeps-digest-check": {
		description: "An error outside the identity fields does not hide a digest mismatch.",
		subject: "record",
		expect: [
			{ code: "invalid-timestamp", path: "/captured_at" },
			{ code: "digest-mismatch", path: "/digest" },
		],
		value: withPatch(candidate, { captured_at: "yesterday", digest: sha("wrong") }),
	},
	"bundle-duplicate-nonce": {
		description: "Two approvals bound by one nonce inside a change is a replay the bundle can see.",
		subject: "bundle",
		expect: [{ code: "receipt-replayed", path: "/approvals/1/receipt/nonce" }],
		value: withPatch(bundle, { approvals: [approval, withPatch(approval, { id: "apr_000000000000000000000a02" })] }),
	},
	"bundle-proof-omits-obligation-scenario": {
		description: "A proof that discharges O1 must name O1's scenario.",
		subject: "bundle",
		expect: [{ code: "invalid-value", path: "/proofs/0/scenario_ids" }],
		value: withPatch(bundle, { proofs: [withPatch(proof, { scenario_ids: ["S2"] }), proof2] }),
	},
	"acceptance-request-ttl-too-long": {
		description: "A request cannot stay answerable for more than 24 hours.",
		subject: "acceptance-request",
		expect: [{ code: "invalid-value", path: "/expires_at" }],
		value: withPatch(acceptanceRequest, { expires_at: "2026-09-19T10:40:00Z" }),
	},
	"acceptance-request-presentation-digest-mismatch": {
		description: "A presentation edited after issue no longer matches its digest.",
		subject: "acceptance-request",
		expect: [{ code: "digest-mismatch", path: "/presentation_digest" }],
		value: withPatch(acceptanceRequest, { presentation: { ...presentation, limitations: [] } }),
	},
	"request-start-attempt-absolute-manifest-path": {
		description: "A host-supplied absolute path in a snapshot input is refused.",
		subject: "request",
		expect: [{ code: "invalid-path", path: "/baseline_snapshot/manifest/0/path" }],
		value: (() => {
			const v = clone(requests["start-attempt"]);
			v.baseline_snapshot.manifest[0].path = "/abs/path";
			return v;
		})(),
	},
};

// ---------- write ----------

async function writeJson(relPath, value) {
	const path = join(HERE, relPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

await writeJson("valid/change.json", change);
await writeJson("valid/change-minimal.json", minimalChange);
await writeJson("valid/slice.json", slice);
await writeJson("valid/attempt.json", attempt);
await writeJson("valid/snapshot-baseline.json", baseline);
await writeJson("valid/snapshot-candidate.json", candidate);
await writeJson("valid/proof.json", proof);
await writeJson("valid/proof-second-obligation.json", proof2);
await writeJson("valid/review.json", review);
await writeJson("valid/approval.json", approval);
await writeJson("valid/acceptance-request.json", acceptanceRequest);
await writeJson("valid/bundle.json", bundle);
for (const [action, request] of Object.entries(requests)) await writeJson(`valid/requests/${action}.json`, request);
for (const [name, fixture] of Object.entries(invalid)) await writeJson(`invalid/${name}.json`, fixture);
console.log(`wrote ${12 + Object.keys(requests).length + Object.keys(invalid).length} fixtures`);
