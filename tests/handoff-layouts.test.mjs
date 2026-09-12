// A handoff in the layouts #246 admitted completes end to end: a wrapped
// plain-scalar closeout_summary, a value starting on the line after its key,
// and a list at the same indent as its key. Each of these was valid YAML that
// the parser rejected with "Invalid YAML indentation" or read as null.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const server = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

const REPORT = "# Map\n\n## Validation\n\n| # | Criterion | Result | Evidence |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n";

const HANDOFF = [
	"phase_id: architecture",
	"closeout_summary: Mapped the core modules, the two",
	"  delivery surfaces, and the pipeline engine; routed",
	"  one gap to contracts.",
	"owner_notes:",
	"- The parser is the stable base.",
	"- Both surfaces share core/.",
	"open_questions:",
	"- id: q-storage",
	"  kind: needs-maintainer-decision",
	"  description:",
	"    Which storage engine is canonical",
	"    for the library?",
	"carry_forward:",
	"- id: arch-CF1",
	"  target_phase: contracts",
	"  description: Pin the retry contract.",
	"",
].join("\n");

test("a handoff using wrapped scalars and same-indent lists completes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-handoff-layouts-"));
	try {
		await server.handleInit({ cwd, pipeline: "lite" });
		const codecarto = join(cwd, ".codecarto");
		await writeFile(join(codecarto, "findings", "architecture", "architecture-map.md"), REPORT, "utf8");
		await mkdir(join(codecarto, "scratch", "handoffs"), { recursive: true });
		await writeFile(join(codecarto, "scratch", "handoffs", "architecture.yaml"), HANDOFF, "utf8");

		const result = await server.handleComplete({ cwd });
		assert.match(result.content[0].text, /architecture/);

		const phase = (await core.getWorkspaceState(cwd)).status.phases.architecture;
		assert.equal(phase.status, "complete");
		assert.ok(phase.owner_notes.includes("The parser is the stable base."));
		assert.ok(phase.owner_notes.includes("Both surfaces share core/."));
		assert.deepEqual(phase.open_questions, [
			{ id: "q-storage", kind: "needs-maintainer-decision", description: "Which storage engine is canonical for the library?" },
		]);
		assert.deepEqual(phase.carry_forward, [{ id: "arch-CF1", target_phase: "contracts", description: "Pin the retry contract." }]);
		const closeout = await core.loadHandoffFile("architecture", codecarto);
		assert.equal(closeout.closeout_summary, "Mapped the core modules, the two delivery surfaces, and the pipeline engine; routed one gap to contracts.");
	} finally {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
