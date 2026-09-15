// Batch request building and cost estimation for a lens's slices.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { BROADSIDE_MODEL } from "./constants.ts";
import { type BatchRequest, type BroadsideReasoning, type FileSlice, type ModelPricing, type RepoInfo, defaultReasoningFor } from "./types.ts";
import { SCHEMAS } from "./schemas.ts";
import { type LensDefinition } from "./lenses.ts";
import { sanitizeId } from "./repo.ts";

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
				{
					role: "user",
					content:
						// A fallback scan is not "server source files": say what it is,
						// so the model judges the trust boundary wherever it appears
						// and does not report the missing server/ as a finding (#319).
						(slice.fallback
							? `NOTE: this repository has no source files under the paths this lens usually reads (${slice.fallback}). ` +
								"What follows is every source file it has, after anything those paths did match; locate the trust boundary and the request-handling code wherever they live.\n\n"
							: "") + lens.userPrompt(info, slice.content, slice.moduleName),
				},
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS[lens.schemaName] },
			max_tokens: maxTokensOverride ?? lens.maxTokens,
			// Always sent, never inherited: an absent field means the model's
			// own default, and that default is what truncated the JSON.
			reasoning: reasoningOverride ?? lens.reasoning ?? defaultReasoningFor(),
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
