// Unit tests for buildSteeringMessage — the markdown emitted into the
// orchestrator's session when --llm-steer produces a customized seed.
// Pure formatting; the rewriter session itself is not exercised here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildSteeringMessage } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/agent-rewriter.ts`).href);

test("steering message names the next phase + previous phase in the header", () => {
	const out = buildSteeringMessage({
		nextPhaseId: "contracts",
		prevPhaseId: "architecture",
		rewrittenPrompt: "Run the contracts phase. Pay attention to dashboard auth.",
	});
	assert.match(out, /\*\*Steering: `contracts` seed prompt\*\*/);
	assert.match(out, /from `architecture`'s closeout/);
});

test("steering message embeds the full rewritten prompt verbatim below the divider", () => {
	const longPrompt = "Customized phase prompt with 3 bullet points:\n- one\n- two\n- three";
	const out = buildSteeringMessage({
		nextPhaseId: "protocols",
		prevPhaseId: "contracts",
		rewrittenPrompt: longPrompt,
	});
	assert.ok(out.endsWith(longPrompt), "rewritten prompt must appear verbatim at the end");
	assert.match(out, /^---$/m);
});

test("steering message falls back to a generic provenance when prevPhaseId is missing", () => {
	const out = buildSteeringMessage({
		nextPhaseId: "contracts",
		rewrittenPrompt: "stub",
	});
	assert.match(out, /customized by the orchestrator's LLM\./);
	assert.doesNotMatch(out, /from ``'s closeout/);
});

test("steering message uses display-friendly italics + horizontal rule between header and body", () => {
	const out = buildSteeringMessage({
		nextPhaseId: "contracts",
		prevPhaseId: "architecture",
		rewrittenPrompt: "body",
	});
	const lines = out.split("\n");
	assert.equal(lines[0], "**Steering: `contracts` seed prompt**");
	assert.match(lines[2], /^_/);
	assert.match(lines[2], /_$/);
	assert.equal(lines[4], "---");
});
