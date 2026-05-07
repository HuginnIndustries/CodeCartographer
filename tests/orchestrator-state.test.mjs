// Round-trip tests for the per-machine orchestrator session pointer that
// /codecarto-init writes when run from the Pi extension. Each test creates
// a temp .codecarto/ skeleton and exercises load/write directly — no Pi
// runtime mocking; the helpers are pure filesystem I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadOrchestratorState, writeOrchestratorState } = await import(`${REPO_ROOT}/core/orchestrator.ts`);

async function withTempWorkspace(fn) {
	const root = await mkdtemp(join(tmpdir(), "cc-orch-"));
	await mkdir(join(root, ".codecarto", "workflow"), { recursive: true });
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

test("loadOrchestratorState returns null when the file is missing", async () => {
	await withTempWorkspace(async (cwd) => {
		const state = await loadOrchestratorState(cwd);
		assert.equal(state, null);
	});
});

test("write then load round-trips both fields", async () => {
	await withTempWorkspace(async (cwd) => {
		const written = {
			sessionFile: "/home/user/.pi/agent/sessions/abc123.json",
			sessionId: "abc123",
		};
		await writeOrchestratorState(cwd, written);
		const read = await loadOrchestratorState(cwd);
		assert.deepEqual(read, written);
	});
});

test("loadOrchestratorState returns null when the file is malformed YAML", async () => {
	await withTempWorkspace(async (cwd) => {
		const path = join(cwd, ".codecarto", "workflow", ".orchestrator.local.yaml");
		await writeFile(path, "this isn't structured: at all: : :\n", "utf8");
		const state = await loadOrchestratorState(cwd);
		assert.equal(state, null);
	});
});

test("loadOrchestratorState returns null when sessionFile is missing", async () => {
	await withTempWorkspace(async (cwd) => {
		const path = join(cwd, ".codecarto", "workflow", ".orchestrator.local.yaml");
		await writeFile(path, "sessionId: only-id-no-file\n", "utf8");
		const state = await loadOrchestratorState(cwd);
		assert.equal(state, null);
	});
});

test("loadOrchestratorState returns null when sessionId is missing", async () => {
	await withTempWorkspace(async (cwd) => {
		const path = join(cwd, ".codecarto", "workflow", ".orchestrator.local.yaml");
		await writeFile(path, "sessionFile: /tmp/some/path.json\n", "utf8");
		const state = await loadOrchestratorState(cwd);
		assert.equal(state, null);
	});
});

test("writeOrchestratorState overwrites an existing file", async () => {
	await withTempWorkspace(async (cwd) => {
		await writeOrchestratorState(cwd, { sessionFile: "/old/path.json", sessionId: "old" });
		await writeOrchestratorState(cwd, { sessionFile: "/new/path.json", sessionId: "new" });
		const state = await loadOrchestratorState(cwd);
		assert.deepEqual(state, { sessionFile: "/new/path.json", sessionId: "new" });
	});
});

test("written file lives at workflow/.orchestrator.local.yaml", async () => {
	await withTempWorkspace(async (cwd) => {
		await writeOrchestratorState(cwd, { sessionFile: "/x.json", sessionId: "x" });
		const path = join(cwd, ".codecarto", "workflow", ".orchestrator.local.yaml");
		const content = await readFile(path, "utf8");
		assert.match(content, /sessionFile:.*x\.json/);
		assert.match(content, /sessionId:.*x/);
	});
});
