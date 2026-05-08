// Optional LLM-steered prompt rewriter for /codecarto-next.
//
// When enabled (workspace config `orchestrator.llm_steer_next_phase: true`,
// or per-invocation `--llm-steer`), this runs a one-shot in-memory
// AgentSession on the orchestrator's model with no tools. It receives the
// stock phase prompt + the previous phase's closeout (if any) and returns
// a customized seed prompt that acknowledges the prior findings.
//
// Off by default. The orchestrator's tokens stay yours unless you opt in.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { closeoutFileName, pathExists, type WorkspaceState } from "../../core/index.ts";

/** Closeout content over this many bytes is truncated before being passed to
 *  the rewriter. Keeps the orchestrator-side cost predictable. */
const CLOSEOUT_BYTE_BUDGET = 8000;

export interface RewritePhasePromptInput {
	ctx: ExtensionContext;
	state: WorkspaceState;
	originalPrompt: string;
	nextPhaseId: string;
}

export interface RewritePhasePromptResult {
	prompt: string;
	used: boolean;
	skipReason?: string;
}

/**
 * Run the rewriter and return the customized seed prompt. On any failure
 * (no prior phase, missing closeout, rewriter session error, empty output)
 * returns the original prompt with `used: false` and a skip reason — never
 * throws. The caller decides what to surface to the user.
 */
export async function rewritePhasePrompt(input: RewritePhasePromptInput): Promise<RewritePhasePromptResult> {
	const { ctx, state, originalPrompt, nextPhaseId } = input;

	const prevPhaseId = findPreviousPhaseId(state, nextPhaseId);
	if (!prevPhaseId) {
		return { prompt: originalPrompt, used: false, skipReason: "no previous phase to steer from" };
	}

	const closeout = await readLatestCloseout(state.workspaceDir, prevPhaseId);
	if (!closeout) {
		return { prompt: originalPrompt, used: false, skipReason: `no closeout found for ${prevPhaseId}` };
	}

	const rewriterPrompt = buildRewriterPrompt({
		nextPhaseId,
		prevPhaseId,
		originalPrompt,
		prevCloseout: closeout,
	});

	let customized: string;
	try {
		customized = await runRewriterOnce(ctx, rewriterPrompt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { prompt: originalPrompt, used: false, skipReason: `rewriter session failed: ${message}` };
	}

	const trimmed = customized.trim();
	if (!trimmed) {
		return { prompt: originalPrompt, used: false, skipReason: "rewriter returned empty output" };
	}

	return { prompt: trimmed, used: true };
}

function findPreviousPhaseId(state: WorkspaceState, nextPhaseId: string): string | undefined {
	const order = state.pipeline.phase_order;
	const idx = order.indexOf(nextPhaseId);
	if (idx <= 0) return undefined;
	for (let i = idx - 1; i >= 0; i--) {
		if (state.status.phases[order[i]]?.status === "complete") return order[i];
	}
	return undefined;
}

async function readLatestCloseout(workspaceDir: string, phaseId: string): Promise<string | undefined> {
	const closeoutsDir = join(workspaceDir, "closeouts");
	if (!(await pathExists(closeoutsDir))) return undefined;
	let entries: string[];
	try {
		entries = await readdir(closeoutsDir);
	} catch {
		return undefined;
	}
	const suffix = closeoutFileName("", phaseId).replace(/^-/, ""); // "<phaseId>.md"
	const matches = entries.filter((name) => name.endsWith(`-${suffix}`)).sort();
	const latest = matches.at(-1);
	if (!latest) return undefined;
	const raw = await readFile(join(closeoutsDir, latest), "utf8");
	if (raw.length <= CLOSEOUT_BYTE_BUDGET) return raw;
	return `${raw.slice(0, CLOSEOUT_BYTE_BUDGET)}\n\n[…closeout truncated for rewriter input…]`;
}

interface RewriterPromptInput {
	nextPhaseId: string;
	prevPhaseId: string;
	originalPrompt: string;
	prevCloseout: string;
}

function buildRewriterPrompt(input: RewriterPromptInput): string {
	return [
		`You are seeding a sub-agent for the \`${input.nextPhaseId}\` phase of a CodeCartographer pipeline.`,
		`The previous phase \`${input.prevPhaseId}\` just completed. Read its closeout below and produce a CUSTOMIZED seed prompt for the next phase's sub-agent.`,
		"",
		"Constraints for the customized prompt:",
		`- Stay faithful to the original ${input.nextPhaseId} phase template; do not change its structure, required outputs, or completion criteria.`,
		`- Add a short \"context from ${input.prevPhaseId}\" preamble that names the specific findings, open questions, or carry-forward items from the closeout that the ${input.nextPhaseId} phase should pay attention to.`,
		"- Do not invent findings the closeout does not state.",
		"- Do not add commentary directed at the user; the output is the sub-agent's seed prompt.",
		"",
		"Output ONLY the customized seed prompt as plain Markdown. No preface, no fenced code blocks, no commentary.",
		"",
		"=== ORIGINAL NEXT-PHASE PROMPT ===",
		input.originalPrompt,
		"=== END ORIGINAL NEXT-PHASE PROMPT ===",
		"",
		`=== PREVIOUS PHASE (${input.prevPhaseId}) CLOSEOUT ===`,
		input.prevCloseout,
		`=== END PREVIOUS PHASE (${input.prevPhaseId}) CLOSEOUT ===`,
	].join("\n");
}

async function runRewriterOnce(ctx: ExtensionContext, prompt: string): Promise<string> {
	const cwd = ctx.cwd;
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		// Even more stripped than the phase runner: no extensions either,
		// since the rewriter has no tools and shouldn't pick up codecarto's
		// tool-interception (it has no tools to intercept).
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.create(cwd, agentDir),
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		tools: [],
		resourceLoader: loader,
	});

	await session.prompt(prompt);

	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i];
		if (msg.role !== "assistant") continue;
		const blocks = msg.content as Array<{ type?: string; text?: string }>;
		const parts: string[] = [];
		for (const c of blocks) {
			if (c.type === "text" && c.text) parts.push(c.text);
		}
		const joined = parts.join("\n").trim();
		if (joined) return joined;
	}
	return "";
}
