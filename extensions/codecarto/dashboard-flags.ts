// Flag parser for /codecarto-dashboard. The user invokes the slash command
// with an optional "--narrate" flag to trigger the opt-in LLM narrator.
// Same shape and discipline as next-flags.ts so future flags slot in
// without refactoring.

export interface DashboardFlags {
	narrate: boolean;
	unknown: string[];
}

const KNOWN = new Set(["--narrate"]);

export function parseDashboardFlags(args: string): DashboardFlags {
	const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
	const result: DashboardFlags = { narrate: false, unknown: [] };
	for (const t of tokens) {
		if (t === "--narrate") result.narrate = true;
		else result.unknown.push(t);
	}
	return result;
}

export const KNOWN_DASHBOARD_FLAGS = [...KNOWN] as const;
