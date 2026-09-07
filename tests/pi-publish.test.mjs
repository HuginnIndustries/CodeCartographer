// The Pi surface for publishing (/codecarto-publish). Drives the registered
// command through a fake Pi harness against a temporary workspace and
// library. What matters here is what the command records and what it asks:
// the git remote as source_repo when there is one, the directory otherwise
// (#147); and the source-repo collision guard answered as a question rather
// than a flag the command does not take (#146) — including the one time an
// upgraded Pi trips it on its own, when an entry recorded under the old
// directory shape meets a publish carrying the new remote shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Git fixtures must not inherit the developer's git configuration. A global
// `url.<base>.insteadOf` rewrites what `git remote get-url` reports — which is
// exactly what resolvePublishSourceRepo reads — so a verbatim-URL assertion
// fails on any machine carrying that common setting while staying green on
// CI's bare runners. `commit.gpgsign` and `init.defaultBranch` reach the
// committing fixtures the same way. Point both config layers at a path that
// does not exist: git reads a missing file as empty config. Identity is set
// per fixture in repo-local config, so commits still work.
const ABSENT_GIT_CONFIG = join(tmpdir(), "codecarto-tests-absent-gitconfig");
process.env.GIT_CONFIG_GLOBAL = ABSENT_GIT_CONFIG;
process.env.GIT_CONFIG_SYSTEM = ABSENT_GIT_CONFIG;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: codeCartographerExtension } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href
);
const { writeMarker, deriveSlug, ENTRIES_DIR, METADATA_FILE } = await import(pathToFileURL(`${REPO_ROOT}/core/library.ts`).href);

// The command merges the user-global config under the workspace's. Keep the
// developer's real ~/.codecarto/config.yaml out of it; each test file runs in
// its own process, so the override cannot leak.
process.env.CODECARTO_USER_CONFIG_PATH = join(tmpdir(), `cc-pi-publish-no-user-config-${process.pid}`, "config.yaml");

const execFileAsync = promisify(execFile);

async function git(dir, ...args) {
	await execFileAsync("git", ["-C", dir, ...args]);
}

function createHarness(cwd, { confirm = async () => true } = {}) {
	const events = new Map();
	const commands = new Map();
	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		setActiveTools: () => {},
		setSessionName: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	const ui = {
		notifications: [],
		confirmations: [],
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: () => {},
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => {
			ui.confirmations.push({ title, body });
			return confirm(title, body);
		},
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { events, commands, ctx, ui };
}

/**
 * A publishable fixture: a directory named `whisper-fixture` (so the slug a
 * path derives matches the slug its remote will derive), an initialized
 * workspace pointing at a fresh single-tenant library, and a spec to publish.
 */
async function publishableFixture() {
	const root = await mkdtemp(join(tmpdir(), "cc-pi-publish-"));
	const cwd = join(root, "whisper-fixture");
	await mkdir(cwd);
	const libraryPath = join(root, "library");
	await mkdir(libraryPath);
	await writeMarker(libraryPath, { schema_version: 1, name: "pi-publish-library", namespaced: false });

	const bootstrap = createHarness(cwd);
	await bootstrap.events.get("session_start")({}, bootstrap.ctx);
	await bootstrap.commands.get("codecarto-init").handler("", bootstrap.ctx);
	await writeFile(
		join(cwd, ".codecarto", "workflow", "config.yaml"),
		["library:", `  path: ${libraryPath}`, "  publish_confirm: true"].join("\n"),
		"utf8",
	);
	const specPath = join(cwd, ".codecarto", "findings", "reimplementation-spec", "reimplementation-spec.md");
	const writeSpec = (summary) => writeFile(specPath, `# Reimplementation Spec\n\n## System Summary\n\n${summary}\n`, "utf8");
	await writeSpec("A publishable fixture system.");

	return {
		cwd,
		libraryPath,
		writeSpec,
		entryDir: (slug) => join(libraryPath, ENTRIES_DIR, slug),
		metadata: (slug, version) => readFile(join(libraryPath, ENTRIES_DIR, slug, `v${version}`, METADATA_FILE), "utf8"),
		cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
	};
}

/**
 * Run /codecarto-publish from a fresh Pi session on an existing workspace.
 * Every command checks that CodeCartographer is active in the session, so the
 * session opens the workspace first (as a user would) and the open's own
 * notification is dropped, leaving the UI log to the publish alone.
 */
async function publish(cwd, options) {
	const { events, commands, ctx, ui } = createHarness(cwd, options);
	await events.get("session_start")({}, ctx);
	await commands.get("codecarto-open").handler("", ctx);
	assert.match(ui.notifications.at(-1).message, /Opened existing CodeCartographer workspace/);
	ui.notifications.length = 0;
	ui.confirmations.length = 0;
	await commands.get("codecarto-publish").handler("", ctx);
	return ui;
}

const ORIGIN = "https://github.com/acme/Whisper-Fixture.git";

test("records the origin remote as source_repo, verbatim, and derives the slug from it (#147)", async () => {
	const fx = await publishableFixture();
	try {
		await git(fx.cwd, "init", "-q");
		await git(fx.cwd, "remote", "add", "origin", ORIGIN);

		const ui = await publish(fx.cwd);

		assert.equal(ui.confirmations.length, 1, "publish_confirm: true asks once");
		assert.equal(ui.confirmations[0].title, "Publish reimplementation spec");
		assert.match(ui.confirmations[0].body, /^Publish whisper-fixture to /m, "the slug comes from the remote");
		assert.match(ui.confirmations[0].body, /^Source: https:\/\/github\.com\/acme\/Whisper-Fixture\.git \(git remote origin\)$/m, "the preview shows what will be recorded");
		assert.match(ui.notifications.at(-1).message, /^Published whisper-fixture v1\./);

		const meta = await fx.metadata("whisper-fixture", 1);
		assert.match(meta, /^source_repo: "?https:\/\/github\.com\/acme\/Whisper-Fixture\.git"?$/m, "stored as git reports it — case and .git kept");
		assert.doesNotMatch(meta, new RegExp(fx.cwd.replaceAll("\\", "\\\\")), "the local path is not the provenance");
	} finally {
		await fx.cleanup();
	}
});

test("a directory that is not a git repository still records its path", async () => {
	const fx = await publishableFixture();
	try {
		const ui = await publish(fx.cwd);

		assert.match(ui.confirmations[0].body, new RegExp(`^Source: ${fx.cwd.replaceAll("\\", "\\\\")}$`, "m"));
		assert.doesNotMatch(ui.confirmations[0].body, /git remote/);
		assert.match(ui.notifications.at(-1).message, /^Published whisper-fixture v1\./);
		assert.equal(deriveSlug(fx.cwd), "whisper-fixture");
		assert.match(await fx.metadata("whisper-fixture", 1), new RegExp(`^source_repo: "?${fx.cwd.replaceAll("\\", "\\\\")}"?$`, "m"));
	} finally {
		await fx.cleanup();
	}
});

test("a recorded path meeting an incoming remote asks whether the repository moved; yes appends (#146)", async () => {
	// The upgrade path: v1 was published by a Pi that recorded the directory.
	// The same checkout then publishes from a Pi that records the remote, so
	// the collision guard sees a path against a URL and cannot tell a moved
	// repository from a different one. The question is the remedy.
	const fx = await publishableFixture();
	try {
		await publish(fx.cwd);
		assert.match(await fx.metadata("whisper-fixture", 1), /^source_repo: "?\//m, "v1 records the path");

		await git(fx.cwd, "init", "-q");
		await git(fx.cwd, "remote", "add", "origin", ORIGIN);
		await fx.writeSpec("The fixture system, revised.");

		const ui = await publish(fx.cwd);

		assert.equal(ui.confirmations.length, 2, "the preview, then the move question");
		const [preview, moved] = ui.confirmations;
		assert.equal(preview.title, "Publish reimplementation spec");
		assert.match(moved.title, /Source repository changed/);
		assert.match(moved.body, new RegExp(`records source_repo "${fx.cwd.replaceAll("\\", "\\\\")}"`), "the recorded value");
		assert.match(moved.body, /this publish carries "https:\/\/github\.com\/acme\/Whisper-Fixture\.git"/, "the incoming value");
		assert.match(moved.body, /Did the repository move\?/);
		assert.match(ui.notifications.at(-1).message, /^Published whisper-fixture v2\./);
		assert.equal(ui.notifications.at(-1).level, "info");

		assert.deepEqual((await readdir(fx.entryDir("whisper-fixture"))).sort(), ["latest", "v1", "v2"]);
		assert.match(await fx.metadata("whisper-fixture", 2), /^source_repo: "?https:\/\/github\.com\/acme\/Whisper-Fixture\.git"?$/m);
		assert.match(await fx.metadata("whisper-fixture", 1), /^source_repo: "?\//m, "history is appended to, not rewritten");
	} finally {
		await fx.cleanup();
	}
});

test("answering no to the move question writes nothing", async () => {
	const fx = await publishableFixture();
	try {
		await publish(fx.cwd);
		await git(fx.cwd, "init", "-q");
		await git(fx.cwd, "remote", "add", "origin", ORIGIN);
		await fx.writeSpec("The fixture system, revised.");
		const v1Before = await fx.metadata("whisper-fixture", 1);

		const ui = await publish(fx.cwd, { confirm: async (title) => !/Source repository changed/.test(title) });

		assert.equal(ui.confirmations.length, 2);
		assert.equal(ui.notifications.at(-1).message, "Publish cancelled. Nothing was written.");
		assert.equal(ui.notifications.at(-1).level, "info", "a cancel is not an error");
		assert.deepEqual((await readdir(fx.entryDir("whisper-fixture"))).sort(), ["latest", "v1"]);
		assert.equal(await fx.metadata("whisper-fixture", 1), v1Before, "not even a metadata-only rewrite");
	} finally {
		await fx.cleanup();
	}
});

test("declining the preview asks nothing further and writes nothing", async () => {
	const fx = await publishableFixture();
	try {
		await git(fx.cwd, "init", "-q");
		await git(fx.cwd, "remote", "add", "origin", ORIGIN);

		const ui = await publish(fx.cwd, { confirm: async () => false });

		assert.equal(ui.confirmations.length, 1);
		assert.equal(ui.notifications.length, 0, "the existing preview decline is silent");
		await assert.rejects(readdir(fx.entryDir("whisper-fixture")), /ENOENT/);
	} finally {
		await fx.cleanup();
	}
});
