// The model catalog, pricing, benchmarks, and the per-repository batch-endpoint memory.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, pathExists } from "../utils.ts";
import { BROADSIDE_BENCHMARKS_URL, BROADSIDE_CATALOG_CACHE_FILE, BROADSIDE_CATALOG_CACHE_TTL_MS, BROADSIDE_ENDPOINTS_FILE, BROADSIDE_INPUT_PRICE_PER_M, BROADSIDE_MODEL, BROADSIDE_MODELS_URL, BROADSIDE_OUTPUT_PRICE_PER_M } from "./constants.ts";
import { BroadsideAuthError, type BroadsideCatalogResult, type BroadsideConfig, type CatalogEntry, type CodingBenchmarks, type ModelPricing } from "./types.ts";
import { NO_BATCH_ENDPOINT_RE, describeBatchError, type FetchLike } from "./client.ts";

// ---------- model catalog, pricing, benchmarks ----------

/** The catalog cache schema this build writes; a file from another is not read. */
export const BROADSIDE_CATALOG_CACHE_SCHEMA = 3;

/**
 * Schema 3 stamps each entry with its own `fetched_at`. Schema 2 carried one
 * stamp for the file, so writing one freshly fetched model rewrote it and
 * every other cached model's price inherited a fresh 24 h TTL — a stale price
 * could persist indefinitely (self-audit mech 1.9). A schema-2 file is still
 * read, with the file's stamp standing in for each entry's; anything else is
 * treated as absent, which is what checking the version you write is for
 * (sem 5.10).
 */
type CatalogCacheFile = {
	schema_version: number;
	fetched_at: string;
	models: Record<string, CatalogEntry & { fetched_at?: string }>;
};

async function readCatalogCache(broadsideDir: string): Promise<CatalogCacheFile | null> {
	const cachePath = join(broadsideDir, BROADSIDE_CATALOG_CACHE_FILE);
	if (!(await pathExists(cachePath))) return null;
	try {
		const parsed = JSON.parse(await readFile(cachePath, "utf8")) as CatalogCacheFile;
		if (!parsed || typeof parsed !== "object" || !parsed.models || typeof parsed.models !== "object") return null;
		if (parsed.schema_version !== BROADSIDE_CATALOG_CACHE_SCHEMA && parsed.schema_version !== 2) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** When a cached entry was fetched: its own stamp, or the file's for a schema-2 cache. */
function catalogEntryFetchedAt(cache: CatalogCacheFile, model: string): number {
	const stamp = cache.models[model]?.fetched_at ?? cache.fetched_at;
	return new Date(stamp).getTime();
}

async function writeCatalogCache(broadsideDir: string, cache: CatalogCacheFile): Promise<void> {
	await mkdir(broadsideDir, { recursive: true });
	await writeFile(join(broadsideDir, BROADSIDE_CATALOG_CACHE_FILE), `${JSON.stringify(cache, null, "\t")}\n`, "utf8");
}

/** One model's most recent submit outcome, as remembered in {@link BROADSIDE_ENDPOINTS_FILE}. */
export type BatchEndpointRecord = {
	status: "accepted" | "rejected";
	/** ISO timestamp of the submit that produced this record. */
	at: string;
	/** The provider's refusal, for a rejected endpoint. */
	error?: string;
};

type EndpointsFile = { schema_version: number; models: Record<string, BatchEndpointRecord> };
const BROADSIDE_ENDPOINTS_SCHEMA = 1;

export async function readBatchEndpoints(broadsideDir: string): Promise<Record<string, BatchEndpointRecord>> {
	const path = join(broadsideDir, BROADSIDE_ENDPOINTS_FILE);
	if (!(await pathExists(path))) return {};
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as EndpointsFile;
		if (!parsed || typeof parsed !== "object" || parsed.schema_version !== BROADSIDE_ENDPOINTS_SCHEMA) return {};
		if (!parsed.models || typeof parsed.models !== "object") return {};
		const out: Record<string, BatchEndpointRecord> = {};
		for (const [model, record] of Object.entries(parsed.models)) {
			if (!record || typeof record !== "object") continue;
			if (record.status !== "accepted" && record.status !== "rejected") continue;
			if (typeof record.at !== "string") continue;
			out[model] = { status: record.status, at: record.at, ...(typeof record.error === "string" && { error: record.error }) };
		}
		return out;
	} catch {
		// An unreadable memory is an empty one: it only annotates a listing.
		return {};
	}
}

/**
 * The refusal OpenRouter returns for a catalog id that has no batch endpoint
 * behind it. Matched loosely: the message is the only signal there is.
 */

/**
 * Remember what a submit learned about each model it posted to. An accepted
 * job proves the endpoint exists; a "does not have a :batch endpoint"
 * refusal proves it does not. Any other rejection (quota, malformed request,
 * auth) says nothing about the endpoint and leaves the record alone.
 */
export async function recordBatchEndpoints(
	broadsideDir: string,
	outcomes: Array<{ model: string; batchId: string; error?: unknown }>,
): Promise<void> {
	const at = new Date().toISOString();
	const updates: Record<string, BatchEndpointRecord> = {};
	for (const { model, batchId, error } of outcomes) {
		if (batchId) {
			updates[model] = { status: "accepted", at };
			continue;
		}
		const message = describeBatchError(error);
		if (message && NO_BATCH_ENDPOINT_RE.test(message)) {
			updates[model] = { status: "rejected", at, error: message };
		}
	}
	if (Object.keys(updates).length === 0) return;
	const models = { ...(await readBatchEndpoints(broadsideDir)), ...updates };
	await mkdir(broadsideDir, { recursive: true });
	const file: EndpointsFile = { schema_version: BROADSIDE_ENDPOINTS_SCHEMA, models };
	await atomicWriteFile(join(broadsideDir, BROADSIDE_ENDPOINTS_FILE), `${JSON.stringify(file, null, "\t")}\n`);
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
	if (cache && cached && Date.now() - catalogEntryFetchedAt(cache, model) < BROADSIDE_CATALOG_CACHE_TTL_MS) {
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
		const now = new Date().toISOString();
		const updated: CatalogCacheFile = {
			schema_version: BROADSIDE_CATALOG_CACHE_SCHEMA,
			fetched_at: now,
			// Other entries keep their own stamps (a schema-2 file's entries
			// inherit the file's, once, on this upgrade); only this model is fresh.
			models: Object.fromEntries(
				Object.entries(cache?.models ?? {}).map(([id, entry]) => [id, { ...entry, fetched_at: entry.fetched_at ?? cache!.fetched_at }]),
			),
		};
		updated.models[model] = { ...live, fetched_at: now };
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
export function baseSlug(modelId: string): string {
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
): Promise<{
	entries: CatalogEntry[];
	source: string;
	benchmarks: CodingBenchmarks | null;
	defaultModel: string;
	/** This repository's remembered submit outcomes per model, from {@link BROADSIDE_ENDPOINTS_FILE}. */
	endpoints: Record<string, BatchEndpointRecord>;
}> {
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
	const fetchedAt = new Date().toISOString();
	const cache: CatalogCacheFile = { schema_version: BROADSIDE_CATALOG_CACHE_SCHEMA, fetched_at: fetchedAt, models: {} };
	for (const entry of entries) cache.models[entry.id] = { ...entry, fetched_at: fetchedAt };
	await writeCatalogCache(broadsideDir, cache);

	const benchmarks = opts.includeBenchmarks ? await fetchCodingBenchmarks(apiKey, fetcher) : null;
	const endpoints = await readBatchEndpoints(broadsideDir);
	return { entries, source: "live", benchmarks, defaultModel: config.model, endpoints };
}
