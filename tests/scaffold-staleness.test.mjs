// Stale-scaffold detection (issue #85): a workspace copied from an old
// .codecarto/ template must be told so, instead of silently running a
// framework whose contract its GUIDE contradicts. Warn, never fail —
// unversioned workspaces keep working.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(join(REPO_ROOT, "core/index.ts")).href);

const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));

async function initWorkspace(cwd) {
	await cp(join(REPO_ROOT, ".codecarto"), join(cwd, ".codecarto"), { recursive: true });
}

const markerPath = (cwd) => join(cwd, ".codecarto", "workflow", "scaffold-version.yaml");

test("fresh template copy carries the current scaffold version and no staleness notice", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-scaffold-"));
	try {
		await initWorkspace(cwd);
		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.scaffoldVersion, pkg.version);
		assert.equal(core.describeScaffoldStaleness(state), null);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("missing marker reads as a pre-marker scaffold and names the handoff contract", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-scaffold-"));
	try {
		await initWorkspace(cwd);
		await unlink(markerPath(cwd));
		const state = await core.getWorkspaceState(cwd);
		assert.equal(state.scaffoldVersion, undefined);
		const notice = core.describeScaffoldStaleness(state);
		assert.match(notice, /scaffold-version\.yaml marker/);
		assert.match(notice, /handoff contract/);
		assert.match(notice, /Refresh/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("older scaffold version produces a refresh notice; newer produces an upgrade notice", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-scaffold-"));
	try {
		await initWorkspace(cwd);
		await writeFile(markerPath(cwd), "scaffold_version: 0.11.0\n", "utf8");
		let state = await core.getWorkspaceState(cwd);
		assert.equal(state.scaffoldVersion, "0.11.0");
		assert.match(core.describeScaffoldStaleness(state), /older than the running framework .*Refresh/);

		await writeFile(markerPath(cwd), "scaffold_version: 99.0.0\n", "utf8");
		state = await core.getWorkspaceState(cwd);
		assert.match(core.describeScaffoldStaleness(state), /newer than the running framework .*Upgrade/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("phase prompt lists the handoff template read on a fresh scaffold, with no warnings", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-scaffold-"));
	try {
		await initWorkspace(cwd);
		const state = await core.getWorkspaceState(cwd);
		const phase = core.getNextEligiblePhase(state);
		const prompt = await core.buildPhasePrompt(state, phase);
		assert.ok(prompt.includes("- .codecarto/templates/phase-handoff.yaml"));
		assert.ok(!prompt.includes("WARNING:"), "fresh scaffold must not carry scaffold warnings");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("phase prompt on a pre-handoff scaffold warns instead of listing a missing read", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-scaffold-"));
	try {
		await initWorkspace(cwd);
		await unlink(join(cwd, ".codecarto", "templates", "phase-handoff.yaml"));
		await unlink(markerPath(cwd));
		const state = await core.getWorkspaceState(cwd);
		const phase = core.getNextEligiblePhase(state);
		const prompt = await core.buildPhasePrompt(state, phase);
		assert.ok(!prompt.includes("- .codecarto/templates/phase-handoff.yaml"), "must not instruct reading a file that does not exist");
		assert.match(prompt, /WARNING: \.codecarto\/templates\/phase-handoff\.yaml is missing/);
		assert.match(prompt, new RegExp(`scratch/handoffs/${phase.id}\\.yaml`), "warning must name the handoff path completion will require");
		assert.match(prompt, /WARNING: This workspace's \.codecarto\/ scaffold has no workflow\/scaffold-version\.yaml marker/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("MCP codecarto_status surfaces the staleness notice", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-scaffold-"));
	try {
		await initWorkspace(cwd);
		await unlink(markerPath(cwd));
		const { handleStatus } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
		const result = await handleStatus({ cwd });
		const text = result.content[0].text;
		assert.match(text, /Scaffold: This workspace's \.codecarto\/ scaffold has no workflow\/scaffold-version\.yaml marker/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("MCP codecarto_status stays quiet on a current scaffold", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-scaffold-"));
	try {
		await initWorkspace(cwd);
		const { handleStatus } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
		const result = await handleStatus({ cwd });
		assert.ok(!result.content[0].text.includes("Scaffold:"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
