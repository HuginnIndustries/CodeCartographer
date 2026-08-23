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
	collectRepoInfo,
	defaultBroadsideState,
	estimateCost,
	gatherSlices,
	getLens,
	loadBroadsideConfig,
	loadBroadsideState,
	listLenses,
	renderFindingsMarkdown,
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

// ---------- cost estimation ----------

test("estimateCost matches the documented per-token pricing", () => {
	const lens = getLens("defect");
	const slices = [
		{ moduleName: "a", content: "x".repeat(4000), fileCount: 1, chars: 4000 },
		{ moduleName: "b", content: "y".repeat(4000), fileCount: 1, chars: 4000 },
	];
	const { inputTokens, outputTokens, cost } = estimateCost(lens, slices);
	assert.equal(inputTokens, 2000); // 8000 chars / 4
	assert.equal(outputTokens, 4500); // maxTokens 6000 * 0.75
	const expected = (2000 / 1e6) * 0.1875 + (4500 / 1e6) * 0.9375;
	assert.ok(Math.abs(cost - expected) < 1e-12);
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
