// Broad-Side constants: model, endpoints, file names, defaults.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.


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
/**
 * What this repository's own submits learned about batch endpoints: which
 * `:batch` ids OpenRouter accepted a job for and which it refused with
 * "does not have a :batch endpoint". The catalog cannot tell the two apart
 * (#141), so the `models` action annotates its rows from this file.
 */
export const BROADSIDE_ENDPOINTS_FILE = "batch-endpoints.json";
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

/**
 * The run expense limit in USD a repository gets before it configures one.
 * Pi asks a human before submitting over the estimate; the MCP surface cannot,
 * and shipped with no limit at all, so a host calling submit with the stock
 * config spent whatever the estimate came to (#231). One dollar covers a
 * six-lens run of a repository this size with room to spare; a larger one
 * raises `max_cost` in config.yaml, passes `max_cost` on the call, or sets it
 * to 0 for no limit.
 */
export const BROADSIDE_DEFAULT_MAX_COST = 1;

// Batch and entry status sets, here rather than beside the client that
// produces them so the state module can rank entries without importing a
// module above it in the layer order (#371).
/**
 * Batch statuses that will never produce a result.
 *
 * Deliberately excludes the synthetic `timeout` this module returns when a poll
 * budget expires: that batch is still running server-side and has already been
 * charged, so callers must come back for it rather than retire it.
 */
export const BROADSIDE_DEAD_BATCH_STATUSES: string[] = ["failed", "expired", "cancelled", "auth-failed"];

/**
 * Batch entry statuses collect never polls again: the dead ones above, plus
 * `completed`, plus the two a submit assigns without a batch (`skipped`: no
 * matching files; `rejected`: the provider refused it). The 0.19.1 changelog
 * called the dead set "a named constant rather than two hand-maintained
 * lists"; this set was still three literal copies (self-audit sem 5.8).
 */
export const BROADSIDE_TERMINAL_ENTRY_STATUSES: string[] = ["completed", ...BROADSIDE_DEAD_BATCH_STATUSES, "skipped", "rejected"];
