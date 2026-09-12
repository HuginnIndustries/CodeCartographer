// A phase complete in status.yaml whose report is not on disk is named by
// status on both surfaces (self-audit #259, D-M16).
//
// status.yaml is committed and findings are gitignored by default, so a fresh
// clone says "complete" about reports it does not have. The policy stays; the
// divergence is no longer silent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);

const REPORT = "# Map\n\n## Validation\n\n| # | Criterion | Result | Evidence |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n";
const LINE = /^Outputs missing on disk for 1 complete phase\(s\) — findings are gitignored by default, so a clone carries the status but not the reports; re-run the phase here, or commit findings \(see README, "What to commit"\):$/m;

async function completedThenCloned(cwd) {
	const codecarto = join(cwd, ".codecarto");
	if (!(await core.pathExists(join(codecarto, "workflow", "status.yaml")))) await server.handleInit({ cwd, pipeline: "lite" });
	const report = join(codecarto, "findings", "architecture", "architecture-map.md");
	await writeFile(report, REPORT, "utf8");
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), "phase_id: architecture\ncloseout_summary: done\n", "utf8");
	await server.handleComplete({ cwd });
	// What a fresh clone looks like: the status travelled, the report did not.
	await unlink(report);
	return codecarto;
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
	const ui = {
		widgets: [],
		notifications: [],
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async () => true,
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, ctx, ui };
}

test("listMissingCompletedOutputs names complete phases whose report is gone, and nothing else", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-missing-"));
	try {
		await server.handleInit({ cwd, pipeline: "lite" });
		assert.deepEqual(await core.listMissingCompletedOutputs(await core.getWorkspaceState(cwd)), [], "pending phases with no report are fine");
		await completedThenCloned(cwd);
		assert.deepEqual(await core.listMissingCompletedOutputs(await core.getWorkspaceState(cwd)), [
			{ phaseId: "architecture", path: "findings/architecture/architecture-map.md" },
		]);
		assert.deepEqual(core.describeMissingCompletedOutputs([]), []);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("codecarto_status names the phase and the path, and stays quiet when the report is there", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-missing-"));
	try {
		const codecarto = await completedThenCloned(cwd);
		const result = await server.handleStatus({ cwd });
		assert.match(result.content[0].text, /^Progress: 1\/3 complete$/m, "status.yaml still says complete");
		assert.match(result.content[0].text, LINE);
		assert.match(result.content[0].text, /^  - architecture: \.codecarto\/findings\/architecture\/architecture-map\.md$/m);
		assert.deepEqual(result.structuredContent.missingOutputs, [{ phaseId: "architecture", path: "findings/architecture/architecture-map.md" }]);

		await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), REPORT, "utf8");
		const again = await server.handleStatus({ cwd });
		assert.doesNotMatch(again.content[0].text, /Outputs missing on disk/);
		assert.equal(again.structuredContent.missingOutputs, undefined);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("/codecarto-status shows the same lines and warns instead of the usual info notice", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-missing-"));
	try {
		await completedThenCloned(cwd);
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-open").handler("", ctx);
		await commands.get("codecarto-status").handler("", ctx);
		const widget = ui.widgets.at(-1).value.join("\n");
		assert.match(widget, LINE);
		assert.match(widget, /^  - architecture: \.codecarto\/findings\/architecture\/architecture-map\.md$/m);
		assert.equal(ui.notifications.at(-1).level, "warning");
		assert.match(ui.notifications.at(-1).message, /^CodeCartographer phase: contracts\. Outputs missing on disk for 1 complete phase\(s\)/);
		const mcp = await server.handleStatus({ cwd });
		const mcpLines = mcp.content[0].text.split("\n").filter((line) => line.startsWith("Outputs missing") || line.startsWith("  - architecture"));
		const piLines = widget.split("\n").filter((line) => line.startsWith("Outputs missing") || line.startsWith("  - architecture"));
		assert.deepEqual(piLines, mcpLines);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
