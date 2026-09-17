import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const module = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/phase-compaction.ts`).href);
const { phaseIdFromSessionName, buildPhaseCompactionInstructions, writePhaseCheckpoint, phaseCompactionExtension } = module;

test("phaseIdFromSessionName limits custom compaction to isolated phase sessions", () => {
	assert.equal(phaseIdFromSessionName("CodeCartographer phase: contracts"), "contracts");
	assert.equal(phaseIdFromSessionName("CodeCartographer: contracts"), null);
	assert.equal(phaseIdFromSessionName(undefined), null);
});

test("phase-aware instructions preserve evidence, output progress, and validation gaps", () => {
	const text = buildPhaseCompactionInstructions("contracts", "findings/contracts/behavioral-contracts.md").toLowerCase();
	for (const phrase of ["contracts", "behavioral-contracts.md", "evidence", "files inspected", "open questions", "validation criteria"]) {
		assert.match(text, new RegExp(phrase.replaceAll(".", "\\.")));
	}
});

test("writePhaseCheckpoint atomically persists a resumable phase summary", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "codecarto-checkpoint-"));
	try {
		const path = await writePhaseCheckpoint(cwd, "contracts", "summary body", 12345);
		assert.equal(path, join(cwd, ".codecarto", "scratch", "checkpoints", "contracts.md"));
		const text = await readFile(path, "utf8");
		assert.match(text, /phase: contracts/);
		assert.match(text, /tokens_before: 12345/);
		assert.match(text, /summary body/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("phaseCompactionExtension can be installed into isolated child sessions", async () => {
	const handlers = new Map();
	phaseCompactionExtension({ on: (event, handler) => handlers.set(event, handler) });
	assert.equal(typeof handlers.get("session_before_compact"), "function");
	assert.equal(typeof handlers.get("session_compact"), "function");
	assert.equal(typeof handlers.get("tool_call"), "function");

	const cwd = await mkdtemp(join(tmpdir(), "codecarto-child-checkpoint-"));
	try {
		const ctx = { cwd, sessionManager: { getSessionName: () => "CodeCartographer phase: contracts" } };
		assert.deepEqual(await handlers.get("tool_call")({ toolName: "bash", input: {} }, ctx), {
			block: true,
			reason: "CodeCartographer phase sessions disable bash to keep source analysis read-only.",
		});
		assert.match(
			(await handlers.get("tool_call")({ toolName: "write", input: { path: "src/source.ts" } }, ctx)).reason,
			/only allow write within \.codecarto\//,
		);
		assert.equal(
			await handlers.get("tool_call")({ toolName: "write", input: { path: ".codecarto/findings/contracts/out.md" } }, ctx),
			undefined,
		);
		// Narrower than the orchestrator's hook on purpose (#364): a phase
		// never publishes, so a configured library is not a write root here.
		await mkdir(join(cwd, "library"), { recursive: true });
		await writeFile(join(cwd, "library", ".codecarto-library"), JSON.stringify({ schema_version: 1, name: "library", namespaced: false }), "utf8");
		await mkdir(join(cwd, ".codecarto", "workflow"), { recursive: true });
		await writeFile(join(cwd, ".codecarto", "workflow", "config.yaml"), `library:\n  path: ${join(cwd, "library")}\n`, "utf8");
		assert.match(
			(await handlers.get("tool_call")({ toolName: "write", input: { path: "library/entries/spec.md" } }, ctx)).reason,
			/only allow write within \.codecarto\//,
		);
		await handlers.get("session_compact")(
			{ compactionEntry: { summary: "child summary", tokensBefore: 456 } },
			ctx,
		);
		const text = await readFile(join(cwd, ".codecarto", "scratch", "checkpoints", "contracts.md"), "utf8");
		assert.match(text, /child summary/);
		assert.match(text, /tokens_before: 456/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a phase's first write into .codecarto/ is allowed when the workspace is reached through a symlink (#394)", async () => {
	const handlers = new Map();
	phaseCompactionExtension({ on: (event, handler) => handlers.set(event, handler) });

	// An ancestor of the cwd is a symlink, which realpath expands and a lexical
	// resolve does not -- the POSIX shape of the 8.3 short name the Windows
	// runner puts in %TEMP% (C:\Users\RUNNER~1\...). The guard resolved the
	// target's existing prefix but fell back to the spelled root when
	// .codecarto/ did not exist yet, so the two shared no prefix and the phase
	// was refused the one directory it is allowed to write.
	const base = await realpath(await mkdtemp(join(tmpdir(), "codecarto-symlinked-cwd-")));
	try {
		await mkdir(join(base, "real", "repo"), { recursive: true });
		await mkdir(join(base, "outside"), { recursive: true });
		await symlink(join(base, "real"), join(base, "link"));
		const cwd = join(base, "link", "repo");
		const ctx = { cwd, sessionManager: { getSessionName: () => "CodeCartographer phase: contracts" } };

		assert.equal(
			await handlers.get("tool_call")({ toolName: "write", input: { path: ".codecarto/findings/contracts/out.md" } }, ctx),
			undefined,
			"a findings write is inside the workspace whether or not .codecarto/ exists yet",
		);

		// Containment still holds through the same symlinked cwd.
		assert.match(
			(await handlers.get("tool_call")({ toolName: "write", input: { path: "src/source.ts" } }, ctx)).reason,
			/only allow write within \.codecarto\//,
		);
		await symlink(join(base, "outside"), join(cwd, "escape"));
		assert.match(
			(await handlers.get("tool_call")({ toolName: "write", input: { path: ".codecarto/../escape/leak.md" } }, ctx)).reason,
			/only allow write within \.codecarto\//,
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
