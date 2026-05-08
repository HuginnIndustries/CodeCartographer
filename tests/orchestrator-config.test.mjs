// Unit tests for loadCodecartoConfig + mergeConfig. Pure parsing / shape
// validation; the file-IO path is exercised by feeding pre-built fixtures
// into a tmp directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadCodecartoConfig, mergeConfig, CONFIG_RELATIVE_PATH } = await import(
	`${REPO_ROOT}/core/orchestrator-config.ts`
);

async function makeWorkspace(configContent) {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-config-"));
	const workspaceDir = join(dir, ".codecarto");
	await mkdir(join(workspaceDir, "workflow"), { recursive: true });
	if (configContent !== undefined) {
		await writeFile(join(workspaceDir, CONFIG_RELATIVE_PATH), configContent, "utf8");
	}
	return { workspaceDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("loadCodecartoConfig returns defaults when config.yaml is missing", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.orchestrator.llm_steer_next_phase, false);
	} finally {
		await cleanup();
	}
});

test("loadCodecartoConfig reads orchestrator.llm_steer_next_phase: true", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace("orchestrator:\n  llm_steer_next_phase: true\n");
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.orchestrator.llm_steer_next_phase, true);
	} finally {
		await cleanup();
	}
});

test("loadCodecartoConfig falls back to defaults on malformed YAML", async () => {
	const { workspaceDir, cleanup } = await makeWorkspace("orchestrator: [not, a, mapping]\n");
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.orchestrator.llm_steer_next_phase, false);
	} finally {
		await cleanup();
	}
});

test("mergeConfig ignores unknown keys", () => {
	const result = mergeConfig({ orchestrator: { llm_steer_next_phase: true, future_flag: "x" } });
	assert.equal(result.orchestrator.llm_steer_next_phase, true);
});

test("mergeConfig coerces non-boolean llm_steer_next_phase to default false", () => {
	const result = mergeConfig({ orchestrator: { llm_steer_next_phase: "yes" } });
	assert.equal(result.orchestrator.llm_steer_next_phase, false);
});

test("mergeConfig handles null/undefined input as full defaults", () => {
	assert.equal(mergeConfig(null).orchestrator.llm_steer_next_phase, false);
	assert.equal(mergeConfig(undefined).orchestrator.llm_steer_next_phase, false);
	assert.equal(mergeConfig({}).orchestrator.llm_steer_next_phase, false);
});
