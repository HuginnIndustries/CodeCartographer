// Mechanical cross-checks over a defect report's findings tables (issue #122).
//
// A run can register an open question saying "source alone cannot determine
// which" and, in the same run, ship one of that question's candidates as
// `strong inference` / `fix before porting`. Both artifacts validate on their
// own criteria because nothing reads what the evidence and action cells SAY.
// The checks here do: they are deterministic reads of two cells the model
// wrote itself, so the gating one cannot wedge an --auto run on a heuristic.
//
// The findings tables are header-identical across the three defect templates
// (`| # | Location | Defect | Severity | Evidence Level | Action |`, with an
// optional trailing Spec Reference), which is what makes a header-driven parse
// a parse and not a guess. Any table without both an Evidence Level and an
// Action column is left alone.

import { compareDottedVersions } from "./utils.ts";

/**
 * First scaffold version whose defect templates offer `verify at runtime`.
 * A workspace scaffolded before it had no honest action for an unsettled
 * finding, so the pairing violation is reported as a warning there instead
 * of failing a phase mid-run.
 */
export const FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION = "0.17.1";

/** Evidence levels that mean "not settled by reading this source". */
export const UNSETTLED_EVIDENCE_LEVELS: ReadonlySet<string> = new Set(["open question", "external-behavior claim"]);

/** Actions that assert the diagnosis is settled enough to act on. */
export const SETTLED_FIX_ACTIONS: ReadonlySet<string> = new Set(["fix before porting", "fix now"]);

/** The pre-porting action an unsettled finding takes. */
export const RUNTIME_VERIFY_ACTION = "verify at runtime";

export type FindingRow = {
	/** The `## Pass N` heading the table sits under, when there is one. */
	pass: string | null;
	/** The `#` cell, verbatim. */
	number: string;
	/** Normalized Evidence Level cell (lowercase, markup stripped). */
	evidence: string;
	/** Normalized Action cell. */
	action: string;
	/** 1-based line of the row in the document. */
	line: number;
};

export type FindingsCrossCheck = {
	/** Violations that fail validation on a current scaffold. */
	errors: string[];
	/** Non-gating observations, rendered as NOTE lines. */
	warnings: string[];
	findings: FindingRow[];
};

function normalizeCell(cell: string): string {
	return cell.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isTableRow(line: string): boolean {
	return line.trim().startsWith("|");
}

function isSeparatorRow(line: string): boolean {
	return /^\s*\|?\s*:?-{3,}/.test(line);
}

function splitRow(line: string): string[] {
	const trimmed = line.trim();
	const inner = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
	return inner.split("|").map((cell) => cell.trim());
}

/**
 * Every data row of every table whose header carries both an Evidence Level
 * and an Action column. Placeholder rows (both cells empty) are skipped so an
 * untouched template section contributes nothing.
 */
export function parseFindingsTables(content: string): FindingRow[] {
	const lines = content.split(/\r?\n/);
	const rows: FindingRow[] = [];
	let pass: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const heading = /^##\s+Pass\s+(\d+)\b/i.exec(lines[i]);
		if (heading) {
			pass = heading[1];
			continue;
		}
		if (!isTableRow(lines[i]) || !isSeparatorRow(lines[i + 1] ?? "")) continue;

		const header = splitRow(lines[i]).map(normalizeCell);
		const evidenceIdx = header.indexOf("evidence level");
		const actionIdx = header.indexOf("action");
		const numberIdx = header.indexOf("#");
		if (evidenceIdx < 0 || actionIdx < 0) continue;

		for (let j = i + 2; j < lines.length && isTableRow(lines[j]); j++) {
			const cells = splitRow(lines[j]);
			const evidence = normalizeCell(cells[evidenceIdx] ?? "");
			const action = normalizeCell(cells[actionIdx] ?? "");
			if (!evidence && !action) continue;
			rows.push({ pass, number: numberIdx >= 0 ? (cells[numberIdx] ?? "").trim() : "", evidence, action, line: j + 1 });
			i = j;
		}
	}
	return rows;
}

/** Whether the report has an `## Open Questions` table, and how many filled rows it holds. */
export function parseOpenQuestionsTable(content: string): { present: boolean; rows: number } {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+Open Questions\s*$/i.test(line));
	if (start < 0) return { present: false, rows: 0 };
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) break; // next section, no table
		if (!isTableRow(lines[i]) || !isSeparatorRow(lines[i + 1] ?? "")) continue;
		let rows = 0;
		for (let j = i + 2; j < lines.length && isTableRow(lines[j]); j++) {
			if (splitRow(lines[j]).some((cell) => cell.length > 0)) rows++;
		}
		return { present: true, rows };
	}
	return { present: true, rows: 0 };
}

/**
 * Whether the pairing violation fails validation for this workspace. True from
 * the scaffold version that introduced `verify at runtime`; an unversioned or
 * older scaffold only warns.
 */
export function findingsPairingGateActive(scaffoldVersion: string | undefined | null): boolean {
	if (!scaffoldVersion) return false;
	const comparison = compareDottedVersions(scaffoldVersion, FINDINGS_PAIRING_GATE_SCAFFOLD_VERSION);
	return comparison !== null && comparison >= 0;
}

function describe(row: FindingRow): string {
	const where = row.pass ? `Pass ${row.pass} finding #${row.number || "?"}` : `finding #${row.number || "?"}`;
	return `${where} (line ${row.line})`;
}

/**
 * Run the cross-checks over a phase output. Returns empty results for any
 * document without findings tables, so non-defect phases are untouched.
 *
 * @param content - The primary output's markdown.
 * @param opts.gate - Whether the pairing violation is an error (current scaffold) or a warning.
 */
export function crossCheckFindings(content: string, opts: { gate: boolean }): FindingsCrossCheck {
	const findings = parseFindingsTables(content);
	const errors: string[] = [];
	const warnings: string[] = [];
	if (findings.length === 0) return { errors, warnings, findings };

	for (const row of findings) {
		if (UNSETTLED_EVIDENCE_LEVELS.has(row.evidence) && SETTLED_FIX_ACTIONS.has(row.action)) {
			const message =
				`${describe(row)}: evidence level "${row.evidence}" cannot carry the settled action "${row.action}" — ` +
				`use "${RUNTIME_VERIFY_ACTION}" or "port differently" ("investigate" on maintenance pipelines), and list the finding under ## Open Questions.`;
			if (opts.gate) errors.push(message);
			else warnings.push(`${message} Warning only: this workspace's scaffold predates the verify-at-runtime vocabulary — refresh it to make this gating.`);
		}
		if (row.evidence === "observed fact" && row.action === RUNTIME_VERIFY_ACTION) {
			warnings.push(
				`${describe(row)}: "observed fact" paired with "${RUNTIME_VERIFY_ACTION}" contradicts itself — a settled label with an unsettled action. Pick the one that is true.`,
			);
		}
	}

	const unsettled = findings.filter((row) => UNSETTLED_EVIDENCE_LEVELS.has(row.evidence) || row.action === RUNTIME_VERIFY_ACTION);
	const openQuestions = parseOpenQuestionsTable(content);
	if (unsettled.length > 0 && openQuestions.present && openQuestions.rows === 0) {
		warnings.push(
			`${unsettled.length} unsettled finding(s) but the ## Open Questions table is empty — each open question / external-behavior claim finding needs a row there so the hedge travels with the finding, not only with the handoff.`,
		);
	}

	return { errors, warnings, findings };
}
