// The coverage-gap ledger every primary output carries (#122, #186).
//
// Each phase output ends with a `## Coverage and limits` section whose bullet
// labels are fixed across every template — `- Inspected scope:`, `- Skipped
// scope:`, `- Evidence basis:`, `- Known blind spots:`, `- Coverage
// disposition:` — which is what makes reading it a parse and not a guess.
//
// The ledger was carried nowhere: not into the next phase's prompt, not into
// status.yaml, not into validation. So an upstream phase could declare "the
// encoded search-proxy command was not fully decoded" and the next phase could
// assert an `observed fact` about that exact component, with nothing in the
// framework comparing the two. The contradiction sweep could not have caught
// it either: that sweep compares against `owner_notes`, and a declared blind
// spot is not an owner note.
//
// Everything here is non-gating and read-only. A missing file, a missing
// section, or an empty bullet yields nothing; nothing throws.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceState } from "./types.ts";
import { pathExists } from "./utils.ts";

/** The section heading whose bullets this module reads. */
export const COVERAGE_SECTION_HEADING = "Coverage and limits";

/** The ledger's five fixed bullets, verbatim values with the label stripped. */
export type CoverageLedger = {
	inspected_scope: string;
	skipped_scope: string;
	evidence_basis: string;
	known_blind_spots: string;
	coverage_disposition: string;
};

/** Bullet label (normalized) to ledger field. */
const LEDGER_LABELS: ReadonlyMap<string, keyof CoverageLedger> = new Map([
	["inspected scope", "inspected_scope"],
	["skipped scope", "skipped_scope"],
	["evidence basis", "evidence_basis"],
	["known blind spots", "known_blind_spots"],
	["coverage disposition", "coverage_disposition"],
]);

/** The two ledger bullets a downstream phase is bound by, in render order. */
const GAP_FIELDS: ReadonlyArray<{ field: keyof CoverageLedger; label: string }> = [
	{ field: "skipped_scope", label: "skipped scope" },
	{ field: "known_blind_spots", label: "known blind spots" },
];

/** One declared gap from one completed phase's ledger. */
export type CoverageGap = {
	/** The phase that declared it. */
	phaseId: string;
	/** Which bullet it came from: "skipped scope" or "known blind spots". */
	label: string;
	/** The bullet's text, sub-bullets folded onto one line. */
	detail: string;
	/** `.codecarto/`-relative path of the output the ledger was read from. */
	output: string;
};

function emptyLedger(): CoverageLedger {
	return {
		inspected_scope: "",
		skipped_scope: "",
		evidence_basis: "",
		known_blind_spots: "",
		coverage_disposition: "",
	};
}

function normalizeLabel(label: string): string {
	return label.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Read a phase output's `## Coverage and limits` ledger.
 *
 * Returns null when the document has no such section. A bullet the author left
 * blank comes back as an empty string, as does a label the section omits, so a
 * caller never has to distinguish "absent" from "empty" — both mean nothing to
 * carry forward.
 *
 * Sub-bullets and wrapped continuation lines under a label belong to that
 * label: a real report writes its blind spots as a nested list, and dropping
 * them would silence exactly the case this exists for. They fold onto one line
 * (sub-bullets joined with "; ") because the consumer is a prompt bullet.
 */
export function parseCoverageAndLimits(content: string): CoverageLedger | null {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+Coverage and limits\s*$/i.test(line.replace(/[`*_]/g, "")));
	if (start < 0) return null;

	const ledger = emptyLedger();
	let current: keyof CoverageLedger | null = null;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) break;
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		if (bullet) {
			const separator = bullet[1].indexOf(":");
			const field = separator >= 0 ? LEDGER_LABELS.get(normalizeLabel(bullet[1].slice(0, separator))) : undefined;
			// An unrecognized top-level bullet ends the previous label's block
			// rather than absorbing text that belongs to neither.
			current = field ?? null;
			if (field) ledger[field] = bullet[1].slice(separator + 1).trim();
			continue;
		}
		if (!line.trim()) continue; // a blank line does not end a label's block
		if (!current || !/^\s/.test(line)) {
			current = null; // unindented prose is not part of any bullet
			continue;
		}
		const continuation = line.trim();
		const nested = /^[-*]\s+(.*)$/.exec(continuation);
		const text = (nested ? nested[1] : continuation).trim();
		if (!text) continue;
		ledger[current] = ledger[current] ? `${ledger[current]}${nested ? "; " : " "}${text}` : text;
	}
	return ledger;
}

/**
 * Every declared gap from every completed phase whose primary output exists.
 *
 * Walks `phase_order` so the list is deterministic and reads upstream-first.
 * Only `Skipped scope` and `Known blind spots` are collected: those are the
 * two bullets that bind a later phase's claims. Unreadable or unparsable
 * outputs contribute nothing.
 */
export async function collectCoverageGaps(state: WorkspaceState): Promise<CoverageGap[]> {
	const configs = new Map(state.pipeline.phases.map((phase) => [phase.id, phase]));
	const gaps: CoverageGap[] = [];
	for (const phaseId of state.pipeline.phase_order ?? []) {
		if (state.status.phases[phaseId]?.status !== "complete") continue;
		const output = configs.get(phaseId)?.primary_output;
		if (!output) continue;
		const outputPath = join(state.workspaceDir, output);
		if (!(await pathExists(outputPath))) continue;
		const content = await readFile(outputPath, "utf8").catch(() => null);
		if (content === null) continue;
		const ledger = parseCoverageAndLimits(content);
		if (!ledger) continue;
		for (const { field, label } of GAP_FIELDS) {
			const detail = ledger[field];
			if (detail) gaps.push({ phaseId, label, detail, output });
		}
	}
	return gaps;
}
