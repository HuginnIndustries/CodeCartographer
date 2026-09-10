// Hand-rolled YAML parser/serializer good enough for the .codecarto workflow
// files (mappings, sequences, scalars, nested maps, strings/numbers/booleans).
// Round-trips structured carry_forward/open_questions entries.

import { readFile } from "node:fs/promises";
import { isPlainObject } from "./utils.ts";

/**
 * True when the double quote at `index` is escaped, i.e. preceded by an odd
 * run of backslashes. Checking only the single previous character read `\\"`
 * (an escaped backslash, then the closing quote) as an escaped quote, so the
 * scalar never closed and a trailing ` # comment` leaked into the value (#134).
 */
function isEscapedQuote(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

export function stripYamlComment(value: string): string {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle && !isEscapedQuote(value, i)) {
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
		if (char === '"' && !inSingle && !isEscapedQuote(text, i)) {
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
	// A quoted scalar needs at least its two quotes: a lone quote character
	// satisfied startsWith and endsWith at once and was sliced to "" (#134).
	const canBeQuoted = trimmed.length >= 2;
	if (canBeQuoted && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (canBeQuoted && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	return trimmed;
}

/**
 * Block scalar header: the `|`/`>` style plus an optional chomping indicator.
 *
 * Folded (`>`) is supported because a handoff is usually written by a model,
 * and a model reaching for a wrapped prose field reaches for `>-` — the field
 * `closeout_summary` is exactly that shape. Before this, `>-` fell through to
 * the plain-scalar path and the block body then failed the indentation check,
 * so valid YAML was rejected with a message that blamed whitespace (#211).
 */
interface BlockScalarHeader {
	/** true for `|` (literal), false for `>` (folded). */
	literal: boolean;
	/** `-` strip, `+` keep, `` clip (a single trailing newline). */
	chomp: "strip" | "keep" | "clip";
}

function parseBlockScalarHeader(rawValue: string): BlockScalarHeader | null {
	const match = /^([|>])([-+]?)$/.exec(rawValue);
	if (!match) return null;
	return {
		literal: match[1] === "|",
		chomp: match[2] === "-" ? "strip" : match[2] === "+" ? "keep" : "clip",
	};
}

/**
 * Fold a block scalar's lines per YAML's folding rules: a single line break
 * between two content lines becomes a space, and a run of k blank lines becomes
 * k newlines. Lines indented deeper than the block's own content indent are
 * "more indented" and keep their breaks literally, which is what lets a folded
 * block hold an indented snippet without it being flattened onto one line.
 */
function foldBlockLines(blockLines: readonly string[]): string {
	let result = "";
	let pendingBreaks = 0;
	let started = false;
	let previousMoreIndented = false;

	for (const line of blockLines) {
		if (line.trim() === "") {
			pendingBreaks++;
			continue;
		}
		const moreIndented = /^[ \t]/.test(line);
		if (!started) {
			result = line;
			started = true;
			previousMoreIndented = moreIndented;
			continue;
		}
		if (pendingBreaks > 0) {
			result += "\n".repeat(pendingBreaks);
			pendingBreaks = 0;
		} else if (moreIndented || previousMoreIndented) {
			result += "\n";
		} else {
			result += " ";
		}
		result += line;
		previousMoreIndented = moreIndented;
	}

	return started ? result + "\n".repeat(pendingBreaks) : "";
}

function applyBlockScalar(blockLines: readonly string[], header: BlockScalarHeader): string {
	const content = header.literal ? blockLines.join("\n") : foldBlockLines(blockLines);
	if (header.chomp === "keep") return content;
	const stripped = content.replace(/\n+$/, "");
	return header.chomp === "strip" ? stripped : `${stripped}\n`;
}

export function parseSimpleYaml(raw: string): unknown {
	const lines = raw.split(/\r?\n/);
	let index = 0;

	const skipBlank = (): void => {
		while (index < lines.length && isBlankOrComment(lines[index] ?? "")) index++;
	};

	/**
	 * Read the body of a block scalar that opened on the line just consumed.
	 * Shared by mapping values (`key: >-`) and sequence items (`- >-`): when only
	 * the mapping path had it, a handoff whose `decisions:` list used `- >-`
	 * still failed with the indentation error that #211 was supposed to end.
	 */
	const collectBlockScalarLines = (baseIndent: number): string[] => {
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
			if (blockIndent <= baseIndent) break;
			contentIndent ??= blockIndent;
			blockLines.push(blockLine.slice(Math.min(contentIndent, blockIndent)));
			index++;
		}
		return blockLines;
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
		// Duplicate detection tracks keys explicitly rather than testing
		// `key in result`. A bare object inherits from Object.prototype, so
		// `"constructor" in result` is already true before anything is parsed —
		// a document whose key is `constructor`, `toString`, `valueOf` or any
		// other prototype member was rejected as a duplicate on first sight.
		const seen = new Set<string>();
		// Assignment goes through defineProperty for the same reason: plain
		// `result[key] = value` with the key `__proto__` invokes the prototype
		// setter instead of creating an entry, so a hand-edited YAML file could
		// change the shape of every object in the process rather than parse.
		const assign = (key: string, value: unknown): void => {
			Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true });
		};

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
			if (seen.has(key)) {
				throw new Error(`Duplicate YAML key: ${key} near line: ${line.trim()}`);
			}
			seen.add(key);

			const blockHeader = parseBlockScalarHeader(rawValue);
			if (blockHeader) {
				assign(key, applyBlockScalar(collectBlockScalarLines(indent), blockHeader));
				continue;
			}

			if (rawValue !== "") {
				assign(key, parseYamlScalar(rawValue));
				continue;
			}

			skipBlank();
			if (index < lines.length && countIndent(lines[index] ?? "") > indent) {
				assign(key, parseBlock(countIndent(lines[index] ?? "")));
			} else {
				assign(key, null);
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

			const afterDash = trimmed === "-" ? "" : trimmed.slice(2);
			const rawItem = afterDash.trim();
			// A sequence item's mapping continues at the column where its own
			// content starts, which is not always two past the dash: `-   id: x`
			// aligns its siblings under the `i`, four columns in. Hardcoding two
			// rejected that valid layout as bad indentation.
			const itemIndent = indent + 2 + (afterDash.length - afterDash.trimStart().length);
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

			const itemBlockHeader = parseBlockScalarHeader(rawItem);
			if (itemBlockHeader) {
				result.push(applyBlockScalar(collectBlockScalarLines(indent), itemBlockHeader));
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
					const nested = parseMapping(itemIndent);
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
