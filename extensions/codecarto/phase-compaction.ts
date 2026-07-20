import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { canonicalPath, getWorkspaceState, isWithinPath } from "../../core/index.ts";

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

/**
 * Phase-only compaction hooks shared by the parent extension and isolated
 * child sessions. Keeping this as a standalone inline extension ensures that
 * children spawned from an explicitly loaded (`pi -e ...`) CodeCartographer
 * extension receive the same checkpoint behavior as globally installed runs.
 */
export function phaseCompactionExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!phaseIdFromSessionName(ctx.sessionManager.getSessionName())) return undefined;
		if (event.toolName === "bash") {
			return { block: true, reason: "CodeCartographer phase sessions disable bash to keep source analysis read-only." };
		}
		if (event.toolName === "edit" || event.toolName === "write") {
			const inputPath = typeof event.input.path === "string" ? event.input.path : "";
			const strippedPath = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
			const targetPath = await canonicalPath(resolve(ctx.cwd, strippedPath));
			const allowedRoot = await canonicalPath(join(ctx.cwd, ".codecarto"));
			if (!isWithinPath(targetPath, allowedRoot)) {
				return {
					block: true,
					reason: `CodeCartographer phase sessions only allow ${event.toolName} within .codecarto/`,
				};
			}
		}
		return undefined;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const phaseId = phaseIdFromSessionName(ctx.sessionManager.getSessionName());
		if (!phaseId || !ctx.model) return undefined;
		try {
			const state = await getWorkspaceState(ctx.cwd);
			const phase = state.pipeline.phases.find((candidate) => candidate.id === phaseId);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok || !auth.apiKey) return undefined;
			const instructions = buildPhaseCompactionInstructions(phaseId, phase?.primary_output);
			const result = await compact(
				event.preparation,
				ctx.model,
				auth.apiKey,
				auth.headers,
				instructions,
				event.signal,
			);
			return { compaction: result };
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Phase-aware compaction unavailable (${message}); using host default.`, "warning");
			}
			return undefined;
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		const phaseId = phaseIdFromSessionName(ctx.sessionManager.getSessionName());
		if (!phaseId) return;
		try {
			await writePhaseCheckpoint(
				ctx.cwd,
				phaseId,
				event.compactionEntry.summary,
				event.compactionEntry.tokensBefore,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Phase checkpoint could not be written: ${message}`, "warning");
			else console.warn(`[codecarto] Phase checkpoint could not be written: ${message}`);
		}
	});
}
