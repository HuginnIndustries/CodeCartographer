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
		"keep-tmp": { type: "boolean", default: false },
	},
});

const repoPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const VERSION = argv.version ?? repoPkg.version;

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

	console.error(`# installing codecartographer-pi@${VERSION} into ${pkgRoot}`);
	await execFile(
		"npm",
		["install", "--no-audit", "--no-fund", "--prefix", pkgRoot, `codecartographer-pi@${VERSION}`],
		{ env: { ...process.env, npm_config_loglevel: "error" } },
	);

	const binPath = join(pkgRoot, "node_modules", ".bin", "codecarto-mcp");
	await access(binPath, FS.X_OK);
	return { pkgRoot, target, binPath };
}

const EXPECTED_TOOLS = [
	"codecarto_complete",
	"codecarto_init",
	"codecarto_next",
	"codecarto_phase",
	"codecarto_skill",
	"codecarto_status",
	"codecarto_validate",
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

	await step("tools/list: returns the seven documented tools", async () => {
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
} catch {
	// step() already logged; non-zero exit code already set.
} finally {
	await cleanup();
}
