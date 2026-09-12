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
// A missing file at either layer falls back to defaults. A file that exists
// but cannot be used — unparseable YAML, a section that is not a mapping, a
// key of the wrong type, a relative `library.path` — is dropped at the
// granularity of the fault and the fault is recorded in `problems`, so the
// tools can say which file and which key rather than silently answering
// from the wrong settings (#242, #243).
//
// `library.path` is returned tilde-expanded and absolute. A relative value
// is refused: it would resolve against wherever the MCP server or Pi was
// launched, not against the config file, so the library would move with the
// launch directory.

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
	/** True when some config layer set `publish_confirm`; false when the
	 *  default above supplied it. Pi confirms either way (a dialog costs
	 *  nothing), but the MCP server's refuse-unless-confirmed gate on
	 *  `codecarto_publish` costs every host a round trip, so it applies only
	 *  to hosts that actually configured the key. */
	publish_confirm_configured: boolean;
}

/** One thing a config file said that the loader could not use. */
export interface ConfigProblem {
	/** The config file the problem was found in. */
	path: string;
	/** What was wrong and what the loader did about it. */
	message: string;
}

export interface CodecartoConfig {
	orchestrator: OrchestratorConfig;
	library: LibraryConfig;
	/**
	 * Faults in the config files that were read, in layer order (user-global
	 * first). Empty when every file that exists was used in full. The loader
	 * never throws on a bad file — a phase run should not be blocked by a
	 * typo in a toggle — but publish refuses while this is non-empty, since
	 * the library path and the confirm gate come from here.
	 */
	problems: ConfigProblem[];
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
		publish_confirm_configured: false,
	},
	problems: [],
};

type RawConfig = {
	orchestrator?: Partial<{ llm_steer_next_phase: unknown }>;
	library?: Partial<{ path: unknown; namespace: unknown; publish_confirm: unknown }>;
};

/** One config file as read: its parsed content, or the reason it has none. */
type RawLayer = { path: string; raw: RawConfig | null; problem?: ConfigProblem };

export async function loadCodecartoConfig(workspaceDir: PathLike): Promise<CodecartoConfig> {
	const user = await loadRawIfExists(resolveUserConfigPath());
	const workspace = await loadRawIfExists(join(workspaceDir as string, CONFIG_RELATIVE_PATH));
	return mergeLayered([user, workspace]);
}

/**
 * Read the user-global config directly. Exposed so wrappers can show
 * "your library is at <path>" in onboarding flows without having to
 * load a workspace first.
 */
export async function loadUserConfig(): Promise<CodecartoConfig> {
	return mergeLayered([await loadRawIfExists(resolveUserConfigPath())]);
}

async function loadRawIfExists(path: string): Promise<RawLayer> {
	if (!(await pathExists(path))) return { path, raw: null };
	try {
		const parsed = await loadYamlFile<unknown>(path);
		if (parsed === null || parsed === undefined) return { path, raw: null };
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			return { path, raw: null, problem: { path, message: "the file is not a YAML mapping; the whole file was ignored" } };
		}
		return { path, raw: parsed as RawConfig };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { path, raw: null, problem: { path, message: `could not be parsed (${reason}); the whole file was ignored` } };
	}
}

function mergeLayered(layers: RawLayer[]): CodecartoConfig {
	let merged = cloneDefault();
	for (const layer of layers) {
		if (layer.problem) {
			merged.problems.push(layer.problem);
			continue;
		}
		merged = applyRaw(merged, layer.raw, layer.path);
	}
	return merged;
}

/**
 * Apply one raw config layer over the defaults. Public so tests can
 * exercise layering without filesystem fixtures, and so wrappers can mock
 * a layer in memory (e.g. "what if library_path were X"). `sourcePath`
 * names the layer in any problem it produces.
 */
export function mergeConfig(raw: RawConfig | null | undefined, sourcePath = "(in-memory config)"): CodecartoConfig {
	return applyRaw(cloneDefault(), raw, sourcePath);
}

/**
 * The lines both surfaces print for a config with problems: one header,
 * then one line per fault naming its file. Empty when there are none.
 */
export function describeConfigProblems(config: CodecartoConfig): string[] {
	if (config.problems.length === 0) return [];
	const noun = config.problems.length === 1 ? "problem" : "problems";
	return [
		`Config ${noun} (${config.problems.length}) — these settings are not in effect:`,
		...config.problems.map((problem) => `  - ${problem.path}: ${problem.message}`),
	];
}

function applyRaw(base: CodecartoConfig, raw: RawConfig | null | undefined, sourcePath: string): CodecartoConfig {
	const out: CodecartoConfig = {
		orchestrator: { ...base.orchestrator },
		library: { ...base.library },
		problems: [...base.problems],
	};
	if (!raw || typeof raw !== "object") return out;
	const problem = (message: string) => out.problems.push({ path: sourcePath, message });
	const describe = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : String(value));

	const o = raw.orchestrator;
	if (o !== undefined) {
		if (!o || typeof o !== "object" || Array.isArray(o)) {
			problem("orchestrator must be a mapping; the section was ignored");
		} else if (o.llm_steer_next_phase !== undefined) {
			if (typeof o.llm_steer_next_phase === "boolean") {
				out.orchestrator.llm_steer_next_phase = o.llm_steer_next_phase;
			} else {
				problem(`orchestrator.llm_steer_next_phase must be true or false, got ${describe(o.llm_steer_next_phase)}; the key was ignored`);
			}
		}
	}

	const l = raw.library;
	if (l !== undefined) {
		if (!l || typeof l !== "object" || Array.isArray(l)) {
			problem("library must be a mapping; the section was ignored");
		} else {
			if (typeof l.path === "string" && l.path.trim() !== "") {
				const expanded = expandTilde(l.path.trim());
				if (isAbsolute(expanded)) {
					out.library.path = resolve(expanded);
				} else {
					problem(`library.path must be absolute or start with ~ (got ${describe(l.path.trim())}); the key was ignored`);
				}
			} else if (l.path !== undefined && l.path !== null && typeof l.path !== "string") {
				problem(`library.path must be a string, got ${describe(l.path)}; the key was ignored`);
			}
			if (typeof l.namespace === "string" && l.namespace.trim() !== "") {
				out.library.namespace = l.namespace.trim();
			} else if (l.namespace !== undefined && l.namespace !== null && typeof l.namespace !== "string") {
				problem(`library.namespace must be a string, got ${describe(l.namespace)}; the key was ignored`);
			}
			if (typeof l.publish_confirm === "boolean") {
				out.library.publish_confirm = l.publish_confirm;
				out.library.publish_confirm_configured = true;
			} else if (l.publish_confirm !== undefined) {
				problem(`library.publish_confirm must be true or false, got ${describe(l.publish_confirm)}; the key was ignored`);
			}
		}
	}

	return out;
}

function cloneDefault(): CodecartoConfig {
	return {
		orchestrator: { ...DEFAULT_CONFIG.orchestrator },
		library: { ...DEFAULT_CONFIG.library },
		problems: [],
	};
}

/**
 * Record a library in a config file (user-global or workspace): set
 * `library.path`, and `library.namespace` when one is given. Every other key
 * in the file, `library.publish_confirm` included, is left exactly as it was
 * — library-init writes only what it was asked for, so it cannot switch the
 * MCP confirm gate on behind the user's back (#244). Creates the file and
 * parent directories if needed. A file that exists but does not parse is
 * never overwritten: the caller is told to fix it first.
 */
export async function writeLibraryConfig(
	configPath: string,
	libraryPath: string,
	namespace: string | null = null,
): Promise<void> {
	let existing: Record<string, unknown> = {};
	if (await pathExists(configPath)) {
		const raw = await readFile(configPath, "utf8");
		let parsed: unknown;
		try {
			parsed = parseSimpleYaml(raw);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Refusing to rewrite ${configPath}: it could not be parsed (${reason}). Fix or remove the file, then run library-init again.`);
		}
		if (parsed !== null && parsed !== undefined) {
			if (typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Refusing to rewrite ${configPath}: it is not a YAML mapping. Fix or remove the file, then run library-init again.`);
			}
			existing = parsed as Record<string, unknown>;
		}
	}

	const previous = existing.library;
	const library: Record<string, unknown> = previous && typeof previous === "object" && !Array.isArray(previous)
		? { ...(previous as Record<string, unknown>) }
		: {};
	library.path = libraryPath;
	if (namespace) library.namespace = namespace;

	const updated: Record<string, unknown> = { ...existing, library };
	// dirname() honors the platform separator; the previous hand-rolled
	// `includes("/")` check treated every Windows path as a bare filename
	// and left mkdir a no-op before the writeFile ENOENT'd (#128).
	const dir = dirname(configPath);
	await mkdir(dir, { recursive: true });
	await writeFile(configPath, `${stringifySimpleYaml(updated)}\n`, "utf8");
}
