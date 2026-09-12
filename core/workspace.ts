// Workspace bootstrap: resolves the packaged .codecarto/ template directory
// (so the MCP server and Pi can both copy from it on /codecarto-init), loads
// + normalizes the per-project workspace state from disk, and provides the
// atomic status-update primitive used by /codecarto-complete.

import { existsSync, readFileSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, applyHandoff, createEmptyStatus, normalizeStatus, parseHandoff } from "./status.ts";
import type { PhaseHandoff, PipelineFile, StatusFile, WorkspaceState } from "./types.ts";
import { compareDottedVersions, newlineIfUnterminated, pathExists } from "./utils.ts";
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
	{ file: "BACKLOG.md", template: "backlog-project.md" },
	{ file: "THREAD_LOG.md", template: "thread-log.md" },
] as const;

/**
 * Project state that must never travel from the packaged template into a new
 * workspace.
 *
 * This repository's `.codecarto/` is two things at once: the template that gets
 * copied into a user's repo, and CodeCartographer's own live workspace. The
 * second role writes real project state into it — a backlog of framework
 * deferrals, a thread log, closeouts of sessions where CodeCartographer
 * analyzed itself. Copying the tree wholesale handed every new workspace ~40 KB
 * of another project's history as its own, and the damage was not only clutter:
 * GUIDE.md keys first-time-project setup on `closeouts/` being empty, so a
 * shipped closeout told every new session it was not the first to touch the
 * project, suppressing the orchestrator role that issues #97/#98 made the
 * default.
 *
 * The four top-level files are seeded fresh from templates instead
 * ({@link ORCHESTRATOR_FILES}); `closeouts/` is created empty.
 */
const INIT_EXCLUDED_TOP_LEVEL = new Set([
	"BACKLOG.md",
	"THREAD_LOG.md",
	"CONVENTIONS.md",
	"DECISIONS.md",
	// Rendered from a workspace's own state; the narration cache holds an
	// LLM summary of it.
	"dashboard.html",
	".dashboard-narration.local.md",
]);
// Directories that exist in every workspace but whose contents are one
// project's sessions: closeouts, and scratch (handoffs, checkpoints,
// amendments) apart from its .gitkeep.
const INIT_EXCLUDED_DIR_CONTENTS = new Set(["closeouts", "scratch"]);
// Project state under workflow/: init writes a fresh status.yaml itself, and
// the two dot-files hold one machine's usage log and session pointer.
const INIT_EXCLUDED_WORKFLOW_FILES = new Set(["status.yaml", ".usage.local.yaml", ".orchestrator.local.yaml"]);
// Where the workspace's ignore rules ship (see ensureWorkspaceGitignore).
const GITIGNORE_TEMPLATE_RELATIVE_PATH = "templates/gitignore";
// broadside/ is machine-local scan state (state.json, timestamped run dirs)
// except for its two template files — the same carve-out .codecarto/.gitignore
// makes for this repository itself. Without this, init from a local checkout
// with live scan state handed every new workspace another project's runs.
// Literal rather than an import from broadside.ts, which imports this module.
const BROADSIDE_DIR_NAME = "broadside";
const INIT_BROADSIDE_TEMPLATE_FILES = new Set(["SKILL.md", "config.yaml"]);

/**
 * Every workspace-relative path a packaged pipeline declares as a phase output,
 * primary or secondary. Findings directories ship README and SKILL stubs
 * beside the reports sessions write, so the reports have to be excluded by
 * name rather than by directory, and the pipelines are the source of truth
 * for those names. A pipeline file that fails to load contributes nothing.
 */
export async function listDeclaredOutputs(sourceWorkspaceDir: string = packagedWorkspaceDir): Promise<Set<string>> {
	const outputs = new Set<string>();
	const workflowDir = join(sourceWorkspaceDir, "workflow");
	let names: string[];
	try {
		names = await readdir(workflowDir);
	} catch {
		return outputs;
	}
	for (const name of names) {
		if (!/^pipeline.*\.ya?ml$/.test(name)) continue;
		let pipeline: PipelineFile | null | undefined;
		try {
			pipeline = await loadYamlFile<PipelineFile>(join(workflowDir, name));
		} catch {
			continue;
		}
		for (const phase of pipeline?.phases ?? []) {
			if (typeof phase.primary_output === "string") outputs.add(toPosixRelative(phase.primary_output));
			for (const secondary of phase.secondary_outputs ?? []) {
				const path = (secondary as { path?: unknown }).path;
				if (typeof path === "string") outputs.add(toPosixRelative(path));
			}
		}
	}
	return outputs;
}

function toPosixRelative(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Whether a template path (as segments) is framework-owned and travels into a
 * new workspace. Everything a session produces stays behind: the declared
 * phase outputs, handoffs and checkpoints, closeouts, the dashboard, usage,
 * status, Broad-Side runs, and any lock or temp file a crashed process left.
 * Directories pass so the workspace keeps its shape (an empty `closeouts/`,
 * a `findings/<phase>/` for every phase).
 */
function isTemplatePath(segments: string[], declaredOutputs: Set<string>): boolean {
	const posixPath = segments.join("/");
	if (declaredOutputs.has(posixPath)) return false;
	if (/\.(lock|tmp)$/.test(posixPath)) return false;
	if (segments.length === 1) return !INIT_EXCLUDED_TOP_LEVEL.has(segments[0]);
	const [top, second] = segments;
	if (top === BROADSIDE_DIR_NAME) return segments.length === 2 && INIT_BROADSIDE_TEMPLATE_FILES.has(second);
	if (top === "scratch") return segments.length === 2 && second === ".gitkeep";
	if (top === "workflow") return !(segments.length === 2 && INIT_EXCLUDED_WORKFLOW_FILES.has(second));
	return !INIT_EXCLUDED_DIR_CONTENTS.has(top);
}

/**
 * Copy the packaged template into a target workspace, skipping everything a
 * session wrote into it. Directories are still created, so a fresh workspace
 * has an empty `closeouts/` rather than no `closeouts/`.
 *
 * This repository's `.codecarto/` is the template *and* CodeCartographer's own
 * live workspace, so a checkout install's template can hold finished phase
 * reports, handoffs, and a dashboard. Copying those seeded every new workspace
 * with another project's findings, and validation then passed on them (#224).
 * The exclusion is by declared output path ({@link listDeclaredOutputs}), so a
 * new phase's report is covered the moment its pipeline names it.
 *
 * @param targetWorkspaceDir - Absolute path to the `.codecarto/` to create or merge into.
 * @param sourceWorkspaceDir - The template to copy from. Defaults to the packaged
 *   template; tests pass a synthetic directory so they can prove the state filter
 *   without mutating the repository's own live workspace mid-suite.
 */
export async function copyPackagedWorkspace(
	targetWorkspaceDir: string,
	sourceWorkspaceDir: string = packagedWorkspaceDir,
): Promise<void> {
	const declaredOutputs = await listDeclaredOutputs(sourceWorkspaceDir);
	await cp(sourceWorkspaceDir, targetWorkspaceDir, {
		recursive: true,
		filter: (source) => {
			const relativePath = relative(sourceWorkspaceDir, source);
			if (!relativePath) return true; // the workspace root itself
			return isTemplatePath(relativePath.split(/[\\/]/), declaredOutputs);
		},
	});
	// The published tarball carries no empty directories, so an excluded-contents
	// directory may not exist to be copied at all. Create them either way: a
	// workspace whose closeouts/ is missing rather than empty reads differently
	// to anything that lists it.
	for (const name of INIT_EXCLUDED_DIR_CONTENTS) {
		await mkdir(join(targetWorkspaceDir, name), { recursive: true });
	}
	await ensureWorkspaceGitignore(targetWorkspaceDir);
}

/**
 * Give the workspace its ignore rules when it has none. npm never packs a file
 * named `.gitignore`, so an npm-installed template carried no rules and the
 * workspaces initialised from it committed the dashboard, the usage log with
 * its absolute session paths, and the Broad-Side config with any API key in
 * it (#229). The rules ship as `templates/gitignore` instead and are copied
 * to `.gitignore` here; an existing `.gitignore` is the user's and is left
 * alone.
 * @returns whether a file was written.
 */
export async function ensureWorkspaceGitignore(workspaceDir: string): Promise<boolean> {
	const target = join(workspaceDir, ".gitignore");
	if (await pathExists(target)) return false;
	const template = join(workspaceDir, GITIGNORE_TEMPLATE_RELATIVE_PATH);
	if (!(await pathExists(template))) return false;
	await copyFile(template, target);
	return true;
}

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
const REFRESH_EXCLUDED_TOP_LEVEL = new Set([
	"BACKLOG.md",
	"THREAD_LOG.md",
	"CONVENTIONS.md",
	"DECISIONS.md",
	"dashboard.html",
	".dashboard-narration.local.md",
	// The user's ignore rules; created from templates/gitignore when absent.
	".gitignore",
]);
// broadside/ holds machine-local scout state (batch ids, API key config,
// generated results) — refresh must never overwrite it.
const REFRESH_EXCLUDED_DIRS = new Set(["scratch", "inputs", "closeouts", "broadside"]);
const REFRESH_EXCLUDED_WORKFLOW_FILES = new Set(["status.yaml", "config.yaml", ".usage.local.yaml", ".orchestrator.local.yaml"]);

/**
 * What a scaffold refresh never touches, for a wrapper that asks before
 * refreshing to show. The same sets drive {@link refreshScaffold}, so the
 * preview and the write cannot disagree.
 */
export const SCAFFOLD_REFRESH_PROTECTED = Object.freeze({
	topLevel: Object.freeze([...REFRESH_EXCLUDED_TOP_LEVEL]),
	dirs: Object.freeze([...REFRESH_EXCLUDED_DIRS]),
	workflowFiles: Object.freeze([...REFRESH_EXCLUDED_WORKFLOW_FILES]),
});

/** One scaffold refresh's outcome. */
export type RefreshScaffoldResult = {
	/** Workspace-relative paths written, sorted. */
	written: string[];
	/** The workspace's scaffold version before the refresh, if any. */
	scaffoldVersionBefore?: string;
	/** The running framework version the scaffold now matches. */
	scaffoldVersionAfter: string;
};

async function listTemplateFiles(dir: string, declaredOutputs: Set<string>, relativeDir = ""): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (!relativeDir && REFRESH_EXCLUDED_DIRS.has(entry.name)) continue;
			files.push(...await listTemplateFiles(join(dir, entry.name), declaredOutputs, relativePath));
			continue;
		}
		if (!relativeDir && REFRESH_EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
		if (relativeDir === "workflow" && REFRESH_EXCLUDED_WORKFLOW_FILES.has(entry.name)) continue;
		// A checkout install's template can hold finished reports (the repository
		// analyses itself); refreshing those over a user's own would be worse
		// than init copying them (#224).
		if (declaredOutputs.has(relativePath)) continue;
		if (/\.(lock|tmp)$/.test(entry.name)) continue;
		files.push(relativePath);
	}
	return files;
}

/**
 * The workspace-relative paths a scaffold refresh would write, sorted — the
 * exact set {@link refreshScaffold} copies, computed without writing anything.
 * A wrapper that asks before refreshing shows this.
 */
export async function listScaffoldRefreshFiles(sourceWorkspaceDir: string = packagedWorkspaceDir): Promise<string[]> {
	if (!existsSync(sourceWorkspaceDir)) {
		throw new Error("Packaged .codecarto template is missing. Reinstall codecartographer-pi.");
	}
	const declaredOutputs = await listDeclaredOutputs(sourceWorkspaceDir);
	return (await listTemplateFiles(sourceWorkspaceDir, declaredOutputs)).sort();
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
	const files = await listScaffoldRefreshFiles();
	for (const relativePath of files) {
		const target = join(state.workspaceDir, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(packagedWorkspaceDir, relativePath), target);
	}
	// Workspaces initialised from an npm install before the rules shipped as a
	// template have no .gitignore at all; give them one without touching an
	// existing (user-owned) file.
	await ensureWorkspaceGitignore(state.workspaceDir);
	const entry = `- ${new Date().toISOString().slice(0, 10)} — scaffold-refresh — Refreshed ${files.length} framework-owned file(s) from the packaged template (${scaffoldVersionBefore ?? "unversioned"} → ${PACKAGE_VERSION}); project state, user config, and session outputs untouched.`;
	const threadLogPath = join(state.workspaceDir, "THREAD_LOG.md");
	let currentLog = "";
	try {
		currentLog = await readFile(threadLogPath, "utf8");
	} catch {
		// Created by the append when absent (pre-template scaffolds).
	}
	await appendFile(threadLogPath, `${newlineIfUnterminated(currentLog)}${entry}\n`, "utf8");
	return {
		written: files,
		...(scaffoldVersionBefore !== undefined && { scaffoldVersionBefore }),
		scaffoldVersionAfter: PACKAGE_VERSION,
	};
}

// Numeric x.y.z comparison; null when either side is not a plain dotted triple.

/**
 * The remedy every staleness notice points at, spelled for both executable
 * surfaces: this text renders inside Pi's widget and inside MCP's status
 * result alike, and a Pi user handed only the MCP tool name has nothing to run.
 */
const SCAFFOLD_REFRESH_REMEDY = "`codecarto_refresh_scaffold` on MCP, `/codecarto-refresh-scaffold` on Pi";

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
		return `This workspace's .codecarto/ scaffold has no workflow/scaffold-version.yaml marker (introduced after v0.12.11), so its framework-owned files (GUIDE.md, templates/, workflow/ pipelines and VALIDATE.md) may predate the v0.12.0 handoff contract. Refresh them from the packaged CodeCartographer template (${SCAFFOLD_REFRESH_REMEDY}) — that refresh does not touch project state.`;
	}
	const comparison = compareDottedVersions(scaffold, PACKAGE_VERSION);
	if (comparison === 0) return null;
	if (comparison === null) {
		return scaffold === PACKAGE_VERSION
			? null
			: `This workspace's scaffold version (${scaffold}) does not match the running framework (${PACKAGE_VERSION}). Refresh the framework-owned files (GUIDE.md, templates/, workflow/) from the packaged template (${SCAFFOLD_REFRESH_REMEDY}) — that refresh does not touch project state.`;
	}
	if (comparison < 0) {
		return `This workspace's scaffold (v${scaffold}) is older than the running framework (v${PACKAGE_VERSION}). Refresh the framework-owned files (GUIDE.md, templates/, workflow/) from the packaged template to pick up pipeline and template fixes (${SCAFFOLD_REFRESH_REMEDY}) — that refresh does not touch project state.`;
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
				await appendFile(threadLogPath, `${newlineIfUnterminated(currentLog)}${normalizedEntry}\n`, "utf8");
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
