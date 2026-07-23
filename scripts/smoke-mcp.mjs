#!/usr/bin/env node
// End-to-end smoke test for the published codecartographer-pi MCP server.
// Installs the package from npm into a temp dir, drives the bin via the
// MCP SDK's stdio client, and runs nine TAP-style assertions covering the
// happy path and key negative cases.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values: argv } = parseArgs({
	options: {
		version: { type: "string" },
		tarball: { type: "string" },
		"keep-tmp": { type: "boolean", default: false },
	},
});

if (argv.version && argv.tarball) {
	console.error("error: pass either --version or --tarball, not both");
	process.exit(2);
}

const repoPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const TARBALL = argv.tarball ? resolve(argv.tarball) : null;
const VERSION = TARBALL ? null : (argv.version ?? repoPkg.version);
const INSTALL_SPEC = TARBALL ?? `codecartographer-pi@${VERSION}`;
const INSTALL_LABEL = TARBALL ? `tarball ${TARBALL}` : `codecartographer-pi@${VERSION}`;

let smokeRoot;
let keepTmp = argv["keep-tmp"];
const stderrChunks = [];

async function cleanup() {
	if (!smokeRoot) return;
	if (keepTmp) {
		console.error(`# preserving harness at ${smokeRoot}`);
		return;
	}
	await rm(smokeRoot, { recursive: true, force: true }).catch(() => {});
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, async () => {
		await cleanup();
		process.exit(130);
	});
}

async function setupFixture() {
	smokeRoot = await mkdtemp(join(tmpdir(), "cc-smoke-"));
	const pkgRoot = join(smokeRoot, "harness");
	const target = join(smokeRoot, "target");
	await mkdir(pkgRoot, { recursive: true });
	await mkdir(target, { recursive: true });
	await writeFile(
		join(pkgRoot, "package.json"),
		JSON.stringify({ name: "smoke-harness", private: true, type: "module" }, null, 2),
	);

	console.error(`# installing ${INSTALL_LABEL} into ${pkgRoot}`);
	const installEnv = { ...process.env, npm_config_loglevel: "error" };
	delete installEnv.npm_config_allow_scripts;
	delete installEnv.NPM_CONFIG_ALLOW_SCRIPTS;
	await execFile(
		"npm",
		["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", pkgRoot, INSTALL_SPEC],
		{ env: installEnv },
	);

	const binPath = join(pkgRoot, "node_modules", ".bin", "codecarto-mcp");
	await access(binPath, FS.X_OK);
	return { pkgRoot, target, binPath };
}

const EXPECTED_TOOLS = [
	"codecarto_complete",
	"codecarto_config",
	"codecarto_dashboard",
	"codecarto_init",
	"codecarto_library_init",
	"codecarto_library_list",
	"codecarto_library_reindex",
	"codecarto_list_skills",
	"codecarto_next",
	"codecarto_open",
	"codecarto_phase",
	"codecarto_publish",
	"codecarto_skill",
	"codecarto_status",
	"codecarto_switch_pipeline",
	"codecarto_usage",
	"codecarto_validate",
	"codecarto_vision",
];

async function step(name, fn) {
	try {
		await fn();
		console.log(`ok - ${name}`);
	} catch (err) {
		console.log(`not ok - ${name}`);
		console.error("---");
		console.error("error:", err?.message ?? err);
		if (err?.code !== undefined) console.error("mcp code:", err.code);
		if (err?.stack) console.error(err.stack);
		console.error("server stderr (tail 4KB):");
		console.error(Buffer.concat(stderrChunks).slice(-4096).toString("utf8"));
		console.error("smokeRoot:", smokeRoot, "(preserved for inspection)");
		console.error("---");
		keepTmp = true;
		process.exitCode = 1;
		throw err;
	}
}

async function expectReject(promise, { code, message }) {
	let resolved;
	try {
		resolved = await promise;
	} catch (err) {
		assert.equal(err.code, code, `expected mcp code ${code}, got ${err.code}`);
		if (message) assert.match(err.message ?? String(err), message);
		return;
	}
	throw new Error(`expected rejection, got: ${JSON.stringify(resolved)}`);
}

async function main() {
	const { target, binPath } = await setupFixture();

	const transport = new StdioClientTransport({ command: binPath, args: [], stderr: "pipe" });
	transport.stderr?.on("data", (c) => stderrChunks.push(c));
	const client = new Client({ name: "codecarto-smoke", version: "0.0.0" }, { capabilities: {} });

	await step("connect: server boots and completes initialize handshake", async () => {
		await Promise.race([
			client.connect(transport),
			new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout 10s")), 10_000)),
		]);
	});

	await step("tools/list: returns the documented workflow and library tools", async () => {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, EXPECTED_TOOLS);
		const init = tools.find((t) => t.name === "codecarto_init");
		assert.ok(init.inputSchema?.required?.includes("cwd"), "codecarto_init must require cwd");
	});

	await step("codecarto_init: initializes lite pipeline in target", async () => {
		const result = await client.callTool({
			name: "codecarto_init",
			arguments: { cwd: target, pipeline: "lite" },
		});
		assert.equal(result.structuredContent?.firstPhase, "architecture");
		await access(join(target, ".codecarto", "workflow", "status.yaml"));
	});

	await step("codecarto_status: reports freshly initialized state", async () => {
		const result = await client.callTool({ name: "codecarto_status", arguments: { cwd: target } });
		const sc = result.structuredContent;
		assert.equal(sc?.currentPhase, "architecture");
		assert.equal(sc?.completed, 0);
		assert.ok(sc?.total > 0, `expected total > 0, got ${sc?.total}`);
	});

	await step("codecarto_next: returns architecture phase prompt", async () => {
		const result = await client.callTool({ name: "codecarto_next", arguments: { cwd: target } });
		assert.equal(result.structuredContent?.phase, "architecture");
		assert.equal(result.structuredContent?.forced, false);
		assert.ok(
			(result.content?.[0]?.text ?? "").length > 200,
			"expected a substantive phase prompt",
		);
	});

	await step("negative: missing cwd rejects with InvalidParams", async () => {
		await expectReject(client.callTool({ name: "codecarto_status", arguments: {} }), {
			code: -32602,
			message: /cwd is required/,
		});
	});

	await step("negative: non-absolute cwd rejects with InvalidParams", async () => {
		await expectReject(
			client.callTool({ name: "codecarto_status", arguments: { cwd: "relative/path" } }),
			{ code: -32602, message: /absolute path/ },
		);
	});

	await step("negative: complete before validate rejects with InvalidRequest", async () => {
		await expectReject(
			client.callTool({ name: "codecarto_complete", arguments: { cwd: target } }),
			{ code: -32600, message: /MISSING/ },
		);
	});

	await step("negative: skill before pipeline complete rejects with InvalidRequest", async () => {
		await expectReject(
			client.callTool({
				name: "codecarto_skill",
				arguments: { cwd: target, name: "spec-delta-application" },
			}),
			{ code: -32600, message: /pipeline is not complete/ },
		);
	});

	await client.close();
	console.log("1..9");
}

try {
	await main();
} catch (err) {
	// setup failures happen before step() can mark the run failed.
	console.error("not ok - smoke setup or uncaught failure");
	console.error(err?.stack ?? err?.message ?? err);
	process.exitCode ||= 1;
} finally {
	await cleanup();
}
