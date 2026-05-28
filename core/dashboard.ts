// Pure-ish HTML dashboard renderer for a CodeCartographer workspace. The
// writer gathers disk state and calls renderDashboard() to produce a
// self-contained, file://-friendly report. The report includes a small embedded
// script for local-only filtering and export; it has no external assets.

import { formatMillis, formatTokenCount } from "./utils.ts";
import type { NormalizedStatus, OpenQuestionEntry, CarryForwardEntry, PipelineFile, PipelinePhase, StatusPhase } from "./types.ts";
import type { UsageFile, UsageRun, UsageTotals } from "./usage.ts";
import { computePerPhaseTotals, computeTotals } from "./usage.ts";

export const DASHBOARD_RELATIVE_PATH = "dashboard.html";
export const NARRATION_CACHE_RELATIVE_PATH = ".dashboard-narration.local.md";

const TIMELINE_VISIBLE_COUNT = 10;

export interface DashboardArtifactLink {
	path: string;
	exists: boolean;
	kind: "primary" | "secondary";
}

export interface DashboardCloseoutEntry {
	date: string;
	phaseOrModule: string;
	fileName: string;
	summary?: string;
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
	const projectName = inputs.status.project_name || "CodeCartographer";
	const sections = [
		renderSidebar(inputs),
		`<div class="cc-main">`,
		renderHeader(inputs),
		renderStalenessWarning(inputs),
		renderHealthPanel(inputs),
		inputs.narration ? renderNarration(inputs.narration, completedPhaseCount(inputs.status)) : "",
		renderKeyResults(inputs),
		renderProgressBar(inputs.pipeline, inputs.status),
		renderPhaseCards(inputs),
		renderUsagePanel(inputs),
		renderActivityTimeline(inputs.usage.runs),
		renderOpenQuestionsRollup(inputs.status),
		renderCloseoutsList(inputs),
		renderFooter(inputs),
		`</div>`,
	].filter(Boolean).join("\n");

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
		`<button class="cc-menu-button" type="button" data-sidebar-toggle aria-label="Toggle navigation">☰</button>`,
		`<main class="cc-dashboard">`,
		sections,
		"</main>",
		renderExportData(inputs),
		renderScripts(),
		"</body>",
		"</html>",
	].join("\n");
}

// ----------------------------------------------------------------------------
// Sections
// ----------------------------------------------------------------------------

function renderSidebar(inputs: DashboardInputs): string {
	const phaseLinks = inputs.pipeline.phase_order.map((phaseId) => {
		const state = phaseRenderState(inputs.status, phaseId);
		return `<a class="cc-nav-link cc-state-${state}" href="#${phaseAnchor(phaseId)}" data-status="${escapeAttr(state)}"><span>${escapeHtml(phaseId)}</span><b>${escapeHtml(state)}</b></a>`;
	}).join("\n");
	return [
		`<aside class="cc-sidebar" data-sidebar>`,
		`<div class="cc-brand">`,
		`<span class="cc-brand-mark">◇</span>`,
		`<div><strong>CodeCartographer</strong><span>${escapeHtml(inputs.status.project_name || "workspace")}</span></div>`,
		`</div>`,
		`<label class="cc-search-label">Search dashboard</label>`,
		`<input class="cc-search" type="search" placeholder="phase, output, question…" data-search>`,
		`<div class="cc-filter-row" aria-label="Status filters">`,
		`<button type="button" class="cc-filter is-active" data-filter="all">All</button>`,
		`<button type="button" class="cc-filter" data-filter="complete">Complete</button>`,
		`<button type="button" class="cc-filter" data-filter="current">Current</button>`,
		`<button type="button" class="cc-filter" data-filter="pending">Pending</button>`,
		`</div>`,
		`<nav class="cc-nav" aria-label="Dashboard sections">`,
		`<a class="cc-nav-section" href="#summary">Summary</a>`,
		`<a class="cc-nav-section" href="#key-results">Key results</a>`,
		`<a class="cc-nav-section" href="#phases">Phases</a>`,
		phaseLinks,
		`<a class="cc-nav-section" href="#usage">Usage</a>`,
		`<a class="cc-nav-section" href="#closeouts">Closeouts</a>`,
		`</nav>`,
		`<button type="button" class="cc-export" data-export>Export dashboard JSON</button>`,
		`<p class="cc-sidebar-foot">Self-contained local report. No network calls.</p>`,
		`</aside>`,
	].join("\n");
}

function renderHeader(inputs: DashboardInputs): string {
	const { status, pipeline, packageVersion, generatedAt } = inputs;
	const projectName = status.project_name || "(unnamed project)";
	const pipelineLabel = pipeline.workflow_name || status.pipeline;
	const currentPhase = displayCurrentPhase(status);
	const totals = computeTotals(inputs.usage);
	const completed = completedPhaseCount(status);
	const total = pipeline.phase_order.length;
	const nextActions = status.next_actions?.length
		? `<ul class="cc-next-actions">${status.next_actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
		: `<p class="cc-muted">No next actions recorded.</p>`;

	return [
		`<header class="cc-header" id="summary" data-section data-search-text="${escapeAttr([projectName, pipelineLabel, currentPhase, pipeline.workflow_goal ?? ""].join(" "))}">`,
		`<div class="cc-eyebrow">CodeCartographer dashboard</div>`,
		`<h1>${escapeHtml(projectName)}</h1>`,
		pipeline.workflow_goal ? `<p class="cc-goal">${escapeHtml(pipeline.workflow_goal)}</p>` : "",
		`<div class="cc-stat-grid">`,
		renderStat("Pipeline", pipelineLabel),
		renderStat("Current phase", currentPhase),
		renderStat("Progress", `${completed}/${total} phases`),
		renderStat("Recorded tokens", formatTokensForDashboard(inputs.usage)),
		renderStat("Tool uses", String(totals.tool_uses)),
		renderStat("Package", `v${packageVersion}`),
		`</div>`,
		`<details class="cc-meta-details">`,
		`<summary>Run metadata and next actions</summary>`,
		`<dl class="cc-header-meta">`,
		`<dt>Status last updated</dt><dd>${escapeHtml(status.last_updated || "never")}</dd>`,
		`<dt>Dashboard generated</dt><dd>${escapeHtml(generatedAt)}</dd>`,
		`<dt>Status file</dt><dd><code>${escapeHtml(status.pipeline)}</code></dd>`,
		`</dl>`,
		`<h3>Next actions</h3>`,
		nextActions,
		`</details>`,
		`</header>`,
	].filter(Boolean).join("\n");
}

function renderStat(label: string, value: string): string {
	return `<div class="cc-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderStalenessWarning(inputs: DashboardInputs): string {
	if (!inputs.status.last_updated || inputs.status.last_updated <= inputs.generatedAt) return "";
	return `<section class="cc-warning" data-section><strong>Dashboard may be stale.</strong> Status was updated at ${escapeHtml(inputs.status.last_updated)} after this dashboard was generated at ${escapeHtml(inputs.generatedAt)}. Regenerate with <code>/codecarto-dashboard</code>.</section>`;
}

type DashboardIssue = { severity: "blocker" | "warning"; phaseId: string; title: string; detail: string; path?: string };

function renderHealthPanel(inputs: DashboardInputs): string {
	const { status, pipeline, usage } = inputs;
	const completed = completedPhaseCount(status);
	const total = pipeline.phase_order.length;
	const totals = computeTotals(usage);
	const issues = collectDashboardIssues(inputs);
	const openQuestionCount = countOpenQuestions(status);
	const carryForwardCount = countCarryForward(status);
	const health = issues.some((i) => i.severity === "blocker") ? "attention required" : issues.length ? "review recommended" : completed === total ? "complete" : "on track";
	const healthClass = issues.some((i) => i.severity === "blocker") ? "bad" : issues.length ? "warn" : "ok";
	const tokenText = usageHasTokenAccounting(usage) ? formatTokenCount(totals.tokens.input + totals.tokens.output) : usage.runs.length ? "unavailable" : "0";
	const issueMarkup = issues.length
		? `<div class="cc-health-issues">${issues.map(renderDashboardIssue).join("\n")}</div>`
		: `<p class="cc-health-ok">No blocking artifact gaps detected.</p>`;

	return [
		`<section class="cc-card cc-health cc-health-${healthClass}" aria-label="Dashboard health" data-section data-search-text="health status blockers missing artifacts open questions">`,
		`<div class="cc-health-hero">`,
		`<div><div class="cc-eyebrow">Pipeline health</div><h2>${escapeHtml(health)}</h2><p>${escapeHtml(status.current_phase && status.current_phase !== "complete" ? `Current phase: ${status.current_phase}` : "Pipeline complete — all phases have finished.")}</p></div>`,
		`<div class="cc-health-ring" aria-label="${completed} of ${total} phases complete"><strong>${completed}/${total}</strong><span>phases</span></div>`,
		`</div>`,
		`<div class="cc-health-grid">`,
		renderHealthMetric("Artifacts needing attention", String(issues.length), issues.length ? "bad" : "ok"),
		renderHealthMetric("Open questions", String(openQuestionCount), openQuestionCount ? "warn" : "ok"),
		renderHealthMetric("Carry-forward items", String(carryForwardCount), carryForwardCount ? "warn" : "ok"),
		renderHealthMetric("Tool uses", String(totals.tool_uses), "neutral"),
		renderHealthMetric("Runtime", formatMillis(totals.duration_ms), "neutral"),
		renderHealthMetric("Tokens", tokenText, tokenText === "unavailable" ? "warn" : "neutral"),
		`</div>`,
		issueMarkup,
		`</section>`,
	].join("\n");
}

function renderHealthMetric(label: string, value: string, tone: "ok" | "warn" | "bad" | "neutral"): string {
	return `<div class="cc-health-metric cc-tone-${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderDashboardIssue(issue: DashboardIssue): string {
	const path = issue.path ? `<code>${escapeHtml(issue.path)}</code>` : "";
	return `<article class="cc-health-issue cc-issue-${issue.severity}"><div><span class="cc-pill ${issue.severity === "blocker" ? "cc-pill-bad" : ""}">${escapeHtml(issue.severity)}</span><a href="#${phaseAnchor(issue.phaseId)}">${escapeHtml(issue.phaseId)}</a></div><strong>${escapeHtml(issue.title)}</strong><p>${escapeHtml(issue.detail)} ${path}</p></article>`;
}

function collectDashboardIssues(inputs: DashboardInputs): DashboardIssue[] {
	const out: DashboardIssue[] = [];
	for (const phaseId of inputs.pipeline.phase_order) {
		const phase = getPhase(inputs.pipeline, phaseId);
		if (!phase?.primary_output) continue;
		const state = phaseRenderState(inputs.status, phaseId);
		const primary = inputs.outputsPresent.get(phaseId)?.primary;
		const shouldExist = state === "complete" || state === "current" || state === "running";
		if (shouldExist && primary?.exists === false) {
			out.push({
				severity: state === "complete" || state === "current" ? "blocker" : "warning",
				phaseId,
				title: "Required primary output is missing",
				detail: state === "complete" ? "Phase is marked complete but the dashboard cannot find its primary artifact at" : "This phase is active or ready, but its required artifact is not present at",
				path: phase.primary_output,
			});
		}
	}
	return out;
}

function renderNarration(narration: DashboardNarration, currentCompletedCount: number): string {
	const runsSince = Math.max(0, currentCompletedCount - narration.phaseCountAtGeneration);
	const staleness = runsSince === 0 ? "current" : `${runsSince} run${runsSince === 1 ? "" : "s"} since`;
	return [
		`<section class="cc-card cc-narration" aria-label="Executive summary" data-section data-search-text="${escapeAttr(narration.content)}">`,
		`<div class="cc-section-head"><h2>Executive summary</h2><span>${escapeHtml(staleness)}</span></div>`,
		`<p class="cc-narration-meta">Narrated ${escapeHtml(narration.generatedAt)}.</p>`,
		`<pre>${escapeHtml(narration.content)}</pre>`,
		`</section>`,
	].join("\n");
}

function renderKeyResults(inputs: DashboardInputs): string {
	const rows: string[] = [];
	for (const phaseId of inputs.pipeline.phase_order) {
		const phase = getPhase(inputs.pipeline, phaseId);
		if (!phase?.primary_output) continue;
		const outputs = inputs.outputsPresent.get(phaseId);
		const closeout = closeoutForPhase(inputs.closeouts, phaseId);
		const primary = outputs?.primary;
		if (primary?.exists || phaseRenderState(inputs.status, phaseId) === "complete") {
			rows.push(renderArtifactRow({ phaseId, label: "Primary result", path: phase.primary_output, exists: primary?.exists ?? false, closeout }));
		}
	}
	if (rows.length === 0) return "";
	return [
		`<section class="cc-card" id="key-results" aria-label="Key results" data-section data-search-text="key results final artifacts outputs">`,
		`<div class="cc-section-head"><h2>Key results</h2><span>${rows.length} artifacts</span></div>`,
		`<div class="cc-artifact-list">${rows.join("\n")}</div>`,
		`</section>`,
	].join("\n");
}

function renderArtifactRow(input: { phaseId: string; label: string; path: string; exists: boolean; closeout?: DashboardCloseoutEntry }): string {
	const result = input.exists
		? renderSafeLink(input.path, input.path)
		: `<span class="cc-missing-path">${escapeHtml(input.path)}</span>`;
	const closeout = input.closeout
		? renderSafeLink(`closeouts/${input.closeout.fileName}`, "closeout", "cc-pill")
		: `<span class="cc-pill cc-pill-muted">no closeout</span>`;
	return `<article class="cc-artifact-row" data-search-text="${escapeAttr(`${input.phaseId} ${input.path} ${input.label}`)}"><div><a class="cc-phase-jump" href="#${phaseAnchor(input.phaseId)}">${escapeHtml(input.phaseId)}</a><span>${escapeHtml(input.label)}</span></div><div>${result}</div><div>${input.exists ? `<span class="cc-pill cc-pill-ok">available</span>` : `<span class="cc-pill cc-pill-bad">missing</span>`}${closeout}</div></article>`;
}

function renderProgressBar(pipeline: PipelineFile, status: NormalizedStatus): string {
	const items = pipeline.phase_order.map((phaseId) => {
		const state = phaseRenderState(status, phaseId);
		const purpose = getPhase(pipeline, phaseId)?.purpose ?? "";
		return [
			`<li class="cc-progress-item cc-state-${state}" title="${escapeAttr(purpose)}">`,
			`<a href="#${phaseAnchor(phaseId)}">`,
			`<span class="cc-progress-id">${escapeHtml(phaseId)}</span>`,
			`<span class="cc-progress-badge">${escapeHtml(state)}</span>`,
			`</a>`,
			`</li>`,
		].join("");
	}).join("\n");

	return [
		`<section class="cc-progress" aria-label="Pipeline progress" data-section data-search-text="pipeline progress">`,
		`<h2>Pipeline progress</h2>`,
		`<ol class="cc-progress-list">`,
		items,
		`</ol>`,
		`</section>`,
	].join("\n");
}

function renderPhaseCards(inputs: DashboardInputs): string {
	const { status, pipeline, usage, outputsPresent, closeouts } = inputs;
	const perPhaseLastRun = lastRunPerPhase(usage.runs);

	const cards = pipeline.phase_order.map((phaseId) => {
		const phaseDef = getPhase(pipeline, phaseId);
		const phaseState = status.phases[phaseId];
		const renderState = phaseRenderState(status, phaseId);
		const outputs = outputsPresent.get(phaseId);
		const lastRun = perPhaseLastRun.get(phaseId);
		const closeout = closeoutForPhase(closeouts, phaseId);
		const open = renderState === "running" || renderState === "current";
		const detailsAttr = open ? " open" : "";
		const searchText = [phaseId, phaseDef?.purpose, phaseDef?.primary_output, ...(phaseDef?.secondary_outputs ?? []).map((s) => s.path), ...(phaseState?.owner_notes ?? []), ...(phaseState?.open_questions ?? []).map((q) => q.description)].filter(Boolean).join(" ");

		return [
			`<details class="cc-phase-card cc-state-${renderState}" id="${phaseAnchor(phaseId)}" data-section data-phase data-status="${escapeAttr(renderState)}" data-search-text="${escapeAttr(searchText)}"${detailsAttr}>`,
			`<summary>`,
			`<span class="cc-phase-id">${escapeHtml(phaseId)}</span>`,
			`<span class="cc-phase-badge">${escapeHtml(renderState)}</span>`,
			`</summary>`,
			renderPhasePurpose(phaseDef),
			renderPhaseOverview(phaseDef),
			renderPhaseOutputs(phaseDef, outputs),
			renderPhaseCloseout(closeout),
			renderPhaseOpenQuestions(phaseState),
			renderPhaseCarryForward(phaseState),
			renderPhaseOwnerNotes(phaseState),
			renderPhaseLastRun(lastRun),
			`</details>`,
		].filter(Boolean).join("\n");
	}).join("\n");

	return [
		`<section class="cc-phases" id="phases" aria-label="Per-phase status">`,
		`<h2>Phases</h2>`,
		cards,
		`</section>`,
	].join("\n");
}

function renderPhasePurpose(phase: PipelinePhase | undefined): string {
	if (!phase?.purpose) return "";
	return `<p class="cc-phase-purpose">${escapeHtml(phase.purpose)}</p>`;
}

function renderPhaseOverview(phase: PipelinePhase | undefined): string {
	if (!phase) return "";
	const bits: string[] = [];
	if ((phase.depends_on ?? []).length > 0) bits.push(`<div><strong>Depends on</strong>${phase.depends_on.map((d) => `<a class="cc-pill" href="#${phaseAnchor(d)}">${escapeHtml(d)}</a>`).join("")}</div>`);
	if ((phase.required_reads ?? []).length > 0) bits.push(`<div><strong>Required reads</strong>${phase.required_reads.map((r) => `<code>${escapeHtml(r)}</code>`).join(" ")}</div>`);
	if (bits.length === 0) return "";
	return `<div class="cc-phase-section cc-phase-overview">${bits.join("")}</div>`;
}

function renderPhaseOutputs(phase: PipelinePhase | undefined, outputs: OutputAvailability | undefined): string {
	if (!phase) return "";
	const lines: string[] = [];
	if (phase.primary_output) {
		const present = outputs?.primary?.exists ?? false;
		const link = renderSafeLink(phase.primary_output, phase.primary_output);
		lines.push(present && link
			? `<li>${link} <span class="cc-pill cc-pill-ok">primary</span></li>`
			: `<li><span class="cc-pill cc-pill-bad">primary missing</span> <span class="cc-missing-path">${escapeHtml(phase.primary_output)}</span></li>`);
	}
	for (const sec of phase.secondary_outputs ?? []) {
		const present = outputs?.secondary.find((s) => s.path === sec.path)?.exists ?? false;
		const link = renderSafeLink(sec.path, sec.path);
		lines.push(present && link
			? `<li>${link} <span class="cc-pill">secondary</span></li>`
			: `<li><span class="cc-pill cc-pill-bad">secondary missing</span> <span class="cc-missing-path">${escapeHtml(sec.path)}</span></li>`);
	}
	if (lines.length === 0) return "";
	return `<div class="cc-phase-section"><h3>Outputs</h3><ul class="cc-output-list">${lines.join("")}</ul></div>`;
}

function renderPhaseCloseout(closeout: DashboardCloseoutEntry | undefined): string {
	if (!closeout) return "";
	const link = renderSafeLink(`closeouts/${closeout.fileName}`, closeout.fileName);
	return `<div class="cc-phase-section"><h3>Closeout</h3><p>${link ?? escapeHtml(closeout.fileName)}</p>${closeout.summary ? `<p class="cc-closeout-summary">${escapeHtml(closeout.summary)}</p>` : ""}</div>`;
}

function renderPhaseOpenQuestions(phaseState: StatusPhase | undefined): string {
	const items = phaseState?.open_questions ?? [];
	if (items.length === 0) return "";
	return [`<div class="cc-phase-section">`, `<h3>Open questions (${items.length})</h3>`, `<ul class="cc-question-list">`, items.map(renderOpenQuestion).join(""), `</ul>`, `</div>`].join("");
}

function renderOpenQuestion(q: OpenQuestionEntry): string {
	const kind = q.kind ? `<span class="cc-pill">${escapeHtml(String(q.kind))}</span> ` : "";
	const desc = escapeHtml(q.description ?? "(no description)");
	const reason = q.deferred_reason ? `<div class="cc-question-reason">${escapeHtml(q.deferred_reason)}</div>` : "";
	return `<li>${kind}${desc}${reason}</li>`;
}

function renderPhaseCarryForward(phaseState: StatusPhase | undefined): string {
	const items = phaseState?.carry_forward ?? [];
	if (items.length === 0) return "";
	return [`<div class="cc-phase-section">`, `<h3>Carry-forward (${items.length})</h3>`, `<ul class="cc-carry-list">`, items.map(renderCarryForward).join(""), `</ul>`, `</div>`].join("");
}

function renderCarryForward(c: CarryForwardEntry): string {
	const target = c.target_phase ? `<a class="cc-pill cc-pill-target" href="#${phaseAnchor(c.target_phase)}">→ ${escapeHtml(c.target_phase)}</a> ` : "";
	const kind = c.kind ? `<span class="cc-pill">${escapeHtml(String(c.kind))}</span> ` : "";
	const desc = escapeHtml(c.description ?? "(no description)");
	const reason = c.deferred_reason ? `<div class="cc-question-reason">${escapeHtml(c.deferred_reason)}</div>` : "";
	return `<li>${target}${kind}${desc}${reason}</li>`;
}

function renderPhaseOwnerNotes(phaseState: StatusPhase | undefined): string {
	const notes = phaseState?.owner_notes ?? [];
	if (notes.length === 0) return "";
	return [`<div class="cc-phase-section">`, `<h3>Owner notes</h3>`, `<ul class="cc-notes-list">`, notes.map((n) => `<li>${escapeHtml(n)}</li>`).join(""), `</ul>`, `</div>`].join("");
}

function renderPhaseLastRun(run: UsageRun | undefined): string {
	if (!run) return `<div class="cc-phase-section"><h3>Last run</h3><p class="cc-muted">No usage record for this phase.</p></div>`;
	const tokensTotal = formatRunTokens(run);
	const sessionLink = run.session_file ? renderSafeLink(run.session_file, "transcript") : undefined;
	const session = sessionLink ? `<dt>Session</dt><dd>${sessionLink}</dd>` : "";
	return [`<div class="cc-phase-section">`, `<h3>Last run</h3>`, `<dl class="cc-run-meta">`, `<dt>Timestamp</dt><dd>${escapeHtml(run.timestamp)}</dd>`, `<dt>Status</dt><dd>${escapeHtml(run.status)}</dd>`, `<dt>Turns</dt><dd>${run.turn_count}</dd>`, `<dt>Tool uses</dt><dd>${run.tool_uses}</dd>`, `<dt>Tokens</dt><dd>${escapeHtml(tokensTotal)}</dd>`, `<dt>Duration</dt><dd>${escapeHtml(formatMillis(run.duration_ms))}</dd>`, session, `</dl>`, `</div>`].join("");
}

function renderUsagePanel(inputs: DashboardInputs): string {
	const { usage, pipeline, status } = inputs;
	const totals = computeTotals(usage);
	const perPhase = computePerPhaseTotals(usage);
	const tokenAccounting = usageHasTokenAccounting(usage);
	const maxTools = Math.max(1, ...[...perPhase.values()].map((t) => t.tool_uses));
	const maxDuration = Math.max(1, ...[...perPhase.values()].map((t) => t.duration_ms));
	const rows = pipeline.phase_order.map((phaseId) => {
		const t = perPhase.get(phaseId);
		if (!t) {
			const complete = status.phases[phaseId]?.status === "complete";
			return `<tr class="${complete ? "cc-usage-missing" : ""}"><td><a href="#${phaseAnchor(phaseId)}">${escapeHtml(phaseId)}</a></td><td>0</td><td>—</td><td>—</td><td>—</td><td>${complete ? "usage not recorded" : "not run"}</td></tr>`;
		}
		const tokensTotal = t.tokens.input + t.tokens.output;
		return `<tr><td><a href="#${phaseAnchor(phaseId)}">${escapeHtml(phaseId)}</a></td><td>${t.runs}</td><td>${escapeHtml(tokenAccounting ? formatTokenCount(tokensTotal) : "unavailable")}</td><td>${renderUsageBar(t.tool_uses, maxTools, String(t.tool_uses))}</td><td>${renderUsageBar(t.duration_ms, maxDuration, formatMillis(t.duration_ms))}</td><td>${usagePhaseNote(phaseId, status)}</td></tr>`;
	}).join("");

	return [
		`<section class="cc-card cc-usage" id="usage" aria-label="Token usage" data-section data-search-text="usage tokens tool duration">`,
		`<div class="cc-section-head"><h2>Usage</h2><span>${totals.runs} runs</span></div>`,
		usage.runs.length === 0 ? `<p class="cc-empty">No phase runs recorded yet.</p>` : `<dl class="cc-usage-totals">${renderUsageTotalsList(totals, tokenAccounting)}</dl>`,
		renderUsageInsights(perPhase, status),
		`<table class="cc-usage-table">`,
		`<thead><tr><th>Phase</th><th>Runs</th><th>Tokens</th><th>Tools</th><th>Duration</th><th>State</th></tr></thead>`,
		`<tbody>${rows}</tbody>`,
		`</table>`,
		`</section>`,
	].join("\n");
}

function renderUsageTotalsList(totals: UsageTotals, tokenAccounting: boolean): string {
	const tokensTotal = totals.tokens.input + totals.tokens.output;
	const tokenDetail = tokenAccounting
		? `${escapeHtml(formatTokenCount(totals.tokens.input))} / ${escapeHtml(formatTokenCount(totals.tokens.output))} / ${escapeHtml(formatTokenCount(totals.tokens.cache_write))}`
		: `<span class="cc-muted">unavailable — host did not report token counts</span>`;
	const tokenTotal = tokenAccounting ? escapeHtml(formatTokenCount(tokensTotal)) : `<span class="cc-muted">unavailable</span>`;
	return [`<dt>Total runs</dt><dd>${totals.runs}</dd>`, `<dt>Tokens (in / out / cache)</dt><dd>${tokenDetail}</dd>`, `<dt>Total tokens</dt><dd>${tokenTotal}</dd>`, `<dt>Tool uses</dt><dd>${totals.tool_uses}</dd>`, `<dt>Total duration</dt><dd>${escapeHtml(formatMillis(totals.duration_ms))}</dd>`].join("");
}

function renderUsageInsights(perPhase: Map<string, UsageTotals>, status: NormalizedStatus): string {
	if (perPhase.size === 0) return "";
	const entries = [...perPhase.entries()];
	const longest = entries.reduce((best, entry) => entry[1].duration_ms > best[1].duration_ms ? entry : best, entries[0]);
	const mostTools = entries.reduce((best, entry) => entry[1].tool_uses > best[1].tool_uses ? entry : best, entries[0]);
	const current = status.current_phase ? perPhase.get(status.current_phase) : undefined;
	return [
		`<div class="cc-usage-insights">`,
		renderInsight("Longest phase", longest[0], formatMillis(longest[1].duration_ms)),
		renderInsight("Most tool-heavy", mostTools[0], `${mostTools[1].tool_uses} tools`),
		current && status.current_phase ? renderInsight("Current phase usage", status.current_phase, `${current.runs} run${current.runs === 1 ? "" : "s"} · ${formatMillis(current.duration_ms)}`) : "",
		`</div>`,
	].filter(Boolean).join("\n");
}

function renderInsight(label: string, phaseId: string, value: string): string {
	return `<article class="cc-insight"><span>${escapeHtml(label)}</span><a href="#${phaseAnchor(phaseId)}">${escapeHtml(phaseId)}</a><strong>${escapeHtml(value)}</strong></article>`;
}

function renderUsageBar(value: number, max: number, label: string): string {
	const pct = Math.max(3, Math.min(100, Math.round((value / max) * 100)));
	return `<span class="cc-bar-cell"><span class="cc-bar" style="--cc-bar:${pct}%"></span><span>${escapeHtml(label)}</span></span>`;
}

function usagePhaseNote(phaseId: string, status: NormalizedStatus): string {
	return escapeHtml(phaseRenderState(status, phaseId));
}

function renderActivityTimeline(runs: UsageRun[]): string {
	if (runs.length === 0) return "";
	const sorted = [...runs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
	const visible = sorted.slice(0, TIMELINE_VISIBLE_COUNT);
	const overflow = sorted.slice(TIMELINE_VISIBLE_COUNT);
	const hasSessionLinks = sorted.some((run) => Boolean(run.session_file && safeRelativeHref(run.session_file)));
	const rowOf = (run: UsageRun) => {
		const tokensTotal = formatRunTokens(run);
		const sessionCell = run.session_file ? (renderSafeLink(run.session_file, "session") ?? "—") : "—";
		return `<tr><td>${escapeHtml(run.timestamp)}</td><td><a href="#${phaseAnchor(run.phase)}">${escapeHtml(run.phase)}</a></td><td>${escapeHtml(run.status)}</td><td>${run.turn_count}</td><td>${run.tool_uses}</td><td>${escapeHtml(tokensTotal)}</td><td>${escapeHtml(formatMillis(run.duration_ms))}</td>${hasSessionLinks ? `<td>${sessionCell}</td>` : ""}</tr>`;
	};
	const overflowBlock = overflow.length === 0 ? "" : [`<details class="cc-timeline-older">`, `<summary>Older runs (${overflow.length})</summary>`, `<table class="cc-timeline-table">`, `<tbody>${overflow.map(rowOf).join("")}</tbody>`, `</table>`, `</details>`].join("\n");
	return [`<section class="cc-card cc-timeline" aria-label="Activity timeline" data-section data-search-text="activity timeline sessions">`, `<div class="cc-section-head"><h2>Activity timeline</h2><span>newest first</span></div>`, `<table class="cc-timeline-table">`, `<thead><tr><th>When</th><th>Phase</th><th>Status</th><th>Turns</th><th>Tools</th><th>Tokens</th><th>Duration</th>${hasSessionLinks ? "<th>Session</th>" : ""}</tr></thead>`, `<tbody>${visible.map(rowOf).join("")}</tbody>`, `</table>`, overflowBlock, `</section>`].join("\n");
}

function renderOpenQuestionsRollup(status: NormalizedStatus): string {
	const buckets: string[] = [];
	const seen = new Set<string>();
	const byKind = new Map<string, number>();
	let total = 0;
	for (const [phaseId, phaseState] of Object.entries(status.phases)) {
		const questions: string[] = [];
		for (const q of phaseState.open_questions ?? []) {
			const key = `${q.kind ?? ""}|${q.description ?? ""}|${q.deferred_reason ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const kind = String(q.kind ?? "unspecified");
			byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
			questions.push(renderOpenQuestion(q));
		}
		if (questions.length === 0) continue;
		total += questions.length;
		buckets.push(`<div class="cc-question-bucket"><h3>${escapeHtml(phaseId)} (${questions.length})</h3><a class="cc-pill cc-pill-target" href="#${phaseAnchor(phaseId)}">jump to phase</a><ul class="cc-question-list">${questions.join("")}</ul></div>`);
	}
	if (total === 0) return "";
	const kindSummary = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `<span class="cc-kind-chip"><strong>${count}</strong>${escapeHtml(kind)}</span>`).join("");
	return [`<section class="cc-card cc-rollup" aria-label="Open questions roll-up" data-section data-search-text="open questions">`, `<div class="cc-section-head"><h2>Open questions</h2><span>${total} unique</span></div>`, `<div class="cc-kind-summary">${kindSummary}</div>`, buckets.join("\n"), `</section>`].join("\n");
}

function renderCloseoutsList(inputs: DashboardInputs): string {
	const closeouts = inputs.closeouts;
	if (closeouts.length === 0) return [`<section class="cc-card cc-closeouts" id="closeouts" aria-label="Closeouts" data-section>`, `<h2>Closeouts</h2>`, `<p class="cc-empty">No closeouts yet.</p>`, `</section>`].join("\n");
	const sorted = [...closeouts].sort((a, b) => (a.date < b.date ? 1 : -1));
	const rows = sorted.map((c) => {
		const phase = getPhase(inputs.pipeline, c.phaseOrModule);
		const outputs = inputs.outputsPresent.get(c.phaseOrModule);
		const outputLinks = renderCloseoutOutputLinks(phase, outputs);
		const closeoutLink = renderSafeLink(`closeouts/${c.fileName}`, "summary");
		const summary = c.summary ? `<p class="cc-closeout-summary">${escapeHtml(c.summary)}</p>` : "";
		return `<article class="cc-closeout-row" data-search-text="${escapeAttr(`${c.date} ${c.phaseOrModule} ${c.fileName} ${c.summary ?? ""}`)}"><div><span class="cc-closeout-date">${escapeHtml(c.date)}</span><a class="cc-phase-jump" href="#${phaseAnchor(c.phaseOrModule)}">${escapeHtml(c.phaseOrModule)}</a></div><div>${closeoutLink ?? "summary"}<code>${escapeHtml(c.fileName)}</code>${summary}</div><div class="cc-closeout-results">${outputLinks}</div></article>`;
	}).join("\n");
	return [`<section class="cc-card cc-closeouts" id="closeouts" aria-label="Closeouts" data-section data-search-text="closeouts summaries results">`, `<div class="cc-section-head"><h2>Closeouts</h2><span>${closeouts.length} summaries</span></div>`, `<div class="cc-closeouts-list">${rows}</div>`, `</section>`].join("\n");
}

function renderCloseoutOutputLinks(phase: PipelinePhase | undefined, outputs: OutputAvailability | undefined): string {
	if (!phase) return `<span class="cc-pill cc-pill-muted">non-phase closeout</span>`;
	const links: string[] = [];
	if (phase.primary_output) {
		const exists = outputs?.primary?.exists ?? false;
		links.push(exists ? (renderSafeLink(phase.primary_output, "primary result", "cc-pill cc-pill-ok") ?? `<span class="cc-pill cc-pill-bad">primary unsafe</span>`) : `<span class="cc-pill cc-pill-bad">primary missing</span>`);
	}
	for (const sec of phase.secondary_outputs ?? []) {
		const exists = outputs?.secondary.find((s) => s.path === sec.path)?.exists ?? false;
		if (exists) links.push(renderSafeLink(sec.path, "secondary", "cc-pill") ?? `<span class="cc-pill cc-pill-bad">secondary unsafe</span>`);
	}
	return links.length ? links.join("") : `<span class="cc-pill cc-pill-muted">no outputs</span>`;
}

function renderFooter(inputs: DashboardInputs): string {
	return [`<footer class="cc-footer">`, `<p>Generated by codecartographer-pi v${escapeHtml(inputs.packageVersion)} at ${escapeHtml(inputs.generatedAt)}.</p>`, `<p class="cc-footer-hint">Regenerate via <code>/codecarto-dashboard</code> · narrate via <code>/codecarto-dashboard --narrate</code>.</p>`, `</footer>`].join("\n");
}

// ----------------------------------------------------------------------------
// Data export and JS
// ----------------------------------------------------------------------------

function renderExportData(inputs: DashboardInputs): string {
	const phases = inputs.pipeline.phase_order.map((phaseId) => {
		const phase = getPhase(inputs.pipeline, phaseId);
		const outputs = inputs.outputsPresent.get(phaseId);
		return {
			id: phaseId,
			status: phaseRenderState(inputs.status, phaseId),
			purpose: phase?.purpose ?? "",
			primary_output: phase?.primary_output ?? null,
			primary_output_exists: outputs?.primary?.exists ?? false,
			secondary_outputs: outputs?.secondary ?? [],
		};
	});
	const data = { project: inputs.status.project_name, generatedAt: inputs.generatedAt, packageVersion: inputs.packageVersion, phases, usage: inputs.usage, closeouts: inputs.closeouts };
	return `<script id="cc-dashboard-data" type="application/json">${escapeJsonForScript(data)}</script>`;
}

function renderScripts(): string {
	return `<script>
(() => {
  const q = document.querySelector('[data-search]');
  const filters = [...document.querySelectorAll('[data-filter]')];
  const sections = [...document.querySelectorAll('[data-section]')];
  let active = 'all';
  function textFor(el){ return ((el.dataset.searchText || '') + ' ' + el.textContent).toLowerCase(); }
  function apply(){
    const terms = (q?.value || '').toLowerCase().trim().split(/\\s+/).filter(Boolean);
    for (const el of sections) {
      const status = el.dataset.status;
      const statusOk = active === 'all' || !status || status === active;
      const searchOk = terms.every(t => textFor(el).includes(t));
      el.hidden = !(statusOk && searchOk);
    }
  }
  q?.addEventListener('input', apply);
  for (const btn of filters) btn.addEventListener('click', () => {
    active = btn.dataset.filter || 'all';
    filters.forEach(b => b.classList.toggle('is-active', b === btn));
    apply();
  });
  document.querySelector('[data-export]')?.addEventListener('click', () => {
    const raw = document.getElementById('cc-dashboard-data')?.textContent || '{}';
    const blob = new Blob([JSON.stringify(JSON.parse(raw), null, 2) + '\\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'codecartographer-dashboard.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.querySelector('[data-sidebar-toggle]')?.addEventListener('click', () => document.body.classList.toggle('cc-sidebar-open'));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { if (q) q.value = ''; active = 'all'; filters.forEach(b => b.classList.toggle('is-active', b.dataset.filter === 'all')); apply(); document.body.classList.remove('cc-sidebar-open'); }
  });
})();
</script>`;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function phaseRenderState(status: NormalizedStatus, phaseId: string): "complete" | "current" | "pending" | "running" {
	const phaseStatus = status.phases[phaseId]?.status;
	if (phaseStatus === "complete") return "complete";
	if (phaseStatus === "running") return "running";
	if (status.current_phase === phaseId) return "current";
	return "pending";
}

function displayCurrentPhase(status: NormalizedStatus): string {
	return status.current_phase === "complete" ? "Pipeline complete" : status.current_phase || "—";
}

function completedPhaseCount(status: NormalizedStatus): number {
	return Object.values(status.phases).filter((p) => p.status === "complete").length;
}

function countOpenQuestions(status: NormalizedStatus): number {
	return Object.values(status.phases).reduce((sum, p) => sum + (p.open_questions?.length ?? 0), 0);
}

function countCarryForward(status: NormalizedStatus): number {
	return Object.values(status.phases).reduce((sum, p) => sum + (p.carry_forward?.length ?? 0), 0);
}

function usageHasTokenAccounting(usage: UsageFile): boolean {
	return usage.runs.some((run) => (run.tokens?.input ?? 0) > 0 || (run.tokens?.output ?? 0) > 0 || (run.tokens?.cache_write ?? 0) > 0);
}

function formatTokensForDashboard(usage: UsageFile): string {
	const totals = computeTotals(usage);
	if (usage.runs.length > 0 && !usageHasTokenAccounting(usage)) return "unavailable";
	return formatTokenCount(totals.tokens.input + totals.tokens.output);
}

function formatRunTokens(run: UsageRun): string {
	const total = (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0);
	const hasAccounting = total > 0 || (run.tokens?.cache_write ?? 0) > 0;
	return hasAccounting ? formatTokenCount(total) : "unavailable";
}

function lastRunPerPhase(runs: UsageRun[]): Map<string, UsageRun> {
	const out = new Map<string, UsageRun>();
	for (const r of runs) {
		const existing = out.get(r.phase);
		if (!existing || existing.timestamp < r.timestamp) out.set(r.phase, r);
	}
	return out;
}

function getPhase(pipeline: PipelineFile, phaseId: string): PipelinePhase | undefined {
	return pipeline.phases.find((p) => p.id === phaseId);
}

function closeoutForPhase(closeouts: DashboardCloseoutEntry[], phaseId: string): DashboardCloseoutEntry | undefined {
	return [...closeouts].filter((c) => c.phaseOrModule === phaseId).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
}

function phaseAnchor(phaseId: string): string {
	return `phase-${phaseId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function renderSafeLink(path: string, label: string, className?: string): string | undefined {
	const href = safeRelativeHref(path);
	if (!href) return undefined;
	const classAttr = className ? ` class="${escapeAttr(className)}"` : "";
	return `<a${classAttr} href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
}

function safeRelativeHref(path: string): string | undefined {
	if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return undefined;
	const parts = path.split("/");
	if (parts.some((seg) => !seg || seg === "." || seg === "..")) return undefined;
	return parts.map((seg) => encodeURIComponent(seg)).join("/");
}

function escapeJsonForScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/&/g, "\\u0026")
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

export function escapeHtml(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
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
  --sidebar-width: 300px; --s-1: 4px; --s-2: 8px; --s-3: 16px; --s-4: 24px; --s-5: 40px;
  --fg: #1f2328; --fg-dim: #667085; --bg: #f6f4ee; --bg-card: #fffdf7; --bg-soft: #ece7da;
  --border: #ddd5c4; --accent: #b8432f; --accent-2: #2c5862; --accent-3: #63a77d;
  --status-pending: #8a8f98; --status-current: #2c5862; --status-running: #b7791f; --status-complete: #2f855a; --status-error: #c53030;
  --code-bg: #eee8da; --shadow: 0 14px 45px rgba(22, 18, 12, 0.10);
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #f3ead7; --fg-dim: #a79f90; --bg: #101211; --bg-card: #181b19; --bg-soft: #20251f;
    --border: #30362f; --accent: #f1a84f; --accent-2: #71c4cf; --accent-3: #63e6a4;
    --status-pending: #7d8790; --status-current: #71c4cf; --status-running: #f1a84f; --status-complete: #63e6a4; --status-error: #ff7768;
    --code-bg: #242820; --shadow: 0 14px 45px rgba(0, 0, 0, 0.28);
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: radial-gradient(circle at top left, color-mix(in srgb, var(--accent-2) 15%, transparent), transparent 32rem), var(--bg); color: var(--fg); font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
a { color: var(--accent-2); text-decoration: none; }
a:hover { color: var(--accent); text-decoration: underline; }
code { background: var(--code-bg); padding: 2px 5px; border-radius: 5px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
[hidden] { display: none !important; }
.cc-dashboard { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: 100vh; }
.cc-sidebar { position: sticky; top: 0; height: 100vh; overflow: auto; padding: var(--s-3); border-right: 1px solid var(--border); background: color-mix(in srgb, var(--bg-card) 92%, transparent); backdrop-filter: blur(12px); }
.cc-main { max-width: 1180px; width: 100%; padding: var(--s-4); }
.cc-brand { display: flex; gap: var(--s-2); align-items: center; margin-bottom: var(--s-3); }
.cc-brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; font-weight: 800; }
.cc-brand div { display: grid; line-height: 1.2; } .cc-brand span:last-child { color: var(--fg-dim); font-size: 12px; }
.cc-search-label { display: block; color: var(--fg-dim); font-size: 12px; margin-bottom: var(--s-1); }
.cc-search { width: 100%; padding: 10px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--fg); }
.cc-filter-row { display: flex; flex-wrap: wrap; gap: var(--s-1); margin: var(--s-2) 0 var(--s-3); }
.cc-filter, .cc-export { border: 1px solid var(--border); background: var(--bg-soft); color: var(--fg); border-radius: 999px; padding: 6px 9px; cursor: pointer; font: inherit; font-size: 12px; }
.cc-filter.is-active, .cc-export:hover { border-color: var(--accent); color: var(--accent); }
.cc-export { width: 100%; border-radius: 10px; margin-top: var(--s-3); }
.cc-nav { display: grid; gap: 3px; }
.cc-nav-link, .cc-nav-section { display: flex; justify-content: space-between; gap: var(--s-2); padding: 7px 8px; border-radius: 8px; color: var(--fg); }
.cc-nav-link:hover, .cc-nav-section:hover { background: var(--bg-soft); text-decoration: none; }
.cc-nav-link b { color: var(--fg-dim); font-size: 11px; text-transform: uppercase; }
.cc-nav-section { color: var(--fg-dim); font-weight: 700; margin-top: var(--s-2); }
.cc-sidebar-foot { color: var(--fg-dim); font-size: 12px; }
.cc-menu-button { display: none; position: fixed; top: 12px; right: 12px; z-index: 20; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; background: var(--bg-card); color: var(--fg); }
.cc-header, .cc-card, .cc-phase-card, .cc-warning { background: var(--bg-card); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow); }
.cc-header { padding: var(--s-4); margin-bottom: var(--s-4); }
.cc-eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .14em; font-size: 12px; font-weight: 800; }
h1 { font-size: clamp(30px, 5vw, 56px); line-height: 1; margin: var(--s-2) 0; }
h2 { margin: 0; font-size: 18px; } h3 { margin: var(--s-2) 0 var(--s-1); color: var(--fg-dim); text-transform: uppercase; letter-spacing: .06em; font-size: 12px; }
.cc-goal { max-width: 70ch; color: var(--fg-dim); font-size: 16px; }
.cc-stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-2); margin-top: var(--s-3); }
.cc-stat { padding: var(--s-2); border: 1px solid var(--border); border-radius: 12px; background: var(--bg); }
.cc-stat span { display: block; color: var(--fg-dim); font-size: 12px; } .cc-stat strong { display: block; font-size: 18px; }
.cc-meta-details { margin-top: var(--s-3); } .cc-header-meta, .cc-run-meta, .cc-usage-totals { display: grid; grid-template-columns: max-content 1fr; gap: var(--s-1) var(--s-3); margin: var(--s-2) 0; } dt { color: var(--fg-dim); } dd { margin: 0; }
.cc-card, .cc-warning { padding: var(--s-3); margin-bottom: var(--s-4); }
.cc-warning { border-color: var(--status-running); background: color-mix(in srgb, var(--status-running) 9%, var(--bg-card)); }
.cc-health { border-width: 1px; position: relative; overflow: hidden; }
.cc-health::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 4px; background: var(--accent-2); }
.cc-health-bad::before { background: var(--status-error); } .cc-health-warn::before { background: var(--status-running); } .cc-health-ok::before { background: var(--status-complete); }
.cc-health-hero { display: flex; justify-content: space-between; align-items: center; gap: var(--s-3); margin-bottom: var(--s-3); }
.cc-health-hero h2 { font-size: clamp(24px, 3vw, 38px); text-transform: capitalize; margin: 2px 0; }
.cc-health-hero p { color: var(--fg-dim); margin: 0; }
.cc-health-ring { width: 112px; height: 112px; border-radius: 999px; display: grid; place-items: center; align-content: center; background: radial-gradient(circle at center, var(--bg-card) 58%, transparent 59%), conic-gradient(var(--accent-3), var(--accent-2)); border: 1px solid var(--border); flex: 0 0 auto; }
.cc-health-ring strong { font-size: 24px; line-height: 1; } .cc-health-ring span { color: var(--fg-dim); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.cc-health-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--s-2); margin-bottom: var(--s-3); }
.cc-health-metric { padding: var(--s-2); border: 1px solid var(--border); border-radius: 14px; background: var(--bg); min-width: 0; }
.cc-health-metric span { display: block; color: var(--fg-dim); font-size: 12px; } .cc-health-metric strong { display: block; margin-top: 2px; font-size: 18px; overflow-wrap: anywhere; }
.cc-tone-ok strong { color: var(--status-complete); } .cc-tone-warn strong { color: var(--status-running); } .cc-tone-bad strong { color: var(--status-error); }
.cc-health-issues { display: grid; gap: var(--s-2); }
.cc-health-issue { padding: var(--s-2); border: 1px solid var(--border); border-radius: 14px; background: var(--bg); }
.cc-health-issue div { display: flex; flex-wrap: wrap; gap: var(--s-1); align-items: center; margin-bottom: 2px; }
.cc-health-issue strong { display: block; font-size: 15px; } .cc-health-issue p { color: var(--fg-dim); margin: 2px 0 0; }
.cc-issue-blocker { border-color: color-mix(in srgb, var(--status-error) 55%, var(--border)); background: color-mix(in srgb, var(--status-error) 8%, var(--bg-card)); }
.cc-health-ok { color: var(--status-complete); margin: 0; }
.cc-section-head { display: flex; justify-content: space-between; gap: var(--s-2); align-items: baseline; padding-bottom: var(--s-2); margin-bottom: var(--s-2); border-bottom: 1px solid var(--border); }
.cc-section-head span, .cc-muted, .cc-empty { color: var(--fg-dim); }
.cc-narration pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; font-family: inherit; }
.cc-artifact-list, .cc-closeouts-list { display: grid; gap: var(--s-2); }
.cc-artifact-row, .cc-closeout-row { display: grid; grid-template-columns: minmax(170px, .8fr) minmax(0, 1.5fr) minmax(180px, .8fr); gap: var(--s-2); align-items: start; padding: var(--s-2); border: 1px solid var(--border); border-radius: 12px; background: var(--bg); }
.cc-artifact-row > div:first-child, .cc-closeout-row > div:first-child { display: grid; gap: 2px; }
.cc-closeout-row code { display: block; margin-top: 3px; width: fit-content; }
.cc-closeout-summary { color: var(--fg-dim); margin: var(--s-1) 0 0; }
.cc-closeout-results { display: flex; flex-wrap: wrap; gap: var(--s-1); }
.cc-progress-list { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: var(--s-2); }
.cc-progress-item a { display: grid; gap: 2px; padding: var(--s-2); border: 1px solid var(--border); border-radius: 12px; background: var(--bg-card); color: var(--fg); }
.cc-progress-item a:hover { text-decoration: none; border-color: var(--accent); }
.cc-progress-id, .cc-phase-id { font-weight: 800; } .cc-progress-badge, .cc-phase-badge { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: var(--fg-dim); }
.cc-state-complete .cc-progress-badge, .cc-state-complete .cc-phase-badge { color: var(--status-complete); } .cc-state-current .cc-progress-badge, .cc-state-current .cc-phase-badge { color: var(--status-current); } .cc-state-running .cc-progress-badge, .cc-state-running .cc-phase-badge { color: var(--status-running); } .cc-state-pending .cc-progress-badge, .cc-state-pending .cc-phase-badge { color: var(--status-pending); }
.cc-phase-card { margin-bottom: var(--s-2); scroll-margin-top: var(--s-3); overflow: hidden; }
.cc-phase-card summary { padding: var(--s-3); cursor: pointer; display: flex; justify-content: space-between; gap: var(--s-3); align-items: baseline; }
.cc-phase-card[open] summary { border-bottom: 1px solid var(--border); }
.cc-phase-purpose { padding: var(--s-2) var(--s-3) 0; color: var(--fg-dim); }
.cc-phase-section { padding: var(--s-2) var(--s-3); }
.cc-phase-section ul { margin: 0; padding-left: var(--s-3); }
.cc-phase-overview { display: grid; gap: var(--s-1); color: var(--fg-dim); }
.cc-output-list li, .cc-question-list li, .cc-carry-list li, .cc-notes-list li { margin: var(--s-1) 0; }
.cc-question-reason { color: var(--fg-dim); font-size: 13px; margin-left: var(--s-2); }
.cc-pill { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; background: var(--code-bg); color: var(--fg-dim); border: 1px solid var(--border); margin: 0 3px 3px 0; }
.cc-pill-ok { background: color-mix(in srgb, var(--status-complete) 14%, transparent); color: var(--status-complete); border-color: var(--status-complete); } .cc-pill-bad { background: color-mix(in srgb, var(--status-error) 14%, transparent); color: var(--status-error); border-color: var(--status-error); } .cc-pill-target { color: var(--accent-2); border-color: var(--accent-2); } .cc-pill-muted, .cc-missing-path { color: var(--fg-dim); }
.cc-phase-jump { font-weight: 800; }
.cc-usage-table, .cc-timeline-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cc-usage-table th, .cc-usage-table td, .cc-timeline-table th, .cc-timeline-table td { padding: var(--s-1) var(--s-2); text-align: left; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.cc-usage-table th, .cc-timeline-table th { color: var(--fg-dim); font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
.cc-usage-missing td:last-child { color: var(--status-running); }
.cc-usage-insights { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-2); margin: var(--s-3) 0; }
.cc-insight { padding: var(--s-2); border: 1px solid var(--border); border-radius: 12px; background: var(--bg); display: grid; gap: 2px; }
.cc-insight span { color: var(--fg-dim); font-size: 12px; } .cc-insight a { font-weight: 800; } .cc-insight strong { font-size: 15px; }
.cc-bar-cell { min-width: 120px; display: grid; grid-template-columns: minmax(42px, 1fr) auto; align-items: center; gap: var(--s-2); }
.cc-bar-cell > span:last-child { min-width: 48px; text-align: right; }
.cc-bar { height: 8px; border-radius: 999px; background: linear-gradient(90deg, var(--accent-2) var(--cc-bar), var(--bg-soft) var(--cc-bar)); border: 1px solid var(--border); }
.cc-kind-summary { display: flex; flex-wrap: wrap; gap: var(--s-1); margin: var(--s-2) 0 var(--s-3); }
.cc-kind-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--fg-dim); font-size: 12px; }
.cc-kind-chip strong { color: var(--fg); }
.cc-timeline-older { margin-top: var(--s-2); }
.cc-footer { margin-top: var(--s-5); padding-top: var(--s-3); border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 13px; }
@media (max-width: 900px) {
  .cc-dashboard { display: block; }
  .cc-sidebar { position: fixed; inset: 0 auto 0 0; width: min(86vw, 340px); transform: translateX(-105%); transition: transform .18s ease; z-index: 10; }
  body.cc-sidebar-open .cc-sidebar { transform: translateX(0); }
  .cc-menu-button { display: block; }
  .cc-main { padding: var(--s-3); padding-top: var(--s-5); }
  .cc-stat-grid, .cc-artifact-row, .cc-closeout-row, .cc-health-grid, .cc-usage-insights { grid-template-columns: 1fr; }
  .cc-health-hero { align-items: flex-start; } .cc-health-ring { width: 88px; height: 88px; }
  .cc-header-meta, .cc-run-meta, .cc-usage-totals { grid-template-columns: 1fr; }
  table { display: block; overflow-x: auto; white-space: nowrap; }
}
@media print {
  body { background: #fff; color: #111; }
  .cc-sidebar, .cc-menu-button, script { display: none !important; }
  .cc-dashboard { display: block; } .cc-main { max-width: none; padding: 0; } .cc-card, .cc-header, .cc-phase-card { box-shadow: none; break-inside: avoid; }
}
</style>`;
}
