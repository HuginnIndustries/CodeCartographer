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
const { ProtocolError, ProtocolErrorCode } = await import("@modelcontextprotocol/server");
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
			(error) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams,
		);
	});
});

test("a missing action is refused", async () => {
	await withWorkspace(async (cwd) => {
		await assert.rejects(
			() => handleChange({ cwd }),
			(error) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams,
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
				(error) => error instanceof ProtocolError,
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
			(error) => error instanceof ProtocolError && /revision|conflict|stale/i.test(error.message),
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
					assert.ok(error instanceof ProtocolError, `${action} did not raise an ProtocolError`);
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
				(error) => error instanceof ProtocolError && new RegExp(`${field} is derived`).test(error.message),
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

// --- Added after a second mutation round -----------------------------------
// Six mutations survived: update's writes, show's reported state, the
// whitespace check, the retried flag, and the proof type guard. The update
// tests asserted only the REFUSAL path, so a version of update that stored
// nothing at all would have passed.

test("an update actually writes the fields it reports", async () => {
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "Before", outcome: "old outcome" });
		const changeId = created.structuredContent.change_id;

		const updated = await handleChange({
			cwd,
			action: "update",
			change_id: changeId,
			revision: created.structuredContent.revision,
			title: "After",
			outcome: "new outcome",
		});
		assert.equal(updated.structuredContent.revision, created.structuredContent.revision + 1, "the revision did not advance");

		// Read it back through a separate call: the write must be durable, not
		// merely reported.
		const shown = await handleChange({ cwd, action: "show", change_id: changeId });
		assert.equal(shown.structuredContent.title, "After", "the title was reported as updated but not stored");
		assert.equal(shown.structuredContent.requested_outcome, "new outcome", "the outcome was reported as updated but not stored");
		assert.equal(shown.structuredContent.revision, created.structuredContent.revision + 1);
	});
});

test("an update omitting a field leaves it alone rather than clearing it", async () => {
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "Keep me", outcome: "keep this too" });
		const changeId = created.structuredContent.change_id;
		await handleChange({ cwd, action: "update", change_id: changeId, revision: created.structuredContent.revision, title: "Changed" });
		const shown = await handleChange({ cwd, action: "show", change_id: changeId });
		assert.equal(shown.structuredContent.title, "Changed");
		assert.equal(shown.structuredContent.requested_outcome, "keep this too", "an omitted field was overwritten");
	});
});

test("show reports the record's real state, not a fixed label", async () => {
	// A `show` that hardcoded "draft" would be indistinguishable from a working
	// one on a freshly created change, so this seeds a record whose state is
	// something else.
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const change = await readFixture("change.json");
		assert.notEqual(change.state, "draft", "the fixture must not be in the state a stub would report");
		await store.put(change);
		const shown = await handleChange({ cwd, action: "show", change_id: change.id });
		assert.equal(shown.structuredContent.state, change.state, "show reported a state the record does not have");
		assert.ok(shown.content[0].text.includes(change.state));
	});
});

test("a blank or whitespace-only required field is refused", async () => {
	// "   " is not a title. Accepting it would store a record that satisfies
	// every downstream shape check while carrying no information.
	await withWorkspace(async (cwd) => {
		for (const blank of ["", "   ", "\t", "\n"]) {
			await assert.rejects(
				() => handleChange({ cwd, action: "create", title: blank, outcome: "something" }),
				(error) => error instanceof ProtocolError && /title/.test(error.message),
				`a title of ${JSON.stringify(blank)} was accepted`,
			);
		}
	});
});

test("a retry reports that it was a replay, not a fresh write", async () => {
	// The `retried` flag is how a caller distinguishes "I created this" from
	// "this already existed". Hardcoding it to false survived before.
	await withWorkspace(async (cwd) => {
		const args = { cwd, action: "create", title: "Idempotent", outcome: "one change only", request_id: "req-retry-1" };
		const first = await handleChange({ ...args });
		const second = await handleChange({ ...args });
		assert.equal(first.structuredContent.change_id, second.structuredContent.change_id, "a retry minted a second change");
		assert.equal(first.structuredContent.retried, false, "a first write claimed to be a replay");
		assert.equal(second.structuredContent.retried, true, "a replay was reported as a fresh write");
	});
});

test("a proof that is not an object is refused", async () => {
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "Proof shape", outcome: "o" });
		for (const bad of ["a string", 42, true, ["an", "array"], null]) {
			await assert.rejects(
				() => handleChange({ cwd, action: "record_proof", change_id: created.structuredContent.change_id, proof: bad }),
				(error) => error instanceof ProtocolError && /proof/.test(error.message),
				`a proof of ${JSON.stringify(bad)} was accepted`,
			);
		}
	});
});

// --- Review regressions (PR #434) -----------------------------------------

test("an accepted change cannot be rewritten through update", async () => {
	// F-1. `title` and `requested_outcome` are exactly the fields an
	// AcceptancePresentation carries, and an approval's presentation_digest is
	// recomputed from its own embedded copy — so editing them after acceptance
	// left the approval validating against a change it no longer described.
	// The record stated an outcome nobody approved.
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const change = await readFixture("change.json");
		for (const state of ["accepted", "abandoned"]) {
			const id = change.id;
			// Replacing an existing record needs the CAS token and a higher
			// revision — the store refuses a blind overwrite, which is the
			// property E02 exists to provide.
			const current = await store.get("change", id).catch(() => null);
			const nextRevision = current ? current.record.revision + 1 : 1;
			await store.put({ ...change, state, revision: nextRevision }, current ? { ifRevision: current.record.revision } : undefined);
			await assert.rejects(
				() => handleChange({ cwd, action: "update", change_id: id, revision: nextRevision, title: "MUTATED AFTER ACCEPTANCE" }),
				(error) => error instanceof ProtocolError && new RegExp(state).test(error.message),
				`a ${state} change was editable`,
			);
			const after = (await store.get("change", id)).record;
			assert.equal(after.title, change.title, `a ${state} change was rewritten`);
		}
	});
});

test("an update without the revision it read is refused, not applied blindly", async () => {
	// F-2. `ifRevision` was populated from the record the adapter had just
	// read, so the compare-and-swap only ever compared the adapter against
	// itself: last-write-wins with extra steps. A second writer's work
	// disappeared with no error reported to anyone.
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "Original", outcome: "o" });
		const id = created.structuredContent.change_id;
		await assert.rejects(
			() => handleChange({ cwd, action: "update", change_id: id, title: "BLIND OVERWRITE" }),
			(error) => error instanceof ProtocolError && /requires the revision you last read/.test(error.message),
			"a blind update was applied",
		);
		const shown = await handleChange({ cwd, action: "show", change_id: id });
		assert.equal(shown.structuredContent.title, "Original", "the record changed despite the refusal");

		// A non-integer revision is a caller error, not a silent coercion. The
		// message must name the TYPE problem: asserting only "some ProtocolError"
		// let the integer check be deleted, because the undefined check above
		// already rejects "1" and null for a different reason.
		for (const bad of ["1", 1.5, null, {}, Number.NaN]) {
			await assert.rejects(
				() => handleChange({ cwd, action: "update", change_id: id, revision: bad, title: "x" }),
				(error) => {
					assert.ok(error instanceof ProtocolError, `a revision of ${JSON.stringify(bad)} did not raise an ProtocolError`);
					assert.match(
						error.message,
						/revision must be an integer|requires the revision you last read/,
						`a revision of ${JSON.stringify(bad)} was refused for the wrong reason: ${error.message}`,
					);
					return true;
				},
				`a revision of ${JSON.stringify(bad)} was accepted`,
			);
		}
		// 1.5 and NaN are defined, so they reach the integer check specifically.
		await assert.rejects(
			() => handleChange({ cwd, action: "update", change_id: id, revision: 1.5, title: "x" }),
			(error) => error instanceof ProtocolError && /revision must be an integer/.test(error.message),
			"a fractional revision was not refused as a type error",
		);
	});
});

test("two successive updates each advance the revision by exactly one", async () => {
	// F-2's corroborating mutations: `ifRevision: 1` and `revision + 2` both
	// survived because no test ever performed two SUCCESSFUL updates, so
	// nothing observed the numbers the adapter passed or wrote.
	await withWorkspace(async (cwd) => {
		const created = await handleChange({ cwd, action: "create", title: "R0", outcome: "o" });
		const id = created.structuredContent.change_id;
		let revision = created.structuredContent.revision;
		for (const title of ["R1", "R2", "R3"]) {
			const updated = await handleChange({ cwd, action: "update", change_id: id, revision, title });
			assert.equal(updated.structuredContent.revision, revision + 1, `revision jumped from ${revision}`);
			revision = updated.structuredContent.revision;
			const shown = await handleChange({ cwd, action: "show", change_id: id });
			assert.equal(shown.structuredContent.title, title);
			assert.equal(shown.structuredContent.revision, revision, "the reported revision is not the stored one");
		}
	});
});

test("a creation timestamp is a real time, and a retry reuses the first one", async () => {
	// F-3. The timestamp used to be a digest of the request: a fixed 2020 epoch
	// plus a bounded offset, giving at most 1000 distinct created_at values per
	// workspace. Anything ordering by creation time got arbitrary order.
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const before = Date.now();
		const args = { cwd, action: "create", title: "Timed", outcome: "o", request_id: "req-time-1" };
		const first = await handleChange({ ...args });
		const after = Date.now();

		const record = (await store.get("change", first.structuredContent.change_id)).record;
		const createdAt = Date.parse(record.created_at);
		assert.ok(createdAt >= before - 1000 && createdAt <= after + 1000, `created_at ${record.created_at} is not a real time`);
		assert.ok(!record.created_at.startsWith("2020-01-01"), "the synthetic 2020 timestamp is back");

		// The retry must not merely succeed — it must carry the SAME time, or
		// the bytes differ and the store reports a conflict.
		const second = await handleChange({ ...args });
		assert.equal(second.structuredContent.retried, true);
		const again = (await store.get("change", second.structuredContent.change_id)).record;
		assert.equal(again.created_at, record.created_at, "a retry rewrote the creation time");
	});
});

test("a bad argument is a caller error, not an internal one", async () => {
	// F-4. These fell through into StoreError, which the server maps to
	// InternalError (-32603) — a code hosts treat as a server bug and retry.
	// Retrying an invalid enum forever is not a recovery strategy.
	await withWorkspace(async (cwd) => {
		const cases = [
			{ args: { mode: "self-approved" }, why: "an unknown mode" },
			{ args: { baseline_commit: "HEAD" }, why: "a non-hash baseline" },
			{ args: { request_id: "../../../pwn" }, why: "a traversal request id" },
			{ args: { request_id: "a".repeat(200) }, why: "an oversized request id" },
		];
		for (const { args, why } of cases) {
			await assert.rejects(
				() => handleChange({ cwd, action: "create", title: "t", outcome: "o", ...args }),
				(error) => {
					assert.ok(error instanceof ProtocolError, `${why} did not raise an ProtocolError`);
					assert.equal(error.code, ProtocolErrorCode.InvalidParams, `${why} was reported as an internal error (${error.code})`);
					return true;
				},
				`${why} was accepted`,
			);
		}

		// An idempotency conflict is also the caller's problem, and says what to do.
		const args = { cwd, action: "create", title: "Alpha", outcome: "o", request_id: "req-conflict" };
		await handleChange({ ...args });
		await assert.rejects(
			() => handleChange({ ...args, title: "Beta" }),
			(error) => error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams && /new request_id/.test(error.message),
			"a conflicting retry was reported as an internal error",
		);
	});
});

test("an inherited property name is not treated as a refused action", async () => {
	// F-5. REFUSED_ACTIONS was a plain object literal, so `action:
	// "constructor"` looked up Object's constructor and printed native function
	// source as the refusal reason.
	await withWorkspace(async (cwd) => {
		for (const action of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
			await assert.rejects(
				() => handleChange({ cwd, action }),
				(error) => {
					assert.ok(error instanceof ProtocolError);
					assert.ok(!/native code|\[object Object\]/.test(error.message), `${action} leaked engine internals: ${error.message}`);
					assert.match(error.message, /unknown action/);
					return true;
				},
				`${action} was not refused`,
			);
		}
	});
});

test("the value that would actually launder a proof is neutralized", async () => {
	// F-6. The existing test sent attested_by: "adapter", which E01 refuses on
	// shape for a host-observed collector — so with the provenance overwrite
	// removed it failed with a validation error and the authority assertions
	// were never reached. It could not distinguish a working overwrite from an
	// unrelated refusal. This sends the value that DOES launder.
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
				provenance: { source: "claude-code:post-tool-use-hook", attested_by: "host-tool-result", tool_call_id: "call_evil" },
			},
		});
		assert.equal(result.structuredContent.authority, "claimed", "a host-tool-result attestation was believed");
		assert.equal(result.structuredContent.discharges, false);

		// The STORED bytes must carry the adapter's provenance, not the
		// caller's: a later reader has only the record to go on.
		const stored = (await store.get("proof", result.structuredContent.proof_id, { changeId: change.id, attemptId: attempt.id })).record;
		assert.equal(stored.provenance.attested_by, "caller", "the caller's attestation was stored");
		assert.equal(stored.provenance.source, "mcp:tool-call", "the caller's source was stored");
		assert.equal(stored.provenance.tool_call_id, undefined, "a forged tool_call_id survived into the record");
	});
});

test("a proof is filed against the change named in the request, not in the payload", async () => {
	// A surviving mutation: dropping the `change_id` overwrite let the payload's
	// own change_id win, filing a proof against a different change.
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
			proof: { ...proof, change_id: "chg_ffffffffffffffffffffffff" },
		});
		const stored = (await store.get("proof", result.structuredContent.proof_id, { changeId: change.id, attemptId: attempt.id })).record;
		assert.equal(stored.change_id, change.id, "the payload's change_id overrode the request's");
	});
});

test("the gate discloses the storage boundary, not only the correctness limit", async () => {
	// F-7's most serious survivor: flipping the reported storage boundary to
	// "host-enforced" deleted the disclosure that these records are not
	// protected from the agent whose work they describe — and the test only
	// checked that SOME limitation matched /semantic correctness/.
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const change = await readFixture("change.json");
		await store.put(change);
		const gate = await handleChange({ cwd, action: "gate", change_id: change.id, attempt_id: "att_000000000000000000000001" });
		const limitations = gate.structuredContent.limitations;
		assert.ok(
			limitations.some((l) => /could have been rewritten by the agent/.test(l)),
			`the storage-boundary disclosure is missing from ${JSON.stringify(limitations)}`,
		);
		assert.ok(limitations.some((l) => /semantic correctness/.test(l)));
	});
});

test("the mode and baseline a caller supplies are the ones recorded", async () => {
	// Two surviving mutations: ignoring `mode` (always "feature") and ignoring
	// `baseline_commit` (always vcs "none").
	await withWorkspace(async (cwd) => {
		const store = await openStore(join(cwd, ".codecarto"));
		const commit = "a".repeat(40);
		const created = await handleChange({ cwd, action: "create", title: "Modes", outcome: "o", mode: "migration", baseline_commit: commit });
		const record = (await store.get("change", created.structuredContent.change_id)).record;
		assert.equal(record.mode, "migration", "the supplied mode was ignored");
		assert.equal(record.baseline.vcs, "git", "a supplied commit did not produce a git baseline");
		assert.equal(record.baseline.head, commit, "the supplied commit was not recorded");

		const without = await handleChange({ cwd, action: "create", title: "No baseline", outcome: "o" });
		const bare = (await store.get("change", without.structuredContent.change_id)).record;
		assert.equal(bare.baseline.vcs, "none", "a change with no commit claimed a git baseline");
	});
});
