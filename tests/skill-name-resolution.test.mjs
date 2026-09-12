// Skill names resolve against the installed list only (self-audit #235, D-M21).
//
// Before this, both surfaces joined the supplied name onto `.codecarto/skills/`
// and checked that `<name>/SKILL.md` existed. Probe P5 in the self-audit showed
// that `../findings/architecture` passes that check (every findings directory
// ships a SKILL.md) and the phase skill is then spliced into the post-pipeline
// prompt. The resolver here never builds a path from the name, so the only
// names that resolve are the directory names listSkillNames() reports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

const PASSING_REPORT = [
	"# Map",
	"",
	"## Validation",
	"",
	"| # | Criterion | Result | Evidence |",
	"|---|-----------|--------|----------|",
	"| 1 | Intent documented. | PASS | §above |",
	"",
	"**Overall:** PASS",
	"",
].join("\n");

/** The traversal name probe P5 used: resolves to a real SKILL.md on disk. */
const TRAVERSAL = "../findings/architecture";

async function withTempRepo(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-skill-name-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/** Init the one-phase pipeline and complete it so the skill gate is open. */
async function initCompleted(cwd) {
	await server.handleInit({ cwd, pipeline: "architecture-only" });
	const codecarto = join(cwd, ".codecarto");
	await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), PASSING_REPORT, "utf8");
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), "phase_id: architecture\ncloseout_summary: done\n", "utf8");
	await server.handleComplete({ cwd });
	// The precondition the probe relied on: the traversal target exists, so a
	// path-existence check alone would accept it.
	assert.equal(await core.pathExists(join(codecarto, "skills", TRAVERSAL, "SKILL.md")), true, "test precondition: traversal target must exist on disk");
	return codecarto;
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = {
		on: () => {},
		registerCommand: (name, command) => commands.set(name, command),
		setActiveTools: () => {},
		setSessionName: () => {},
		sendMessage: () => {},
		sentUserMessages: [],
		sendUserMessage: (message, options) => {
			pi.sentUserMessages.push({ message, options });
		},
	};
	const ui = {
		widgets: [],
		notifications: [],
		theme: { fg: (_name, text) => text },
		setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async () => true,
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui,
		signal: new AbortController().signal,
		isIdle: () => true,
		reload: async () => {},
	};
	codeCartographerExtension(pi);
	return { commands, pi, ctx, ui };
}

// ---------- core ----------

test("resolveSkillName returns installed names verbatim and nothing else", async () => {
	await withTempRepo(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		const workspaceDir = join(cwd, ".codecarto");
		const installed = await core.listSkillNames(workspaceDir);
		assert.ok(installed.length > 0, "the packaged template ships at least one post-pipeline skill");

		for (const name of installed) {
			assert.equal(await core.resolveSkillName(workspaceDir, name), name);
			assert.equal(await core.resolveSkillName(workspaceDir, `  ${name}  `), name, "surrounding whitespace is trimmed");
		}

		const rejected = [
			TRAVERSAL,
			`${installed[0]}/../../findings/architecture`,
			`${installed[0]}/`,
			`./${installed[0]}`,
			join(workspaceDir, "skills", installed[0]),
			"..",
			".",
			"",
			"   ",
			"no-such-skill",
			"broadside",
		];
		for (const name of rejected) {
			assert.equal(await core.resolveSkillName(workspaceDir, name), null, `expected ${JSON.stringify(name)} to be rejected`);
		}
		assert.equal(await core.resolveSkillName(workspaceDir, undefined), null);
		assert.equal(await core.resolveSkillName(workspaceDir, 42), null);
	});
});

test("resolveSkillName ignores non-skill entries under skills/", async () => {
	await withTempRepo(async (cwd) => {
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		const workspaceDir = join(cwd, ".codecarto");
		// A stray file and a directory without SKILL.md are not skills.
		await writeFile(join(workspaceDir, "skills", "notes.md"), "# notes\n", "utf8");
		await mkdir(join(workspaceDir, "skills", "half-installed"), { recursive: true });
		assert.equal(await core.resolveSkillName(workspaceDir, "notes.md"), null);
		assert.equal(await core.resolveSkillName(workspaceDir, "half-installed"), null);
		// Adding a SKILL.md makes it a skill.
		await writeFile(join(workspaceDir, "skills", "half-installed", "SKILL.md"), "# Half\n", "utf8");
		assert.equal(await core.resolveSkillName(workspaceDir, "half-installed"), "half-installed");
	});
});

// ---------- MCP (probe P5) ----------

test("codecarto_skill refuses a traversal name on a completed pipeline (probe P5)", async () => {
	await withTempRepo(async (cwd) => {
		await initCompleted(cwd);
		await assert.rejects(
			server.handleSkill({ cwd, name: TRAVERSAL }),
			(error) => {
				assert.ok(error instanceof McpError, "expected McpError");
				assert.equal(error.code, ErrorCode.InvalidParams);
				assert.match(error.message, /^MCP error -32602: Unknown skill: \.\.\/findings\/architecture\./);
				assert.match(error.message, /Available: /, "the refusal lists what is installed");
				return true;
			},
		);
	});
});

test("codecarto_skill serves an installed skill and names it in the prompt", async () => {
	await withTempRepo(async (cwd) => {
		const codecarto = await initCompleted(cwd);
		const [name] = await core.listSkillNames(codecarto);
		const result = await server.handleSkill({ cwd, name: `  ${name}  ` });
		assert.equal(result.structuredContent.skill, name, "the canonical name is reported, not the raw argument");
		const state = await core.getWorkspaceState(cwd);
		assert.equal(result.content[0].text, await core.buildSkillPrompt(state, name));
		assert.match(result.content[0].text, new RegExp(`- \\.codecarto/skills/${name}/SKILL\\.md`));
	});
});

// ---------- Pi parity ----------

test("/codecarto-skill refuses the same traversal name and sends nothing", async () => {
	await withTempRepo(async (cwd) => {
		await initCompleted(cwd);
		const { commands, pi, ctx, ui } = createHarness(cwd);
		// Pi commands are gated on activation; /codecarto-open activates an
		// existing workspace without touching its state.
		await commands.get("codecarto-open").handler("", ctx);
		await commands.get("codecarto-skill").handler(TRAVERSAL, ctx);
		const notification = ui.notifications.at(-1);
		assert.equal(notification.level, "error");
		assert.match(notification.message, /^Unknown skill: \.\.\/findings\/architecture \(available: /);
		assert.equal(pi.sentUserMessages.length, 0, "no prompt may be queued for an unresolved name");
	});
});

test("/codecarto-skill queues the same prompt codecarto_skill returns for an installed skill", async () => {
	await withTempRepo(async (cwd) => {
		const codecarto = await initCompleted(cwd);
		const [name] = await core.listSkillNames(codecarto);
		const { commands, pi, ctx, ui } = createHarness(cwd);
		await commands.get("codecarto-open").handler("", ctx);
		await commands.get("codecarto-skill").handler(`${name} `, ctx);
		assert.equal(ui.notifications.at(-1).level, "info");
		assert.equal(ui.notifications.at(-1).message, `Queued CodeCartographer skill: ${name}`);
		const mcp = await server.handleSkill({ cwd, name });
		assert.equal(pi.sentUserMessages.length, 1);
		assert.equal(pi.sentUserMessages[0].message, mcp.content[0].text, "both surfaces must queue byte-identical skill prompts");
	});
});
