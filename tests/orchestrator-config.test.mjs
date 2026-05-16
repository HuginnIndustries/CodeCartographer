// Unit tests for loadCodecartoConfig + mergeConfig. Pure parsing / shape
// validation; the file-IO path is exercised by feeding pre-built fixtures
// into a tmp directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadCodecartoConfig, loadUserConfig, mergeConfig, CONFIG_RELATIVE_PATH } = await import(pathToFileURL(`${REPO_ROOT}/core/orchestrator-config.ts`).href);

async function makeWorkspace(configContent) {
	const dir = await mkdtemp(join(tmpdir(), "codecarto-config-"));
	const workspaceDir = join(dir, ".codecarto");
	await mkdir(join(workspaceDir, "workflow"), { recursive: true });
	if (configContent !== undefined) {
		await writeFile(join(workspaceDir, CONFIG_RELATIVE_PATH), configContent, "utf8");
	}
	return { workspaceDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Set CODECARTO_USER_CONFIG_PATH to a tmp file and return a cleanup helper
 * that both removes the dir and restores the env var. Tests that touch
 * user-global config MUST use this so they don't poison the real ~/.codecarto/.
 */
async function withMockedUserConfig(content) {
	const previous = process.env.CODECARTO_USER_CONFIG_PATH;
	const dir = await mkdtemp(join(tmpdir(), "codecarto-userconfig-"));
	const path = join(dir, "config.yaml");
	if (content !== undefined) {
		await writeFile(path, content, "utf8");
	}
	process.env.CODECARTO_USER_CONFIG_PATH = path;
	return {
		path,
		cleanup: async () => {
			if (previous === undefined) delete process.env.CODECARTO_USER_CONFIG_PATH;
			else process.env.CODECARTO_USER_CONFIG_PATH = previous;
			await rm(dir, { recursive: true, force: true });
		},
	};
}

// Guarantee no stale CODECARTO_USER_CONFIG_PATH leaks across tests that
// don't set it explicitly — point it at a path that won't exist.
async function withNoUserConfig() {
	return withMockedUserConfig(undefined);
}

test("loadCodecartoConfig returns defaults when config.yaml is missing", async () => {
	const noUser = await withNoUserConfig();
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.orchestrator.llm_steer_next_phase, false);
		assert.equal(config.library.path, null);
		assert.equal(config.library.namespace, null);
		assert.equal(config.library.publish_confirm, true);
	} finally {
		await cleanup();
		await noUser.cleanup();
	}
});

test("loadCodecartoConfig reads orchestrator.llm_steer_next_phase: true", async () => {
	const noUser = await withNoUserConfig();
	const { workspaceDir, cleanup } = await makeWorkspace("orchestrator:\n  llm_steer_next_phase: true\n");
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.orchestrator.llm_steer_next_phase, true);
	} finally {
		await cleanup();
		await noUser.cleanup();
	}
});

test("loadCodecartoConfig falls back to defaults on malformed YAML", async () => {
	const noUser = await withNoUserConfig();
	const { workspaceDir, cleanup } = await makeWorkspace("orchestrator: [not, a, mapping]\n");
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.orchestrator.llm_steer_next_phase, false);
	} finally {
		await cleanup();
		await noUser.cleanup();
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

// ─── Library config block ─────────────────────────────────────────────────

test("mergeConfig parses library block with tilde-expanded path", () => {
	const result = mergeConfig({
		library: { path: "/abs/path/to/lib", namespace: "alice", publish_confirm: false },
	});
	assert.equal(result.library.path, resolve("/abs/path/to/lib"));
	assert.equal(result.library.namespace, "alice");
	assert.equal(result.library.publish_confirm, false);
});

test("mergeConfig leaves library defaults intact when block is missing", () => {
	const result = mergeConfig({ orchestrator: { llm_steer_next_phase: true } });
	assert.equal(result.library.path, null);
	assert.equal(result.library.namespace, null);
	assert.equal(result.library.publish_confirm, true);
});

test("mergeConfig ignores empty-string library path / namespace", () => {
	const result = mergeConfig({ library: { path: "", namespace: "  " } });
	assert.equal(result.library.path, null);
	assert.equal(result.library.namespace, null);
});

test("loadCodecartoConfig reads user-global library config", async () => {
	const noUser = await withMockedUserConfig(
		"library:\n  path: /abs/user-lib\n  namespace: james\n  publish_confirm: false\n",
	);
	const { workspaceDir, cleanup } = await makeWorkspace();
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.library.path, resolve("/abs/user-lib"));
		assert.equal(config.library.namespace, "james");
		assert.equal(config.library.publish_confirm, false);
	} finally {
		await cleanup();
		await noUser.cleanup();
	}
});

test("workspace library config overrides user-global", async () => {
	const noUser = await withMockedUserConfig(
		"library:\n  path: /abs/user-lib\n  namespace: james\n  publish_confirm: false\n",
	);
	const { workspaceDir, cleanup } = await makeWorkspace(
		"library:\n  path: /abs/workspace-lib\n  namespace: alice\n",
	);
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		// path + namespace overridden by workspace
		assert.equal(config.library.path, resolve("/abs/workspace-lib"));
		assert.equal(config.library.namespace, "alice");
		// publish_confirm not in workspace, so inherited from user-global
		assert.equal(config.library.publish_confirm, false);
	} finally {
		await cleanup();
		await noUser.cleanup();
	}
});

test("malformed user-global config is silently ignored", async () => {
	const noUser = await withMockedUserConfig("library: [not, a, mapping]\n");
	const { workspaceDir, cleanup } = await makeWorkspace(
		"library:\n  path: /abs/workspace-lib\n",
	);
	try {
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.library.path, resolve("/abs/workspace-lib"));
		assert.equal(config.library.publish_confirm, true);  // fell back to default
	} finally {
		await cleanup();
		await noUser.cleanup();
	}
});

test("loadUserConfig reads user-global without a workspace", async () => {
	const noUser = await withMockedUserConfig(
		"library:\n  path: /abs/user-lib\n  namespace: james\n",
	);
	try {
		const config = await loadUserConfig();
		assert.equal(config.library.path, resolve("/abs/user-lib"));
		assert.equal(config.library.namespace, "james");
	} finally {
		await noUser.cleanup();
	}
});
