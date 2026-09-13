// Model selection and batch-endpoint memory (#141).
//
// core/ already routed lenses to their own models through config.yaml's
// `lens_models`, but neither surface took a model: the `models` action helped
// choose one that could then only be applied by hand-editing the file. Both
// surfaces now take `model` / `lens_models` (Pi: --model=, --lens-model=).
//
// The catalog also over-reports: it returns a `:batch` id for models whose
// Batch API refuses the job ("does not have a :batch endpoint"), with nothing
// in the entry to tell them apart. Submits now remember what the provider
// said about each model, and the listing carries it as an advisory.
//
// And the two refusals a run meets in practice — no batch endpoint, and the
// per-account concurrent-job quota — used to read as a bare "rejected" (or,
// when the quota filled after acceptance, "completed, 0 result(s)").

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
const {
	BROADSIDE_ENDPOINTS_FILE,
	BROADSIDE_MODEL,
	broadsideDirFor,
	collectResultText,
	estimateSubmitText,
	explainBatchError,
	getLens,
	listBatchModels,
	loadBroadsideConfig,
	modelsText,
	readBatchEndpoints,
	recordBatchEndpoints,
	runBroadsideCollect,
	runBroadsideSubmit,
} = core;

process.env.OPENROUTER_API_KEY = "sk-fake";

const STRONG = "vendor/strong:batch";
const GHOST = "vendor/ghost:batch";
const NO_ENDPOINT = `Model '${GHOST}' does not have a :batch endpoint.`;
const QUOTA = "invalid batch inference job: job-submission-count for account acct_1, in use: 16, quota: 16";

async function withRepo(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-model-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await mkdir(join(dir, "server"), { recursive: true });
		await writeFile(join(dir, "main.go"), "package main\n\nfunc main() {}\n");
		await writeFile(join(dir, "server", "routes.go"), "package server\n\n// GET /api/version\nfunc routes() {}\n");
		await writeFile(join(dir, "server", "auth.go"), "package server\n\nfunc auth() {}\n");
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

function response(status, body) {
	return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

const catalog = () =>
	response(200, {
		data: [
			{ id: STRONG, name: "Strong", pricing: { prompt: "0.000005", completion: "0.000025" }, context_length: 200000, top_provider: { max_completion_tokens: 32000 }, supported_parameters: ["structured_outputs"] },
			{ id: GHOST, name: "Ghost", pricing: { prompt: "0.000001", completion: "0.000002" }, context_length: 100000, top_provider: { max_completion_tokens: 8000 }, supported_parameters: ["structured_outputs"] },
			{ id: BROADSIDE_MODEL, name: "Default", pricing: { prompt: "0.000000375", completion: "0.000001875" }, context_length: 1000000, top_provider: { max_completion_tokens: 65536 }, supported_parameters: ["structured_outputs", "tools"] },
		],
	});

/**
 * Accepts every POST except one on the ghost model, which it refuses the way
 * OpenRouter does; every GET reports the batch still running.
 */
function fetcherRecording(posted) {
	return async (url, init) => {
		if (init?.method === "POST") {
			const payload = JSON.parse(init.body);
			posted.push(payload);
			if (payload.model === GHOST) return response(400, { error: { message: NO_ENDPOINT, code: 400 } });
			return response(202, { id: `batch-${posted.length}`, status: "validating" });
		}
		if (String(url).includes("/models")) return catalog();
		return response(200, { id: "x", status: "in_progress", request_counts: {} });
	};
}

async function withGlobalFetch(fetcher, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = fetcher;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
	const ui = {
		widgets: [], notifications: [], confirmations: [],
		theme: { fg: (_name, text) => text }, setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => { ui.confirmations.push({ title, body }); return true; },
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, ctx, ui };
}

// ---------- core: lensModels layered over config ----------

test("runBroadsideSubmit's lensModels layer over config.yaml's lens_models, and model replaces the default", async () => {
	await withRepo(async (dir) => {
		await mkdir(broadsideDirFor(dir), { recursive: true });
		await writeFile(join(broadsideDirFor(dir), "config.yaml"), `lens_models:\n  defect: ${STRONG}\n  security: ${STRONG}\n`);
		const posted = [];
		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["architecture", "security", "defect"],
			fetcher: fetcherRecording(posted),
			maxCost: 0,
			model: STRONG,
			// The parameter wins for security; defect keeps the file's; the
			// rest ride the run model passed in.
			lensModels: { security: BROADSIDE_MODEL },
		});
		const modelOf = (lensId) => posted.find((p) => p.requests[0].custom_id.startsWith(`${lensId}-`)).model;
		assert.equal(modelOf("architecture"), STRONG, "run model replaces the shipped default");
		assert.equal(modelOf("security"), BROADSIDE_MODEL, "the parameter's override beats the file's");
		assert.equal(modelOf("defect"), STRONG, "a lens set only in the file keeps the file's override");
		// Recorded per lens where it differs from the run model, as before.
		assert.equal(result.batches.security.model, BROADSIDE_MODEL);
		assert.equal(result.batches.architecture.model, undefined);
	});
});

// ---------- core: endpoint memory ----------

test("a submit remembers which models were accepted and which have no batch endpoint", async () => {
	await withRepo(async (dir) => {
		const posted = [];
		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["architecture", "security"],
			fetcher: fetcherRecording(posted),
			maxCost: 0,
			lensModels: { security: GHOST },
		});
		assert.equal(result.batches.architecture.status, "validating");
		assert.equal(result.batches.security.status, "rejected");

		const memory = await readBatchEndpoints(broadsideDirFor(dir));
		assert.equal(memory[BROADSIDE_MODEL].status, "accepted");
		assert.equal(memory[GHOST].status, "rejected");
		assert.match(memory[GHOST].error, /does not have a :batch endpoint/);
		assert.match(memory[GHOST].at, /^\d{4}-\d{2}-\d{2}T/);
		const raw = JSON.parse(await readFile(join(broadsideDirFor(dir), BROADSIDE_ENDPOINTS_FILE), "utf8"));
		assert.equal(raw.schema_version, 1);

		// The submit report says why, not just "rejected".
		const text = estimateSubmitText(result, ["architecture", "security"].map(getLens));
		assert.match(text, /Security[^\n]*rejected[^\n]*does not have a :batch endpoint[^\n]*runs no batch endpoint/);
		assert.match(text, /Nothing was charged/);

		// The listing carries the memory and the advisory.
		const listed = await listBatchModels(broadsideDirFor(dir), await loadBroadsideConfig(broadsideDirFor(dir)), "sk-fake", { fetcher: fetcherRecording([]) });
		assert.equal(listed.endpoints[GHOST].status, "rejected");
		const listing = modelsText(listed.entries, { benchmarks: null, defaultModel: BROADSIDE_MODEL, endpoints: listed.endpoints });
		assert.match(listing, /^Advisory: this is the catalog's list of :batch ids, not a list of working batch endpoints/m);
		assert.match(listing, new RegExp(`^${GHOST.replace(/[/.]/g, "\\$&")}[^\\n]*\\[no batch endpoint, refused \\d{4}-\\d{2}-\\d{2}\\]`, "m"));
		assert.match(listing, new RegExp(`^${BROADSIDE_MODEL.replace(/[/.]/g, "\\$&")}[^\\n]*\\(default\\)[^\\n]*\\[batch OK \\d{4}-\\d{2}-\\d{2}\\]`, "m"));
		assert.doesNotMatch(listing, new RegExp(`^${STRONG.replace(/[/.]/g, "\\$&")}[^\\n]*\\[`, "m"), "an untried model carries no tag");
		assert.match(listing, /--model=|model parameter/);
	});
});

test("only a no-batch-endpoint refusal is remembered as rejected; a quota refusal says nothing about the endpoint", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-endpoints-"));
	try {
		await recordBatchEndpoints(dir, [
			{ model: "a:batch", batchId: "batch-1" },
			{ model: "b:batch", batchId: "", error: { error: { message: NO_ENDPOINT.replace(GHOST, "b:batch") } } },
			{ model: "c:batch", batchId: "", error: { message: QUOTA } },
			{ model: "d:batch", batchId: "", error: "TypeError: fetch failed" },
		]);
		const memory = await readBatchEndpoints(dir);
		assert.equal(memory["a:batch"].status, "accepted");
		assert.equal(memory["b:batch"].status, "rejected");
		assert.equal(memory["c:batch"], undefined, "a full quota is not a missing endpoint");
		assert.equal(memory["d:batch"], undefined, "a network failure is not a missing endpoint");

		// A later accepted submit on the same key overwrites; a later unrelated
		// failure leaves the record alone.
		await recordBatchEndpoints(dir, [{ model: "b:batch", batchId: "batch-9" }, { model: "a:batch", batchId: "", error: { message: QUOTA } }]);
		const later = await readBatchEndpoints(dir);
		assert.equal(later["b:batch"].status, "accepted");
		assert.equal(later["a:batch"].status, "accepted");

		// An unreadable memory file is an empty one.
		await writeFile(join(dir, BROADSIDE_ENDPOINTS_FILE), "{not json", "utf8");
		assert.deepEqual(await readBatchEndpoints(dir), {});
		await writeFile(join(dir, BROADSIDE_ENDPOINTS_FILE), JSON.stringify({ schema_version: 99, models: { x: { status: "accepted", at: "now" } } }), "utf8");
		assert.deepEqual(await readBatchEndpoints(dir), {}, "another schema is not read");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- core: the two refusals, explained ----------

test("explainBatchError names the fix for a missing batch endpoint and for a full job quota", () => {
	assert.match(explainBatchError({ error: { message: NO_ENDPOINT } }), /runs no batch endpoint for it.*pick another model/);
	assert.match(explainBatchError(QUOTA), /per-account limit on concurrent batch jobs is full.*one job per lens.*re-submit/);
	assert.equal(explainBatchError("something else"), "something else");
	assert.equal(explainBatchError(null), null);
});

test("a batch that completed with every request refused by the quota reports the refusal, not an empty repository", async () => {
	await withRepo(async (dir) => {
		const posted = [];
		const fetcher = async (url, init) => {
			if (init?.method === "POST") {
				posted.push(JSON.parse(init.body));
				return response(202, { id: `batch-${posted.length}`, status: "validating" });
			}
			if (String(url).includes("/models")) return catalog();
			const payload = posted[Number(String(url).split("/").pop().replace(/^batch-/, "")) - 1];
			// Accepted, then every request failed — the quota filled after acceptance.
			return response(200, {
				id: "x",
				status: "completed",
				results: payload.requests.map((r) => ({ custom_id: r.custom_id, response: null, error: { message: QUOTA, code: 400 } })),
				usage: { cost: 0 },
			});
		};
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, maxCost: 0 });
		const collect = await runBroadsideCollect(dir, "sk-fake", { fetcher, includeSynthesis: false, includeTriage: false });
		assert.equal(collect.lensOutcomes.architecture.status, "completed");
		assert.equal(collect.lensOutcomes.architecture.resultCount, 0);
		assert.match(collect.lensOutcomes.architecture.error, /^all 1 request\(s\) failed: .*job-submission-count.*concurrent batch jobs is full/);
		assert.match(collectResultText(collect), /architecture: completed[^\n]*all 1 request\(s\) failed/);
	});
});

// ---------- MCP ----------

test("codecarto_broadside takes model and lens_models, validates them, and passes them to the run", async () => {
	await withRepo(async (dir) => {
		const posted = [];
		await withGlobalFetch(fetcherRecording(posted), async () => {
			for (const [args, pattern] of [
				[{ model: "" }, /model must be a non-empty/],
				[{ model: "   " }, /model must be a non-empty/],
				[{ lens_models: "x" }, /lens_models must be an object/],
				[{ lens_models: ["a"] }, /lens_models must be an object/],
				[{ lens_models: { nonsense: STRONG } }, /unknown lens "nonsense"/],
				[{ lens_models: { security: "" } }, /lens_models\.security must be a non-empty/],
				[{ lens_models: { security: 3 } }, /lens_models\.security must be a non-empty/],
			]) {
				await assert.rejects(
					server.handleBroadside({ cwd: dir, action: "submit", lenses: ["architecture"], max_cost: 0, ...args }),
					(error) => error instanceof McpError && error.code === ErrorCode.InvalidParams && pattern.test(error.message),
					`${JSON.stringify(args)} must be refused as InvalidParams`,
				);
			}
			assert.equal(posted.length, 0, "an invalid selection submits nothing");

			const result = await server.handleBroadside({
				cwd: dir,
				action: "submit",
				lenses: ["architecture", "security"],
				max_cost: 0,
				model: STRONG,
				lens_models: { security: BROADSIDE_MODEL },
			});
			const modelOf = (lensId) => posted.find((p) => p.requests[0].custom_id.startsWith(`${lensId}-`)).model;
			assert.equal(modelOf("architecture"), STRONG);
			assert.equal(modelOf("security"), BROADSIDE_MODEL);
			assert.match(result.content[0].text, /Security[^\n]*on google\/gemini-3\.7-flash:batch/);

			// The listing exposes the memory and says it is advisory.
			const models = await server.handleBroadside({ cwd: dir, action: "models" });
			assert.equal(models.structuredContent.catalogAdvisory, true);
			assert.equal(models.structuredContent.endpoints[STRONG].status, "accepted");
			assert.match(models.content[0].text, /^Advisory:/m);
			assert.match(models.content[0].text, /\[batch OK \d{4}-\d{2}-\d{2}\]/);
		});
	});
});

// ---------- Pi ----------

test("/codecarto-broadside --model= and --lens-model= reach the run", async () => {
	await withRepo(async (dir) => {
		const posted = [];
		await withGlobalFetch(fetcherRecording(posted), async () => {
			const { commands, ctx, ui } = createHarness(dir);
			await commands.get("codecarto-broadside").handler(
				`submit architecture security --max-cost=0 --model=${STRONG} --lens-model=security:${BROADSIDE_MODEL}`,
				ctx,
			);
			const errors = ui.notifications.filter((n) => n.level === "error");
			assert.deepEqual(errors, [], `no errors expected, got ${JSON.stringify(errors)}`);
			const modelOf = (lensId) => posted.find((p) => p.requests[0].custom_id.startsWith(`${lensId}-`)).model;
			assert.equal(modelOf("architecture"), STRONG);
			assert.equal(modelOf("security"), BROADSIDE_MODEL);
			// The spend dialog priced the mixed run per lens.
			assert.equal(ui.confirmations.length, 1);
			assert.match(ui.confirmations[0].body, new RegExp(STRONG.replace(/[/.]/g, "\\$&")));

			// A flag on the wrong action is refused before anything is priced.
			const before = posted.length;
			await commands.get("codecarto-broadside").handler(`collect --model=${STRONG}`, ctx);
			assert.match(ui.notifications.at(-1).message, /--model is only meaningful for submit/);
			assert.equal(posted.length, before);
		});
	});
});
