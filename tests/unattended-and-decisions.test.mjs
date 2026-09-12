// Two framework notes from the self-audit's dogfooding (#270 F1, #273 F4).
//
// F1: an autonomous host driving codecarto_next had nobody to answer the
//     reimplementation-spec phase's Strategic Alignment Hook and improvised.
//     MCP now takes `unattended`, the spelling of Pi's --auto.
// F4: the first D<NNN> row completion appended to DECISIONS.md landed right
//     after the section's paragraph, so renderers folded it into the prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

const REPORT = "# X\n\n## Validation\n\n| # | c | r | e |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n";

async function withWorkspace(pipeline, fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-unattended-"));
	try {
		await server.handleInit({ cwd, pipeline });
		await fn(cwd, join(cwd, ".codecarto"));
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

test("codecarto_phase with unattended: true carries the auto-default hook; without it, the interactive one", async () => {
	await withWorkspace("full", async (cwd) => {
		const interactive = await server.handlePhase({ cwd, phase: "reimplementation-spec" });
		assert.match(interactive.content[0].text, /Strategic Alignment Hook \(run BEFORE producing the spec\):/);
		assert.doesNotMatch(interactive.content[0].text, /selection: auto-default/);
		assert.equal(interactive.structuredContent.unattended, false);

		const unattended = await server.handlePhase({ cwd, phase: "reimplementation-spec", unattended: true });
		assert.match(unattended.content[0].text, /Strategic Alignment Hook \(auto run — DO NOT ask the user\):/);
		assert.match(unattended.content[0].text, /selection: auto-default/);
		assert.match(unattended.content[0].text, /Do NOT block on the user/);
		assert.equal(unattended.structuredContent.unattended, true);

		// Byte-identical to what Pi's --auto builds.
		const state = await core.getWorkspaceState(cwd);
		const phase = core.resolvePhase(state, "reimplementation-spec");
		assert.equal(unattended.content[0].text, await core.buildPhasePrompt(state, phase, true, { auto: true }));
	});
});

test("codecarto_next takes unattended too, and only a boolean true counts", async () => {
	await withWorkspace("lite", async (cwd) => {
		const plain = await server.handleNext({ cwd });
		assert.equal(plain.structuredContent.unattended, false);
		assert.doesNotMatch(plain.content[0].text, /auto run/);
		const flagged = await server.handleNext({ cwd, unattended: true });
		assert.equal(flagged.structuredContent.unattended, true);
		// The lite pipeline's first phase has no interactive hook, so the two
		// prompts differ only in what the flag reports; both are what core builds.
		const state = await core.getWorkspaceState(cwd);
		const phase = core.getNextEligiblePhase(state);
		assert.equal(flagged.content[0].text, await core.buildPhasePrompt(state, phase, false, { auto: true }));
		const stringy = await server.handleNext({ cwd, unattended: "yes" });
		assert.equal(stringy.structuredContent.unattended, false, "a string is not consent to run unattended");
	});
});

test("the first decision row appended to DECISIONS.md is separated from the paragraph above it", async () => {
	await withWorkspace("architecture-only", async (cwd, codecarto) => {
		await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), REPORT, "utf8");
		await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), [
			"phase_id: architecture",
			"closeout_summary: done",
			"decisions:",
			"  - Keep the hand-rolled YAML parser.",
			"  - Treat the dashboard as derived state.",
			"",
		].join("\n"), "utf8");
		await server.handleComplete({ cwd });
		const decisions = await readFile(join(codecarto, "DECISIONS.md"), "utf8");
		// The template carries a commented example row; look only at the log.
		// The template mentions the heading inside prose and a comment; the
		// section itself starts the line.
		const heading = decisions.search(/^## Completion log$/m);
		assert.ok(heading >= 0, decisions);
		const lines = decisions.slice(heading).split("\n");
		const first = lines.findIndex((line) => /^D001 \|/.test(line));
		assert.ok(first > 0, decisions);
		assert.equal(lines[first - 1], "", "a blank line precedes the first row");
		assert.match(lines[first - 2], /\S/, "and the paragraph above is still there");
		assert.match(lines[first + 1], /^D002 \|/, "consecutive rows stay contiguous");
		assert.equal(lines.filter((line) => /^D00[12] \|/.test(line)).length, 2, "exactly the two decisions, once each");
	});
});
