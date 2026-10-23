// `codecarto_change` action `next` (#458): the traverse planner's answer over
// the real stdio transport, read-only.
//
// Three properties, each pinned by a test a plausible mutant fails:
//
//   1. It writes NOTHING. Every file and directory under the temporary
//      workspace (path, size, bytes, mtime; the whole cwd, not only
//      .codecarto/) is the same after `next` as before, and a workspace with
//      no engineering directory still has none afterwards.
//   2. Bounds are refused exactly as the planner refuses them, and as the
//      CALLER's error (InvalidParams), not an internal failure: NaN,
//      Infinity, zero, negative, fractional attempts, missing, wrong type.
//   3. can_obtain_human_decision is not taken on the caller's word: a client
//      that did not declare elicitation.form cannot reach a person through
//      this surface, so a caller's `true` is treated as false (AND, never OR).
//
// The server under test is the COMPILED one (dist/), served by the same
// test-only launcher the acceptance tests use, so the client's declared
// capabilities at initialize are what the session sees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPO_ROOT, "tests/helpers/acceptance-server.mjs");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, planTraverseStep } = engineering;
const { handleChangeForTest: handleChange, handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { ProtocolError, ProtocolErrorCode } = await import("@modelcontextprotocol/server");

const INVALID_PARAMS = -32602;
const SCENARIOS = [{ id: "S1", kind: "behavior", description: "count() counts every item" }];
const SLICE = {
	title: "Count",
	deliverable: "count() is exported and counts",
	scenario_ids: ["S1"],
	proof_obligations: [{ id: "O1", scenario_id: "S1", check_kind: "test", description: "node --test passes", minimum_collector: "host-observed" }],
	permitted_scope: { paths: ["count.js"] },
};
const GOOD = { max_attempts: 3, max_wall_clock_ms: 60_000, can_execute: true, can_obtain_human_decision: true };

async function withWorkspace(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-next-"));
	try {
		await handleInit({ cwd, pipeline: "lite" });
		return await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/** A stdio session against the compiled server; `capabilities` is what the client declares at initialize. */
async function withClient({ capabilities = {} } = {}, fn) {
	const child = spawn(process.execPath, [LAUNCHER], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
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
	/** `rawArguments` is spliced in verbatim, so a frame can carry `1e309` (which JSON.parse reads as Infinity). */
	const send = (method, params, rawArguments) => {
		const id = nextId++;
		let frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		if (rawArguments !== undefined) frame = frame.replace('"__RAW__"', rawArguments);
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectPromise(new Error(`timed out waiting for ${method}; stderr: ${stderr.join("")}`));
			}, 30_000);
			pending.set(id, (message) => {
				clearTimeout(timer);
				resolvePromise(message);
			});
			child.stdin.write(`${frame}\n`);
		});
	};
	const call = (args) => send("tools/call", { name: "codecarto_change", arguments: args });
	const callRaw = (raw) => send("tools/call", { name: "codecarto_change", arguments: "__RAW__" }, raw);
	try {
		const init = await send("initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "next-test", version: "0" } });
		assert.ok(!init.error, JSON.stringify(init.error));
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		return await fn({ call, callRaw, stderr });
	} finally {
		child.stdin.end();
		child.kill();
	}
}

/** Every file and directory under `root`, with bytes and mtime: what "writes nothing" is checked against. */
async function treeState(root) {
	const out = {};
	async function walk(dir) {
		for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			const info = await stat(full);
			if (entry.isDirectory()) {
				out[`${full}/`] = `${info.mtimeMs}:${info.size}`;
				await walk(full);
			} else {
				out[full] = `${info.mtimeMs}:${info.size}:${(await readFile(full)).toString("base64")}`;
			}
		}
	}
	await walk(root);
	return out;
}

/** create -> plan over the wire; returns the change and slice ids. */
async function plannedChange(call, cwd) {
	const created = await call({ cwd, action: "create", title: "Count widgets", outcome: "count() counts" });
	assert.ok(!created.error, JSON.stringify(created.error));
	const { change_id, revision } = created.result.structuredContent;
	const planned = await call({ cwd, action: "plan", change_id, revision, acceptance_scenarios: SCENARIOS, slices: [SLICE] });
	assert.ok(!planned.error, JSON.stringify(planned.error));
	return { changeId: change_id, sliceId: planned.result.structuredContent.slice_ids[0] };
}

/** An attempt whose outcome is ready-for-review: the point where the planner first asks whether a person can be reached. */
async function seedReadyForReview(cwd, changeId, sliceId) {
	const fixture = JSON.parse(await readFile(join(REPO_ROOT, "tests/fixtures/engineering/v1/valid/attempt.json"), "utf8"));
	const store = await openStore(join(cwd, ".codecarto"));
	await store.put({ ...fixture, change_id: changeId, slice_id: sliceId, outcome: "ready-for-review" });
	return fixture.id;
}

test("next is advertised in the tool schema with the planner's inputs", async () => {
	const { ENGINEERING_TOOLS, CHANGE_ACTIONS } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/engineering.ts`).href);
	assert.ok(CHANGE_ACTIONS.includes("next"));
	const schema = ENGINEERING_TOOLS[0].inputSchema.properties;
	assert.ok(schema.action.enum.includes("next"));
	for (const field of ["max_attempts", "max_wall_clock_ms", "can_execute", "can_obtain_human_decision"]) assert.ok(schema[field], `${field} missing from the schema`);
	assert.match(ENGINEERING_TOOLS[0].description, /EXPERIMENTAL/);
	assert.match(ENGINEERING_TOOLS[0].description, /next is read-only/);
});

test("next on a freshly planned change returns start-attempt in content and structuredContent, and writes nothing", async () => {
	await withWorkspace(async (cwd) => {
		await withClient({}, async ({ call }) => {
			const { changeId } = await plannedChange(call, cwd);
			const before = await treeState(cwd);
			const first = await call({ cwd, action: "next", change_id: changeId, ...GOOD });
			assert.ok(!first.error, JSON.stringify(first.error));
			const s = first.result.structuredContent;
			assert.equal(s.action, "start-attempt");
			assert.equal(s.stop_reason, undefined);
			assert.equal(s.change_id, changeId);
			assert.match(s.idempotency_key, /\S/);
			assert.ok(Array.isArray(s.history));
			assert.ok(s.bounds.limits.some((l) => /attempts remaining 3/.test(l)), JSON.stringify(s.bounds));
			assert.ok(s.bounds.limits.some((l) => /wall clock 60000 ms/.test(l)), JSON.stringify(s.bounds));
			assert.match(s.rationale, /no open attempt/);
			const text = first.result.content[0].text;
			assert.match(text, /Next: start-attempt\./);
			assert.ok(text.includes(s.idempotency_key), "the text and structuredContent disagree on the key");
			assert.ok(text.includes(s.rationale), "the text omits the rationale");

			// Same records, same answer: a host retrying recognizes its own step.
			const second = await call({ cwd, action: "next", change_id: changeId, ...GOOD });
			assert.equal(second.result.structuredContent.idempotency_key, s.idempotency_key);

			// The direct planner call agrees with what the transport returned.
			const direct = await planTraverseStep(await openStore(join(cwd, ".codecarto")), { change_id: changeId, host: { can_execute: true, can_obtain_human_decision: false, storage: { boundary: "none" }, bounds: { max_attempts: 3, max_wall_clock_ms: 60_000 } } });
			assert.equal(direct.action, s.action);
			assert.equal(direct.idempotency_key, s.idempotency_key);

			assert.deepEqual(await treeState(cwd), before, "next changed a file or directory in the workspace");
		});
	});
});

test("next on an unknown change is a stop with its reason, not an error", async () => {
	await withWorkspace(async (cwd) => {
		await withClient({}, async ({ call }) => {
			const out = await call({ cwd, action: "next", change_id: "chg_ffffffffffffffffffffffff", ...GOOD });
			assert.ok(!out.error, JSON.stringify(out.error));
			assert.equal(out.result.structuredContent.action, "stop");
			assert.equal(out.result.structuredContent.stop_reason, "unknown-change");
			assert.match(out.result.content[0].text, /Next: stop \(unknown-change\)/);
		});
	});
});

test("bad bounds, capabilities and fields are refused as InvalidParams over the wire, and nothing is written", async () => {
	await withWorkspace(async (cwd) => {
		await withClient({}, async ({ call, callRaw }) => {
			const { changeId } = await plannedChange(call, cwd);
			const before = await treeState(cwd);
			const base = { cwd, action: "next", change_id: changeId, ...GOOD };
			const without = (field) => {
				const copy = { ...base };
				delete copy[field];
				return copy;
			};
			const cases = {
				"max_attempts missing": without("max_attempts"),
				"max_wall_clock_ms missing": without("max_wall_clock_ms"),
				"max_attempts 0": { ...base, max_attempts: 0 },
				"max_attempts negative": { ...base, max_attempts: -1 },
				"max_attempts fractional": { ...base, max_attempts: 1.5 },
				"max_attempts string": { ...base, max_attempts: "3" },
				"max_attempts null (NaN on the wire)": { ...base, max_attempts: null },
				"max_attempts boolean": { ...base, max_attempts: true },
				"max_wall_clock_ms 0": { ...base, max_wall_clock_ms: 0 },
				"max_wall_clock_ms negative": { ...base, max_wall_clock_ms: -5 },
				"max_wall_clock_ms string": { ...base, max_wall_clock_ms: "60000" },
				"max_wall_clock_ms null": { ...base, max_wall_clock_ms: null },
				"can_execute missing": without("can_execute"),
				"can_execute string": { ...base, can_execute: "yes" },
				"can_obtain_human_decision missing": without("can_obtain_human_decision"),
				"can_obtain_human_decision number": { ...base, can_obtain_human_decision: 1 },
				"change_id missing": without("change_id"),
				// A change_id the planner would read as a record that exists
				// but cannot be read (blocked-needs-operator) is the caller's
				// mistake, refused before any path is built from it.
				"change_id traversing (../../x)": { ...base, change_id: "../../x" },
				"change_id traversing (../../../etc/passwd)": { ...base, change_id: "../../../etc/passwd" },
				"change_id upper case": { ...base, change_id: "CHG_FFFFFFFFFFFFFFFFFFFFFFFF" },
				"change_id of another kind (att_)": { ...base, change_id: "att_ffffffffffffffffffffffff" },
				"change_id naming the lock file": { ...base, change_id: "chg_.lock" },
				"change_id NUL-suffixed": { ...base, change_id: `${changeId}\u0000` },
				"change_id a Windows path": { ...base, change_id: "C:\\x" },
				"change_id 5000 characters": { ...base, change_id: `chg_${"f".repeat(4996)}` },
				"change_id empty": { ...base, change_id: "" },
				"change_id number": { ...base, change_id: 7 },
				"bounds object instead of flat fields": { ...base, bounds: { max_attempts: 3, max_wall_clock_ms: 1 } },
				"host supplied": { ...base, host: { can_obtain_human_decision: true } },
				"elicitation_form supplied": { ...base, elicitation_form: true },
				"derived state supplied": { ...base, state: "accepted" },
				"revision supplied": { ...base, revision: 1 },
			};
			for (const [name, args] of Object.entries(cases)) {
				const out = await call(args);
				assert.equal(out.error?.code, INVALID_PARAMS, `${name}: expected InvalidParams, got ${JSON.stringify(out.error ?? out.result)}`);
			}
			// Infinity cannot be written by JSON.stringify, but `1e309` is valid
			// JSON and parses to Infinity: the bound that reads as a limit and
			// bounds nothing.
			for (const [name, raw] of Object.entries({
				"max_attempts Infinity": JSON.stringify({ ...base, max_attempts: "__INF__" }).replace('"__INF__"', "1e309"),
				"max_wall_clock_ms Infinity": JSON.stringify({ ...base, max_wall_clock_ms: "__INF__" }).replace('"__INF__"', "1e309"),
				"max_wall_clock_ms -Infinity": JSON.stringify({ ...base, max_wall_clock_ms: "__INF__" }).replace('"__INF__"', "-1e309"),
			})) {
				const out = await callRaw(raw);
				assert.equal(out.error?.code, INVALID_PARAMS, `${name}: expected InvalidParams, got ${JSON.stringify(out.error ?? out.result)}`);
			}
			assert.deepEqual(await treeState(cwd), before, "a refused next changed a file or directory in the workspace");
		});
	});
});

test("NaN and Infinity bounds are refused in-process as InvalidParams, for every case the planner itself refuses", async () => {
	// JSON cannot carry NaN, so this drives the registered handler directly.
	// Every case is also handed to the planner: the adapter's restated rule
	// and the planner's must refuse the same inputs, or the two have drifted.
	await withWorkspace(async (cwd) => {
		const created = (await handleChange({ cwd, action: "create", title: "Count widgets", outcome: "count() counts" })).structuredContent;
		await handleChange({ cwd, action: "plan", change_id: created.change_id, revision: created.revision, acceptance_scenarios: SCENARIOS, slices: [SLICE] });
		const store = await openStore(join(cwd, ".codecarto"));
		const bad = [
			{ max_attempts: Number.NaN, max_wall_clock_ms: 60_000 },
			{ max_attempts: 3, max_wall_clock_ms: Number.NaN },
			{ max_attempts: Number.POSITIVE_INFINITY, max_wall_clock_ms: 60_000 },
			{ max_attempts: 3, max_wall_clock_ms: Number.POSITIVE_INFINITY },
			{ max_attempts: 0, max_wall_clock_ms: 60_000 },
			{ max_attempts: 3, max_wall_clock_ms: -1 },
			{ max_attempts: 2.5, max_wall_clock_ms: 60_000 },
			{ max_attempts: "3", max_wall_clock_ms: 60_000 },
			{ max_attempts: undefined, max_wall_clock_ms: 60_000 },
		];
		for (const bounds of bad) {
			await assert.rejects(
				() => planTraverseStep(store, { change_id: created.change_id, host: { can_execute: true, can_obtain_human_decision: false, storage: { boundary: "none" }, bounds } }),
				/real bounds/,
				`the planner accepted ${String(bounds.max_attempts)}/${String(bounds.max_wall_clock_ms)}: the case list no longer matches it`,
			);
			const args = { cwd, action: "next", change_id: created.change_id, can_execute: true, can_obtain_human_decision: false, ...bounds };
			if (bounds.max_attempts === undefined) delete args.max_attempts;
			await assert.rejects(
				() => handleChange(args),
				(error) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams,
				`next accepted ${String(bounds.max_attempts)}/${String(bounds.max_wall_clock_ms)}`,
			);
		}
		// And the good cases are accepted by both, with the same step. A
		// planner that turned stricter (a cap on attempts, a floor on the
		// clock) must fail here rather than leave the adapter promising
		// bounds the planner then refuses as an internal error.
		const good = [
			{ max_attempts: 1, max_wall_clock_ms: 0.5 },
			{ max_attempts: 3, max_wall_clock_ms: 60_000 },
			{ max_attempts: Number.MAX_SAFE_INTEGER, max_wall_clock_ms: 60_000 },
			{ max_attempts: 1e308, max_wall_clock_ms: 60_000 },
			{ max_attempts: 3, max_wall_clock_ms: Number.MAX_SAFE_INTEGER },
			{ max_attempts: 3, max_wall_clock_ms: 1e308 },
			{ max_attempts: 3, max_wall_clock_ms: Number.MIN_VALUE },
			{ max_attempts: 1, max_wall_clock_ms: 1 },
		];
		for (const bounds of good) {
			const label = `${String(bounds.max_attempts)}/${String(bounds.max_wall_clock_ms)}`;
			const direct = await planTraverseStep(store, { change_id: created.change_id, host: { can_execute: true, can_obtain_human_decision: false, storage: { boundary: "none" }, bounds } });
			const ok = await handleChange({ cwd, action: "next", change_id: created.change_id, can_execute: true, can_obtain_human_decision: false, ...bounds });
			assert.equal(direct.action, "start-attempt", `the planner gave ${direct.action} for ${label}`);
			assert.equal(ok.structuredContent.action, direct.action, `next and the planner disagree on ${label}`);
			assert.equal(ok.structuredContent.idempotency_key, direct.idempotency_key, `next and the planner disagree on the key for ${label}`);
			assert.deepEqual(ok.structuredContent.host.bounds, bounds, `next did not pass ${label} through unchanged`);
		}
	});
});

test("next on a workspace with no engineering directory answers unknown-change and does not create it", async () => {
	await withWorkspace(async (cwd) => {
		const engineeringDir = join(cwd, ".codecarto", "engineering");
		await rm(engineeringDir, { recursive: true, force: true });
		const before = await treeState(cwd);
		const absent = async () => {
			await assert.rejects(() => lstat(engineeringDir), (error) => error.code === "ENOENT", "next created .codecarto/engineering");
		};
		const inProcess = await handleChange({ cwd, action: "next", change_id: "chg_ffffffffffffffffffffffff", ...GOOD });
		assert.equal(inProcess.structuredContent.action, "stop");
		assert.equal(inProcess.structuredContent.stop_reason, "unknown-change");
		await absent();
		// A malformed id is still refused, not answered from the empty store.
		await assert.rejects(
			() => handleChange({ cwd, action: "next", change_id: "../../x", ...GOOD }),
			(error) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams,
		);
		await absent();
		await withClient({}, async ({ call }) => {
			const out = await call({ cwd, action: "next", change_id: "chg_ffffffffffffffffffffffff", ...GOOD });
			assert.ok(!out.error, JSON.stringify(out.error));
			assert.equal(out.result.structuredContent.stop_reason, "unknown-change");
		});
		await absent();
		assert.deepEqual(await treeState(cwd), before, "next changed a file or directory in the workspace");
		// Every other action still opens (and creates) the namespace.
		await handleChange({ cwd, action: "list" });
		assert.ok((await lstat(engineeringDir)).isDirectory(), "list no longer creates the engineering directory");
	});
});

test("a client that did not declare elicitation.form cannot obtain a human decision, whatever the caller says", async () => {
	await withWorkspace(async (cwd) => {
		await withClient({ capabilities: {} }, async ({ call }) => {
			const { changeId, sliceId } = await plannedChange(call, cwd);
			const attemptId = await seedReadyForReview(cwd, changeId, sliceId);
			const before = await treeState(cwd);
			const out = await call({ cwd, action: "next", change_id: changeId, ...GOOD, can_obtain_human_decision: true });
			assert.ok(!out.error, JSON.stringify(out.error));
			const s = out.result.structuredContent;
			assert.equal(s.action, "stop", JSON.stringify(s));
			assert.equal(s.stop_reason, "host-cannot-obtain-human-decision");
			assert.match(s.rationale, new RegExp(attemptId));
			assert.equal(s.host.can_obtain_human_decision, false);
			assert.equal(s.host.can_obtain_human_decision_declared, true);
			assert.equal(s.host.elicitation_form, false);
			assert.match(out.result.content[0].text, /did not declare elicitation\.form/);
			assert.deepEqual(await treeState(cwd), before);
		});
	});
});

test("a client that declared elicitation.form: the caller's declaration is ANDed, never overridden upward", async () => {
	await withWorkspace(async (cwd) => {
		await withClient({ capabilities: { elicitation: { form: {} } } }, async ({ call }) => {
			const { changeId, sliceId } = await plannedChange(call, cwd);
			await seedReadyForReview(cwd, changeId, sliceId);
			// Positive control: with the session's channel AND the caller's
			// yes, the planner proceeds past the human check.
			const yes = (await call({ cwd, action: "next", change_id: changeId, ...GOOD, can_obtain_human_decision: true })).result.structuredContent;
			assert.equal(yes.action, "request-review", JSON.stringify(yes));
			assert.equal(yes.host.can_obtain_human_decision, true);
			assert.equal(yes.host.elicitation_form, true);
			// A host that knows its person is unreachable can say so even
			// though its client could elicit.
			const no = (await call({ cwd, action: "next", change_id: changeId, ...GOOD, can_obtain_human_decision: false })).result.structuredContent;
			assert.equal(no.stop_reason, "host-cannot-obtain-human-decision");
		});
	});
});
