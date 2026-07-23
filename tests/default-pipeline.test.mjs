// Invariants tying the packaged status.yaml to the active default pipeline,
// and tying the Pi extension's hardcoded fallback to the same default. Catches
// the PR4-class issue where one of these falls out of sync with the others.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODECARTO = join(REPO_ROOT, ".codecarto");

const { parseSimpleYaml } = await import(pathToFileURL(`${REPO_ROOT}/core/yaml.ts`).href);
const { PIPELINE_ALIASES, DEFAULT_PIPELINE_PATH } = await import(pathToFileURL(`${REPO_ROOT}/core/pipeline.ts`).href);

const statusYaml = await readFile(join(CODECARTO, "workflow", "status.yaml"), "utf8");
const status = parseSimpleYaml(statusYaml);
const pipelinePath = join(CODECARTO, status.pipeline);
const pipelineYaml = await readFile(pipelinePath, "utf8");
const pipeline = parseSimpleYaml(pipelineYaml);

test("status.yaml pipeline pointer resolves to a real file", async () => {
	assert.ok(status.pipeline, "status.yaml is missing the `pipeline:` field");
	await assert.doesNotReject(stat(pipelinePath), `pipeline file ${status.pipeline} does not exist`);
});

test("status.yaml phases keys exactly match the active pipeline's phase_order", () => {
	const statusPhaseIds = Object.keys(status.phases);
	assert.deepEqual(
		statusPhaseIds,
		pipeline.phase_order,
		`status.yaml phases keys ${JSON.stringify(statusPhaseIds)} != active pipeline phase_order ${JSON.stringify(pipeline.phase_order)}. Did you change the default pipeline without updating the packaged status.yaml?`,
	);
});

test("DEFAULT_PIPELINE_PATH points at the same pipeline as the packaged status.yaml", () => {
	assert.equal(
		DEFAULT_PIPELINE_PATH,
		status.pipeline,
		`Pi extension's DEFAULT_PIPELINE_PATH (${DEFAULT_PIPELINE_PATH}) disagrees with the packaged status.yaml's pipeline pointer (${status.pipeline})`,
	);
});

test("PIPELINE_ALIASES contains an entry pointing at the default pipeline", () => {
	const targets = Object.values(PIPELINE_ALIASES);
	assert.ok(
		targets.includes(DEFAULT_PIPELINE_PATH),
		`No PIPELINE_ALIASES entry maps to the default pipeline (${DEFAULT_PIPELINE_PATH}). Aliases: ${JSON.stringify(PIPELINE_ALIASES, null, 2)}`,
	);
});

test("every PIPELINE_ALIASES target resolves to a real file", async () => {
	for (const [alias, target] of Object.entries(PIPELINE_ALIASES)) {
		await assert.doesNotReject(
			stat(join(CODECARTO, target)),
			`PIPELINE_ALIASES.${alias} → ${target} does not exist on disk`,
		);
	}
});

test("Pi extension registers a command for every CodeCartographer operation", async () => {
	// The set of operations the framework exposes; both wrappers must surface them.
	const expected = ["init", "open", "switch-pipeline", "status", "next", "phase", "validate", "complete", "skill", "publish", "usage", "dashboard"];
	const indexSrc = await readFile(join(REPO_ROOT, "extensions", "codecarto", "index.ts"), "utf8");
	const missing = expected.filter((op) => !indexSrc.includes(`pi.registerCommand("codecarto-${op}"`));
	assert.deepEqual(
		missing,
		[],
		`Pi extension is missing command registration for: ${missing.join(", ")}`,
	);
});
