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
	full: "workflow/pipeline.yaml",
	"defect-scan": "workflow/pipeline-defect-scan.yaml",
	lite: "workflow/pipeline-lite.yaml",
	"architecture-only": "workflow/pipeline-architecture-only.yaml",
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
	if (trimmed) {
		return getPhaseMap(state.pipeline).get(trimmed) ?? null;
	}
	return getNextEligiblePhase(state);
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
	return lines;
}
