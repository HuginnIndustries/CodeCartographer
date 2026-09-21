// Planning a repository-local change (E04, #402).
//
// The job here is narrow, because E01 and E02 already did the structural work:
// E01 owns the record shapes and `validateChangeBundle`, E02 owns storage.
// This module turns a change request into the two human-readable artifacts an
// agent actually works from — a brief and a plan — and refuses the cases where
// producing one would assert something nobody checked.
//
// Two rules shape everything below.
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
	/** Premises the requester has NOT established. Surfaced verbatim. */
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
 */
const FINDING_MODES = new Set<ChangeMode>(["investigation"]);

function fail(errors: PlanningError[], path: string, code: PlanningError["code"], message: string): void {
	errors.push({ path, code, message });
}

/** `1.4.2` yes; `latest`, `^1.0`, `main` no. A floating version is not a reference, it is a hope. */
function isExactVersion(version: unknown): boolean {
	return typeof version === "string" && /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/.test(version);
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
		if (!s || typeof s.id !== "string" || typeof s.description !== "string") {
			fail(errors, `/acceptance_scenarios/${i}`, "invalid-value", "a scenario needs an id and a description");
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
		valid.push(s);
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
		if (!r || typeof r.id !== "string") {
			fail(errors, `/references/${i}`, "invalid-value", "a reference needs an id");
			continue;
		}
		if (!isExactVersion(r.version)) {
			// The whole point of binding a reference is that the bytes the plan
			// was written against can be identified later. A range cannot do
			// that, so it is refused rather than resolved to something today.
			fail(
				errors,
				`/references/${i}/version`,
				"invalid-value",
				`reference ${r.id} needs an exact version, got ${JSON.stringify(r.version)}`,
			);
			continue;
		}
		valid.push(r);
	}
	return valid;
}

function bulletList(items: string[], empty: string): string {
	if (items.length === 0) return `_${empty}_\n`;
	return `${items.map((i) => `- ${i}`).join("\n")}\n`;
}

/**
 * The brief: what is being asked for, what must not break, and what is not
 * yet known. Grounded entirely in the repository — a change with no library
 * configured is the normal case, and the brief never mentions its absence.
 */
export function buildChangeBrief(request: ChangeBriefRequest): ArtifactOutcome {
	const errors: PlanningError[] = [];

	if (!request || typeof request !== "object") {
		return { ok: false, errors: [{ path: "", code: "invalid-value", message: "a change request is required" }] };
	}
	for (const field of ["title", "requested_outcome"] as const) {
		if (typeof request[field] !== "string" || request[field].trim() === "") {
			fail(errors, `/${field}`, "missing-field", `${field} is required`);
		}
	}
	if (!CHANGE_MODES.includes(request.mode)) {
		fail(errors, "/mode", "invalid-value", `unknown change mode ${JSON.stringify(request.mode)}`);
	}
	const scenarios = checkScenarios(request.acceptance_scenarios, errors);
	const references = checkReferences(request.references, errors);

	if (errors.length > 0) return { ok: false, errors };

	const baseline = request.baseline ?? { vcs: "none" };
	const baselineLine = [baseline.description, baseline.head ? `\`${baseline.head}\`` : null, `(${baseline.vcs})`]
		.filter(Boolean)
		.join(" ");

	const sections: string[] = [
		`# Change brief: ${request.title}`,
		"",
		`**Mode:** ${request.mode}`,
		"",
		"## Requested outcome",
		"",
		request.requested_outcome,
		"",
		"## Baseline",
		"",
		baselineLine,
		"",
		"## In scope",
		"",
		bulletList(request.scope?.in_scope ?? [], "nothing listed"),
		"## Non-goals",
		"",
		bulletList(request.scope?.non_goals ?? [], "none stated"),
		"## Contracts that must not break",
		"",
		bulletList(request.preserved_contracts ?? [], "none identified"),
		"## Acceptance scenarios",
		"",
		scenarios.map((s) => `- \`${s.id}\` (${s.kind}) — ${s.description}`).join("\n"),
		"",
	];

	// Uncertainty is stated as uncertainty. A brief that presents an
	// unverified premise as established hands the agent the confidence
	// without the evidence.
	const uncertainties = Array.isArray(request.uncertainties) ? request.uncertainties.filter((u) => typeof u === "string") : [];
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
			references.map((r) => `- \`${r.id}\` at exact version **${r.version}**`).join("\n"),
			"",
		);
	}

	const findings = Array.isArray(request.local_findings) ? request.local_findings : [];
	if (findings.length > 0) {
		sections.push("## Local analysis artifacts", "");
		for (const f of findings) {
			// A stale artifact is disclosed as stale. Using one silently is how
			// a plan ends up describing a repository that no longer exists.
			const note = f.stale
				? " — **stale**: captured before the current baseline and may no longer describe this repository"
				: f.captured_at
					? ` — captured ${f.captured_at}`
					: "";
			sections.push(`- \`${f.path}\`${note}`);
		}
		sections.push("");
	}

	return { ok: true, markdown: sections.join("\n") };
}

interface NormalizedSlice {
	id: string;
	title: string;
	deliverable: string;
	scenario_ids: string[];
	depends_on: string[];
	proof_obligations: ProofObligation[];
}

function normalizeSlices(slices: unknown, scenarioIds: Set<string>, errors: PlanningError[]): NormalizedSlice[] {
	if (!Array.isArray(slices) || slices.length === 0) {
		fail(errors, "/slices", "invalid-value", "a plan needs at least one slice");
		return [];
	}
	const out: NormalizedSlice[] = [];
	for (const [i, raw] of slices.entries()) {
		const s = raw as SliceInput & { id?: string };
		const at = `/slices/${i}`;
		if (!s || typeof s.title !== "string" || typeof s.deliverable !== "string") {
			fail(errors, at, "invalid-value", "a slice needs a title and a deliverable");
			continue;
		}
		const ids = Array.isArray(s.scenario_ids) ? s.scenario_ids.filter((x): x is string => typeof x === "string") : [];
		if (ids.length === 0) {
			fail(errors, `${at}/scenario_ids`, "invalid-value", `slice ${JSON.stringify(s.title)} proves no scenario; that is not planning`);
			continue;
		}
		for (const [j, id] of ids.entries()) {
			if (!scenarioIds.has(id)) {
				fail(errors, `${at}/scenario_ids/${j}`, "unknown-reference", `no scenario ${id} in this change`);
			}
		}
		const obligations = Array.isArray(s.proof_obligations) ? s.proof_obligations : [];
		for (const [j, o] of obligations.entries()) {
			if (!o || typeof o.id !== "string") {
				fail(errors, `${at}/proof_obligations/${j}`, "invalid-value", "an obligation needs an id");
				continue;
			}
			if (!CHECK_KINDS.includes(o.check_kind)) {
				fail(errors, `${at}/proof_obligations/${j}/check_kind`, "invalid-value", `unknown check kind ${JSON.stringify(o.check_kind)}`);
			}
			// `agent-claimed` is excluded by the contract: an obligation whose
			// weakest acceptable collector is the agent's own word is not an
			// obligation at all.
			//
			// The declared type already excludes it, so TypeScript considers
			// this comparison dead — but the value arrives as untrusted JSON
			// from a host, where the type is a claim rather than a guarantee.
			// Widened to `string` so the runtime check survives; deleting it
			// because the compiler cannot see the case would be exactly the
			// wrong lesson.
			const collector = o.minimum_collector as string;
			if (!COLLECTORS.includes(collector as (typeof COLLECTORS)[number]) || collector === "agent-claimed") {
				fail(
					errors,
					`${at}/proof_obligations/${j}/minimum_collector`,
					"invalid-value",
					`obligation ${o.id} must name an observed collector, got ${JSON.stringify(o.minimum_collector)}`,
				);
			}
			if (typeof o.scenario_id === "string" && !ids.includes(o.scenario_id)) {
				fail(
					errors,
					`${at}/proof_obligations/${j}/scenario_id`,
					"unknown-reference",
					`obligation ${o.id} proves scenario ${o.scenario_id}, which slice ${JSON.stringify(s.title)} does not claim`,
				);
			}
		}
		out.push({
			id: typeof s.id === "string" ? s.id : `#${i}`,
			title: s.title,
			deliverable: s.deliverable,
			scenario_ids: ids,
			depends_on: Array.isArray(s.depends_on) ? s.depends_on.filter((d): d is string => typeof d === "string") : [],
			proof_obligations: obligations as ProofObligation[],
		});
	}
	return out;
}

/**
 * E01 refuses a self-dependency and an unknown dependency; neither catches
 * `a -> b -> a`. A cycle is a plan with no executable first step, so it is
 * refused here rather than discovered when execution stalls.
 */
function findCycle(slices: NormalizedSlice[]): string[] | null {
	const byId = new Map(slices.map((s) => [s.id, s]));
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];

	function walk(id: string): string[] | null {
		const current = state.get(id);
		if (current === "done") return null;
		if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
		const slice = byId.get(id);
		if (!slice) return null;
		state.set(id, "visiting");
		stack.push(id);
		for (const dep of slice.depends_on) {
			const cycle = walk(dep);
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(id, "done");
		return null;
	}

	for (const slice of slices) {
		const cycle = walk(slice.id);
		if (cycle) return cycle;
	}
	return null;
}

/** Scenarios the change declares that no slice proves. Reported, never silently dropped. */
export function describeUnprovedObligations(request: ChangeBriefRequest, slices: SliceInput[]): UnprovedObligation[] {
	const scenarios = Array.isArray(request?.acceptance_scenarios) ? request.acceptance_scenarios : [];
	const covered = new Set<string>();
	for (const s of Array.isArray(slices) ? slices : []) {
		for (const id of Array.isArray(s?.scenario_ids) ? s.scenario_ids : []) {
			if (typeof id === "string") covered.add(id);
		}
	}
	return scenarios
		.filter((s) => s && typeof s.id === "string" && !covered.has(s.id))
		.map((s) => ({
			scenario_id: s.id,
			description: s.description,
			reason: "no slice in this plan claims to prove it",
		}));
}

/** The plan: slices, what each delivers, and what would prove it. */
export function buildChangePlan(request: ChangeBriefRequest, slices: SliceInput[]): ArtifactOutcome {
	const errors: PlanningError[] = [];
	const scenarios = checkScenarios(request?.acceptance_scenarios, errors);
	const scenarioIds = new Set(scenarios.map((s) => s.id));
	const normalized = normalizeSlices(slices, scenarioIds, errors);

	const cycle = findCycle(normalized);
	if (cycle) {
		fail(errors, "/slices", "invalid-value", `dependency cycle between slices: ${cycle.join(" -> ")}`);
	}

	if (errors.length > 0) return { ok: false, errors };

	const sections: string[] = [`# Change plan: ${request.title}`, "", "## Slices", ""];
	for (const s of normalized) {
		sections.push(`### ${s.title}`, "", `**Delivers:** ${s.deliverable}`, "", `**Proves:** ${s.scenario_ids.map((i) => `\`${i}\``).join(", ")}`, "");
		if (s.depends_on.length > 0) {
			sections.push(`**Depends on:** ${s.depends_on.map((d) => `\`${d}\``).join(", ")}`, "");
		}
		if (s.proof_obligations.length > 0) {
			sections.push("**Proof obligations:**", "");
			for (const o of s.proof_obligations) {
				sections.push(`- \`${o.id}\` (${o.check_kind}, minimum collector \`${o.minimum_collector}\`) — ${o.description}`);
			}
			sections.push("");
		}
	}

	const unproved = describeUnprovedObligations(request, slices);
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

	const findingMode = FINDING_MODES.has(request?.mode);
	if (kinds.has("test") && !environment?.test_command && !findingMode) {
		blockers.push("a slice requires a `test` obligation but no test command is configured for this workspace");
	}
	if ((kinds.has("build") || kinds.has("typecheck")) && !environment?.build_command && !findingMode) {
		blockers.push("a slice requires a `build` or `typecheck` obligation but no build command is configured for this workspace");
	}

	return { executable: blockers.length === 0, blockers };
}
