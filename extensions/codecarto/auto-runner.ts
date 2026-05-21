// End-to-end auto runner for /codecarto-next --auto plus the two helpers
// shared between the one-shot path and the auto loop.
//
// runSinglePhase encapsulates everything the historical inline /codecarto-next
// did between getNextEligiblePhase and the .finally setTimeout. The one-shot
// handler still consumes it as a fire-and-forget Promise (void runSinglePhase
// keeps the TUI responsive while the phase runs). The auto loop awaits the
// same Promise, validates the output, and decides whether to advance.
//
// autoCompletePhase mirrors /codecarto-complete's updateStatusAtomically
// block — the gap → open_questions extraction, owner-notes append, THREAD_LOG
// write, closeout-stub creation, dashboard regen. UI notifications stay in
// the calling handler.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runPhase } from "./agent-runner.ts";
import { type PhaseActivity, clearPhase, finishPhase, getPhaseActivity, startPhase } from "./agent-state.ts";
import { buildSteeringMessage, rewritePhasePrompt } from "./agent-rewriter.ts";
import { buildPhaseSummary } from "./agent-summary.ts";
import { getAgentsWidget } from "./agent-widget.ts";
import { writeDashboard } from "./dashboard-writer.ts";

import {
	appendUsageRun,
	buildPhasePrompt,
	buildThreadLogEntry,
	buildValidationSummary,
	closeoutFileName,
	dateOnly,
	ensureCloseoutStub,
	formatMillis,
	formatTokenCount,
	getNextEligiblePhase,
	getWorkspaceState,
	loadCodecartoConfig,
	normalizeStatus,
	type OpenQuestionEntry,
	PACKAGE_VERSION,
	type PipelinePhase,
	resolvePhase,
	type UsageRunStatus,
	uniqueStrings,
	updateStatusAtomically,
	type ValidationOverall,
	type ValidationResult,
	validatePhaseOutput,
	type WorkspaceState,
} from "../../core/index.ts";

// ----------------------------------------------------------------------------
// runSinglePhase — shared by the one-shot path and the auto loop
// ----------------------------------------------------------------------------

export interface RunSinglePhaseOptions {
	llmSteerEnabled: boolean;
	signal?: AbortSignal;
	/**
	 * True when this phase is being driven by `/codecarto-next --auto`. The flag
	 * propagates into `buildPhasePrompt` so interactive hooks (notably the
	 * `reimplementation-spec` Strategic Alignment Hook) suppress their user-
	 * facing question and fall back to a documented default. The one-shot
	 * `/codecarto-next` path leaves this unset and the prompt is unchanged.
	 */
	auto?: boolean;
}

export interface SinglePhaseResult {
	status: "completed" | "aborted" | "error";
	activity: PhaseActivity;
	error?: string;
	responseText?: string;
}

/**
 * Run one phase end to end: optional LLM-steered rewrite, spawn the sub-agent,
 * wait for it, then emit the side effects the historical /codecarto-next chain
 * fired (notify, phase-summary sendMessage, recordUsage, writeDashboard). The
 * .finally linger-timeout for clearPhase fires here so both callers (one-shot
 * + auto loop) get the same lifecycle.
 *
 * Pre-conditions: caller verified the phase isn't already running (via
 * getPhaseActivity) and attached the agents widget if it wanted live progress.
 */
export async function runSinglePhase(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	state: WorkspaceState,
	phase: PipelinePhase,
	options: RunSinglePhaseOptions,
): Promise<SinglePhaseResult> {
	let prompt = await buildPhasePrompt(state, phase, false, { auto: options.auto === true });

	if (options.llmSteerEnabled) {
		if (ctx.hasUI) ctx.ui.notify(`Customizing ${phase.id} prompt via LLM rewriter…`, "info");
		const rewrite = await rewritePhasePrompt({ ctx, state, originalPrompt: prompt, nextPhaseId: phase.id });
		if (rewrite.used) {
			prompt = rewrite.prompt;
			if (ctx.hasUI) ctx.ui.notify(`LLM rewriter customized ${phase.id} seed prompt.`, "info");
			pi.sendMessage({
				customType: "codecarto-steering",
				content: buildSteeringMessage({
					nextPhaseId: phase.id,
					prevPhaseId: rewrite.prevPhaseId,
					rewrittenPrompt: rewrite.prompt,
				}),
				display: true,
			});
		} else if (ctx.hasUI) {
			ctx.ui.notify(`LLM rewriter skipped (${rewrite.skipReason}); using stock prompt.`, "warning");
		}
	}

	const activity = startPhase(phase.id);
	if (ctx.hasUI) {
		ctx.ui.notify(`CodeCartographer phase: ${phase.id} (sub-agent running)`, "info");
		getAgentsWidget().attach(ctx.ui);
	}

	try {
		const result = await runPhase(
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
			options.signal,
		);

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
				sessionFile: result.sessionFile,
			}),
			display: true,
		});
		void recordUsage(state.workspaceDir, phase.id, status, activity, result.sessionFile);
		void writeDashboard(ctx.cwd, PACKAGE_VERSION);

		return {
			status: result.aborted ? "aborted" : "completed",
			activity,
			responseText: result.responseText,
		};
	} catch (err: unknown) {
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
		void writeDashboard(ctx.cwd, PACKAGE_VERSION);

		return { status: "error", activity, error: message };
	} finally {
		// Linger 30s so /codecarto-status can show that the phase ran.
		setTimeout(() => clearPhase(phase.id), 30_000);
	}
}

/**
 * Re-entry guard: returns true if the phase is already running from a prior
 * spawn (manual or auto). Callers (both /codecarto-next paths) should reject
 * before invoking runSinglePhase.
 */
export function isPhaseRunning(phaseId: string): boolean {
	const existing = getPhaseActivity(phaseId);
	return existing?.status === "running";
}

// ----------------------------------------------------------------------------
// autoCompletePhase — programmatic /codecarto-complete (no UI notifies)
// ----------------------------------------------------------------------------

export interface AutoCompleteResult {
	updatedState: WorkspaceState;
	closeoutNotice?: string;
}

export async function autoCompletePhase(
	ctx: ExtensionContext,
	validation: ValidationResult,
): Promise<AutoCompleteResult> {
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
			closeoutNotice = `Closeout stub: .codecarto/closeouts/${closeoutFileName(dateOnly(completionTimestamp), validation.phaseId)} (fill it in)`;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		closeoutNotice = `Closeout stub not created: ${message}`;
	}

	void writeDashboard(ctx.cwd, PACKAGE_VERSION);

	return { updatedState, closeoutNotice };
}

// ----------------------------------------------------------------------------
// runAuto — the end-to-end loop
// ----------------------------------------------------------------------------

export type AutoOutcome = "complete" | "stopped" | "aborted";

export interface AutoRunOptions {
	strict: boolean;
	llmSteerOverride?: boolean;
	signal?: AbortSignal;
	/**
	 * Fired after each phase is auto-completed and `state` has advanced to the
	 * next eligible phase. Lets the caller refresh UI that reflects pipeline
	 * progress (the status widget, session name) mid-run instead of only after
	 * the whole loop returns — otherwise the readout stays frozen at the
	 * initial phase/progress until the auto run finishes.
	 */
	onPhaseAdvanced?: (state: WorkspaceState) => void;
}

export interface AutoRunResult {
	outcome: AutoOutcome;
	reason: string;
	phasesRun: string[];
	totalPhases: number;
	startedAt: number;
	endedAt: number;
	totalTokens: { input: number; output: number; cacheWrite: number };
	stoppedAt?: { phaseId: string; validation?: ValidationOverall; error?: string };
	validationSummary?: string[];
}

/**
 * Per-iteration decision: given the outcome of a sub-agent run and (if it
 * completed) its validation result, what should the auto loop do next?
 * Pure function — no I/O, no module state — so the decision matrix is
 * unit-testable without mocking the SDK.
 */
export type AutoDecision =
	| { action: "continue" }
	| { action: "stop"; reason: string; validation?: ValidationOverall; error?: string; validationSummary?: string[] }
	| { action: "aborted" };

export function decideAfterPhase(
	phaseStatus: SinglePhaseResult["status"],
	phaseError: string | undefined,
	validation: ValidationResult | null,
	strict: boolean,
): AutoDecision {
	if (phaseStatus === "aborted") return { action: "aborted" };
	if (phaseStatus === "error") {
		return { action: "stop", reason: phaseError ?? "Sub-agent errored.", error: phaseError };
	}
	if (!validation) {
		return { action: "stop", reason: "Validation skipped (no result)." };
	}
	if (validation.overall === "FAIL" || validation.overall === "MISSING") {
		return {
			action: "stop",
			reason: `Validation ${validation.overall} on ${validation.phaseId}.`,
			validation: validation.overall,
			validationSummary: buildValidationSummary(validation),
		};
	}
	if (validation.overall === "PASS WITH GAPS" && strict) {
		return {
			action: "stop",
			reason: `PASS WITH GAPS on ${validation.phaseId} (strict mode).`,
			validation: validation.overall,
			validationSummary: buildValidationSummary(validation),
		};
	}
	return { action: "continue" };
}

export async function runAuto(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	initialState: WorkspaceState,
	options: AutoRunOptions,
): Promise<AutoRunResult> {
	const startedAt = Date.now();
	const phasesRun: string[] = [];
	const totalTokens = { input: 0, output: 0, cacheWrite: 0 };
	const totalPhases = initialState.pipeline.phase_order.length;

	const config = await loadCodecartoConfig(initialState.workspaceDir);
	const llmSteerEnabled = options.llmSteerOverride ?? config.orchestrator.llm_steer_next_phase;

	let state = initialState;

	while (true) {
		if (options.signal?.aborted) {
			return finish({
				outcome: "aborted",
				reason: "User aborted the auto run.",
			});
		}

		const phase = getNextEligiblePhase(state);
		if (!phase) {
			return finish({
				outcome: "complete",
				reason: "Pipeline complete.",
			});
		}

		if (isPhaseRunning(phase.id)) {
			return finish({
				outcome: "stopped",
				reason: `Phase ${phase.id} is already running from a prior invocation.`,
				stoppedAt: { phaseId: phase.id },
			});
		}

		const phaseResult = await runSinglePhase(ctx, pi, state, phase, {
			llmSteerEnabled,
			signal: options.signal,
			auto: true,
		});

		// Accumulate tokens whether the phase succeeded, was aborted, or errored.
		totalTokens.input += phaseResult.activity.lifetimeUsage.input;
		totalTokens.output += phaseResult.activity.lifetimeUsage.output;
		totalTokens.cacheWrite += phaseResult.activity.lifetimeUsage.cacheWrite;

		// Validate only when the phase actually completed. Aborts and errors
		// short-circuit; decideAfterPhase handles all three outcomes.
		let validation: ValidationResult | null = null;
		if (phaseResult.status === "completed") {
			// State must be refreshed because the sub-agent may have written
			// findings to disk that the validator reads.
			const stateForValidation = (await getWorkspaceState(ctx.cwd)) ?? state;
			validation = await validatePhaseOutput(stateForValidation, phase.id);
		}

		const decision = decideAfterPhase(phaseResult.status, phaseResult.error, validation, options.strict);

		if (decision.action === "aborted") {
			return finish({
				outcome: "aborted",
				reason: `Aborted during ${phase.id}.`,
				stoppedAt: { phaseId: phase.id },
			});
		}
		if (decision.action === "stop") {
			return finish({
				outcome: "stopped",
				reason: decision.reason,
				stoppedAt: { phaseId: phase.id, validation: decision.validation, error: decision.error },
				validationSummary: decision.validationSummary,
			});
		}

		// decision.action === "continue" → auto-complete and loop.
		// validation is guaranteed non-null on the continue branch.
		try {
			const { updatedState } = await autoCompletePhase(ctx, validation!);
			state = updatedState;
			phasesRun.push(phase.id);
			options.onPhaseAdvanced?.(state);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return finish({
				outcome: "stopped",
				reason: `Auto-complete failed on ${phase.id}: ${message}`,
				stoppedAt: { phaseId: phase.id, error: message },
			});
		}
	}

	function finish(partial: Pick<AutoRunResult, "outcome" | "reason"> & Partial<Pick<AutoRunResult, "stoppedAt" | "validationSummary">>): AutoRunResult {
		return {
			...partial,
			phasesRun,
			totalPhases,
			startedAt,
			endedAt: Date.now(),
			totalTokens,
		};
	}
}

// ----------------------------------------------------------------------------
// buildAutoSummary — the codecarto-auto-summary message body
// ----------------------------------------------------------------------------

export function buildAutoSummary(result: AutoRunResult, availableSkills: string[] = []): string {
	const totalTokens = result.totalTokens.input + result.totalTokens.output;
	const wallTime = formatMillis(result.endedAt - result.startedAt);
	const tokensStr = formatTokenCount(totalTokens);
	const ranOf = `${result.phasesRun.length}/${result.totalPhases} phase${result.totalPhases === 1 ? "" : "s"}`;

	const header = (() => {
		switch (result.outcome) {
			case "complete":
				return `**Auto pipeline complete.**`;
			case "stopped":
				return `**Auto pipeline stopped at \`${result.stoppedAt?.phaseId ?? "?"}\`.**`;
			case "aborted":
				return `**Auto pipeline aborted${result.stoppedAt?.phaseId ? ` during \`${result.stoppedAt.phaseId}\`` : ""}.**`;
		}
	})();

	const statsLine = `_⟳ ${ranOf} · ${tokensStr} tokens · ${wallTime}_`;

	const lines: string[] = [header, "", statsLine];

	if (result.outcome === "stopped" && result.validationSummary && result.validationSummary.length > 0) {
		lines.push("", "```");
		lines.push(...result.validationSummary);
		lines.push("```");
	}

	if (result.outcome === "stopped" || result.outcome === "aborted") {
		lines.push("", result.reason);
		lines.push("", recoveryHint(result));
	}

	if (result.outcome === "complete") {
		lines.push("", "Dashboard: `.codecarto/dashboard.html`");
		if (availableSkills.length > 0) {
			lines.push(`Next: try \`/codecarto-skill ${availableSkills[0]}\` (also available: ${availableSkills.slice(1).join(", ") || "none"}).`);
		}
	}

	return lines.join("\n");
}

function recoveryHint(result: AutoRunResult): string {
	if (result.outcome === "aborted") {
		return "Run `/codecarto-next --auto` to resume.";
	}
	const v = result.stoppedAt?.validation;
	if (v === "FAIL" || v === "MISSING") {
		return `Fix the phase output, then \`/codecarto-next --auto\` to resume.`;
	}
	if (v === "PASS WITH GAPS") {
		return `Review gaps via \`/codecarto-validate\`, then \`/codecarto-complete ${result.stoppedAt?.phaseId ?? "<phase>"}\`, then \`/codecarto-next --auto\`.`;
	}
	if (result.stoppedAt?.error) {
		return `Re-run \`/codecarto-next\` (single-step) on \`${result.stoppedAt.phaseId}\` to retry once the issue is resolved.`;
	}
	return "Run `/codecarto-next --auto` to resume.";
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function recordUsage(
	workspaceDir: string,
	phaseId: string,
	status: UsageRunStatus,
	activity: PhaseActivity,
	sessionFile?: string,
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
			...(sessionFile ? { session_file: sessionFile } : {}),
		});
	} catch {
		// Best-effort, matches the original recordUsage discipline.
	}
}
