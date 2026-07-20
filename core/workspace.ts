// Workspace bootstrap: resolves the packaged .codecarto/ template directory
// (so the MCP server and Pi can both copy from it on /codecarto-init), loads
// + normalizes the per-project workspace state from disk, and provides the
// atomic status-update primitive used by /codecarto-complete.

import { existsSync, readFileSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, applyHandoff, normalizeStatus, parseHandoff } from "./status.ts";
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
const packageRoot = findPackageRoot(coreDir);

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

	return {
		cwd,
		workspaceDir,
		statusPath,
		pipelinePath,
		pipeline,
		status,
	};
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
