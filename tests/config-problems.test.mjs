// Config faults are reported, not swallowed (self-audit #242, #243, #244).
//
// #242: a config file that fails to parse, or a section or key the loader
//       cannot use, was dropped silently. It is now recorded in
//       `config.problems`; codecarto_config / /codecarto-config show the list
//       and the library tools refuse while it is non-empty.
// #243: a relative `library.path` resolved against the process cwd. It is now
//       refused with a problem naming the file and the value.
// #244: library-init wrote `publish_confirm: true`, which switched the MCP
//       confirm gate on. It now writes only `library.path` (and `namespace`
//       when given) and refuses to rewrite a file it cannot parse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

const { CONFIG_RELATIVE_PATH, describeConfigProblems, loadCodecartoConfig, loadUserConfig, mergeConfig, writeLibraryConfig } = core;

/** YAML the hand-rolled parser rejects outright. */
const UNPARSEABLE = "library:\n  path: /abs/lib\n   namespace: bad-indent\n";

async function withTemp(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-config-problems-"));
	const previous = process.env.CODECARTO_USER_CONFIG_PATH;
	// Every test gets its own user-global path so the developer's real file
	// never leaks in and a test that writes one never leaks out.
	const userConfigPath = join(dir, "user", "config.yaml");
	process.env.CODECARTO_USER_CONFIG_PATH = userConfigPath;
	try {
		await fn({ dir, userConfigPath });
	} finally {
		if (previous === undefined) delete process.env.CODECARTO_USER_CONFIG_PATH;
		else process.env.CODECARTO_USER_CONFIG_PATH = previous;
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

async function writeUserConfig(userConfigPath, content) {
	await mkdir(dirname(userConfigPath), { recursive: true });
	await writeFile(userConfigPath, content, "utf8");
}

/** A cwd with a `.codecarto/workflow/config.yaml` holding `content` (no status.yaml). */
async function makeWorkspace(dir, content) {
	const cwd = join(dir, "ws");
	const workspaceDir = join(cwd, ".codecarto");
	await mkdir(join(workspaceDir, "workflow"), { recursive: true });
	if (content !== undefined) await writeFile(join(workspaceDir, CONFIG_RELATIVE_PATH), content, "utf8");
	return { cwd, workspaceDir, configPath: join(workspaceDir, CONFIG_RELATIVE_PATH) };
}

async function makeLibrary(dir) {
	const libraryPath = join(dir, "library");
	await mkdir(libraryPath, { recursive: true });
	await core.writeMarker(libraryPath, { schema_version: 1, name: "t", namespaced: false });
	return libraryPath;
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
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => {
			ui.confirmations.push({ title, body });
			return true;
		},
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, pi, ctx, ui };
}

// ---------- #242: the loader reports ----------

test("an unparseable config file is dropped whole and reported with its path", async () => {
	await withTemp(async ({ dir }) => {
		const { workspaceDir, configPath } = await makeWorkspace(dir, UNPARSEABLE);
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.library.path, null, "nothing from the file is in effect");
		assert.equal(config.problems.length, 1);
		assert.equal(config.problems[0].path, configPath);
		assert.match(config.problems[0].message, /^could not be parsed \(.+\); the whole file was ignored$/);
	});
});

test("a file that is not a mapping is reported, and an empty file is not a problem", async () => {
	await withTemp(async ({ dir }) => {
		const list = await makeWorkspace(dir, "- just\n- a list\n");
		const config = await loadCodecartoConfig(list.workspaceDir);
		assert.deepEqual(config.problems, [{ path: list.configPath, message: "the file is not a YAML mapping; the whole file was ignored" }]);

		await writeFile(list.configPath, "", "utf8");
		assert.deepEqual((await loadCodecartoConfig(list.workspaceDir)).problems, []);
	});
});

test("a key of the wrong type is reported and ignored while the rest of the file applies", () => {
	const config = mergeConfig(
		{ orchestrator: { llm_steer_next_phase: "yes" }, library: { path: "/abs/lib", publish_confirm: "no", namespace: 7 } },
		"/some/config.yaml",
	);
	assert.equal(config.orchestrator.llm_steer_next_phase, false);
	assert.equal(config.library.path, resolve("/abs/lib"), "the good key still applies");
	assert.equal(config.library.publish_confirm, true);
	assert.equal(config.library.publish_confirm_configured, false, "a bad value does not count as configuring the gate");
	assert.equal(config.library.namespace, null);
	assert.deepEqual(config.problems.map((problem) => problem.message), [
		'orchestrator.llm_steer_next_phase must be true or false, got "yes"; the key was ignored',
		"library.namespace must be a string, got 7; the key was ignored",
		'library.publish_confirm must be true or false, got "no"; the key was ignored',
	]);
	assert.ok(config.problems.every((problem) => problem.path === "/some/config.yaml"));
});

test("problems accumulate across layers in order, and a good layer still overrides", async () => {
	await withTemp(async ({ dir, userConfigPath }) => {
		await writeUserConfig(userConfigPath, UNPARSEABLE);
		const { workspaceDir, configPath } = await makeWorkspace(dir, "library:\n  path: /abs/ws-lib\n  publish_confirm: [x]\n");
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.library.path, resolve("/abs/ws-lib"));
		assert.deepEqual(config.problems.map((problem) => problem.path), [userConfigPath, configPath]);
		assert.match(config.problems[0].message, /could not be parsed/);
		assert.match(config.problems[1].message, /^library\.publish_confirm must be true or false/);

		const userOnly = await loadUserConfig();
		assert.equal(userOnly.problems.length, 1);
	});
});

test("describeConfigProblems renders one line per fault and nothing when there are none", () => {
	assert.deepEqual(describeConfigProblems(mergeConfig({})), []);
	const config = mergeConfig({ library: { path: "relative/lib" } }, "/u/config.yaml");
	assert.deepEqual(describeConfigProblems(config), [
		"Config problem (1) — these settings are not in effect:",
		'  - /u/config.yaml: library.path must be absolute or start with ~ (got "relative/lib"); the key was ignored',
	]);
	const two = mergeConfig({ library: { path: 1, namespace: 2 } }, "/u/config.yaml");
	assert.match(describeConfigProblems(two)[0], /^Config problems \(2\)/);
});

// ---------- #243: relative library.path ----------

test("a relative library.path is refused with a problem; absolute and ~ paths still resolve", () => {
	for (const relative of ["relative/lib", "./lib", "../lib", ".codecarto/library"]) {
		const config = mergeConfig({ library: { path: relative } }, "/u/config.yaml");
		assert.equal(config.library.path, null, `${relative} must not resolve against the process cwd`);
		assert.equal(config.problems.length, 1);
		assert.match(config.problems[0].message, /^library\.path must be absolute or start with ~/);
	}
	assert.equal(mergeConfig({ library: { path: "/abs/lib" } }).library.path, resolve("/abs/lib"));
	const tilde = mergeConfig({ library: { path: "~/codecarto-library" } });
	assert.equal(tilde.library.path, core.expandTilde("~/codecarto-library"));
	assert.deepEqual(tilde.problems, []);
});

test("a relative library.path in the workspace file does not make the user-global one vanish", async () => {
	await withTemp(async ({ dir, userConfigPath }) => {
		await writeUserConfig(userConfigPath, "library:\n  path: /abs/user-lib\n");
		const { workspaceDir } = await makeWorkspace(dir, "library:\n  path: ../shared-lib\n");
		const config = await loadCodecartoConfig(workspaceDir);
		assert.equal(config.library.path, resolve("/abs/user-lib"), "the refused key leaves the lower layer's value in effect");
		assert.equal(config.problems.length, 1);
	});
});

// ---------- #244: what library-init writes ----------

test("writeLibraryConfig writes library.path alone into a new file", async () => {
	await withTemp(async ({ userConfigPath }) => {
		await writeLibraryConfig(userConfigPath, "/abs/lib");
		assert.equal(await readFile(userConfigPath, "utf8"), "library:\n  path: /abs/lib\n");
		const config = await loadUserConfig();
		assert.equal(config.library.publish_confirm_configured, false, "the MCP gate is not switched on by init");
	});
});

test("writeLibraryConfig keeps publish_confirm, orchestrator, and an existing namespace as they were", async () => {
	await withTemp(async ({ userConfigPath }) => {
		await writeUserConfig(userConfigPath, [
			"orchestrator:",
			"  llm_steer_next_phase: true",
			"library:",
			"  path: /abs/old-lib",
			"  namespace: alice",
			"  publish_confirm: false",
			"",
		].join("\n"));
		await writeLibraryConfig(userConfigPath, "/abs/new-lib");
		const config = await loadUserConfig();
		assert.equal(config.library.path, resolve("/abs/new-lib"));
		assert.equal(config.library.namespace, "alice", "not asked to change the namespace, so it stays");
		assert.equal(config.library.publish_confirm, false);
		assert.equal(config.library.publish_confirm_configured, true);
		assert.equal(config.orchestrator.llm_steer_next_phase, true);
		assert.deepEqual(config.problems, []);

		await writeLibraryConfig(userConfigPath, "/abs/new-lib", "bob");
		assert.equal((await loadUserConfig()).library.namespace, "bob", "a given namespace is written");
	});
});

test("writeLibraryConfig refuses to rewrite a file it cannot parse", async () => {
	await withTemp(async ({ userConfigPath }) => {
		await writeUserConfig(userConfigPath, UNPARSEABLE);
		await assert.rejects(writeLibraryConfig(userConfigPath, "/abs/lib"), /^Error: Refusing to rewrite .*: it could not be parsed \(.+\)\. Fix or remove the file, then run library-init again\.$/);
		assert.equal(await readFile(userConfigPath, "utf8"), UNPARSEABLE, "the file is untouched");
		await writeFile(userConfigPath, "- a\n- list\n", "utf8");
		await assert.rejects(writeLibraryConfig(userConfigPath, "/abs/lib"), /is not a YAML mapping/);
	});
});

// ---------- the two surfaces ----------

test("codecarto_library_init does not switch the publish gate on, and says what it wrote", async () => {
	await withTemp(async ({ dir, userConfigPath }) => {
		const libraryPath = join(dir, "new-library");
		const result = await server.handleLibraryInit({ library_path: libraryPath });
		assert.match(result.content[0].text, /Wrote library\.path to .*config\.yaml; other keys untouched\.$/);
		assert.equal(await readFile(userConfigPath, "utf8"), `library:\n  path: ${libraryPath}\n`);

		// Straight to publish with no confirm: the gate is off, as #162 intended
		// for a host that never configured it.
		const published = await server.handlePublish({ library_path: libraryPath, spec: "# s\n", source_repo: "https://github.com/x/y", headline: "h" });
		assert.equal(published.structuredContent.version, 1);

		const namespaced = await server.handleLibraryInit({ library_path: join(dir, "ns-library"), namespace: "team" });
		assert.match(namespaced.content[0].text, /Wrote library\.path and library\.namespace to /);
	});
});

test("codecarto_library_init refuses to rewrite an unparseable user config", async () => {
	await withTemp(async ({ dir, userConfigPath }) => {
		await writeUserConfig(userConfigPath, UNPARSEABLE);
		await assert.rejects(
			server.handleLibraryInit({ library_path: join(dir, "new-library") }),
			(error) => {
				assert.ok(error instanceof McpError);
				assert.equal(error.code, ErrorCode.InvalidRequest);
				assert.match(error.message, /Refusing to rewrite .*could not be parsed/);
				return true;
			},
		);
		assert.equal(await readFile(userConfigPath, "utf8"), UNPARSEABLE);
	});
});

test("codecarto_config lists the problems and the library tools refuse while any exist", async () => {
	await withTemp(async ({ dir, userConfigPath }) => {
		const libraryPath = await makeLibrary(dir);
		await writeUserConfig(userConfigPath, `library:\n  path: ${libraryPath}\n`);
		const { cwd, configPath } = await makeWorkspace(dir, "library:\n  path: relative/lib\n");

		const shown = await server.handleConfig({ cwd });
		assert.match(shown.content[0].text, /^Config problem \(1\) — these settings are not in effect:$/m);
		assert.match(shown.content[0].text, new RegExp(`^  - ${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: library\\.path must be absolute or start with ~ \\(got "relative/lib"\\); the key was ignored$`, "m"));
		assert.equal(shown.structuredContent.problems.length, 1);
		assert.equal(shown.structuredContent.libraryPath, libraryPath, "the user-global path is what is in effect");

		const refused = (tool) => (error) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, ErrorCode.InvalidRequest);
			assert.match(error.message, new RegExp(`^MCP error -32600: ${tool} refused: the configuration has problems`));
			assert.match(error.message, /library\.path must be absolute/);
			return true;
		};
		const publishArgs = { cwd, library_path: libraryPath, spec: "# s\n", source_repo: "https://github.com/x/y", headline: "h" };
		await assert.rejects(server.handlePublish(publishArgs), refused("codecarto_publish"));
		await assert.rejects(server.handleLibraryList({ cwd, library_path: libraryPath }), refused("codecarto_library_list"));
		await assert.rejects(server.handleLibraryReindex({ cwd, library_path: libraryPath }), refused("codecarto_library_reindex"));
		assert.deepEqual(await core.listEntries(libraryPath), [], "the refused publish wrote nothing");

		// Without the workspace layer the same calls go through.
		const ok = await server.handlePublish({ library_path: libraryPath, spec: "# s\n", source_repo: "https://github.com/x/y", headline: "h" });
		assert.equal(ok.structuredContent.version, 1);
		assert.deepEqual((await server.handleConfig({})).structuredContent.problems, []);
	});
});

test("/codecarto-config shows the same problem lines and /codecarto-publish refuses on them", async () => {
	await withTemp(async ({ dir, userConfigPath }) => {
		const libraryPath = await makeLibrary(dir);
		await writeUserConfig(userConfigPath, UNPARSEABLE);
		const cwd = join(dir, "repo");
		await mkdir(cwd, { recursive: true });
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		await writeFile(join(cwd, ".codecarto", CONFIG_RELATIVE_PATH), `library:\n  path: ${libraryPath}\n`, "utf8");
		const { commands, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-open").handler("", ctx);

		await commands.get("codecarto-config").handler("", ctx);
		const widget = ui.widgets.at(-1).value.join("\n");
		assert.match(widget, /Config problem \(1\) — these settings are not in effect:/);
		assert.match(widget, /could not be parsed/);
		assert.equal(ui.notifications.at(-1).level, "warning", "a problem is a warning, not the usual info notice");
		const mcp = await server.handleConfig({ cwd });
		const mcpLines = mcp.content[0].text.split("\n").filter((line) => line.startsWith("Config problem") || line.startsWith("  - "));
		const piLines = widget.split("\n").filter((line) => line.startsWith("Config problem") || line.startsWith("  - "));
		assert.deepEqual(piLines, mcpLines, "both surfaces print the same problem lines");

		await commands.get("codecarto-publish").handler("", ctx);
		assert.equal(ui.notifications.at(-1).level, "error");
		assert.match(ui.notifications.at(-1).message, /^Publish refused: the configuration has problems/);
		assert.equal(ui.confirmations.length, 0, "refused before any preview dialog");
		assert.deepEqual(await core.listEntries(libraryPath), []);
	});
});

test("/codecarto-library-init names what it wrote", async () => {
	await withTemp(async ({ dir, userConfigPath }) => {
		const cwd = join(dir, "repo");
		await mkdir(cwd, { recursive: true });
		const { commands, ctx, ui } = createHarness(cwd);
		const libraryPath = join(dir, "pi-library");
		await commands.get("codecarto-library-init").handler(libraryPath, ctx);
		assert.equal(ui.notifications.at(-1).level, "info");
		assert.equal(ui.notifications.at(-1).message, `Wrote library.path to ${userConfigPath}; other keys untouched`);
		assert.equal(await readFile(userConfigPath, "utf8"), `library:\n  path: ${libraryPath}\n`);
	});
});
