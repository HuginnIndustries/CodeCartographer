// Broad-Side: cheap batch reconnaissance over the OpenRouter Batch API.
//
// Broad-Side fires every analysis lens at a repository at once. Each lens is a
// single-turn prompt with a structured-output JSON schema, submitted as an
// asynchronous batch job (Google Gemini's batch endpoint, ~50% of sync pricing)
// and polled to completion. Results land in `.codecarto/broadside/<run>/` as
// JSON plus rendered markdown, and an optional synthesis pass cross-references
// every lens into one executive report.
//
// This is deliberately NOT the interactive CodeCartographer pipeline. The batch
// API is text-in/text-out: no filesystem access, no multi-turn exploration, no
// runtime verification. Broad-Side findings are unverified scouting signals —
// file:line leads that a real analysis (or a human) must confirm. That division
// of labor is the point: a ~$0.50 unattended sweep that tells the expensive
// interactive run where to look.
//
// Field shapes for the model catalog and benchmarks endpoints follow the
// official OpenRouter skills (OpenRouterTeam/skills: openrouter-models,
// openrouter-benchmarks).
//
// RESUBMISSION INVARIANT: batch requests are pure functions of their input —
// no tools, no filesystem, no side effects — so resubmitting a failed or
// truncated slice is always safe. This is the retry rule OpenRouter's own
// headless-agent scaffold states the hard way (retry only before tool calls,
// because replaying a mutating tool would double-execute it); here the rule is
// satisfied by construction. If Broad-Side ever gains server tools
// (openrouter:web_search etc.), this invariant becomes load-bearing and the
// resubmit path must gate on whether any tool executed.
//
// Broad-Side requires runtime code, so the feature itself lives on the
// executable surfaces (Pi and MCP), not the pure template. What the template does
// carry is the reading guide for its output — `.codecarto/broadside/SKILL.md`,
// served by codecarto_skill under the name `broadside` (see readBroadsideSkill).

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import { atomicWriteFile, pathExists, sleep } from "./utils.ts";
import { acquireLock } from "./status.ts";
import { loadYamlFile } from "./yaml.ts";
import { packagedWorkspaceDir } from "./workspace.ts";

const execFileAsync = promisify(execFile);

// ---------- constants ----------

export const BROADSIDE_MODEL = "google/gemini-3.7-flash:batch";
export const BROADSIDE_BATCH_URL = "https://openrouter.ai/api/beta/batches";
export const BROADSIDE_DIR = "broadside"; // relative to .codecarto/
/** Name Broad-Side answers to on the skill surfaces. Not a post-pipeline skill — see readBroadsideSkill. */
export const BROADSIDE_SKILL_NAME = "broadside";
export const BROADSIDE_STATE_FILE = "state.json";
export const BROADSIDE_CONFIG_FILE = "config.yaml";
export const BROADSIDE_STATE_SCHEMA_VERSION = 1;

// Per-token pricing in USD (OpenRouter, google/gemini-3.7-flash:batch).
// OpenRouter's listed rates for the `:batch` variant, which already carry the
// batch discount — the sync model is $0.75/$3.75. These were half these values
// until a live run compared them against the catalog: the batch discount had
// been applied a second time by hand, so every estimate for the default model
// came out at half its true cost and `max_cost` bound at twice what the user
// asked for. They are the offline fallback only; the live catalog wins.
export const BROADSIDE_INPUT_PRICE_PER_M = 0.375;
export const BROADSIDE_OUTPUT_PRICE_PER_M = 1.875;

// OpenRouter's public model catalog; pricing, context, and capabilities live
// per model id. The benchmarks endpoint adds coding/intelligence indices.
export const BROADSIDE_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const BROADSIDE_BENCHMARKS_URL = "https://openrouter.ai/api/v1/benchmarks";

export const BROADSIDE_CATALOG_CACHE_FILE = "model-catalog.json";
export const BROADSIDE_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const BROADSIDE_LENS_IDS = [
	"architecture",
	"api",
	"security",
	"defect",
	"conventions",
	"porting",
] as const;
export type BroadsideLensId = (typeof BROADSIDE_LENS_IDS)[number];

export const BROADSIDE_POLL_INTERVAL_MS = 15_000;
export const BROADSIDE_DEFAULT_POLL_BUDGET_MS = 25 * 60 * 1000;

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
};

export type FileSlice = {
	moduleName: string;
	content: string;
	fileCount: number;
	chars: number;
	/** Repo-relative paths of the files folded into this slice. */
	files: string[];
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
 * The share of a lens's output budget reasoning may spend.
 *
 * `estimateCost` already budgets output at 75% of `maxTokens`; capping thinking
 * at the remaining quarter makes that assumption true by construction and
 * guarantees the answer has room. A floor keeps the cap sane for a small lens.
 */
export const BROADSIDE_REASONING_BUDGET_FRACTION = 0.25;
export const BROADSIDE_MIN_REASONING_TOKENS = 512;

/**
 * Cap reasoning for a lens request — deliberately a cap, not an off switch.
 *
 * Disabling outright is not portable: `google/gemini-3.8-flash:batch` refuses
 * the whole batch with *"Reasoning is mandatory for this endpoint and cannot be
 * disabled"*, turning a partial result into none at all. Capping works whether
 * or not a provider allows reasoning to be switched off.
 *
 * The failure this prevents is the budget being spent thinking rather than
 * answering. Measured on one run: 5,758 of a 6,000-token budget went to
 * reasoning, leaving ~230 tokens for JSON that truncated mid-structure — and
 * those tokens bill at the full output rate. The shipped default model does the
 * same thing less consistently (reasoning tokens from 0 to 5,757 across 13
 * slices, three of them cut off at `finish_reason: length`), so this is not a
 * multi-model concern.
 */
export function defaultReasoningFor(maxTokens: number): BroadsideReasoning {
	return { max_tokens: Math.max(BROADSIDE_MIN_REASONING_TOKENS, Math.floor(maxTokens * BROADSIDE_REASONING_BUDGET_FRACTION)) };
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

export type BroadsideTriageEntry = {
	batchId?: string;
	status: "pending" | "submitted" | "completed" | "failed";
	cost?: number;
};

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
	lensOutcomes: Partial<
		Record<BroadsideLensId, { status: string; cost?: number; resultCount?: number; truncated?: number; error?: string }>
	>;
	synthesis: BroadsideSynthesisEntry;
	triage: BroadsideTriageEntry;
	topFindings: { title: string; severity: string; sourceLens: string; summary: string }[];
	topTriageItems: TriageItem[];
};

// ---------- JSON schemas (one per lens, plus synthesis) ----------

const SCHEMAS: Record<string, JsonSchemaDef> = {
	architecture: {
		name: "architecture_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				tech_stack: {
					type: "object",
					properties: {
						language: { type: "string" },
						version: { type: "string" },
						build_system: { type: "string" },
						key_dependencies: { type: "array", items: { type: "string" } },
					},
					required: ["language", "build_system"],
					additionalProperties: false,
				},
				module_architecture: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							role: { type: "string" },
							file_count: { type: "integer" },
							depends_on: { type: "array", items: { type: "string" } },
						},
						required: ["name", "role"],
						additionalProperties: false,
					},
				},
				data_flow: { type: "string" },
				entry_points: { type: "array", items: { type: "string" } },
				notable_patterns: { type: "array", items: { type: "string" } },
			},
			required: ["tech_stack", "module_architecture", "data_flow", "entry_points"],
			additionalProperties: false,
		},
	},
	api_surface: {
		name: "api_surface_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				endpoints: {
					type: "array",
					items: {
						type: "object",
						properties: {
							method: { type: "string" },
							path: { type: "string" },
							handler: { type: "string" },
							auth_required: { type: "boolean" },
							description: { type: "string" },
						},
						required: ["method", "path", "handler", "auth_required"],
						additionalProperties: false,
					},
				},
				data_types: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							kind: { type: "string" },
							fields_summary: { type: "string" },
						},
						required: ["name", "kind"],
						additionalProperties: false,
					},
				},
				authentication_flow: { type: "string" },
				error_handling: { type: "string" },
			},
			required: ["endpoints"],
			additionalProperties: false,
		},
	},
	security: {
		name: "security_review_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
							category: { type: "string" },
							title: { type: "string" },
							location: { type: "string" },
							description: { type: "string" },
						},
						required: ["severity", "title", "description"],
						additionalProperties: false,
					},
				},
				overall_assessment: { type: "string" },
				coverage_note: { type: "string" },
			},
			required: ["findings", "overall_assessment"],
			additionalProperties: false,
		},
	},
	defect_mechanical: {
		name: "defect_scan_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				module: { type: "string" },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							severity: { type: "string", enum: ["high", "medium", "low"] },
							pattern: { type: "string" },
							title: { type: "string" },
							location: { type: "string" },
							description: { type: "string" },
							suggestion: { type: "string" },
						},
						required: ["severity", "pattern", "title", "description"],
						additionalProperties: false,
					},
				},
				patterns_checked: { type: "array", items: { type: "string" } },
				files_scanned: { type: "integer" },
				overall_notes: { type: "string" },
			},
			required: ["module", "findings", "patterns_checked", "files_scanned"],
			additionalProperties: false,
		},
	},
	conventions: {
		name: "conventions_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				module: { type: "string" },
				naming_conventions: {
					type: "object",
					properties: {
						packages: { type: "string" },
						types: { type: "string" },
						functions: { type: "string" },
						variables: { type: "string" },
						files: { type: "string" },
						tests: { type: "string" },
					},
					additionalProperties: false,
				},
				error_handling_pattern: { type: "string" },
				logging_approach: { type: "string" },
				test_patterns: { type: "string" },
				code_organization: { type: "string" },
				idioms: { type: "array", items: { type: "string" } },
				inconsistencies: {
					type: "array",
					items: {
						type: "object",
						properties: {
							description: { type: "string" },
							locations: { type: "array", items: { type: "string" } },
						},
						required: ["description"],
						additionalProperties: false,
					},
				},
				promotable_conventions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							rule: { type: "string" },
							evidence: { type: "string" },
						},
						required: ["title", "rule"],
						additionalProperties: false,
					},
				},
				files_scanned: { type: "integer" },
			},
			required: ["module", "naming_conventions", "files_scanned"],
			additionalProperties: false,
		},
	},
	porting: {
		name: "porting_surface_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				module: { type: "string" },
				platform_coupling: {
					type: "array",
					items: {
						type: "object",
						properties: {
							platform: { type: "string" },
							mechanisms: { type: "array", items: { type: "string" } },
							files: { type: "array", items: { type: "string" } },
						},
						required: ["platform", "mechanisms"],
						additionalProperties: false,
					},
				},
				external_dependencies: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							role: { type: "string" },
							replaceability: { type: "string" },
						},
						required: ["name"],
						additionalProperties: false,
					},
				},
				build_system_complexity: { type: "string" },
				porting_risk_areas: {
					type: "array",
					items: {
						type: "object",
						properties: {
							area: { type: "string" },
							risk: { type: "string", enum: ["low", "medium", "high"] },
							notes: { type: "string" },
						},
						required: ["area", "risk"],
						additionalProperties: false,
					},
				},
				files_scanned: { type: "integer" },
			},
			required: ["module", "platform_coupling", "files_scanned"],
			additionalProperties: false,
		},
	},
	synthesis: {
		name: "synthesis_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				executive_summary: { type: "string" },
				severity_summary: {
					type: "object",
					properties: {
						critical: { type: "integer" },
						high: { type: "integer" },
						medium: { type: "integer" },
						low: { type: "integer" },
					},
					required: ["critical", "high", "medium", "low"],
					additionalProperties: false,
				},
				top_findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							severity: { type: "string" },
							source_lens: { type: "string" },
							summary: { type: "string" },
						},
						required: ["title", "severity", "source_lens", "summary"],
						additionalProperties: false,
					},
				},
				module_assessments: {
					type: "array",
					items: {
						type: "object",
						properties: {
							module: { type: "string" },
							quality_notes: { type: "string" },
							risk_level: { type: "string", enum: ["low", "medium", "high"] },
						},
						required: ["module", "risk_level"],
						additionalProperties: false,
					},
				},
				porting_readiness: { type: "string" },
				gaps_and_unknowns: { type: "array", items: { type: "string" } },
				coverage: { type: "string" },
			},
			required: ["executive_summary", "severity_summary", "top_findings"],
			additionalProperties: false,
		},
	},
	triage: {
		name: "triage_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				summary: { type: "string" },
				items: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							severity: { type: "string" },
							module: { type: "string" },
							impact: { type: "string", enum: ["high", "medium", "low"] },
							difficulty: { type: "string", enum: ["high", "medium", "low"] },
							priority: { type: "string" },
							effort_estimate: { type: "string" },
							rationale: { type: "string" },
						},
						required: ["title", "severity", "module", "impact", "difficulty", "priority", "rationale"],
						additionalProperties: false,
					},
				},
				omitted: {
					type: "array",
					items: { type: "string" },
					description: "Leads deliberately dropped from the queue and why (duplicates, too vague, out of scope)",
				},
			},
			required: ["summary", "items"],
			additionalProperties: false,
		},
	},
};

// ---------- lens definitions ----------

// Lenses share their JSON schemas across languages, but prompts must speak
// the language's idioms: "goroutines without ctx" is noise to a Python
// scanner. Profiles supply per-language defect patterns and convention
// vocabulary; unknown languages get the neutral default.
type LanguageProfile = {
	defectPatterns: string[];
	conventionCategories: Array<{ key: string; label: string }>;
	idiomHints: string[];
};

const TS_PROFILE: LanguageProfile = {
	defectPatterns: [
		"Null/undefined dereference risks (unchecked optional access)",
		"Error handling gaps (unhandled promise rejections, swallowed catches)",
		"Resource leaks (unclosed handles, missing cleanup, dangling timers/listeners)",
		"Race conditions (shared mutable state, async interleavings without guards)",
		"Integer/precision assumptions in arithmetic",
		"Unsafe type assumptions (as-casts, any leaks, non-null assertions)",
		"Panic-prone code (out-of-bounds access, runtime TypeError paths)",
		"Timezone/locale assumptions",
	],
	conventionCategories: [
		{ key: "packages", label: "modules and imports" },
		{ key: "types", label: "interfaces and type aliases" },
		{ key: "functions", label: "functions (camelCase), components (PascalCase)" },
		{ key: "variables", label: "variables and constants (camelCase)" },
		{ key: "files", label: "file naming (kebab vs camel) and folder organization" },
		{ key: "tests", label: "test files (*.test.ts, describe/it patterns)" },
	],
	idiomHints: ["strict null checks usage", "async/await vs promise chains", "dependency injection patterns"],
};

const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
	go: {
		defectPatterns: [
			"Nil pointer dereference risks (unchecked returns, missing nil guards)",
			"Error handling gaps (ignored errors, deferred errors unchecked)",
			"Resource leaks (unclosed files, connections, goroutines without ctx)",
			"Race conditions (shared state without sync, channel misuse)",
			"Integer overflow/underflow in arithmetic or bounds",
			"Unsafe type assertions without ok check",
			"Panic-prone code (slice out of bounds, map access without ok)",
			"Timezone/locale assumptions",
		],
		conventionCategories: [
			{ key: "packages", label: "packages" },
			{ key: "types", label: "types and interfaces" },
			{ key: "functions", label: "functions and methods" },
			{ key: "variables", label: "variables and fields" },
			{ key: "files", label: "file and directory organization" },
			{ key: "tests", label: "test files and table-driven tests" },
		],
		idiomHints: ["error wrapping with %w", "zero-value construction"],
	},
	python: {
		defectPatterns: [
			"None dereference risks (unchecked optional returns, AttributeError paths)",
			"Exception handling gaps (bare except, swallowed exceptions, broad catch-all)",
			"Resource leaks (unclosed files, sockets, connections, context managers)",
			"Race conditions (shared mutable state, threading without locks, async pitfalls)",
			"Integer/float precision assumptions in arithmetic",
			"Unsafe type assumptions (unpacking mismatches, isinstance without fallback)",
			"Panic-prone code (IndexError/KeyError paths, unbounded slicing)",
			"Timezone/locale assumptions (naive datetimes)",
		],
		conventionCategories: [
			{ key: "packages", label: "modules and packages" },
			{ key: "types", label: "classes and type hints" },
			{ key: "functions", label: "functions and methods (snake_case vs camelCase)" },
			{ key: "variables", label: "variables and constants" },
			{ key: "files", label: "file and module organization" },
			{ key: "tests", label: "test files (pytest fixtures, naming)" },
		],
		idiomHints: ["dunder method usage", "context manager idioms", "dataclass/pydantic models"],
	},
	rust: {
		defectPatterns: [
			"Unwrap/expect panics on fallible paths",
			"Error handling gaps (swallowed Results, lossy conversions)",
			"Resource leaks (unclosed handles, drop order assumptions)",
			"Data races and Send/Sync violations (unsafe blocks, interior mutability misuse)",
			"Integer overflow/underflow (arithmetic, casting)",
			"Unsafe type assumptions (transmute/casts without invariants)",
			"Panic-prone code (indexing, slicing, unreachable! in library paths)",
			"Timezone/locale assumptions",
		],
		conventionCategories: [
			{ key: "packages", label: "crates and modules" },
			{ key: "types", label: "structs, enums, and traits" },
			{ key: "functions", label: "functions and methods (snake_case)" },
			{ key: "variables", label: "variables and constants (SCREAMING_SNAKE)" },
			{ key: "files", label: "module file organization" },
			{ key: "tests", label: "test modules and #[cfg(test)] patterns" },
		],
		idiomHints: ["Result/Option handling with ?", "builder patterns", "trait-based extension"],
	},
	typescript: TS_PROFILE,
	javascript: TS_PROFILE,
	default: {
		defectPatterns: [
			"Null/undefined dereference risks (unchecked optional access)",
			"Error handling gaps (ignored or swallowed errors)",
			"Resource leaks (unclosed files, connections, handles)",
			"Race conditions (shared mutable state without synchronization)",
			"Integer overflow/underflow in arithmetic or bounds",
			"Unsafe type assumptions and unchecked casts",
			"Panic-prone code (out-of-bounds access, missing keys)",
			"Timezone/locale assumptions",
		],
		conventionCategories: [
			{ key: "packages", label: "modules, packages, or namespaces" },
			{ key: "types", label: "types, classes, and interfaces" },
			{ key: "functions", label: "functions and methods" },
			{ key: "variables", label: "variables and constants" },
			{ key: "files", label: "file and directory organization" },
			{ key: "tests", label: "test files and test organization" },
		],
		idiomHints: [],
	},
};

function languageProfile(language: string): LanguageProfile {
	return LANGUAGE_PROFILES[language] ?? LANGUAGE_PROFILES.default;
}

type LensDefinition = {
	id: BroadsideLensId;
	name: string;
	description: string;
	schemaName: string;
	// "none" = one slice for the whole repo; "directory" = one slice per
	// top-level module; "auto" = directory for large repos, none for small
	// ones (see resolveSliceMode).
	sliceBy: "none" | "directory" | "auto";
	maxChars: number;
	maxTokens: number;
	// Omitted means BROADSIDE_DEFAULT_REASONING (off). Set this only for a lens
	// that genuinely needs to think, and raise its maxTokens to cover both.
	reasoning?: BroadsideReasoning;
	// Test files rarely carry the surface a lens audits — they bulk up the
	// batch and the bill. Convention extraction is the exception: it exists
	// partly to catalog test patterns.
	skipTestFiles?: boolean;
	// Globs are matched against repo-relative forward-slash paths.
	globsFor: (info: RepoInfo) => string[];
	systemPrompt: (info: RepoInfo) => string;
	userPrompt: (info: RepoInfo, source: string, moduleName: string) => string;
};

const LENSES: Record<BroadsideLensId, LensDefinition> = {
	architecture: {
		id: "architecture",
		name: "Architecture, tech stack & module map",
		description: "Repo-wide structural analysis from the manifest, entry point, README, and file tree.",
		schemaName: "architecture",
		sliceBy: "none",
		maxChars: 0, // repo-info lens; no file slurping
		maxTokens: 8000,
		globsFor: () => [],
		systemPrompt: () =>
			"You are a senior software architect performing a structural analysis of a " +
			"codebase. You receive the project manifest, entry point, README excerpt, and " +
			"file tree. Return a JSON object following the architecture_report schema " +
			"exactly. All findings must be traceable to the provided files — cite file " +
			"paths. If you can't determine something, say so rather than guessing.",
		userPrompt: (info) => {
			const manifest = info.manifest
				? `## ${info.manifest.path}\n\`\`\`\n${info.manifest.content}\n\`\`\`\n\n`
				: "## Manifest\n[no manifest found]\n\n";
			return (
				"Analyze the architecture of this project.\n\n" +
				manifest +
				`## Entry point\n\`\`\`\n${info.mainFile || "[missing]"}\n\`\`\`\n\n` +
				`## README (first 4000 chars)\n${info.readmeFirst || "[missing]"}\n\n` +
				`## File tree (depth 3, capped)\n${info.fileTree || "[missing]"}\n\n` +
				"## File counts by extension\n```json\n" +
				JSON.stringify(info.fileCounts) +
				"\n```\n\n" +
				"Return the architecture_report JSON schema."
			);
		},
	},
	api: {
		id: "api",
		name: "API surface audit",
		description: "Endpoint catalog, request/response types, auth flow, error handling.",
		schemaName: "api_surface",
		sliceBy: "none",
		maxChars: 70_000,
		maxTokens: 8000,
		skipTestFiles: true,
		globsFor: (info) =>
			info.language === "go"
				? ["server/**/*.go", "server/*.go", "api/**/*.go", "api/*.go"]
				: [
						"server/**",
						"api/**",
						"src/server/**",
						"src/api/**",
						"mcp-server/**",
						"**/*routes*",
						"**/*router*",
						"**/*handler*",
						"**/*endpoint*",
					],
		systemPrompt: () =>
			"You are a senior API auditor. Given source files from an HTTP server, " +
			"extract every HTTP endpoint (method, path, handler function, auth requirement) " +
			"and every key request/response data type. Return a JSON object following the " +
			"api_surface_report schema exactly. Cite specific file:line locations.",
		userPrompt: (info, source, moduleName) =>
			"Extract the full API surface from these server source files:\n\n" +
			source +
			"\n\nReturn the api_surface_report JSON schema.",
	},
	security: {
		id: "security",
		name: "Security review",
		description: "Auth, authorization, input validation, TLS, secrets, trust boundaries.",
		schemaName: "security",
		sliceBy: "none",
		maxChars: 70_000,
		maxTokens: 8000,
		skipTestFiles: true,
		globsFor: (info) =>
			info.language === "go"
				? ["server/**/*.go", "server/*.go", "**/auth*.go", "**/middleware/**/*.go", "SECURITY.md"]
				: ["server/**", "**/auth*", "**/middleware/**", "SECURITY.md"],
		systemPrompt: () =>
			"You are a security engineer performing a first-pass review of a codebase. " +
			"Given source files, identify potential security issues — focusing on " +
			"authentication, authorization, input validation, TLS, secrets handling, " +
			"and trust boundaries. Return a JSON object following the security_review_report " +
			"schema. Rate severity as critical/high/medium/low. Be specific: cite file:line. " +
			"If the provided files don't cover an area, state the gap in coverage_note.",
		userPrompt: (info, source, moduleName) =>
			"Review these server source files for security issues:\n\n" +
			source +
			"\n\nReturn the security_review_report JSON schema.",
	},
	defect: {
		id: "defect",
		name: "Mechanical defect scan",
		description: "Nil derefs, error gaps, leaks, races, panics — pattern-based, sliced per module.",
		schemaName: "defect_mechanical",
		sliceBy: "auto",
		maxChars: 60_000,
		maxTokens: 6000,
		globsFor: (info) => [info.sourceGlob],
		systemPrompt: (info) => {
			const profile = languageProfile(info.language);
			const patterns = profile.defectPatterns.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
			return (
				`You are a senior code reviewer performing an automated defect scan on ${info.language} ` +
				"source files. Look for these specific patterns:\n" +
				patterns +
				"\n\n" +
				"Return a JSON object following the defect_scan_report schema. " +
				"Cite file:line for every finding. List which patterns you checked. " +
				"If the code looks clean for a pattern, say so rather than staying silent. " +
				"Prefer precision over volume — 3 solid findings beat 15 vague ones."
			);
		},
		userPrompt: (info, source, moduleName) =>
			`Scan this ${info.language} module for mechanical defects.\n\n` +
			`Module: ${moduleName}\n\n` +
			"## Source files\n\n" +
			source +
			"\n\nReturn the defect_scan_report JSON schema.",
	},
	conventions: {
		id: "conventions",
		name: "Convention extraction",
		description: "Naming, error handling, idioms, inconsistencies, promotable conventions.",
		schemaName: "conventions",
		sliceBy: "auto",
		maxChars: 60_000,
		maxTokens: 6000,
		globsFor: (info) => [info.sourceGlob],
		systemPrompt: (info) => {
			const profile = languageProfile(info.language);
			const categories = profile.conventionCategories.map((c) => `${c.key} (${c.label})`).join(", ");
			const idiomHint =
				profile.idiomHints.length > 0
					? ` Keep an eye out for ${info.language} idioms such as ${profile.idiomHints.join(", ")}.`
					: "";
			return (
				`You are a code style analyst extracting conventions from ${info.language} source files. ` +
				"Catalog naming conventions per category — " + categories + " — plus the dominant " +
				"error-handling pattern, logging approach, test organization patterns, file/package " +
				"organization rules, and recurring idioms." + idiomHint +
				" Also flag inconsistencies — places where the same convention is violated. " +
				"If you find well-established conventions worth formalizing, list them as " +
				"promotable_conventions with a title, rule, and evidence from the code. " +
				"Return a JSON object following the conventions_report schema."
			);
		},
		userPrompt: (info, source, moduleName) =>
			"Extract coding conventions from this module.\n\n" +
			`Module: ${moduleName}\n\n` +
			"## Source files\n\n" +
			source +
			"\n\nReturn the conventions_report JSON schema.",
	},
	porting: {
		id: "porting",
		name: "Porting surface assessment",
		description: "Platform coupling, external deps, build complexity, porting risk areas.",
		schemaName: "porting",
		sliceBy: "auto",
		maxChars: 60_000,
		maxTokens: 6000,
		skipTestFiles: true,
		globsFor: (info) => [
			info.sourceGlob,
			"**/*.c",
			"**/*.h",
			"**/*.cpp",
			"**/*.cc",
			"**/*.m",
			"**/*.mm",
			"**/CMakeLists.txt",
			"**/*.cmake",
			"go.mod",
		],
		systemPrompt: () =>
			"You are a software portability analyst. Examine source files and " +
			"identify everything that ties this codebase to a specific platform, OS, " +
			"architecture, or external dependency. Catalog: platform-specific build tags, " +
			"FFI usage, OS-specific syscalls, external library bindings, and " +
			"compile-time constants that encode platform assumptions. " +
			"For each external dependency, note whether it could be replaced by a " +
			"cross-platform alternative. Assess the build system complexity. " +
			"Return a JSON object following the porting_surface_report schema.",
		userPrompt: (info, source, moduleName) =>
			"Assess porting surface for this module.\n\n" +
			`Module: ${moduleName}\n\n` +
			"## Source files\n\n" +
			source +
			"\n\nReturn the porting_surface_report JSON schema.",
	},
};

export function getLens(lensId: BroadsideLensId): LensDefinition {
	return LENSES[lensId];
}

export function listLenses(): LensDefinition[] {
	return BROADSIDE_LENS_IDS.map((id) => LENSES[id]);
}

// ---------- repo info ----------

const SKIP_DIR_NAMES = new Set([
	".git",
	".github",
	".claude",
	".opencode",
	".codecarto",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
	"testdata",
	"__pycache__",
]);

const SKIP_FILE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
	".ico",
	".icns",
	".bmp",
	".webp",
	".mp3",
	".mp4",
	".mov",
	".avi",
	".wav",
	".ogg",
	".zip",
	".gz",
	".tar",
	".bz2",
	".xz",
	".7z",
	".pdf",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".otf",
	".bin",
	".exe",
	".dll",
	".so",
	".dylib",
	".a",
	".o",
	".obj",
	".class",
	".jar",
	".war",
	".pyc",
	".wasm",
	".model",
	".bpe",
]);

/**
 * Manifest files and the languages each one can mean. `package.json` covers
 * both TypeScript and JavaScript; which of the two a repository is comes from
 * counting its source files, not from the manifest.
 */
const MANIFEST_CANDIDATES: ReadonlyArray<readonly [string, readonly string[]]> = [
	["go.mod", ["go"]],
	["package.json", ["typescript", "javascript"]],
	["Cargo.toml", ["rust"]],
	["pyproject.toml", ["python"]],
	["setup.py", ["python"]],
	["requirements.txt", ["python"]],
];

/** The languages Broad-Side can scan; anything else is refused at submit. */
export const BROADSIDE_LANGUAGES = ["go", "python", "rust", "typescript", "javascript"] as const;

/** Chars of the entry-point file and the manifest that ride in the architecture prompt (#249). */
const REPO_INFO_FILE_CAP = 20_000;

const SOURCE_SPECS: Record<string, { glob: string; exts: string[] }> = {
	go: { glob: "**/*.go", exts: [".go"] },
	python: { glob: "**/*.py", exts: [".py"] },
	rust: { glob: "**/*.rs", exts: [".rs"] },
	typescript: { glob: "**/*.ts", exts: [".ts", ".tsx"] },
	javascript: { glob: "**/*.js", exts: [".js", ".jsx"] },
};

/**
 * The files a run scans, and where they came from. Contents are always read
 * from the working tree, so the list is the working tree's too: tracked files
 * plus untracked ones git does not ignore, minus files deleted on disk. The
 * list used to come from `git ls-tree HEAD`, so a run mixed the committed
 * file list with uncommitted contents and never saw an untracked file (#248).
 * A target that is not a git repository gets a bounded walk.
 */
async function listRepoFiles(targetDir: string): Promise<{ files: string[]; snapshot: RepoSnapshotSource }> {
	try {
		const listed = await execFileAsync(
			"git",
			["-C", targetDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		const deleted = await execFileAsync("git", ["-C", targetDir, "ls-files", "-z", "--deleted"], {
			maxBuffer: 64 * 1024 * 1024,
		});
		const gone = new Set(deleted.stdout.split("\0").filter(Boolean));
		const files = listed.stdout.split("\0").filter((path) => path && !gone.has(path));
		return { files, snapshot: "working-tree" };
	} catch {
		return { files: await walkFiles(targetDir, targetDir, 0, 30_000), snapshot: "walk" };
	}
}

async function gitHead(targetDir: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", targetDir, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function gitDirty(targetDir: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", targetDir, "status", "--porcelain"], { maxBuffer: 1024 * 1024 });
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Repo-relative paths changed since `baseHead` (or all files when there is
 * no base). Returns null when the diff cannot be computed (non-git tree,
 * missing base commit) so callers fall back to a full scan.
 */
async function changedFilesSince(targetDir: string, baseHead: string | null): Promise<Set<string> | null> {
	if (!baseHead) return null;
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", targetDir, "diff", "--name-only", baseHead, "HEAD"],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		return new Set(stdout.split("\n").filter(Boolean));
	} catch {
		return null;
	}
}

async function walkFiles(
	rootDir: string,
	dir: string,
	depth: number,
	remaining: number,
): Promise<string[]> {
	if (remaining <= 0) return [];
	let out: string[] = [];
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.name !== ".github") continue;
		if (entry.isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue;
			if (depth > 8) continue;
			const children = await walkFiles(rootDir, join(dir, entry.name), depth + 1, remaining - out.length);
			out = out.concat(children);
		} else if (entry.isFile()) {
			// relative() rather than slice(rootDir.length + 1): the hand-rolled
			// slice cut one character too many whenever rootDir carried a trailing
			// separator, and mangled every path outright when rootDir was "/".
			const rel = relative(rootDir, join(dir, entry.name)).split("\\").join("/");
			out.push(rel);
		}
	}
	return out;
}

function sourceFileCount(language: string, fileCounts: Record<string, number>): number {
	return (SOURCE_SPECS[language]?.exts ?? []).reduce((sum, ext) => sum + (fileCounts[ext] ?? 0), 0);
}

/**
 * The language the lenses scan as. The manifests present name the candidates
 * (all of them, not the first one found: a Python service with a
 * `package.json` for its docs tooling is not a TypeScript repository), and
 * among candidates the one with the most source files wins; without a
 * manifest, the language with the most source files; without any source
 * file, `unknown` — which submit refuses rather than scanning nothing and
 * paying for it (#250). Ties keep manifest order.
 */
function detectLanguage(fileCounts: Record<string, number>, manifestPaths: string[]): string {
	const candidates: string[] = [];
	for (const [candidate, languages] of MANIFEST_CANDIDATES) {
		if (!manifestPaths.includes(candidate)) continue;
		for (const language of languages) if (!candidates.includes(language)) candidates.push(language);
	}
	const pool = candidates.length > 0 ? candidates : [...BROADSIDE_LANGUAGES];
	let best: string | null = null;
	let bestCount = -1;
	for (const language of pool) {
		const count = sourceFileCount(language, fileCounts);
		if (count > bestCount) {
			best = language;
			bestCount = count;
		}
	}
	if (bestCount > 0) return best!;
	// A manifest with no source files behind it still names the language;
	// submit reports the empty count. No manifest and no source: unknown.
	return candidates[0] ?? "unknown";
}

/** Cut a file that rides whole in a prompt down to the cap, saying so (#249). */
function capForPrompt(content: string, cap: number): string {
	if (content.length <= cap) return content;
	return `${content.slice(0, cap)}\n… [truncated: ${cap.toLocaleString()} of ${content.length.toLocaleString()} chars shown]\n`;
}

export async function collectRepoInfo(targetDir: string): Promise<RepoInfo> {
	const { files: allFiles, snapshot } = await listRepoFiles(targetDir);

	const fileCounts: Record<string, number> = {};
	for (const f of allFiles) {
		const slash = f.lastIndexOf("/");
		const base = slash >= 0 ? f.slice(slash + 1) : f;
		const dot = base.lastIndexOf(".");
		const ext = dot > 0 ? base.slice(dot).toLowerCase() : "(no ext)";
		fileCounts[ext] = (fileCounts[ext] ?? 0) + 1;
	}
	const sortedCounts: Record<string, number> = {};
	for (const [ext, n] of Object.entries(fileCounts).sort((a, b) => b[1] - a[1])) {
		sortedCounts[ext] = n;
	}

	// Every manifest present counts toward language detection; the first one
	// found is the one the architecture prompt shows.
	const manifestPaths: string[] = [];
	for (const [candidate] of MANIFEST_CANDIDATES) {
		if (await pathExists(join(targetDir, candidate))) manifestPaths.push(candidate);
	}
	const language = detectLanguage(sortedCounts, manifestPaths);
	// Show the manifest that belongs to the detected language when there is
	// one, so a polyglot repo's prompt does not open with the other stack's file.
	const manifestPath = manifestPaths.find((path) => MANIFEST_CANDIDATES.find(([candidate]) => candidate === path)?.[1].includes(language))
		?? manifestPaths[0]
		?? null;
	let manifest: { path: string; content: string } | null = null;
	if (manifestPath) {
		try {
			manifest = { path: manifestPath, content: capForPrompt(await readFile(join(targetDir, manifestPath), "utf8"), REPO_INFO_FILE_CAP) };
		} catch {
			manifest = null;
		}
	}

	// Read whole and unbounded before, and then estimated at a flat 6,000
	// chars: a large entry point shipped in full while the cap was checked
	// against a number that had nothing to do with it (#249).
	let mainFile = "";
	for (const candidate of ["main.go", "main.py", "src/main.rs", "src/index.ts", "index.ts", "src/index.js", "index.js"]) {
		const p = join(targetDir, candidate);
		if (await pathExists(p)) {
			try {
				mainFile = capForPrompt(await readFile(p, "utf8"), REPO_INFO_FILE_CAP);
			} catch {
				mainFile = "";
			}
			break;
		}
	}

	let readmeFirst = "";
	const readmePath = join(targetDir, "README.md");
	if (await pathExists(readmePath)) {
		try {
			readmeFirst = (await readFile(readmePath, "utf8")).slice(0, 4000);
		} catch {
			readmeFirst = "";
		}
	}

	const fileTree = buildFileTree(allFiles);

	// An unknown language used to fall through to Go's globs, so the code
	// lenses matched nothing and the run paid for empty batches (#250).
	const sourceSpec = SOURCE_SPECS[language] ?? { glob: "", exts: [] };
	const name = targetDir.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
	const sourceFiles = allFiles.filter((path) => isSlurpable(path) && sourceSpec.exts.some((ext) => path.toLowerCase().endsWith(ext))).length;

	return {
		name,
		path: targetDir,
		language,
		manifest,
		mainFile,
		readmeFirst,
		fileTree,
		fileCounts: sortedCounts,
		sourceGlob: sourceSpec.glob,
		sourceExts: sourceSpec.exts,
		sourceFileCount: sourceFiles,
		snapshot,
	};
}

function buildFileTree(allFiles: string[], maxDepth = 3, maxLines = 200): string {
	const lines: string[] = [];
	let count = 0;
	for (const f of allFiles) {
		if (f.split("/").length - 1 > maxDepth) continue;
		if (f.startsWith(".git/") || f.startsWith(".github/")) continue;
		if (f.endsWith(".sum") || f.endsWith(".lock")) continue;
		lines.push(f);
		count += 1;
		if (count >= maxLines) {
			lines.push(`... (${allFiles.length} total files, showing first ${maxLines})`);
			break;
		}
	}
	return lines.join("\n");
}

// ---------- glob matching & file slurping ----------

function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**/` matches zero or more directories; a trailing `**`
				// matches anything including slashes.
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
	for (const glob of globs) {
		if (globToRegExp(glob).test(path)) return true;
	}
	return false;
}

function isSlurpable(relPath: string): boolean {
	const segments = relPath.split("/");
	for (const seg of segments) {
		if (SKIP_DIR_NAMES.has(seg)) return false;
	}
	const slash = relPath.lastIndexOf("/");
	const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
	const dot = base.lastIndexOf(".");
	if (dot > 0 && SKIP_FILE_EXTENSIONS.has(base.slice(dot).toLowerCase())) return false;
	return true;
}

function sanitizeId(segment: string): string {
	return segment.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function topLevelModule(relPath: string): string {
	const slash = relPath.indexOf("/");
	return slash >= 0 ? relPath.slice(0, slash) : "root";
}

type CollectedFile = { relPath: string; moduleName: string };

function isTestFile(relPath: string): boolean {
	const base = relPath.slice(relPath.lastIndexOf("/") + 1);
	return /[._](test|spec)\.[a-z]+$/i.test(base) || base.includes("_test.");
}

/**
 * "auto" slicing: directory-slice when the repo is large enough that a
 * single whole-repo slice would overflow the lens's char cap, otherwise a
 * single slice. The threshold is the lens's own cap — a repo whose matching
 * files fit in one slice gains nothing from per-module splitting, and a
 * small repo pays for it in extra requests.
 */
function resolveSliceMode(lens: LensDefinition, files: CollectedFile[], totalChars: number): "none" | "directory" {
	if (lens.sliceBy !== "auto") return lens.sliceBy;
	return totalChars > lens.maxChars ? "directory" : "none";
}

function collectLensFiles(allFiles: string[], lens: LensDefinition, info: RepoInfo): CollectedFile[] {
	const globs = lens.globsFor(info).filter(Boolean);
	if (globs.length === 0) return [];
	const out: CollectedFile[] = [];
	for (const f of allFiles) {
		if (!isSlurpable(f)) continue;
		if (lens.skipTestFiles && isTestFile(f)) continue;
		if (!matchesAnyGlob(f, globs)) continue;
		out.push({ relPath: f, moduleName: topLevelModule(f) });
	}
	return out;
}

async function slurpFileList(
	targetDir: string,
	files: CollectedFile[],
	maxChars: number,
): Promise<FileSlice[]> {
	const slices: FileSlice[] = [];
	let currentModule = "";
	let parts: string[] = [];
	let running = 0;
	let fileCount = 0;
	let filePaths: string[] = [];

	const flush = () => {
		if (parts.length === 0) return;
		slices.push({
			moduleName: currentModule,
			content: parts.join("\n"),
			fileCount,
			chars: running,
			files: filePaths,
		});
		parts = [];
		running = 0;
		fileCount = 0;
		filePaths = [];
	};

	for (const file of files) {
		let content = "";
		try {
			content = await readFile(join(targetDir, file.relPath), "utf8");
		} catch (error) {
			// The listing is the working tree's, so this is a race with a
			// concurrent delete rather than a listed-but-deleted file; skip it.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			content = "[BINARY or UNREADABLE]";
		}
		const block = `=== ${file.relPath} ===\n${content}\n`;

		if (file.moduleName !== currentModule && parts.length > 0) {
			flush();
		}
		currentModule = file.moduleName;

		if (running + block.length > maxChars && parts.length > 0) {
			// Slice is full: flush it and start another slice for the same module
			// rather than truncating, so big modules get full coverage.
			flush();
			currentModule = file.moduleName;
		}
		parts.push(block);
		running += block.length;
		fileCount += 1;
		filePaths.push(file.relPath);
	}
	flush();
	return slices;
}

export async function gatherSlices(targetDir: string, lens: LensDefinition, info: RepoInfo): Promise<FileSlice[]> {
	if (lens.sliceBy === "none" && lens.globsFor(info).length === 0) {
		// Repo-info lens (architecture): the prompt is built from info alone.
		return [{ moduleName: "root", content: "", fileCount: 0, chars: 0, files: [] }];
	}
	const { files: allFiles } = await listRepoFiles(targetDir);
	const files = collectLensFiles(allFiles, lens, info);
	const totalChars = await sumFileSizes(targetDir, files);
	const mode = resolveSliceMode(lens, files, totalChars);
	if (mode === "none") {
		// Whole-repo slice: one module named after the repo, so a small
		// repo produces a single request instead of one per directory.
		const single = files.map((f) => ({ ...f, moduleName: info.name }));
		return slurpFileList(targetDir, single, lens.maxChars);
	}
	return slurpFileList(targetDir, files, lens.maxChars);
}

async function sumFileSizes(targetDir: string, files: CollectedFile[]): Promise<number> {
	let total = 0;
	for (const f of files) {
		try {
			total += (await stat(join(targetDir, f.relPath))).size;
		} catch {
			// Unreadable file — slurpFileList substitutes a placeholder.
		}
	}
	return total;
}

// ---------- request building ----------

export function buildBatchRequest(
	lens: LensDefinition,
	info: RepoInfo,
	slice: FileSlice,
	index: number,
	sliceCount: number,
	model: string = BROADSIDE_MODEL,
	maxTokensOverride?: number,
	reasoningOverride?: BroadsideReasoning,
): BatchRequest {
	const moduleTag = sanitizeId(slice.moduleName);
	const customId = sliceCount > 1 ? `${lens.id}-${moduleTag}-${index + 1}` : `${lens.id}-${moduleTag}`;
	return {
		custom_id: customId,
		body: {
			model,
			messages: [
				{ role: "system", content: lens.systemPrompt(info) },
				{ role: "user", content: lens.userPrompt(info, slice.content, slice.moduleName) },
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS[lens.schemaName] },
			max_tokens: maxTokensOverride ?? lens.maxTokens,
			// Always sent, never inherited: an absent field means the model's
			// own default, and that default is what truncated the JSON.
			reasoning: reasoningOverride ?? lens.reasoning ?? defaultReasoningFor(maxTokensOverride ?? lens.maxTokens),
		},
	};
}

/**
 * Pre-flight cost estimate for one lens.
 *
 * Every slice is its own batch request, so both halves scale with the slice
 * count. The output half used to be a single `maxTokens * 0.75` for the whole
 * lens no matter how many requests it sent — on a repository that sliced into
 * 13 modules that budgeted one request's output and shipped thirteen, and a
 * live run came in at roughly 3x its estimate. Since this number is what
 * `max_cost` binds against, under-counting it lets a run outspend the cap the
 * user set.
 *
 * @param info - Repo info, when the caller has it: lets the estimate include
 *   the system prompt and JSON schema each request carries. Omitted, the
 *   estimate covers slice content only, which is what the old signature did.
 */
export function estimateCost(
	lens: LensDefinition,
	slices: FileSlice[],
	pricing: ModelPricing,
	maxTokensOverride?: number,
	info?: RepoInfo,
): {
	inputTokens: number;
	outputTokens: number;
	cost: number;
} {
	// With repo info, size each request from the user prompt that would be
	// sent, which is what the architecture lens is made of: it used to be
	// estimated at a flat 6,000 chars while the entry point, manifest, README
	// excerpt and file tree it carries ran to whatever they ran to (#249).
	// Without info, the slice content alone is what the old signature covered.
	const sliceChars = slices.reduce(
		(sum, s) => sum + (info ? lens.userPrompt(info, s.content, s.moduleName).length : lens.maxChars === 0 ? 6000 : s.chars),
		0,
	);
	// The system prompt and the response schema ride on every request, so they
	// are paid once per slice rather than once per lens.
	const perRequestOverhead = info
		? (lens.systemPrompt(info)?.length ?? 0) + JSON.stringify(SCHEMAS[lens.schemaName] ?? {}).length
		: 0;
	const inputTokens = Math.ceil((sliceChars + perRequestOverhead * slices.length) / 4);
	const outputTokens = slices.length * Math.ceil((maxTokensOverride ?? lens.maxTokens) * 0.75);
	const cost =
		(inputTokens / 1_000_000) * pricing.inputPerM +
		(outputTokens / 1_000_000) * pricing.outputPerM;
	return { inputTokens, outputTokens, cost };
}

// ---------- state & config ----------

export function broadsideDirFor(cwd: string): string {
	return join(cwd, ".codecarto", BROADSIDE_DIR);
}

/**
 * Read the Broad-Side reading guide.
 *
 * It is deliberately not a post-pipeline skill under `.codecarto/skills/`: a
 * scout run is read *before* or *during* the interactive pipeline, and the
 * post-pipeline machinery gates on a completed run and wraps its prompt in
 * post-pipeline framing that would be false here. It is also readable on a
 * repository that has scout state and no workspace at all, which is why this
 * falls back to the packaged copy.
 *
 * @param cwd - Absolute path to the target repository.
 * @returns the skill text and the path it came from.
 * @throws when neither the workspace copy nor the packaged copy exists.
 */
export async function readBroadsideSkill(cwd: string): Promise<{ path: string; content: string }> {
	const candidates = [
		join(broadsideDirFor(cwd), "SKILL.md"),
		join(packagedWorkspaceDir, BROADSIDE_DIR, "SKILL.md"),
	];
	for (const path of candidates) {
		if (await pathExists(path)) return { path, content: await readFile(path, "utf8") };
	}
	throw new Error(
		`Broad-Side skill not found at ${candidates.join(" or ")}. Reinstall codecartographer-pi.`,
	);
}

export function defaultBroadsideState(): BroadsideStateFile {
	return { schema_version: BROADSIDE_STATE_SCHEMA_VERSION, runs: [] };
}

export async function loadBroadsideState(broadsideDir: string): Promise<BroadsideStateFile> {
	const statePath = join(broadsideDir, BROADSIDE_STATE_FILE);
	if (!(await pathExists(statePath))) return defaultBroadsideState();
	try {
		const raw = JSON.parse(await readFile(statePath, "utf8"));
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.runs)) return defaultBroadsideState();
		return raw as BroadsideStateFile;
	} catch {
		return defaultBroadsideState();
	}
}

/**
 * Overwrite `state.json` wholesale with `state`.
 *
 * Prefer {@link persistBroadsideRun} anywhere a live operation is recording its
 * own progress — this entry point replaces the file, so any run a concurrent
 * process recorded in the meantime is erased. It remains the right call for
 * seeding a fresh workspace and for test fixtures, where "make the file exactly
 * this" is the intent.
 */
export async function saveBroadsideState(broadsideDir: string, state: BroadsideStateFile): Promise<void> {
	await mkdir(broadsideDir, { recursive: true });
	const statePath = join(broadsideDir, BROADSIDE_STATE_FILE);
	const lock = await acquireLock(`${statePath}.lock`);
	try {
		await writeBroadsideStateFile(statePath, state);
	} finally {
		await lock.release();
	}
}

/** Serialize through a temp file so a crash mid-write cannot truncate state.json. */
async function writeBroadsideStateFile(statePath: string, state: BroadsideStateFile): Promise<void> {
	await atomicWriteFile(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Read-modify-write `state.json` under a lock.
 *
 * The lock is held only for the read-modify-write, never for the surrounding
 * operation: a `collect` can poll for the better part of an hour, and holding
 * the lock across that would push every concurrent caller past the 5s lock
 * timeout.
 */
export async function updateBroadsideStateAtomically(
	broadsideDir: string,
	mutate: (state: BroadsideStateFile) => void | Promise<void>,
): Promise<BroadsideStateFile> {
	await mkdir(broadsideDir, { recursive: true });
	const statePath = join(broadsideDir, BROADSIDE_STATE_FILE);
	const lock = await acquireLock(`${statePath}.lock`);
	try {
		const state = await loadBroadsideState(broadsideDir);
		await mutate(state);
		await writeBroadsideStateFile(statePath, state);
		return state;
	} finally {
		await lock.release();
	}
}

/**
 * Record one run's current shape, merged into whatever is on disk *now*.
 *
 * Broad-Side operations are long-lived and hold their state in memory while
 * they poll. Writing that snapshot back wholesale silently erased any run a
 * concurrent operation had recorded since it was loaded, orphaning that run's
 * paid results on disk — present as files, invisible to `list`, and unreachable
 * by `collect`, which finds its run by position in `state.runs`. Observed live:
 * a submit at 23:35 was erased by a collect that had loaded state before it and
 * wrote back at 00:08.
 *
 * Merging by run id also self-heals: a run erased by an older writer is
 * restored the next time its own operation checkpoints.
 */
export async function persistBroadsideRun(broadsideDir: string, run: BroadsideRun): Promise<BroadsideStateFile> {
	return updateBroadsideStateAtomically(broadsideDir, (state) => {
		const index = state.runs.findIndex((candidate) => candidate.id === run.id);
		if (index === -1) state.runs.push(run);
		else state.runs[index] = run;
	});
}

/** Read a `reasoning:` block from config.yaml, ignoring anything malformed. */
function parseReasoningConfig(raw: unknown): BroadsideReasoning | null {
	if (raw === false) return { enabled: false };
	if (raw === true) return { enabled: true };
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const out: BroadsideReasoning = {};
	if (typeof value.enabled === "boolean") out.enabled = value.enabled;
	if (value.effort === "minimal" || value.effort === "low" || value.effort === "medium" || value.effort === "high") out.effort = value.effort;
	if (typeof value.max_tokens === "number" && value.max_tokens > 0) out.max_tokens = value.max_tokens;
	return Object.keys(out).length > 0 ? out : null;
}

export async function loadBroadsideConfig(broadsideDir: string): Promise<BroadsideConfig> {
	const configPath = join(broadsideDir, BROADSIDE_CONFIG_FILE);
	let raw: Record<string, unknown> = {};
	if (await pathExists(configPath)) {
		try {
			raw = (await loadYamlFile<Record<string, unknown>>(configPath)) ?? {};
		} catch {
			raw = {};
		}
	}
	const lenses = Array.isArray(raw.default_lenses)
		? (raw.default_lenses.filter((l): l is BroadsideLensId => BROADSIDE_LENS_IDS.includes(l as BroadsideLensId)))
		: [];
	const rawPricing = (raw.pricing ?? {}) as Record<string, unknown>;
	const inputOverride = typeof rawPricing.input_per_m === "number" ? rawPricing.input_per_m : undefined;
	const outputOverride = typeof rawPricing.output_per_m === "number" ? rawPricing.output_per_m : undefined;
	// A malformed value falls back to the shipped default rather than failing
	// the run: config.yaml is hand-edited, and a typo in a poll budget must not
	// cost a user their batches.
	const flag = (key: string, fallback: boolean): boolean =>
		typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;
	// An override for an unknown lens id is dropped rather than carried: it can
	// only be a typo, and a silently-ignored key that looks applied is worse
	// than one that never appears.
	const lensModels: Partial<Record<BroadsideLensId, string>> = {};
	const rawLensModels = (raw.lens_models ?? {}) as Record<string, unknown>;
	for (const lensId of BROADSIDE_LENS_IDS) {
		const value = rawLensModels[lensId];
		if (typeof value === "string" && value.trim()) lensModels[lensId] = value.trim();
	}
	return {
		model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : BROADSIDE_MODEL,
		apiKey: typeof raw.api_key === "string" ? raw.api_key.trim() : "",
		defaultLenses: lenses.length > 0 ? lenses : [...BROADSIDE_LENS_IDS],
		maxCost: typeof raw.max_cost === "number" && raw.max_cost > 0 ? raw.max_cost : 0,
		pricing:
			inputOverride !== undefined && outputOverride !== undefined
				? { inputPerM: inputOverride, outputPerM: outputOverride }
				: null,
		lensModels,
		// An escape hatch, not a knob to reach for: a model whose reasoning is
		// worth paying for needs its lens maxTokens raised to cover both the
		// thinking and the answer, or the JSON truncates exactly as before.
		reasoning: parseReasoningConfig(raw.reasoning),
		incremental: flag("incremental", false),
		retryTruncated: flag("retry_truncated", true),
		includeSynthesis: flag("include_synthesis", true),
		includeTriage: flag("include_triage", true),
		waitSeconds: typeof raw.wait_seconds === "number" && raw.wait_seconds > 0 ? raw.wait_seconds : 0,
	};
}

// ---------- model catalog, pricing, benchmarks ----------

type CatalogCacheFile = {
	schema_version: number;
	fetched_at: string;
	models: Record<string, CatalogEntry>;
};

async function readCatalogCache(broadsideDir: string): Promise<CatalogCacheFile | null> {
	const cachePath = join(broadsideDir, BROADSIDE_CATALOG_CACHE_FILE);
	if (!(await pathExists(cachePath))) return null;
	try {
		const parsed = JSON.parse(await readFile(cachePath, "utf8")) as CatalogCacheFile;
		if (!parsed || typeof parsed !== "object" || typeof parsed.models !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeCatalogCache(broadsideDir: string, cache: CatalogCacheFile): Promise<void> {
	await mkdir(broadsideDir, { recursive: true });
	await writeFile(join(broadsideDir, BROADSIDE_CATALOG_CACHE_FILE), `${JSON.stringify(cache, null, "\t")}\n`, "utf8");
}

function parseCatalogEntry(raw: Record<string, unknown>): CatalogEntry | null {
	const id = String(raw.id ?? "");
	if (!id) return null;
	const p = (raw.pricing ?? {}) as { prompt?: unknown; completion?: unknown; cached_input?: unknown };
	const input = typeof p.prompt === "string" ? Number(p.prompt) : NaN;
	const output = typeof p.completion === "string" ? Number(p.completion) : NaN;
	if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
	const cached = typeof p.cached_input === "string" ? Number(p.cached_input) : NaN;
	const topProvider = (raw.top_provider ?? {}) as Record<string, unknown>;
	const contextLength = typeof raw.context_length === "number" ? raw.context_length : undefined;
	const maxCompletion =
		typeof topProvider.max_completion_tokens === "number" ? topProvider.max_completion_tokens : undefined;
	return {
		id,
		name: String(raw.name ?? id),
		inputPerM: input * 1_000_000,
		outputPerM: output * 1_000_000,
		cachedInputPerM: Number.isFinite(cached) ? cached * 1_000_000 : undefined,
		contextLength,
		maxCompletionTokens: maxCompletion,
		supportedParameters: Array.isArray(raw.supported_parameters)
			? raw.supported_parameters.map((entry) => String(entry))
			: [],
		expirationDate: typeof raw.expiration_date === "string" ? raw.expiration_date : null,
	};
}

export function builtInCatalogEntry(model: string): CatalogEntry | null {
	// The default model's rates are compile-time constants; its capabilities
	// are asserted from the shipped configuration (1M context, 64K output,
	// structured outputs used by every lens).
	if (model !== BROADSIDE_MODEL) return null;
	return {
		id: BROADSIDE_MODEL,
		name: "Google: Gemini 3.7 Flash (batch)",
		inputPerM: BROADSIDE_INPUT_PRICE_PER_M,
		outputPerM: BROADSIDE_OUTPUT_PRICE_PER_M,
		contextLength: 1_048_576,
		maxCompletionTokens: 65_536,
		supportedParameters: ["tools", "structured_outputs", "json_schema", "response_format"],
		expirationDate: null,
	};
}

export function builtInPricing(model: string): ModelPricing | null {
	const entry = builtInCatalogEntry(model);
	if (!entry) return null;
	return { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM, source: "built-in" };
}

export async function resolveCatalogEntry(
	broadsideDir: string,
	config: BroadsideConfig,
	model: string,
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<BroadsideCatalogResult> {
	// Manual overrides always win for pricing — the user is asserting a rate,
	// and a config assertion is cheaper to respect than to second-guess.
	// Capabilities stay unknown in that case: nothing is refused, nothing
	// is clamped, and the submit text says the pricing came from config.
	if (config.pricing) {
		return {
			model,
			source: "config",
			entry: {
				id: model,
				name: model,
				inputPerM: config.pricing.inputPerM,
				outputPerM: config.pricing.outputPerM,
				supportedParameters: [],
			},
		};
	}

	// On-disk cache first, then the live catalog — for the default model too.
	// Hardcoded rates used to short-circuit here, which meant a stale constant
	// could never self-correct even though the catalog was already being
	// fetched for every other model. The authoritative source wins; the
	// constants below are what we fall back to when the network is unavailable.
	const cache = await readCatalogCache(broadsideDir);
	const cached = cache?.models[model];
	if (cached && Date.now() - new Date(cache!.fetched_at).getTime() < BROADSIDE_CATALOG_CACHE_TTL_MS) {
		return { model, source: "cache", entry: cached };
	}

	// What went wrong when the live lookup produced nothing, for the error
	// below: a 401 and a dead network used to read the same — "could not
	// resolve per-token pricing" — or, for the default model, nothing at all.
	let live: CatalogEntry | null = null;
	let catalogFailure: string | null = null;
	try {
		const resp = await fetcher(BROADSIDE_MODELS_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (resp.status === 401 || resp.status === 403) {
			throw new BroadsideAuthError(resp.status, await responseDetail(resp));
		}
		if (resp.ok === false) {
			catalogFailure = `the model catalog request failed (HTTP ${resp.status}${await responseDetail(resp).then((d) => (d ? `: ${d}` : ""))})`;
		} else {
			const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
			const hit = (data.data ?? []).find((m) => String(m.id) === model);
			if (hit) live = parseCatalogEntry(hit);
			else catalogFailure = `the model catalog has no entry for "${model}"`;
		}
	} catch (error) {
		if (error instanceof BroadsideAuthError) throw error;
		live = null;
		catalogFailure = `the model catalog could not be fetched (${error instanceof Error ? error.message : String(error)})`;
	}

	if (live) {
		const updated: CatalogCacheFile = {
			schema_version: 2,
			fetched_at: new Date().toISOString(),
			models: { ...(cache?.models ?? {}) },
		};
		updated.models[model] = live;
		await writeCatalogCache(broadsideDir, updated);
		return { model, source: "live", entry: live };
	}

	// Offline fallback: the default model's rates and capabilities are known at
	// compile time, so a network failure does not have to stop a run.
	const builtIn = builtInCatalogEntry(model);
	if (builtIn) return { model, source: "built-in", entry: builtIn };

	throw new Error(
		`Could not resolve per-token pricing for batch model "${model}": ${catalogFailure ?? "no catalog entry"}. ` +
		"Set pricing.input_per_m and pricing.output_per_m in .codecarto/broadside/config.yaml " +
		"(USD per million tokens), or check the model id against https://openrouter.ai/models?variant=batch.",
	);
}

/** A short, safe excerpt of an error response body for a message. */
async function responseDetail(resp: { json?: () => Promise<unknown>; text?: () => Promise<string> }): Promise<string> {
	try {
		if (typeof resp.text === "function") {
			const text = (await resp.text()).trim();
			try {
				const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
				const message = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message;
				if (typeof message === "string" && message) return message.slice(0, 200);
			} catch {
				// not JSON; fall through to the raw excerpt
			}
			return text.replace(/\s+/g, " ").slice(0, 200);
		}
		if (typeof resp.json === "function") {
			const parsed = (await resp.json()) as { error?: { message?: unknown } | string };
			const message = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message;
			return typeof message === "string" ? message.slice(0, 200) : "";
		}
	} catch {
		// an unreadable body adds nothing to the message
	}
	return "";
}

export async function resolveModelPricing(
	broadsideDir: string,
	config: BroadsideConfig,
	model: string,
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<ModelPricing> {
	const { source, entry } = await resolveCatalogEntry(broadsideDir, config, model, apiKey, fetcher);
	if (!entry) throw new Error(`No pricing resolved for ${model}.`);
	return { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM, source };
}

/** Base slug with the OpenRouter variant suffix (e.g. `:batch`) stripped. */
function baseSlug(modelId: string): string {
	const idx = modelId.indexOf(":");
	return idx >= 0 ? modelId.slice(0, idx) : modelId;
}

export async function fetchCodingBenchmarks(
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<CodingBenchmarks | null> {
	try {
		const resp = await fetcher(`${BROADSIDE_BENCHMARKS_URL}?source=artificial-analysis&task_type=coding`, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(30_000),
		});
		const data = (await resp.json()) as { data?: Array<Record<string, unknown>>; meta?: Record<string, unknown> };
		const byBaseSlug: CodingBenchmarks["byBaseSlug"] = {};
		for (const row of data.data ?? []) {
			const slug = baseSlug(String(row.model_permaslug ?? ""));
			if (!slug) continue;
			const toIndex = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
			byBaseSlug[slug] = {
				codingIndex: toIndex(row.coding_index),
				intelligenceIndex: toIndex(row.intelligence_index),
			};
		}
		return { byBaseSlug, meta: data.meta ?? {} };
	} catch {
		return null;
	}
}

export async function listBatchModels(
	broadsideDir: string,
	config: BroadsideConfig,
	apiKey: string,
	opts: { includeBenchmarks?: boolean; fetcher?: FetchLike } = {},
): Promise<{ entries: CatalogEntry[]; source: string; benchmarks: CodingBenchmarks | null; defaultModel: string }> {
	const fetcher = opts.fetcher ?? (fetch as FetchLike);
	const resp = await fetcher(BROADSIDE_MODELS_URL, {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(30_000),
	});
	const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
	const entries: CatalogEntry[] = [];
	const seen = new Set<string>();
	for (const raw of data.data ?? []) {
		const entry = parseCatalogEntry(raw);
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (!entry.id.endsWith(":batch")) continue;
		entries.push(entry);
	}
	entries.sort((a, b) => a.inputPerM + a.outputPerM - (b.inputPerM + b.outputPerM));

	// Persist the catalog so the next submit's pricing resolution hits cache.
	const cache: CatalogCacheFile = { schema_version: 2, fetched_at: new Date().toISOString(), models: {} };
	for (const entry of entries) cache.models[entry.id] = entry;
	await writeCatalogCache(broadsideDir, cache);

	const benchmarks = opts.includeBenchmarks ? await fetchCodingBenchmarks(apiKey, fetcher) : null;
	return { entries, source: "live", benchmarks, defaultModel: config.model };
}

// ---------- batch client ----------

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>;

export async function submitBatch(
	batchRequests: BatchRequest[],
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
	model: string = BROADSIDE_MODEL,
): Promise<{ batchId: string; status: string; error?: unknown }> {
	// The OpenRouter batch endpoint stream-parses the body and requires
	// `endpoint` and `model` to serialize before `requests` — key order matters.
	const payload = {
		endpoint: "/v1/chat/completions",
		model,
		requests: batchRequests,
	};
	const resp = await fetcher(BROADSIDE_BATCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(30_000),
	});
	const data = (await resp.json()) as Record<string, unknown>;
	if (resp.status !== 202) {
		return { batchId: "", status: "rejected", error: data };
	}
	return { batchId: String(data.id), status: String(data.status) };
}

export async function fetchBatch(
	batchId: string,
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<Record<string, unknown>> {
	const resp = await fetcher(`${BROADSIDE_BATCH_URL}/${batchId}`, {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(30_000),
	});
	let data: Record<string, unknown>;
	try {
		data = (await resp.json()) as Record<string, unknown>;
	} catch (error) {
		// A gateway error page is not JSON. It used to throw out of here and
		// be retried as if the network were down; keep the status instead.
		data = { error: `non-JSON response (${error instanceof Error ? error.message : String(error)})` };
	}
	if (!data || typeof data !== "object") data = { error: "empty response" };
	// Surface the HTTP status so the poller can bail fast on auth expiry
	// instead of retrying a dead key for the whole budget.
	data.http_status = resp.status;
	return data;
}

/**
 * Batch statuses that will never produce a result.
 *
 * Deliberately excludes the synthetic `timeout` this module returns when a poll
 * budget expires: that batch is still running server-side and has already been
 * charged, so callers must come back for it rather than retire it.
 */
export const BROADSIDE_DEAD_BATCH_STATUSES: string[] = ["failed", "expired", "cancelled", "auth-failed"];

export async function pollBatchUntilTerminal(
	batchId: string,
	apiKey: string,
	opts: {
		deadlineMs?: number;
		onStatus?: (status: string, counts: Record<string, unknown>) => void;
		fetcher?: FetchLike;
		pollIntervalMs?: number;
	} = {},
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + (opts.deadlineMs ?? BROADSIDE_DEFAULT_POLL_BUDGET_MS);
	const intervalMs = opts.pollIntervalMs ?? BROADSIDE_POLL_INTERVAL_MS;
	const fetcher = opts.fetcher ?? (fetch as FetchLike);
	// A poll that runs out of budget without one good response is not a slow
	// batch. The last thing that went wrong rides on the timeout so the report
	// can tell a dead network or a failing gateway from a batch still running.
	let lastError: string | null = null;
	let sawBatch = false;
	const timedOut = (): Record<string, unknown> => ({
		id: batchId,
		status: "timeout",
		...(lastError && !sawBatch && { error: `no successful poll response; last error: ${lastError}` }),
		...(lastError && sawBatch && { last_error: lastError }),
	});
	for (;;) {
		let batch: Record<string, unknown>;
		try {
			batch = await fetchBatch(batchId, apiKey, fetcher);
		} catch (error) {
			lastError = `fetch failed (${error instanceof Error ? error.message : String(error)})`;
			if (Date.now() >= deadline) return timedOut();
			await sleep(intervalMs);
			continue;
		}
		const httpStatus = Number(batch.http_status ?? 200);
		if (httpStatus === 401 || httpStatus === 403) {
			return { id: batchId, status: "auth-failed", error: batch.error ?? batch };
		}
		if (httpStatus >= 400) {
			// A gateway or server error: retry within the budget, remembered.
			const detail = typeof batch.error === "string" ? batch.error : JSON.stringify(batch.error ?? "");
			lastError = `HTTP ${httpStatus}${detail ? ` (${detail.slice(0, 200)})` : ""}`;
			if (Date.now() >= deadline) return timedOut();
			await sleep(intervalMs);
			continue;
		}
		sawBatch = true;
		const status = String(batch.status ?? "unknown");
		const counts = (batch.request_counts ?? {}) as Record<string, unknown>;
		opts.onStatus?.(status, counts);
		if (status === "completed" || BROADSIDE_DEAD_BATCH_STATUSES.includes(status)) return batch;
		if (Date.now() >= deadline) return timedOut();
		await sleep(intervalMs);
	}
}

/**
 * Poll several batch ids in parallel against one shared deadline. Collect
 * previously polled one lens at a time, so a slow first lens serialized the
 * wall clock for lenses that had already finished server-side (#136). The
 * onStatus callback identifies the lens so progress output stays readable
 * even while the polls interleave.
 */
export async function pollBatchesConcurrently(
	entries: Array<{ lensId: BroadsideLensId; batchId: string }>,
	apiKey: string,
	opts: {
		deadlineMs?: number;
		fetcher?: FetchLike;
		pollIntervalMs?: number;
		onStatus?: (lensId: string, status: string, counts: Record<string, unknown>) => void;
	} = {},
): Promise<Map<string, Record<string, unknown>>> {
	const results = new Map<string, Record<string, unknown>>();
	const deadlineMs = opts.deadlineMs ?? BROADSIDE_DEFAULT_POLL_BUDGET_MS;
	await Promise.all(
		entries.map(async ({ lensId, batchId }) => {
			const batch = await pollBatchUntilTerminal(batchId, apiKey, {
				deadlineMs,
				fetcher: opts.fetcher,
				pollIntervalMs: opts.pollIntervalMs,
				onStatus: (status, counts) => opts.onStatus?.(lensId, status, counts),
			});
			results.set(batchId, batch);
		}),
	);
	return results;
}

// ---------- run orchestration ----------

export async function runBroadsideSubmit(
	cwd: string,
	apiKey: string,
	opts: {
		lenses?: BroadsideLensId[];
		fetcher?: FetchLike;
		model?: string;
		/** Approximate run expense limit in USD; 0 means no limit. */
		maxCost?: number;
		/** Submit even when the estimate exceeds maxCost. */
		force?: boolean;
		/** Diff against the previous run's HEAD and scan only changed modules (#142). */
		incremental?: boolean;
		/**
		 * Called with the pre-flight estimate after slicing and before any state
		 * write or submission. Returning false throws {@link BroadsideCancelledError}
		 * and nothing is submitted; returning true proceeds even past maxCost,
		 * because an interactive approval of a priced run *is* the force flag.
		 *
		 * A surface that cannot ask a human (MCP) omits this and keeps the
		 * refuse-unless-force behavior.
		 */
		confirm?: (estimate: BroadsideEstimate) => boolean | Promise<boolean>;
	} = {},
): Promise<BroadsideSubmitResult> {
	const info = await collectRepoInfo(cwd);
	// Before pricing, before the network, before any state write: a run on a
	// language the lenses cannot scan used to submit empty batches and pay for
	// them (#250).
	if (info.language === "unknown") {
		throw new Error(
			`Broad-Side could not tell what language this repository is: no ${MANIFEST_CANDIDATES.map(([candidate]) => candidate).join(", ")} ` +
			`and no source files in a language the lenses can scan (${BROADSIDE_LANGUAGES.join(", ")}). Nothing was submitted.`,
		);
	}
	if (info.sourceFileCount === 0) {
		throw new Error(
			`Broad-Side found no ${info.language} source files to scan (detected from ${info.manifest?.path ?? "the file counts"}; ` +
			`the lenses look for ${info.sourceExts.join(", ")}). Nothing was submitted.`,
		);
	}
	const lensIds = opts.lenses ?? BROADSIDE_LENS_IDS;
	const broadsideDir = broadsideDirFor(cwd);
	const model = opts.model ?? BROADSIDE_MODEL;

	// Resolve a catalog entry per distinct model before anything is submitted:
	// the guardrail must know real per-token rates, and every lens requires
	// structured-output support that not all batch models offer. Lenses may run
	// on different models (config `lens_models`), so each one is pre-flighted.
	const config = await loadBroadsideConfig(broadsideDir);
	const modelForLens = (lensId: BroadsideLensId): string => config.lensModels[lensId] ?? model;
	const resolved = new Map<
		string,
		{ pricing: ModelPricing; outputCap?: number; entry: CatalogEntry; supportsStructuredOutputs: boolean }
	>();
	for (const candidate of new Set([model, ...lensIds.map(modelForLens)])) {
		const catalog = await resolveCatalogEntry(broadsideDir, config, candidate, apiKey, opts.fetcher);
		const entry = catalog.entry;
		const supportsStructuredOutputs =
			entry.supportedParameters.length === 0 ||
			entry.supportedParameters.some((p) =>
				["structured_outputs", "json_schema", "response_format", "structuredoutputs"].includes(p.toLowerCase()),
			);
		if (!supportsStructuredOutputs) {
			throw new Error(
				`Batch model "${candidate}" does not advertise structured-output support ` +
				`(supported_parameters: ${entry.supportedParameters.join(", ") || "unknown"}), but every ` +
				"Broad-Side lens requires json_schema response_format. Choose another batch model " +
				"(codecarto_broadside action 'models') or pass a pricing override only if you know it works.",
			);
		}
		resolved.set(candidate, {
			entry,
			supportsStructuredOutputs,
			pricing: { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM, source: catalog.source },
			// Respect the provider's completion ceiling: a request asking for more
			// output than the model can produce fails the whole batch.
			...(entry.maxCompletionTokens !== undefined && { outputCap: entry.maxCompletionTokens }),
		});
	}
	const pricing = resolved.get(model)!.pricing;
	const outputCap = resolved.get(model)!.outputCap;
	const defaultEntry = resolved.get(model)!.entry;
	const limit = opts.maxCost ?? config.maxCost;

	// Incremental re-scouting (#142): diff against the previous run's HEAD
	// and scan only the modules whose files changed. Falls back to a full
	// scan when there is no prior run, the tree is dirty, or the diff fails.
	const sourceHead = await gitHead(cwd);
	const sourceDirty = await gitDirty(cwd);
	let baseHead: string | null = null;
	let changed: Set<string> | null = null;
	const incrementalOutcome: BroadsideIncrementalOutcome = {
		requested: opts.incremental === true,
		applied: false,
		baseHead: null,
	};
	if (opts.incremental) {
		const state = await loadBroadsideState(broadsideDir);
		// The baseline is the most recent run that recorded a HEAD — a
		// submit-only run (never collected) is still a valid committed base.
		const previous = [...state.runs].reverse().find((r) => r.sourceHead);
		if (sourceDirty) {
			incrementalOutcome.reason = "dirty-worktree";
		} else if (!previous?.sourceHead) {
			incrementalOutcome.reason = "no-baseline";
		} else {
			baseHead = previous.sourceHead;
			changed = await changedFilesSince(cwd, baseHead);
			incrementalOutcome.baseHead = baseHead;
			if (changed) incrementalOutcome.applied = true;
			else incrementalOutcome.reason = "diff-failed";
		}
	}

	// Slice offline first so the estimate covers every request we would send.
	const slicesByLens = new Map<BroadsideLensId, FileSlice[]>();
	let estimatedInputTokens = 0;
	let estimatedOutputTokens = 0;
	let estimatedTotalCost = 0;
	const perLensEstimate: Array<{
		lens: LensDefinition;
		cost: number;
		maxTokens: number;
		lensModel: string;
		lensPricing: ModelPricing;
		lensOutputCap?: number;
	}> = [];
	for (const lensId of lensIds) {
		const lens = getLens(lensId);
		let slices = await gatherSlices(cwd, lens, info);
		if (changed) {
			// Repo-info slices (empty files, e.g. architecture) always run;
			// file-backed slices run only when one of their files changed.
			slices = slices.filter((s) => s.files.length === 0 || s.files.some((f) => changed!.has(f)));
		}
		slicesByLens.set(lensId, slices);
		const lensModel = modelForLens(lensId);
		const { pricing: lensPricing, outputCap: lensOutputCap } = resolved.get(lensModel)!;
		const maxTokens = lensOutputCap ? Math.min(lens.maxTokens, lensOutputCap) : lens.maxTokens;
		const estimate = estimateCost(lens, slices, lensPricing, maxTokens, info);
		estimatedInputTokens += estimate.inputTokens;
		estimatedOutputTokens += estimate.outputTokens;
		estimatedTotalCost += estimate.cost;
		perLensEstimate.push({
			lens,
			cost: estimate.cost,
			maxTokens,
			lensModel,
			lensPricing,
			...(lensOutputCap !== undefined && { lensOutputCap }),
		});
	}

	const exceedsLimit = limit > 0 && estimatedTotalCost > limit;

	if (opts.confirm) {
		const approved = await opts.confirm({
			model,
			pricing,
			lenses: perLensEstimate.map(({ lens, cost, maxTokens, lensModel, lensPricing }) => ({
				lensId: lens.id,
				name: lens.name,
				slices: (slicesByLens.get(lens.id) ?? []).length,
				maxTokens,
				cost,
				model: lensModel,
				pricing: lensPricing,
			})),
			mixedModels: perLensEstimate.some(({ lensModel }) => lensModel !== model),
			totalCost: estimatedTotalCost,
			inputTokens: estimatedInputTokens,
			outputTokens: estimatedOutputTokens,
			maxCost: limit,
			exceedsLimit,
			baseHead,
			sourceDirty,
			incremental: incrementalOutcome,
			...(outputCap !== undefined && { outputCap }),
		});
		if (!approved) throw new BroadsideCancelledError();
	} else if (exceedsLimit && !opts.force) {
		const breakdown = perLensEstimate
			.map(({ lens, cost, lensModel }) =>
				`  ${lens.name}: ~$${cost.toFixed(4)}${lensModel === model ? "" : ` (${lensModel})`}`,
			)
			.join("\n");
		throw new Error(
			`Estimated Broad-Side cost ~$${estimatedTotalCost.toFixed(4)} exceeds the run limit ` +
				`$${limit.toFixed(2)}. Nothing was submitted.\nBreakdown:\n${breakdown}\n` +
				`Pass force: true to submit anyway, or raise max_cost in .codecarto/broadside/config.yaml.`,
		);
	}

	const state = await loadBroadsideState(broadsideDir);
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	const run: BroadsideRun = {
		id: runId,
		createdAt: new Date().toISOString(),
		model,
		lenses: [...lensIds],
		status: "in-flight",
		outputDir: runId,
		batches: {},
		synthesis: { status: "pending" },
		triage: { status: "pending" },
		pricing,
		maxCost: limit > 0 ? limit : undefined,
		outputCap,
		sourceHead,
		sourceDirty,
		baseHead,
		snapshot: info.snapshot,
		language: info.language,
	};
	state.runs.push(run);
	await persistBroadsideRun(broadsideDir, run);

	const requestsByCustomId: Record<string, BatchRequest> = {};
	const submissions: Promise<void>[] = [];
	// Submit from the estimate rather than recomputing: the user approved that
	// breakdown, so the request that fires must be the one that was priced.
	for (const priced of perLensEstimate) {
		const { lens, maxTokens, lensModel, lensOutputCap } = priced;
		const lensId = lens.id;
		const slices = slicesByLens.get(lensId) ?? [];
		const requests = slices.map((sl, i) => buildBatchRequest(lens, info, sl, i, slices.length, lensModel, maxTokens, config.reasoning ?? undefined));
		for (const request of requests) requestsByCustomId[request.custom_id] = request;

		const entry: BroadsideBatchEntry = {
			batchId: "",
			requests: requests.length,
			status: "submitting",
			submittedAt: new Date().toISOString(),
			estimatedCost: priced.cost,
			// Recorded per lens so collect's truncation retry re-submits against
			// the model and ceiling this lens actually used, not the run default.
			...(lensModel !== model && { model: lensModel }),
			...(lensOutputCap !== undefined && { outputCap: lensOutputCap }),
		};
		run.batches[lensId] = entry;

		if (requests.length === 0) {
			// No files matched the lens's globs. That is a coverage gap to
			// report, not a batch to submit — the API rejects empty batches.
			entry.status = "skipped";
			continue;
		}

		submissions.push(
			(async () => {
				// A network-level throw (DNS, abort, TLS) must not strand the
				// entry in "submitting" forever — allSettled would swallow the
				// rejection and collect would never see a terminal status.
				try {
					const { batchId, status, error } = await submitBatch(requests, apiKey, opts.fetcher, lensModel);
					entry.batchId = batchId;
					entry.status = status;
					if (error) entry.error = error;
				} catch (error) {
					entry.status = "rejected";
					entry.error = error instanceof Error ? error.message : String(error);
				}
			})(),
		);
	}
	await Promise.allSettled(submissions);
	await persistBroadsideRun(broadsideDir, run);

	// Persist the exact request bodies so collect can re-submit a truncated
	// slice (bumped output cap) without re-walking the repo (#133). The run
	// dir is created here rather than waiting for collect so a crash between
	// submit and collect still leaves the retry input on disk.
	const runDir = join(broadsideDir, runId);
	await mkdir(runDir, { recursive: true });
	await writeFile(join(runDir, "requests.json"), `${JSON.stringify(requestsByCustomId, null, "\t")}\n`, "utf8");

	return {
		runId,
		outputDir: join(".codecarto", BROADSIDE_DIR, runId),
		batches: run.batches,
		estimatedTotalCost,
		estimatedInputTokens,
		estimatedOutputTokens,
		pricing,
		maxCost: limit > 0 ? limit : undefined,
		// modelInfo describes the run's default model. Per-lens overrides are
		// recorded on their own batch entries.
		modelInfo: {
			contextLength: defaultEntry.contextLength,
			maxCompletionTokens: defaultEntry.maxCompletionTokens,
			supportsStructuredOutputs: defaultEntry.supportedParameters.length === 0
				? undefined
				: resolved.get(model)!.supportsStructuredOutputs,
			expirationDate: defaultEntry.expirationDate ?? null,
		},
		incremental: incrementalOutcome,
		repo: {
			language: info.language,
			sourceFiles: info.sourceFileCount,
			snapshot: info.snapshot,
			sourceHead,
			sourceDirty,
		},
	};
}

export type StoredLensResult = {
	lensId: BroadsideLensId;
	customId: string;
	moduleName: string;
	content: string;
	raw: Record<string, unknown>;
	/** True when the content is not parseable JSON even after fence stripping —
	 * the telltale of an output cut off at max_tokens. */
	truncated: boolean;
};

function extractContent(result: Record<string, unknown>): string | null {
	const response = result.response as Record<string, unknown> | undefined;
	if (!response?.body) return null;
	const body = response.body as Record<string, unknown>;
	const choices = body.choices as Array<Record<string, unknown>> | undefined;
	const message = choices?.[0]?.message as Record<string, unknown> | undefined;
	return typeof message?.content === "string" ? message.content : null;
}

/**
 * Parse lens content as JSON, tolerating the markdown code fences some models
 * wrap structured output in (the same tolerance OpenRouter's headless-agent
 * scaffold ships for --output-schema). Returns null when the content is not
 * JSON at all — which for a strict json_schema request means the output was
 * truncated at max_tokens, not that the model chose prose.
 */
export function parseLensJson(content: string): unknown | null {
	const trimmed = content.trim();
	const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
	const candidate = fenced ? fenced[1].trim() : trimmed;
	if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
	try {
		return JSON.parse(candidate);
	} catch {
		return null;
	}
}

export async function saveLensResults(
	runDir: string,
	lensId: BroadsideLensId,
	batch: Record<string, unknown>,
): Promise<StoredLensResult[]> {
	const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
	const out: StoredLensResult[] = [];
	for (const result of results) {
		const customId = String(result.custom_id ?? "unknown");
		const content = extractContent(result);
		if (content === null) {
			if (result.error) {
				await writeFile(join(runDir, `${sanitizeId(customId)}.error.json`), `${JSON.stringify(result.error, null, "\t")}\n`, "utf8");
			}
			continue;
		}
		const parsed = parseLensJson(content);
		const truncated = parsed === null;
		if (parsed !== null) {
			await writeFile(join(runDir, `${sanitizeId(customId)}.json`), `${JSON.stringify(parsed, null, "\t")}\n`, "utf8");
		} else {
			// Save the raw bytes verbatim so nothing is lost, but name the
			// gap: an unparseable strict-schema response is a truncation.
			await writeFile(join(runDir, `${sanitizeId(customId)}.json`), `${content}\n`, "utf8");
		}
		await writeFile(join(runDir, `${sanitizeId(customId)}.md`), renderFindingsMarkdown(content), "utf8");
		out.push({
			lensId,
			customId,
			moduleName: String(customId).replace(/^[a-z]+-/, ""),
			content,
			raw: result,
			truncated,
		});
	}
	return out;
}

/**
 * Rebuild lens results from what a previous collect already wrote to disk.
 *
 * The post-passes are gated on having lens findings in hand, and a collect
 * only holds the ones *it* polled. When an earlier collect saved every lens
 * and then died before synthesis and triage ran — the batch window is long
 * and a poll can easily be interrupted — the next collect finds every lens
 * already terminal, skips them all, and would otherwise reach the post-pass
 * gate with nothing to hand it. Reading the saved results back is what makes
 * "a resumed collect can finish whichever is still pending" true.
 */
export async function loadSavedLensResults(runDir: string, lenses: BroadsideLensId[]): Promise<StoredLensResult[]> {
	if (!(await pathExists(runDir))) return [];
	const reserved = new Set(["requests.json", "run-meta.json", "synthesis.json", "triage.json"]);
	const out: StoredLensResult[] = [];
	// Longest lens id first: no id is a prefix of another today, but ordering
	// keeps that from becoming a silent misattribution if one ever is.
	const ordered = [...lenses].sort((a, b) => b.length - a.length);
	for (const name of (await readdir(runDir)).sort()) {
		if (!name.endsWith(".json") || name.endsWith(".error.json") || reserved.has(name) || name.startsWith("raw-")) continue;
		const customId = name.slice(0, -".json".length);
		const lensId = ordered.find((id) => customId === id || customId.startsWith(`${id}-`));
		if (!lensId) continue;
		const content = await readFile(join(runDir, name), "utf8").catch(() => null);
		if (content === null) continue;
		out.push({
			lensId,
			customId,
			moduleName: customId.replace(/^[a-z]+-/, ""),
			content,
			raw: {},
			truncated: parseLensJson(content) === null,
		});
	}
	return out;
}

async function loadStoredRequests(runDir: string): Promise<Record<string, BatchRequest>> {
	const path = join(runDir, "requests.json");
	if (!(await pathExists(path))) return {};
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, BatchRequest>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

// ---------- post-lens passes: synthesis + triage ----------

function buildSynthesisRequest(findingsText: string, truncatedNote: string, model: string): BatchRequest {
	return {
		custom_id: "synthesis",
		body: {
			model,
			messages: [
				{
					role: "system",
					content:
						"You are a technical editor synthesizing multiple analysis reports about a single " +
						"codebase into one coherent summary. The reports come from different lenses — " +
						"architecture, API surface, security review, defect scanning, convention extraction, " +
						"and porting assessment. Cross-reference findings across lenses: if a security issue " +
						"also appears as a defect, merge them. Produce a JSON object following the " +
						"synthesis_report schema. Prioritize the most actionable findings. " +
						"Be honest about gaps — if a lens found nothing, say 'no issues found' rather than " +
						"inventing problems. These are scouting signals from a batch model, not verified " +
						"claims; note that in the summary.",
				},
				{
					role: "user",
					content:
						"Synthesize these analysis reports into a single summary.\n\n" +
						findingsText +
						truncatedNote +
						"\nReturn the synthesis_report JSON schema.",
				},
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS.synthesis },
			max_tokens: 12_000,
		},
	};
}

function buildTriageRequest(findingsText: string, truncatedNote: string, model: string): BatchRequest {
	return {
		custom_id: "triage",
		body: {
			model,
			messages: [
				{
					role: "system",
					content:
						"You are a senior engineering lead turning unverified scouting findings into a " +
						"prioritized work order. Given the findings below, produce a JSON object following " +
						"the triage_report schema. Score every lead by impact and fix difficulty, assign a " +
						"priority (P0 urgent/safety-critical to P3 nice-to-have), give a rough effort " +
						"estimate, group the queue by module where sensible, and justify each call in the " +
						"rationale. Merge duplicate leads instead of listing them twice. Drop leads that are " +
						"too vague to act on and record each drop in omitted with the reason. These findings " +
						"are UNVERIFIED scouting signals from a cheap batch model: the queue is a starting " +
						"point for re-verification, not a commitment — say so in the summary, and never " +
						"inflate a severity you cannot see evidence for.",
				},
				{
					role: "user",
					content:
						"Triage these scouting findings into a prioritized work order.\n\n" +
						findingsText +
						truncatedNote +
						"\nReturn the triage_report JSON schema.",
				},
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS.triage },
			max_tokens: 10_000,
		},
	};
}

function parseTriageItems(content: string): TriageItem[] {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const items = Array.isArray(parsed.items) ? (parsed.items as Array<Record<string, unknown>>) : [];
		return items
			.filter((item) => typeof item.title === "string")
			.map((item) => ({
				title: String(item.title),
				severity: String(item.severity ?? "unknown"),
				module: String(item.module ?? "unknown"),
				impact: (["high", "medium", "low"].includes(String(item.impact)) ? String(item.impact) : "medium") as TriageItem["impact"],
				difficulty: (["high", "medium", "low"].includes(String(item.difficulty)) ? String(item.difficulty) : "medium") as TriageItem["difficulty"],
				priority: String(item.priority ?? "?"),
				effort_estimate: String(item.effort_estimate ?? ""),
				rationale: String(item.rationale ?? ""),
			}));
	} catch {
		return [];
	}
}

export async function runBroadsideCollect(
	cwd: string,
	apiKey: string,
	opts: {
		waitMs?: number;
		includeSynthesis?: boolean;
		includeTriage?: boolean;
		/** Re-submit truncated slices once with a doubled output cap (#133). */
		retryTruncated?: boolean;
		onStatus?: (lensId: string, status: string, counts: Record<string, unknown>) => void;
		fetcher?: FetchLike;
	} = {},
): Promise<BroadsideCollectResult> {
	const broadsideDir = broadsideDirFor(cwd);
	const state = await loadBroadsideState(broadsideDir);
	const run = state.runs[state.runs.length - 1];
	if (!run) {
		throw new Error("No Broad-Side run recorded. Call codecarto_broadside with action 'submit' first.");
	}

	const runDir = join(broadsideDir, run.outputDir);
	await mkdir(runDir, { recursive: true });

	const deadline = Date.now() + (opts.waitMs ?? BROADSIDE_DEFAULT_POLL_BUDGET_MS);
	let totalCost = 0;
	let resultCount = 0;
	let truncatedCount = 0;
	const lensOutcomes: BroadsideCollectResult["lensOutcomes"] = {};

	const allLensResults: StoredLensResult[] = [];

	// Terminal entries are settled already; everything else polls in parallel
	// against one shared deadline (#136), then results save in lens order so
	// output layout stays deterministic.
	const inFlight: Array<{ lensId: BroadsideLensId; batchId: string }> = [];
	for (const lensId of run.lenses) {
		const entry = run.batches[lensId];
		if (!entry || !entry.batchId) {
			lensOutcomes[lensId] = { status: entry?.status ?? "failed", resultCount: 0 };
			continue;
		}
		if (["completed", "failed", "expired", "cancelled", "auth-failed", "skipped", "rejected"].includes(entry.status)) {
			totalCost += entry.cost ?? 0;
			resultCount += entry.resultCount ?? 0;
			lensOutcomes[lensId] = { status: entry.status, cost: entry.cost, resultCount: entry.resultCount };
			continue;
		}
		inFlight.push({ lensId, batchId: entry.batchId });
	}

	const polled = await pollBatchesConcurrently(inFlight, apiKey, {
		deadlineMs: Math.max(0, deadline - Date.now()),
		fetcher: opts.fetcher,
		onStatus: opts.onStatus,
	});

	for (const { lensId } of inFlight) {
		const entry = run.batches[lensId];
		if (!entry) continue;
		const batch = polled.get(entry.batchId) ?? { id: entry.batchId, status: "timeout" };

		const status = String(batch.status ?? "unknown");
		entry.status = status;
		if (status === "completed") {
			const usage = (batch.usage ?? {}) as Record<string, unknown>;
			const cost = typeof usage.cost === "number" ? usage.cost : undefined;
			entry.cost = cost;
			entry.completedAt = new Date().toISOString();
			const stored = await saveLensResults(runDir, lensId, batch);
			entry.resultCount = stored.length;
			const truncated = stored.filter((s) => s.truncated).length;
			allLensResults.push(...stored);
			resultCount += stored.length;
			truncatedCount += truncated;
			totalCost += cost ?? 0;
			await writeFile(
				join(runDir, `raw-${lensId}.json`),
				`${JSON.stringify(batch, null, "\t")}\n`,
				"utf8",
			);
			lensOutcomes[lensId] = { status, cost: entry.cost, resultCount: entry.resultCount, truncated };
		} else {
			// Every non-completed outcome still has to reach the report.
			// `lensOutcomes` is what the caller renders, and this branch used to
			// require `batch.error` — but the commonest failure here is the
			// synthetic `{ status: "timeout" }` the poll returns when its budget
			// expires with the batch still in flight, and that carries no error.
			// A lens that never came back was therefore omitted entirely,
			// indistinguishable in the output from one that was never requested.
			if (batch.error) entry.error = batch.error;
			const error = describeBatchError(batch.error);
			lensOutcomes[lensId] = { status, cost: entry.cost, resultCount: entry.resultCount, ...(error && { error }) };
		}
		await persistBroadsideRun(broadsideDir, run);
	}

	// #133: re-submit truncated slices once with a bumped output cap. Batch
	// requests are pure, so re-running is always safe; the aim is to recover
	// coverage the first pass lost to a max_tokens cutoff, not to loop forever.
	let retriedCount = 0;
	if (opts.retryTruncated !== false && truncatedCount > 0) {
		const requestsByCustomId = await loadStoredRequests(runDir);
		for (const stored of allLensResults) {
			if (!stored.truncated) continue;
			const original = requestsByCustomId[stored.customId];
			if (!original) continue;
			const lensEntry = run.batches[stored.lensId];
			// A lens may have run on its own model (config `lens_models`), with its
			// own completion ceiling. Re-submitting against the run default would
			// change the model mid-run and could exceed that lens's real ceiling.
			const lensModel = lensEntry?.model ?? run.model;
			const lensCap = lensEntry?.outputCap ?? run.outputCap;
			const previousMax = original.body.max_tokens ?? getLens(stored.lensId).maxTokens;
			const bumpedMax = lensCap ? Math.min(previousMax * 2, lensCap) : previousMax * 2;
			if (bumpedMax <= previousMax) continue; // already at the ceiling

			const bumped: BatchRequest = {
				...original,
				body: { ...original.body, max_tokens: bumpedMax },
			};
			try {
				const { batchId, error } = await submitBatch([bumped], apiKey, opts.fetcher, lensModel);
				if (error) continue;
				const batch = await pollBatchUntilTerminal(batchId, apiKey, {
					// Share the caller's deadline. Each of these polls used to
					// start a fresh 25-minute budget, so `wait_seconds` bounded
					// only the lens poll and a collect could run for the caller's
					// budget plus fifty minutes.
					deadlineMs: Math.max(0, deadline - Date.now()),
					onStatus: (status, counts) => opts.onStatus?.(`${stored.lensId}:retry`, status, counts),
					fetcher: opts.fetcher,
				});
				if (batch.status !== "completed") continue;
				const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
				const content = results.length > 0 ? extractContent(results[0]) : null;
				if (content === null || parseLensJson(content) === null) continue; // still no good

				const usage = (batch.usage ?? {}) as Record<string, unknown>;
				totalCost += typeof usage.cost === "number" ? usage.cost : 0;

				const parsed = parseLensJson(content);
				await writeFile(join(runDir, `${sanitizeId(stored.customId)}.json`), `${JSON.stringify(parsed, null, "\t")}\n`, "utf8");
				await writeFile(join(runDir, `${sanitizeId(stored.customId)}.md`), renderFindingsMarkdown(content), "utf8");

				stored.content = content;
				stored.truncated = false;
				retriedCount += 1;
			} catch {
				// A retry that fails to submit/poll leaves the original
				// truncated result in place — nothing is lost.
			}
		}
		truncatedCount = allLensResults.filter((s) => s.truncated).length;
		for (const [lensId, outcome] of Object.entries(lensOutcomes)) {
			if (outcome.truncated !== undefined) {
				outcome.truncated = allLensResults.filter((s) => s.lensId === lensId && s.truncated).length;
			}
		}
		await persistBroadsideRun(broadsideDir, run);
	}

	// Synthesis + triage: cross-lens post-passes, only after every lens batch
	// is terminal. Triage turns the leads into a prioritized work order.
	run.triage ??= { status: "pending" };
	let topFindings: BroadsideCollectResult["topFindings"] = [];
	let topTriageItems: BroadsideCollectResult["topTriageItems"] = [];
	const wantSynthesis = opts.includeSynthesis !== false;
	const wantTriage = opts.includeTriage !== false;
	// A resumed collect polls nothing — every lens is already terminal — so the
	// findings the post-passes need have to come back off disk, or a run whose
	// first collect was interrupted could never produce its executive report
	// and work order, however many times it was re-run.
	const postPassUnfinished = (entry: BroadsideSynthesisEntry): boolean =>
		entry.status === "pending" || entry.status === "submitted";
	if ((wantSynthesis || wantTriage) && allLensResults.length === 0
		&& (postPassUnfinished(run.synthesis) || postPassUnfinished(run.triage))) {
		const restored = await loadSavedLensResults(runDir, run.lenses);
		if (restored.length > 0) {
			allLensResults.push(...restored);
			truncatedCount = restored.filter((s) => s.truncated).length;
		}
	}
	if ((wantSynthesis || wantTriage) && allLensResults.length > 0) {
		const allTerminal = run.lenses.every((lensId) => {
			const entry = run.batches[lensId];
			return entry && ["completed", "failed", "expired", "cancelled", "auth-failed", "skipped", "rejected"].includes(entry.status);
		});
		if (allTerminal && (postPassUnfinished(run.synthesis) || postPassUnfinished(run.triage))) {
			const findingsText = allLensResults
				.map((r) => `## ${r.lensId} — ${r.customId}\n\n${r.content}\n`)
				.join("\n");
			const truncatedNote =
				truncatedCount > 0
					? `\n\nNOTE: ${truncatedCount} lens result(s) were truncated at the output token limit and are ` +
						"not included above. Any gap they would have covered is unrepresented — do not treat " +
						"silence on a module as a clean bill.\n"
					: "";

			// Both post-passes consume the same findings; they run as two
			// batches (different response_format schemas cannot share one)
			// submitted together and polled in turn.
			const passes: Array<{
				kind: "synthesis" | "triage";
				request: BatchRequest;
				entry: BroadsideSynthesisEntry;
			}> = [
				...(wantSynthesis && run.synthesis.status === "pending"
					? [{
							kind: "synthesis" as const,
							request: buildSynthesisRequest(findingsText, truncatedNote, run.model),
							entry: run.synthesis,
						}]
					: []),
				...(wantTriage && run.triage.status === "pending"
					? [{
							kind: "triage" as const,
							request: buildTriageRequest(findingsText, truncatedNote, run.model),
							entry: run.triage,
						}]
					: []),
			];

			const submitted = new Map<string, { batchId: string; pass: (typeof passes)[number] }>();

			// A pass can be left at "submitted" when an earlier collect returned
			// before its batch reached a terminal status — the batch still runs
			// and is still charged, so the result exists and is simply unclaimed.
			// Nothing above would ever look at it again: the pass list is built
			// from "pending" entries only. Poll those regardless of the want
			// flags, because the spend already happened and discarding a
			// finished result is worse than saving one the caller opted out of.
			for (const kind of ["synthesis", "triage"] as const) {
				const entry = kind === "synthesis" ? run.synthesis : run.triage;
				if (entry.status !== "submitted" || !entry.batchId) continue;
				if (submitted.has(entry.batchId)) continue;
				submitted.set(entry.batchId, {
					batchId: entry.batchId,
					pass: { kind, request: undefined as unknown as BatchRequest, entry },
				});
			}

			await Promise.allSettled(
				passes.map(async (pass) => {
					pass.entry.status = "submitted";
					try {
						const { batchId, error } = await submitBatch([pass.request], apiKey, opts.fetcher, run.model);
						if (error) {
							pass.entry.status = "failed";
							return;
						}
						pass.entry.batchId = batchId;
						submitted.set(batchId, { batchId, pass });
					} catch {
						pass.entry.status = "failed";
					}
				}),
			);
			await persistBroadsideRun(broadsideDir, run);

			for (const { batchId, pass } of submitted.values()) {
				const batch = await pollBatchUntilTerminal(batchId, apiKey, {
					// Shares the caller's deadline, as the retry poll above does.
					// A pass whose poll runs out stays `submitted`, so the batch
					// is already paid for and a later collect claims its result.
					deadlineMs: Math.max(0, deadline - Date.now()),
					onStatus: (status, counts) => opts.onStatus?.(pass.kind, status, counts),
					fetcher: opts.fetcher,
				});
				if (batch.status === "completed") {
					const usage = (batch.usage ?? {}) as Record<string, unknown>;
					const cost = typeof usage.cost === "number" ? usage.cost : undefined;
					pass.entry.status = "completed";
					pass.entry.cost = cost;
					totalCost += cost ?? 0;
					const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
					const content = results.length > 0 ? extractContent(results[0]) : null;
					if (content !== null) {
						await writeFile(join(runDir, `${pass.kind}.json`), `${content}\n`, "utf8");
						await writeFile(join(runDir, `${pass.kind}.md`), renderFindingsMarkdown(content), "utf8");
						if (pass.kind === "synthesis") {
							topFindings = parseSynthesisTopFindings(content);
						} else {
							topTriageItems = parseTriageItems(content);
						}
					}
				} else if (BROADSIDE_DEAD_BATCH_STATUSES.includes(String(batch.status))) {
					// The batch will never produce a result, so retire the pass.
					// This used to require `batch.error`, leaving an expired or
					// cancelled batch parked at "submitted" forever — and since a
					// resumed collect re-polls anything still "submitted", it
					// would re-poll a dead batch on every future run.
					pass.entry.status = "failed";
					if (batch.error) pass.entry.error = batch.error instanceof Error ? batch.error.message : String(batch.error);
				}
				// A "timeout" is deliberately left at "submitted": the batch is
				// still running server-side and has already been paid for, so a
				// later collect should claim its result rather than discard it.
				await persistBroadsideRun(broadsideDir, run);
			}
		}
	}

	const terminal = run.lenses.every((lensId) => {
		const entry = run.batches[lensId];
		return entry && ["completed", "failed", "expired", "cancelled", "auth-failed", "skipped", "rejected"].includes(entry.status);
	});
	run.status = terminal ? (resultCount > 0 ? "completed" : "failed") : "partial";
	run.totalCost = totalCost;
	await persistBroadsideRun(broadsideDir, run);

	await writeFile(
		join(runDir, "run-meta.json"),
		`${JSON.stringify(
			{
				experimental: true,
				method: "Broad-Side (OpenRouter Batch API)",
				model: run.model,
				pricing: run.pricing,
				max_cost: run.maxCost,
				run_id: run.id,
				created_at: run.createdAt,
				status: run.status,
				total_cost: totalCost,
				result_count: resultCount,
				truncated_count: truncatedCount,
				retried_count: retriedCount,
				synthesis: run.synthesis,
				triage: run.triage,
				lenses: run.lenses,
				// Which lens ran on which model. Absent means the run default —
				// a reader comparing two runs needs to know a lens changed model.
				lens_models: Object.fromEntries(
					Object.entries(run.batches)
						.filter(([, batch]) => batch?.model)
						.map(([lensId, batch]) => [lensId, batch!.model]),
				),
				disclaimer:
					"Findings are unverified scouting signals from a batch model, not validated claims. " +
					"Re-verify every file:line lead with the interactive pipeline or by hand.",
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);

	return {
		runId: run.id,
		status: run.status,
		totalCost,
		resultCount,
		truncatedCount,
		retriedCount,
		lensOutcomes,
		synthesis: run.synthesis,
		triage: run.triage,
		topFindings,
		topTriageItems,
	};
}

export async function runBroadsideStatus(cwd: string): Promise<{ state: BroadsideStateFile }> {
	const broadsideDir = broadsideDirFor(cwd);
	const state = await loadBroadsideState(broadsideDir);
	return { state };
}

// ---------- rendering ----------

export function renderFindingsMarkdown(content: string): string {
	const parsed = parseLensJson(content);
	if (parsed === null) return content;
	return formatAsMarkdown(parsed);
}

function formatAsMarkdown(value: unknown, depth = 0): string {
	const indent = "\t".repeat(depth);
	if (Array.isArray(value)) {
		const lines: string[] = [];
		for (let i = 0; i < value.length; i++) {
			const item = value[i] as Record<string, unknown>;
			if (item && typeof item === "object") {
				const title = (item.title ?? item.name ?? item.module ?? item.area ?? item.platform ?? "") as string;
				lines.push(`${indent}${i + 1}. ${title}`);
				lines.push(formatAsMarkdown(item, depth + 1));
			} else {
				lines.push(`${indent}- ${String(item)}`);
			}
		}
		return lines.join("\n");
	}
	if (value && typeof value === "object") {
		const lines: string[] = [];
		for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
			if (entryValue && typeof entryValue === "object") {
				lines.push(`${indent}**${key}**:`);
				lines.push(formatAsMarkdown(entryValue, depth + 1));
			} else {
				lines.push(`${indent}- **${key}**: ${String(entryValue)}`);
			}
		}
		return lines.join("\n");
	}
	return `${indent}${String(value)}`;
}

function parseSynthesisTopFindings(
	content: string,
): BroadsideCollectResult["topFindings"] {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const findings = Array.isArray(parsed.top_findings)
			? (parsed.top_findings as Array<Record<string, unknown>>)
			: [];
		return findings
			.filter((f) => typeof f.title === "string")
			.map((f) => ({
				title: String(f.title),
				severity: String(f.severity ?? "unknown"),
				sourceLens: String(f.source_lens ?? "unknown"),
				summary: String(f.summary ?? ""),
			}));
	} catch {
		return [];
	}
}

// ---------- formatting helpers for tool output ----------

function describeIncrementalFallback(reason: BroadsideIncrementalOutcome["reason"]): string {
	switch (reason) {
		case "dirty-worktree":
			return "the working tree has uncommitted changes, so there is no committed state to diff against";
		case "no-baseline":
			return "no earlier run recorded a commit to diff against";
		case "diff-failed":
			return "the diff against the previous run's commit could not be read";
		default:
			return "no baseline was available";
	}
}

export function estimateSubmitText(result: BroadsideSubmitResult, lenses: LensDefinition[]): string {
	// Count the lenses that actually got a batch, not every lens considered. A
	// lens with nothing to scan is reported as `skipped (0 request(s))` two
	// lines below, so counting it here made the header contradict its own body:
	// a Rust CLI with no server surface reported "submitted 6 batch(es)" over a
	// list showing four batches and two skips.
	const entries = Object.values(result.batches ?? {});
	const submittedCount = entries.filter((entry) => entry.batchId).length;
	const withoutBatch = entries.length - submittedCount;
	const lines = [
		withoutBatch > 0
			? `Broad-Side submitted ${submittedCount} batch(es); ${withoutBatch} lens(es) produced none (see below).`
			: `Broad-Side submitted ${submittedCount} batch(es).`,
	];
	for (const lens of lenses) {
		const entry = result.batches[lens.id];
		if (!entry) continue;
		const status = entry.batchId ? `batch ${entry.batchId}` : entry.status;
		const override = entry.model ? ` on ${entry.model}` : "";
		lines.push(`  ${lens.name}: ${status} (${entry.requests} request(s), ~$${entry.estimatedCost.toFixed(4)})${override}`);
	}
	if (result.repo) {
		const head = result.repo.sourceHead ? ` at ${result.repo.sourceHead.slice(0, 8)}${result.repo.sourceDirty ? " (dirty)" : ""}` : "";
		const source = result.repo.snapshot === "working-tree" ? `working tree${head}` : "directory walk (not a git repository)";
		lines.push(`Scanned as ${result.repo.language}: ${result.repo.sourceFiles} source file(s) from the ${source}.`);
	}
	const incremental = result.incremental;
	if (incremental?.requested) {
		lines.push(
			incremental.applied
				? `Incremental: scanning only what changed since ${(incremental.baseHead ?? "").slice(0, 8)}.`
				: `Incremental: requested but NOT applied — ${describeIncrementalFallback(incremental.reason)}. Every module was scanned, at full cost.`,
		);
	}
	lines.push(
		`Estimated total: ~$${result.estimatedTotalCost.toFixed(4)}`,
		`Pricing: $${result.pricing.inputPerM.toFixed(4)}/M in, $${result.pricing.outputPerM.toFixed(4)}/M out (${result.pricing.source})`,
	);
	if (result.modelInfo.contextLength) {
		lines.push(`Model: ${result.modelInfo.contextLength.toLocaleString()} context, ${result.modelInfo.maxCompletionTokens?.toLocaleString() ?? "?"} max output`);
	}
	if (result.modelInfo.supportsStructuredOutputs === false) {
		lines.push("Warning: model does not advertise structured-output support; lens JSON may be unreliable.");
	}
	if (result.modelInfo.expirationDate) {
		lines.push(`Warning: this model is deprecated (expires ${result.modelInfo.expirationDate}).`);
	}
	if (result.maxCost) {
		lines.push(`Run limit: $${result.maxCost.toFixed(2)} (enforced on estimate; pass force to override)`);
	}
	lines.push(
		`Results will land in ${result.outputDir}/`,
		"Call codecarto_broadside with action 'collect' once batches finish, or pass wait_seconds on submit to block.",
		"Disclaimer: Broad-Side findings are unverified scouting signals from a batch model, not validated claims.",
	);
	return lines.join("\n");
}

export function modelsText(
	entries: CatalogEntry[],
	opts: { benchmarks: CodingBenchmarks | null; defaultModel: string },
): string {
	const lines = [
		`Batch models on OpenRouter (${entries.length}, cheapest first).`,
		"",
		"id | $/M in | $/M out | ctx | max out | structured | coding idx",
	];
	for (const entry of entries) {
		const bench = opts.benchmarks?.byBaseSlug[baseSlug(entry.id)];
		const structured = entry.supportedParameters.length === 0
			? "?"
			: entry.supportedParameters.some((p) => ["structured_outputs", "json_schema", "response_format", "structuredoutputs"].includes(p.toLowerCase()))
				? "yes"
				: "no";
		const coding = bench?.codingIndex !== undefined ? bench.codingIndex.toFixed(1) : "-";
		const ctx = entry.contextLength
			? entry.contextLength >= 1_000_000
				? `${(entry.contextLength / 1_000_000).toFixed(1)}M`
				: `${(entry.contextLength / 1024).toFixed(0)}k`
			: "?";
		const out = entry.maxCompletionTokens ? `${(entry.maxCompletionTokens / 1024).toFixed(0)}k` : "?";
		const tag = entry.id === opts.defaultModel ? "  (default)" : "";
		const exp = entry.expirationDate ? "  [deprecated]" : "";
		lines.push(
			`${entry.id}${tag}${exp} | ${entry.inputPerM.toFixed(3)} | ${entry.outputPerM.toFixed(3)} | ${ctx} | ${out} | ${structured} | ${coding}`,
		);
	}
	if (opts.benchmarks?.meta.as_of) {
		lines.push("", `Benchmarks: Artificial Analysis coding index (as of ${String(opts.benchmarks.meta.as_of)}).`);
	}
	lines.push("", "Set the batch model in .codecarto/broadside/config.yaml (model key). Higher coding index ≠ better scout: precision, context, and structured-output support matter most here.");
	return lines.join("\n");
}

/** One line of a batch's error field, whatever shape the provider gave it. */
function describeBatchError(error: unknown): string | null {
	if (error === undefined || error === null || error === "") return null;
	if (typeof error === "string") return error.slice(0, 300);
	if (typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message) return message.slice(0, 300);
		try {
			return JSON.stringify(error).slice(0, 300);
		} catch {
			return String(error);
		}
	}
	return String(error);
}

export function collectResultText(result: BroadsideCollectResult): string {
	const lines = [
		`Broad-Side run ${result.runId}: ${result.status}`,
		`  Results: ${result.resultCount} | Total cost: $${result.totalCost.toFixed(6)}`,
	];
	for (const lensId of BROADSIDE_LENS_IDS) {
		const outcome = result.lensOutcomes[lensId];
		if (!outcome) continue;
		const truncation = outcome.truncated ? `, ${outcome.truncated} truncated` : "";
		lines.push(
			`  ${lensId}: ${outcome.status}` +
				(outcome.cost !== undefined ? `, $${outcome.cost.toFixed(6)}` : "") +
				(outcome.resultCount !== undefined ? `, ${outcome.resultCount} result(s)` : "") +
				truncation +
				// The reason a lens did not complete, when the poll recorded one:
				// an auth failure or a dead network used to read as a slow batch.
				(outcome.error ? ` — ${outcome.error}` : ""),
		);
	}
	if (result.retriedCount > 0) {
		lines.push(`  ↻ ${result.retriedCount} truncated result(s) recovered by re-submission with a doubled output cap.`);
	}
	if (result.truncatedCount > 0) {
		lines.push(
			`  ⚠ ${result.truncatedCount} result(s) still truncated after retry — their modules are unscouted, not clean.`,
		);
	}
	if (result.synthesis.status === "completed") {
		lines.push(`  synthesis: completed, $${(result.synthesis.cost ?? 0).toFixed(6)}`);
		if (result.topFindings.length > 0) {
			lines.push("", "Top findings (unverified leads):");
			for (const f of result.topFindings.slice(0, 10)) {
				lines.push(`  [${f.severity}] ${f.title}`);
			}
		}
	}
	if (result.triage.status === "completed") {
		lines.push(`  triage: completed, $${(result.triage.cost ?? 0).toFixed(6)}`);
		if (result.topTriageItems.length > 0) {
			lines.push("", "Triage — prioritized work order (re-verify before acting):");
			for (const item of result.topTriageItems.slice(0, 10)) {
				lines.push(
					`  ${item.priority} [${item.severity}/${item.module}] ${item.title}` +
					(item.effort_estimate ? ` (${item.effort_estimate})` : ""),
				);
			}
		}
	} else if (result.triage.status === "failed") {
		lines.push("  triage: failed");
	}
	lines.push("", "Disclaimer: Broad-Side findings are unverified scouting signals from a batch model, not validated claims.");
	return lines.join("\n");
}

export function statusText(state: BroadsideStateFile): string {
	if (state.runs.length === 0) {
		return "No Broad-Side runs recorded. Call codecarto_broadside with action 'submit' first.";
	}
	const lines: string[] = [];
	for (const run of [...state.runs].reverse().slice(0, 3)) {
		lines.push(`Run ${run.id} — ${run.status}`);
		// Recorded since #248; a run from an older version has neither field.
		if (run.language || run.snapshot) {
			const head = run.sourceHead ? ` at ${run.sourceHead.slice(0, 8)}${run.sourceDirty ? " (dirty)" : ""}` : "";
			const source = run.snapshot === "walk" ? "directory walk" : run.snapshot ? `working tree${head}` : "unknown source";
			lines.push(`  scanned as ${run.language ?? "unknown"} from the ${source}`);
		}
		for (const lensId of BROADSIDE_LENS_IDS) {
			const entry = run.batches[lensId];
			if (!entry) continue;
			lines.push(`  ${lensId}: ${entry.status}${entry.batchId ? ` (${entry.batchId})` : ""}${entry.cost !== undefined ? `, $${entry.cost.toFixed(6)}` : ""}`);
		}
		lines.push(`  synthesis: ${run.synthesis.status}`);
		lines.push(`  triage: ${run.triage?.status ?? "pending"}`);
		if (run.totalCost !== undefined) lines.push(`  total cost: $${run.totalCost.toFixed(6)}`);
	}
	return lines.join("\n");
}
