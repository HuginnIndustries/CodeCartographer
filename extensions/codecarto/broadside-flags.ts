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
//   --no-incremental       --no-triage
//   --max-cost=N           --no-retry-truncated
//   --wait=SECONDS         --benchmarks (models only)
//
// --incremental has a spelled-out negative because the value is tri-state:
// absent defers to config.yaml, so a repository that set `incremental: true`
// can still ask for a one-off full scan (#163), exactly as an MCP caller can
// with `incremental: false`.
//
// The parser never throws. index.ts decides how to surface unknown tokens and
// invalid combinations, matching parseNextFlags.

import { BROADSIDE_LENS_IDS, type BroadsideLensId } from "../../core/index.ts";

export type BroadsideAction = "submit" | "collect" | "status" | "models";

export interface BroadsideFlags {
	action: BroadsideAction;
	/** Empty means "the repository's default lens set". */
	lenses: BroadsideLensId[];
	/**
	 * Undefined means "use the repository's config default". --incremental sets
	 * true and --no-incremental sets false, so a config-set `incremental: true`
	 * can be overridden back to a full scan for one run (#163).
	 */
	incremental?: boolean;
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
	"--no-incremental",
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
		if (token === "--incremental" || token === "--no-incremental") {
			const value = token === "--incremental";
			// Last-one-wins would be a silent tiebreak on a command that spends
			// money; a contradiction is an error.
			if (result.incremental !== undefined && result.incremental !== value) {
				result.error ??= "--incremental and --no-incremental contradict each other; pass one or neither.";
			}
			result.incremental = value;
			continue;
		}
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
	// "collected incrementally", which is not a thing (and --no-incremental
	// would read as a full re-collect, which is not one either).
	if (result.lenses.length > 0 && result.action !== "submit") {
		result.error ??= `Lens names are only meaningful for submit (got action "${result.action}").`;
	}
	if (result.incremental !== undefined && result.action !== "submit") {
		const flag = result.incremental ? "--incremental" : "--no-incremental";
		result.error ??= `${flag} is only meaningful for submit (got action "${result.action}").`;
	}
	if (result.benchmarks && result.action !== "models") {
		result.error ??= `--benchmarks is only meaningful for models (got action "${result.action}").`;
	}
	if (result.action === "status" && result.waitSeconds !== undefined) {
		result.error ??= "--wait is only meaningful for submit and collect; status reads recorded state.";
	}

	return result;
}
