import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { autoCompletePhase, buildAutoSummary, isPhaseRunning, runAuto, runSinglePhase } from "./auto-runner.ts";
import { disposeAgentsWidget } from "./agent-widget.ts";
import { parseDashboardFlags } from "./dashboard-flags.ts";
import { narrateDashboard } from "./dashboard-narrator.ts";
import { writeDashboard } from "./dashboard-writer.ts";
import { parseNextFlags } from "./next-flags.ts";
import { phaseCompactionExtension } from "./phase-compaction.ts";

import {
	buildPhasePrompt,
	buildSkillPrompt,
	buildValidationSummary,
	canonicalPath,
	computePerPhaseTotals,
	computeTotals,
	createEmptyStatus,
	DEFAULT_PIPELINE_PATH,
	deriveSlug,
	discoverLibrary,
	type EntryGeneration,
	getNextEligiblePhase,
	getPipelineLabel,
	getWorkspaceState,
	isWithinPath,
	listSkillNames,
	loadCodecartoConfig,
	loadUsage,
	loadYamlFile,
	normalizeForComparison,
	packagedWorkspaceDir,
	pathExists,
	PACKAGE_VERSION,
	PhasePreflightError,
	type PhasePreflightResult,
	PIPELINE_ALIASES,
	publishEntry,
	type PipelineFile,
	resolvePhase,
	resolvePipelineChoice,
	runPhasePreflight,
	type StatusFile,
	stringifySimpleYaml,
	switchPipeline,
	validatePhaseOutput,
	type WorkspaceState,
} from "../../core/index.ts";

const STATUS_WIDGET_ID = "codecarto-widget";
const STATUS_LINE_ID = "codecarto-status";
const SAFE_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write"];

function derivePublishHeadline(spec: string, cwd: string): string {
	const summary = spec.split(/^##\s+System Summary\s*$/mi)[1]?.split(/^##\s+/m)[0] ?? "";
	const candidate = summary
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("<!--") && !line.startsWith("-->") && !line.startsWith("#"));
	return candidate?.replace(/\s+/g, " ").slice(0, 280) || `Reimplementation specification for ${basename(cwd)}.`;
}

function piGeneration(ctx: ExtensionCommandContext): EntryGeneration {
	return {
		surface: "pi-extension",
		agent: "pi",
		agent_version: "unknown",
		model: ctx.model?.id ?? "unknown",
		model_vendor: ctx.model?.provider ?? "unknown",
		// Pi's extension context exposes the selected model but not the active
		// thinking level. Preserve that uncertainty instead of inferring it.
		reasoning: "unknown",
		notes: "",
	};
}

function formatUsageTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${count}`;
}

function formatUsageDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function buildStatusLines(state: WorkspaceState, extraLines: string[] = []): string[] {
	const nextPhase = getNextEligiblePhase(state);
	const currentPhase = nextPhase?.id ?? state.status.current_phase ?? "complete";
	const pipelineLabel = getPipelineLabel(state.status.pipeline);
	const completedCount = state.pipeline.phase_order.filter((phaseId) => state.status.phases[phaseId]?.status === "complete").length;
	const terminalOpenQuestions = Object.values(state.status.phases).reduce((sum, phase) => sum + (phase.open_questions?.length ?? 0), 0);
	const totalCarryForward = Object.values(state.status.phases).reduce((sum, phase) => sum + (phase.carry_forward?.length ?? 0), 0);
	const postPipelinePending = state.status.post_pipeline.filter((entry) => entry.status !== "resolved").length;
	const nextAction = state.status.next_actions[0] ?? (nextPhase ? `Next: ${nextPhase.id}` : "All phases complete.");

	const lines = [
		"CodeCartographer",
		`Phase: ${currentPhase}`,
		`Pipeline state: ${currentPhase === "complete" ? "complete" : "in progress"}`,
		`Pipeline: ${pipelineLabel}`,
		`Progress: ${completedCount}/${state.pipeline.phase_order.length} complete`,
		`Open questions (terminal unresolved): ${terminalOpenQuestions}`,
		`Carry-forward (pipeline phases): ${totalCarryForward}`,
		`Post-pipeline work: ${postPipelinePending} pending`,
		`Next: ${nextAction}`,
	];

	if (extraLines.length > 0) {
		lines.push("", ...extraLines);
	}

	return lines;
}

function setUiState(ctx: ExtensionContext | ExtensionCommandContext, state: WorkspaceState | null, extraLines: string[] = []): void {
	if (!ctx.hasUI) return;
	if (!state) {
		ctx.ui.setStatus(STATUS_LINE_ID, undefined);
		ctx.ui.setWidget(STATUS_WIDGET_ID, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const currentPhase = getNextEligiblePhase(state)?.id ?? state.status.current_phase ?? "complete";
	ctx.ui.setStatus(STATUS_LINE_ID, `${theme.fg("accent", "CC")} ${theme.fg("dim", currentPhase)}`);
	ctx.ui.setWidget(STATUS_WIDGET_ID, buildStatusLines(state, extraLines));
}

export default function codeCartographerExtension(pi: ExtensionAPI) {
	phaseCompactionExtension(pi);
	let lastFeedbackLines: string[] = [];
	let codecartoModeActive = false;

	const readWorkspaceState = async (ctx: ExtensionContext | ExtensionCommandContext, notifyOnError: boolean = true): Promise<WorkspaceState | null> => {
		try {
			return await getWorkspaceState(ctx.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastFeedbackLines = [message];
			setUiState(ctx, null);
			if (notifyOnError && ctx.hasUI) ctx.ui.notify(message, "error");
			return null;
		}
	};

	const refreshWorkspaceUi = async (ctx: ExtensionContext | ExtensionCommandContext, extraLines?: string[]): Promise<WorkspaceState | null> => {
		if (!codecartoModeActive) {
			setUiState(ctx, null);
			return null;
		}
		const state = await readWorkspaceState(ctx, false);
		setUiState(ctx, state, extraLines ?? lastFeedbackLines);
		if (state) {
			const phaseId = getNextEligiblePhase(state)?.id ?? state.status.current_phase;
			if (phaseId) pi.setSessionName(`CodeCartographer: ${phaseId}`);
		}
		return state;
	};

	const ensureWorkspaceState = async (ctx: ExtensionCommandContext): Promise<WorkspaceState | null> => {
		if (!codecartoModeActive) {
			setUiState(ctx, null);
			ctx.ui.notify("CodeCartographer is not active in this session. Run /codecarto-init first.", "warning");
			return null;
		}
		const state = await readWorkspaceState(ctx);
		if (state) return state;
		const hasWorkspace = await pathExists(join(ctx.cwd, ".codecarto", "workflow", "status.yaml"));
		if (!hasWorkspace) ctx.ui.notify("No .codecarto/ workspace found. Run /codecarto-init first.", "warning");
		return null;
	};

	pi.on("session_start", async (_event, ctx) => {
		codecartoModeActive = false;
		lastFeedbackLines = [];
		setUiState(ctx, null);
	});

	pi.on("session_shutdown", async () => {
		// Tear down the persistent agents widget so we don't leak the timer
		// or render against a torn-down UI context after a session swap.
		disposeAgentsWidget();
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshWorkspaceUi(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!codecartoModeActive) return undefined;

		const workspaceDir = join(ctx.cwd, ".codecarto");
		if (!(await pathExists(workspaceDir))) return undefined;

		if (event.toolName === "bash") {
			if (ctx.hasUI) ctx.ui.notify("Blocked bash in CodeCartographer mode", "warning");
			return { block: true, reason: "CodeCartographer mode disables bash to keep source analysis read-only." };
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const inputPath = typeof event.input.path === "string" ? event.input.path : "";
			const strippedPath = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
			const targetPath = await canonicalPath(resolve(ctx.cwd, strippedPath));
			const allowedRoots = [await canonicalPath(workspaceDir)];
			const config = await loadCodecartoConfig(workspaceDir);
			if (config.library.path && await discoverLibrary(config.library.path)) {
				allowedRoots.push(await canonicalPath(config.library.path));
			}
			if (!allowedRoots.some((allowedRoot) => isWithinPath(targetPath, allowedRoot))) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked ${event.toolName} outside .codecarto/ or configured library: ${inputPath}`, "warning");
				}
				return { block: true, reason: `CodeCartographer mode only allows ${event.toolName} within .codecarto/ or the configured CodeCartographer library.` };
			}
		}

		return undefined;
	});

	pi.registerCommand("codecarto-open", {
		description: "Activate an existing .codecarto workspace without resetting durable state",
		handler: async (_args, ctx) => {
			const workspaceDir = join(ctx.cwd, ".codecarto");
			if (!(await pathExists(join(workspaceDir, "workflow", "status.yaml")))) {
				ctx.ui.notify("No existing CodeCartographer workspace found. Run /codecarto-init first.", "warning");
				return;
			}
			try {
				const state = await getWorkspaceState(ctx.cwd);
				codecartoModeActive = true;
				lastFeedbackLines = [`Opened existing workspace: ${getPipelineLabel(state.status.pipeline)}`];
				pi.setActiveTools(SAFE_TOOL_NAMES);
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify("Opened existing CodeCartographer workspace without resetting state.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to open CodeCartographer workspace: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("codecarto-init", {
		description: "Initialize .codecarto/ in the current repository",
		getArgumentCompletions: (prefix) => {
			const items = Object.keys(PIPELINE_ALIASES)
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const pipelineChoice = resolvePipelineChoice(trimmedArgs);
			if (trimmedArgs && !pipelineChoice) {
				ctx.ui.notify(`Unknown pipeline: ${trimmedArgs}`, "error");
				return;
			}
			const targetWorkspaceDir = join(ctx.cwd, ".codecarto");
			const sourceWorkspaceDir = packagedWorkspaceDir;

			if (!(await pathExists(sourceWorkspaceDir))) {
				ctx.ui.notify("Packaged .codecarto assets are missing.", "error");
				return;
			}

			const targetExists = await pathExists(targetWorkspaceDir);
			if (targetExists) {
				const sameWorkspace = normalizeForComparison(await canonicalPath(targetWorkspaceDir)) === normalizeForComparison(await canonicalPath(sourceWorkspaceDir));
				if (!sameWorkspace) {
					const overwrite = await ctx.ui.confirm(
						"CodeCartographer already exists — data will be lost",
						"A .codecarto/ directory already exists in this repository. Re-initializing will back up the existing workspace to .codecarto-backup-TIMESTAMP/ and create a fresh one. All phase findings, handoffs, usage data, closeouts, and progress will be moved to the backup. Consider /codecarto-open to reattach without resetting. Continue?",
					);
					if (!overwrite) return;
					const backupDir = join(ctx.cwd, `.codecarto-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
					await rename(targetWorkspaceDir, backupDir);
					if (ctx.hasUI) ctx.ui.notify(`Backed up existing workspace to ${basename(backupDir)}/`, "info");
				}
			}

			if (!(await pathExists(targetWorkspaceDir))) {
				await mkdir(ctx.cwd, { recursive: true });
				await cp(sourceWorkspaceDir, targetWorkspaceDir, { recursive: true });
			}

			const rawStatusPath = join(targetWorkspaceDir, "workflow", "status.yaml");
			const rawStatus = (await loadYamlFile<StatusFile>(rawStatusPath)) ?? {};
			const selectedPipelinePath = pipelineChoice ?? rawStatus.pipeline?.trim() ?? DEFAULT_PIPELINE_PATH;
			const resolvedPipelinePath = join(targetWorkspaceDir, selectedPipelinePath);

			if (!(await pathExists(resolvedPipelinePath))) {
				ctx.ui.notify(`Pipeline not found: ${selectedPipelinePath}`, "error");
				return;
			}

			const pipeline = await loadYamlFile<PipelineFile>(resolvedPipelinePath);
			const normalizedStatus = createEmptyStatus(basename(ctx.cwd), selectedPipelinePath, pipeline);
			normalizedStatus.last_updated = new Date().toISOString();
			await writeFile(rawStatusPath, `${stringifySimpleYaml(normalizedStatus)}\n`, "utf8");

			codecartoModeActive = true;
			lastFeedbackLines = [`Initialized workspace with pipeline: ${getPipelineLabel(selectedPipelinePath)}`];
			ctx.ui.notify(`Initialized CodeCartographer (${getPipelineLabel(selectedPipelinePath)})`, "info");
			// Render the initial dashboard (empty usage, all phases pending) so
			// the user sees the file exist immediately after /codecarto-init.
			void writeDashboard(ctx.cwd, PACKAGE_VERSION);
			await refreshWorkspaceUi(ctx, lastFeedbackLines);
			pi.setActiveTools(SAFE_TOOL_NAMES);
			return;
		},
	});

	pi.registerCommand("codecarto-status", {
		description: "Show the current CodeCartographer phase and progress",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const nextPhase = getNextEligiblePhase(state)?.id ?? "complete";
			lastFeedbackLines = [`Current phase: ${nextPhase}`, `Pipeline: ${getPipelineLabel(state.status.pipeline)}`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`CodeCartographer phase: ${nextPhase}`, "info");
		},
	});

	pi.registerCommand("codecarto-switch-pipeline", {
		description: "Switch the active pipeline without losing findings or progress: /codecarto-switch-pipeline <variant>",
		getArgumentCompletions: (prefix) => {
			const items = Object.keys(PIPELINE_ALIASES)
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (!trimmedArgs) {
				ctx.ui.notify("Usage: /codecarto-switch-pipeline <variant> (e.g. lite, full, synthesis)", "warning");
				return;
			}

			const pipelineChoice = resolvePipelineChoice(trimmedArgs);
			if (!pipelineChoice) {
				ctx.ui.notify(`Unknown pipeline: ${trimmedArgs}`, "error");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const currentPipeline = state.status.pipeline;
			if (currentPipeline === pipelineChoice) {
				ctx.ui.notify(`Already on pipeline: ${getPipelineLabel(pipelineChoice)}`, "info");
				return;
			}

			try {
				const result = await switchPipeline(ctx.cwd, pipelineChoice);
				const lines = [
					`Switched pipeline: ${getPipelineLabel(pipelineChoice)}`,
				];
				if (result.carried.length > 0) lines.push(`Phases preserved (completed): ${result.carried.join(", ")}`);
				if (result.newPhases.length > 0) lines.push(`New phases: ${result.newPhases.join(", ")}`);
				if (result.dropped.length > 0) lines.push(`Phases not in new pipeline: ${result.dropped.join(", ")} (findings remain on disk)`);

				lastFeedbackLines = lines;
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify(`Switched to pipeline: ${getPipelineLabel(pipelineChoice)}`, "info");
				void writeDashboard(ctx.cwd, PACKAGE_VERSION);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				lastFeedbackLines = [message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerCommand("codecarto-next", {
		description: "Run the next eligible CodeCartographer phase as a sub-agent. Flags: --llm-steer / --no-llm-steer / --auto [--strict]",
		getArgumentCompletions: (prefix) => {
			const items = ["--llm-steer", "--no-llm-steer", "--auto", "--strict"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const flags = parseNextFlags(args);
			if (flags.error) {
				ctx.ui.notify(flags.error, "error");
				return;
			}
			if (flags.unknown.length > 0) {
				ctx.ui.notify(`Unknown /codecarto-next flag: ${flags.unknown.join(" ")}`, "error");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			if (flags.auto) {
				ctx.ui.notify(`Auto pipeline${flags.strict ? " (strict)" : ""} running…`, "info");
				const result = await runAuto(ctx, pi, state, {
					strict: flags.strict,
					llmSteerOverride: flags.llmSteerOverride,
					signal: ctx.signal,
					onPhaseAdvanced: (advancedState) => {
						// Refresh the status widget + session name between phases so
						// the readout tracks progress live instead of staying frozen
						// at the initial phase until the whole auto run finishes.
						setUiState(ctx, advancedState, [`Auto pipeline${flags.strict ? " (strict)" : ""} running…`]);
						const phaseId = getNextEligiblePhase(advancedState)?.id ?? advancedState.status.current_phase;
						if (phaseId) pi.setSessionName(`CodeCartographer: ${phaseId}`);
					},
				});
				const availableSkills = await listSkillNames(state.workspaceDir).catch(() => [] as string[]);
				pi.sendMessage({
					customType: "codecarto-auto-summary",
					content: buildAutoSummary(result, availableSkills),
					display: true,
				});
				lastFeedbackLines = [`Auto pipeline ${result.outcome}: ${result.reason}`];
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify(`Auto pipeline ${result.outcome}: ${result.phasesRun.length}/${result.totalPhases} phases.`, result.outcome === "complete" ? "info" : "warning");
				return;
			}

			const phase = getNextEligiblePhase(state);
			if (!phase) {
				lastFeedbackLines = ["All phases complete."];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify("All CodeCartographer phases are complete.", "info");
				return;
			}

			let preflight: PhasePreflightResult;
			try {
				preflight = await runPhasePreflight(state, phase);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				lastFeedbackLines = [message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(message, error instanceof PhasePreflightError ? "warning" : "error");
				return;
			}

			// Reject re-entry: don't spawn a duplicate runner for a phase that's
			// already in flight from a previous /codecarto-next invocation.
			if (isPhaseRunning(phase.id)) {
				ctx.ui.notify(`Phase ${phase.id} is already running.`, "warning");
				return;
			}

			const config = await loadCodecartoConfig(state.workspaceDir);
			const llmSteerEnabled = flags.llmSteerOverride ?? config.orchestrator.llm_steer_next_phase;

			lastFeedbackLines = [`Running ${phase.id} phase as sub-agent`];
			setUiState(ctx, state, lastFeedbackLines);

			// Fire-and-forget: keep the TUI responsive while the sub-agent works.
			// runSinglePhase handles all side effects (steering message, notify,
			// phase summary, recordUsage, dashboard regen, clearPhase linger).
			// After the sub-agent finishes, auto-validate and auto-complete the
			// phase so status.yaml advances without requiring the user to manually
			// run /codecarto-validate then /codecarto-complete. This mirrors what
			// the auto loop (runAuto) does after each phase.
			void runSinglePhase(ctx, pi, state, phase, { llmSteerEnabled, signal: ctx.signal, preflight })
				.then(async (result) => {
					if (result.status !== "completed") return;

					// Refresh state from disk — the sub-agent may have written
					// findings that the validator needs to read.
					const stateForValidation = (await getWorkspaceState(ctx.cwd)) ?? state;
					const validation = await validatePhaseOutput(stateForValidation, phase.id).catch(
						(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
					);

					if (validation instanceof Error) {
						if (ctx.hasUI) ctx.ui.notify(`Auto-validation error for ${phase.id}: ${validation.message}`, "warning");
						lastFeedbackLines = [`Validation error: ${validation.message}`, "Run `/codecarto-validate` then `/codecarto-complete` manually."];
						return;
					}

					if (validation.overall === "FAIL" || validation.overall === "MISSING") {
						if (ctx.hasUI) ctx.ui.notify(`Phase ${phase.id} validation: ${validation.overall}. Fix the output, then re-run /codecarto-next.`, "warning");
						lastFeedbackLines = buildValidationSummary(validation);
						return;
					}

					// PASS or PASS WITH GAPS — auto-complete the phase.
					try {
						const { updatedState, closeoutNotice } = await autoCompletePhase(ctx, validation);
						if (ctx.hasUI) {
							ctx.ui.notify(`Phase ${phase.id} auto-completed (validation: ${validation.overall}).`, validation.overall === "PASS WITH GAPS" ? "warning" : "info");
							if (closeoutNotice) ctx.ui.notify(closeoutNotice, "info");
						}
						lastFeedbackLines = [
							`Completed phase: ${validation.phaseId}`,
							`Validation: ${validation.overall}`,
							`Next phase: ${updatedState.status.current_phase}`,
						];
						if (closeoutNotice) lastFeedbackLines.push(closeoutNotice);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : String(error);
						if (ctx.hasUI) ctx.ui.notify(`Auto-completion failed for ${phase.id}: ${message}. Run /codecarto-complete manually.`, "warning");
						lastFeedbackLines = [`Auto-completion failed: ${message}`, "Run `/codecarto-complete` manually."];
					}
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) ctx.ui.notify(`Post-phase processing error for ${phase.id}: ${message}`, "warning");
					lastFeedbackLines = [`Post-phase error: ${message}`];
				})
				.finally(() => {
					// Refresh the status widget after the phase resolves so the
					// "Open questions / Carry-forward / Next" lines reflect any
					// owner_notes the sub-agent wrote to status.yaml.
					void refreshWorkspaceUi(ctx);
				});
		},
	});

	pi.registerCommand("codecarto-phase", {
		description: "Queue a specific CodeCartographer phase prompt: /codecarto-phase <phase>",
		handler: async (args, ctx) => {
			const phaseId = args.trim();
			if (!phaseId) {
				ctx.ui.notify("Usage: /codecarto-phase <phase>", "warning");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const phase = resolvePhase(state, phaseId);
			if (!phase) {
				ctx.ui.notify(`Unknown phase: ${phaseId}`, "error");
				return;
			}

			let prompt: string;
			try {
				prompt = await buildPhasePrompt(state, phase, true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, error instanceof PhasePreflightError ? "warning" : "error");
				return;
			}
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}

			lastFeedbackLines = [`Queued explicit phase prompt for ${phase.id}`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`Queued CodeCartographer phase: ${phase.id}`, "info");
		},
	});

	pi.registerCommand("codecarto-validate", {
		description: "Validate a phase output: /codecarto-validate [phase]",
		handler: async (args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const validation = await validatePhaseOutput(state, args.trim() || undefined).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
			if (validation instanceof Error) {
				lastFeedbackLines = [validation.message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(validation.message, "error");
				return;
			}
			lastFeedbackLines = buildValidationSummary(validation);
			setUiState(ctx, state, lastFeedbackLines);

			const level = validation.overall === "FAIL" || validation.overall === "MISSING" ? "error" : validation.overall === "PASS WITH GAPS" ? "warning" : "info";
			ctx.ui.notify(`Validation ${validation.phaseId}: ${validation.overall}`, level);
		},
	});

	pi.registerCommand("codecarto-complete", {
		description: "Mark a phase complete after validation passes: /codecarto-complete [phase]",
		handler: async (args, ctx) => {
			const currentState = await ensureWorkspaceState(ctx);
			if (!currentState) return;

			const validation = await validatePhaseOutput(currentState, args.trim() || undefined).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
			if (validation instanceof Error) {
				lastFeedbackLines = [validation.message];
				setUiState(ctx, currentState, lastFeedbackLines);
				ctx.ui.notify(validation.message, "error");
				return;
			}
			if (validation.overall === "FAIL" || validation.overall === "MISSING") {
				lastFeedbackLines = buildValidationSummary(validation);
				setUiState(ctx, currentState, lastFeedbackLines);
				ctx.ui.notify(`Cannot complete ${validation.phaseId}: ${validation.overall}`, "error");
				return;
			}

			const { updatedState, closeoutNotice } = await autoCompletePhase(ctx, validation);

			lastFeedbackLines = [
				`Completed phase: ${validation.phaseId}`,
				`Validation: ${validation.overall}`,
				`Next phase: ${updatedState.status.current_phase}`,
			];
			if (closeoutNotice) lastFeedbackLines.push(closeoutNotice);
			setUiState(ctx, updatedState, lastFeedbackLines);
			ctx.ui.notify(`Marked ${validation.phaseId} complete`, validation.overall === "PASS WITH GAPS" ? "warning" : "info");
			if (closeoutNotice) ctx.ui.notify(closeoutNotice, "info");
		},
	});

	pi.registerCommand("codecarto-skill", {
		description: "Run a post-pipeline skill (after all phases are complete): /codecarto-skill <name>",
		handler: async (args, ctx) => {
			const skillName = args.trim();
			if (!skillName) {
				const available = await listSkillNames(join(ctx.cwd, ".codecarto"));
				const hint = available.length > 0 ? ` (available: ${available.join(", ")})` : "";
				ctx.ui.notify(`Usage: /codecarto-skill <name>${hint}`, "warning");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const nextPhase = getNextEligiblePhase(state);
			if (nextPhase) {
				ctx.ui.notify(
					`Cannot run skill: pipeline is not complete (next phase: ${nextPhase.id}). Finish the pipeline before running post-pipeline skills.`,
					"error",
				);
				return;
			}

			const skillFile = join(state.workspaceDir, "skills", skillName, "SKILL.md");
			if (!(await pathExists(skillFile))) {
				const available = await listSkillNames(state.workspaceDir);
				const hint = available.length > 0 ? ` (available: ${available.join(", ")})` : " (no skills installed)";
				ctx.ui.notify(`Unknown skill: ${skillName}${hint}`, "error");
				return;
			}

			const prompt = await buildSkillPrompt(state, skillName);
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}

			lastFeedbackLines = [`Queued post-pipeline skill: ${skillName}`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`Queued CodeCartographer skill: ${skillName}`, "info");
		},
	});

	pi.registerCommand("codecarto-publish", {
		description: "Publish the completed reimplementation spec to the configured CodeCartographer library",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const config = await loadCodecartoConfig(state.workspaceDir);
			if (!config.library.path) {
				ctx.ui.notify("No library.path is configured. Create a library directory with a .codecarto-library marker, then set library.path in ~/.codecarto/config.yaml or .codecarto/workflow/config.yaml.", "error");
				return;
			}
			const marker = await discoverLibrary(config.library.path);
			if (!marker) {
				ctx.ui.notify(`No CodeCartographer library at ${config.library.path} (missing .codecarto-library). Create a .codecarto-library marker file in that directory.`, "error");
				return;
			}

			const phase = resolvePhase(state, "reimplementation-spec");
			if (!phase?.primary_output) {
				ctx.ui.notify("The active pipeline does not produce a reimplementation spec to publish.", "error");
				return;
			}
			const specPath = join(state.workspaceDir, phase.primary_output);
			if (!(await pathExists(specPath))) {
				ctx.ui.notify(`Reimplementation spec is missing: .codecarto/${phase.primary_output}`, "error");
				return;
			}

			const spec = await readFile(specPath, "utf8");
			const slug = deriveSlug(ctx.cwd);
			const headline = derivePublishHeadline(spec, ctx.cwd);
			const namespace = marker.namespaced ? config.library.namespace ?? undefined : undefined;
			if (marker.namespaced && !namespace) {
				ctx.ui.notify("The configured library is namespaced; set library.namespace before publishing.", "error");
				return;
			}

			const preview = [
				`Publish ${namespace ? `${namespace}/` : ""}${slug} to ${config.library.path}`,
				`Source: ${ctx.cwd}`,
				`Spec: .codecarto/${phase.primary_output}`,
				`Headline: ${headline}`,
				`Provenance: Pi / ${ctx.model?.provider ?? "unknown"} / ${ctx.model?.id ?? "unknown"}`,
			].join("\n");
			if (config.library.publish_confirm && !(await ctx.ui.confirm("Publish reimplementation spec", preview))) return;

			try {
				const result = await publishEntry(config.library.path, spec, {
					slug,
					namespace,
					source_repo: ctx.cwd,
					analyzed_at: new Date().toISOString(),
					pipeline: state.status.pipeline,
					codecarto_version: PACKAGE_VERSION,
					headline,
					tags: [],
					capabilities: [],
					generation: piGeneration(ctx),
				});
				lastFeedbackLines = [`Published ${result.namespace ? `${result.namespace}/` : ""}${result.slug} v${result.version}`, result.isNewVersion ? "New content version." : "Metadata-only update (content unchanged)."];
				await writeDashboard(ctx.cwd, PACKAGE_VERSION);
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify(`Published ${result.namespace ? `${result.namespace}/` : ""}${result.slug} v${result.version}.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to publish: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("codecarto-usage", {
		description: "Show cumulative + per-phase token usage from local phase runs",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const usage = await loadUsage(state.workspaceDir);
			if (usage.runs.length === 0) {
				lastFeedbackLines = ["No phase runs recorded yet."];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify("No phase runs recorded yet.", "info");
				return;
			}

			const totals = computeTotals(usage);
			const perPhase = computePerPhaseTotals(usage);

			const lines: string[] = [];
			lines.push(`Total runs: ${totals.runs}`);
			lines.push(`Total tokens: ${formatUsageTokens(totals.tokens.input)} in · ${formatUsageTokens(totals.tokens.output)} out · ${formatUsageTokens(totals.tokens.cache_write)} cache-write`);
			lines.push(`Total duration: ${formatUsageDuration(totals.duration_ms)} · ${totals.tool_uses} tool uses`);
			lines.push(totals.compaction_runs > 0
				? `Compactions: ${totals.compactions.successful} successful · ${totals.compactions.failed} failed · ${totals.compactions.aborted} aborted`
				: "Compactions: unavailable — historical or host usage records did not report compaction events");
			lines.push("");
			lines.push("Per-phase totals:");
			for (const [phaseId, t] of perPhase) {
				const tokensTotal = t.tokens.input + t.tokens.output;
				lines.push(
					`  ${phaseId}: ${t.runs} run${t.runs === 1 ? "" : "s"} · ${formatUsageTokens(tokensTotal)} tokens · ${t.tool_uses} tool uses · ${t.compaction_runs > 0 ? `${t.compactions.successful + t.compactions.failed + t.compactions.aborted} compactions` : "compactions unavailable"} · ${formatUsageDuration(t.duration_ms)}`,
				);
			}

			lastFeedbackLines = lines;
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`CodeCartographer usage: ${totals.runs} run${totals.runs === 1 ? "" : "s"}, ${formatUsageTokens(totals.tokens.input + totals.tokens.output)} tokens total`, "info");
		},
	});

	pi.registerCommand("codecarto-dashboard", {
		description: "Regenerate .codecarto/dashboard.html (use --narrate for an LLM executive summary)",
		getArgumentCompletions: (prefix) => {
			const items = ["--narrate"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const flags = parseDashboardFlags(args);
			if (flags.unknown.length > 0) {
				ctx.ui.notify(`Unknown /codecarto-dashboard flag: ${flags.unknown.join(" ")}`, "error");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			if (flags.narrate) {
				ctx.ui.notify(`Narrating dashboard via LLM…`, "info");
				const result = await narrateDashboard(ctx, state);
				if (result.used) {
					ctx.ui.notify("Narration written to .codecarto/.dashboard-narration.local.md", "info");
				} else {
					ctx.ui.notify(`LLM narration skipped (${result.skipReason}); rendering deterministic dashboard.`, "warning");
				}
			}

			await writeDashboard(ctx.cwd, PACKAGE_VERSION);
			lastFeedbackLines = ["Dashboard regenerated: .codecarto/dashboard.html"];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify("Dashboard regenerated: .codecarto/dashboard.html", "info");
		},
	});
}
