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
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import {
	buildPhasePrompt,
	buildSkillPrompt,
	buildValidationSummary,
	BROADSIDE_DIR,
	broadsideDirFor,
	BROADSIDE_LENS_IDS,
	type BroadsideLensId,
	canonicalPath,
	copyPackagedWorkspace,
	collectResultText,
	completeValidatedPhase,
	computePerPhaseTotals,
	computeTotals,
	createEmptyStatus,

	DEFAULT_PIPELINE_PATH,
	deriveSlug,
	discoverLibrary,

	describeScaffoldStaleness,
	type EntryGeneration,
	estimateSubmitText,
	type GuideDocument,
	type GenerationReasoning,
	type GenerationSurface,
	getLens,
	getNextEligiblePhase,
	getPipelineLabel,
	getWorkspaceState,
	isValidSlug,
	isWithinPathResolved,
	type LibraryIndexEntry,
	type LibraryVisibility,
	listBatchModels,
	listEntries,
	listGuideTopics,
	loadBroadsideConfig,
	modelsText,
	readGuide,
	listSkillNames,
	loadCodecartoConfig,
	loadUsage,
	loadYamlFile,
	normalizeForComparison,

	PACKAGE_VERSION,
	packagedWorkspaceDir,
	pathExists,
	PhasePreflightError,
	PIPELINE_ALIASES,
	type PipelineFile,
	publishEntry,
	reindex as libraryReindex,
	refreshScaffold,
	resolvePhase,
	resolvePipelineChoice,
	runBroadsideCollect,
	runBroadsideStatus,
	runBroadsideSubmit,
	seedOrchestratorFiles,
	type StatusFile,
	statusText,
	stringifySimpleYaml,
	switchPipeline,
	validatePhaseOutput,
	type WorkspaceState,
	writeLibraryConfig,
} from "../core/index.ts";
import { applyAmendment } from "../core/amendment.ts";
import { appendUsageRun } from "../core/usage.ts";
import { initLibrary } from "../core/library.ts";
import { loadUserConfig, resolveUserConfigPath } from "../core/orchestrator-config.ts";
import { writeDashboard } from "../extensions/codecarto/dashboard-writer.ts";

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

// MCP clients may read structuredContent in preference to content when both are
// present. The tools whose payload IS prose — the phase prompts, the guide —
// therefore have to expose it structurally too, or such a client receives labels
// and no payload: codecarto_next returned no phase prompt at all (issue #94).
// Carrying the rendered text under a stable key keeps both client styles whole,
// and no tool declares an outputSchema that this could violate.
function textResult(text: string, structured?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: { ...structured, text },
	};
}

async function buildMcpPhasePrompt(
	state: WorkspaceState,
	phase: PipelineFile["phases"][number],
	forced: boolean,
): Promise<string> {
	try {
		return await buildPhasePrompt(state, phase, forced);
	} catch (error) {
		if (error instanceof PhasePreflightError) {
			throw new McpError(ErrorCode.InvalidRequest, error.message);
		}
		throw error;
	}
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

	// Broad-Side (batch reconnaissance) creates .codecarto/broadside/ on any
	// repo, workspace or not. A .codecarto/ holding only that directory is not
	// an existing workspace — init must proceed and merge the template into it
	// rather than demanding force and a backup of pure scout state.
	let broadsideOnly = false;
	if (targetExists && !sameWorkspace) {
		const entries = (await readdir(targetWorkspaceDir)).filter((entry) => entry !== BROADSIDE_DIR);
		broadsideOnly = entries.length === 0 && (await pathExists(join(targetWorkspaceDir, BROADSIDE_DIR)));
	}

	if (targetExists && !sameWorkspace && !broadsideOnly) {
		if (!args.force) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				`A .codecarto/ directory already exists at ${targetWorkspaceDir}. Pass force: true to back it up and reinitialize. Warning: this moves all existing findings, handoffs, usage data, closeouts, and phase progress to a .codecarto-backup-TIMESTAMP/ directory.`,
			);
		}
		const backupDir = join(cwd, `.codecarto-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
		await rename(targetWorkspaceDir, backupDir);
	}

	if (!(await pathExists(targetWorkspaceDir))) {
		await mkdir(cwd, { recursive: true });
		await copyPackagedWorkspace(targetWorkspaceDir);
	} else if (broadsideOnly) {
		// Merge the template into the scout-only .codecarto/, preserving the
		// broadside state and results already on disk.
		await copyPackagedWorkspace(targetWorkspaceDir);
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

	// Orchestration is on by default (issue #97/#98): the driving chat holds the
	// duties, so the files those duties maintain exist from the first phase.
	const seeded = await seedOrchestratorFiles(targetWorkspaceDir);

	const label = getPipelineLabel(selectedPipelinePath);
	const initLines = [
		`Initialized CodeCartographer workspace at ${targetWorkspaceDir}.`,
		`Pipeline: ${label} (${selectedPipelinePath})`,
		`First phase: ${normalizedStatus.current_phase}`,
	];
	if (seeded.length > 0) initLines.push(`Seeded orchestrator files: ${seeded.join(", ")} (the driving chat holds the orchestrator duties — see GUIDE.md §Roles).`);
	return textResult(
		initLines.join("\n"),
		{
			workspaceDir: targetWorkspaceDir,
			pipeline: selectedPipelinePath,
			pipelineLabel: label,
			firstPhase: normalizedStatus.current_phase,
			seededOrchestratorFiles: seeded,
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
	const scaffoldNotice = describeScaffoldStaleness(state);
	const summaryLines = [
		`Phase: ${currentPhase}`,
		`Pipeline state: ${currentPhase === "complete" ? "complete" : "in progress"}`,
		`Pipeline: ${getPipelineLabel(state.status.pipeline)} (${state.status.pipeline})`,
		`Progress: ${completed}/${state.pipeline.phase_order.length} complete`,
		`Open questions (terminal unresolved): ${terminalOpenQuestions}`,
		`Carry-forward (pipeline phases): ${totalCarryForward}`,
		`Post-pipeline work: ${postPipelinePending} pending`,
		// Render every stored action: the terminal list routes to several
		// post-pipeline surfaces (issue #114), and a text-reading client that
		// only ever sees actions[0] loses exactly the routing it exists for.
		...(state.status.next_actions.length > 0
			? state.status.next_actions.map((action, index) => `${index === 0 ? "Next: " : "      "}${action}`)
			: [`Next: ${nextPhase ? `Begin ${nextPhase.id}` : "All phases complete."}`]),
	];
	if (scaffoldNotice) summaryLines.push(`Scaffold: ${scaffoldNotice}`);
	const summary = summaryLines.join("\n");
	return textResult(summary, {
		...(scaffoldNotice ? { scaffoldNotice } : {}),
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

export async function handleSwitchPipeline(args: { cwd: string; pipeline: string }) {
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);

	const pipelineChoice = resolvePipelineChoice(args.pipeline);
	if (!pipelineChoice) {
		throw new McpError(ErrorCode.InvalidRequest, `Unknown pipeline: ${args.pipeline}`);
	}

	if (state.status.pipeline === pipelineChoice) {
		return textResult(`Already on pipeline: ${getPipelineLabel(pipelineChoice)}`, { pipeline: getPipelineLabel(pipelineChoice) });
	}

	const result = await switchPipeline(cwd, pipelineChoice);
	const lines = [`Switched pipeline: ${getPipelineLabel(pipelineChoice)}`];
	if (result.carried.length > 0) lines.push(`Phases preserved (completed): ${result.carried.join(", ")}`);
	if (result.newPhases.length > 0) lines.push(`New phases: ${result.newPhases.join(", ")}`);
	if (result.dropped.length > 0) lines.push(`Phases not in new pipeline: ${result.dropped.join(", ")} (findings remain on disk)`);

	return textResult(lines.join("\n"), {
		pipeline: getPipelineLabel(pipelineChoice),
		carried: result.carried,
		newPhases: result.newPhases,
		dropped: result.dropped,
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
	const prompt = await buildMcpPhasePrompt(state, phase, false);
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
	const prompt = await buildMcpPhasePrompt(state, phase, true);
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
		secondaryOutputs: validation.secondaryOutputs ?? [],
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

	const { updatedState, closeoutNotice, orchestratorCheckpoint } = await completeValidatedPhase(cwd, validation, "codecarto_complete").catch((error) => {
		throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
	});

	// Record the run in the usage log (issue #100). MCP hosts execute phases in
	// their own context, so tokens and activity are unknowable here — this is a
	// completion receipt, marked recorded_by so totals can tell it apart from
	// the Pi runner's token-bearing entries. Recording lives in this handler,
	// not core completion, because Pi-driven runs already record with real
	// telemetry and must not double-count.
	try {
		await appendUsageRun(updatedState.workspaceDir, {
			timestamp: new Date().toISOString(),
			phase: validation.phaseId,
			status: "completed",
			turn_count: 0,
			tool_uses: 0,
			duration_ms: 0,
			tokens: { input: 0, output: 0, cache_write: 0 },
			recorded_by: "mcp-complete",
		});
	} catch {
		// Usage is best-effort telemetry: the phase completed and canonical
		// state is already written, so a usage-log write failure must not fail
		// the completion result. Nothing else can act on the error here.
	}

	// Dashboard freshness is a completion side effect (issue #112): the counts
	// it renders change exactly here, and a stale dashboard misreports them
	// confidently. writeDashboard never throws; its boolean says whether a
	// fresh render actually landed, so the result only claims what happened.
	const dashboardPath = (await writeDashboard(cwd, PACKAGE_VERSION)) ? ".codecarto/dashboard.html" : undefined;

	const lines = [
		`Marked ${validation.phaseId} complete (validation: ${validation.overall}).`,
		`Next phase: ${updatedState.status.current_phase}`,
	];
	if (closeoutNotice) lines.push(closeoutNotice);
	if (orchestratorCheckpoint) lines.push(orchestratorCheckpoint);
	if (dashboardPath) lines.push(`Dashboard refreshed: ${dashboardPath}`);

	return textResult(lines.join("\n"), {
		completedPhase: validation.phaseId,
		validation: validation.overall,
		nextPhase: updatedState.status.current_phase,
		closeoutNotice,
		orchestratorCheckpoint,
		dashboardPath,
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

// `allowedRoots` is deliberately required and must be non-empty whenever
// spec_path is used. It previously defaulted to `[]`, which made containment
// opt-in: a caller that omitted it would read any absolute path the client
// asked for, silently reopening the arbitrary-file-read class of bug fixed in
// v0.12.11. Containment is now the default posture and an empty root set is a
// programming error rather than a bypass.
export async function readSpecArg(
	args: { spec?: unknown; spec_path?: unknown; cwd?: unknown },
	allowedRoots: string[],
): Promise<string> {
	if (typeof args.spec === "string" && args.spec.length > 0) return args.spec;
	if (typeof args.spec_path === "string" && args.spec_path.length > 0) {
		if (!isAbsolute(args.spec_path)) {
			throw new McpError(ErrorCode.InvalidParams, `spec_path must be absolute, got: ${args.spec_path}`);
		}
		if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
			throw new McpError(
				ErrorCode.InternalError,
				"refusing to read spec_path without a containment root — this is a caller bug, not a client error",
			);
		}
		if (!(await pathExists(args.spec_path))) {
			throw new McpError(ErrorCode.InvalidParams, `spec_path does not exist: ${args.spec_path}`);
		}
		// Enforce path containment: spec_path must be within an allowed root
		// (cwd's .codecarto/ or the configured library path) to prevent
		// arbitrary file reads.
		const resolvedSpecPath = await canonicalPath(args.spec_path);
		const withinAllowed = await Promise.all(
			allowedRoots.map((root) => isWithinPathResolved(resolvedSpecPath, root)),
		);
		if (!withinAllowed.some((result) => result)) {
			throw new McpError(
				ErrorCode.InvalidParams,
				`spec_path must be within the workspace (.codecarto/) or the configured library path. Got: ${args.spec_path}`,
			);
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

	// Build allowed roots for spec_path containment: workspace .codecarto/ and library path
	const allowedRoots: string[] = [libraryPath];
	if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
		allowedRoots.push(join(args.cwd.trim(), ".codecarto"));
	}

	const spec = await readSpecArg(args, allowedRoots);
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
		{
			forceNewVersion: args.force_new_version === true,
			allowSourceRepoChange: args.allow_source_repo_change === true,
		},
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

export async function handleLibraryInit(args: { library_path: string; name?: string; namespace?: string; cwd?: string }) {
	if (!args.library_path || typeof args.library_path !== "string") {
		throw new McpError(ErrorCode.InvalidParams, "library_path is required.");
	}

	const libraryPath = args.library_path;
	const namespaced = !!args.namespace;

	const result = await initLibrary(libraryPath, {
		name: args.name,
		namespaced,
	});

	// Write config to user-global location
	const configPath = resolveUserConfigPath();
	await writeLibraryConfig(configPath, libraryPath, args.namespace ?? null);

	const msg = result.alreadyExisted
		? `Library already exists at ${libraryPath} (marker preserved). Config written to ${configPath}.`
		: `Created library at ${libraryPath} with marker "${result.marker.name}". Config written to ${configPath}.`;

	return textResult(msg, {
		libraryPath,
		markerName: result.marker.name,
		namespaced: result.marker.namespaced,
		alreadyExisted: result.alreadyExisted,
		configPath,
	});
}

export async function handleVision(args: { cwd: string; raw_text: string }) {
	const cwd = await validateCwd(args.cwd);
	const workspaceDir = join(cwd, ".codecarto");
	const interviewPath = join(workspaceDir, "findings", "vision-capture", "INTERVIEW.md");
	const visionPath = join(workspaceDir, "inputs", "vision.md");

	if (!(await pathExists(interviewPath))) {
		throw new McpError(ErrorCode.InvalidRequest, "Vision interview skill not found. Run codecarto_init with the synthesis pipeline first.");
	}

	const interviewSkill = await readFile(interviewPath, "utf8");
	const prompt = [
		"Read the interview skill below and use it to structure the user's raw product text into a vision brief.",
		"",
		interviewSkill,
		"",
		"The user's raw product text is:",
		"",
		args.raw_text,
		"",
		`Write the synthesized brief to ${visionPath}.`,
	].join("\n");

	return textResult(prompt, {
		cwd,
		visionPath,
		interviewPath,
		note: "Feed this prompt to your agent. The agent will write the structured vision brief to inputs/vision.md.",
	});
}

export async function handleConfig(args: { cwd?: string }) {
	const config = args.cwd
		? await loadCodecartoConfig(join(args.cwd, ".codecarto"))
		: await loadUserConfig();

	const userConfigPath = resolveUserConfigPath();
	const workspaceConfigPath = args.cwd ? join(args.cwd, ".codecarto", "workflow", "config.yaml") : null;

	let markerStatus = "not configured";
	if (config.library.path) {
		const marker = await discoverLibrary(config.library.path);
		markerStatus = marker ? `found ("${marker.name}", namespaced: ${marker.namespaced})` : "MISSING";
	}

	return textResult(
		[
			"Effective CodeCartographer configuration:",
			`  library.path: ${config.library.path ?? "(not set)"}`,
			`  library.namespace: ${config.library.namespace ?? "(not set)"}`,
			`  library.publish_confirm: ${config.library.publish_confirm}`,
			`  orchestrator.llm_steer_next_phase: ${config.orchestrator.llm_steer_next_phase}`,
			`  Library marker: ${markerStatus}`,
			`  User-global config: ${userConfigPath}`,
			`  Workspace config: ${workspaceConfigPath ?? "(no cwd provided)"}`,
		].join("\n"),
		{
			libraryPath: config.library.path,
			libraryNamespace: config.library.namespace,
			publishConfirm: config.library.publish_confirm,
			llmSteerNextPhase: config.orchestrator.llm_steer_next_phase,
			userConfigPath,
			workspaceConfigPath,
		},
	);
}

// ---------- MCP parity handlers: open, usage, dashboard, list_skills ----------

export async function handleOpen(args: { cwd: string }) {
	const cwd = await validateCwd(args.cwd);
	const workspaceDir = join(cwd, ".codecarto");
	if (!(await pathExists(join(workspaceDir, "workflow", "status.yaml")))) {
		throw new McpError(ErrorCode.InvalidRequest, "No existing CodeCartographer workspace found. Run codecarto_init first.");
	}
	const state = await requireWorkspace(cwd);
	const nextPhase = getNextEligiblePhase(state)?.id ?? "complete";
	return textResult(
		`Opened existing CodeCartographer workspace: ${getPipelineLabel(state.status.pipeline)}. Current phase: ${nextPhase}.`,
		{ pipeline: getPipelineLabel(state.status.pipeline), currentPhase: nextPhase },
	);
}

export async function handleUsage(args: { cwd: string }) {
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);
	const usage = await loadUsage(state.workspaceDir);
	if (usage.runs.length === 0) {
		return textResult("No phase runs recorded yet.", { runs: 0 });
	}
	const totals = computeTotals(usage);
	const perPhase = computePerPhaseTotals(usage);
	const receiptRuns = usage.runs.filter((run) => run.recorded_by === "mcp-complete").length;
	const lines: string[] = [
		`Total runs: ${totals.runs}`,
		`Total tokens: ${totals.tokens.input} in / ${totals.tokens.output} out / ${totals.tokens.cache_write} cache-write`,
		`Total duration: ${totals.duration_ms}ms / ${totals.tool_uses} tool uses`,
	];
	if (receiptRuns > 0) {
		lines.push(`Note: ${receiptRuns} run(s) recorded via codecarto_complete carry no token or activity data (MCP hosts execute phases in their own context) — zeros above are unknowns, not free runs.`);
	}
	lines.push("", "Per-phase totals:");
	for (const [phaseId, t] of perPhase) {
		lines.push(`  ${phaseId}: ${t.runs} run(s), ${t.tokens.input + t.tokens.output} tokens, ${t.tool_uses} tool uses, ${t.duration_ms}ms`);
	}
	return textResult(lines.join("\n"), {
		runs: totals.runs,
		receiptRuns,
		tokens: totals.tokens,
		toolUses: totals.tool_uses,
		durationMs: totals.duration_ms,
		perPhase: Object.fromEntries(perPhase),
	});
}

export async function handleDashboard(args: { cwd: string }) {
	const cwd = await validateCwd(args.cwd);
	await requireWorkspace(cwd);
	if (!(await writeDashboard(cwd, PACKAGE_VERSION))) {
		throw new McpError(ErrorCode.InvalidRequest, "Dashboard render failed: the workspace state could not be gathered or .codecarto/dashboard.html is not writable.");
	}
	return textResult("Dashboard regenerated: .codecarto/dashboard.html", { path: ".codecarto/dashboard.html" });
}

export async function handleListSkills(args: { cwd: string }) {
	const cwd = await validateCwd(args.cwd);
	const state = await requireWorkspace(cwd);
	const skills = await listSkillNames(state.workspaceDir);
	const lines = skills.length > 0
		? [`Available skills (${skills.length}):`, ...skills.map((s) => `  - ${s}`)]
		: ["No skills installed."];
	return textResult(lines.join("\n"), { skills });
}

export async function handleRefreshScaffold(args: { cwd: string }) {
	const cwd = await validateCwd(args.cwd);
	await requireWorkspace(cwd);
	const result = await refreshScaffold(cwd).catch((error) => {
		throw new McpError(ErrorCode.InvalidRequest, error instanceof Error ? error.message : String(error));
	});
	const shown = result.written.slice(0, 20);
	const lines = [
		`Refreshed ${result.written.length} framework-owned file(s) from the packaged template (${result.scaffoldVersionBefore ?? "unversioned"} → ${result.scaffoldVersionAfter}).`,
		"Project state, user config, findings outputs, scratch, closeouts, and orchestrator files were not touched.",
		...shown.map((path) => `  - .codecarto/${path}`),
	];
	if (result.written.length > shown.length) lines.push(`  … +${result.written.length - shown.length} more`);

	return textResult(lines.join("\n"), {
		written: result.written,
		scaffoldVersionBefore: result.scaffoldVersionBefore,
		scaffoldVersionAfter: result.scaffoldVersionAfter,
	});
}

export async function handleAmend(args: { cwd: string; name: string }) {
	if (typeof args.name !== "string" || !args.name.trim()) {
		throw new McpError(ErrorCode.InvalidParams, "name is required (the amendment file's slug under .codecarto/scratch/amendments/)");
	}
	const cwd = await validateCwd(args.cwd);
	await requireWorkspace(cwd);
	const { applied, closeoutNotice } = await applyAmendment(cwd, args.name).catch((error) => {
		throw new McpError(ErrorCode.InvalidRequest, error instanceof Error ? error.message : String(error));
	});

	// An amendment exists precisely to change the numbers the dashboard shows
	// (issue #112); refresh it, reporting only a render that actually landed.
	const dashboardPath = (await writeDashboard(cwd, PACKAGE_VERSION)) ? ".codecarto/dashboard.html" : undefined;

	const lines = [
		`Amendment applied.`,
		`Open questions closed: ${applied.openQuestionsClosed.length > 0 ? applied.openQuestionsClosed.join(", ") : "none"}`,
		`Post-pipeline items closed: ${applied.postPipelineClosed.length > 0 ? applied.postPipelineClosed.join(", ") : "none"}`,
	];
	if (applied.unknownIds.length > 0) lines.push(`Ids that matched nothing (already closed or unknown): ${applied.unknownIds.join(", ")}`);
	lines.push(closeoutNotice);
	if (dashboardPath) lines.push(`Dashboard refreshed: ${dashboardPath}`);

	return textResult(lines.join("\n"), {
		openQuestionsClosed: applied.openQuestionsClosed,
		postPipelineClosed: applied.postPipelineClosed,
		unknownIds: applied.unknownIds,
		closeoutNotice,
		dashboardPath,
	});
}

// ---------- broadside (batch reconnaissance) ----------

function resolveBroadsideApiKey(explicit: string | undefined, config: { apiKey: string }): string {
	if (explicit && explicit.trim()) return explicit.trim();
	const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	if (config.apiKey) return config.apiKey;
	throw new McpError(
		ErrorCode.InvalidParams,
		"No OpenRouter API key found. Pass api_key, set the OPENROUTER_API_KEY environment variable, or add api_key to .codecarto/broadside/config.yaml.",
	);
}

export async function handleBroadside(args: {
	cwd: string;
	action: "submit" | "collect" | "status" | "models";
	lenses?: string[];
	api_key?: string;
	wait_seconds?: number;
	include_synthesis?: boolean;
	include_triage?: boolean;
	retry_truncated?: boolean;
	max_cost?: number;
	force?: boolean;
	include_benchmarks?: boolean;
}) {
	const cwd = await validateCwd(args.cwd);
	const action = args.action ?? "submit";
	if (!["submit", "collect", "status", "models"].includes(action)) {
		throw new McpError(ErrorCode.InvalidParams, `Unknown action: ${action}. Valid actions: submit, collect, status, models.`);
	}

	const config = await loadBroadsideConfig(broadsideDirFor(cwd));

	if (action === "status") {
		const { state } = await runBroadsideStatus(cwd);
		return textResult(statusText(state), { state });
	}

	const apiKey = resolveBroadsideApiKey(args.api_key, config);
	const waitMs = typeof args.wait_seconds === "number" && args.wait_seconds > 0 ? args.wait_seconds * 1000 : undefined;

	if (action === "models") {
		const { entries, benchmarks } = await listBatchModels(broadsideDirFor(cwd), config, apiKey, {
			includeBenchmarks: args.include_benchmarks === true,
		}).catch((error) => {
			throw new McpError(ErrorCode.InvalidRequest, error instanceof Error ? error.message : String(error));
		});
		return textResult(modelsText(entries, { benchmarks, defaultModel: config.model }), {
			models: entries,
			defaultModel: config.model,
			benchmarkMeta: benchmarks?.meta ?? null,
		});
	}

	if (action === "submit") {
		let lenses: BroadsideLensId[];
		if (args.lenses && args.lenses.length > 0) {
			const unknown = args.lenses.filter((l) => !BROADSIDE_LENS_IDS.includes(l as BroadsideLensId));
			if (unknown.length > 0) {
				throw new McpError(ErrorCode.InvalidParams, `Unknown lens(es): ${unknown.join(", ")}. Valid: ${BROADSIDE_LENS_IDS.join(", ")}`);
			}
			lenses = args.lenses as BroadsideLensId[];
		} else {
			lenses = config.defaultLenses;
		}

		const maxCost = typeof args.max_cost === "number" && args.max_cost > 0 ? args.max_cost : config.maxCost;

		const result = await runBroadsideSubmit(cwd, apiKey, {
			lenses,
			model: config.model,
			maxCost,
			force: args.force === true,
		}).catch((error) => {
			throw new McpError(ErrorCode.InvalidRequest, error instanceof Error ? error.message : String(error));
		});

		const lines = [estimateSubmitText(result, lenses.map(getLens))];
		if (waitMs) {
			lines.push("", "Waiting for batches to complete...");
			const collect = await runBroadsideCollect(cwd, apiKey, {
				waitMs,
				includeSynthesis: args.include_synthesis !== false,
				includeTriage: args.include_triage !== false,
				retryTruncated: args.retry_truncated !== false,
				onStatus: (lensId, status, counts) =>
					lines.push(`  ${lensId}: ${status} (${counts.completed ?? 0}/${counts.total ?? "?"})`),
			});
			lines.push("", collectResultText(collect));
		}
		return textResult(lines.join("\n"), {
			runId: result.runId,
			outputDir: result.outputDir,
			batches: result.batches,
			estimatedTotalCost: result.estimatedTotalCost,
			pricing: result.pricing,
			maxCost: result.maxCost,
		});
	}

	// action === "collect"
	const collect = await runBroadsideCollect(cwd, apiKey, {
		waitMs,
		includeSynthesis: args.include_synthesis !== false,
		includeTriage: args.include_triage !== false,
		retryTruncated: args.retry_truncated !== false,
	}).catch((error) => {
		throw new McpError(ErrorCode.InvalidRequest, error instanceof Error ? error.message : String(error));
	});
	return textResult(collectResultText(collect), {
		runId: collect.runId,
		status: collect.status,
		totalCost: collect.totalCost,
		resultCount: collect.resultCount,
		truncatedCount: collect.truncatedCount,
		retriedCount: collect.retriedCount,
		lensOutcomes: collect.lensOutcomes,
		synthesis: collect.synthesis,
		triage: collect.triage,
		topFindings: collect.topFindings,
		topTriageItems: collect.topTriageItems,
	});
}

// ---------- tool registry ----------

const TOOLS = [
	{
		name: "codecarto_init",
		description:
			"Initialize a CodeCartographer workspace (.codecarto/) in a target repository. Copies the packaged framework template and writes a fresh status.yaml for the chosen pipeline. If .codecarto/ already exists, pass force: true to back up the existing workspace to .codecarto-backup-TIMESTAMP/ and create a fresh one. Warning: backing up moves all existing findings, handoffs, usage data, closeouts, and phase progress to the backup directory.",
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
					description: "Back up and overwrite an existing .codecarto/ directory if present (default false).",
				},
			},
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_switch_pipeline",
		description:
			"Switch the active pipeline in-place without losing findings, handoffs, usage data, or phase progress. Phases that exist in both the old and new pipelines preserve their completion status. Phases unique to the new pipeline start as pending. Pass a pipeline alias (e.g. lite, full, synthesis) or a workflow/*.yaml path.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				pipeline: {
					type: "string",
					description: "Pipeline alias (e.g. lite, full, synthesis, architecture-only, defect-scan) or workflow/*.yaml path.",
				},
			},
			required: ["cwd", "pipeline"],
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
				allow_source_repo_change: {
					type: "boolean",
					description:
						"Permit publishing when the target entry already records a different source_repo. Off by default, because a mismatch usually means two projects derived the same slug and the spec would land in the wrong version history. Set only when the repository itself moved.",
				},
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
	{
		name: "codecarto_vision",
		description:
			"Generate a structured vision brief from raw product text using the guided interview skill. Returns a prompt the host should feed to its agent to write inputs/vision.md. Requires a synthesis workspace (run codecarto_init with the synthesis pipeline first).",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository with a .codecarto/ synthesis workspace." },
				raw_text: { type: "string", description: "The user's raw product text — audience, problem, desired outcomes, constraints, non-goals." },
			},
			required: ["cwd", "raw_text"],
		},
	},
	{
		name: "codecarto_library_init",
		description:
			"Initialize a CodeCartographer library at the given path: create the directory, write the .codecarto-library marker, and write the library.path into the user-global config. Idempotent — safe to re-run on an existing library. Pass a namespace to create a namespaced (shared) library.",
		inputSchema: {
			type: "object",
			properties: {
				library_path: { type: "string", description: "Absolute path for the library directory." },
				name: { type: "string", description: "Library name (defaults to the directory basename)." },
				namespace: { type: "string", description: "Default namespace for a namespaced (shared) library." },
			},
			required: ["library_path"],
		},
	},
	{
		name: "codecarto_config",
		description:
			"Show the effective merged CodeCartographer configuration (library.path, library.namespace, publish_confirm, llm_steer_next_phase) and whether the library marker was found. Pass cwd to include workspace-level config in the merge.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to a repository with a .codecarto/ workspace (optional)." },
			},
		},
	},
	{
		name: "codecarto_open",
		description: "Activate an existing CodeCartographer workspace without resetting state. Returns the current pipeline and phase.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string", description: "Absolute path to the target repository." } },
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_usage",
		description: "Show cumulative and per-phase token usage from local phase runs.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string", description: "Absolute path to the target repository." } },
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_dashboard",
		description: "Regenerate .codecarto/dashboard.html from the current workspace state.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string", description: "Absolute path to the target repository." } },
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_guide",
		description:
			"Return the instructions for driving this server: the status/next/execute/validate/complete loop, the phase-handoff contract, pipeline selection, executor choice, and recovery. Call this first when you have not run a CodeCartographer pipeline before. Takes no workspace.",
		inputSchema: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					description: "Guide topic. Omit for the overview; other topics are listed in every response.",
				},
			},
		},
	},
	{
		name: "codecarto_list_skills",
		description: "List available post-pipeline skills installed in the workspace.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string", description: "Absolute path to the target repository." } },
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_amend",
		description:
			"Apply a post-pipeline amendment from .codecarto/scratch/amendments/<name>.yaml to workflow/status.yaml: close open questions resolved on evidence after the pipeline completed and retire finished post-pipeline backlog items, under the same lock completion uses. Writes an amendment closeout and THREAD_LOG entry. Refused while the pipeline is incomplete — mid-pipeline resolutions belong in the phase handoff. Idempotent: ids that no longer match are reported, not fatal.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				name: { type: "string", description: "Amendment file slug under .codecarto/scratch/amendments/ (with or without .yaml)." },
			},
			required: ["cwd", "name"],
		},
	},
	{
		name: "codecarto_refresh_scaffold",
		description:
			"Refresh a workspace's framework-owned files (GUIDE.md, templates/, workflow pipelines and VALIDATE.md, skills/, findings SKILL and README stubs) from the packaged template — the action every scaffold-staleness warning instructs. Never touches project state (status.yaml), user config (workflow/config.yaml, usage log), findings outputs, scratch/, closeouts/, or the orchestrator files (CONVENTIONS.md, DECISIONS.md, BACKLOG.md, THREAD_LOG.md). Appends one THREAD_LOG entry naming the version transition. Unlike codecarto_init force:true, nothing is backed up or lost.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string", description: "Absolute path to the target repository." } },
			required: ["cwd"],
		},
	},
	{
		name: "codecarto_broadside",
		description:
			"Broad-Side: fire a cheap batch reconnaissance scan at a repository via the OpenRouter Batch API. Six lenses (architecture, api, security, defect, conventions, porting) run as asynchronous single-turn prompts with structured JSON schemas; results land in .codecarto/broadside/<run>/ as JSON plus markdown, with an optional cross-lens synthesis report. Works on any git repository — no CodeCartographer workspace required. Requires an OpenRouter API key (api_key param, OPENROUTER_API_KEY env var, or .codecarto/broadside/config.yaml). Findings are unverified scouting signals from a batch model, not validated claims — they tell the interactive pipeline where to look. Actions: submit (fire batches, returns batch ids and cost estimate), collect (poll to completion, save results, optionally synthesize), status (show recorded runs), models (list batch-capable models with pricing, context, output caps, structured-output support, and optional coding benchmarks).",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", description: "Absolute path to the target repository." },
				action: {
					type: "string",
					enum: ["submit", "collect", "status", "models"],
					description: "submit fires all lens batches and returns batch ids; collect polls submitted batches, saves results, and optionally runs the synthesis pass; status shows recorded runs; models lists batch-capable models with pricing and capabilities.",
				},
				lenses: {
					type: "array",
					items: { type: "string", enum: [...BROADSIDE_LENS_IDS] },
					description: "Lenses to run (submit only). Defaults to all six.",
				},
				api_key: {
					type: "string",
					description: "OpenRouter API key. Prefer the OPENROUTER_API_KEY environment variable or .codecarto/broadside/config.yaml.",
				},
				wait_seconds: {
					type: "number",
					description: "For submit: after submitting, poll up to this many seconds before returning. For collect: poll up to this many seconds before returning with partial state.",
				},
				include_synthesis: {
					type: "boolean",
					description: "Run the cross-lens synthesis pass once all lens batches complete (default true).",
				},
				include_triage: {
					type: "boolean",
					description:
						"Run the triage pass once all lens batches complete: turns the findings into a prioritized work order (impact × difficulty, P0-P3, effort estimates). Default true.",
				},
				retry_truncated: {
					type: "boolean",
					description:
						"Re-submit lens results that came back truncated at the output token limit, once, with a doubled output cap. Default true.",
				},
				max_cost: {
					type: "number",
					description:
						"Approximate run expense limit in USD. The submit action estimates the run cost from slice sizes and the configured model's per-token pricing (live OpenRouter lookup, cached 24h) and refuses to submit when the estimate exceeds the limit unless force is true. Falls back to max_cost in .codecarto/broadside/config.yaml.",
				},
				force: {
					type: "boolean",
					description: "Submit even when the cost estimate exceeds max_cost (default false).",
				},
				include_benchmarks: {
					type: "boolean",
					description: "For action 'models': annotate each model with its Artificial Analysis coding index (extra API call; default false).",
				},
			},
			required: ["cwd", "action"],
		},
	},
] as const;

const HANDLERS: Record<string, (args: any) => Promise<unknown>> = {
	codecarto_amend: handleAmend,
	codecarto_init: handleInit,
	codecarto_refresh_scaffold: handleRefreshScaffold,
	codecarto_status: handleStatus,
	codecarto_switch_pipeline: handleSwitchPipeline,
	codecarto_next: handleNext,
	codecarto_phase: handlePhase,
	codecarto_validate: handleValidate,
	codecarto_complete: handleComplete,
	codecarto_skill: handleSkill,
	codecarto_publish: handlePublish,
	codecarto_library_list: handleLibraryList,
	codecarto_library_reindex: handleLibraryReindex,
	codecarto_library_init: handleLibraryInit,
	codecarto_config: handleConfig,
	codecarto_vision: handleVision,
	codecarto_open: handleOpen,
	codecarto_usage: handleUsage,
	codecarto_dashboard: handleDashboard,
	codecarto_list_skills: handleListSkills,
	codecarto_guide: handleGuide,
	codecarto_broadside: handleBroadside,
};

export async function handleGuide(args: { topic?: string }) {
	const topics = await listGuideTopics();
	const document: GuideDocument = await readGuide(args.topic).catch((error) => {
		throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
	});
	const other = topics.filter((name) => name !== document.topic);
	const footer = other.length > 0
		? `\n\n---\nOther guide topics: ${other.join(", ")} (call codecarto_guide with topic).`
		: "";
	return textResult(`${document.content}${footer}`, { topic: document.topic, topics });
}

// ---------- server bootstrap ----------

export function buildServer() {
	const server = new Server(
		{ name: "codecartographer", version: PACKAGE_VERSION },
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
