// Broad-Side auth and transport failures are named, not masked (self-audit
// #251, D-M14; mech 2.5).
//
// A 401/403 from the model catalog fell into the built-in pricing fallback
// for the default model (silently) or "Could not resolve per-token pricing"
// for any other, and the poller swallowed every fetch error until its budget
// ran out and then reported "timeout" — so a dead key or a dead network read
// as a pricing gap or a slow batch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
	BROADSIDE_MODEL,
	BroadsideAuthError,
	broadsideDirFor,
	collectResultText,
	loadBroadsideState,
	pollBatchUntilTerminal,
	resolveCatalogEntry,
	runBroadsideSubmit,
} = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);

const CONFIG = { model: BROADSIDE_MODEL, apiKey: "", defaultLenses: ["architecture"], maxCost: 0, pricing: null, lensModels: {}, reasoning: null };

function response(status, body, { asText = false } = {}) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => {
			if (asText) throw new SyntaxError("Unexpected token < in JSON");
			return body;
		},
		text: async () => text,
	};
}

async function withDir(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-auth-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

// ---------- catalog ----------

test("a 401 from the model catalog is an auth error, not a pricing gap — even for the default model", async () => {
	await withDir(async (dir) => {
		const fetcher = async () => response(401, { error: { message: "Invalid API key", code: 401 } });
		await assert.rejects(
			resolveCatalogEntry(dir, CONFIG, BROADSIDE_MODEL, "sk-bad", fetcher),
			(error) => {
				assert.ok(error instanceof BroadsideAuthError);
				assert.equal(error.httpStatus, 401);
				assert.equal(error.message, "OpenRouter rejected the API key (HTTP 401: Invalid API key). Check OPENROUTER_API_KEY, the api_key parameter, or api_key in .codecarto/broadside/config.yaml. Nothing was submitted.");
				return true;
			},
		);
		await assert.rejects(resolveCatalogEntry(dir, CONFIG, "vendor/other:batch", "sk-bad", async () => response(403, "<html>Forbidden</html>", { asText: true })), (error) => {
			assert.ok(error instanceof BroadsideAuthError);
			assert.match(error.message, /^OpenRouter rejected the API key \(HTTP 403: <html>Forbidden<\/html>\)/);
			return true;
		});
	});
});

test("a 5xx or a dead network keeps the offline fallback for the default model and names the cause otherwise", async () => {
	await withDir(async (dir) => {
		const gateway = async () => response(502, "<html>Bad Gateway</html>", { asText: true });
		const offline = async () => { throw new TypeError("fetch failed: ECONNREFUSED"); };

		const viaGateway = await resolveCatalogEntry(dir, CONFIG, BROADSIDE_MODEL, "sk-fake", gateway);
		assert.equal(viaGateway.source, "built-in");
		const viaOffline = await resolveCatalogEntry(dir, CONFIG, BROADSIDE_MODEL, "sk-fake", offline);
		assert.equal(viaOffline.source, "built-in");

		await assert.rejects(
			resolveCatalogEntry(dir, CONFIG, "vendor/other:batch", "sk-fake", gateway),
			/^Error: Could not resolve per-token pricing for batch model "vendor\/other:batch": the model catalog request failed \(HTTP 502: <html>Bad Gateway<\/html>\)\. Set pricing/,
		);
		await assert.rejects(
			resolveCatalogEntry(dir, CONFIG, "vendor/other:batch", "sk-fake", offline),
			/^Error: Could not resolve per-token pricing for batch model "vendor\/other:batch": the model catalog could not be fetched \(fetch failed: ECONNREFUSED\)\./,
		);
		await assert.rejects(
			resolveCatalogEntry(dir, CONFIG, "vendor/other:batch", "sk-fake", async () => response(200, { data: [] })),
			/: the model catalog has no entry for "vendor\/other:batch"\./,
		);
	});
});

test("submit stops at the auth error before any batch is posted or any run is recorded", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		let posted = 0;
		const fetcher = async (_url, init) => {
			if (init?.method === "POST") posted++;
			return response(401, { error: { message: "Invalid API key" } });
		};
		await assert.rejects(runBroadsideSubmit(dir, "sk-bad", { lenses: ["architecture"], fetcher }), (error) => error instanceof BroadsideAuthError);
		assert.equal(posted, 0);
		assert.deepEqual((await loadBroadsideState(broadsideDirFor(dir))).runs, []);
	});
});

// ---------- polling ----------

test("a poll that never gets a good response times out saying so, not as a slow batch", async () => {
	const offline = async () => { throw new TypeError("fetch failed: ENOTFOUND openrouter.ai"); };
	const result = await pollBatchUntilTerminal("batch-1", "sk-fake", { fetcher: offline, deadlineMs: 30, pollIntervalMs: 5 });
	assert.equal(result.status, "timeout");
	assert.equal(result.error, "no successful poll response; last error: fetch failed (fetch failed: ENOTFOUND openrouter.ai)");

	const gateway = async () => response(502, "<html>Bad Gateway</html>", { asText: true });
	const viaGateway = await pollBatchUntilTerminal("batch-1", "sk-fake", { fetcher: gateway, deadlineMs: 30, pollIntervalMs: 5 });
	assert.equal(viaGateway.status, "timeout");
	assert.match(viaGateway.error, /^no successful poll response; last error: HTTP 502 \(non-JSON response \(Unexpected token/);
});

test("a poll that saw the batch running and then lost the network is a real timeout, with the last error noted", async () => {
	let calls = 0;
	const flaky = async () => {
		calls++;
		if (calls === 1) return response(200, { id: "batch-1", status: "in_progress", request_counts: {} });
		throw new TypeError("fetch failed");
	};
	const result = await pollBatchUntilTerminal("batch-1", "sk-fake", { fetcher: flaky, deadlineMs: 30, pollIntervalMs: 5 });
	assert.equal(result.status, "timeout");
	assert.equal(result.error, undefined, "the batch is running; this is not a failure to report");
	assert.equal(result.last_error, "fetch failed (fetch failed)");
});

test("a 401 mid-poll is still auth-failed, immediately", async () => {
	let calls = 0;
	const result = await pollBatchUntilTerminal("batch-1", "sk-fake", {
		fetcher: async () => { calls++; return response(401, { error: { message: "expired" } }); },
		deadlineMs: 10_000,
		pollIntervalMs: 5,
	});
	assert.equal(result.status, "auth-failed");
	assert.equal(calls, 1);
});

// ---------- the collect report ----------

test("the collect report carries a lens's error on its line", () => {
	const base = {
		runId: "r",
		status: "partial",
		totalCost: 0,
		resultCount: 0,
		truncatedCount: 0,
		retriedCount: 0,
		lensOutcomes: {
			architecture: { status: "completed", cost: 0.01, resultCount: 1 },
			api: { status: "timeout", error: "no successful poll response; last error: fetch failed (ENOTFOUND)" },
			security: { status: "auth-failed", error: "Invalid API key" },
		},
		synthesis: { status: "pending" },
		triage: { status: "pending" },
		topFindings: [],
		topTriageItems: [],
	};
	const text = collectResultText(base);
	assert.match(text, /^  architecture: completed, \$0\.010000, 1 result\(s\)$/m);
	assert.match(text, /^  api: timeout — no successful poll response; last error: fetch failed \(ENOTFOUND\)$/m);
	assert.match(text, /^  security: auth-failed — Invalid API key$/m);
});
