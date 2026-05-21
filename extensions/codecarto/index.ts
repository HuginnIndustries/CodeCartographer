import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { autoCompletePhase, buildAutoSummary, isPhaseRunning, runAuto, runSinglePhase } from "./auto-runner.ts";
import { disposeAgentsWidget } from "./agent-widget.ts";
import { parseDashboardFlags } from "./dashboard-flags.ts";
import { narrateDashboard } from "./dashboard-narrator.ts";
import { writeDashboard } from "./dashboard-writer.ts";
import { parseNextFlags } from "./next-flags.ts";

import {
	buildPhasePrompt,
	buildSkillPrompt,
	buildValidationSummary,
	canonicalPath,
	computePerPhaseTotals,
	computeTotals,
	createEmptyStatus,
	DEFAULT_PIPELINE_PATH,
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
	PIPELINE_ALIASES,
	type PipelineFile,
	resolvePhase,
	resolvePipelineChoice,
	type StatusFile,
	stringifySimpleYaml,
	validatePhaseOutput,
	type WorkspaceState,
} from "../../core/index.ts";

const STATUS_WIDGET_ID = "codecarto-widget";
const STATUS_LINE_ID = "codecarto-status";
const SAFE_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write"];

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
	const currentOpenQuestions = currentPhase === "complete" ? 0 : state.status.phases[currentPhase]?.open_questions.length ?? 0;
	const totalCarryForward = Object.values(state.status.phases).reduce((sum, phase) => sum + (phase.carry_forward?.length ?? 0), 0);
	const nextAction = state.status.next_actions[0] ?? (nextPhase ? `Next: ${nextPhase.id}` : "All phases complete.");

	const lines = [
		"CodeCartographer",
		`Phase: ${currentPhase}`,
		`Pipeline: ${pipelineLabel}`,
		`Progress: ${completedCount}/${state.pipeline.phase_order.length} complete`,
		`Open questions: ${currentOpenQuestions}`,
		`Carry-forward: ${totalCarryForward}`,
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
	let lastFeedbackLines: string[] = [];

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
		const state = await readWorkspaceState(ctx, false);
		setUiState(ctx, state, extraLines ?? lastFeedbackLines);
		if (state) {
			const phaseId = getNextEligiblePhase(state)?.id ?? state.status.current_phase;
			if (phaseId) pi.setSessionName(`CodeCartographer: ${phaseId}`);
		}
		return state;
	};

	const ensureWorkspaceState = async (ctx: ExtensionCommandContext): Promise<WorkspaceState | null> => {
		const state = await readWorkspaceState(ctx);
		if (state) return state;
		const hasWorkspace = await pathExists(join(ctx.cwd, ".codecarto", "workflow", "status.yaml"));
		if (!hasWorkspace) ctx.ui.notify("No .codecarto/ workspace found. Run /codecarto-init first.", "warning");
		return null;
	};

	pi.on("session_start", async (_event, ctx) => {
		const state = await refreshWorkspaceUi(ctx);
		if (!state) return;
		pi.setActiveTools(SAFE_TOOL_NAMES);
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
			const allowedRoot = await canonicalPath(workspaceDir);
			if (!isWithinPath(targetPath, allowedRoot)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked ${event.toolName} outside .codecarto/: ${inputPath}`, "warning");
				}
				return { block: true, reason: `CodeCartographer mode only allows ${event.toolName} within .codecarto/` };
			}
		}

		return undefined;
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
						"CodeCartographer already exists",
						"A .codecarto/ directory already exists in this repository. Overwrite it?",
					);
					if (!overwrite) return;
					await rm(targetWorkspaceDir, { recursive: true, force: true });
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

			lastFeedbackLines = [`Initialized workspace with pipeline: ${getPipelineLabel(selectedPipelinePath)}`];
			ctx.ui.notify(`Initialized CodeCartographer (${getPipelineLabel(selectedPipelinePath)})`, "info");
			await ctx.reload();
			// Render the initial dashboard (empty usage, all phases pending) so
			// the user sees the file exist immediately after /codecarto-init.
			void writeDashboard(ctx.cwd, PACKAGE_VERSION);
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
			void runSinglePhase(ctx, pi, state, phase, { llmSteerEnabled, signal: ctx.signal })
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

			const prompt = await buildPhasePrompt(state, phase, true);
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
			lines.push("");
			lines.push("Per-phase totals:");
			for (const [phaseId, t] of perPhase) {
				const tokensTotal = t.tokens.input + t.tokens.output;
				lines.push(
					`  ${phaseId}: ${t.runs} run${t.runs === 1 ? "" : "s"} · ${formatUsageTokens(tokensTotal)} tokens · ${t.tool_uses} tool uses · ${formatUsageDuration(t.duration_ms)}`,
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
