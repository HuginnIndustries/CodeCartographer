// Pipeline-shape invariants. Catches the PR4-class issue (someone edits a
// pipeline YAML but breaks the dependency DAG / required_reads chain) and the
// PR5-class issue (a SKILL.md cites a report path that doesn't exist for the
// active pipelines).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODECARTO = join(REPO_ROOT, ".codecarto");

const { parseSimpleYaml } = await import(`${REPO_ROOT}/core/yaml.ts`);

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
