// Workspace-level orchestrator configuration. Two layers:
//
//   1. User-global  — `~/.codecarto/config.yaml`. Default location for
//      `library.path`, `library.namespace`, `library.publish_confirm`, and
//      the orchestrator toggles. Shared across all workspaces on this
//      machine.
//   2. Per-workspace — `.codecarto/workflow/config.yaml` inside the
//      workspace. Overrides individual keys from the user-global layer.
//
// Resolution order (top wins): per-workspace > user-global > defaults.
// Missing files at either layer fall back to defaults; malformed YAML
// at either layer is non-fatal (drops the layer, logs nothing).
//
// `library.path` is returned tilde-expanded and absolute so consumers
// don't have to expand themselves.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PathLike } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expandTilde, pathExists } from "./utils.ts";
import { loadYamlFile, parseSimpleYaml, stringifySimpleYaml } from "./yaml.ts";

export interface OrchestratorConfig {
	/** When true, /codecarto-next runs an LLM rewriter to produce a seed prompt
	 *  customized to the previous phase's closeout + the next phase's template
	 *  before spawning the sub-agent. Off by default — extra orchestrator-side
	 *  tokens, opt-in. */
	llm_steer_next_phase: boolean;
}

export interface LibraryConfig {
	/** Absolute, tilde-expanded path to the CodeCartographer library
	 *  this workspace publishes to and reads from. Null if unconfigured —
	 *  callers should prompt the user on first use. */
	path: string | null;
	/** Default namespace for entries published by this workspace.
	 *  Null if unconfigured (single-tenant libraries should use null). */
	namespace: string | null;
	/** Whether `codecarto publish` should display a confirmation prompt
	 *  with slug + source + library path before writing. Default true. */
	publish_confirm: boolean;
}

export interface CodecartoConfig {
	orchestrator: OrchestratorConfig;
	library: LibraryConfig;
}

export const CONFIG_RELATIVE_PATH = "workflow/config.yaml";
export const USER_CONFIG_DIR = join(homedir(), ".codecarto");
export const USER_CONFIG_PATH = join(USER_CONFIG_DIR, "config.yaml");

/**
 * Tests and tooling can override the user-global config path by setting
 * `CODECARTO_USER_CONFIG_PATH`. The exported constant above is the default
 * for documentation and onboarding flows. Internal load functions go
 * through `resolveUserConfigPath()` so the override takes effect.
 */
export function resolveUserConfigPath(): string {
	return process.env.CODECARTO_USER_CONFIG_PATH ?? USER_CONFIG_PATH;
}

const DEFAULT_CONFIG: CodecartoConfig = {
	orchestrator: {
		llm_steer_next_phase: false,
	},
	library: {
		path: null,
		namespace: null,
		publish_confirm: true,
	},
};

type RawConfig = {
	orchestrator?: Partial<{ llm_steer_next_phase: unknown }>;
	library?: Partial<{ path: unknown; namespace: unknown; publish_confirm: unknown }>;
};

export async function loadCodecartoConfig(workspaceDir: PathLike): Promise<CodecartoConfig> {
	const userRaw = await loadRawIfExists(resolveUserConfigPath());
	const workspaceRaw = await loadRawIfExists(join(workspaceDir as string, CONFIG_RELATIVE_PATH));
	return mergeLayered([userRaw, workspaceRaw]);
}

/**
 * Read the user-global config directly. Exposed so wrappers can show
 * "your library is at <path>" in onboarding flows without having to
 * load a workspace first.
 */
export async function loadUserConfig(): Promise<CodecartoConfig> {
	const userRaw = await loadRawIfExists(resolveUserConfigPath());
	return mergeLayered([userRaw]);
}

async function loadRawIfExists(path: string): Promise<RawConfig | null> {
	if (!(await pathExists(path))) return null;
	try {
		return await loadYamlFile<RawConfig>(path);
	} catch {
		return null;
	}
}

function mergeLayered(layers: (RawConfig | null | undefined)[]): CodecartoConfig {
	let merged = cloneDefault();
	for (const layer of layers) merged = applyRaw(merged, layer);
	return merged;
}

/**
 * Apply one raw config layer over an existing config. Public so tests can
 * exercise layering without filesystem fixtures, and so wrappers can mock
 * a layer in memory (e.g. "what if library_path were X").
 */
export function mergeConfig(raw: RawConfig | null | undefined): CodecartoConfig {
	return applyRaw(cloneDefault(), raw);
}

function applyRaw(base: CodecartoConfig, raw: RawConfig | null | undefined): CodecartoConfig {
	if (!raw || typeof raw !== "object") return base;
	const out: CodecartoConfig = {
		orchestrator: { ...base.orchestrator },
		library: { ...base.library },
	};

	const o = raw.orchestrator;
	if (o && typeof o === "object") {
		if (typeof o.llm_steer_next_phase === "boolean") {
			out.orchestrator.llm_steer_next_phase = o.llm_steer_next_phase;
		}
	}

	const l = raw.library;
	if (l && typeof l === "object") {
		if (typeof l.path === "string" && l.path.trim() !== "") {
			out.library.path = resolve(expandTilde(l.path.trim()));
		}
		if (typeof l.namespace === "string" && l.namespace.trim() !== "") {
			out.library.namespace = l.namespace.trim();
		}
		if (typeof l.publish_confirm === "boolean") {
			out.library.publish_confirm = l.publish_confirm;
		}
	}

	return out;
}

function cloneDefault(): CodecartoConfig {
	return {
		orchestrator: { ...DEFAULT_CONFIG.orchestrator },
		library: { ...DEFAULT_CONFIG.library },
	};
}

/**
 * Write a `library:` block into a config file (user-global or workspace).
 * Creates the file and parent directories if needed. Preserves any existing
 * `orchestrator:` block. Overwrites the `library:` block if present.
 */
export async function writeLibraryConfig(
	configPath: string,
	libraryPath: string,
	namespace: string | null = null,
	publishConfirm = true,
): Promise<void> {
	let existing: Record<string, unknown> = {};
	if (await pathExists(configPath)) {
		try {
			const raw = await readFile(configPath, "utf8");
			existing = parseSimpleYaml(raw) as Record<string, unknown>;
		} catch {
			// Malformed file — start fresh
		}
	}

	const library: Record<string, unknown> = { path: libraryPath, publish_confirm: publishConfirm };
	if (namespace) library.namespace = namespace;

	const updated: Record<string, unknown> = { ...existing, library };
	const dir = configPath.includes("/") ? configPath.slice(0, configPath.lastIndexOf("/")) : ".";
	await mkdir(dir, { recursive: true });
	await writeFile(configPath, `${stringifySimpleYaml(updated)}\n`, "utf8");
}
