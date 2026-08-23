// Broad-Side: cheap batch reconnaissance over the OpenRouter Batch API.
//
// Broad-Side fires every analysis lens at a repository at once. Each lens is a
// single-turn prompt with a structured-output JSON schema, submitted as an
// asynchronous batch job (Google Gemini's batch endpoint, ~50% of sync pricing)
// and polled to completion. Results land in `.codecarto/broadside/<run>/` as
// JSON plus rendered markdown, and an optional synthesis pass cross-references
// every lens into one executive report.
//
// This is deliberately NOT the interactive CodeCartographer pipeline. The batch
// API is text-in/text-out: no filesystem access, no multi-turn exploration, no
// runtime verification. Broad-Side findings are unverified scouting signals —
// file:line leads that a real analysis (or a human) must confirm. That division
// of labor is the point: a ~$0.50 unattended sweep that tells the expensive
// interactive run where to look.
//
// Field shapes for the model catalog and benchmarks endpoints follow the
// official OpenRouter skills (OpenRouterTeam/skills: openrouter-models,
// openrouter-benchmarks).
//
// RESUBMISSION INVARIANT: batch requests are pure functions of their input —
// no tools, no filesystem, no side effects — so resubmitting a failed or
// truncated slice is always safe. This is the retry rule OpenRouter's own
// headless-agent scaffold states the hard way (retry only before tool calls,
// because replaying a mutating tool would double-execute it); here the rule is
// satisfied by construction. If Broad-Side ever gains server tools
// (openrouter:web_search etc.), this invariant becomes load-bearing and the
// resubmit path must gate on whether any tool executed.
//
// Deliberately not in .codecarto/ template prose: Broad-Side requires runtime
// code, so it lives on the executable surfaces (MCP today, Pi on the roadmap).

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { pathExists, sleep } from "./utils.ts";
import { loadYamlFile } from "./yaml.ts";

const execFileAsync = promisify(execFile);

// ---------- constants ----------

export const BROADSIDE_MODEL = "google/gemini-3.7-flash:batch";
export const BROADSIDE_BATCH_URL = "https://openrouter.ai/api/beta/batches";
export const BROADSIDE_DIR = "broadside"; // relative to .codecarto/
export const BROADSIDE_STATE_FILE = "state.json";
export const BROADSIDE_CONFIG_FILE = "config.yaml";
export const BROADSIDE_STATE_SCHEMA_VERSION = 1;

// Per-token pricing in USD (OpenRouter, google/gemini-3.7-flash:batch).
export const BROADSIDE_INPUT_PRICE_PER_M = 0.1875;
export const BROADSIDE_OUTPUT_PRICE_PER_M = 0.9375;

// OpenRouter's public model catalog; pricing, context, and capabilities live
// per model id. The benchmarks endpoint adds coding/intelligence indices.
export const BROADSIDE_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const BROADSIDE_BENCHMARKS_URL = "https://openrouter.ai/api/v1/benchmarks";

export const BROADSIDE_CATALOG_CACHE_FILE = "model-catalog.json";
export const BROADSIDE_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const BROADSIDE_LENS_IDS = [
	"architecture",
	"api",
	"security",
	"defect",
	"conventions",
	"porting",
] as const;
export type BroadsideLensId = (typeof BROADSIDE_LENS_IDS)[number];

export const BROADSIDE_POLL_INTERVAL_MS = 15_000;
export const BROADSIDE_DEFAULT_POLL_BUDGET_MS = 25 * 60 * 1000;

// ---------- types ----------

export type ModelPricing = {
	/** USD per million input tokens. */
	inputPerM: number;
	/** USD per million output tokens. */
	outputPerM: number;
	/** Where the numbers came from — affects what the submit text claims. */
	source: "built-in" | "config" | "live" | "cache";
};

/** The subset of the OpenRouter model catalog Broad-Side actually uses. */
export type CatalogEntry = {
	id: string;
	name: string;
	inputPerM: number;
	outputPerM: number;
	cachedInputPerM?: number;
	contextLength?: number;
	maxCompletionTokens?: number;
	/** Empty array means unknown, not "supports nothing". */
	supportedParameters: string[];
	expirationDate?: string | null;
};

export type CodingBenchmarks = {
	/** Base model slug (batch suffix stripped) → indices. */
	byBaseSlug: Record<string, { codingIndex?: number; intelligenceIndex?: number }>;
	/** Citation/attribution metadata from the benchmarks endpoint. */
	meta: Record<string, unknown>;
};

export type BroadsideCatalogResult = {
	model: string;
	source: "built-in" | "config" | "live" | "cache";
	entry: CatalogEntry | null;
	benchmarks?: CodingBenchmarks;
};

export type JsonSchemaDef = {
	name: string;
	strict: boolean;
	schema: Record<string, unknown>;
};

export type RepoInfo = {
	name: string;
	path: string;
	language: string;
	manifest: { path: string; content: string } | null;
	mainFile: string;
	readmeFirst: string;
	fileTree: string;
	fileCounts: Record<string, number>;
	sourceGlob: string;
	sourceExts: string[];
};

export type FileSlice = {
	moduleName: string;
	content: string;
	fileCount: number;
	chars: number;
};

export type BatchRequest = {
	custom_id: string;
	body: {
		model: string;
		messages: { role: "system" | "user"; content: string }[];
		response_format: { type: "json_schema"; json_schema: JsonSchemaDef };
		max_tokens: number;
	};
};

export type BatchTerminalStatus = "completed" | "failed" | "expired" | "cancelled";

export type BroadsideBatchEntry = {
	batchId: string;
	requests: number;
	status: string;
	submittedAt: string;
	completedAt?: string;
	estimatedCost: number;
	cost?: number;
	resultCount?: number;
	error?: unknown;
};

export type BroadsideSynthesisEntry = {
	batchId?: string;
	status: "pending" | "submitted" | "completed" | "failed";
	cost?: number;
};

/** One triage item — a scouting lead turned into a work-order entry. */
export type TriageItem = {
	title: string;
	severity: string;
	module: string;
	impact: "high" | "medium" | "low";
	difficulty: "high" | "medium" | "low";
	priority: string;
	effort_estimate: string;
	rationale: string;
};

export type BroadsideTriageEntry = {
	batchId?: string;
	status: "pending" | "submitted" | "completed" | "failed";
	cost?: number;
};

export type BroadsideRun = {
	id: string;
	createdAt: string;
	model: string;
	lenses: BroadsideLensId[];
	status: "in-flight" | "completed" | "partial" | "failed";
	outputDir: string; // relative to .codecarto/broadside/
	batches: Partial<Record<BroadsideLensId, BroadsideBatchEntry>>;
	synthesis: BroadsideSynthesisEntry;
	triage: BroadsideTriageEntry;
	totalCost?: number;
	pricing?: ModelPricing;
	maxCost?: number;
};

export type BroadsideStateFile = {
	schema_version: number;
	runs: BroadsideRun[];
};

export type BroadsideConfig = {
	model: string;
	apiKey: string;
	defaultLenses: BroadsideLensId[];
	/** Approximate run expense limit in USD; 0 means no limit. */
	maxCost: number;
	/** Manual pricing overrides (USD per million). Live lookup is preferred. */
	pricing: { inputPerM: number; outputPerM: number } | null;
};

export type BroadsideSubmitResult = {
	runId: string;
	outputDir: string;
	batches: Partial<Record<BroadsideLensId, BroadsideBatchEntry>>;
	estimatedTotalCost: number;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	pricing: ModelPricing;
	maxCost?: number;
	modelInfo: {
		contextLength?: number;
		maxCompletionTokens?: number;
		supportsStructuredOutputs?: boolean;
		expirationDate?: string | null;
	};
};

export type BroadsideCollectResult = {
	runId: string;
	status: string;
	totalCost: number;
	resultCount: number;
	/** Results whose JSON did not parse even after fence stripping —
	 * the signature of an output cut off at max_tokens. */
	truncatedCount: number;
	lensOutcomes: Partial<
		Record<BroadsideLensId, { status: string; cost?: number; resultCount?: number; truncated?: number }>
	>;
	synthesis: BroadsideSynthesisEntry;
	triage: BroadsideTriageEntry;
	topFindings: { title: string; severity: string; sourceLens: string; summary: string }[];
	topTriageItems: TriageItem[];
};

// ---------- JSON schemas (one per lens, plus synthesis) ----------

const SCHEMAS: Record<string, JsonSchemaDef> = {
	architecture: {
		name: "architecture_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				tech_stack: {
					type: "object",
					properties: {
						language: { type: "string" },
						version: { type: "string" },
						build_system: { type: "string" },
						key_dependencies: { type: "array", items: { type: "string" } },
					},
					required: ["language", "build_system"],
					additionalProperties: false,
				},
				module_architecture: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							role: { type: "string" },
							file_count: { type: "integer" },
							depends_on: { type: "array", items: { type: "string" } },
						},
						required: ["name", "role"],
						additionalProperties: false,
					},
				},
				data_flow: { type: "string" },
				entry_points: { type: "array", items: { type: "string" } },
				notable_patterns: { type: "array", items: { type: "string" } },
			},
			required: ["tech_stack", "module_architecture", "data_flow", "entry_points"],
			additionalProperties: false,
		},
	},
	api_surface: {
		name: "api_surface_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				endpoints: {
					type: "array",
					items: {
						type: "object",
						properties: {
							method: { type: "string" },
							path: { type: "string" },
							handler: { type: "string" },
							auth_required: { type: "boolean" },
							description: { type: "string" },
						},
						required: ["method", "path", "handler", "auth_required"],
						additionalProperties: false,
					},
				},
				data_types: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							kind: { type: "string" },
							fields_summary: { type: "string" },
						},
						required: ["name", "kind"],
						additionalProperties: false,
					},
				},
				authentication_flow: { type: "string" },
				error_handling: { type: "string" },
			},
			required: ["endpoints"],
			additionalProperties: false,
		},
	},
	security: {
		name: "security_review_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
							category: { type: "string" },
							title: { type: "string" },
							location: { type: "string" },
							description: { type: "string" },
						},
						required: ["severity", "title", "description"],
						additionalProperties: false,
					},
				},
				overall_assessment: { type: "string" },
				coverage_note: { type: "string" },
			},
			required: ["findings", "overall_assessment"],
			additionalProperties: false,
		},
	},
	defect_mechanical: {
		name: "defect_scan_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				module: { type: "string" },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							severity: { type: "string", enum: ["high", "medium", "low"] },
							pattern: { type: "string" },
							title: { type: "string" },
							location: { type: "string" },
							description: { type: "string" },
							suggestion: { type: "string" },
						},
						required: ["severity", "pattern", "title", "description"],
						additionalProperties: false,
					},
				},
				patterns_checked: { type: "array", items: { type: "string" } },
				files_scanned: { type: "integer" },
				overall_notes: { type: "string" },
			},
			required: ["module", "findings", "patterns_checked", "files_scanned"],
			additionalProperties: false,
		},
	},
	conventions: {
		name: "conventions_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				module: { type: "string" },
				naming_conventions: {
					type: "object",
					properties: {
						packages: { type: "string" },
						types: { type: "string" },
						functions: { type: "string" },
						variables: { type: "string" },
						files: { type: "string" },
						tests: { type: "string" },
					},
					additionalProperties: false,
				},
				error_handling_pattern: { type: "string" },
				logging_approach: { type: "string" },
				test_patterns: { type: "string" },
				code_organization: { type: "string" },
				idioms: { type: "array", items: { type: "string" } },
				inconsistencies: {
					type: "array",
					items: {
						type: "object",
						properties: {
							description: { type: "string" },
							locations: { type: "array", items: { type: "string" } },
						},
						required: ["description"],
						additionalProperties: false,
					},
				},
				promotable_conventions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							rule: { type: "string" },
							evidence: { type: "string" },
						},
						required: ["title", "rule"],
						additionalProperties: false,
					},
				},
				files_scanned: { type: "integer" },
			},
			required: ["module", "naming_conventions", "files_scanned"],
			additionalProperties: false,
		},
	},
	porting: {
		name: "porting_surface_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				module: { type: "string" },
				platform_coupling: {
					type: "array",
					items: {
						type: "object",
						properties: {
							platform: { type: "string" },
							mechanisms: { type: "array", items: { type: "string" } },
							files: { type: "array", items: { type: "string" } },
						},
						required: ["platform", "mechanisms"],
						additionalProperties: false,
					},
				},
				external_dependencies: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							role: { type: "string" },
							replaceability: { type: "string" },
						},
						required: ["name"],
						additionalProperties: false,
					},
				},
				build_system_complexity: { type: "string" },
				porting_risk_areas: {
					type: "array",
					items: {
						type: "object",
						properties: {
							area: { type: "string" },
							risk: { type: "string", enum: ["low", "medium", "high"] },
							notes: { type: "string" },
						},
						required: ["area", "risk"],
						additionalProperties: false,
					},
				},
				files_scanned: { type: "integer" },
			},
			required: ["module", "platform_coupling", "files_scanned"],
			additionalProperties: false,
		},
	},
	synthesis: {
		name: "synthesis_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				executive_summary: { type: "string" },
				severity_summary: {
					type: "object",
					properties: {
						critical: { type: "integer" },
						high: { type: "integer" },
						medium: { type: "integer" },
						low: { type: "integer" },
					},
					required: ["critical", "high", "medium", "low"],
					additionalProperties: false,
				},
				top_findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							severity: { type: "string" },
							source_lens: { type: "string" },
							summary: { type: "string" },
						},
						required: ["title", "severity", "source_lens", "summary"],
						additionalProperties: false,
					},
				},
				module_assessments: {
					type: "array",
					items: {
						type: "object",
						properties: {
							module: { type: "string" },
							quality_notes: { type: "string" },
							risk_level: { type: "string", enum: ["low", "medium", "high"] },
						},
						required: ["module", "risk_level"],
						additionalProperties: false,
					},
				},
				porting_readiness: { type: "string" },
				gaps_and_unknowns: { type: "array", items: { type: "string" } },
				coverage: { type: "string" },
			},
			required: ["executive_summary", "severity_summary", "top_findings"],
			additionalProperties: false,
		},
	},
	triage: {
		name: "triage_report",
		strict: true,
		schema: {
			type: "object",
			properties: {
				summary: { type: "string" },
				items: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							severity: { type: "string" },
							module: { type: "string" },
							impact: { type: "string", enum: ["high", "medium", "low"] },
							difficulty: { type: "string", enum: ["high", "medium", "low"] },
							priority: { type: "string" },
							effort_estimate: { type: "string" },
							rationale: { type: "string" },
						},
						required: ["title", "severity", "module", "impact", "difficulty", "priority", "rationale"],
						additionalProperties: false,
					},
				},
				omitted: {
					type: "array",
					items: { type: "string" },
					description: "Leads deliberately dropped from the queue and why (duplicates, too vague, out of scope)",
				},
			},
			required: ["summary", "items"],
			additionalProperties: false,
		},
	},
};

// ---------- lens definitions ----------

type LensDefinition = {
	id: BroadsideLensId;
	name: string;
	description: string;
	schemaName: string;
	sliceBy: "none" | "directory";
	maxChars: number;
	maxTokens: number;
	// Test files rarely carry the surface a lens audits — they bulk up the
	// batch and the bill. Convention extraction is the exception: it exists
	// partly to catalog test patterns.
	skipTestFiles?: boolean;
	// Globs are matched against repo-relative forward-slash paths.
	globsFor: (info: RepoInfo) => string[];
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
		sliceBy: "directory",
		maxChars: 60_000,
		maxTokens: 6000,
		globsFor: (info) => [info.sourceGlob],
		systemPrompt: (info) =>
			`You are a senior code reviewer performing an automated defect scan on ${info.language} ` +
			"source files. Look for these specific patterns:\n" +
			"  1. Nil/null pointer dereference risks (unchecked returns, missing guards)\n" +
			"  2. Error handling gaps (ignored errors, deferred errors unchecked)\n" +
			"  3. Resource leaks (unclosed files, connections, goroutines without ctx)\n" +
			"  4. Race conditions (shared state without sync, channel misuse)\n" +
			"  5. Integer overflow/underflow in arithmetic or bounds\n" +
			"  6. Unsafe type assertions without ok check\n" +
			"  7. Panic-prone code (slice out of bounds, map access without ok)\n" +
			"  8. Timezone/locale assumptions\n\n" +
			"Return a JSON object following the defect_scan_report schema. " +
			"Cite file:line for every finding. List which patterns you checked. " +
			"If the code looks clean for a pattern, say so rather than staying silent. " +
			"Prefer precision over volume — 3 solid findings beat 15 vague ones.",
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
		sliceBy: "directory",
		maxChars: 60_000,
		maxTokens: 6000,
		globsFor: (info) => [info.sourceGlob],
		systemPrompt: () =>
			"You are a code style analyst extracting conventions from source files. " +
			"Catalog: naming conventions per category (packages, types, functions, variables, " +
			"source files, test files), the dominant error-handling pattern, logging approach, " +
			"test organization patterns, file/package organization rules, and recurring idioms. " +
			"Also flag inconsistencies — places where the same convention is violated. " +
			"If you find well-established conventions worth formalizing, list them as " +
			"promotable_conventions with a title, rule, and evidence from the code. " +
			"Return a JSON object following the conventions_report schema.",
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
		sliceBy: "directory",
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

// ---------- repo info ----------

const SKIP_DIR_NAMES = new Set([
	".git",
	".github",
	".claude",
	".opencode",
	".codecarto",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
	"testdata",
	"__pycache__",
]);

const SKIP_FILE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
	".ico",
	".icns",
	".bmp",
	".webp",
	".mp3",
	".mp4",
	".mov",
	".avi",
	".wav",
	".ogg",
	".zip",
	".gz",
	".tar",
	".bz2",
	".xz",
	".7z",
	".pdf",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".otf",
	".bin",
	".exe",
	".dll",
	".so",
	".dylib",
	".a",
	".o",
	".obj",
	".class",
	".jar",
	".war",
	".pyc",
	".wasm",
	".model",
	".bpe",
]);

const MANIFEST_CANDIDATES = [
	["go.mod", "go"],
	["package.json", "typescript"],
	["Cargo.toml", "rust"],
	["pyproject.toml", "python"],
	["setup.py", "python"],
	["requirements.txt", "python"],
];

const SOURCE_SPECS: Record<string, { glob: string; exts: string[] }> = {
	go: { glob: "**/*.go", exts: [".go"] },
	python: { glob: "**/*.py", exts: [".py"] },
	rust: { glob: "**/*.rs", exts: [".rs"] },
	typescript: { glob: "**/*.ts", exts: [".ts", ".tsx"] },
	javascript: { glob: "**/*.js", exts: [".js", ".jsx"] },
};

async function listRepoFiles(targetDir: string): Promise<string[]> {
	// git ls-tree is the fast path; fall back to a bounded walk for non-git trees.
	try {
		const { stdout } = await execFileAsync("git", ["-C", targetDir, "ls-tree", "-r", "--name-only", "HEAD"], {
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout.split("\n").filter(Boolean);
	} catch {
		return walkFiles(targetDir, targetDir, 0, 30_000);
	}
}

async function walkFiles(
	rootDir: string,
	dir: string,
	depth: number,
	remaining: number,
): Promise<string[]> {
	if (remaining <= 0) return [];
	let out: string[] = [];
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.name !== ".github") continue;
		if (entry.isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue;
			if (depth > 8) continue;
			const children = await walkFiles(rootDir, join(dir, entry.name), depth + 1, remaining - out.length);
			out = out.concat(children);
		} else if (entry.isFile()) {
			const rel = join(dir, entry.name).slice(rootDir.length + 1).split("\\").join("/");
			out.push(rel);
		}
	}
	return out;
}

function detectLanguage(fileCounts: Record<string, number>, manifestPath: string | null): string {
	if (manifestPath) {
		for (const [candidate, lang] of MANIFEST_CANDIDATES) {
			if (manifestPath === candidate) return lang;
		}
	}
	const counts: Record<string, number> = { go: fileCounts[".go"] ?? 0, python: fileCounts[".py"] ?? 0, rust: fileCounts[".rs"] ?? 0, typescript: (fileCounts[".ts"] ?? 0) + (fileCounts[".tsx"] ?? 0) };
	const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	return best && best[1] > 0 ? best[0] : "unknown";
}

export async function collectRepoInfo(targetDir: string): Promise<RepoInfo> {
	const allFiles = await listRepoFiles(targetDir);

	const fileCounts: Record<string, number> = {};
	for (const f of allFiles) {
		const slash = f.lastIndexOf("/");
		const base = slash >= 0 ? f.slice(slash + 1) : f;
		const dot = base.lastIndexOf(".");
		const ext = dot > 0 ? base.slice(dot).toLowerCase() : "(no ext)";
		fileCounts[ext] = (fileCounts[ext] ?? 0) + 1;
	}
	const sortedCounts: Record<string, number> = {};
	for (const [ext, n] of Object.entries(fileCounts).sort((a, b) => b[1] - a[1])) {
		sortedCounts[ext] = n;
	}

	let manifest: { path: string; content: string } | null = null;
	for (const [candidate] of MANIFEST_CANDIDATES) {
		const p = join(targetDir, candidate);
		if (await pathExists(p)) {
			try {
				manifest = { path: candidate, content: await readFile(p, "utf8") };
			} catch {
				manifest = null;
			}
			break;
		}
	}

	let mainFile = "";
	for (const candidate of ["main.go", "main.py", "src/main.rs", "src/index.ts", "index.ts"]) {
		const p = join(targetDir, candidate);
		if (await pathExists(p)) {
			try {
				mainFile = await readFile(p, "utf8");
			} catch {
				mainFile = "";
			}
			break;
		}
	}

	let readmeFirst = "";
	const readmePath = join(targetDir, "README.md");
	if (await pathExists(readmePath)) {
		try {
			readmeFirst = (await readFile(readmePath, "utf8")).slice(0, 4000);
		} catch {
			readmeFirst = "";
		}
	}

	const fileTree = buildFileTree(allFiles);

	const language = detectLanguage(sortedCounts, manifest?.path ?? null);
	const sourceSpec = SOURCE_SPECS[language] ?? SOURCE_SPECS.go;
	const name = targetDir.split(/[\\/]/).filter(Boolean).pop() ?? "repo";

	return {
		name,
		path: targetDir,
		language,
		manifest,
		mainFile,
		readmeFirst,
		fileTree,
		fileCounts: sortedCounts,
		sourceGlob: sourceSpec.glob,
		sourceExts: sourceSpec.exts,
	};
}

function buildFileTree(allFiles: string[], maxDepth = 3, maxLines = 200): string {
	const lines: string[] = [];
	let count = 0;
	for (const f of allFiles) {
		if (f.split("/").length - 1 > maxDepth) continue;
		if (f.startsWith(".git/") || f.startsWith(".github/")) continue;
		if (f.endsWith(".sum") || f.endsWith(".lock")) continue;
		lines.push(f);
		count += 1;
		if (count >= maxLines) {
			lines.push(`... (${allFiles.length} total files, showing first ${maxLines})`);
			break;
		}
	}
	return lines.join("\n");
}

// ---------- glob matching & file slurping ----------

function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**/` matches zero or more directories; a trailing `**`
				// matches anything including slashes.
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
	for (const glob of globs) {
		if (globToRegExp(glob).test(path)) return true;
	}
	return false;
}

function isSlurpable(relPath: string): boolean {
	const segments = relPath.split("/");
	for (const seg of segments) {
		if (SKIP_DIR_NAMES.has(seg)) return false;
	}
	const slash = relPath.lastIndexOf("/");
	const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
	const dot = base.lastIndexOf(".");
	if (dot > 0 && SKIP_FILE_EXTENSIONS.has(base.slice(dot).toLowerCase())) return false;
	return true;
}

function sanitizeId(segment: string): string {
	return segment.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function topLevelModule(relPath: string): string {
	const slash = relPath.indexOf("/");
	return slash >= 0 ? relPath.slice(0, slash) : "root";
}

type CollectedFile = { relPath: string; moduleName: string };

function isTestFile(relPath: string): boolean {
	const base = relPath.slice(relPath.lastIndexOf("/") + 1);
	return /[._](test|spec)\.[a-z]+$/i.test(base) || base.includes("_test.");
}

function collectLensFiles(allFiles: string[], lens: LensDefinition, info: RepoInfo): CollectedFile[] {
	const globs = lens.globsFor(info);
	if (globs.length === 0) return [];
	const out: CollectedFile[] = [];
	for (const f of allFiles) {
		if (!isSlurpable(f)) continue;
		if (lens.skipTestFiles && isTestFile(f)) continue;
		if (!matchesAnyGlob(f, globs)) continue;
		out.push({ relPath: f, moduleName: lens.sliceBy === "directory" ? topLevelModule(f) : info.name });
	}
	return out;
}

async function slurpFileList(
	targetDir: string,
	files: CollectedFile[],
	maxChars: number,
): Promise<FileSlice[]> {
	const slices: FileSlice[] = [];
	let currentModule = "";
	let parts: string[] = [];
	let running = 0;
	let fileCount = 0;

	const flush = () => {
		if (parts.length === 0) return;
		slices.push({
			moduleName: currentModule,
			content: parts.join("\n"),
			fileCount,
			chars: running,
		});
		parts = [];
		running = 0;
		fileCount = 0;
	};

	for (const file of files) {
		let content = "";
		try {
			content = await readFile(join(targetDir, file.relPath), "utf8");
		} catch {
			content = "[BINARY or UNREADABLE]";
		}
		const block = `=== ${file.relPath} ===\n${content}\n`;

		if (file.moduleName !== currentModule && parts.length > 0) {
			flush();
		}
		currentModule = file.moduleName;

		if (running + block.length > maxChars && parts.length > 0) {
			// Slice is full: flush it and start another slice for the same module
			// rather than truncating, so big modules get full coverage.
			flush();
			currentModule = file.moduleName;
		}
		parts.push(block);
		running += block.length;
		fileCount += 1;
	}
	flush();
	return slices;
}

export async function gatherSlices(targetDir: string, lens: LensDefinition, info: RepoInfo): Promise<FileSlice[]> {
	if (lens.sliceBy === "none" && lens.globsFor(info).length === 0) {
		// Repo-info lens (architecture): the prompt is built from info alone.
		return [{ moduleName: "root", content: "", fileCount: 0, chars: 0 }];
	}
	const allFiles = await listRepoFiles(targetDir);
	const files = collectLensFiles(allFiles, lens, info);
	return slurpFileList(targetDir, files, lens.maxChars);
}

// ---------- request building ----------

export function buildBatchRequest(
	lens: LensDefinition,
	info: RepoInfo,
	slice: FileSlice,
	index: number,
	sliceCount: number,
	model: string = BROADSIDE_MODEL,
	maxTokensOverride?: number,
): BatchRequest {
	const moduleTag = sanitizeId(slice.moduleName);
	const customId = sliceCount > 1 ? `${lens.id}-${moduleTag}-${index + 1}` : `${lens.id}-${moduleTag}`;
	return {
		custom_id: customId,
		body: {
			model,
			messages: [
				{ role: "system", content: lens.systemPrompt(info) },
				{ role: "user", content: lens.userPrompt(info, slice.content, slice.moduleName) },
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS[lens.schemaName] },
			max_tokens: maxTokensOverride ?? lens.maxTokens,
		},
	};
}

export function estimateCost(
	lens: LensDefinition,
	slices: FileSlice[],
	pricing: ModelPricing,
	maxTokensOverride?: number,
): {
	inputTokens: number;
	outputTokens: number;
	cost: number;
} {
	const inputTokens = Math.ceil(slices.reduce((sum, s) => sum + (lens.maxChars === 0 ? 6000 : s.chars), 0) / 4);
	const outputTokens = Math.ceil((maxTokensOverride ?? lens.maxTokens) * 0.75);
	const cost =
		(inputTokens / 1_000_000) * pricing.inputPerM +
		(outputTokens / 1_000_000) * pricing.outputPerM;
	return { inputTokens, outputTokens, cost };
}

// ---------- state & config ----------

export function broadsideDirFor(cwd: string): string {
	return join(cwd, ".codecarto", BROADSIDE_DIR);
}

export function defaultBroadsideState(): BroadsideStateFile {
	return { schema_version: BROADSIDE_STATE_SCHEMA_VERSION, runs: [] };
}

export async function loadBroadsideState(broadsideDir: string): Promise<BroadsideStateFile> {
	const statePath = join(broadsideDir, BROADSIDE_STATE_FILE);
	if (!(await pathExists(statePath))) return defaultBroadsideState();
	try {
		const raw = JSON.parse(await readFile(statePath, "utf8"));
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.runs)) return defaultBroadsideState();
		return raw as BroadsideStateFile;
	} catch {
		return defaultBroadsideState();
	}
}

export async function saveBroadsideState(broadsideDir: string, state: BroadsideStateFile): Promise<void> {
	await mkdir(broadsideDir, { recursive: true });
	await writeFile(join(broadsideDir, BROADSIDE_STATE_FILE), `${JSON.stringify(state, null, "\t")}\n`, "utf8");
}

export async function loadBroadsideConfig(broadsideDir: string): Promise<BroadsideConfig> {
	const configPath = join(broadsideDir, BROADSIDE_CONFIG_FILE);
	let raw: Record<string, unknown> = {};
	if (await pathExists(configPath)) {
		try {
			raw = (await loadYamlFile<Record<string, unknown>>(configPath)) ?? {};
		} catch {
			raw = {};
		}
	}
	const lenses = Array.isArray(raw.default_lenses)
		? (raw.default_lenses.filter((l): l is BroadsideLensId => BROADSIDE_LENS_IDS.includes(l as BroadsideLensId)))
		: [];
	const rawPricing = (raw.pricing ?? {}) as Record<string, unknown>;
	const inputOverride = typeof rawPricing.input_per_m === "number" ? rawPricing.input_per_m : undefined;
	const outputOverride = typeof rawPricing.output_per_m === "number" ? rawPricing.output_per_m : undefined;
	return {
		model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : BROADSIDE_MODEL,
		apiKey: typeof raw.api_key === "string" ? raw.api_key.trim() : "",
		defaultLenses: lenses.length > 0 ? lenses : [...BROADSIDE_LENS_IDS],
		maxCost: typeof raw.max_cost === "number" && raw.max_cost > 0 ? raw.max_cost : 0,
		pricing:
			inputOverride !== undefined && outputOverride !== undefined
				? { inputPerM: inputOverride, outputPerM: outputOverride }
				: null,
	};
}

// ---------- model catalog, pricing, benchmarks ----------

type CatalogCacheFile = {
	schema_version: number;
	fetched_at: string;
	models: Record<string, CatalogEntry>;
};

async function readCatalogCache(broadsideDir: string): Promise<CatalogCacheFile | null> {
	const cachePath = join(broadsideDir, BROADSIDE_CATALOG_CACHE_FILE);
	if (!(await pathExists(cachePath))) return null;
	try {
		const parsed = JSON.parse(await readFile(cachePath, "utf8")) as CatalogCacheFile;
		if (!parsed || typeof parsed !== "object" || typeof parsed.models !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeCatalogCache(broadsideDir: string, cache: CatalogCacheFile): Promise<void> {
	await mkdir(broadsideDir, { recursive: true });
	await writeFile(join(broadsideDir, BROADSIDE_CATALOG_CACHE_FILE), `${JSON.stringify(cache, null, "\t")}\n`, "utf8");
}

function parseCatalogEntry(raw: Record<string, unknown>): CatalogEntry | null {
	const id = String(raw.id ?? "");
	if (!id) return null;
	const p = (raw.pricing ?? {}) as { prompt?: unknown; completion?: unknown; cached_input?: unknown };
	const input = typeof p.prompt === "string" ? Number(p.prompt) : NaN;
	const output = typeof p.completion === "string" ? Number(p.completion) : NaN;
	if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
	const cached = typeof p.cached_input === "string" ? Number(p.cached_input) : NaN;
	const topProvider = (raw.top_provider ?? {}) as Record<string, unknown>;
	const contextLength = typeof raw.context_length === "number" ? raw.context_length : undefined;
	const maxCompletion =
		typeof topProvider.max_completion_tokens === "number" ? topProvider.max_completion_tokens : undefined;
	return {
		id,
		name: String(raw.name ?? id),
		inputPerM: input * 1_000_000,
		outputPerM: output * 1_000_000,
		cachedInputPerM: Number.isFinite(cached) ? cached * 1_000_000 : undefined,
		contextLength,
		maxCompletionTokens: maxCompletion,
		supportedParameters: Array.isArray(raw.supported_parameters)
			? raw.supported_parameters.map((entry) => String(entry))
			: [],
		expirationDate: typeof raw.expiration_date === "string" ? raw.expiration_date : null,
	};
}

export function builtInCatalogEntry(model: string): CatalogEntry | null {
	// The default model's rates are compile-time constants; its capabilities
	// are asserted from the shipped configuration (1M context, 64K output,
	// structured outputs used by every lens).
	if (model !== BROADSIDE_MODEL) return null;
	return {
		id: BROADSIDE_MODEL,
		name: "Google: Gemini 3.7 Flash (batch)",
		inputPerM: BROADSIDE_INPUT_PRICE_PER_M,
		outputPerM: BROADSIDE_OUTPUT_PRICE_PER_M,
		contextLength: 1_048_576,
		maxCompletionTokens: 65_536,
		supportedParameters: ["tools", "structured_outputs", "json_schema", "response_format"],
		expirationDate: null,
	};
}

export function builtInPricing(model: string): ModelPricing | null {
	const entry = builtInCatalogEntry(model);
	if (!entry) return null;
	return { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM, source: "built-in" };
}

export async function resolveCatalogEntry(
	broadsideDir: string,
	config: BroadsideConfig,
	model: string,
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<BroadsideCatalogResult> {
	// Manual overrides always win for pricing — the user is asserting a rate,
	// and a config assertion is cheaper to respect than to second-guess.
	// Capabilities stay unknown in that case: nothing is refused, nothing
	// is clamped, and the submit text says the pricing came from config.
	if (config.pricing) {
		return {
			model,
			source: "config",
			entry: {
				id: model,
				name: model,
				inputPerM: config.pricing.inputPerM,
				outputPerM: config.pricing.outputPerM,
				supportedParameters: [],
			},
		};
	}

	const builtIn = builtInCatalogEntry(model);
	if (builtIn) return { model, source: "built-in", entry: builtIn };

	// Unknown model: on-disk cache first, then the live catalog.
	const cache = await readCatalogCache(broadsideDir);
	const cached = cache?.models[model];
	if (cached && Date.now() - new Date(cache!.fetched_at).getTime() < BROADSIDE_CATALOG_CACHE_TTL_MS) {
		return { model, source: "cache", entry: cached };
	}

	let live: CatalogEntry | null = null;
	try {
		const resp = await fetcher(BROADSIDE_MODELS_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(30_000),
		});
		const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
		const hit = (data.data ?? []).find((m) => String(m.id) === model);
		if (hit) live = parseCatalogEntry(hit);
	} catch {
		live = null;
	}

	if (live) {
		const updated: CatalogCacheFile = {
			schema_version: 2,
			fetched_at: new Date().toISOString(),
			models: { ...(cache?.models ?? {}) },
		};
		updated.models[model] = live;
		await writeCatalogCache(broadsideDir, updated);
		return { model, source: "live", entry: live };
	}

	throw new Error(
		`Could not resolve per-token pricing for batch model "${model}". ` +
		"Set pricing.input_per_m and pricing.output_per_m in .codecarto/broadside/config.yaml " +
		"(USD per million tokens), or check the model id against https://openrouter.ai/models?variant=batch.",
	);
}

export async function resolveModelPricing(
	broadsideDir: string,
	config: BroadsideConfig,
	model: string,
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<ModelPricing> {
	const { source, entry } = await resolveCatalogEntry(broadsideDir, config, model, apiKey, fetcher);
	if (!entry) throw new Error(`No pricing resolved for ${model}.`);
	return { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM, source };
}

/** Base slug with the OpenRouter variant suffix (e.g. `:batch`) stripped. */
function baseSlug(modelId: string): string {
	const idx = modelId.indexOf(":");
	return idx >= 0 ? modelId.slice(0, idx) : modelId;
}

export async function fetchCodingBenchmarks(
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<CodingBenchmarks | null> {
	try {
		const resp = await fetcher(`${BROADSIDE_BENCHMARKS_URL}?source=artificial-analysis&task_type=coding`, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(30_000),
		});
		const data = (await resp.json()) as { data?: Array<Record<string, unknown>>; meta?: Record<string, unknown> };
		const byBaseSlug: CodingBenchmarks["byBaseSlug"] = {};
		for (const row of data.data ?? []) {
			const slug = baseSlug(String(row.model_permaslug ?? ""));
			if (!slug) continue;
			const toIndex = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
			byBaseSlug[slug] = {
				codingIndex: toIndex(row.coding_index),
				intelligenceIndex: toIndex(row.intelligence_index),
			};
		}
		return { byBaseSlug, meta: data.meta ?? {} };
	} catch {
		return null;
	}
}

export async function listBatchModels(
	broadsideDir: string,
	config: BroadsideConfig,
	apiKey: string,
	opts: { includeBenchmarks?: boolean; fetcher?: FetchLike } = {},
): Promise<{ entries: CatalogEntry[]; source: string; benchmarks: CodingBenchmarks | null; defaultModel: string }> {
	const fetcher = opts.fetcher ?? (fetch as FetchLike);
	const resp = await fetcher(BROADSIDE_MODELS_URL, {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(30_000),
	});
	const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
	const entries: CatalogEntry[] = [];
	const seen = new Set<string>();
	for (const raw of data.data ?? []) {
		const entry = parseCatalogEntry(raw);
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (!entry.id.endsWith(":batch")) continue;
		entries.push(entry);
	}
	entries.sort((a, b) => a.inputPerM + a.outputPerM - (b.inputPerM + b.outputPerM));

	// Persist the catalog so the next submit's pricing resolution hits cache.
	const cache: CatalogCacheFile = { schema_version: 2, fetched_at: new Date().toISOString(), models: {} };
	for (const entry of entries) cache.models[entry.id] = entry;
	await writeCatalogCache(broadsideDir, cache);

	const benchmarks = opts.includeBenchmarks ? await fetchCodingBenchmarks(apiKey, fetcher) : null;
	return { entries, source: "live", benchmarks, defaultModel: config.model };
}

// ---------- batch client ----------

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>;

export async function submitBatch(
	batchRequests: BatchRequest[],
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
	model: string = BROADSIDE_MODEL,
): Promise<{ batchId: string; status: string; error?: unknown }> {
	// The OpenRouter batch endpoint stream-parses the body and requires
	// `endpoint` and `model` to serialize before `requests` — key order matters.
	const payload = {
		endpoint: "/v1/chat/completions",
		model,
		requests: batchRequests,
	};
	const resp = await fetcher(BROADSIDE_BATCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(30_000),
	});
	const data = (await resp.json()) as Record<string, unknown>;
	if (resp.status !== 202) {
		return { batchId: "", status: "rejected", error: data };
	}
	return { batchId: String(data.id), status: String(data.status) };
}

export async function fetchBatch(
	batchId: string,
	apiKey: string,
	fetcher: FetchLike = fetch as FetchLike,
): Promise<Record<string, unknown>> {
	const resp = await fetcher(`${BROADSIDE_BATCH_URL}/${batchId}`, {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(30_000),
	});
	const data = (await resp.json()) as Record<string, unknown>;
	// Surface the HTTP status so the poller can bail fast on auth expiry
	// instead of retrying a dead key for the whole budget.
	data.http_status = resp.status;
	return data;
}

export async function pollBatchUntilTerminal(
	batchId: string,
	apiKey: string,
	opts: {
		deadlineMs?: number;
		onStatus?: (status: string, counts: Record<string, unknown>) => void;
		fetcher?: FetchLike;
		pollIntervalMs?: number;
	} = {},
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + (opts.deadlineMs ?? BROADSIDE_DEFAULT_POLL_BUDGET_MS);
	const intervalMs = opts.pollIntervalMs ?? BROADSIDE_POLL_INTERVAL_MS;
	const fetcher = opts.fetcher ?? (fetch as FetchLike);
	for (;;) {
		let batch: Record<string, unknown>;
		try {
			batch = await fetchBatch(batchId, apiKey, fetcher);
		} catch {
			if (Date.now() >= deadline) return { id: batchId, status: "timeout" };
			await sleep(intervalMs);
			continue;
		}
		const httpStatus = Number(batch.http_status ?? 200);
		if (httpStatus === 401 || httpStatus === 403) {
			return { id: batchId, status: "auth-failed", error: batch.error ?? batch };
		}
		const status = String(batch.status ?? "unknown");
		const counts = (batch.request_counts ?? {}) as Record<string, unknown>;
		opts.onStatus?.(status, counts);
		if (["completed", "failed", "expired", "cancelled", "auth-failed"].includes(status)) return batch;
		if (Date.now() >= deadline) return { id: batchId, status: "timeout" };
		await sleep(intervalMs);
	}
}

/**
 * Poll several batch ids in parallel against one shared deadline. Collect
 * previously polled one lens at a time, so a slow first lens serialized the
 * wall clock for lenses that had already finished server-side (#136). The
 * onStatus callback identifies the lens so progress output stays readable
 * even while the polls interleave.
 */
export async function pollBatchesConcurrently(
	entries: Array<{ lensId: BroadsideLensId; batchId: string }>,
	apiKey: string,
	opts: {
		deadlineMs?: number;
		fetcher?: FetchLike;
		pollIntervalMs?: number;
		onStatus?: (lensId: string, status: string, counts: Record<string, unknown>) => void;
	} = {},
): Promise<Map<string, Record<string, unknown>>> {
	const results = new Map<string, Record<string, unknown>>();
	const deadlineMs = opts.deadlineMs ?? BROADSIDE_DEFAULT_POLL_BUDGET_MS;
	await Promise.all(
		entries.map(async ({ lensId, batchId }) => {
			const batch = await pollBatchUntilTerminal(batchId, apiKey, {
				deadlineMs,
				fetcher: opts.fetcher,
				pollIntervalMs: opts.pollIntervalMs,
				onStatus: (status, counts) => opts.onStatus?.(lensId, status, counts),
			});
			results.set(batchId, batch);
		}),
	);
	return results;
}

// ---------- run orchestration ----------

export async function runBroadsideSubmit(
	cwd: string,
	apiKey: string,
	opts: {
		lenses?: BroadsideLensId[];
		fetcher?: FetchLike;
		model?: string;
		/** Approximate run expense limit in USD; 0 means no limit. */
		maxCost?: number;
		/** Submit even when the estimate exceeds maxCost. */
		force?: boolean;
	} = {},
): Promise<BroadsideSubmitResult> {
	const info = await collectRepoInfo(cwd);
	const lensIds = opts.lenses ?? BROADSIDE_LENS_IDS;
	const broadsideDir = broadsideDirFor(cwd);
	const model = opts.model ?? BROADSIDE_MODEL;

	// Resolve the model's catalog entry before anything is submitted: the
	// guardrail must know real per-token rates, and every lens requires
	// structured-output support that not all batch models offer.
	const config = await loadBroadsideConfig(broadsideDir);
	const catalog = await resolveCatalogEntry(broadsideDir, config, model, apiKey, opts.fetcher);
	const pricing: ModelPricing = {
		inputPerM: catalog.entry!.inputPerM,
		outputPerM: catalog.entry!.outputPerM,
		source: catalog.source,
	};
	const limit = opts.maxCost ?? config.maxCost;

	const entry = catalog.entry!;
	const supportsStructuredOutputs =
		entry.supportedParameters.length === 0 ||
		entry.supportedParameters.some((p) =>
			["structured_outputs", "json_schema", "response_format", "structuredoutputs"].includes(p.toLowerCase()),
		);
	if (!supportsStructuredOutputs) {
		throw new Error(
			`Batch model "${model}" does not advertise structured-output support ` +
			`(supported_parameters: ${entry.supportedParameters.join(", ") || "unknown"}), but every ` +
			"Broad-Side lens requires json_schema response_format. Choose another batch model " +
			"(codecarto_broadside action 'models') or pass a pricing override only if you know it works.",
		);
	}
	// Respect the provider's completion ceiling: a request asking for more
	// output than the model can produce fails the whole batch.
	const outputCap = entry.maxCompletionTokens;

	// Slice offline first so the estimate covers every request we would send.
	const slicesByLens = new Map<BroadsideLensId, FileSlice[]>();
	let estimatedInputTokens = 0;
	let estimatedOutputTokens = 0;
	let estimatedTotalCost = 0;
	const perLensEstimate: Array<{ lens: LensDefinition; cost: number; maxTokens: number }> = [];
	for (const lensId of lensIds) {
		const lens = getLens(lensId);
		const slices = await gatherSlices(cwd, lens, info);
		slicesByLens.set(lensId, slices);
		const maxTokens = outputCap ? Math.min(lens.maxTokens, outputCap) : lens.maxTokens;
		const estimate = estimateCost(lens, slices, pricing, maxTokens);
		estimatedInputTokens += estimate.inputTokens;
		estimatedOutputTokens += estimate.outputTokens;
		estimatedTotalCost += estimate.cost;
		perLensEstimate.push({ lens, cost: estimate.cost, maxTokens });
	}

	if (limit > 0 && !opts.force && estimatedTotalCost > limit) {
		const breakdown = perLensEstimate
			.map(({ lens, cost }) => `  ${lens.name}: ~$${cost.toFixed(4)}`)
			.join("\n");
		throw new Error(
			`Estimated Broad-Side cost ~$${estimatedTotalCost.toFixed(4)} exceeds the run limit ` +
				`$${limit.toFixed(2)}. Nothing was submitted.\nBreakdown:\n${breakdown}\n` +
				`Pass force: true to submit anyway, or raise max_cost in .codecarto/broadside/config.yaml.`,
		);
	}

	const state = await loadBroadsideState(broadsideDir);
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	const run: BroadsideRun = {
		id: runId,
		createdAt: new Date().toISOString(),
		model,
		lenses: [...lensIds],
		status: "in-flight",
		outputDir: runId,
		batches: {},
		synthesis: { status: "pending" },
		triage: { status: "pending" },
		pricing,
		maxCost: limit > 0 ? limit : undefined,
	};
	state.runs.push(run);
	await saveBroadsideState(broadsideDir, state);

	const submissions: Promise<void>[] = [];
	for (const lensId of lensIds) {
		const lens = getLens(lensId);
		const slices = slicesByLens.get(lensId) ?? [];
		const maxTokens = outputCap ? Math.min(lens.maxTokens, outputCap) : lens.maxTokens;
		const requests = slices.map((s, i) => buildBatchRequest(lens, info, s, i, slices.length, model, maxTokens));
		const estimate = estimateCost(lens, slices, pricing, maxTokens);

		const entry: BroadsideBatchEntry = {
			batchId: "",
			requests: requests.length,
			status: "submitting",
			submittedAt: new Date().toISOString(),
			estimatedCost: estimate.cost,
		};
		run.batches[lensId] = entry;

		if (requests.length === 0) {
			// No files matched the lens's globs. That is a coverage gap to
			// report, not a batch to submit — the API rejects empty batches.
			entry.status = "skipped";
			continue;
		}

		submissions.push(
			(async () => {
				// A network-level throw (DNS, abort, TLS) must not strand the
				// entry in "submitting" forever — allSettled would swallow the
				// rejection and collect would never see a terminal status.
				try {
					const { batchId, status, error } = await submitBatch(requests, apiKey, opts.fetcher, model);
					entry.batchId = batchId;
					entry.status = status;
					if (error) entry.error = error;
				} catch (error) {
					entry.status = "rejected";
					entry.error = error instanceof Error ? error.message : String(error);
				}
			})(),
		);
	}
	await Promise.allSettled(submissions);
	await saveBroadsideState(broadsideDir, state);

	return {
		runId,
		outputDir: join(".codecarto", BROADSIDE_DIR, runId),
		batches: run.batches,
		estimatedTotalCost,
		estimatedInputTokens,
		estimatedOutputTokens,
		pricing,
		maxCost: limit > 0 ? limit : undefined,
		modelInfo: {
			contextLength: entry.contextLength,
			maxCompletionTokens: entry.maxCompletionTokens,
			supportsStructuredOutputs: entry.supportedParameters.length === 0 ? undefined : supportsStructuredOutputs,
			expirationDate: entry.expirationDate ?? null,
		},
	};
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

function extractContent(result: Record<string, unknown>): string | null {
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

// ---------- post-lens passes: synthesis + triage ----------

function buildSynthesisRequest(findingsText: string, truncatedNote: string, model: string): BatchRequest {
	return {
		custom_id: "synthesis",
		body: {
			model,
			messages: [
				{
					role: "system",
					content:
						"You are a technical editor synthesizing multiple analysis reports about a single " +
						"codebase into one coherent summary. The reports come from different lenses — " +
						"architecture, API surface, security review, defect scanning, convention extraction, " +
						"and porting assessment. Cross-reference findings across lenses: if a security issue " +
						"also appears as a defect, merge them. Produce a JSON object following the " +
						"synthesis_report schema. Prioritize the most actionable findings. " +
						"Be honest about gaps — if a lens found nothing, say 'no issues found' rather than " +
						"inventing problems. These are scouting signals from a batch model, not verified " +
						"claims; note that in the summary.",
				},
				{
					role: "user",
					content:
						"Synthesize these analysis reports into a single summary.\n\n" +
						findingsText +
						truncatedNote +
						"\nReturn the synthesis_report JSON schema.",
				},
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS.synthesis },
			max_tokens: 12_000,
		},
	};
}

function buildTriageRequest(findingsText: string, truncatedNote: string, model: string): BatchRequest {
	return {
		custom_id: "triage",
		body: {
			model,
			messages: [
				{
					role: "system",
					content:
						"You are a senior engineering lead turning unverified scouting findings into a " +
						"prioritized work order. Given the findings below, produce a JSON object following " +
						"the triage_report schema. Score every lead by impact and fix difficulty, assign a " +
						"priority (P0 urgent/safety-critical to P3 nice-to-have), give a rough effort " +
						"estimate, group the queue by module where sensible, and justify each call in the " +
						"rationale. Merge duplicate leads instead of listing them twice. Drop leads that are " +
						"too vague to act on and record each drop in omitted with the reason. These findings " +
						"are UNVERIFIED scouting signals from a cheap batch model: the queue is a starting " +
						"point for re-verification, not a commitment — say so in the summary, and never " +
						"inflate a severity you cannot see evidence for.",
				},
				{
					role: "user",
					content:
						"Triage these scouting findings into a prioritized work order.\n\n" +
						findingsText +
						truncatedNote +
						"\nReturn the triage_report JSON schema.",
				},
			],
			response_format: { type: "json_schema", json_schema: SCHEMAS.triage },
			max_tokens: 10_000,
		},
	};
}

function parseTriageItems(content: string): TriageItem[] {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const items = Array.isArray(parsed.items) ? (parsed.items as Array<Record<string, unknown>>) : [];
		return items
			.filter((item) => typeof item.title === "string")
			.map((item) => ({
				title: String(item.title),
				severity: String(item.severity ?? "unknown"),
				module: String(item.module ?? "unknown"),
				impact: (["high", "medium", "low"].includes(String(item.impact)) ? String(item.impact) : "medium") as TriageItem["impact"],
				difficulty: (["high", "medium", "low"].includes(String(item.difficulty)) ? String(item.difficulty) : "medium") as TriageItem["difficulty"],
				priority: String(item.priority ?? "?"),
				effort_estimate: String(item.effort_estimate ?? ""),
				rationale: String(item.rationale ?? ""),
			}));
	} catch {
		return [];
	}
}

export async function runBroadsideCollect(
	cwd: string,
	apiKey: string,
	opts: {
		waitMs?: number;
		includeSynthesis?: boolean;
		includeTriage?: boolean;
		onStatus?: (lensId: string, status: string, counts: Record<string, unknown>) => void;
		fetcher?: FetchLike;
	} = {},
): Promise<BroadsideCollectResult> {
	const broadsideDir = broadsideDirFor(cwd);
	const state = await loadBroadsideState(broadsideDir);
	const run = state.runs[state.runs.length - 1];
	if (!run) {
		throw new Error("No Broad-Side run recorded. Call codecarto_broadside with action 'submit' first.");
	}

	const runDir = join(broadsideDir, run.outputDir);
	await mkdir(runDir, { recursive: true });

	const deadline = Date.now() + (opts.waitMs ?? BROADSIDE_DEFAULT_POLL_BUDGET_MS);
	let totalCost = 0;
	let resultCount = 0;
	let truncatedCount = 0;
	const lensOutcomes: BroadsideCollectResult["lensOutcomes"] = {};

	const allLensResults: StoredLensResult[] = [];

	// Terminal entries are settled already; everything else polls in parallel
	// against one shared deadline (#136), then results save in lens order so
	// output layout stays deterministic.
	const inFlight: Array<{ lensId: BroadsideLensId; batchId: string }> = [];
	for (const lensId of run.lenses) {
		const entry = run.batches[lensId];
		if (!entry || !entry.batchId) {
			lensOutcomes[lensId] = { status: entry?.status ?? "failed", resultCount: 0 };
			continue;
		}
		if (["completed", "failed", "expired", "cancelled", "auth-failed", "skipped", "rejected"].includes(entry.status)) {
			totalCost += entry.cost ?? 0;
			resultCount += entry.resultCount ?? 0;
			lensOutcomes[lensId] = { status: entry.status, cost: entry.cost, resultCount: entry.resultCount };
			continue;
		}
		inFlight.push({ lensId, batchId: entry.batchId });
	}

	const polled = await pollBatchesConcurrently(inFlight, apiKey, {
		deadlineMs: Math.max(0, deadline - Date.now()),
		fetcher: opts.fetcher,
		onStatus: opts.onStatus,
	});

	for (const { lensId } of inFlight) {
		const entry = run.batches[lensId];
		if (!entry) continue;
		const batch = polled.get(entry.batchId) ?? { id: entry.batchId, status: "timeout" };

		const status = String(batch.status ?? "unknown");
		entry.status = status;
		if (status === "completed") {
			const usage = (batch.usage ?? {}) as Record<string, unknown>;
			const cost = typeof usage.cost === "number" ? usage.cost : undefined;
			entry.cost = cost;
			entry.completedAt = new Date().toISOString();
			const stored = await saveLensResults(runDir, lensId, batch);
			entry.resultCount = stored.length;
			const truncated = stored.filter((s) => s.truncated).length;
			allLensResults.push(...stored);
			resultCount += stored.length;
			truncatedCount += truncated;
			totalCost += cost ?? 0;
			await writeFile(
				join(runDir, `raw-${lensId}.json`),
				`${JSON.stringify(batch, null, "\t")}\n`,
				"utf8",
			);
			lensOutcomes[lensId] = { status, cost: entry.cost, resultCount: entry.resultCount, truncated };
		} else if (batch.error) {
			entry.error = batch.error;
			lensOutcomes[lensId] = { status, cost: entry.cost, resultCount: entry.resultCount };
		}
		await saveBroadsideState(broadsideDir, state);
	}

	// Synthesis + triage: cross-lens post-passes, only after every lens batch
	// is terminal. Triage turns the leads into a prioritized work order.
	run.triage ??= { status: "pending" };
	let topFindings: BroadsideCollectResult["topFindings"] = [];
	let topTriageItems: BroadsideCollectResult["topTriageItems"] = [];
	const wantSynthesis = opts.includeSynthesis !== false;
	const wantTriage = opts.includeTriage !== false;
	if ((wantSynthesis || wantTriage) && allLensResults.length > 0) {
		const allTerminal = run.lenses.every((lensId) => {
			const entry = run.batches[lensId];
			return entry && ["completed", "failed", "expired", "cancelled", "auth-failed", "skipped", "rejected"].includes(entry.status);
		});
		if (allTerminal && (run.synthesis.status === "pending" || run.triage.status === "pending")) {
			const findingsText = allLensResults
				.map((r) => `## ${r.lensId} — ${r.customId}\n\n${r.content}\n`)
				.join("\n");
			const truncatedNote =
				truncatedCount > 0
					? `\n\nNOTE: ${truncatedCount} lens result(s) were truncated at the output token limit and are ` +
						"not included above. Any gap they would have covered is unrepresented — do not treat " +
						"silence on a module as a clean bill.\n"
					: "";

			// Both post-passes consume the same findings; they run as two
			// batches (different response_format schemas cannot share one)
			// submitted together and polled in turn.
			const passes: Array<{
				kind: "synthesis" | "triage";
				request: BatchRequest;
				entry: BroadsideSynthesisEntry;
			}> = [
				...(wantSynthesis && run.synthesis.status === "pending"
					? [{
							kind: "synthesis" as const,
							request: buildSynthesisRequest(findingsText, truncatedNote, run.model),
							entry: run.synthesis,
						}]
					: []),
				...(wantTriage && run.triage.status === "pending"
					? [{
							kind: "triage" as const,
							request: buildTriageRequest(findingsText, truncatedNote, run.model),
							entry: run.triage,
						}]
					: []),
			];

			const submitted = new Map<string, { batchId: string; pass: (typeof passes)[number] }>();
			await Promise.allSettled(
				passes.map(async (pass) => {
					pass.entry.status = "submitted";
					try {
						const { batchId, error } = await submitBatch([pass.request], apiKey, opts.fetcher, run.model);
						if (error) {
							pass.entry.status = "failed";
							return;
						}
						pass.entry.batchId = batchId;
						submitted.set(batchId, { batchId, pass });
					} catch {
						pass.entry.status = "failed";
					}
				}),
			);
			await saveBroadsideState(broadsideDir, state);

			for (const { batchId, pass } of submitted.values()) {
				const batch = await pollBatchUntilTerminal(batchId, apiKey, {
					deadlineMs: BROADSIDE_DEFAULT_POLL_BUDGET_MS,
					onStatus: (status, counts) => opts.onStatus?.(pass.kind, status, counts),
					fetcher: opts.fetcher,
				});
				if (batch.status === "completed") {
					const usage = (batch.usage ?? {}) as Record<string, unknown>;
					const cost = typeof usage.cost === "number" ? usage.cost : undefined;
					pass.entry.status = "completed";
					pass.entry.cost = cost;
					totalCost += cost ?? 0;
					const results = Array.isArray(batch.results) ? (batch.results as Array<Record<string, unknown>>) : [];
					const content = results.length > 0 ? extractContent(results[0]) : null;
					if (content !== null) {
						await writeFile(join(runDir, `${pass.kind}.json`), `${content}\n`, "utf8");
						await writeFile(join(runDir, `${pass.kind}.md`), renderFindingsMarkdown(content), "utf8");
						if (pass.kind === "synthesis") {
							topFindings = parseSynthesisTopFindings(content);
						} else {
							topTriageItems = parseTriageItems(content);
						}
					}
				} else if (batch.error) {
					pass.entry.status = "failed";
				}
				await saveBroadsideState(broadsideDir, state);
			}
		}
	}

	const terminal = run.lenses.every((lensId) => {
		const entry = run.batches[lensId];
		return entry && ["completed", "failed", "expired", "cancelled", "auth-failed", "skipped", "rejected"].includes(entry.status);
	});
	run.status = terminal ? (resultCount > 0 ? "completed" : "failed") : "partial";
	run.totalCost = totalCost;
	await saveBroadsideState(broadsideDir, state);

	await writeFile(
		join(runDir, "run-meta.json"),
		`${JSON.stringify(
			{
				experimental: true,
				method: "Broad-Side (OpenRouter Batch API)",
				model: run.model,
				pricing: run.pricing,
				max_cost: run.maxCost,
				run_id: run.id,
				created_at: run.createdAt,
				status: run.status,
				total_cost: totalCost,
				result_count: resultCount,
				truncated_count: truncatedCount,
				synthesis: run.synthesis,
				triage: run.triage,
				lenses: run.lenses,
				disclaimer:
					"Findings are unverified scouting signals from a batch model, not validated claims. " +
					"Re-verify every file:line lead with the interactive pipeline or by hand.",
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);

	return {
		runId: run.id,
		status: run.status,
		totalCost,
		resultCount,
		truncatedCount,
		lensOutcomes,
		synthesis: run.synthesis,
		triage: run.triage,
		topFindings,
		topTriageItems,
	};
}

export async function runBroadsideStatus(cwd: string): Promise<{ state: BroadsideStateFile }> {
	const broadsideDir = broadsideDirFor(cwd);
	const state = await loadBroadsideState(broadsideDir);
	return { state };
}

// ---------- rendering ----------

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

function parseSynthesisTopFindings(
	content: string,
): BroadsideCollectResult["topFindings"] {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const findings = Array.isArray(parsed.top_findings)
			? (parsed.top_findings as Array<Record<string, unknown>>)
			: [];
		return findings
			.filter((f) => typeof f.title === "string")
			.map((f) => ({
				title: String(f.title),
				severity: String(f.severity ?? "unknown"),
				sourceLens: String(f.source_lens ?? "unknown"),
				summary: String(f.summary ?? ""),
			}));
	} catch {
		return [];
	}
}

// ---------- formatting helpers for tool output ----------

export function estimateSubmitText(result: BroadsideSubmitResult, lenses: LensDefinition[]): string {
	const lines = [
		`Broad-Side submitted ${result.batches ? Object.keys(result.batches).length : 0} batch(es).`,
	];
	for (const lens of lenses) {
		const entry = result.batches[lens.id];
		if (!entry) continue;
		const status = entry.batchId ? `batch ${entry.batchId}` : entry.status;
		lines.push(`  ${lens.name}: ${status} (${entry.requests} request(s), ~$${entry.estimatedCost.toFixed(4)})`);
	}
	lines.push(
		`Estimated total: ~$${result.estimatedTotalCost.toFixed(4)}`,
		`Pricing: $${result.pricing.inputPerM.toFixed(4)}/M in, $${result.pricing.outputPerM.toFixed(4)}/M out (${result.pricing.source})`,
	);
	if (result.modelInfo.contextLength) {
		lines.push(`Model: ${result.modelInfo.contextLength.toLocaleString()} context, ${result.modelInfo.maxCompletionTokens?.toLocaleString() ?? "?"} max output`);
	}
	if (result.modelInfo.supportsStructuredOutputs === false) {
		lines.push("Warning: model does not advertise structured-output support; lens JSON may be unreliable.");
	}
	if (result.modelInfo.expirationDate) {
		lines.push(`Warning: this model is deprecated (expires ${result.modelInfo.expirationDate}).`);
	}
	if (result.maxCost) {
		lines.push(`Run limit: $${result.maxCost.toFixed(2)} (enforced on estimate; pass force to override)`);
	}
	lines.push(
		`Results will land in ${result.outputDir}/`,
		"Call codecarto_broadside with action 'collect' once batches finish, or pass wait_seconds on submit to block.",
		"Disclaimer: Broad-Side findings are unverified scouting signals from a batch model, not validated claims.",
	);
	return lines.join("\n");
}

export function modelsText(
	entries: CatalogEntry[],
	opts: { benchmarks: CodingBenchmarks | null; defaultModel: string },
): string {
	const lines = [
		`Batch models on OpenRouter (${entries.length}, cheapest first).`,
		"",
		"id | $/M in | $/M out | ctx | max out | structured | coding idx",
	];
	for (const entry of entries) {
		const bench = opts.benchmarks?.byBaseSlug[baseSlug(entry.id)];
		const structured = entry.supportedParameters.length === 0
			? "?"
			: entry.supportedParameters.some((p) => ["structured_outputs", "json_schema", "response_format", "structuredoutputs"].includes(p.toLowerCase()))
				? "yes"
				: "no";
		const coding = bench?.codingIndex !== undefined ? bench.codingIndex.toFixed(1) : "-";
		const ctx = entry.contextLength
			? entry.contextLength >= 1_000_000
				? `${(entry.contextLength / 1_000_000).toFixed(1)}M`
				: `${(entry.contextLength / 1024).toFixed(0)}k`
			: "?";
		const out = entry.maxCompletionTokens ? `${(entry.maxCompletionTokens / 1024).toFixed(0)}k` : "?";
		const tag = entry.id === opts.defaultModel ? "  (default)" : "";
		const exp = entry.expirationDate ? "  [deprecated]" : "";
		lines.push(
			`${entry.id}${tag}${exp} | ${entry.inputPerM.toFixed(3)} | ${entry.outputPerM.toFixed(3)} | ${ctx} | ${out} | ${structured} | ${coding}`,
		);
	}
	if (opts.benchmarks?.meta.as_of) {
		lines.push("", `Benchmarks: Artificial Analysis coding index (as of ${String(opts.benchmarks.meta.as_of)}).`);
	}
	lines.push("", "Set the batch model in .codecarto/broadside/config.yaml (model key). Higher coding index ≠ better scout: precision, context, and structured-output support matter most here.");
	return lines.join("\n");
}

export function collectResultText(result: BroadsideCollectResult): string {
	const lines = [
		`Broad-Side run ${result.runId}: ${result.status}`,
		`  Results: ${result.resultCount} | Total cost: $${result.totalCost.toFixed(6)}`,
	];
	for (const lensId of BROADSIDE_LENS_IDS) {
		const outcome = result.lensOutcomes[lensId];
		if (!outcome) continue;
		const truncation = outcome.truncated ? `, ${outcome.truncated} truncated` : "";
		lines.push(
			`  ${lensId}: ${outcome.status}` +
				(outcome.cost !== undefined ? `, $${outcome.cost.toFixed(6)}` : "") +
				(outcome.resultCount !== undefined ? `, ${outcome.resultCount} result(s)` : "") +
				truncation,
		);
	}
	if (result.truncatedCount > 0) {
		lines.push(
			`  ⚠ ${result.truncatedCount} result(s) truncated at the output limit — their modules are unscouted, not clean.`,
		);
	}
	if (result.synthesis.status === "completed") {
		lines.push(`  synthesis: completed, $${(result.synthesis.cost ?? 0).toFixed(6)}`);
		if (result.topFindings.length > 0) {
			lines.push("", "Top findings (unverified leads):");
			for (const f of result.topFindings.slice(0, 10)) {
				lines.push(`  [${f.severity}] ${f.title}`);
			}
		}
	}
	if (result.triage.status === "completed") {
		lines.push(`  triage: completed, $${(result.triage.cost ?? 0).toFixed(6)}`);
		if (result.topTriageItems.length > 0) {
			lines.push("", "Triage — prioritized work order (re-verify before acting):");
			for (const item of result.topTriageItems.slice(0, 10)) {
				lines.push(
					`  ${item.priority} [${item.severity}/${item.module}] ${item.title}` +
					(item.effort_estimate ? ` (${item.effort_estimate})` : ""),
				);
			}
		}
	} else if (result.triage.status === "failed") {
		lines.push("  triage: failed");
	}
	lines.push("", "Disclaimer: Broad-Side findings are unverified scouting signals from a batch model, not validated claims.");
	return lines.join("\n");
}

export function statusText(state: BroadsideStateFile): string {
	if (state.runs.length === 0) {
		return "No Broad-Side runs recorded. Call codecarto_broadside with action 'submit' first.";
	}
	const lines: string[] = [];
	for (const run of [...state.runs].reverse().slice(0, 3)) {
		lines.push(`Run ${run.id} — ${run.status}`);
		for (const lensId of BROADSIDE_LENS_IDS) {
			const entry = run.batches[lensId];
			if (!entry) continue;
			lines.push(`  ${lensId}: ${entry.status}${entry.batchId ? ` (${entry.batchId})` : ""}${entry.cost !== undefined ? `, $${entry.cost.toFixed(6)}` : ""}`);
		}
		lines.push(`  synthesis: ${run.synthesis.status}`);
		lines.push(`  triage: ${run.triage?.status ?? "pending"}`);
		if (run.totalCost !== undefined) lines.push(`  total cost: $${run.totalCost.toFixed(6)}`);
	}
	return lines.join("\n");
}
