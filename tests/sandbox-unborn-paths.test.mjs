// Containment for paths that do not exist yet (#223). The write sandbox on
// the Pi surface used to resolve a not-yet-created target lexically, so a
// symlinked directory inside .codecarto/ that pointed outside the workspace
// let a new file land outside. resolveExistingPrefix follows whatever exists
// through symlinks first, then appends the unborn tail.
//
// The root gets the same treatment, not realpath alone (#394): realpath throws
// on a .codecarto/ that does not exist yet, and the lexical fallback kept an
// ancestor the target's side had already expanded, so a fresh workspace's first
// write was judged outside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { isWithinPathResolved, resolveExistingPrefix } = await import(pathToFileURL(`${REPO_ROOT}/core/utils.ts`).href);

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "cc-unborn-")));
	const workspace = join(base, ".codecarto");
	const outside = join(base, "outside");
	await mkdir(join(workspace, "findings"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, "exists.md"), "x\n");
	await symlink(outside, join(workspace, "link"));
	await symlink(join(workspace, "findings"), join(workspace, "inner-link"));
	return { base, workspace, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("a new file under a symlinked directory that points outside the root is outside", async () => {
	const { workspace, outside, cleanup } = await fixture();
	try {
		const target = join(workspace, "link", "new.md");
		assert.equal(await resolveExistingPrefix(target), join(outside, "new.md"));
		assert.equal(await isWithinPathResolved(target, workspace), false);
		// Deeper unborn tails resolve the same way.
		assert.equal(await isWithinPathResolved(join(workspace, "link", "a", "b", "new.md"), workspace), false);
	} finally {
		await cleanup();
	}
});

test("an existing file reached through such a symlink is still outside", async () => {
	const { workspace, cleanup } = await fixture();
	try {
		assert.equal(await isWithinPathResolved(join(workspace, "link", "exists.md"), workspace), false);
	} finally {
		await cleanup();
	}
});

test("`..` applies to the resolved prefix, not the spelled one", async () => {
	const { base, workspace, cleanup } = await fixture();
	try {
		// On disk, link/.. is the link target's parent (the base dir), so this
		// file would land beside the workspace, not inside it. A lexical
		// resolve() collapses it to .codecarto/escape.md and lets it through.
		const spelled = `${workspace}/link/../escape.md`;
		assert.equal(await resolveExistingPrefix(spelled), join(base, "escape.md"));
		assert.equal(await isWithinPathResolved(spelled, workspace), false);
		// A relative spelling against the workspace's parent resolves the same way.
		assert.equal(await resolveExistingPrefix(".codecarto/link/../escape.md", base), join(base, "escape.md"));
	} finally {
		await cleanup();
	}
});

test("new files under real directories and under symlinks that stay inside are inside", async () => {
	const { workspace, cleanup } = await fixture();
	try {
		assert.equal(await isWithinPathResolved(join(workspace, "findings", "architecture", "map.md"), workspace), true);
		assert.equal(await isWithinPathResolved(join(workspace, "inner-link", "new.md"), workspace), true);
		assert.equal(await isWithinPathResolved(join(workspace, "scratch", "handoffs", "x.yaml"), workspace), true);
		assert.equal(await isWithinPathResolved(workspace, workspace), true);
		assert.equal(await isWithinPathResolved(join(workspace, "..", "elsewhere.md"), workspace), false);
	} finally {
		await cleanup();
	}
});

test("a workspace root that is itself a symlink resolves to the same place as targets under it", async () => {
	const { base, workspace, cleanup } = await fixture();
	try {
		const alias = join(base, "alias");
		await symlink(workspace, alias);
		assert.equal(await isWithinPathResolved(join(alias, "findings", "new.md"), workspace), true);
		assert.equal(await isWithinPathResolved(join(workspace, "findings", "new.md"), alias), true);
	} finally {
		await cleanup();
	}
});

test("a root that does not exist yet is canonicalized like its targets, not lexically (#394)", async () => {
	// The workspace is reached through a symlinked ancestor, which realpath
	// expands and a lexical resolve does not: the POSIX shape of the Windows
	// runner's 8.3 short name (C:\Users\RUNNER~1\...) and of macOS' /var ->
	// /private/var. Resolving the root with realpath alone threw for a
	// .codecarto/ that does not exist yet and fell back to the spelled path, so
	// root and target shared no prefix and a fresh workspace's first write was
	// judged outside the one directory it is allowed to write.
	const base = await realpath(await mkdtemp(join(tmpdir(), "cc-unborn-root-")));
	try {
		await mkdir(join(base, "real", "repo"), { recursive: true });
		await mkdir(join(base, "outside"), { recursive: true });
		await symlink(join(base, "real"), join(base, "link"));
		const cwd = join(base, "link", "repo");
		const workspace = join(cwd, ".codecarto");
		const target = join(workspace, "findings", "contracts", "out.md");

		assert.equal(await isWithinPathResolved(target, workspace), true, "the first write of a fresh workspace is inside it");
		// And the answer does not change once the root exists on disk.
		await mkdir(workspace, { recursive: true });
		assert.equal(await isWithinPathResolved(target, workspace), true);

		// Containment is not weakened by resolving the root: outside stays outside.
		assert.equal(await isWithinPathResolved(join(base, "outside", "x.md"), workspace), false);
		assert.equal(await isWithinPathResolved(join(cwd, "src", "source.ts"), workspace), false);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a relative target resolves against `base`, the way the Pi write guards pass one", async () => {
	const { base, workspace, cleanup } = await fixture();
	try {
		assert.equal(await isWithinPathResolved(".codecarto/findings/new.md", workspace, base), true);
		assert.equal(await isWithinPathResolved("elsewhere.md", workspace, base), false);
		// The root may be spelled relatively too, and resolves the same way.
		assert.equal(await isWithinPathResolved(".codecarto/findings/new.md", ".codecarto", base), true);
	} finally {
		await cleanup();
	}
});
