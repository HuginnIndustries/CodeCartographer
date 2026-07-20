import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const module = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/phase-compaction.ts`).href);
const { phaseIdFromSessionName, buildPhaseCompactionInstructions, writePhaseCheckpoint } = module;

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
