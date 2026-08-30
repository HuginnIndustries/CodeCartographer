// The scout-first pipeline (#139). Its whole point is routing Broad-Side leads
// into phases without letting a cheap batch model's guesses become findings,
// so the contract worth pinning is: who reads the brief, who must account for
// it, and that the variant has not silently drifted from the deep-audit
// pipeline it wraps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODECARTO = join(REPO_ROOT, ".codecarto");
const { parseSimpleYaml } = await import(pathToFileURL(`${REPO_ROOT}/core/yaml.ts`).href);
const { PIPELINE_ALIASES } = await import(pathToFileURL(`${REPO_ROOT}/core/pipeline.ts`).href);

const readPipeline = async (file) => parseSimpleYaml(await readFile(join(CODECARTO, "workflow", file), "utf8"));
const scoutFirst = await readPipeline("pipeline-scout-first.yaml");
const deepAudit = await readPipeline("pipeline-full-with-deep-audit.yaml");

const BRIEF = "findings/broadside-scout/scout-brief.md";
const RECEIVERS = ["architecture", "defect-scan-mechanical", "contracts", "protocols", "defect-scan-semantic", "porting"];

const phase = (pipeline, id) => pipeline.phases.find((p) => p.id === id);

test("scout-first is reachable by alias and leads with the scout phase", () => {
	assert.equal(PIPELINE_ALIASES["scout-first"], "workflow/pipeline-scout-first.yaml");
	assert.equal(scoutFirst.phase_order[0], "broadside-scout");
	assert.deepEqual(phase(scoutFirst, "broadside-scout").depends_on, [], "the scout phase gates on nothing");
	assert.equal(phase(scoutFirst, "broadside-scout").primary_output, BRIEF);
});

test("every phase that reads the brief must account for its leads at validation", () => {
	for (const id of RECEIVERS) {
		const p = phase(scoutFirst, id);
		assert.ok(p, `${id} should exist in scout-first`);
		assert.ok(p.required_reads.includes(BRIEF), `${id} must read the scout brief`);
		assert.ok(p.depends_on.includes("broadside-scout"), `${id} must depend on the scout phase`);
		// Reading the brief without a criterion that forces confirmation is how a
		// batch model's guess becomes a cited finding.
		const accounting = p.completion_criteria.filter((c) => /Broad-Side lead/i.test(c));
		assert.equal(accounting.length, 1, `${id} must carry exactly one lead-accounting criterion`);
		assert.match(accounting[0], /confirmed against the source|dismissed|carried forward/i);
		assert.match(accounting[0], /none is reported as a finding/i, `${id}'s criterion must forbid citing the brief`);
	}
});

test("the reimplementation phase keeps the porting bundle as its only compression boundary", () => {
	// The spec phase deliberately reads one upstream artifact. Feeding it raw
	// scout leads would reopen exactly the boundary that phase exists to hold.
	const spec = phase(scoutFirst, "reimplementation-spec");
	assert.ok(!spec.required_reads.includes(BRIEF), "reimplementation-spec must not read the scout brief");
	assert.ok(!spec.depends_on.includes("broadside-scout"));
});

test("scout-first differs from full-with-deep-audit only by the scout additions", () => {
	// The variant was derived from the deep-audit pipeline. If the two drift,
	// a user picking scout-first quietly gets a different analysis run.
	assert.deepEqual(
		scoutFirst.phase_order,
		["broadside-scout", ...deepAudit.phase_order],
		"scout-first must be the deep-audit order with the scout phase in front",
	);

	for (const id of deepAudit.phase_order) {
		const mine = phase(scoutFirst, id);
		const theirs = phase(deepAudit, id);
		assert.equal(mine.purpose, theirs.purpose, `${id}: purpose drifted`);
		assert.equal(mine.skill_path, theirs.skill_path, `${id}: skill_path drifted`);
		assert.equal(mine.output_template, theirs.output_template, `${id}: output_template drifted`);
		assert.equal(mine.primary_output, theirs.primary_output, `${id}: primary_output drifted`);
		assert.deepEqual(mine.secondary_outputs ?? [], theirs.secondary_outputs ?? [], `${id}: secondary_outputs drifted`);
		assert.deepEqual(mine.handoff_requirements, theirs.handoff_requirements, `${id}: handoff_requirements drifted`);

		assert.deepEqual(
			mine.depends_on.filter((dep) => dep !== "broadside-scout"),
			theirs.depends_on,
			`${id}: dependencies drifted beyond the scout edge`,
		);
		assert.deepEqual(
			mine.required_reads.filter((path) => path !== BRIEF),
			theirs.required_reads,
			`${id}: required_reads drifted beyond the scout brief`,
		);
		assert.deepEqual(
			mine.completion_criteria.filter((c) => !/Broad-Side lead/i.test(c)),
			theirs.completion_criteria,
			`${id}: completion_criteria drifted beyond the lead-accounting rule`,
		);
	}
});

test("the scout phase reads a run rather than paying for one", async () => {
	// A phase prompt that told an executor to submit batches would spend money
	// inside an unattended /codecarto-next --auto run.
	// Prose assertions run against a whitespace-normalized copy: the source is
	// hard-wrapped, so a sentence can straddle a newline.
	const skill = (await readFile(join(CODECARTO, "findings", "broadside-scout", "SKILL.md"), "utf8"))
		.replace(/\s+/g, " ");
	assert.match(skill, /never submits a batch/i, "the skill must state that it does not submit");
	assert.match(skill, /no completed run/i, "the skill must handle the no-run case");
	assert.match(skill, /do not submit one/i, "the no-run path must forbid firing a run to fill the gap");

	const criteria = phase(scoutFirst, "broadside-scout").completion_criteria;
	assert.ok(
		criteria.some((c) => /no completed Broad-Side run exists/i.test(c) && /does not block/i.test(c)),
		"a missing run must be a documented outcome, not a stall",
	);
	assert.ok(
		criteria.some((c) => /unverified scouting signal/i.test(c)),
		"the brief's own criteria must carry the leads-never-evidence rule",
	);
});
