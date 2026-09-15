// The lens registry: per-language defect and convention profiles, each lens's scope, prompts, and caps.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { BROADSIDE_LENS_IDS, type BroadsideLensId } from "./constants.ts";
import { type BroadsideReasoning, type RepoInfo } from "./types.ts";

// ---------- lens definitions ----------

// Lenses share their JSON schemas across languages, but prompts must speak
// the language's idioms: "goroutines without ctx" is noise to a Python
// scanner. Profiles supply per-language defect patterns and convention
// vocabulary; unknown languages get the neutral default.
type LanguageProfile = {
	defectPatterns: string[];
	conventionCategories: Array<{ key: string; label: string }>;
	idiomHints: string[];
};

const TS_PROFILE: LanguageProfile = {
	defectPatterns: [
		"Null/undefined dereference risks (unchecked optional access)",
		"Error handling gaps (unhandled promise rejections, swallowed catches)",
		"Resource leaks (unclosed handles, missing cleanup, dangling timers/listeners)",
		"Race conditions (shared mutable state, async interleavings without guards)",
		"Integer/precision assumptions in arithmetic",
		"Unsafe type assumptions (as-casts, any leaks, non-null assertions)",
		"Panic-prone code (out-of-bounds access, runtime TypeError paths)",
		"Timezone/locale assumptions",
	],
	conventionCategories: [
		{ key: "packages", label: "modules and imports" },
		{ key: "types", label: "interfaces and type aliases" },
		{ key: "functions", label: "functions (camelCase), components (PascalCase)" },
		{ key: "variables", label: "variables and constants (camelCase)" },
		{ key: "files", label: "file naming (kebab vs camel) and folder organization" },
		{ key: "tests", label: "test files (*.test.ts, describe/it patterns)" },
	],
	idiomHints: ["strict null checks usage", "async/await vs promise chains", "dependency injection patterns"],
};

const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
	go: {
		defectPatterns: [
			"Nil pointer dereference risks (unchecked returns, missing nil guards)",
			"Error handling gaps (ignored errors, deferred errors unchecked)",
			"Resource leaks (unclosed files, connections, goroutines without ctx)",
			"Race conditions (shared state without sync, channel misuse)",
			"Integer overflow/underflow in arithmetic or bounds",
			"Unsafe type assertions without ok check",
			"Panic-prone code (slice out of bounds, map access without ok)",
			"Timezone/locale assumptions",
		],
		conventionCategories: [
			{ key: "packages", label: "packages" },
			{ key: "types", label: "types and interfaces" },
			{ key: "functions", label: "functions and methods" },
			{ key: "variables", label: "variables and fields" },
			{ key: "files", label: "file and directory organization" },
			{ key: "tests", label: "test files and table-driven tests" },
		],
		idiomHints: ["error wrapping with %w", "zero-value construction"],
	},
	python: {
		defectPatterns: [
			"None dereference risks (unchecked optional returns, AttributeError paths)",
			"Exception handling gaps (bare except, swallowed exceptions, broad catch-all)",
			"Resource leaks (unclosed files, sockets, connections, context managers)",
			"Race conditions (shared mutable state, threading without locks, async pitfalls)",
			"Integer/float precision assumptions in arithmetic",
			"Unsafe type assumptions (unpacking mismatches, isinstance without fallback)",
			"Panic-prone code (IndexError/KeyError paths, unbounded slicing)",
			"Timezone/locale assumptions (naive datetimes)",
		],
		conventionCategories: [
			{ key: "packages", label: "modules and packages" },
			{ key: "types", label: "classes and type hints" },
			{ key: "functions", label: "functions and methods (snake_case vs camelCase)" },
			{ key: "variables", label: "variables and constants" },
			{ key: "files", label: "file and module organization" },
			{ key: "tests", label: "test files (pytest fixtures, naming)" },
		],
		idiomHints: ["dunder method usage", "context manager idioms", "dataclass/pydantic models"],
	},
	rust: {
		defectPatterns: [
			"Unwrap/expect panics on fallible paths",
			"Error handling gaps (swallowed Results, lossy conversions)",
			"Resource leaks (unclosed handles, drop order assumptions)",
			"Data races and Send/Sync violations (unsafe blocks, interior mutability misuse)",
			"Integer overflow/underflow (arithmetic, casting)",
			"Unsafe type assumptions (transmute/casts without invariants)",
			"Panic-prone code (indexing, slicing, unreachable! in library paths)",
			"Timezone/locale assumptions",
		],
		conventionCategories: [
			{ key: "packages", label: "crates and modules" },
			{ key: "types", label: "structs, enums, and traits" },
			{ key: "functions", label: "functions and methods (snake_case)" },
			{ key: "variables", label: "variables and constants (SCREAMING_SNAKE)" },
			{ key: "files", label: "module file organization" },
			{ key: "tests", label: "test modules and #[cfg(test)] patterns" },
		],
		idiomHints: ["Result/Option handling with ?", "builder patterns", "trait-based extension"],
	},
	typescript: TS_PROFILE,
	javascript: TS_PROFILE,
	default: {
		defectPatterns: [
			"Null/undefined dereference risks (unchecked optional access)",
			"Error handling gaps (ignored or swallowed errors)",
			"Resource leaks (unclosed files, connections, handles)",
			"Race conditions (shared mutable state without synchronization)",
			"Integer overflow/underflow in arithmetic or bounds",
			"Unsafe type assumptions and unchecked casts",
			"Panic-prone code (out-of-bounds access, missing keys)",
			"Timezone/locale assumptions",
		],
		conventionCategories: [
			{ key: "packages", label: "modules, packages, or namespaces" },
			{ key: "types", label: "types, classes, and interfaces" },
			{ key: "functions", label: "functions and methods" },
			{ key: "variables", label: "variables and constants" },
			{ key: "files", label: "file and directory organization" },
			{ key: "tests", label: "test files and test organization" },
		],
		idiomHints: [],
	},
};

function languageProfile(language: string): LanguageProfile {
	return LANGUAGE_PROFILES[language] ?? LANGUAGE_PROFILES.default;
}

export type LensDefinition = {
	id: BroadsideLensId;
	name: string;
	description: string;
	schemaName: string;
	// "none" = one slice for the whole repo; "directory" = one slice per
	// top-level module; "auto" = directory for large repos, none for small
	// ones (see resolveSliceMode).
	sliceBy: "none" | "directory" | "auto";
	maxChars: number;
	maxTokens: number;
	// Omitted means BROADSIDE_DEFAULT_REASONING (off). Set this only for a lens
	// that genuinely needs to think, and raise its maxTokens to cover both.
	reasoning?: BroadsideReasoning;
	// Test files rarely carry the surface a lens audits — they bulk up the
	// batch and the bill. Convention extraction is the exception: it exists
	// partly to catalog test patterns.
	skipTestFiles?: boolean;
	// Globs are matched against repo-relative forward-slash paths.
	globsFor: (info: RepoInfo) => string[];
	/**
	 * Where to look when `globsFor` matches no source file (#319). The
	 * security and api lenses target server/, auth, and middleware paths
	 * because that is where the trust boundary usually lives; a service whose
	 * server is `src/server.js` matched none of them and got no security
	 * review at all. A match that is only documents is the same starvation:
	 * `SECURITY.md` satisfied the security lens on CodeCartographer itself,
	 * which then reviewed a policy and reported zero findings. The fallback
	 * is the language's whole source set, added to whatever did match —
	 * priced as such, and said so in the estimate, the run record, and the
	 * prompt.
	 */
	fallbackGlobsFor?: (info: RepoInfo) => string[];
	systemPrompt: (info: RepoInfo) => string;
	userPrompt: (info: RepoInfo, source: string, moduleName: string) => string;
};

const LENSES: Record<BroadsideLensId, LensDefinition> = {
	architecture: {
		id: "architecture",
		name: "Architecture, tech stack & module map",
		description: "Repo-wide structural analysis from the manifest, entry point, README, and file tree.",
		schemaName: "architecture",
		sliceBy: "none",
		maxChars: 0, // repo-info lens; no file slurping
		maxTokens: 8000,
		globsFor: () => [],
		systemPrompt: () =>
			"You are a senior software architect performing a structural analysis of a " +
			"codebase. You receive the project manifest, entry point, README excerpt, and " +
			"file tree. Return a JSON object following the architecture_report schema " +
			"exactly. All findings must be traceable to the provided files — cite file " +
			"paths. If you can't determine something, say so rather than guessing.",
		userPrompt: (info) => {
			const manifest = info.manifest
				? `## ${info.manifest.path}\n\`\`\`\n${info.manifest.content}\n\`\`\`\n\n`
				: "## Manifest\n[no manifest found]\n\n";
			return (
				"Analyze the architecture of this project.\n\n" +
				manifest +
				`## Entry point\n\`\`\`\n${info.mainFile || "[missing]"}\n\`\`\`\n\n` +
				`## README (first 4000 chars)\n${info.readmeFirst || "[missing]"}\n\n` +
				`## File tree (depth 3, capped)\n${info.fileTree || "[missing]"}\n\n` +
				"## File counts by extension\n```json\n" +
				JSON.stringify(info.fileCounts) +
				"\n```\n\n" +
				"Return the architecture_report JSON schema."
			);
		},
	},
	api: {
		id: "api",
		name: "API surface audit",
		description: "Endpoint catalog, request/response types, auth flow, error handling.",
		schemaName: "api_surface",
		sliceBy: "none",
		maxChars: 70_000,
		maxTokens: 8000,
		skipTestFiles: true,
		globsFor: (info) =>
			info.language === "go"
				? ["server/**/*.go", "server/*.go", "api/**/*.go", "api/*.go"]
				: [
						"server/**",
						"api/**",
						"src/server/**",
						"src/api/**",
						"mcp-server/**",
						"**/*routes*",
						"**/*router*",
						"**/*handler*",
						"**/*endpoint*",
					],
		fallbackGlobsFor: (info) => [info.sourceGlob],
		systemPrompt: () =>
			"You are a senior API auditor. Given source files from an HTTP server, " +
			"extract every HTTP endpoint (method, path, handler function, auth requirement) " +
			"and every key request/response data type. Return a JSON object following the " +
			"api_surface_report schema exactly. Cite specific file:line locations.",
		userPrompt: (info, source, moduleName) =>
			"Extract the full API surface from these server source files:\n\n" +
			source +
			"\n\nReturn the api_surface_report JSON schema.",
	},
	security: {
		id: "security",
		name: "Security review",
		description: "Auth, authorization, input validation, TLS, secrets, trust boundaries.",
		schemaName: "security",
		sliceBy: "none",
		maxChars: 70_000,
		maxTokens: 8000,
		skipTestFiles: true,
		globsFor: (info) =>
			info.language === "go"
				? ["server/**/*.go", "server/*.go", "**/auth*.go", "**/middleware/**/*.go", "SECURITY.md"]
				: ["server/**", "**/auth*", "**/middleware/**", "SECURITY.md"],
		fallbackGlobsFor: (info) => [info.sourceGlob],
		systemPrompt: () =>
			"You are a security engineer performing a first-pass review of a codebase. " +
			"Given source files, identify potential security issues — focusing on " +
			"authentication, authorization, input validation, TLS, secrets handling, " +
			"and trust boundaries. Return a JSON object following the security_review_report " +
			"schema. Rate severity as critical/high/medium/low. Be specific: cite file:line. " +
			"If the provided files don't cover an area, state the gap in coverage_note.",
		userPrompt: (info, source, moduleName) =>
			"Review these server source files for security issues:\n\n" +
			source +
			"\n\nReturn the security_review_report JSON schema.",
	},
	defect: {
		id: "defect",
		name: "Mechanical defect scan",
		description: "Nil derefs, error gaps, leaks, races, panics — pattern-based, sliced per module.",
		schemaName: "defect_mechanical",
		sliceBy: "auto",
		maxChars: 60_000,
		maxTokens: 6000,
		globsFor: (info) => [info.sourceGlob],
		systemPrompt: (info) => {
			const profile = languageProfile(info.language);
			const patterns = profile.defectPatterns.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
			return (
				`You are a senior code reviewer performing an automated defect scan on ${info.language} ` +
				"source files. Look for these specific patterns:\n" +
				patterns +
				"\n\n" +
				"Return a JSON object following the defect_scan_report schema. " +
				"Cite file:line for every finding. List which patterns you checked. " +
				"If the code looks clean for a pattern, say so rather than staying silent. " +
				"Prefer precision over volume — 3 solid findings beat 15 vague ones.\n\n" +
				// The verification pass (#143) confirmed 2 of the 12 top findings a
				// scan produced with the paragraph above alone; the other ten were
				// casts and assertions every caller satisfied, guards that lived one
				// call away, or environments the project does not target. The rubric
				// the verifier applies is asked of the scan itself, up front.
				"A finding is a reachable failure: name in the description the concrete input, call site, or sequence " +
				"that reaches it and what then goes wrong. A cast, assertion, `any`, or non-null `!` that every caller " +
				"you can see satisfies, a hypothetical about a runtime or environment the project does not target, or a " +
				"style or type-hygiene observation is not a defect — leave it out, or if it is worth a note, report it " +
				"at severity low under the pattern name `type-hygiene` so it ranks apart from reachable failures. " +
				"When the guard you looked for may live in another module, say which check you could not find " +
				"rather than asserting it is absent; severity high or medium is for failures you traced to a trigger."
			);
		},
		userPrompt: (info, source, moduleName) =>
			`Scan this ${info.language} module for mechanical defects.\n\n` +
			`Module: ${moduleName}\n\n` +
			"## Source files\n\n" +
			source +
			"\n\nReturn the defect_scan_report JSON schema.",
	},
	conventions: {
		id: "conventions",
		name: "Convention extraction",
		description: "Naming, error handling, idioms, inconsistencies, promotable conventions.",
		schemaName: "conventions",
		sliceBy: "auto",
		maxChars: 60_000,
		maxTokens: 6000,
		globsFor: (info) => [info.sourceGlob],
		systemPrompt: (info) => {
			const profile = languageProfile(info.language);
			const categories = profile.conventionCategories.map((c) => `${c.key} (${c.label})`).join(", ");
			const idiomHint =
				profile.idiomHints.length > 0
					? ` Keep an eye out for ${info.language} idioms such as ${profile.idiomHints.join(", ")}.`
					: "";
			return (
				`You are a code style analyst extracting conventions from ${info.language} source files. ` +
				"Catalog naming conventions per category — " + categories + " — plus the dominant " +
				"error-handling pattern, logging approach, test organization patterns, file/package " +
				"organization rules, and recurring idioms." + idiomHint +
				" Also flag inconsistencies — places where the same convention is violated. " +
				"If you find well-established conventions worth formalizing, list them as " +
				"promotable_conventions with a title, rule, and evidence from the code. " +
				"Return a JSON object following the conventions_report schema."
			);
		},
		userPrompt: (info, source, moduleName) =>
			"Extract coding conventions from this module.\n\n" +
			`Module: ${moduleName}\n\n` +
			"## Source files\n\n" +
			source +
			"\n\nReturn the conventions_report JSON schema.",
	},
	porting: {
		id: "porting",
		name: "Porting surface assessment",
		description: "Platform coupling, external deps, build complexity, porting risk areas.",
		schemaName: "porting",
		sliceBy: "auto",
		maxChars: 60_000,
		maxTokens: 6000,
		skipTestFiles: true,
		globsFor: (info) => [
			info.sourceGlob,
			"**/*.c",
			"**/*.h",
			"**/*.cpp",
			"**/*.cc",
			"**/*.m",
			"**/*.mm",
			"**/CMakeLists.txt",
			"**/*.cmake",
			"go.mod",
		],
		systemPrompt: () =>
			"You are a software portability analyst. Examine source files and " +
			"identify everything that ties this codebase to a specific platform, OS, " +
			"architecture, or external dependency. Catalog: platform-specific build tags, " +
			"FFI usage, OS-specific syscalls, external library bindings, and " +
			"compile-time constants that encode platform assumptions. " +
			"For each external dependency, note whether it could be replaced by a " +
			"cross-platform alternative. Assess the build system complexity. " +
			"Return a JSON object following the porting_surface_report schema.",
		userPrompt: (info, source, moduleName) =>
			"Assess porting surface for this module.\n\n" +
			`Module: ${moduleName}\n\n` +
			"## Source files\n\n" +
			source +
			"\n\nReturn the porting_surface_report JSON schema.",
	},
};

export function getLens(lensId: BroadsideLensId): LensDefinition {
	return LENSES[lensId];
}

export function listLenses(): LensDefinition[] {
	return BROADSIDE_LENS_IDS.map((id) => LENSES[id]);
}
