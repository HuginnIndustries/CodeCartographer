// Broad-Side unit tests. No network: the batch client is exercised through an
// injected fake fetcher, and file collection runs against temp fixtures built
// in-memory. The real OpenRouter API is covered by a manual smoke path, not
// this suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Git fixtures must not inherit the developer's git configuration. A global
// `url.<base>.insteadOf` rewrites what `git remote get-url` reports — which is
// exactly what resolvePublishSourceRepo reads — so a verbatim-URL assertion
// fails on any machine carrying that common setting while staying green on
// CI's bare runners. `commit.gpgsign` and `init.defaultBranch` reach the
// committing fixtures the same way. Point both config layers at a path that
// does not exist: git reads a missing file as empty config. Identity is set
// per fixture in repo-local config, so commits still work.
const ABSENT_GIT_CONFIG = join(tmpdir(), "codecarto-tests-absent-gitconfig");
process.env.GIT_CONFIG_GLOBAL = ABSENT_GIT_CONFIG;
process.env.GIT_CONFIG_SYSTEM = ABSENT_GIT_CONFIG;

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
	BROADSIDE_DEAD_BATCH_STATUSES,
	BROADSIDE_REASONING_BUDGET_FRACTION,
	BROADSIDE_MIN_REASONING_TOKENS,
	defaultReasoningFor,
	estimateSubmitText,
	persistBroadsideRun,
	saveBroadsideState,
	submitBatch,
	updateBroadsideStateAtomically,
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

test("auto slicing collapses a small repo to a single whole-repo slice", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const slices = await gatherSlices(dir, lens, info);
		assert.equal(slices.length, 1, "a repo that fits one slice must not be split per directory");
		assert.equal(slices[0].moduleName, info.name);
		assert.match(slices[0].content, /server\/routes\.go/);
		assert.match(slices[0].content, /model\/deep\/nested\.go/);
		assert.match(slices[0].content, /main\.go/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("auto slicing directory-splits a repo too large for one slice", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-auto-"));
	try {
		await mkdir(join(dir, "server"));
		await mkdir(join(dir, "model"));
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), "package main\n");
		for (let i = 0; i < 40; i++) {
			await writeFile(join(dir, "server", `s${i}.go`), "package server\n" + `// ${"x".repeat(2000)}\n`);
			await writeFile(join(dir, "model", `m${i}.go`), "package model\n" + `// ${"y".repeat(2000)}\n`);
		}
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const slices = await gatherSlices(dir, lens, info);
		const byModule = Object.fromEntries(slices.map((s) => [s.moduleName, s]));
		assert.ok(byModule.server, "server/ must be its own slice");
		assert.ok(byModule.model, "model/ must be its own slice");
		assert.ok(byModule.root, "top-level main.go must land in the root slice");
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
	const pricing = { inputPerM: 0.375, outputPerM: 1.875, source: "built-in" };
	const { inputTokens, outputTokens, cost } = estimateCost(lens, slices, pricing);
	assert.equal(inputTokens, 2000); // 8000 chars / 4
	// Both halves scale with the slice count, because every slice is its own
	// batch request. This assertion used to read 4500 — one request's output
	// for a two-request lens — which is the shape that let a 13-slice run come
	// in at roughly 3x its estimate while max_cost was bound to the low number.
	assert.equal(outputTokens, 9000); // 2 requests * maxTokens 6000 * 0.75
	const expected = (2000 / 1e6) * 0.375 + (9000 / 1e6) * 1.875;
	assert.ok(Math.abs(cost - expected) < 1e-12);
});

test("estimateCost scales the output budget with the number of requests", () => {
	const lens = getLens("defect");
	const pricing = { inputPerM: 0.375, outputPerM: 1.875, source: "built-in" };
	const slice = (name) => ({ moduleName: name, content: "x".repeat(4000), fileCount: 1, chars: 4000 });
	const one = estimateCost(lens, [slice("a")], pricing);
	const thirteen = estimateCost(lens, Array.from({ length: 13 }, (_, i) => slice(`m${i}`)), pricing);
	assert.equal(thirteen.outputTokens, one.outputTokens * 13);
	assert.equal(estimateCost(lens, [], pricing).outputTokens, 0, "a lens with nothing to scan budgets no output");
});

test("estimateCost counts the system prompt and schema each request carries when given repo info", () => {
	const lens = getLens("defect");
	const pricing = { inputPerM: 0.375, outputPerM: 1.875, source: "built-in" };
	const slices = [
		{ moduleName: "a", content: "x".repeat(4000), fileCount: 1, chars: 4000 },
		{ moduleName: "b", content: "y".repeat(4000), fileCount: 1, chars: 4000 },
	];
	const info = { languages: ["TypeScript"], fileCount: 2, root: "/tmp/x", manifests: [], tree: "" };
	const withInfo = estimateCost(lens, slices, pricing, undefined, info);
	const without = estimateCost(lens, slices, pricing);
	assert.ok(withInfo.inputTokens > without.inputTokens, "the per-request prompt and schema are not free");
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

// A long-running operation holds its state in memory while it polls, then
// checkpoints. Until persistBroadsideRun, that checkpoint wrote the whole
// snapshot back, erasing any run a concurrent operation had recorded since the
// snapshot was taken. Found live: a submit at 23:35 recorded a run, a collect
// that had loaded state before it wrote back at 00:08, and the run vanished
// from state.json while its paid results sat orphaned on disk.

const makeRun = (id, extra = {}) => ({
	id,
	createdAt: "2026-09-08T00:00:00Z",
	model: BROADSIDE_MODEL,
	lenses: ["architecture"],
	status: "in-flight",
	outputDir: id,
	batches: {},
	synthesis: { status: "pending" },
	...extra,
});

test("a checkpoint does not erase a run recorded after its snapshot was taken", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-lostupdate-"));
	try {
		const slow = makeRun("run-slow");
		await persistBroadsideRun(dir, slow);

		// The long operation's snapshot: taken now, written back much later.
		const snapshotTakenBySlowOperation = await loadBroadsideState(dir);
		assert.equal(snapshotTakenBySlowOperation.runs.length, 1);

		// Meanwhile an independent submit records a second run.
		await persistBroadsideRun(dir, makeRun("run-concurrent"));

		// The slow operation finishes and checkpoints its own run.
		slow.status = "completed";
		slow.totalCost = 0.5;
		await persistBroadsideRun(dir, slow);

		const finalState = await loadBroadsideState(dir);
		assert.deepEqual(
			finalState.runs.map((r) => r.id).sort(),
			["run-concurrent", "run-slow"],
			"the concurrently-recorded run must survive the slow operation's checkpoint",
		);
		const persistedSlow = finalState.runs.find((r) => r.id === "run-slow");
		assert.equal(persistedSlow.status, "completed", "the checkpoint must still apply its own updates");
		assert.equal(persistedSlow.totalCost, 0.5);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a run erased by an older writer is restored by its own next checkpoint", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-selfheal-"));
	try {
		const run = makeRun("run-orphaned");
		await persistBroadsideRun(dir, run);

		// An older writer overwrites state.json without this run.
		await saveBroadsideState(dir, defaultBroadsideState());
		assert.equal((await loadBroadsideState(dir)).runs.length, 0);

		run.status = "completed";
		await persistBroadsideRun(dir, run);

		const restored = await loadBroadsideState(dir);
		assert.equal(restored.runs.length, 1);
		assert.equal(restored.runs[0].id, "run-orphaned");
		assert.equal(restored.runs[0].status, "completed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("interleaved checkpoints from many runs all survive", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-interleaved-"));
	try {
		const runs = ["a", "b", "c", "d", "e"].map((id) => makeRun(`run-${id}`));
		// Every run checkpoints twice, interleaved, as concurrent operations would.
		await Promise.all(runs.map((run) => persistBroadsideRun(dir, run)));
		await Promise.all(
			runs.map((run) => {
				run.status = "completed";
				return persistBroadsideRun(dir, run);
			}),
		);

		const state = await loadBroadsideState(dir);
		assert.deepEqual(
			state.runs.map((r) => r.id).sort(),
			runs.map((r) => r.id).sort(),
			"no run may be dropped by an interleaved write",
		);
		assert.ok(state.runs.every((r) => r.status === "completed"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a checkpoint updates a run in place rather than appending a duplicate", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-dedupe-"));
	try {
		const run = makeRun("run-1");
		for (const status of ["in-flight", "partial", "completed"]) {
			run.status = status;
			await persistBroadsideRun(dir, run);
		}
		const state = await loadBroadsideState(dir);
		assert.equal(state.runs.length, 1, "repeated checkpoints must not append duplicates");
		assert.equal(state.runs[0].status, "completed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("state writes leave no temp file behind", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-tmp-"));
	try {
		await persistBroadsideRun(dir, makeRun("run-1"));
		await updateBroadsideStateAtomically(dir, (state) => {
			state.runs[0].status = "completed";
		});
		const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
		assert.deepEqual(leftovers, [], "temp and lock files must be cleaned up");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a corrupt state file is refused and preserved, never read as empty (#233)", async () => {
	// It used to degrade to defaults, and the next checkpoint wrote that empty
	// state over the file — losing the batch ids of every paid, in-flight run.
	const dir = await mkdtemp(join(tmpdir(), "broadside-corrupt-"));
	try {
		await writeFile(join(dir, "state.json"), "{ this is not json");
		await assert.rejects(loadBroadsideState(dir), /^BroadsideStateError: Broad-Side state .*state\.json could not be parsed \(.*\)\. A copy is preserved at .*state\.json\.corrupt-[0-9a-f]{8}; the file is not overwritten\./);
		const copies = (await readdir(dir)).filter((name) => name.startsWith("state.json.corrupt-"));
		assert.equal(copies.length, 1);
		assert.equal(await readFile(join(dir, copies[0]), "utf8"), "{ this is not json");
		await assert.rejects(loadBroadsideState(dir));
		assert.equal((await readdir(dir)).filter((name) => name.startsWith("state.json.corrupt-")).length, 1, "the same content is preserved once");
		assert.equal(await readFile(join(dir, "state.json"), "utf8"), "{ this is not json", "nothing wrote over it");
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

test("config carries repo defaults for every per-call run knob", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-run-defaults-"));
	try {
		const defaults = await loadBroadsideConfig(dir);
		assert.equal(defaults.incremental, false);
		assert.equal(defaults.retryTruncated, true, "truncation repair is on unless a repo turns it off");
		assert.equal(defaults.includeSynthesis, true);
		assert.equal(defaults.includeTriage, true);
		assert.equal(defaults.waitSeconds, 0, "0 means submit and collect later");

		await writeFile(
			join(dir, "config.yaml"),
			[
				"incremental: true",
				"retry_truncated: false",
				"include_synthesis: false",
				"include_triage: false",
				"wait_seconds: 600",
				"",
			].join("\n"),
		);
		const set = await loadBroadsideConfig(dir);
		assert.equal(set.incremental, true);
		assert.equal(set.retryTruncated, false);
		assert.equal(set.includeSynthesis, false);
		assert.equal(set.includeTriage, false);
		assert.equal(set.waitSeconds, 600);

		// config.yaml is hand-edited: a typo must not cost a user their batches.
		await writeFile(join(dir, "config.yaml"), "incremental: yes-please\nwait_seconds: soon\n");
		const malformed = await loadBroadsideConfig(dir);
		assert.equal(malformed.incremental, false, "a non-boolean flag falls back to the shipped default");
		assert.equal(malformed.waitSeconds, 0, "a non-numeric poll budget falls back to the shipped default");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("every documented config key is one loadBroadsideConfig actually reads", async () => {
	// The commented-out keys in the shipped config.yaml are the only
	// documentation a user gets. A key documented but not parsed reads as a
	// working setting that silently does nothing; a key parsed but not
	// documented is a feature nobody can find.
	const shipped = await readFile(join(REPO_ROOT, ".codecarto", "broadside", "config.yaml"), "utf8");
	// Commented YAML keeps its indentation after the "# ", so nesting depth
	// separates top-level keys from the examples under pricing / lens_models.
	const documentedTop = [...shipped.matchAll(/^# ([a-z_]+):/gm)].map((match) => match[1]);
	const documentedNested = [...shipped.matchAll(/^#\s{2,}([a-z_]+):/gm)].map((match) => match[1]);

	const parsedTop = new Set([
		"model",
		"api_key",
		"default_lenses",
		"max_cost",
		"pricing",
		"lens_models",
		"reasoning",
		"incremental",
		"retry_truncated",
		"include_synthesis",
		"include_triage",
		"wait_seconds",
		"redact_secrets",
	]);
	const undocumented = [...parsedTop].filter((key) => !documentedTop.includes(key));
	assert.deepEqual(undocumented, [], `config.yaml does not document: ${undocumented.join(", ")}`);
	for (const key of documentedTop) {
		assert.ok(parsedTop.has(key), `config.yaml documents ${key}, which loadBroadsideConfig does not read`);
	}

	// Nested examples must be real too: pricing's two fields, or a lens id.
	const parsedNested = new Set(["input_per_m", "output_per_m", "enabled", "effort", "max_tokens", ...BROADSIDE_LENS_IDS]);
	for (const key of documentedNested) {
		assert.ok(parsedNested.has(key), `config.yaml shows a nested ${key} key that nothing reads`);
	}
	assert.ok(
		documentedNested.some((key) => BROADSIDE_LENS_IDS.includes(key)),
		"lens_models must be documented with at least one real lens id as an example",
	);
});

test("per-lens model overrides parse, and unknown lens ids are dropped", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-lens-models-"));
	try {
		assert.deepEqual((await loadBroadsideConfig(dir)).lensModels, {}, "no overrides by default");

		await writeFile(
			join(dir, "config.yaml"),
			"lens_models:\n  security: vendor/strong:batch\n  nonsense: vendor/whatever:batch\n  defect: \n",
		);
		const config = await loadBroadsideConfig(dir);
		assert.deepEqual(
			config.lensModels,
			{ security: "vendor/strong:batch" },
			"an unknown lens id and an empty value are both dropped rather than carried",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the Broad-Side reading guide is readable from a repo with no workspace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-skill-"));
	try {
		// No .codecarto/ at all: the packaged copy answers.
		const packaged = await core.readBroadsideSkill(dir);
		assert.match(packaged.content, /# Broad-Side/);
		assert.ok(packaged.path.includes(join("broadside", "SKILL.md")));

		// A workspace copy wins, so a user's edits to their own scaffold are served.
		await mkdir(join(dir, ".codecarto", "broadside"), { recursive: true });
		await writeFile(join(dir, ".codecarto", "broadside", "SKILL.md"), "# Local guide\n");
		const local = await core.readBroadsideSkill(dir);
		assert.equal(local.content, "# Local guide\n");
		assert.equal(local.path, join(dir, ".codecarto", "broadside", "SKILL.md"));
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
		assert.equal(pricing.inputPerM, 0.375, "the fallback must carry OpenRouter's listed batch rate, not a second discount");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the live catalog outranks the built-in rate for the default model", async () => {
	// The built-in constants used to short-circuit the lookup, so a stale rate
	// could never self-correct even though the catalog was already fetched for
	// every other model — and a stale rate on the default model is the one that
	// silently halves every estimate and doubles what max_cost really allows.
	const dir = await mkdtemp(join(tmpdir(), "broadside-pricing-"));
	try {
		const config = { model: BROADSIDE_MODEL, apiKey: "", defaultLenses: ["architecture"], maxCost: 0, pricing: null };
		const fetcher = async () =>
			fakeResponse(200, modelsCatalog([{ id: BROADSIDE_MODEL, pricing: { prompt: "0.000001", completion: "0.00001" } }]));
		const pricing = await resolveModelPricing(dir, config, BROADSIDE_MODEL, "sk-fake", fetcher);
		assert.equal(pricing.source, "live", "the catalog is authoritative, not the compile-time constant");
		assert.equal(pricing.inputPerM, 1);
		assert.equal(pricing.outputPerM, 10);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the built-in fallback carries OpenRouter's listed batch rate", () => {
	// Guards the specific mistake this replaced: the `:batch` variant's listed
	// price already includes the batch discount, so halving it again is wrong.
	// If OpenRouter's listing moves, update these to match the listing — do not
	// derive them from the sync price.
	assert.deepEqual(core.builtInPricing(BROADSIDE_MODEL), { inputPerM: 0.375, outputPerM: 1.875, source: "built-in" });
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

test("a confirm hook decides the run, and declining submits nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-confirm-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await mkdir(join(dir, "big"), { recursive: true });
		for (let i = 0; i < 40; i++) {
			await writeFile(join(dir, "big", `file${i}.go`), "package big\n" + `// ${"y".repeat(2000)}\n`);
		}
		let posted = 0;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				posted += 1;
				return fakeResponse(202, { id: "batch-ok", status: "validating" });
			}
			return fakeResponse(200, { id: "x", status: "in_progress" });
		};
		const stateDir = join(dir, ".codecarto", "broadside");

		// Declining is not an error condition to paper over: nothing is spent,
		// nothing is recorded, and the caller can tell it apart from a failure.
		const seen = [];
		await assert.rejects(
			() => runBroadsideSubmit(dir, "sk-fake", {
				lenses: ["defect"],
				fetcher,
				confirm: (estimate) => { seen.push(estimate); return false; },
			}),
			(error) => {
				assert.equal(error.name, "BroadsideCancelledError");
				assert.match(error.message, /Nothing was submitted/);
				return true;
			},
		);
		assert.equal(posted, 0, "a declined run must not submit a batch");
		assert.equal((await loadBroadsideState(stateDir)).runs.length, 0, "a declined run must not be recorded");

		assert.equal(seen.length, 1, "the hook is called once, before submission");
		assert.equal(seen[0].lenses.length, 1);
		assert.equal(seen[0].lenses[0].lensId, "defect");
		assert.ok(seen[0].totalCost > 0, "the estimate must carry a price");
		assert.ok(seen[0].lenses[0].slices > 0, "the estimate must say how much work was sliced");

		// An interactive approval is the force flag: it carries the run past a
		// max_cost the non-interactive path would refuse.
		const approved = [];
		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["defect"],
			fetcher,
			maxCost: 0.0001,
			confirm: (estimate) => { approved.push(estimate); return true; },
		});
		assert.equal(approved[0].exceedsLimit, true, "the hook must be told it is over budget");
		assert.equal(approved[0].maxCost, 0.0001);
		assert.equal(result.batches.defect.status, "validating");
		assert.equal((await loadBroadsideState(stateDir)).runs.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a per-lens override reaches the wire, the estimate, and the retry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-per-lens-model-"));
	try {
		await writeFile(join(dir, "go.mod"), "module x\n");
		await mkdir(join(dir, "big"), { recursive: true });
		for (let i = 0; i < 10; i++) {
			await writeFile(join(dir, "big", `file${i}.go`), `package big\n// ${"y".repeat(1500)}\n`);
		}
		await mkdir(join(dir, ".codecarto", "broadside"), { recursive: true });
		await writeFile(
			join(dir, ".codecarto", "broadside", "config.yaml"),
			"lens_models:\n  defect: vendor/strong:batch\n",
		);

		const posted = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				posted.push(JSON.parse(init.body));
				return fakeResponse(202, { id: `batch-${posted.length}`, status: "validating" });
			}
			if (String(url).includes("/models")) {
				// Both models must price: the override is pre-flighted like the default.
				return fakeResponse(200, modelsCatalog([
					{
						id: "vendor/strong:batch",
						name: "Strong",
						pricing: { prompt: "0.000005", completion: "0.000025" },
						context_length: 200000,
						top_provider: { max_completion_tokens: 32000 },
						supported_parameters: ["structured_outputs"],
					},
				]));
			}
			return fakeResponse(200, { id: "x", status: "in_progress" });
		};

		const seen = [];
		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["architecture", "defect"],
			fetcher,
			confirm: (estimate) => { seen.push(estimate); return true; },
		});

		// The estimate must price each lens against its own model, or the number
		// the user approves is not the number they will be billed.
		const [estimate] = seen;
		assert.equal(estimate.mixedModels, true);
		const defectRow = estimate.lenses.find((l) => l.lensId === "defect");
		const archRow = estimate.lenses.find((l) => l.lensId === "architecture");
		assert.equal(defectRow.model, "vendor/strong:batch");
		assert.equal(archRow.model, BROADSIDE_MODEL);
		assert.equal(defectRow.pricing.outputPerM, 25, "the override's own rates must price its lens");
		assert.notEqual(archRow.pricing.outputPerM, defectRow.pricing.outputPerM);

		// And the batch that fires must carry it, at both payload levels.
		const defectBatch = posted.find((p) => p.model === "vendor/strong:batch");
		assert.ok(defectBatch, "the defect batch must be submitted on the override model");
		assert.equal(defectBatch.requests[0].body.model, "vendor/strong:batch");
		assert.ok(
			posted.some((p) => p.model === BROADSIDE_MODEL),
			"the architecture batch must stay on the run default",
		);

		// Recorded per lens, so collect's truncation retry re-submits on the same
		// model and against that model's ceiling rather than the run default's.
		assert.equal(result.batches.defect.model, "vendor/strong:batch");
		assert.equal(result.batches.defect.outputCap, 32000);
		assert.equal(result.batches.architecture.model, undefined, "the default model is not restated per lens");
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

// ---------- incremental re-scouting (#142) ----------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

async function git(dir, ...args) {
	await execFileAsync("git", ["-C", dir, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

async function makeGitRepo() {
	const dir = await mkdtemp(join(tmpdir(), "broadside-git-"));
	await git(dir, "init", "-q");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	await mkdir(join(dir, "server"));
	await mkdir(join(dir, "model"));
	await writeFile(join(dir, "go.mod"), "module x\n");
	await writeFile(join(dir, "main.go"), "package main\n");
	for (let i = 0; i < 40; i++) {
		await writeFile(join(dir, "server", `s${i}.go`), "package server\n" + `// ${"x".repeat(2000)}\n`);
		await writeFile(join(dir, "model", `m${i}.go`), "package model\n" + `// ${"y".repeat(2000)}\n`);
	}
	await git(dir, "add", "-A");
	await git(dir, "commit", "-q", "-m", "initial");
	return dir;
}

function submittedCustomIds(payloads) {
	return payloads.flatMap((p) => p.requests.map((r) => r.custom_id));
}

test("incremental submit scans only modules whose files changed", async () => {
	const dir = await makeGitRepo();
	try {
		const payloads = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				payloads.push(JSON.parse(init.body));
				return fakeResponse(202, { id: `batch-${payloads.length}`, status: "validating" });
			}
			return fakeResponse(200, { id: "x", status: "in_progress" });
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["defect"], fetcher });
		const firstIds = submittedCustomIds(payloads);
		assert.ok(firstIds.some((id) => id.startsWith("defect-server")), "baseline must scan server");
		assert.ok(firstIds.some((id) => id.startsWith("defect-model")), "baseline must scan model");

		// Change one server file, commit, then re-scout incrementally.
		await writeFile(join(dir, "server", "s0.go"), "package server\n// changed\n");
		await git(dir, "add", "-A");
		await git(dir, "commit", "-q", "-m", "change server");

		payloads.length = 0;
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["defect"], fetcher, incremental: true });
		const secondIds = submittedCustomIds(payloads);
		assert.ok(secondIds.some((id) => id.startsWith("defect-server")), "changed module must be re-scanned");
		assert.ok(!secondIds.some((id) => id.startsWith("defect-model")), "unchanged module must be skipped");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("incremental submit falls back to a full scan when the tree is dirty", async () => {
	const dir = await makeGitRepo();
	try {
		const payloads = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				payloads.push(JSON.parse(init.body));
				return fakeResponse(202, { id: `batch-${payloads.length}`, status: "validating" });
			}
			return fakeResponse(200, { id: "x", status: "in_progress" });
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["defect"], fetcher });
		// Uncommitted change → the diff is unreliable, so scan everything.
		await writeFile(join(dir, "model", "m0.go"), "package model\n// dirty\n");

		payloads.length = 0;
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["defect"], fetcher, incremental: true });
		const ids = submittedCustomIds(payloads);
		assert.ok(ids.some((id) => id.startsWith("defect-server")), "dirty tree must still scan server");
		assert.ok(ids.some((id) => id.startsWith("defect-model")), "dirty tree must still scan model");
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

test("loadSavedLensResults rebuilds results a previous collect wrote", async () => {
	const runDir = await mkdtemp(join(tmpdir(), "broadside-restore-"));
	try {
		await writeFile(join(runDir, "defect-core-1.json"), JSON.stringify({ module: "core", findings: [] }), "utf8");
		await writeFile(join(runDir, "architecture-root.json"), JSON.stringify({ summary: "x" }), "utf8");
		await writeFile(join(runDir, "conventions-core-2.json"), "{ truncated output with no closing", "utf8");
		// None of these are lens findings and none may be mistaken for them.
		await writeFile(join(runDir, "requests.json"), "{}", "utf8");
		await writeFile(join(runDir, "run-meta.json"), "{}", "utf8");
		await writeFile(join(runDir, "synthesis.json"), "{}", "utf8");
		await writeFile(join(runDir, "defect-core-9.error.json"), "{}", "utf8");
		await writeFile(join(runDir, "defect-core-1.md"), "# rendered", "utf8");

		const restored = await core.loadSavedLensResults(runDir, ["architecture", "defect", "conventions"]);
		assert.deepEqual(restored.map((r) => r.customId).sort(), ["architecture-root", "conventions-core-2", "defect-core-1"]);
		assert.deepEqual([...new Set(restored.map((r) => r.lensId))].sort(), ["architecture", "conventions", "defect"]);
		assert.equal(restored.find((r) => r.customId === "conventions-core-2").truncated, true, "unparseable content is still a truncation");
		assert.equal(restored.find((r) => r.customId === "defect-core-1").truncated, false);
	} finally {
		await rm(runDir, { recursive: true, force: true });
	}
});

test("a resumed collect runs the post-passes an interrupted one never reached", async () => {
	// The batch window is long and a collect polls for minutes, so losing the
	// process after the lens results are saved but before synthesis and triage
	// is an ordinary outcome. Every lens is terminal on the next run, so
	// nothing is polled — and the post-passes used to be gated on what *this*
	// invocation polled, which left the run permanently without the executive
	// report and work order it exists to produce.
	const dir = await mkdtemp(join(tmpdir(), "broadside-resume-"));
	try {
		const broadsideDir = join(dir, ".codecarto", "broadside");
		const runId = "2026-01-01T00-00-00-000Z";
		const runDir = join(broadsideDir, runId);
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "defect-core-1.json"), JSON.stringify({ module: "core", findings: [{ title: "x" }] }), "utf8");

		await writeFile(join(broadsideDir, "state.json"), JSON.stringify({
			schema_version: 1,
			runs: [{
				id: runId,
				outputDir: runId,   // stored relative to broadside/, as submit records it
				model: BROADSIDE_MODEL,
				lenses: ["defect"],
				status: "in-flight",
				batches: { defect: { batchId: "batch-done", requests: 1, status: "completed", submittedAt: runId, estimatedCost: 0.01, resultCount: 1 } },
				synthesis: { status: "pending" },
				triage: { status: "pending" },
			}],
		}), "utf8");

		const posted = [];
		const done = (id, content) => ({
			id,
			status: "completed",
			results: [{ custom_id: id.replace("batch-", ""), response: { status_code: 200, body: { choices: [{ message: { content } }] } }, error: null }],
			usage: { cost: 0.001 },
		});
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				const customId = JSON.parse(init.body).requests[0].custom_id;
				posted.push(customId);
				return fakeResponse(202, { id: `batch-${customId}`, status: "validating" });
			}
			// The post-pass poll runs on its own budget, so a fake that never
			// reaches a terminal status would hang the suite rather than fail it.
			const id = String(url).split("/").pop();
			return fakeResponse(200, done(id, JSON.stringify({ summary: "s", themes: [], top_findings: [], items: [] })));
		};

		await runBroadsideCollect(dir, "sk-fake", { fetcher, waitMs: 0 });
		assert.ok(posted.length >= 1, "the resumed collect must submit the pending post-passes, not report completion");
		const state = await loadBroadsideState(broadsideDir);
		const run = state.runs.at(-1);
		assert.notEqual(run.synthesis.status, "pending", "synthesis must leave the pending state on resume");
		assert.notEqual(run.triage.status, "pending", "triage must leave the pending state on resume");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a post-pass left at submitted is polled and saved, not stranded", async () => {
	// The batch keeps running and is charged whether or not the collect that
	// submitted it is still alive, so a pass abandoned at "submitted" is a
	// result the user has already paid for and can never retrieve: the pass
	// list is built from "pending" entries, so nothing looks at it again.
	const dir = await mkdtemp(join(tmpdir(), "broadside-rescue-"));
	try {
		const broadsideDir = join(dir, ".codecarto", "broadside");
		const runId = "2026-01-02T00-00-00-000Z";
		const runDir = join(broadsideDir, runId);
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "defect-core-1.json"), JSON.stringify({ module: "core", findings: [] }), "utf8");
		await writeFile(join(broadsideDir, "state.json"), JSON.stringify({
			schema_version: 1,
			runs: [{
				id: runId,
				outputDir: runId,
				model: BROADSIDE_MODEL,
				lenses: ["defect"],
				status: "completed",
				batches: { defect: { batchId: "batch-done", requests: 1, status: "completed", submittedAt: runId, estimatedCost: 0.01, resultCount: 1 } },
				synthesis: { status: "completed", batchId: "batch-synth", cost: 0.01 },
				triage: { status: "submitted", batchId: "batch-triage-inflight" },
			}],
		}), "utf8");

		let posts = 0;
		const fetcher = async (url, init) => {
			if (init.method === "POST") { posts += 1; return fakeResponse(202, { id: "batch-new", status: "validating" }); }
			const id = String(url).split("/").pop();
			return fakeResponse(200, {
				id,
				status: "completed",
				results: [{ custom_id: "triage", response: { status_code: 200, body: { choices: [{ message: { content: JSON.stringify({ items: [] }) } }] } }, error: null }],
				usage: { cost: 0.002 },
			});
		};

		await runBroadsideCollect(dir, "sk-fake", { fetcher, waitMs: 0 });
		const run = (await loadBroadsideState(broadsideDir)).runs.at(-1);
		assert.equal(run.triage.status, "completed", "the in-flight pass must be claimed, not left submitted");
		assert.equal(posts, 0, "an already-submitted pass is polled, never re-submitted and re-charged");
		assert.equal(run.synthesis.status, "completed", "a finished pass is not disturbed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

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


// ---------- outcomes reported for non-completed batches ----------
//
// Leads from the second live Broad-Side scan of this repository, each verified
// against the source before being fixed.

test("a lens whose batch never came back is still reported, not omitted", async () => {
	const dir = await makeFixture();
	try {
		// A batch still in flight when the poll budget expires yields the
		// synthetic `{ status: "timeout" }`, which carries no `error`. The
		// outcome map used to require an error, so this lens disappeared from
		// the report entirely — indistinguishable from one never requested.
		const fetcher = async (url, init) =>
			init.method === "POST"
				? fakeResponse(202, { id: "batch-stuck", status: "validating" })
				: fakeResponse(200, { id: "batch-stuck", status: "in_progress" });

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		const collect = await runBroadsideCollect(dir, "sk-fake", {
			fetcher,
			waitMs: 0,
			includeSynthesis: false,
			includeTriage: false,
		});

		assert.ok(collect.lensOutcomes.architecture, "a timed-out lens must appear in the outcome map");
		assert.equal(collect.lensOutcomes.architecture.status, "timeout");
		assert.notEqual(collect.status, "completed", "a run with an unreturned lens is not complete");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a post-pass whose batch dies without an error is retired, not left submitted", async () => {
	const dir = await makeFixture();
	try {
		const finding = JSON.stringify({ module: "root", findings: [], patterns_checked: [], files_scanned: 1 });
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				const payload = JSON.parse(init.body);
				const isPostPass = payload.requests.some((r) => String(r.custom_id).startsWith("synthesis") || String(r.custom_id).startsWith("triage"));
				return fakeResponse(202, { id: isPostPass ? "batch-postpass" : "batch-lens", status: "validating" });
			}
			if (String(url).includes("batch-postpass")) {
				// Terminal, dead, and carrying no error object.
				return fakeResponse(200, { id: "batch-postpass", status: "expired" });
			}
			return fakeResponse(200, {
				id: "batch-lens",
				status: "completed",
				results: [{ custom_id: "architecture-root", response: { status_code: 200, body: { choices: [{ message: { content: finding } }] } }, error: null }],
				usage: { cost: 0.001 },
			});
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		await runBroadsideCollect(dir, "sk-fake", { fetcher, includeTriage: false });

		const run = (await loadBroadsideState(join(dir, ".codecarto", "broadside"))).runs.at(-1);
		assert.equal(
			run.synthesis.status,
			"failed",
			"an expired post-pass batch must be retired; leaving it 'submitted' makes every later collect re-poll a dead batch",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a timeout is not a dead batch status", () => {
	// The distinction is load-bearing: a dead status retires the work, while a
	// timeout means the batch is still running server-side and has already been
	// paid for, so a later collect must be able to claim its result.
	assert.ok(!BROADSIDE_DEAD_BATCH_STATUSES.includes("timeout"));
	assert.ok(!BROADSIDE_DEAD_BATCH_STATUSES.includes("completed"));
	assert.deepEqual(BROADSIDE_DEAD_BATCH_STATUSES, ["failed", "expired", "cancelled", "auth-failed"]);
});

test("a trailing separator on the target directory does not corrupt slice paths", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const plain = await gatherSlices(dir, lens, info);
		const trailing = await gatherSlices(`${dir}/`, lens, info);

		const filesOf = (slices) => slices.flatMap((s) => s.files).sort();
		assert.deepEqual(
			filesOf(trailing),
			filesOf(plain),
			"paths were sliced at a hardcoded rootDir.length + 1, so a trailing separator cut one character too many",
		);
		assert.ok(filesOf(plain).length > 0, "the fixture must yield files for this to prove anything");
		assert.ok(
			filesOf(trailing).every((f) => !f.startsWith("/")),
			"no slice path may be absolute",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the submit header counts batches sent, not lenses considered", async () => {
	// A lens with nothing to scan is listed as skipped with 0 requests, so
	// counting it in the header made that line contradict the body directly
	// below it. Seen on a live scan of a Rust CLI with no server surface:
	// "submitted 6 batch(es)" over a list of four batches and two skips.
	const dir = await mkdtemp(join(tmpdir(), "broadside-noserver-"));
	try {
		// No server/, no auth*, no middleware/, no SECURITY.md — so the security
		// lens gathers nothing, while architecture always has the repo info.
		await writeFile(join(dir, "go.mod"), "module example.com/cli\n\ngo 1.26.0\n");
		await writeFile(join(dir, "main.go"), "package main\n\nfunc main() {}\n");

		const fetcher = async (url, init) =>
			init.method === "POST"
				? fakeResponse(202, { id: "batch-x", status: "validating" })
				: fakeResponse(200, { id: "batch-x", status: "in_progress" });
		const lenses = ["architecture", "security"];
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses, fetcher });

		const skipped = Object.values(result.batches).filter((b) => !b.batchId);
		assert.equal(skipped.length, 1, "the fixture must produce exactly one lens with nothing to scan");

		const text = estimateSubmitText(result, lenses.map(getLens));
		assert.match(text, /submitted 1 batch\(es\); 1 lens\(es\) produced none/);
		assert.ok(!/submitted 2 batch\(es\)/.test(text), "the header must not count the skipped lens");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("wait_seconds bounds the whole collect, not just the lens poll", async () => {
	// The truncation-retry and post-pass polls each started a fresh 25-minute
	// budget, so `wait_seconds` bounded only the first of three phases: a
	// collect could block for the caller's budget plus fifty minutes. Counting
	// polls rather than measuring elapsed time keeps this test fast and lets it
	// fail cleanly — an earlier version of it hung the suite for 25 minutes when
	// the bug was present, because Promise.race does not cancel the loser.
	const dir = await makeFixture();
	try {
		const finding = JSON.stringify({ module: "root", findings: [], patterns_checked: [], files_scanned: 1 });
		let postPassPolls = 0;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				const payload = JSON.parse(init.body);
				const isPostPass = payload.requests.some((r) =>
					String(r.custom_id).startsWith("synthesis") || String(r.custom_id).startsWith("triage"),
				);
				return fakeResponse(202, { id: isPostPass ? "batch-postpass" : "batch-lens", status: "validating" });
			}
			if (String(url).includes("batch-postpass")) {
				postPassPolls += 1;
				// Terminal on the second poll, so a collect that ignores the
				// deadline still finishes and fails on the assertion below
				// rather than hanging the suite.
				return fakeResponse(200, { id: "batch-postpass", status: postPassPolls >= 2 ? "completed" : "in_progress", results: [], usage: { cost: 0 } });
			}
			return fakeResponse(200, {
				id: "batch-lens",
				status: "completed",
				results: [{ custom_id: "architecture-root", response: { status_code: 200, body: { choices: [{ message: { content: finding } }] } }, error: null }],
				usage: { cost: 0.001 },
			});
		};

		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher });
		const collect = await runBroadsideCollect(dir, "sk-fake", { fetcher, waitMs: 0, includeTriage: false });

		assert.equal(collect.lensOutcomes.architecture.status, "completed", "the lens itself still completed");
		assert.equal(
			postPassPolls,
			1,
			"with no budget left the post-pass must be polled once and abandoned, not retried on a fresh 25-minute deadline",
		);

		const run = (await loadBroadsideState(join(dir, ".codecarto", "broadside"))).runs.at(-1);
		assert.equal(
			run.synthesis.status,
			"submitted",
			"a pass whose poll ran out stays claimable: the batch is paid for and a later collect must be able to claim it",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- incremental fallback is reported, not silent ----------
//
// A request for incremental scouting falls back to a full scan whenever there
// is nothing to diff against. That fallback costs real money — the caller asked
// for the cheap mode and pays for the expensive one — so it has to be stated.
// Found live: an incremental scan of a Rust repository submitted all 31
// requests at full price because the earlier run predated the repo being a git
// checkout, and the output said nothing about it.

const acceptingFetcher = async (url, init) =>
	init.method === "POST"
		? fakeResponse(202, { id: "batch-x", status: "validating" })
		: fakeResponse(200, { id: "batch-x", status: "in_progress" });

test("an incremental run with no baseline says so instead of quietly scanning everything", async () => {
	const dir = await makeGitRepo();
	try {
		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["architecture"],
			fetcher: acceptingFetcher,
			incremental: true,
		});
		assert.equal(result.incremental.requested, true);
		assert.equal(result.incremental.applied, false);
		assert.equal(result.incremental.reason, "no-baseline");

		const text = estimateSubmitText(result, [getLens("architecture")]);
		assert.match(text, /Incremental: requested but NOT applied/);
		assert.match(text, /no earlier run recorded a commit/);
		assert.match(text, /at full cost/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an incremental run against a dirty worktree names that as the reason", async () => {
	const dir = await makeGitRepo();
	try {
		// A first run records the commit a later run would diff against.
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: acceptingFetcher });
		await writeFile(join(dir, "main.go"), "package main\n// uncommitted\n");

		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["architecture"],
			fetcher: acceptingFetcher,
			incremental: true,
		});
		assert.equal(result.incremental.applied, false);
		assert.equal(result.incremental.reason, "dirty-worktree");
		assert.match(estimateSubmitText(result, [getLens("architecture")]), /uncommitted changes/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an incremental run that finds a baseline reports the commit it diffed against", async () => {
	const dir = await makeGitRepo();
	try {
		await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: acceptingFetcher });
		await writeFile(join(dir, "main.go"), "package main\n// committed change\n");
		await git(dir, "add", "-A");
		await git(dir, "commit", "-q", "-m", "change");

		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["architecture"],
			fetcher: acceptingFetcher,
			incremental: true,
		});
		assert.equal(result.incremental.applied, true, "a committed change on top of a recorded run must diff cleanly");
		assert.ok(result.incremental.baseHead, "the base commit must be recorded");

		const text = estimateSubmitText(result, [getLens("architecture")]);
		assert.match(text, /Incremental: scanning only what changed since/);
		assert.match(text, new RegExp(result.incremental.baseHead.slice(0, 8)));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a run that never asked for incremental says nothing about it", async () => {
	const dir = await makeGitRepo();
	try {
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture"], fetcher: acceptingFetcher });
		assert.equal(result.incremental.requested, false);
		assert.ok(
			!/Incremental:/.test(estimateSubmitText(result, [getLens("architecture")])),
			"an unrequested mode must not add noise to the summary",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- reasoning tokens must not eat the output budget ----------
//
// Sending no `reasoning` field means each model applies its own default. A
// reasoning-capable model then spent 5,758 of a 6,000-token output budget
// thinking and left ~230 tokens for the JSON, which truncated mid-structure —
// on 11 of 13 slices, with the thinking billed at the full output rate. The
// field is now always present.

test("every lens request caps reasoning explicitly", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		for (const lensId of BROADSIDE_LENS_IDS) {
			const lens = getLens(lensId);
			const slices = await gatherSlices(dir, lens, info);
			if (slices.length === 0) continue;
			const request = buildBatchRequest(lens, info, slices[0], 0, slices.length);
			assert.ok(
				Object.prototype.hasOwnProperty.call(request.body, "reasoning"),
				`${lensId} must send reasoning explicitly rather than inheriting the model's default`,
			);
			const cap = request.body.reasoning.max_tokens;
			assert.ok(cap > 0, `${lensId} must carry a reasoning cap`);
			assert.ok(cap < request.body.max_tokens, `${lensId}'s cap must leave room for the answer`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the cap is a cap, never an off switch", async () => {
	// Disabling is not portable: google/gemini-3.8-flash:batch refuses the whole
	// batch with "Reasoning is mandatory for this endpoint and cannot be
	// disabled", which turns a partial result into none at all. Verified live —
	// `{enabled: false}` failed 13 of 13 requests on that model, where the
	// uncapped run had at least produced 2.
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const slices = await gatherSlices(dir, lens, info);
		const reasoning = buildBatchRequest(lens, info, slices[0], 0, slices.length).body.reasoning;
		assert.equal(reasoning.enabled, undefined, "the default must not try to switch reasoning off");
		assert.equal(typeof reasoning.max_tokens, "number");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the reasoning cap leaves exactly the share estimateCost budgets for output", () => {
	// estimateCost budgets output at 75% of maxTokens. Capping thinking at the
	// remaining quarter makes that assumption true rather than hopeful.
	assert.equal(BROADSIDE_REASONING_BUDGET_FRACTION, 0.25);
	assert.equal(defaultReasoningFor(6000).max_tokens, 1500);
	assert.equal(defaultReasoningFor(8000).max_tokens, 2000);
	// A small lens still gets a usable floor rather than a nonsense cap.
	assert.equal(defaultReasoningFor(100).max_tokens, BROADSIDE_MIN_REASONING_TOKENS);
});

test("a retry's extra budget goes to the answer, not to more thinking", async () => {
	// #133 doubles maxTokens on a truncated slice, and the retry clones the
	// stored request rather than rebuilding it — so the reasoning cap carries
	// over unchanged while the answer budget doubles. That is the right way
	// round: the slice was retried *because* the answer was cut off, so the
	// extra budget belongs to the answer.
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const slices = await gatherSlices(dir, lens, info);
		const original = buildBatchRequest(lens, info, slices[0], 0, slices.length);
		const bumped = { ...original, body: { ...original.body, max_tokens: original.body.max_tokens * 2 } };

		assert.equal(bumped.body.reasoning.max_tokens, original.body.reasoning.max_tokens, "the thinking cap must not grow");
		const answerBefore = original.body.max_tokens - original.body.reasoning.max_tokens;
		const answerAfter = bumped.body.max_tokens - bumped.body.reasoning.max_tokens;
		assert.ok(answerAfter > answerBefore * 2, "all of the extra budget must reach the answer");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a per-lens reasoning setting overrides the default", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = { ...getLens("defect"), reasoning: { effort: "low" } };
		const slices = await gatherSlices(dir, lens, info);
		const request = buildBatchRequest(lens, info, slices[0], 0, slices.length);
		assert.deepEqual(request.body.reasoning, { effort: "low" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an explicit override beats both the lens and the default", async () => {
	const dir = await makeFixture();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("defect");
		const slices = await gatherSlices(dir, lens, info);
		const request = buildBatchRequest(lens, info, slices[0], 0, slices.length, undefined, undefined, { effort: "high" });
		assert.deepEqual(request.body.reasoning, { effort: "high" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("config.yaml can re-enable reasoning, and malformed values are ignored", async () => {
	const dir = await mkdtemp(join(tmpdir(), "broadside-reasoning-"));
	try {
		const write = async (body) => {
			await writeFile(join(dir, "config.yaml"), body, "utf8");
			return loadBroadsideConfig(dir);
		};
		assert.equal((await write("model: x\n")).reasoning, null, "absent means: use the lens default");
		assert.deepEqual((await write("reasoning:\n  effort: high\n")).reasoning, { effort: "high" });
		assert.deepEqual((await write("reasoning:\n  enabled: true\n")).reasoning, { enabled: true });
		assert.deepEqual((await write("reasoning:\n  max_tokens: 2000\n")).reasoning, { max_tokens: 2000 });
		// A typo must not silently become a setting.
		assert.equal((await write("reasoning:\n  effort: enormous\n")).reasoning, null);
		assert.equal((await write("reasoning:\n  max_tokens: -5\n")).reasoning, null);
		assert.equal((await write("reasoning: not-a-mapping\n")).reasoning, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
