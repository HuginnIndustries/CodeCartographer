// Workspace-level orchestrator configuration. Lives at
// `.codecarto/workflow/config.yaml`. Missing file or missing keys fall back
// to defaults, so existing workspaces created before this file existed
// keep working unchanged. Schema is intentionally narrow — one surface
// per feature, easy to grow.

import { join } from "node:path";
import type { PathLike } from "node:fs";
import { pathExists } from "./utils.ts";
import { loadYamlFile } from "./yaml.ts";

export interface OrchestratorConfig {
	/** When true, /codecarto-next runs an LLM rewriter to produce a seed prompt
	 *  customized to the previous phase's closeout + the next phase's template
	 *  before spawning the sub-agent. Off by default — extra orchestrator-side
	 *  tokens, opt-in. */
	llm_steer_next_phase: boolean;
}

export interface CodecartoConfig {
	orchestrator: OrchestratorConfig;
}

export const CONFIG_RELATIVE_PATH = "workflow/config.yaml";

const DEFAULT_CONFIG: CodecartoConfig = {
	orchestrator: {
		llm_steer_next_phase: false,
	},
};

type RawConfig = {
	orchestrator?: Partial<{ llm_steer_next_phase: unknown }>;
};

export async function loadCodecartoConfig(workspaceDir: PathLike): Promise<CodecartoConfig> {
	const configPath = join(workspaceDir as string, CONFIG_RELATIVE_PATH);
	if (!(await pathExists(configPath))) return cloneDefault();
	try {
		const raw = await loadYamlFile<RawConfig>(configPath);
		return mergeConfig(raw);
	} catch {
		// Malformed YAML: fall back to defaults rather than failing the
		// command. The user can fix it; a broken config shouldn't block work.
		return cloneDefault();
	}
}

export function mergeConfig(raw: RawConfig | null | undefined): CodecartoConfig {
	const merged = cloneDefault();
	if (!raw || typeof raw !== "object") return merged;
	const o = raw.orchestrator;
	if (o && typeof o === "object") {
		if (typeof o.llm_steer_next_phase === "boolean") {
			merged.orchestrator.llm_steer_next_phase = o.llm_steer_next_phase;
		}
	}
	return merged;
}

function cloneDefault(): CodecartoConfig {
	return {
		orchestrator: { ...DEFAULT_CONFIG.orchestrator },
	};
}
