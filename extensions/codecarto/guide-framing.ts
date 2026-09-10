// Surface framing for the packaged agent guide when it is read into a Pi
// session.
//
// Two problems this solves, both invisible on the MCP surface:
//
// 1. The guide arrives as a user message. /codecarto-guide queues the document
//    through pi.sendUserMessage, so ~200 lines of imperative instructions land
//    as if the user had typed them, with no task attached. A model handed
//    instructions and no task either starts driving immediately or stalls
//    asking what to do; both are wrong for what is a reference lookup.
//
// 2. The guide is written for the MCP surface. It tells the agent to call
//    codecarto_* tools — but the Pi extension registers no tools at all, only
//    slash commands the *user* invokes. A model that tries to follow it finds
//    nothing to call and reasonably concludes the server is missing. The drive
//    loop differs too: on Pi, /codecarto-next runs the phase as an isolated
//    sub-agent and then auto-validates and auto-completes it, so the guide's
//    hand-written execute → handoff → validate → complete loop does not
//    describe a Pi session.
//
// The guide text itself stays untouched — agent-skill/ is the single source and
// core/guide.ts serves it verbatim to every surface. Per-surface adaptation
// belongs in the wrapper, which is here.

/** Tool names in the guide that have no Pi slash command. */
export const MCP_ONLY_TOOLS = ["codecarto_library_list", "codecarto_library_reindex"] as const;

export const GUIDE_PREAMBLE = [
	"**CodeCartographer guide — reference material, not a task.**",
	"",
	"The user ran `/codecarto-guide`, which queues the guide below into this session so it is available when needed. Nothing is being asked of you yet.",
	"",
	"Do not start a workflow, do not begin a phase, and do not ask which repository or pipeline to use. Acknowledge in a sentence that you have read it, then wait. Answer from it when the user asks.",
].join("\n");

export const PI_SURFACE_ADDENDUM = [
	"---",
	"",
	"## Reading this guide in a Pi session",
	"",
	"The guide above is written for the MCP surface, where an agent drives the workflow by calling `codecarto_*` tools. **This session is the Pi extension, which registers no tools.** There is nothing named `codecarto_*` for you to call, and their absence does not mean a server is missing or misconfigured.",
	"",
	`- **Every tool name maps to a slash command the user runs**, mechanically: \`codecarto_status\` → \`/codecarto-status\`, \`codecarto_next\` → \`/codecarto-next\`, and so on. Two have no Pi equivalent: ${MCP_ONLY_TOOLS.map((name) => `\`${name}\``).join(" and ")}.`,
	"- **Ignore \"every tool takes an absolute `cwd`\".** Slash commands act on the session's own directory; there is no `cwd` argument to pass.",
	"- **The drive loop is different.** `/codecarto-next` executes the phase itself, as an isolated sub-agent, and then auto-validates and auto-completes it. The guide's hand-written loop — take the prompt, execute it, write the handoff, then validate and complete yourself — describes the MCP surface. On Pi the user drives and the extension executes; your job is to explain what the framework is doing and answer questions about it, not to reproduce that loop by hand.",
].join("\n");

/**
 * Assemble the message /codecarto-guide queues. The guide document is embedded
 * whole and unmodified between the framing and the addendum — `guide.test.mjs`
 * pins that documents are served entire rather than summarized, and that holds
 * on this surface too.
 */
export function buildPiGuideMessage(documentContent: string, otherTopics: readonly string[]): string {
	const footer = otherTopics.length > 0
		? `\n\n---\nOther guide topics: ${otherTopics.join(", ")} (run /codecarto-guide <topic>).`
		: "";
	return `${GUIDE_PREAMBLE}\n\n---\n\n${documentContent}\n\n${PI_SURFACE_ADDENDUM}${footer}`;
}
