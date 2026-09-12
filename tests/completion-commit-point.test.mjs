// status.yaml is the commit point (#234). Closeouts, THREAD_LOG lines, and
// decision rows assert that a phase is complete, so they are written only
// after the status rename has landed: a failed commit leaves none of them
// behind, and a failure after the commit is reported but re-running the
// operation regenerates the artifacts idempotently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { getWorkspaceState, updateStatusAtomically } = await import(pathToFileURL(`${REPO_ROOT}/core/workspace.ts`).href);
const { completeValidatedPhase } = await import(pathToFileURL(`${REPO_ROOT}/core/completion.ts`).href);
const { applyAmendment } = await import(pathToFileURL(`${REPO_ROOT}/core/amendment.ts`).href);
const { validatePhaseOutput } = await import(pathToFileURL(`${REPO_ROOT}/core/pipeline.ts`).href);
const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

// chmod-based failure injection needs a user the kernel will refuse.
const canRestrict = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

const PASSING_OUTPUT = [
	"# Architecture Map",
	"",
	"Body.",
	"",
	"## Validation",
	"",
	"| # | Criterion | Result | Evidence |",
	"|---|-----------|--------|----------|",
	"| 1 | The system intent is documented. | PASS | §above |",
	"",
	"**Validated by:** test",
	"**Overall:** PASS",
	"",
].join("\n");

const HANDOFF = [
	"schema_version: 1",
	"phase_id: architecture",
	"open_questions:",
	"  - id: arch-OQ1",
	"    kind: needs-maintainer-decision",
	"    description: Which default to keep.",
	"    deferred_reason: Product call.",
	"decisions:",
	"  - Record the commit point before any artifact.",
	"closeout_summary: Architecture mapped.",
	"",
].join("\n");

async function completableWorkspace() {
	const cwd = await mkdtemp(join(tmpdir(), "cc-commit-point-"));
	await handleInit({ cwd, pipeline: "architecture-only" });
	const codecarto = join(cwd, ".codecarto");
	await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), PASSING_OUTPUT, "utf8");
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), HANDOFF, "utf8");
	return { cwd, codecarto, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

async function architectureCloseouts(codecarto) {
	return (await readdir(join(codecarto, "closeouts"))).filter((name) => name.endsWith("-architecture.md"));
}

function countLines(text, needle) {
	return text.split(/\r?\n/).filter((line) => line.includes(needle)).length;
}

test("afterCommit runs after status.yaml holds the new state", async () => {
	const { cwd, codecarto, cleanup } = await completableWorkspace();
	try {
		const order = [];
		const marker = "2031-01-01T00:00:00.000Z";
		await updateStatusAtomically(cwd, (state) => {
			order.push("updater");
			return {
				state: { ...state, status: { ...state.status, last_updated: marker } },
				afterCommit: async (committed) => {
					order.push("afterCommit");
					assert.equal(committed.status.last_updated, marker);
					const onDisk = await readFile(join(codecarto, "workflow", "status.yaml"), "utf8");
					assert.ok(onDisk.includes(marker), "the commit precedes the hook");
				},
			};
		});
		assert.deepEqual(order, ["updater", "afterCommit"]);
	} finally {
		await cleanup();
	}
});

test("a commit that cannot land runs no afterCommit and leaves status untouched", { skip: !canRestrict && "needs a non-root POSIX user" }, async () => {
	const { cwd, codecarto, cleanup } = await completableWorkspace();
	const workflowDir = join(codecarto, "workflow");
	const statusPath = join(workflowDir, "status.yaml");
	const before = await readFile(statusPath, "utf8");
	let hookRan = false;
	try {
		await assert.rejects(
			updateStatusAtomically(cwd, async (state) => {
				// The lock already exists; now the temp file for the rename cannot.
				await chmod(workflowDir, 0o555);
				return {
					state: { ...state, status: { ...state.status, last_updated: "2031-01-01T00:00:00.000Z" } },
					afterCommit: () => {
						hookRan = true;
					},
				};
			}),
			/EACCES|EPERM/,
		);
		assert.equal(hookRan, false, "nothing that asserts completion may run when the commit failed");
		assert.equal(await readFile(statusPath, "utf8"), before, "status.yaml is untouched");
	} finally {
		await chmod(workflowDir, 0o755);
		await rm(`${statusPath}.lock`, { force: true });
		await cleanup();
	}
});

test("completion: a failed artifact write after the commit is reported, the phase stays complete, and re-running regenerates the artifacts once", { skip: !canRestrict && "needs a non-root POSIX user" }, async () => {
	const { cwd, codecarto, cleanup } = await completableWorkspace();
	const closeoutsDir = join(codecarto, "closeouts");
	try {
		const validation = await validatePhaseOutput(await getWorkspaceState(cwd), "architecture");
		assert.equal(validation.overall, "PASS");
		// The seeded files may carry commented examples; count relative to them.
		const threadLogPath = join(codecarto, "THREAD_LOG.md");
		const decisionsPath = join(codecarto, "DECISIONS.md");
		const logLinesBefore = countLines(await readFile(threadLogPath, "utf8"), "-architecture.md)");
		const decisionRowsBefore = countLines(await readFile(decisionsPath, "utf8"), "Record the commit point");

		await chmod(closeoutsDir, 0o555);
		await assert.rejects(
			completeValidatedPhase(cwd, validation, "test"),
			/status\.yaml was updated, but a step that runs after the update failed: .*EACCES/,
		);
		const state = await getWorkspaceState(cwd);
		assert.equal(state.status.phases.architecture.status, "complete", "the commit point landed");
		assert.deepEqual(await architectureCloseouts(codecarto), [], "no closeout for the failed artifact step");
		assert.equal(countLines(await readFile(threadLogPath, "utf8"), "-architecture.md)"), logLinesBefore, "no index line");
		assert.equal(countLines(await readFile(decisionsPath, "utf8"), "Record the commit point"), decisionRowsBefore, "no decision row");

		await chmod(closeoutsDir, 0o755);
		const second = await completeValidatedPhase(cwd, validation, "test");
		assert.match(second.closeoutNotice, /closeouts\/\d{4}-\d{2}-\d{2}-architecture\.md/);
		await completeValidatedPhase(cwd, validation, "test");
		assert.equal((await architectureCloseouts(codecarto)).length, 1, "one closeout after two successful re-runs");
		assert.equal(countLines(await readFile(threadLogPath, "utf8"), "-architecture.md)"), logLinesBefore + 1, "one index line");
		assert.equal(countLines(await readFile(decisionsPath, "utf8"), "Record the commit point"), decisionRowsBefore + 1, "one decision row");
		assert.equal((await getWorkspaceState(cwd)).status.phases.architecture.status, "complete");
	} finally {
		await chmod(closeoutsDir, 0o755).catch(() => undefined);
		await cleanup();
	}
});

test("amendment: the closure is committed before its closeout and index line", { skip: !canRestrict && "needs a non-root POSIX user" }, async () => {
	const { cwd, codecarto, cleanup } = await completableWorkspace();
	const closeoutsDir = join(codecarto, "closeouts");
	try {
		const validation = await validatePhaseOutput(await getWorkspaceState(cwd), "architecture");
		await completeValidatedPhase(cwd, validation, "test");
		await mkdir(join(codecarto, "scratch", "amendments"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "amendments", "close-q.yaml"), [
			"schema_version: 1",
			"open_question_closures:",
			"  - arch-OQ1",
			"post_pipeline_closures: []",
			"notes: []",
			"closeout_summary: Question settled.",
			"",
		].join("\n"), "utf8");

		await chmod(closeoutsDir, 0o555);
		await assert.rejects(applyAmendment(cwd, "close-q"), /status\.yaml was updated, but a step that runs after the update failed/);
		const state = await getWorkspaceState(cwd);
		assert.ok(!state.status.phases.architecture.open_questions.some((q) => q.id === "arch-OQ1"), "the closure landed");
		assert.ok(!(await readdir(closeoutsDir)).some((name) => name.includes("amendment-close-q")), "no amendment closeout yet");

		await chmod(closeoutsDir, 0o755);
		const rerun = await applyAmendment(cwd, "close-q");
		assert.match(rerun.closeoutNotice, /amendment-close-q\.md/);
		assert.deepEqual(rerun.applied.unknownIds, ["arch-OQ1"], "already closed on the first, committed run");
		assert.equal((await readdir(closeoutsDir)).filter((name) => name.includes("amendment-close-q")).length, 1);
		assert.equal(countLines(await readFile(join(codecarto, "THREAD_LOG.md"), "utf8"), "amendment-close-q.md)"), 1);
	} finally {
		await chmod(closeoutsDir, 0o755).catch(() => undefined);
		await cleanup();
	}
});
