import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const {
	buildPhasePrompt,
	getWorkspaceState,
	hasMeaningfulVisionContent,
	parseConfirmedProposalEntries,
	publishEntry,
	resolvePhase,
	runPhasePreflight,
	writeMarker,
} = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit, handlePhase } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");

let workspace;
let library;
let state;

test("setup: synthesis workspace and one versioned library entry", async () => {
	workspace = await mkdtemp(join(tmpdir(), "cc-synthesis-workspace-"));
	library = await mkdtemp(join(tmpdir(), "cc-synthesis-library-"));
	await writeMarker(library, {
		schema_version: 1,
		name: "test-library",
		namespaced: false,
	});
	await publishEntry(library, "# Router spec\n\nRoutes events with tenant isolation.\n", {
		slug: "event-router",
		source_repo: "https://example.test/event-router",
		analyzed_at: "2026-07-21T00:00:00Z",
		pipeline: "workflow/pipeline.yaml",
		codecarto_version: "0.11.0",
		headline: "Tenant-isolated event routing.",
		tags: ["events", "multi-tenant"],
		capabilities: ["tenant isolation"],
		generation: {
			surface: "mcp-server",
			agent: "codex",
			agent_version: "test",
			model: "gpt-5.6",
			model_vendor: "openai",
			reasoning: "high",
			notes: "fixture",
		},
	});

	await handleInit({ cwd: workspace, pipeline: "synthesis" });
	await writeFile(
		join(workspace, ".codecarto", "workflow", "config.yaml"),
		`orchestrator:\n  llm_steer_next_phase: false\nlibrary:\n  path: ${library}\n  namespace: null\n  publish_confirm: true\n`,
		"utf8",
	);
	state = await getWorkspaceState(workspace);
	assert.ok(state);
	assert.equal(state.pipeline.workflow_name, "evidence-backed-project-synthesis");
});

test("synthesis alias initializes the four-phase forward workflow", () => {
	assert.deepEqual(state.pipeline.phase_order, [
		"vision-capture",
		"goal-synthesis-propose",
		"spec-merge",
		"goal-synthesis-finalize",
	]);
});

test("vision capture refuses the placeholder brief and includes a completed brief", async () => {
	const phase = resolvePhase(state, "vision-capture");
	await assert.rejects(buildPhasePrompt(state, phase, false), /vision brief.*still empty/i);
	await writeFile(
		join(workspace, ".codecarto", "inputs", "vision.md"),
		"# Vision brief\n\nHelp platform teams turn several proven service designs into one auditable implementation plan.\n",
		"utf8",
	);
	const prompt = await buildPhasePrompt(state, phase, false);
	assert.match(prompt, /\.codecarto\/inputs\/vision\.md/);
	assert.match(prompt, /raw product brief/);
});

test("vision content detection cannot be bypassed by HTML comment delimiters", () => {
	for (const emptyVision of [
		"# Vision\n\n<!-- placeholder -->\n",
		"# Vision\n\n<!-- first --><!-- second -->\n",
		"# Vision\n\n<!-- unclosed placeholder\nignored text\n",
		"# Vision\n\n<!<!-- placeholder -->--\n",
		"# Vision\n\n<!-- outer <!-- nested marker -->\n",
	]) {
		assert.equal(hasMeaningfulVisionContent(emptyVision), false);
	}

	assert.equal(
		hasMeaningfulVisionContent("# Vision\n\n<!-- audience --> Platform engineers need an auditable plan.\n"),
		true,
	);
});

test("proposal prompt exposes read-only library provenance", async () => {
	const phase = resolvePhase(state, "goal-synthesis-propose");
	const prompt = await buildPhasePrompt(state, phase, true);
	assert.match(prompt, /Synthesis library context:/);
	assert.match(prompt, /event-router \| v1/);
	assert.match(prompt, /reimplementation-spec\.md/);
	assert.match(prompt, /Treat library files as read-only evidence/);
	assert.match(prompt, /forward synthesis workspace/);
});

test("confirmation parser accepts checked rows and ignores unchecked rows", () => {
	const markdown = [
		"| Confirm | Library entry | Version |",
		"|---|---|---|",
		"| [ ] | `ignored-entry` | v1 |",
		"| [x] | `event-router` | v1 |",
		"| [X] | `team/other-entry` | v2 |",
	].join("\n");
	assert.deepEqual(parseConfirmedProposalEntries(markdown), ["event-router", "team/other-entry"]);
});

test("spec merge preflight refuses a missing or unchecked proposal", async () => {
	const phase = resolvePhase(state, "spec-merge");
	await assert.rejects(runPhasePreflight(state, phase), /proposal is missing/);

	const proposalDir = join(workspace, ".codecarto", "findings", "goal-synthesis");
	await mkdir(proposalDir, { recursive: true });
	await writeFile(join(proposalDir, "proposal.md"), "| [ ] | `event-router` | v1 |\n", "utf8");
	await assert.rejects(runPhasePreflight(state, phase), /no library entries are confirmed/);
});

test("checked proposal unlocks merge and finalization with confirmed refs in the prompt", async () => {
	const proposalPath = join(workspace, ".codecarto", "findings", "goal-synthesis", "proposal.md");
	await writeFile(proposalPath, "| [x] | `event-router` | v1 |\n", "utf8");

	for (const phaseId of ["spec-merge", "goal-synthesis-finalize"]) {
		const phase = resolvePhase(state, phaseId);
		const result = await runPhasePreflight(state, phase);
		assert.deepEqual(result.confirmedEntries, ["event-router"]);
		assert.deepEqual(
			result.confirmedSelections.map(({ ref, version }) => ({ ref, version })),
			[{ ref: "event-router", version: 1 }],
		);
		const prompt = await buildPhasePrompt(state, phase, true);
		assert.match(prompt, /Human-confirmed, version-pinned inputs/);
		assert.match(prompt, /event-router@v1/);
		assert.match(prompt, /Read only these version-pinned/);
	}
});

test("a precomputed result prevents prompt building from repeating preflight", async () => {
	const proposalPath = join(workspace, ".codecarto", "findings", "goal-synthesis", "proposal.md");
	await writeFile(proposalPath, "| [x] | `event-router` | v1 |\n", "utf8");
	const phase = resolvePhase(state, "spec-merge");
	const preflight = await runPhasePreflight(state, phase);

	// Change the input after the caller's successful check. A prompt using the
	// supplied result must not read it again; a self-contained prompt still does.
	await writeFile(proposalPath, "| [ ] | `event-router` | v1 |\n", "utf8");
	const prompt = await buildPhasePrompt(state, phase, true, { preflight });
	assert.match(prompt, /event-router@v1/);
	await assert.rejects(buildPhasePrompt(state, phase, true), /no library entries are confirmed/);
});

test("preflight rejects a checked entry version that is not in the library", async () => {
	const proposalPath = join(workspace, ".codecarto", "findings", "goal-synthesis", "proposal.md");
	await writeFile(proposalPath, "| [x] | `event-router` | v99 |\n", "utf8");
	const phase = resolvePhase(state, "spec-merge");
	await assert.rejects(runPhasePreflight(state, phase), /event-router@v99 is not present/);
});

test("MCP maps confirmation failures to InvalidRequest", async () => {
	const proposalPath = join(workspace, ".codecarto", "findings", "goal-synthesis", "proposal.md");
	await writeFile(proposalPath, "| [ ] | `event-router` | v1 |\n", "utf8");
	await assert.rejects(
		handlePhase({ cwd: workspace, phase: "spec-merge" }),
		(error) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, ErrorCode.InvalidRequest);
			assert.match(error.message, /no library entries are confirmed/);
			return true;
		},
	);
});

test("teardown: remove synthesis fixtures", async () => {
	if (workspace) await rm(workspace, { recursive: true, force: true });
	if (library) await rm(library, { recursive: true, force: true });
});
