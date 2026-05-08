// Flag parser for /codecarto-next. The user invokes the slash command with
// an optional "--llm-steer" or "--no-llm-steer" override. We parse and
// validate; index.ts decides how to merge the override with workspace
// config to compute the effective "should we run the LLM rewriter?" bit.

export interface NextFlags {
	llmSteerOverride?: boolean;
	unknown: string[];
}

const KNOWN = new Set(["--llm-steer", "--no-llm-steer"]);

export function parseNextFlags(args: string): NextFlags {
	const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
	const result: NextFlags = { unknown: [] };
	for (const t of tokens) {
		if (t === "--llm-steer") result.llmSteerOverride = true;
		else if (t === "--no-llm-steer") result.llmSteerOverride = false;
		else result.unknown.push(t);
	}
	return result;
}

export const KNOWN_NEXT_FLAGS = [...KNOWN] as const;
