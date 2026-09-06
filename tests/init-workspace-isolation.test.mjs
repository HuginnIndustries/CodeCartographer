// A new workspace must contain this project's state and nothing of anyone
// else's. The repository's own .codecarto/ is both the shipped template and
// CodeCartographer's live workspace, so a wholesale copy handed every user a
// backlog, a thread log, and a closeout belonging to the framework itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODECARTO = join(REPO_ROOT, ".codecarto");
const { handleInit } = await import(pathToFileURL(`${REPO_ROOT}/mcp-server/server.ts`).href);
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);

async function freshWorkspace(fn) {
	const cwd = await mkdtemp(join(tmpdir(), "cc-isolation-"));
	try {
		await handleInit({ cwd, pipeline: "architecture-only" });
		await fn(join(cwd, ".codecarto"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("a fresh workspace starts with an empty closeouts/", async () => {
	// GUIDE.md keys First-Time Project Setup on "no closeouts in closeouts/".
	// Shipping one told every new session it was not the first to touch the
	// project, suppressing the orchestrator role that is meant to be default.
	// The directory must exist rather than be absent: npm tarballs carry no
	// empty directories, so init creates it instead of relying on the copy.
	await freshWorkspace(async (ws) => {
		assert.deepEqual(await readdir(join(ws, "closeouts")), [], "closeouts/ must exist and be empty");
	});
});

test("no orchestrator file carries the framework's own project history", async () => {
	await freshWorkspace(async (ws) => {
		for (const file of ["BACKLOG.md", "THREAD_LOG.md", "CONVENTIONS.md", "DECISIONS.md"]) {
			const content = await readFile(join(ws, file), "utf8");
			assert.ok(content.length > 0, `${file} must be seeded`);
			// Real entries from this repository's own sessions, as opposed to the
			// illustrative examples a template is allowed to carry.
			const entries = content
				.split(/\n/)
				.filter((line) => /^- \d{4}-\d{2}-\d{2} —/.test(line) || /^## B\d+\./.test(line));
			assert.deepEqual(entries, [], `${file} ships with real entries: ${entries.join(" | ")}`);
		}
	});
});

test("the seeded backlog is the project template, not the framework's deferral list", async () => {
	const framework = await readFile(join(CODECARTO, "BACKLOG.md"), "utf8");
	assert.match(framework, /^## B\d+\./m, "the repository's own backlog should still hold its entries");

	await freshWorkspace(async (ws) => {
		const seeded = await readFile(join(ws, "BACKLOG.md"), "utf8");
		assert.notEqual(seeded, framework, "a new workspace must not inherit the framework's backlog");
		assert.match(seeded, /DECISIONS\.md.*decided to \*\*do\*\*/s, "the template must state the BACKLOG/DECISIONS split");
		assert.match(seeded, /Preconditions:/, "entries must ask what has to land first");
		assert.match(seeded, /Smallest viable form:/, "entries must record the smallest viable form");
	});
});

test("every orchestrator file has a template to be seeded from", async () => {
	// A seeded file whose template is missing is silently skipped, which is how
	// a workspace ends up with no BACKLOG.md and a SKILL telling it to write one.
	for (const { file, template } of core.ORCHESTRATOR_FILES) {
		const path = join(CODECARTO, "templates", template);
		const content = await readFile(path, "utf8").catch(() => null);
		assert.ok(content, `${file} names templates/${template}, which does not exist`);
		assert.ok(content.trim().length > 100, `templates/${template} is too short to be a real skeleton`);
	}
});

test("the framework's own workspace state is not published to npm", async () => {
	// package.json ships .codecarto/**/*, so anything this repository writes into
	// its own workspace rides along into the tarball unless it is negated out.
	// Init filters the same paths, but the tarball should not transport another
	// project's history either.
	const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
	assert.ok(pkg.files.includes(".codecarto/**/*"), "assumption: the whole template ships");
	for (const { file } of core.ORCHESTRATOR_FILES) {
		assert.ok(
			pkg.files.includes(`!.codecarto/${file}`),
			`package.json must exclude .codecarto/${file} — it is seeded from a template, never shipped`,
		);
	}
	assert.ok(pkg.files.includes("!.codecarto/closeouts/**"), "package.json must exclude this repository's closeouts");
	assert.ok(
		pkg.files.includes("!.codecarto/broadside/**"),
		"package.json must exclude this repository's Broad-Side scan state",
	);
	for (const kept of [".codecarto/broadside/SKILL.md", ".codecarto/broadside/config.yaml"]) {
		assert.ok(pkg.files.includes(kept), `${kept} is template, not state — it must ride back in after the negation`);
	}

	// The stray one-off changelog belongs to the framework's history, not the template.
	const stray = (await readdir(CODECARTO)).filter((name) => /^CHANGELOG/.test(name));
	assert.deepEqual(stray, [], `framework history left in the template: ${stray.join(", ")}`);
});

test("a fresh workspace inherits no Broad-Side scan state", async () => {
	// The repository's own broadside/ holds gitignored machine-local state
	// (state.json, timestamped run directories) next to the two template files.
	// Build a synthetic template carrying such state — mutating the live
	// packaged workspace here would race the other test files copying it —
	// and prove the filter keeps only the template pair.
	const source = await mkdtemp(join(tmpdir(), "cc-broadside-src-"));
	const target = await mkdtemp(join(tmpdir(), "cc-broadside-dst-"));
	try {
		const broadsideDir = join(source, "broadside");
		const runDir = join(broadsideDir, "2026-08-23T05-52-23-986Z");
		await mkdir(runDir, { recursive: true });
		await writeFile(join(broadsideDir, "SKILL.md"), "# reading guide\n");
		await writeFile(join(broadsideDir, "config.yaml"), "# defaults\n");
		await writeFile(join(broadsideDir, "state.json"), '{"schema_version":1,"runs":[{"id":"x"}]}\n');
		await writeFile(join(runDir, "run-meta.json"), "{}\n");
		await writeFile(join(source, "GUIDE.md"), "guide\n");

		const ws = join(target, ".codecarto");
		await core.copyPackagedWorkspace(ws, source);
		const copied = (await readdir(join(ws, "broadside"))).sort();
		assert.deepEqual(
			copied,
			["SKILL.md", "config.yaml"],
			`broadside/ must carry only its template files, got: ${copied.join(", ")}`,
		);
	} finally {
		await rm(source, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});
