// The mechanized half of the orchestrator loop (issue #98): init seeds
// CONVENTIONS.md/DECISIONS.md, completion appends handoff `decisions` to
// DECISIONS.md and stages `proposed_conventions` in CONVENTIONS.md, prompts
// carry the duties block, and completion reports the checkpoint. The failure
// these pin: a real seven-phase run stranded ~12 proposals and 23 decisions
// in closeout prose because promotion existed only as a prose ritual.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit, handleComplete } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

let WORKSPACE;
let CODECARTO;

async function pathExists(path) {
	return core.pathExists(path);
}

/** Write a passing architecture primary output with a validation block. */
async function writePassingArchitectureOutput() {
	const outputPath = join(CODECARTO, "findings", "architecture", "architecture-map.md");
	await writeFile(outputPath, [
		"# Architecture Map",
		"",
		"Body.",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		"| 1 | The system intent is documented. | PASS | §above |",
		"",
		"**Validated by:** test",
		"**Overall:** PASS",
		"",
	].join("\n"), "utf8");
}

async function writeArchitectureHandoff(extra = "") {
	const handoffPath = join(CODECARTO, "scratch", "handoffs", "architecture.yaml");
	await mkdir(dirname(handoffPath), { recursive: true });
	await writeFile(handoffPath, [
		"schema_version: 1",
		"phase_id: architecture",
		"owner_notes:",
		"  - Execution strategy: inline.",
		"decisions:",
		"  - Kept the evidence-marker vocabulary from the upstream run.",
		"  - Excluded the POC package group from findings.",
		"proposed_conventions:",
		"  - name: evidence-markers",
		"    rule: Cite every load-bearing claim with a marker naming its source file.",
		"    evidence: Two prior phases reached for the same vocabulary.",
		"closeout_summary: Architecture mapped.",
		extra,
		"",
	].join("\n"), "utf8");
}

test("setup: init seeds the orchestrator files", async () => {
	WORKSPACE = await mkdtemp(join(tmpdir(), "cc-promotion-"));
	const result = await handleInit({ cwd: WORKSPACE, pipeline: "architecture-only" });
	CODECARTO = join(WORKSPACE, ".codecarto");
	assert.ok(await pathExists(join(CODECARTO, "CONVENTIONS.md")), "init must seed CONVENTIONS.md");
	assert.ok(await pathExists(join(CODECARTO, "DECISIONS.md")), "init must seed DECISIONS.md");
	assert.deepEqual(
		result.structuredContent.seededOrchestratorFiles,
		["CONVENTIONS.md", "DECISIONS.md", "BACKLOG.md", "THREAD_LOG.md"],
		"all four orchestrator files are seeded from templates, not copied from the framework's own workspace",
	);
	const conventions = await readFile(join(CODECARTO, "CONVENTIONS.md"), "utf8");
	assert.match(conventions, /^# Conventions/, "seeded file carries the template body");
});

test("init is idempotent about seeding: existing files are never touched", async () => {
	const conventionsPath = join(CODECARTO, "CONVENTIONS.md");
	await writeFile(conventionsPath, "# Conventions\n\nproject-specific content\n", "utf8");
	const seeded = await core.seedOrchestratorFiles(CODECARTO);
	assert.deepEqual(seeded, [], "no file should be re-seeded");
	assert.match(await readFile(conventionsPath, "utf8"), /project-specific content/);
});

test("first-phase prompt carries the secondary-output inventory when the phase declares any", async () => {
	const state = await core.getWorkspaceState(WORKSPACE);
	const phase = core.resolvePhase(state, "architecture");
	const prompt = await core.buildPhasePrompt(state, phase, false);
	if (phase.secondary_outputs?.length) {
		assert.match(prompt, /Orchestrator duties \(perform BEFORE executing this phase/);
		assert.match(prompt, /secondary outputs/);
		assert.match(prompt, /\(missing\)/);
	} else {
		assert.doesNotMatch(prompt, /Orchestrator duties/);
	}
});

test("completion appends decisions to DECISIONS.md and stages proposals in CONVENTIONS.md", async () => {
	await writePassingArchitectureOutput();
	await writeArchitectureHandoff();
	const result = await handleComplete({ cwd: WORKSPACE });

	const decisions = await readFile(join(CODECARTO, "DECISIONS.md"), "utf8");
	assert.match(decisions, /## Completion log/);
	assert.match(decisions, /^D001 \| Kept the evidence-marker vocabulary from the upstream run\. \| \d{4}-\d{2}-\d{2}-architecture \| closeouts\//m);
	assert.match(decisions, /^D002 \| Excluded the POC package group from findings\./m);

	const conventions = await readFile(join(CODECARTO, "CONVENTIONS.md"), "utf8");
	assert.match(conventions, /## Pending proposals/);
	assert.match(conventions, /- \*\*evidence-markers\*\* \(architecture, \d{4}-\d{2}-\d{2}\) — Cite every load-bearing claim/);
	assert.match(conventions, /Evidence: Two prior phases reached for the same vocabulary\./);

	assert.match(result.structuredContent.orchestratorCheckpoint, /2 decision\(s\) appended/);
	assert.match(result.structuredContent.orchestratorCheckpoint, /1 proposal\(s\) pending/);
});

test("re-running the appenders is idempotent: no duplicate rows or bullets", async () => {
	const state = await core.getWorkspaceState(WORKSPACE);
	const validation = await core.validatePhaseOutput(state, "architecture");
	await core.completeValidatedPhase(WORKSPACE, validation, "test-rerun");

	const decisions = await readFile(join(CODECARTO, "DECISIONS.md"), "utf8");
	assert.equal(decisions.match(/Kept the evidence-marker vocabulary/g).length, 1, "decision must not duplicate");
	const conventions = await readFile(join(CODECARTO, "CONVENTIONS.md"), "utf8");
	assert.equal(conventions.match(/\*\*evidence-markers\*\*/g).length, 1, "proposal must not duplicate");
});

test("decision numbering continues from the highest existing D<NNN> anywhere in the file", async () => {
	const decisionsPath = join(CODECARTO, "DECISIONS.md");
	const current = await readFile(decisionsPath, "utf8");
	await writeFile(decisionsPath, `${current}D041 | Manually curated category entry. | manual | manual\n`, "utf8");

	await writeArchitectureHandoff("");
	const handoffPath = join(CODECARTO, "scratch", "handoffs", "architecture.yaml");
	const handoff = await readFile(handoffPath, "utf8");
	await writeFile(handoffPath, handoff.replace("Kept the evidence-marker vocabulary from the upstream run.", "A third, later decision."), "utf8");

	const state = await core.getWorkspaceState(WORKSPACE);
	const validation = await core.validatePhaseOutput(state, "architecture");
	await core.completeValidatedPhase(WORKSPACE, validation, "test-numbering");

	const decisions = await readFile(decisionsPath, "utf8");
	assert.match(decisions, /^D042 \| A third, later decision\./m, "numbering continues after the curated D041");
});

test("the completion-log heading is a real visible line, not the template's prose mention (#111)", async () => {
	// The decisions template *mentions* `## Completion log` in running prose, so
	// a substring presence check believes the heading exists and never inserts
	// it — rows then glue to the template's closing sentence at EOF.
	const decisions = await readFile(join(CODECARTO, "DECISIONS.md"), "utf8");
	const lines = decisions.split("\n");
	const headingIndex = lines.findIndex((line) => line.trim() === "## Completion log");
	assert.notEqual(headingIndex, -1, "append must insert the heading as its own line");
	// The template ships a *commented* D001 example above the heading, so the
	// row scan must look below the heading only.
	assert.ok(
		lines.slice(headingIndex + 1).some((line) => /^D001 \|/.test(line)),
		"appended rows must sit under the heading",
	);
});

test("countPendingProposals ignores a prose mention of the pending heading (#111)", async () => {
	const crafted = [
		"# Conventions",
		"",
		"Completion stages entries under `## Pending proposals`; promote them at the boundary.",
		"",
		"- **decoy-one** a bullet between the prose mention and the real section",
		"- **decoy-two** another one",
		"",
		"## Pending proposals",
		"",
		"- **real-one** (architecture, 2026-08-17) — the only staged entry.",
		"",
	].join("\n");
	assert.equal(await core.countPendingProposals(CODECARTO, crafted), 1, "only bullets under the real heading line count");
});

test("prompt duties block lists pending proposals and re-triage questions after completion", async () => {
	// Route an open question with a re-triage kind into status via a fresh handoff completion.
	const handoffPath = join(CODECARTO, "scratch", "handoffs", "architecture.yaml");
	await mkdir(dirname(handoffPath), { recursive: true });
	await writeFile(handoffPath, [
		"schema_version: 1",
		"phase_id: architecture",
		"open_questions:",
		"  - id: arch-OQ9",
		"    kind: needs-maintainer-decision",
		"    description: Is the loopback-only bind intentional?",
		"    deferred_reason: Threat model unclear.",
		"closeout_summary: Re-completed with a question.",
		"",
	].join("\n"), "utf8");
	const state = await core.getWorkspaceState(WORKSPACE);
	const validation = await core.validatePhaseOutput(state, "architecture");
	await core.completeValidatedPhase(WORKSPACE, validation, "test-question");

	const after = await core.getWorkspaceState(WORKSPACE);
	const phase = core.resolvePhase(after, "architecture");
	const prompt = await core.buildPhasePrompt(after, phase, true);
	assert.match(prompt, /CONVENTIONS\.md has \d+ pending proposal/);
	assert.match(prompt, /Re-triage these open questions' kind labels/);
	assert.match(prompt, /arch-OQ9 \(needs-maintainer-decision, from architecture\) Is the loopback-only bind intentional\?/);
	assert.match(prompt, /Contradiction sweep:/);

	const autoPrompt = await core.buildPhasePrompt(after, phase, true, { auto: true });
	assert.match(autoPrompt, /Orchestrator duties \(auto run — perform them without asking the user/);
});

test("completion falls back to minimal headers on a scaffold without the templates", async () => {
	const bare = await mkdtemp(join(tmpdir(), "cc-promotion-bare-"));
	await handleInit({ cwd: bare, pipeline: "architecture-only" });
	const bareWorkspace = join(bare, ".codecarto");
	// Simulate a pre-template scaffold: remove the seeded files and the templates.
	await unlink(join(bareWorkspace, "CONVENTIONS.md"));
	await unlink(join(bareWorkspace, "DECISIONS.md"));
	await unlink(join(bareWorkspace, "templates", "conventions-template.md"));
	await unlink(join(bareWorkspace, "templates", "decisions-template.md"));

	await writeFile(join(bareWorkspace, "findings", "architecture", "architecture-map.md"), [
		"# Map",
		"",
		"## Validation",
		"",
		"| # | Criterion | Result | Evidence |",
		"|---|-----------|--------|----------|",
		"| 1 | Intent documented. | PASS | §above |",
		"",
		"**Overall:** PASS",
		"",
	].join("\n"), "utf8");
	await mkdir(join(bareWorkspace, "scratch", "handoffs"), { recursive: true });
	await writeFile(join(bareWorkspace, "scratch", "handoffs", "architecture.yaml"), [
		"schema_version: 1",
		"phase_id: architecture",
		"decisions:",
		"  - Fallback-header decision.",
		"proposed_conventions:",
		"  - name: fallback-proposal",
		"    rule: Works without the template files.",
		"closeout_summary: Bare scaffold completion.",
		"",
	].join("\n"), "utf8");

	const state = await core.getWorkspaceState(bare);
	const validation = await core.validatePhaseOutput(state, "architecture");
	await core.completeValidatedPhase(bare, validation, "test-bare");

	const decisions = await readFile(join(bareWorkspace, "DECISIONS.md"), "utf8");
	assert.match(decisions, /^# Decisions/);
	assert.match(decisions, /D001 \| Fallback-header decision\./);
	const conventions = await readFile(join(bareWorkspace, "CONVENTIONS.md"), "utf8");
	assert.match(conventions, /^# Conventions/);
	assert.match(conventions, /\*\*fallback-proposal\*\*/);

	await rm(bare, { recursive: true, force: true });
});

test("teardown: remove temp workspace", async () => {
	await rm(WORKSPACE, { recursive: true, force: true });
});
