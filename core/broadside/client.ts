// The OpenRouter Batch API client: submit, fetch, poll one or many batches to a terminal status.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { sleep } from "../utils.ts";
import { BROADSIDE_BATCH_URL, BROADSIDE_DEAD_BATCH_STATUSES, BROADSIDE_DEFAULT_POLL_BUDGET_MS, BROADSIDE_MODEL, BROADSIDE_POLL_INTERVAL_MS, type BroadsideLensId } from "./constants.ts";
import { type BatchRequest } from "./types.ts";

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

export async function pollBatchUntilTerminal(
	batchId: string,
	apiKey: string,
	opts: {
		deadlineMs?: number;
		onStatus?: (status: string, counts: Record<string, unknown>) => void;
		fetcher?: FetchLike;
		pollIntervalMs?: number;
		/**
		 * Stops polling early with the same synthetic `timeout` a spent budget
		 * returns: the batch keeps running server-side and a later collect
		 * claims it. The MCP server aborts when its client disconnects (#322).
		 */
		signal?: AbortSignal;
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
		if (opts.signal?.aborted) return { ...timedOut(), aborted: true };
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
		await sleepUnlessAborted(intervalMs, opts.signal);
	}
}

/** Sleep, but wake at once when the signal fires so an abort is not a poll interval late. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return sleep(ms);
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
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
		signal?: AbortSignal;
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
				signal: opts.signal,
				onStatus: (status, counts) => opts.onStatus?.(lensId, status, counts),
			});
			results.set(batchId, batch);
		}),
	);
	return results;
}

// ---------- provider errors ----------

export const NO_BATCH_ENDPOINT_RE = /does not have a :batch endpoint/i;
/** The refusal for a full per-account concurrent batch-job quota. */
export const BATCH_QUOTA_RE = /job-submission-count/i;

/** One line of a batch's error field, whatever shape the provider gave it. */
export function describeBatchError(error: unknown): string | null {
	if (error === undefined || error === null || error === "") return null;
	if (typeof error === "string") return error.slice(0, 300);
	if (typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message) return message.slice(0, 300);
		// OpenRouter wraps a submit refusal as `{ error: { message } }`.
		const nested = (error as { error?: unknown }).error;
		if (nested && typeof nested === "object") {
			const inner = (nested as { message?: unknown }).message;
			if (typeof inner === "string" && inner) return inner.slice(0, 300);
		}
		if (typeof nested === "string" && nested) return nested.slice(0, 300);
		try {
			return JSON.stringify(error).slice(0, 300);
		} catch {
			return String(error);
		}
	}
	return String(error);
}

/**
 * A provider refusal plus what to do about it, for the two refusals a batch
 * run meets in practice and cannot fix by itself (#141):
 *
 * - `Model '<id>' does not have a :batch endpoint.` — the catalog advertises a
 *   `:batch` id that OpenRouter runs no batch endpoint for. Nothing in the
 *   catalog distinguishes these; the `models` action marks ids this
 *   repository has seen refused.
 * - `job-submission-count … in use: 16, quota: 16` — the per-account limit
 *   on concurrent batch jobs. Broad-Side submits one job per lens, so a few
 *   runs in flight on the same key fill it; the refusal costs nothing.
 */
export function explainBatchError(error: unknown): string | null {
	const message = describeBatchError(error);
	if (!message) return null;
	if (NO_BATCH_ENDPOINT_RE.test(message)) {
		return `${message} — the catalog lists this id, but OpenRouter runs no batch endpoint for it. Nothing was charged; pick another model (the models action marks ids this repository has seen refused).`;
	}
	if (BATCH_QUOTA_RE.test(message)) {
		return `${message} — OpenRouter's per-account limit on concurrent batch jobs is full. Broad-Side submits one job per lens, so a few runs in flight on this key (in any repository) fill it. Nothing was charged; collect or wait out the runs in flight, then re-submit.`;
	}
	return message;
}
