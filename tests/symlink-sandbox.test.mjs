import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinPath, isWithinPathResolved } from "../core/utils.ts";

let tmpRoot;

async function setup() {
	tmpRoot = join(tmpdir(), `cc-symlink-test-${process.pid}-${Date.now()}`);
	const allowedDir = join(tmpRoot, "allowed");
	const outsideDir = join(tmpRoot, "outside");
	await mkdir(allowedDir, { recursive: true });
	await mkdir(outsideDir, { recursive: true });
	await writeFile(join(outsideDir, "secret.txt"), "SECRET");
	await symlink(join(outsideDir, "secret.txt"), join(allowedDir, "link.txt"));
	return { allowedDir, outsideDir, symlinkPath: join(allowedDir, "link.txt") };
}

async function cleanup() {
	await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

test("isWithinPath (lexical) is bypassed by symlinks - documents the vulnerability", async () => {
	const { allowedDir, symlinkPath } = await setup();
	try {
		assert.equal(isWithinPath(symlinkPath, allowedDir), true);
	} finally {
		await cleanup();
	}
});

test("isWithinPathResolved blocks symlinks pointing outside the root", async () => {
	const { allowedDir, symlinkPath } = await setup();
	try {
		assert.equal(await isWithinPathResolved(symlinkPath, allowedDir), false);
	} finally {
		await cleanup();
	}
});

test("isWithinPathResolved allows legitimate paths inside the root", async () => {
	const { allowedDir } = await setup();
	try {
		const legitPath = join(allowedDir, "findings", "architecture.md");
		assert.equal(await isWithinPathResolved(legitPath, allowedDir), true);
	} finally {
		await cleanup();
	}
});

test("isWithinPathResolved allows the root itself", async () => {
	const { allowedDir } = await setup();
	try {
		assert.equal(await isWithinPathResolved(allowedDir, allowedDir), true);
	} finally {
		await cleanup();
	}
});