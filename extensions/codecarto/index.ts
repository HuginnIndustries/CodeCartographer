import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runPhase } from "./agent-runner.ts";
import { rewritePhasePrompt } from "./agent-rewriter.ts";
import { clearPhase, finishPhase, getPhaseActivity, startPhase } from "./agent-state.ts";
import { buildPhaseSummary } from "./agent-summary.ts";
import { disposeAgentsWidget, getAgentsWidget } from "./agent-widget.ts";
import { parseNextFlags } from "./next-flags.ts";

import {
	appendUsageRun,
	buildPhasePrompt,
	buildSkillPrompt,
	buildThreadLogEntry,
	buildValidationSummary,
	canonicalPath,
	closeoutFileName,
	computePerPhaseTotals,
	computeTotals,
	createEmptyStatus,
	dateOnly,
	DEFAULT_PIPELINE_PATH,
	ensureCloseoutStub,
	getNextEligiblePhase,
	getPipelineLabel,
	getWorkspaceState,
	isWithinPath,
	listSkillNames,
	loadCodecartoConfig,
	loadUsage,
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
	type UsageRunStatus,
	validatePhaseOutput,
	type WorkspaceState,
} from "../../core/index.ts";

const STATUS_WIDGET_ID = "codecarto-widget";
const STATUS_LINE_ID = "codecarto-status";
const SAFE_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write"];

async function recordUsage(
	workspaceDir: string,
	phaseId: string,
	status: UsageRunStatus,
	activity: { startedAt: number; completedAt?: number; turnCount: number; toolUses: number; lifetimeUsage: { input: number; output: number; cacheWrite: number } },
): Promise<void> {
	try {
		await appendUsageRun(workspaceDir, {
			timestamp: new Date().toISOString(),
			phase: phaseId,
			status,
			turn_count: activity.turnCount,
			tool_uses: activity.toolUses,
			duration_ms: (activity.completedAt ?? Date.now()) - activity.startedAt,
			tokens: {
				input: activity.lifetimeUsage.input,
				output: activity.lifetimeUsage.output,
				cache_write: activity.lifetimeUsage.cacheWrite,
			},
		});
	} catch {
		// Local usage logging is best-effort. A full disk or permission
		// failure shouldn't surface as a phase error to the user.
	}
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
		description: "Run the next eligible CodeCartographer phase as a sub-agent. Flags: --llm-steer / --no-llm-steer",
		getArgumentCompletions: (prefix) => {
			const items = ["--llm-steer", "--no-llm-steer"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const flags = parseNextFlags(args);
			if (flags.unknown.length > 0) {
				ctx.ui.notify(`Unknown /codecarto-next flag: ${flags.unknown.join(" ")}`, "error");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const phase = getNextEligiblePhase(state);
			if (!phase) {
				lastFeedbackLines = ["All phases complete."];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify("All CodeCartographer phases are complete.", "info");
				return;
			}

			// Reject re-entry: don't spawn a duplicate runner for a phase that's
			// already in flight from a previous /codecarto-next invocation.
			const existing = getPhaseActivity(phase.id);
			if (existing && existing.status === "running") {
				ctx.ui.notify(`Phase ${phase.id} is already running.`, "warning");
				return;
			}

			const config = await loadCodecartoConfig(state.workspaceDir);
			const llmSteerEnabled = flags.llmSteerOverride ?? config.orchestrator.llm_steer_next_phase;

			let prompt = await buildPhasePrompt(state, phase, false);
			if (llmSteerEnabled) {
				ctx.ui.notify(`Customizing ${phase.id} prompt via LLM rewriter…`, "info");
				const rewrite = await rewritePhasePrompt({ ctx, state, originalPrompt: prompt, nextPhaseId: phase.id });
				if (rewrite.used) {
					prompt = rewrite.prompt;
					ctx.ui.notify(`LLM rewriter customized ${phase.id} seed prompt.`, "info");
				} else {
					ctx.ui.notify(`LLM rewriter skipped (${rewrite.skipReason}); using stock prompt.`, "warning");
				}
			}

			const activity = startPhase(phase.id);
			lastFeedbackLines = [`Running ${phase.id} phase as sub-agent`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`CodeCartographer phase: ${phase.id} (sub-agent running)`, "info");

			// Attach the persistent "Agents" widget so the user can watch the
			// phase's tool/turn/token counts live above the editor while the
			// orchestrator's TUI stays responsive.
			getAgentsWidget().attach(ctx.ui);

			// Fire-and-forget: spawn the phase runner asynchronously so the
			// orchestrator's TUI stays responsive. The runner mutates the shared
			// agent-state map from event callbacks; M2 will read that map from a
			// persistent widget. For M1 we just notify on completion.
			void runPhase(
				ctx,
				prompt,
				{
					onSessionCreated: (session) => { activity.session = session; },
					onToolStart: (id, name) => { activity.activeTools.set(id, name); activity.toolUses++; },
					onToolEnd: (id) => { activity.activeTools.delete(id); },
					onTextDelta: (_delta, fullText) => { activity.responseText = fullText; },
					onTurnEnd: (turnCount) => { activity.turnCount = turnCount; },
					onMessageEnd: (usage) => {
						activity.lifetimeUsage.input += usage.input;
						activity.lifetimeUsage.output += usage.output;
						activity.lifetimeUsage.cacheWrite += usage.cacheWrite;
					},
				},
				{ sessionName: `CodeCartographer phase: ${phase.id}` },
			)
				.then((result) => {
					const status: UsageRunStatus = result.aborted ? "aborted" : "completed";
					finishPhase(phase.id, { status });
					if (ctx.hasUI) {
						ctx.ui.notify(
							result.aborted
								? `Phase ${phase.id} aborted.`
								: `Phase ${phase.id} sub-agent finished (${result.toolUses} tool uses, ${result.turnCount} turns).`,
							result.aborted ? "warning" : "info",
						);
					}
					// Inject a CustomMessageEntry into the orchestrator's session so
					// the user sees a closeout summary in the TUI scrollback and the
					// orchestrator's LLM picks up the phase result as context on the
					// next turn. display:true renders in the TUI; no triggerTurn so
					// the LLM doesn't auto-respond — the user remains in control.
					pi.sendMessage({
						customType: "codecarto-phase-summary",
						content: buildPhaseSummary({
							phaseId: phase.id,
							status: result.aborted ? "aborted" : "completed",
							turnCount: activity.turnCount,
							toolUses: activity.toolUses,
							tokens: activity.lifetimeUsage,
							durationMs: (activity.completedAt ?? Date.now()) - activity.startedAt,
							responseText: result.responseText,
						}),
						display: true,
					});
					void recordUsage(state.workspaceDir, phase.id, status, activity);
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					finishPhase(phase.id, { status: "error", error: message });
					if (ctx.hasUI) {
						ctx.ui.notify(`Phase ${phase.id} sub-agent failed: ${message}`, "error");
					}
					pi.sendMessage({
						customType: "codecarto-phase-summary",
						content: buildPhaseSummary({
							phaseId: phase.id,
							status: "error",
							turnCount: activity.turnCount,
							toolUses: activity.toolUses,
							tokens: activity.lifetimeUsage,
							durationMs: (activity.completedAt ?? Date.now()) - activity.startedAt,
							responseText: "",
							error: message,
						}),
						display: true,
					});
					void recordUsage(state.workspaceDir, phase.id, "error", activity);
				})
				.finally(() => {
					// Sub-agent may have written findings, owner_notes, or carry-forward
					// items into status.yaml. Refresh the main status widget so the
					// "Open questions / Carry-forward / Next" lines reflect the new
					// state without waiting for the user to run /codecarto-status.
					void refreshWorkspaceUi(ctx);
					// Linger 30s in M1 so /codecarto-status can show that the phase ran;
					// M2's widget owns the proper "linger N turns" lifecycle.
					setTimeout(() => clearPhase(phase.id), 30_000);
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

			const validation = await validatePhaseOutput(state, args.trim() || undefined);
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

			const validation = await validatePhaseOutput(currentState, args.trim() || undefined);
			if (validation.overall === "FAIL" || validation.overall === "MISSING") {
				lastFeedbackLines = buildValidationSummary(validation);
				setUiState(ctx, currentState, lastFeedbackLines);
				ctx.ui.notify(`Cannot complete ${validation.phaseId}: ${validation.overall}`, "error");
				return;
			}

			const completionTimestamp = new Date().toISOString();
			const updatedState = await updateStatusAtomically(ctx.cwd, (lockedState) => {
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
					const dupe = mergedOpenQuestions.some((entry) => entry.description === candidate.description && entry.deferred_reason === candidate.deferred_reason);
					if (!dupe) mergedOpenQuestions.push(candidate);
				}

				nextStatus.phases[validation.phaseId] = {
					status: "complete",
					owner_notes: uniqueStrings([
						...existingPhase.owner_notes,
						`Completed via /codecarto-complete on ${completionTimestamp}.`,
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
					? [
						`Begin ${nextEligible.id} phase by producing ${nextEligible.primary_output ?? `findings/${nextEligible.id}/`}`,
					]
					: ["All phases complete. Review findings, open questions, and downstream implementation notes."];

				return {
					state: {
						...updatedWorkspaceState,
						status: nextStatus,
					},
					threadLogEntry: buildThreadLogEntry(validation.phaseId, validation, completionTimestamp),
				};
			});

			let closeoutNotice: string | undefined;
			try {
				const created = await ensureCloseoutStub(updatedState.workspaceDir, validation.phaseId, completionTimestamp);
				if (created) {
					closeoutNotice = `Closeout stub: .codecarto/closeouts/${closeoutFileName(dateOnly(completionTimestamp), validation.phaseId)} (fill it in)`;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				closeoutNotice = `Closeout stub not created: ${message}`;
			}

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
}
