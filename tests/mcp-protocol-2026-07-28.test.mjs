// Protocol-era contract of the shipped stdio server (#185).
//
// Drives dist/mcp-server/bin.mjs over raw newline-delimited JSON-RPC, the way
// a host does, and pins two things at once:
//
//   1. NON-REGRESSION: every 2025-era `initialize` the SDK v1 line accepted is
//      still accepted and negotiated exactly as before. The issue's hard
//      acceptance item is "today the server accepts every revision the SDK
//      supports, and that behavior must not regress".
//   2. THE 2026-07-28 ERA: a client opening with the per-request `_meta`
//      envelope (`server/discover`, then envelope-bearing `tools/list` /
//      `tools/call`) is answered in that era: supportedVersions, resultType,
//      caching hints, serverInfo stamping.
//
// Both eras are served from one process; the opening message selects the era.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "dist/mcp-server/bin.mjs");

const MODERN_REVISION = "2026-07-28";
// The legacy-era revisions the SDK v1 line (1.30.0) accepted on `initialize`.
// Removing one from this list is the regression the issue forbids.
const LEGACY_REVISIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/** The 2026-07-28 per-request envelope: every request carries its own era claim. */
function envelope(params = {}) {
	return {
		...params,
		_meta: {
			[PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
			[CLIENT_INFO_META_KEY]: { name: "protocol-2026-test", version: "0" },
			[CLIENT_CAPABILITIES_META_KEY]: {},
		},
	};
}

async function withSession(fn) {
	const child = spawn(process.execPath, [BIN], {
		cwd: REPO_ROOT,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const waiter = pending.get(message.id);
			if (waiter) {
				pending.delete(message.id);
				waiter(message);
			}
		}
	});
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

	function send(method, params) {
		const id = nextId++;
		const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectPromise(new Error(`timed out waiting for ${method}; stderr: ${stderr.join("")}`));
			}, 30_000);
			pending.set(id, (message) => {
				clearTimeout(timer);
				resolvePromise(message);
			});
			child.stdin.write(frame);
		});
	}
	function notify(method, params) {
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}
	try {
		return await fn({ send, notify });
	} finally {
		child.stdin.end();
		child.kill();
	}
}

const initialize = (send, protocolVersion) =>
	send("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "protocol-2026-test", version: "0" } });

// ---------- 1. non-regression: the 2025-era handshake ----------

for (const revision of LEGACY_REVISIONS) {
	test(`initialize with ${revision} is accepted and echoed back (non-regression)`, async () => {
		await withSession(async ({ send, notify }) => {
			const reply = await initialize(send, revision);
			assert.ok(!reply.error, JSON.stringify(reply.error));
			assert.equal(reply.result.protocolVersion, revision);
			assert.equal(reply.result.serverInfo.name, "codecartographer");
			assert.deepEqual(Object.keys(reply.result.capabilities), ["tools"]);
			notify("notifications/initialized");
			const listed = await send("tools/list", {});
			assert.ok(listed.result.tools.length >= 22, `expected the full inventory, got ${listed.result.tools.length}`);
			// A 2025-era response carries none of the 2026-era result vocabulary.
			assert.equal(listed.result.resultType, undefined);
			assert.equal(listed.result.ttlMs, undefined);
		});
	});
}

test("initialize with an unknown revision negotiates down to the newest legacy revision", async () => {
	await withSession(async ({ send }) => {
		// A client that names the modern revision through the LEGACY handshake is
		// still a legacy client (the modern era opens with server/discover, not
		// initialize): the SDK v1 and v2 lines both answer with the newest
		// revision they serve on initialize.
		const reply = await initialize(send, MODERN_REVISION);
		assert.ok(!reply.error, JSON.stringify(reply.error));
		assert.equal(reply.result.protocolVersion, "2025-11-25");
	});
});

// ---------- 2. the 2026-07-28 era ----------

test("server/discover answers with the modern revision, capabilities and instructions", async () => {
	await withSession(async ({ send }) => {
		const reply = await send("server/discover", envelope());
		assert.ok(!reply.error, `server/discover failed: ${JSON.stringify(reply.error)}`);
		assert.deepEqual(reply.result.supportedVersions, [MODERN_REVISION]);
		assert.deepEqual(Object.keys(reply.result.capabilities), ["tools"]);
		assert.equal(reply.result.resultType, "complete");
		assert.equal(typeof reply.result.ttlMs, "number");
		assert.ok(["public", "private"].includes(reply.result.cacheScope));
		assert.equal(reply.result._meta[SERVER_INFO_META_KEY].name, "codecartographer");
	});
});

test("tools/list in the modern era carries resultType, caching hints and serverInfo", async () => {
	await withSession(async ({ send }) => {
		await send("server/discover", envelope());
		const listed = await send("tools/list", envelope());
		assert.ok(!listed.error, JSON.stringify(listed.error));
		assert.equal(listed.result.resultType, "complete");
		// The inventory is static for the life of the process: cache it long
		// and share it, as the issue's P1 item specifies.
		assert.equal(listed.result.cacheScope, "public");
		assert.ok(listed.result.ttlMs >= 60_000, `ttlMs ${listed.result.ttlMs} is not a long TTL`);
		assert.equal(listed.result._meta[SERVER_INFO_META_KEY].name, "codecartographer");
		assert.ok(listed.result.tools.length >= 22);
	});
});

test("tools/call in the modern era returns resultType 'complete' with both content halves", async () => {
	await withSession(async ({ send }) => {
		await send("server/discover", envelope());
		const called = await send("tools/call", envelope({ name: "codecarto_guide", arguments: {} }));
		assert.ok(!called.error, JSON.stringify(called.error));
		assert.equal(called.result.resultType, "complete");
		assert.equal(called.result.content[0].type, "text");
		// issue #94's failure mode must survive the new era's projection too.
		assert.equal(typeof called.result.structuredContent.text, "string");
		assert.equal(called.result._meta[SERVER_INFO_META_KEY].name, "codecartographer");
	});
});

test("a tool refusal in the modern era is still a JSON-RPC error with the standard code", async () => {
	await withSession(async ({ send }) => {
		await send("server/discover", envelope());
		const refused = await send("tools/call", envelope({ name: "codecarto_status", arguments: { cwd: "relative/path" } }));
		assert.ok(refused.error, "a bad cwd must be a JSON-RPC error");
		assert.equal(refused.error.code, -32602, "InvalidParams keeps the JSON-RPC standard code");
		const unknown = await send("tools/call", envelope({ name: "codecarto_no_such_tool", arguments: {} }));
		assert.equal(unknown.error.code, -32601, "an unknown tool is MethodNotFound");
	});
});

test("a client that probes with server/discover and then falls back to initialize is served the 2025 era", async () => {
	await withSession(async ({ send, notify }) => {
		// A probe alone does not pin the connection: a negotiating client that
		// discovers, decides it prefers the legacy handshake, and sends
		// `initialize` must still be served (the SDK discards the probe instance
		// and pins a legacy one).
		await send("server/discover", envelope());
		const fallback = await initialize(send, "2025-11-25");
		assert.ok(!fallback.error, JSON.stringify(fallback.error));
		assert.equal(fallback.result.protocolVersion, "2025-11-25");
		notify("notifications/initialized");
		const listed = await send("tools/list", {});
		assert.ok(listed.result.tools.length >= 22);
		assert.equal(listed.result.resultType, undefined, "a legacy-pinned connection carries no 2026 vocabulary");
	});
});

test("a 2025-era initialize on a modern-PINNED connection is refused, not mis-served", async () => {
	await withSession(async ({ send }) => {
		await send("server/discover", envelope());
		// An envelope-bearing request after the probe pins the modern era.
		const listed = await send("tools/list", envelope());
		assert.equal(listed.result.resultType, "complete");
		const late = await initialize(send, "2025-11-25");
		assert.ok(late.error, "the era is decided by the opening exchange");
		assert.deepEqual(late.error.data.supported, [MODERN_REVISION]);
		assert.equal(late.error.data.requested, "2025-11-25");
	});
});

// ---------- 3. verify item: inputSchema under JSON Schema 2020-12 ----------

// Keywords that Draft-07 accepted and 2020-12 removed or renamed. Under the
// 2020-12 default a validator silently ignores them, which turns a constraint
// into no constraint.
const DRAFT07_ONLY_KEYWORDS = new Set(["definitions", "dependencies", "additionalItems", "id"]);

function* walk(node, path = "") {
	if (Array.isArray(node)) {
		for (const [i, child] of node.entries()) yield* walk(child, `${path}[${i}]`);
		return;
	}
	if (node === null || typeof node !== "object") return;
	yield [path, node];
	for (const [key, child] of Object.entries(node)) {
		// Property NAMES under `properties` are not keywords.
		if (key === "properties" && child && typeof child === "object") {
			for (const [name, sub] of Object.entries(child)) yield* walk(sub, `${path}.properties.${name}`);
			continue;
		}
		yield* walk(child, `${path}.${key}`);
	}
}

test("every advertised inputSchema is valid under JSON Schema 2020-12 (no Draft-07-only keywords)", async () => {
	await withSession(async ({ send, notify }) => {
		await initialize(send, "2025-11-25");
		notify("notifications/initialized");
		const listed = await send("tools/list", {});
		const problems = [];
		for (const tool of listed.result.tools) {
			assert.equal(tool.inputSchema.type, "object", `${tool.name}: inputSchema.type`);
			for (const [path, node] of walk(tool.inputSchema, tool.name)) {
				for (const key of Object.keys(node)) {
					if (DRAFT07_ONLY_KEYWORDS.has(key)) problems.push(`${path}: ${key}`);
					if (key === "$ref" && String(node[key]).includes("#/definitions/")) problems.push(`${path}: $ref into definitions`);
				}
				// Draft-07 tuple form `items: [...]` became `prefixItems` in 2020-12.
				if (Array.isArray(node.items)) problems.push(`${path}: items as array`);
			}
		}
		assert.deepEqual(problems, []);
	});
});
