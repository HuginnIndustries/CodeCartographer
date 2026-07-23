import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePublish } from "../mcp-server/server.ts";

let tmpRoot;

async function setup() {
	tmpRoot = await mkdtemp(join(tmpdir(), "cc-publish-test-"));
	const workspaceDir = join(tmpRoot, "target", ".codecarto");
	const libraryDir = join(tmpRoot, "library");
	await mkdir(join(workspaceDir, "workflow"), { recursive: true });
	await mkdir(join(workspaceDir, "findings", "reimplementation-spec"), { recursive: true });
	await mkdir(libraryDir, { recursive: true });

	await writeFile(join(libraryDir, ".codecarto-library"), JSON.stringify({
		schema_version: 1,
		name: "test-library",
		visibility: "internal",
		namespaced: false,
		created_at: "2026-01-01T00:00:00Z",
	}));

	const specContent = "# Test Spec\n\n## System Summary\n\nA test reimplementation spec.";
	await writeFile(join(workspaceDir, "findings", "reimplementation-spec", "reimplementation-spec.md"), specContent);

	await mkdir(join(tmpRoot, "outside"), { recursive: true });
	await writeFile(join(tmpRoot, "outside", "secret.txt"), "SECRET CONTENT");

	return { workspaceDir, libraryDir, specContent, secretPath: join(tmpRoot, "outside", "secret.txt") };
}

async function cleanup() {
	await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

test("codecarto_publish rejects spec_path outside workspace and library", async () => {
	const { secretPath, libraryDir } = await setup();
	try {
		await assert.rejects(
			handlePublish({
				library_path: libraryDir,
				source_repo: "https://github.com/test/repo",
				headline: "Test spec",
				spec_path: secretPath,
			}),
			(err) => {
				assert.match(err.message, /must be within the workspace/i);
				return true;
			},
		);
	} finally {
		await cleanup();
	}
});

test("codecarto_publish accepts spec_path within workspace", async () => {
	const { workspaceDir, libraryDir } = await setup();
	try {
		await handlePublish({
			library_path: libraryDir,
			cwd: join(workspaceDir, ".."),
			source_repo: "https://github.com/test/repo",
			headline: "Test spec",
			spec_path: join(workspaceDir, "findings", "reimplementation-spec", "reimplementation-spec.md"),
		});
	} catch (err) {
		assert.doesNotMatch(err.message, /must be within the workspace/i);
	} finally {
		await cleanup();
	}
});