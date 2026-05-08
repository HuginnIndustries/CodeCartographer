// Persistent "Agents" widget rendered above the editor while CodeCartographer
// phase sub-agents are running. Reads the shared agent-state map every ~80ms
// to update the spinner and per-phase stats; unregisters itself when no phase
// is active and any finished phases have lingered out.
//
// Pattern adapted from @tintinweb/pi-subagents (src/ui/agent-widget.ts).
// Slimmed down: codecarto runs at most a small number of phases sequentially
// per workflow, so the overflow/queue logic in tintinweb's version is dropped.

import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { listPhaseActivity, type PhaseActivity } from "./agent-state.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDGET_KEY = "codecarto-agents";
const STATUS_KEY = "codecarto-agents-status";
const TICK_MS = 80;

/** How many ticks a finished phase lingers in the widget before removal. */
const FINISHED_LINGER_TICKS = 80; // ~6.4s at 80ms

const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

class CodecartoAgentsWidget {
	private uiCtx: ExtensionUIContext | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private spinnerFrame = 0;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private lastStatus: string | undefined;
	/** Tick counts for finished phases — used to age them out. */
	private finishedAge = new Map<string, number>();

	/**
	 * Wire this widget to a UI context. Called from /codecarto-next when a
	 * phase starts. Idempotent — if already running on the same context the
	 * call is a no-op.
	 */
	attach(uiCtx: ExtensionUIContext): void {
		if (this.uiCtx === uiCtx && this.timer !== undefined) return;
		this.uiCtx = uiCtx;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.lastStatus = undefined;
		this.ensureTimer();
		this.update();
	}

	/** Tear down — called from extension dispose. */
	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.uiCtx) {
			this.uiCtx.setWidget(WIDGET_KEY, undefined);
			this.uiCtx.setStatus(STATUS_KEY, undefined);
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.lastStatus = undefined;
		this.finishedAge.clear();
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.update(), TICK_MS);
	}

	private update(): void {
		if (!this.uiCtx) return;

		const all = listPhaseActivity();
		const running = all.filter((a) => a.status === "running");
		const finished = all.filter((a) => a.status !== "running");

		// Age finished phases. Drop those past the linger threshold.
		for (const a of finished) {
			const age = (this.finishedAge.get(a.phaseId) ?? 0) + 1;
			this.finishedAge.set(a.phaseId, age);
		}
		// Forget aged-out phases (visual only — agent-state owns the actual map).
		const visibleFinished = finished.filter((a) => (this.finishedAge.get(a.phaseId) ?? 0) <= FINISHED_LINGER_TICKS);

		// Drop entries for phases that are no longer in the activity map.
		for (const id of [...this.finishedAge.keys()]) {
			if (!all.some((a) => a.phaseId === id)) this.finishedAge.delete(id);
		}

		const hasActive = running.length > 0;
		const hasContent = hasActive || visibleFinished.length > 0;

		if (!hasContent) {
			this.unregister();
			return;
		}

		const newStatus = hasActive
			? `${running.length} CodeCartographer phase${running.length === 1 ? "" : "s"} running`
			: undefined;
		if (newStatus !== this.lastStatus) {
			this.uiCtx.setStatus(STATUS_KEY, newStatus);
			this.lastStatus = newStatus;
		}

		this.spinnerFrame++;

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: () => this.renderLines(tui, theme as unknown as Theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	private unregister(): void {
		if (!this.uiCtx) return;
		if (this.widgetRegistered) {
			this.uiCtx.setWidget(WIDGET_KEY, undefined);
			this.widgetRegistered = false;
			this.tui = undefined;
		}
		if (this.lastStatus !== undefined) {
			this.uiCtx.setStatus(STATUS_KEY, undefined);
			this.lastStatus = undefined;
		}
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.finishedAge.clear();
	}

	private renderLines(tui: TUI, theme: Theme): string[] {
		const all = listPhaseActivity();
		if (all.length === 0) return [];

		const cols = (tui as { terminal?: { columns?: number } }).terminal?.columns ?? 80;
		const truncate = (line: string) => truncateToWidth(line, cols);

		const running = all.filter((a) => a.status === "running");
		const finished = all
			.filter((a) => a.status !== "running")
			.filter((a) => (this.finishedAge.get(a.phaseId) ?? 0) <= FINISHED_LINGER_TICKS);

		const headingColor = running.length > 0 ? "accent" : "dim";
		const headingIcon = running.length > 0 ? "●" : "○";
		const heading = `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "CodeCartographer")}`;

		const lines: string[] = [truncate(heading)];

		const allEntries: Array<{ activity: PhaseActivity; isLast: boolean }> = [];
		for (const a of running) allEntries.push({ activity: a, isLast: false });
		for (const a of finished) allEntries.push({ activity: a, isLast: false });
		for (let i = 0; i < allEntries.length; i++) {
			allEntries[i].isLast = i === allEntries.length - 1;
		}

		for (const { activity, isLast } of allEntries) {
			const connector = isLast ? "└─" : "├─";
			const continuation = isLast ? "   " : "│  ";
			if (activity.status === "running") {
				const frame = SPINNER[this.spinnerFrame % SPINNER.length];
				const stats = formatRunningStats(activity);
				const header = `${theme.fg("dim", connector)} ${theme.fg("accent", frame)} ${theme.bold(activity.phaseId)} phase  ${theme.fg("dim", stats)}`;
				const activityText = describeActivity(activity);
				lines.push(truncate(header));
				lines.push(truncate(`${theme.fg("dim", continuation)}${theme.fg("dim", `   ⎿ ${activityText}`)}`));
			} else {
				const stats = formatFinishedStats(activity);
				const icon = formatStatusIcon(activity.status, theme);
				const dim = activity.status === "completed" ? "dim" : "warning";
				const errSuffix = activity.error ? ` ${theme.fg("error", `– ${activity.error.slice(0, 60)}`)}` : "";
				lines.push(truncate(`${theme.fg("dim", connector)} ${icon} ${theme.fg(dim, `${activity.phaseId} phase`)}  ${theme.fg("dim", stats)}${errSuffix}`));
			}
		}

		return lines;
	}
}

function formatRunningStats(a: PhaseActivity): string {
	const parts: string[] = [];
	if (a.turnCount > 0) parts.push(`⟳ ${a.turnCount}`);
	if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
	const tokens = a.lifetimeUsage.input + a.lifetimeUsage.output;
	if (tokens > 0) parts.push(formatTokens(tokens));
	parts.push(formatDuration(Date.now() - a.startedAt));
	return parts.join(" · ");
}

function formatFinishedStats(a: PhaseActivity): string {
	const parts: string[] = [];
	if (a.turnCount > 0) parts.push(`⟳ ${a.turnCount}`);
	if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
	const tokens = a.lifetimeUsage.input + a.lifetimeUsage.output;
	if (tokens > 0) parts.push(formatTokens(tokens));
	const dur = a.completedAt ? a.completedAt - a.startedAt : 0;
	if (dur > 0) parts.push(formatDuration(dur));
	return parts.join(" · ");
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

function formatStatusIcon(status: PhaseActivity["status"], theme: Theme): string {
	switch (status) {
		case "completed": return theme.fg("success", "✓");
		case "aborted": return theme.fg("warning", "■");
		case "error": return theme.fg("error", "✗");
		default: return theme.fg("dim", "·");
	}
}

function describeActivity(a: PhaseActivity): string {
	if (a.activeTools.size > 0) {
		const counts = new Map<string, number>();
		for (const name of a.activeTools.values()) {
			const action = TOOL_DISPLAY[name] ?? name;
			counts.set(action, (counts.get(action) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [action, count] of counts) {
			parts.push(count > 1 ? `${action} ×${count}` : action);
		}
		return `${parts.join(", ")}…`;
	}
	const text = a.responseText.split("\n").find((l) => l.trim()) ?? "";
	if (text.trim().length > 0) {
		return text.length > 60 ? `${text.slice(0, 60)}…` : text;
	}
	return "thinking…";
}

let widgetSingleton: CodecartoAgentsWidget | undefined;

export function getAgentsWidget(): CodecartoAgentsWidget {
	if (!widgetSingleton) widgetSingleton = new CodecartoAgentsWidget();
	return widgetSingleton;
}

export function disposeAgentsWidget(): void {
	if (widgetSingleton) {
		widgetSingleton.dispose();
		widgetSingleton = undefined;
	}
}
