// I/O wrapper that gathers all dashboard inputs and writes the rendered
// HTML to `.codecarto/dashboard.html`. Best-effort — failures are swallowed
// and never escalate to a phase error the user sees, mirroring the
// recordUsage discipline at extensions/codecarto/index.ts.

import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	DASHBOARD_RELATIVE_PATH,
	type DashboardCloseoutEntry,
	type DashboardInputs,
	type DashboardNarration,
	getWorkspaceState,
	loadUsage,
	NARRATION_CACHE_RELATIVE_PATH,
	type OutputAvailability,
	parseSimpleYaml,
	pathExists,
	renderDashboard,
} from "../../core/index.ts";

const CLOSEOUT_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

export async function writeDashboard(cwd: string, packageVersion: string): Promise<void> {
	try {
		const state = await getWorkspaceState(cwd);
		if (!state) return;

		const workspaceDir = state.workspaceDir;
		const [usage, closeouts, outputsPresent, narration] = await Promise.all([
			loadUsage(workspaceDir),
			listCloseouts(workspaceDir),
			buildOutputsPresent(state.workspaceDir, state.pipeline),
			loadNarration(workspaceDir),
		]);

		const inputs: DashboardInputs = {
			status: state.status,
			pipeline: state.pipeline,
			usage,
			closeouts,
			outputsPresent,
			packageVersion,
			generatedAt: new Date().toISOString(),
			narration,
		};

		const html = renderDashboard(inputs);
		const path = join(workspaceDir, DASHBOARD_RELATIVE_PATH);
		const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tempPath, html, "utf8");
		await rename(tempPath, path);
	} catch {
		// Best-effort: a failed dashboard write must not surface as a phase
		// error. The user's pipeline state is unaffected; the next state
		// change will trigger another render attempt.
	}
}

async function listCloseouts(workspaceDir: string): Promise<DashboardCloseoutEntry[]> {
	const dir = join(workspaceDir, "closeouts");
	if (!(await pathExists(dir))) return [];
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const out: DashboardCloseoutEntry[] = [];
	for (const name of entries) {
		const m = CLOSEOUT_FILENAME_RE.exec(name);
		if (!m) continue;
		out.push({ date: m[1], phaseOrModule: m[2], fileName: name });
	}
	return out;
}

async function buildOutputsPresent(
	workspaceDir: string,
	pipeline: { phase_order: string[]; phases: Array<{ id: string; primary_output?: string; secondary_outputs?: Array<{ path: string }> }> },
): Promise<Map<string, OutputAvailability>> {
	const out = new Map<string, OutputAvailability>();
	for (const phaseId of pipeline.phase_order) {
		const phaseDef = pipeline.phases.find((p) => p.id === phaseId);
		if (!phaseDef) continue;
		const entry: OutputAvailability = { secondary: [] };
		if (phaseDef.primary_output) {
			entry.primary = {
				path: phaseDef.primary_output,
				exists: await pathExists(join(workspaceDir, phaseDef.primary_output)),
			};
		}
		for (const sec of phaseDef.secondary_outputs ?? []) {
			entry.secondary.push({
				path: sec.path,
				exists: await pathExists(join(workspaceDir, sec.path)),
			});
		}
		out.set(phaseId, entry);
	}
	return out;
}

async function loadNarration(workspaceDir: string): Promise<DashboardNarration | undefined> {
	const path = join(workspaceDir, NARRATION_CACHE_RELATIVE_PATH);
	if (!(await pathExists(path))) return undefined;
	try {
		const raw = await readFile(path, "utf8");
		const { frontmatter, body } = splitFrontmatter(raw);
		if (!frontmatter) return undefined;
		const generatedAt = typeof frontmatter.generatedAt === "string" ? frontmatter.generatedAt : "";
		const phaseCountAtGeneration = typeof frontmatter.phaseCountAtGeneration === "number" ? frontmatter.phaseCountAtGeneration : 0;
		if (!generatedAt) return undefined;
		return { content: body.trim(), generatedAt, phaseCountAtGeneration };
	} catch {
		return undefined;
	}
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown> | null; body: string } {
	if (!raw.startsWith("---\n")) return { frontmatter: null, body: raw };
	const end = raw.indexOf("\n---\n", 4);
	if (end === -1) return { frontmatter: null, body: raw };
	const yamlText = raw.slice(4, end);
	const body = raw.slice(end + 5);
	try {
		const parsed = parseSimpleYaml(yamlText);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { frontmatter: parsed as Record<string, unknown>, body };
		}
	} catch {
		// fall through
	}
	return { frontmatter: null, body };
}
