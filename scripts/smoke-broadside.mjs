// Broad-Side smoke test: drives the MCP handler through a real submit →
// collect → synthesis cycle against a live target repository using the
// OpenRouter Batch API.
//
// This spends real money (~$0.03 for the default two lenses). It is therefore
// opt-in: it skips cleanly unless OPENROUTER_API_KEY is set and a target is
// passed on the command line.
//
//   OPENROUTER_API_KEY=sk-or-... node scripts/smoke-broadside.mjs /path/to/repo

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

if (!process.env.OPENROUTER_API_KEY) {
	console.log("SKIP: OPENROUTER_API_KEY not set — broadside smoke spends real money and is opt-in.");
	process.exit(0);
}
if (!target) {
	console.error("Usage: OPENROUTER_API_KEY=sk-or-... node scripts/smoke-broadside.mjs /path/to/repo");
	process.exit(1);
}

const { handleBroadside } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);

async function step(label, fn) {
	console.log(`\n== ${label} ==`);
	const result = await fn();
	console.log(result.content[0].text);
	return result;
}

const submit = await step("submit (architecture + api)", () =>
	handleBroadside({ cwd: target, action: "submit", lenses: ["architecture", "api"], api_key: process.env.OPENROUTER_API_KEY }),
);
assert.equal(submit.structuredContent.runId.length > 0, true, "submit must return a run id");

const status = await step("status", () => handleBroadside({ cwd: target, action: "status" }));
assert.match(status.content[0].text, /architecture/);

const collect = await step("collect (polls to completion, synthesizes)", () =>
	handleBroadside({ cwd: target, action: "collect", api_key: process.env.OPENROUTER_API_KEY }),
);
assert.equal(collect.structuredContent.status, "completed", "collect must reach completed");
assert.ok(collect.structuredContent.resultCount > 0, "collect must save at least one result");
assert.equal(collect.structuredContent.synthesis.status, "completed", "synthesis must complete");
assert.ok(collect.structuredContent.topFindings.length > 0, "synthesis must produce top findings");

console.log("\nSMOKE PASSED");
