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
	"",
	"### How to drive a run",
	"",
	"`/codecarto-next` takes flags that change how much runs and how each phase is seeded. They are independent: `--auto` decides *how many phases run*, `--llm-steer` decides *what prompt each one gets*.",
	"",
	"| Invocation | What it does |",
	"| --- | --- |",
	"| `/codecarto-next` | Runs the next eligible phase, once. Good for watching a single phase or retrying one that stopped. |",
	"| `/codecarto-next --auto` | Runs every remaining phase back to back, validating and completing each before starting the next. Stops on a validation failure or a sub-agent error. |",
	"| `/codecarto-next --auto --llm-steer` | The same, with each phase's prompt rewritten from the previous phase's closeout. **This is the usual choice for a full run** — it is what makes phase N+1 aware of what phase N found. |",
	"| `/codecarto-next --auto --strict --llm-steer` | The same, but also stops on `PASS WITH GAPS` instead of advancing through it. Use when gaps should be reviewed rather than carried forward. |",
	"",
	"Notes worth passing on when the user asks:",
	"",
	"- **The first phase is never steered** — there is no previous closeout to steer from, so it reports `LLM rewriter skipped (no previous phase to steer from)` and uses the stock prompt. That message is normal, not a failure.",
	"- **Steering costs an extra model call per phase**, on top of the phase sub-agent itself.",
	"- `--strict` is only valid with `--auto`; on its own it is an error.",
	"- `--no-llm-steer` forces steering off for one invocation when the workspace config has it on (`orchestrator.llm_steer_next_phase`, default off).",
	"- **An auto run that stops says why in its summary block.** If a phase produced its artifact but the pipeline still shows it incomplete, read the `Auto pipeline stopped at …` message rather than assuming the phase failed — the phase usually succeeded and something after it did not.",
	"",
	"If the user has just initialized a workspace and has not said what they want, tell them the run command rather than waiting to be asked: `/codecarto-next --auto --llm-steer` for a full pass, or plain `/codecarto-next` to watch one phase first.",
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
