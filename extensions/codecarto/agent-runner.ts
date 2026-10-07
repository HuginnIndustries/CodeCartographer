// Sub-agent runner for codecarto phases. Spawns an in-memory AgentSession
// using the SDK's createAgentSession() (NOT ctx.newSession() — that replaces
// the active TUI session, which is not what we want). Subscribes to the
// session's event stream and forwards events to caller-provided callbacks
// so a parent UI (the agents widget; M2) can render live progress while the
// phase runs in parallel with the orchestrator.
//
// The runner is intentionally minimal: no memory tools, no append-mode
// system prompt, no parent-context inheritance, no turn-limit grace logic.
// Codecarto phases are bounded by their phase prompt and validation gate;
// they don't need the full subagent-framework machinery.

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { canonicalPath, isWithinPath } from "../../core/index.ts";
import { createChildModelRuntime } from "./child-model-runtime.ts";
import { phaseCompactionExtension } from "./phase-compaction.ts";

// Tools available to the phase sub-agent. Matches the codecarto interception
// allowlist (SAFE_TOOL_NAMES in extensions/codecarto/index.ts), minus bash.
// Phases analyze source code and write findings; they don't need a shell.
const PHASE_TOOL_NAMES = ["read", "edit", "write", "grep", "find", "ls"];
const COMPACTION_SETTLE_TIMEOUT_MS = 30_000;

export function needsPhaseContinuation(messages: ReadonlyArray<{ role: string; stopReason?: string }>): boolean {
	const last = messages.at(-1);
	if (!last) return false;
	return last.role === "toolResult" || (last.role === "assistant" && last.stopReason === "toolUse");
}

export function shouldContinuePhase(
	messages: ReadonlyArray<{ role: string; stopReason?: string }>,
	primaryOutputPresent: boolean,
): boolean {
	return !primaryOutputPresent || needsPhaseContinuation(messages);
}

export async function primaryOutputExists(cwd: string, primaryOutput: string): Promise<boolean> {
	const workspaceRoot = await canonicalPath(join(cwd, ".codecarto"));
	const candidate = await canonicalPath(resolve(workspaceRoot, primaryOutput));
	if (!isWithinPath(candidate, workspaceRoot)) return false;
	return access(candidate).then(() => true, () => false);
}

export function buildPhaseContinuationPrompt(compacted: boolean): string {
	const recovery = compacted
		? "Continue the current CodeCartographer phase from the compacted context and durable checkpoint."
		: "The previous phase run stopped before finalizing its required output. Continue from the current session context.";
	return `${recovery} Finish the declared primary output, validation block, status updates, and closeout before ending.`;
}

export async function waitForCompaction(
	compactionCompleted: Promise<boolean>,
	timeoutMs: number = COMPACTION_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			compactionCompleted,
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface PhaseRunCallbacks {
	onToolStart?: (toolCallId: string, toolName: string) => void;
	onToolEnd?: (toolCallId: string, toolName: string) => void;
	onTextDelta?: (delta: string, fullText: string) => void;
	onTurnEnd?: (turnCount: number) => void;
	onMessageEnd?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	onCompactionEnd?: (event: { reason: "manual" | "threshold" | "overflow"; successful: boolean; aborted: boolean }) => void;
	/** The handoff check refused the handoff; a repair turn is about to run. */
	onHandoffRefused?: (refusal: string) => void;
}

export interface PhaseRunOptions {
	/** Display name written via appendSessionInfo so the session shows up in
	 *  /resume's picker as e.g. "CodeCartographer phase: blueprint". Pi reads
	 *  it via SessionManager.getSessionName(). */
	sessionName?: string;
	/** Primary output relative to `.codecarto/`; used to detect provider runs
	 * that stop normally before writing their required artifact. */
	primaryOutput?: string;
	/**
	 * Would completion accept the phase handoff as it stands? Returns the
	 * refusal completion would give, or null when it would accept. Called
	 * once the primary output exists; a refusal gets one repair turn (#454).
	 */
	checkHandoff?: () => Promise<string | null>;
}

export interface PhaseRunResult {
	responseText: string;
	toolUses: number;
	turnCount: number;
	aborted: boolean;
	/** Path to the on-disk session file (under ~/.pi/agent/sessions/<encoded-cwd>/).
	 *  Stable across the run; useful for /codecarto-usage and any future tooling
	 *  that wants to point at the phase's transcript. */
	sessionFile: string | undefined;
	/** The handoff refusal that triggered the repair turn, when one ran. */
	handoffRefusal?: string;
}

/** The slice of an AgentSession the end-of-phase logic drives. */
export interface PhaseFinishSession {
	prompt(text: string): Promise<unknown>;
	readonly messages: ReadonlyArray<{ role: string; stopReason?: string }>;
}

export interface PhaseFinishOptions {
	cwd: string;
	primaryOutput?: string;
	checkHandoff?: () => Promise<string | null>;
	onHandoffRefused?: (refusal: string) => void;
	/** Settles true when a compaction ran during the phase prompt. */
	compactionCompleted: Promise<boolean>;
	isAborted: () => boolean;
}

/**
 * What runs after the phase prompt returns, while the child session is still
 * live: at most one continuation when the run stopped before its primary
 * output existed, then at most one handoff repair turn. Each is a single
 * prompt, never a loop — a model that cannot finish in one more turn is a
 * stop for the caller to report, not something to retry indefinitely.
 */
export async function finishPhaseSession(session: PhaseFinishSession, options: PhaseFinishOptions): Promise<{ handoffRefusal?: string }> {
	const outputPresent = () => (options.primaryOutput ? primaryOutputExists(options.cwd, options.primaryOutput) : Promise.resolve(true));
	if (!options.isAborted() && shouldContinuePhase(session.messages, await outputPresent())) {
		const compacted = await waitForCompaction(options.compactionCompleted);
		if (!options.isAborted()) await session.prompt(buildPhaseContinuationPrompt(compacted));
	}
	// The handoff is judged only once the phase has its output: without one the
	// phase failed on its own terms, and validation reports that, not this.
	if (options.isAborted() || !options.checkHandoff || !(await outputPresent())) return {};
	const refusal = await options.checkHandoff();
	if (!refusal || options.isAborted()) return {};
	options.onHandoffRefused?.(refusal);
	await session.prompt(buildHandoffRepairPrompt(refusal));
	return { handoffRefusal: refusal };
}

/**
 * The one repair turn a refused handoff gets (#454). The refusal is passed
 * verbatim: every completion refusal already names the field, the entry, and
 * the shape it would accept, and paraphrasing it would only lose that.
 */
export function buildHandoffRepairPrompt(refusal: string): string {
	return [
		"CodeCartographer checked this phase's handoff before completion, and completion would refuse it:",
		"",
		refusal,
		"",
		"Fix the phase handoff under .codecarto/scratch/handoffs/ so completion accepts it, following the shape in .codecarto/templates/phase-handoff.yaml.",
		"Change only what the refusal names. Do not redo the analysis, and do not edit the primary output unless the refusal requires it.",
		"Then end the phase.",
	].join("\n");
}

/**
 * Run one CodeCartographer phase as an isolated AgentSession. Awaiting this
 * function blocks until the phase completes (or aborts via signal). The
 * orchestrator's TUI stays active throughout — only the phase's own context
 * window holds the tool calls and reasoning.
 *
 * The phase session is **persisted** to the default Pi session directory
 * (`~/.pi/agent/sessions/<encoded-cwd>/`), the same directory the orchestrator
 * uses, so Pi's `/resume`, `/tree`, and `/export` see phase transcripts as
 * first-class sessions. They're tagged via `appendSessionInfo` (display name)
 * and `parentSession` (the orchestrator's session file path) so the picker
 * shows lineage.
 */
export async function runPhase(
	ctx: ExtensionContext,
	prompt: string,
	callbacks: PhaseRunCallbacks = {},
	options: PhaseRunOptions = {},
	signal?: AbortSignal,
): Promise<PhaseRunResult> {
	const cwd = ctx.cwd;
	const agentDir = getAgentDir();

	// Resource loader: isolate the child from global extensions/skills and load
	// only CodeCartographer's inline phase guards and compaction hooks. This
	// avoids duplicate registration when CodeCartographer is globally installed
	// while preserving the same safety when it was loaded explicitly with -e.
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [phaseCompactionExtension],
	});
	await loader.reload();

	// File-backed session in the same directory the orchestrator's TUI uses.
	// Pi's /resume, /tree, and /export read this directory, so phase
	// transcripts become first-class browsable artifacts. Tag with
	// parentSession (orchestrator's file) for lineage and a session_info
	// display name so the picker can identify them at a glance.
	const sessionManager = SessionManager.create(cwd);
	const orchestratorSessionFile = ctx.sessionManager.getSessionFile();
	if (orchestratorSessionFile) {
		// SessionManager.create() calls newSession() with no options in its
		// constructor; rewrite the header to attach the parent before the
		// session ever flushes to disk.
		sessionManager.newSession({ parentSession: orchestratorSessionFile });
	}
	if (options.sessionName) {
		sessionManager.appendSessionInfo(options.sessionName);
	}

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: await createChildModelRuntime(ctx, agentDir),
		sessionManager,
		settingsManager: SettingsManager.create(cwd, agentDir),
		model: ctx.model,
		tools: PHASE_TOOL_NAMES,
		resourceLoader: loader,
	});

	await session.bindExtensions({});

	let toolUses = 0;
	let turnCount = 0;
	let currentMessageText = "";
	let aborted = false;
	let resolveCompaction: ((completed: boolean) => void) | undefined;
	const compactionCompleted = new Promise<boolean>((resolve) => { resolveCompaction = resolve; });

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "tool_execution_start": {
				toolUses++;
				const id = (event as { toolCallId?: string }).toolCallId ?? `${event.toolName}-${toolUses}`;
				callbacks.onToolStart?.(id, event.toolName);
				break;
			}
			case "tool_execution_end": {
				const id = (event as { toolCallId?: string }).toolCallId ?? `${event.toolName}-${toolUses}`;
				callbacks.onToolEnd?.(id, event.toolName);
				break;
			}
			case "turn_end": {
				turnCount++;
				callbacks.onTurnEnd?.(turnCount);
				break;
			}
			case "message_start": {
				currentMessageText = "";
				break;
			}
			case "message_update": {
				if (event.assistantMessageEvent?.type === "text_delta") {
					currentMessageText += event.assistantMessageEvent.delta;
					callbacks.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					const u = (event.message as { usage?: { input?: number; output?: number; cacheWrite?: number } }).usage;
					if (u) {
						callbacks.onMessageEnd?.({
							input: u.input ?? 0,
							output: u.output ?? 0,
							cacheWrite: u.cacheWrite ?? 0,
						});
					}
				}
				break;
			}
			case "compaction_end": {
				const compactEvent = event as AgentSessionEvent & {
					reason: "manual" | "threshold" | "overflow";
					result?: unknown;
					aborted: boolean;
					errorMessage?: string;
				};
				callbacks.onCompactionEnd?.({
					reason: compactEvent.reason,
					successful: compactEvent.result !== undefined && compactEvent.result !== null && !compactEvent.aborted && !compactEvent.errorMessage,
					aborted: compactEvent.aborted,
				});
				resolveCompaction?.(true);
				break;
			}
		}
	});

	let abortCleanup = () => {};
	if (signal) {
		const onAbort = () => {
			aborted = true;
			session.abort();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		abortCleanup = () => signal.removeEventListener("abort", onAbort);
	}

	try {
		await session.prompt(prompt);
		// If no compaction fired during the run, the promise above would
		// otherwise strand the continuation path for the full settle timeout
		// (#129). Settle it with what actually happened — resolve() is
		// idempotent, so a real compaction_end event earlier in the run
		// keeps its `true`.
		resolveCompaction?.(false);
		const { handoffRefusal } = await finishPhaseSession(session, {
			cwd,
			primaryOutput: options.primaryOutput,
			checkHandoff: options.checkHandoff,
			onHandoffRefused: callbacks.onHandoffRefused,
			compactionCompleted,
			isAborted: () => aborted,
		});
		return {
			responseText: getLastAssistantText(session) || currentMessageText,
			toolUses,
			turnCount,
			aborted,
			sessionFile: sessionManager.getSessionFile(),
			...(handoffRefusal !== undefined && { handoffRefusal }),
		};
	} finally {
		unsubscribe();
		abortCleanup();
		// The child is done, on every path. Dispose aborts whatever it still
		// has in flight, drops its agent subscription and listeners, and runs
		// the per-session resource cleanups extensions registered — a seven
		// phase auto run used to keep all of that for every phase, rewrite,
		// and narration until the process exited (#256). Nothing reads the
		// session after this: the result carries the text and the file path.
		disposeChildSession(session);
	}
}

/**
 * Dispose a child session, swallowing whatever dispose throws: the work is
 * done and its result is already in hand, so a failing cleanup hook must not
 * turn a finished phase into an error.
 */
export function disposeChildSession(session: Pick<AgentSession, "dispose">): void {
	try {
		session.dispose();
	} catch {
		// nothing to do with a cleanup failure but move on
	}
}

/**
 * Walk session.messages backward to find the last non-empty assistant text.
 * Used as a fallback when text_delta streaming missed something or the final
 * message arrived in a single chunk.
 */
function getLastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i];
		if (msg.role !== "assistant") continue;
		// Assistant content is always a content-block array per SDK types.
		const blocks = msg.content as Array<{ type?: string; text?: string }>;
		const parts: string[] = [];
		for (const c of blocks) {
			if (c.type === "text" && c.text) parts.push(c.text);
		}
		const joined = parts.join("\n").trim();
		if (joined) return joined;
	}
	return "";
}
