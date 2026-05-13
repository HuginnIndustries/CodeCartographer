// Pure HTML dashboard renderer for a CodeCartographer workspace. No I/O —
// the writer (extensions/codecarto/dashboard-writer.ts) gathers all inputs
// and calls renderDashboard() to produce a self-contained HTML document.
//
// Self-contained: embedded <style>, no JavaScript, no external assets.
// Works opened directly from a file:// URL. Light/dark via
// prefers-color-scheme. Mobile via a single max-width: 720px collapse rule.
//
// HTML safety: every disk-sourced value (phase IDs, owner notes, open-question
// descriptions, carry-forward target_phase, closeout filenames, paths inside
// href attributes) passes through escapeHtml. Href path segments also get
// URL-encoded before escaping.

import { formatMillis, formatTokenCount } from "./utils.ts";
import type { NormalizedStatus, OpenQuestionEntry, CarryForwardEntry, PipelineFile, PipelinePhase, StatusPhase } from "./types.ts";
import type { UsageFile, UsageRun, UsageTotals } from "./usage.ts";
import { computePerPhaseTotals, computeTotals } from "./usage.ts";

export const DASHBOARD_RELATIVE_PATH = "dashboard.html";
export const NARRATION_CACHE_RELATIVE_PATH = ".dashboard-narration.local.md";

const TIMELINE_VISIBLE_COUNT = 10;

export interface DashboardCloseoutEntry {
	date: string;
	phaseOrModule: string;
	fileName: string;
}

export interface OutputAvailability {
	primary?: { path: string; exists: boolean };
	secondary: Array<{ path: string; exists: boolean }>;
}

export interface DashboardNarration {
	content: string;
	generatedAt: string;
	phaseCountAtGeneration: number;
}

export interface DashboardInputs {
	status: NormalizedStatus;
	pipeline: PipelineFile;
	usage: UsageFile;
	closeouts: DashboardCloseoutEntry[];
	outputsPresent: Map<string, OutputAvailability>;
	packageVersion: string;
	generatedAt: string;
	narration?: DashboardNarration;
}

export function renderDashboard(inputs: DashboardInputs): string {
	const sections = [
		renderHeader(inputs),
		inputs.narration ? renderNarration(inputs.narration, completedPhaseCount(inputs.status)) : "",
		renderProgressBar(inputs.pipeline, inputs.status),
		renderPhaseCards(inputs),
		renderUsagePanel(inputs.usage),
		renderActivityTimeline(inputs.usage.runs),
		renderOpenQuestionsRollup(inputs.status),
		renderCloseoutsList(inputs.closeouts),
		renderFooter(inputs),
	].filter(Boolean).join("\n");

	const projectName = inputs.status.project_name || "CodeCartographer";
	return [
		"<!DOCTYPE html>",
		`<html lang="en">`,
		"<head>",
		`<meta charset="utf-8">`,
		`<meta name="viewport" content="width=device-width, initial-scale=1">`,
		`<title>${escapeHtml(projectName)} — CodeCartographer dashboard</title>`,
		renderStyles(),
		"</head>",
		"<body>",
		`<main class="cc-dashboard">`,
		sections,
		"</main>",
		"</body>",
		"</html>",
	].join("\n");
}

// ----------------------------------------------------------------------------
// Sections
// ----------------------------------------------------------------------------

function renderHeader(inputs: DashboardInputs): string {
	const { status, pipeline, packageVersion, generatedAt } = inputs;
	const projectName = status.project_name || "(unnamed project)";
	const pipelineLabel = pipeline.workflow_name || status.pipeline;
	const currentPhase = status.current_phase || "—";

	return [
		`<header class="cc-header">`,
		`<h1>${escapeHtml(projectName)}</h1>`,
		`<dl class="cc-header-meta">`,
		`<dt>Pipeline</dt><dd>${escapeHtml(pipelineLabel)}</dd>`,
		`<dt>Current phase</dt><dd>${escapeHtml(currentPhase)}</dd>`,
		`<dt>Status last updated</dt><dd>${escapeHtml(status.last_updated || "never")}</dd>`,
		`<dt>Dashboard generated</dt><dd>${escapeHtml(generatedAt)}</dd>`,
		`<dt>Package version</dt><dd>codecartographer-pi v${escapeHtml(packageVersion)}</dd>`,
		`</dl>`,
		`</header>`,
	].join("\n");
}

function renderNarration(narration: DashboardNarration, currentCompletedCount: number): string {
	const runsSince = Math.max(0, currentCompletedCount - narration.phaseCountAtGeneration);
	const staleness = runsSince === 0
		? "current"
		: `${runsSince} run${runsSince === 1 ? "" : "s"} since`;
	return [
		`<section class="cc-narration" aria-label="Executive summary">`,
		`<h2>Executive summary</h2>`,
		`<p class="cc-narration-meta">Narrated ${escapeHtml(narration.generatedAt)} · ${escapeHtml(staleness)}.</p>`,
		`<div class="cc-narration-body">`,
		// The narration body is LLM-generated Markdown. We do not parse Markdown
		// to HTML here (zero-dep policy); we escape it and render in a <pre>
		// so the user gets readable output without an XSS vector. A future
		// upgrade could swap in a tiny Markdown renderer.
		`<pre>${escapeHtml(narration.content)}</pre>`,
		`</div>`,
		`</section>`,
	].join("\n");
}

function renderProgressBar(pipeline: PipelineFile, status: NormalizedStatus): string {
	const items = pipeline.phase_order.map((phaseId) => {
		const state = phaseRenderState(status, phaseId);
		const purpose = pipeline.phases.find((p) => p.id === phaseId)?.purpose ?? "";
		return [
			`<li class="cc-progress-item cc-state-${state}" title="${escapeAttr(purpose)}">`,
			`<span class="cc-progress-id">${escapeHtml(phaseId)}</span>`,
			`<span class="cc-progress-badge">${escapeHtml(state)}</span>`,
			`</li>`,
		].join("");
	}).join("\n");

	return [
		`<section class="cc-progress" aria-label="Pipeline progress">`,
		`<h2>Pipeline progress</h2>`,
		`<ol class="cc-progress-list">`,
		items,
		`</ol>`,
		`</section>`,
	].join("\n");
}

function renderPhaseCards(inputs: DashboardInputs): string {
	const { status, pipeline, usage, outputsPresent } = inputs;
	const perPhaseLastRun = lastRunPerPhase(usage.runs);

	const cards = pipeline.phase_order.map((phaseId) => {
		const phaseDef = pipeline.phases.find((p) => p.id === phaseId);
		const phaseState = status.phases[phaseId];
		const renderState = phaseRenderState(status, phaseId);
		const outputs = outputsPresent.get(phaseId);
		const lastRun = perPhaseLastRun.get(phaseId);

		const open = renderState === "running" || renderState === "current";
		const detailsAttr = open ? " open" : "";

		return [
			`<details class="cc-phase-card cc-state-${renderState}"${detailsAttr}>`,
			`<summary>`,
			`<span class="cc-phase-id">${escapeHtml(phaseId)}</span>`,
			`<span class="cc-phase-badge">${escapeHtml(renderState)}</span>`,
			`</summary>`,
			renderPhasePurpose(phaseDef),
			renderPhaseOutputs(phaseDef, outputs),
			renderPhaseOpenQuestions(phaseState),
			renderPhaseCarryForward(phaseState),
			renderPhaseOwnerNotes(phaseState),
			renderPhaseLastRun(lastRun),
			`</details>`,
		].filter(Boolean).join("\n");
	}).join("\n");

	return [
		`<section class="cc-phases" aria-label="Per-phase status">`,
		`<h2>Phases</h2>`,
		cards,
		`</section>`,
	].join("\n");
}

function renderPhasePurpose(phase: PipelinePhase | undefined): string {
	if (!phase?.purpose) return "";
	return `<p class="cc-phase-purpose">${escapeHtml(phase.purpose)}</p>`;
}

function renderPhaseOutputs(phase: PipelinePhase | undefined, outputs: OutputAvailability | undefined): string {
	if (!phase) return "";
	const lines: string[] = [];
	if (phase.primary_output) {
		const present = outputs?.primary?.exists ?? false;
		const href = relativeHref(phase.primary_output);
		lines.push(present
			? `<li><a href="${escapeAttr(href)}">${escapeHtml(phase.primary_output)}</a> <span class="cc-tag cc-tag-present">primary</span></li>`
			: `<li><span class="cc-tag cc-tag-missing">primary (missing)</span> ${escapeHtml(phase.primary_output)}</li>`);
	}
	for (const sec of phase.secondary_outputs ?? []) {
		const present = outputs?.secondary.find((s) => s.path === sec.path)?.exists ?? false;
		const href = relativeHref(sec.path);
		lines.push(present
			? `<li><a href="${escapeAttr(href)}">${escapeHtml(sec.path)}</a> <span class="cc-tag">secondary</span></li>`
			: `<li><span class="cc-tag cc-tag-missing">secondary (missing)</span> ${escapeHtml(sec.path)}</li>`);
	}
	if (lines.length === 0) return "";
	return `<div class="cc-phase-section"><h3>Outputs</h3><ul class="cc-output-list">${lines.join("")}</ul></div>`;
}

function renderPhaseOpenQuestions(phaseState: StatusPhase | undefined): string {
	const items = phaseState?.open_questions ?? [];
	if (items.length === 0) return "";
	return [
		`<div class="cc-phase-section">`,
		`<h3>Open questions (${items.length})</h3>`,
		`<ul class="cc-question-list">`,
		items.map(renderOpenQuestion).join(""),
		`</ul>`,
		`</div>`,
	].join("");
}

function renderOpenQuestion(q: OpenQuestionEntry): string {
	const kind = q.kind ? `<span class="cc-tag">${escapeHtml(String(q.kind))}</span> ` : "";
	const desc = escapeHtml(q.description ?? "(no description)");
	const reason = q.deferred_reason ? `<div class="cc-question-reason">${escapeHtml(q.deferred_reason)}</div>` : "";
	return `<li>${kind}${desc}${reason}</li>`;
}

function renderPhaseCarryForward(phaseState: StatusPhase | undefined): string {
	const items = phaseState?.carry_forward ?? [];
	if (items.length === 0) return "";
	return [
		`<div class="cc-phase-section">`,
		`<h3>Carry-forward (${items.length})</h3>`,
		`<ul class="cc-carry-list">`,
		items.map(renderCarryForward).join(""),
		`</ul>`,
		`</div>`,
	].join("");
}

function renderCarryForward(c: CarryForwardEntry): string {
	const target = c.target_phase ? `<span class="cc-tag cc-tag-target">→ ${escapeHtml(c.target_phase)}</span> ` : "";
	const kind = c.kind ? `<span class="cc-tag">${escapeHtml(String(c.kind))}</span> ` : "";
	const desc = escapeHtml(c.description ?? "(no description)");
	const reason = c.deferred_reason ? `<div class="cc-question-reason">${escapeHtml(c.deferred_reason)}</div>` : "";
	return `<li>${target}${kind}${desc}${reason}</li>`;
}

function renderPhaseOwnerNotes(phaseState: StatusPhase | undefined): string {
	const notes = phaseState?.owner_notes ?? [];
	if (notes.length === 0) return "";
	return [
		`<div class="cc-phase-section">`,
		`<h3>Owner notes</h3>`,
		`<ul class="cc-notes-list">`,
		notes.map((n) => `<li>${escapeHtml(n)}</li>`).join(""),
		`</ul>`,
		`</div>`,
	].join("");
}

function renderPhaseLastRun(run: UsageRun | undefined): string {
	if (!run) return "";
	const tokensTotal = (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0);
	return [
		`<div class="cc-phase-section">`,
		`<h3>Last run</h3>`,
		`<dl class="cc-run-meta">`,
		`<dt>Timestamp</dt><dd>${escapeHtml(run.timestamp)}</dd>`,
		`<dt>Status</dt><dd>${escapeHtml(run.status)}</dd>`,
		`<dt>Turns</dt><dd>${run.turn_count}</dd>`,
		`<dt>Tool uses</dt><dd>${run.tool_uses}</dd>`,
		`<dt>Tokens</dt><dd>${escapeHtml(formatTokenCount(tokensTotal))}</dd>`,
		`<dt>Duration</dt><dd>${escapeHtml(formatMillis(run.duration_ms))}</dd>`,
		`</dl>`,
		`</div>`,
	].join("");
}

function renderUsagePanel(usage: UsageFile): string {
	if (usage.runs.length === 0) {
		return [
			`<section class="cc-usage" aria-label="Token usage">`,
			`<h2>Usage</h2>`,
			`<p class="cc-empty">No phase runs recorded yet.</p>`,
			`</section>`,
		].join("\n");
	}
	const totals = computeTotals(usage);
	const perPhase = computePerPhaseTotals(usage);

	const rows = [...perPhase.entries()].map(([phaseId, t]) => {
		const tokensTotal = t.tokens.input + t.tokens.output;
		return [
			`<tr>`,
			`<td>${escapeHtml(phaseId)}</td>`,
			`<td>${t.runs}</td>`,
			`<td>${escapeHtml(formatTokenCount(tokensTotal))}</td>`,
			`<td>${t.tool_uses}</td>`,
			`<td>${escapeHtml(formatMillis(t.duration_ms))}</td>`,
			`</tr>`,
		].join("");
	}).join("");

	return [
		`<section class="cc-usage" aria-label="Token usage">`,
		`<h2>Usage</h2>`,
		`<dl class="cc-usage-totals">`,
		renderUsageTotalsList(totals),
		`</dl>`,
		`<table class="cc-usage-table">`,
		`<thead><tr><th>Phase</th><th>Runs</th><th>Tokens</th><th>Tools</th><th>Duration</th></tr></thead>`,
		`<tbody>${rows}</tbody>`,
		`</table>`,
		`</section>`,
	].join("\n");
}

function renderUsageTotalsList(totals: UsageTotals): string {
	const tokensTotal = totals.tokens.input + totals.tokens.output;
	return [
		`<dt>Total runs</dt><dd>${totals.runs}</dd>`,
		`<dt>Tokens (in / out / cache)</dt><dd>${escapeHtml(formatTokenCount(totals.tokens.input))} / ${escapeHtml(formatTokenCount(totals.tokens.output))} / ${escapeHtml(formatTokenCount(totals.tokens.cache_write))}</dd>`,
		`<dt>Total tokens</dt><dd>${escapeHtml(formatTokenCount(tokensTotal))}</dd>`,
		`<dt>Tool uses</dt><dd>${totals.tool_uses}</dd>`,
		`<dt>Total duration</dt><dd>${escapeHtml(formatMillis(totals.duration_ms))}</dd>`,
	].join("");
}

function renderActivityTimeline(runs: UsageRun[]): string {
	if (runs.length === 0) return "";
	const sorted = [...runs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
	const visible = sorted.slice(0, TIMELINE_VISIBLE_COUNT);
	const overflow = sorted.slice(TIMELINE_VISIBLE_COUNT);

	const rowOf = (run: UsageRun) => {
		const tokensTotal = (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0);
		const sessionCell = run.session_file
			? `<a href="${escapeAttr(run.session_file)}">session</a>`
			: "—";
		return [
			`<tr>`,
			`<td>${escapeHtml(run.timestamp)}</td>`,
			`<td>${escapeHtml(run.phase)}</td>`,
			`<td>${escapeHtml(run.status)}</td>`,
			`<td>${run.turn_count}</td>`,
			`<td>${run.tool_uses}</td>`,
			`<td>${escapeHtml(formatTokenCount(tokensTotal))}</td>`,
			`<td>${escapeHtml(formatMillis(run.duration_ms))}</td>`,
			`<td>${sessionCell}</td>`,
			`</tr>`,
		].join("");
	};

	const visibleRows = visible.map(rowOf).join("");
	const overflowBlock = overflow.length === 0 ? "" : [
		`<details class="cc-timeline-older">`,
		`<summary>Older runs (${overflow.length})</summary>`,
		`<table class="cc-timeline-table">`,
		`<tbody>${overflow.map(rowOf).join("")}</tbody>`,
		`</table>`,
		`</details>`,
	].join("\n");

	return [
		`<section class="cc-timeline" aria-label="Activity timeline">`,
		`<h2>Activity timeline</h2>`,
		`<table class="cc-timeline-table">`,
		`<thead><tr><th>When</th><th>Phase</th><th>Status</th><th>⟳</th><th>Tools</th><th>Tokens</th><th>Duration</th><th>Session</th></tr></thead>`,
		`<tbody>${visibleRows}</tbody>`,
		`</table>`,
		overflowBlock,
		`</section>`,
	].join("\n");
}

function renderOpenQuestionsRollup(status: NormalizedStatus): string {
	const buckets: Array<{ phaseId: string; questions: OpenQuestionEntry[] }> = [];
	for (const [phaseId, phaseState] of Object.entries(status.phases)) {
		if ((phaseState.open_questions ?? []).length > 0) {
			buckets.push({ phaseId, questions: phaseState.open_questions });
		}
	}
	if (buckets.length === 0) return "";

	const sections = buckets.map(({ phaseId, questions }) => [
		`<div class="cc-rollup-phase">`,
		`<h3>${escapeHtml(phaseId)} (${questions.length})</h3>`,
		`<ul class="cc-question-list">`,
		questions.map(renderOpenQuestion).join(""),
		`</ul>`,
		`</div>`,
	].join("")).join("\n");

	return [
		`<section class="cc-rollup" aria-label="Open questions roll-up">`,
		`<h2>Open questions</h2>`,
		sections,
		`</section>`,
	].join("\n");
}

function renderCloseoutsList(closeouts: DashboardCloseoutEntry[]): string {
	if (closeouts.length === 0) {
		return [
			`<section class="cc-closeouts" aria-label="Closeouts">`,
			`<h2>Closeouts</h2>`,
			`<p class="cc-empty">No closeouts yet.</p>`,
			`</section>`,
		].join("\n");
	}
	const sorted = [...closeouts].sort((a, b) => (a.date < b.date ? 1 : -1));
	const rows = sorted.map((c) => {
		const href = relativeHref(`closeouts/${c.fileName}`);
		return [
			`<li>`,
			`<span class="cc-closeout-date">${escapeHtml(c.date)}</span> `,
			`<span class="cc-closeout-phase">${escapeHtml(c.phaseOrModule)}</span> `,
			`— <a href="${escapeAttr(href)}">${escapeHtml(c.fileName)}</a>`,
			`</li>`,
		].join("");
	}).join("");

	return [
		`<section class="cc-closeouts" aria-label="Closeouts">`,
		`<h2>Closeouts</h2>`,
		`<ul class="cc-closeouts-list">${rows}</ul>`,
		`</section>`,
	].join("\n");
}

function renderFooter(inputs: DashboardInputs): string {
	return [
		`<footer class="cc-footer">`,
		`<p>Generated by codecartographer-pi v${escapeHtml(inputs.packageVersion)} at ${escapeHtml(inputs.generatedAt)}.</p>`,
		`<p class="cc-footer-hint">Regenerate via <code>/codecarto-dashboard</code> · narrate via <code>/codecarto-dashboard --narrate</code>.</p>`,
		`</footer>`,
	].join("\n");
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function phaseRenderState(status: NormalizedStatus, phaseId: string): "complete" | "current" | "pending" | "running" {
	const phaseStatus = status.phases[phaseId]?.status;
	if (phaseStatus === "complete") return "complete";
	if (status.current_phase === phaseId) return "current";
	return "pending";
}

function completedPhaseCount(status: NormalizedStatus): number {
	return Object.values(status.phases).filter((p) => p.status === "complete").length;
}

function lastRunPerPhase(runs: UsageRun[]): Map<string, UsageRun> {
	const out = new Map<string, UsageRun>();
	for (const r of runs) {
		const existing = out.get(r.phase);
		if (!existing || existing.timestamp < r.timestamp) out.set(r.phase, r);
	}
	return out;
}

function relativeHref(path: string): string {
	// The dashboard lives at <workspaceDir>/dashboard.html. Workspace-relative
	// paths in pipeline definitions and closeouts are relative to the
	// workspaceDir, so they resolve from the dashboard's URL directly.
	return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

export function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function escapeAttr(input: string): string {
	return escapeHtml(input);
}

// ----------------------------------------------------------------------------
// Styles
// ----------------------------------------------------------------------------

function renderStyles(): string {
	return `<style>
:root {
  --s-1: 4px; --s-2: 8px; --s-3: 16px; --s-4: 24px; --s-5: 40px;
  --fg: #1a1a1a; --fg-dim: #5a5a5a; --bg: #fafafa; --bg-card: #ffffff;
  --border: #e3e3e3; --accent: #2563eb; --accent-fg: #ffffff;
  --status-pending: #94a3b8; --status-current: #2563eb; --status-running: #f59e0b;
  --status-complete: #16a34a; --status-error: #dc2626;
  --code-bg: #f1f5f9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #f1f5f9; --fg-dim: #94a3b8; --bg: #0f172a; --bg-card: #1e293b;
    --border: #334155; --accent: #60a5fa; --accent-fg: #0f172a;
    --status-pending: #64748b; --status-current: #60a5fa; --status-running: #fbbf24;
    --status-complete: #4ade80; --status-error: #f87171;
    --code-bg: #1e293b;
  }
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--fg); margin: 0; padding: var(--s-4);
  line-height: 1.5; font-size: 15px;
}
.cc-dashboard { max-width: 1100px; margin: 0 auto; }
.cc-header h1 { margin: 0 0 var(--s-3) 0; font-size: 28px; }
.cc-header-meta { display: grid; grid-template-columns: max-content 1fr; gap: var(--s-1) var(--s-3); margin: 0 0 var(--s-4) 0; }
.cc-header-meta dt { color: var(--fg-dim); font-weight: 500; }
.cc-header-meta dd { margin: 0; }
h2 { font-size: 18px; margin: var(--s-4) 0 var(--s-2) 0; padding-bottom: var(--s-1); border-bottom: 1px solid var(--border); }
h3 { font-size: 14px; margin: var(--s-2) 0 var(--s-1) 0; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.04em; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--code-bg); padding: 1px 4px; border-radius: 3px; font-size: 13px; }
section { margin-bottom: var(--s-4); }
.cc-empty { color: var(--fg-dim); font-style: italic; }

/* Narration */
.cc-narration { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: var(--s-3); }
.cc-narration-meta { color: var(--fg-dim); font-size: 13px; margin: 0 0 var(--s-2) 0; }
.cc-narration-body pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; font-family: inherit; font-size: 14px; line-height: 1.6; }

/* Progress bar */
.cc-progress-list { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--s-1); }
.cc-progress-item { flex: 1 1 120px; padding: var(--s-2); border: 1px solid var(--border); border-radius: 4px; background: var(--bg-card); display: flex; flex-direction: column; gap: 2px; }
.cc-progress-id { font-weight: 600; }
.cc-progress-badge { font-size: 12px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.cc-state-complete .cc-progress-badge, .cc-state-complete .cc-phase-badge { color: var(--status-complete); }
.cc-state-current .cc-progress-badge, .cc-state-current .cc-phase-badge { color: var(--status-current); font-weight: 600; }
.cc-state-running .cc-progress-badge, .cc-state-running .cc-phase-badge { color: var(--status-running); font-weight: 600; }
.cc-state-pending .cc-progress-badge, .cc-state-pending .cc-phase-badge { color: var(--status-pending); }
.cc-state-current { border-left: 3px solid var(--status-current); }

/* Phase cards */
.cc-phase-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 0; margin-bottom: var(--s-2); }
.cc-phase-card summary { padding: var(--s-2) var(--s-3); cursor: pointer; display: flex; gap: var(--s-3); align-items: baseline; }
.cc-phase-card[open] summary { border-bottom: 1px solid var(--border); }
.cc-phase-id { font-weight: 600; font-size: 16px; }
.cc-phase-purpose { padding: var(--s-2) var(--s-3) 0; color: var(--fg-dim); }
.cc-phase-section { padding: var(--s-2) var(--s-3); }
.cc-phase-section ul { margin: 0; padding-left: var(--s-3); }
.cc-output-list li, .cc-question-list li, .cc-carry-list li, .cc-notes-list li { margin: var(--s-1) 0; }
.cc-question-reason { color: var(--fg-dim); font-size: 13px; margin-left: var(--s-2); }

/* Tags */
.cc-tag { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; background: var(--code-bg); color: var(--fg-dim); border: 1px solid var(--border); }
.cc-tag-present { background: color-mix(in srgb, var(--status-complete) 15%, transparent); color: var(--status-complete); border-color: var(--status-complete); }
.cc-tag-missing { background: color-mix(in srgb, var(--status-error) 15%, transparent); color: var(--status-error); border-color: var(--status-error); }
.cc-tag-target { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border-color: var(--accent); }

/* Run meta dl */
.cc-run-meta { display: grid; grid-template-columns: max-content 1fr; gap: var(--s-1) var(--s-3); margin: 0; }
.cc-run-meta dt { color: var(--fg-dim); font-size: 13px; }
.cc-run-meta dd { margin: 0; font-size: 13px; }

/* Usage */
.cc-usage-totals { display: grid; grid-template-columns: max-content 1fr; gap: var(--s-1) var(--s-3); margin: 0 0 var(--s-3) 0; }
.cc-usage-totals dt { color: var(--fg-dim); }
.cc-usage-totals dd { margin: 0; font-variant-numeric: tabular-nums; }
.cc-usage-table, .cc-timeline-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cc-usage-table th, .cc-usage-table td, .cc-timeline-table th, .cc-timeline-table td { padding: var(--s-1) var(--s-2); text-align: left; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.cc-usage-table th, .cc-timeline-table th { color: var(--fg-dim); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
.cc-timeline-older { margin-top: var(--s-2); }

/* Footer */
.cc-footer { margin-top: var(--s-5); padding-top: var(--s-3); border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 13px; }
.cc-footer p { margin: var(--s-1) 0; }

/* Mobile */
@media (max-width: 720px) {
  body { padding: var(--s-3); font-size: 14px; }
  .cc-progress-list { flex-direction: column; }
  .cc-header-meta, .cc-run-meta, .cc-usage-totals { grid-template-columns: 1fr; }
  .cc-header-meta dt, .cc-run-meta dt, .cc-usage-totals dt { margin-top: var(--s-1); }
}
</style>`;
}
