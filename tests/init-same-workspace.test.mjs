// Init on the packaged template itself (self-audit #245, D-M17).
//
// A checkout's `.codecarto/` is the template init copies from and a live
// workspace at once. Init used to special-case that (`sameWorkspace`): it
// skipped the existing-workspace refusal and the backup an ordinary force
// takes, and reset status.yaml in place. Now that case is an existing
// workspace like any other — refuse without force, ask on Pi — and a forced
// re-init moves the session state out file by file (the directory cannot be
// renamed away, it is what init copies from) via backupWorkspaceState.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

async function withTemp(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-init-same-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

async function listFiles(dir, prefix = "") {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out.sort();
}

/** A workspace that is a real copy of the template plus one of every kind of session state. */
async function workspaceWithState(dir) {
	const cwd = join(dir, "repo");
	await mkdir(cwd, { recursive: true });
	await server.handleInit({ cwd, pipeline: "lite" });
	const workspaceDir = join(cwd, ".codecarto");
	const state = {
		"workflow/status.yaml": null, // written by init; kept as-is
		"workflow/.usage.local.yaml": "runs: []\n",
		"workflow/.orchestrator.local.yaml": "session: /x\n",
		"workflow/status.yaml.lock": "1\n",
		"findings/architecture/architecture-map.md": "# map\n",
		"findings/public-surfaces/public-surfaces.md": "# secondary output\n",
		"scratch/handoffs/architecture.yaml": "phase_id: architecture\n",
		"scratch/checkpoints/architecture.md": "# ckpt\n",
		"closeouts/2026-09-12-architecture.md": "# closeout\n",
		"dashboard.html": "<html></html>",
		".dashboard-narration.local.md": "narration\n",
		"broadside/state.json": "{}\n",
		"broadside/2026-09-12T00-00-00Z/results.json": "[]\n",
	};
	for (const [rel, content] of Object.entries(state)) {
		if (content === null) continue;
		await mkdir(dirname(join(workspaceDir, rel)), { recursive: true });
		await writeFile(join(workspaceDir, rel), content, "utf8");
	}
	// The orchestrator files are seeded by init and then edited by sessions.
	await writeFile(join(workspaceDir, "THREAD_LOG.md"), "- 2026-09-12 — architecture — done\n", "utf8");
	return { cwd, workspaceDir, statePaths: Object.keys(state).sort() };
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = {
		on: () => {},
		registerCommand: (name, command) => commands.set(name, command),
		setActiveTools: () => {},
		setSessionName: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	const ui = {
		widgets: [],
		notifications: [],
		confirmations: [],
		answer: false,
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => {
			ui.confirmations.push({ title, body });
			return ui.answer;
		},
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, pi, ctx, ui };
}

// ---------- core: what a forced re-init of the template moves ----------

test("backupWorkspaceState moves every session-written file and leaves the framework's in place", async () => {
	await withTemp(async (dir) => {
		const { cwd, workspaceDir, statePaths } = await workspaceWithState(dir);
		const before = await listFiles(workspaceDir);
		const backupDir = join(cwd, ".codecarto-backup-test");

		const moved = await core.backupWorkspaceState(workspaceDir, backupDir);

		const expected = [...statePaths, "BACKLOG.md", "CONVENTIONS.md", "DECISIONS.md", "THREAD_LOG.md"].sort();
		assert.deepEqual(moved, expected, "exactly the session state moved, sorted");
		assert.deepEqual(await listFiles(backupDir), expected, "the backup holds each at its relative path");

		const after = await listFiles(workspaceDir);
		assert.deepEqual(after, before.filter((path) => !expected.includes(path)), "nothing else moved");
		for (const kept of ["GUIDE.md", ".gitignore", "workflow/config.yaml", "workflow/pipeline-lite.yaml", "workflow/VALIDATE.md", "templates/architecture-map.md", "findings/architecture/SKILL.md", "broadside/SKILL.md", "broadside/config.yaml", "scratch/.gitkeep"]) {
			assert.ok(after.includes(kept), `${kept} is framework-owned and must stay`);
		}
		// Directories keep the workspace's shape even when emptied.
		for (const shape of ["closeouts", "scratch/handoffs", "findings/architecture", "broadside"]) {
			assert.ok((await readdir(join(workspaceDir, shape))) !== undefined, `${shape}/ still exists`);
		}
		assert.equal(await readFile(join(backupDir, "THREAD_LOG.md"), "utf8"), "- 2026-09-12 — architecture — done\n", "content travels intact");
	});
});

test("backupWorkspaceState on a pristine workspace moves only what init itself seeded", async () => {
	await withTemp(async (dir) => {
		const cwd = join(dir, "repo");
		await mkdir(cwd, { recursive: true });
		await server.handleInit({ cwd, pipeline: "lite" });
		const hadDashboard = await core.pathExists(join(cwd, ".codecarto", "dashboard.html"));
		const moved = await core.backupWorkspaceState(join(cwd, ".codecarto"), join(cwd, "backup"));
		const expected = ["BACKLOG.md", "CONVENTIONS.md", "DECISIONS.md", "THREAD_LOG.md", "workflow/status.yaml", ...(hadDashboard ? ["dashboard.html"] : [])].sort();
		assert.deepEqual(moved, expected);
		assert.equal(await core.pathExists(join(cwd, ".codecarto", "workflow", "status.yaml")), false);
		assert.equal(await core.pathExists(join(cwd, ".codecarto", "GUIDE.md")), true);
	});
});

// ---------- the surfaces, against the real packaged template ----------
//
// The only way to reach `sameWorkspace` is a `.codecarto` that canonicalizes
// to the packaged template, so these tests symlink to it. Without force the
// handler must refuse before touching anything; the checkout's status.yaml is
// snapshotted and restored around each call so a regression can never leave
// the repository dirty.

async function withTemplateSymlink(fn) {
	// What the old code touched on the template: it rewrote status.yaml and
	// seeded the orchestrator files. Snapshot those, restore or remove after.
	const guarded = ["workflow/status.yaml", ...core.ORCHESTRATOR_FILES.map((entry) => entry.file), "dashboard.html"]
		.map((rel) => join(core.packagedWorkspaceDir, rel));
	const snapshots = new Map();
	for (const path of guarded) snapshots.set(path, await readFile(path, "utf8").catch(() => null));
	await withTemp(async (dir) => {
		const cwd = join(dir, "checkout");
		await mkdir(cwd, { recursive: true });
		await symlink(core.packagedWorkspaceDir, join(cwd, ".codecarto"), "dir");
		try {
			await fn(cwd);
		} finally {
			const touched = [];
			for (const [path, snapshot] of snapshots) {
				const now = await readFile(path, "utf8").catch(() => null);
				if (now === snapshot) continue;
				touched.push(path);
				if (snapshot === null) await rm(path, { force: true });
				else await writeFile(path, snapshot, "utf8");
			}
			assert.deepEqual(touched, [], "the packaged template must not have been touched (restored)");
		}
	});
}

test("codecarto_init refuses to reset the packaged template without force", async () => {
	await withTemplateSymlink(async (cwd) => {
		const listing = await listFiles(core.packagedWorkspaceDir);
		await assert.rejects(
			server.handleInit({ cwd }),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidRequest);
				assert.match(error.message, /is CodeCartographer's own packaged template \(a checkout install\)/);
				assert.match(error.message, /Pass force: true to move that state/);
				assert.match(error.message, /the framework files stay in place/);
				assert.match(error.message, /codecarto_open/);
				return true;
			},
		);
		assert.deepEqual(await listFiles(core.packagedWorkspaceDir), listing, "a refusal moves nothing");
		const backups = (await readdir(cwd)).filter((name) => name.startsWith(".codecarto-backup-"));
		assert.deepEqual(backups, []);
	});
});

test("/codecarto-init asks before resetting the packaged template, and a 'no' changes nothing", async () => {
	await withTemplateSymlink(async (cwd) => {
		const listing = await listFiles(core.packagedWorkspaceDir);
		const { commands, ctx, ui } = createHarness(cwd);
		ui.answer = false;
		await commands.get("codecarto-init").handler("lite", ctx);
		assert.equal(ui.confirmations.length, 1, "the template is an existing workspace: it is asked about");
		assert.equal(ui.confirmations[0].title, "CodeCartographer already exists — data will be lost");
		assert.match(ui.confirmations[0].body, /^This \.codecarto\/ is CodeCartographer's own packaged template \(a checkout install\)/);
		assert.match(ui.confirmations[0].body, /the framework files stay in place/);
		assert.match(ui.confirmations[0].body, /\/codecarto-open/);
		assert.deepEqual(await listFiles(core.packagedWorkspaceDir), listing, "a declined confirmation moves nothing");
		assert.deepEqual((await readdir(cwd)).filter((name) => name.startsWith(".codecarto-backup-")), []);
		assert.ok(!ui.notifications.some((entry) => /Initialized/.test(entry.message)), "nothing was initialized");
	});
});

test("an ordinary existing workspace still gets the directory-level backup", async () => {
	await withTemp(async (dir) => {
		const { cwd, workspaceDir } = await workspaceWithState(dir);
		await assert.rejects(server.handleInit({ cwd }), /A \.codecarto\/ directory already exists at/);
		const result = await server.handleInit({ cwd, force: true, pipeline: "lite" });
		assert.match(result.content[0].text, /Initialized CodeCartographer workspace/);
		const backups = (await readdir(cwd)).filter((name) => name.startsWith(".codecarto-backup-"));
		assert.equal(backups.length, 1);
		assert.ok((await listFiles(join(cwd, backups[0]))).includes("closeouts/2026-09-12-architecture.md"), "the whole old workspace was moved");
		assert.ok(!(await listFiles(workspaceDir)).includes("closeouts/2026-09-12-architecture.md"), "the new workspace is fresh");
	});
});
