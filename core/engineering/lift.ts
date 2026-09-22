// Lifting slices out of a planning artifact (E09, #407).
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// The reimplementation specs and the project plan now carry a Slices table
// and scenario ids. This module reads those tables and produces the record
// vocabulary -- slice titles, deliverables, `scenario_ids`, `depends_on` --
// so a change can be planned FROM an existing analysis artifact rather than
// from nothing. That is the seam E04 left open ("deriving a plan from an
// existing analysis artifact is deliberately NOT implemented here").
//
// WHAT IT REFUSES
//
// It refuses precisely what the record contract refuses, in the same words,
// so an artifact that lifts here also stores there. The planning skill tells
// a session "an empty proof list is not a plan"; this is where that sentence
// becomes a check rather than advice:
//
//   - a slice with no proved scenarios
//   - a slice naming a scenario that does not exist in the artifact
//   - a slice depending on a slice that does not exist, or on itself
//   - a minimum-viable scenario owned by no slice
//   - duplicate slice or scenario ids
//
// WHAT IT DOES NOT DO
//
// It does not decide that the artifact is GOOD. A table can be structurally
// perfect and describe the wrong system; that judgment stays with the
// reviewer. It reads markdown and returns data plus a list of reasons the
// data cannot be used. Pure: no filesystem, no store, no clock.
//
// The parser is deliberately narrow. It reads a GitHub-flavoured pipe table
// under a known heading and nothing else; a template that changes the
// heading or the column names fails loudly here, which is what the paired
// pipeline-invariants test is for. It does not try to be a markdown parser.

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
	/** Present only when the artifact's table carries a Proof command column. */
	proof_command?: string;
}

export interface LiftError {
	/** Where in the artifact the problem is, in the artifact's own ids. */
	at: string;
	code:
		| "missing-section"
		| "missing-column"
		| "empty-proof-list"
		| "unknown-scenario"
		| "unknown-dependency"
		| "self-dependency"
		| "unowned-minimum-viable"
		| "duplicate-id"
		| "missing-id";
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

/**
 * Read the scenarios and slices out of a planning artifact.
 *
 * `errors` is a complete list, not a first failure: a session fixing an
 * artifact needs every reason at once, and a reviewer reading the outcome
 * needs to see that nothing was hidden behind the first refusal.
 */
export function liftSlices(markdown: string): LiftOutcome {
	const errors: LiftError[] = [];

	const scenarioTable = readTable(markdown, [/^## Acceptance Scenarios\s*$/im, /^## Acceptance plan\s*$/im]);
	if (!scenarioTable) {
		errors.push({ at: "Acceptance Scenarios", code: "missing-section", message: "no Acceptance Scenarios / Acceptance plan table found" });
	}
	const sliceTable = readTable(markdown, [/^## Slices\s*$/im]);
	if (!sliceTable) {
		errors.push({ at: "Slices", code: "missing-section", message: "no Slices table found" });
	}
	// No early return here. An old-format artifact has an acceptance table
	// with no ids AND no Slices section; a session converting it needs both
	// facts at once. Returning on the first missing section hid the second
	// (found by lifting the repository's own pre-E09 self-audit specs).

	const scenarios: LiftedScenario[] = [];
	if (scenarioTable) {
		const idCol = column(scenarioTable, "Scenario ID");
		const tierCol = column(scenarioTable, "Tier");
		const descCol = column(scenarioTable, "Scenario");
		for (const [name, col] of [["Scenario ID", idCol], ["Tier", tierCol], ["Scenario", descCol]] as const) {
			if (col < 0) errors.push({ at: "Acceptance Scenarios", code: "missing-column", message: `acceptance table has no ${name} column` });
		}
		if (idCol >= 0 && tierCol >= 0 && descCol >= 0) {
			const seen = new Set<string>();
			for (const row of scenarioTable.rows) {
				const id = row[idCol]?.trim() ?? "";
				if (!id) {
					// A fully blank row is table noise and is ignored. A row WITH
					// content but no id is not: dropping it silently would lose a
					// scenario the author wrote, and ownership would be counted
					// against a table the author did not see.
					if (row.every((cell) => !cell.trim())) continue;
					errors.push({ at: `Acceptance Scenarios row ${scenarios.length + 1}`, code: "missing-id", message: "a scenario row has content but no Scenario ID" });
					continue;
				}
				if (seen.has(id)) errors.push({ at: id, code: "duplicate-id", message: `scenario ${id} is defined more than once` });
				seen.add(id);
				scenarios.push({ id, tier: row[tierCol]?.trim() ?? "", description: row[descCol]?.trim() ?? "" });
			}
		}
	}

	const slices: LiftedSlice[] = [];
	if (sliceTable) {
		const cols = {
			id: column(sliceTable, "Slice ID"),
			deliverable: column(sliceTable, "Deliverable"),
			modules: column(sliceTable, "Modules"),
			proves: column(sliceTable, "Proves scenarios"),
			depends: column(sliceTable, "Depends on"),
			tier: column(sliceTable, "Tier"),
			proof: column(sliceTable, "Proof command"),
		};
		for (const [name, col] of [
			["Slice ID", cols.id],
			["Deliverable", cols.deliverable],
			["Modules", cols.modules],
			["Proves scenarios", cols.proves],
			["Depends on", cols.depends],
			["Tier", cols.tier],
		] as const) {
			if (col < 0) errors.push({ at: "Slices", code: "missing-column", message: `Slices table has no ${name} column` });
		}
		if (Object.entries(cols).every(([k, v]) => k === "proof" || v >= 0)) {
			const seen = new Set<string>();
			for (const row of sliceTable.rows) {
				const id = row[cols.id]?.trim() ?? "";
				if (!id) {
					if (row.every((cell) => !cell.trim())) continue;
					errors.push({ at: `Slices row ${slices.length + 1}`, code: "missing-id", message: "a slice row has content but no Slice ID; it would otherwise vanish from the plan" });
					continue;
				}
				if (seen.has(id)) errors.push({ at: id, code: "duplicate-id", message: `slice ${id} is defined more than once` });
				seen.add(id);
				slices.push({
					id,
					deliverable: row[cols.deliverable]?.trim() ?? "",
					modules: list(row[cols.modules]),
					scenario_ids: list(row[cols.proves]),
					depends_on: list(row[cols.depends]),
					tier: row[cols.tier]?.trim() ?? "",
					...(cols.proof >= 0 && row[cols.proof]?.trim() ? { proof_command: row[cols.proof].trim() } : {}),
				});
			}
		}
	}

	// Cross-checks. Same refusals as the record contract, same reasons.
	const scenarioIds = new Set(scenarios.map((s) => s.id));
	const sliceIds = new Set(slices.map((s) => s.id));
	const owned = new Set<string>();
	for (const slice of slices) {
		if (slice.scenario_ids.length === 0) {
			errors.push({
				at: slice.id,
				code: "empty-proof-list",
				message: `slice ${slice.id} proves no scenario; an empty proof list is not a plan`,
			});
		}
		for (const sid of slice.scenario_ids) {
			if (!scenarioIds.has(sid)) {
				errors.push({ at: slice.id, code: "unknown-scenario", message: `slice ${slice.id} proves ${sid}, which is not in the acceptance table` });
			} else {
				owned.add(sid);
			}
		}
		for (const dep of slice.depends_on) {
			if (dep === slice.id) errors.push({ at: slice.id, code: "self-dependency", message: `slice ${slice.id} depends on itself` });
			else if (!sliceIds.has(dep)) errors.push({ at: slice.id, code: "unknown-dependency", message: `slice ${slice.id} depends on ${dep}, which is not a slice` });
		}
	}
	for (const scenario of scenarios) {
		if (scenario.tier === MINIMUM_VIABLE_TIER && !owned.has(scenario.id)) {
			errors.push({
				at: scenario.id,
				code: "unowned-minimum-viable",
				message: `scenario ${scenario.id} is minimum-viable but no slice proves it; the plan could be called done without it`,
			});
		}
	}

	return { scenarios, slices, errors };
}

// ---------------------------------------------------------------------------
// A narrow pipe-table reader.
// ---------------------------------------------------------------------------

interface Table {
	header: string[];
	rows: string[][];
}

/** The first pipe table under the first heading that matches any pattern. */
function readTable(markdown: string, headings: RegExp[]): Table | null {
	for (const heading of headings) {
		const match = heading.exec(markdown);
		if (!match) continue;
		const after = markdown.slice(match.index + match[0].length);
		// Stop at the next H2 so a table in a later section is never read.
		const section = after.split(/^## /m)[0];
		const lines = section.split(/\r?\n/);
		const start = lines.findIndex((line) => line.trim().startsWith("|"));
		if (start < 0) return null;
		const header = cells(lines[start]);
		// The separator row is |---|---|; skip it, then read until the table ends.
		const rows: string[][] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i];
			if (!line.trim().startsWith("|")) break;
			// A separator row has at least one dash per cell. The earlier form,
			// [\s:|-]+, also matched an all-blank row, which then never reached
			// the blank-row handling below and made that handling untestable.
			// UNTESTED BY CONSTRUCTION: loosening this back is an equivalent
			// mutant on every observable -- a swallowed blank row and a skipped
			// blank row both yield no slice and no error. The tight form is
			// here so the blank-row branch is REACHABLE, not because the loose
			// form misbehaved on real artifacts (checked: only a row of bare
			// colons distinguishes them).
			if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
			rows.push(cells(line));
		}
		return { header, rows };
	}
	return null;
}

function cells(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => cell.trim());
}

function column(table: Table, name: string): number {
	return table.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}

/** A comma-separated cell into a list, ignoring blanks. */
function list(cell: string | undefined): string[] {
	if (!cell) return [];
	return cell
		.split(/[,;]/)
		.map((part) => part.trim())
		.filter(Boolean);
}
