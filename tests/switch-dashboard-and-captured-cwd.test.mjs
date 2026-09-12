// Two Pi/MCP parity gaps from the self-audit.
//
// #254 (D-M24): Pi re-rendered the dashboard after a pipeline switch and MCP
// did not, so the file showed the old pipeline until the next completion.
// The writer now lives in core and codecarto_switch_pipeline calls it.
//
// #255 (D-M25): the auto runner captures the workspace root before spawning a
// phase sub-agent, because the sub-agent replaces the session and every later
// read of `ctx.cwd` throws (#201). Two post-phase sites still read `ctx.cwd`.
// The discipline is pinned at the source level here, since reaching those
// lines needs a live Pi session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

test("codecarto_switch_pipeline re-renders the dashboard for the new pipeline (spec M24)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-switch-dash-"));
	try {
		await server.handleInit({ cwd, pipeline: "lite" });
		await server.handleDashboard({ cwd });
		const path = join(cwd, ".codecarto", "dashboard.html");
		const before = await readFile(path, "utf8");
		assert.match(before, /pipeline-lite\.yaml/);
		assert.doesNotMatch(before, /defect-scan-mechanical/);
		// Push the mtime into the past so an advance is unambiguous.
		const past = new Date(Date.now() - 60_000);
		await utimes(path, past, past);

		const result = await server.handleSwitchPipeline({ cwd, pipeline: "full-with-deep-audit" });
		assert.equal(result.structuredContent.dashboardPath, ".codecarto/dashboard.html");
		assert.match(result.content[0].text, /^Dashboard refreshed: \.codecarto\/dashboard\.html$/m);
		assert.ok((await stat(path)).mtimeMs > past.getTime(), "the dashboard file's mtime advances");
		const after = await readFile(path, "utf8");
		assert.match(after, /pipeline-full-with-deep-audit\.yaml/);
		assert.match(after, /defect-scan-mechanical/, "the new pipeline's phases are on the dashboard");
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("writeDashboard is a core export, and the old extension path still resolves", async () => {
	assert.equal(typeof core.writeDashboard, "function");
	const shim = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/dashboard-writer.ts`).href);
	assert.equal(shim.writeDashboard, core.writeDashboard);
	const serverSource = await readFile(join(REPO_ROOT, "mcp-server", "server.ts"), "utf8");
	assert.doesNotMatch(serverSource, /from "\.\.\/extensions\//, "the MCP server imports shared primitives from core, never from the Pi extension");
});

test("the auto runner reads ctx.cwd exactly once, before any phase runs", async () => {
	const source = await readFile(join(REPO_ROOT, "extensions", "codecarto", "auto-runner.ts"), "utf8");
	const reads = source
		.split("\n")
		.map((line, index) => ({ line, number: index + 1 }))
		.filter(({ line }) => /\bctx\.cwd\b/.test(line) && !/^\s*\/\//.test(line));
	assert.deepEqual(
		reads.map(({ line }) => line.trim()),
		["const autoCwd = ctx.cwd;"],
		`every post-phase site must use the captured root; found: ${reads.map(({ number, line }) => `${number}: ${line.trim()}`).join(" | ")}`,
	);
});
