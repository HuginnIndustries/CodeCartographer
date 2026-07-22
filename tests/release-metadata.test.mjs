// Release invariants for npm and official MCP Registry discovery metadata.
// These fail before publication if the package, lockfile, executable, and
// server.json drift apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(REPO_ROOT, "package-lock.json"), "utf8"));
const server = JSON.parse(await readFile(join(REPO_ROOT, "server.json"), "utf8"));

test("release versions agree across npm and MCP Registry metadata", () => {
	assert.equal(lock.version, pkg.version, "package-lock root version must match package.json");
	assert.equal(lock.packages?.[""]?.version, pkg.version, "package-lock package version must match package.json");
	assert.equal(server.version, pkg.version, "server.json version must match package.json");
	assert.equal(server.packages?.[0]?.version, pkg.version, "MCP npm package version must match package.json");
});

test("MCP Registry metadata identifies the published stdio package", () => {
	assert.match(
		server.$schema ?? "",
		/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[^/]+\/server\.schema\.json$/,
	);
	assert.equal(
		pkg.mcpName,
		"io.github.HuginnIndustries/codecartographer",
		"MCP Registry GitHub organization namespaces are case-sensitive",
	);
	assert.equal(server.name, pkg.mcpName, "server.json name must match npm mcpName ownership marker");
	assert.equal(server.title, "CodeCartographer");
	assert.equal(server.websiteUrl, "https://codecarto.dev/");
	assert.equal(server.repository?.url, "https://github.com/HuginnIndustries/CodeCartographer");
	assert.equal(server.repository?.source, "github");
	assert.equal(server.packages?.length, 1, "CodeCartographer should publish one npm-backed server package");

	const registryPackage = server.packages[0];
	assert.equal(registryPackage.registryType, "npm");
	assert.equal(registryPackage.identifier, pkg.name);
	assert.equal(registryPackage.transport?.type, "stdio");
	assert.equal(registryPackage.environmentVariables, undefined, "the local server requires no secrets");
	assert.equal(pkg.bin?.["codecarto-mcp"], "dist/mcp-server/bin.mjs");
});

test("npm metadata describes both product directions and preserves discovery terms", () => {
	assert.match(pkg.description, /evidence-backed reverse engineering/i);
	assert.match(pkg.description, /software planning/i);

	const requiredKeywords = [
		"codecartographer",
		"reverse-engineering",
		"mcp",
		"software-planning",
		"code-analysis",
		"synthesis",
	];
	for (const keyword of requiredKeywords) {
		assert.ok(pkg.keywords?.includes(keyword), `package.json keywords must include ${keyword}`);
	}
});
