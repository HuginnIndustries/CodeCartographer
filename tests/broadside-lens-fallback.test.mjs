// The security and api lenses fall back to every source file when their
// targeted globs match no source file (#319).
//
// Seen live on 0.22.0: a Node service whose server lives at src/server.js
// matched none of server/**, **/auth*, **/middleware/**, SECURITY.md, and
// the lens that exists to find exactly that code reported "skipped".
// Seen live on 0.24.0: CodeCartographer's own SECURITY.md satisfied the
// same globs, so the security lens reviewed a policy document, found
// nothing, and wrote a coverage note saying it had seen no code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/broadside.ts`).href);
const { default: codeCartographerExtension } = await import(pathToFileURL(`${REPO_ROOT}/extensions/codecarto/index.ts`).href);
const { broadsideDirFor, collectRepoInfo, estimateSubmitText, gatherSlices, getLens, loadBroadsideState, runBroadsideSubmit, selectLensFiles, statusText } = core;

process.env.OPENROUTER_API_KEY = "sk-fake";

function response(status, body) {
	return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A Node service with no server/ directory: the layout that exposed the gap. */
async function nodeService() {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-fallback-"));
	await writeFile(join(dir, "package.json"), '{"name":"notesd","type":"module"}\n');
	await mkdir(join(dir, "src", "lib"), { recursive: true });
	await writeFile(join(dir, "src", "server.js"), "export function start() { /* bearer check lives here */ }\n");
	await writeFile(join(dir, "src", "router.js"), "export class Router {}\n");
	await writeFile(join(dir, "src", "lib", "validate.js"), "export function validateNote() {}\n");
	await writeFile(join(dir, "src", "store.test.js"), "test('x', () => {});\n");
	return dir;
}

/** A Go service with a server/ directory: the layout the globs were written for. */
async function goService() {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-targeted-"));
	await writeFile(join(dir, "go.mod"), "module x\n");
	await writeFile(join(dir, "main.go"), "package main\n");
	await mkdir(join(dir, "server"), { recursive: true });
	await writeFile(join(dir, "server", "auth.go"), "package server\n");
	await writeFile(join(dir, "internal.go"), "package main\n");
	await writeFile(join(dir, "SECURITY.md"), "# Security policy\n");
	return dir;
}

function recordingFetcher(posted) {
	return async (url, init) => {
		if (init?.method === "POST") {
			posted.push(JSON.parse(init.body));
			return response(202, { id: `batch-${posted.length}`, status: "validating" });
		}
		if (String(url).includes("/models")) return response(200, { data: [] });
		return response(200, { id: "x", status: "in_progress", request_counts: {} });
	};
}

function createHarness(cwd) {
	const commands = new Map();
	const pi = { on: () => {}, registerCommand: (name, command) => commands.set(name, command), setActiveTools: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
	const ui = {
		widgets: [], notifications: [], confirmations: [],
		theme: { fg: (_name, text) => text }, setStatus: () => {},
		setWidget: (id, value) => ui.widgets.push({ id, value }),
		notify: (message, level) => ui.notifications.push({ message, level }),
		confirm: async (title, body) => { ui.confirmations.push({ title, body }); return false; },
	};
	const ctx = { cwd, hasUI: true, ui, signal: new AbortController().signal, isIdle: () => true, reload: async () => {} };
	codeCartographerExtension(pi);
	return { commands, ctx, ui };
}

test("the security and api lenses fall back to every source file when their targeted globs match nothing", async () => {
	const dir = await nodeService();
	try {
		const info = await collectRepoInfo(dir);
		const [security] = await gatherSlices(dir, getLens("security"), info);
		assert.deepEqual(security.files.sort(), ["src/lib/validate.js", "src/router.js", "src/server.js"], "every source, tests excluded");
		assert.match(security.fallback, /^no files matched .* \(test files excluded\); scanned all javascript sources \(\*\*\/\*\.js\) instead$/);

		// The api lens's targeted globs match router.js by name, so it stays
		// targeted here…
		const [api] = await gatherSlices(dir, getLens("api"), info);
		assert.deepEqual(api.files, ["src/router.js"]);
		assert.equal(api.fallback, undefined);
		// …and falls back the moment the layout names nothing it recognizes.
		await rm(join(dir, "src", "router.js"));
		await writeFile(join(dir, "src", "dispatch.js"), "export class Dispatch {}\n");
		const [apiFallback] = await gatherSlices(dir, getLens("api"), await collectRepoInfo(dir));
		assert.deepEqual(apiFallback.files.sort(), ["src/dispatch.js", "src/lib/validate.js", "src/server.js"]);
		assert.match(apiFallback.fallback, /scanned all javascript sources/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a targeted match never falls back, and lenses without a fallback are untouched", async () => {
	const dir = await goService();
	try {
		const info = await collectRepoInfo(dir);
		const security = await gatherSlices(dir, getLens("security"), info);
		assert.deepEqual(security.flatMap((s) => s.files), ["SECURITY.md", "server/auth.go"], "the targeted scope stands when it matches code");
		assert.equal(security[0].fallback, undefined);
		const defect = await gatherSlices(dir, getLens("defect"), info);
		assert.equal(defect.some((s) => s.fallback), false, "a lens that already reads every source has nothing to fall back to");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a fallback scan is said out loud: in the estimate, the submit report, the run record, status, and the prompt", async () => {
	const dir = await nodeService();
	try {
		const posted = [];
		const seen = [];
		const result = await runBroadsideSubmit(dir, "sk-fake", {
			lenses: ["security"],
			fetcher: recordingFetcher(posted),
			maxCost: 0,
			confirm: (estimate) => { seen.push(estimate); return true; },
		});
		// Estimate: the row carries the sentence, so an approval is informed.
		const row = seen[0].lenses.find((l) => l.lensId === "security");
		assert.match(row.fallback, /scanned all javascript sources/);
		assert.ok(row.cost > 0, "priced as a real scan, not as a skip");

		// Batch entry and the submit report.
		assert.equal(result.batches.security.status, "validating");
		assert.match(result.batches.security.fallback, /no files matched server\/\*\*, \*\*\/auth\*, \*\*\/middleware\/\*\*, SECURITY\.md \(test files excluded\); scanned all javascript sources/);
		const text = estimateSubmitText(result, [getLens("security")]);
		assert.match(text, /Security review: batch batch-1 \(1 request\(s\), ~\$[\d.]+\) — no files matched .*; scanned all javascript sources \(\*\*\/\*\.js\) instead/);

		// The run record and status.
		const { state } = await core.runBroadsideStatus(dir);
		const run = state.runs.at(-1);
		assert.match(run.batches.security.fallback, /scanned all javascript sources/);
		assert.match(statusText(state), /security: validating \(batch-1\) — no files matched .*; scanned all javascript sources/);

		// The prompt tells the model what it is looking at.
		const request = posted[0].requests[0];
		assert.match(request.body.messages[1].content, /^NOTE: this repository has no source files under the paths this lens usually reads \(no files matched .*\)\. What follows is every source file it has, after anything those paths did match; locate the trust boundary/);
		assert.match(request.body.messages[1].content, /=== src\/server\.js ===/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the Pi spend dialog shows the fallback under the lens it applies to", async () => {
	const dir = await nodeService();
	try {
		const posted = [];
		const original = globalThis.fetch;
		globalThis.fetch = recordingFetcher(posted);
		try {
			const { commands, ctx, ui } = createHarness(dir);
			await commands.get("codecarto-broadside").handler("submit security --max-cost=0 --wait=0", ctx);
			assert.equal(ui.confirmations.length, 1);
			assert.match(ui.confirmations[0].body, /Security review: 1 slice — ~\$[\d.]+\n    ↳ no files matched .*; scanned all javascript sources \(\*\*\/\*\.js\) instead/);
			assert.equal(posted.length, 0, "declined in the dialog: nothing submitted");
		} finally {
			globalThis.fetch = original;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a targeted scan's prompt carries no fallback note", async () => {
	const dir = await goService();
	try {
		const info = await collectRepoInfo(dir);
		const lens = getLens("security");
		const [slice] = await gatherSlices(dir, lens, info);
		const request = core.buildBatchRequest(lens, info, slice, 0, 1);
		assert.doesNotMatch(request.body.messages[1].content, /^NOTE: this repository has no/);
		assert.match(request.body.messages[1].content, /^Review these server source files/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a match that is only documents falls back too, keeping the documents ahead of the code", async () => {
	const dir = await nodeService();
	try {
		await writeFile(join(dir, "SECURITY.md"), "# Security policy\n\nReport privately.\n");
		const info = await collectRepoInfo(dir);
		const lens = getLens("security");
		const [slice] = await gatherSlices(dir, lens, info);
		assert.deepEqual(slice.files, ["SECURITY.md", "src/lib/validate.js", "src/router.js", "src/server.js"], "the policy first, then every source, tests excluded");
		assert.equal(
			slice.fallback,
			"no source files matched server/**, **/auth*, **/middleware/**, SECURITY.md (only SECURITY.md; test files excluded); scanned all javascript sources (**/*.js) as well",
		);
		assert.ok(slice.content.indexOf("=== SECURITY.md ===") < slice.content.indexOf("=== src/server.js ==="));
		const request = core.buildBatchRequest(lens, info, slice, 0, 1);
		assert.match(request.body.messages[1].content, /^NOTE: this repository has no source files under the paths this lens usually reads \(no source files matched .*; scanned all javascript sources \(\*\*\/\*\.js\) as well\)\. What follows is every source file it has, after anything those paths did match;/);

		// The submit report and the run record carry the same sentence.
		const posted = [];
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["security"], fetcher: recordingFetcher(posted), maxCost: 0, confirm: () => true });
		assert.match(result.batches.security.fallback, /^no source files matched .* \(only SECURITY\.md; test files excluded\); scanned all javascript sources/);
		assert.match(estimateSubmitText(result, [lens]), /Security review: batch batch-1 \(1 request\(s\), ~\$[\d.]+\) — no source files matched .*; scanned all javascript sources \(\*\*\/\*\.js\) as well/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a long document-only match is abbreviated, and a lens with no sources to fall back to keeps what matched", () => {
	const lens = getLens("security");
	const info = { language: "javascript", sourceGlob: "**/*.js", sourceExts: [".js", ".jsx"] };
	const docs = ["SECURITY.md", "server/README.md", "server/config.yaml", "server/openapi.json", "server/notes.txt"];
	const { files, fallback } = selectLensFiles([...docs, "src/app.js", "src/app.test.js"], lens, info);
	assert.deepEqual(files.map((f) => f.relPath), [...docs, "src/app.js"]);
	assert.match(fallback, /\(only SECURITY\.md, server\/README\.md, server\/config\.yaml and 2 more; test files excluded\)/);

	// Code in another language under the targeted paths is still code: no fallback.
	const mixed = selectLensFiles(["SECURITY.md", "server/index.py", "src/app.js"], lens, info);
	assert.deepEqual(mixed.files.map((f) => f.relPath), ["SECURITY.md", "server/index.py"]);
	assert.equal(mixed.fallback, undefined);

	// An unknown language has no source glob to fall back to: the match stands as it was.
	const unknown = selectLensFiles(["SECURITY.md", "src/app.rb"], lens, { language: "unknown", sourceGlob: "", sourceExts: [] });
	assert.deepEqual(unknown.files.map((f) => f.relPath), ["SECURITY.md"]);
	assert.equal(unknown.fallback, undefined);
});
