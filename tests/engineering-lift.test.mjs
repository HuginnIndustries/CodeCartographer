// The slice lifter (E09): reads Slices out of a planning artifact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { liftSlices, MINIMUM_VIABLE_TIER } = await import(pathToFileURL(join(REPO_ROOT, "core/engineering/index.ts")).href);

const ARTIFACT = `# Spec

## Acceptance Scenarios

| Scenario ID | Tier | Scenario | Input | Expected Output / Side Effect |
|-------------|------|----------|-------|-------------------------------|
| S-01 | minimum-viable | boots | none | exit 0 |
| S-02 | minimum-viable | reads config | a file | values applied |
| S-03 | major-workflow | exports | a doc | a pdf |

## Slices

| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier |
|----------|-------------|---------|------------------|------------|------|
| SL-01 | a runnable binary | core, cli | S-01 | | minimum-viable |
| SL-02 | config loading | config | S-02 | SL-01 | minimum-viable |
| SL-03 | pdf export | export | S-03 | SL-01, SL-02 | major-workflow |

## Validation
`;

// ---------------------------------------------------------------------------
// The shipped templates are the cheapest detector for an invented rule: when
// a new rule refuses a fixture the repository ships as valid, the rule is
// wrong. Every template must lift with only the refusals its BLANK example
// row is expected to produce -- and no structural error at all.
// ---------------------------------------------------------------------------

for (const template of ["reimplementation-spec.md", "reimplementation-spec-opinionated.md", "project-plan.md"]) {
	test(`the shipped ${template} template lifts structurally clean`, async () => {
		const text = await readFile(join(REPO_ROOT, ".codecarto/templates", template), "utf8");
		const out = liftSlices(text);
		const structural = out.errors.filter((e) => e.code === "missing-section" || e.code === "missing-column");
		assert.deepEqual(structural, [], `template has a structural problem: ${JSON.stringify(structural)}`);
		// The template ships one example slice proving one example scenario,
		// which is a complete (if empty) plan. It must not be refused.
		assert.deepEqual(out.errors, [], `the template's own example is refused: ${JSON.stringify(out.errors)}`);
		assert.equal(out.slices.length, 1);
		assert.deepEqual(out.slices[0].scenario_ids, ["S-01"]);
	});
}

test("a well-formed artifact lifts into the record vocabulary", () => {
	const out = liftSlices(ARTIFACT);
	assert.deepEqual(out.errors, []);
	assert.equal(out.scenarios.length, 3);
	assert.equal(out.slices.length, 3);
	assert.deepEqual(out.slices[2], {
		id: "SL-03",
		deliverable: "pdf export",
		modules: ["export"],
		scenario_ids: ["S-03"],
		depends_on: ["SL-01", "SL-02"],
		tier: "major-workflow",
	});
});

test("an empty proof list is refused, in the words the skill uses", () => {
	const out = liftSlices(ARTIFACT.replace("| SL-03 | pdf export | export | S-03 |", "| SL-03 | pdf export | export |  |"));
	const hit = out.errors.filter((e) => e.code === "empty-proof-list");
	assert.equal(hit.length, 1, JSON.stringify(out.errors));
	assert.equal(hit[0].at, "SL-03");
	assert.match(hit[0].message, /empty proof list is not a plan/);
});

test("a slice naming a scenario that does not exist is refused", () => {
	const out = liftSlices(ARTIFACT.replace("| S-03 | SL-01, SL-02 |", "| S-99 | SL-01, SL-02 |"));
	const hit = out.errors.filter((e) => e.code === "unknown-scenario");
	assert.equal(hit.length, 1, JSON.stringify(out.errors));
	assert.match(hit[0].message, /S-99/);
});

test("a minimum-viable scenario owned by no slice is refused, and a non-minimum one is not", () => {
	// Drop SL-02, which was the only owner of S-02 (minimum-viable).
	const out = liftSlices(ARTIFACT.replace(/\| SL-02 \|[^\n]*\n/, "").replace("SL-01, SL-02", "SL-01"));
	const hit = out.errors.filter((e) => e.code === "unowned-minimum-viable");
	assert.deepEqual(hit.map((e) => e.at), ["S-02"], JSON.stringify(out.errors));
	// Negative control: unowning the major-workflow scenario is allowed.
	const relaxed = liftSlices(ARTIFACT.replace(/\| SL-03 \|[^\n]*\n/, ""));
	assert.deepEqual(relaxed.errors.filter((e) => e.code === "unowned-minimum-viable"), []);
});

test("an unknown or self dependency is refused", () => {
	const unknown = liftSlices(ARTIFACT.replace("| S-02 | SL-01 |", "| S-02 | SL-77 |"));
	assert.equal(unknown.errors.filter((e) => e.code === "unknown-dependency").length, 1, JSON.stringify(unknown.errors));
	const self = liftSlices(ARTIFACT.replace("| S-02 | SL-01 |", "| S-02 | SL-02 |"));
	assert.equal(self.errors.filter((e) => e.code === "self-dependency").length, 1, JSON.stringify(self.errors));
});

test("duplicate ids are refused rather than silently merged", () => {
	const out = liftSlices(ARTIFACT.replace("| SL-03 |", "| SL-01 |"));
	assert.equal(out.errors.filter((e) => e.code === "duplicate-id").length, 1, JSON.stringify(out.errors));
});

test("errors are a complete list, not a first failure", () => {
	// Three independent defects at once: a session fixing the artifact needs
	// all of them, and a reviewer needs to see nothing hid behind the first.
	const broken = ARTIFACT.replace("| SL-03 | pdf export | export | S-03 |", "| SL-03 | pdf export | export |  |") // empty proof
		.replace("| S-02 | SL-01 |", "| S-02 | SL-77 |") // unknown dep
		.replace(/\| S-01 \| minimum-viable \| boots[^\n]*\n/, ""); // S-01 vanishes -> SL-01 proves unknown
	const codes = new Set(liftSlices(broken).errors.map((e) => e.code));
	for (const expected of ["empty-proof-list", "unknown-dependency", "unknown-scenario"]) {
		assert.ok(codes.has(expected), `${expected} missing from ${[...codes]}`);
	}
});

test("a table in a later section is never read as the Slices table", () => {
	// The reader stops at the next H2. The heading must EXIST with no table
	// under it, and a slice-shaped table must follow in the next section;
	// otherwise the missing-heading path fires first and the boundary is
	// never exercised (the first version of this test made that mistake and
	// survived a mutation that removed the boundary entirely).
	const headingOnly = ARTIFACT.replace(/## Slices[\s\S]*?(?=## Validation)/, "## Slices\n\nTo be written.\n\n");
	const withTrailing = headingOnly + "\n| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier |\n|--|--|--|--|--|--|\n| SL-X | | | S-01 | | minimum-viable |\n";
	const out = liftSlices(withTrailing);
	assert.equal(out.slices.length, 0, "a table under Validation was read as slices");
	assert.ok(out.errors.some((e) => e.code === "missing-section" && e.at === "Slices"), JSON.stringify(out.errors));
});

test("a fully blank row is ignored, but a row with content and no id is refused", () => {
	// Dropping a row the author filled would lose a slice silently and count
	// ownership against a table the author did not see. Fail closed.
	const blank = liftSlices(ARTIFACT.replace("| SL-03 | pdf export | export | S-03 | SL-01, SL-02 | major-workflow |", "|  |  |  |  |  |  |"));
	assert.deepEqual(blank.errors, [], JSON.stringify(blank.errors));
	assert.equal(blank.slices.length, 2);
	const noId = liftSlices(ARTIFACT.replace("| SL-03 | pdf export |", "|  | pdf export |"));
	const hit = noId.errors.filter((e) => e.code === "missing-id");
	assert.equal(hit.length, 1, JSON.stringify(noId.errors));
	assert.match(hit[0].at, /Slices row 3/);
	const noScenarioId = liftSlices(ARTIFACT.replace("| S-03 | major-workflow |", "|  | major-workflow |"));
	assert.ok(noScenarioId.errors.some((e) => e.code === "missing-id" && /Acceptance Scenarios row 3/.test(e.at)), JSON.stringify(noScenarioId.errors));
});

test("the opinionated Proof command column lifts when present and is absent otherwise", () => {
	const withProof = ARTIFACT.replace("| Depends on | Tier |", "| Depends on | Tier | Proof command |")
		.replace("|------------|------|", "|------------|------|---------------|")
		.replace("| S-01 | | minimum-viable |", "| S-01 | | minimum-viable | make test |")
		.replace("| S-02 | SL-01 | minimum-viable |", "| S-02 | SL-01 | minimum-viable | |")
		.replace("| S-03 | SL-01, SL-02 | major-workflow |", "| S-03 | SL-01, SL-02 | major-workflow | |");
	const out = liftSlices(withProof);
	assert.deepEqual(out.errors, [], JSON.stringify(out.errors));
	assert.equal(out.slices[0].proof_command, "make test");
	assert.equal("proof_command" in out.slices[1], false, "an empty proof cell produced a key");
	assert.equal("proof_command" in liftSlices(ARTIFACT).slices[0], false);
});

test("MINIMUM_VIABLE_TIER is the exact string the templates use", async () => {
	// If the constant and the template drift, ownership checking silently
	// stops applying to anything. Pin them together.
	assert.equal(MINIMUM_VIABLE_TIER, "minimum-viable");
	for (const template of ["reimplementation-spec.md", "project-plan.md"]) {
		const text = await readFile(join(REPO_ROOT, ".codecarto/templates", template), "utf8");
		assert.ok(text.includes(`| ${MINIMUM_VIABLE_TIER} |`), `${template} does not use the tier string the lifter checks`);
	}
});

// ---------------------------------------------------------------------------
// Agreement with E04. The point of lifting is that a plan derived from an
// artifact can be handed straight to buildChangePlan. So test the two halves
// TOGETHER: what lifts clean must plan clean, and what the lifter refuses the
// planner must refuse on the same ground. Two checks that agree with each
// other are worth more than two that are each individually plausible.
// ---------------------------------------------------------------------------

const { buildChangePlan, buildChangeBrief } = await import(pathToFileURL(join(REPO_ROOT, "core/engineering/index.ts")).href);

/** Turn a lifted artifact into a change request + slice inputs, the way a planner would. */
function planFromLift(out) {
	const request = {
		title: "port the thing",
		mode: "feature",
		requested_outcome: "the lifted plan is executable",
		baseline: { vcs: "git", head: "a".repeat(40), description: "main" },
		scope: { in_scope: ["src/**"], non_goals: [] },
		preserved_contracts: [],
		acceptance_scenarios: out.scenarios.map((s) => ({ id: s.id, kind: "behavior", description: s.description })), // verbatim, same reason as below
	};
	// Carry the lifted text and dependencies through VERBATIM. The first
	// version of this helper substituted `s.deliverable || s.id` and blanked
	// depends_on, which silently repaired an empty deliverable and made a
	// dependency cycle invisible to E04 -- so the agreement tests could not
	// see two real disagreements (review E09-01, E09-03).
	const slices = out.slices.map((s) => ({
		id: s.id,
		title: s.deliverable,
		deliverable: s.deliverable,
		scenario_ids: s.scenario_ids,
		depends_on: s.depends_on,
		proof_obligations: s.scenario_ids.map((sid, i) => ({
			id: `${s.id}-o${i + 1}`,
			scenario_id: sid,
			check_kind: "test",
			description: `observe ${sid}`,
			minimum_collector: "host-observed",
		})),
		permitted_scope: { paths: ["src/**"] },
	}));
	return { request, slices };
}

test("agreement: an artifact that lifts clean plans clean in E04", () => {
	const out = liftSlices(ARTIFACT);
	assert.deepEqual(out.errors, []);
	const { request, slices } = planFromLift(out);
	assert.equal(buildChangeBrief(request).ok, true);
	const plan = buildChangePlan(request, slices);
	assert.equal(plan.ok, true, JSON.stringify(plan.errors ?? plan));
});

test("agreement: an empty proof list is refused by BOTH the lifter and E04, on the same ground", () => {
	const out = liftSlices(ARTIFACT.replace("| SL-03 | pdf export | export | S-03 |", "| SL-03 | pdf export | export |  |"));
	assert.ok(out.errors.some((e) => e.code === "empty-proof-list"));
	// Hand the same slices through anyway, as a careless planner would.
	const { request, slices } = planFromLift(out);
	const plan = buildChangePlan(request, slices);
	assert.equal(plan.ok, false, "E04 accepted a slice the lifter refused");
	assert.ok(JSON.stringify(plan.errors).match(/scenario/i), JSON.stringify(plan.errors));
});

test("agreement: a scenario id the artifact does not define is refused by both", () => {
	const out = liftSlices(ARTIFACT.replace("| S-03 | SL-01, SL-02 |", "| S-99 | SL-01, SL-02 |"));
	assert.ok(out.errors.some((e) => e.code === "unknown-scenario"));
	const { request, slices } = planFromLift(out);
	assert.equal(buildChangePlan(request, slices).ok, false, "E04 accepted a slice proving an undefined scenario");
});

test("the ids the templates teach (S-01, SL-01) are valid E01 local ids", async () => {
	// The template's example ids are what sessions will copy. If they did
	// not satisfy the record grammar, every lifted plan would be refused at
	// the store for a reason invisible in the artifact.
	const { isLocalId } = await import(pathToFileURL(join(REPO_ROOT, "core/engineering/index.ts")).href);
	for (const id of ["S-01", "SL-01", "S-12", "SL-07"]) assert.equal(isLocalId(id), true, `${id} is not a valid local id`);
});

// ---------------------------------------------------------------------------
// Compatibility with artifacts that predate E09. The repository ships two
// real self-audit specs written against the old template. They must not lift
// (they have no Slices), and the refusal must say EVERYTHING that is missing
// -- an early return on the first missing section hid the second, which a
// session converting the artifact needs to know about in the same pass.
// ---------------------------------------------------------------------------

test("a pre-E09 self-audit spec is refused with every missing structure named at once", async () => {
	const path = join(REPO_ROOT, "self-audit/2026-09-15-v0.25.0-full-with-deep-audit/findings/reimplementation-spec/reimplementation-spec.md");
	const out = liftSlices(await readFile(path, "utf8"));
	assert.equal(out.slices.length, 0);
	const codes = out.errors.map((e) => `${e.code}@${e.at}`);
	assert.ok(codes.includes("missing-section@Slices"), codes.join(", "));
	// The old acceptance table exists but has no Scenario ID / Tier columns.
	// Both facts must be reported, not just the first one found.
	assert.ok(codes.includes("missing-column@Acceptance Scenarios"), `old acceptance table's missing columns not reported: ${codes.join(", ")}`);
	assert.ok(out.errors.some((e) => /Scenario ID/.test(e.message)), "did not name the Scenario ID column");
	assert.ok(out.errors.some((e) => /Tier/.test(e.message)), "did not name the Tier column");
});

test("an id the record store would refuse is refused HERE, where the author can fix it", async () => {
	// E04's buildChangePlan does not check id grammar; only the store (E01)
	// does. Without this check an artifact lifts clean, plans clean, and is
	// refused three steps later for a reason invisible in the document.
	// Found while trying to break the agreement claim: "S 01" lifted and
	// planned, and validateRecordOfKind refused it with invalid-local-id.
	const { validateRecordOfKind } = await import(pathToFileURL(join(REPO_ROOT, "core/engineering/index.ts")).href);
	for (const [bad, where] of [["S 01", "scenario"], ["S/01", "scenario"], ["S-" + "x".repeat(70), "scenario"], ["SL 01", "slice"], [".SL-01", "slice"]]) {
		const text = where === "scenario"
			? ARTIFACT.replace("| S-01 | minimum-viable |", `| ${bad} | minimum-viable |`).replace("| S-01 | | minimum-viable |", `| ${bad} | | minimum-viable |`)
			: ARTIFACT.replace("| SL-01 | a runnable binary", `| ${bad} | a runnable binary`).replace("| SL-01 |", `| ${bad} |`).replace("SL-01, SL-02", `${bad}, SL-02`);
		const out = liftSlices(text);
		const hit = out.errors.filter((e) => e.code === "invalid-id");
		assert.equal(hit.length, 1, `${where} id ${JSON.stringify(bad)}: ${JSON.stringify(out.errors)}`);
		assert.equal(hit[0].at, bad);
	}
	// Agreement in the other direction: what the lifter accepts, the store's
	// grammar accepts. Every id the clean fixture uses passes E01.
	const clean = liftSlices(ARTIFACT);
	const now = "2026-09-22T12:00:00Z";
	for (const s of clean.slices) {
		const record = validateRecordOfKind("slice", {
			schema_version: 1, kind: "slice", id: "slc_0123456789abcdef01234567", created_at: now, updated_at: now,
			change_id: "chg_0123456789abcdef01234567", revision: 1, title: s.deliverable, deliverable: s.deliverable,
			scenario_ids: s.scenario_ids, depends_on: [],
			proof_obligations: s.scenario_ids.map((sid, i) => ({ id: `o${i + 1}`, scenario_id: sid, check_kind: "test", description: "d", minimum_collector: "host-observed" })),
			permitted_scope: { paths: ["src/**"] }, state: "planned",
		});
		const idErrors = (record.errors ?? []).filter((e) => e.code === "invalid-local-id");
		assert.deepEqual(idErrors, [], `store refused an id the lifter accepted: ${JSON.stringify(idErrors)}`);
	}
});

// ---------------------------------------------------------------------------
// Review regressions (deleg_1ebf14c6). Each was a live reproduction against
// the previous reader; each is now a refusal with a reason the author can act
// on. The reader's rules are GFM's, not a regex approximation.
// ---------------------------------------------------------------------------

test("E09-01: a dependency cycle is refused by BOTH halves, in the same words", () => {
	const cyc = ARTIFACT.replace("| S-01 | | minimum-viable |", "| S-01 | SL-02 | minimum-viable |"); // SL-01 -> SL-02 -> SL-01
	const out = liftSlices(cyc);
	const hit = out.errors.filter((e) => e.code === "dependency-cycle");
	assert.equal(hit.length, 1, JSON.stringify(out.errors));
	assert.match(hit[0].message, /SL-01 -> SL-02 -> SL-01/);
	const { request, slices } = planFromLift(out);
	const plan = buildChangePlan(request, slices);
	assert.equal(plan.ok, false);
	assert.match(JSON.stringify(plan.errors), /dependency cycle/);
	// Indirect cycle too: SL-01 -> SL-03 -> SL-02 -> SL-01.
	const indirect = ARTIFACT.replace("| S-01 | | minimum-viable |", "| S-01 | SL-03 | minimum-viable |");
	assert.ok(liftSlices(indirect).errors.some((e) => e.code === "dependency-cycle"));
	// And the clean fixture, with its real dependencies carried, still plans.
	const clean = planFromLift(liftSlices(ARTIFACT));
	assert.equal(buildChangePlan(clean.request, clean.slices).ok, true);
});

test("E09-02: a GFM row without a leading pipe is read, not dropped with every row after it", () => {
	const text = ARTIFACT.replace("| SL-02 | config loading | config | S-02 | SL-01 | minimum-viable |", "SL-02 | config loading | config | S-02 | SL-01 | minimum-viable |");
	const out = liftSlices(text);
	assert.deepEqual(out.slices.map((s) => s.id), ["SL-01", "SL-02", "SL-03"]);
	assert.deepEqual(out.errors, []);
});

test("E09-02: a blank line between rows does not end the table; prose between rows is refused", () => {
	const blank = ARTIFACT.replace("| SL-02 |", "\n| SL-02 |");
	assert.deepEqual(liftSlices(blank).slices.map((s) => s.id), ["SL-01", "SL-02", "SL-03"]);
	const prose = ARTIFACT.replace("| SL-02 |", "(the following are stretch goals)\n| SL-02 |");
	const out = liftSlices(prose);
	const hit = out.errors.filter((e) => e.code === "interrupted-table");
	assert.equal(hit.length, 1, JSON.stringify(out.errors));
	assert.match(hit[0].message, /stretch goals/);
	// Prose AFTER the last row is ordinary and not an interruption.
	const trailing = ARTIFACT.replace("\n## Validation", "\nSee also the non-goals.\n\n## Validation");
	assert.deepEqual(liftSlices(trailing).errors, []);
});

test("E09-03/04: an empty deliverable or scenario description is refused here, as E04 refuses it", () => {
	const noDeliverable = liftSlices(ARTIFACT.replace("| SL-03 | pdf export |", "| SL-03 |  |"));
	assert.ok(noDeliverable.errors.some((e) => e.code === "empty-deliverable" && e.at === "SL-03"), JSON.stringify(noDeliverable.errors));
	const p1 = planFromLift(noDeliverable);
	assert.equal(buildChangePlan(p1.request, p1.slices).ok, false);
	const noDesc = liftSlices(ARTIFACT.replace("| S-03 | major-workflow | exports |", "| S-03 | major-workflow |  |"));
	assert.ok(noDesc.errors.some((e) => e.code === "empty-description" && e.at === "S-03"), JSON.stringify(noDesc.errors));
	const p2 = planFromLift(noDesc);
	assert.equal(buildChangeBrief(p2.request).ok, false);
});

test("E09-05: the delimiter row is the line after the header and nothing else; a '-' placeholder row is content", () => {
	// A row of dashes as "not applicable" markers is a data row. The old
	// separator regex swallowed it. Now it is read, and refused for what it
	// is: a row with content but no valid id.
	const placeholder = ARTIFACT.replace("| SL-03 | pdf export | export | S-03 | SL-01, SL-02 | major-workflow |", "| - | - | - | - | - | - |");
	const out = liftSlices(placeholder);
	assert.ok(out.errors.some((e) => e.code === "invalid-id" && e.at === "-"), JSON.stringify(out.errors));
	// A header NOT followed by a delimiter row is not a table.
	const noDelim = ARTIFACT.replace("|----------|-------------|---------|------------------|------------|------|\n", "");
	assert.ok(liftSlices(noDelim).errors.some((e) => e.code === "malformed-table" && e.at === "Slices"));
});

test("E09-06: a misspelled column does not suppress the row-level defects in columns that exist", () => {
	const text = ARTIFACT.replace("| Modules |", "| Module |")
		.replace("| SL-03 | pdf export | export | S-03 |", "| SL-03 | pdf export | export |  |") // empty proof
		.replace("| SL-02 | config loading", "| SL-01 | config loading"); // duplicate id
	const codes = liftSlices(text).errors.map((e) => e.code);
	for (const expected of ["missing-column", "empty-proof-list", "duplicate-id"]) {
		assert.ok(codes.includes(expected), `${expected} hidden behind the column error: ${codes}`);
	}
});

test("E09-07: an indented table (legal GFM) is read; no phantom '---' slice", () => {
	const indented = ARTIFACT.replace(/^\| (SL|Slice|-)/gm, "   | $1").replace(/^\|--/gm, "   |--");
	const out = liftSlices(indented);
	assert.deepEqual(out.slices.map((s) => s.id), ["SL-01", "SL-02", "SL-03"]);
	assert.deepEqual(out.errors, []);
});

test("E09-08: a table inside a fenced code block is invisible; a duplicated heading is refused, not picked", () => {
	const fenced = ARTIFACT.replace("## Slices", "Example of the shape:\n\n```markdown\n## Slices\n\n| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier |\n|--|--|--|--|--|--|\n| SL-EXAMPLE | x | m | S-01 | | minimum-viable |\n```\n\n## Slices");
	const out = liftSlices(fenced);
	assert.deepEqual(out.slices.map((s) => s.id), ["SL-01", "SL-02", "SL-03"], JSON.stringify(out.errors));
	assert.deepEqual(out.errors, []);
	const twice = ARTIFACT.replace("## Validation", "## Slices\n\n_TBD_\n\n## Validation");
	const dup = liftSlices(twice);
	assert.ok(dup.errors.some((e) => e.code === "duplicate-section" && e.at === "Slices"), JSON.stringify(dup.errors));
	assert.equal(dup.slices.length, 0);
});

test("E09-09: an escaped pipe is one cell; a genuinely ragged row is refused by cell count", () => {
	const escaped = ARTIFACT.replace("| SL-01 | a runnable binary |", "| SL-01 | a runnable \\| static binary |");
	const out = liftSlices(escaped);
	assert.deepEqual(out.errors, [], JSON.stringify(out.errors));
	assert.equal(out.slices[0].deliverable, "a runnable | static binary");
	const ragged = ARTIFACT.replace("| SL-01 | a runnable binary |", "| SL-01 | a runnable | binary |");
	const hit = liftSlices(ragged).errors.filter((e) => e.code === "ragged-row");
	assert.equal(hit.length, 1);
	assert.match(hit[0].at, /Slices row 1/);
});

test("CRLF artifacts lift identically to LF", () => {
	const lf = liftSlices(ARTIFACT);
	const crlf = liftSlices(ARTIFACT.replace(/\n/g, "\r\n"));
	assert.deepEqual(crlf, lf);
});

test("an indented fence (1-3 spaces, legal GFM) is still a fence", () => {
	// Survived mutation until this test: dropping the \s{0,3} from the fence
	// regex made an indented example block visible, and its example heading
	// turned into a duplicate-section refusal of the real table.
	const text = ARTIFACT.replace("## Slices", "  ```markdown\n## Slices\n\n| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier |\n|--|--|--|--|--|--|\n| SL-EX | x | m | S-01 | | minimum-viable |\n  ```\n\n## Slices");
	const out = liftSlices(text);
	assert.deepEqual(out.errors, [], JSON.stringify(out.errors));
	assert.deepEqual(out.slices.map((s) => s.id), ["SL-01", "SL-02", "SL-03"]);
});

test("a self-dependency is reported once, not also as a one-node cycle", () => {
	// The cycle walk skips self-edges because self-dependency already names
	// them. Without the skip the author sees the same defect twice with two
	// different codes and fixes it once, then wonders about the other.
	const out = liftSlices(ARTIFACT.replace("| S-02 | SL-01 |", "| S-02 | SL-02 |"));
	assert.deepEqual(out.errors.map((e) => e.code), ["self-dependency"], JSON.stringify(out.errors));
});

// ---------------------------------------------------------------------------
// E10: the verification route. A column the lifter ignored would leave the
// route in the document and out of the plan, which is the seam E10 opens.
// ---------------------------------------------------------------------------

const ROUTED = ARTIFACT.replace("| Depends on | Tier |", "| Depends on | Tier | Verification route |")
	.replace("|------------|------|", "|------------|------|--------------------|")
	.replace("| S-01 | | minimum-viable |", "| S-01 | | minimum-viable | test |")
	.replace("| S-02 | SL-01 | minimum-viable |", "| S-02 | SL-01 | minimum-viable | run |")
	.replace("| S-03 | SL-01, SL-02 | major-workflow |", "| S-03 | SL-01, SL-02 | major-workflow | manual-procedure |");

test("E10: a verification route lifts in E01's check_kind vocabulary, and is absent when the column is", () => {
	const out = liftSlices(ROUTED);
	assert.deepEqual(out.errors, [], JSON.stringify(out.errors));
	assert.deepEqual(out.slices.map((s) => s.verification_route), ["test", "run", "manual-procedure"]);
	assert.equal("verification_route" in liftSlices(ARTIFACT).slices[0], false, "a route appeared with no column");
});

test("E10: `none` is a recorded gap that refuses the slice; a blank route is refused; a made-up route is refused", () => {
	const none = liftSlices(ROUTED.replace("| major-workflow | manual-procedure |", "| major-workflow | none |"));
	const gap = none.errors.filter((e) => e.code === "no-route");
	assert.equal(gap.length, 1, JSON.stringify(none.errors));
	assert.equal(gap[0].at, "SL-03");
	assert.match(gap[0].message, /gap.*not a pass/);
	assert.equal(none.slices[2].verification_route, "none", "the gap is still recorded on the slice");
	const blank = liftSlices(ROUTED.replace("| major-workflow | manual-procedure |", "| major-workflow |  |"));
	assert.ok(blank.errors.some((e) => e.code === "no-route" && e.at === "SL-03"), JSON.stringify(blank.errors));
	const bogus = liftSlices(ROUTED.replace("| major-workflow | manual-procedure |", "| major-workflow | click through the UI |"));
	const hit = bogus.errors.filter((e) => e.code === "unknown-route");
	assert.equal(hit.length, 1, JSON.stringify(bogus.errors));
	assert.match(hit[0].message, /manual-procedure/, "the refusal must name the vocabulary the author should use");
});

test("E10: every route the templates teach is a real E01 check_kind, and the shipped templates lift with a route", async () => {
	const { CHECK_KINDS } = await import(pathToFileURL(join(REPO_ROOT, "core/engineering/index.ts")).href);
	for (const template of ["reimplementation-spec.md", "reimplementation-spec-opinionated.md"]) {
		const text = await readFile(join(REPO_ROOT, ".codecarto/templates", template), "utf8");
		const out = liftSlices(text);
		assert.deepEqual(out.errors, [], `${template}: ${JSON.stringify(out.errors)}`);
		assert.ok(CHECK_KINDS.includes(out.slices[0].verification_route), `${template} example route ${out.slices[0].verification_route} is not a check_kind`);
		// The template's instructions name only real kinds (plus none).
		const slices = text.split(/^## Slices\s*$/im)[1].split(/^## /m)[0];
		for (const named of slices.match(/`([a-z-]+)`/g).map((m) => m.slice(1, -1))) {
			assert.ok(CHECK_KINDS.includes(named) || named === "none", `${template} teaches route \`${named}\`, which E01 does not know`);
		}
	}
});

test("E10: an artifact written before the route column existed lifts exactly as it did, with no route and no route errors", async () => {
	// Old workspaces stay compatible: the column is the opt-in. The shipped
	// v0.25.0 self-audit spec predates E09 and E10 both; its E09-era errors
	// are pinned elsewhere, and E10 must add none.
	const old = await readFile(join(REPO_ROOT, "self-audit/2026-09-15-v0.25.0-full-with-deep-audit/findings/reimplementation-spec/reimplementation-spec.md"), "utf8");
	const out = liftSlices(old);
	assert.equal(out.errors.filter((e) => e.code === "no-route" || e.code === "unknown-route").length, 0, JSON.stringify(out.errors));
	assert.ok(out.slices.every((s) => !("verification_route" in s)));
	// And the E09-era artifact used in the agreement tests, likewise.
	const e09 = liftSlices(ARTIFACT);
	assert.deepEqual(e09.errors, []);
	assert.ok(e09.slices.every((s) => !("verification_route" in s)));
});
