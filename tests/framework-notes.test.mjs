// The self-audit's template and prompt notes (#271 F2, #272 F3, #274 F5,
// #275 F6, #277 F8, #278 F9, #279 F10), pinned where they changed what the
// phase executor is told.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const CODECARTO = join(REPO_ROOT, ".codecarto");
const read = (rel) => readFile(join(CODECARTO, rel), "utf8");

test("F5: after the first phase the prompt says the framework's own reads are unchanged, and status.yaml is not", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-notes-"));
	try {
		await server.handleInit({ cwd, pipeline: "lite" });
		const first = (await server.handleNext({ cwd })).content[0].text;
		assert.match(first, /^- \.codecarto\/GUIDE\.md$/m, "the first phase reads everything plainly");
		assert.match(first, /^- \.codecarto\/workflow\/status\.yaml$/m);
		assert.match(first, /^- \.codecarto\/templates\/phase-handoff\.yaml$/m);

		const codecarto = join(cwd, ".codecarto");
		await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), "# M\n\n## Validation\n\n| # | c | r | e |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n", "utf8");
		await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), "phase_id: architecture\ncloseout_summary: done\n", "utf8");
		await server.handleComplete({ cwd });
		const second = (await server.handleNext({ cwd })).content[0].text;
		assert.match(second, /^- \.codecarto\/GUIDE\.md \(framework-owned; unchanged since your last phase unless the scaffold was refreshed — skim rather than re-read if you still hold it\)$/m);
		assert.match(second, /^- \.codecarto\/templates\/phase-handoff\.yaml \(framework-owned; unchanged since your last phase/m);
		assert.match(second, /^- \.codecarto\/workflow\/status\.yaml \(rewritten by the last completion; read it\)$/m);
		assert.match(second, /^- \.codecarto\/findings\/architecture\/architecture-map\.md$/m, "the phase's real inputs are listed plainly");
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("F2: the spec template no longer names carry-forward targets completion refuses", async () => {
	const template = await read("templates/reimplementation-spec.md");
	assert.doesNotMatch(template, /Allowed target_phase values for post-pipeline/);
	assert.match(template, /target_phase that is a LATER phase of the active pipeline/);
	assert.match(template, /post_pipeline list instead/);
	// The rule the template now states is the rule completion applies.
	const cwd = await mkdtemp(join(tmpdir(), "cc-notes-"));
	try {
		await server.handleInit({ cwd, pipeline: "architecture-only" });
		const codecarto = join(cwd, ".codecarto");
		await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), "# M\n\n## Validation\n\n| # | c | r | e |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n", "utf8");
		await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), "phase_id: architecture\ncloseout_summary: done\ncarry_forward:\n  - id: x\n    target_phase: spike\n    description: later\n", "utf8");
		await assert.rejects(server.handleComplete({ cwd }), /carry_forward target_phase spike is not a downstream active pipeline phase; use post_pipeline/);
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("F3, F6, F8, F9, F10: the guide, skills, and templates carry the notes", async () => {
	assert.match(await read("workflow/VALIDATE.md"), /\*\*Validated by:\*\* \[session identifier or date — YYYY-MM-DD in UTC/);
	assert.match(await read("GUIDE.md"), /every other date the framework writes is the UTC calendar day/);

	const mechanical = await read("findings/defect-scan-mechanical/SKILL.md");
	assert.match(mechanical, /package manifest \(`package\.json`, `pyproject\.toml`, `go\.mod`/);
	assert.match(mechanical, /\.github\/workflows\/\*/);
	assert.match(await read("findings/defect-scan-semantic/SKILL.md"), /the source of a dependency the code trusts \(under\n`node_modules\/`/);
	assert.match(await read("findings/porting/SKILL.md"), /Read each scan's `§Runtime probes` section/);
	for (const template of ["templates/mechanical-defects.md", "templates/semantic-defects.md"]) {
		const text = await read(template);
		assert.match(text, /^## Runtime probes$/m, template);
		assert.ok(text.search(/^## Runtime probes$/m) < text.search(/^## Open Questions$/m), `${template}: probes come before open questions`);
	}

	assert.match(await read("findings/protocols/SKILL.md"), /This phase owns the storage-format catalog/);
	assert.match(await read("findings/contracts/SKILL.md"), /catalog of on-disk and wire formats belongs to the protocols\s+phase/);

	const bundle = await read("templates/reverse-engineering-bundle.md");
	assert.doesNotMatch(bundle, /Keep it under one screen/);
	assert.match(bundle, /Completeness wins\. Give every high and medium\s+finding its own row; group lows by shared root cause/);

	const rubric = await read("findings/defect-scan/SKILL.md");
	assert.match(rubric, /Severity is the consequence, not the confidence/);
	assert.match(rubric, /it is not promoted for having been confirmed/);
	assert.match(await read("findings/defect-scan-semantic/SKILL.md"), /including its rule for probe-confirmed findings/);
});
