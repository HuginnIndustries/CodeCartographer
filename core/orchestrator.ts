// Per-machine pointer to the Pi session that runs as the CodeCartographer
// orchestrator. Stored in `.codecarto/workflow/.orchestrator.local.yaml`
// (gitignored) so committed `status.yaml` doesn't leak machine-specific
// session file paths to collaborators.
//
// Only the Pi extension writes/reads this — the MCP path has no session
// concept. When the file is missing or malformed, `/codecarto-next` falls
// back to in-place phase prompts (legacy 0.1.0–0.1.2 behavior).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathExists } from "./utils.ts";
import { loadYamlFile, stringifySimpleYaml } from "./yaml.ts";

export interface OrchestratorState {
	sessionFile: string;
	sessionId: string;
}

const ORCHESTRATOR_STATE_RELATIVE = "workflow/.orchestrator.local.yaml";

function orchestratorStatePath(cwd: string): string {
	return join(cwd, ".codecarto", ORCHESTRATOR_STATE_RELATIVE);
}

export async function loadOrchestratorState(cwd: string): Promise<OrchestratorState | null> {
	const path = orchestratorStatePath(cwd);
	if (!(await pathExists(path))) return null;
	let data: Partial<OrchestratorState> | null;
	try {
		data = await loadYamlFile<Partial<OrchestratorState>>(path);
	} catch {
		return null;
	}
	if (!data?.sessionFile || !data?.sessionId) return null;
	return { sessionFile: data.sessionFile, sessionId: data.sessionId };
}

export async function writeOrchestratorState(cwd: string, state: OrchestratorState): Promise<void> {
	const path = orchestratorStatePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${stringifySimpleYaml(state)}\n`, "utf8");
}
