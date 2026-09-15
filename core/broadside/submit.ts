// runBroadsideSubmit — pricing, confirmation, incremental scope, one batch per lens — and the stored lens results collect reads back.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BROADSIDE_DIR, BROADSIDE_LENS_IDS, BROADSIDE_MODEL, type BroadsideLensId } from "./constants.ts";
import { type BatchRequest, type BroadsideBatchEntry, BroadsideCancelledError, type BroadsideEstimate, type BroadsideIncrementalOutcome, type BroadsideRun, type BroadsideSubmitResult, type CatalogEntry, type FileSlice, type ModelPricing } from "./types.ts";
import { type LensDefinition, getLens } from "./lenses.ts";
import { BROADSIDE_LANGUAGES, MANIFEST_CANDIDATES, changedFilesSince, collectRepoInfo, gatherSlices, gitDirty, gitHead } from "./repo.ts";
import { buildBatchRequest, estimateCost } from "./requests.ts";
import { broadsideDirFor, loadBroadsideConfig, loadBroadsideState, persistBroadsideRun } from "./state.ts";
import { recordBatchEndpoints, resolveCatalogEntry } from "./models.ts";
import { type FetchLike, submitBatch } from "./client.ts";

// ---------- run orchestration ----------

export async function runBroadsideSubmit(
	cwd: string,
	apiKey: string,
	opts: {
		lenses?: BroadsideLensId[];
		fetcher?: FetchLike;
		model?: string;
		/**
		 * Per-lens model overrides for this run, layered over config.yaml's
		 * `lens_models`: a lens named here runs on this model, a lens named only
		 * in the file runs on the file's, and the rest run on `model` (#141).
		 */
		lensModels?: Partial<Record<BroadsideLensId, string>>;
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
	const lensIds = opts.lenses ?? BROADSIDE_LENS_IDS;
	const broadsideDir = broadsideDirFor(cwd);
	const model = opts.model ?? BROADSIDE_MODEL;

	// Resolve a catalog entry per distinct model before anything is submitted:
	// the guardrail must know real per-token rates, and every lens requires
	// structured-output support that not all batch models offer. Lenses may run
	// on different models (config `lens_models`), so each one is pre-flighted.
	const config = await loadBroadsideConfig(broadsideDir);
	const redact = config.redactSecrets;
	const info = await collectRepoInfo(cwd, { redact });
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
	const lensModels: Partial<Record<BroadsideLensId, string>> = { ...config.lensModels, ...opts.lensModels };
	const modelForLens = (lensId: BroadsideLensId): string => lensModels[lensId] ?? model;
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
	// Why a lens ended up with nothing to submit, for the report (see below).
	const skipReasons = new Map<BroadsideLensId, string>();
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
	// What the redaction pass did across every lens's slices, for the run
	// record and the report: a value in a file shared by two lenses counts
	// once per lens it was sent in, files once each.
	let redactedValues = info.redactedValues;
	const redactedFiles = new Set<string>();
	for (const lensId of lensIds) {
		const lens = getLens(lensId);
		let slices = await gatherSlices(cwd, lens, info, { redact });
		for (const slice of slices) {
			redactedValues += slice.redactedValues ?? 0;
			for (const file of slice.redactedFiles ?? []) redactedFiles.add(file);
		}
		const matchedBeforeIncremental = slices.length;
		if (changed) {
			// Repo-info slices (empty files, e.g. architecture) always run;
			// file-backed slices run only when one of their files changed.
			slices = slices.filter((s) => s.files.length === 0 || s.files.some((f) => changed!.has(f)));
		}
		slicesByLens.set(lensId, slices);
		if (slices.length === 0) {
			const globs = lens.globsFor(info).filter(Boolean);
			const fallbackGlobs = lens.fallbackGlobsFor?.(info).filter(Boolean) ?? [];
			skipReasons.set(
				lensId,
				globs.length === 0
					? "the lens has no file patterns for this language"
					: matchedBeforeIncremental > 0
						? "incremental: none of this lens's files changed since the previous run"
						: `no files matched ${globs.join(", ")}` +
							(fallbackGlobs.length > 0 ? ` or the fallback ${fallbackGlobs.join(", ")}` : "") +
							(lens.skipTestFiles ? " (test files excluded)" : ""),
			);
		}
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
			lenses: perLensEstimate.map(({ lens, cost, maxTokens, lensModel, lensPricing }) => {
				const fallback = (slicesByLens.get(lens.id) ?? []).find((slice) => slice.fallback)?.fallback;
				return {
					lensId: lens.id,
					name: lens.name,
					slices: (slicesByLens.get(lens.id) ?? []).length,
					maxTokens,
					cost,
					model: lensModel,
					pricing: lensPricing,
					...(fallback && { fallback }),
				};
			}),
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

	// Read before anything is posted: a state.json that cannot be read refuses
	// the run here (#233), while persistBroadsideRun below merges by run id.
	await loadBroadsideState(broadsideDir);
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
		redaction: {
			enabled: redact,
			values: redactedValues,
			files: redactedFiles.size,
			skippedFiles: info.secretFilesSkipped.length,
		},
	};
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

		const fallback = slices.find((slice) => slice.fallback)?.fallback;
		const entry: BroadsideBatchEntry = {
			batchId: "",
			requests: requests.length,
			status: "submitting",
			submittedAt: new Date().toISOString(),
			estimatedCost: priced.cost,
			// A scan of the fallback scope is recorded as such (#319).
			...(fallback && { fallback }),
			// Recorded per lens so collect's truncation retry re-submits against
			// the model and ceiling this lens actually used, not the run default.
			...(lensModel !== model && { model: lensModel }),
			...(lensOutputCap !== undefined && { outputCap: lensOutputCap }),
		};
		run.batches[lensId] = entry;

		if (requests.length === 0) {
			// No files matched the lens's globs. That is a coverage gap to
			// report, not a batch to submit — the API rejects empty batches.
			// Name the globs: a JavaScript service whose server lives at
			// src/server.js gets no security review (that lens reads server/**,
			// **/auth*, **/middleware/**), and "skipped (0 request(s))" alone
			// read as an empty repository rather than a lens that looked in
			// the wrong place.
			entry.status = "skipped";
			const reason = skipReasons.get(lensId);
			if (reason) entry.reason = reason;
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
	// A run with no batch behind it has nothing in flight. Every lens was
	// skipped or refused, so no poll will ever complete it; leaving it
	// "in-flight" had status listing a refused run above the completed ones
	// with synthesis and triage "pending" forever.
	if (!Object.values(run.batches).some((entry) => entry.batchId)) run.status = "failed";
	await persistBroadsideRun(broadsideDir, run);
	// What the provider just said about each model's batch endpoint outlives
	// the run: the `models` action reads it back (#141).
	await recordBatchEndpoints(
		broadsideDir,
		lensIds
			.map((lensId) => run.batches[lensId])
			.filter((entry): entry is BroadsideBatchEntry => Boolean(entry) && entry.status !== "skipped")
			.map((entry) => ({ model: entry.model ?? model, batchId: entry.batchId, error: entry.error })),
	);

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
		redaction: {
			enabled: redact,
			values: redactedValues,
			files: redactedFiles.size,
			skippedFiles: info.secretFilesSkipped,
		},
	};
}
