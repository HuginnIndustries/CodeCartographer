// Workspace bootstrap: resolves the packaged .codecarto/ template directory
// (so the MCP server and Pi can both copy from it on /codecarto-init), loads
// + normalizes the per-project workspace state from disk, and provides the
// atomic status-update primitive used by /codecarto-complete.

import { appendFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, normalizeStatus } from "./status.ts";
import type { PipelineFile, StatusFile, WorkspaceState } from "./types.ts";
import { pathExists } from "./utils.ts";
import { loadYamlFile, stringifySimpleYaml } from "./yaml.ts";

const coreDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(coreDir, "..");

// Path to the packaged framework template directory. Wrappers copy this on
// /codecarto-init.
export const packagedWorkspaceDir = join(packageRoot, ".codecarto");

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
	updater: (state: WorkspaceState) => Promise<{ state: WorkspaceState; threadLogEntry?: string }> | { state: WorkspaceState; threadLogEntry?: string },
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
		const serialized = `${stringifySimpleYaml(nextState.status)}\n`;
		const tempPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tempPath, serialized, "utf8");
		await rename(tempPath, statusPath);

		if (result.threadLogEntry) {
			const threadLogPath = join(workspaceDir, "THREAD_LOG.md");
			await appendFile(threadLogPath, result.threadLogEntry, "utf8");
		}

		return nextState;
	} finally {
		await lock.release();
	}
}
