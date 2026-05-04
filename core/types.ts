// Shared schema types for the CodeCartographer framework.
// Both the Pi extension and the MCP server import from here so the schema
// has a single source of truth.

export type PhaseStatusValue = "pending" | "complete" | "partial" | "in-progress";

export const OPEN_QUESTION_KINDS = [
	"needs-runtime-test",
	"needs-maintainer-decision",
	"needs-spec-ruling",
	"defer-to-phase",
	"needs-fixture-capture",
] as const;

export type EntryKind = (typeof OPEN_QUESTION_KINDS)[number] | string;

export type OpenQuestionEntry = {
	id?: string;
	kind?: EntryKind;
	description?: string;
	deferred_reason?: string;
};

export type CarryForwardEntry = OpenQuestionEntry & {
	target_phase?: string;
};

export type StatusPhase = {
	status: PhaseStatusValue | string;
	owner_notes: string[];
	outputs_present: string[];
	open_questions: OpenQuestionEntry[];
	carry_forward: CarryForwardEntry[];
};

export type StatusFile = {
	project_name?: string;
	pipeline?: string;
	current_phase?: string;
	last_updated?: string;
	phases?: Record<string, StatusPhase>;
	next_actions?: string[];
};

export type SecondaryOutput = {
	path: string;
	mode?: string;
};

export type PipelinePhase = {
	id: string;
	purpose?: string;
	skill_path?: string;
	output_template?: string;
	depends_on?: string[];
	primary_output?: string;
	secondary_outputs?: SecondaryOutput[];
	required_reads?: string[];
	completion_criteria?: string[];
	handoff_requirements?: string[];
};

export type PipelineFile = {
	workflow_name?: string;
	workflow_version?: number;
	workflow_goal?: string;
	source_location?: string;
	validation_protocol?: string;
	phase_order: string[];
	phases: PipelinePhase[];
};

export type NormalizedStatus = Required<Pick<StatusFile, "project_name" | "pipeline" | "current_phase" | "last_updated" | "phases" | "next_actions">>;

export type WorkspaceState = {
	cwd: string;
	workspaceDir: string;
	statusPath: string;
	pipelinePath: string;
	status: NormalizedStatus;
	pipeline: PipelineFile;
};

export type ValidationOverall = "PASS" | "PASS WITH GAPS" | "FAIL" | "MISSING";

export type ValidationResult = {
	phaseId: string;
	primaryOutput: string;
	outputPath: string;
	exists: boolean;
	hasValidationBlock: boolean;
	overall: ValidationOverall;
	rows: Array<{ criterion: string; result: string; evidence: string }>;
	gaps: string[];
	errors: string[];
};
