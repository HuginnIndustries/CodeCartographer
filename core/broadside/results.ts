// Lens results as they come back and as they are stored: content extraction
// from a batch result, JSON parsing that tolerates code fences, markdown
// rendering, and the per-run files collect writes and later reads back.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../utils.ts";
import { type BroadsideLensId } from "./constants.ts";
import { type BatchRequest } from "./types.ts";
import { sanitizeId } from "./repo.ts";

export function renderFindingsMarkdown(content: string): string {
	const parsed = parseLensJson(content);
	if (parsed === null) return content;
	return formatAsMarkdown(parsed);
}

function formatAsMarkdown(value: unknown, depth = 0): string {
	const indent = "\t".repeat(depth);
	if (Array.isArray(value)) {
		const lines: string[] = [];
		for (let i = 0; i < value.length; i++) {
			const item = value[i] as Record<string, unknown>;
			if (item && typeof item === "object") {
				const title = (item.title ?? item.name ?? item.module ?? item.area ?? item.platform ?? "") as string;
				lines.push(`${indent}${i + 1}. ${title}`);
				lines.push(formatAsMarkdown(item, depth + 1));
			} else {
				lines.push(`${indent}- ${String(item)}`);
			}
		}
		return lines.join("\n");
	}
	if (value && typeof value === "object") {
		const lines: string[] = [];
		for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
			if (entryValue && typeof entryValue === "object") {
				lines.push(`${indent}**${key}**:`);
				lines.push(formatAsMarkdown(entryValue, depth + 1));
			} else {
				lines.push(`${indent}- **${key}**: ${String(entryValue)}`);
			}
		}
		return lines.join("\n");
	}
	return `${indent}${String(value)}`;
}

export type StoredLensResult = {
	lensId: BroadsideLensId;
	customId: string;
	moduleName: string;
	content: string;
	raw: Record<string, unknown>;
	/** True when the content is not parseable JSON even after fence stripping —
	 * the telltale of an output cut off at max_tokens. */
	truncated: boolean;
};

export function extractContent(result: Record<string, unknown>): string | null {
	const response = result.response as Record<string, unknown> | undefined;
	if (!response?.body) return null;
	const body = response.body as Record<string, unknown>;
	const choices = body.choices as Array<Record<string, unknown>> | undefined;
	const message = choices?.[0]?.message as Record<string, unknown> | undefined;
	return typeof message?.content === "string" ? message.content : null;
}

/**
 * Parse lens content as JSON, tolerating the markdown code fences some models
 * wrap structured output in (the same tolerance OpenRouter's headless-agent
 * scaffold ships for --output-schema). Returns null when the content is not
 * JSON at all — which for a strict json_schema request means the output was
 * truncated at max_tokens, not that the model chose prose.
 */
export function parseLensJson(content: string): unknown | null {
	const trimmed = content.trim();
	const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
	const candidate = fenced ? fenced[1].trim() : trimmed;
	if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
	try {
		return JSON.parse(candidate);
	} catch {
		return null;
	}
}

export async function saveLensResults(
	runDir: string,
	lensId: BroadsideLensId,
	batch: Record<string, unknown>,
): Promise<StoredLensResult[]> {
	const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
	const out: StoredLensResult[] = [];
	for (const result of results) {
		const customId = String(result.custom_id ?? "unknown");
		const content = extractContent(result);
		if (content === null) {
			if (result.error) {
				await writeFile(join(runDir, `${sanitizeId(customId)}.error.json`), `${JSON.stringify(result.error, null, "\t")}\n`, "utf8");
			}
			continue;
		}
		const parsed = parseLensJson(content);
		const truncated = parsed === null;
		if (parsed !== null) {
			await writeFile(join(runDir, `${sanitizeId(customId)}.json`), `${JSON.stringify(parsed, null, "\t")}\n`, "utf8");
		} else {
			// Save the raw bytes verbatim so nothing is lost, but name the
			// gap: an unparseable strict-schema response is a truncation.
			await writeFile(join(runDir, `${sanitizeId(customId)}.json`), `${content}\n`, "utf8");
		}
		await writeFile(join(runDir, `${sanitizeId(customId)}.md`), renderFindingsMarkdown(content), "utf8");
		out.push({
			lensId,
			customId,
			moduleName: String(customId).replace(/^[a-z]+-/, ""),
			content,
			raw: result,
			truncated,
		});
	}
	return out;
}

/**
 * Rebuild lens results from what a previous collect already wrote to disk.
 *
 * The post-passes are gated on having lens findings in hand, and a collect
 * only holds the ones *it* polled. When an earlier collect saved every lens
 * and then died before synthesis and triage ran — the batch window is long
 * and a poll can easily be interrupted — the next collect finds every lens
 * already terminal, skips them all, and would otherwise reach the post-pass
 * gate with nothing to hand it. Reading the saved results back is what makes
 * "a resumed collect can finish whichever is still pending" true.
 */
export async function loadSavedLensResults(runDir: string, lenses: BroadsideLensId[]): Promise<StoredLensResult[]> {
	if (!(await pathExists(runDir))) return [];
	const reserved = new Set(["requests.json", "run-meta.json", "synthesis.json", "triage.json"]);
	const out: StoredLensResult[] = [];
	// Longest lens id first: no id is a prefix of another today, but ordering
	// keeps that from becoming a silent misattribution if one ever is.
	const ordered = [...lenses].sort((a, b) => b.length - a.length);
	for (const name of (await readdir(runDir)).sort()) {
		if (!name.endsWith(".json") || name.endsWith(".error.json") || reserved.has(name) || name.startsWith("raw-")) continue;
		const customId = name.slice(0, -".json".length);
		const lensId = ordered.find((id) => customId === id || customId.startsWith(`${id}-`));
		if (!lensId) continue;
		const content = await readFile(join(runDir, name), "utf8").catch(() => null);
		if (content === null) continue;
		out.push({
			lensId,
			customId,
			moduleName: customId.replace(/^[a-z]+-/, ""),
			content,
			raw: {},
			truncated: parseLensJson(content) === null,
		});
	}
	return out;
}

export async function loadStoredRequests(runDir: string): Promise<Record<string, BatchRequest>> {
	const path = join(runDir, "requests.json");
	if (!(await pathExists(path))) return {};
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, BatchRequest>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
