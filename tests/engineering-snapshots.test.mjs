// Snapshot collection semantics (E03, #401).
//
// E01's contract test pins what a snapshot *is*; this pins how one is built
// and compared. The load-bearing properties, in the order the issue states
// them: the same bytes are stable, a change anywhere relevant changes the
// identity, the engineering namespace and secrets are excluded without
// silently pretending the tree is fully covered, and a dirty tree cannot be
// reduced to a HEAD revision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineering = await import(pathToFileURL(`${REPO_ROOT}/core/engineering/index.ts`).href);
const barrel = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { collectSnapshot, candidateMayBindAcceptance, diffSnapshots, patternCovers, ALWAYS_EXCLUDED, computeSnapshotDigest, validateRecord, checkCandidateFreshness } = engineering;
const { isSupportedPattern, compareUtf8 } = engineering;

const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const file = (path, body, extra = {}) => ({ path, type: "file", digest: sha(body), executable: false, size: Buffer.byteLength(body), ...extra });

/** The plain repository block the second-review regressions build on. */
const REPOSITORY = { vcs: "git", head: "a".repeat(40), dirty: false };

/** A small, realistic tree. */
function tree(overrides = []) {
	const base = [file("src/index.ts", "export const a = 1;\n"), file("src/util.ts", "export const b = 2;\n"), file("README.md", "# demo\n")];
	return [...base, ...overrides];
}

const repository = { vcs: "git", head: "a".repeat(40), dirty: false };
const collect = (entries, rest = {}) => collectSnapshot({ entries, repository, ...rest });
const ok = (result) => {
	assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.errors) : "");
	return result.value;
};

test("the module is re-exported through both barrels and imports no side-effecting module", async () => {
	for (const name of ["collectSnapshot", "candidateMayBindAcceptance", "diffSnapshots"]) {
		assert.equal(typeof engineering[name], "function", name);
		assert.equal(typeof barrel[name], "function", `core/index.ts re-exports ${name}`);
	}
	const source = await readFile(join(REPO_ROOT, "core/engineering/snapshots.ts"), "utf8");
	const imports = [...source.matchAll(/^import .*? from "(.*?)";$/gm)].map((m) => m[1]);
	assert.deepEqual(
		[...new Set(imports)].sort(),
		["../secrets.ts", "./digest.ts", "./ids.ts", "./types.ts"],
		"snapshots.ts imports only the contract's own modules and the shared secret-path list",
	);
	assert.ok(!source.includes('from "./index.ts"'), "no module in core/engineering/ imports the barrel");
	assert.ok(!/require\(|child_process|node:fs/.test(source), "collection is pure: the host reads the tree, this module does not");
});

test("the same bytes produce the same identity, and any relevant change moves it", () => {
	const a = ok(collect(tree()));
	const b = ok(collect(tree()));
	assert.equal(a.digest, b.digest, "same observation, same digest");
	assert.equal(a.stability, "stable");

	// Entry order from the host must not matter: the manifest is sorted.
	const shuffled = ok(collect([...tree()].reverse()));
	assert.equal(shuffled.digest, a.digest, "host enumeration order is not part of the identity");
	assert.deepEqual(
		shuffled.manifest.map((e) => e.path),
		["README.md", "src/index.ts", "src/util.ts"],
		"strictly ascending in UTF-8 byte order",
	);

	// Each of these is a different tree and must not reuse the digest.
	const changed = ok(collect([file("src/index.ts", "export const a = 2;\n"), file("src/util.ts", "export const b = 2;\n"), file("README.md", "# demo\n")]));
	const deleted = ok(collect([file("src/index.ts", "export const a = 1;\n"), file("README.md", "# demo\n")]));
	const added = ok(collect(tree([file("src/new.ts", "export const c = 3;\n")])));
	const mode = ok(collect([file("src/index.ts", "export const a = 1;\n", { executable: true }), file("src/util.ts", "export const b = 2;\n"), file("README.md", "# demo\n")]));
	const link = ok(collect(tree([{ path: "src/link.ts", type: "symlink", target: "./index.ts" }])));
	const relinked = ok(collect(tree([{ path: "src/link.ts", type: "symlink", target: "./util.ts" }])));

	const digests = [a.digest, changed.digest, deleted.digest, added.digest, mode.digest, link.digest, relinked.digest];
	assert.equal(new Set(digests).size, digests.length, "changed content, deletion, addition, mode change, and a retargeted symlink each change the identity");
});

test("a symlink carries its link text and is never followed, even when it escapes the repository", () => {
	const escaping = ok(collect(tree([{ path: "src/escape", type: "symlink", target: "../../../../etc/passwd" }])));
	const entry = escaping.manifest.find((e) => e.path === "src/escape");
	assert.deepEqual(entry, { path: "src/escape", type: "symlink", target: "../../../../etc/passwd" });
	assert.ok(!("digest" in entry), "a symlink is identified by its target text, never by the bytes it points at");
	// The escaping link is data about the tree, so it changes identity rather than being dropped.
	assert.notEqual(escaping.digest, ok(collect(tree())).digest);
});

test("the engineering namespace is always excluded, so a snapshot cannot invalidate itself", () => {
	assert.deepEqual(ALWAYS_EXCLUDED, [{ pattern: ".codecarto/engineering/**", reason: "engineering-namespace" }]);
	const withRecords = tree([
		file(".codecarto/engineering/changes/chg_1/record.json", '{"a":1}'),
		file(".codecarto/engineering/inbox/1.json", '{"b":2}'),
	]);
	const result = ok(collect(withRecords));
	assert.equal(result.digest, ok(collect(tree())).digest, "engineering records are not part of the tree's identity");
	assert.deepEqual(result.dropped.map((d) => d.reason).sort(), ["engineering-namespace", "engineering-namespace"]);
	assert.ok(result.coverage.excluded.some((e) => e.reason === "engineering-namespace"), "the exclusion is disclosed");
	assert.deepEqual(result.coverage.uncovered_relevant_inputs, [], "an excluded namespace is not an uncovered relevant input");
});

test("a secret file is excluded by name, its digest is never recorded, and the exclusion is disclosed", () => {
	const withSecrets = tree([file(".env", "API_KEY=sk-live-abcdefghijklmnopqrst\n"), file("deploy/credentials.json", '{"token":"x"}'), file("certs/server.pem", "-----BEGIN PRIVATE KEY-----\n")]);
	const result = ok(collect(withSecrets));
	const serialized = JSON.stringify(result);
	for (const name of [".env", "deploy/credentials.json", "certs/server.pem"]) {
		assert.ok(!result.manifest.some((e) => e.path === name), `${name} is not in the manifest`);
		assert.ok(result.coverage.excluded.some((e) => e.pattern === name && e.reason === "secret"), `${name} is disclosed as a secret exclusion`);
	}
	assert.ok(!serialized.includes("sk-live-abcdefghijklmnopqrst"), "no secret value reaches the record");
	assert.ok(!/sha256:[0-9a-f]{64}/.test(JSON.stringify(result.coverage)), "a secret's digest is not recorded: it would be an oracle for the file");
	// Changing a secret's contents does not change the tree identity — but the
	// exclusion is visible, so a reader knows the coverage is partial.
	const rotated = ok(collect(tree([file(".env", "API_KEY=sk-live-zzzzzzzzzzzzzzzzzzzz\n"), file("deploy/credentials.json", '{"token":"x"}'), file("certs/server.pem", "-----BEGIN PRIVATE KEY-----\n")])));
	assert.equal(rotated.digest, result.digest);
});

test("an unreadable or host-skipped path becomes an uncovered relevant input, never a silent omission", () => {
	const withGap = ok(
		collect([...tree(), { path: "src/huge.bin", type: "unreadable", reason: "exceeds the collector's size limit" }], {
			uncovered_relevant_inputs: ["vendor/opaque"],
		}),
	);
	assert.deepEqual(withGap.coverage.uncovered_relevant_inputs, ["src/huge.bin", "vendor/opaque"], "sorted, merged, and disclosed");
	assert.ok(!withGap.manifest.some((e) => e.path === "src/huge.bin"), "an unreadable file is not in the manifest");
	// An uncovered input must change the identity: the alternative is a tree
	// that looks identical to one where the file was read and unchanged.
	assert.notEqual(withGap.digest, ok(collect(tree())).digest, "coverage is part of the identity");
});

test("an uncovered relevant input blocks acceptance rather than implying completeness", () => {
	const base = { role: "candidate", stability: "stable", collector: "host-observed", attested_by: "adapter", coverage: { uncovered_relevant_inputs: [] } };
	assert.deepEqual(candidateMayBindAcceptance(base), { ok: true });

	const gapped = candidateMayBindAcceptance({ ...base, coverage: { uncovered_relevant_inputs: ["vendor/opaque", "src/huge.bin"] } });
	assert.equal(gapped.ok, false);
	assert.match(gapped.reasons.join(" "), /2 relevant input\(s\) were not covered/);
	assert.match(gapped.reasons.join(" "), /an unchanged digest cannot mean an unchanged tree/);

	// The contract's other snapshot rules, restated where the gate can reach them.
	assert.equal(candidateMayBindAcceptance({ ...base, stability: "unstable" }).ok, false, "a tree that moved during capture");
	assert.equal(candidateMayBindAcceptance({ ...base, collector: "agent-claimed" }).ok, false, "an agent's account of the tree");
	assert.equal(candidateMayBindAcceptance({ ...base, attested_by: "caller" }).ok, false, "a caller-attested candidate");
	assert.equal(candidateMayBindAcceptance({ ...base, role: "baseline" }).ok, false, "a baseline is not a candidate");
	const every = candidateMayBindAcceptance({ role: "baseline", stability: "unstable", collector: "agent-claimed", attested_by: "caller", coverage: { uncovered_relevant_inputs: ["x"] } });
	assert.equal(every.reasons.length, 5, "every failing rule is reported, not just the first");
});

test("a dirty tree cannot be reduced to its HEAD revision", () => {
	const clean = ok(collectSnapshot({ entries: tree(), repository: { vcs: "git", head: "a".repeat(40), dirty: false } }));
	const dirty = ok(collectSnapshot({ entries: tree([file("src/wip.ts", "// uncommitted\n")]), repository: { vcs: "git", head: "a".repeat(40), dirty: true } }));
	assert.notEqual(dirty.digest, clean.digest, "same HEAD, different working bytes, different identity");

	// The same HEAD with *edited* tracked content is the case the issue names:
	// evidence bound to the clean tree must not be reusable.
	const edited = ok(collectSnapshot({ entries: [file("src/index.ts", "export const a = 999;\n"), file("src/util.ts", "export const b = 2;\n"), file("README.md", "# demo\n")], repository: { vcs: "git", head: "a".repeat(40), dirty: true } }));
	assert.notEqual(edited.digest, clean.digest);

	// And a tree with no VCS at all is still identified by its bytes.
	const none = ok(collectSnapshot({ entries: tree(), repository: { vcs: "none", dirty: false } }));
	assert.notEqual(none.digest, clean.digest, "the repository block is part of the identity");
});

test("collection refuses malformed observations rather than normalizing them away", () => {
	const cases = [
		[[{ path: "../escape.ts", type: "file", digest: sha("x"), executable: false, size: 1 }], /repository-relative/],
		[[{ path: "/abs/path.ts", type: "file", digest: sha("x"), executable: false, size: 1 }], /repository-relative/],
		[[{ path: "src/a.ts", type: "file", digest: "not-a-digest", executable: false, size: 1 }], /sha256/],
		[[{ path: "src/a.ts", type: "file", digest: sha("x"), executable: false, size: -1 }], /non-negative integer/],
		[[{ path: "src/a.ts", type: "file", digest: sha("x"), executable: false, size: 1.5 }], /non-negative integer/],
		[[{ path: "src/a.ts", type: "symlink", target: "" }], /target is empty/],
		[[file("src/a.ts", "x"), file("src/a.ts", "y")], /duplicate path/],
	];
	for (const [entries, pattern] of cases) {
		const result = collect(entries);
		assert.equal(result.ok, false, JSON.stringify(entries));
		assert.match(result.errors.map((e) => e.message).join(" "), pattern);
	}
	// A bad path in the host's uncovered list is refused too.
	assert.equal(collect(tree(), { uncovered_relevant_inputs: ["../../etc/passwd"] }).ok, false);
});

test("an unstable capture is recorded as unstable and cannot bind an acceptance", () => {
	const moved = ok(collect(tree(), { moved_during_capture: true }));
	assert.equal(moved.stability, "unstable");
	assert.equal(candidateMayBindAcceptance({ role: "candidate", stability: moved.stability, collector: "host-observed", attested_by: "adapter", coverage: moved.coverage }).ok, false);
	// Stability is a property of the observation, not of the bytes: it must not
	// change the digest, or a re-capture of an unchanged tree would look edited.
	assert.equal(moved.digest, ok(collect(tree())).digest);
});

test("the collected identity is exactly what the contract's validator recomputes", () => {
	const collected = ok(collect(tree([{ path: "src/link.ts", type: "symlink", target: "./index.ts" }])));
	assert.equal(computeSnapshotDigest({ coverage: collected.coverage, manifest: collected.manifest, repository: collected.repository }), collected.digest);

	// A whole record built from a collection validates, and its digest survives
	// the validator's own recomputation.
	const record = {
		schema_version: 1,
		kind: "snapshot",
		id: "snp_00000000000000000000d001",
		created_at: "2026-09-17T10:22:00Z",
		change_id: "chg_00000000000000000000c001",
		attempt_id: "att_00000000000000000000a001",
		role: "candidate",
		repository: collected.repository,
		manifest: collected.manifest,
		coverage: collected.coverage,
		stability: collected.stability,
		collector: "host-observed",
		attested_by: "adapter",
		captured_at: "2026-09-17T10:22:00Z",
		digest: collected.digest,
	};
	assert.equal(validateRecord(record).ok, true, JSON.stringify(validateRecord(record).errors ?? []));

	// And freshness: the same tree passes, an edited one fails at /digest.
	assert.equal(checkCandidateFreshness(record, { coverage: collected.coverage, manifest: collected.manifest, repository: collected.repository }).ok, true);
	const after = ok(collect(tree([{ path: "src/link.ts", type: "symlink", target: "./index.ts" }, file("src/added.ts", "export const c = 3;\n")])));
	const stale = checkCandidateFreshness(record, { coverage: after.coverage, manifest: after.manifest, repository: after.repository });
	assert.equal(stale.ok, false);
	assert.equal(stale.errors[0].code, "digest-mismatch");
	assert.equal(stale.errors[0].path, "/digest");
});

test("diffSnapshots explains what moved, including coverage drift a manifest diff would hide", () => {
	const before = ok(collect(tree([file("src/gone.ts", "// bye\n"), { path: "src/link.ts", type: "symlink", target: "./index.ts" }])));
	const after = ok(
		collect([
			file("src/index.ts", "export const a = 2;\n"), // modified
			file("src/util.ts", "export const b = 2;\n", { executable: true }), // mode only
			file("README.md", "# demo\n"),
			file("src/new.ts", "export const c = 3;\n"), // added
			{ path: "src/link.ts", type: "file", digest: sha("now a real file\n"), executable: false, size: 16 }, // type changed
		]),
	);
	const diff = diffSnapshots(before, after);
	assert.equal(diff.identical, false);
	assert.deepEqual(diff.added, ["src/new.ts"]);
	assert.deepEqual(diff.removed, ["src/gone.ts"]);
	assert.deepEqual(diff.modified, ["src/index.ts"]);
	assert.deepEqual(diff.mode_changed, ["src/util.ts"], "a file that became executable is a behaviour change, not a no-op");
	assert.deepEqual(diff.type_changed, ["src/link.ts"], "a symlink replaced by a file is not a content edit");

	assert.equal(diffSnapshots(before, before).identical, true);

	// Coverage drift with an identical manifest: a collector that quietly
	// started skipping a path would otherwise look like an unchanged tree.
	const narrowed = ok(collect(tree(), { uncovered_relevant_inputs: ["vendor/opaque"] }));
	const wide = ok(collect(tree()));
	const coverageOnly = diffSnapshots(wide, narrowed);
	assert.equal(coverageOnly.coverage_changed, true);
	assert.equal(coverageOnly.identical, false, "identical manifests with different coverage are not the same observation");
	assert.deepEqual([coverageOnly.added, coverageOnly.removed, coverageOnly.modified], [[], [], []]);
});

test("exclusion patterns match the paths they claim and no others", () => {
	assert.equal(patternCovers(".codecarto/engineering/**", ".codecarto/engineering/changes/x.json"), true);
	assert.equal(patternCovers(".codecarto/engineering/**", ".codecarto/engineering"), true);
	assert.equal(patternCovers(".codecarto/engineering/**", ".codecarto/engineering-notes/x"), false, "a prefix is not a path component");
	assert.equal(patternCovers("dist/*", "dist/bundle.js"), true);
	assert.equal(patternCovers("dist/*", "dist/nested/bundle.js"), false, "a single star does not cross a separator");
	assert.equal(patternCovers("exact/file.ts", "exact/file.ts"), true);
	assert.equal(patternCovers("exact/file.ts", "exact/file.ts.map"), false);

	// A host-declared exclusion is honoured and disclosed with its own reason.
	const built = ok(collect(tree([file("dist/bundle.js", "// generated\n")]), { excluded: [{ pattern: "dist/**", reason: "generated" }] }));
	assert.ok(!built.manifest.some((e) => e.path.startsWith("dist/")));
	assert.ok(built.coverage.excluded.some((e) => e.pattern === "dist/**" && e.reason === "generated"));
	// Excluding a build directory must not be mistakable for excluding source.
	assert.notEqual(built.digest, ok(collect(tree())).digest, "the exclusion list is part of the identity");
});

test("a path is validated before any exclusion decision, so no unvalidated string reaches the identity", () => {
	// Review finding: exclusion and secret matching ran BEFORE the path check,
	// so a secret-like basename or a covering host pattern smuggled an
	// absolute, traversing, or NUL-bearing string into coverage.excluded —
	// and coverage is inside the digest.
	for (const bad of ["/home/someone/.netrc", "../../.npmrc", "ok/\u0000bad/.npmrc", "/etc/shadow"]) {
		const viaSecret = collect([file("src/a.ts", "x"), { path: bad, type: "file", digest: sha("s"), executable: false, size: 1 }]);
		assert.equal(viaSecret.ok, false, `secret-like basename must not bypass path validation: ${bad}`);
		assert.match(viaSecret.errors.map((e) => e.message).join(" "), /repository-relative/);
		const viaExclusion = collect([file("src/a.ts", "x"), { path: bad, type: "file", digest: sha("s"), executable: false, size: 1 }], {
			excluded: [{ pattern: "vendor/**", reason: "host-declared" }],
		});
		assert.equal(viaExclusion.ok, false, `a host exclusion must not bypass path validation: ${bad}`);
	}
	// An unreadable entry gets the same treatment.
	assert.equal(collect([{ path: "/abs/unreadable", type: "unreadable", reason: "denied" }]).ok, false);
});

test("one path, one observation: a duplicate in any combination of kinds is refused", () => {
	// Review finding: duplicate detection lived after the unreadable branch, so
	// file+unreadable for one path produced a snapshot claiming the path was
	// both fingerprinted and not covered.
	const pairs = [
		[file("src/a.ts", "x"), { path: "src/a.ts", type: "unreadable", reason: "raced" }],
		[{ path: "src/a.ts", type: "unreadable", reason: "raced" }, file("src/a.ts", "x")],
		[file("src/a.ts", "x"), { path: "src/a.ts", type: "symlink", target: "./b.ts" }],
		[file("src/a.ts", "x"), file("src/a.ts", "y")],
	];
	for (const entries of pairs) {
		const result = collect(entries);
		assert.equal(result.ok, false, JSON.stringify(entries.map((e) => e.type)));
		assert.match(result.errors.map((e) => e.message).join(" "), /duplicate path/);
	}
});

test("an exclusion the matcher cannot apply is refused, not disclosed", () => {
	// Review finding: patternCovers silently returned false for `*.log` and
	// `**/*.log`, so those exclusions were recorded in coverage — and in the
	// digest — while every matching file stayed in the manifest. Disclosed
	// coverage was narrower than actual coverage, which inverts the point.
	assert.equal(isSupportedPattern("*.log"), true);
	assert.equal(isSupportedPattern("**/*.log"), true);
	assert.equal(patternCovers("*.log", "app.log"), true);
	assert.equal(patternCovers("*.log", "src/app.log"), true, "a basename suffix matches at any depth");
	assert.equal(patternCovers("**/*.log", "src/deep/app.log"), true);
	assert.equal(patternCovers("*.log", "applog"), false, "the dot is part of the suffix");

	for (const unsupported of ["src/**/x", "", "  ", "a\u0000b", "/abs/**", "../escape/**", "**/**", "*.l*g", 42, null]) {
		assert.equal(isSupportedPattern(unsupported), false, JSON.stringify(unsupported));
		const result = collect(tree(), { excluded: [{ pattern: unsupported, reason: "generated" }] });
		assert.equal(result.ok, false, `unsupported pattern must be refused: ${JSON.stringify(unsupported)}`);
		assert.match(result.errors.map((e) => e.message).join(" "), /unsupported exclusion pattern|each exclusion must be an object/);
	}
	// An unknown reason is refused too: the reason is what a reader trusts.
	assert.equal(collect(tree(), { excluded: [{ pattern: "dist/**", reason: "because" }] }).ok, false);
});

test("declaring the same exclusion twice does not change the tree's identity", () => {
	// Review finding: only the secret case was deduped, so a host that listed
	// a rule twice produced a different digest for an identical tree.
	const once = ok(collect(tree(), { excluded: [{ pattern: "dist/**", reason: "generated" }] }));
	const twice = ok(collect(tree(), { excluded: [{ pattern: "dist/**", reason: "generated" }, { pattern: "dist/**", reason: "generated" }] }));
	assert.equal(twice.digest, once.digest, "a repeated rule is one rule");
	const redeclared = ok(collect(tree(), { excluded: [{ pattern: ".codecarto/engineering/**", reason: "engineering-namespace" }] }));
	assert.equal(redeclared.digest, ok(collect(tree())).digest, "re-declaring the built-in rule is a no-op");
	// But a different reason for the same pattern is a different disclosure.
	const otherReason = ok(collect(tree(), { excluded: [{ pattern: "dist/**", reason: "ignored" }] }));
	assert.notEqual(otherReason.digest, once.digest);
});

test("the repository block is validated, not passed through into the digest", () => {
	// Review finding: repository was digested verbatim, so a caller could put
	// arbitrary keys or a string `dirty` inside the tree's identity.
	const bad = [
		{ vcs: "git", head: "a".repeat(40), dirty: "false" },
		{ vcs: "git", head: "a".repeat(40), dirty: false, sneaky: "extra" },
		{ vcs: "svn", dirty: false },
		{ vcs: "git", head: "not-a-revision", dirty: false },
		{ vcs: "none", head: "a".repeat(40), dirty: false },
		{ vcs: "git", head: 1.5, dirty: false },
		null,
		"git",
	];
	for (const repository of bad) {
		const result = collectSnapshot({ entries: tree(), repository });
		assert.equal(result.ok, false, JSON.stringify(repository));
	}
	assert.equal(collectSnapshot({ entries: tree(), repository: { vcs: "git", head: "a".repeat(40), dirty: false } }).ok, true);
	assert.equal(collectSnapshot({ entries: tree(), repository: { vcs: "none", dirty: true } }).ok, true);
});

test("a candidate whose coverage cannot be read may not bind an acceptance", () => {
	// Review finding: `candidate.coverage?.uncovered_relevant_inputs ?? []`
	// made coverage optional, so omitting it returned ok:true — a degradation
	// that RAISED trust. An unreadable coverage must block.
	const base = { role: "candidate", stability: "stable", collector: "host-observed", attested_by: "adapter" };
	for (const coverage of [undefined, null, {}, { uncovered_relevant_inputs: null }, { uncovered_relevant_inputs: "" }, { uncovered_relevant_inputs: "abc" }, { uncovered_relevant_inputs: 5 }]) {
		const result = candidateMayBindAcceptance({ ...base, coverage });
		assert.equal(result.ok, false, JSON.stringify(coverage));
		assert.match(result.reasons.join(" "), /coverage\.uncovered_relevant_inputs is missing or not a list/);
	}
	// A length-spoofing object is not an array and does not pass.
	assert.equal(candidateMayBindAcceptance({ ...base, coverage: { uncovered_relevant_inputs: { length: 0 } } }).ok, false);
	// The honest empty case still passes.
	assert.deepEqual(candidateMayBindAcceptance({ ...base, coverage: { uncovered_relevant_inputs: [] } }), { ok: true });
});

test("a record carries no absolute path, home directory, or environment value", () => {
	const collected = ok(
		collect(tree([file("src/deep/nested/module.ts", "export const d = 4;\n")]), {
			excluded: [{ pattern: "dist/**", reason: "generated" }],
			uncovered_relevant_inputs: ["vendor/opaque"],
		}),
	);
	const serialized = JSON.stringify(collected);
	assert.ok(!serialized.includes("/home/"), "no home directory");
	assert.ok(!serialized.includes("/tmp/"), "no absolute temporary path");
	assert.ok(!/"\/[A-Za-z]/.test(serialized), "no value begins with an absolute path");
	assert.ok(!/[A-Z_]{4,}=/.test(serialized), "no environment assignment");
	for (const entry of collected.manifest) {
		assert.ok(!entry.path.startsWith("/") && !entry.path.includes(".."), entry.path);
	}
});

// --- Second adversarial review (Fable 5.1) --------------------------------
// Every case below is a two-trees-one-digest collision or a spurious-drift
// bug found reviewing the FIXES from the first review. They are regressions,
// not hypotheticals: each digest pair here was observed colliding.

test("a non-boolean executable is refused, never coerced to false", () => {
	// Observed: `executable: 1` and `executable: "true"` both produced the
	// digest of a NON-executable file, so a tree whose script carries the
	// executable bit was indistinguishable from one where it does not.
	for (const bad of [1, 0, "true", "false", null, {}, []]) {
		const r = collectSnapshot({ entries: [file("bin/run.sh", "#!/bin/sh\n", { executable: bad })], repository: REPOSITORY });
		assert.equal(r.ok, false, `executable: ${JSON.stringify(bad)} must be refused`);
		assert.match(r.errors[0].message, /executable is not a boolean/);
	}
	const yes = collectSnapshot({ entries: [file("bin/run.sh", "#!/bin/sh\n", { executable: true })], repository: REPOSITORY });
	const no = collectSnapshot({ entries: [file("bin/run.sh", "#!/bin/sh\n", { executable: false })], repository: REPOSITORY });
	assert.notEqual(yes.value.digest, no.value.digest, "the executable bit must change the identity");
});

test("a path the sort cannot order deterministically is refused", () => {
	// compareUtf8 encodes to UTF-8, which maps every lone surrogate to U+FFFD,
	// so "a\uD800" and "a\uFFFD" compared EQUAL. A non-total comparator made
	// the manifest sort order-dependent: the same tree, enumerated in two
	// orders, produced two different digests.
	assert.equal(compareUtf8("a\uD800", "a\uFFFD"), 0, "the comparator really does collapse these");
	for (const bad of ["a\uD800", "a\uDFFF", "a\uFFFD", "dir/\uD800x"]) {
		const r = collectSnapshot({ entries: [file(bad, "x")], repository: REPOSITORY });
		assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`);
		assert.match(r.errors[0].message, /unpaired surrogate|replacement character/);
	}
	// A correctly paired surrogate is a real character and stays accepted.
	const ok = collectSnapshot({ entries: [file("src/\u{1F600}.ts", "x")], repository: REPOSITORY });
	assert.equal(ok.ok, true, "an astral character is a legitimate filename");
});

test("the repository block is shape-checked, not stringified", () => {
	// Observed: String(head) accepted ["a".repeat(40)], which then reached the
	// digest as an array; a non-plain prototype threw out of canonicalJson
	// instead of returning ok:false.
	const entries = [file("src/index.ts", "x")];
	for (const head of [["a".repeat(40)], 40, null, { toString: () => "a".repeat(40) }]) {
		const r = collectSnapshot({ entries, repository: { vcs: "git", head, dirty: false } });
		assert.equal(r.ok, false, `head ${JSON.stringify(head)} must be refused`);
	}
	const weird = collectSnapshot({ entries, repository: Object.assign(Object.create({ vcs: "git" }), { dirty: false }) });
	assert.equal(weird.ok, false, "a non-plain repository object is refused, not thrown on");
});

test("one pattern has one meaning, and a whole-tree exclusion is refused", () => {
	// Re-declaring a built-in rule under another reason produced a SECOND
	// coverage entry — a spurious second identity for an identical tree.
	const entries = [file("src/index.ts", "x")];
	const plain = collectSnapshot({ entries, repository: REPOSITORY });
	const redeclared = collectSnapshot({
		entries,
		repository: REPOSITORY,
		excluded: [{ pattern: ALWAYS_EXCLUDED[0].pattern, reason: "host-declared" }],
	});
	assert.equal(redeclared.ok, false, "the same pattern under two reasons is a contradiction, not a second entry");
	assert.match(redeclared.errors[0].message, /declared twice with different reasons/);
	// Declaring it identically is a no-op, not drift.
	const same = collectSnapshot({ entries, repository: REPOSITORY, excluded: [{ ...ALWAYS_EXCLUDED[0] }] });
	assert.equal(same.value.digest, plain.value.digest, "an identical re-declaration must not change identity");
	// `**` would empty the manifest, giving every repository one identity.
	const all = collectSnapshot({ entries, repository: REPOSITORY, excluded: [{ pattern: "**", reason: "host-declared" }] });
	assert.equal(all.ok, false, "a whole-tree exclusion is refused");
});

test("a disclosed exclusion is one the matcher actually applies", () => {
	// The first review's fix covered *.log; the same defect survived in two
	// other shapes: a bare directory name matched nothing inside it, and the
	// two spellings of a suffix rule disagreed about a bare `.log` file.
	assert.equal(isSupportedPattern("build"), true, "an exact path is supported");
	assert.equal(patternCovers("build", "build"), true);
	assert.equal(patternCovers("build", "build/out.js"), false, "a bare name is NOT a directory rule");
	assert.equal(isSupportedPattern("build/"), false, "a trailing slash is not a supported spelling");
	assert.equal(patternCovers("build/**", "build/out.js"), true, "a directory must say so");
	// A pattern carrying a `*` the matcher does not implement must be refused
	// outright, not accepted and then silently matched against nothing.
	for (const bad of ["src/*.ts", "a*b", "src/**/x"]) {
		assert.equal(isSupportedPattern(bad), false, `${bad} is not a shape the matcher implements`);
		const r = collectSnapshot({ entries: [file("src/index.ts", "x")], repository: REPOSITORY, excluded: [{ pattern: bad, reason: "host-declared" }] });
		assert.equal(r.ok, false, `${bad} must be refused by the collector, not disclosed`);
	}
	// Both spellings must agree, or coverage depends on how the host phrased it.
	assert.equal(patternCovers("*.log", ".log"), patternCovers("**/*.log", ".log"), "spellings must agree");
	assert.equal(patternCovers("*.log", ".log"), false, "a file named `.log` has no stem");
	assert.equal(patternCovers("*.log", "a.log.bak"), false);
	for (const bad of ["*.", "**/*."]) assert.equal(isSupportedPattern(bad), false, `${bad} matches nothing useful`);
	// And the exclusion is really applied: a matching file leaves the manifest.
	const collected = collectSnapshot({
		entries: [file("src/index.ts", "x"), file("run.log", "noise")],
		repository: REPOSITORY,
		excluded: [{ pattern: "*.log", reason: "host-declared" }],
	});
	assert.deepEqual(collected.value.manifest.map((e) => e.path), ["src/index.ts"], "the excluded file is really dropped");
	assert.ok(collected.value.dropped.some((d) => d.path === "run.log"), "and is disclosed as dropped");
});

test("no secret digest appears anywhere in the entire serialized snapshot", () => {
	// The earlier test only grepped `coverage`; this greps the whole result,
	// including `dropped`, which is where a leak would actually land.
	const body = "AKIA_EXAMPLE_SECRET\n";
	const collected = collectSnapshot({
		entries: [file("src/index.ts", "x"), file(".env", body), file("config/credentials.json", body)],
		repository: REPOSITORY,
	});
	const serialized = JSON.stringify(collected.value);
	assert.ok(!serialized.includes(sha(body).slice(7)), "the secret's digest must not appear anywhere");
	assert.ok(!serialized.includes(body.trim()), "nor its contents");
	assert.ok(!collected.value.manifest.some((e) => e.path === ".env"), "and it is not in the manifest");
	assert.ok(collected.value.dropped.some((d) => d.path === ".env" && d.digest === undefined), "dropped discloses the path without a digest");
});
