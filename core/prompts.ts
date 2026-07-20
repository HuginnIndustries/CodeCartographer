// Prompt builders + closeout/thread-log helpers. The phase prompt is the
// single biggest fidelity surface — both Pi and the MCP server emit
// byte-identical text by importing buildPhasePrompt from here.

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	CarryForwardEntry,
	OpenQuestionEntry,
	PipelinePhase,
	ValidationResult,
	WorkspaceState,
} from "./types.ts";
import { dateOnly, pathExists } from "./utils.ts";

export function describeEntry(entry: OpenQuestionEntry | CarryForwardEntry): string {
	const parts: string[] = [];
	if (entry.id) parts.push(entry.id);
	if (entry.kind) parts.push(`(${entry.kind})`);
	if (entry.description) parts.push(entry.description);
	else if (entry.deferred_reason) parts.push(entry.deferred_reason);
	return parts.join(" ").trim() || "(unlabeled entry)";
}

export function collectRoutedCarryForward(state: WorkspaceState, targetPhaseId: string): CarryForwardEntry[] {
	const routed: CarryForwardEntry[] = [];
	for (const phase of Object.values(state.status.phases)) {
		for (const entry of phase.carry_forward ?? []) {
			if (entry.target_phase === targetPhaseId) routed.push(entry);
		}
	}
	return routed;
}

export interface BuildPhasePromptOptions {
	/**
	 * Set when the phase is being run inside `/codecarto-next --auto` (or any
	 * other non-interactive driver). Suppresses interactive hooks that would
	 * otherwise pause the sub-agent to ask the user a question — those hooks
	 * are the dominant cause of the auto loop wedging at `reimplementation-spec`
	 * with a `MISSING` primary output. Each suppressed hook documents the
	 * default it falls back to.
	 */
	auto?: boolean;
}

export async function buildPhasePrompt(
	state: WorkspaceState,
	phase: PipelinePhase,
	forced: boolean,
	options: BuildPhasePromptOptions = {},
): Promise<string> {
	const lines = [
		`Read .codecarto/GUIDE.md and continue the CodeCartographer workflow for the phase \`${phase.id}\`.`,
		`Work on this phase only. The analyzed source code is the repository outside .codecarto/.`,
		"",
		"Required reads before analysis:",
		"- .codecarto/GUIDE.md",
		"- .codecarto/workflow/status.yaml",
	];

	const primaryOutput = phase.primary_output ? `.codecarto/${phase.primary_output}` : undefined;
	if (primaryOutput) {
		lines.push(`- ${primaryOutput} if it already exists (continue instead of duplicating work)`);
	}
	if (phase.skill_path) lines.push(`- .codecarto/${phase.skill_path}`);
	if (phase.output_template) lines.push(`- .codecarto/${phase.output_template}`);

	const staticReads = new Set(["GUIDE.md", "workflow/status.yaml"]);
	const phaseReads = (phase.required_reads ?? []).filter((path) => path && !staticReads.has(path));
	for (const path of phaseReads) {
		lines.push(`- .codecarto/${path}`);
	}

	const checkpointRelativePath = `scratch/checkpoints/${phase.id}.md`;
	if (await pathExists(join(state.workspaceDir, checkpointRelativePath))) {
		lines.push(`- .codecarto/${checkpointRelativePath} (resume from durable in-phase progress after compaction or interruption)`);
	}

	const conventionsPath = join(state.workspaceDir, "CONVENTIONS.md");
	if (await pathExists(conventionsPath)) {
		lines.push("- .codecarto/CONVENTIONS.md (cross-cutting patterns the orchestrator has promoted)");
	}
	const decisionsPath = join(state.workspaceDir, "DECISIONS.md");
	if (await pathExists(decisionsPath)) {
		lines.push("- .codecarto/DECISIONS.md (numbered project decisions; new entries are appended in your closeout)");
	}

	const routed = collectRoutedCarryForward(state, phase.id);
	if (routed.length > 0) {
		lines.push("", `Items routed to \`${phase.id}\` for closure (carry_forward from earlier phases):`);
		for (const entry of routed) {
			lines.push(`- ${describeEntry(entry)}`);
		}
		lines.push("Close each item by editing your phase output to address it, then remove the entry from the source phase's carry_forward in workflow/status.yaml.");
	}

	if (phase.id === "reimplementation-spec") {
		lines.push("");
		if (options.auto) {
			lines.push("Strategic Alignment Hook (auto run — DO NOT ask the user):");
			lines.push("- This phase is running inside `/codecarto-next --auto`. The user is not in the loop.");
			lines.push("- Default the spec to LANGUAGE-AGNOSTIC: use templates/reimplementation-spec.md.");
			lines.push("- Record `variant: language-agnostic` and `selection: auto-default` in the spec front-matter and in your validation block, so a later opinionated re-run is traceable.");
			lines.push("- Do NOT block on the user. If you would otherwise pause to ask about target stack, project name, or scope cuts, instead produce the language-agnostic spec and capture each unresolved choice as an `open_questions` entry (`kind: needs-maintainer-decision`) for follow-up.");
		} else {
			lines.push("Strategic Alignment Hook (run BEFORE producing the spec):");
			lines.push("- Confirm with the user whether this spec should be language-agnostic or opinionated:");
			lines.push("    - language-agnostic → use templates/reimplementation-spec.md (default).");
			lines.push("    - opinionated (target stack locked) → use templates/reimplementation-spec-opinionated.md.");
			lines.push("- Record the chosen variant in the spec front-matter and in your validation block.");
		}
	}

	lines.push("", "Rules:");
	lines.push("- Do not modify source files outside .codecarto/.");
	lines.push("- Follow the active pipeline and validation protocol.");
	lines.push("- Update findings under .codecarto/findings/ for this phase.");
	lines.push(`- For long phases, checkpoint resumable progress at .codecarto/scratch/checkpoints/${phase.id}.md; Pi writes this automatically after phase compaction.`);
	lines.push("- Include a Coverage and limits section that names inspected scope, skipped scope, evidence basis, and blind spots; route material gaps through PARTIAL validation and open_questions/carry_forward.");
	lines.push("- Distinguish open_questions (genuinely unknown) from carry_forward (routed to a specific later phase) when updating workflow/status.yaml — see GUIDE.md \"Open Questions vs Carry-Forward\".");

	if (forced) {
		lines.push("- The user explicitly requested this phase even if it is not the next eligible phase.");
	}

	if (phase.depends_on && phase.depends_on.length > 0) {
		const unmet = phase.depends_on.filter((dependencyId) => state.status.phases[dependencyId]?.status !== "complete");
		if (unmet.length > 0) {
			lines.push(`- Warning: dependencies not complete yet: ${unmet.join(", ")}`);
		}
	}

	if (phase.handoff_requirements && phase.handoff_requirements.length > 0) {
		lines.push("", "Handoff requirements (from the active pipeline):");
		for (const requirement of phase.handoff_requirements) {
			lines.push(`- ${requirement}`);
		}
	}

	if (primaryOutput) {
		lines.push("", `Primary output target: ${primaryOutput}`);
	}

	return lines.join("\n");
}

export function closeoutFileName(date: string, phaseOrModule: string): string {
	return `${date}-${phaseOrModule}.md`;
}

export function buildThreadLogEntry(phaseOrModule: string, validation: ValidationResult, timestamp: string): string {
	const date = dateOnly(timestamp);
	const file = closeoutFileName(date, phaseOrModule);
	return `- ${date} — ${phaseOrModule} — Validation: ${validation.overall} — [closeout](closeouts/${file})\n`;
}

export async function ensureCloseoutStub(workspaceDir: string, phaseOrModule: string, timestamp: string): Promise<string | null> {
	const date = dateOnly(timestamp);
	const closeoutsDir = join(workspaceDir, "closeouts");
	const closeoutPath = join(closeoutsDir, closeoutFileName(date, phaseOrModule));
	if (await pathExists(closeoutPath)) return null;
	const templatePath = join(workspaceDir, "templates", "closeout-template.md");
	if (!(await pathExists(templatePath))) return null;
	await mkdir(closeoutsDir, { recursive: true });
	await copyFile(templatePath, closeoutPath);
	return closeoutPath;
}

export async function listSkillNames(workspaceDir: string): Promise<string[]> {
	const skillsDir = join(workspaceDir, "skills");
	if (!(await pathExists(skillsDir))) return [];
	try {
		const entries = await readdir(skillsDir, { withFileTypes: true });
		const names: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillFile = join(skillsDir, entry.name, "SKILL.md");
			if (await pathExists(skillFile)) names.push(entry.name);
		}
		return names.sort();
	} catch {
		return [];
	}
}

export async function buildSkillPrompt(state: WorkspaceState, skillName: string): Promise<string> {
	const lines = [
		`Read .codecarto/GUIDE.md and run the post-pipeline skill \`${skillName}\`.`,
		"This is post-pipeline work. The pipeline is `complete`. Do not change `current_phase` or `phase_order` in workflow/status.yaml.",
		"",
		"Required reads before starting:",
		"- .codecarto/GUIDE.md",
		"- .codecarto/workflow/status.yaml",
		`- .codecarto/skills/${skillName}/SKILL.md`,
	];

	const conventionsPath = join(state.workspaceDir, "CONVENTIONS.md");
	if (await pathExists(conventionsPath)) {
		lines.push("- .codecarto/CONVENTIONS.md (cross-cutting patterns the orchestrator has promoted)");
	}
	const decisionsPath = join(state.workspaceDir, "DECISIONS.md");
	if (await pathExists(decisionsPath)) {
		lines.push("- .codecarto/DECISIONS.md (numbered project decisions; new entries are appended in your closeout)");
	}

	lines.push("", "Rules:");
	lines.push("- Do not modify source files outside .codecarto/.");
	lines.push("- Follow the SKILL.md instructions exactly; the skill enforces its own discipline (see GUIDE.md).");
	lines.push("- Update only the artifacts the skill calls for. Do NOT touch phase status entries.");
	lines.push("- On completion, write a closeout at .codecarto/closeouts/<YYYY-MM-DD>-<skill-or-module>.md and append a one-line index entry to THREAD_LOG.md.");
	lines.push("- If your work resolves entries in any phase's open_questions or carry_forward, remove only those resolved entries.");

	return lines.join("\n");
}
