// Hand-rolled YAML parser/serializer good enough for the .codecarto workflow
// files (mappings, sequences, scalars, nested maps, strings/numbers/booleans).
// Round-trips structured carry_forward/open_questions entries.

import { readFile } from "node:fs/promises";
import { isPlainObject } from "./utils.ts";

export function stripYamlComment(value: string): string {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle && value[i - 1] !== "\\") {
			inDouble = !inDouble;
			continue;
		}
		if (char === "#" && !inSingle && !inDouble) {
			if (i === 0 || /\s/.test(value[i - 1] ?? "")) {
				return value.slice(0, i).trimEnd();
			}
		}
	}

	return value.trimEnd();
}

function countIndent(line: string): number {
	let count = 0;
	for (const char of line) {
		if (char === " ") count++;
		else if (char === "\t") count += 2;
		else break;
	}
	return count;
}

function isBlankOrComment(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === "" || trimmed.startsWith("#");
}

function findKeySeparator(text: string): number {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle && text[i - 1] !== "\\") {
			inDouble = !inDouble;
			continue;
		}
		if (char === ":" && !inSingle && !inDouble) {
			return i;
		}
	}

	return -1;
}

export function parseYamlScalar(rawValue: string): unknown {
	const trimmed = stripYamlComment(rawValue).trim();
	if (trimmed === "") return "";
	if (trimmed === "[]") return [];
	if (trimmed === "{}") return {};
	if (trimmed === "null") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	return trimmed;
}

export function parseSimpleYaml(raw: string): unknown {
	const lines = raw.split(/\r?\n/);
	let index = 0;

	const skipBlank = (): void => {
		while (index < lines.length && isBlankOrComment(lines[index] ?? "")) index++;
	};

	const parseBlock = (indent: number): unknown => {
		skipBlank();
		if (index >= lines.length) return {};
		const line = lines[index] ?? "";
		const lineIndent = countIndent(line);
		const trimmed = line.slice(lineIndent);
		if (trimmed.startsWith("- ") || trimmed === "-") {
			return parseSequence(indent);
		}
		return parseMapping(indent);
	};

	const parseMapping = (indent: number): Record<string, unknown> => {
		const result: Record<string, unknown> = {};

		while (index < lines.length) {
			skipBlank();
			if (index >= lines.length) break;
			const line = lines[index] ?? "";
			const lineIndent = countIndent(line);
			if (lineIndent < indent) break;
			if (lineIndent > indent) {
				throw new Error(`Invalid YAML indentation near: ${line.trim()}`);
			}

			const trimmed = line.slice(indent);
			if (trimmed.startsWith("- ") || trimmed === "-") break;

			const separator = findKeySeparator(trimmed);
			if (separator === -1) {
				throw new Error(`Invalid YAML mapping entry: ${trimmed}`);
			}

			const key = trimmed.slice(0, separator).trim();
			const rawValue = trimmed.slice(separator + 1).trim();
			index++;
			if (key in result) {
				throw new Error(`Duplicate YAML key: ${key} near line: ${line.trim()}`);
			}

			if (rawValue === "|" || rawValue === "|-") {
				const blockLines: string[] = [];
				let contentIndent: number | null = null;
				while (index < lines.length) {
					const blockLine = lines[index] ?? "";
					if (blockLine.trim() === "") {
						blockLines.push("");
						index++;
						continue;
					}
					const blockIndent = countIndent(blockLine);
					if (blockIndent <= indent) break;
					contentIndent ??= blockIndent;
					blockLines.push(blockLine.slice(Math.min(contentIndent, blockIndent)));
					index++;
				}
				const content = blockLines.join("\n").replace(/\n+$/, "");
				result[key] = rawValue === "|" ? `${content}\n` : content;
				continue;
			}

			if (rawValue !== "") {
				result[key] = parseYamlScalar(rawValue);
				continue;
			}

			skipBlank();
			if (index < lines.length && countIndent(lines[index] ?? "") > indent) {
				result[key] = parseBlock(countIndent(lines[index] ?? ""));
			} else {
				result[key] = null;
			}
		}

		return result;
	};

	const parseSequence = (indent: number): unknown[] => {
		const result: unknown[] = [];

		while (index < lines.length) {
			skipBlank();
			if (index >= lines.length) break;
			const line = lines[index] ?? "";
			const lineIndent = countIndent(line);
			if (lineIndent < indent) break;
			const trimmed = line.slice(lineIndent);
			if (lineIndent !== indent || (!trimmed.startsWith("- ") && trimmed !== "-")) break;

			const rawItem = trimmed === "-" ? "" : trimmed.slice(2).trim();
			index++;

			if (rawItem === "") {
				skipBlank();
				if (index < lines.length && countIndent(lines[index] ?? "") > indent) {
					result.push(parseBlock(countIndent(lines[index] ?? "")));
				} else {
					result.push(null);
				}
				continue;
			}

			const separator = findKeySeparator(rawItem);
			if (separator !== -1) {
				const key = rawItem.slice(0, separator).trim();
				const rawValue = rawItem.slice(separator + 1).trim();
				const item: Record<string, unknown> = {};
				item[key] = rawValue === "" ? null : parseYamlScalar(rawValue);

				skipBlank();
				if (rawValue === "" && index < lines.length && countIndent(lines[index] ?? "") > indent + 1) {
					item[key] = parseBlock(countIndent(lines[index] ?? ""));
				}
				if (index < lines.length && countIndent(lines[index] ?? "") > indent) {
					const nested = parseMapping(indent + 2);
					for (const [nestedKey, nestedValue] of Object.entries(nested)) item[nestedKey] = nestedValue;
				}
				result.push(item);
				continue;
			}

			result.push(parseYamlScalar(rawItem));
		}

		return result;
	};

	skipBlank();
	if (index >= lines.length) return {};
	return parseBlock(countIndent(lines[index] ?? ""));
}

export function formatYamlScalar(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "[]" : JSON.stringify(value);
	if (isPlainObject(value)) return Object.keys(value).length === 0 ? "{}" : JSON.stringify(value);
	const stringValue = String(value);
	if (stringValue === "") return '""';
	if (/^[A-Za-z0-9_./-]+$/.test(stringValue)) return stringValue;
	return JSON.stringify(stringValue);
}

export function stringifySimpleYaml(value: unknown, indent: number = 0): string {
	const prefix = " ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return `${prefix}[]`;
		return value
			.map((item) => {
				if (Array.isArray(item) || isPlainObject(item)) {
					const isEmptyObject = isPlainObject(item) && Object.keys(item).length === 0;
					if (Array.isArray(item) && item.length === 0) return `${prefix}- []`;
					if (isEmptyObject) return `${prefix}- {}`;
					return `${prefix}-\n${stringifySimpleYaml(item, indent + 2)}`;
				}
				return `${prefix}- ${formatYamlScalar(item)}`;
			})
			.join("\n");
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) return `${prefix}{}`;
		return entries
			.map(([key, entryValue]) => {
				if (Array.isArray(entryValue) || isPlainObject(entryValue)) {
					const isEmptyObject = isPlainObject(entryValue) && Object.keys(entryValue).length === 0;
					if (Array.isArray(entryValue) && entryValue.length === 0) return `${prefix}${key}: []`;
					if (isEmptyObject) return `${prefix}${key}: {}`;
					return `${prefix}${key}:\n${stringifySimpleYaml(entryValue, indent + 2)}`;
				}
				return `${prefix}${key}: ${formatYamlScalar(entryValue)}`;
			})
			.join("\n");
	}
	return `${prefix}${formatYamlScalar(value)}`;
}

export async function loadYamlFile<T>(path: string): Promise<T> {
	const raw = await readFile(path, "utf8");
	return (parseSimpleYaml(raw) ?? {}) as T;
}
