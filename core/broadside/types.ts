// Broad-Side types: repository info, slices, batch requests and entries, runs, state, config, results, errors; the reasoning defaults.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { type BroadsideLensId } from "./constants.ts";

// ---------- types ----------

export type ModelPricing = {
	/** USD per million input tokens. */
	inputPerM: number;
	/** USD per million output tokens. */
	outputPerM: number;
	/** Where the numbers came from — affects what the submit text claims. */
	source: "built-in" | "config" | "live" | "cache";
};

/** The subset of the OpenRouter model catalog Broad-Side actually uses. */
export type CatalogEntry = {
	id: string;
	name: string;
	inputPerM: number;
	outputPerM: number;
	cachedInputPerM?: number;
	contextLength?: number;
	maxCompletionTokens?: number;
	/** Empty array means unknown, not "supports nothing". */
	supportedParameters: string[];
	expirationDate?: string | null;
};

export type CodingBenchmarks = {
	/** Base model slug (batch suffix stripped) → indices. */
	byBaseSlug: Record<string, { codingIndex?: number; intelligenceIndex?: number }>;
	/** Citation/attribution metadata from the benchmarks endpoint. */
	meta: Record<string, unknown>;
};

export type BroadsideCatalogResult = {
	model: string;
	source: "built-in" | "config" | "live" | "cache";
	/**
	 * Always resolved. `resolveCatalogEntry` either returns an entry — from
	 * config, cache, the live catalog, or the compile-time fallback — or throws
	 * naming the model it could not price. This was declared nullable, which is
	 * the only reason the single consumer needed a non-null assertion to read it.
	 */
	entry: CatalogEntry;
	benchmarks?: CodingBenchmarks;
};

export type JsonSchemaDef = {
	name: string;
	strict: boolean;
	schema: Record<string, unknown>;
};

/**
 * Where the file list and the file contents both came from — one source, so
 * a run's results correspond to one state of the repository (#248).
 * `working-tree`: git's view of the checkout (tracked plus untracked files,
 * ignore rules applied, files deleted on disk left out); `walk`: a bounded
 * directory walk, for a target that is not a git repository.
 */
export type RepoSnapshotSource = "working-tree" | "walk";

export type RepoInfo = {
	name: string;
	path: string;
	language: string;
	manifest: { path: string; content: string } | null;
	mainFile: string;
	readmeFirst: string;
	fileTree: string;
	fileCounts: Record<string, number>;
	sourceGlob: string;
	sourceExts: string[];
	/** How many slurpable files carry one of `sourceExts`; zero means no lens has code to scan. */
	sourceFileCount: number;
	snapshot: RepoSnapshotSource;
	/** Files left out of every lens because their name says they hold secrets (#252). */
	secretFilesSkipped: string[];
	/** Secret-like values redacted from the entry point, manifest, and README excerpt. */
	redactedValues: number;
};

export type FileSlice = {
	moduleName: string;
	content: string;
	fileCount: number;
	chars: number;
	/** Repo-relative paths of the files folded into this slice. */
	files: string[];
	/** Secret-like values redacted from this slice's files before upload (#252). */
	redactedValues?: number;
	/** The files in this slice that had at least one value redacted. */
	redactedFiles?: string[];
	/**
	 * Set when the lens's targeted globs matched nothing and the slice was
	 * built from its fallback globs instead (#319). The estimate, the batch
	 * entry, and the prompt all say so.
	 */
	fallback?: string;
};

/**
 * OpenRouter's unified `reasoning` control, as sent on a lens request.
 *
 * Left unsent, each model applies its own default — which is how a
 * reasoning-capable model came to spend 5,758 of a 6,000-token output budget
 * thinking, leaving ~230 tokens for JSON that then truncated mid-structure. The
 * thinking is billed at the full *output* rate, so the run paid for roughly
 * 6,000 output tokens per slice to receive 230 usable ones.
 */
export type BroadsideReasoning = { enabled?: boolean; effort?: "minimal" | "low" | "medium" | "high"; max_tokens?: number };

/**
 * The reasoning control every lens request carries: low effort.
 *
 * It used to be a token cap — `max_tokens` at a quarter of the lens's output
 * budget, so three quarters stayed for the answer. Measured live on
 * `google/gemini-3.8-flash:batch` (0.22.0 verification, defect lens, cap
 * 5,800 of a 6,000 budget): the model reasoned 5,218 tokens on the first
 * pass and **11,518 under the same cap** on the doubled-budget retry —
 * thinking scaled with `max_tokens` and the cap changed nothing, both
 * results truncated, and the retry cost twice the original for no JSON.
 * The same lens with `effort: "low"` reasoned 0 tokens, finished with
 * `stop`, returned valid JSON, and cost a twelfth as much. Gemini 3.x
 * models take a thinking *level*, not a budget, and OpenRouter forwards a
 * `max_tokens` cap to them as nothing at all; `effort` is what it can
 * translate for every provider (a level where the provider has levels, a
 * fraction of the budget where it takes a budget). So the default asks for
 * little thinking in the one vocabulary that reaches everyone.
 *
 * Deliberately not `enabled: false`: `google/gemini-3.8-flash:batch` refuses
 * the whole batch with *"Reasoning is mandatory for this endpoint and cannot
 * be disabled"*, turning a partial result into none at all. Low effort works
 * whether or not a provider allows reasoning to be switched off.
 */
export const BROADSIDE_DEFAULT_REASONING: Readonly<BroadsideReasoning> = Object.freeze({ effort: "low" });

/** The reasoning control a lens request carries when config.yaml sets none. */
export function defaultReasoningFor(): BroadsideReasoning {
	return { ...BROADSIDE_DEFAULT_REASONING };
}

/**
 * The reasoning control a truncated slice is re-submitted with.
 *
 * A truncation on a reasoning-capable model is usually thinking that ate the
 * answer's budget, and doubling `max_tokens` doubles the thinking where the
 * provider ignores a token cap (see {@link BROADSIDE_DEFAULT_REASONING}). The
 * retry therefore asks for low effort as well, replacing a `max_tokens` cap
 * (OpenRouter refuses a request carrying both) and lowering a higher effort.
 * An explicit `enabled: false` and an effort already at or below low are left
 * as they are.
 */
export function retryReasoningFor(original: BroadsideReasoning | undefined): BroadsideReasoning {
	if (original?.enabled === false) return { ...original };
	if (original?.effort === "minimal" || original?.effort === "low") return { ...original };
	const { max_tokens: _cap, effort: _effort, ...rest } = original ?? {};
	return { ...rest, effort: "low" };
}

export type BatchRequest = {
	custom_id: string;
	body: {
		model: string;
		messages: { role: "system" | "user"; content: string }[];
		response_format: { type: "json_schema"; json_schema: JsonSchemaDef };
		max_tokens: number;
		reasoning?: BroadsideReasoning;
	};
};

export type BatchTerminalStatus = "completed" | "failed" | "expired" | "cancelled";

export type BroadsideBatchEntry = {
	batchId: string;
	requests: number;
	status: string;
	submittedAt: string;
	completedAt?: string;
	estimatedCost: number;
	cost?: number;
	resultCount?: number;
	error?: unknown;
	/** Why a `skipped` lens had nothing to submit: the globs that matched no file. */
	reason?: string;
	/**
	 * Set when the lens scanned its fallback scope because its targeted globs
	 * matched nothing (#319): "no files matched …; scanned all javascript
	 * sources instead". Absent for a targeted scan.
	 */
	fallback?: string;
	/** Set when this lens used a model other than the run default. */
	model?: string;
	/** The completion ceiling of this lens's model; bounds the truncation retry. */
	outputCap?: number;
};

export type BroadsideSynthesisEntry = {
	batchId?: string;
	status: "pending" | "submitted" | "completed" | "failed";
	cost?: number;
	/** Why the pass was retired, when the batch reported one. */
	error?: string;
	/**
	 * How many verification verdicts the pass was built from (#338): the
	 * `verified.json` a `verify` pass wrote before this pass was submitted.
	 * Absent when the pass was built from the lens findings alone.
	 */
	verdicts?: number;
};

/** One triage item — a scouting lead turned into a work-order entry. */
export type TriageItem = {
	title: string;
	severity: string;
	module: string;
	impact: "high" | "medium" | "low";
	difficulty: "high" | "medium" | "low";
	priority: string;
	effort_estimate: string;
	rationale: string;
};

/** The triage post-pass entry: the same shape as synthesis's. */
export type BroadsideTriageEntry = BroadsideSynthesisEntry;

/** Recorded on the run once a verification pass has run (#143); see core/broadside/verify.ts. */
export type BroadsideVerifyEntry = {
	/** `completed`: every selected finding got a verdict; `partial`: the cost cap or an abort stopped it early. */
	status: "completed" | "partial";
	model: string;
	top: number;
	verified: number;
	confirmed: number;
	cost: number;
	at: string;
	/** Secret-like values redacted from the pass's tool output before upload (#358); absent on passes from before it. */
	redactedValues?: number;
};

/** The truncation retry pass of one run: one batch per model (#206). */
export type BroadsideRetryEntry = {
	status: "submitted" | "completed" | "failed";
	batches: Array<{ model: string; batchId: string }>;
	/** When the owning collect claimed the pass (#322). */
	claimedAt: string;
	/** What the retry batches cost, once polled to completion. */
	cost?: number;
	/** Why a retry batch was refused at submit, per model (#370). */
	error?: string;
};

/**
 * The parts of a run that cost money to submit and that exactly one collect
 * may own: the two post-passes and the truncation retry (#322).
 */
export type BroadsideRunSlot = "synthesis" | "triage" | "retry";
export const BROADSIDE_RUN_SLOTS: readonly BroadsideRunSlot[] = ["synthesis", "triage", "retry"];

export type BroadsideRun = {
	id: string;
	createdAt: string;
	model: string;
	lenses: BroadsideLensId[];
	status: "in-flight" | "completed" | "partial" | "failed";
	outputDir: string; // relative to .codecarto/broadside/
	batches: Partial<Record<BroadsideLensId, BroadsideBatchEntry>>;
	synthesis: BroadsideSynthesisEntry;
	triage: BroadsideTriageEntry;
	/**
	 * The truncation retry pass (#133), recorded so that two collects on one
	 * run cannot both submit it (#322). Absent until a collect claims it.
	 */
	retry?: BroadsideRetryEntry;
	/** The verification pass over the top findings, when one has run (#143). */
	verify?: BroadsideVerifyEntry;
	/**
	 * What post-pass results that were later regenerated had cost (#338):
	 * money the run spent that no current entry accounts for.
	 */
	retiredCost?: number;
	totalCost?: number;
	pricing?: ModelPricing;
	maxCost?: number;
	/** The model's completion ceiling, recorded so collect can cap retries. */
	outputCap?: number;
	/** Git HEAD at submit time, for incremental re-scouting (#142). */
	sourceHead?: string | null;
	/** Whether the working tree was dirty at submit time. */
	sourceDirty?: boolean;
	/** When incremental, the previous run's HEAD this run diffs against. */
	baseHead?: string | null;
	/** Where the scanned files and their contents were read from (#248). */
	snapshot?: RepoSnapshotSource;
	/** The language the lenses scanned as. */
	language?: string;
	/** What the secret-redaction pass did before upload (#252); absent on runs from before it. */
	redaction?: { enabled: boolean; values: number; files: number; skippedFiles: number };
};

export type BroadsideStateFile = {
	schema_version: number;
	runs: BroadsideRun[];
};

export type BroadsideConfig = {
	model: string;
	apiKey: string;
	defaultLenses: BroadsideLensId[];
	/** Approximate run expense limit in USD; 0 means no limit. */
	maxCost: number;
	/** Manual pricing overrides (USD per million). Live lookup is preferred. */
	pricing: { inputPerM: number; outputPerM: number } | null;
	/**
	 * Per-lens model overrides. A lens absent here uses `model`. This is how a
	 * repository routes the semantic lenses (security, defect) to a stronger
	 * batch model while the cheap default carries the rest — the whole point of
	 * the cheap model is telling the expensive one where to look, and that
	 * trade-off is not the same for every lens.
	 */
	lensModels: Partial<Record<BroadsideLensId, string>>;
	/** Overrides every lens's reasoning setting when present. */
	reasoning: BroadsideReasoning | null;
	/**
	 * Repo defaults for the per-call run knobs. Each mirrors a tool parameter
	 * of the same name; an explicit parameter always wins. They live here so a
	 * repository can fix its own scouting policy once instead of restating it
	 * on every submit and collect.
	 */
	incremental: boolean;
	retryTruncated: boolean;
	includeSynthesis: boolean;
	includeTriage: boolean;
	/** Default poll budget in seconds; 0 means "return immediately". */
	waitSeconds: number;
	/**
	 * Replace secret-like values with `[REDACTED:<kind>]` and skip files named
	 * like credential stores before anything is uploaded (#252). On by default;
	 * off only for a repository whose maintainers have decided its contents may
	 * leave as they are.
	 */
	redactSecrets: boolean;
};

/**
 * The pre-flight facts a caller needs to decide whether a run is worth its
 * price: what each lens would cost, at what rates, against which limit. Handed
 * to {@link BroadsideSubmitOptions.confirm} before anything is submitted.
 */
export type BroadsideEstimate = {
	model: string;
	pricing: ModelPricing;
	lenses: Array<{
		lensId: BroadsideLensId;
		name: string;
		slices: number;
		maxTokens: number;
		cost: number;
		/** The model this lens would use — `model` unless a per-lens override applies. */
		model: string;
		pricing: ModelPricing;
		/** Set when this lens is priced on its fallback scope (#319); see BroadsideBatchEntry.fallback. */
		fallback?: string;
	}>;
	/** True when at least one lens uses a model other than the run default. */
	mixedModels: boolean;
	totalCost: number;
	inputTokens: number;
	outputTokens: number;
	/** Run expense limit in USD; 0 means no limit. */
	maxCost: number;
	/** True when totalCost is over a non-zero maxCost. */
	exceedsLimit: boolean;
	/** Set when incremental scouting found a baseline to diff against. */
	baseHead: string | null;
	sourceDirty: boolean;
	/** Whether a requested incremental run actually narrowed this estimate. */
	incremental: BroadsideIncrementalOutcome;
	/** The provider's completion ceiling, when the catalog advertises one. */
	outputCap?: number;
};

/**
 * OpenRouter rejected the API key (HTTP 401/403). Thrown from the catalog
 * lookup rather than swallowed into "could not price" or a silent built-in
 * fallback: a run that cannot authenticate cannot submit either, and the
 * message that reaches the user has to say so (#251).
 */
export class BroadsideAuthError extends Error {
	readonly httpStatus: number;
	readonly detail: string;
	constructor(httpStatus: number, detail: string) {
		super(
			`OpenRouter rejected the API key (HTTP ${httpStatus}${detail ? `: ${detail}` : ""}). ` +
			"Check OPENROUTER_API_KEY, the api_key parameter, or api_key in .codecarto/broadside/config.yaml. Nothing was submitted.",
		);
		this.name = "BroadsideAuthError";
		this.httpStatus = httpStatus;
		this.detail = detail;
	}
}

/**
 * `broadside/config.yaml` exists but cannot be used. A file that failed to
 * parse used to be treated exactly like an absent one — defaults, including
 * no spend cap and no lens routing, with no message — so a typo removed the
 * user's own guard (#232). Only an absent file yields defaults now.
 */
export class BroadsideConfigError extends Error {
	readonly path: string;
	constructor(path: string, detail: string) {
		super(`Broad-Side config ${path} ${detail}. Fix or remove the file; nothing runs on defaults while it is unreadable.`);
		this.name = "BroadsideConfigError";
		this.path = path;
	}
}

/**
 * `broadside/state.json` exists but cannot be read. It used to be read as
 * empty and the next checkpoint wrote that empty state over it, losing the
 * batch ids of every in-flight, already-paid run (#233). The corrupt file is
 * preserved beside itself and nothing writes over it until someone looks.
 */
export class BroadsideStateError extends Error {
	readonly path: string;
	readonly backupPath: string;
	constructor(path: string, backupPath: string, detail: string) {
		super(
			`Broad-Side state ${path} ${detail}. A copy is preserved at ${backupPath}; the file is not overwritten. ` +
			"Repair state.json from the copy (each run's batch ids are what collect needs), or move it aside to start fresh.",
		);
		this.name = "BroadsideStateError";
		this.path = path;
		this.backupPath = backupPath;
	}
}

/** Thrown when a confirm hook declines a run. Nothing was submitted. */
export class BroadsideCancelledError extends Error {
	constructor(message = "Broad-Side submission cancelled. Nothing was submitted.") {
		super(message);
		this.name = "BroadsideCancelledError";
	}
}

/**
 * Whether incremental scouting actually narrowed the run.
 *
 * A request for incremental falls back to a full scan whenever there is nothing
 * to diff against, and that fallback costs real money — the caller asked for the
 * cheap mode and gets the expensive one. It must be reported, not inferred from
 * the request counts.
 */
export type BroadsideIncrementalOutcome = {
	requested: boolean;
	applied: boolean;
	/** The commit the run diffed against, when one was found. */
	baseHead: string | null;
	/** Why a requested incremental run did not apply. */
	reason?: "dirty-worktree" | "no-baseline" | "diff-failed";
};

export type BroadsideSubmitResult = {
	runId: string;
	outputDir: string;
	batches: Partial<Record<BroadsideLensId, BroadsideBatchEntry>>;
	estimatedTotalCost: number;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	pricing: ModelPricing;
	maxCost?: number;
	modelInfo: {
		contextLength?: number;
		maxCompletionTokens?: number;
		supportsStructuredOutputs?: boolean;
		expirationDate?: string | null;
	};
	incremental: BroadsideIncrementalOutcome;
	/** What was scanned: the language the lenses ran as and the snapshot the files came from. */
	repo: {
		language: string;
		sourceFiles: number;
		snapshot: RepoSnapshotSource;
		sourceHead: string | null;
		sourceDirty: boolean;
	};
	/** What the secret-redaction pass did before upload (#252). */
	redaction: { enabled: boolean; values: number; files: number; skippedFiles: string[] };
};

export type BroadsideCollectResult = {
	runId: string;
	status: string;
	totalCost: number;
	resultCount: number;
	/** Results whose JSON did not parse even after fence stripping —
	 * the signature of an output cut off at max_tokens. */
	truncatedCount: number;
	/** Truncated slices recovered by the automatic re-submit pass (#133). */
	retriedCount: number;
	/** Another collect on this run owns the retry pass; its result lands on a later collect (#322). */
	retryElsewhere?: boolean;
	/** Why the truncation retry could not be submitted, when it was refused (#370). */
	retryError?: string;
	lensOutcomes: Partial<
		Record<BroadsideLensId, { status: string; cost?: number; resultCount?: number; truncated?: number; error?: string }>
	>;
	synthesis: BroadsideSynthesisEntry;
	triage: BroadsideTriageEntry;
	topFindings: { title: string; severity: string; sourceLens: string; summary: string }[];
	topTriageItems: TriageItem[];
	/** The post-passes this collect reset and re-ran on request (#338). */
	regenerated?: Array<"synthesis" | "triage">;
};
