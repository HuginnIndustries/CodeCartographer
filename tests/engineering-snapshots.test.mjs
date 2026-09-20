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

const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const file = (path, body, extra = {}) => ({ path, type: "file", digest: sha(body), executable: false, size: Buffer.byteLength(body), ...extra });

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
		imports.sort(),
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
