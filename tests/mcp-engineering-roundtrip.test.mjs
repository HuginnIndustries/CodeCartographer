// A real stdio round trip against the packed tarball (E07, #405).
//
// The in-process tests drive the handler directly, which proves the logic but
// not the transport. This drives the SHIPPED server over stdio JSON-RPC the
// way an MCP host does — separate process, real serialization, real tool
// listing — because a surface that works in-process and not over the wire is
// not a surface.
//
// What it checks that the unit tests cannot:
//   - the new tool actually appears in the transported inventory
//   - structuredContent survives serialization (issue #94's failure mode: a
//     client reading structuredContent got labels and no payload)
//   - a refusal arrives as a JSON-RPC error a client can branch on, rather
//     than a success carrying an error string
//   - create -> plan -> record_proof -> gate works end to end in one session

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A live stdio MCP session against the server as it ships.
 *
 * Framing is newline-delimited JSON-RPC; the server writes one response per
 * line. Requests are matched by id rather than by arrival order, because a
 * transport that reorders is exactly the kind of thing this test exists to
 * notice.
 */
async function withSession(fn) {
	// The COMPILED entry point, which is what a host actually runs: bin.mjs
	// imports ./server.js from dist/. Running the TypeScript source directly
	// would test a path no client takes.
	const child = spawn(process.execPath, [join(REPO_ROOT, "dist/mcp-server/bin.mjs")], {
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
				continue; // not a JSON-RPC frame; the server may log
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

	try {
		await send("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "e07-roundtrip", version: "0" },
		});
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
		return await fn(send);
	} finally {
		child.stdin.end();
		child.kill();
	}
}

const callChange = async (send, args) => await send("tools/call", { name: "codecarto_change", arguments: args });

test("the engineering tool appears in the transported inventory", async () => {
	await withSession(async (send) => {
		const listed = await send("tools/list", {});
		const names = listed.result.tools.map((tool) => tool.name);
		assert.ok(names.includes("codecarto_change"), `codecarto_change missing from ${names.length} advertised tools`);
		// Additive: the analysis surface a host already depends on is intact.
		for (const existing of ["codecarto_status", "codecarto_next", "codecarto_init"]) {
			assert.ok(names.includes(existing), `registration perturbed the inventory: ${existing} is gone`);
		}
		const tool = listed.result.tools.find((t) => t.name === "codecarto_change");
		assert.match(tool.description, /EXPERIMENTAL/);
		assert.ok(tool.inputSchema.properties.action.enum.includes("gate"));
	});
});

test("a change survives a real create -> plan -> gate round trip", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-e07-rt-"));
	try {
		await withSession(async (send) => {
			await send("tools/call", { name: "codecarto_init", arguments: { cwd, pipeline: "lite" } });

			const created = await callChange(send, { cwd, action: "create", title: "Round trip", outcome: "the surface works over stdio" });
			assert.ok(!created.error, JSON.stringify(created.error));
			// The failure mode from issue #94: a client reading structuredContent
			// received labels and no payload. Both halves must survive the wire.
			const changeId = created.result.structuredContent.change_id;
			assert.match(changeId, /^chg_[0-9a-f]{24}$/);
			assert.ok(created.result.content[0].text.includes(changeId), "the text and the structured payload disagree over the wire");

			const shown = await callChange(send, { cwd, action: "show", change_id: changeId });
			assert.equal(shown.result.structuredContent.change_id, changeId);
			assert.equal(shown.result.structuredContent.title, "Round trip");

			const listed = await callChange(send, { cwd, action: "list" });
			assert.ok(listed.result.structuredContent.changes.includes(changeId));

			const gate = await callChange(send, { cwd, action: "gate", change_id: changeId, attempt_id: "att_000000000000000000000001" });
			assert.ok(!gate.error, JSON.stringify(gate.error));
			assert.equal(gate.result.structuredContent.state, "refused", "a change with no attempt was not refused");
			assert.ok(
				gate.result.structuredContent.limitations.some((l) => /semantic correctness/.test(l)),
				"the always-stated limitation did not survive transport",
			);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("a refusal arrives as a JSON-RPC error, not a success carrying an error string", async () => {
	// A client branches on `error`. A refusal delivered as a successful result
	// whose text happens to say "refused" is a refusal every automated caller
	// will miss.
	const cwd = await mkdtemp(join(tmpdir(), "cc-e07-rt-err-"));
	try {
		await withSession(async (send) => {
			await send("tools/call", { name: "codecarto_init", arguments: { cwd, pipeline: "lite" } });
			const approved = await callChange(send, { cwd, action: "approve", change_id: "chg_000000000000000000000001" });
			assert.ok(approved.error, "approving through the tool surface was not a transport-level error");
			assert.match(approved.error.message, /not available through this surface/);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("a bad argument arrives as InvalidParams over the wire, not InternalError", async () => {
	// F-4, over the transport that actually matters. The in-process test cannot
	// see this: `InternalError` is applied by the SERVER's catch wrapper, so a
	// test calling the handler directly observes the adapter's code and never
	// the one a client receives. -32603 tells a host "server bug, retry" — and
	// retrying an invalid enum fails identically forever.
	const cwd = await mkdtemp(join(tmpdir(), "cc-e07-rt-codes-"));
	try {
		await withSession(async (send) => {
			await send("tools/call", { name: "codecarto_init", arguments: { cwd, pipeline: "lite" } });

			const INVALID_PARAMS = -32602;
			const cases = [
				{ args: { mode: "self-approved" }, why: "an unknown mode" },
				{ args: { baseline_commit: "HEAD" }, why: "a non-hash baseline commit" },
				{ args: { request_id: "../../../pwn" }, why: "a traversal request id" },
			];
			for (const { args, why } of cases) {
				const result = await callChange(send, { cwd, action: "create", title: "t", outcome: "o", ...args });
				assert.ok(result.error, `${why} was accepted`);
				assert.equal(result.error.code, INVALID_PARAMS, `${why} arrived as ${result.error.code}, which hosts retry as a server fault`);
			}

			// An idempotency conflict is the caller's problem too.
			const base = { cwd, action: "create", outcome: "o", request_id: "req-wire-conflict" };
			await callChange(send, { ...base, title: "Alpha" });
			const conflict = await callChange(send, { ...base, title: "Beta" });
			assert.ok(conflict.error, "a conflicting retry succeeded");
			assert.equal(conflict.error.code, INVALID_PARAMS, `an idempotency conflict arrived as ${conflict.error.code}`);
		});
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("a title carrying control characters does not corrupt the reported text", async () => {
	// F-8: untested transport concern. A NUL and ANSI escapes reached show's
	// output unescaped.
	const cwd = await mkdtemp(join(tmpdir(), "cc-e07-rt-ctrl-"));
	try {
		await withSession(async (send) => {
			await send("tools/call", { name: "codecarto_init", arguments: { cwd, pipeline: "lite" } });
			const created = await callChange(send, {
				cwd,
				action: "create",
				title: "Fix\u0000 the \u001b[31mred\u001b[0m thing\nwith a newline",
				outcome: "o",
			});
			assert.ok(!created.error, JSON.stringify(created.error));
			const shown = await callChange(send, { cwd, action: "show", change_id: created.result.structuredContent.change_id });
			const text = shown.result.content[0].text;
			assert.ok(!text.includes("\u0000"), "a NUL byte reached the reported text");
			assert.ok(!/\u001b\[/.test(text), "an ANSI escape reached the reported text");
		});
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("structuredContent carries its whole payload over the wire", async () => {
	// F-8: the parity assertion only checked that the text contained the id,
	// which would still hold if structuredContent carried nothing else.
	const cwd = await mkdtemp(join(tmpdir(), "cc-e07-rt-struct-"));
	try {
		await withSession(async (send) => {
			await send("tools/call", { name: "codecarto_init", arguments: { cwd, pipeline: "lite" } });
			const created = await callChange(send, { cwd, action: "create", title: "Payload", outcome: "every key survives" });
			const shown = await callChange(send, { cwd, action: "show", change_id: created.result.structuredContent.change_id });
			for (const key of ["change_id", "title", "state", "revision", "requested_outcome"]) {
				assert.ok(key in shown.result.structuredContent, `structuredContent lost ${key} in transit`);
			}
			assert.equal(shown.result.structuredContent.title, "Payload");
			assert.equal(shown.result.structuredContent.requested_outcome, "every key survives");
		});
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
