// Secret redaction for text that leaves the machine (#252).
//
// Broad-Side uploads repository content to a batch API as-is; the only thing
// keeping a `.env` out of a batch was that no language glob matched it. This
// module is the content-level counterpart: files that exist to hold secrets
// are skipped by name, and high-confidence secret shapes inside any other
// file are replaced with `[REDACTED:<kind>]` before the text is sent. The
// marker keeps the *presence* of a credential visible to the security lens —
// `password = "[REDACTED:credential-assignment]"` is still a hardcoded
// credential to flag — while the value stays home.
//
// The patterns are deliberately the well-known, low-false-positive ones. A
// generic entropy scan would redact hashes, ids, and base64 blobs that the
// lenses need to read, and the point of the pass is to make an accidental
// upload harmless, not to replace a secret scanner in CI.

/** A file whose purpose is to hold credentials; never uploaded, whatever a lens's globs say. */
const SECRET_FILE_PATTERNS: RegExp[] = [
	/^\.env(?:\..*)?$/i, // .env, .env.local, .env.production — templates included; they hold values more often than not
	/\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg|ppk)$/i,
	/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/, // private keys and their .pub siblings; the public half is noise anyway
	/^(?:\.npmrc|\.pypirc|\.netrc|_netrc|\.htpasswd|\.git-credentials|\.pgpass|\.my\.cnf|\.boto)$/i,
	// credentials.json, secrets.yaml, secret.env — data files by that name.
	// Not `secrets.go` or `credentials.py`: source that *handles* secrets is
	// exactly what the security lens should read, so only data extensions
	// (or none) count here.
	/^(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|txt|cfg|conf|properties|env|local))?$/i,
	/\.secret$/i,
	/\.tfvars(?:\.json)?$/i,
	/^service[-_]?account.*\.json$/i,
];

/** Whether a repo-relative path names a file that exists to hold secrets. */
export function isSecretFile(relPath: string): boolean {
	const base = relPath.slice(relPath.lastIndexOf("/") + 1);
	return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

interface SecretPattern {
	kind: string;
	pattern: RegExp;
	/** Builds the replacement from the match's capture groups; the whole match is replaced when absent. */
	rebuild?: (marker: string, ...groups: string[]) => string;
}

const SECRET_PATTERNS: SecretPattern[] = [
	{ kind: "private-key", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY(?: BLOCK)?-----/g },
	{ kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
	// OpenAI, OpenRouter (sk-or-v1-…), and Anthropic (sk-ant-…) keys share the prefix.
	{ kind: "sk-api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	// `password: "hunter2hunter2"`, `API_KEY = 'abcdefgh…'`: the key and the
	// quotes stay, the value goes. Eight characters or more, so `password: "x"`
	// in a test fixture is left alone.
	// The key may carry a prefix (`DB_PASSWORD`, `stripe-secret-key`), and a
	// value that is already a marker is left alone, which is what makes the
	// pass idempotent.
	{
		kind: "credential-assignment",
		pattern: /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|password|passwd|pwd|secret|token)\s*[:=]\s*)(["'`])(?!\[REDACTED:)([^"'`\r\n]{8,})\2/gi,
		rebuild: (marker, prefix, quote) => `${prefix}${quote}${marker}${quote}`,
	},
	// The password in `scheme://user:password@host`.
	{
		kind: "url-credential",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:)(?!\[REDACTED:)([^\s/@"']{3,})(@)/gi,
		rebuild: (marker, head, _password, at) => `${head}${marker}${at}`,
	},
];

export interface RedactionResult {
	text: string;
	/** Values replaced, in total. */
	count: number;
	/** Values replaced per kind, kinds in the order first seen. */
	kinds: Record<string, number>;
}

/**
 * Replace every high-confidence secret in `text` with `[REDACTED:<kind>]`.
 * Idempotent: a marker contains nothing any pattern matches.
 */
export function redactSecrets(text: string): RedactionResult {
	let out = text;
	let count = 0;
	const kinds: Record<string, number> = {};
	for (const { kind, pattern, rebuild } of SECRET_PATTERNS) {
		out = out.replace(pattern, (...match: unknown[]) => {
			count++;
			kinds[kind] = (kinds[kind] ?? 0) + 1;
			const marker = `[REDACTED:${kind}]`;
			if (!rebuild) return marker;
			// replace() passes [whole, ...groups, offset, input]; hand over the groups.
			const groups = match.slice(1, match.length - 2).map((value) => (typeof value === "string" ? value : ""));
			return rebuild(marker, ...groups);
		});
	}
	return { text: out, count, kinds };
}

/** One line for a submit report: what the pass did, or nothing when it did nothing. */
export function describeRedactions(values: number, files: number, skipped: string[]): string | null {
	const parts: string[] = [];
	if (values > 0) parts.push(`redacted ${values} secret-like value(s) in ${files} file(s)`);
	if (skipped.length > 0) {
		const shown = skipped.slice(0, 3).join(", ");
		parts.push(`skipped ${skipped.length} secret-bearing file(s) by name (${shown}${skipped.length > 3 ? ", …" : ""})`);
	}
	if (parts.length === 0) return null;
	return `Before upload: ${parts.join("; ")}.`;
}
