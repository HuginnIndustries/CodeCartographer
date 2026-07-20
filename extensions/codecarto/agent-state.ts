// Shared, per-extension-instance phase activity state. The runner mutates
// it from session-event callbacks; the agents widget (M2) reads it on each
// render. Module-scoped Map so different command handlers can hand work to
// the runner and the widget sees the same state without explicit plumbing.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { emptyCompactionTelemetry, type CompactionTelemetry } from "../../core/usage.ts";

export type PhaseStatus = "running" | "completed" | "error" | "aborted";

export interface PhaseActivity {
	phaseId: string;
	status: PhaseStatus;
	startedAt: number;
	completedAt?: number;
	turnCount: number;
	toolUses: number;
	/** Currently-executing tool calls keyed by toolCallId, value is the tool name. */
	activeTools: Map<string, string>;
	/** Latest streaming response text from the assistant (for "thinking…" UI). */
	responseText: string;
	/** Cumulative token usage across all assistant turns; survives in-session compaction. */
	lifetimeUsage: { input: number; output: number; cacheWrite: number };
	/** Compaction outcomes observed during this phase session. */
	compactions: CompactionTelemetry;
	session?: AgentSession;
	error?: string;
}

const phaseActivity = new Map<string, PhaseActivity>();

export function getPhaseActivity(phaseId: string): PhaseActivity | undefined {
	return phaseActivity.get(phaseId);
}

export function listPhaseActivity(): PhaseActivity[] {
	return [...phaseActivity.values()];
}

export function startPhase(phaseId: string): PhaseActivity {
	const existing = phaseActivity.get(phaseId);
	if (existing && existing.status === "running") return existing;
	const activity: PhaseActivity = {
		phaseId,
		status: "running",
		startedAt: Date.now(),
		turnCount: 0,
		toolUses: 0,
		activeTools: new Map(),
		responseText: "",
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		compactions: emptyCompactionTelemetry(),
	};
	phaseActivity.set(phaseId, activity);
	return activity;
}

export function finishPhase(
	phaseId: string,
	outcome: { status: Exclude<PhaseStatus, "running">; error?: string },
): void {
	const activity = phaseActivity.get(phaseId);
	if (!activity) return;
	activity.status = outcome.status;
	activity.completedAt = Date.now();
	if (outcome.error) activity.error = outcome.error;
	activity.activeTools.clear();
}

/**
 * Clear a phase from the activity map. The widget (M2) will linger finished
 * phases for a turn or two before calling this; for now (M1) we clear after
 * a fixed timeout so the orchestrator notification stays meaningful.
 */
export function clearPhase(phaseId: string): void {
	phaseActivity.delete(phaseId);
}
