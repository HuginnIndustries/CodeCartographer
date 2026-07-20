// Optional LLM-narrated executive summary for the dashboard. Opt-in via
// /codecarto-dashboard --narrate. Runs the orchestrator's model as a
// one-shot in-memory AgentSession with no tools, reads recent closeouts +
// status + usage totals, and produces a 200-400 word Markdown summary.
//
// The summary is cached to .codecarto/.dashboard-narration.local.md with a
// YAML frontmatter recording when it was generated and the completed-phase
// count at that time. Subsequent deterministic re-renders consult this
// cache and surface a "<N> runs since" staleness note.
//
// Same one-shot pattern as agent-rewriter.ts:runRewriterOnce — different
// system prompt, different output target. Never throws.

import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
	computeTotals,
	NARRATION_CACHE_RELATIVE_PATH,
	loadUsage,
	pathExists,
	stringifySimpleYaml,
	type UsageFile,
	type WorkspaceState,
} from "../../core/index.ts";

// Per-closeout byte budget when stuffing the narrator's input. Three
// closeouts × 4 KB each ≈ 12 KB of prompt context, which is well under any
// reasonable model's input window.
const CLOSEOUT_BYTE_BUDGET = 4000;
const MAX_CLOSEOUTS = 3;

export interface NarrateDashboardResult {
	narration?: string;
	used: boolean;
	skipReason?: string;
}

export async function narrateDashboard(
	ctx: ExtensionContext,
	state: WorkspaceState,
): Promise<NarrateDashboardResult> {
	const closeouts = await readRecentCloseouts(state.workspaceDir);
	if (closeouts.length === 0) {
		return { used: false, skipReason: "no closeouts to narrate from" };
	}

	const usage = await loadUsage(state.workspaceDir);
	const prompt = buildNarratorPrompt({
		projectName: state.status.project_name || "(unnamed project)",
		pipeline: state.status.pipeline,
		currentPhase: state.status.current_phase || "—",
		completedCount: completedPhaseCount(state),
		totalPhases: state.pipeline.phase_order.length,
		usageSummary: summarizeUsage(usage),
		closeouts,
	});

	let narration: string;
	try {
		narration = await runNarratorOnce(ctx, prompt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { used: false, skipReason: `narrator session failed: ${message}` };
	}

	const trimmed = narration.trim();
	if (!trimmed) {
		return { used: false, skipReason: "narrator returned empty output" };
	}

	await writeNarrationCache(state.workspaceDir, trimmed, completedPhaseCount(state));
	return { narration: trimmed, used: true };
}

interface RecentCloseout { date: string; phaseOrModule: string; fileName: string; content: string; }

async function readRecentCloseouts(workspaceDir: string): Promise<RecentCloseout[]> {
	const dir = join(workspaceDir, "closeouts");
	if (!(await pathExists(dir))) return [];
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const matched = entries
		.map((name) => {
			const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(name);
			return m ? { date: m[1], phaseOrModule: m[2], fileName: name } : null;
		})
		.filter((x): x is { date: string; phaseOrModule: string; fileName: string } => x !== null)
		.sort((a, b) => (a.date < b.date ? 1 : -1))
		.slice(0, MAX_CLOSEOUTS);

	const out: RecentCloseout[] = [];
	for (const entry of matched) {
		try {
			const raw = await readFile(join(dir, entry.fileName), "utf8");
			const truncated = raw.length > CLOSEOUT_BYTE_BUDGET
				? `${raw.slice(0, CLOSEOUT_BYTE_BUDGET)}\n\n[…truncated for narration budget…]`
				: raw;
			out.push({ ...entry, content: truncated });
		} catch {
			// skip unreadable closeouts
		}
	}
	return out;
}

interface NarratorPromptInput {
	projectName: string;
	pipeline: string;
	currentPhase: string;
	completedCount: number;
	totalPhases: number;
	usageSummary: string;
	closeouts: RecentCloseout[];
}

function buildNarratorPrompt(input: NarratorPromptInput): string {
	const closeoutBlocks = input.closeouts.map((c) => [
		`=== CLOSEOUT ${c.date} ${c.phaseOrModule} ===`,
		c.content,
		`=== END CLOSEOUT ${c.date} ${c.phaseOrModule} ===`,
	].join("\n")).join("\n\n");

	return [
		`You are writing a 200-400 word executive summary of a CodeCartographer run for a human reader (project owner, reviewer, or new team member).`,
		"",
		"Constraints:",
		"- Cite specific findings from the closeouts below; quote phase IDs and artifact names verbatim.",
		"- Do not invent findings the closeouts do not state.",
		"- Lead with what the run discovered, not what it did mechanically. Findings > activity.",
		"- Surface any cross-cutting risks or open questions worth pulling forward.",
		"- Output Markdown only, no commentary, no preface, no fenced code blocks.",
		"- 200-400 words; tight prose, no bullet-list-soup.",
		"",
		"=== RUN METADATA ===",
		`Project: ${input.projectName}`,
		`Pipeline: ${input.pipeline}`,
		`Progress: ${input.completedCount}/${input.totalPhases} phases complete`,
		`Current phase: ${input.currentPhase}`,
		`Usage: ${input.usageSummary}`,
		"=== END RUN METADATA ===",
		"",
		closeoutBlocks,
	].join("\n");
}

function summarizeUsage(usage: UsageFile): string {
	if (usage.runs.length === 0) return "no runs recorded";
	const totals = computeTotals(usage);
	const tokensTotal = totals.tokens.input + totals.tokens.output;
	return `${totals.runs} runs · ${formatK(tokensTotal)} tokens · ${totals.tool_uses} tool uses`;
}

function formatK(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function completedPhaseCount(state: WorkspaceState): number {
	return Object.values(state.status.phases).filter((p) => p.status === "complete").length;
}

async function writeNarrationCache(workspaceDir: string, content: string, phaseCount: number): Promise<void> {
	const generatedAt = new Date().toISOString();
	const frontmatter = stringifySimpleYaml({ generatedAt, phaseCountAtGeneration: phaseCount });
	const body = `---\n${frontmatter}\n---\n${content}\n`;
	const path = join(workspaceDir, NARRATION_CACHE_RELATIVE_PATH);
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, body, "utf8");
	await rename(tempPath, path);
}

async function runNarratorOnce(ctx: ExtensionContext, prompt: string): Promise<string> {
	const cwd = ctx.cwd;
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
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
		model: ctx.model,
		tools: [],
		resourceLoader: loader,
	});

	await session.prompt(prompt);
	return getLastAssistantText(session);
}

function getLastAssistantText(session: AgentSession): string {
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

