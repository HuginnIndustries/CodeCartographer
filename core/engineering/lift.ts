// Lifting slices out of a planning artifact (E09, #407).
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// The reimplementation specs and the project plan now carry a Slices table
// and scenario ids. This module reads those tables and produces the record
// vocabulary -- slice ids, deliverables, `scenario_ids`, `depends_on` -- so a
// change can be planned FROM an existing analysis artifact rather than from
// nothing. That is the seam E04 left open ("deriving a plan from an existing
// analysis artifact is deliberately NOT implemented here").
//
// WHAT IT REFUSES
//
// It refuses what buildChangePlan (E04) and the record contract (E01) refuse,
// in the same words, so an artifact that lifts here also plans and stores
// there. tests/engineering-lift.test.mjs hands the same slices to both halves
// and asserts they agree. The planning skill tells a session "an empty proof
// list is not a plan"; this is where that sentence becomes a check:
//
//   - an id that is not a valid record local id
//   - a slice with no proved scenarios, or an empty deliverable
//   - a scenario with an empty description
//   - a slice naming a scenario that does not exist in the artifact
//   - a slice depending on a slice that does not exist, on itself, or
//     through a cycle (a -> b -> a is a plan with no first step)
//   - a minimum-viable scenario owned by no slice
//   - duplicate slice or scenario ids
//   - a row the author wrote that the reader would otherwise lose: a row
//     with content but no id, a table interrupted by prose, a row whose
//     cell count does not match the header
//   - a heading that appears twice, so the reader never silently picks one
//   - (E10) a slice whose verification route is missing, `none`, or not a
//     record check_kind; `none` is a recorded gap and lifts as a refusal
//
// WHAT IT DOES NOT DO
//
// It does not decide that the artifact is GOOD. A table can be structurally
// perfect and describe the wrong system; that judgment stays with the
// reviewer. It reads markdown and returns data plus a list of reasons the
// data cannot be used. Pure: no filesystem, no store, no clock.
//
// THE READER
//
// Deliberately narrow: a GitHub-flavoured pipe table under a known H2, and
// nothing else. The rules it follows are GFM's, not a regex approximation
// of them, because the first version of this file used a regex to decide
// which lines were rows and lost rows the author wrote (found in review):
//
//   - fenced code blocks are invisible, so an example table in a SKILL or a
//     template comment is never mistaken for the real one
//   - the section runs from the heading to the next H2
//   - the first line containing a pipe is the header; the line after it
//     MUST be the delimiter row, and no other line is ever treated as one
//   - a leading or trailing pipe is optional, `\|` is a literal pipe
//   - a blank line does not end the table; a non-blank line without a pipe
//     that is followed by more pipe lines is an interruption and is refused,
//     because ending the table there would drop every row after it
//
// Errors are a complete list rather than a first failure. Column checks
// gate only the row checks that need that column, so a misspelled header
// does not hide an empty proof list two rows down.

import { isLocalId } from "./ids.ts";
import type { CheckKind } from "./types.ts";

/**
 * The check kinds a slice may name as its verification ROUTE (E10). A
 * deliberate subset of E01's CHECK_KINDS: `build`, `lint` and `typecheck`
 * do not observe scenario behavior, and `other` means "I cannot say how
 * this is observed" -- which is a gap, and must be written as `none` so it
 * is refused as one. Gating on the full CHECK_KINDS let `other` lift as a
 * clean pass and the refusal message recommend it (review finding).
 */
export const ROUTE_KINDS = ["test", "run", "manual-procedure"] as const satisfies readonly CheckKind[];
export type RouteKind = (typeof ROUTE_KINDS)[number];

export interface LiftedScenario {
	id: string;
	tier: string;
	description: string;
}

export interface LiftedSlice {
	id: string;
	deliverable: string;
	modules: string[];
	scenario_ids: string[];
	depends_on: string[];
	tier: string;
	/**
	 * How an agent observes the proved scenarios (E10), in E01's own
	 * check_kind vocabulary. Present only when the artifact's table carries
	 * a Verification route column. `"none"` is a recorded gap, not a route.
	 */
	verification_route?: RouteKind | "none";
	/** Present only when the artifact's table carries a Proof command column. */
	proof_command?: string;
}

export type LiftErrorCode =
	| "missing-section"
	| "duplicate-section"
	| "malformed-table"
	| "interrupted-table"
	| "ragged-row"
	| "missing-column"
	| "missing-id"
	| "invalid-id"
	| "duplicate-id"
	| "empty-description"
	| "empty-deliverable"
	| "empty-proof-list"
	| "unknown-scenario"
	| "unknown-dependency"
	| "self-dependency"
	| "dependency-cycle"
	| "unowned-minimum-viable"
	| "unknown-route"
	| "no-route"
	| "duplicate-column";

export interface LiftError {
	/** Where in the artifact the problem is, in the artifact's own ids or table rows. */
	at: string;
	code: LiftErrorCode;
	message: string;
}

export interface LiftOutcome {
	scenarios: LiftedScenario[];
	slices: LiftedSlice[];
	/** Empty exactly when the artifact can be planned from. */
	errors: LiftError[];
}

/** The tier a scenario must carry for "every one of these is owned" to apply. */
export const MINIMUM_VIABLE_TIER = "minimum-viable";

const SCENARIO_HEADINGS = [/^## Acceptance Scenarios\s*$/im, /^## Acceptance plan\s*$/im];
const SLICE_HEADINGS = [/^## Slices\s*$/im];
const SCENARIO_SECTION = "Acceptance Scenarios";
const SLICE_SECTION = "Slices";

/**
 * Read the scenarios and slices out of a planning artifact.
 */
export function liftSlices(markdown: string): LiftOutcome {
	const errors: LiftError[] = [];
	const visible = blankFencedCode(markdown);

	const scenarioTable = readSectionTable(visible, SCENARIO_HEADINGS, SCENARIO_SECTION, errors);
	const sliceTable = readSectionTable(visible, SLICE_HEADINGS, SLICE_SECTION, errors);

	// ---- scenarios ----
	const scenarios: LiftedScenario[] = [];
	if (scenarioTable) {
		const idCol = requireColumn(scenarioTable, "Scenario ID", SCENARIO_SECTION, errors);
		const tierCol = requireColumn(scenarioTable, "Tier", SCENARIO_SECTION, errors);
		const descCol = requireColumn(scenarioTable, "Scenario", SCENARIO_SECTION, errors);
		if (idCol >= 0) {
			const seen = new Set<string>();
			for (const row of scenarioTable.rows) {
				const id = row.cells[idCol] ?? "";
				if (!id) {
					if (row.cells.every((cell) => !cell)) continue;
					errors.push({ at: `${SCENARIO_SECTION} row ${row.number}`, code: "missing-id", message: "a scenario row has content but no Scenario ID" });
					continue;
				}
				if (!isLocalId(id)) errors.push({ at: id, code: "invalid-id", message: `scenario id ${JSON.stringify(id)} is not a valid local id ([A-Za-z0-9][A-Za-z0-9._-]{0,63}); the record store would refuse it` });
				if (seen.has(id)) errors.push({ at: id, code: "duplicate-id", message: `scenario ${id} is defined more than once` });
				seen.add(id);
				const description = descCol >= 0 ? (row.cells[descCol] ?? "") : "";
				if (descCol >= 0 && !description) {
					errors.push({ at: id, code: "empty-description", message: `scenario ${id} has no description; a scenario needs a non-empty id and description` });
				}
				scenarios.push({ id, tier: tierCol >= 0 ? (row.cells[tierCol] ?? "") : "", description });
			}
		}
	}

	// ---- slices ----
	const slices: LiftedSlice[] = [];
	if (sliceTable) {
		const cols = {
			id: requireColumn(sliceTable, "Slice ID", SLICE_SECTION, errors),
			deliverable: requireColumn(sliceTable, "Deliverable", SLICE_SECTION, errors),
			modules: requireColumn(sliceTable, "Modules", SLICE_SECTION, errors),
			proves: requireColumn(sliceTable, "Proves scenarios", SLICE_SECTION, errors),
			depends: requireColumn(sliceTable, "Depends on", SLICE_SECTION, errors),
			tier: requireColumn(sliceTable, "Tier", SLICE_SECTION, errors),
			proof: column(sliceTable, "Proof command"),
			route: column(sliceTable, "Verification route"),
		};
		// A column that appears twice is refused for the same reason a heading
		// that appears twice is: which cell is the route is ambiguous, and
		// first-match-wins silently discarded a recorded `none` (review finding).
		for (const name of ["Slice ID", "Deliverable", "Modules", "Proves scenarios", "Depends on", "Tier", "Verification route", "Proof command"]) {
			const n = sliceTable.header.filter((h) => h.toLowerCase() === name.toLowerCase()).length;
			if (n > 1) errors.push({ at: "Slices", code: "duplicate-column", message: `the Slices table has ${n} "${name}" columns; which one is meant is ambiguous` });
		}
		// Only the id column gates the row loop. Every other check runs when
		// its own column exists, so one misspelled header does not suppress
		// the defects in columns that are present.
		if (cols.id >= 0) {
			const seen = new Set<string>();
			for (const row of sliceTable.rows) {
				const id = row.cells[cols.id] ?? "";
				if (!id) {
					if (row.cells.every((cell) => !cell)) continue;
					errors.push({ at: `${SLICE_SECTION} row ${row.number}`, code: "missing-id", message: "a slice row has content but no Slice ID; it would otherwise vanish from the plan" });
					continue;
				}
				if (!isLocalId(id)) errors.push({ at: id, code: "invalid-id", message: `slice id ${JSON.stringify(id)} is not a valid local id ([A-Za-z0-9][A-Za-z0-9._-]{0,63}); the record store would refuse it` });
				if (seen.has(id)) errors.push({ at: id, code: "duplicate-id", message: `slice ${id} is defined more than once` });
				seen.add(id);
				const deliverable = cols.deliverable >= 0 ? (row.cells[cols.deliverable] ?? "") : "";
				if (cols.deliverable >= 0 && !deliverable) {
					errors.push({ at: id, code: "empty-deliverable", message: `slice ${id} has no deliverable; a slice needs a title and a deliverable` });
				}
				const proof = cols.proof >= 0 ? (row.cells[cols.proof] ?? "") : "";
				const routeText = cols.route >= 0 ? (row.cells[cols.route] ?? "") : "";
				let route: RouteKind | "none" | undefined;
				if (cols.route >= 0) {
					// The column exists, so a route is required: E10 says every
					// slice names one. An unavailable route is written as `none`
					// and refused as a gap on that slice -- never silently a pass.
					if (!routeText) {
						errors.push({ at: id, code: "no-route", message: `slice ${id} names no verification route; write \`none\` if there is none, and it is a gap, not a pass` });
					} else if (routeText === "none") {
						route = "none";
						errors.push({ at: id, code: "no-route", message: `slice ${id} has no observable verification route (\`none\`); this is a gap on the slice, not a pass` });
					} else if ((ROUTE_KINDS as readonly string[]).includes(routeText)) {
						route = routeText as RouteKind;
					} else {
						errors.push({ at: id, code: "unknown-route", message: `slice ${id} names verification route ${JSON.stringify(routeText)}, which is not a verification route (${ROUTE_KINDS.join(", ")}) or \`none\`` });
					}
				}
				slices.push({
					id,
					deliverable,
					modules: cols.modules >= 0 ? list(row.cells[cols.modules]) : [],
					scenario_ids: cols.proves >= 0 ? list(row.cells[cols.proves]) : [],
					depends_on: cols.depends >= 0 ? list(row.cells[cols.depends]) : [],
					tier: cols.tier >= 0 ? (row.cells[cols.tier] ?? "") : "",
					...(route !== undefined ? { verification_route: route } : {}),
					...(proof ? { proof_command: proof } : {}),
				});
			}
			// ---- cross-checks, the same refusals as E04, same reasons ----
			const scenarioIds = new Set(scenarios.map((s) => s.id));
			const sliceIds = new Set(slices.map((s) => s.id));
			const owned = new Set<string>();
			for (const slice of slices) {
				if (cols.proves >= 0 && slice.scenario_ids.length === 0) {
					errors.push({ at: slice.id, code: "empty-proof-list", message: `slice ${slice.id} proves no scenario; an empty proof list is not a plan` });
				}
				for (const sid of slice.scenario_ids) {
					if (!scenarioIds.has(sid)) errors.push({ at: slice.id, code: "unknown-scenario", message: `slice ${slice.id} proves ${sid}, which is not in the acceptance table` });
					else owned.add(sid);
				}
				for (const dep of slice.depends_on) {
					if (dep === slice.id) errors.push({ at: slice.id, code: "self-dependency", message: `slice ${slice.id} depends on itself` });
					else if (!sliceIds.has(dep)) errors.push({ at: slice.id, code: "unknown-dependency", message: `slice ${slice.id} depends on ${dep}, which is not a slice` });
				}
			}
			const cycle = findCycle(slices);
			if (cycle) {
				errors.push({ at: cycle[0], code: "dependency-cycle", message: `dependency cycle between slices: ${cycle.join(" -> ")}; a cycle is a plan with no first step` });
			}
			if (scenarioTable) {
				for (const scenario of scenarios) {
					if (scenario.tier === MINIMUM_VIABLE_TIER && !owned.has(scenario.id)) {
						errors.push({ at: scenario.id, code: "unowned-minimum-viable", message: `scenario ${scenario.id} is minimum-viable but no slice proves it; the plan could be called done without it` });
					}
				}
			}
		}
	}

	return { scenarios, slices, errors };
}

/**
 * The same walk E04 does (planning.ts findCycle), over the artifact's own
 * Slice IDs. Unknown dependencies are skipped here because they are already
 * reported by name; duplicates were reported above, and the first definition
 * wins for the walk, which cannot hide a cycle because the duplicate is
 * itself a refusal.
 */
function findCycle(slices: LiftedSlice[]): string[] | null {
	const byId = new Map<string, LiftedSlice>();
	for (const s of slices) if (!byId.has(s.id)) byId.set(s.id, s);
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	function walk(id: string): string[] | null {
		const current = state.get(id);
		if (current === "done") return null;
		if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
		const slice = byId.get(id);
		if (!slice) return null;
		state.set(id, "visiting");
		stack.push(id);
		for (const dep of slice.depends_on) {
			if (dep === id) continue; // reported as self-dependency
			const cycle = walk(dep);
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(id, "done");
		return null;
	}
	for (const s of slices) {
		const cycle = walk(s.id);
		if (cycle) return cycle;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The pipe-table reader.
// ---------------------------------------------------------------------------

interface TableRow {
	/** 1-based, counting data rows only, for messages. */
	number: number;
	cells: string[];
}

interface Table {
	header: string[];
	rows: TableRow[];
}

/**
 * Replace the contents of every fenced code block with blank lines, so line
 * structure survives but no fenced text is ever read.
 *
 * The split here normalizes CRLF. UNTESTED BY CONSTRUCTION: splitting on
 * bare \n instead is an equivalent mutant -- a trailing \r survives into
 * every line, but the fence regex is anchored at the start, the heading
 * regexes end in \s*$ which absorbs it, and every cell is trimmed. The
 * CRLF test passes either way; the normalization is here so no future
 * consumer of `lines` has to know that.
 */
function blankFencedCode(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
		if (fence === null) {
			if (m) {
				fence = m[1][0];
				lines[i] = "";
			}
		} else {
			const closing = m && m[1][0] === fence;
			lines[i] = "";
			if (closing) fence = null;
		}
	}
	return lines.join("\n");
}

/**
 * The table under the ONE heading matching any of `headings`. Two matching
 * headings is a refusal rather than a pick: a reader that silently chose one
 * would report on a table the author was not looking at.
 */
function readSectionTable(markdown: string, headings: RegExp[], name: string, errors: LiftError[]): Table | null {
	const matches: number[] = [];
	for (const heading of headings) {
		const global = new RegExp(heading.source, heading.flags.includes("g") ? heading.flags : heading.flags + "g");
		for (const m of markdown.matchAll(global)) matches.push(m.index + m[0].length);
	}
	if (matches.length === 0) {
		errors.push({ at: name, code: "missing-section", message: `no ${name} table found` });
		return null;
	}
	if (matches.length > 1) {
		errors.push({ at: name, code: "duplicate-section", message: `the ${name} heading appears ${matches.length} times; which table is the plan is ambiguous` });
		return null;
	}
	const section = markdown.slice(matches[0]).split(/^## /m)[0];
	return readTable(section, name, errors);
}

const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function readTable(section: string, name: string, errors: LiftError[]): Table | null {
	const lines = section.split("\n");
	const isPipeLine = (line: string) => hasUnescapedPipe(line);
	const start = lines.findIndex(isPipeLine);
	if (start < 0) {
		errors.push({ at: name, code: "missing-section", message: `the ${name} section has no table` });
		return null;
	}
	const header = splitCells(lines[start]);
	const delimiter = lines[start + 1] ?? "";
	if (!DELIMITER_ROW.test(delimiter.trim())) {
		errors.push({ at: name, code: "malformed-table", message: `the ${name} table header is not followed by a delimiter row (|---|---|); the line after it is ${JSON.stringify(delimiter.trim())}` });
		return null;
	}
	const rows: TableRow[] = [];
	for (let i = start + 2; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue; // a blank line does not end the table
		if (!isPipeLine(line)) {
			// Prose after the table is fine. Prose BETWEEN rows is not: the
			// rows after it would be lost, and "errors: []" would be a lie.
			const more = lines.slice(i + 1).some(isPipeLine);
			if (more) {
				errors.push({ at: `${name} row ${rows.length + 1}`, code: "interrupted-table", message: `the ${name} table is interrupted by a line without a pipe (${JSON.stringify(line.trim().slice(0, 60))}); rows after it would be dropped` });
			}
			break;
		}
		const cells = splitCells(line);
		if (cells.length !== header.length) {
			errors.push({ at: `${name} row ${rows.length + 1}`, code: "ragged-row", message: `row has ${cells.length} cells but the header has ${header.length}; every column after the mismatch would be read as the wrong one` });
			// Still record it so later checks report on what IS readable.
		}
		rows.push({ number: rows.length + 1, cells });
	}
	return { header, rows };
}

function hasUnescapedPipe(line: string): boolean {
	return /(^|[^\\])\|/.test(line);
}

/** Split a GFM row into trimmed cells. Leading/trailing pipe optional, `\|` is a literal pipe. */
function splitCells(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\\" && s[i + 1] === "|") {
			current += "|";
			i++;
		} else if (ch === "|") {
			cells.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	cells.push(current.trim());
	return cells;
}

function column(table: Table, name: string): number {
	return table.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}

function requireColumn(table: Table, name: string, section: string, errors: LiftError[]): number {
	const col = column(table, name);
	if (col < 0) errors.push({ at: section, code: "missing-column", message: `${section} table has no ${name} column` });
	return col;
}

/** A comma-separated cell into a list, ignoring blanks. */
function list(cell: string | undefined): string[] {
	if (!cell) return [];
	return cell
		.split(/[,;]/)
		.map((part) => part.trim())
		.filter(Boolean);
}
