// The supervised Traverse procedure (E08, #406).
//
// Traverse is the loop that joins the records into usable work: intake a
// change, check the host can do what the loop needs, start or resume an
// attempt, let the HOST execute, ingest what it observed, get a fresh review,
// and ask a human. CodeCartographer never runs the build.
//
// WHAT THESE TESTS REFUSE TO DO
//
// The issue is explicit: "Tests must not pretend string checks establish
// runtime behavior." A SKILL.md is prose read by an agent, and no assertion
// about its wording proves an agent obeyed it. So the tests split in two:
//
//   1. Behaviour tests, against the real procedure module: bounded next
//      actions, resume from durable records, distinct failed/blocked/
//      needs-human states, and refusal to repeat a side effect whose
//      acknowledgement was lost. These are runtime claims and are executed.
//
//   2. Document tests, against SKILL.md and the template: structural only --
//      that a required section EXISTS and that the document does not promise
//      enforcement the code does not provide. A document test never claims
//      the procedure works; it claims the document does not lie about what
//      the procedure does.
//
// The second category is deliberately weak and labelled as such. The failure
// mode being avoided is a suite that looks thorough because it greps a
// paragraph, while nothing exercises the loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(join(REPO_ROOT, "core/engineering/index.ts")).href);
const { openStore, planTraverseStep, TRAVERSE_STOP_REASONS } = engineering;

const FIXTURES = join(REPO_ROOT, "tests/fixtures/engineering/v1/valid");
const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));

async function withStore(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-traverse-"));
	try {
		return await fn(await openStore(dir), dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/** A host that can do everything the loop needs. */
const CAPABLE_HOST = {
	can_obtain_human_decision: true,
	can_execute: true,
	storage: { boundary: "host-enforced", protection: "continuous-since-initialization" },
	bounds: { max_attempts: 3, max_wall_clock_ms: 600_000 },
};

// ---------------------------------------------------------------------------
// Behaviour: every next action is bounded
// ---------------------------------------------------------------------------

test("the next action is a single named step, never an open instruction", async () => {
	await withStore(async (store) => {
		const change = await readFixture("change.json");
		await store.put(change);
		const step = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		assert.equal(typeof step.action, "string");
		assert.ok(step.action.length > 0);
		// A bounded step names exactly one thing to do and what would end it.
		assert.ok(Array.isArray(step.bounds.limits), "a step without limits is unbounded");
		assert.ok(step.bounds.limits.length > 0, "no limit was stated for this step");
		assert.ok(typeof step.rationale === "string" && step.rationale.length > 0);
		// And it never instructs the host to decide for a human.
		assert.ok(!/approve|accept on behalf|sign off/i.test(step.action), `the step invites self-approval: ${step.action}`);
	});
});

test("a change with no slices asks for planning, not execution", async () => {
	await withStore(async (store) => {
		const change = await readFixture("change.json");
		await store.put(change);
		const step = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		assert.equal(step.action, "plan-slices");
		assert.ok(!/execute|run|build/i.test(step.action));
	});
});

test("an unknown change stops rather than inventing a first step", async () => {
	await withStore(async (store) => {
		const step = await planTraverseStep(store, { change_id: "chg_ffffffffffffffffffffffff", host: CAPABLE_HOST });
		assert.equal(step.action, "stop");
		assert.equal(step.stop_reason, "unknown-change");
		assert.ok(TRAVERSE_STOP_REASONS.includes(step.stop_reason));
	});
});

// ---------------------------------------------------------------------------
// Behaviour: resume from durable records
// ---------------------------------------------------------------------------

test("a fresh session resumes from records alone, with no in-memory state", async () => {
	await withStore(async (store, dir) => {
		const [change, slice, attempt] = await Promise.all(["change.json", "slice.json", "attempt.json"].map(readFixture));
		for (const record of [change, slice, attempt]) await store.put(record);

		const first = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });

		// A genuinely new store over the same directory: nothing carried over.
		const reopened = await openStore(dir);
		const second = await planTraverseStep(reopened, { change_id: change.id, host: CAPABLE_HOST });
		assert.deepEqual(second, first, "the resumed step differs from the original");
		assert.ok(second.resumed_from, "a resumed step does not say what it resumed from");
		assert.equal(second.resumed_from.attempt_id, attempt.id);
	});
});

test("a resumed session reports prior failures and blockers rather than hiding them", async () => {
	await withStore(async (store) => {
		const [change, slice, attempt] = await Promise.all(["change.json", "slice.json", "attempt.json"].map(readFixture));
		for (const record of [change, slice]) await store.put(record);
		await store.put({ ...attempt, outcome: "failed", failure_summary: "the build did not compile" });

		const step = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		assert.ok(Array.isArray(step.history), "a resumed step carries no history");
		assert.ok(step.history.some((entry) => /failed/.test(entry)), `prior failure is not surfaced: ${JSON.stringify(step.history)}`);
	});
});

// ---------------------------------------------------------------------------
// Behaviour: failed, blocked and needs-human stay distinct
// ---------------------------------------------------------------------------

test("failed, blocked and needs-human produce different next actions", async () => {
	await withStore(async (store) => {
		const [change, slice, attempt] = await Promise.all(["change.json", "slice.json", "attempt.json"].map(readFixture));
		for (const record of [change, slice]) await store.put(record);

		// One attempt per outcome, in separate stores: an attempt is an
		// immutable observation, so the loop sees the LATEST attempt and its
		// outcome must not be rewritten under it.
		const seen = new Map();
		for (const outcome of ["failed", "blocked", "ready-for-review"]) {
			const extra = {
				...attempt,
				outcome,
				...(outcome === "blocked" ? { block_reason: "the staging database is unreachable" } : {}),
				...(outcome === "running" ? {} : { ended_at: attempt.ended_at ?? "2026-01-01T00:00:01.000Z" }),
			};
			await withStore(async (isolated) => {
				for (const record of [change, slice]) await isolated.put(record);
				await isolated.put(extra);
				const step = await planTraverseStep(isolated, { change_id: change.id, host: CAPABLE_HOST });
				seen.set(outcome, step.action);
			});
		}
		// Collapsing these three is how a blocked change gets retried forever
		// and a finished one gets rebuilt.
		assert.equal(new Set(seen.values()).size, 3, `the three outcomes collapsed: ${JSON.stringify([...seen])}`);
	});
});

test("a blocked attempt names what would unblock it", async () => {
	await withStore(async (store) => {
		const [change, slice, attempt] = await Promise.all(["change.json", "slice.json", "attempt.json"].map(readFixture));
		for (const record of [change, slice]) await store.put(record);
		await store.put({ ...attempt, outcome: "blocked", block_reason: "the staging database is unreachable" });
		const step = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		assert.match(step.rationale, /staging database is unreachable/, "the recorded blocker is not reported to the next session");
	});
});

// ---------------------------------------------------------------------------
// Behaviour: host bounds and capability
// ---------------------------------------------------------------------------

test("an incapable host stops before asking for a human decision it cannot obtain", async () => {
	await withStore(async (store) => {
		const [change, slice, attempt, snapshot] = await Promise.all(
			["change.json", "slice.json", "attempt.json", "snapshot-candidate.json"].map(readFixture),
		);
		for (const record of [change, slice, snapshot]) await store.put(record);
		await store.put({ ...attempt, outcome: "ready-for-review" });

		const step = await planTraverseStep(store, {
			change_id: change.id,
			host: { ...CAPABLE_HOST, can_obtain_human_decision: false },
		});
		assert.equal(step.action, "stop");
		assert.equal(step.stop_reason, "host-cannot-obtain-human-decision");
		assert.match(step.rationale, /cannot/i);
	});
});

test("the attempt budget is enforced, and exhausting it stops rather than looping", async () => {
	await withStore(async (store) => {
		const [change, slice] = await Promise.all(["change.json", "slice.json"].map(readFixture));
		for (const record of [change, slice]) await store.put(record);
		const attempt = await readFixture("attempt.json");
		// Three failed attempts against a budget of three.
		for (let i = 0; i < 3; i++) {
			await store.put({
				...attempt,
				id: `att_${String(i).padStart(24, "0")}`,
				outcome: "failed",
				failure_summary: `attempt ${i} did not compile`,
			});
		}
		const step = await planTraverseStep(store, {
			change_id: change.id,
			host: { ...CAPABLE_HOST, bounds: { max_attempts: 3, max_wall_clock_ms: 600_000 } },
		});
		assert.equal(step.action, "stop");
		assert.equal(step.stop_reason, "attempt-budget-exhausted");
	});
});

test("a host with no declared bounds is refused: unbounded execution is not a default", async () => {
	await withStore(async (store) => {
		const change = await readFixture("change.json");
		await store.put(change);
		await assert.rejects(
			() => planTraverseStep(store, { change_id: change.id, host: { ...CAPABLE_HOST, bounds: undefined } }),
			/bounds/i,
			"a host without bounds was allowed to proceed",
		);
	});
});

// ---------------------------------------------------------------------------
// Behaviour: never repeat a side effect because an acknowledgement was lost
// ---------------------------------------------------------------------------

test("an attempt already recorded as started is not started again", async () => {
	// The issue's explicit requirement. A lost acknowledgement must not turn
	// into a second external side effect: the loop reads what is on disk, and
	// a started attempt is resumed, never re-created.
	await withStore(async (store) => {
		const [change, slice, attempt] = await Promise.all(["change.json", "slice.json", "attempt.json"].map(readFixture));
		for (const record of [change, slice]) await store.put(record);
		await store.put({ ...attempt, ended_at: undefined, outcome: "running" });

		const first = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		const second = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		assert.notEqual(first.action, "start-attempt", "a running attempt was started again");
		assert.deepEqual(second, first, "planning twice produced two different next actions");
		assert.ok(first.idempotency_key, "the step carries no key the host can use to deduplicate");
		assert.equal(first.idempotency_key, second.idempotency_key, "the deduplication key changes between reads");
	});
});

test("the step's idempotency key is derived from the records, not the clock", async () => {
	await withStore(async (store) => {
		const [change, slice, attempt] = await Promise.all(["change.json", "slice.json", "attempt.json"].map(readFixture));
		for (const record of [change, slice]) await store.put(record);
		await store.put({ ...attempt, ended_at: undefined, outcome: "running" });
		const a = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		await new Promise((r) => setTimeout(r, 25));
		const b = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		assert.equal(a.idempotency_key, b.idempotency_key, "the key moved with the clock, so a retry looks like new work");
	});
});

// ---------------------------------------------------------------------------
// Document structure. DELIBERATELY WEAK -- these assert a document exists and
// is honest about its own limits. None of them establishes runtime behaviour.
// ---------------------------------------------------------------------------

test("the traverse skill document exists and states that it does not execute", async () => {
	const text = await readFile(join(REPO_ROOT, ".codecarto/skills/traverse/SKILL.md"), "utf8");
	// Structural: the sections a host needs in order to follow the loop.
	for (const heading of ["## Intake", "## Readiness", "## Execute", "## Ingest", "## Review", "## Acceptance", "## Stopping and resuming"]) {
		assert.ok(text.includes(heading), `SKILL.md is missing ${heading}`);
	}
	// Honesty: the document must not claim it enforces anything.
	assert.match(text, /prose is not enforcement|this document does not enforce/i, "SKILL.md does not disclaim enforcement");
});

test("the skill document does not promise a capability the code refuses", async () => {
	// The specific lie to prevent: prose telling a host it may accept work
	// through this loop, when the gate refuses to offer acceptance without a
	// trusted channel.
	const text = await readFile(join(REPO_ROOT, ".codecarto/skills/traverse/SKILL.md"), "utf8");
	assert.ok(!/you may (approve|accept) (the|this) (change|work)/i.test(text), "SKILL.md invites self-acceptance");
	assert.match(text, /human/i, "SKILL.md never mentions the human decision it depends on");
});

test("the record template has a slot for every state the loop can stop in", async () => {
	const text = await readFile(join(REPO_ROOT, ".codecarto/templates/traverse-record.md"), "utf8");
	for (const reason of TRAVERSE_STOP_REASONS) {
		assert.ok(text.includes(reason), `the template cannot record the stop reason ${reason}`);
	}
});

// ---------------------------------------------------------------------------
// Eligibility: traverse is reachable without a completed analysis pipeline.
//
// An engineering change is not a post-pipeline activity. Requiring a full
// analysis run before a one-line fix can be tracked would make the record
// system unusable for exactly the changes it is most useful for.
//
// The risk is the fix being too broad: an exemption that accidentally serves
// EVERY skill without the gate would silently remove a guard the analysis
// pipeline depends on. So these tests assert both halves -- traverse is
// exempt, and everything else still is not.
// ---------------------------------------------------------------------------

test("the traverse skill is served without a completed pipeline", async () => {
	const { handleSkill } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
	const dir = await mkdtemp(join(tmpdir(), "cc-elig-"));
	try {
		// A real workspace, initialized the way a user initializes one, with
		// no phases run. Hand-making a .codecarto directory would test a state
		// the product never produces.
		const { handleInit } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
		await handleInit({ cwd: dir });
		const result = await handleSkill({ cwd: dir, name: "traverse" });
		const text = result.content.map((part) => part.text).join("");
		// handleSkill returns a PROMPT that points at the skill, not the skill
		// body. Asserting on the body here would have been asserting against
		// an API this code does not have.
		assert.match(text, /skills\/traverse\/SKILL\.md/, "the prompt does not point at the traverse skill");
		assert.equal(result.structuredContent.postPipeline, false, "traverse is reported as a post-pipeline skill");
		// And it must not open by telling the agent the pipeline is complete
		// when no phase has run.
		assert.ok(!/pipeline is `complete`/.test(text), "the prompt claims a completed pipeline in a workspace that has run none");
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("the exemption is narrow: other skills are still pipeline-gated", async () => {
	const { handleSkill } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
	const dir = await mkdtemp(join(tmpdir(), "cc-elig2-"));
	try {
		const { handleInit } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
		await handleInit({ cwd: dir });
		// The pre-existing post-pipeline skill must NOT have become reachable.
		await assert.rejects(
			() => handleSkill({ cwd: dir, name: "spec-delta-application" }),
			/pipeline is not complete|No CodeCartographer workspace/i,
			"the engineering exemption also un-gated an unrelated post-pipeline skill",
		);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("the eligibility check matches the exact name, not a prefix", async () => {
	// `traverse-everything` must not inherit the exemption by starting with
	// the exempt name -- a startsWith check here would be a bypass.
	const { handleSkill } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
	const dir = await mkdtemp(join(tmpdir(), "cc-elig3-"));
	try {
		const { handleInit } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
		await handleInit({ cwd: dir });
		await assert.rejects(
			() => handleSkill({ cwd: dir, name: "traverse-everything" }),
			/pipeline is not complete|Unknown skill|No CodeCartographer workspace/i,
			"a name merely starting with the exempt name was served",
		);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("the loop reads the newest attempt, not merely the last one written", async () => {
	// Ordering is load-bearing and was untested: every other test plants ONE
	// attempt, so a loop that read them in arbitrary order passed. A change
	// that failed and was then retried successfully must not be reported as
	// still failing, and the ids are not chronological.
	await withStore(async (store) => {
		const [change, slice, attempt] = await Promise.all(["change.json", "slice.json", "attempt.json"].map(readFixture));
		for (const record of [change, slice]) await store.put(record);

		// Written newest-first, with ids that sort OPPOSITE to their times, so
		// neither insertion order nor id order can accidentally be right.
		// Ids whose sort order is UNRELATED to chronology. Earlier fixtures had
		// ids sorting exactly opposite to time, which makes reverse(), id-desc
		// and sort-by-time all the SAME list -- three wrong orderings passed.
		// Here: e is newest, a is middle, f is oldest, so the true order
		// [f, a, e] matches no permutation rule.
		await store.put({
			...attempt,
			id: "att_eeeeeeeeeeeeeeeeeeeeeeee",
			outcome: "blocked",
			block_reason: "the newest attempt is blocked on an operator",
			started_at: "2026-01-20T00:00:00.000Z",
			ended_at: "2026-01-20T00:00:05.000Z",
		});
		await store.put({
			...attempt,
			id: "att_aaaaaaaaaaaaaaaaaaaaaaaa",
			outcome: "failed",
			failure_summary: "the middle attempt also failed",
			started_at: "2026-01-09T00:00:00.000Z",
			ended_at: "2026-01-09T00:00:05.000Z",
		});
		await store.put({
			...attempt,
			id: "att_ffffffffffffffffffffffff",
			outcome: "failed",
			failure_summary: "the older attempt did not compile",
			started_at: "2026-01-01T00:00:00.000Z",
			ended_at: "2026-01-01T00:00:05.000Z",
		});

		const step = await planTraverseStep(store, { change_id: change.id, host: CAPABLE_HOST });
		assert.equal(step.action, "stop", `the loop resumed the wrong attempt: ${step.action} (${step.rationale})`);
		assert.equal(step.stop_reason, "blocked-needs-operator", `the loop read an attempt other than the newest: ${step.rationale}`);
		assert.match(step.rationale, /blocked on an operator/);
		// The ordering itself, not just which record came last: history is
		// emitted in list order, so this pins the sort rather than one lucky
		// element. Oldest failure first, newest blocker last.
		const chronological = step.history.map((entry) => entry.split(" ")[1]);
		assert.deepEqual(
			chronological,
			["att_ffffffffffffffffffffffff", "att_aaaaaaaaaaaaaaaaaaaaaaaa", "att_eeeeeeeeeeeeeeeeeeeeeeee"],
			`attempts were not ordered by time: ${JSON.stringify(step.history)}`,
		);
		// The older failure is still reported as history, not silently dropped.
		assert.ok(step.history.some((entry) => /did not compile/.test(entry)), "the earlier failure vanished from history");
	});
});
