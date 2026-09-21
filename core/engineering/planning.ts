// Planning a repository-local change (E04, #402).
//
// The job here is narrow, because E01 and E02 already did the structural work:
// E01 owns the record shapes and `validateChangeBundle`, E02 owns storage.
// This module turns a change request into the two human-readable artifacts an
// agent actually works from — a brief and a plan — and refuses the cases where
// producing one would assert something nobody checked.
//
// Three rules shape everything below.
//
// A planner that always succeeds is a text generator. The value is in the
// refusals: a floating reference version, a slice that proves nothing, a
// dependency cycle. Each of those is a plan that looks executable and is not.
//
// A gap must be visible, never implied away. An acceptance scenario no slice
// covers is not necessarily wrong — it may be deliberately deferred — but the
// plan must say so in the artifact the agent reads, not leave the absence to
// be noticed.
//
// THE ARTIFACT IS EVIDENCE, SO ITS INPUT IS UNTRUSTED. A brief and a plan are
// what a human reads before approving work. Every free-text field is authored
// by the agent proposing the change, so with respect to the human reviewing
// it, that text is attacker-controlled. Interpolating it raw let a slice's
// `deliverable` forge a `## Unproved acceptance scenarios` section reading
// "Every acceptance scenario is claimed by a slice" ABOVE the real disclosure:
// the document a human approves claimed coverage it did not have. Free text is
// neutralized on the way in, so the only structure in the document is the
// structure this module wrote.
//
// Scope note (E04 minus the imported-spec seam): deriving a plan from an
// existing analysis artifact — a reimplementation spec or project plan — is
// deliberately NOT implemented here. That seam belongs to E09, which is on
// maintainer hold. `local_findings` below carries such artifacts only as
// disclosed context with a staleness flag; nothing reads their content.

import { SCENARIO_KINDS, CHANGE_MODES, COLLECTORS, CHECK_KINDS } from "./types.ts";
import type { ChangeMode, AcceptanceScenario, ReferenceBinding, SliceInput, ProofObligation } from "./types.ts";

export interface PlanningError {
	path: string;
	code: "invalid-value" | "unknown-reference" | "missing-field";
	message: string;
}

export interface ArtifactOutcome {
	ok: boolean;
	markdown?: string;
	errors?: PlanningError[];
}

/** A local analysis artifact offered as context. Its CONTENT is never read here — see the scope note above. */
export interface LocalFinding {
	path: string;
	captured_at?: string;
	stale?: boolean;
}

export interface ChangeBriefRequest {
	title: string;
	mode: ChangeMode;
	requested_outcome: string;
	baseline: { vcs: string; head?: string; description?: string };
	scope: { in_scope: string[]; non_goals: string[] };
	preserved_contracts: string[];
	acceptance_scenarios: AcceptanceScenario[];
	references?: ReferenceBinding[];
	/** Premises the requester has NOT established. Surfaced, neutralized. */
	uncertainties?: string[];
	local_findings?: LocalFinding[];
}

export interface BuildEnvironment {
	build_command: string | null;
	test_command: string | null;
}

export interface PlanReadiness {
	executable: boolean;
	blockers: string[];
}

export interface UnprovedObligation {
	scenario_id: string;
	description: string;
	reason: string;
}

/**
 * Modes whose acceptance is a recorded finding rather than a passing suite.
 * Requiring a test command here would block the work that establishes whether
 * a fix is even possible.
 *
 * The exemption is per CHECK KIND, not blanket. An investigation that claims a
 * `build` obligation still needs a build command, because only running one can
 * discharge it; waiving every kind made `executable: true` meaningless.
 */
const FINDING_MODES = new Set<ChangeMode>(["investigation"]);
const FINDING_EXEMPT_KINDS = new Set(["test"]);

function fail(errors: PlanningError[], path: string, code: PlanningError["code"], message: string): void {
	errors.push({ path, code, message });
}

/**
 * Render agent-authored text so it cannot create document structure.
 *
 * A `deliverable` of "a helper\n\n## Unproved acceptance scenarios\n\n_Every
 * acceptance scenario is claimed by a slice._" forged the coverage disclosure
 * above the real one. Newlines are what make that possible — a heading or a
 * fence must start a line — so free text is collapsed to one line and the
 * markers that could still open a construct are escaped.
 *
 * Returns `null` when the value is not usable text, so callers refuse rather
 * than render `undefined` into the artifact.
 */
function safeText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const collapsed = value
		// Every line terminator, including the two that are easy to forget:
		// U+2028 and U+2029 begin a new line in many renderers.
		.replace(/[\r\n\u2028\u2029]+/g, " ")
		// Other C0/C1 controls carry no meaning here and can conceal text.
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
		.trim();
	if (collapsed === "") return null;
	// Only a LEADING block marker is escaped. Backticks are deliberately left
	// alone: naming a field as `source_repo` is exactly how a preserved
	// contract should read, and escaping them rendered a visible backslash in
	// every legitimate description. They are also not a forgery route — a code
	// span cannot cross a blank line, so it cannot reach out of the paragraph
	// it sits in and swallow the disclosure below, and a fence must begin a
	// line, which the collapse above already prevents.
	return collapsed.replace(/^([#>\-*+]|\d+\.)/, "\\$1");
}

/** `sha256:<64 lowercase hex>` — the only digest format v1 defines. */
function isDigest(value: unknown): boolean {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * A version is exact when it names one immutable thing.
 *
 * `1.0+main` and `1.0-latest` are branch pointers wearing a version's clothes:
 * they satisfy a semver-shaped pattern and resolve to different bytes tomorrow,
 * which is the whole failure a bound reference exists to prevent. A 40-char
 * commit hash is accepted because it is maximally exact. Leading zeros are
 * refused so one release has one spelling — `0001.2` and `1.2` would otherwise
 * be two identities for one thing.
 */
function isExactVersion(version: unknown): boolean {
	if (typeof version !== "string" || version === "") return false;
	if (/^[0-9a-f]{40}$/.test(version)) return true;
	return /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$/.test(version);
}

/** The value as a string array, or `null` when it is anything else. Never throws. */
function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

/** A free-text list field, neutralized. A non-list is refused rather than crashing the caller. */
function safeList(value: unknown, path: string, errors: PlanningError[]): string[] {
	if (value === undefined) return [];
	const raw = stringArray(value);
	if (raw === null) {
		fail(errors, path, "invalid-value", `${path} must be a list of strings`);
		return [];
	}
	return raw.map((v) => safeText(v)).filter((v): v is string => v !== null);
}

/**
 * Read every field of the request exactly once, into a frozen plain object.
 *
 * The request arrives from a host and may define `acceptance_scenarios` as a
 * getter. It was read three times, so a getter could hand the validator a full
 * list and the coverage check a shorter one — the plan then rendered "every
 * scenario is claimed" while a real gap existed. One read, then work from the
 * copy.
 */
function snapshotRequest(request: ChangeBriefRequest): ChangeBriefRequest {
	const source = (request ?? {}) as ChangeBriefRequest;
	const copyArray = (v: unknown) => (Array.isArray(v) ? [...v] : v);
	return Object.freeze({
		title: source.title,
		mode: source.mode,
		requested_outcome: source.requested_outcome,
		baseline: source.baseline,
		scope: source.scope,
		preserved_contracts: copyArray(source.preserved_contracts),
		acceptance_scenarios: copyArray(source.acceptance_scenarios),
		references: copyArray(source.references),
		uncertainties: copyArray(source.uncertainties),
		local_findings: copyArray(source.local_findings),
	}) as ChangeBriefRequest;
}

function checkScenarios(scenarios: unknown, errors: PlanningError[]): AcceptanceScenario[] {
	if (!Array.isArray(scenarios) || scenarios.length === 0) {
		fail(
			errors,
			"/acceptance_scenarios",
			"invalid-value",
			"a change with no acceptance scenarios cannot be planned: there is nothing a slice could prove",
		);
		return [];
	}
	const seen = new Set<string>();
	const valid: AcceptanceScenario[] = [];
	for (const [i, raw] of scenarios.entries()) {
		const s = raw as AcceptanceScenario;
		const description = safeText(s?.description);
		if (!s || typeof s.id !== "string" || s.id.trim() === "" || description === null) {
			fail(errors, `/acceptance_scenarios/${i}`, "invalid-value", "a scenario needs a non-empty id and description");
			continue;
		}
		if (!SCENARIO_KINDS.includes(s.kind)) {
			fail(errors, `/acceptance_scenarios/${i}/kind`, "invalid-value", `unknown scenario kind ${JSON.stringify(s.kind)}`);
			continue;
		}
		if (seen.has(s.id)) {
			fail(errors, `/acceptance_scenarios/${i}/id`, "invalid-value", `duplicate scenario id ${s.id}`);
			continue;
		}
		seen.add(s.id);
		// Carry the neutralized text forward so every later reader sees the
		// same safe value.
		valid.push({ id: s.id, kind: s.kind, description });
	}
	return valid;
}

function checkReferences(references: unknown, errors: PlanningError[]): ReferenceBinding[] {
	if (references === undefined) return [];
	if (!Array.isArray(references)) {
		fail(errors, "/references", "invalid-value", "references must be a list");
		return [];
	}
	const valid: ReferenceBinding[] = [];
	for (const [i, raw] of references.entries()) {
		const r = raw as ReferenceBinding;
		if (!r || typeof r.id !== "string" || r.id.trim() === "") {
			fail(errors, `/references/${i}`, "invalid-value", "a reference needs an id");
			continue;
		}
		if (!isExactVersion(r.version)) {
			// The point of binding a reference is that the bytes the plan was
			// written against can be identified later. A range or a branch
			// pointer cannot do that, so it is refused rather than resolved to
			// whatever it happens to mean today.
			fail(
				errors,
				`/references/${i}/version`,
				"invalid-value",
				`reference ${r.id} needs an exact version, got ${JSON.stringify(r.version)}`,
			);
			continue;
		}
		// E01's REFERENCE_SHAPE requires a digest. Accepting one without it
		// produces a plan for a change that can never be stored, and the
		// divergence surfaces only after the work is done.
		if (!isDigest(r.digest)) {
			fail(
				errors,
				`/references/${i}/digest`,
				"invalid-value",
				`reference ${r.id} needs a sha256 digest of the bytes read at planning time`,
			);
			continue;
		}
		valid.push({ id: r.id, version: r.version, digest: r.digest });
	}
	return valid;
}

function bulletList(items: string[], empty: string): string {
	if (items.length === 0) return `_${empty}_\n`;
	return `${items.map((i) => `- ${i}`).join("\n")}\n`;
}

/**
 * The checks a change must pass before EITHER artifact is produced. Shared so
 * the brief and the plan cannot disagree about what a valid change is: the
 * plan used to accept a mode and a reference version the brief refused.
 */
function checkChangeCore(request: ChangeBriefRequest, errors: PlanningError[]): AcceptanceScenario[] {
	if (!request || typeof request !== "object") {
		fail(errors, "", "invalid-value", "a change request is required");
		return [];
	}
	for (const field of ["title", "requested_outcome"] as const) {
		if (safeText(request[field]) === null) {
			fail(errors, `/${field}`, "missing-field", `${field} is required`);
		}
	}
	if (!CHANGE_MODES.includes(request.mode)) {
		fail(errors, "/mode", "invalid-value", `unknown change mode ${JSON.stringify(request.mode)}`);
	}
	const scenarios = checkScenarios(request.acceptance_scenarios, errors);
	checkReferences(request.references, errors);
	return scenarios;
}

/**
 * The brief: what is being asked for, what must not break, and what is not
 * yet known. Grounded entirely in the repository — a change with no library
 * configured is the normal case, and the brief never mentions its absence.
 */
export function buildChangeBrief(request: ChangeBriefRequest): ArtifactOutcome {
	const errors: PlanningError[] = [];
	const snapshot = snapshotRequest(request);
	const scenarios = checkChangeCore(snapshot, errors);
	const inScope = safeList(snapshot.scope?.in_scope, "/scope/in_scope", errors);
	const nonGoals = safeList(snapshot.scope?.non_goals, "/scope/non_goals", errors);
	const preserved = safeList(snapshot.preserved_contracts, "/preserved_contracts", errors);
	const uncertainties = safeList(snapshot.uncertainties, "/uncertainties", errors);

	if (errors.length > 0) return { ok: false, errors };

	// Already validated by checkChangeCore; re-derived here for rendering.
	const references = checkReferences(snapshot.references, []);
	const baseline = snapshot.baseline ?? { vcs: "none" };
	const baselineLine = [
		safeText(baseline.description),
		typeof baseline.head === "string" ? `\`${safeText(baseline.head) ?? ""}\`` : null,
		`(${safeText(baseline.vcs) ?? "unknown"})`,
	]
		.filter(Boolean)
		.join(" ");

	const sections: string[] = [
		`# Change brief: ${safeText(snapshot.title)}`,
		"",
		`**Mode:** ${snapshot.mode}`,
		"",
		"## Requested outcome",
		"",
		safeText(snapshot.requested_outcome) ?? "",
		"",
		"## Baseline",
		"",
		baselineLine,
		"",
		"## In scope",
		"",
		bulletList(inScope, "nothing listed"),
		"## Non-goals",
		"",
		bulletList(nonGoals, "none stated"),
		"## Contracts that must not break",
		"",
		bulletList(preserved, "none identified"),
		"## Acceptance scenarios",
		"",
		scenarios.map((s) => `- \`${s.id}\` (${s.kind}) — ${s.description}`).join("\n"),
		"",
	];

	// Uncertainty is stated as uncertainty. A brief that presents an
	// unverified premise as established hands the agent the confidence
	// without the evidence.
	if (uncertainties.length > 0) {
		sections.push(
			"## Open questions — not established",
			"",
			"These are uncertain and have not been verified. Do not plan as though they are settled:",
			"",
			bulletList(uncertainties, ""),
		);
	}

	if (references.length > 0) {
		sections.push(
			"## Bound references",
			"",
			references.map((r) => `- \`${safeText(r.id)}\` at exact version **${r.version}** (\`${r.digest}\`)`).join("\n"),
			"",
		);
	}

	const findings = Array.isArray(snapshot.local_findings) ? snapshot.local_findings : [];
	if (findings.length > 0) {
		sections.push("## Local analysis artifacts", "");
		for (const f of findings) {
			const path = safeText(f?.path);
			if (path === null) continue;
			// A stale artifact is disclosed as stale. Using one silently is how
			// a plan ends up describing a repository that no longer exists.
			const note = f.stale
				? " — **stale**: captured before the current baseline and may no longer describe this repository"
				: f.captured_at
					? ` — captured ${safeText(f.captured_at) ?? "at an unstated time"}`
					: "";
			sections.push(`- \`${path}\`${note}`);
		}
		sections.push("");
	}

	return { ok: true, markdown: sections.join("\n") };
}

interface NormalizedSlice {
	/** Position in the submitted array. The dependency graph is keyed by this, never by a caller-supplied id. */
	index: number;
	declaredId: string | null;
	title: string;
	deliverable: string;
	scenario_ids: string[];
	depends_on: string[];
	proof_obligations: Array<ProofObligation & { description: string }>;
}

function normalizeSlices(slices: unknown, scenarioIds: Set<string>, errors: PlanningError[]): NormalizedSlice[] {
	if (!Array.isArray(slices) || slices.length === 0) {
		fail(errors, "/slices", "invalid-value", "a plan needs at least one slice");
		return [];
	}
	const out: NormalizedSlice[] = [];
	const seenIds = new Set<string>();
	for (const [i, raw] of slices.entries()) {
		const s = raw as SliceInput & { id?: string };
		const at = `/slices/${i}`;
		const title = safeText(s?.title);
		const deliverable = safeText(s?.deliverable);
		if (!s || title === null || deliverable === null) {
			fail(errors, at, "invalid-value", "a slice needs a title and a deliverable");
			continue;
		}
		// Two slices sharing an id let the later one overwrite the earlier
		// node in the dependency graph, which hid a real cycle behind an
		// accepted plan.
		if (typeof s.id === "string") {
			if (seenIds.has(s.id)) {
				fail(errors, `${at}/id`, "invalid-value", `duplicate slice id ${s.id}`);
				continue;
			}
			seenIds.add(s.id);
		}
		const ids = stringArray(s.scenario_ids) ?? [];
		if (ids.length === 0) {
			fail(errors, `${at}/scenario_ids`, "invalid-value", `slice ${JSON.stringify(title)} proves no scenario; that is not planning`);
			continue;
		}
		if (new Set(ids).size !== ids.length) {
			// E01's `uniqueStrings` refuses this, so accepting it here produces
			// a plan for a slice that can never be stored.
			fail(errors, `${at}/scenario_ids`, "invalid-value", `slice ${JSON.stringify(title)} names the same scenario twice`);
			continue;
		}
		let sliceFailed = false;
		for (const [j, id] of ids.entries()) {
			if (!scenarioIds.has(id)) {
				fail(errors, `${at}/scenario_ids/${j}`, "unknown-reference", `no scenario ${id} in this change`);
				sliceFailed = true;
			}
		}
		const obligations = Array.isArray(s.proof_obligations) ? s.proof_obligations : [];
		// E01 requires at least one. A slice with none rendered as provable,
		// reported `executable: true`, and proved nothing — the exact shape
		// this module claims to refuse.
		if (obligations.length === 0) {
			fail(
				errors,
				`${at}/proof_obligations`,
				"invalid-value",
				`slice ${JSON.stringify(title)} carries no proof obligation; nothing would establish its claim`,
			);
			continue;
		}
		const normalizedObligations: Array<ProofObligation & { description: string }> = [];
		for (const [j, o] of obligations.entries()) {
			const description = safeText(o?.description);
			if (!o || typeof o.id !== "string" || description === null) {
				fail(errors, `${at}/proof_obligations/${j}`, "invalid-value", "an obligation needs an id and a description");
				sliceFailed = true;
				continue;
			}
			if (!CHECK_KINDS.includes(o.check_kind)) {
				fail(errors, `${at}/proof_obligations/${j}/check_kind`, "invalid-value", `unknown check kind ${JSON.stringify(o.check_kind)}`);
				sliceFailed = true;
				continue;
			}
			// `agent-claimed` is excluded by the contract: an obligation whose
			// weakest acceptable collector is the agent's own word is not an
			// obligation at all.
			//
			// The declared type already excludes it, so TypeScript considers
			// this comparison dead — but the value arrives as untrusted JSON
			// from a host, where the type is a claim rather than a guarantee.
			const collector = o.minimum_collector as string;
			if (!COLLECTORS.includes(collector as (typeof COLLECTORS)[number]) || collector === "agent-claimed") {
				fail(
					errors,
					`${at}/proof_obligations/${j}/minimum_collector`,
					"invalid-value",
					`obligation ${o.id} must name an observed collector, got ${JSON.stringify(o.minimum_collector)}`,
				);
				sliceFailed = true;
				continue;
			}
			if (typeof o.scenario_id === "string" && !ids.includes(o.scenario_id)) {
				fail(
					errors,
					`${at}/proof_obligations/${j}/scenario_id`,
					"unknown-reference",
					`obligation ${o.id} proves scenario ${o.scenario_id}, which slice ${JSON.stringify(title)} does not claim`,
				);
				sliceFailed = true;
				continue;
			}
			normalizedObligations.push({ ...o, description });
		}
		if (sliceFailed) continue;
		out.push({
			index: i,
			declaredId: typeof s.id === "string" ? s.id : null,
			title,
			deliverable,
			scenario_ids: ids,
			depends_on: stringArray(s.depends_on) ?? [],
			proof_obligations: normalizedObligations,
		});
	}
	return out;
}

/**
 * E01 refuses a self-dependency and an unknown dependency; neither catches
 * `a -> b -> a`. A cycle is a plan with no executable first step, so it is
 * refused here rather than discovered when execution stalls.
 *
 * The graph is keyed by ARRAY INDEX and declared ids are resolved to indices
 * separately. Keying by the caller's id let a duplicate overwrite a cyclic
 * node, and let a slice declare the synthetic `#0` form to impersonate an
 * unnamed one — both hid real cycles.
 */
function findCycle(slices: NormalizedSlice[]): string[] | null {
	const indexById = new Map<string, number>();
	for (const s of slices) {
		if (s.declaredId !== null) indexById.set(s.declaredId, s.index);
	}
	const byIndex = new Map(slices.map((s) => [s.index, s]));
	const state = new Map<number, "visiting" | "done">();
	const stack: number[] = [];
	const label = (i: number) => byIndex.get(i)?.declaredId ?? `slice #${i}`;

	function walk(index: number): number[] | null {
		const current = state.get(index);
		if (current === "done") return null;
		if (current === "visiting") return [...stack.slice(stack.indexOf(index)), index];
		const slice = byIndex.get(index);
		if (!slice) return null;
		state.set(index, "visiting");
		stack.push(index);
		for (const dep of slice.depends_on) {
			const depIndex = indexById.get(dep);
			if (depIndex === undefined) continue;
			const cycle = walk(depIndex);
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(index, "done");
		return null;
	}

	for (const slice of slices) {
		const cycle = walk(slice.index);
		if (cycle) return cycle.map(label);
	}
	return null;
}

/** Scenarios the change declares that no slice proves. Reported, never silently dropped. */
export function describeUnprovedObligations(request: ChangeBriefRequest, slices: SliceInput[]): UnprovedObligation[] {
	const snapshot = snapshotRequest(request);
	const scenarios = Array.isArray(snapshot.acceptance_scenarios) ? snapshot.acceptance_scenarios : [];
	const covered = new Set<string>();
	for (const s of Array.isArray(slices) ? slices : []) {
		for (const id of stringArray(s?.scenario_ids) ?? []) covered.add(id);
	}
	return scenarios
		.filter((s) => s && typeof s.id === "string" && !covered.has(s.id))
		.map((s) => ({
			scenario_id: s.id,
			description: safeText(s.description) ?? "",
			reason: "no slice in this plan claims to prove it",
		}));
}

/** The plan: slices, what each delivers, and what would prove it. */
export function buildChangePlan(request: ChangeBriefRequest, slices: SliceInput[]): ArtifactOutcome {
	const errors: PlanningError[] = [];
	const snapshot = snapshotRequest(request);
	// The same core checks as the brief, so a plan cannot be produced for a
	// change the brief would have refused.
	const scenarios = checkChangeCore(snapshot, errors);
	const scenarioIds = new Set(scenarios.map((s) => s.id));
	const normalized = normalizeSlices(slices, scenarioIds, errors);

	const cycle = findCycle(normalized);
	if (cycle) {
		fail(errors, "/slices", "invalid-value", `dependency cycle between slices: ${cycle.join(" -> ")}`);
	}

	if (errors.length > 0) return { ok: false, errors };

	const sections: string[] = [`# Change plan: ${safeText(snapshot.title)}`, "", "## Slices", ""];
	for (const s of normalized) {
		sections.push(`### ${s.title}`, "", `**Delivers:** ${s.deliverable}`, "", `**Proves:** ${s.scenario_ids.map((i) => `\`${i}\``).join(", ")}`, "");
		if (s.depends_on.length > 0) {
			sections.push(`**Depends on:** ${s.depends_on.map((d) => `\`${safeText(d) ?? ""}\``).join(", ")}`, "");
		}
		// Unconditional: every slice reaching here has at least one obligation,
		// so the heading cannot be absent in a way that reads as "nothing to
		// prove" rather than "nothing recorded".
		sections.push("**Proof obligations:**", "");
		for (const o of s.proof_obligations) {
			sections.push(`- \`${o.id}\` (${o.check_kind}, minimum collector \`${o.minimum_collector}\`) — ${o.description}`);
		}
		sections.push("");
	}

	const unproved = describeUnprovedObligations(snapshot, slices);
	sections.push("## Unproved acceptance scenarios", "");
	if (unproved.length === 0) {
		sections.push("_Every acceptance scenario is claimed by a slice._", "");
	} else {
		// Stated in the artifact the agent reads. An uncovered scenario may be
		// a deliberate deferral, but it must never be discovered by its absence.
		sections.push("These scenarios are **not proved** by any slice in this plan:", "");
		for (const u of unproved) {
			sections.push(`- \`${u.scenario_id}\` — ${u.description} (${u.reason})`);
		}
		sections.push("");
	}

	return { ok: true, markdown: sections.join("\n") };
}

/**
 * Whether this plan can actually be executed here. A plan that names a `test`
 * obligation in a workspace with no test command is not executable, and saying
 * so up front is cheaper than discovering it at proof time.
 */
export function planReadiness(request: ChangeBriefRequest, slices: SliceInput[], environment: BuildEnvironment): PlanReadiness {
	const blockers: string[] = [];
	const kinds = new Set<string>();
	for (const s of Array.isArray(slices) ? slices : []) {
		for (const o of Array.isArray(s?.proof_obligations) ? s.proof_obligations : []) {
			if (o && typeof o.check_kind === "string") kinds.add(o.check_kind);
		}
	}

	// The exemption is per check kind. An investigation claiming a `build`
	// obligation still needs a build command: only running one discharges it.
	const findingMode = FINDING_MODES.has(request?.mode);
	const exempt = (kind: string) => findingMode && FINDING_EXEMPT_KINDS.has(kind);

	if (kinds.has("test") && !environment?.test_command && !exempt("test")) {
		blockers.push("a slice requires a `test` obligation but no test command is configured for this workspace");
	}
	if ((kinds.has("build") || kinds.has("typecheck")) && !environment?.build_command) {
		blockers.push("a slice requires a `build` or `typecheck` obligation but no build command is configured for this workspace");
	}

	return { executable: blockers.length === 0, blockers };
}
