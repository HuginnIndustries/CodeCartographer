// The five MCP handlers no test invoked.
//
// Companion to tests/pi-command-handlers.test.mjs, written for the same reason
// and after the same survey: exported handlers with zero test invocations are
// where surface bugs live, because the core logic behind them is covered
// exhaustively and the wiring is not. `handleBroadside` is the one that matters
// most — it is the MCP entry point for the only feature that spends money.
//
// Everything here runs offline. No model, no network, no API key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ABSENT_GIT_CONFIG = join(tmpdir(), "codecarto-tests-absent-gitconfig");
process.env.GIT_CONFIG_GLOBAL = ABSENT_GIT_CONFIG;
process.env.GIT_CONFIG_SYSTEM = ABSENT_GIT_CONFIG;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
	handleInit,
	handleOpen,
	handleSwitchPipeline,
	handleUsage,
	handleDashboard,
	handleBroadside,
} = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { getWorkspaceState } = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

async function withWorkspace(fn, { init = "lite" } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-mcp-uncovered-"));
	try {
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "package.json"), '{"name":"t","version":"0.1.0"}\n', "utf8");
		await writeFile(join(cwd, "src", "index.ts"), "export const x = 1;\n", "utf8");
		if (init) await handleInit({ cwd, pipeline: init });
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

// ---------- codecarto_open ----------

test("open reports an existing workspace", async () => {
	await withWorkspace(async (cwd) => {
		const result = await handleOpen({ cwd });
		assert.match(result.content[0].text, /codecarto|workspace/i);
	});
});

test("open refuses a directory with no workspace", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(
			() => handleOpen({ cwd }),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.match(error.message, /codecarto_init|No existing/i);
				return true;
			},
		);
	}, { init: false });
});

test("open rejects a relative cwd", async () => {
	await assert.rejects(() => handleOpen({ cwd: "relative/path" }), /absolute/i);
});

// ---------- codecarto_switch_pipeline ----------

test("switch_pipeline changes the active pipeline and keeps progress", async () => {
	await withWorkspace(async (cwd) => {
		const before = await getWorkspaceState(cwd);
		assert.match(before.status.pipeline, /pipeline-lite\.yaml$/);

		const result = await handleSwitchPipeline({ cwd, pipeline: "full" });
		assert.ok(result.content[0].text.length > 0);

		const after = await getWorkspaceState(cwd);
		assert.doesNotMatch(after.status.pipeline, /pipeline-lite\.yaml$/);
		assert.ok(after.pipeline.phase_order.length > before.pipeline.phase_order.length);
	});
});

test("switch_pipeline rejects an unknown variant without touching status", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(
			() => handleSwitchPipeline({ cwd, pipeline: "turbo" }),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.match(error.message, /Unknown pipeline: turbo/);
				return true;
			},
		);
		const state = await getWorkspaceState(cwd);
		assert.match(state.status.pipeline, /pipeline-lite\.yaml$/, "a rejected switch must leave the pipeline alone");
	});
});

// ---------- codecarto_usage ----------

test("usage reports an empty log rather than failing", async () => {
	await withWorkspace(async (cwd) => {
		const result = await handleUsage({ cwd });
		assert.equal(result.content[0].type, "text");
		assert.ok(result.content[0].text.length > 0, "usage must say something on an empty log");
	});
});

test("usage requires a workspace", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(() => handleUsage({ cwd }), /codecarto_init/);
	}, { init: false });
});

// ---------- codecarto_dashboard ----------

test("dashboard writes a single self-contained file", async () => {
	await withWorkspace(async (cwd) => {
		const path = join(cwd, ".codecarto", "dashboard.html");
		await rm(path, { force: true });
		await handleDashboard({ cwd });
		const html = await readFile(path, "utf8");
		assert.match(html, /<html|<!doctype/i);

		// The contract worth enforcing is self-containment, not the absence of
		// JavaScript. The renderer inlines a JSON data island and a search and
		// filter script, which is why this file works opened straight off disk
		// with no server and no network. CLAUDE.md described it as "no JS" until
		// this test was written; that half was stale, the external-asset half
		// was not.
		assert.equal((html.match(/(src|href)\s*=\s*["']https?:/gi) ?? []).length, 0, "no external src or href");
		assert.equal((html.match(/<link/gi) ?? []).length, 0, "no stylesheet links");
		assert.equal((html.match(/https?:\/\//gi) ?? []).length, 0, "no absolute URLs at all");
		assert.match(html, /prefers-color-scheme/, "light and dark come from the media query, not a toggle");
	});
});

// ---------- codecarto_broadside ----------

test("broadside rejects an unknown action and names the valid ones", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(
			() => handleBroadside({ cwd, action: "obliterate" }),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams);
				assert.match(error.message, /Unknown action: obliterate/);
				assert.match(error.message, /submit, collect, status, models/);
				return true;
			},
		);
	});
});

test("broadside status needs no API key", async () => {
	await withWorkspace(async (cwd) => {
		// The status branch returns before the key is resolved, which is what
		// makes it usable for checking on a run you have already paid for.
		const result = await handleBroadside({ cwd, action: "status" });
		assert.equal(result.content[0].type, "text");
		assert.ok(result.content[0].text.length > 0);
	});
});

test("broadside without a key says exactly where to put one", async () => {
	await withWorkspace(async (cwd) => {
		const saved = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			await assert.rejects(
				() => handleBroadside({ cwd, action: "submit" }),
				(error) => {
					assert.match(error.message, /No OpenRouter API key found/);
					assert.match(error.message, /api_key/);
					assert.match(error.message, /OPENROUTER_API_KEY/);
					assert.match(error.message, /config\.yaml/);
					return true;
				},
			);
		} finally {
			if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
		}
	});
});

test("broadside rejects an unknown lens before spending anything", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(
			() => handleBroadside({ cwd, action: "submit", api_key: "sk-not-used", lenses: ["architecture", "vibes"] }),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidParams);
				assert.match(error.message, /Unknown lens\(es\): vibes/);
				return true;
			},
		);
	});
});

test("broadside rejects a relative cwd before doing anything else", async () => {
	await assert.rejects(() => handleBroadside({ cwd: "relative/path", action: "status" }), /absolute/i);
});
