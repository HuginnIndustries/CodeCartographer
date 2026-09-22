// Pipeline-shape invariants. Catches the PR4-class issue (someone edits a
// pipeline YAML but breaks the dependency DAG / required_reads chain) and the
// PR5-class issue (a SKILL.md cites a report path that doesn't exist for the
// active pipelines).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODECARTO = join(REPO_ROOT, ".codecarto");

const { parseSimpleYaml } = await import(pathToFileURL(`${REPO_ROOT}/core/yaml.ts`).href);

async function loadPipelines() {
	const pipelinesDir = join(CODECARTO, "workflow");
	const files = (await readdir(pipelinesDir)).filter((f) => f.startsWith("pipeline") && f.endsWith(".yaml"));
	const pipelines = {};
	for (const f of files) {
		pipelines[f] = parseSimpleYaml(await readFile(join(pipelinesDir, f), "utf8"));
	}
	return pipelines;
}

const pipelines = await loadPipelines();
const STATIC_READS = new Set(["GUIDE.md", "workflow/status.yaml"]);

for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
	test(`${pipelineFile}: phase_order matches phases[*].id`, () => {
		const phaseIds = pipeline.phases.map((p) => p.id);
		assert.deepEqual(
			phaseIds,
			pipeline.phase_order,
			`phase_order ${JSON.stringify(pipeline.phase_order)} != phase ids ${JSON.stringify(phaseIds)}`,
		);
	});

	test(`${pipelineFile}: every depends_on references a real phase`, () => {
		const phaseIds = new Set(pipeline.phases.map((p) => p.id));
		for (const phase of pipeline.phases) {
			for (const dep of phase.depends_on ?? []) {
				assert.ok(phaseIds.has(dep), `phase ${phase.id} depends on unknown phase ${dep}`);
			}
		}
	});

	test(`${pipelineFile}: dependency DAG walks cleanly through phase_order`, () => {
		const completed = new Set();
		for (const phaseId of pipeline.phase_order) {
			const phase = pipeline.phases.find((p) => p.id === phaseId);
			for (const dep of phase.depends_on ?? []) {
				assert.ok(
					completed.has(dep),
					`phase ${phaseId} depends on ${dep} which appears later in phase_order`,
				);
			}
			completed.add(phaseId);
		}
	});

	test(`${pipelineFile}: every required_read is GUIDE/status or an upstream primary_output`, () => {
		const upstreamProducerOf = new Map();
		for (let i = 0; i < pipeline.phase_order.length; i++) {
			const upstream = new Set();
			for (let j = 0; j < i; j++) {
				const earlier = pipeline.phases.find((p) => p.id === pipeline.phase_order[j]);
				if (earlier?.primary_output) upstream.add(earlier.primary_output);
			}
			upstreamProducerOf.set(pipeline.phase_order[i], upstream);
		}
		for (const phase of pipeline.phases) {
			const upstream = upstreamProducerOf.get(phase.id);
			for (const path of phase.required_reads ?? []) {
				if (STATIC_READS.has(path)) continue;
				assert.ok(
					upstream.has(path),
					`phase ${phase.id} required_read ${path} is not produced by any upstream phase (or is misspelled)`,
				);
			}
		}
	});

	test(`${pipelineFile}: skill_path and output_template files exist on disk`, async () => {
		for (const phase of pipeline.phases) {
			if (phase.skill_path) {
				await assert.doesNotReject(
					stat(join(CODECARTO, phase.skill_path)),
					`phase ${phase.id} skill_path ${phase.skill_path} not found on disk`,
				);
			}
			if (phase.output_template) {
				await assert.doesNotReject(
					stat(join(CODECARTO, phase.output_template)),
					`phase ${phase.id} output_template ${phase.output_template} not found on disk`,
				);
			}
		}
	});
}

// Cross-pipeline: report paths cited in SKILL/template prose must be produced
// by SOME phase in SOME pipeline (as primary_output or secondary_outputs).
// This is the PR5 catch — porting/SKILL.md citing
// findings/defect-scan/defect-report.md should still resolve back to the
// full-with-audit pipeline that produces that report.
test("findings/*/SKILL.md and templates/*.md cite only paths that some pipeline produces", async () => {
	const producedPaths = new Set();
	for (const pipeline of Object.values(pipelines)) {
		for (const phase of pipeline.phases) {
			if (phase.primary_output) producedPaths.add(phase.primary_output);
			for (const secondary of phase.secondary_outputs ?? []) {
				if (secondary.path) producedPaths.add(secondary.path);
			}
		}
	}
	// Also accept "Place at: <path>" declarations in template files. These are
	// post-pipeline skill outputs that templates intentionally self-document.
	const templateFiles = (await readdir(join(CODECARTO, "templates"))).filter((f) => f.endsWith(".md"));
	for (const f of templateFiles) {
		const content = await readFile(join(CODECARTO, "templates", f), "utf8");
		for (const m of content.matchAll(/Place at:\s*([a-z0-9_./-]+\.md)/gi)) {
			producedPaths.add(m[1]);
		}
	}

	function citedPaths(text) {
		const matches = text.matchAll(/findings\/[a-z0-9_-]+(?:\/[a-z0-9_.-]+)+\.md/gi);
		return [...new Set([...matches].map((m) => m[0]))];
	}

	const findingsDir = join(CODECARTO, "findings");
	const templatesDir = join(CODECARTO, "templates");
	const skillFiles = [];
	for (const subdir of await readdir(findingsDir)) {
		const skill = join(findingsDir, subdir, "SKILL.md");
		try {
			await stat(skill);
			skillFiles.push(skill);
		} catch {}
	}
	for (const f of await readdir(templatesDir)) {
		if (f.endsWith(".md")) skillFiles.push(join(templatesDir, f));
	}

	const orphaned = [];
	for (const file of skillFiles) {
		const content = await readFile(file, "utf8");
		for (const path of citedPaths(content)) {
			if (producedPaths.has(path)) continue;
			try {
				await stat(join(CODECARTO, path));
			} catch {
				orphaned.push({ file: file.replace(`${REPO_ROOT}/`, ""), path });
			}
		}
	}
	assert.deepEqual(
		orphaned,
		[],
		`SKILL/template files cite findings/* paths that no pipeline produces and no framework file on disk supplies:\n${orphaned.map((b) => `  ${b.file} → ${b.path}`).join("\n")}`,
	);
});

test("every phase template and completion criteria require coverage and limits accounting", async () => {
	const checkedTemplates = new Set();
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		for (const phase of pipeline.phases) {
			assert.ok(
				(phase.completion_criteria ?? []).some((criterion) => /coverage/i.test(criterion)),
				`${pipelineFile}:${phase.id} lacks a coverage completion criterion`,
			);
			if (!phase.output_template || checkedTemplates.has(phase.output_template)) continue;
			checkedTemplates.add(phase.output_template);
			const template = await readFile(join(CODECARTO, phase.output_template), "utf8");
			assert.match(template, /^## Coverage and limits\s*$/im, `${phase.output_template} lacks a Coverage and limits section`);
			const validation = template.split(/^## Validation\s*$/im)[1] ?? "";
			assert.match(validation, /Coverage and limits name inspected scope/i, `${phase.output_template} validation table omits coverage accounting`);
			if (phase.id === "porting") assert.match(validation, /Source Index.*compression boundary/i, `${phase.output_template} validation table omits its compression-boundary criterion`);
			if (phase.id === "reimplementation-spec") assert.match(validation, /Lower-level findings are deep-read only/i, `${phase.output_template} validation table omits selective deep-read accounting`);
		}
	}
});

test("reimplementation phases use the porting bundle as the default compression boundary", () => {
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		const phase = pipeline.phases.find((candidate) => candidate.id === "reimplementation-spec");
		if (!phase) continue;
		assert.ok(phase.required_reads.includes("findings/porting/reverse-engineering-bundle.md"), `${pipelineFile} must require the porting bundle`);
		const lowerLevel = phase.required_reads.filter((path) => path.startsWith("findings/") && path !== "findings/porting/reverse-engineering-bundle.md");
		assert.deepEqual(lowerLevel, [], `${pipelineFile} should selectively deep-read lower-level findings instead of requiring them all`);
	}
});

// Guard against the pre-v0.12.0 wording resurfacing: phase workflow state is
// framework-owned, so no pipeline may instruct the agent to edit
// workflow/status.yaml or append THREAD_LOG.md directly — the phase handoff at
// scratch/handoffs/<phase>.yaml is the only state channel (issue #83).
test("no pipeline instructs direct edits of framework-owned state", () => {
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		for (const phase of pipeline.phases) {
			const lines = [...(phase.handoff_requirements ?? []), ...(phase.completion_criteria ?? [])];
			for (const line of lines) {
				assert.ok(
					!/update\s+workflow\/status\.yaml/i.test(line),
					`${pipelineFile}:${phase.id} instructs editing framework-owned workflow/status.yaml — route state through scratch/handoffs/<phase>.yaml: "${line}"`,
				);
				assert.ok(
					!/append[^.\n]*THREAD_LOG\.md/i.test(line),
					`${pipelineFile}:${phase.id} instructs appending framework-owned THREAD_LOG.md — completion writes it from the handoff: "${line}"`,
				);
				assert.ok(
					!/carry_forward\s+in\s+workflow\/status\.yaml/i.test(line),
					`${pipelineFile}:${phase.id} routes carry_forward entries to status.yaml — route them via the phase handoff: "${line}"`,
				);
			}
			if (phase.handoff_requirements?.length) {
				assert.ok(
					phase.handoff_requirements.some((line) => line.includes("scratch/handoffs/") || /phase handoff/i.test(line)),
					`${pipelineFile}:${phase.id} handoff_requirements never mention the phase handoff`,
				);
			}
		}
	}
});

test("NEW_THREAD_BLURB.md matches the framework-owned state contract", async () => {
	const blurb = await readFile(join(CODECARTO, "NEW_THREAD_BLURB.md"), "utf8");
	assert.ok(blurb.includes("scratch/handoffs/"), "blurb must route state changes through the phase handoff");
	assert.ok(!/update\s+`?workflow\/status\.yaml`?:/i.test(blurb), "blurb must not instruct editing framework-owned status.yaml");
	assert.ok(!/append[^.\n]*THREAD_LOG\.md/i.test(blurb), "blurb must not instruct appending framework-owned THREAD_LOG.md");
});

// #86 fixed the pipelines and NEW_THREAD_BLURB but left the same pre-v0.12.0
// wording in the files a session reads while producing output: phase output
// templates, VALIDATE.md, and SKILL.md. A session that follows a template
// telling it to "mirror these into workflow/status.yaml" writes a prose table
// and no state, which is exactly how a real run lost every carry_forward entry.
// Reads of status.yaml stay legal — completion does put the entries there.
test("no framework instruction file tells a session to write framework-owned state", async () => {
	const scanned = [];
	for (const name of await readdir(join(CODECARTO, "templates"))) {
		if (name.endsWith(".md")) scanned.push(join("templates", name));
	}
	for (const subdir of await readdir(join(CODECARTO, "findings"))) {
		const skill = join("findings", subdir, "SKILL.md");
		try {
			await stat(join(CODECARTO, skill));
			scanned.push(skill);
		} catch {
			// Not every findings/ subdirectory carries a SKILL.md.
		}
	}
	scanned.push(join("workflow", "VALIDATE.md"), "GUIDE.md", "NEW_THREAD_BLURB.md", "CONTRIBUTING.md");

	// Post-pipeline skills run after the pipeline is complete and never reach
	// completeValidatedPhase, so they legitimately write their own closeout and
	// THREAD_LOG entry. Phase state stays framework-owned for them regardless.
	const postPipelineSkills = [];
	try {
		for (const subdir of await readdir(join(CODECARTO, "skills"))) {
			const skill = join("skills", subdir, "SKILL.md");
			try {
				await stat(join(CODECARTO, skill));
				postPipelineSkills.push(skill);
			} catch {
				// Not every skills/ subdirectory carries a SKILL.md.
			}
		}
	} catch {
		// A scaffold without any post-pipeline skills is valid.
	}

	// Each pattern is an imperative to WRITE a framework-owned file. Phrases
	// that merely reference or read one must not match.
	const forbidden = [
		{ re: /mirror\s+(?:these|them|it)\s+into\s+(?:`?workflow\/)?status\.yaml/i, why: "mirror-into-status.yaml" },
		{ re: /record\s+it\s+(?:as|under)[^.\n]*\bin\s+`?(?:workflow\/)?status\.yaml`?/i, why: "record-into-status.yaml" },
		// Catches the bare filename and the list form:
		// "update `status.yaml`", "update `CONVENTIONS.md` / `DECISIONS.md` / `workflow/status.yaml`".
		// The list-item class excludes the "/" separator so an item and the
		// delimiter can never both claim the same character — that ambiguity is
		// exponential backtracking on input like "-/-/-/…" (js/redos).
		{ re: /\bupdate\s+(?:`?[\w.-]+`?\s*[/,]\s*)*`?(?:workflow\/)?status\.yaml`?/i, why: "update-status.yaml" },
		{ re: /\bappend[^.\n]*\bto\s+`?THREAD_LOG\.md`?/i, why: "append-THREAD_LOG.md" },
		{ re: /\bset\b[^.\n]*\bstatus\b[^.\n]*\bto\s+`?complete`?\s+in\s+status\.yaml/i, why: "set-status-complete" },
	];

	// A prohibition ("do not append to THREAD_LOG.md") is the wording we want,
	// so only flag a match that is not negated in the clause introducing it.
	const NEGATION = /\b(?:do not|do n't|don'?t|never|must not|cannot|can'?t|rather than|instead of|without)\b[^.]{0,60}$/i;
	const isNegated = (line, index) => NEGATION.test(line.slice(0, index));

	const violations = [];
	const check = async (relative, patterns) => {
		const content = await readFile(join(CODECARTO, relative), "utf8");
		const lines = content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			for (const { re, why } of patterns) {
				const match = re.exec(lines[i]);
				if (match && !isNegated(lines[i], match.index)) {
					violations.push(`${relative}:${i + 1} [${why}] ${lines[i].trim()}`);
				}
			}
		}
	};
	for (const relative of scanned) await check(relative, forbidden);
	// Skills are held to the status.yaml rules but not the THREAD_LOG one.
	const skillPatterns = forbidden.filter((pattern) => !pattern.why.includes("THREAD_LOG"));
	for (const relative of postPipelineSkills) await check(relative, skillPatterns);
	assert.deepEqual(
		violations,
		[],
		`Framework instruction files must route state through the phase handoff, never instruct writing framework-owned files:\n${violations.join("\n")}`,
	);
});

// ---------------------------------------------------------------------------
// E09: slice-to-scenario traceability in the planning artifacts.
//
// The engineering record (E01) requires every slice to name the scenarios
// that prove it, and refuses a slice with an empty proof list. The analysis
// artifacts that FEED planning -- the reimplementation specs and the project
// plan -- had no such structure: scenarios were a flat table with no owner,
// and scope tiers were prose. So a plan derived from them could not say
// which scenario proved which promise, and E04 left that seam open.
//
// These invariants pin the structure: a Slices section whose rows carry
// stable ids, the scenarios they prove, dependencies and a tier; a validation
// row that checks every minimum-viable scenario is owned; and the SKILL that
// produces each artifact instructing the session to fill it. They are
// structural checks on TEMPLATES, so they prove the instruction exists, not
// that a session obeyed it. The record contract enforces that part.
// ---------------------------------------------------------------------------

/** Templates that must carry the slice structure, and the SKILL that produces each. */
const SLICE_BEARING = [
	{ template: "templates/reimplementation-spec.md", skill: "findings/reimplementation-spec/SKILL.md", phase: "reimplementation-spec" },
	{ template: "templates/reimplementation-spec-opinionated.md", skill: "findings/reimplementation-spec/SKILL.md", phase: "reimplementation-spec" },
	{ template: "templates/project-plan.md", skill: "findings/goal-synthesis-finalize/SKILL.md", phase: "goal-synthesis-finalize" },
];

test("E09: every pipeline carrying a slice-bearing phase is enumerated, not assumed", () => {
	// The issue asks for the ACTUAL current pipelines. Pin them so a new
	// pipeline that adds one of these phases fails here and gets the same
	// slice criteria, instead of silently shipping the old prose-only shape.
	const carriers = {};
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		for (const phase of pipeline.phases) {
			// Two spec templates share one phase; count the phase once.
			if (SLICE_BEARING.some((bearing) => bearing.phase === phase.id)) (carriers[phase.id] ??= []).push(pipelineFile);
		}
	}
	assert.deepEqual(
		Object.fromEntries(Object.entries(carriers).map(([k, v]) => [k, v.sort()])),
		{
			"reimplementation-spec": ["pipeline-full-with-audit.yaml", "pipeline-full-with-deep-audit.yaml", "pipeline-scout-first.yaml", "pipeline.yaml"],
			"goal-synthesis-finalize": ["pipeline-synthesis.yaml"],
		},
	);
});

test("E09: slice-bearing templates carry a Slices section with stable ids, proved scenarios, dependencies and tier", async () => {
	for (const { template } of SLICE_BEARING) {
		const text = await readFile(join(CODECARTO, template), "utf8");
		assert.match(text, /^## Slices\s*$/im, `${template} lacks a Slices section`);
		const slices = text.split(/^## Slices\s*$/im)[1]?.split(/^## /m)[0] ?? "";
		// The table header is the contract a session fills. Column names are
		// the record vocabulary, so a plan can be lifted into a SliceInput
		// without translation.
		for (const column of ["Slice ID", "Deliverable", "Modules", "Proves scenarios", "Depends on", "Tier"]) {
			assert.ok(slices.includes(column), `${template}: Slices table lacks the ${column} column`);
		}
		// Every scenario a slice claims to prove must exist, and an empty proof
		// list is not a plan. Say so in the template, where a session reads it.
		assert.match(slices, /empty .*proof|no proof|at least one scenario/i, `${template}: Slices section does not forbid an empty proof list`);
	}
});

test("E09: acceptance scenarios carry stable ids and a tier, so a slice can name them", async () => {
	for (const { template } of SLICE_BEARING) {
		const text = await readFile(join(CODECARTO, template), "utf8");
		const heading = /project-plan/.test(template) ? /^## Acceptance plan\s*$/im : /^## Acceptance Scenarios\s*$/im;
		assert.match(text, heading, `${template} lacks its acceptance section`);
		const section = text.split(heading)[1]?.split(/^## /m)[0] ?? "";
		// A scenario numbered "1" in a table cannot be referenced stably once
		// rows are inserted. It needs an id, and it needs to say which tier it
		// belongs to, because "every minimum-viable scenario is owned" is only
		// checkable when scenarios say which ones are minimum-viable.
		assert.ok(section.includes("Scenario ID"), `${template}: acceptance table has no Scenario ID column`);
		assert.ok(section.includes("Tier"), `${template}: acceptance table has no Tier column`);
	}
});

test("E09: the validation table checks that every minimum-viable scenario is owned by a slice", async () => {
	for (const { template } of SLICE_BEARING) {
		const text = await readFile(join(CODECARTO, template), "utf8");
		const validation = text.split(/^## Validation\s*$/im)[1] ?? "";
		assert.match(validation, /minimum[- ]viable scenario.*(owned|proved) by/i, `${template}: validation table has no minimum-viable ownership row`);
		assert.match(validation, /proves scenarios.*(exist|resolve|listed)|scenario id.*(exist|resolve)/i, `${template}: validation table does not check that proved scenarios exist`);
	}
});

test("E09: the producing SKILL instructs the session to fill slices and reject empty proof lists", async () => {
	for (const skill of new Set(SLICE_BEARING.map((b) => b.skill))) {
		const text = await readFile(join(CODECARTO, skill), "utf8");
		assert.match(text, /## Slices|Slices section|slice/i, `${skill} never mentions slices`);
		assert.match(text, /proves scenarios|proved scenario/i, `${skill} does not tell the session to name proved scenarios`);
		assert.match(text, /empty .*proof|no proof|at least one scenario/i, `${skill} does not forbid an empty proof list`);
	}
});

test("E09: the language-agnostic spec stays language-agnostic in its slice instructions", async () => {
	// The issue's explicit constraint. Executable proof commands belong only
	// where the target stack is known (the opinionated variant); the
	// language-neutral spec must not start listing shell commands as proof.
	const text = await readFile(join(CODECARTO, "templates/reimplementation-spec.md"), "utf8");
	const slices = text.split(/^## Slices\s*$/im)[1]?.split(/^## /m)[0] ?? "";
	assert.ok(!/```(sh|bash|shell)|\bnpm (test|run)\b|\bpytest\b|\bcargo test\b/.test(slices), "the language-agnostic spec's Slices section names an executable proof command");
});

test("E09: completion criteria for slice-bearing phases name the slice-to-scenario requirement", () => {
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		for (const phase of pipeline.phases) {
			if (!SLICE_BEARING.some((b) => b.phase === phase.id)) continue;
			assert.ok(
				(phase.completion_criteria ?? []).some((c) => /slice/i.test(c) && /scenario/i.test(c)),
				`${pipelineFile}:${phase.id} has no completion criterion tying slices to scenarios`,
			);
		}
	}
});

test("E09: the new validation rows and the pipeline completion criteria are the same sentences, word for word", async () => {
	// "Changed together" is a property of the files, not of the commit
	// message. The two earlier E09 tests checked each half loosely and
	// independently, so either could be reworded without the other noticing
	// (review E09-10). Pin the exact sentences on both sides.
	const SLICE_ROWS = {
		"reimplementation-spec": [
			"Every slice names at least one scenario it proves, and every Scenario ID it lists exists in the Acceptance Scenarios table.",
			"Every minimum-viable scenario is owned by at least one slice.",
		],
		"goal-synthesis-finalize": [
			"Every slice names at least one scenario it proves, and every Scenario ID it lists exists in the Acceptance plan.",
			"Every minimum-viable scenario is owned by at least one slice.",
		],
	};
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		for (const phase of pipeline.phases) {
			const rows = SLICE_ROWS[phase.id];
			if (!rows) continue;
			for (const row of rows) {
				assert.ok(phase.completion_criteria.includes(row), `${pipelineFile}:${phase.id} completion_criteria lacks the exact sentence: ${row}`);
			}
		}
	}
	for (const { template, phase } of SLICE_BEARING) {
		const text = await readFile(join(CODECARTO, template), "utf8");
		const validation = text.split(/^## Validation\s*$/im)[1] ?? "";
		for (const row of SLICE_ROWS[phase]) {
			assert.ok(validation.includes(`| ${row} |`), `${template} Validation table lacks the exact row: ${row}`);
		}
	}
});

// ---------------------------------------------------------------------------
// E10: agent addressability and observable verification routes.
//
// E09 made every slice name the scenarios that prove it. E10 asks the prior
// question: CAN an agent observe those scenarios at all? A codebase whose
// behavior is only reachable through a GUI, a device, or a network it does
// not have is not "unverifiable" in the abstract; it has a specific,
// recordable gap. The architecture phase assesses this once, tagged with the
// existing evidence levels; the spec names one route per slice in the record
// vocabulary (E01 check_kind / collector) so the plan can carry it. Missing
// seams are hazards, not evidence of correctness -- a system that cannot be
// observed headlessly is not thereby known to work.
//
// Structural checks on TEMPLATES and SKILLs: they prove the instruction
// exists. The record contract enforces that a session obeyed it.
// ---------------------------------------------------------------------------

const ADDRESSABILITY_BEARING = [
	{ template: "templates/architecture-map.md", skill: "findings/architecture/SKILL.md", phase: "architecture", section: /^## Agent Addressability\s*$/im },
	{ template: "templates/reverse-engineering-bundle.md", skill: "findings/porting/SKILL.md", phase: "porting", section: /^## Agent Addressability\s*$/im },
];
const ROUTE_BEARING = [
	{ template: "templates/reimplementation-spec.md", skill: "findings/reimplementation-spec/SKILL.md", phase: "reimplementation-spec" },
	{ template: "templates/reimplementation-spec-opinionated.md", skill: "findings/reimplementation-spec/SKILL.md", phase: "reimplementation-spec" },
];

test("E10: every pipeline carrying an addressability-bearing phase is enumerated, not assumed", () => {
	const carriers = {};
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		for (const phase of pipeline.phases) {
			if (ADDRESSABILITY_BEARING.some((b) => b.phase === phase.id)) (carriers[phase.id] ??= []).push(pipelineFile);
		}
	}
	assert.deepEqual(
		Object.fromEntries(Object.entries(carriers).map(([k, v]) => [k, v.sort()])),
		{
			architecture: ["pipeline-architecture-only.yaml", "pipeline-defect-scan.yaml", "pipeline-full-with-audit.yaml", "pipeline-full-with-deep-audit.yaml", "pipeline-lite.yaml", "pipeline-scout-first.yaml", "pipeline.yaml"],
			porting: ["pipeline-full-with-audit.yaml", "pipeline-full-with-deep-audit.yaml", "pipeline-scout-first.yaml", "pipeline.yaml"],
		},
	);
});

test("E10: architecture and porting templates carry an Agent Addressability section asking the three questions, tagged with evidence levels", async () => {
	for (const { template, section } of ADDRESSABILITY_BEARING) {
		const text = await readFile(join(CODECARTO, template), "utf8");
		assert.match(text, section, `${template} lacks an Agent Addressability section`);
		const body = text.split(section)[1]?.split(/^## /m)[0] ?? "";
		// The three questions the issue names, as columns a session fills.
		for (const q of ["Headless", "Inspectable state", "Programmatic seam"]) {
			assert.ok(body.includes(q), `${template}: Agent Addressability does not ask about ${q}`);
		}
		// Every row is tagged with the evidence level the phase already uses,
		// so "runs headlessly" is not accepted as a bare assertion.
		assert.ok(body.includes("Evidence"), `${template}: Agent Addressability rows carry no evidence level`);
		assert.match(body, /observed fact|strong inference|open question/, `${template}: Agent Addressability does not name the evidence vocabulary`);
		// A missing seam is a hazard, in the template's own words.
		assert.match(body, /hazard/i, `${template}: Agent Addressability does not say a missing seam is a hazard`);
		assert.ok(!/evidence of correctness|proves it works|therefore correct/i.test(body) || /not evidence of correctness|is not evidence/i.test(body), `${template}: a missing seam must not read as evidence of correctness`);
	}
});

test("E10: the spec templates require one observable verification route per slice, in the record vocabulary", async () => {
	for (const { template } of ROUTE_BEARING) {
		const text = await readFile(join(CODECARTO, template), "utf8");
		const slices = text.split(/^## Slices\s*$/im)[1]?.split(/^## /m)[0] ?? "";
		assert.ok(slices.includes("Verification route"), `${template}: Slices table has no Verification route column`);
		// The route is stated in E01's own words, so a plan can lift it into
		// a proof obligation without translation.
		for (const kind of ["test", "run", "manual-procedure"]) {
			assert.ok(slices.includes(`\`${kind}\``), `${template}: Slices section does not offer the ${kind} route`);
		}
		// Headless preferred; GUI/hardware/integration allowed when documented;
		// unavailable is a gap, not a pass.
		assert.match(slices, /headless/i, `${template}: does not prefer headless routes`);
		assert.match(slices, /unavailable.*(gap|blocker)|(gap|blocker).*unavailable/i, `${template}: does not say an unavailable environment is a gap`);
	}
});

test("E10: the validation tables and completion criteria carry the addressability and route rows, as the same sentences", async () => {
	const ROWS = {
		architecture: ["Agent addressability is assessed with evidence levels, and missing seams are recorded as hazards."],
		porting: ["Agent addressability is assessed with evidence levels, and missing seams are recorded as hazards."],
		"reimplementation-spec": ["Every slice names at least one observable verification route, and an unavailable route is recorded as a gap rather than a pass."],
	};
	for (const [pipelineFile, pipeline] of Object.entries(pipelines)) {
		for (const phase of pipeline.phases) {
			const rows = ROWS[phase.id];
			if (!rows) continue;
			for (const row of rows) assert.ok(phase.completion_criteria.includes(row), `${pipelineFile}:${phase.id} lacks the exact criterion: ${row}`);
		}
	}
	for (const { template, phase } of [...ADDRESSABILITY_BEARING, ...ROUTE_BEARING]) {
		const text = await readFile(join(CODECARTO, template), "utf8");
		const validation = text.split(/^## Validation\s*$/im)[1] ?? "";
		for (const row of ROWS[phase]) assert.ok(validation.includes(`| ${row} |`), `${template} Validation lacks the exact row: ${row}`);
	}
});

test("E10: the producing SKILLs instruct the session, and none of them force an architectural rewrite to satisfy the checklist", async () => {
	for (const skill of new Set([...ADDRESSABILITY_BEARING, ...ROUTE_BEARING].map((b) => b.skill))) {
		const text = await readFile(join(CODECARTO, skill), "utf8");
		assert.match(text, /addressab|verification route/i, `${skill} never mentions addressability or verification routes`);
		assert.match(text, /hazard/i, `${skill} does not say a missing seam is a hazard`);
		// The issue's acceptance: do not force rewrites. The SKILL must say so.
		assert.match(text, /do not (require|force|propose)|not a reason to|is not a request to/i, `${skill} does not forbid forcing a rewrite to satisfy the checklist`);
	}
});

test("E10: Broad-Side lenses and schemas are untouched", async () => {
	// The issue keeps lens/schema changes out of this PR. Pin the file set by
	// digest so an accidental edit here fails loudly.
	const { createHash } = await import("node:crypto");
	const files = ["core/broadside/lenses.ts", "core/broadside/schemas.ts"];
	const digests = {};
	for (const f of files) digests[f] = createHash("sha256").update(await readFile(join(REPO_ROOT, f))).digest("hex").slice(0, 16);
	// Recorded at the E10 branch point (main a240571). Update deliberately, in a
	// PR that is about Broad-Side.
	assert.deepEqual(digests, JSON.parse(await readFile(join(REPO_ROOT, "tests/fixtures/broadside-pin.json"), "utf8")));
});
