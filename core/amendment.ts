// Post-pipeline amendments (issue #99, formerly template BACKLOG item B2):
// apply evidence-based resolutions to workflow/status.yaml AFTER the pipeline
// is complete, under the same lock completion uses. During the pipeline the
// phase handoff is the only state channel (open_question_closures /
// carry_forward_closures); an amendment is the post-pipeline counterpart, so
// spec-delta sessions, spikes, and maintainer rulings no longer end with
// "record for a later explicit amendment" that nothing can perform.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getNextEligiblePhase } from "./pipeline.ts";
import { buildTerminalNextActions, ensureArray, normalizeStatus } from "./status.ts";
import type { WorkspaceState } from "./types.ts";
import { dateOnly, pathExists } from "./utils.ts";
import { getWorkspaceState, updateStatusAtomically } from "./workspace.ts";
import { loadYamlFile } from "./yaml.ts";

/** One parsed amendment file from scratch/amendments/<slug>.yaml. */
export type Amendment = {
	/** The file's basename without extension; names the closeout. */
	slug: string;
	/** Open-question ids to remove from every phase. */
	open_question_closures: string[];
	/** post_pipeline item ids to remove from the backlog (the closeout records the closure). */
	post_pipeline_closures: string[];
	/** Durable observations recorded in the amendment closeout. */
	notes: string[];
	closeout_summary: string;
	closeout_content: string;
	schema_version?: number;
};

/** What one amendment application changed, id by id. */
export type AmendmentApplication = {
	openQuestionsClosed: string[];
	postPipelineClosed: string[];
	/** Requested ids that matched nothing — already closed or never existed. Re-running an amendment is safe. */
	unknownIds: string[];
};

export type AmendmentResult = {
	updatedState: WorkspaceState;
	closeoutNotice: string;
	applied: AmendmentApplication;
};

/** Same charset rule as phase ids: the slug becomes file names, so path shapes are refused. */
export function assertSafeAmendmentSlug(slug: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
		throw new Error(`Invalid amendment name: ${slug}`);
	}
}

/**
 * Load and validate one amendment file.
 * @param name - the amendment slug, with or without a `.yaml` suffix.
 */
export async function loadAmendmentFile(name: string, workspaceDir: string): Promise<Amendment> {
	const slug = name.trim().replace(/\.ya?ml$/i, "");
	assertSafeAmendmentSlug(slug);
	const amendmentPath = join(workspaceDir, "scratch", "amendments", `${slug}.yaml`);
	if (!(await pathExists(amendmentPath))) {
		throw new Error(
			`No amendment at .codecarto/scratch/amendments/${slug}.yaml. `
			+ `Write it first (see templates/amendment.yaml): schema_version: 1, arrays for open_question_closures, post_pipeline_closures, and notes, plus closeout_summary and optional closeout_content.`,
		);
	}
	const raw = (await loadYamlFile<Record<string, unknown>>(amendmentPath)) ?? {};
	const schemaVersion = typeof raw.schema_version === "number" ? raw.schema_version : 1;
	if (schemaVersion > 1) {
		throw new Error(`Invalid amendment: unsupported schema_version ${schemaVersion}. Supported: 1.`);
	}
	for (const field of ["open_question_closures", "post_pipeline_closures", "notes"] as const) {
		if (raw[field] !== undefined && !Array.isArray(raw[field])) {
			throw new Error(`Invalid amendment: ${field} must be an array`);
		}
	}
	const amendment: Amendment = {
		slug,
		open_question_closures: ensureArray(raw.open_question_closures),
		post_pipeline_closures: ensureArray(raw.post_pipeline_closures),
		notes: ensureArray(raw.notes),
		closeout_summary: typeof raw.closeout_summary === "string" ? raw.closeout_summary : "",
		closeout_content: typeof raw.closeout_content === "string" ? raw.closeout_content : "",
		schema_version: schemaVersion,
	};
	if (amendment.open_question_closures.length === 0 && amendment.post_pipeline_closures.length === 0 && amendment.notes.length === 0) {
		throw new Error("Invalid amendment: nothing to apply (no closures and no notes)");
	}
	return amendment;
}

/** Render the generated closeout body when the amendment supplies none. */
function renderAmendmentCloseout(amendment: Amendment, applied: AmendmentApplication, timestamp: string): string {
	const lines = [`# Amendment — ${amendment.slug}`, "", `Applied ${dateOnly(timestamp)}.`, ""];
	if (applied.openQuestionsClosed.length > 0) {
		lines.push("## Open questions closed", "", ...applied.openQuestionsClosed.map((id) => `- ${id}`), "");
	}
	if (applied.postPipelineClosed.length > 0) {
		lines.push("## Post-pipeline items closed", "", ...applied.postPipelineClosed.map((id) => `- ${id}`), "");
	}
	if (applied.unknownIds.length > 0) {
		lines.push("## Ids that matched nothing (already closed or unknown)", "", ...applied.unknownIds.map((id) => `- ${id}`), "");
	}
	if (amendment.notes.length > 0) {
		lines.push("## Notes", "", ...amendment.notes.map((note) => `- ${note}`), "");
	}
	return lines.join("\n");
}

/**
 * Apply one amendment to canonical state under the completion lock. Refuses
 * while the pipeline is incomplete — mid-pipeline resolutions belong in the
 * phase handoff, and allowing both channels at once would race them.
 * Idempotent: ids that no longer match anything are reported, not fatal.
 */
export async function applyAmendment(cwd: string, name: string): Promise<AmendmentResult> {
	const initialState = await getWorkspaceState(cwd);
	if (!initialState) throw new Error("CodeCartographer workspace not found. Run /codecarto-init first.");
	const amendment = await loadAmendmentFile(name, initialState.workspaceDir);

	const nextPhase = getNextEligiblePhase(initialState);
	if (nextPhase) {
		throw new Error(
			`Cannot amend: the pipeline is not complete (next phase: ${nextPhase.id}). `
			+ `Resolve open questions and routed items through that phase's handoff (open_question_closures / carry_forward_closures) instead.`,
		);
	}

	const timestamp = new Date().toISOString();
	const applied: AmendmentApplication = { openQuestionsClosed: [], postPipelineClosed: [], unknownIds: [] };
	let closeoutNotice = "";

	const updatedState = await updateStatusAtomically(cwd, async (lockedState) => {
		const nextStatus = normalizeStatus(lockedState.status, lockedState.pipeline, lockedState.status.pipeline, lockedState.cwd);

		for (const closureId of amendment.open_question_closures) {
			if (!closureId) continue;
			let matched = false;
			for (const phase of Object.values(nextStatus.phases)) {
				const before = phase.open_questions.length;
				phase.open_questions = phase.open_questions.filter((entry) => entry.id !== closureId);
				if (phase.open_questions.length !== before) matched = true;
			}
			(matched ? applied.openQuestionsClosed : applied.unknownIds).push(closureId);
		}

		for (const closureId of amendment.post_pipeline_closures) {
			if (!closureId) continue;
			const before = nextStatus.post_pipeline.length;
			nextStatus.post_pipeline = nextStatus.post_pipeline.filter((entry) => entry.id !== closureId);
			(nextStatus.post_pipeline.length !== before ? applied.postPipelineClosed : applied.unknownIds).push(closureId);
		}

		// The amendment changed exactly the counts the terminal routing lines
		// carry (issue #114); rebuild them so status never shows stale numbers.
		nextStatus.next_actions = buildTerminalNextActions(nextStatus);
		nextStatus.last_updated = timestamp;

		// Amendment closeout + THREAD_LOG entry, same idempotence rule as
		// completion: the closeout link appears in THREAD_LOG at most once.
		const closeoutFile = `${dateOnly(timestamp)}-amendment-${amendment.slug}.md`;
		const closeoutsDir = join(lockedState.workspaceDir, "closeouts");
		await mkdir(closeoutsDir, { recursive: true });
		const body = amendment.closeout_content.trim() || renderAmendmentCloseout(amendment, applied, timestamp);
		await writeFile(join(closeoutsDir, closeoutFile), `${body}\n`, "utf8");
		const summary = amendment.closeout_summary.trim()
			|| `Amendment applied: ${applied.openQuestionsClosed.length} open question(s) and ${applied.postPipelineClosed.length} post-pipeline item(s) closed.`;
		const entry = `- ${dateOnly(timestamp)} — amendment:${amendment.slug} — ${summary} — [closeout](closeouts/${closeoutFile})`;
		const threadLogPath = join(lockedState.workspaceDir, "THREAD_LOG.md");
		let current = "";
		try {
			current = await readFile(threadLogPath, "utf8");
		} catch {
			// Created below when absent.
		}
		if (!current.split(/\r?\n/).some((line) => line.includes(`[closeout](closeouts/${closeoutFile})`))) {
			await appendFile(threadLogPath, `${entry}\n`, "utf8");
		}
		closeoutNotice = `Closeout: .codecarto/closeouts/${closeoutFile}`;

		return { state: { ...lockedState, status: nextStatus } };
	});

	return { updatedState, closeoutNotice, applied };
}
