// PARTIAL validation rows become auto open questions only when nothing already
// tracks the gap (self-audit #239, D-M3; spec acceptance scenario M3).
//
// VALIDATE.md asks a PARTIAL row's Evidence cell to name the open_questions or
// carry_forward entry that tracks the gap. Completion used to ignore that and
// add a `needs-maintainer-decision` question for every PARTIAL row regardless,
// so a routed gap was also a duplicate question that every later phase
// re-triaged and an amendment had to close. Creating the questions before the
// handoff was applied also let an id-less handoff question replace a gap
// under the same auto-assigned id.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

function report(rows, overall = "PASS WITH GAPS") {
	return [
		"# Map",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		...rows.map((row, index) => `| ${index + 1} | ${row.criterion} | ${row.result} | ${row.evidence} |`),
		"",
		`**Overall:** ${overall}`,
		"",
	].join("\n");
}

async function withTempRepo(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-partial-rows-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/** Init `pipeline`, write `phase`'s report and handoff, complete it, return the phase record. */
async function completeWith(cwd, { pipeline = "lite", phase = "architecture", output = "findings/architecture/architecture-map.md", rows, handoff }) {
	const codecarto = join(cwd, ".codecarto");
	if (!(await core.pathExists(join(codecarto, "workflow", "status.yaml")))) {
		await server.handleInit({ cwd, pipeline });
	}
	await mkdir(dirname(join(codecarto, output)), { recursive: true });
	await writeFile(join(codecarto, output), report(rows), "utf8");
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", `${phase}.yaml`), handoff, "utf8");
	await server.handleComplete({ cwd });
	const state = await core.getWorkspaceState(cwd);
	return state.status.phases[phase];
}

const autoQuestions = (phase) => phase.open_questions.filter((entry) => entry.kind === "needs-maintainer-decision" && entry.id?.startsWith("oq-"));

test("a PARTIAL row whose evidence names the carry-forward that routes it adds no question (spec M3)", async () => {
	await withTempRepo(async (cwd) => {
		const phase = await completeWith(cwd, {
			rows: [
				{ criterion: "Intent documented.", result: "PASS", evidence: "§Intent" },
				{ criterion: "Public surfaces are identified.", result: "PARTIAL", evidence: "MCP endpoints listed by name only. Routed to `carry_forward` as `arch-CF1` with `target_phase: contracts`." },
			],
			handoff: [
				"phase_id: architecture",
				"closeout_summary: done",
				"carry_forward:",
				"  - id: arch-CF1",
				"    target_phase: contracts",
				"    description: Extract MCP endpoint schemas.",
				"",
			].join("\n"),
		});
		assert.deepEqual(phase.open_questions, [], "the routed gap is tracked by arch-CF1 and needs no duplicate question");
		assert.deepEqual(phase.carry_forward.map((entry) => entry.id), ["arch-CF1"]);
	});
});

test("a PARTIAL row whose evidence names the handoff's open question adds no second one", async () => {
	await withTempRepo(async (cwd) => {
		const phase = await completeWith(cwd, {
			rows: [
				{ criterion: "Runtime lifecycle summarized.", result: "PARTIAL", evidence: "Shutdown ordering unverified; tracked as q-shutdown-order." },
			],
			handoff: [
				"phase_id: architecture",
				"closeout_summary: done",
				"open_questions:",
				"  - id: q-shutdown-order",
				"    kind: needs-runtime-test",
				"    description: In what order do the workers stop?",
				"",
			].join("\n"),
		});
		assert.deepEqual(phase.open_questions.map((entry) => entry.id), ["q-shutdown-order"]);
	});
});

test("a PARTIAL row that names nothing still becomes a question (the safety net stays)", async () => {
	await withTempRepo(async (cwd) => {
		const phase = await completeWith(cwd, {
			rows: [
				{ criterion: "Edge cases documented.", result: "PARTIAL", evidence: "some edges missing" },
			],
			handoff: "phase_id: architecture\ncloseout_summary: done\n",
		});
		assert.deepEqual(phase.open_questions, [
			{ id: "oq-architecture-1", kind: "needs-maintainer-decision", description: "Edge cases documented.", deferred_reason: "some edges missing" },
		]);
	});
});

test("a PARTIAL row that only describes routing without an id is still a question", async () => {
	await withTempRepo(async (cwd) => {
		// "routed to carry_forward" with no id is exactly the evidence cell
		// VALIDATE.md warns against; nothing ties it to the entry, so the net holds.
		const phase = await completeWith(cwd, {
			rows: [
				{ criterion: "Public surfaces are identified.", result: "PARTIAL", evidence: "MCP endpoints listed by name only; routed to carry_forward for contracts." },
			],
			handoff: [
				"phase_id: architecture",
				"closeout_summary: done",
				"carry_forward:",
				"  - id: arch-CF1",
				"    target_phase: contracts",
				"    description: Extract MCP endpoint schemas.",
				"",
			].join("\n"),
		});
		assert.equal(autoQuestions(phase).length, 1);
	});
});

test("an id is matched as a whole token, so arch-CF1 does not satisfy a row naming arch-CF10", async () => {
	await withTempRepo(async (cwd) => {
		const phase = await completeWith(cwd, {
			rows: [
				{ criterion: "Public surfaces are identified.", result: "PARTIAL", evidence: "Routed as arch-CF10." },
			],
			handoff: [
				"phase_id: architecture",
				"closeout_summary: done",
				"carry_forward:",
				"  - id: arch-CF1",
				"    target_phase: contracts",
				"    description: Extract MCP endpoint schemas.",
				"",
			].join("\n"),
		});
		assert.equal(autoQuestions(phase).length, 1, "arch-CF10 is not an entry; the gap is untracked");
	});
});

test("an entry an earlier phase already tracks counts as tracking", async () => {
	await withTempRepo(async (cwd) => {
		await completeWith(cwd, {
			rows: [{ criterion: "Intent documented.", result: "PASS", evidence: "§Intent" }],
			handoff: [
				"phase_id: architecture",
				"closeout_summary: done",
				"open_questions:",
				"  - id: q-storage-engine",
				"    kind: needs-maintainer-decision",
				"    description: Which storage engine is canonical?",
				"",
			].join("\n"),
		});
		// contracts inherits the gap and says so; it must not register it again.
		const contracts = await completeWith(cwd, {
			phase: "contracts",
			output: "findings/contracts/behavioral-contracts.md",
			rows: [
				{ criterion: "Persisted state is documented.", result: "PARTIAL", evidence: "Storage contract inherits q-storage-engine, still open." },
			],
			handoff: "phase_id: contracts\ncloseout_summary: done\n",
		});
		assert.deepEqual(contracts.open_questions, []);
		const state = await core.getWorkspaceState(cwd);
		assert.deepEqual(state.status.phases.architecture.open_questions.map((entry) => entry.id), ["q-storage-engine"]);
	});
});

test("an id-less handoff question no longer replaces a PARTIAL gap under the same auto id", async () => {
	await withTempRepo(async (cwd) => {
		const phase = await completeWith(cwd, {
			rows: [
				{ criterion: "Edge cases documented.", result: "PARTIAL", evidence: "some edges missing" },
			],
			handoff: [
				"phase_id: architecture",
				"closeout_summary: done",
				"open_questions:",
				"  - description: An id-less handoff question",
				"    kind: needs-runtime-test",
				"",
			].join("\n"),
		});
		assert.deepEqual(phase.open_questions, [
			{ id: "oq-architecture-1", kind: "needs-runtime-test", description: "An id-less handoff question" },
			{ id: "oq-architecture-2", kind: "needs-maintainer-decision", description: "Edge cases documented.", deferred_reason: "some edges missing" },
		]);
	});
});

test("re-running completion on the same PARTIAL output adds no second copy of the gap", async () => {
	await withTempRepo(async (cwd) => {
		const rows = [{ criterion: "Edge cases documented.", result: "PARTIAL", evidence: "some edges missing" }];
		const handoff = "phase_id: architecture\ncloseout_summary: done\n";
		const first = await completeWith(cwd, { rows, handoff });
		assert.equal(autoQuestions(first).length, 1);
		// Completion is idempotent by design; drive it a second time directly.
		const state = await core.getWorkspaceState(cwd);
		const validation = await core.validatePhaseOutput(state, "architecture");
		await core.completeValidatedPhase(cwd, validation, "test");
		const again = (await core.getWorkspaceState(cwd)).status.phases.architecture;
		assert.deepEqual(again.open_questions.map((entry) => entry.id), ["oq-architecture-1"]);
	});
});
