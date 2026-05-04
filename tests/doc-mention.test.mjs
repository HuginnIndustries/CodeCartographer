// Catches doc drift: every pipeline YAML on disk should be named in the
// public-facing variant tables (top README, .codecarto/README, GUIDE), and
// the file actually named as the default in status.yaml should be the only
// one labeled "default" in those tables.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODECARTO = join(REPO_ROOT, ".codecarto");

const { parseSimpleYaml } = await import(`${REPO_ROOT}/core/yaml.ts`);

const statusRaw = await readFile(join(CODECARTO, "workflow", "status.yaml"), "utf8");
const status = parseSimpleYaml(statusRaw);
const defaultPipelineFile = status.pipeline.replace(/^workflow\//, "");

const pipelineFiles = (await readdir(join(CODECARTO, "workflow"))).filter(
	(f) => f.startsWith("pipeline") && f.endsWith(".yaml"),
);

const docFiles = [
	{ label: "top README.md", path: join(REPO_ROOT, "README.md") },
	{ label: ".codecarto/README.md", path: join(CODECARTO, "README.md") },
	{ label: ".codecarto/GUIDE.md", path: join(CODECARTO, "GUIDE.md") },
];

for (const doc of docFiles) {
	const content = await readFile(doc.path, "utf8");

	test(`${doc.label} mentions every pipeline file`, () => {
		const missing = pipelineFiles.filter((pf) => !content.includes(pf));
		assert.deepEqual(
			missing,
			[],
			`${doc.label} does not mention these pipeline files: ${missing.join(", ")}. Adding a new pipeline YAML requires updating ${doc.label}.`,
		);
	});

	test(`${doc.label} marks ${defaultPipelineFile} as the default`, () => {
		// We expect the default pipeline to appear in close proximity to the
		// word "default" (case-insensitive). Allow up to 200 chars of
		// surrounding context (covers the variant-table cell + a comment).
		const idx = content.indexOf(defaultPipelineFile);
		assert.ok(idx >= 0, `${doc.label} does not mention the default pipeline (${defaultPipelineFile})`);
		const window = content.slice(Math.max(0, idx - 100), idx + defaultPipelineFile.length + 100);
		assert.match(
			window,
			/default/i,
			`${doc.label} mentions ${defaultPipelineFile} but does not label it as the default within 100 chars of context`,
		);
	});
}
