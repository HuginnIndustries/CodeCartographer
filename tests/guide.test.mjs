// The packaged agent skill and the codecarto_guide tool that serves it.
// The content assertions target the contract facts an integration gets wrong
// when it reverse-engineers the server instead of reading a spec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(join(REPO_ROOT, "core/index.ts")).href);
const SKILL_DIR = join(REPO_ROOT, "agent-skill", "codecartographer");

test("listGuideTopics returns overview first, then every reference", async () => {
	const topics = await core.listGuideTopics();
	assert.equal(topics[0], "overview");
	for (const expected of ["executors", "handoff-contract", "library", "orchestration", "phase-recovery", "pipeline-selection"]) {
		assert.ok(topics.includes(expected), `missing guide topic ${expected}`);
	}
	assert.equal(new Set(topics).size, topics.length, "topics must be unique");
});

test("readGuide defaults to the overview and strips installer frontmatter", async () => {
	const doc = await core.readGuide();
	assert.equal(doc.topic, "overview");
	assert.ok(!doc.content.startsWith("---"), "frontmatter must not reach the client");
	assert.ok(!doc.content.includes("license: MIT"), "installer metadata must not reach the client");
	assert.match(doc.content, /^# Driving CodeCartographer/, "body should start at the heading");
});

test("readGuide returns each reference body", async () => {
	for (const topic of await core.listGuideTopics()) {
		const doc = await core.readGuide(topic);
		assert.equal(doc.topic, topic);
		assert.ok(doc.content.trim().length > 200, `${topic} body is suspiciously short`);
	}
});

test("readGuide rejects an unknown topic and names the valid ones", async () => {
	await assert.rejects(() => core.readGuide("nonsense"), /Unknown guide topic nonsense/);
	await assert.rejects(() => core.readGuide("nonsense"), /overview/);
});

test("the guide teaches the handoff contract, not direct status.yaml writes", async () => {
	// An integration that reverse-engineered this server documented writing and
	// repairing status.yaml directly and never mentioned handoffs; against the
	// current completion gate that guidance fails outright. The guide exists to
	// make that contract explicit, so assert it actually says so.
	const overview = (await core.readGuide("overview")).content;
	assert.match(overview, /scratch\/handoffs\/<phase-id>\.yaml/, "must name the handoff path");
	assert.match(overview, /[Nn]ever write those files|[Nn]ever hand-edit/, "must forbid writing framework-owned files");
	assert.match(overview, /codecarto_validate/);
	assert.match(overview, /codecarto_complete/);

	const handoff = (await core.readGuide("handoff-contract")).content;
	for (const field of ["schema_version", "phase_id", "carry_forward", "carry_forward_closures", "closeout_summary"]) {
		assert.ok(handoff.includes(field), `handoff reference omits ${field}`);
	}
});

test("the guide's pipeline aliases match the ones the loader accepts", async () => {
	const selection = (await core.readGuide("pipeline-selection")).content;
	for (const alias of Object.keys(core.PIPELINE_ALIASES)) {
		assert.ok(selection.includes(`\`${alias}\``), `pipeline reference omits the ${alias} alias`);
	}
});

test("the guide stays executor-agnostic", async () => {
	// The skill must describe a contract any executor can satisfy rather than
	// hard-coding one vendor's CLI, so a user's best available model is usable.
	const executors = (await core.readGuide("executors")).content;
	assert.match(executors, /executor contract/i);
	assert.match(executors, /strongest model available/i);
	assert.match(executors, /largest usable context/i);
});

test("the rewrite references carry the disposition vocabulary the porting phase uses", async () => {
	// The porting template asks for a disposition per defect. If the guide and
	// the template drift apart, a session produces a bundle the next phase
	// cannot act on.
	const synthesis = (await core.readGuide("deep-audit-synthesis")).content;
	for (const disposition of ["fix before porting", "port differently", "leave behind"]) {
		assert.ok(synthesis.includes(disposition), `deep-audit synthesis omits the "${disposition}" disposition`);
	}
	assert.match(synthesis, /acceptance[- ]test/i, "hazards must be tied to acceptance tests");

	const kernel = (await core.readGuide("kernel-first-rewrite")).content;
	assert.match(kernel, /language-agnostic/i, "must say when to keep the spec language-agnostic");
	assert.match(kernel, /fake/i, "must describe the fake-driven acceptance harness");
});

test("the Broad-Side reference states the rule the feature rests on", async () => {
	// Broad-Side output is a cheap model's one-shot guesses. The single way it
	// can actively harm a run is an agent citing a lead as a finding, so the
	// reference that teaches the tool must say so outright.
	const topics = await core.listGuideTopics();
	assert.ok(topics.includes("broadside"), "broadside must be a guide topic");
	const broadside = (await core.readGuide("broadside")).content;
	assert.match(broadside, /unverified/i, "must mark findings unverified");
	assert.match(broadside, /never (be )?evidence|not evidence|leads, never evidence/i);
	assert.match(broadside, /max_cost/, "must name the cost guardrail");
	assert.match(broadside, /codecarto_broadside/, "must name the tool an agent calls");
});

test("SKILL.md carries frontmatter a skill installer can read", async () => {
	const raw = await readFile(join(SKILL_DIR, "SKILL.md"), "utf8");
	assert.match(raw, /^---\r?\n/, "SKILL.md must open with frontmatter");
	assert.match(raw, /^name: codecartographer$/m);
	assert.match(raw, /^description: .{40,}$/m, "description must be substantial enough to route on");
});

test("every reference the skill links resolves to a real topic", async () => {
	const raw = await readFile(join(SKILL_DIR, "SKILL.md"), "utf8");
	const topics = await core.listGuideTopics();
	const linked = [...raw.matchAll(/references\/([\w-]+)\.md/g)].map((match) => match[1]);
	assert.ok(linked.length > 0, "SKILL.md should link its references");
	for (const name of new Set(linked)) {
		assert.ok(topics.includes(name), `SKILL.md links references/${name}.md which is not a guide topic`);
	}
});

test("the guide never instructs writing framework-owned files", async () => {
	// Same rule the template is held to. The document that teaches the handoff
	// contract is the last place that should drift back to direct state writes,
	// and prohibitions ("never hand-edit status.yaml") must still read naturally.
	const forbidden = [
		/mirror\s+(?:these|them|it)\s+into\s+(?:`?workflow\/)?status\.yaml/i,
		/\bupdate\s+(?:`?[\w.-]+`?\s*[/,]\s*)*`?(?:workflow\/)?status\.yaml`?/i,
		/\bappend[^.\n]*\bto\s+`?THREAD_LOG\.md`?/i,
	];
	const negation = /\b(?:do not|don'?t|never|must not|cannot|can'?t|rather than|instead of|without)\b[^.]{0,60}$/i;
	const violations = [];
	for (const topic of await core.listGuideTopics()) {
		const lines = (await core.readGuide(topic)).content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			for (const re of forbidden) {
				const match = re.exec(lines[i]);
				if (match && !negation.test(lines[i].slice(0, match.index))) {
					violations.push(`${topic}:${i + 1} ${lines[i].trim()}`);
				}
			}
		}
	}
	assert.deepEqual(violations, [], `guide instructs writing framework-owned state:\n${violations.join("\n")}`);
});

test("codecarto_guide returns the overview and advertises other topics", async () => {
	const { handleGuide } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
	const result = await handleGuide({});
	const text = result.content[0].text;
	assert.match(text, /# Driving CodeCartographer/);
	assert.match(text, /Other guide topics: .*handoff-contract/);
	assert.equal(result.structuredContent.topic, "overview");
});

test("codecarto_guide serves a requested topic and rejects a bad one", async () => {
	const { handleGuide } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
	const result = await handleGuide({ topic: "phase-recovery" });
	assert.match(result.content[0].text, /Recovering a stalled or failed phase/);
	await assert.rejects(() => handleGuide({ topic: "../package" }), /Unknown guide topic/);
});
