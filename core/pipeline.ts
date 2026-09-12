// Pipeline alias resolution, DAG walking, and phase-output validation.

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	PipelineFile,
	PipelinePhase,
	ValidationResult,
	WorkspaceState,
} from "./types.ts";
import { pathExists } from "./utils.ts";
import { crossCheckFindings, findingsPairingGateActive } from "./findings.ts";
import { beginPhaseAction, buildTerminalNextActions } from "./status.ts";

export const PIPELINE_ALIASES: Record<string, string> = {
	"full-with-audit": "workflow/pipeline-full-with-audit.yaml",
	"full-with-deep-audit": "workflow/pipeline-full-with-deep-audit.yaml",
	"scout-first": "workflow/pipeline-scout-first.yaml",
	full: "workflow/pipeline.yaml",
	"defect-scan": "workflow/pipeline-defect-scan.yaml",
	lite: "workflow/pipeline-lite.yaml",
	"architecture-only": "workflow/pipeline-architecture-only.yaml",
	synthesis: "workflow/pipeline-synthesis.yaml",
};

export const DEFAULT_PIPELINE_PATH = "workflow/pipeline-full-with-deep-audit.yaml";

export function getPhaseMap(pipeline: PipelineFile): Map<string, PipelinePhase> {
	return new Map(pipeline.phases.map((phase) => [phase.id, phase]));
}

export function getPipelineLabel(pipelinePath: string): string {
	const fileName = basename(pipelinePath, ".yaml");
	if (fileName === "pipeline") return "full";
	return fileName.replace(/^pipeline-/, "");
}

export function getNextEligiblePhase(state: WorkspaceState): PipelinePhase | null {
	const phaseMap = getPhaseMap(state.pipeline);
	for (const phaseId of state.pipeline.phase_order) {
		const phaseStatus = state.status.phases[phaseId]?.status;
		if (phaseStatus === "complete") continue;
		const phase = phaseMap.get(phaseId);
		if (!phase) continue;
		const dependencies = phase.depends_on ?? [];
		const ready = dependencies.every((dependencyId) => state.status.phases[dependencyId]?.status === "complete");
		if (ready) return phase;
	}
	return null;
}

/** One phase the pipeline cannot reach, and the dependencies keeping it there. */
export interface BlockedPhase {
	phaseId: string;
	/** Each unmet `depends_on` entry, with why it will not clear on its own. */
	missing: Array<{ dependencyId: string; reason: "not-in-pipeline" | "blocked" }>;
}

/**
 * What the pipeline can do next. `getNextEligiblePhase` returned null both
 * when every phase was complete and when the remaining phases waited on a
 * dependency that would never clear, and every consumer read null as
 * complete: a DAG with an unmet dependency reported 1/2 complete and unlocked
 * the post-pipeline skills (#228). The third outcome is the difference.
 */
export type PipelineOutcome =
	| { kind: "eligible"; phase: PipelinePhase }
	| { kind: "complete" }
	| { kind: "stuck"; blocked: BlockedPhase[] };

export function resolvePipelineOutcome(state: WorkspaceState): PipelineOutcome {
	const phase = getNextEligiblePhase(state);
	if (phase) return { kind: "eligible", phase };
	const phaseMap = getPhaseMap(state.pipeline);
	const isComplete = (phaseId: string) => state.status.phases[phaseId]?.status === "complete";
	const incomplete = state.pipeline.phase_order.filter((phaseId) => !isComplete(phaseId));
	if (incomplete.length === 0) return { kind: "complete" };
	// Nothing is eligible and something is incomplete, so every incomplete
	// phase has an unmet dependency. Each one is either a phase this pipeline
	// does not declare, or one of the blocked phases themselves (a cycle, or a
	// chain back to one).
	const blocked: BlockedPhase[] = incomplete.map((phaseId) => ({
		phaseId,
		missing: (phaseMap.get(phaseId)?.depends_on ?? [])
			.filter((dependencyId) => !isComplete(dependencyId))
			.map((dependencyId) => ({
				dependencyId,
				reason: state.pipeline.phase_order.includes(dependencyId) ? "blocked" : "not-in-pipeline",
			})),
	}));
	return { kind: "stuck", blocked };
}

/** True when every phase in the active pipeline is complete. */
export function isPipelineComplete(state: WorkspaceState): boolean {
	return resolvePipelineOutcome(state).kind === "complete";
}

/**
 * One sentence both surfaces print for a stuck pipeline, naming each blocked
 * phase and the dependency keeping it there. The pipeline file is the thing to
 * fix — or switch away from — so the sentence says so.
 */
export function describeStuckPipeline(blocked: BlockedPhase[]): string {
	const parts = blocked.map((entry) => {
		const deps = entry.missing.map((m) =>
			m.reason === "not-in-pipeline" ? `${m.dependencyId}, which is not in this pipeline` : `${m.dependencyId}, which is itself blocked`,
		);
		return `${entry.phaseId} depends on ${deps.join(" and ") || "nothing it can reach"}`;
	});
	return `Pipeline is stuck: ${parts.join("; ")}. No phase can run until the pipeline file's depends_on is fixed (or switch pipelines with codecarto_switch_pipeline / /codecarto-switch-pipeline).`;
}

/**
 * Point `current_phase` and `next_actions` at whatever the engine finds
 * eligible now, at the terminal routing when every phase is complete, or at
 * the first blocked phase with the stuck sentence when nothing can run.
 * Completion and a pipeline switch both derive the cursor this way (#236), so
 * status.yaml never disagrees with the phase records it sits beside. Returns
 * the eligible phase, or null.
 */
export function recomputeCursor(state: WorkspaceState): PipelinePhase | null {
	const outcome = resolvePipelineOutcome(state);
	if (outcome.kind === "eligible") {
		state.status.current_phase = outcome.phase.id;
		state.status.next_actions = [beginPhaseAction(outcome.phase)];
		return outcome.phase;
	}
	if (outcome.kind === "stuck") {
		// The cursor stays on the first phase that cannot run; "complete" is
		// reserved for the state where nothing is left (#228).
		state.status.current_phase = outcome.blocked[0]?.phaseId ?? "complete";
		state.status.next_actions = [describeStuckPipeline(outcome.blocked)];
		return null;
	}
	state.status.current_phase = "complete";
	state.status.next_actions = buildTerminalNextActions(state.status);
	return null;
}

/**
 * Phases status.yaml records as complete whose primary output is not on disk.
 * status.yaml is committed and the findings are ignored by default, so a fresh
 * clone says "complete" about reports it does not have; both surfaces' status
 * name the gap rather than let the two files disagree in silence (#259).
 */
export async function listMissingCompletedOutputs(state: WorkspaceState): Promise<Array<{ phaseId: string; path: string }>> {
	const missing: Array<{ phaseId: string; path: string }> = [];
	for (const phase of state.pipeline.phases) {
		if (!phase.primary_output) continue;
		if (state.status.phases[phase.id]?.status !== "complete") continue;
		if (await pathExists(join(state.workspaceDir, phase.primary_output))) continue;
		missing.push({ phaseId: phase.id, path: phase.primary_output });
	}
	return missing;
}

/** The status lines both surfaces print for {@link listMissingCompletedOutputs}; empty when nothing is missing. */
export function describeMissingCompletedOutputs(missing: Array<{ phaseId: string; path: string }>): string[] {
	if (missing.length === 0) return [];
	return [
		`Outputs missing on disk for ${missing.length} complete phase(s) — findings are gitignored by default, so a clone carries the status but not the reports; re-run the phase here, or commit findings (see README, "What to commit"):`,
		...missing.map((entry) => `  - ${entry.phaseId}: .codecarto/${entry.path}`),
	];
}

export function resolvePhase(state: WorkspaceState, phaseId?: string): PipelinePhase | null {
	const trimmed = phaseId?.trim();
	if (!trimmed) return getNextEligiblePhase(state);

	const exact = getPhaseMap(state.pipeline).get(trimmed);
	if (exact) return exact;

	// Fall back to matching the primary_output filename. Validation errors
	// surface that path (e.g. "Missing primary output: .codecarto/findings/
	// protocols/protocols-and-state.md"), so users naturally paste it back as
	// the phase argument. Accept the basename with or without the .md suffix.
	const wanted = basename(trimmed, ".md");
	for (const phase of state.pipeline.phases) {
		if (phase.primary_output && basename(phase.primary_output, ".md") === wanted) {
			return phase;
		}
	}
	return null;
}

export function resolvePipelineChoice(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (PIPELINE_ALIASES[trimmed]) return PIPELINE_ALIASES[trimmed];
	return trimmed.endsWith(".yaml") ? trimmed : null;
}

/** What an Overall line can say; MISSING is the validator's own word for an absent output. */
type OverallVerdict = Exclude<ValidationResult["overall"], "MISSING">;

/**
 * Read the verdict off a `**Overall:**` line, tolerating decoration around
 * it: `**Overall:** PASS (6/6)`, `**Overall:** **PASS WITH GAPS** — see §3`,
 * `**Overall**: \`PASS\`.`, a leading list marker. The verdict is whatever the
 * value starts with; anything after it is commentary. Returns null for a
 * line that is not an Overall line at all, and `{ verdict: null }` for one
 * whose value does not start with a verdict, so the caller can say which
 * line it could not read rather than reporting a bare FAIL (#247).
 */
export function parseOverallLine(line: string): { verdict: OverallVerdict | null } | null {
	const match = /^(?:[-*>]\s+)?\*\*Overall(?::\*\*|\*\*:)\s*(.*)$/i.exec(line.trim());
	if (!match) return null;
	const value = (match[1] ?? "").replace(/^[\s*_`]+/, "").toUpperCase();
	if (/^PASS WITH GAPS(?![A-Z])/.test(value)) return { verdict: "PASS WITH GAPS" };
	if (/^PASS(?![A-Z])/.test(value)) return { verdict: "PASS" };
	if (/^FAIL(?![A-Z])/.test(value)) return { verdict: "FAIL" };
	return { verdict: null };
}

export async function validatePhaseOutput(state: WorkspaceState, phaseId?: string): Promise<ValidationResult> {
	const phase = resolvePhase(state, phaseId);
	if (!phase) {
		throw new Error(phaseId ? `Unknown phase: ${phaseId}` : "No eligible phase found.");
	}
	if (!phase.primary_output) {
		throw new Error(`Phase ${phase.id} has no primary_output in the active pipeline.`);
	}

	// Declared secondary outputs with existence (issue #101): non-gating
	// visibility, because secondary outputs are created only when needed — but
	// a declared output that ends the phase absent AND unaccounted-for is how
	// a real run silently dropped one. The summary surfaces it; the session
	// either writes it or routes the gap.
	const secondaryOutputs: Array<{ path: string; exists: boolean }> = [];
	for (const output of phase.secondary_outputs ?? []) {
		if (!output.path) continue;
		secondaryOutputs.push({ path: output.path, exists: await pathExists(join(state.workspaceDir, output.path)) });
	}

	const outputPath = join(state.workspaceDir, phase.primary_output);
	if (!(await pathExists(outputPath))) {
		return {
			phaseId: phase.id,
			primaryOutput: phase.primary_output,
			outputPath,
			exists: false,
			hasValidationBlock: false,
			overall: "MISSING",
			rows: [],
			gaps: [],
			errors: [`Missing primary output: .codecarto/${phase.primary_output}`],
			secondaryOutputs,
		};
	}

	const content = await readFile(outputPath, "utf8");
	const validationHeadingIndex = content.lastIndexOf("## Validation");
	if (validationHeadingIndex === -1) {
		return {
			phaseId: phase.id,
			primaryOutput: phase.primary_output,
			outputPath,
			exists: true,
			hasValidationBlock: false,
			overall: "FAIL",
			rows: [],
			gaps: [],
			errors: ["Primary output exists but is missing a ## Validation block."],
			secondaryOutputs,
		};
	}

	const validationContent = content.slice(validationHeadingIndex);
	const rows: Array<{ criterion: string; result: string; evidence: string }> = [];
	let overall: ValidationResult["overall"] = "FAIL";
	const errors: string[] = [];
	// The last **Overall:** line wins; what it said is remembered so the error
	// can quote it when the verdict could not be read or was FAIL.
	let overallLine: { text: string; verdict: OverallVerdict | null } | null = null;

	for (const rawLine of validationContent.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("|")) {
			const cells = line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
			if (cells.length >= 4 && cells[0] !== "#" && !/^[-:]+$/.test(cells[0])) {
				rows.push({
					criterion: cells[1] ?? "",
					result: cells[2] ?? "",
					evidence: cells[3] ?? "",
				});
			}
		}

		const parsed = parseOverallLine(line);
		if (parsed) {
			overallLine = { text: line, verdict: parsed.verdict };
			overall = parsed.verdict ?? "FAIL";
		}
	}

	if (!overallLine) {
		errors.push("No **Overall:** line found in the ## Validation block. End the block with `**Overall:** PASS`, `**Overall:** PASS WITH GAPS`, or `**Overall:** FAIL`.");
	} else if (overallLine.verdict === null) {
		errors.push(`Could not read the verdict on the Overall line: "${overallLine.text}". It must start with PASS, PASS WITH GAPS, or FAIL; anything after the verdict is ignored.`);
	} else if (overallLine.verdict === "FAIL") {
		errors.push(`The Overall line says FAIL: "${overallLine.text}".`);
	}
	const gaps = rows
		.filter((row) => row.result.toUpperCase().includes("PARTIAL"))
		.map((row) => `${row.criterion}: ${row.evidence}`);

	if (rows.length === 0) {
		errors.push("Validation block found, but no validation rows could be parsed.");
	}
	if (rows.some((row) => row.result.toUpperCase().includes("FAIL"))) {
		errors.push("One or more validation criteria are marked FAIL.");
		overall = "FAIL";
	}

	// Findings cross-checks (#122): the validation table says whether criteria
	// were met; these read what the findings' own evidence and action cells
	// say. Deterministic on two cells the model wrote, so the pairing rule can
	// gate — on a scaffold that offers `verify at runtime`. Older scaffolds warn.
	const crossCheck = crossCheckFindings(content, { gate: findingsPairingGateActive(state.scaffoldVersion) });
	if (crossCheck.errors.length > 0) {
		errors.push(...crossCheck.errors);
		overall = "FAIL";
	}
	const warnings = crossCheck.warnings;

	if (overall === "FAIL" && errors.length === 0) {
		errors.push("Validation overall result is FAIL.");
	}

	return {
		phaseId: phase.id,
		primaryOutput: phase.primary_output,
		outputPath,
		exists: true,
		hasValidationBlock: true,
		overall,
		rows,
		gaps,
		errors,
		secondaryOutputs,
		...(warnings.length > 0 && { warnings }),
	};
}

export function buildValidationSummary(validation: ValidationResult): string[] {
	const lines = [`Validation: ${validation.overall}`];
	if (!validation.exists) {
		lines.push(...validation.errors);
		return lines;
	}
	lines.push(`Output: .codecarto/${validation.primaryOutput}`);
	if (validation.gaps.length > 0) {
		lines.push(`Gaps: ${validation.gaps.length}`);
	}
	if (validation.errors.length > 0) {
		lines.push(...validation.errors.slice(0, 3));
	}
	for (const warning of validation.warnings ?? []) {
		lines.push(`NOTE: ${warning} Non-gating.`);
	}
	const missingSecondary = (validation.secondaryOutputs ?? []).filter((output) => !output.exists);
	if (missingSecondary.length > 0) {
		lines.push(`NOTE: ${missingSecondary.length} declared secondary output(s) not written: ${missingSecondary.map((output) => `.codecarto/${output.path}`).join(", ")} — write each, or account for it in Coverage and limits / a routed handoff entry. Non-gating.`);
	}
	return lines;
}
