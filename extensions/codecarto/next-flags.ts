// Flag parser for /codecarto-next. Recognized flags:
//   --llm-steer / --no-llm-steer  — override the workspace config's
//                                    llm_steer_next_phase per invocation.
//   --auto                          — run the entire pipeline end-to-end.
//   --strict                        — only with --auto; stop on PASS WITH GAPS
//                                    instead of auto-advancing.
//
// The parser returns a populated NextFlags shape and never throws. index.ts
// decides how to surface errors (unknown flags + invalid combinations) and
// how to compose --llm-steer with workspace config.

export interface NextFlags {
	llmSteerOverride?: boolean;
	auto: boolean;
	strict: boolean;
	unknown: string[];
	/** Set when --strict is passed without --auto. Caller surfaces as an error. */
	error?: string;
}

const KNOWN = new Set(["--llm-steer", "--no-llm-steer", "--auto", "--strict"]);

export function parseNextFlags(args: string): NextFlags {
	const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
	const result: NextFlags = { auto: false, strict: false, unknown: [] };
	for (const t of tokens) {
		if (t === "--llm-steer") result.llmSteerOverride = true;
		else if (t === "--no-llm-steer") result.llmSteerOverride = false;
		else if (t === "--auto") result.auto = true;
		else if (t === "--strict") result.strict = true;
		else result.unknown.push(t);
	}
	if (result.strict && !result.auto) {
		result.error = "Flag --strict requires --auto.";
	}
	return result;
}

export const KNOWN_NEXT_FLAGS = [...KNOWN] as const;
