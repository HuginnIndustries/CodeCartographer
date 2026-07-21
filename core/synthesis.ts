// Runtime guards and library context for the forward synthesis pipeline.
// These checks live in core so Pi and MCP refuse the same invalid transition
// before an LLM receives a phase prompt.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverLibrary, listEntries, type LibraryIndexEntry } from "./library.ts";
import { loadCodecartoConfig } from "./orchestrator-config.ts";
import type { PipelinePhase, WorkspaceState } from "./types.ts";
import { pathExists } from "./utils.ts";

export const SYNTHESIS_PROPOSAL_PATH = "findings/goal-synthesis/proposal.md";
export const SYNTHESIS_VISION_INPUT_PATH = "inputs/vision.md";

export type SynthesisLibraryEntry = {
	ref: string;
	version: number;
	versions: number[];
	headline: string;
	tags: string[];
	specPath: string;
};

export type ConfirmedProposalSelection = {
	ref: string;
	version: number;
	specPath?: string;
};

export type PhasePreflightResult = {
	libraryPath?: string;
	libraryName?: string;
	libraryEntries: SynthesisLibraryEntry[];
	confirmedEntries: string[];
	confirmedSelections: ConfirmedProposalSelection[];
};

export class PhasePreflightError extends Error {
	readonly phaseId: string;

	constructor(phaseId: string, message: string) {
		super(`Cannot start ${phaseId}: ${message}`);
		this.phaseId = phaseId;
		this.name = "PhasePreflightError";
	}
}

export function parseConfirmedProposalEntries(markdown: string): string[] {
	return parseConfirmedProposalSelections(markdown).map((selection) => selection.ref);
}

export function hasMeaningfulVisionContent(markdown: string): boolean {
	let inHtmlComment = false;

	for (const line of markdown.split(/\r?\n/)) {
		const visibleSegments: string[] = [];
		let cursor = 0;

		while (cursor < line.length) {
			if (inHtmlComment) {
				const commentEnd = line.indexOf("-->", cursor);
				if (commentEnd === -1) {
					cursor = line.length;
					continue;
				}
				inHtmlComment = false;
				cursor = commentEnd + 3;
				continue;
			}

			const commentStart = line.indexOf("<!--", cursor);
			if (commentStart === -1) {
				visibleSegments.push(line.slice(cursor));
				break;
			}
			visibleSegments.push(line.slice(cursor, commentStart));
			inHtmlComment = true;
			cursor = commentStart + 4;
		}

		// Keep source segments separated so removing a comment cannot manufacture
		// a new multi-character token from the characters on either side.
		const visible = visibleSegments.join(" ").trim();
		if (!visible || /^#+(?:\s|$)/.test(visible)) continue;
		if (/[\p{L}\p{N}]/u.test(visible)) return true;
	}

	return false;
}

export function parseConfirmedProposalSelections(markdown: string): ConfirmedProposalSelection[] {
	const confirmed: ConfirmedProposalSelection[] = [];
	for (const rawLine of markdown.split(/\r?\n/)) {
		const match = rawLine.match(/^\|\s*\[[xX]\]\s*\|\s*`?([^|`]+)`?\s*\|\s*`?v?(\d+)`?\s*\|/i);
		const ref = match?.[1]?.trim();
		const version = match?.[2] ? Number.parseInt(match[2], 10) : Number.NaN;
		if (ref && Number.isInteger(version) && !confirmed.some((selection) => selection.ref === ref)) {
			confirmed.push({ ref, version });
		}
	}
	return confirmed;
}

export async function runPhasePreflight(
	state: WorkspaceState,
	phase: PipelinePhase,
): Promise<PhasePreflightResult> {
	const checks = new Set(phase.preflight ?? []);
	const result: PhasePreflightResult = { libraryEntries: [], confirmedEntries: [], confirmedSelections: [] };

	if (checks.has("requires-vision-input")) {
		const visionPath = join(state.workspaceDir, SYNTHESIS_VISION_INPUT_PATH);
		if (!(await pathExists(visionPath))) {
			throw new PhasePreflightError(
				phase.id,
				`the vision brief is missing at .codecarto/${SYNTHESIS_VISION_INPUT_PATH}. Create it before starting synthesis.`,
			);
		}
		const rawVision = await readFile(visionPath, "utf8");
		if (!hasMeaningfulVisionContent(rawVision)) {
			throw new PhasePreflightError(
				phase.id,
				`the vision brief at .codecarto/${SYNTHESIS_VISION_INPUT_PATH} is still empty. Describe the audience, problem, and desired outcome, then retry.`,
			);
		}
	}

	if (checks.has("requires-library")) {
		const config = await loadCodecartoConfig(state.workspaceDir);
		if (!config.library.path) {
			throw new PhasePreflightError(
				phase.id,
				"no library.path is configured. Set it in ~/.codecarto/config.yaml or .codecarto/workflow/config.yaml.",
			);
		}
		const marker = await discoverLibrary(config.library.path);
		if (!marker) {
			throw new PhasePreflightError(
				phase.id,
				`no CodeCartographer library was found at ${config.library.path} (missing .codecarto-library).`,
			);
		}
		const entries = await listEntries(config.library.path);
		if (entries.length === 0) {
			throw new PhasePreflightError(
				phase.id,
				`the configured library at ${config.library.path} has no entries. Publish at least one reimplementation spec first.`,
			);
		}
		result.libraryPath = config.library.path;
		result.libraryName = marker.name;
		result.libraryEntries = entries.map((entry) => describeLibraryEntry(config.library.path!, entry));
	}

	if (checks.has("requires-confirmed-proposal")) {
		const proposalPath = join(state.workspaceDir, SYNTHESIS_PROPOSAL_PATH);
		if (!(await pathExists(proposalPath))) {
			throw new PhasePreflightError(
				phase.id,
				`the proposal is missing at .codecarto/${SYNTHESIS_PROPOSAL_PATH}. Run goal-synthesis-propose first.`,
			);
		}
		result.confirmedSelections = parseConfirmedProposalSelections(await readFile(proposalPath, "utf8"));
		result.confirmedEntries = result.confirmedSelections.map((selection) => selection.ref);
		if (result.confirmedSelections.length === 0) {
			throw new PhasePreflightError(
				phase.id,
				`no library entries are confirmed in .codecarto/${SYNTHESIS_PROPOSAL_PATH}. Change at least one [ ] checkbox to [x], then retry.`,
			);
		}
		const available = new Map(result.libraryEntries.map((entry) => [entry.ref, entry]));
		for (const selection of result.confirmedSelections) {
			const entry = available.get(selection.ref);
			if (!entry || !entry.versions.includes(selection.version)) {
				throw new PhasePreflightError(
					phase.id,
					`confirmed selection ${selection.ref}@v${selection.version} is not present in the configured library. Re-run the proposal phase or correct the checked row.`,
				);
			}
			selection.specPath = specPathForVersion(result.libraryPath!, selection.ref, selection.version);
		}
	}

	return result;
}

function describeLibraryEntry(libraryPath: string, entry: LibraryIndexEntry): SynthesisLibraryEntry {
	const ref = entry.namespace ? `${entry.namespace}/${entry.slug}` : entry.slug;
	const version = entry.latest_version;
	return {
		ref,
		version,
		versions: [...entry.versions],
		headline: entry.headline,
		tags: [...entry.tags],
		specPath: join(
			libraryPath,
			"entries",
			...(entry.namespace ? [entry.namespace] : []),
			entry.slug,
			`v${version}`,
			"reimplementation-spec.md",
		),
	};
}

function specPathForVersion(libraryPath: string, ref: string, version: number): string {
	return join(libraryPath, "entries", ...ref.split("/"), `v${version}`, "reimplementation-spec.md");
}
