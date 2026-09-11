// User-facing notifications from the orchestrator side of the Pi extension.
//
// Two things go wrong with a bare `ctx.ui.notify(...)`, and this module is the
// one place that handles both.
//
// A stale ctx throws. Pi invalidates an extension ctx when the session is
// replaced, and from then on *every* property access on it throws — `ctx.cwd`
// and `ctx.hasUI` included. A phase runs as a sub-agent, so by the time
// post-phase work fires, the ctx captured when the command started may already
// be dead. That is an ordinary outcome, not an error: the UI it would have
// refreshed is gone with the session, so the message is dropped.
//
// A non-interactive session shows nothing. Under `pi -p`, `ctx.hasUI` is false
// and `ctx.ui.notify` is a silent no-op. Commands whose only output is a notify
// — /codecarto-status, /codecarto-usage, /codecarto-list-skills — then exit 0
// having printed nothing, which is byte-for-byte what a silent refusal looks
// like (#219). So when there is no UI, the message goes to stderr instead:
// stderr rather than stdout because `--mode json` owns stdout for its event
// stream and prose there would corrupt it.
//
// This is for the orchestrator's ctx only. Code that runs inside the phase
// sub-agent (phase-compaction.ts) also sees `hasUI === false`, but there the
// parent TUI may be on screen, and writing to stderr would put text into a live
// terminal. That code keeps its own `if (ctx.hasUI)` guards.

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type NotifyLevel = "info" | "warning" | "error";

/** Whether `ctx` still belongs to the live session. See the module comment. */
export function isCtxLive(ctx: ExtensionContext | ExtensionCommandContext): boolean {
	try {
		return typeof ctx.cwd === "string";
	} catch {
		return false;
	}
}

/**
 * Format a notification for a stream. Exported so tests pin the shape a script
 * would parse: one line, prefixed, level visible.
 */
export function formatStreamNotification(message: string, level: NotifyLevel): string {
	return `[codecarto] ${level}: ${message}\n`;
}

/**
 * Notify through `ctx`: the TUI when there is one, stderr when there is not,
 * nothing when the ctx is stale.
 */
export function notifyCtx(
	ctx: ExtensionContext | ExtensionCommandContext,
	message: string,
	level: NotifyLevel,
	stream: { write(chunk: string): unknown } = process.stderr,
): void {
	if (!isCtxLive(ctx)) return;
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	stream.write(formatStreamNotification(message, level));
}
