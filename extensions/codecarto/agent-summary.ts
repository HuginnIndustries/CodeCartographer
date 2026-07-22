// Build the markdown summary that's injected into the orchestrator's session
// when a phase sub-agent finishes. The summary is a CustomMessageEntry
// (display: true, no triggerTurn) so the user sees it in the TUI and the
// orchestrator's LLM picks it up as context on the user's next turn.

import type { PhaseActivity } from "./agent-state.ts";

export interface PhaseSummaryInput {
	phaseId: string;
	status: PhaseActivity["status"];
	turnCount: number;
	toolUses: number;
	tokens: { input: number; output: number; cacheWrite: number };
	compactions?: { successful: number; failed: number; aborted: number };
	durationMs: number;
	responseText: string;
	sessionFile?: string;
	error?: string;
}

const RESPONSE_TEXT_CHAR_BUDGET = 2000;

export function buildPhaseSummary(input: PhaseSummaryInput): string {
	const stats = formatStats(input);
	const headerLine = formatHeader(input.phaseId, input.status);

	if (input.status === "error") {
		const errorLine = input.error ? `\n\n\`${input.error}\`` : "";
		return `${headerLine}\n\n${stats}${errorLine}`;
	}

	const trailer = formatTrailer(input);
	const excerpt = formatExcerpt(input.responseText);
	const sections: string[] = [headerLine, stats];
	if (excerpt) sections.push(excerpt);
	sections.push(trailer);
	return sections.join("\n\n");
}

function formatHeader(phaseId: string, status: PhaseActivity["status"]): string {
	switch (status) {
		case "completed":
			return `**Phase \`${phaseId}\` finished.**`;
		case "aborted":
			return `**Phase \`${phaseId}\` aborted.**`;
		case "error":
			return `**Phase \`${phaseId}\` failed.**`;
		default:
			return `**Phase \`${phaseId}\`.**`;
	}
}

function formatStats(input: PhaseSummaryInput): string {
	const parts: string[] = [];
	if (input.turnCount > 0) parts.push(`⟳ ${input.turnCount}`);
	if (input.toolUses > 0) parts.push(`${input.toolUses} tool use${input.toolUses === 1 ? "" : "s"}`);
	const totalTokens = input.tokens.input + input.tokens.output;
	if (totalTokens > 0) parts.push(formatTokens(totalTokens));
	const compact = input.compactions;
	if (compact && compact.successful + compact.failed + compact.aborted > 0) {
		const details = [`${compact.successful} compaction${compact.successful === 1 ? "" : "s"}`];
		if (compact.failed > 0) details.push(`${compact.failed} failed`);
		if (compact.aborted > 0) details.push(`${compact.aborted} aborted`);
		parts.push(details.join(", "));
	}
	if (input.durationMs > 0) parts.push(formatDuration(input.durationMs));
	return parts.length > 0 ? `_${parts.join(" · ")}_` : "_(no activity recorded)_";
}

function formatExcerpt(responseText: string): string {
	const trimmed = responseText.trim();
	if (!trimmed) return "";
	if (trimmed.length <= RESPONSE_TEXT_CHAR_BUDGET) return trimmed;
	return `${trimmed.slice(0, RESPONSE_TEXT_CHAR_BUDGET).trimEnd()}…\n\n_(transcript truncated; resume the phase session for the full output)_`;
}

function formatTrailer(input: PhaseSummaryInput): string {
	const lines: string[] = [];
	if (input.sessionFile) {
		lines.push(`Phase transcript: \`${input.sessionFile}\` (open via \`/resume\`).`);
	}
	if (input.status === "completed") {
		lines.push("Auto-validating and completing the phase — check the status widget for the result.");
	}
	return lines.join("\n");
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tokens`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tokens`;
	return `${count} tokens`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}
