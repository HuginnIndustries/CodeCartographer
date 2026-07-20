// CodeCartographer MCP server. Exposes the framework as seven JSON-RPC tools
// equivalent to the seven /codecarto-* commands the Pi extension registers.
// Both wrappers import their primitives from ../core/index.ts so phase prompts,
// status normalization, validation, and atomic completion are byte-identical
// across surfaces.
//
// Transport: stdio (the default for MCP servers spawned as subprocesses by
// hosts like Claude Code or Claude Desktop).
//
// Each tool takes an absolute `cwd` (the project the host wants to analyze).
// Tools that produce phase or skill text return it inline as the tool result;
// the host decides how to surface it (display, feed to the agent, etc.).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import {
	buildPhasePrompt,
	buildSkillPrompt,
	buildValidationSummary,
	canonicalPath,
	completeValidatedPhase,
	createEmptyStatus,

	DEFAULT_PIPELINE_PATH,
	deriveSlug,
	discoverLibrary,

	type EntryGeneration,
	type GenerationReasoning,
	type GenerationSurface,
	getNextEligiblePhase,
	getPipelineLabel,
	getWorkspaceState,
	isValidSlug,
	type LibraryIndexEntry,
	type LibraryVisibility,
	listEntries,
	listSkillNames,
	loadCodecartoConfig,
	loadYamlFile,
	normalizeForComparison,

	PACKAGE_VERSION,
	packagedWorkspaceDir,
	pathExists,
	PIPELINE_ALIASES,
	type PipelineFile,
	publishEntry,
	reindex as libraryReindex,
	resolvePhase,
	resolvePipelineChoice,
	type StatusFile,
	stringifySimpleYaml,

	validatePhaseOutput,
	type WorkspaceState,
} from "../core/index.ts";

// ---------- input helpers ----------

async function validateCwd(cwd: unknown): Promise<string> {
	if (typeof cwd !== "string" || !cwd.trim()) {
		throw new McpError(ErrorCode.InvalidParams, "cwd is required");
	}
	if (!isAbsolute(cwd)) {
		throw new McpError(ErrorCode.InvalidParams, `cwd must be an absolute path, got: ${cwd}`);
	}
	if (!(await pathExists(cwd))) {
		throw new McpError(ErrorCode.InvalidParams, `cwd does not exist: ${cwd}`);
	}
	return cwd;
}

async function requireWorkspace(cwd: string): Promise<WorkspaceState> {
	const state = await getWorkspaceState(cwd).catch((error) => {
		throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
	});
	if (!state) {
		throw new McpError(
			ErrorCode.InvalidRequest,
			`No CodeCartographer workspace at ${cwd}. Call codecarto_init first.`,
		);
	}
	return state;
}

function textResult(text: string, structured?: Record<string, unknown>) {
	const result: { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } = {
		content: [{ type: "text", text }],
	};
	if (structured) result.structuredContent = structured;
	return result;
}

// ---------- handlers ----------

export async function handleInit(args: { cwd: string; pipeline?: string; force?: boolean }) {
	const cwd = await validateCwd(args.cwd);
	const pipelineChoice = args.pipeline ? resolvePipelineChoice(args.pipeline) : null;
	if (args.pipeline && !pipelineChoice) {
		throw new McpError(ErrorCode.InvalidParams, `Unknown pipeline: ${args.pipeline}`);
	}

	if (!(await pathExists(packagedWorkspaceDir))) {
		throw new McpError(ErrorCode.InternalError, "Packaged .codecarto assets are missing on the MCP server.");
	}

	const targetWorkspaceDir = join(cwd, ".codecarto");
	const targetExists = await pathExists(targetWorkspaceDir);
	let sameWorkspace = false;
	if (targetExists) {
		sameWorkspace =
			normalizeForComparison(await canonicalPath(targetWorkspaceDir)) ===
			normalizeForComparison(await canonicalPath(packagedWorkspaceDir));
	}

	if (targetExists && !sameWorkspace) {
		if (!args.force) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				`A .codecarto/ directory already exists at ${targetWorkspaceDir}. Pass force: true to overwrite it.`,
			);
		}
		await rm(targetWorkspaceDir, { recursive: true, force: true });
	}

	if (!(await pathExists(targetWorkspaceDir))) {
		await mkdir(cwd, { recursive: true });
		await cp(packagedWorkspaceDir, targetWorkspaceDir, { recursive: true });
	}

	const statusPath = join(targetWorkspaceDir, "workflow", "status.yaml");
	const rawStatus = (await loadYamlFile<StatusFile>(statusPath)) ?? {};
	const selectedPipelinePath = pipelineChoice ?? rawStatus.pipeline?.trim() ?? DEFAULT_PIPELINE_PATH;
	const resolvedPipelinePath = join(targetWorkspaceDir, selectedPipelinePath);

	if (!(await pathExists(resolvedPipelinePath))) {
		throw new McpError(ErrorCode.InvalidParams, `Pipeline file not found: ${selectedPipelinePath}`);
	}

	const pipeline = await loadYamlFile<PipelineFile>(resolvedPipelinePath);
	const normalizedStatus = createEmptyStatus(basename(cwd), selectedPipelinePath, pipeline);
	normalizedStatus.last_updated = new Date().toISOString();
	await writeFile(statusPath, `${stringifySimpleYaml(normalizedStatus)}\n`, "utf8");

	const label = getPipelineLabel(selectedPipelinePath);
	return textResult(
		`Initialized CodeCartographer workspace at ${targetWorkspaceDir}.\nPipeline: ${label} (${selectedPipelinePath})\nFirst phase: ${normalizedStatus.current_phase}`,
		{
			workspaceDir: targetWorkspaceDir,
			pipeline: selectedPipelinePath,
			pipelineLabel: label,
			firstPhase: normalizedStatus.current_phase,
		},
	);
}

export async function handleStatus(args: { cwd: string }) {
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);
	const nextPhase = getNextEligiblePhase(state);
	const currentPhase = nextPhase?.id ?? state.status.current_phase ?? "complete";
	const completed = state.pipeline.phase_order.filter((id) => state.status.phases[id]?.status === "complete").length;
	const totalCarryForward = Object.values(state.status.phases).reduce(
		(sum, phase) => sum + (phase.carry_forward?.length ?? 0),
		0,
	);
	const currentOpenQuestions =
		currentPhase === "complete" ? 0 : state.status.phases[currentPhase]?.open_questions.length ?? 0;
	const terminalOpenQuestions = Object.values(state.status.phases).reduce(
		(sum, phase) => sum + (phase.open_questions?.length ?? 0),
		0,
	);
	const postPipelinePending = state.status.post_pipeline.filter((entry) => entry.status !== "resolved").length;
	const summary = [
		`Phase: ${currentPhase}`,
		`Pipeline state: ${currentPhase === "complete" ? "complete" : "in progress"}`,
		`Pipeline: ${getPipelineLabel(state.status.pipeline)} (${state.status.pipeline})`,
		`Progress: ${completed}/${state.pipeline.phase_order.length} complete`,
		`Open questions (terminal unresolved): ${terminalOpenQuestions}`,
		`Carry-forward (pipeline phases): ${totalCarryForward}`,
		`Post-pipeline work: ${postPipelinePending} pending`,
		`Next: ${state.status.next_actions[0] ?? (nextPhase ? `Begin ${nextPhase.id}` : "All phases complete.")}`,
	].join("\n");
	return textResult(summary, {
		currentPhase,
		pipeline: state.status.pipeline,
		pipelineLabel: getPipelineLabel(state.status.pipeline),
		completed,
		total: state.pipeline.phase_order.length,
		openQuestionsCurrentPhase: currentOpenQuestions,
		openQuestionsTerminal: terminalOpenQuestions,
		carryForwardTotal: totalCarryForward,
		postPipelinePending,
		nextActions: state.status.next_actions,
	});
}

export async function handleNext(args: { cwd: string }) {
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);
	const phase = getNextEligiblePhase(state);
	if (!phase) {
		return textResult("All CodeCartographer phases are complete. Run codecarto_skill for post-pipeline work.", {
			complete: true,
		});
	}
	const prompt = await buildPhasePrompt(state, phase, false);
	return textResult(prompt, { phase: phase.id, forced: false });
}

export async function handlePhase(args: { cwd: string; phase: string }) {
	if (typeof args.phase !== "string" || !args.phase.trim()) {
		throw new McpError(ErrorCode.InvalidParams, "phase is required");
	}
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);
	const phase = resolvePhase(state, args.phase);
	if (!phase) {
		throw new McpError(ErrorCode.InvalidParams, `Unknown phase: ${args.phase}`);
	}
	const prompt = await buildPhasePrompt(state, phase, true);
	return textResult(prompt, { phase: phase.id, forced: true });
}

export async function handleValidate(args: { cwd: string; phase?: string }) {
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);
	const validation = await validatePhaseOutput(state, args.phase?.trim() || undefined).catch((error) => {
		throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
	});
	const summary = buildValidationSummary(validation).join("\n");
	return textResult(summary, {
		phaseId: validation.phaseId,
		overall: validation.overall,
		exists: validation.exists,
		hasValidationBlock: validation.hasValidationBlock,
		primaryOutput: validation.primaryOutput,
		rows: validation.rows,
		gaps: validation.gaps,
		errors: validation.errors,
	});
}

export async function handleComplete(args: { cwd: string; phase?: string }) {
	const cwd = await validateCwd(args.cwd);
	const initialState = await requireWorkspace(cwd);
	const validation = await validatePhaseOutput(initialState, args.phase?.trim() || undefined).catch((error) => {
		throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
	});
	if (validation.overall === "FAIL" || validation.overall === "MISSING") {
		throw new McpError(
			ErrorCode.InvalidRequest,
			`Cannot complete ${validation.phaseId}: validation is ${validation.overall}.\n${buildValidationSummary(validation).join("\n")}`,
		);
	}

	const { updatedState, closeoutNotice } = await completeValidatedPhase(cwd, validation, "codecarto_complete").catch((error) => {
		throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
	});

	const lines = [
		`Marked ${validation.phaseId} complete (validation: ${validation.overall}).`,
		`Next phase: ${updatedState.status.current_phase}`,
	];
	if (closeoutNotice) lines.push(closeoutNotice);

	return textResult(lines.join("\n"), {
		completedPhase: validation.phaseId,
		validation: validation.overall,
		nextPhase: updatedState.status.current_phase,
		closeoutNotice,
	});
}

export async function handleSkill(args: { cwd: string; name: string }) {
	if (typeof args.name !== "string" || !args.name.trim()) {
		throw new McpError(ErrorCode.InvalidParams, "name is required");
	}
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);
	const nextPhase = getNextEligiblePhase(state);
	if (nextPhase) {
		throw new McpError(
			ErrorCode.InvalidRequest,
			`Cannot run skill: pipeline is not complete (next phase: ${nextPhase.id}). Finish the pipeline first.`,
		);
	}
	const skillFile = join(state.workspaceDir, "skills", args.name, "SKILL.md");
	if (!(await pathExists(skillFile))) {
		const available = await listSkillNames(state.workspaceDir);
		const hint = available.length > 0 ? ` Available: ${available.join(", ")}.` : " No skills installed.";
		throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${args.name}.${hint}`);
	}
	const prompt = await buildSkillPrompt(state, args.name);
	return textResult(prompt, { skill: args.name });
}

// ---------- library helpers ----------

async function resolveLibraryPath(args: { library_path?: unknown; cwd?: unknown }): Promise<string> {
	const explicit = typeof args.library_path === "string" && args.library_path.trim() !== ""
		? args.library_path.trim()
		: null;
	if (explicit) {
		if (!isAbsolute(explicit)) {
			throw new McpError(ErrorCode.InvalidParams, `library_path must be absolute, got: ${explicit}`);
		}
		return explicit;
	}
	if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
		const cwd = args.cwd.trim();
		if (!isAbsolute(cwd)) {
			throw new McpError(ErrorCode.InvalidParams, `cwd must be absolute, got: ${cwd}`);
		}
		// loadCodecartoConfig merges user-global under per-workspace and tolerates
		// a missing workspace file, so a single call covers both cases.
		const workspaceDir = join(cwd, ".codecarto");
		const config = await loadCodecartoConfig(workspaceDir);
		if (config.library.path) return config.library.path;
	}
	throw new McpError(
		ErrorCode.InvalidParams,
		"library_path is required (pass it explicitly, or pass cwd and configure library.path in ~/.codecarto/config.yaml or .codecarto/workflow/config.yaml).",
	);
}

function asStringArray(value: unknown, fieldName: string): string[] {
	if (!Array.isArray(value)) {
		throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be an array of strings`);
	}
	const out: string[] = [];
	for (const v of value) {
		if (typeof v !== "string") {
			throw new McpError(ErrorCode.InvalidParams, `${fieldName} must contain only strings`);
		}
		out.push(v);
	}
	return out;
}

const ALLOWED_REASONING: GenerationReasoning[] = ["high", "medium", "low", "default", "unknown"];

function buildGenerationFromArg(model_metadata: unknown): EntryGeneration {
	const surface: GenerationSurface = "mcp-server";
	const defaults: EntryGeneration = {
		surface,
		agent: "unknown",
		agent_version: "unknown",
		model: "unknown",
		model_vendor: "unknown",
		reasoning: "unknown",
		notes: "",
	};
	if (model_metadata === undefined || model_metadata === null) return defaults;
	if (typeof model_metadata !== "object") {
		throw new McpError(ErrorCode.InvalidParams, "model_metadata must be an object");
	}
	const m = model_metadata as Record<string, unknown>;
	const out = { ...defaults };
	if (typeof m.agent === "string") out.agent = m.agent;
	if (typeof m.agent_version === "string") out.agent_version = m.agent_version;
	if (typeof m.model === "string") out.model = m.model;
	if (typeof m.model_vendor === "string") out.model_vendor = m.model_vendor;
	if (typeof m.reasoning === "string" && (ALLOWED_REASONING as string[]).includes(m.reasoning)) {
		out.reasoning = m.reasoning as GenerationReasoning;
	}
	if (typeof m.notes === "string") out.notes = m.notes;
	return out;
}

async function readSpecArg(args: { spec?: unknown; spec_path?: unknown }): Promise<string> {
	if (typeof args.spec === "string" && args.spec.length > 0) return args.spec;
	if (typeof args.spec_path === "string" && args.spec_path.length > 0) {
		if (!isAbsolute(args.spec_path)) {
			throw new McpError(ErrorCode.InvalidParams, `spec_path must be absolute, got: ${args.spec_path}`);
		}
		if (!(await pathExists(args.spec_path))) {
			throw new McpError(ErrorCode.InvalidParams, `spec_path does not exist: ${args.spec_path}`);
		}
		return readFile(args.spec_path, "utf8");
	}
	throw new McpError(ErrorCode.InvalidParams, "Either spec (inline content) or spec_path (absolute file path) is required");
}

async function resolveDefaultsFromWorkspace(
	cwd: unknown,
	overrides: { pipeline?: unknown; namespace?: unknown },
): Promise<{ pipeline: string; namespace: string | null }> {
	let pipeline = typeof overrides.pipeline === "string" && overrides.pipeline.trim() !== ""
		? overrides.pipeline.trim()
		: "unknown";
	let namespace: string | null = typeof overrides.namespace === "string" && overrides.namespace.trim() !== ""
		? overrides.namespace.trim()
		: null;

	if (typeof cwd === "string" && cwd.trim() !== "" && isAbsolute(cwd)) {
		const workspaceDir = join(cwd.trim(), ".codecarto");
		if (await pathExists(workspaceDir)) {
			if (pipeline === "unknown") {
				try {
					const state = await getWorkspaceState(cwd.trim());
					if (state?.status.pipeline) pipeline = state.status.pipeline;
				} catch {
					// ignore — pipeline stays "unknown"
				}
			}
			if (!namespace) {
				const config = await loadCodecartoConfig(workspaceDir);
				if (config.library.namespace) namespace = config.library.namespace;
			}
		}
	}

	return { pipeline, namespace };
}

// ---------- library handlers ----------

export async function handlePublish(args: Record<string, unknown>) {
	const libraryPath = await resolveLibraryPath(args);
	const marker = await discoverLibrary(libraryPath);
	if (!marker) {
		throw new McpError(
			ErrorCode.InvalidParams,
			`No CodeCartographer library at ${libraryPath} (missing .codecarto-library marker). Create one before publishing.`,
		);
	}

	const spec = await readSpecArg(args);
	if (typeof args.source_repo !== "string" || args.source_repo.trim() === "") {
		throw new McpError(ErrorCode.InvalidParams, "source_repo is required");
	}
	if (typeof args.headline !== "string" || args.headline.trim() === "") {
		throw new McpError(ErrorCode.InvalidParams, "headline is required");
	}
	const tags = asStringArray(args.tags ?? [], "tags");
	const capabilities = asStringArray(args.capabilities ?? [], "capabilities");

	const sourceRepo = args.source_repo.trim();
	const slugInput = typeof args.slug === "string" && args.slug.trim() !== "" ? args.slug.trim() : null;
	const slug = slugInput ?? deriveSlug(sourceRepo);
	if (!isValidSlug(slug)) {
		throw new McpError(
			ErrorCode.InvalidParams,
			`Resolved slug "${slug}" is invalid. Provide an explicit slug (lowercase ASCII, starts with a letter, max 64 chars).`,
		);
	}

	const defaults = await resolveDefaultsFromWorkspace(args.cwd, {
		pipeline: args.pipeline,
		namespace: args.namespace,
	});

	const namespace = marker.namespaced
		? (typeof args.namespace === "string" && args.namespace.trim() !== ""
			? args.namespace.trim()
			: defaults.namespace ?? undefined)
		: undefined;

	if (marker.namespaced && !namespace) {
		throw new McpError(
			ErrorCode.InvalidParams,
			"Library is namespaced — namespace argument is required (or set library.namespace in config.yaml).",
		);
	}

	const generation = buildGenerationFromArg(args.model_metadata);
	const confidentiality: LibraryVisibility | undefined =
		args.confidentiality === "internal" || args.confidentiality === "shared" || args.confidentiality === "public"
			? args.confidentiality
			: undefined;

	const analyzedAt = typeof args.analyzed_at === "string" && args.analyzed_at !== ""
		? args.analyzed_at
		: new Date().toISOString();

	const result = await publishEntry(
		libraryPath,
		spec,
		{
			slug,
			namespace: namespace ?? undefined,
			source_repo: sourceRepo,
			source_commit: typeof args.source_commit === "string" ? args.source_commit : undefined,
			source_branch: typeof args.source_branch === "string" ? args.source_branch : undefined,
			source_dirty: typeof args.source_dirty === "boolean" ? args.source_dirty : undefined,
			analyzed_at: analyzedAt,
			pipeline: defaults.pipeline,
			codecarto_version: PACKAGE_VERSION,
			headline: args.headline.trim(),
			tags,
			capabilities,
			confidentiality,
			generation,
		},
		{ forceNewVersion: args.force_new_version === true },
	);

	const lines = [
		`Published ${result.namespace ? `${result.namespace}/` : ""}${result.slug} v${result.version} to ${libraryPath}`,
		result.isNewVersion ? `New version: v${result.version}` : `Metadata-only update (content hash matched v${result.version}).`,
		`Entry directory: ${result.versionDir}`,
	];
	return textResult(lines.join("\n"), {
		libraryPath,
		slug: result.slug,
		namespace: result.namespace ?? null,
		version: result.version,
		isNewVersion: result.isNewVersion,
		versionDir: result.versionDir,
	});
}

export async function handleLibraryList(args: Record<string, unknown>) {
	const libraryPath = await resolveLibraryPath(args);
	const marker = await discoverLibrary(libraryPath);
	if (!marker) {
		throw new McpError(
			ErrorCode.InvalidParams,
			`No CodeCartographer library at ${libraryPath} (missing .codecarto-library marker).`,
		);
	}

	const filter: { namespace?: string; tag?: string; slug?: string; source_repo?: string } = {};
	if (typeof args.namespace === "string" && args.namespace !== "") filter.namespace = args.namespace;
	if (typeof args.tag === "string" && args.tag !== "") filter.tag = args.tag;
	if (typeof args.slug === "string" && args.slug !== "") filter.slug = args.slug;
	if (typeof args.source_repo === "string" && args.source_repo !== "") filter.source_repo = args.source_repo;

	const entries = await listEntries(libraryPath, filter);
	const summary = entries.length === 0
		? `No entries match the filter in ${libraryPath}.`
		: [
			`${entries.length} ${entries.length === 1 ? "entry" : "entries"} in ${libraryPath}:`,
			...entries.map((e: LibraryIndexEntry) => {
				const ns = e.namespace ? `${e.namespace}/` : "";
				const tags = e.tags.length > 0 ? ` [${e.tags.slice(0, 4).join(", ")}${e.tags.length > 4 ? ", ..." : ""}]` : "";
				return `  ${ns}${e.slug} v${e.latest_version} — ${e.headline}${tags}`;
			}),
		].join("\n");

	return textResult(summary, {
		libraryPath,
		libraryName: marker.name,
		namespaced: marker.namespaced,
		count: entries.length,
		entries,
	});
}

export async function handleLibraryReindex(args: Record<string, unknown>) {
	const libraryPath = await resolveLibraryPath(args);
	const marker = await discoverLibrary(libraryPath);
	if (!marker) {
		throw new McpError(
			ErrorCode.InvalidParams,
			`No CodeCartographer library at ${libraryPath} (missing .codecarto-library marker).`,
		);
	}
	const index = await libraryReindex(libraryPath);
	const namespaces = index.namespaces.length > 0 ? index.namespaces.join(", ") : "(none)";
	return textResult(
		`Reindexed ${libraryPath}: ${index.entry_count} ${index.entry_count === 1 ? "entry" : "entries"} across namespaces [${namespaces}].`,
		{
			libraryPath,
			libraryName: index.library_name,
			entry_count: index.entry_count,
			namespaces: index.namespaces,
		},
	);
}

// ---------- tool registry ----------

const TOOLS = [
	{
		name: "codecarto_init",
		description:
			"Initialize a CodeCartographer workspace (.codecarto/) in a target repository. Copies the packaged framework template and writes a fresh status.yaml for the chosen pipeline. Errors if .codecarto/ already exists unless force is true.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				pipeline: {
					type: "string",
					description: `Pipeline alias or workflow/*.yaml path. Defaults to the framework's default pipeline.`,
				},
				force: {
					type: "boolean",
					description: "Overwrite an existing .codecarto/ directory if present (default false).",
				},
			},
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_status",
		description: "Show the current CodeCartographer phase, active pipeline, and progress for a target repository.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string", description: "Absolute path to the target repository." } },
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_next",
		description:
			"Return the prompt text for the next eligible CodeCartographer phase. The host should feed this prompt back to the agent or display it to the user.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string", description: "Absolute path to the target repository." } },
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_phase",
		description:
			"Return the prompt text for a specific CodeCartographer phase, even if it is not the next eligible phase. Used to revisit a phase or to bypass DAG order intentionally.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				phase: { type: "string", description: "Phase id from the active pipeline." },
			},
			required: ["cwd", "phase"],
		},
	},
	{
		name: "codecarto_validate",
		description:
			"Validate a phase's primary output against the validation block in the produced markdown. Returns overall PASS/PASS WITH GAPS/FAIL/MISSING plus the parsed criteria rows. If phase is omitted, validates the next eligible phase.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				phase: { type: "string", description: "Phase id (optional)." },
			},
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_complete",
		description:
			"Mark a phase complete. Requires the phase output's validation to be PASS or PASS WITH GAPS. Atomically updates status.yaml under a file lock, appends to THREAD_LOG.md, and creates a closeout stub from the template if one does not yet exist. If phase is omitted, completes the next eligible phase.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				phase: { type: "string", description: "Phase id (optional)." },
			},
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_skill",
		description:
			"Return the prompt text for a post-pipeline skill (only callable after all phases are complete). Use codecarto_status to confirm completion first.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				name: { type: "string", description: "Skill name (a directory under .codecarto/skills/)." },
			},
			required: ["cwd", "name"],
		},
	},
	{
		name: "codecarto_publish",
		description:
			"Publish a reimplementation-spec to a CodeCartographer library. Identified by library_path (absolute) or cwd's config.yaml. Content-hash idempotent — re-publishing identical spec bytes updates metadata in place rather than bumping the version. Required: source_repo, headline, and either spec (inline) or spec_path (absolute file). Slug derives from source_repo if not provided. If the library is namespaced, namespace is required (or pass cwd to inherit from config). Generation context (agent, model, vendor, reasoning) is passed via model_metadata so the host can record provenance; omitted fields default to 'unknown'.",
		inputSchema: {
			type: "object",
			properties: {
				library_path: { type: "string", description: "Absolute path to the library directory." },
				cwd: { type: "string", description: "Absolute path to a workspace. Used to read defaults from config.yaml and status.yaml." },
				spec: { type: "string", description: "Inline spec markdown content (mutually exclusive with spec_path)." },
				spec_path: { type: "string", description: "Absolute path to a file containing the spec markdown (mutually exclusive with spec)." },
				slug: { type: "string", description: "Entry slug. Derived from source_repo if omitted." },
				namespace: { type: "string", description: "Namespace under entries/. Required for namespaced libraries." },
				source_repo: { type: "string", description: "URL or path to the analyzed repository." },
				source_commit: { type: "string" },
				source_branch: { type: "string" },
				source_dirty: { type: "boolean" },
				analyzed_at: { type: "string", description: "ISO 8601 UTC timestamp. Defaults to now." },
				pipeline: { type: "string", description: "Pipeline used. Inherited from cwd's status.yaml if available." },
				headline: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				capabilities: { type: "array", items: { type: "string" } },
				confidentiality: { type: "string", enum: ["internal", "shared", "public"] },
				model_metadata: {
					type: "object",
					properties: {
						agent: { type: "string" },
						agent_version: { type: "string" },
						model: { type: "string" },
						model_vendor: { type: "string" },
						reasoning: { type: "string", enum: ["high", "medium", "low", "default", "unknown"] },
						notes: { type: "string" },
					},
				},
				force_new_version: { type: "boolean" },
			},
			required: ["source_repo", "headline"],
		},
	},
	{
		name: "codecarto_library_list",
		description:
			"List entries in a CodeCartographer library, optionally filtered by namespace, tag, slug, or source_repo. The library is identified by library_path (absolute) or by cwd's config.yaml.",
		inputSchema: {
			type: "object",
			properties: {
				library_path: { type: "string" },
				cwd: { type: "string" },
				namespace: { type: "string" },
				tag: { type: "string" },
				slug: { type: "string" },
				source_repo: { type: "string" },
			},
		},
	},
	{
		name: "codecarto_library_reindex",
		description:
			"Regenerate index.yaml and INDEX.md for a CodeCartographer library from filesystem state. Use after manual edits or to resolve a git merge conflict on index.yaml.",
		inputSchema: {
			type: "object",
			properties: {
				library_path: { type: "string" },
				cwd: { type: "string" },
			},
		},
	},
] as const;

const HANDLERS: Record<string, (args: any) => Promise<unknown>> = {
	codecarto_init: handleInit,
	codecarto_status: handleStatus,
	codecarto_next: handleNext,
	codecarto_phase: handlePhase,
	codecarto_validate: handleValidate,
	codecarto_complete: handleComplete,
	codecarto_skill: handleSkill,
	codecarto_publish: handlePublish,
	codecarto_library_list: handleLibraryList,
	codecarto_library_reindex: handleLibraryReindex,
};

// ---------- server bootstrap ----------

export function buildServer() {
	const server = new Server(
		{ name: "codecartographer", version: "0.2.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as typeof TOOLS[number][] }));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const handler = HANDLERS[request.params.name];
		if (!handler) {
			throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
		}
		try {
			return (await handler(request.params.arguments ?? {})) as Awaited<ReturnType<typeof handleStatus>>;
		} catch (error) {
			if (error instanceof McpError) throw error;
			throw new McpError(
				ErrorCode.InternalError,
				error instanceof Error ? error.message : String(error),
			);
		}
	});

	return server;
}

export async function startStdioServer() {
	const server = buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
