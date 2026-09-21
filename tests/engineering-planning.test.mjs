// E04 — planning a repository-local change without a library.
//
// The interesting behaviour here is what planning REFUSES, not what it emits.
// A planner that always produces a plan is a plan-shaped text generator; the
// value is in the cases where it declines and says why, because those are the
// cases where an agent would otherwise proceed on an assumption nobody checked.
//
// E01 owns the record shapes and E02 owns storage. This module composes them:
// it must not re-validate what `validateChangeBundle` already validates, and
// it must not write records itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const engineering = await import(pathToFileURL(resolve("core/engineering/index.ts")).href);
const { buildChangeBrief, buildChangePlan, planReadiness, describeUnprovedObligations } = engineering;

/** A bug fix against an existing repository, no library configured. */
function bugFixRequest(overrides = {}) {
	return {
		title: "resolvePublishSourceRepo records the wrong remote",
		mode: "fix",
		requested_outcome: "The recorded source repo matches origin's fetch URL even when git config rewrites it.",
		baseline: { vcs: "git", head: "a".repeat(40), description: "main at the current checkout" },
		scope: {
			in_scope: ["core/library.ts", "tests/library.test.mjs"],
			non_goals: ["changing how remotes are chosen"],
		},
		preserved_contracts: ["the published record's `source_repo` field shape"],
		acceptance_scenarios: [
			{ id: "s1", kind: "behavior", description: "the failure reproduces before the fix and not after" },
			{ id: "s2", kind: "preserved", description: "an unrewritten remote is still recorded verbatim" },
		],
		...overrides,
	};
}

function slice(overrides = {}) {
	return {
		title: "neutralize the config rewrite in tests",
		deliverable: "a shared helper that clears git's env-reachable config sources",
		scenario_ids: ["s1"],
		depends_on: [],
		proof_obligations: [
			{ id: "o1", scenario_id: "s1", check_kind: "test", description: "the suite passes under injection", minimum_collector: "host-observed" },
		],
		permitted_scope: { paths: ["tests/**"] },
		...overrides,
	};
}

// ---------------------------------------------------------------
// The brief: what the agent is being asked to do, grounded in the repo.
// ---------------------------------------------------------------

test("a brief carries the requested outcome, baseline, scope, and acceptance ids", () => {
	const brief = buildChangeBrief(bugFixRequest());
	assert.equal(brief.ok, true);
	const text = brief.markdown;
	assert.match(text, /resolvePublishSourceRepo records the wrong remote/);
	assert.match(text, /main at the current checkout/);
	assert.match(text, /core\/library\.ts/);
	assert.match(text, /changing how remotes are chosen/, "non-goals must survive into the brief");
	assert.match(text, /\bs1\b/);
	assert.match(text, /\bs2\b/);
	assert.match(text, /the published record's `source_repo` field shape/, "preserved contracts must appear");
});

test("a brief states its own uncertainty rather than reading as settled fact", () => {
	// A brief that presents an unverified premise as established is worse than
	// no brief: the agent inherits the confidence without the evidence.
	const brief = buildChangeBrief(
		bugFixRequest({
			uncertainties: ["whether GIT_CONFIG_PARAMETERS is also reachable here"],
		}),
	);
	assert.equal(brief.ok, true);
	assert.match(brief.markdown, /GIT_CONFIG_PARAMETERS/);
	assert.match(brief.markdown, /uncertain|unverified|not established|open question/i);
});

test("a feature with no acceptance scenarios is refused, not planned", () => {
	const brief = buildChangeBrief(bugFixRequest({ mode: "feature", acceptance_scenarios: [] }));
	assert.equal(brief.ok, false);
	assert.ok(
		brief.errors.some((e) => e.code === "invalid-value" && /acceptance/i.test(e.message)),
		`expected an acceptance-scenario refusal, got ${JSON.stringify(brief.errors)}`,
	);
});

test("a change with no library configured plans normally", () => {
	// The whole point of E04: zero external references is the NORMAL case,
	// not a degraded one. No warning, no placeholder reference, no prompt to
	// configure a library.
	const brief = buildChangeBrief(bugFixRequest({ references: [] }));
	assert.equal(brief.ok, true);
	assert.doesNotMatch(brief.markdown, /library is not configured|configure a library|no library/i);
});

// ---------------------------------------------------------------
// References: optional, but exact when present.
// ---------------------------------------------------------------

test("an optional reference is carried only with an exact version", () => {
	const withVersion = buildChangeBrief(
		bugFixRequest({ references: [{ id: "lib_0000000000000000000000r1", version: "1.4.2", digest: "sha256:" + "b".repeat(64) }] }),
	);
	assert.equal(withVersion.ok, true);
	assert.match(withVersion.markdown, /1\.4\.2/);

	const floating = buildChangeBrief(
		bugFixRequest({ references: [{ id: "lib_0000000000000000000000r1", version: "latest", digest: "sha256:" + "b".repeat(64) }] }),
	);
	assert.equal(floating.ok, false, "a floating version is not a reference, it is a hope");
	assert.ok(floating.errors.some((e) => /version/i.test(e.message)));
});

test("a stale local finding is named as stale rather than silently used", () => {
	const brief = buildChangeBrief(
		bugFixRequest({
			local_findings: [{ path: "findings/architecture/report.md", captured_at: "2026-01-02T00:00:00Z", stale: true }],
		}),
	);
	assert.equal(brief.ok, true);
	assert.match(brief.markdown, /findings\/architecture\/report\.md/);
	assert.match(brief.markdown, /stale|out of date|may no longer/i);
});

// ---------------------------------------------------------------
// The plan: slices with proof obligations.
// ---------------------------------------------------------------

test("a plan lists each slice with its deliverable and proof obligations", () => {
	const plan = buildChangePlan(bugFixRequest(), [slice()]);
	assert.equal(plan.ok, true);
	assert.match(plan.markdown, /neutralize the config rewrite in tests/);
	assert.match(plan.markdown, /a shared helper that clears git's env-reachable config sources/);
	assert.match(plan.markdown, /the suite passes under injection/);
	assert.match(plan.markdown, /host-observed/, "the minimum collector is part of the obligation");
});

test("a slice proving no scenario is refused", () => {
	const plan = buildChangePlan(bugFixRequest(), [slice({ scenario_ids: [], proof_obligations: [] })]);
	assert.equal(plan.ok, false);
	assert.ok(plan.errors.some((e) => /scenario/i.test(e.message)));
});

test("a slice naming a scenario the change does not have is refused", () => {
	// The obligation cross-check fires on this input too, so asserting merely
	// "some unknown-reference" passes even when the scenario_ids check is
	// removed. Pin the exact path so this test fails for its own reason.
	const plan = buildChangePlan(bugFixRequest(), [slice({ scenario_ids: ["s9"], proof_obligations: [] })]);
	assert.equal(plan.ok, false);
	assert.ok(
		plan.errors.some((e) => e.code === "unknown-reference" && e.path === "/slices/0/scenario_ids/0" && /no scenario s9/.test(e.message)),
		`expected an unknown-reference at /slices/0/scenario_ids/0, got ${JSON.stringify(plan.errors)}`,
	);
});

test("a dependency cycle between slices is refused", () => {
	// E01 checks that a slice does not depend on ITSELF and that every
	// dependency names a real slice. Neither catches a -> b -> a.
	const a = { ...slice({ title: "A" }), id: "slc_0000000000000000000000a1", depends_on: ["slc_0000000000000000000000b1"] };
	const b = { ...slice({ title: "B" }), id: "slc_0000000000000000000000b1", depends_on: ["slc_0000000000000000000000a1"] };
	const plan = buildChangePlan(bugFixRequest(), [a, b]);
	assert.equal(plan.ok, false);
	assert.ok(
		plan.errors.some((e) => /cycle/i.test(e.message)),
		`expected a cycle refusal, got ${JSON.stringify(plan.errors)}`,
	);
});

test("a longer dependency cycle is refused too", () => {
	const mk = (suffix, dep) => ({
		...slice({ title: suffix }),
		id: `slc_000000000000000000000${suffix}`,
		depends_on: [`slc_000000000000000000000${dep}`],
	});
	const plan = buildChangePlan(bugFixRequest(), [mk("a1", "b1"), mk("b1", "c1"), mk("c1", "a1")]);
	assert.equal(plan.ok, false);
	assert.ok(plan.errors.some((e) => /cycle/i.test(e.message)));
});

test("a scenario no slice covers is reported as an uncovered obligation", () => {
	// s2 exists on the change but no slice proves it. That is not necessarily
	// an error — it may be deliberate — but it must be VISIBLE, never implied
	// to be covered.
	const plan = buildChangePlan(bugFixRequest(), [slice()]);
	assert.equal(plan.ok, true);
	// The heading must exist as a heading. Matching only the body prose passes
	// even when the section is removed, because the per-scenario line repeats
	// the same words.
	assert.match(plan.markdown, /^## Unproved acceptance scenarios$/m);
	assert.match(plan.markdown, /^- `s2` — .*no slice in this plan claims to prove it/m);
});

// ---------------------------------------------------------------
// Readiness: is this plan executable yet?
// ---------------------------------------------------------------

test("a plan with no build or test environment is not executable", () => {
	const readiness = planReadiness(bugFixRequest(), [slice()], { build_command: null, test_command: null });
	assert.equal(readiness.executable, false);
	assert.ok(
		readiness.blockers.some((b) => /build|test/i.test(b)),
		`expected a missing-environment blocker, got ${JSON.stringify(readiness.blockers)}`,
	);
});

test("a plan whose obligations are all host-executed is executable when commands exist", () => {
	const readiness = planReadiness(bugFixRequest(), [slice()], { build_command: "npm run build", test_command: "npm test" });
	assert.equal(readiness.executable, true);
	assert.deepEqual(readiness.blockers, []);
});

test("a bounded investigation is executable without a test command", () => {
	// Investigation produces a finding, not a passing suite. Requiring a test
	// command here would block the very work that establishes whether a fix is
	// even possible.
	const investigation = bugFixRequest({
		mode: "investigation",
		acceptance_scenarios: [{ id: "s1", kind: "behavior", description: "state whether the rewrite is reachable via env" }],
	});
	const readiness = planReadiness(
		investigation,
		[slice({ scenario_ids: ["s1"], proof_obligations: [{ id: "o1", scenario_id: "s1", check_kind: "manual-procedure", description: "record what was observed", minimum_collector: "host-observed" }] })],
		{ build_command: null, test_command: null },
	);
	assert.equal(readiness.executable, true, `investigation should not need a test command: ${JSON.stringify(readiness.blockers)}`);
});

test("unproved obligations are listed explicitly, never summarized away", () => {
	const unproved = describeUnprovedObligations(bugFixRequest(), [slice()]);
	assert.ok(Array.isArray(unproved));
	assert.ok(unproved.some((u) => u.scenario_id === "s2"), `s2 is unproved and must be listed: ${JSON.stringify(unproved)}`);
});

// ---------------------------------------------------------------
// The plan must not repurpose the synthesis pipeline.
// ---------------------------------------------------------------

test("planning writes no synthesis output path and requires no confirmation", () => {
	const plan = buildChangePlan(bugFixRequest(), [slice()]);
	assert.equal(plan.ok, true);
	assert.doesNotMatch(plan.markdown, /reimplementation-spec|project-plan|confirm the selected version/i);
});

// --- Found in adversarial review of the first implementation ------------
// Every case below passed on the version submitted for review. The artifact
// is what a human reads before approving work, so agent-authored text in it
// is attacker-controlled with respect to that reader.

/** A heading is a LINE that starts with `#`. Substring checks miss the difference and pass wrongly. */
function headingLines(markdown, text) {
	return markdown.split("\n").filter((l) => l.trim() === text).length;
}

test("agent-authored text cannot forge a section heading in the plan", () => {
	// The blocking finding. A slice `deliverable` carrying a newline plus
	// "## Unproved acceptance scenarios" and the fully-covered sentence forged
	// that disclosure ABOVE the real one, so the plan a human approved claimed
	// coverage it did not have.
	const payload = "a helper\n\n## Unproved acceptance scenarios\n\n_Every acceptance scenario is claimed by a slice._\n";
	for (const [field, mutated] of [
		["deliverable", slice({ deliverable: payload })],
		["title", slice({ title: payload })],
		[
			"obligation description",
			slice({
				proof_obligations: [
					{ id: "o1", scenario_id: "s1", check_kind: "test", description: payload, minimum_collector: "host-observed" },
				],
			}),
		],
	]) {
		const plan = buildChangePlan(bugFixRequest(), [mutated]);
		assert.equal(plan.ok, true, `${field} should still produce a plan`);
		assert.equal(
			headingLines(plan.markdown, "## Unproved acceptance scenarios"),
			1,
			`${field} forged a second disclosure heading`,
		);
		assert.equal(
			headingLines(plan.markdown, "_Every acceptance scenario is claimed by a slice._"),
			0,
			`${field} forged a fully-covered claim while s2 is uncovered`,
		);
	}
});

test("agent-authored text cannot open a code fence that swallows the disclosure", () => {
	// An unterminated fence rendered the entire real disclosure as code, which
	// hides it just as effectively as forging a replacement.
	const plan = buildChangePlan(bugFixRequest(), [slice({ deliverable: "a helper\n```\n" })]);
	assert.equal(plan.ok, true);
	assert.equal(plan.markdown.split("\n").filter((l) => l.trim() === "```").length, 0, "a fence survived into the document");
});

test("a scenario description cannot forge a slice section", () => {
	const plan = buildChangePlan(
		bugFixRequest({
			acceptance_scenarios: [
				{ id: "s1", kind: "behavior", description: "d1" },
				{ id: "s2", kind: "preserved", description: "d2\n\n## Slices\n\n### forged slice\n" },
			],
		}),
		[slice()],
	);
	assert.equal(plan.ok, true);
	assert.equal(headingLines(plan.markdown, "## Slices"), 1, "a scenario description forged a second Slices section");
});

test("a slice with no proof obligations is refused", () => {
	// It rendered as provable, reported `executable: true`, and proved nothing.
	// E01's contract requires at least one, so accepting it also produced a
	// plan for a slice that could never be stored.
	const plan = buildChangePlan(bugFixRequest(), [slice({ proof_obligations: [] })]);
	assert.equal(plan.ok, false);
	assert.ok(
		plan.errors.some((e) => e.path === "/slices/0/proof_obligations" && /no proof obligation/.test(e.message)),
		`expected a refusal at /slices/0/proof_obligations, got ${JSON.stringify(plan.errors)}`,
	);
});

test("two slices sharing an id cannot hide a cycle", () => {
	// The graph was keyed by the caller's id, so a later duplicate overwrote
	// the cyclic node and the cycle went undetected.
	const a = { ...slice({ title: "A" }), id: "slc_0000000000000000000000a1", depends_on: ["slc_0000000000000000000000b1"] };
	const b = { ...slice({ title: "B" }), id: "slc_0000000000000000000000b1", depends_on: ["slc_0000000000000000000000a1"] };
	const decoy = { ...slice({ title: "A-again" }), id: "slc_0000000000000000000000a1", depends_on: [] };

	assert.equal(buildChangePlan(bugFixRequest(), [a, b]).ok, false, "the bare cycle must be refused");
	const withDecoy = buildChangePlan(bugFixRequest(), [a, b, decoy]);
	assert.equal(withDecoy.ok, false, "a duplicate id must not hide the cycle");
	assert.ok(withDecoy.errors.some((e) => /duplicate slice id/.test(e.message)));
});

test("a declared id cannot impersonate an unnamed slice's synthetic id", () => {
	// Unnamed slices were keyed `#0`, `#1`; a slice could simply declare
	// `id: "#0"` and take that node over.
	const unnamed = slice({ title: "unnamed", depends_on: ["#1"] });
	const impostor = { ...slice({ title: "impostor" }), id: "#0", depends_on: [] };
	const plan = buildChangePlan(bugFixRequest(), [unnamed, impostor]);
	// The dependency `#1` resolves to nothing now that ids are not synthesized,
	// so this is a plan with an unresolvable dependency rather than a cycle —
	// what matters is that the impostor cannot become node `#0`.
	assert.equal(plan.ok, true);
	assert.match(plan.markdown, /### unnamed/);
	assert.match(plan.markdown, /### impostor/);
});

test("a branch pointer wearing a version's clothes is refused", () => {
	// `1.0+main` satisfies a semver-shaped pattern and resolves to different
	// bytes tomorrow, which is the exact failure a bound reference prevents.
	for (const version of ["1.0+main", "1.0-latest", "1.0-HEAD", "0001.0002"]) {
		const brief = buildChangeBrief(
			bugFixRequest({ references: [{ id: "lib_x", version, digest: `sha256:${"b".repeat(64)}` }] }),
		);
		assert.equal(brief.ok, false, `${version} must be refused as a floating version`);
	}
	// A full commit hash is maximally exact and is accepted.
	const exact = buildChangeBrief(
		bugFixRequest({ references: [{ id: "lib_x", version: "a".repeat(40), digest: `sha256:${"b".repeat(64)}` }] }),
	);
	assert.equal(exact.ok, true, `a commit hash should be accepted: ${JSON.stringify(exact.errors)}`);
});

test("a reference without a digest is refused, because E01 requires one", () => {
	// Accepting it produced a plan for a change that could never be stored.
	const brief = buildChangeBrief(bugFixRequest({ references: [{ id: "lib_x", version: "1.4.2" }] }));
	assert.equal(brief.ok, false);
	assert.ok(brief.errors.some((e) => e.path === "/references/0/digest"));
});

test("the plan refuses everything the brief refuses", () => {
	// The plan validated neither `mode` nor `references`, so a plan was
	// produced for a change the brief had already rejected.
	const bogus = bugFixRequest({ mode: "not-a-mode", references: [{ id: "x", version: "latest" }] });
	assert.equal(buildChangeBrief(bogus).ok, false);
	assert.equal(buildChangePlan(bogus, [slice()]).ok, false, "the plan must refuse what the brief refuses");
});

test("a slice naming the same scenario twice is refused", () => {
	// E01's `uniqueStrings` refuses this; accepting it here diverged from the
	// contract.
	const plan = buildChangePlan(bugFixRequest(), [slice({ scenario_ids: ["s1", "s1"] })]);
	assert.equal(plan.ok, false);
	assert.ok(plan.errors.some((e) => /same scenario twice/.test(e.message)));
});

test("a non-list where a list belongs is refused, not thrown", () => {
	// `preserved_contracts: "a string"` escaped as a TypeError from
	// `items.map`, which a caller cannot distinguish from a bug in the planner.
	for (const [field, bad] of [
		["preserved_contracts", bugFixRequest({ preserved_contracts: "a string" })],
		["scope.in_scope", bugFixRequest({ scope: { in_scope: {}, non_goals: [] } })],
	]) {
		let outcome;
		assert.doesNotThrow(() => {
			outcome = buildChangeBrief(bad);
		}, `${field} threw instead of refusing`);
		assert.equal(outcome.ok, false, `${field} must be refused`);
	}
});

test("a getter cannot show the validator one scenario list and the renderer another", () => {
	// `acceptance_scenarios` was read three times, so a getter could validate
	// against a full list and render coverage against a shorter one — the plan
	// then claimed every scenario was claimed while a real gap existed.
	const full = [
		{ id: "s1", kind: "behavior", description: "d1" },
		{ id: "s2", kind: "preserved", description: "d2" },
	];
	let reads = 0;
	const toctou = { ...bugFixRequest() };
	Object.defineProperty(toctou, "acceptance_scenarios", {
		get() {
			reads += 1;
			return reads <= 1 ? full : [full[0]];
		},
		enumerable: true,
	});

	const plan = buildChangePlan(toctou, [slice()]);
	assert.equal(plan.ok, true);
	assert.equal(
		headingLines(plan.markdown, "_Every acceptance scenario is claimed by a slice._"),
		0,
		"the plan claimed full coverage while s2 was uncovered",
	);
	assert.match(plan.markdown, /^- `s2` — /m, "s2 must still be disclosed as unproved");
});

test("investigation waives the test command but not the build command", () => {
	// The exemption was blanket, so an investigation claiming a `build`
	// obligation reported `executable: true` with no build command.
	const investigation = bugFixRequest({
		mode: "investigation",
		acceptance_scenarios: [{ id: "s1", kind: "behavior", description: "state whether the rewrite is reachable" }],
	});
	const buildSlice = slice({
		scenario_ids: ["s1"],
		proof_obligations: [
			{ id: "o1", scenario_id: "s1", check_kind: "build", description: "it compiles", minimum_collector: "host-observed" },
		],
	});
	const readiness = planReadiness(investigation, [buildSlice], { build_command: null, test_command: null });
	assert.equal(readiness.executable, false, "a build obligation still needs a build command");
	assert.ok(readiness.blockers.some((b) => /build/.test(b)));
});

test("an obligation whose minimum collector is the agent's own word is refused", () => {
	// No test covered this, so the runtime guard its comment defends was
	// untested — the mutation that deleted it survived.
	const plan = buildChangePlan(bugFixRequest(), [
		slice({
			proof_obligations: [
				{ id: "o1", scenario_id: "s1", check_kind: "test", description: "x", minimum_collector: "agent-claimed" },
			],
		}),
	]);
	assert.equal(plan.ok, false);
	assert.ok(
		plan.errors.some((e) => e.path === "/slices/0/proof_obligations/0/minimum_collector"),
		`expected a collector refusal, got ${JSON.stringify(plan.errors)}`,
	);
});
