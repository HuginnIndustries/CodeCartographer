import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildPhaseContinuationPrompt, needsPhaseContinuation, primaryOutputExists, shouldContinuePhase, waitForCompaction } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/agent-runner.ts`).href
);

test("needsPhaseContinuation detects a phase interrupted after tool results", () => {
	assert.equal(needsPhaseContinuation([]), false);
	assert.equal(needsPhaseContinuation([{ role: "assistant", content: [{ type: "text", text: "done" }] }]), false);
	assert.equal(needsPhaseContinuation([{ role: "toolResult", content: [{ type: "text", text: "result" }] }]), true);
	assert.equal(
		needsPhaseContinuation([{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }]),
		true,
	);
});

test("shouldContinuePhase treats a missing declared output as incomplete even after a normal stop", () => {
	const finalMessage = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I will write it next." }] }];
	assert.equal(shouldContinuePhase(finalMessage, false), true);
	assert.equal(shouldContinuePhase(finalMessage, true), false);
});

test("primaryOutputExists rejects traversal and symlink escapes from .codecarto", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "codecarto-primary-output-"));
	try {
		await mkdir(resolve(root, ".codecarto", "findings"), { recursive: true });
		await writeFile(resolve(root, ".codecarto", "findings", "output.md"), "safe");
		await writeFile(resolve(root, "outside.md"), "outside");
		await symlink(resolve(root, "outside.md"), resolve(root, ".codecarto", "link.md"));

		assert.equal(await primaryOutputExists(root, "findings/output.md"), true);
		assert.equal(await primaryOutputExists(root, "../outside.md"), false);
		assert.equal(await primaryOutputExists(root, "link.md"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("buildPhaseContinuationPrompt distinguishes compacted recovery from provider interruption", () => {
	assert.match(buildPhaseContinuationPrompt(true), /compacted context and durable checkpoint/i);
	assert.match(buildPhaseContinuationPrompt(false), /stopped before finalizing/i);
	for (const compacted of [true, false]) {
		assert.match(buildPhaseContinuationPrompt(compacted), /primary output/i);
		assert.match(buildPhaseContinuationPrompt(compacted), /validation block/i);
	}
});

test("waitForCompaction handles completion and bounded timeout", async () => {
	assert.equal(await waitForCompaction(Promise.resolve(true), 20), true);
	assert.equal(await waitForCompaction(new Promise(() => {}), 1), false);
});
