import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildPiGuideMessage, GUIDE_PREAMBLE, PI_SURFACE_ADDENDUM, MCP_ONLY_TOOLS } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/guide-framing.ts`).href
);
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);

test("the guide document is embedded whole and unmodified", async () => {
	const { content } = await core.readGuide("overview");
	const message = buildPiGuideMessage(content, ["handoff-contract"]);
	assert.ok(message.includes(content), "the document must survive framing byte for byte");
});

test("the framing tells the model this is reference and not to start driving", () => {
	assert.match(GUIDE_PREAMBLE, /not a task/i);
	assert.match(GUIDE_PREAMBLE, /Do not start a workflow/);
	// The observed stall was the model asking which repo and which pipeline
	// instead of doing anything; the header names that behaviour directly.
	assert.match(GUIDE_PREAMBLE, /do not ask which repository or pipeline/i);
});

test("the addendum explains that Pi has no tools, so their absence is not a broken server", () => {
	assert.match(PI_SURFACE_ADDENDUM, /registers no tools/);
	assert.match(PI_SURFACE_ADDENDUM, /does not mean a server is missing/i);
});

test("the addendum corrects the drive loop rather than only renaming the tools", () => {
	assert.match(PI_SURFACE_ADDENDUM, /auto-validates and auto-completes/);
	assert.match(PI_SURFACE_ADDENDUM, /describes the MCP surface/);
	assert.match(PI_SURFACE_ADDENDUM, /no `cwd` argument/);
});

test("ordering: header, then document, then addendum, then the topic footer", () => {
	const message = buildPiGuideMessage("DOCUMENT-BODY", ["handoff-contract", "phase-recovery"]);
	const order = [
		message.indexOf("not a task"),
		message.indexOf("DOCUMENT-BODY"),
		message.indexOf("Reading this guide in a Pi session"),
		message.indexOf("Other guide topics:"),
	];
	assert.deepEqual(order, [...order].sort((a, b) => a - b), "framing must not interleave with the body");
	assert.ok(order.every((index) => index >= 0), "every section must be present");
});

test("a topic with no siblings gets no trailing topic footer", () => {
	const message = buildPiGuideMessage("BODY", []);
	assert.equal(message.includes("Other guide topics:"), false);
	assert.ok(message.endsWith(PI_SURFACE_ADDENDUM), "the addendum is the last section");
});

// The addendum claims two MCP tools have no Pi command. That claim rots the
// moment someone registers one of them, and a wrong claim here is worse than
// none: it tells a model a command does not exist when it does.
test("the MCP-only tool list matches the real gap between the surfaces", async () => {
	const [piSource, mcpSource] = await Promise.all([
		readFile(resolve(REPO_ROOT, "extensions/codecarto/index.ts"), "utf8"),
		readFile(resolve(REPO_ROOT, "mcp-server/server.ts"), "utf8"),
	]);
	const piCommands = new Set(
		[...piSource.matchAll(/registerCommand\("(codecarto-[a-z-]+)"/g)].map((m) => m[1].replace(/-/g, "_")),
	);
	const mcpTools = new Set([...mcpSource.matchAll(/"(codecarto_[a-z_]+)"/g)].map((m) => m[1]));
	const gap = [...mcpTools].filter((name) => !piCommands.has(name)).sort();

	assert.deepEqual(gap, [...MCP_ONLY_TOOLS].sort(), "update MCP_ONLY_TOOLS in guide-framing.ts");
	for (const name of MCP_ONLY_TOOLS) {
		assert.ok(PI_SURFACE_ADDENDUM.includes(name), `${name} must be named in the addendum`);
	}
});
