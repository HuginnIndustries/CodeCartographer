// Serves the packaged agent skill — the instructions for driving this server —
// so an MCP client can read them without installing the skill files. The shipped
// markdown under agent-skill/ is the single source: nothing here duplicates its
// prose, and a drift test would have nothing to compare.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathExists } from "./utils.ts";
import { packageRoot } from "./workspace.ts";

/** Packaged agent-skill directory. Wrappers serve its contents through codecarto_guide. */
export const packagedAgentSkillDir = join(packageRoot, "agent-skill", "codecartographer");

/** A guide document: the main skill or one of its topic references. */
export type GuideDocument = {
	/** `overview` for SKILL.md, otherwise the reference's basename without `.md`. */
	topic: string;
	/** Markdown body, with SKILL.md's installer frontmatter stripped. */
	content: string;
};

/**
 * Strip a leading YAML frontmatter block. The frontmatter is skill-installer
 * metadata (name, version, license) that carries no instruction value for an
 * agent reading the guide through the tool.
 */
function stripFrontmatter(markdown: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
	return match ? markdown.slice(match[0].length).trimStart() : markdown;
}

/** Topic names available to {@link readGuide}, `overview` first. */
export async function listGuideTopics(): Promise<string[]> {
	const referencesDir = join(packagedAgentSkillDir, "references");
	if (!(await pathExists(referencesDir))) return ["overview"];
	const names = (await readdir(referencesDir))
		.filter((name) => name.endsWith(".md"))
		.map((name) => basename(name, ".md"))
		.sort();
	return ["overview", ...names];
}

/**
 * Read one guide document.
 * @param topic - `overview` (default) for the main skill, or a reference name from {@link listGuideTopics}.
 * @returns the requested document.
 * @throws when the packaged skill is missing, or the topic is not one of {@link listGuideTopics}.
 */
export async function readGuide(topic = "overview"): Promise<GuideDocument> {
	const requested = topic.trim() || "overview";
	const available = await listGuideTopics();
	if (!available.includes(requested)) {
		throw new Error(`Unknown guide topic ${requested}. Available: ${available.join(", ")}.`);
	}

	const path = requested === "overview"
		? join(packagedAgentSkillDir, "SKILL.md")
		: join(packagedAgentSkillDir, "references", `${requested}.md`);
	if (!(await pathExists(path))) {
		throw new Error(`Packaged agent skill is missing at ${path}. Reinstall codecartographer-pi.`);
	}
	return { topic: requested, content: stripFrontmatter(await readFile(path, "utf8")) };
}
