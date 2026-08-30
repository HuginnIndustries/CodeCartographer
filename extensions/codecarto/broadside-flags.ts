// Argument parser for /codecarto-broadside. The grammar is one optional
// action followed by lens names and flags, in any order:
//
//   /codecarto-broadside                              → submit, default lenses
//   /codecarto-broadside submit architecture security → submit, two lenses
//   /codecarto-broadside collect --wait=900
//   /codecarto-broadside status
//   /codecarto-broadside models --benchmarks
//
// Flags mirror the codecarto_broadside tool parameters, with the negative
// forms spelled out because a slash command has no place to pass `false`:
//   --incremental          --no-synthesis
//   --max-cost=N           --no-triage
//   --wait=SECONDS         --no-retry-truncated
//   --benchmarks (models only)
//
// The parser never throws. index.ts decides how to surface unknown tokens and
// invalid combinations, matching parseNextFlags.

import { BROADSIDE_LENS_IDS, type BroadsideLensId } from "../../core/index.ts";

export type BroadsideAction = "submit" | "collect" | "status" | "models";

export interface BroadsideFlags {
	action: BroadsideAction;
	/** Empty means "the repository's default lens set". */
	lenses: BroadsideLensId[];
	incremental: boolean;
	includeSynthesis?: boolean;
	includeTriage?: boolean;
	retryTruncated?: boolean;
	/** Undefined means "use the repository's config default". */
	maxCost?: number;
	waitSeconds?: number;
	benchmarks: boolean;
	unknown: string[];
	/** Set on an invalid combination. The caller surfaces it as an error. */
	error?: string;
}

const ACTIONS = new Set<BroadsideAction>(["submit", "collect", "status", "models"]);

/** Every token the completer offers, in the order it offers them. */
export const KNOWN_BROADSIDE_TOKENS = [
	"submit",
	"collect",
	"status",
	"models",
	...BROADSIDE_LENS_IDS,
	"--incremental",
	"--max-cost=",
	"--wait=",
	"--no-synthesis",
	"--no-triage",
	"--no-retry-truncated",
	"--benchmarks",
] as const;

// A numeric flag with a missing or unparseable value is an error, not a
// silent fallback to the config default: "--max-cost=" almost certainly means
// the user meant to cap the spend and mistyped it.
function parseNumeric(token: string, name: string, result: BroadsideFlags): number | undefined {
	const raw = token.slice(name.length + 1);
	const value = Number(raw);
	if (!raw || !Number.isFinite(value) || value < 0) {
		result.error = `${name} needs a non-negative number (got "${raw}").`;
		return undefined;
	}
	return value;
}

export function parseBroadsideFlags(args: string): BroadsideFlags {
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	const result: BroadsideFlags = {
		action: "submit",
		lenses: [],
		incremental: false,
		benchmarks: false,
		unknown: [],
	};

	let actionSeen = false;
	for (const token of tokens) {
		if (!actionSeen && ACTIONS.has(token as BroadsideAction)) {
			result.action = token as BroadsideAction;
			actionSeen = true;
			continue;
		}
		if (BROADSIDE_LENS_IDS.includes(token as BroadsideLensId)) {
			// A lens named twice is one lens, not two batches of it.
			if (!result.lenses.includes(token as BroadsideLensId)) result.lenses.push(token as BroadsideLensId);
			continue;
		}
		if (token === "--incremental") { result.incremental = true; continue; }
		if (token === "--no-synthesis") { result.includeSynthesis = false; continue; }
		if (token === "--no-triage") { result.includeTriage = false; continue; }
		if (token === "--no-retry-truncated") { result.retryTruncated = false; continue; }
		if (token === "--benchmarks") { result.benchmarks = true; continue; }
		if (token.startsWith("--max-cost=")) { result.maxCost = parseNumeric(token, "--max-cost", result); continue; }
		if (token.startsWith("--wait=")) { result.waitSeconds = parseNumeric(token, "--wait", result); continue; }
		result.unknown.push(token);
	}

	// Flags that only mean something for one action are refused rather than
	// ignored: silently dropping --incremental on a collect would read as
	// "collected incrementally", which is not a thing.
	if (result.lenses.length > 0 && result.action !== "submit") {
		result.error ??= `Lens names are only meaningful for submit (got action "${result.action}").`;
	}
	if (result.incremental && result.action !== "submit") {
		result.error ??= `--incremental is only meaningful for submit (got action "${result.action}").`;
	}
	if (result.benchmarks && result.action !== "models") {
		result.error ??= `--benchmarks is only meaningful for models (got action "${result.action}").`;
	}
	if (result.action === "status" && result.waitSeconds !== undefined) {
		result.error ??= "--wait is only meaningful for submit and collect; status reads recorded state.";
	}

	return result;
}
