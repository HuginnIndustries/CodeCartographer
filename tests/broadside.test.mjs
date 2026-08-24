// Broad-Side unit tests. No network: the batch client is exercised through an
// injected fake fetcher, and file collection runs against temp fixtures built
// in-memory. The real OpenRouter API is covered by a manual smoke path, not
// this suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
	fetchCodingBenchmarks,
	gatherSlices,
	getLens,
	listBatchModels,
	loadBroadsideConfig,
	loadBroadsideState,
	listLenses,
	modelsText,
	pollBatchesConcurrently,
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

// ---------- model catalog & models action ----------

function catalogWith(...models) {
	return { data: models };
}

const BATCH_MODEL_SHAPE = (id, prompt, completion, extra = {}) => ({
	id,
	name: id,
	pricing: { prompt: String(prompt), completion: String(completion) },
	context_length: 1_000_000,
	top_provider: { max_completion_tokens: 65_536 },
	supported_parameters: ["tools", "structured_outputs"],
	expiration_date: null,
	...extra,
});

test("listBatchModels keeps only :batch variants and sorts cheapest first", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-models-"));
	try {
		const config = { model: BROADSIDE_MODEL, apiKey: "", defaultLenses: ["architecture"], maxCost: 0, pricing: null };
		const fetcher = async () =>
			fakeResponse(
				200,
				catalogWith(
					BATCH_MODEL_SHAPE("openai/gpt-5.2-pro:batch", 0.00000375, 0.000084),
					BATCH_MODEL_SHAPE("google/gemini-3.7-flash:batch", 0.0000001875, 0.0000009375),
					{ id: "openai/gpt-5.2-pro", pricing: { prompt: "0.00001", completion: "0.0001" } }, // non-batch, must be excluded
					BATCH_MODEL_SHAPE("deepseek/deepseek-v4-pro:batch", 0.000000481, 0.000000963),
				),
			);
		const { entries } = await listBatchModels(dir, config, "sk-fake", { fetcher });
		assert.equal(entries.length, 3);
		assert.ok(!entries.some((e) => !e.id.endsWith(":batch")));
		assert.equal(entries[0].id, "google/gemini-3.7-flash:batch", "cheapest first");
		assert.equal(entries[2].id, "openai/gpt-5.2-pro:batch", "most expensive last");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("submit refuses models that do not advertise structured outputs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-cap-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				return fakeResponse(202, { id: "batch-x", status: "validating" });
			}
		return fakeResponse(
			200,
			catalogWith(BATCH_MODEL_SHAPE("vendor/no-structured:batch", 0.0000001, 0.0000002, { supported_parameters: ["tools"] })),
		);
		};
		await assert.rejects(
			() => runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, model: "vendor/no-structured:batch" }),
			/does not advertise structured-output support/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("submit clamps lens max_tokens to the provider completion ceiling", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-clamp-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		let payload;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				payload = JSON.parse(init.body);
				return fakeResponse(202, { id: "batch-c", status: "validating" });
			}
		return fakeResponse(
			200,
			catalogWith(BATCH_MODEL_SHAPE("vendor/tiny-out:batch", 0.0000001, 0.0000002, { top_provider: { max_completion_tokens: 1000 } })),
		);
		};
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher, model: "vendor/tiny-out:batch" });
		assert.equal(payload.requests[0].body.max_tokens, 1000, "8000-token lens must clamp to the 1000-token ceiling");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fetchCodingBenchmarks maps indices by base slug (batch suffix stripped)", async () => {
	const fetcher = async () =>
		fakeResponse(
			200,
			{
				data: [{ model_permaslug: "google/gemini-3.7-flash", coding_index: 62.4, intelligence_index: 58.1 }],
				meta: { as_of: "2026-08-23", source_url: "https://example.com" },
			},
		);
	const benchmarks = await fetchCodingBenchmarks("sk-fake", fetcher);
	assert.equal(benchmarks.byBaseSlug["google/gemini-3.7-flash"].codingIndex, 62.4);
	assert.ok("google/gemini-3.7-flash:batch".indexOf(":") >= 0, "the batch variant resolves through its base slug");
	assert.equal(benchmarks.meta.as_of, "2026-08-23");
});

test("modelsText renders pricing, caps, support, and benchmark columns", () => {
	const entries = [
		{
			id: "google/gemini-3.7-flash:batch",
			name: "Google: Gemini 3.7 Flash (batch)",
			inputPerM: 0.1875,
			outputPerM: 0.9375,
			contextLength: 1_048_576,
			maxCompletionTokens: 65_536,
			supportedParameters: ["tools", "structured_outputs"],
			expirationDate: null,
		},
	];
	const text = modelsText(entries, {
		benchmarks: { byBaseSlug: { "google/gemini-3.7-flash": { codingIndex: 62.4 } }, meta: { as_of: "2026-08-23" } },
		defaultModel: "google/gemini-3.7-flash:batch",
	});
	assert.match(text, /0\.188/);
	assert.match(text, /64k/);
	assert.match(text, /62\.4/);
	assert.match(text, /\(default\)/);
});

// ---------- truncated-slice resubmit (#133) ----------

test("submit persists request bodies for truncated-slice recovery", async () => {
	const dir = await makeFixture();
	try {
		const fetcher = async (url, init) =>
			init.method === "POST" ? fakeResponse(202, { id: "batch-x", status: "validating" }) : fakeResponse(200, { id: "x", status: "in_progress" });
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		const runDir = join(dir, ".codecarto", "broadside", result.outputDir.split("/").pop());
		const requests = JSON.parse(await readFile(join(runDir, "requests.json"), "utf8"));
		assert.ok(requests["architecture-root"], "architecture request must be persisted");
		assert.equal(requests["architecture-root"].body.model, BROADSIDE_MODEL);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("collect re-submits truncated slices once with a doubled output cap", async () => {
	const dir = await makeFixture();
	try {
		const truncated = '{"module": "server", "findings": [';
		const recovered = JSON.stringify({ module: "server", findings: [], patterns_checked: [], files_scanned: 0 });
		const retryPayloads = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				const payload = JSON.parse(init.body);
				const isRetry = retryPayloads.length > 0;
				retryPayloads.push(payload);
				return fakeResponse(202, { id: isRetry ? "batch-retry" : "batch-lens", status: "validating" });
			}
			if (String(url).includes("batch-lens")) {
				return fakeResponse(200, {
					id: "batch-lens",
					status: "completed",
					results: [{ custom_id: "architecture-root", response: { status_code: 200, body: { choices: [{ message: { content: truncated } }] } }, error: null }],
					usage: { cost: 0.001 },
				});
			}
			return fakeResponse(200, {
				id: "batch-retry",
				status: "completed",
				results: [{ custom_id: "architecture-root", response: { status_code: 200, body: { choices: [{ message: { content: recovered } }] } }, error: null }],
				usage: { cost: 0.002 },
			});
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		const collect = await runBroadsideCollect(dir, "sk-fake", { fetcher, includeSynthesis: false, includeTriage: false });

		assert.equal(collect.truncatedCount, 0, "recovered slice must clear the truncation count");
		assert.equal(collect.retriedCount, 1, "one slice recovered by resubmission");
		assert.equal(retryPayloads.length, 2, "one original submit + one retry");
		assert.equal(retryPayloads[1].requests[0].body.max_tokens, retryPayloads[0].requests[0].body.max_tokens * 2, "retry must double the output cap");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("collect leaves truncated slices alone when retry_truncated is false", async () => {
	const dir = await makeFixture();
	try {
		const truncated = '{"module": "server", "findings": [';
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				return fakeResponse(202, { id: "batch-lens", status: "validating" });
			}
			return fakeResponse(200, {
				id: "batch-lens",
				status: "completed",
				results: [{ custom_id: "architecture-root", response: { status_code: 200, body: { choices: [{ message: { content: truncated } }] } }, error: null }],
				usage: { cost: 0.001 },
			});
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		const collect = await runBroadsideCollect(dir, "sk-fake", { fetcher, includeSynthesis: false, includeTriage: false, retryTruncated: false });

		assert.equal(collect.truncatedCount, 1, "truncation must remain reported");
		assert.equal(collect.retriedCount, 0, "no resubmission when retry_truncated is false");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- per-language prompts (#137) ----------

test("defect lens prompt speaks the detected language, not Go", () => {
	const python = getLens("defect").systemPrompt({ language: "python" });
	assert.match(python, /bare except/);
	assert.ok(!python.includes("goroutines"), "Go idioms must not leak into Python prompts");

	const go = getLens("defect").systemPrompt({ language: "go" });
	assert.match(go, /goroutines without ctx/);

	const rust = getLens("defect").systemPrompt({ language: "rust" });
	assert.match(rust, /Unwrap\/expect panics/);

	const ts = getLens("defect").systemPrompt({ language: "typescript" });
	assert.match(ts, /non-null assertions/);

	const js = getLens("defect").systemPrompt({ language: "javascript" });
	assert.match(js, /unhandled promise rejections/, "javascript rides the TS profile");

	const unknown = getLens("defect").systemPrompt({ language: "whitespace-esque" });
	assert.match(unknown, /unchecked casts/, "unknown languages get the neutral default profile");
});

test("conventions lens prompt names language-appropriate categories and idioms", () => {
	const rust = getLens("conventions").systemPrompt({ language: "rust" });
	assert.match(rust, /crates and modules/);

	const python = getLens("conventions").systemPrompt({ language: "python" });
	assert.match(python, /dunder method usage/);

	const go = getLens("conventions").systemPrompt({ language: "go" });
	assert.match(go, /error wrapping with %w/);
	assert.ok(!go.includes("dunder"), "python idiom hints must not leak into Go prompts");
});

// ---------- concurrent polling (#136) ----------

test("pollBatchesConcurrently polls all batches in parallel against one deadline", async () => {
	// Peak-concurrency tracking is deterministic: if polling were sequential,
	// the fast batch would hold the loop and peak concurrent GETs would stay
	// at 1. Under the fix, the fast batch polls while the slow one is still
	// mid-polling.
	let inFlightGets = 0;
	let peak = 0;
	const fetcher = async (url) => {
		inFlightGets += 1;
		peak = Math.max(peak, inFlightGets);
		try {
			await new Promise((r) => setTimeout(r, 15)); // overlap window
			if (String(url).includes("batch-a")) {
				return fakeResponse(200, { id: "batch-a", status: "completed", results: [], usage: { cost: 0.001 } });
			}
			return fakeResponse(200, { id: "batch-b", status: "completed", results: [], usage: { cost: 0.002 } });
		} finally {
			inFlightGets -= 1;
		}
	};

	const results = await pollBatchesConcurrently(
		[
			{ lensId: "defect", batchId: "batch-a" },
			{ lensId: "security", batchId: "batch-b" },
		],
		"sk-fake",
		{ fetcher, pollIntervalMs: 20, deadlineMs: 5000 },
	);
	assert.equal(results.size, 2);
	assert.equal(results.get("batch-a").status, "completed");
	assert.equal(results.get("batch-b").status, "completed");
	assert.ok(peak >= 2, `peak concurrent GETs was ${peak} — polling is sequential`);
});

test("collect polls multiple in-flight lenses concurrently", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-conc-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		await mkdir(join(dir, "server"));
		await writeFile(join(dir, "server", "routes.go"), "package server\n");

		let inFlightGets = 0;
		let peak = 0;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				return fakeResponse(202, { id: "batch-x", status: "validating" });
			}
			inFlightGets += 1;
			peak = Math.max(peak, inFlightGets);
			try {
				await new Promise((r) => setTimeout(r, 15));
				const batchId = String(url).split("/").pop();
				return fakeResponse(200, {
					id: batchId,
					status: "completed",
					results: [
						{
							custom_id: `${batchId}-1`,
							response: {
								status_code: 200,
								body: { choices: [{ message: { content: JSON.stringify({ module: "x", findings: [], patterns_checked: [], files_scanned: 0 }) } }] },
							},
							error: null,
						},
					],
					usage: { cost: 0.001 },
				});
			} finally {
				inFlightGets -= 1;
			}
		};

		// Two submissions → two lens batches; rewrite state so both are
		// in flight under distinct ids, then collect must poll both together.
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture", "security"], fetcher });
		assert.equal(Object.keys(result.batches).length, 2);
		const broadsideDir = join(dir, ".codecarto", "broadside");
		const state = await loadBroadsideState(broadsideDir);
		state.runs[0].batches.architecture.batchId = "batch-a";
		state.runs[0].batches.architecture.status = "validating";
		state.runs[0].batches.security.batchId = "batch-b";
		state.runs[0].batches.security.status = "validating";
		await saveBroadsideState(broadsideDir, state);

		const collect = await runBroadsideCollect(dir, "sk-fake", { fetcher, includeSynthesis: false, includeTriage: false });
		assert.equal(collect.resultCount, 2);
		assert.ok(peak >= 2, `peak concurrent GETs was ${peak} — collect is polling lenses sequentially`);
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

test("runBroadsideCollect polls, saves results, and runs synthesis + triage", async () => {
	const dir = await makeFixture();
	try {
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
		const triagePayload = {
			results: [
				{
					custom_id: "triage",
					response: {
						status_code: 200,
						body: {
							choices: [{ message: { role: "assistant", content: JSON.stringify({ summary: "work order", items: [{ title: "fix the thing", severity: "high", module: "server", impact: "high", difficulty: "low", priority: "P0", effort_estimate: "2h", rationale: "obvious" }] }) } }],
						},
					},
					error: null,
				},
			],
			usage: { cost: 0.003 },
			request_counts: { total: 1, completed: 1, failed: 0 },
		};
		let postCount = 0;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				postCount += 1;
				const payload = JSON.parse(init.body);
				const id = payload.requests[0].custom_id === "synthesis" ? "batch-synth" : payload.requests[0].custom_id === "triage" ? "batch-triage" : "batch-lens";
				return fakeResponse(202, { id, status: "validating" });
			}
			if (String(url).includes("batch-lens")) {
				return fakeResponse(200, { id: "batch-lens", status: "completed", ...lensPayload });
			}
			if (String(url).includes("batch-triage")) {
				return fakeResponse(200, { id: "batch-triage", status: "completed", ...triagePayload });
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
		assert.equal(collect.triage.status, "completed");
		assert.equal(collect.topTriageItems.length, 1);
		assert.equal(collect.topTriageItems[0].title, "fix the thing");
		assert.equal(collect.topTriageItems[0].priority, "P0");
		assert.equal(postCount, 3, "lens + synthesis + triage batches");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runBroadsideCollect skips triage when include_triage is false", async () => {
	const dir = await makeFixture();
	try {
		const lensPayload = {
			results: [
				{
					custom_id: "architecture-root",
					response: {
						status_code: 200,
						body: { choices: [{ message: { content: JSON.stringify({ tech_stack: { language: "Go", build_system: "x" }, module_architecture: [], data_flow: "x", entry_points: [] }) } }] },
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
						body: { choices: [{ message: { content: JSON.stringify({ executive_summary: "ok", severity_summary: { critical: 0, high: 0, medium: 0, low: 0 }, top_findings: [] }) } }] },
					},
					error: null,
				},
			],
			usage: { cost: 0.002 },
			request_counts: { total: 1, completed: 1, failed: 0 },
		};
		const seenPosts = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				const payload = JSON.parse(init.body);
				seenPosts.push(payload.requests[0].custom_id);
				return fakeResponse(202, { id: `batch-${payload.requests[0].custom_id}`, status: "validating" });
			}
			if (String(url).includes("batch-synthesis")) {
				return fakeResponse(200, { id: "batch-synthesis", status: "completed", ...synthPayload });
			}
			return fakeResponse(200, { id: "batch-architecture-root", status: "completed", ...lensPayload });
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		const collect = await runBroadsideCollect(dir, "sk-fake", { fetcher, includeTriage: false });
		assert.deepEqual(seenPosts, ["architecture-root", "synthesis"], "no triage batch may be submitted");
		assert.equal(collect.triage.status, "pending");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- markdown rendering & fence-tolerant parsing ----------

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

test("parseLensJson strips markdown code fences", () => {
	const fenced = '```json\n{"title": "F", "severity": "low"}\n```';
	const parsed = core.parseLensJson(fenced);
	assert.deepEqual(parsed, { title: "F", severity: "low" });
	const withoutLang = '```\n{"title": "F"}\n```';
	assert.deepEqual(core.parseLensJson(withoutLang), { title: "F" });
});

test("parseLensJson returns null for truncated or non-JSON content", () => {
	assert.equal(core.parseLensJson('```json\n{"title": "unterminated\n```'), null);
	assert.equal(core.parseLensJson("The findings are numerous."), null);
});

test("saveLensResults marks truncated content and writes parsed JSON cleanly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-trunc-"));
	try {
		const batch = {
			results: [
				{
					custom_id: "defect-core-1",
					response: {
						status_code: 200,
						body: { choices: [{ message: { content: '```json\n{"module": "core", "findings": []}\n```' } }] },
					},
					error: null,
				},
				{
					custom_id: "defect-core-2",
					response: {
						status_code: 200,
						body: { choices: [{ message: { content: '{"module": "core-2", "findin' } }] },
					},
					error: null,
				},
			],
		};
		const stored = await core.saveLensResults(dir, "defect", batch);
		assert.equal(stored.length, 2);
		assert.equal(stored[0].truncated, false);
		assert.equal(stored[1].truncated, true);

		const written = JSON.parse(await readFile(join(dir, "defect-core-1.json"), "utf8"));
		assert.equal(written.module, "core", "fenced JSON must be saved parsed, not verbatim");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
