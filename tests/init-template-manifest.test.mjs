// Init and refresh copy the framework-owned template and nothing a session
// wrote into it (#224), and every workspace gets its ignore rules even from an
// npm install, which never packs a file named .gitignore (#229).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODECARTO = join(REPO_ROOT, ".codecarto");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { handleInit, handleValidate } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);

const PIPELINE = [
	"workflow_name: synthetic",
	"phase_order:",
	"  - alpha",
	"phases:",
	"  - id: alpha",
	"    depends_on: []",
	"    primary_output: findings/alpha/alpha-report.md",
	"    secondary_outputs:",
	"      - path: findings/beta/beta-notes.md",
	"        mode: append",
	"    completion_criteria:",
	"      - Something",
	"",
].join("\n");

const REPORT = "# Alpha\n\n## Validation\n\n| # | Criterion | Result | Evidence |\n|---|---|---|---|\n| 1 | Something | PASS | done |\n\n**Overall:** PASS\n";

/** A template that, like a checkout of this repository, carries a finished run. */
async function syntheticTemplate({ withGitignore }) {
	const source = await mkdtemp(join(tmpdir(), "cc-manifest-src-"));
	const files = {
		"GUIDE.md": "guide\n",
		"templates/gitignore": "dashboard.html\n",
		"templates/conventions-template.md": "conventions\n",
		"workflow/pipeline.yaml": PIPELINE,
		"workflow/scaffold-version.yaml": "scaffold_version: 0.0.0\n",
		"workflow/status.yaml": "project_name: someone-else\npipeline: workflow/pipeline.yaml\n",
		"workflow/.usage.local.yaml": "version: 1\nruns: []\n",
		"workflow/.orchestrator.local.yaml": "session: /home/someone/.pi/x.jsonl\n",
		"workflow/status.yaml.lock": "123\n",
		"findings/alpha/SKILL.md": "skill\n",
		"findings/alpha/README.md": "readme\n",
		"findings/alpha/alpha-report.md": REPORT,
		"findings/beta/.gitkeep": "",
		"findings/beta/beta-notes.md": "notes\n",
		"scratch/.gitkeep": "",
		"scratch/handoffs/alpha.yaml": "schema_version: 1\n",
		"scratch/checkpoints/alpha.md": "checkpoint\n",
		"closeouts/2026-01-01-alpha.md": "closeout\n",
		"dashboard.html": "<html></html>\n",
		".dashboard-narration.local.md": "narration\n",
		"broadside/SKILL.md": "guide\n",
		"broadside/config.yaml": "max_cost: 1\n",
		"broadside/state.json": "{}\n",
	};
	if (withGitignore) files[".gitignore"] = "# the checkout's own rules\ndashboard.html\n";
	for (const [relativePath, content] of Object.entries(files)) {
		await mkdir(dirname(join(source, relativePath)), { recursive: true });
		await writeFile(join(source, relativePath), content, "utf8");
	}
	return source;
}

async function exists(path) {
	return stat(path).then(() => true, () => false);
}

test("init copies the template and leaves every session-written file behind", async () => {
	const source = await syntheticTemplate({ withGitignore: false });
	const target = await mkdtemp(join(tmpdir(), "cc-manifest-dst-"));
	try {
		const ws = join(target, ".codecarto");
		await core.copyPackagedWorkspace(ws, source);
		for (const kept of [
			"GUIDE.md",
			"templates/gitignore",
			"templates/conventions-template.md",
			"workflow/pipeline.yaml",
			"workflow/scaffold-version.yaml",
			"findings/alpha/SKILL.md",
			"findings/alpha/README.md",
			"findings/beta/.gitkeep",
			"scratch/.gitkeep",
			"broadside/SKILL.md",
			"broadside/config.yaml",
		]) {
			assert.ok(await exists(join(ws, kept)), `${kept} must be copied`);
		}
		for (const left of [
			"findings/alpha/alpha-report.md",
			"findings/beta/beta-notes.md",
			"scratch/handoffs",
			"scratch/checkpoints",
			"closeouts/2026-01-01-alpha.md",
			"dashboard.html",
			".dashboard-narration.local.md",
			"workflow/status.yaml",
			"workflow/.usage.local.yaml",
			"workflow/.orchestrator.local.yaml",
			"workflow/status.yaml.lock",
			"broadside/state.json",
		]) {
			assert.ok(!(await exists(join(ws, left))), `${left} is session state and must not be copied`);
		}
		assert.deepEqual(await readdir(join(ws, "closeouts")), [], "closeouts/ exists and is empty");
		assert.deepEqual(await readdir(join(ws, "scratch")), [".gitkeep"], "scratch/ keeps only its .gitkeep");
		assert.equal(await readFile(join(ws, ".gitignore"), "utf8"), "dashboard.html\n", ".gitignore is written from templates/gitignore when the template has none");
	} finally {
		await rm(source, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});

test("a template that ships its own .gitignore (a checkout) is copied as-is", async () => {
	const source = await syntheticTemplate({ withGitignore: true });
	const target = await mkdtemp(join(tmpdir(), "cc-manifest-dst-"));
	try {
		const ws = join(target, ".codecarto");
		await core.copyPackagedWorkspace(ws, source);
		assert.match(await readFile(join(ws, ".gitignore"), "utf8"), /the checkout's own rules/);
	} finally {
		await rm(source, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});

test("ensureWorkspaceGitignore never overwrites an existing file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cc-gitignore-"));
	try {
		await mkdir(join(dir, "templates"), { recursive: true });
		await writeFile(join(dir, "templates", "gitignore"), "from-template\n");
		assert.equal(await core.ensureWorkspaceGitignore(dir), true);
		assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "from-template\n");
		await writeFile(join(dir, ".gitignore"), "user-edited\n");
		assert.equal(await core.ensureWorkspaceGitignore(dir), false);
		assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "user-edited\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("scaffold refresh lists framework files only, never reports, dashboards, or the ignore file", async () => {
	const source = await syntheticTemplate({ withGitignore: true });
	try {
		const files = await core.listScaffoldRefreshFiles(source);
		for (const kept of ["GUIDE.md", "templates/gitignore", "workflow/pipeline.yaml", "findings/alpha/SKILL.md", "findings/beta/.gitkeep"]) {
			assert.ok(files.includes(kept), `${kept} must refresh`);
		}
		for (const left of [
			"findings/alpha/alpha-report.md",
			"findings/beta/beta-notes.md",
			"dashboard.html",
			".dashboard-narration.local.md",
			".gitignore",
			"workflow/status.yaml",
			"workflow/.orchestrator.local.yaml",
			"workflow/status.yaml.lock",
		]) {
			assert.ok(!files.includes(left), `${left} must not refresh: ${files.join(", ")}`);
		}
	} finally {
		await rm(source, { recursive: true, force: true });
	}
});

test("the shipped ignore template is byte-identical to this repository's own .codecarto/.gitignore", async () => {
	const live = await readFile(join(CODECARTO, ".gitignore"), "utf8");
	const shipped = await readFile(join(CODECARTO, "templates", "gitignore"), "utf8");
	assert.equal(shipped, live);
	// The analysis pipelines' reports are all listed, not a stale path (#269).
	// (Synthesis outputs are the project's own planning documents and are
	// deliberately not ignored.)
	for (const output of [
		"findings/defect-scan-mechanical/mechanical-defects.md",
		"findings/defect-scan-semantic/semantic-defects.md",
		"findings/porting/reverse-engineering-bundle.md",
	]) {
		assert.ok(live.split(/\r?\n/).includes(output), `.codecarto/.gitignore does not list declared output ${output}`);
	}
});

test("the packaged pipelines declare the outputs init must leave behind", async () => {
	const outputs = await core.listDeclaredOutputs();
	for (const expected of [
		"findings/architecture/architecture-map.md",
		"findings/defect-scan-mechanical/mechanical-defects.md",
		"findings/reimplementation-spec/reimplementation-spec.md",
		"findings/public-surfaces/public-surfaces.md",
	]) {
		assert.ok(outputs.has(expected), `${expected} should be a declared output`);
	}
});

test("a workspace initialised from the live template holds no report and validates MISSING", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cc-live-init-"));
	try {
		await handleInit({ cwd, pipeline: "full-with-deep-audit" });
		const ws = join(cwd, ".codecarto");
		for (const output of await core.listDeclaredOutputs()) {
			assert.ok(!(await exists(join(ws, output))), `fresh workspace carries ${output}`);
		}
		for (const left of ["dashboard.html", "scratch/handoffs", "workflow/.usage.local.yaml"]) {
			assert.ok(!(await exists(join(ws, left))), `fresh workspace carries ${left}`);
		}
		assert.ok(await exists(join(ws, ".gitignore")), "fresh workspace has its ignore rules");
		const validation = await handleValidate({ cwd, phase: "architecture" });
		assert.equal(validation.structuredContent.overall, "MISSING");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("the npm tarball carries the ignore rules under their shipped name", async () => {
	// npm-packlist always drops files named .gitignore, so the rules travel as
	// templates/gitignore. --dry-run --json lists what would be packed.
	const npm = process.env.npm_execpath ?? "npm";
	const runner = process.env.npm_execpath ? process.execPath : npm;
	const args = process.env.npm_execpath ? [npm, "pack", "--dry-run", "--json"] : ["pack", "--dry-run", "--json"];
	const { stdout } = await promisify(execFile)(runner, args, { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
	// npm has emitted three shapes over time: an array, one object, and an
	// object keyed by package name.
	const parsed = JSON.parse(stdout);
	const pack = Array.isArray(parsed) ? parsed[0] : parsed.files ? parsed : Object.values(parsed)[0];
	assert.ok(Array.isArray(pack?.files), `unexpected npm pack --json shape: ${stdout.slice(0, 200)}`);
	const paths = new Set(pack.files.map((f) => f.path));
	assert.ok(paths.has(".codecarto/templates/gitignore"), "templates/gitignore must be in the tarball");
	assert.ok(!paths.has(".codecarto/.gitignore"), "assumption: npm still drops .gitignore itself");
});
