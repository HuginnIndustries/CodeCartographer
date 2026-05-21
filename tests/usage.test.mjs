// Tests for the local-only phase usage log: round-trip read/append,
// totals math, malformed-file resilience.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadUsage, appendUsageRun, computeTotals, computePerPhaseTotals, USAGE_RELATIVE_PATH } = await import(pathToFileURL(`${REPO_ROOT}/core/usage.ts`).href);

async function makeWorkspace() {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-usage-"));
	const workspaceDir = join(dir, ".codecarto");
	await mkdir(join(workspaceDir, "workflow"), { recursive: true });
	return { workspaceDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function sampleRun(overrides = {}) {
	return {
		timestamp: "2026-05-08T12:00:00.000Z",
		phase: "blueprint",
		status: "completed",
		turn_count: 5,
		tool_uses: 12,
		duration_ms: 90_000,
		tokens: { input: 1500, output: 800, cache_write: 0 },
		session_file: "/some/path.jsonl",
		...overrides,
	};
}

test("loadUsage on a fresh workspace returns empty runs and version 1", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		const u = await loadUsage(workspaceDir);
		assert.equal(u.version, 1);
		assert.deepEqual(u.runs, []);
	} finally {
		await cleanup();
	}
});

test("appendUsageRun creates the file and round-trips runs", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		await appendUsageRun(workspaceDir, sampleRun());
		await appendUsageRun(workspaceDir, sampleRun({ phase: "contracts", turn_count: 3, tool_uses: 6 }));
		const u = await loadUsage(workspaceDir);
		assert.equal(u.runs.length, 2);
		assert.equal(u.runs[0].phase, "blueprint");
		assert.equal(u.runs[1].phase, "contracts");
	} finally {
		await cleanup();
	}
});

test("computeTotals sums tokens, tool_uses, and durations across all runs", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		await appendUsageRun(workspaceDir, sampleRun());
		await appendUsageRun(workspaceDir, sampleRun({
			phase: "contracts",
			turn_count: 3,
			tool_uses: 6,
			duration_ms: 30_000,
			tokens: { input: 500, output: 300, cache_write: 200 },
		}));
		const totals = computeTotals(await loadUsage(workspaceDir));
		assert.equal(totals.runs, 2);
		assert.equal(totals.tokens.input, 2000);
		assert.equal(totals.tokens.output, 1100);
		assert.equal(totals.tokens.cache_write, 200);
		assert.equal(totals.tool_uses, 18);
		assert.equal(totals.duration_ms, 120_000);
	} finally {
		await cleanup();
	}
});

test("computePerPhaseTotals groups by phase ID", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		await appendUsageRun(workspaceDir, sampleRun({ phase: "blueprint", duration_ms: 1000 }));
		await appendUsageRun(workspaceDir, sampleRun({ phase: "blueprint", duration_ms: 2000 }));
		await appendUsageRun(workspaceDir, sampleRun({ phase: "contracts", duration_ms: 500 }));
		const perPhase = computePerPhaseTotals(await loadUsage(workspaceDir));
		assert.equal(perPhase.size, 2);
		assert.equal(perPhase.get("blueprint").runs, 2);
		assert.equal(perPhase.get("blueprint").duration_ms, 3000);
		assert.equal(perPhase.get("contracts").runs, 1);
	} finally {
		await cleanup();
	}
});

test("loadUsage falls back to empty file on malformed YAML", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		await writeFile(join(workspaceDir, USAGE_RELATIVE_PATH), "not: [valid yaml: here", "utf8");
		const u = await loadUsage(workspaceDir);
		assert.equal(u.runs.length, 0);
	} finally {
		await cleanup();
	}
});

test("loadUsage drops entries that lack required fields", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		// Two valid runs, one bogus (missing phase). Bogus is dropped.
		await appendUsageRun(workspaceDir, sampleRun());
		// Hand-write a run that's missing the `phase` field.
		const path = join(workspaceDir, USAGE_RELATIVE_PATH);
		const bad = `version: 1\nruns:\n  -\n    timestamp: '2026-05-08T13:00:00.000Z'\n    phase: 'blueprint'\n    status: 'completed'\n    turn_count: 1\n    tool_uses: 0\n    duration_ms: 100\n    tokens:\n      input: 0\n      output: 0\n      cache_write: 0\n  -\n    timestamp: '2026-05-08T14:00:00.000Z'\n    status: 'completed'\n    turn_count: 1\n`;
		await writeFile(path, bad, "utf8");
		const u = await loadUsage(workspaceDir);
		assert.equal(u.runs.length, 1);
		assert.equal(u.runs[0].phase, "blueprint");
	} finally {
		await cleanup();
	}
});

test("loadUsage drops entries with non-numeric counters or malformed tokens", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		const path = join(workspaceDir, USAGE_RELATIVE_PATH);
		const bad = `version: 1\nruns:\n  -\n    timestamp: '2026-05-08T13:00:00.000Z'\n    phase: 'blueprint'\n    status: 'completed'\n    turn_count: '<img src=x onerror=alert(1)>'\n    tool_uses: 0\n    duration_ms: 100\n    tokens:\n      input: 0\n      output: 0\n      cache_write: 0\n  -\n    timestamp: '2026-05-08T14:00:00.000Z'\n    phase: 'contracts'\n    status: 'completed'\n    turn_count: 1\n    tool_uses: 2\n    duration_ms: 300\n    tokens:\n      input: 10\n      output: 20\n      cache_write: 0\n`;
		await writeFile(path, bad, "utf8");
		const u = await loadUsage(workspaceDir);
		assert.equal(u.runs.length, 1);
		assert.equal(u.runs[0].phase, "contracts");
	} finally {
		await cleanup();
	}
});
