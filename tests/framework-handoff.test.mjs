// Behavior tests for framework-owned phase handoffs, schema-safe status migration,
// idempotent completion, and duplicate-key rejection.
// Strict TDD: write failing tests first, then implement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const {
	parseSimpleYaml,
	stringifySimpleYaml,
	loadYamlFile,
} = await import(pathToFileURL(`${REPO_ROOT}/core/yaml.ts`).href);

const {
	normalizeStatus,
	createEmptyStatus,
	ensurePhaseRecord,
	acquireLock,
} = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);

const {
	getWorkspaceState,
	updateStatusAtomically,
} = await import(pathToFileURL(`${REPO_ROOT}/core/workspace.ts`).href);

const {
	buildPhasePrompt,
} = await import(pathToFileURL(`${REPO_ROOT}/core/prompts.ts`).href);

const {
	PIPELINE_ALIASES,
	DEFAULT_PIPELINE_PATH,
} = await import(pathToFileURL(`${REPO_ROOT}/core/pipeline.ts`).href);

// Helpers
async function initWorkspace(cwd, pipeline = DEFAULT_PIPELINE_PATH) {
	const targetWorkspaceDir = join(cwd, ".codecarto");
	const packaged = join(REPO_ROOT, ".codecarto");
	const { cp } = await import("node:fs/promises");
	await cp(packaged, targetWorkspaceDir, { recursive: true });
	// Patch status.yaml with chosen pipeline
	const statusPath = join(targetWorkspaceDir, "workflow", "status.yaml");
	const raw = await loadYamlFile(statusPath);
	raw.pipeline = pipeline;
	await writeFile(statusPath, `${stringifySimpleYaml(raw)}\n`, "utf8");
}

// ---------------------------------------------------------------
// 1. Handoff schema parsing and validation
// ---------------------------------------------------------------

test("parseSimpleYaml rejects duplicate keys at the same mapping level", () => {
	const yaml = `
project_name: A
project_name: B
`;
	assert.throws(() => parseSimpleYaml(yaml), /Duplicate YAML key/);
});

test("parseSimpleYaml rejects duplicate keys in nested mappings", () => {
	const yaml = `
phases:
  architecture:
    status: pending
    status: complete
`;
	assert.throws(() => parseSimpleYaml(yaml), /Duplicate YAML key/);
});

test("parseSimpleYaml tolerates duplicate keys when they are in sibling mappings at different paths", () => {
	const yaml = `
phases:
  architecture:
    status: pending
  contracts:
    status: complete
`;
	const result = parseSimpleYaml(yaml);
	assert.equal(result.phases.architecture.status, "pending");
	assert.equal(result.phases.contracts.status, "complete");
});

// ---------------------------------------------------------------
// 2. schema_version migration
// ---------------------------------------------------------------

test("normalizeStatus adds schema_version: 1 when missing", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const state = await getWorkspaceState(cwd);
		assert.equal(state.status.schema_version, 1, "missing schema_version should normalize to 1");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("normalizeStatus rejects unsupported future schema versions", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		const raw = await loadYamlFile(statusPath);
		raw.schema_version = 3;
		await writeFile(statusPath, `${stringifySimpleYaml(raw)}\n`, "utf8");
		await assert.rejects(() => getWorkspaceState(cwd), /Unsupported status schema_version 3/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("stringifySimpleYaml serializes schema_version as a top-level integer", () => {
	const obj = { schema_version: 2, project_name: "X" };
	const yaml = stringifySimpleYaml(obj);
	assert.match(yaml, /^schema_version: 2$/m);
});

// ---------------------------------------------------------------
// 3. Handoff artifact: core/types and core/status support
// ---------------------------------------------------------------

test("parseHandoff is exported from status module", async () => {
	const { parseHandoff } = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);
	assert.equal(typeof parseHandoff, "function");
});

test("parseHandoff validates required fields and rejects unknown shapes", async () => {
	const { parseHandoff } = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);
	assert.throws(() => parseHandoff(null), /Invalid handoff/);
	assert.throws(() => parseHandoff({}), /phase_id is required/);
	assert.doesNotThrow(() => parseHandoff({ phase_id: "architecture" }));
	assert.throws(() => parseHandoff({ phase_id: "architecture", owner_notes: "not-an-array" }), /owner_notes must be an array/);
});

test("parseHandoff accepts minimal valid handoff", async () => {
	const { parseHandoff } = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);
	const result = parseHandoff({
		phase_id: "architecture",
		timestamp: "2026-07-20T00:00:00Z",
		owner_notes: ["note1"],
		open_questions: [],
		carry_forward: [],
		carry_forward_closures: [],
		decisions: [],
		closeout_content: "",
		closeout_summary: "",
	});
	assert.equal(result.phase_id, "architecture");
});

test("handoff lookup rejects unsafe phase IDs before path resolution", async () => {
	const { loadHandoffFile } = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);
	await assert.rejects(() => loadHandoffFile("../../escape", tmpdir()), /Invalid phase id/);
});

// ---------------------------------------------------------------
// 4. Prompt text no longer instructs agents to edit status.yaml or thread_log
// ---------------------------------------------------------------

test("buildPhasePrompt does not tell the agent to edit workflow/status.yaml", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const state = await getWorkspaceState(cwd);
		const prompt = await buildPhasePrompt(state, state.pipeline.phases[0], false);
		assert.ok(!prompt.includes("remove the entry from the source phase's carry_forward in workflow/status.yaml"), "old carry_forward editing instruction must be removed");
		assert.ok(!prompt.includes("append a one-line index entry to THREAD_LOG.md"), "old thread_log append instruction must be removed");
		assert.ok(prompt.includes("handoff"), "prompt must mention the handoff artifact");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("buildSkillPrompt does not tell the agent to edit workflow/status.yaml", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const state = await getWorkspaceState(cwd);
		// Import buildSkillPrompt
		const { buildSkillPrompt } = await import(pathToFileURL(`${REPO_ROOT}/core/prompts.ts`).href);
		const prompt = await buildSkillPrompt(state, "spec-delta-application");
		assert.ok(!prompt.includes("remove the entry from"), "skill prompt must not direct edits to status.yaml");
		assert.ok(!prompt.includes("append a one-line index entry to THREAD_LOG.md"), "skill prompt must not use the obsolete phase-completion wording");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------
// 5. updateStatusAtomically accepts handoff and applies it under lock
// ---------------------------------------------------------------

test("updateStatusAtomically accepts a handoff and writes it to the phase", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const state = await getWorkspaceState(cwd);
		const handoff = {
			phase_id: "architecture",
			timestamp: "2026-07-20T00:00:00Z",
			owner_notes: ["inspected src/"],
			open_questions: [{ id: "oq1", kind: "needs-runtime-test", description: "Q" }],
			carry_forward: [{ id: "cf1", kind: "defer-to-phase", target_phase: "contracts", description: "D" }],
			carry_forward_closures: [],
			decisions: ["use yaml"],
			closeout_content: "## Closeout\nDone.",
			closeout_summary: "Architecture closeout",
		};
		const next = await updateStatusAtomically(cwd, () => ({
			state,
			handoff,
			threadLogEntry: "- 2026-07-20 — architecture — closeout\n",
		}));
		assert.equal(next.status.phases.architecture.owner_notes.includes("inspected src/"), true);
		assert.equal(next.status.phases.architecture.open_questions.length, 1);
		assert.equal(next.status.phases.architecture.carry_forward.length, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------
// 6. Idempotent completion
// ---------------------------------------------------------------

test("completing the same phase twice with handoff is idempotent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const state = await getWorkspaceState(cwd);
		const handoff = {
			phase_id: "architecture",
			timestamp: "2026-07-20T00:00:00Z",
			owner_notes: ["first"],
			open_questions: [],
			carry_forward: [],
			carry_forward_closures: [],
			decisions: [],
			closeout_content: "",
			closeout_summary: "",
		};
		await updateStatusAtomically(cwd, () => ({
			state: { ...state, status: { ...state.status, phases: { ...state.status.phases, architecture: { ...state.status.phases.architecture, status: "complete" } } } },
			handoff,
			threadLogEntry: "- 2026-07-20 — architecture — first\n",
		}));

		const threadLogPath = join(cwd, ".codecarto", "THREAD_LOG.md");
		const firstLog = await readFile(threadLogPath, "utf8");

		// Second call with same handoff should not append duplicate thread log
		await updateStatusAtomically(cwd, () => ({
			state: { ...state, status: { ...state.status, phases: { ...state.status.phases, architecture: { ...state.status.phases.architecture, status: "complete" } } } },
			handoff,
			threadLogEntry: "- 2026-07-20 — architecture — first\n",
		}));

		const secondLog = await readFile(threadLogPath, "utf8");
		assert.equal(firstLog, secondLog, "THREAD_LOG must not duplicate on retry");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------
// 7. Null / malformed collection rejection
// ---------------------------------------------------------------

test("ensurePhaseRecord normalizes null open_questions and carry_forward to []", () => {
	const record = ensurePhaseRecord({
		architecture: {
			status: "complete",
			owner_notes: [],
			outputs_present: [],
			open_questions: null,
			carry_forward: null,
		},
	});
	assert.deepEqual(record.architecture.open_questions, []);
	assert.deepEqual(record.architecture.carry_forward, []);
});

test("ensurePhaseRecord normalizes missing collections to []", () => {
	const record = ensurePhaseRecord({
		architecture: {
			status: "complete",
		},
	});
	assert.deepEqual(record.architecture.owner_notes, []);
	assert.deepEqual(record.architecture.outputs_present, []);
	assert.deepEqual(record.architecture.open_questions, []);
	assert.deepEqual(record.architecture.carry_forward, []);
});

// ---------------------------------------------------------------
// 8. Backward compatibility: workspaces without handoff still complete
// ---------------------------------------------------------------

test("updateStatusAtomically works without handoff (legacy path)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const state = await getWorkspaceState(cwd);
		const next = await updateStatusAtomically(cwd, () => ({
			state,
			threadLogEntry: "- 2026-07-20 — architecture — legacy\n",
		}));
		assert.equal(next.status.phases.architecture.status, "pending"); // unchanged because no handoff
		const threadLogPath = join(cwd, ".codecarto", "THREAD_LOG.md");
		const log = await readFile(threadLogPath, "utf8");
		assert.ok(log.includes("legacy"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("completeValidatedPhase consumes a handoff with host timestamps and idempotent artifacts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const handoffDir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(handoffDir, { recursive: true });
		await writeFile(join(handoffDir, "architecture.yaml"), `phase_id: architecture\ntimestamp: 2099-01-01T00:00:00Z\nowner_notes:\n  - framework-owned note\nopen_questions: []\ncarry_forward: []\ncarry_forward_closures: []\ndecisions:\n  - preserve evidence\ncloseout_summary: Architecture complete\ncloseout_content: |\n  # Closeout — architecture\n\n  ## Summary\n\n  Architecture complete.\n`, "utf8");
		const { completeValidatedPhase } = await import(pathToFileURL(`${REPO_ROOT}/core/completion.ts`).href);
		const validation = { phaseId: "architecture", primaryOutput: "findings/architecture/architecture-map.md", outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
		await completeValidatedPhase(cwd, validation, "test");
		await completeValidatedPhase(cwd, validation, "test");
		const state = await getWorkspaceState(cwd);
		assert.equal(state.status.phases.architecture.status, "complete");
		assert.ok(state.status.phases.architecture.owner_notes.includes("framework-owned note"));
		assert.notEqual(state.status.last_updated, "2099-01-01T00:00:00Z");
		const { readdir } = await import("node:fs/promises");
		const closeouts = (await readdir(join(cwd, ".codecarto", "closeouts"))).filter((name) => name.endsWith("-architecture.md"));
		assert.equal(closeouts.length, 1);
		const log = await readFile(join(cwd, ".codecarto", "THREAD_LOG.md"), "utf8");
		assert.equal(log.split("Architecture complete").length - 1, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("completeValidatedPhase rejects an invalid handoff without mutating status", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const handoffDir = join(cwd, ".codecarto", "scratch", "handoffs");
		await mkdir(handoffDir, { recursive: true });
		await writeFile(join(handoffDir, "architecture.yaml"), "phase_id: architecture\nowner_notes: invalid\n", "utf8");
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		const before = await readFile(statusPath, "utf8");
		const { completeValidatedPhase } = await import(pathToFileURL(`${REPO_ROOT}/core/completion.ts`).href);
		const validation = { phaseId: "architecture", primaryOutput: "findings/architecture/architecture-map.md", outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
		await assert.rejects(() => completeValidatedPhase(cwd, validation, "test"), /owner_notes must be an array/);
		assert.equal(await readFile(statusPath, "utf8"), before);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("MCP and Pi completion surfaces both delegate to framework-owned handoff completion", async () => {
	for (const surface of ["mcp", "pi"]) {
		const cwd = await mkdtemp(join(tmpdir(), `cc-handoff-${surface}-`));
		try {
			await initWorkspace(cwd);
			const outputDir = join(cwd, ".codecarto", "findings", "architecture");
			await mkdir(outputDir, { recursive: true });
			await writeFile(join(outputDir, "architecture-map.md"), "# Architecture\n\n## Validation\n\n| # | Criterion | Result | Evidence |\n|---|---|---|---|\n| 1 | Output exists | PASS | test |\n\n**Overall:** PASS\n", "utf8");
			const handoffDir = join(cwd, ".codecarto", "scratch", "handoffs");
			await mkdir(handoffDir, { recursive: true });
			await writeFile(join(handoffDir, "architecture.yaml"), `phase_id: architecture\nowner_notes:\n  - ${surface}-handoff\n`, "utf8");
			if (surface === "mcp") {
				const { handleComplete } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
				await handleComplete({ cwd, phase: "architecture" });
			} else {
				const { autoCompletePhase } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/auto-runner.ts`).href);
				const validation = { phaseId: "architecture", primaryOutput: "findings/architecture/architecture-map.md", outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
				await autoCompletePhase({ cwd }, validation);
			}
			const state = await getWorkspaceState(cwd);
			assert.ok(state.status.phases.architecture.owner_notes.includes(`${surface}-handoff`));
		} finally {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					await rm(cwd, { recursive: true, force: true });
					break;
				} catch (err) {
					if (err.code === "ENOTEMPTY" && attempt < 2) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						continue;
					}
					throw err;
				}
			}
		}
	}
});

// ---------------------------------------------------------------
// 9. Handoff presence enforcement (issue #84)
// ---------------------------------------------------------------

test("completeValidatedPhase refuses when the phase declares handoff_requirements and no handoff exists", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		const statusPath = join(cwd, ".codecarto", "workflow", "status.yaml");
		const before = await readFile(statusPath, "utf8");
		const { completeValidatedPhase } = await import(pathToFileURL(`${REPO_ROOT}/core/completion.ts`).href);
		const validation = { phaseId: "architecture", primaryOutput: "findings/architecture/architecture-map.md", outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
		await assert.rejects(
			() => completeValidatedPhase(cwd, validation, "test"),
			/scratch\/handoffs\/architecture\.yaml/,
			"refusal must name the expected handoff path",
		);
		assert.equal(await readFile(statusPath, "utf8"), before, "refusal must not mutate status");
		const { readdir } = await import("node:fs/promises");
		const closeouts = (await readdir(join(cwd, ".codecarto", "closeouts"))).filter((name) => name.endsWith("-architecture.md"));
		assert.deepEqual(closeouts, [], "refusal must not write a closeout");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("completeValidatedPhase stays lenient when the phase declares no handoff_requirements", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-"));
	try {
		await initWorkspace(cwd);
		// Strip the declaration from the workspace's pipeline copy: custom
		// pipelines without handoff_requirements keep the pre-#84 behavior.
		const pipelinePath = join(cwd, ".codecarto", DEFAULT_PIPELINE_PATH);
		const pipeline = await loadYamlFile(pipelinePath);
		for (const phase of pipeline.phases) delete phase.handoff_requirements;
		await writeFile(pipelinePath, `${stringifySimpleYaml(pipeline)}\n`, "utf8");
		const { completeValidatedPhase } = await import(pathToFileURL(`${REPO_ROOT}/core/completion.ts`).href);
		const validation = { phaseId: "architecture", primaryOutput: "findings/architecture/architecture-map.md", outputPath: "", exists: true, hasValidationBlock: true, overall: "PASS", rows: [], gaps: [], errors: [] };
		await completeValidatedPhase(cwd, validation, "test");
		const state = await getWorkspaceState(cwd);
		assert.equal(state.status.phases.architecture.status, "complete");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("parseHandoff parses proposed_conventions and defaults omission to empty", async () => {
	const { parseHandoff } = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);
	const withProposals = parseHandoff({
		phase_id: "architecture",
		proposed_conventions: [
			{ name: "evidence-markers", rule: "Cite claims with a source marker.", evidence: "Recurred twice." },
			{ name: "bare-minimum", rule: "Name and rule only." },
		],
	});
	assert.equal(withProposals.proposed_conventions.length, 2);
	assert.deepEqual(withProposals.proposed_conventions[1], { name: "bare-minimum", rule: "Name and rule only." });

	const omitted = parseHandoff({ phase_id: "architecture" });
	assert.deepEqual(omitted.proposed_conventions, []);
});

test("parseHandoff rejects malformed proposed_conventions loudly", async () => {
	const { parseHandoff } = await import(pathToFileURL(`${REPO_ROOT}/core/status.ts`).href);
	assert.throws(() => parseHandoff({ phase_id: "architecture", proposed_conventions: "not-an-array" }), /must be an array/);
	assert.throws(() => parseHandoff({ phase_id: "architecture", proposed_conventions: [{ name: "no-rule" }] }), /require non-empty name and rule/);
	assert.throws(() => parseHandoff({ phase_id: "architecture", proposed_conventions: ["a string"] }), /must be objects/);
});
