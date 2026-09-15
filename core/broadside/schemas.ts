// The structured-output JSON schemas, one per lens plus synthesis and triage.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { type JsonSchemaDef } from "./types.ts";

// ---------- JSON schemas (one per lens, plus synthesis) ----------

export const SCHEMAS: Record<string, JsonSchemaDef> = {
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
