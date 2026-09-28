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

import "./helpers/git-environment-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPO_ROOT, "tests/helpers/acceptance-server.mjs");
const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const { openStore, evaluateApprovalReceipt, classifyAcceptance, VERIFIED_ACCEPTANCE_INTEGRATIONS, computeSnapshotDigest, requestAcceptance, checkCandidateFreshness } = engineering;
const { hostCapabilitiesFromSession } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/engineering.ts`).href);
const execFileAsync = promisify(execFile);

/** chmod 000 denies nothing to root and does not exist on Windows. */
const CANNOT_RESTRICT = (process.platform === "win32" && "chmod 000 does not deny reads on Windows") || (typeof process.getuid === "function" && process.getuid() === 0 && "root reads chmod-000 files");
const NO_SYMLINKS = process.platform === "win32" && "symlink creation needs a privilege on Windows";
const { readWorkingTree } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/working-tree.ts`).href);

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

/**
 * The candidate's tree, materialized on disk. The paths mirror the fixture
 * snapshot's manifest; the bytes are synthetic. The candidate record the
 * store is seeded with is CAPTURED from this tree by the same reader the
 * adapter uses at acceptance time, so the re-read compares like with like
 * and an edit after capture is a real digest mismatch.
 */
async function materializeTree(cwd) {
	await mkdir(join(cwd, "src", "widgets"), { recursive: true });
	await mkdir(join(cwd, "tests"), { recursive: true });
	await mkdir(join(cwd, "tools"), { recursive: true });
	await mkdir(join(cwd, "scripts"), { recursive: true });
	await mkdir(join(cwd, ".git"), { recursive: true });
	await writeFile(join(cwd, "src", "widgets", "count.ts"), "export function count(items) {\n\treturn items.length;\n}\n");
	await writeFile(join(cwd, "tests", "widgets-count.test.mjs"), "// synthetic test file\n");
	await writeFile(join(cwd, "tools", "run-tests"), "#!/bin/sh\nnode --test\n");
	await chmod(join(cwd, "tools", "run-tests"), 0o755);
	await symlink("../src/widgets/count.ts", join(cwd, "scripts", "count"));
	await writeFile(join(cwd, ".git", "HEAD"), `${SNAPSHOT.repository.head}\n`);
}

/** A workspace whose attempt is ready for acceptance, seeded through the real store, with the candidate's bytes on disk. */
async function withWorkspace(fn, { records } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-e08-"));
	try {
		// Initialize through the compiled server the way a host does, then seed the store.
		const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/dist/mcp-server/server.js`).href);
		await handleInit({ cwd, pipeline: "lite" });
		await materializeTree(cwd);
		const read = await readWorkingTree(cwd, SNAPSHOT);
		assert.equal(read.ok, true, read.ok ? "" : read.reason);
		const candidate = { ...SNAPSHOT, ...read.reread, digest: computeSnapshotDigest(read.reread) };
		const review = { ...REVIEW, candidate_digest: candidate.digest };
		const store = await openStore(join(cwd, ".codecarto"));
		const seed = records ? records({ candidate, review }) : [CHANGE, SLICE, ATTEMPT, candidate, observedProof(PROOF), observedProof(PROOF2), review];
		for (const record of seed) await store.put(record);
		const attemptDir = join(store.root, "changes", CHANGE.id, "attempts", ATTEMPT.id);
		const list = async (dir) => (await readdir(join(attemptDir, dir)).catch(() => [])).filter((n) => n.endsWith(".json"));
		return await fn({ cwd, store, attemptDir, list, candidate, review });
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
	await withWorkspace(async ({ cwd, attemptDir, list, candidate }) => {
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
			assert.equal(stored.candidate_digest, candidate.digest);
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
	await withWorkspace(async ({ cwd, store, attemptDir, list, candidate, review }) => {
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

			const receipt = evaluateApprovalReceipt(approval, { request: stored, consumed_nonces: [], attempt: ATTEMPT, candidate });
			assert.deepEqual(receipt, { ok: true, accepted: true });
			const reading = classifyAcceptance(approval, { request: stored, consumed_nonces: [], attempt: ATTEMPT, candidate, current_storage: { boundary: "none" }, integrations: [REGISTERED], proofs: [observedProof(PROOF), observedProof(PROOF2)], reviews: [review] });
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
	});
	await withWorkspace(async ({ cwd, list }) => {
		const unusable = { ...REGISTERED, client_request_timeout_ms: 1_000 };
		await withClient({ registry: [unusable], answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "needs-human-acceptance", JSON.stringify(out));
			assert.match(out.reason, /leaves no usable window/);
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("approvals"), []);
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

// ---------------------------------------------------------------- (m) the gate runs first (review P1c)

test("(m) an attempt the gate refuses (no review) is never presented: blocked with review-missing, 0 elicitations, no request, no approval", async () => {
	await withWorkspace(
		async ({ cwd, list }) => {
			await withClient({ registry: [REGISTERED], answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
				const reply = await request(send, cwd);
				assert.ok(!reply.error, JSON.stringify(reply.error));
				const out = reply.result.structuredContent;
				assert.equal(out.outcome, "blocked", JSON.stringify(out));
				assert.equal(out.gate_state, "refused");
				assert.ok(out.blockers.some((b) => b.code === "review-missing"), JSON.stringify(out.blockers));
				assert.match(out.reason, /review-missing/);
				assert.match(reply.result.content[0].text, /# Acceptance refused/);
				assert.equal(out.request_id, undefined, "no request is issued for refused work");
				assert.equal(elicitations.length, 0, "nobody was asked");
				assert.deepEqual(await list("requests"), []);
				assert.deepEqual(await list("approvals"), []);
			});
		},
		{ records: ({ candidate }) => [CHANGE, SLICE, ATTEMPT, candidate, observedProof(PROOF), observedProof(PROOF2)] },
	);
});

test("(m') a tree edited after the candidate was captured is never presented: blocked naming staleness, 0 elicitations, no request, no approval", async () => {
	await withWorkspace(async ({ cwd, list, candidate }) => {
		await writeFile(join(cwd, "src", "widgets", "count.ts"), "export function count(items) {\n\treturn items.length + 1;\n}\n");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: await_never() }) }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "blocked", JSON.stringify(out));
			const stale = out.blockers.find((b) => b.code === "proof-stale");
			assert.ok(stale, JSON.stringify(out.blockers));
			assert.match(stale.detail, new RegExp(`the working tree no longer matches candidate ${candidate.id}`));
			assert.match(stale.detail, /digest-mismatch|has digest .*; the tree now has/);
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("requests"), []);
			assert.deepEqual(await list("approvals"), []);
		});
	});
});

test("(m'') the MCP gate action re-reads the tree: an edited tree is refused as stale, not disclosed as unread", async () => {
	await withWorkspace(async ({ cwd }) => {
		await withClient({ registry: [REGISTERED], answer: () => ({ result: await_never() }) }, async ({ send }) => {
			const gate = (send) => send("tools/call", { name: "codecarto_change", arguments: { cwd, action: "gate", change_id: CHANGE.id, attempt_id: ATTEMPT.id } });
			const before = (await gate(send)).result.structuredContent;
			assert.equal(before.state, "needs-human-acceptance", JSON.stringify(before));
			assert.ok(!before.limitations.some((l) => /supplied no re-read/.test(l)), `the tree WAS re-read: ${JSON.stringify(before.limitations)}`);
			await writeFile(join(cwd, "README.md"), "# added after capture\n");
			const after = (await gate(send)).result.structuredContent;
			assert.equal(after.state, "refused", JSON.stringify(after));
			assert.ok(after.blockers.some((b) => b.code === "proof-stale" && /no longer matches/.test(b.detail)), JSON.stringify(after.blockers));
		});
	});
});

// ---------------------------------------------------------------- (n) one approval per candidate (review P4a/P4b)

test("(n) a second request after an accepted approval is refused already-accepted; exactly one approval on disk", async () => {
	await withWorkspace(async ({ cwd, list }) => {
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: answer }) }, async ({ send, elicitations }) => {
			const first = (await request(send, cwd)).result.structuredContent;
			assert.equal(first.outcome, "accepted", JSON.stringify(first));
			const second = await request(send, cwd);
			assert.ok(second.error, "the second request must be refused");
			assert.match(second.error.message, /already-accepted: approval apr_[0-9a-f]{24} already binds an accepted decision to candidate/);
			assert.equal(elicitations.length, 1, "the person is asked once");
			assert.equal((await list("approvals")).length, 1);
			assert.equal((await list("requests")).length, 1, "no second request is issued");
		});
	});
});

test("(n') two concurrent requests: exactly one approval, the other refused because a request is in flight", async () => {
	await withWorkspace(async ({ cwd, list }) => {
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: answer, delay: 300 }) }, async ({ send, elicitations }) => {
			const [a, b] = await Promise.all([request(send, cwd), request(send, cwd)]);
			const accepted = [a, b].filter((r) => r.result?.structuredContent?.outcome === "accepted");
			const refused = [a, b].filter((r) => r.error);
			assert.equal(accepted.length, 1, JSON.stringify([a, b]));
			assert.equal(refused.length, 1, JSON.stringify([a, b]));
			assert.match(refused[0].error.message, /another acceptance request for attempt .* is in flight|already-accepted/);
			assert.equal(elicitations.length, 1, "the person is asked once");
			assert.deepEqual(await list("approvals"), [`${accepted[0].result.structuredContent.approval_id}.json`]);
			assert.equal((await readdir(join(cwd, ".codecarto", "engineering", "changes", CHANGE.id, "attempts", ATTEMPT.id, "requests"))).includes(".in-flight"), false, "the marker is released on every exit path");
		});
	});
});

test("(n'') a stale in-flight marker (crashed server, past its expires_at) does not wedge the attempt; a live one does", async () => {
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		const marker = join(attemptDir, "requests", ".in-flight");
		await mkdir(dirname(marker), { recursive: true });
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: answer }) }, async ({ send, elicitations }) => {
			await writeFile(marker, `${JSON.stringify({ expires_at: new Date(Date.now() + 60_000).toISOString() })}\n`);
			const live = await request(send, cwd);
			assert.ok(live.error, "a live marker refuses");
			assert.match(live.error.message, /in flight/);
			assert.equal(elicitations.length, 0);
			await writeFile(marker, `${JSON.stringify({ expires_at: new Date(Date.now() - 1_000).toISOString() })}\n`);
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "accepted", JSON.stringify(out));
			assert.equal(elicitations.length, 1);
			assert.equal((await list("approvals")).length, 1);
		});
	});
});

// ---------------------------------------------------------------- (o) the receipt is minted from the request, never from the answer (mutant M6)

test("(o) extra fields in the client's accept content never reach the approval: nonce and presentation_digest come from the STORED request", async () => {
	await withWorkspace(async ({ cwd, store, attemptDir, list }) => {
		const answer = await elicitation("accept-accept");
		// Every forged value is one no honest receipt could carry, so a plain
		// substring search over the stored approval is a sufficient leak check.
		const forged = { nonce: "ffffffffffffffffffffffffffffffff", presentation_digest: `sha256:${"ab".repeat(32)}`, approved: "forged-approved", host: "forged-host", assurance: "forged-verified", decided_at: "2020-01-01T00:00:00Z" };
		await withClient({ registry: [REGISTERED], answer: () => ({ result: { ...answer, content: { ...answer.content, ...forged } } }) }, async ({ send }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "accepted", JSON.stringify(out));
			const approval = (await store.get("approval", out.approval_id, { changeId: CHANGE.id, attemptId: ATTEMPT.id })).record;
			const stored = await storedRequest(attemptDir, out.request_id);
			assert.equal(approval.receipt.nonce, stored.nonce);
			assert.notEqual(approval.receipt.nonce, forged.nonce);
			assert.equal(approval.receipt.presentation_digest, stored.presentation_digest);
			assert.notEqual(approval.receipt.presentation_digest, forged.presentation_digest);
			assert.equal(approval.receipt.host, "mcp-server");
			assert.equal(approval.assurance, "cooperative");
			assert.notEqual(approval.decided_at, forged.decided_at);
			const text = JSON.stringify(approval);
			for (const [field, value] of Object.entries(forged)) {
				assert.ok(!text.includes(JSON.stringify(value)), `${field} from the answer leaked into the approval`);
			}
			assert.equal("approved" in approval, false);
			assert.equal(approval.assurance, "cooperative");
			assert.equal((await list("approvals")).length, 1);
		});
	});
});

// ---------------------------------------------------------------- (p) freshness AGAIN before minting (review #4; contract: "before issuing and again before minting")

test("(p) a tree edited while the person was deciding is refused before minting: proof-stale, 0 approvals, request stored, marker released; an untouched tree still accepts", async () => {
	await withWorkspace(async ({ cwd, attemptDir, list, candidate }) => {
		const answer = await elicitation("accept-accept");
		// The scripted presenter edits a covered file, then answers accept.
		const editThenAccept = async () => {
			await writeFile(join(cwd, "src", "widgets", "count.ts"), "export function count(items) {\n\treturn items.length + 1; // edited while the form was open\n}\n");
			return { result: answer };
		};
		await withClient({ registry: [REGISTERED], answer: editThenAccept }, async ({ send, elicitations }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "refused", JSON.stringify(out));
			assert.match(out.reason, /^proof-stale: the tree moved while the person was deciding/);
			assert.match(out.reason, new RegExp(`no longer matches candidate ${candidate.id}`));
			assert.equal(out.elicitation, "accepted", "the person DID answer accept; the refusal is the tree's, not theirs");
			assert.equal(elicitations.length, 1);
			assert.deepEqual(await list("approvals"), []);
			assert.deepEqual(await list("requests"), [`${out.request_id}.json`], "the request was issued honestly and stays");
			assert.equal((await readdir(join(attemptDir, "requests"))).includes(".in-flight"), false, "the marker is released");
			// The bytes really moved: the same reader now disagrees with the bound candidate.
			const now = await readWorkingTree(cwd, candidate);
			assert.equal(now.ok && checkCandidateFreshness(candidate, now.reread).ok, false);
		});
	});
	// Untouched: the second re-read agrees and the approval is minted.
	await withWorkspace(async ({ cwd, list }) => {
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: answer }) }, async ({ send }) => {
			const out = (await request(send, cwd)).result.structuredContent;
			assert.equal(out.outcome, "accepted", JSON.stringify(out));
			assert.equal((await list("approvals")).length, 1);
		});
	});
});

// ---------------------------------------------------------------- (q) core: no re-read means nobody is asked (review #8, mutant reread-fail-proceeds)

const CORE_CAPS = hostCapabilitiesFromSession({ elicitation_form: true, client: { name: "claude-code", version: "2.1.277" }, storage_boundary: "none", tool_result_path: "none", current_storage: { boundary: "none" }, presenter: null });

/** Core-level call, bypassing the MCP adapter, with a presenter that counts. */
async function coreRequest(store, reread) {
	let presented = 0;
	const presenter = { elicit: async () => { presented++; return { action: "accept", content: { decision: "accept" } }; } };
	const result = await requestAcceptance(store, { change_id: CHANGE.id, attempt_id: ATTEMPT.id, capabilities: CORE_CAPS, presenter, current_storage: { boundary: "none" }, registry: [REGISTERED], host_session: "test", ...(reread === undefined ? {} : { reread }) });
	return { result, presented };
}

test("(q) requestAcceptance with no reread, or a reread that fails: needs-human-acceptance, 0 elicitations, no request, no approval; the same call with a working reread accepts", async () => {
	assert.equal(CORE_CAPS.assurance_policy, "verified");
	await withWorkspace(async ({ store, list, cwd }) => {
		const none = await coreRequest(store, undefined);
		assert.equal(none.result.outcome, "needs-human-acceptance", JSON.stringify(none.result));
		assert.equal(none.result.request_id, undefined, "no request is issued");
		assert.match(none.result.reason, /cannot be re-read on this surface/);
		assert.equal(none.result.gate?.state, "may-accept", "the gate ran on the records; only the missing re-read stops the ask");
		assert.equal(none.presented, 0);
		assert.deepEqual(await list("requests"), []);
		assert.deepEqual(await list("approvals"), []);

		const failing = await coreRequest(store, async () => ({ ok: false, reason: "disk on fire" }));
		assert.equal(failing.result.outcome, "needs-human-acceptance", JSON.stringify(failing.result));
		assert.equal(failing.result.request_id, undefined);
		assert.equal(failing.result.reason, "disk on fire");
		assert.equal(failing.presented, 0);
		assert.deepEqual(await list("requests"), []);
		assert.deepEqual(await list("approvals"), []);

		// Control: the identical call with a real re-read presents and mints.
		const working = await coreRequest(store, (candidate) => readWorkingTree(cwd, candidate));
		assert.equal(working.result.outcome, "accepted", JSON.stringify(working.result));
		assert.equal(working.presented, 1);
		assert.equal((await list("approvals")).length, 1);
	});
});

test("(q') a reread that succeeds before the ask but fails after the answer: refused, nothing minted", async () => {
	await withWorkspace(async ({ store, list, cwd, attemptDir }) => {
		let calls = 0;
		const flaky = async (candidate) => (++calls === 1 ? readWorkingTree(cwd, candidate) : { ok: false, reason: "the tree vanished" });
		const { result, presented } = await coreRequest(store, flaky);
		assert.equal(result.outcome, "refused", JSON.stringify(result));
		assert.match(result.reason, /^proof-stale: the tree could not be re-read after the person decided \(the tree vanished\)/);
		assert.equal(presented, 1);
		assert.equal(calls, 2, "the tree is read before the ask AND again before minting");
		assert.deepEqual(await list("approvals"), []);
		assert.equal((await list("requests")).length, 1);
		assert.equal((await readdir(join(attemptDir, "requests"))).includes(".in-flight"), false);
	});
});

// ---------------------------------------------------------------- (r) the in-flight marker's degenerate shapes (review #5)

test("(r) an unparseable marker: fresh mtime refuses; ancient mtime is cleared and the request proceeds; a directory or symlink at the marker's path is refused by name and never removed", async () => {
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		const marker = join(attemptDir, "requests", ".in-flight");
		await mkdir(dirname(marker), { recursive: true });
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: answer }) }, async ({ send, elicitations }) => {
			await writeFile(marker, "");
			const fresh = await request(send, cwd);
			assert.ok(fresh.error, "an empty marker with a fresh mtime is a crash in progress: refused");
			assert.match(fresh.error.message, /in flight/);
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("approvals"), []);

			await writeFile(marker, "{not json");
			const ancient = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
			await utimes(marker, ancient, ancient);
			const cleared = (await request(send, cwd)).result.structuredContent;
			assert.equal(cleared.outcome, "accepted", JSON.stringify(cleared));
			assert.equal(elicitations.length, 1);
			assert.equal((await list("approvals")).length, 1);
			assert.equal((await readdir(dirname(marker))).includes(".in-flight"), false);
		});
	});
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		const marker = join(attemptDir, "requests", ".in-flight");
		await mkdir(marker, { recursive: true });
		await writeFile(join(marker, "keep.txt"), "not ours\n");
		const ancient = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		await utimes(marker, ancient, ancient);
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: answer }) }, async ({ send, elicitations }) => {
			const dir = await request(send, cwd);
			assert.ok(dir.error, "a directory at the marker's path is refused");
			assert.match(dir.error.message, /is a directory; it was not written by this adapter and is not removed/);
			assert.equal(await readFile(join(marker, "keep.txt"), "utf8"), "not ours\n", "nothing under it was removed");
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("approvals"), []);
		});
	});
});

test("(r') a symlink at the marker's path is refused by name and never removed", { skip: NO_SYMLINKS }, async () => {
	await withWorkspace(async ({ cwd, attemptDir, list }) => {
		const marker = join(attemptDir, "requests", ".in-flight");
		await mkdir(dirname(marker), { recursive: true });
		// Under the store, not in the tree: a file in the tree would make the gate refuse stale before the marker is reached.
		const target = join(attemptDir, "precious.txt");
		await writeFile(target, "keep\n");
		await symlink(target, marker);
		const answer = await elicitation("accept-accept");
		await withClient({ registry: [REGISTERED], answer: () => ({ result: answer }) }, async ({ send, elicitations }) => {
			const out = await request(send, cwd);
			assert.ok(out.error, JSON.stringify(out));
			assert.match(out.error.message, /is a symbolic link; it was not written by this adapter and is not removed/);
			assert.equal(await readFile(target, "utf8"), "keep\n");
			assert.ok((await readdir(dirname(marker))).includes(".in-flight"), "the link itself is left in place");
			assert.equal(elicitations.length, 0);
			assert.deepEqual(await list("approvals"), []);
		});
	});
});

// ---------------------------------------------------------------- (s) readWorkingTree on real files (review #8: mode bits, symlinks, exclusions, unreadables)

/** A tree, captured as a candidate by the reader under test; `mutate` then edits it and the verdict is the freshness of the re-read. */
async function withTree(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-e08-tree-"));
	try {
		await materializeTree(cwd);
		const read = await readWorkingTree(cwd, SNAPSHOT);
		assert.equal(read.ok, true, read.ok ? "" : read.reason);
		const candidate = { ...SNAPSHOT, ...read.reread, digest: computeSnapshotDigest(read.reread) };
		const verdict = async () => {
			const again = await readWorkingTree(cwd, candidate);
			assert.equal(again.ok, true, again.ok ? "" : again.reason);
			return { fresh: checkCandidateFreshness(candidate, again.reread).ok, reread: again.reread };
		};
		return await fn({ cwd, candidate, verdict });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("(s) readWorkingTree: an untouched tree is FRESH; a changed executable bit is STALE", { skip: process.platform === "win32" && "mode bits are not observable on Windows" }, async () => {
	await withTree(async ({ cwd, candidate, verdict }) => {
		assert.equal((await verdict()).fresh, true);
		const entry = candidate.manifest.find((e) => e.path === "tools/run-tests");
		assert.equal(entry?.type, "file");
		assert.equal(entry.executable, true, "the fixture script is executable at capture");
		await chmod(join(cwd, "tools", "run-tests"), 0o644);
		const after = await verdict();
		assert.equal(after.fresh, false, "the bytes did not change; only the mode did, and that is a different tree");
		assert.equal(after.reread.manifest.find((e) => e.path === "tools/run-tests").executable, false);
	});
	await withTree(async ({ cwd, verdict }) => {
		await chmod(join(cwd, "src", "widgets", "count.ts"), 0o755);
		assert.equal((await verdict()).fresh, false);
	});
});

test("(s') readWorkingTree records symlinks as links and never follows them: replacing a file with a link to the same bytes is STALE; retargeting a link is STALE", { skip: NO_SYMLINKS }, async () => {
	await withTree(async ({ cwd, candidate, verdict }) => {
		const link = candidate.manifest.find((e) => e.path === "scripts/count");
		assert.equal(link?.type, "symlink", JSON.stringify(link));
		assert.equal(link.target, "../src/widgets/count.ts", "the link's own target is what is recorded");
		assert.equal("digest" in link, false, "a link is never hashed through");
		// Replace a regular file with a symlink to a copy of its bytes.
		const bytes = await readFile(join(cwd, "tests", "widgets-count.test.mjs"));
		await writeFile(join(cwd, "tests", "copy.mjs"), bytes);
		await unlink(join(cwd, "tests", "widgets-count.test.mjs"));
		await symlink("copy.mjs", join(cwd, "tests", "widgets-count.test.mjs"));
		const swapped = await verdict();
		assert.equal(swapped.fresh, false);
		assert.equal(swapped.reread.manifest.find((e) => e.path === "tests/widgets-count.test.mjs").type, "symlink");
	});
	await withTree(async ({ cwd, verdict }) => {
		// Retarget the existing link to a file with IDENTICAL bytes: only the target string differs.
		await writeFile(join(cwd, "src", "widgets", "count2.ts"), await readFile(join(cwd, "src", "widgets", "count.ts")));
		await unlink(join(cwd, "scripts", "count"));
		await symlink("../src/widgets/count2.ts", join(cwd, "scripts", "count"));
		const retargeted = await verdict();
		assert.equal(retargeted.fresh, false);
		assert.equal(retargeted.reread.manifest.find((e) => e.path === "scripts/count").target, "../src/widgets/count2.ts");
	});
});

test("(s'') readWorkingTree applies the candidate's own exclusions: an edit under an excluded pattern is FRESH, an edit outside them is STALE", async () => {
	await withTree(async ({ cwd, candidate, verdict }) => {
		const excluded = candidate.coverage.excluded.map((e) => e.pattern);
		assert.ok(excluded.includes("dist/**"), `the fixture candidate excludes dist/**: ${JSON.stringify(excluded)}`);
		await mkdir(join(cwd, "dist"), { recursive: true });
		await writeFile(join(cwd, "dist", "out.js"), "built\n");
		assert.equal((await verdict()).fresh, true, "dist/** is excluded by the candidate; an edit there is not a change in scope");
		assert.equal((await verdict()).reread.manifest.some((e) => e.path.startsWith("dist/")), false);
		await writeFile(join(cwd, "README.md"), "# not excluded\n");
		assert.equal((await verdict()).fresh, false);
	});
});

test("(s''') readWorkingTree reports an unreadable file as uncovered, never silently skipped", { skip: CANNOT_RESTRICT }, async () => {
	await withTree(async ({ cwd, verdict }) => {
		const path = join(cwd, "tests", "widgets-count.test.mjs");
		try {
			await chmod(path, 0o000);
			const after = await verdict();
			assert.equal(after.fresh, false);
			assert.ok(after.reread.coverage.uncovered_relevant_inputs.includes("tests/widgets-count.test.mjs"), JSON.stringify(after.reread.coverage.uncovered_relevant_inputs));
			assert.equal(after.reread.manifest.some((e) => e.path === "tests/widgets-count.test.mjs"), false, "an unreadable file is not in the manifest as if read");
		} finally {
			await chmod(path, 0o644);
		}
	});
});

// ---------------------------------------------------------------- (t) a real git worktree (`.git` file) resolves HEAD by reading files only

/** git is spawned here only to SET UP the fixture; readWorkingTree itself spawns nothing (its module imports no child_process). */
async function gitFixtureAvailable() {
	try {
		await execFileAsync("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

test("(t) readWorkingTree in a git worktree: `.git` is a gitdir: file; HEAD resolves through gitdir + commondir; switching the worktree's branch is STALE", async (t) => {
	if (!(await gitFixtureAvailable())) return t.skip("git is not on PATH to set up the fixture");
	const source = await readFile(join(REPO_ROOT, "mcp-server", "working-tree.ts"), "utf8");
	assert.equal(/^import .*child_process/m.test(source), false, "the reader never runs git");
	const dir = await mkdtemp(join(tmpdir(), "cc-e08-wt-"));
	try {
		const main = join(dir, "main");
		const wt = join(dir, "wt");
		await mkdir(main);
		// Every git call in this fixture, including the ones run inside the
		// worktree, goes through the same environment. On Windows a checkout
		// run outside it picks up the runner's system core.autocrlf=true and
		// rewrites a.txt with CRLF, which a byte-exact re-read rightly calls
		// STALE. The isolation import at the top of the file removes the
		// system and global config for the whole process; the identity is
		// set here.
		const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		const gitAt = (cwd, ...args) => execFileAsync("git", args, { cwd, env: gitEnv });
		const git = (...args) => gitAt(main, ...args);
		await git("init", "-q", "-b", "main");
		await writeFile(join(main, "a.txt"), "a\n");
		await git("add", "a.txt");
		await git("commit", "-q", "-m", "one");
		const first = (await git("rev-parse", "HEAD")).stdout.trim();
		await writeFile(join(main, "a.txt"), "b\n");
		await git("commit", "-q", "-am", "two");
		const second = (await git("rev-parse", "HEAD")).stdout.trim();
		await git("branch", "-q", "feature", first);
		await git("worktree", "add", "-q", wt, "feature");
		// A `.git` FILE with a gitdir: line, as `git worktree add` lays it out.
		const dotGit = await readFile(join(wt, ".git"), "utf8");
		assert.match(dotGit, /^gitdir: /);

		const captured = await readWorkingTree(wt, SNAPSHOT);
		assert.equal(captured.ok, true, captured.ok ? "" : captured.reason);
		assert.equal(captured.reread.repository.head, first, "the WORKTREE's head, not the main checkout's");
		assert.notEqual(captured.reread.repository.head, second);
		assert.deepEqual(captured.reread.manifest.map((e) => e.path), ["a.txt"]);
		const candidate = { ...SNAPSHOT, ...captured.reread, digest: computeSnapshotDigest(captured.reread) };

		const untouched = await readWorkingTree(wt, candidate);
		assert.equal(untouched.ok, true);
		assert.equal(checkCandidateFreshness(candidate, untouched.reread).ok, true, "an untouched worktree is FRESH");

		// Switch the worktree's branch: HEAD moves (and here the bytes too).
		await gitAt(wt, "checkout", "-q", "--detach", second);
		const switched = await readWorkingTree(wt, candidate);
		assert.equal(switched.ok, true);
		assert.equal(switched.reread.repository.head, second);
		assert.equal(checkCandidateFreshness(candidate, switched.reread).ok, false, "a switched worktree is STALE");

		// A branch ref that lives only in packed-refs of the COMMON dir still resolves.
		await gitAt(wt, "checkout", "-q", "feature");
		await git("pack-refs", "--all");
		const packed = await readWorkingTree(wt, candidate);
		assert.equal(packed.ok, true, packed.ok ? "" : packed.reason);
		assert.equal(packed.reread.repository.head, first);
		assert.equal(checkCandidateFreshness(candidate, packed.reread).ok, true);

		// Malformed `.git` files refuse with a clear reason, and nothing is followed.
		for (const [label, content] of [["no gitdir line", "hello\n"], ["empty gitdir", "gitdir: \n"], ["gitdir naming a missing dir", "gitdir: ../nowhere\n"], ["gitdir naming a file", "gitdir: ../main/a.txt\n"]]) {
			await writeFile(join(wt, ".git"), content);
			const bad = await readWorkingTree(wt, candidate);
			assert.equal(bad.ok, false, label);
			assert.match(bad.reason, /no HEAD could be read/, label);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
