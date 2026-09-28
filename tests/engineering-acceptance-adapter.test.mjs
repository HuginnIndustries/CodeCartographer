// The MCP acceptance adapter (E08): asking a person through the client.
//
// Drives the REAL server (buildServer + serveStdio, the factory bin.mjs uses)
// over stdio with a scripted client that answers `elicitation/create`, against
// a real temp store seeded from the E01 fixtures. The SUPPORTED path needs a
// registry entry, and the shipped registry is empty by contract, so the
// launcher in tests/helpers/acceptance-server.mjs passes one through
// buildServer's @internal option — a seam no production entry point reaches.
//
// Every case asserts CONTENT: what was stored, what was sent to the client,
// and what the result said — not merely a state name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPO_ROOT, "tests/helpers/acceptance-server.mjs");
const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, evaluateApprovalReceipt, classifyAcceptance, VERIFIED_ACCEPTANCE_INTEGRATIONS } = engineering;

const CHANGE = await readFixture("change.json");
const SLICE = await readFixture("slice.json");
const ATTEMPT = await readFixture("attempt.json");
const SNAPSHOT = await readFixture("snapshot-candidate.json");
const PROOF = await readFixture("proof.json");
const PROOF2 = await readFixture("proof-second-obligation.json");
const REVIEW = await readFixture("review.json");
const elicitation = async (name) => (await readFixture(`elicitation/${name}.json`)).response;

const observedProof = (proof) => ({ ...proof, provenance: { ...proof.provenance, attested_by: "host-tool-result", tool_call_id: `call_${proof.id.slice(-4)}` } });

/** The registry entry the SUPPORTED cases run under (test-only; the shipped registry is empty). */
const REGISTERED = { host: "mcp-server", client: "claude-code", client_version: "2.1.277", channel: "mcp-elicitation", client_request_timeout_ms: 150_000, evidence: "test-only: scripted client, not a live check" };

/** A workspace whose attempt is ready for acceptance, seeded through the real store. */
async function withWorkspace(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-e08-"));
	try {
		// Initialize through the compiled server the way a host does, then seed the store.
		const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/dist/mcp-server/server.js`).href);
		await handleInit({ cwd, pipeline: "lite" });
		const store = await openStore(join(cwd, ".codecarto"));
		for (const record of [CHANGE, SLICE, ATTEMPT, SNAPSHOT, observedProof(PROOF), observedProof(PROOF2), REVIEW]) await store.put(record);
		const attemptDir = join(store.root, "changes", CHANGE.id, "attempts", ATTEMPT.id);
		const list = async (dir) => (await readdir(join(attemptDir, dir)).catch(() => [])).filter((n) => n.endsWith(".json"));
		return await fn({ cwd, store, attemptDir, list });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

/**
 * A scripted client. `answer` is called with the elicitation/create params and
 * returns either `{ result }` to answer, `{ error }` to fail the request, or
 * `null` to never answer (the server's own timeout must fire).
 */
async function withClient({ registry, capabilities = { elicitation: { form: {}, url: {} } }, clientInfo = { name: "claude-code", version: "2.1.277" }, answer }, fn) {
	const child = spawn(process.execPath, [LAUNCHER, ...(registry ? [JSON.stringify(registry)] : [])], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
	let buffer = "";
	const pending = new Map();
	const elicitations = [];
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
			if (message.method === "elicitation/create") {
				elicitations.push(message.params);
				(async () => {
					const reply = answer ? await answer(message.params) : null;
					if (reply === null || reply === undefined) return;
					if (reply.delay) await new Promise((r) => setTimeout(r, reply.delay));
					if (reply.error) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: reply.error })}\n`);
					else child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: reply.result })}\n`);
				})();
				continue;
			}
			const waiter = pending.get(message.id);
			if (waiter) {
				pending.delete(message.id);
				waiter(message);
			}
		}
	});
	const send = (method, params, timeoutMs = 30_000) => {
		const id = nextId++;
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectPromise(new Error(`timed out waiting for ${method}; stderr: ${stderr.join("")}`));
			}, timeoutMs);
			pending.set(id, (message) => {
				clearTimeout(timer);
				resolvePromise(message);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	};
	try {
		const init = await send("initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo });
		assert.ok(!init.error, JSON.stringify(init.error));
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		return await fn({ send, elicitations, stderr });
	} finally {
		child.stdin.end();
		child.kill();
	}
}

const request = (send, cwd, extra = {}, timeoutMs) => send("tools/call", { name: "codecarto_change", arguments: { cwd, action: "request_acceptance", change_id: CHANGE.id, attempt_id: ATTEMPT.id, ...extra } }, timeoutMs);

/** Every stored approval must evaluate against the stored request; here it is read back from disk, not from the result. */
async function storedRequest(attemptDir, id) {
	return JSON.parse(await readFile(join(attemptDir, "requests", `${id}.json`), "utf8"));
}

// ---------------------------------------------------------------- (a) registry empty

test("(a) with the contract's empty registry every host stops at needs-human-acceptance: request stored, nothing minted, nothing presented", async () => {
	assert.deepEqual(VERIFIED_ACCEPTANCE_INTEGRATIONS, [], "this PR must not register an integration");
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		await withClient({ answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
			const reply = await request(send, cwd);
			assert.ok(!reply.error, JSON.stringify(reply.error));
			const out = reply.result.structuredContent;
			assert.equal(out.outcome, "needs-human-acceptance");
			assert.match(out.reason, /mcp-elicitation on mcp-server \/ claude-code is not a verified integration/);
			assert.equal(out.assurance, "verified");
			assert.match(out.request_id, /^acr_[0-9a-f]{24}$/);
			assert.deepEqual(await list("requests"), [`${out.request_id}.json`]);
			assert.deepEqual(await list("approvals"), []);
			assert.equal(elicitations.length, 0, "nothing may be presented on an unverified integration");
			const stored = await storedRequest(attemptDir, out.request_id);
			assert.equal(stored.candidate_digest, SNAPSHOT.digest);
			assert.equal(stored.presentation.assurance, "verified");
			assert.ok(stored.presentation.limitations.some((l) => /not host-enforced|agent tools|storage/i.test(l)), `storage limitation disclosed: ${JSON.stringify(stored.presentation.limitations)}`);
			assert.match(reply.result.content[0].text, /needs-human-acceptance/);
		});
	});
});

function await_never() {
	throw new Error("the client must never be asked on this path");
}

// ---------------------------------------------------------------- (b) no elicitation capability

test("(b) a client that declared no elicitation capability is human_acceptance: none, even with a registry entry", async () => {
	await withWorkspace(async ({ cwd, list }) => {
		await withClient({ registry: [REGISTERED], capabilities: {}, answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "needs-human-acceptance");
			assert.equal(out.reason, "the host declares no human-acceptance channel");
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("approvals"), []);
			assert.equal((await list("requests")).length, 1);
		});
	});
});

// ---------------------------------------------------------------- (c) version drift

test("(c) registered 2.1.277 but the live client says 2.1.283: unsupported, naming both versions, nothing presented", async () => {
	await withWorkspace(async ({ cwd, list }) => {
		await withClient({ registry: [REGISTERED], clientInfo: { name: "claude-code", version: "2.1.283" }, answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "needs-human-acceptance");
			assert.match(out.reason, /registered for version 2\.1\.277 but the live client is 2\.1\.283/);
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("approvals"), []);
		});
	});
});

// ---------------------------------------------------------------- (d) accept/accept

test("(d) registered pair, accept/accept: approval minted, bound to the stored request, evaluates ok, classifies cooperative (D3)", async () => {
	await withWorkspace(async ({ cwd, store, attemptDir, list }) => {
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: { ...answer, content: { ...answer.content, note: "Looks right; ship it." } } }) }, async ({ send, elicitations }) => {
			const reply = await request(send, cwd);
			assert.ok(!reply.error, JSON.stringify(reply.error));
			const out = reply.result.structuredContent;
			assert.equal(out.outcome, "accepted", JSON.stringify(out));
			assert.equal(out.classification, "cooperative");
			assert.ok(out.classification_reasons.some((r) => /storage boundary/.test(r)), JSON.stringify(out.classification_reasons));

			// What the client was asked: the presentation with an unambiguous, required Decision field and the TTL as the timeout.
			assert.equal(elicitations.length, 1);
			const form = elicitations[0];
			assert.equal(form.mode, "form");
			assert.deepEqual(form.requestedSchema.required, ["decision"]);
			assert.deepEqual(form.requestedSchema.properties.decision.enum, ["accept", "reject"]);
			assert.match(form.message, /Set the required "Decision" field/);
			assert.match(form.message, new RegExp(`Change: ${CHANGE.title}`));
			assert.match(form.message, /Assurance policy: verified/);

			// What was stored.
			assert.deepEqual(await list("approvals"), [`${out.approval_id}.json`]);
			const approval = (await store.get("approval", out.approval_id, { changeId: CHANGE.id, attemptId: ATTEMPT.id })).record;
			const stored = await storedRequest(attemptDir, out.request_id);
			assert.equal(approval.decision, "accepted");
			assert.equal(approval.receipt.nonce, stored.nonce);
			assert.equal(approval.receipt.presentation_digest, stored.presentation_digest);
			assert.deepEqual(approval.receipt.client, { name: "claude-code", version: "2.1.277" });
			assert.equal(approval.receipt.channel, "mcp-elicitation");
			assert.equal(approval.receipt.host, "mcp-server");
			assert.equal(approval.receipt.authenticated, "host-session");
			assert.match(approval.receipt.attestation, /no Elicitation or ElicitationResult hooks/);
			assert.equal(approval.human_note, "Looks right; ship it.");
			assert.equal(approval.assurance, "cooperative", "no host-enforced boundary: the record may not call itself verified");
			assert.equal(approval.storage.boundary, "none");
			// The TTL must sit strictly below the registered client timeout, and the reading must not name the TTL rule.
			assert.ok(Date.parse(stored.expires_at) - Date.parse(stored.issued_at) < REGISTERED.client_request_timeout_ms);
			assert.ok(!out.classification_reasons.some((r) => /request timeout/.test(r)), JSON.stringify(out.classification_reasons));

			const receipt = evaluateApprovalReceipt(approval, { request: stored, consumed_nonces: [], attempt: ATTEMPT, candidate: SNAPSHOT });
			assert.deepEqual(receipt, { ok: true, accepted: true });
			const reading = classifyAcceptance(approval, { request: stored, consumed_nonces: [], attempt: ATTEMPT, candidate: SNAPSHOT, current_storage: { boundary: "none" }, integrations: [REGISTERED], proofs: [observedProof(PROOF), observedProof(PROOF2)], reviews: [REVIEW] });
			assert.equal(reading.class, "cooperative");
		});
	});
});

// ---------------------------------------------------------------- (e) accept/reject, (f) invalid, (g) decline/cancel

for (const [label, fixture, outcome, reasonPattern] of [
	["(e) accept with content.decision reject (the D1 finding) is rejected", "accept-reject", "rejected", /rejected the candidate/],
	["(f) accept with a missing decision is invalid", "accept-missing-decision", "invalid", /without a recognizable decision/],
	["(f) accept with the decision typed into the note is invalid", "accept-decision-in-note", "invalid", /action alone never authorizes/],
	["(f) accept with an unknown decision is invalid", "accept-unknown-decision", "invalid", /without a recognizable decision/],
	["(g) decline is declined", "decline-no-content", "declined", /dismissed/],
	["(g) cancel is cancelled", "cancel", "cancelled", /cancelled/],
]) {
	test(`${label}: request stored, NO approval`, async () => {
		await withWorkspace(async ({ cwd, list }) => {
			const answer = await elicitation(fixture);
			await withClient({ registry: [REGISTERED], answer: () => ({ result: answer }) }, async ({ send, elicitations }) => {
				const out = (await request(send, cwd)).result.structuredContent;
				assert.equal(out.outcome, outcome, JSON.stringify(out));
				assert.equal(out.elicitation, outcome);
				assert.match(out.reason, reasonPattern);
				assert.equal(elicitations.length, 1);
				assert.deepEqual(await list("approvals"), []);
				assert.equal((await list("requests")).length, 1);
			});
		});
	});
}

// ---------------------------------------------------------------- (h) timeout

test("(h) a client that never answers: timed-out on the server's own timeout, NO approval", async () => {
	await withWorkspace(async ({ cwd, list }) => {
		// A registry whose client timeout makes the TTL 1 s, so the test does not wait two minutes.
		const quick = { ...REGISTERED, client_request_timeout_ms: 6_000 };
		await withClient({ registry: [quick], answer: () => null }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd, {}, 20_000)).result.structuredContent;
			assert.equal(out.outcome, "timed-out", JSON.stringify(out));
			assert.match(out.reason, /-32001/);
			assert.equal(elicitations.length, 1);
			assert.deepEqual(await list("approvals"), []);
		});
	});
});

test("(h') a registered client whose timeout is shorter than the adapter's window: the TTL is bounded by it, and an unusable timeout means nobody is asked", async () => {
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		const answer = await elicitation("accept-accept");
		const quick = { ...REGISTERED, client_request_timeout_ms: 8_000 };
		await withClient({ registry: [quick], answer: () => ({ result: answer }) }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "accepted", JSON.stringify(out));
			assert.equal(elicitations.length, 1);
			const stored = await storedRequest(attemptDir, out.request_id);
			const ttl = Date.parse(stored.expires_at) - Date.parse(stored.issued_at);
			assert.ok(ttl > 0 && ttl < quick.client_request_timeout_ms, `TTL ${ttl} must sit strictly inside the ${quick.client_request_timeout_ms} ms client timeout`);
			assert.ok(!out.classification_reasons.some((r) => /request timeout/.test(r)), JSON.stringify(out.classification_reasons));
		});
		const unusable = { ...REGISTERED, client_request_timeout_ms: 1_000 };
		await withClient({ registry: [unusable], answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "needs-human-acceptance", JSON.stringify(out));
			assert.match(out.reason, /leaves no usable window/);
			assert.equal(elicitations.length, 0);
			assert.equal((await list("approvals")).length, 1, "the earlier approval is untouched");
		});
	});
});

// ---------------------------------------------------------------- (i) stale

test("(i) an answer arriving after expires_at is refused by evaluateApprovalReceipt, NO approval", async () => {
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		// Over the transport a late answer is excluded BY CONSTRUCTION: the TTL
		// is also the elicitInput request timeout (D1 timeout finding), so the
		// SDK reports -32001 rather than delivering it — case (h). The receipt
		// rule is exercised at the storage seam instead: while the form is open
		// the stored request's window is closed, so the real answer is stale
		// when the receipt is evaluated against the bytes on disk.
		const answer = await elicitation("accept-accept");
		await withClient({
			registry: [REGISTERED],
			answer: async () => {
				const [file] = (await readdir(join(attemptDir, "requests"))).filter((n) => n.endsWith(".json"));
				const path = join(attemptDir, "requests", file);
				const stored = JSON.parse(await readFile(path, "utf8"));
				stored.expires_at = new Date(Date.parse(stored.issued_at) + 1).toISOString();
				await writeFile(path, JSON.stringify(stored));
				return { result: answer, delay: 50 };
			},
		}, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(elicitations.length, 1);
			assert.equal(out.outcome, "refused", JSON.stringify(out));
			assert.equal(out.elicitation, "accepted", "the person did accept; the receipt is what fails");
			assert.match(out.reason, /receipt-expired at \/receipt\/responded_at/);
			assert.deepEqual(await list("approvals"), []);
		});
	});
});

// ---------------------------------------------------------------- (j) tampered

test("(j) an answer minted from a different request (wrong nonce / presentation digest) is refused, NO approval", async () => {
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		// The scripted client cannot forge a nonce — the server copies it from
		// the request, never from the response — so the tamper is applied at the
		// storage seam: the stored request is rewritten with another nonce and
		// digest after issue and before the answer, which is exactly a stale or
		// substituted request from the receipt's point of view.
		const answer = await elicitation("accept-accept");
		await withClient({
			registry: [REGISTERED],
			answer: async () => {
				const [file] = (await readdir(join(attemptDir, "requests"))).filter((n) => n.endsWith(".json"));
				const path = join(attemptDir, "requests", file);
				const stored = JSON.parse(await readFile(path, "utf8"));
				stored.nonce = "ffffffffffffffffffffffffffffffff";
				await writeFile(path, JSON.stringify(stored));
				return { result: answer };
			},
		}, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(elicitations.length, 1);
			assert.equal(out.outcome, "refused", JSON.stringify(out));
			assert.match(out.reason, /receipt-mismatch at \/receipt\/nonce/);
			assert.deepEqual(await list("approvals"), []);
		});
	});
});

// ---------------------------------------------------------------- (k) refused actions

test("(k) approve and accept remain refused with their reasons; request_acceptance is the only way to ask", async () => {
	await withWorkspace(async ({ cwd }) => {
		await withClient({ registry: [REGISTERED], answer: () => ({ result: await_never() }) }, async ({ send }) => {
			for (const action of ["approve", "accept"]) {
				const reply = await send("tools/call", { name: "codecarto_change", arguments: { cwd, action, change_id: CHANGE.id, attempt_id: ATTEMPT.id } });
				assert.ok(reply.error, `${action} must be refused`);
				assert.match(reply.error.message, new RegExp(`${action} is not available through this surface: acceptance requires a trusted channel and a receipt the core can evaluate`));
			}
		});
	});
});

// ---------------------------------------------------------------- (l) no request field sets capability

test("(l) no request field can raise host capability or carry a decision", async () => {
	await withWorkspace(async ({ cwd, list }) => {
		await withClient({ registry: [REGISTERED], answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
			for (const [field, value] of [
				["verified_integration", true],
				["host", "claude-code"],
				["assurance", "cooperative"],
				["assurance_policy", "cooperative"],
				["storage", { boundary: "host-enforced" }],
				["storage_boundary", "host-enforced"],
				["current_storage", { boundary: "host-enforced", protection: "continuous-since-initialization" }],
				["protection", "continuous-since-initialization"],
				["tool_result_path", "protected"],
				["registry", [REGISTERED]],
				["client", { name: "claude-code", version: "2.1.277" }],
				["decision", "accepted"],
				["approve", true],
				["receipt", {}],
			]) {
				const reply = await request(send, cwd, { [field]: value });
				assert.ok(reply.error, `${field} must be refused`);
				assert.match(reply.error.message, /derived|unknown field/, `${field}: ${reply.error.message}`);
			}
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("requests"), [], "a refused request stores nothing");
		});
	});
});
