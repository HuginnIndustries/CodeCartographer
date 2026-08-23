// Workspace bootstrap: resolves the packaged .codecarto/ template directory
// (so the MCP server and Pi can both copy from it on /codecarto-init), loads
// + normalizes the per-project workspace state from disk, and provides the
// atomic status-update primitive used by /codecarto-complete.

import { existsSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, applyHandoff, createEmptyStatus, normalizeStatus, parseHandoff } from "./status.ts";
import type { PhaseHandoff, PipelineFile, StatusFile, WorkspaceState } from "./types.ts";
import { pathExists } from "./utils.ts";
import { loadYamlFile, stringifySimpleYaml } from "./yaml.ts";

// Walk up from the current file to find the package root. Needed because the
// source lives at <root>/core/workspace.ts (one level below the package root)
// but compiles to <root>/dist/core/workspace.js (two levels below). A fixed
// `..` only works in one of those layouts, so resolve `package.json` instead.
function findPackageRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`Could not locate package.json starting from ${start}`);
		}
		dir = parent;
	}
}

const coreDir = dirname(fileURLToPath(import.meta.url));
/** Installed package root. Anchors packaged assets served to clients (template, agent skill). */
export const packageRoot = findPackageRoot(coreDir);

// Path to the packaged framework template directory. Wrappers copy this on
// /codecarto-init.
export const packagedWorkspaceDir = join(packageRoot, ".codecarto");

// Resolved at module-load time from the same package.json that findPackageRoot
// located. Used by the HTML dashboard renderer for the footer; cheap to read
// once since startup is already paying for findPackageRoot.
export const PACKAGE_VERSION: string = (() => {
	try {
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

function assertCanonicalStatus(status: StatusFile): void {
	if (status.schema_version !== 1) {
		throw new Error(`Cannot write unsupported status schema_version ${String(status.schema_version)}.`);
	}
	if (!Array.isArray(status.post_pipeline)) {
		throw new Error("Cannot write status: post_pipeline must be an array.");
	}
	if (!status.phases || typeof status.phases !== "object" || Array.isArray(status.phases)) {
		throw new Error("Cannot write status: phases must be a mapping.");
	}
	for (const [phaseId, phase] of Object.entries(status.phases)) {
		for (const field of ["owner_notes", "outputs_present", "open_questions", "carry_forward"] as const) {
			if (!Array.isArray(phase?.[field])) {
				throw new Error(`Cannot write status: phases.${phaseId}.${field} must be an array.`);
			}
		}
	}
}

export async function getWorkspaceState(cwd: string): Promise<WorkspaceState | null> {
	const workspaceDir = join(cwd, ".codecarto");
	const statusPath = join(workspaceDir, "workflow", "status.yaml");
	if (!(await pathExists(statusPath))) return null;

	const rawStatus = await loadYamlFile<StatusFile>(statusPath);
	const pipelineRelativePath = rawStatus.pipeline?.trim();
	if (!pipelineRelativePath) {
		throw new Error(`Missing pipeline in ${relative(cwd, statusPath) || statusPath}`);
	}

	const pipelinePath = join(workspaceDir, pipelineRelativePath);
	if (!(await pathExists(pipelinePath))) {
		throw new Error(`Active pipeline does not exist: ${relative(cwd, pipelinePath) || pipelinePath}`);
	}

	const pipeline = await loadYamlFile<PipelineFile>(pipelinePath);
	const status = normalizeStatus(rawStatus, pipeline, pipelineRelativePath, cwd);

	const scaffoldVersionPath = join(workspaceDir, "workflow", "scaffold-version.yaml");
	let scaffoldVersion: string | undefined;
	if (await pathExists(scaffoldVersionPath)) {
		const marker = await loadYamlFile<{ scaffold_version?: unknown }>(scaffoldVersionPath);
		if (typeof marker.scaffold_version === "string" && marker.scaffold_version.trim()) {
			scaffoldVersion = marker.scaffold_version.trim();
		} else if (typeof marker.scaffold_version === "number") {
			scaffoldVersion = String(marker.scaffold_version);
		}
	}

	return {
		cwd,
		workspaceDir,
		statusPath,
		pipelinePath,
		pipeline,
		status,
		...(scaffoldVersion !== undefined && { scaffoldVersion }),
	};
}

/** The orchestrator-maintained files init seeds and completion appends to. */
export const ORCHESTRATOR_FILES = [
	{ file: "CONVENTIONS.md", template: "conventions-template.md" },
	{ file: "DECISIONS.md", template: "decisions-template.md" },
] as const;

/**
 * Seed the orchestrator-maintained files from the workspace's templates
 * (issue #98): orchestration is on by default, so a fresh workspace starts
 * with both skeletons instead of gating them behind a role ritual. Idempotent
 * — existing files are never touched, and a scaffold without the templates
 * (pre-template era) is left for completion's minimal-header fallback.
 * @returns the file names created, for the caller's report.
 */
export async function seedOrchestratorFiles(workspaceDir: string): Promise<string[]> {
	const created: string[] = [];
	for (const { file, template } of ORCHESTRATOR_FILES) {
		const target = join(workspaceDir, file);
		if (await pathExists(target)) continue;
		const templatePath = join(workspaceDir, "templates", template);
		if (!(await pathExists(templatePath))) continue;
		await copyFile(templatePath, target);
		created.push(file);
	}
	return created;
}

/**
 * Workspace paths refresh never touches: project state, user configuration,
 * user-owned top-level files, and the directories sessions write into.
 * Everything else present in the packaged template is framework-owned.
 */
const REFRESH_EXCLUDED_TOP_LEVEL = new Set(["BACKLOG.md", "THREAD_LOG.md", "CONVENTIONS.md", "DECISIONS.md"]);
// broadside/ holds machine-local scout state (batch ids, API key config,
// generated results) — refresh must never overwrite it.
const REFRESH_EXCLUDED_DIRS = new Set(["scratch", "inputs", "closeouts", "broadside"]);
const REFRESH_EXCLUDED_WORKFLOW_FILES = new Set(["status.yaml", "config.yaml", ".usage.local.yaml"]);

/** One scaffold refresh's outcome. */
export type RefreshScaffoldResult = {
	/** Workspace-relative paths written, sorted. */
	written: string[];
	/** The workspace's scaffold version before the refresh, if any. */
	scaffoldVersionBefore?: string;
	/** The running framework version the scaffold now matches. */
	scaffoldVersionAfter: string;
};

async function listTemplateFiles(dir: string, relativeDir = ""): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (!relativeDir && REFRESH_EXCLUDED_DIRS.has(entry.name)) continue;
			files.push(...await listTemplateFiles(join(dir, entry.name), relativePath));
			continue;
		}
		if (!relativeDir && REFRESH_EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
		if (relativeDir === "workflow" && REFRESH_EXCLUDED_WORKFLOW_FILES.has(entry.name)) continue;
		files.push(relativePath);
	}
	return files;
}

/**
 * Refresh a workspace's framework-owned files from the packaged template
 * (issue #102): both staleness notices instruct exactly this, and the only
 * tool that previously touched scaffold files was init's force mode, which
 * backs up the entire workspace. Copies every file the packaged template
 * ships except project state (`workflow/status.yaml`), user configuration
 * (`workflow/config.yaml`, usage log), user-owned top-level files
 * (BACKLOG, THREAD_LOG, CONVENTIONS, DECISIONS), and session-written
 * directories (`scratch/`, `inputs/`, `closeouts/`). Files the template no
 * longer ships are left in place. Appends one THREAD_LOG entry naming the
 * version transition.
 */
export async function refreshScaffold(cwd: string): Promise<RefreshScaffoldResult> {
	const state = await getWorkspaceState(cwd);
	if (!state) throw new Error("CodeCartographer workspace not found. Run /codecarto-init first.");
	if (!existsSync(packagedWorkspaceDir)) {
		throw new Error("Packaged .codecarto template is missing. Reinstall codecartographer-pi.");
	}
	const scaffoldVersionBefore = state.scaffoldVersion;
	const files = (await listTemplateFiles(packagedWorkspaceDir)).sort();
	for (const relativePath of files) {
		const target = join(state.workspaceDir, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(packagedWorkspaceDir, relativePath), target);
	}
	const entry = `- ${new Date().toISOString().slice(0, 10)} — scaffold-refresh — Refreshed ${files.length} framework-owned file(s) from the packaged template (${scaffoldVersionBefore ?? "unversioned"} → ${PACKAGE_VERSION}); project state, user config, and session outputs untouched.`;
	await appendFile(join(state.workspaceDir, "THREAD_LOG.md"), `${entry}\n`, "utf8");
	return {
		written: files,
		...(scaffoldVersionBefore !== undefined && { scaffoldVersionBefore }),
		scaffoldVersionAfter: PACKAGE_VERSION,
	};
}

// Numeric x.y.z comparison; null when either side is not a plain dotted triple.
function compareDottedVersions(a: string, b: string): number | null {
	const parse = (version: string): number[] | null => {
		const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
	};
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return null;
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
	}
	return 0;
}

/**
 * Human-readable staleness notice for the workspace's .codecarto/ scaffold,
 * or null when the scaffold matches the running framework. A missing marker
 * means the scaffold was copied from a release that predates it — those
 * scaffolds may also predate the v0.12.0 handoff contract, whose GUIDE and
 * pipelines instruct the exact opposite completion protocol. Warn, never
 * fail: unversioned workspaces must keep working.
 */
export function describeScaffoldStaleness(state: WorkspaceState): string | null {
	const scaffold = state.scaffoldVersion;
	if (!scaffold) {
		return "This workspace's .codecarto/ scaffold has no workflow/scaffold-version.yaml marker (introduced after v0.12.11), so its framework-owned files (GUIDE.md, templates/, workflow/ pipelines and VALIDATE.md) may predate the v0.12.0 handoff contract. Refresh them from the packaged CodeCartographer template (codecarto_refresh_scaffold does exactly this without touching project state).";
	}
	const comparison = compareDottedVersions(scaffold, PACKAGE_VERSION);
	if (comparison === 0) return null;
	if (comparison === null) {
		return scaffold === PACKAGE_VERSION
			? null
			: `This workspace's scaffold version (${scaffold}) does not match the running framework (${PACKAGE_VERSION}). Refresh the framework-owned files (GUIDE.md, templates/, workflow/) from the packaged template — codecarto_refresh_scaffold does exactly this without touching project state.`;
	}
	if (comparison < 0) {
		return `This workspace's scaffold (v${scaffold}) is older than the running framework (v${PACKAGE_VERSION}). Refresh the framework-owned files (GUIDE.md, templates/, workflow/) from the packaged template to pick up pipeline and template fixes — codecarto_refresh_scaffold does exactly this without touching project state.`;
	}
	return `This workspace's scaffold (v${scaffold}) is newer than the running framework (v${PACKAGE_VERSION}). Upgrade CodeCartographer to at least v${scaffold}.`;
}

export async function updateStatusAtomically(
	cwd: string,
	updater: (state: WorkspaceState) => Promise<{ state: WorkspaceState; handoff?: PhaseHandoff; threadLogEntry?: string }> | { state: WorkspaceState; handoff?: PhaseHandoff; threadLogEntry?: string },
): Promise<WorkspaceState> {
	const workspaceDir = join(cwd, ".codecarto");
	const statusPath = join(workspaceDir, "workflow", "status.yaml");
	const lockPath = `${statusPath}.lock`;
	const lock = await acquireLock(lockPath);

	try {
		const currentState = await getWorkspaceState(cwd);
		if (!currentState) {
			throw new Error("CodeCartographer workspace not found. Run /codecarto-init first.");
		}

		const result = await updater(currentState);
		const nextState = result.state;

		// Apply handoff if provided
		if (result.handoff) {
			const handoff = parseHandoff(result.handoff);
			applyHandoff(nextState.status, handoff);
		}
		assertCanonicalStatus(nextState.status);

		const serialized = `${stringifySimpleYaml(nextState.status)}\n`;
		const tempPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tempPath, serialized, "utf8");
		await rename(tempPath, statusPath);

		if (result.threadLogEntry) {
			const threadLogPath = join(workspaceDir, "THREAD_LOG.md");
			let currentLog = "";
			try {
				currentLog = await readFile(threadLogPath, "utf8");
			} catch {
				// File may not exist yet
			}
			const logEntries = currentLog.split(/\r?\n/).filter((line) => line.trim().startsWith("- "));
			const normalizedEntry = result.threadLogEntry.trim();
			const isDuplicate = logEntries.some((line) => line.trim() === normalizedEntry);
			if (!isDuplicate) {
				await appendFile(threadLogPath, result.threadLogEntry, "utf8");
			}
		}

		return nextState;
	} finally {
		await lock.release();
	}
}

/**
 * Switch the active pipeline in-place without deleting findings, handoffs,
 * usage data, closeouts, or checkpoints. Phases that exist in both the old
 * and new pipelines preserve their completion status, owner notes, open
 * questions, and carry-forward entries. Phases unique to the new pipeline
 * start as pending. Phases unique to the old pipeline are dropped from
 * status.yaml (but their findings remain on disk under findings/).
 */
export async function switchPipeline(
	cwd: string,
	newPipelinePath: string,
): Promise<{ state: WorkspaceState; carried: string[]; dropped: string[]; newPhases: string[] }> {
	const workspaceDir = join(cwd, ".codecarto");
	const statusPath = join(workspaceDir, "workflow", "status.yaml");
	const lockPath = `${statusPath}.lock`;
	const lock = await acquireLock(lockPath);

	try {
		const currentState = await getWorkspaceState(cwd);
		if (!currentState) {
			throw new Error("CodeCartographer workspace not found. Run /codecarto-init first.");
		}

		const resolvedPipelinePath = join(workspaceDir, newPipelinePath);
		if (!(await pathExists(resolvedPipelinePath))) {
			throw new Error(`Pipeline not found: ${newPipelinePath}`);
		}

		const newPipeline = await loadYamlFile<PipelineFile>(resolvedPipelinePath);
		const freshStatus = createEmptyStatus(basename(cwd), newPipelinePath, newPipeline);

		// Preserve phase data for phases that exist in both old and new pipelines.
		const carried: string[] = [];
		const oldPhases = currentState.status.phases;
		for (const phaseId of newPipeline.phase_order) {
			if (oldPhases[phaseId]) {
				freshStatus.phases[phaseId] = { ...oldPhases[phaseId] };
				if (oldPhases[phaseId].status === "complete") {
					carried.push(phaseId);
				}
			}
		}

		// Track phases that were in the old pipeline but not the new one.
		const dropped = currentState.pipeline.phase_order.filter(
			(phaseId) => !newPipeline.phase_order.includes(phaseId),
		);
		const newPhases = newPipeline.phase_order.filter(
			(phaseId) => !currentState.pipeline.phase_order.includes(phaseId),
		);

		// Preserve post_pipeline entries from the old status.
		freshStatus.post_pipeline = currentState.status.post_pipeline;

		freshStatus.last_updated = new Date().toISOString();

		assertCanonicalStatus(freshStatus);
		const serialized = `${stringifySimpleYaml(freshStatus)}\n`;
		const tempPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tempPath, serialized, "utf8");
		await rename(tempPath, statusPath);

		const state = await getWorkspaceState(cwd);
		if (!state) throw new Error("Failed to reload workspace state after pipeline switch.");

		return { state, carried, dropped, newPhases };
	} finally {
		await lock.release();
	}
}
