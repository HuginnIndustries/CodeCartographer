import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PHASE_SESSION_PREFIX = "CodeCartographer phase: ";

export function phaseIdFromSessionName(sessionName: string | undefined): string | null {
	if (!sessionName?.startsWith(PHASE_SESSION_PREFIX)) return null;
	const phaseId = sessionName.slice(PHASE_SESSION_PREFIX.length).trim();
	return /^[a-z0-9][a-z0-9-]*$/.test(phaseId) ? phaseId : null;
}

export function buildPhaseCompactionInstructions(phaseId: string, primaryOutput?: string): string {
	const output = primaryOutput ? `.codecarto/${primaryOutput}` : "the phase's declared primary output";
	return [
		`This is a CodeCartographer phase session for ${phaseId}.`,
		`Produce a phase-aware continuation summary for ${output}.`,
		"Preserve these details explicitly:",
		"- phase goal and constraints",
		"- evidence-backed conclusions and their evidence levels",
		"- files inspected and subsystems covered or skipped",
		"- primary-output sections already written and sections still missing",
		"- edits already made under .codecarto/",
		"- open questions and carry-forward candidates",
		"- validation criteria already satisfied and validation criteria still at risk",
		"- exact next steps needed to finish and validate the phase.",
		"Do not turn an inference into an observed fact. Retain file paths, finding IDs, and unresolved gaps verbatim where possible.",
	].join("\n");
}

export async function writePhaseCheckpoint(
	cwd: string,
	phaseId: string,
	summary: string,
	tokensBefore: number,
): Promise<string> {
	const dir = join(cwd, ".codecarto", "scratch", "checkpoints");
	const target = join(dir, `${phaseId}.md`);
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(dir, { recursive: true });
	const content = [
		"---",
		`phase: ${phaseId}`,
		`updated_at: ${new Date().toISOString()}`,
		`tokens_before: ${tokensBefore}`,
		"source: pi-compaction",
		"---",
		"",
		"# Phase checkpoint",
		"",
		summary.trim(),
		"",
	].join("\n");
	await writeFile(temp, content, "utf8");
	await rename(temp, target);
	return target;
}
