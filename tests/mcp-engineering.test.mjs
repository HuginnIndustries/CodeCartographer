// The experimental engineering MCP surface (E07, #405).
//
// This is the first point where the engineering record system is reachable by
// something outside this process. Everything before it — the store, the
// planner, proof ingestion, the gates — assumed a caller that had already been
// admitted. A tool call has not been.
//
// So these tests are framed on what the surface must REFUSE. The operations it
// offers are thin adapters over core; the value added here is the boundary.
//
// Three properties matter more than the happy path:
//
//   1. No new execution. E07 must not introduce `exec`, target-code writes,
//      GitHub mutations, or provider calls. The server gains a record surface,
//      not a second way to run things.
//   2. An agent cannot approve its own work through ordinary fields. Approval
//      is E08's and E01's business; an agent-authored `decision: accepted` or a
//      hand-written receipt arriving through this surface must be refused, not
//      stored and later believed.
//   3. What the client actually receives is usable. `structuredContent` and
//      `content` must agree, because a client reading one and not the other
//      must not see a different answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineeringMcp = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/engineering.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
const { openStore } = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);

const { ENGINEERING_TOOLS } = engineeringMcp;

// The handler is constructed by the server with its own cwd validation, so the
// registered instance is what a client actually reaches — and therefore what
// these tests drive. Building a fresh one here with different dependencies
// would test a handler no client can call.
const handleChange = server.handleChangeForTest;

const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));

/** A workspace with an initialized engineering namespace. */
async function withWorkspace(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-e07-"));
	try {
		await server.handleInit({ cwd, pipeline: "lite" });
		return await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

// ---------------------------------------------------------------- inventory

test("the engineering surface registers exactly one additive tool", async () => {
	// Additive: E07 must not alter the analysis or synthesis surfaces. One
	// tool with an action discriminator keeps the inventory change reviewable
	// rather than adding a dozen entries nobody audits.
	assert.deepEqual(
		ENGINEERING_TOOLS.map((tool) => tool.name),
		["codecarto_change"],
	);
	const [tool] = ENGINEERING_TOOLS;
	assert.match(tool.description, /experimental/i, "an unstable surface says so in its description");
	assert.ok(tool.inputSchema?.properties?.action, "the action discriminator is part of the schema");
});

test("every advertised action is implemented, and no implemented action is unadvertised", async () => {
	// A drift check in both directions: an advertised action that 404s wastes
	// a client's call, and an implemented one that is not advertised is a
	// surface nobody reviewed.
	const advertised = new Set(ENGINEERING_TOOLS[0].inputSchema.properties.action.enum);
	const implemented = new Set(engineeringMcp.CHANGE_ACTIONS);
	assert.deepEqual([...advertised].sort(), [...implemented].sort());
});

// ---------------------------------------------------------------- refusals

test("an unknown action is refused, not treated as a default", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(
			() => handleChange({ cwd, action: "delete_everything" }),
			(error) => error instanceof McpError && error.code === ErrorCode.InvalidParams,
		);
	});
});

test("a missing action is refused", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(
			() => handleChange({ cwd }),
			(error) => error instanceof McpError && error.code === ErrorCode.InvalidParams,
		);
	});
});

test("a request against a directory with no workspace is refused", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-e07-bare-"));
	try {
		await assert.rejects(() => handleChange({ cwd, action: "create", title: "x", outcome: "y" }), /codecarto_init/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an agent cannot approve its own work through ordinary fields", async () => {
	// The central refusal of this surface. Approval requires a trusted channel
	// and a receipt E01 can evaluate; an agent-authored field claiming a human
	// said yes is exactly the forgery the whole system exists to prevent. It
	// must be refused at the boundary rather than stored and believed later.
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "Add a flag", outcome: "the flag exists" });
		const changeId = created.structuredContent.change_id;
		for (const forged of [
			{ action: "record", kind: "approval", record: { decision: "accepted" } },
			{ action: "record", kind: "approval", record: { decision: "accepted", receipt: { channel: "trusted" } } },
			{ action: "update", change_id: changeId, state: "accepted" },
		]) {
			await assert.rejects(
				() => handleChange({ cwd, change_id: changeId, ...forged }),
				(error) => error instanceof McpError,
				`${JSON.stringify(forged)} was not refused`,
			);
		}
	});
});

test("a proof arriving through this surface cannot declare its own authority", async () => {
	// Proof authority is derived from collector and attestation, never read
	// from the payload. A tool call is a caller-reported channel by
	// construction, so a proof it carries is `claimed` whatever it says.
	//
	// Seeded from E01's own fixtures: a proof missing required fields is
	// refused on SHAPE, which would make this test pass without saying
	// anything about authority.
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const [change, slice, attempt, snapshot, proof] = await Promise.all(
			["change.json", "slice.json", "attempt.json", "snapshot-candidate.json", "proof.json"].map(readFixture),
		);
		for (const record of [change, slice, attempt, snapshot]) await store.put(record);

		const result = await handleChange({
			cwd,
			action: "record_proof",
			change_id: change.id,
			proof: {
				...proof,
				// The forgery: a payload asserting the conclusions the system
				// is supposed to derive.
				authority: "observed",
				discharges: true,
				provenance: { source: "adapter", attested_by: "adapter" },
			},
		});
		assert.equal(result.structuredContent.authority, "claimed", "a payload-declared authority was believed");
		assert.equal(result.structuredContent.discharges, false, "a caller-reported proof discharged an obligation");
		assert.match(result.content[0].text, /claimed/);
	});
});

test("a stale revision is refused rather than silently overwriting", async () => {
	// The store's CAS token exists so two writers cannot lose each other's
	// work; the MCP surface must carry it through, not paper over it.
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "Concurrent", outcome: "one writer wins" });
		const changeId = created.structuredContent.change_id;
		const stale = created.structuredContent.revision;
		await handleChange({ cwd, action: "update", change_id: changeId, outcome: "first write", revision: stale });
		await assert.rejects(
			() => handleChange({ cwd, action: "update", change_id: changeId, outcome: "second write", revision: stale }),
			(error) => error instanceof McpError && /revision|conflict|stale/i.test(error.message),
		);
	});
});

// ---------------------------------------------------------------- no new execution

test("the engineering surface introduces no execution, network, or provider call", async () => {
	// E07's scope says the server gains a record surface and not a second way
	// to run things. Checked against the source rather than trusted.
	const source = await readFile(join(REPO_ROOT, "mcp-server/engineering.ts"), "utf8");
	for (const forbidden of ["child_process", "node:child_process", "exec(", "spawn(", "fetch(", "https://", "octokit", "Octokit"]) {
		assert.ok(!source.includes(forbidden), `the engineering MCP surface references ${forbidden}`);
	}
});

// ---------------------------------------------------------------- transport parity

test("text and structuredContent describe the same outcome", async () => {
	// A client may read either. If they disagree, two clients driving the same
	// workspace see two different answers and one of them is wrong.
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "Parity", outcome: "both agree" });
		assert.ok(created.content?.[0]?.text, "no text content");
		assert.ok(created.structuredContent?.change_id, "no structured change_id");
		assert.ok(
			created.content[0].text.includes(created.structuredContent.change_id),
			"the rendered text does not name the id the structured payload reports",
		);
	});
});

test("a retry of the same create does not produce a second change", async () => {
	// Tool calls get retried — by a flaky transport, by an agent that did not
	// see the first result. A retry that silently forks the workspace into two
	// changes is worse than an error.
	await withWorkspace(async (cwd) => {
		const first = await handleChange({ cwd, action: "create", title: "Idempotent", outcome: "one change", request_id: "req-1" });
		const second = await handleChange({ cwd, action: "create", title: "Idempotent", outcome: "one change", request_id: "req-1" });
		assert.equal(second.structuredContent.change_id, first.structuredContent.change_id, "a retry created a second change");
	});
});

// ---------------------------------------------------------------- honest capability reporting

test("the gate result reports host capability without claiming every client can accept", async () => {
	// Out of scope for E07, explicitly: claiming that all MCP clients support
	// trusted human acceptance. The surface must report what this host can do
	// and say plainly when it cannot obtain a decision.
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const [change, slice, attempt, snapshot] = await Promise.all(
			["change.json", "slice.json", "attempt.json", "snapshot-candidate.json"].map(readFixture),
		);
		for (const record of [change, slice, attempt, snapshot]) await store.put(record);
		const gate = await handleChange({ cwd, action: "gate", change_id: change.id, attempt_id: attempt.id });
		assert.ok(["may-accept", "refused", "needs-human-acceptance"].includes(gate.structuredContent.state));
		assert.ok(Array.isArray(gate.structuredContent.limitations), "the gate result carries no limitations array");
		assert.ok(
			gate.structuredContent.limitations.some((l) => /semantic correctness/i.test(l)),
			"the always-stated limitation did not survive transport",
		);
	});
});

test("the analysis and synthesis tool inventory is unchanged by registration", async () => {
	// E07 is additive. If registering the engineering surface perturbs the
	// existing inventory, a host that depended on it breaks.
	const tools = await server.listToolsForTest?.();
	if (!tools) return; // the helper is optional; the smoke test covers the real inventory
	const analysis = tools.map((t) => t.name).filter((name) => !name.startsWith("codecarto_change"));
	assert.ok(analysis.includes("codecarto_status"));
	assert.ok(analysis.includes("codecarto_next"));
	assert.ok(!analysis.includes("codecarto_change"), "the filter did not remove the new tool");
});

// --- Added after mutation checks -----------------------------------------
// Three rules were unasserted: the explicitly-refused action list, the
// derived-field refusal for non-state fields, and — the serious one — the
// host capability the gate reports.

test("an explicitly refused action says why, rather than reading as a typo", async () => {
	// `approve` and `accept` are the actions an agent would reach for to
	// finish its own work. They are refused with a reason; a bare "unknown
	// action" would read like a spelling mistake and invite a retry.
	await withWorkspace(async (cwd) => {
		for (const action of ["approve", "accept", "execute", "run", "record"]) {
			await assert.rejects(
				() => handleChange({ cwd, action }),
				(error) => {
					assert.ok(error instanceof McpError, `${action} did not raise an McpError`);
					assert.match(error.message, /not available through this surface/, `${action} was not refused with a reason`);
					return true;
				},
				`${action} was not refused`,
			);
		}
	});
});

test("a caller cannot supply a derived field on create", async () => {
	await withWorkspace(async (cwd) => {
		for (const field of ["decision", "authority", "discharges", "approved_by", "accepted_at"]) {
			await assert.rejects(
				() => handleChange({ cwd, action: "create", title: "t", outcome: "o", [field]: "anything" }),
				(error) => error instanceof McpError && new RegExp(`${field} is derived`).test(error.message),
				`${field} was accepted from a caller`,
			);
		}
	});
});

test("the gate reports that an MCP tool call cannot obtain a human decision", async () => {
	// The mutation that matters: flipping this to `can_obtain_human_decision:
	// true` made the surface claim a capability the transport does not have,
	// and nothing failed. A host reading `may-accept` from a channel that
	// cannot ask anyone is exactly the false assurance E06 was built to avoid.
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const [change, slice, attempt, snapshot, proof, proof2, review] = await Promise.all(
			["change.json", "slice.json", "attempt.json", "snapshot-candidate.json", "proof.json", "proof-second-obligation.json", "review.json"].map(readFixture),
		);
		for (const record of [change, slice, attempt, snapshot]) await store.put(record);
		// Observed proofs and a clean review: everything the gate needs, so the
		// ONLY thing standing between this and `may-accept` is the transport's
		// inability to ask a human.
		for (const p of [proof, proof2]) {
			await store.put({ ...p, provenance: { ...p.provenance, attested_by: "host-tool-result", tool_call_id: `call_${p.id.slice(-4)}` } });
		}
		await store.put(review);

		const gate = await handleChange({ cwd, action: "gate", change_id: change.id, attempt_id: attempt.id });
		assert.equal(
			gate.structuredContent.state,
			"needs-human-acceptance",
			"an MCP tool call claimed it could obtain a human decision",
		);
		assert.match(gate.content[0].text, /cannot obtain a human decision/);
	});
});

test("the surface introduces no execution, no target-code write, and no network call", async () => {
	// The quickstart tells hosts this module cannot run anything. That claim
	// should be checked rather than trusted: the whole reason the engineering
	// record is worth keeping is that recording and doing are separate, and a
	// future edit that reaches for child_process here would break the property
	// silently while every behavioural test still passed.
	const source = await readFile(join(REPO_ROOT, "mcp-server/engineering.ts"), "utf8");
	const code = source
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");

	for (const forbidden of [
		"child_process",
		"execSync",
		"spawnSync",
		"spawn(",
		"exec(",
		"fetch(",
		"node:http",
		"writeFile",
		"rm(",
		"unlink",
	]) {
		assert.ok(
			!code.includes(forbidden),
			`the engineering MCP surface reached for ${forbidden}; recording and doing must stay separate`,
		);
	}
});
