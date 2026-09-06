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

		const overallMatch = line.match(/^\*\*Overall:\*\*\s*(.+)$/i);
		if (overallMatch?.[1]) {
			const normalizedOverall = overallMatch[1].trim().toUpperCase();
			if (normalizedOverall === "PASS") overall = "PASS";
			else if (normalizedOverall === "PASS WITH GAPS") overall = "PASS WITH GAPS";
			else overall = "FAIL";
		}
	}

	const errors: string[] = [];
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
	const missingSecondary = (validation.secondaryOutputs ?? []).filter((output) => !output.exists);
	if (missingSecondary.length > 0) {
		lines.push(`NOTE: ${missingSecondary.length} declared secondary output(s) not written: ${missingSecondary.map((output) => `.codecarto/${output.path}`).join(", ")} — write each, or account for it in Coverage and limits / a routed handoff entry. Non-gating.`);
	}
	return lines;
}
