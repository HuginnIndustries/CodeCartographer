import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { recomputeCursor, resolvePhase, validatePhaseOutput } from "./pipeline.ts";
import { applyHandoff, autoAssignIds, loadHandoffFile, normalizeStatus } from "./status.ts";
import type { NormalizedStatus, OpenQuestionEntry, PhaseHandoff, ProposedConventionEntry, ValidationResult, WorkspaceState } from "./types.ts";
import { compareDottedVersions, dateOnly, newlineIfUnterminated, pathExists, uniqueStrings } from "./utils.ts";
import { getWorkspaceState, updateStatusAtomically } from "./workspace.ts";

export type CompletionResult = {
	updatedState: WorkspaceState;
	closeoutNotice?: string;
	/**
	 * Non-gating closure-integrity observations (#122): closures the handoff
	 * claims that the primary output never mentions. Empty when clean.
	 */
	warnings: string[];
	/**
	 * One-line phase-boundary reminder covering what completion just mechanized
	 * (decisions appended, proposals staged) and what still needs orchestrator
	 * judgment (pending proposals, open-question label re-triage). Undefined
	 * when there is nothing to surface.
	 */
	orchestratorCheckpoint?: string;
};

/**
 * The Markdown a reader sees: content inside `<!-- -->` blocks removed by a
 * line scanner. This is read-only scan input for numbering and dedupe — never
 * written back or rendered — so it is deliberately not an HTML sanitizer; an
 * unterminated comment drops the remainder of the file from the scan.
 */
function visibleMarkdown(content: string): string {
	const out: string[] = [];
	let inComment = false;
	for (const line of content.split(/\r?\n/)) {
		let rest = line;
		let visible = "";
		while (rest.length > 0) {
			if (inComment) {
				const end = rest.indexOf("-->");
				if (end === -1) {
					rest = "";
					break;
				}
				rest = rest.slice(end + 3);
				inComment = false;
			} else {
				const start = rest.indexOf("<!--");
				if (start === -1) {
					visible += rest;
					rest = "";
					break;
				}
				visible += rest.slice(0, start);
				rest = rest.slice(start + 4);
				inComment = true;
			}
		}
		out.push(visible);
	}
	return out.join("\n");
}

/** Section heading completion appends mechanized decision rows under. */
export const DECISIONS_COMPLETION_LOG_HEADING = "## Completion log";

/** Section heading completion stages proposed conventions under. */
export const CONVENTIONS_PENDING_HEADING = "## Pending proposals";

/**
 * True when `heading` exists as its own visible line. Both orchestrator-file
 * templates mention their headings in running prose (issue #111: a raw
 * substring check saw the decisions-template's "…rows under `## Completion
 * log`…" sentence and never inserted the real heading), so presence checks
 * must match a whole trimmed line of comment-stripped content.
 */
function hasVisibleHeadingLine(content: string, heading: string): boolean {
	return visibleMarkdown(content)
		.split(/\r?\n/)
		.some((line) => line.trim() === heading);
}

/**
 * Ensure an orchestrator file exists: prefer the workspace's template, fall
 * back to a minimal header for scaffolds that predate the template.
 * @returns the file's current content.
 */
async function ensureOrchestratorFile(
	workspaceDir: string,
	fileName: string,
	templateName: string,
	fallbackHeader: string,
): Promise<string> {
	const filePath = join(workspaceDir, fileName);
	if (!(await pathExists(filePath))) {
		const templatePath = join(workspaceDir, "templates", templateName);
		if (await pathExists(templatePath)) {
			await copyFile(templatePath, filePath);
		} else {
			await writeFile(filePath, fallbackHeader, "utf8");
		}
	}
	return readFile(filePath, "utf8");
}

/**
 * Append handoff `decisions` to DECISIONS.md as `D<NNN> | ...` rows under
 * {@link DECISIONS_COMPLETION_LOG_HEADING}. Numbering continues from the
 * highest `D<NNN>` anywhere in the file, so orchestrator-curated category
 * entries and the completion log share one namespace. A decision whose text
 * already appears in the file is skipped, so re-running completion cannot
 * duplicate rows.
 * @returns how many rows were appended.
 */
async function appendDecisionLog(
	workspaceDir: string,
	phaseId: string,
	closeoutFile: string,
	decisions: string[],
): Promise<number> {
	if (decisions.length === 0) return 0;
	let content = await ensureOrchestratorFile(
		workspaceDir,
		"DECISIONS.md",
		"decisions-template.md",
		"# Decisions\n\nAppend-only log of cross-cutting decisions. This scaffold predates templates/decisions-template.md; refresh the framework-owned files for the full format.\n",
	);
	// The template ships worked examples inside HTML comments (a commented
	// `D001 | ...` row); numbering and dedupe must read only visible content or
	// a fresh file starts at D002 and a decision matching example text is lost.
	const visible = visibleMarkdown(content);
	const fresh = decisions.filter((decision) => decision.trim() && !visible.includes(decision.trim()));
	if (fresh.length === 0) return 0;

	let nextNumber = 1;
	for (const match of visible.matchAll(/^D(\d+)\s*\|/gm)) {
		const parsed = Number.parseInt(match[1], 10);
		if (Number.isFinite(parsed) && parsed >= nextNumber) nextNumber = parsed + 1;
	}

	if (!hasVisibleHeadingLine(content, DECISIONS_COMPLETION_LOG_HEADING)) {
		content += `${content.endsWith("\n") ? "" : "\n"}\n${DECISIONS_COMPLETION_LOG_HEADING}\n\nAppended by completion from each phase handoff's \`decisions\` array. The orchestrator may re-file entries into the category sections above; numbering is shared with them.\n`;
	}
	const source = closeoutFile.replace(/\.md$/, "");
	const rows = fresh.map((decision, index) => {
		const number = String(nextNumber + index).padStart(3, "0");
		return `D${number} | ${decision.trim()} | ${source} | closeouts/${closeoutFile} §Decisions Beyond Prompt (${phaseId})`;
	});
	// A row appended straight after the section's explanatory paragraph is
	// rendered as part of that paragraph by most Markdown renderers; a blank
	// line makes the rows their own block (self-audit F4). Rows already
	// present stay contiguous with the new ones.
	const trailing = content.replace(/\n+$/, "").split("\n").pop() ?? "";
	const separator = /^D\d+\s*\|/.test(trailing) || trailing.trim() === "" ? "" : "\n";
	content += `${content.endsWith("\n") ? "" : "\n"}${separator}${rows.join("\n")}\n`;
	await writeFile(join(workspaceDir, "DECISIONS.md"), content, "utf8");
	return fresh.length;
}

/**
 * Count staged proposals in CONVENTIONS.md's pending section.
 * @param content - the file content, or null to read from disk (null when the file is absent).
 */
export async function countPendingProposals(workspaceDir: string, content?: string): Promise<number> {
	let text = content;
	if (text === undefined) {
		const filePath = join(workspaceDir, "CONVENTIONS.md");
		if (!(await pathExists(filePath))) return 0;
		text = await readFile(filePath, "utf8");
	}
	// Same line-anchored rule as the heading-insertion checks: a prose mention
	// of the heading must not open the section early and miscount.
	const lines = visibleMarkdown(text).split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => line.trim() === CONVENTIONS_PENDING_HEADING);
	if (headingIndex === -1) return 0;
	let count = 0;
	for (const line of lines.slice(headingIndex + 1)) {
		if (line.startsWith("## ")) break;
		if (line.startsWith("- **")) count += 1;
	}
	return count;
}

/**
 * Stage handoff `proposed_conventions` in CONVENTIONS.md under
 * {@link CONVENTIONS_PENDING_HEADING}. Staging is mechanical; promotion into
 * the numbered convention sections stays an orchestrator judgment at the
 * phase boundary. A proposal whose name and rule both already appear in the
 * file is skipped, so re-running completion cannot duplicate entries.
 * @returns staged count and the section's total pending count afterward.
 */
async function stageProposedConventions(
	workspaceDir: string,
	phaseId: string,
	timestamp: string,
	proposals: ProposedConventionEntry[],
): Promise<{ staged: number; totalPending: number }> {
	if (proposals.length === 0) {
		return { staged: 0, totalPending: await countPendingProposals(workspaceDir) };
	}
	let content = await ensureOrchestratorFile(
		workspaceDir,
		"CONVENTIONS.md",
		"conventions-template.md",
		"# Conventions\n\nCross-cutting patterns promoted to project-wide invariants. This scaffold predates templates/conventions-template.md; refresh the framework-owned files for the full format.\n",
	);
	if (!hasVisibleHeadingLine(content, CONVENTIONS_PENDING_HEADING)) {
		content += `${content.endsWith("\n") ? "" : "\n"}\n${CONVENTIONS_PENDING_HEADING}\n\nStaged by completion from each phase handoff's \`proposed_conventions\`. The orchestrator promotes an entry into a numbered convention above (or removes it with a note) at the phase boundary — see GUIDE.md §Roles.\n`;
	}
	// Same visible-content rule as the decision log: template comments must not
	// swallow a genuine proposal through the dedupe check.
	const visible = visibleMarkdown(content);
	const fresh = proposals.filter((proposal) => !(visible.includes(`**${proposal.name}**`) && visible.includes(proposal.rule)));
	if (fresh.length > 0) {
		const bullets = fresh.map((proposal) => {
			const evidence = proposal.evidence ? `\n  - Evidence: ${proposal.evidence}` : "";
			return `- **${proposal.name}** (${phaseId}, ${dateOnly(timestamp)}) — ${proposal.rule}${evidence}`;
		});
		content += `${content.endsWith("\n") ? "" : "\n"}${bullets.join("\n")}\n`;
		await writeFile(join(workspaceDir, "CONVENTIONS.md"), content, "utf8");
	}
	return { staged: fresh.length, totalPending: await countPendingProposals(workspaceDir, content) };
}

/** Build the phase-boundary checkpoint line, or undefined when nothing needs surfacing. */
function buildOrchestratorCheckpoint(
	decisionsAppended: number,
	totalPendingProposals: number,
	status: NormalizedStatus,
): string | undefined {
	const openQuestions = Object.values(status.phases).reduce((sum, phase) => sum + (phase.open_questions?.length ?? 0), 0);
	const parts: string[] = [];
	if (decisionsAppended > 0) parts.push(`${decisionsAppended} decision(s) appended to DECISIONS.md`);
	if (totalPendingProposals > 0) parts.push(`${totalPendingProposals} proposal(s) pending in CONVENTIONS.md — promote or remove them before the next phase`);
	if (openQuestions > 0) parts.push(`${openQuestions} open question(s) outstanding — re-triage their kind labels before the next phase (GUIDE.md §Roles)`);
	if (parts.length === 0) return undefined;
	return `Orchestrator checkpoint: ${parts.join("; ")}.`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function canonicalCloseoutFile(workspaceDir: string, phaseId: string, timestamp: string): Promise<string> {
	const closeoutsDir = join(workspaceDir, "closeouts");
	await mkdir(closeoutsDir, { recursive: true });
	const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(phaseId)}\\.md$`);
	const existing = (await readdir(closeoutsDir)).filter((name) => pattern.test(name)).sort();
	return existing.at(-1) ?? `${dateOnly(timestamp)}-${phaseId}.md`;
}

async function writeCompletionArtifacts(
	workspaceDir: string,
	phaseId: string,
	validation: ValidationResult,
	timestamp: string,
	handoff: PhaseHandoff | null,
): Promise<{ closeoutPath: string; decisionsAppended: number; totalPendingProposals: number }> {
	const closeoutFile = await canonicalCloseoutFile(workspaceDir, phaseId, timestamp);
	const closeoutPath = join(workspaceDir, "closeouts", closeoutFile);
	const suppliedContent = handoff?.closeout_content?.trim();
	if (suppliedContent) {
		const decisions = handoff?.decisions ?? [];
		const decisionsSection = decisions.length > 0
			? `\n\n## Decisions Beyond Prompt\n\n${decisions.map((decision) => `- ${decision}`).join("\n")}`
			: "";
		await writeFile(closeoutPath, `${suppliedContent}${decisionsSection}\n`, "utf8");
	} else if (!(await pathExists(closeoutPath))) {
		const templatePath = join(workspaceDir, "templates", "closeout-template.md");
		if (await pathExists(templatePath)) await copyFile(templatePath, closeoutPath);
	}

	const summary = handoff?.closeout_summary?.trim() || `Validation: ${validation.overall}`;
	const entry = `- ${dateOnly(timestamp)} — ${phaseId} — ${summary} — [closeout](closeouts/${closeoutFile})`;
	const threadLogPath = join(workspaceDir, "THREAD_LOG.md");
	let current = "";
	try {
		current = await readFile(threadLogPath, "utf8");
	} catch {
		// Created below when absent.
	}
	const link = `[closeout](closeouts/${closeoutFile})`;
	if (!current.split(/\r?\n/).some((line) => line.includes(link))) {
		await appendFile(threadLogPath, `${newlineIfUnterminated(current)}${entry}\n`, "utf8");
	}

	// Mechanize the orchestrator loop's bookkeeping half (issue #98): decisions
	// reach DECISIONS.md and proposals reach CONVENTIONS.md at completion, so a
	// run without a promotion ritual cannot strand them in closeout prose.
	// Promotion of pending proposals into numbered conventions stays judged.
	const decisionsAppended = await appendDecisionLog(workspaceDir, phaseId, closeoutFile, handoff?.decisions ?? []);
	const { totalPending: totalPendingProposals } = await stageProposedConventions(
		workspaceDir,
		phaseId,
		timestamp,
		handoff?.proposed_conventions ?? [],
	);
	return { closeoutPath: `.codecarto/closeouts/${closeoutFile}`, decisionsAppended, totalPendingProposals };
}

/**
 * First scaffold version whose handoff template documents the `{id, evidence}`
 * closure shape and the runtime-evidence rule (#122, #186).
 *
 * A workspace scaffolded before it was never told that closing a
 * `needs-runtime-test` question requires evidence, so refusing its completion
 * would apply a rule its own templates do not carry — and could stop an
 * in-flight `--auto` run on a handoff written against the older contract.
 * Those workspaces get a warning instead; refreshing the scaffold
 * (`codecarto_refresh_scaffold` on MCP, `/codecarto-refresh-scaffold` on Pi)
 * opts them in. Same treatment Stage 2's findings pairing check uses.
 */
export const CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION = "0.19.0";

/** Whether the runtime-evidence requirement refuses (current scaffold) or warns (older). */
export function closureEvidenceGateActive(scaffoldVersion: string | undefined | null): boolean {
	if (!scaffoldVersion) return false;
	const comparison = compareDottedVersions(scaffoldVersion, CLOSURE_EVIDENCE_GATE_SCAFFOLD_VERSION);
	return comparison !== null && comparison >= 0;
}

/**
 * Whether `text` names one of `ids` as a whole token: the id must not run
 * straight into another id character on either side, so `arch-CF2` matches
 * "routed as `arch-CF2`" and not "arch-CF20".
 */
function mentionsAnyId(text: string, ids: Iterable<string>): boolean {
	for (const id of ids) {
		let from = 0;
		while (true) {
			const at = text.indexOf(id, from);
			if (at === -1) break;
			const before = at === 0 ? "" : text[at - 1];
			const after = text[at + id.length] ?? "";
			if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return true;
			from = at + 1;
		}
	}
	return false;
}

/**
 * Turn each PARTIAL validation row into a `needs-maintainer-decision`
 * question on the phase, unless the row's criterion or evidence cell names an
 * entry the workspace already tracks: an open question, carry-forward, or
 * post-pipeline item, from this handoff or an earlier phase. VALIDATE.md asks
 * the phase to name the tracking entry in the evidence cell; honouring it is
 * what stops a routed gap from also becoming a duplicate question that every
 * later phase re-triages and someone must close (#239).
 *
 * Runs after the handoff has been applied. That is also what keeps the auto
 * ids distinct from the handoff's: both `autoAssignIds` from `oq-<phase>-1`,
 * and assigning the gaps first let a later id-less handoff question replace a
 * gap under the same id.
 */
function addPartialRowQuestions(status: NormalizedStatus, phaseId: string, rows: ValidationResult["rows"]): void {
	const phase = status.phases[phaseId];
	if (!phase) return;
	const trackedIds = new Set<string>();
	for (const phaseState of Object.values(status.phases)) {
		for (const entry of [...(phaseState.open_questions ?? []), ...(phaseState.carry_forward ?? [])]) {
			if (entry.id) trackedIds.add(entry.id);
		}
	}
	for (const entry of status.post_pipeline) {
		if (entry.id) trackedIds.add(entry.id);
	}
	const gapEntries: OpenQuestionEntry[] = [];
	for (const row of rows) {
		if (!row.result.toUpperCase().includes("PARTIAL")) continue;
		if (mentionsAnyId(`${row.criterion} ${row.evidence}`, trackedIds)) continue;
		const candidate: OpenQuestionEntry = {
			kind: "needs-maintainer-decision",
			description: row.criterion || "Partial validation gap",
			deferred_reason: row.evidence || "Marked PARTIAL by validation",
		};
		// Idempotent across re-runs of completion: the same gap is one question.
		if (phase.open_questions.some((entry) => entry.description === candidate.description && entry.deferred_reason === candidate.deferred_reason)) continue;
		gapEntries.push(candidate);
	}
	if (gapEntries.length === 0) return;
	// Reserve every id already on the phase so the new ones skip them; the
	// placeholders keep autoAssignIds from touching the existing entries.
	const reserved = phase.open_questions.filter((entry) => entry.id).map((entry) => ({ id: entry.id }));
	autoAssignIds([...reserved, ...gapEntries], "oq", phaseId);
	phase.open_questions.push(...gapEntries);
}

export async function completeValidatedPhase(
	cwd: string,
	validation: ValidationResult,
	sourceLabel: string,
): Promise<CompletionResult> {
	const initialState = await getWorkspaceState(cwd);
	if (!initialState) throw new Error("CodeCartographer workspace not found. Run /codecarto-init first.");
	const handoff = await loadHandoffFile(validation.phaseId, initialState.workspaceDir);
	if (handoff && handoff.phase_id !== validation.phaseId) {
		throw new Error(`Invalid handoff: phase_id ${handoff.phase_id} does not match ${validation.phaseId}`);
	}
	// A phase that declares handoff_requirements must not complete without its
	// handoff: silently proceeding writes empty carry_forward/open_questions and
	// severs the cross-phase routing channel (issue #84). Phases without the
	// declaration keep the lenient path for custom pipelines.
	if (!handoff) {
		const declaringPhase = resolvePhase(initialState, validation.phaseId);
		if (declaringPhase?.handoff_requirements?.length) {
			throw new Error(
				`Phase ${validation.phaseId} declares handoff_requirements, but no phase handoff exists at .codecarto/scratch/handoffs/${validation.phaseId}.yaml. `
				+ `Write the handoff first (see GUIDE.md and templates/phase-handoff.yaml): schema_version: 1, the exact phase_id, `
				+ `arrays for owner_notes, open_questions, carry_forward, carry_forward_closures, open_question_closures, post_pipeline, decisions, and proposed_conventions (omitted arrays default to empty), `
				+ `plus closeout_summary and optional closeout_content. Then re-run completion.`,
			);
		}
	}
	const warnings: string[] = [];
	if (handoff) {
		const activePhases = new Set(initialState.pipeline.phase_order);
		const sourceIndex = initialState.pipeline.phase_order.indexOf(validation.phaseId);
		for (const entry of handoff.carry_forward) {
			const targetIndex = entry.target_phase ? initialState.pipeline.phase_order.indexOf(entry.target_phase) : -1;
			if (!entry.target_phase || !activePhases.has(entry.target_phase) || targetIndex <= sourceIndex) {
				throw new Error(`Invalid handoff: carry_forward target_phase ${entry.target_phase ?? "(missing)"} is not a downstream active pipeline phase; use post_pipeline for work after the pipeline`);
			}
		}
		for (const entry of handoff.post_pipeline) {
			if (!entry.id?.trim()) throw new Error("Invalid handoff: post_pipeline entries require a canonical id");
		}

		// Closure integrity, gating (#122, #186). Both checks are deterministic
		// reads of ids the model wrote itself, so neither can wedge an --auto run
		// on a heuristic; both sit here, before the lock, alongside the
		// target_phase check, so a refusal mutates nothing.
		const questionsById = new Map<string, OpenQuestionEntry>();
		const derivesFromById = new Map<string, string>();
		for (const phaseState of Object.values(initialState.status.phases)) {
			for (const entry of phaseState.open_questions ?? []) {
				if (entry.id) questionsById.set(entry.id, entry);
			}
			for (const entry of phaseState.carry_forward ?? []) {
				if (entry.id && entry.derives_from) derivesFromById.set(entry.id, entry.derives_from);
			}
		}
		const closingQuestionIds = new Set(handoff.open_question_closures.map((closure) => closure.id).filter(Boolean));

		// D1: a routed item that declares `derives_from` is one candidate answer
		// to that question. Closing it while the question stands is exactly the
		// contradiction #122 reported — the routed candidate shipped as settled
		// while the question that said "source alone cannot determine which" was
		// still open. A derives_from naming an id that no longer exists is fine:
		// the question was already resolved.
		for (const closureId of handoff.carry_forward_closures) {
			const questionId = derivesFromById.get(closureId);
			if (!questionId || !questionsById.has(questionId)) continue;
			if (closingQuestionIds.has(questionId)) continue;
			throw new Error(
				`Refusing to complete ${validation.phaseId}: the handoff closes carry_forward ${closureId}, which derives_from open question ${questionId} — and ${questionId} is still unresolved and is not in this handoff's open_question_closures. `
				+ `A routed item is one candidate answer to the question it came from; closing it does not settle the question. `
				+ `Either close ${questionId} in this same handoff with the evidence that settles it, or leave ${closureId} routed and give the finding an unsettled action ("verify at runtime") instead.`,
			);
		}

		// D3: a `needs-runtime-test` question closes on runtime evidence, not on
		// another source read. Requiring the evidence string to be non-empty is
		// the whole gate — judging what it says stays prose guidance.
		//
		// Unlike D1, this one can fire on a handoff that uses none of the new
		// fields: a bare-string closure was the only shape before this release.
		// Gating it unconditionally would apply a rule to workspaces whose own
		// templates never state it, so it is version-gated exactly like Stage
		// 2's pairing check — refuse on a scaffold that documents the rule, warn
		// on one that predates it.
		const evidenceGateActive = closureEvidenceGateActive(initialState.scaffoldVersion);
		for (const closure of handoff.open_question_closures) {
			if (questionsById.get(closure.id)?.kind !== "needs-runtime-test") continue;
			if (closure.evidence?.trim()) continue;
			const detail =
				`open_question_closures closes ${closure.id}, whose kind is needs-runtime-test, without evidence. `
				+ `A runtime question closes on runtime evidence — a spike report or an observation against the running system — not on a source read. `
				+ `Write the closure as an object: { id: ${closure.id}, evidence: <where that evidence lives> }. If you do not have it, leave the question open.`;
			if (evidenceGateActive) throw new Error(`Refusing to complete ${validation.phaseId}: ${detail}`);
			warnings.push(
				`${detail} Warning only: this workspace's scaffold predates the requirement — refresh it `
				+ `(codecarto_refresh_scaffold on MCP, /codecarto-refresh-scaffold on Pi) to make this gating.`,
			);
		}
	}

	// Closure integrity (#122, warning only): a handoff can close a carry-forward
	// or open question the report never addressed — "closed in the handoff,
	// resolved nowhere." The id of every claimed closure should appear somewhere
	// in the primary output that claims to resolve it.
	if (handoff && validation.outputPath) {
		const closures = [...handoff.carry_forward_closures, ...handoff.open_question_closures.map((closure) => closure.id)].filter((id) => id?.trim());
		if (closures.length > 0) {
			const output = await readFile(validation.outputPath, "utf8").catch(() => "");
			const unmentioned = closures.filter((id) => !output.includes(id));
			if (unmentioned.length > 0) {
				warnings.push(
					`The handoff closes ${unmentioned.join(", ")} but .codecarto/${validation.primaryOutput} never mentions ${unmentioned.length === 1 ? "that id" : "those ids"} — a closure should be visible in the report that claims to resolve it, not only in the handoff.`,
				);
			}
		}
	}

	const completionTimestamp = new Date().toISOString();
	let closeoutPath: string | undefined;
	let orchestratorCheckpoint: string | undefined;
	const updatedState = await updateStatusAtomically(cwd, async (lockedState) => {
		const phase = resolvePhase(lockedState, validation.phaseId);
		if (!phase?.primary_output) throw new Error(`Phase ${validation.phaseId} is missing primary_output.`);

		// Re-validate the output under the lock (#132). The caller's
		// validation snapshot can predate a concurrent edit or another
		// session's completion; a stale PASS must not complete a phase whose
		// output no longer validates. The locked recheck is the authoritative
		// one and is what every artifact below is written from.
		// A validation that never touched a file on disk (no outputPath)
		// has nothing to race against, so the caller's result stands — the
		// real surfaces (MCP, Pi) always validate real files.
		const authoritative = validation.outputPath
			? await validatePhaseOutput(lockedState, validation.phaseId)
			: validation;
		if (authoritative.overall === "FAIL" || authoritative.overall === "MISSING") {
			throw new Error(
				`Refusing to complete ${validation.phaseId}: the output no longer validates under the status lock ` +
				`(now ${authoritative.overall}). It changed since the last validation — re-run validation and fix the output first.`,
			);
		}
		const lockedValidation = authoritative;

		const nextStatus = normalizeStatus(lockedState.status, lockedState.pipeline, lockedState.status.pipeline, lockedState.cwd);
		const existingPhase = nextStatus.phases[validation.phaseId] ?? {
			status: "pending",
			owner_notes: [],
			outputs_present: [],
			open_questions: [],
			carry_forward: [],
		};
		nextStatus.phases[validation.phaseId] = {
			status: "complete",
			owner_notes: uniqueStrings([
				...existingPhase.owner_notes,
				`Completed via ${sourceLabel}.`,
				`Primary output: .codecarto/${validation.primaryOutput}`,
				`Validation: ${lockedValidation.overall}`,
			]),
			outputs_present: uniqueStrings([...existingPhase.outputs_present, validation.primaryOutput]),
			open_questions: [...existingPhase.open_questions],
			carry_forward: existingPhase.carry_forward ?? [],
		};
		if (handoff) applyHandoff(nextStatus, handoff);
		// After the handoff, so a gap the handoff routed is recognised as
		// tracked and the ids the handoff introduced are known (#239).
		addPartialRowQuestions(nextStatus, validation.phaseId, lockedValidation.rows);
		nextStatus.last_updated = completionTimestamp;
		const nextWorkspace: WorkspaceState = { ...lockedState, status: nextStatus };
		recomputeCursor(nextWorkspace);

		return {
			state: { ...nextWorkspace, status: nextStatus },
			// The closeout, THREAD_LOG line, decision rows, and staged proposals
			// all assert that the phase is complete, so they are written only
			// after status.yaml has landed (#234). Each writer is idempotent
			// (canonical closeout name, link-deduped index line, text-deduped
			// rows), so re-running completion regenerates whatever a failure
			// here left out.
			afterCommit: async () => {
				const artifacts = await writeCompletionArtifacts(lockedState.workspaceDir, validation.phaseId, lockedValidation, completionTimestamp, handoff);
				closeoutPath = artifacts.closeoutPath;
				orchestratorCheckpoint = buildOrchestratorCheckpoint(artifacts.decisionsAppended, artifacts.totalPendingProposals, nextStatus);
			},
		};
	});

	return {
		updatedState,
		closeoutNotice: closeoutPath ? `Closeout: ${closeoutPath}` : undefined,
		orchestratorCheckpoint,
		warnings,
	};
}
