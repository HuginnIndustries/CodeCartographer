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
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import {
	buildPhasePrompt,
	buildSkillPrompt,
	buildThreadLogEntry,
	buildValidationSummary,
	canonicalPath,
	closeoutFileName,
	createEmptyStatus,
	dateOnly,
	DEFAULT_PIPELINE_PATH,
	ensureCloseoutStub,
	getNextEligiblePhase,
	getPipelineLabel,
	getWorkspaceState,
	listSkillNames,
	loadYamlFile,
	normalizeForComparison,
	normalizeStatus,
	type OpenQuestionEntry,
	packagedWorkspaceDir,
	pathExists,
	PIPELINE_ALIASES,
	type PipelineFile,
	resolvePhase,
	resolvePipelineChoice,
	type StatusFile,
	stringifySimpleYaml,
	uniqueStrings,
	updateStatusAtomically,
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
	const summary = [
		`Phase: ${currentPhase}`,
		`Pipeline: ${getPipelineLabel(state.status.pipeline)} (${state.status.pipeline})`,
		`Progress: ${completed}/${state.pipeline.phase_order.length} complete`,
		`Open questions (current phase): ${currentOpenQuestions}`,
		`Carry-forward (all phases): ${totalCarryForward}`,
		`Next: ${state.status.next_actions[0] ?? (nextPhase ? `Begin ${nextPhase.id}` : "All phases complete.")}`,
	].join("\n");
	return textResult(summary, {
		currentPhase,
		pipeline: state.status.pipeline,
		pipelineLabel: getPipelineLabel(state.status.pipeline),
		completed,
		total: state.pipeline.phase_order.length,
		openQuestionsCurrentPhase: currentOpenQuestions,
		carryForwardTotal: totalCarryForward,
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

	const completionTimestamp = new Date().toISOString();
	const updatedState = await updateStatusAtomically(cwd, (lockedState) => {
		const phase = resolvePhase(lockedState, validation.phaseId);
		if (!phase?.primary_output) {
			throw new Error(`Phase ${validation.phaseId} is missing primary_output.`);
		}

		const nextStatus = normalizeStatus(lockedState.status, lockedState.pipeline, lockedState.status.pipeline, lockedState.cwd);
		const existingPhase = nextStatus.phases[validation.phaseId] ?? {
			status: "pending",
			owner_notes: [],
			outputs_present: [],
			open_questions: [],
			carry_forward: [],
		};

		const gapEntries: OpenQuestionEntry[] = validation.rows
			.filter((row) => row.result.toUpperCase().includes("PARTIAL"))
			.map((row) => ({
				kind: "needs-maintainer-decision",
				description: row.criterion || "Partial validation gap",
				deferred_reason: row.evidence || "Marked PARTIAL by validation",
			}));

		const mergedOpenQuestions: OpenQuestionEntry[] = [...existingPhase.open_questions];
		for (const candidate of gapEntries) {
			const dupe = mergedOpenQuestions.some(
				(entry) => entry.description === candidate.description && entry.deferred_reason === candidate.deferred_reason,
			);
			if (!dupe) mergedOpenQuestions.push(candidate);
		}

		nextStatus.phases[validation.phaseId] = {
			status: "complete",
			owner_notes: uniqueStrings([
				...existingPhase.owner_notes,
				`Completed via codecarto_complete on ${completionTimestamp}.`,
				`Primary output: .codecarto/${validation.primaryOutput}`,
				`Validation: ${validation.overall}`,
			]).slice(-3),
			outputs_present: uniqueStrings([...existingPhase.outputs_present, validation.primaryOutput]),
			open_questions: mergedOpenQuestions,
			carry_forward: existingPhase.carry_forward ?? [],
		};

		nextStatus.last_updated = completionTimestamp;
		const updatedWorkspaceState: WorkspaceState = {
			...lockedState,
			status: nextStatus,
		};

		const nextEligible = getNextEligiblePhase(updatedWorkspaceState);
		nextStatus.current_phase = nextEligible?.id ?? "complete";
		nextStatus.next_actions = nextEligible
			? [`Begin ${nextEligible.id} phase by producing ${nextEligible.primary_output ?? `findings/${nextEligible.id}/`}`]
			: ["All phases complete. Review findings, open questions, and downstream implementation notes."];

		return {
			state: { ...updatedWorkspaceState, status: nextStatus },
			threadLogEntry: buildThreadLogEntry(validation.phaseId, validation, completionTimestamp),
		};
	});

	let closeoutNotice: string | undefined;
	try {
		const created = await ensureCloseoutStub(updatedState.workspaceDir, validation.phaseId, completionTimestamp);
		if (created) {
			closeoutNotice = `Closeout stub created: .codecarto/closeouts/${closeoutFileName(dateOnly(completionTimestamp), validation.phaseId)} (fill it in)`;
		}
	} catch (error) {
		closeoutNotice = `Closeout stub not created: ${error instanceof Error ? error.message : String(error)}`;
	}

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
					description: `Pipeline alias (one of ${Object.keys(PIPELINE_ALIASES).join(", ")}) or workflow/*.yaml path. Defaults to the framework's default pipeline.`,
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
] as const;

const HANDLERS: Record<string, (args: any) => Promise<unknown>> = {
	codecarto_init: handleInit,
	codecarto_status: handleStatus,
	codecarto_next: handleNext,
	codecarto_phase: handlePhase,
	codecarto_validate: handleValidate,
	codecarto_complete: handleComplete,
	codecarto_skill: handleSkill,
};

// ---------- server bootstrap ----------

export function buildServer() {
	const server = new Server(
		{ name: "codecartographer", version: "0.1.1" },
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
