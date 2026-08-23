// Regression tests for the five defects the Broad-Side self-scan found and
// verified (#128–#132). Each test pins the fixed behavior; without the fix,
// each fails in the documented way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { completeValidatedPhase } = await import(pathToFileURL(`${REPO_ROOT}/core/completion.ts`).href);
const { waitForCompaction } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/agent-runner.ts`).href);

async function initWorkspace(cwd, pipeline = "workflow/pipeline-architecture-only.yaml") {
	const packaged = join(REPO_ROOT, ".codecarto");
	await cp(packaged, join(cwd, ".codecarto"), { recursive: true });
	const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
	const raw = await core.loadYamlFile(statusPath);
	raw.pipeline = pipeline;
	await writeFile(statusPath, `${core.stringifySimpleYaml(raw)}\n`, "utf8");
}

// ---------- #128: writeLibraryConfig must create parent directories ----------

test("#128 writeLibraryConfig creates nested parent directories", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-128-"));
	try {
		const configPath = join(dir, "deeply", "nested", "dir", "config.yaml");
		await core.writeLibraryConfig(configPath, "/some/library");
		const written = await readFile(configPath, "utf8");
		assert.match(written, /library:/);
		assert.match(written, /\/some\/library/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- #130: isWithinPath at filesystem roots ----------

test("#130 isWithinPath accepts subpaths when the root is a filesystem root", () => {
	assert.equal(core.isWithinPath("/etc/passwd", "/"), true, "/etc/passwd is within /");
	assert.equal(core.isWithinPath("/repo/src", "/repo"), true, "normal case still works");
	assert.equal(core.isWithinPath("/repo2", "/repo"), false, "sibling prefixes still rejected");
	assert.equal(core.isWithinPath("/repo", "/repo/src"), false, "parent is not within child");
});

// ---------- #131: acquireLock keeps the descriptor discipline ----------

test("#131 acquireLock releases cleanly and allows re-acquisition", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-131-"));
	try {
		const lockPath = join(dir, "status.lock");
		const first = await core.acquireLock(lockPath);
		await first.release();
		// The descriptor must have been closed by release's rm; re-acquiring
		// with a fresh exclusive open must succeed.
		const second = await core.acquireLock(lockPath);
		assert.equal(typeof second.release, "function");
		await second.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- #129: settled compaction promise must not cost 30s ----------

test("#129 waitForCompaction returns immediately when the promise is pre-settled", async () => {
	const started = Date.now();
	const compacted = await waitForCompaction(Promise.resolve(false), 30_000);
	const elapsed = Date.now() - started;
	assert.equal(compacted, false);
	assert.ok(elapsed < 1000, `settled promise must not wait for the timeout (took ${elapsed}ms)`);
});

// ---------- #132: completion re-validates under the status lock ----------

test("#132 completeValidatedPhase refuses a stale PASS when the output changed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-132-"));
	try {
		await initWorkspace(cwd);
		const outputPath = join(cwd, ".codecarto", "findings", "architecture", "architecture-map.md");
		await writeFile(
			outputPath,
			"# Architecture Map\n\n## Validation\n\n| Criterion | Result | Evidence |\n|---|---|---|\n| Intent documented | PASS | yes |\n\n**Overall:** PASS\n",
			"utf8",
		);
		const handoffDir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(handoffDir, { recursive: true });
		await writeFile(
			join(handoffDir, "architecture.yaml"),
			"phase_id: architecture\nopen_questions: []\ncarry_forward: []\ncarry_forward_closures: []\nopen_question_closures: []\npost_pipeline: []\ndecisions: []\nproposed_conventions: []\ncloseout_summary: done\n",
			"utf8",
		);

		const state = await core.getWorkspaceState(cwd);
		const validation = await core.validatePhaseOutput(state, "architecture");
		assert.equal(validation.overall, "PASS", "precondition: output validates");

		// A concurrent session (or the executor) rewrites the output before
		// completion acquires the lock. The stale PASS must not complete it.
		await writeFile(outputPath, "garbage without a validation block", "utf8");

		await assert.rejects(
			() => completeValidatedPhase(cwd, validation, "test"),
			/no longer validates/,
		);

		const after = await core.getWorkspaceState(cwd);
		assert.equal(after.status.phases.architecture.status, "pending", "status must stay untouched after refusal");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("#132 completeValidatedPhase completes normally when the output is unchanged", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-132b-"));
	try {
		await initWorkspace(cwd);
		const outputPath = join(cwd, ".codecarto", "findings", "architecture", "architecture-map.md");
		await writeFile(
			outputPath,
			"# Architecture Map\n\n## Validation\n\n| Criterion | Result | Evidence |\n|---|---|---|\n| Intent documented | PASS | yes |\n\n**Overall:** PASS\n",
			"utf8",
		);
		const handoffDir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(handoffDir, { recursive: true });
		await writeFile(
			join(handoffDir, "architecture.yaml"),
			"phase_id: architecture\nopen_questions: []\ncarry_forward: []\ncarry_forward_closures: []\nopen_question_closures: []\npost_pipeline: []\ndecisions: []\nproposed_conventions: []\ncloseout_summary: done\n",
			"utf8",
		);

		const state = await core.getWorkspaceState(cwd);
		const validation = await core.validatePhaseOutput(state, "architecture");
		const result = await completeValidatedPhase(cwd, validation, "test");
		assert.equal(result.updatedState.status.phases.architecture.status, "complete");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
