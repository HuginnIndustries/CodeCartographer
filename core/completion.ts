import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getNextEligiblePhase, resolvePhase } from "./pipeline.ts";
import { applyHandoff, loadHandoffFile, normalizeStatus } from "./status.ts";
import type { OpenQuestionEntry, PhaseHandoff, ValidationResult, WorkspaceState } from "./types.ts";
import { dateOnly, pathExists, uniqueStrings } from "./utils.ts";
import { getWorkspaceState, updateStatusAtomically } from "./workspace.ts";

export type CompletionResult = {
	updatedState: WorkspaceState;
	closeoutNotice?: string;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function canonicalCloseoutFile(workspaceDir: string, phaseId: string, timestamp: string): Promise<string> {
	const closeoutsDir = join(workspaceDir, "closeouts");
	await mkdir(closeoutsDir, { recursive: true });
	const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(phaseId)}\\.md$`);
	const existing = (await readdir(closeoutsDir)).filter((name) => pattern.test(name)).sort();
	return existing.at(-1) ?? `${dateOnly(timestamp)}-${phaseId}.md`;
}

async function writeCompletionArtifacts(
	workspaceDir: string,
	phaseId: string,
	validation: ValidationResult,
	timestamp: string,
	handoff: PhaseHandoff | null,
): Promise<string> {
	const closeoutFile = await canonicalCloseoutFile(workspaceDir, phaseId, timestamp);
	const closeoutPath = join(workspaceDir, "closeouts", closeoutFile);
	const suppliedContent = handoff?.closeout_content?.trim();
	if (suppliedContent) {
		const decisions = handoff?.decisions ?? [];
		const decisionsSection = decisions.length > 0
			? `\n\n## Decisions Beyond Prompt\n\n${decisions.map((decision) => `- ${decision}`).join("\n")}`
			: "";
		await writeFile(closeoutPath, `${suppliedContent}${decisionsSection}\n`, "utf8");
	} else if (!(await pathExists(closeoutPath))) {
		const templatePath = join(workspaceDir, "templates", "closeout-template.md");
		if (await pathExists(templatePath)) await copyFile(templatePath, closeoutPath);
	}

	const summary = handoff?.closeout_summary?.trim() || `Validation: ${validation.overall}`;
	const entry = `- ${dateOnly(timestamp)} — ${phaseId} — ${summary} — [closeout](closeouts/${closeoutFile})`;
	const threadLogPath = join(workspaceDir, "THREAD_LOG.md");
	let current = "";
	try {
		current = await readFile(threadLogPath, "utf8");
	} catch {
		// Created below when absent.
	}
	const link = `[closeout](closeouts/${closeoutFile})`;
	if (!current.split(/\r?\n/).some((line) => line.includes(link))) {
		await appendFile(threadLogPath, `${entry}\n`, "utf8");
	}
	return `.codecarto/closeouts/${closeoutFile}`;
}

export async function completeValidatedPhase(
	cwd: string,
	validation: ValidationResult,
	sourceLabel: string,
): Promise<CompletionResult> {
	const initialState = await getWorkspaceState(cwd);
	if (!initialState) throw new Error("CodeCartographer workspace not found. Run /codecarto-init first.");
	const handoff = await loadHandoffFile(validation.phaseId, initialState.workspaceDir);
	if (handoff && handoff.phase_id !== validation.phaseId) {
		throw new Error(`Invalid handoff: phase_id ${handoff.phase_id} does not match ${validation.phaseId}`);
	}

	const completionTimestamp = new Date().toISOString();
	let closeoutPath: string | undefined;
	const updatedState = await updateStatusAtomically(cwd, async (lockedState) => {
		const phase = resolvePhase(lockedState, validation.phaseId);
		if (!phase?.primary_output) throw new Error(`Phase ${validation.phaseId} is missing primary_output.`);

		const nextStatus = normalizeStatus(lockedState.status, lockedState.pipeline, lockedState.status.pipeline, lockedState.cwd);
		const existingPhase = nextStatus.phases[validation.phaseId] ?? {
			status: "pending",
			owner_notes: [],
			outputs_present: [],
			open_questions: [],
			carry_forward: [],
		};
		const gapEntries: OpenQuestionEntry[] = validation.rows
			.filter((row) => row.result.toUpperCase().includes("PARTIAL"))
			.map((row) => ({
				kind: "needs-maintainer-decision",
				description: row.criterion || "Partial validation gap",
				deferred_reason: row.evidence || "Marked PARTIAL by validation",
			}));
		const mergedOpenQuestions = [...existingPhase.open_questions];
		for (const candidate of gapEntries) {
			if (!mergedOpenQuestions.some((entry) => entry.description === candidate.description && entry.deferred_reason === candidate.deferred_reason)) {
				mergedOpenQuestions.push(candidate);
			}
		}
		nextStatus.phases[validation.phaseId] = {
			status: "complete",
			owner_notes: uniqueStrings([
				...existingPhase.owner_notes,
				`Completed via ${sourceLabel}.`,
				`Primary output: .codecarto/${validation.primaryOutput}`,
				`Validation: ${validation.overall}`,
			]),
			outputs_present: uniqueStrings([...existingPhase.outputs_present, validation.primaryOutput]),
			open_questions: mergedOpenQuestions,
			carry_forward: existingPhase.carry_forward ?? [],
		};
		if (handoff) applyHandoff(nextStatus, handoff);
		nextStatus.last_updated = completionTimestamp;
		const nextWorkspace: WorkspaceState = { ...lockedState, status: nextStatus };
		const nextEligible = getNextEligiblePhase(nextWorkspace);
		nextStatus.current_phase = nextEligible?.id ?? "complete";
		nextStatus.next_actions = nextEligible
			? [`Begin ${nextEligible.id} phase by producing ${nextEligible.primary_output ?? `findings/${nextEligible.id}/`}`]
			: ["All phases complete. Review findings, open questions, and downstream implementation notes."];

		closeoutPath = await writeCompletionArtifacts(lockedState.workspaceDir, validation.phaseId, validation, completionTimestamp, handoff);
		return { state: { ...nextWorkspace, status: nextStatus } };
	});

	return {
		updatedState,
		closeoutNotice: closeoutPath ? `Closeout: ${closeoutPath}` : undefined,
	};
}
