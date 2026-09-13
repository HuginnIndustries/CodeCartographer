// Argument completion for the /codecarto-* slash commands.
//
// Pi hands `getArgumentCompletions` everything typed after the command name,
// and when the user accepts an item it replaces all of that text with the
// item's `value` (pi 0.85: `argumentText = textBeforeCursor.slice(spaceIndex
// + 1)` on the way in, `applyCompletion` slicing `cursorCol - prefix.length`
// on the way out). A completer that matches the *last* token but returns a
// bare flag therefore erases every flag typed before it: with the popup open,
// `/codecarto-next --auto --llm-steer` became `/codecarto-next --llm-steer` on
// Enter, the steered phase ran alone, and the auto run never started. The
// same shape turned `--auto --strict` into `--strict`, the one combination
// the parser rejects.
//
// So: match the last token, but return the whole line.

export interface CompletionCandidate {
	value: string;
	label?: string;
	description?: string;
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

/**
 * Complete the last whitespace-separated token of `prefix` from `candidates`,
 * returning items whose `value` is the full argument text Pi should put in
 * the line — every earlier token, then the candidate. A candidate already
 * typed as an earlier token is not offered again. Returns null when nothing
 * matches, which is what Pi expects for "no popup".
 */
export function completeLastToken(prefix: string, candidates: readonly CompletionCandidate[]): CompletionItem[] | null {
	const tokens = prefix.split(/\s+/);
	const last = tokens.pop() ?? "";
	const earlier = tokens.filter((token) => token.length > 0);
	const head = earlier.join(" ");
	const typed = new Set(earlier);
	const items = candidates
		.filter((candidate) => candidate.value.startsWith(last) && !typed.has(candidate.value))
		.map((candidate) => ({
			value: head ? `${head} ${candidate.value}` : candidate.value,
			label: candidate.label ?? candidate.value,
			...(candidate.description && { description: candidate.description }),
		}));
	return items.length > 0 ? items : null;
}
