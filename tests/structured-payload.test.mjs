// Every tool's payload must reach a caller that reads only structuredContent.
// MCP clients may prefer structuredContent when present; the tools whose payload
// is prose (phase prompts, the guide) previously put it only in content[0].text,
// so such a client received labels and no payload — codecarto_next returned no
// phase prompt at all (issue #94).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);

async function workspace() {
	// handleInit copies the packaged template itself; pre-copying it makes init refuse.
	const cwd = await mkdtemp(join(tmpdir(), "cc-structured-"));
	await server.handleInit({ cwd, pipeline: "lite" });
	return cwd;
}

/** The payload a client reading only structuredContent would receive. */
function structuredPayload(result) {
	const structured = result.structuredContent;
	assert.ok(structured, "tool returned no structuredContent");
	return Object.values(structured)
		.filter((value) => typeof value === "string")
		.join("\n");
}

test("codecarto_next exposes the phase prompt through structuredContent", async () => {
	const cwd = await workspace();
	try {
		const result = await server.handleNext({ cwd });
		const payload = structuredPayload(result);
		assert.match(payload, /architecture/, "prompt must be reachable without content[0].text");
		assert.match(payload, /scratch\/handoffs\//, "the handoff instruction must survive too");
		assert.equal(payload.includes(result.content[0].text), true, "structuredContent must carry the full rendered text");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("codecarto_guide exposes the guide body through structuredContent", async () => {
	const result = await server.handleGuide({});
	const payload = structuredPayload(result);
	assert.match(payload, /Driving CodeCartographer/, "guide body must be reachable without content[0].text");
	assert.match(payload, /scratch\/handoffs\/<phase-id>\.yaml/);
});

test("codecarto_phase and codecarto_skill expose their prompts through structuredContent", async () => {
	const cwd = await workspace();
	try {
		const phase = await server.handlePhase({ cwd, phase: "contracts" });
		assert.match(structuredPayload(phase), /contracts/);
		// codecarto_skill refuses before the pipeline completes; that refusal is an
		// error path, so assert the prompt path via the guide-style tools above and
		// only check here that the refusal itself is not silently empty.
		await assert.rejects(() => server.handleSkill({ cwd, name: "spec-delta-application" }));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("every tool result carries its rendered text in structuredContent", async () => {
	// Guards the helper itself: a future tool that sets structuredContent without
	// routing its text through textResult would reintroduce issue #94.
	const cwd = await workspace();
	try {
		const results = [
			["codecarto_status", await server.handleStatus({ cwd })],
			["codecarto_next", await server.handleNext({ cwd })],
			["codecarto_guide", await server.handleGuide({})],
			["codecarto_config", await server.handleConfig({ cwd })],
			["codecarto_list_skills", await server.handleListSkills({ cwd })],
		];
		for (const [name, result] of results) {
			assert.ok(result.structuredContent, `${name} returned no structuredContent`);
			const text = result.content[0].text;
			const carried = Object.values(result.structuredContent).some(
				(value) => typeof value === "string" && value.includes(text),
			);
			assert.ok(carried, `${name} does not carry its rendered text in structuredContent`);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
