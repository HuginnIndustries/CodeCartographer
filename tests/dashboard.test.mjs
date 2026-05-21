// Unit tests for core/dashboard.ts. The renderer is pure (no I/O) so we
// exercise it with hand-built input fixtures and make `.includes`-style
// assertions per section, mirroring tests/agent-summary.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { renderDashboard, escapeHtml, DASHBOARD_RELATIVE_PATH } = await import(pathToFileURL(`${REPO_ROOT}/core/dashboard.ts`).href);

// ----------------------------------------------------------------------------
// Helpers — fixture builders
// ----------------------------------------------------------------------------

function makePipeline(phaseOrder, phasesExtra = {}) {
	return {
		workflow_name: "test pipeline",
		phase_order: phaseOrder,
		phases: phaseOrder.map((id) => ({
			id,
			purpose: `purpose for ${id}`,
			primary_output: `findings/${id}/${id}.md`,
			secondary_outputs: [],
			...(phasesExtra[id] ?? {}),
		})),
	};
}

function makeStatus(phaseOrder, phasesState = {}) {
	const phases = {};
	for (const id of phaseOrder) {
		phases[id] = phasesState[id] ?? {
			status: "pending",
			owner_notes: [],
			outputs_present: [],
			open_questions: [],
			carry_forward: [],
		};
	}
	return {
		project_name: "test-project",
		pipeline: "workflow/pipeline-test.yaml",
		current_phase: phaseOrder[0],
		last_updated: "2026-05-13T12:00:00.000Z",
		next_actions: [`Run ${phaseOrder[0]}`],
		phases,
	};
}

function makeUsage(runs = []) {
	return { version: 1, runs };
}

function emptyInputs(phaseOrder = ["architecture", "contracts", "protocols"]) {
	return {
		status: makeStatus(phaseOrder),
		pipeline: makePipeline(phaseOrder),
		usage: makeUsage(),
		closeouts: [],
		outputsPresent: new Map(),
		packageVersion: "0.7.0",
		generatedAt: "2026-05-13T12:00:00.000Z",
	};
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("escapeHtml handles all five entities", () => {
	assert.equal(escapeHtml("&"), "&amp;");
	assert.equal(escapeHtml("<"), "&lt;");
	assert.equal(escapeHtml(">"), "&gt;");
	assert.equal(escapeHtml('"'), "&quot;");
	assert.equal(escapeHtml("'"), "&#39;");
	assert.equal(escapeHtml(`<script>alert("xss")</script>&'`), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;&#39;");
});

test("DASHBOARD_RELATIVE_PATH is at the workspace root, not under workflow/", () => {
	// User chose top-level placement, so the constant must reflect that.
	assert.equal(DASHBOARD_RELATIVE_PATH, "dashboard.html");
});



test("embedded dashboard script preserves escaped search/export literals and parseable JSON data", () => {
	const html = renderDashboard(emptyInputs());
	assert.ok(html.includes("split(/\\s+/).filter(Boolean)"));
	assert.ok(html.includes("JSON.stringify(JSON.parse(raw), null, 2) + '\\n'"));
	const raw = html.match(/<script id="cc-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
	assert.ok(raw, "dashboard JSON script should exist");
	const parsed = JSON.parse(raw);
	assert.equal(parsed.project, "test-project");
});

test("empty-state render: no runs / no closeouts produces explicit markers + no broken links", () => {
	const html = renderDashboard(emptyInputs());
	assert.match(html, /No phase runs recorded yet\./);
	assert.match(html, /No closeouts yet\./);
	// Pipeline progress bar is present even when empty
	assert.match(html, /Pipeline progress/);
	assert.match(html, /architecture/);
	// Footer version
	assert.match(html, /codecartographer-pi v0\.7\.0/);
	// No href=undefined / href="" attributes
	assert.doesNotMatch(html, /href=""/);
	assert.doesNotMatch(html, /href="undefined"/);
});

test("full-state render: completed phases get output links, owner note with HTML chars is escaped", () => {
	const phaseOrder = ["architecture", "contracts", "protocols"];
	const status = makeStatus(phaseOrder, {
		architecture: {
			status: "complete",
			owner_notes: ["Note with <script>alert(1)</script> & special chars"],
			outputs_present: ["findings/architecture/architecture.md"],
			open_questions: [],
			carry_forward: [],
		},
	});
	status.current_phase = "contracts";

	const inputs = {
		...emptyInputs(phaseOrder),
		status,
		outputsPresent: new Map([
			["architecture", { primary: { path: "findings/architecture/architecture.md", exists: true }, secondary: [] }],
			["contracts", { primary: { path: "findings/contracts/contracts.md", exists: false }, secondary: [] }],
		]),
	};
	const html = renderDashboard(inputs);

	// XSS guard: literal <script> must be escaped, the entity equivalent must appear
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /&amp; special chars/);

	// architecture is complete → its output link is rendered
	assert.match(html, /href="findings\/architecture\/architecture\.md"/);

	// contracts primary is missing → no link, "missing" tag instead
	assert.doesNotMatch(html, /href="findings\/contracts\/contracts\.md"/);
	assert.match(html, /primary missing/);
});

test("carry-forward entries render with the target_phase pill", () => {
	const phaseOrder = ["architecture", "contracts"];
	const status = makeStatus(phaseOrder, {
		architecture: {
			status: "complete",
			owner_notes: [],
			outputs_present: [],
			open_questions: [],
			carry_forward: [{ id: "arch-CF1", kind: "needs-runtime-test", description: "Verify the foo path", target_phase: "contracts" }],
		},
	});

	const html = renderDashboard({ ...emptyInputs(phaseOrder), status });
	assert.match(html, /→ contracts/);
	assert.match(html, /Verify the foo path/);
	assert.match(html, /needs-runtime-test/);
});

test("open-questions roll-up groups by source phase and lists each question under its bucket", () => {
	const phaseOrder = ["architecture", "contracts"];
	const status = makeStatus(phaseOrder, {
		architecture: {
			status: "complete", owner_notes: [], outputs_present: [],
			open_questions: [{ description: "Q from architecture", kind: "needs-spec-ruling" }],
			carry_forward: [],
		},
		contracts: {
			status: "pending", owner_notes: [], outputs_present: [],
			open_questions: [{ description: "Q from contracts", kind: "needs-runtime-test" }],
			carry_forward: [],
		},
	});

	const html = renderDashboard({ ...emptyInputs(phaseOrder), status });

	// Roll-up section appears
	assert.match(html, /<h2[^>]*>Open questions<\/h2>/);
	// Each phase has its own h3 bucket with count
	assert.match(html, /<h3>architecture \(1\)<\/h3>/);
	assert.match(html, /<h3>contracts \(1\)<\/h3>/);
	assert.match(html, /Q from architecture/);
	assert.match(html, /Q from contracts/);
});

test("usage panel: totals roll up across runs; per-phase breakdown row count matches distinct phases", () => {
	const usage = makeUsage([
		{ timestamp: "2026-05-13T10:00:00.000Z", phase: "architecture", status: "completed", turn_count: 5, tool_uses: 10, duration_ms: 60_000, tokens: { input: 1000, output: 500, cache_write: 0 } },
		{ timestamp: "2026-05-13T11:00:00.000Z", phase: "architecture", status: "completed", turn_count: 3, tool_uses: 6,  duration_ms: 30_000, tokens: { input: 500,  output: 250, cache_write: 100 } },
		{ timestamp: "2026-05-13T12:00:00.000Z", phase: "contracts",    status: "completed", turn_count: 8, tool_uses: 14, duration_ms: 90_000, tokens: { input: 2000, output: 1000, cache_write: 0 } },
	]);
	const html = renderDashboard({ ...emptyInputs(), usage });

	// Total runs surfaced
	assert.match(html, /Total runs<\/dt><dd>3<\/dd>/);
	// Cumulative token total (1000+500+500+250+2000+1000 = 5250 → "5.3k")
	assert.match(html, /5\.3k/);
	// Per-phase breakdown row count: 2 phases (architecture + contracts)
	const usageSection = html.split('<section class="cc-card cc-usage"')[1]?.split('</section>')[0] ?? "";
	const usageTbody = usageSection.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
	const phaseRows = usageTbody.match(/<tr/g) ?? [];
	assert.equal(phaseRows.length, 3, "expected one tbody row per pipeline phase in the per-phase usage table");
});

test("activity timeline shows newest 10 visible; older runs collapsed under <details>", () => {
	const runs = Array.from({ length: 13 }, (_, i) => ({
		timestamp: `2026-05-${String(13 - i).padStart(2, "0")}T12:00:00.000Z`,
		phase: "architecture",
		status: "completed",
		turn_count: 1,
		tool_uses: 1,
		duration_ms: 1000,
		tokens: { input: 100, output: 50, cache_write: 0 },
	}));
	const html = renderDashboard({ ...emptyInputs(), usage: makeUsage(runs) });

	// Visible-table section + older-runs <details>
	assert.match(html, /<summary>Older runs \(3\)<\/summary>/);
});

test("narration section appears only when narration is provided; staleness counts runs since generation", () => {
	const phaseOrder = ["architecture", "contracts", "protocols"];
	const status = makeStatus(phaseOrder, {
		architecture: { status: "complete", owner_notes: [], outputs_present: [], open_questions: [], carry_forward: [] },
		contracts:    { status: "complete", owner_notes: [], outputs_present: [], open_questions: [], carry_forward: [] },
		protocols:    { status: "pending",  owner_notes: [], outputs_present: [], open_questions: [], carry_forward: [] },
	});

	// Without narration → no Executive summary section
	const html1 = renderDashboard({ ...emptyInputs(phaseOrder), status });
	assert.doesNotMatch(html1, /Executive summary/);

	// With narration generated at phaseCount=1 (one phase complete), now 2 complete → "1 run since"
	const html2 = renderDashboard({
		...emptyInputs(phaseOrder),
		status,
		narration: {
			content: "All systems nominal.",
			generatedAt: "2026-05-13T10:00:00.000Z",
			phaseCountAtGeneration: 1,
		},
	});
	assert.match(html2, /Executive summary/);
	assert.match(html2, /1 run since/);
	assert.match(html2, /All systems nominal\./);

	// When narration matches current count → "current"
	const html3 = renderDashboard({
		...emptyInputs(phaseOrder),
		status,
		narration: {
			content: "x",
			generatedAt: "2026-05-13T13:00:00.000Z",
			phaseCountAtGeneration: 2,
		},
	});
	assert.match(html3, />current<\/span>/);
});

test("closeouts list is sorted reverse-chronologically and renders relative-path links", () => {
	const closeouts = [
		{ date: "2026-05-10", phaseOrModule: "architecture", fileName: "2026-05-10-architecture.md" },
		{ date: "2026-05-12", phaseOrModule: "contracts",    fileName: "2026-05-12-contracts.md" },
		{ date: "2026-05-08", phaseOrModule: "init",         fileName: "2026-05-08-init.md" },
	];
	const html = renderDashboard({ ...emptyInputs(), closeouts });

	// Three list items, links are workspace-relative (no leading slash)
	assert.match(html, /href="closeouts\/2026-05-12-contracts\.md"/);
	assert.match(html, /href="closeouts\/2026-05-10-architecture\.md"/);
	assert.match(html, /href="closeouts\/2026-05-08-init\.md"/);

	// Order check: the position of the 05-12 entry must be before 05-10 in the rendered output
	const closeoutSection = html.split('<section class="cc-card cc-closeouts"')[1]?.split('</section>')[0] ?? "";
	const idx12 = closeoutSection.indexOf("2026-05-12-contracts.md");
	const idx10 = closeoutSection.indexOf("2026-05-10-architecture.md");
	const idx08 = closeoutSection.indexOf("2026-05-08-init.md");
	assert.ok(idx12 > 0 && idx10 > idx12 && idx08 > idx10, "closeouts must render reverse-chronologically");
});

test("closeout rows include direct primary result links when outputs exist", () => {
	const phaseOrder = ["architecture", "contracts"];
	const closeouts = [
		{ date: "2026-05-12", phaseOrModule: "contracts", fileName: "2026-05-12-contracts.md", summary: "Contracts complete." },
	];
	const outputsPresent = new Map([
		["contracts", { primary: { path: "findings/contracts/contracts.md", exists: true }, secondary: [] }],
	]);
	const html = renderDashboard({ ...emptyInputs(phaseOrder), closeouts, outputsPresent });
	assert.match(html, /href="closeouts\/2026-05-12-contracts\.md"/);
	assert.match(html, /href="findings\/contracts\/contracts\.md">primary result<\/a>/);
	assert.match(html, /Contracts complete\./);
});

test("activity timeline renders session transcript links safely", () => {
	const usage = makeUsage([
		{ timestamp: "2026-05-13T10:00:00.000Z", phase: "architecture", status: "completed", turn_count: 1, tool_uses: 2, duration_ms: 1000, tokens: { input: 10, output: 5, cache_write: 0 }, session_file: "sessions/phase architecture.html" },
	]);
	const html = renderDashboard({ ...emptyInputs(["architecture"]), usage });
	assert.match(html, /href="sessions\/phase%20architecture\.html">session<\/a>/);
});

test("absolute or parent-relative session files are not rendered as unsafe links", () => {
	const usage = makeUsage([
		{ timestamp: "2026-05-13T10:00:00.000Z", phase: "architecture", status: "completed", turn_count: 1, tool_uses: 2, duration_ms: 1000, tokens: { input: 10, output: 5, cache_write: 0 }, session_file: "/home/james/.pi/agent/sessions/private.html" },
		{ timestamp: "2026-05-13T11:00:00.000Z", phase: "contracts", status: "completed", turn_count: 1, tool_uses: 2, duration_ms: 1000, tokens: { input: 10, output: 5, cache_write: 0 }, session_file: "../outside.html" },
	]);
	const html = renderDashboard({ ...emptyInputs(["architecture", "contracts"]), usage });
	assert.doesNotMatch(html, /href="\/home\/james/);
	assert.doesNotMatch(html, /href="\.\.\/outside\.html"/);
});
