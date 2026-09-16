// Markdown rendering of results and the text both surfaces print: estimates, collect reports, model listings, status.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { describeRedactions } from "../secrets.ts";
import { BROADSIDE_LENS_IDS } from "./constants.ts";
import { type BroadsideCollectResult, type BroadsideIncrementalOutcome, type BroadsideStateFile, type BroadsideSubmitResult, type BroadsideSynthesisEntry, type CatalogEntry, type CodingBenchmarks } from "./types.ts";
import { type LensDefinition } from "./lenses.ts";
import { type BatchEndpointRecord, baseSlug } from "./models.ts";
import { explainBatchError } from "./client.ts";
import { parseLensJson } from "./results.ts";

// ---------- rendering ----------

export function parseSynthesisTopFindings(
	content: string,
): BroadsideCollectResult["topFindings"] {
	try {
		const parsed = (parseLensJson(content) ?? {}) as Record<string, unknown>;
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

export function describeIncrementalFallback(reason: BroadsideIncrementalOutcome["reason"]): string {
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
		// A rejected lens says why: the message is the only way to tell a
		// catalog id with no batch endpoint from a full job quota, and both
		// used to read as a bare "rejected". A skipped lens names the globs
		// that matched nothing.
		const reason = !entry.batchId && entry.error
			? ` — ${explainBatchError(entry.error)}`
			: !entry.batchId && entry.reason
				? ` — ${entry.reason}`
				: entry.fallback
					? ` — ${entry.fallback}`
					: "";
		lines.push(`  ${lens.name}: ${status} (${entry.requests} request(s), ~$${entry.estimatedCost.toFixed(4)})${override}${reason}`);
	}
	if (result.repo) {
		const head = result.repo.sourceHead ? ` at ${result.repo.sourceHead.slice(0, 8)}${result.repo.sourceDirty ? " (dirty)" : ""}` : "";
		const source = result.repo.snapshot === "working-tree" ? `working tree${head}` : "directory walk (not a git repository)";
		lines.push(`Scanned as ${result.repo.language}: ${result.repo.sourceFiles} source file(s) from the ${source}.`);
	}
	if (result.redaction) {
		const line = result.redaction.enabled
			? describeRedactions(result.redaction.values, result.redaction.files, result.redaction.skippedFiles)
			: "Before upload: secret redaction is OFF (redact_secrets: false in config.yaml); files were sent as they are.";
		if (line) lines.push(line);
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
	opts: { benchmarks: CodingBenchmarks | null; defaultModel: string; endpoints?: Record<string, BatchEndpointRecord> },
): string {
	const endpoints = opts.endpoints ?? {};
	const lines = [
		`Batch models on OpenRouter (${entries.length}, cheapest first).`,
		// The catalog over-reports: it returns a `:batch` id for models whose
		// Batch API refuses the job, with nothing in the entry to tell them
		// apart (#141). Say so before the table, not after it.
		"Advisory: this is the catalog's list of :batch ids, not a list of working batch endpoints. Some ids are refused at submit " +
			"(\"does not have a :batch endpoint\"), at no cost. Rows tagged [no batch endpoint …] or [batch OK …] carry what this " +
			"repository's own submits found; an untagged row has not been tried here.",
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
		const record = endpoints[entry.id];
		const seen = record
			? record.status === "rejected"
				? `  [no batch endpoint, refused ${record.at.slice(0, 10)}]`
				: `  [batch OK ${record.at.slice(0, 10)}]`
			: "";
		lines.push(
			`${entry.id}${tag}${exp}${seen} | ${entry.inputPerM.toFixed(3)} | ${entry.outputPerM.toFixed(3)} | ${ctx} | ${out} | ${structured} | ${coding}`,
		);
	}
	if (opts.benchmarks?.meta.as_of) {
		lines.push("", `Benchmarks: Artificial Analysis coding index (as of ${String(opts.benchmarks.meta.as_of)}).`);
	}
	lines.push(
		"",
		"Choose with the model parameter (--model= on Pi) for one run, lens_models (--lens-model=LENS:ID) per lens, or the model key in " +
			".codecarto/broadside/config.yaml for the repository. Higher coding index ≠ better scout: precision, context, structured-output " +
			"support, and whether the model spends its output budget reasoning (see reasoning: in config.yaml) matter most here. " +
			"A refused submit costs nothing, so probe an untried model on one lens first.",
	);
	return lines.join("\n");
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
	if (result.retryElsewhere) {
		lines.push("  ↻ The truncation retry is in flight in another collect on this run; collect again for its result.");
	}
	if (result.retryError) {
		lines.push(`  ↻ The truncation retry could not be submitted — ${result.retryError}. The truncated results stand as collected.`);
	}
	if (result.truncatedCount > 0) {
		lines.push(
			`  ⚠ ${result.truncatedCount} result(s) still truncated after retry — their modules are unscouted, not clean.`,
		);
	}
	// A pass still in flight or retired must appear: a run reported
	// "completed" with no synthesis line read as "no synthesis was run",
	// when the batch was running and a later collect would have claimed it
	// (0.22.1 live run — the collect's wait ran out during the pass).
	const passInFlight = (kind: "synthesis" | "triage", entry: BroadsideSynthesisEntry): void => {
		if (entry.status === "submitted") {
			lines.push(
				`  ${kind}: ${entry.batchId ? "still running" : "in flight in another collect"} — collect again for its result.`,
			);
		} else if (entry.status === "failed") {
			lines.push(`  ${kind}: failed${entry.error ? ` — ${explainBatchError(entry.error)}` : ""}`);
		}
	};
	// Whether a pass was built from a verify pass's verdicts is part of what
	// it is: a work order that ranked on batch severities alone is the one
	// that put two dismissed casts above the confirmed finding (#338).
	const builtFrom = (entry: BroadsideSynthesisEntry): string =>
		entry.verdicts ? ` (built from ${entry.verdicts} verdict${entry.verdicts === 1 ? "" : "s"})` : " (no verdicts)";
	if (result.regenerated && result.regenerated.length > 0) {
		lines.push(`  regenerated: ${result.regenerated.join(", ")}`);
	}
	if (result.synthesis.status === "completed") {
		lines.push(`  synthesis: completed, $${(result.synthesis.cost ?? 0).toFixed(6)}${builtFrom(result.synthesis)}`);
		if (result.topFindings.length > 0) {
			lines.push("", result.synthesis.verdicts ? "Top findings (verdicts applied; unread ones are unverified leads):" : "Top findings (unverified leads):");
			for (const f of result.topFindings.slice(0, 10)) {
				lines.push(`  [${f.severity}] ${f.title}`);
			}
		}
	} else {
		passInFlight("synthesis", result.synthesis);
	}
	if (result.triage.status === "completed") {
		lines.push(`  triage: completed, $${(result.triage.cost ?? 0).toFixed(6)}${builtFrom(result.triage)}`);
		if (result.topTriageItems.length > 0) {
			lines.push(
				"",
				result.triage.verdicts
					? "Triage — prioritized work order (confirmed findings first; re-verify the unread ones before acting):"
					: "Triage — prioritized work order (re-verify before acting):",
			);
			for (const item of result.topTriageItems.slice(0, 10)) {
				lines.push(
					`  ${item.priority} [${item.severity}/${item.module}] ${item.title}` +
					(item.effort_estimate ? ` (${item.effort_estimate})` : ""),
				);
			}
		}
	} else {
		passInFlight("triage", result.triage);
	}
	if (result.status === "completed" && !result.synthesis.verdicts && !result.triage.verdicts
		&& (result.synthesis.status === "completed" || result.triage.status === "completed")) {
		lines.push("", "Run verify, then collect --regenerate, to rebuild the report and the work order from verdicts.");
	}
	lines.push("", "Disclaimer: Broad-Side findings are unverified scouting signals from a batch model, not validated claims.");
	return lines.join("\n");
}

/**
 * An `onStatus` callback that appends one line to `lines` per *change* of a
 * lens's polled status. Every poll used to append a line, so a four-minute
 * wait returned twenty-six identical "in_progress (0/1)" lines per lens
 * before the result (0.22.0 live run).
 */
export function statusLineWriter(lines: string[]): (lensId: string, status: string, counts: Record<string, unknown>) => void {
	const last = new Map<string, string>();
	return (lensId, status, counts) => {
		const line = `  ${lensId}: ${status} (${counts.completed ?? 0}/${counts.total ?? "?"})`;
		if (last.get(lensId) === line) return;
		last.set(lensId, line);
		lines.push(line);
	};
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
			lines.push(
				`  ${lensId}: ${entry.status}${entry.batchId ? ` (${entry.batchId})` : ""}${entry.cost !== undefined ? `, $${entry.cost.toFixed(6)}` : ""}` +
					(entry.status === "skipped" && entry.reason ? ` — ${entry.reason}` : entry.fallback ? ` — ${entry.fallback}` : ""),
			);
		}
		const builtFrom = (entry: BroadsideSynthesisEntry | undefined): string =>
			entry?.status === "completed" ? (entry.verdicts ? ` (built from ${entry.verdicts} verdict${entry.verdicts === 1 ? "" : "s"})` : " (no verdicts)") : "";
		lines.push(`  synthesis: ${run.synthesis.status}${builtFrom(run.synthesis)}`);
		lines.push(`  triage: ${run.triage?.status ?? "pending"}${builtFrom(run.triage)}`);
		if (run.verify) {
			lines.push(`  verify: ${run.verify.status} — ${run.verify.confirmed} confirmed of ${run.verify.verified} read on ${run.verify.model}, $${run.verify.cost.toFixed(4)}`);
		}
		if (run.totalCost !== undefined) lines.push(`  total cost: $${run.totalCost.toFixed(6)}`);
	}
	return lines.join("\n");
}
