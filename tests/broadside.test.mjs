// Broad-Side unit tests. No network: the batch client is exercised through an
// injected fake fetcher, and file collection runs against temp fixtures built
// in-memory. The real OpenRouter API is covered by a manual smoke path, not
// this suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(join(REPO_ROOT, "core/index.ts")).href);

const {
	BROADSIDE_LENS_IDS,
	BROADSIDE_MODEL,
	buildBatchRequest,
	builtInPricing,
	collectRepoInfo,
	defaultBroadsideState,
	estimateCost,
	gatherSlices,
	getLens,
	loadBroadsideConfig,
	loadBroadsideState,
	listLenses,
	renderFindingsMarkdown,
	resolveModelPricing,
	runBroadsideCollect,
	runBroadsideStatus,
	runBroadsideSubmit,
	saveBroadsideState,
	submitBatch,
} = core;

// ---------- lens registry ----------

test("the registry carries six lenses with unique schema names", () => {
	const lenses = listLenses();
	assert.equal(lenses.length, 6);
	assert.deepEqual(
		lenses.map((l) => l.id).sort(),
		[...BROADSIDE_LENS_IDS].sort(),
	);
	const schemaNames = new Set();
	for (const lens of lenses) {
		schemaNames.add(lens.schemaName);
		assert.ok(lens.name.length > 5, "every lens needs a human-readable name");
		assert.ok(lens.systemPrompt({ language: "go" }).length > 100);
	}
	assert.equal(schemaNames.size, 6, "each lens must declare its own schema");
});

// ---------- file collection ----------

async function makeFixture() {
	const dir = await mkdtemp(join(tmpdir(), "broadside-fixture-"));
	await mkdir(join(dir, "server"), { recursive: true });
	await mkdir(join(dir, "model", "deep"), { recursive: true });
	await writeFile(join(dir, "go.mod"), "module example.com/fixture\n\ngo 1.26.0\n");
	await writeFile(join(dir, "main.go"), "package main\n\nfunc main() {}\n");
	await writeFile(join(dir, "server", "routes.go"), "package server\n\n// GET /api/version\nfunc routes() {}\n");
	await writeFile(join(dir, "server", "auth.go"), "package server\n\nfunc auth() {}\n");
	await writeFile(join(dir, "model", "core.go"), "package model\n\nfunc core() {}\n");
	await writeFile(join(dir, "model", "deep", "nested.go"), "package deep\n\nfunc nested() {}\n");
	await writeFile(join(dir, "README.md"), "# Fixture\n");
	return dir;
}

test("collectRepoInfo detects Go and gathers manifest, tree, and counts", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		assert.equal(info.language, "go");
		assert.ok(info.manifest, "go.mod must be found");
		assert.equal(info.manifest.path, "go.mod");
		assert.match(info.fileTree, /server\/routes\.go/);
		assert.ok(info.fileCounts[".go"] >= 5, "five go files expected");
		assert.equal(info.sourceGlob, "**/*.go");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("directory slicing puts nested files under their top-level module", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const slices = await gatherSlices(dir, lens, info);
		const byModule = Object.fromEntries(slices.map((s) => [s.moduleName, s]));
		assert.ok(byModule.server, "server/ must be its own slice");
		assert.ok(byModule.model, "model/ must be its own slice");
		assert.ok(byModule.root, "top-level main.go must land in the root slice");
		assert.match(byModule.server.content, /server\/routes\.go/);
		assert.match(byModule.model.content, /model\/deep\/nested\.go/, "nested files belong to the top-level module");
		assert.match(byModule.root.content, /main\.go/);
		for (const slice of slices) {
			assert.ok(slice.chars <= lens.maxChars);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("oversized modules split into multiple slices instead of truncating", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-split-"));
	try {
		await mkdir(join(dir, "big"));
		await writeFile(join(dir, "go.mod"), "module x\n");
		for (let i = 0; i < 80; i++) {
			await writeFile(join(dir, "big", `file${i}.go`), "package big\n" + `// ${"x".repeat(2000)}\n`);
		}
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const slices = await gatherSlices(dir, lens, info);
		const big = slices.filter((s) => s.moduleName === "big");
		assert.ok(big.length >= 2, `expected split slices, got ${big.length}`);
		const totalChars = big.reduce((sum, s) => sum + s.chars, 0);
		assert.ok(totalChars > 20 * 2000, "split slices must carry all content, not drop it");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("architecture lens needs no file slurping and builds from repo info", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("architecture");
		const slices = await gatherSlices(dir, lens, info);
		assert.equal(slices.length, 1);
		const request = buildBatchRequest(lens, info, slices[0], 0, 1);
		assert.equal(request.custom_id, "architecture-root");
		assert.match(request.body.messages[1].content, /module example\.com\/fixture/);
		assert.equal(request.body.model, BROADSIDE_MODEL);
		assert.equal(request.body.response_format.json_schema.name, "architecture_report");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("api and security lenses skip test files; conventions keeps them", async () => {
	const dir = await makeFixture();
	try {
		await writeFile(join(dir, "server", "routes_test.go"), "package server\n");
		const info = await collectRepoInfo(dir);
		const apiSlices = await gatherSlices(dir, getLens("api"), info);
		const apiText = apiSlices.map((s) => s.content).join("\n");
		assert.ok(!apiText.includes("routes_test.go"), "api lens must skip test files");
		const securitySlices = await gatherSlices(dir, getLens("security"), info);
		const securityText = securitySlices.map((s) => s.content).join("\n");
		assert.ok(!securityText.includes("routes_test.go"), "security lens must skip test files");
		const conventionsSlices = await gatherSlices(dir, getLens("conventions"), info);
		const convText = conventionsSlices.map((s) => s.content).join("\n");
		assert.ok(convText.includes("routes_test.go"), "conventions lens must catalog test files");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("submit marks a lens with no matching files as skipped, never submitting an empty batch", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-empty-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		const posted = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				posted.push(JSON.parse(init.body));
				return fakeResponse(202, { id: `batch-${posted.length}`, status: "validating" });
			}
			return fakeResponse(200, { id: "x", status: "completed" });
		};
		// api lens globs target server/ and api/ — neither exists here.
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture", "api"], fetcher });
		assert.equal(result.batches.api.status, "skipped");
		assert.equal(posted.length, 1, "only the architecture batch may be submitted");
		assert.ok(posted[0].requests.length > 0, "submitted batches must be non-empty");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a network throw during submission marks the entry rejected, not stuck submitting", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-throw-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		const fetcher = async () => {
			throw new Error("ECONNREFUSED");
		};
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		assert.equal(result.batches.architecture.status, "rejected");
		assert.ok(result.batches.architecture.error, "the failure reason must be recorded");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- cost estimation ----------

test("estimateCost matches the documented per-token pricing", () => {
	const lens = getLens("defect");
	const slices = [
		{ moduleName: "a", content: "x".repeat(4000), fileCount: 1, chars: 4000 },
		{ moduleName: "b", content: "y".repeat(4000), fileCount: 1, chars: 4000 },
	];
	const pricing = { inputPerM: 0.1875, outputPerM: 0.9375, source: "built-in" };
	const { inputTokens, outputTokens, cost } = estimateCost(lens, slices, pricing);
	assert.equal(inputTokens, 2000); // 8000 chars / 4
	assert.equal(outputTokens, 4500); // maxTokens 6000 * 0.75
	const expected = (2000 / 1e6) * 0.1875 + (4500 / 1e6) * 0.9375;
	assert.ok(Math.abs(cost - expected) < 1e-12);
});

test("estimateCost scales with the pricing table, not the default model", () => {
	const lens = getLens("defect");
	const slices = [{ moduleName: "a", content: "x".repeat(40000), fileCount: 1, chars: 40000 }];
	const cheap = estimateCost(lens, slices, { inputPerM: 0.1875, outputPerM: 0.9375, source: "built-in" });
	const expensive = estimateCost(lens, slices, { inputPerM: 3.75, outputPerM: 84, source: "live" });
	assert.ok(expensive.cost > cheap.cost * 20, "an $84/M output model must estimate far higher");
});

// ---------- state & config ----------

test("state round-trips and defaults to an empty run list", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-state-"));
	try {
		const state = await loadBroadsideState(dir);
		assert.deepEqual(state, defaultBroadsideState());
		state.runs.push({
			id: "run-1",
			createdAt: "2026-08-23T00:00:00Z",
			model: BROADSIDE_MODEL,
			lenses: ["architecture"],
			status: "in-flight",
			outputDir: "run-1",
			batches: {},
			synthesis: { status: "pending" },
		});
		await saveBroadsideState(dir, state);
		const reloaded = await loadBroadsideState(dir);
		assert.equal(reloaded.runs.length, 1);
		assert.equal(reloaded.runs[0].id, "run-1");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("corrupt state files degrade to defaults, not crashes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-corrupt-"));
	try {
		await writeFile(join(dir, "state.json"), "{ this is not json");
		const state = await loadBroadsideState(dir);
		assert.equal(state.runs.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("config falls back to defaults and honors overrides", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-config-"));
	try {
		const defaults = await loadBroadsideConfig(dir);
		assert.equal(defaults.model, BROADSIDE_MODEL);
		assert.equal(defaults.apiKey, "");
		assert.equal(defaults.defaultLenses.length, 6);

		await writeFile(
			join(dir, "config.yaml"),
			"model: custom/model\napi_key: sk-test\ndefault_lenses:\n  - architecture\n  - security\n",
		);
		const overridden = await loadBroadsideConfig(dir);
		assert.equal(overridden.model, "custom/model");
		assert.equal(overridden.apiKey, "sk-test");
		assert.deepEqual(overridden.defaultLenses, ["architecture", "security"]);

		await writeFile(join(dir, "config.yaml"), "default_lenses:\n  - bogus\n  - architecture\n");
		const filtered = await loadBroadsideConfig(dir);
		assert.deepEqual(filtered.defaultLenses, ["architecture"], "unknown lens ids must be dropped");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- pricing resolution & expense limits ----------

function modelsCatalog(body) {
	return { data: body };
}

test("builtInPricing covers only the default model", () => {
	assert.ok(core.builtInPricing(BROADSIDE_MODEL));
	assert.equal(core.builtInPricing("openai/gpt-5.2-pro:batch"), null);
});

test("resolveModelPricing prefers config overrides over everything", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-pricing-"));
	try {
		const config = {
			model: "custom/model",
			apiKey: "",
			defaultLenses: ["architecture"],
			maxCost: 0,
			pricing: { inputPerM: 1.5, outputPerM: 42 },
		};
		const fetcher = async () => {
			throw new Error("the network must not be touched when config pricing exists");
		};
		const pricing = await resolveModelPricing(dir, config, "custom/model", "sk-fake", fetcher);
		assert.deepEqual(pricing, { inputPerM: 1.5, outputPerM: 42, source: "config" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveModelPricing falls back to built-in for the default model without network", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-pricing-"));
	try {
		const config = { model: BROADSIDE_MODEL, apiKey: "", defaultLenses: ["architecture"], maxCost: 0, pricing: null };
		const fetcher = async () => {
			throw new Error("the default model needs no lookup");
		};
		const pricing = await resolveModelPricing(dir, config, BROADSIDE_MODEL, "sk-fake", fetcher);
		assert.equal(pricing.source, "built-in");
		assert.equal(pricing.inputPerM, 0.1875);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveModelPricing looks up unknown models live and caches the result", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-pricing-"));
	try {
		const config = { model: "openai/gpt-5.2-pro:batch", apiKey: "", defaultLenses: ["architecture"], maxCost: 0, pricing: null };
		let fetches = 0;
		const fetcher = async () => {
			fetches += 1;
			return fakeResponse(
				200,
				modelsCatalog([{ id: "openai/gpt-5.2-pro:batch", pricing: { prompt: "0.00000375", completion: "0.000084" } }]),
			);
		};
		const pricing = await resolveModelPricing(dir, config, "openai/gpt-5.2-pro:batch", "sk-fake", fetcher);
		assert.equal(pricing.source, "live");
		assert.equal(pricing.inputPerM, 3.75);
		assert.equal(pricing.outputPerM, 84);
		assert.equal(fetches, 1);

		const cached = await resolveModelPricing(dir, config, "openai/gpt-5.2-pro:batch", "sk-fake", fetcher);
		assert.equal(cached.source, "cache");
		assert.equal(fetches, 1, "second resolution must come from the 24h cache");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveModelPricing refuses unknown models it cannot price", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-pricing-"));
	try {
		const config = { model: "vendor/mystery", apiKey: "", defaultLenses: ["architecture"], maxCost: 0, pricing: null };
		const fetcher = async () => fakeResponse(200, modelsCatalog([{ id: "other/model", pricing: { prompt: "0.000001", completion: "0.000002" } }]));
		await assert.rejects(
			() => resolveModelPricing(dir, config, "vendor/mystery", "sk-fake", fetcher),
			/Could not resolve per-token pricing/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("submit refuses over-budget runs and creates no run entry; force bypasses", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-limit-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await mkdir(join(dir, "big"), { recursive: true });
		for (let i = 0; i < 40; i++) {
			await writeFile(join(dir, "big", `file${i}.go`), "package big\n" + `// ${"y".repeat(2000)}\n`);
		}
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				return fakeResponse(202, { id: "batch-ok", status: "validating" });
			}
			return fakeResponse(200, { id: "x", status: "in_progress" });
		};

		await assert.rejects(
			() => runBroadsideSubmit(dir, "sk-fake", { lenses: ["defect"], fetcher, maxCost: 0.0001 }),
			/estimated.*exceeds the run limit|exceeds the run limit/i,
		);
		let state = await loadBroadsideState(join(dir, ".codecarto", "broadside"));
		assert.equal(state.runs.length, 0, "a refused submit must not create a run entry");

		const forced = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["defect"], fetcher, maxCost: 0.0001, force: true });
		assert.equal(forced.batches.defect.status, "validating");
		assert.equal(forced.maxCost, 0.0001);

		state = await loadBroadsideState(join(dir, ".codecarto", "broadside"));
		assert.equal(state.runs.length, 1);
		assert.equal(state.runs[0].pricing.source, "built-in");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("submit passes the configured model into batch payloads", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-model-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		let payload;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				payload = JSON.parse(init.body);
				return fakeResponse(202, { id: "batch-m", status: "validating" });
			}
			return fakeResponse(200, { id: "x", status: "in_progress" });
		};
		// config pricing override: submit must not hit the network for pricing.
		await mkdir(join(dir, ".codecarto", "broadside"), { recursive: true });
		await writeFile(
			join(dir, ".codecarto", "broadside", "config.yaml"),
			"model: openai/gpt-5.2-pro:batch\npricing:\n  input_per_m: 3.75\n  output_per_m: 84\n",
		);
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, model: "openai/gpt-5.2-pro:batch" });
		assert.equal(payload.model, "openai/gpt-5.2-pro:batch");
		assert.equal(payload.requests[0].body.model, "openai/gpt-5.2-pro:batch");
		assert.equal(result.pricing.source, "config");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- batch client with a fake fetcher ----------

function fakeResponse(status, body) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body,
	};
}

test("submitBatch orders endpoint and model before requests in the payload", async () => {
	let captured;
	const fetcher = async (url, init) => {
		captured = { url, payload: JSON.parse(init.body) };
		return fakeResponse(202, { id: "batch-test-1", status: "validating" });
	};
	const result = await submitBatch(
		[
			{
				custom_id: "req-1",
				body: {
					model: BROADSIDE_MODEL,
					messages: [{ role: "user", content: "hi" }],
					response_format: { type: "json_schema", json_schema: { name: "x", strict: true, schema: {} } },
					max_tokens: 100,
				},
			},
		],
		"sk-fake",
		fetcher,
	);
	assert.equal(result.batchId, "batch-test-1");
	const keys = Object.keys(captured.payload);
	assert.deepEqual(keys, ["endpoint", "model", "requests"], "the API stream-parses and rejects requests-first bodies");
	assert.equal(captured.payload.endpoint, "/v1/chat/completions");
	assert.equal(captured.payload.model, BROADSIDE_MODEL);
	assert.equal(captured.payload.requests.length, 1);
});

test("submitBatch surfaces non-202 rejection bodies", async () => {
	const fetcher = async () => fakeResponse(400, { error: { message: "no" } });
	const result = await submitBatch([], "sk-fake", fetcher);
	assert.equal(result.status, "rejected");
	assert.ok(result.error);
});

test("runBroadsideSubmit records a run and fires one batch per lens", async () => {
	const dir = await makeFixture();
	try {
		const seenBatches = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				const payload = JSON.parse(init.body);
				seenBatches.push(payload);
				return fakeResponse(202, { id: `batch-${seenBatches.length}`, status: "validating" });
			}
			return fakeResponse(200, { id: "x", status: "in_progress" });
		};
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture", "security"], fetcher });
		assert.equal(Object.keys(result.batches).length, 2);
		assert.ok(result.estimatedTotalCost > 0);
		assert.equal(seenBatches.length, 2);
		for (const payload of seenBatches) {
			assert.ok(payload.requests.length >= 1);
		}
		const { state } = await runBroadsideStatus(dir);
		assert.equal(state.runs.length, 1);
		assert.equal(state.runs[0].status, "in-flight");
		assert.equal(state.runs[0].batches.architecture.status, "validating");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- collect with fake fetcher ----------

test("runBroadsideCollect polls, saves results, and runs synthesis", async () => {
	const dir = await makeFixture();
	try {
		let submits = 0;
		let gets = 0;
		const lensPayload = {
			results: [
				{
					custom_id: "architecture-root",
					response: {
						status_code: 200,
						body: {
							choices: [{ message: { role: "assistant", content: JSON.stringify({ tech_stack: { language: "Go", build_system: "go modules" }, module_architecture: [], data_flow: "x", entry_points: ["main.go"] }) } }],
						},
					},
					error: null,
				},
			],
			usage: { cost: 0.001 },
			request_counts: { total: 1, completed: 1, failed: 0 },
		};
		const synthPayload = {
			results: [
				{
					custom_id: "synthesis",
					response: {
						status_code: 200,
						body: {
							choices: [{ message: { role: "assistant", content: JSON.stringify({ executive_summary: "ok", severity_summary: { critical: 0, high: 1, medium: 2, low: 3 }, top_findings: [{ title: "lead", severity: "high", source_lens: "architecture", summary: "a lead" }] }) } }],
						},
					},
					error: null,
				},
			],
			usage: { cost: 0.002 },
			request_counts: { total: 1, completed: 1, failed: 0 },
		};
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				submits += 1;
				return fakeResponse(202, { id: submits === 1 ? "batch-lens" : "batch-synth", status: "validating" });
			}
			gets += 1;
			// First GET per batch returns completed immediately.
			if (String(url).includes("batch-lens")) {
				return fakeResponse(200, { id: "batch-lens", status: "completed", ...lensPayload });
			}
			return fakeResponse(200, { id: "batch-synth", status: "completed", ...synthPayload });
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		const collect = await runBroadsideCollect(dir, "sk-fake", { fetcher });
		assert.equal(collect.status, "completed");
		assert.equal(collect.resultCount, 1);
		assert.ok(collect.totalCost > 0);
		assert.equal(collect.synthesis.status, "completed");
		assert.equal(collect.topFindings.length, 1);
		assert.equal(collect.topFindings[0].title, "lead");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- markdown rendering ----------

test("renderFindingsMarkdown turns parsed JSON into readable text", () => {
	const md = renderFindingsMarkdown(JSON.stringify({ title: "T", severity: "high", nested: { a: "b" }, list: [{ title: "x" }] }));
	assert.match(md, /\*\*title\*\*: T/);
	assert.match(md, /\*\*severity\*\*: high/);
	assert.match(md, /\*\*nested\*\*:/);
	assert.match(md, /1\. x/);
});

test("renderFindingsMarkdown passes invalid JSON through untouched", () => {
	assert.equal(renderFindingsMarkdown("not json"), "not json");
});
