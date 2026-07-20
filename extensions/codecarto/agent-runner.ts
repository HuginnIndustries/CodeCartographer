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

// Tools available to the phase sub-agent. Matches the codecarto interception
// allowlist (SAFE_TOOL_NAMES in extensions/codecarto/index.ts), minus bash.
// Phases analyze source code and write findings; they don't need a shell.
const PHASE_TOOL_NAMES = ["read", "edit", "write", "grep", "find", "ls"];

export interface PhaseRunCallbacks {
	onSessionCreated?: (session: AgentSession) => void;
	onToolStart?: (toolCallId: string, toolName: string) => void;
	onToolEnd?: (toolCallId: string, toolName: string) => void;
	onTextDelta?: (delta: string, fullText: string) => void;
	onTurnEnd?: (turnCount: number) => void;
	onMessageEnd?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	onCompactionEnd?: (event: { reason: "manual" | "threshold" | "overflow"; successful: boolean; aborted: boolean }) => void;
}

export interface PhaseRunOptions {
	/** Display name written via appendSessionInfo so the session shows up in
	 *  /resume's picker as e.g. "CodeCartographer phase: blueprint". Pi reads
	 *  it via SessionManager.getSessionName(). */
	sessionName?: string;
}

export interface PhaseRunResult {
	session: AgentSession;
	responseText: string;
	toolUses: number;
	turnCount: number;
	aborted: boolean;
	/** Path to the on-disk session file (under ~/.pi/agent/sessions/<encoded-cwd>/).
	 *  Stable across the run; useful for /codecarto-usage and any future tooling
	 *  that wants to point at the phase's transcript. */
	sessionFile: string | undefined;
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

	// Resource loader: load Pi extensions and skills (so codecarto's own tool
	// interception applies to the child) but skip prompt templates, themes,
	// and project context files — they'd just bloat the system prompt.
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: false,
		noSkills: false,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
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
		sessionManager,
		settingsManager: SettingsManager.create(cwd, agentDir),
		model: ctx.model,
		tools: PHASE_TOOL_NAMES,
		resourceLoader: loader,
	});

	await session.bindExtensions({});

	callbacks.onSessionCreated?.(session);

	let toolUses = 0;
	let turnCount = 0;
	let currentMessageText = "";
	let aborted = false;

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
	} finally {
		unsubscribe();
		abortCleanup();
	}

	return {
		session,
		responseText: getLastAssistantText(session) || currentMessageText,
		toolUses,
		turnCount,
		aborted,
		sessionFile: sessionManager.getSessionFile(),
	};
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
