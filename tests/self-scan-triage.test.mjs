// Triage of the Broad-Side self-scan leads in issue #134. Every lead was
// verified against the code before anything here was written; this file holds
// the regression tests for the leads that turned out to be real, plus one pin
// for the lead whose "likely false positive" verdict asked for a legacy-status
// check.
//
// True regression tests — red against the unfixed code:
//   lead 2  phase-compaction: a phase session whose cwd has no workspace hit a
//           TypeError inside the compaction hook, surfaced as a warning.
//   lead 4  the dashboard's closeout and timeline comparators returned -1 for
//           equal keys, so same-date rows rendered in implementation-defined
//           (in V8: reversed) order.
//   lead 5  codecarto_library_init accepted a relative library_path where
//           every sibling library tool refuses one, and persisted it to the
//           user-global config.
//   lead 6  parseSimpleYaml missed the closing quote of a double-quoted scalar
//           ending in an escaped backslash, so a trailing comment leaked into
//           the value along with both quotes.
//   lead 7  parseYamlScalar read a lone quote character as the empty string.
//   lead 8  THREAD_LOG.md appends glued onto a last line lacking a newline.
//   lead 9  applyHandoff discarded open_questions / carry_forward entries that
//           had neither id nor description.
//
// Pin only (held before the fix too): lead 1 — completing a phase from a
// legacy status.yaml whose phase record omits the entry arrays.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { phaseCompactionExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/phase-compaction.ts`).href);
const { handleInit, handleLibraryInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

const PIPELINE = "workflow/pipeline-architecture-only.yaml";
const UNTERMINATED_LOG = "# Thread Log\n\n- 2026-01-01 — init — seeded without a trailing newline";

function passingValidation(phaseId = "architecture") {
	return { phaseId, primaryOutput: `findings/${phaseId}/${phaseId}-map.md`, outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
}

async function writeMinimalHandoff(codecarto, phaseId = "architecture") {
	await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(codecarto, "scratch", "handoffs", `${phaseId}.yaml`), `phase_id: ${phaseId}\ncloseout_summary: done\n`, "utf8");
}

function makePipeline(phaseOrder) {
	return { workflow_name: "test", phase_order: phaseOrder, phases: phaseOrder.map((id) => ({ id, primary_output: `findings/${id}/${id}.md` })) };
}

function makeStatus(phaseOrder) {
	const phases = Object.fromEntries(phaseOrder.map((id) => [id, { status: "pending", owner_notes: [], outputs_present: [], open_questions: [], carry_forward: [] }]));
	return { project_name: "test", pipeline: PIPELINE, current_phase: phaseOrder[0], last_updated: "2026-05-13T12:00:00.000Z", schema_version: 1, phases, next_actions: [], post_pipeline: [] };
}

// ─── lead 1 ─────────────────────────────────────────────────────────────────

test("lead 1 (pin): completion tolerates a legacy status.yaml whose phase record omits the entry arrays", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-134-legacy-"));
	try {
		await handleInit({ cwd, pipeline: "architecture-only" });
		const codecarto = join(cwd, ".codecarto");
		// A pre-normalization status: the phase record carries only `status`.
		await writeFile(join(codecarto, "workflow", "status.yaml"), [
			"project_name: legacy",
			`pipeline: ${PIPELINE}`,
			"current_phase: architecture",
			"schema_version: 1",
			"phases:",
			"  architecture:",
			"    status: pending",
			"next_actions: []",
			"post_pipeline: []",
			"",
		].join("\n"), "utf8");
		await writeMinimalHandoff(codecarto);
		const { updatedState } = await core.completeValidatedPhase(cwd, passingValidation(), "test");
		assert.equal(updatedState.status.phases.architecture.status, "complete");
		assert.deepEqual(updatedState.status.phases.architecture.open_questions, []);
		assert.deepEqual(updatedState.status.phases.architecture.carry_forward, []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ─── lead 2 ─────────────────────────────────────────────────────────────────

test("lead 2: the compaction hook falls back silently when the phase session's cwd has no workspace", async () => {
	const handlers = new Map();
	phaseCompactionExtension({ on: (event, handler) => handlers.set(event, handler) });
	const cwd = await mkdtemp(join(tmpdir(), "cc-134-noworkspace-"));
	try {
		const notifications = [];
		const ctx = {
			cwd,
			model: { id: "test-model" },
			hasUI: true,
			ui: { notify: (message, level) => notifications.push({ message, level }) },
			sessionManager: { getSessionName: () => "CodeCartographer phase: contracts" },
			modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("unreachable without a workspace"); } },
		};
		const result = await handlers.get("session_before_compact")({ preparation: {}, signal: undefined }, ctx);
		assert.equal(result, undefined, "host default compaction takes over");
		assert.deepEqual(notifications, [], "a missing workspace is not a failure worth a warning");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ─── lead 4 ─────────────────────────────────────────────────────────────────

test("lead 4: same-date closeouts and same-timestamp runs keep their input order on the dashboard", () => {
	const phaseOrder = ["architecture", "contracts", "protocols"];
	const closeouts = phaseOrder.map((id) => ({ date: "2026-05-12", phaseOrModule: id, fileName: `2026-05-12-${id}.md` }));
	const runs = phaseOrder.map((phase) => ({
		timestamp: "2026-05-12T10:00:00.000Z",
		phase,
		status: "completed",
		turn_count: 1,
		tool_uses: 1,
		duration_ms: 1000,
		tokens: { input: 10, output: 5, cache_write: 0 },
	}));
	const html = core.renderDashboard({
		status: makeStatus(phaseOrder),
		pipeline: makePipeline(phaseOrder),
		usage: { version: 1, runs },
		closeouts,
		outputsPresent: new Map(),
		packageVersion: "test",
		generatedAt: "2026-05-13T12:00:00.000Z",
	});
	const section = (opening) => html.split(opening)[1]?.split("</section>")[0] ?? "";

	const closeoutSection = section('<section class="cc-card cc-closeouts"');
	const closeoutPositions = closeouts.map((c) => closeoutSection.indexOf(c.fileName));
	assert.ok(closeoutPositions.every((p) => p >= 0), "every closeout renders");
	assert.deepEqual([...closeoutPositions].sort((a, b) => a - b), closeoutPositions, "equal dates sort stably");

	const timeline = section('<section class="cc-card cc-timeline"');
	const runPositions = runs.map((r) => timeline.indexOf(`>${r.phase}</a>`));
	assert.ok(runPositions.every((p) => p >= 0), "every run renders");
	assert.deepEqual([...runPositions].sort((a, b) => a - b), runPositions, "equal timestamps sort stably");
});

// ─── lead 5 ─────────────────────────────────────────────────────────────────

test("lead 5: codecarto_library_init refuses a relative library_path like its sibling library tools", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "cc-134-config-"));
	const configPath = join(configDir, "config.yaml");
	const previous = process.env.CODECARTO_USER_CONFIG_PATH;
	process.env.CODECARTO_USER_CONFIG_PATH = configPath;
	try {
		await assert.rejects(
			() => handleLibraryInit({ library_path: "relative/library" }),
			(error) => error instanceof McpError && error.code === ErrorCode.InvalidParams && /absolute/.test(error.message),
		);
		assert.equal(await core.pathExists(configPath), false, "a refused path must not reach the user-global config");

		const libraryPath = join(configDir, "library");
		const result = await handleLibraryInit({ library_path: libraryPath });
		assert.equal(result.structuredContent.libraryPath, libraryPath);
		assert.equal(result.structuredContent.alreadyExisted, false);
		const config = core.parseSimpleYaml(await readFile(configPath, "utf8"));
		assert.equal(config.library.path, libraryPath);
	} finally {
		if (previous === undefined) delete process.env.CODECARTO_USER_CONFIG_PATH;
		else process.env.CODECARTO_USER_CONFIG_PATH = previous;
		await rm(configDir, { recursive: true, force: true });
	}
});

// ─── lead 6 ─────────────────────────────────────────────────────────────────

test("lead 6: a double-quoted scalar ending in an escaped backslash closes before a trailing comment", () => {
	assert.deepEqual(core.parseSimpleYaml('path: "C:\\\\dir\\\\" # windows'), { path: "C:\\dir\\" });
	assert.deepEqual(core.parseSimpleYaml('- "a\\\\" # comment'), ["a\\"]);
	// Neighbors that already held, pinned alongside the fix.
	assert.deepEqual(core.parseSimpleYaml('key: "a\\\\b"'), { key: "a\\b" });
	assert.deepEqual(core.parseSimpleYaml('key: "a\\"b" # comment'), { key: 'a"b' });
	assert.deepEqual(core.parseSimpleYaml('key: "a\\\\"'), { key: "a\\" });
	assert.deepEqual(core.parseSimpleYaml("key: 'a\\\\b'"), { key: "a\\\\b" }, "single quotes have no escapes");
	const roundTrip = { description: "C:\\dir\\", note: 'quote " and backslash \\ and hash #' };
	assert.deepEqual(core.parseSimpleYaml(core.stringifySimpleYaml(roundTrip)), roundTrip);
});

// ─── lead 7 ─────────────────────────────────────────────────────────────────

test("lead 7: short quoted scalars parse to their content, and a lone quote is not the empty string", () => {
	const { parseYamlScalar, parseSimpleYaml } = core;
	assert.equal(parseYamlScalar("'a'"), "a");
	assert.equal(parseYamlScalar('"a"'), "a");
	assert.equal(parseYamlScalar("''"), "");
	assert.equal(parseYamlScalar('""'), "");
	assert.equal(parseYamlScalar("\"'\""), "'");
	assert.equal(parseYamlScalar("'\"'"), '"');
	assert.equal(parseYamlScalar("''''"), "'", "doubled single quote is the YAML escape");
	// The lead itself: a one-character scalar that is a quote was sliced to "".
	assert.equal(parseYamlScalar('"'), '"');
	assert.equal(parseYamlScalar("'"), "'");
	assert.deepEqual(parseSimpleYaml('key: "'), { key: '"' });
	assert.deepEqual(parseSimpleYaml("key: '"), { key: "'" });
});

// ─── lead 8 ─────────────────────────────────────────────────────────────────

test("lead 8: completion and amendment start their THREAD_LOG entries on a fresh line", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-134-threadlog-"));
	try {
		await handleInit({ cwd, pipeline: "architecture-only" });
		const codecarto = join(cwd, ".codecarto");
		const threadLog = join(codecarto, "THREAD_LOG.md");

		await writeFile(threadLog, UNTERMINATED_LOG, "utf8");
		await writeMinimalHandoff(codecarto);
		await core.completeValidatedPhase(cwd, passingValidation(), "test");
		assert.match(await readFile(threadLog, "utf8"), /trailing newline\n- \d{4}-\d{2}-\d{2} — architecture — /);

		await writeFile(threadLog, UNTERMINATED_LOG, "utf8");
		await mkdir(join(codecarto, "scratch", "amendments"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "amendments", "note.yaml"), "schema_version: 1\nnotes:\n  - closing note\ncloseout_summary: Amended.\n", "utf8");
		await core.applyAmendment(cwd, "note");
		assert.match(await readFile(threadLog, "utf8"), /trailing newline\n- \d{4}-\d{2}-\d{2} — amendment:note — /);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("lead 8: scaffold refresh starts its THREAD_LOG entry on a fresh line", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-134-threadlog-"));
	try {
		await handleInit({ cwd, pipeline: "architecture-only" });
		const threadLog = join(cwd, ".codecarto", "THREAD_LOG.md");
		await writeFile(threadLog, UNTERMINATED_LOG, "utf8");
		await core.refreshScaffold(cwd);
		assert.match(await readFile(threadLog, "utf8"), /trailing newline\n- \d{4}-\d{2}-\d{2} — scaffold-refresh — /);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("lead 8: updateStatusAtomically's threadLogEntry channel writes one entry per line", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-134-threadlog-"));
	try {
		await handleInit({ cwd, pipeline: "architecture-only" });
		const threadLog = join(cwd, ".codecarto", "THREAD_LOG.md");
		await writeFile(threadLog, UNTERMINATED_LOG, "utf8");
		await core.updateStatusAtomically(cwd, (state) => ({ state, threadLogEntry: "- 2026-01-02 — test — first" }));
		await core.updateStatusAtomically(cwd, (state) => ({ state, threadLogEntry: "- 2026-01-03 — test — second" }));
		assert.match(await readFile(threadLog, "utf8"), /trailing newline\n- 2026-01-02 — test — first\n- 2026-01-03 — test — second\n$/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ─── lead 9 ─────────────────────────────────────────────────────────────────

test("lead 9: applyHandoff keeps open_questions and carry_forward entries that have neither id nor description", () => {
	const pipeline = makePipeline(["architecture", "contracts"]);
	const status = core.normalizeStatus({
		pipeline: PIPELINE,
		phases: {
			architecture: {
				status: "complete",
				open_questions: [
					{ kind: "needs-runtime-test", deferred_reason: "no fixture captured yet" },
					{ id: "oq-architecture-1", description: "keyed question" },
				],
				carry_forward: [{ kind: "defer-to-phase", target_phase: "contracts", deferred_reason: "unkeyed routing" }],
			},
		},
	}, pipeline, PIPELINE, "/unused");
	const handoff = core.parseHandoff({
		phase_id: "architecture",
		open_questions: [{ id: "oq-architecture-2", description: "new question" }],
	});
	// applyHandoff is exported on its own; an entry that never went through
	// parseHandoff's autoAssignIds must be appended, not pushed and discarded.
	handoff.open_questions.push({ kind: "needs-spec-ruling" });

	core.applyHandoff(status, handoff);

	const openQuestions = status.phases.architecture.open_questions;
	assert.equal(openQuestions.length, 4, `unkeyed entries must survive the merge: ${JSON.stringify(openQuestions)}`);
	assert.ok(openQuestions.some((e) => e.deferred_reason === "no fixture captured yet"));
	assert.ok(openQuestions.some((e) => e.kind === "needs-spec-ruling"));
	assert.ok(openQuestions.some((e) => e.id === "oq-architecture-1"));
	assert.ok(openQuestions.some((e) => e.id === "oq-architecture-2"));
	const carryForward = status.phases.architecture.carry_forward;
	assert.equal(carryForward.length, 1, `unkeyed carry_forward must survive: ${JSON.stringify(carryForward)}`);
	assert.equal(carryForward[0].deferred_reason, "unkeyed routing");
});
