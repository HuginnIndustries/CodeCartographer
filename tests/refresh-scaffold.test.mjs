// codecarto_refresh_scaffold (issue #102): the executable form of the action
// every scaffold-staleness notice instructs. Framework-owned files come back
// byte-identical to the packaged template; project state, user config, session
// outputs, and orchestrator files are never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit, handleRefreshScaffold } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

let WORKSPACE;
let CODECARTO;

test("setup: init and dirty the workspace", async () => {
	WORKSPACE = await mkdtemp(join(tmpdir(), "cc-refresh-"));
	await handleInit({ cwd: WORKSPACE, pipeline: "architecture-only" });
	CODECARTO = join(WORKSPACE, ".codecarto");

	// Framework-owned files: mutate one, delete one, delete the version marker
	// (the pre-#88 marker-less scaffold case).
	await writeFile(join(CODECARTO, "GUIDE.md"), "# Stale guide from an old release\n", "utf8");
	await unlink(join(CODECARTO, "templates", "phase-handoff.yaml"));
	await unlink(join(CODECARTO, "workflow", "scaffold-version.yaml"));

	// User-owned content that must survive byte-identically.
	await writeFile(join(CODECARTO, "CONVENTIONS.md"), "# Conventions\n\nC01: project-specific.\n", "utf8");
	await writeFile(join(CODECARTO, "BACKLOG.md"), "# Backlog\n\nP1: project deferral.\n", "utf8");
	await mkdir(join(CODECARTO, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(CODECARTO, "scratch", "handoffs", "note.txt"), "session scratch\n", "utf8");
	await writeFile(join(CODECARTO, "findings", "architecture", "architecture-map.md"), "# My findings\n", "utf8");
});

test("refresh restores framework-owned files byte-identically to the packaged template", async () => {
	const statusBefore = await readFile(join(CODECARTO, "workflow", "status.yaml"), "utf8");
	const result = await handleRefreshScaffold({ cwd: WORKSPACE });

	assert.equal(result.structuredContent.scaffoldVersionBefore, undefined, "marker was deleted, so before-version is unversioned");
	assert.equal(result.structuredContent.scaffoldVersionAfter, core.PACKAGE_VERSION);
	assert.ok(result.structuredContent.written.includes("GUIDE.md"));
	assert.ok(result.structuredContent.written.includes("templates/phase-handoff.yaml"));
	assert.ok(result.structuredContent.written.includes("workflow/scaffold-version.yaml"));

	const packagedGuide = await readFile(join(core.packagedWorkspaceDir, "GUIDE.md"), "utf8");
	assert.equal(await readFile(join(CODECARTO, "GUIDE.md"), "utf8"), packagedGuide, "GUIDE restored byte-identically");
	const packagedHandoff = await readFile(join(core.packagedWorkspaceDir, "templates", "phase-handoff.yaml"), "utf8");
	assert.equal(await readFile(join(CODECARTO, "templates", "phase-handoff.yaml"), "utf8"), packagedHandoff, "deleted template restored");
	const marker = await readFile(join(CODECARTO, "workflow", "scaffold-version.yaml"), "utf8");
	assert.ok(marker.includes(core.PACKAGE_VERSION), "marker restored at the running version");

	// Untouched surfaces.
	assert.equal(await readFile(join(CODECARTO, "workflow", "status.yaml"), "utf8"), statusBefore, "project state untouched");
	assert.match(await readFile(join(CODECARTO, "CONVENTIONS.md"), "utf8"), /project-specific/);
	assert.match(await readFile(join(CODECARTO, "BACKLOG.md"), "utf8"), /project deferral/);
	assert.match(await readFile(join(CODECARTO, "scratch", "handoffs", "note.txt"), "utf8"), /session scratch/);
	assert.match(await readFile(join(CODECARTO, "findings", "architecture", "architecture-map.md"), "utf8"), /My findings/);
	assert.ok(!result.structuredContent.written.some((path) => path.startsWith("scratch/") || path === "workflow/status.yaml" || path === "workflow/config.yaml" || path === "BACKLOG.md" || path === "THREAD_LOG.md" || path === "CONVENTIONS.md" || path === "DECISIONS.md"), "exclusions hold");

	const threadLog = await readFile(join(CODECARTO, "THREAD_LOG.md"), "utf8");
	assert.match(threadLog, /scaffold-refresh — Refreshed \d+ framework-owned file\(s\)/);
});

test("findings outputs beside restored SKILL stubs survive a second refresh", async () => {
	const result = await handleRefreshScaffold({ cwd: WORKSPACE });
	assert.match(await readFile(join(CODECARTO, "findings", "architecture", "architecture-map.md"), "utf8"), /My findings/);
	assert.ok(result.structuredContent.written.includes("findings/architecture/SKILL.md"), "framework SKILL stubs refresh");
});

test("refresh without a workspace fails loudly", async () => {
	const empty = await mkdtemp(join(tmpdir(), "cc-refresh-empty-"));
	await assert.rejects(() => handleRefreshScaffold({ cwd: empty }), /No CodeCartographer workspace/);
	await rm(empty, { recursive: true, force: true });
});

test("teardown: remove temp workspace", async () => {
	await rm(WORKSPACE, { recursive: true, force: true });
});
