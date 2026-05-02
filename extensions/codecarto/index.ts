import { access, appendFile, cp, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_WIDGET_ID = "codecarto-widget";
const STATUS_LINE_ID = "codecarto-status";
const SAFE_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write"];
const LOCK_RETRY_MS = 125;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 60_000;

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, "../..");
const packagedWorkspaceDir = join(packageRoot, ".codecarto");

const PIPELINE_ALIASES: Record<string, string> = {
	"full-with-audit": "workflow/pipeline-full-with-audit.yaml",
	full: "workflow/pipeline.yaml",
	"defect-scan": "workflow/pipeline-defect-scan.yaml",
	lite: "workflow/pipeline-lite.yaml",
	"architecture-only": "workflow/pipeline-architecture-only.yaml",
};

type PhaseStatusValue = "pending" | "complete" | "partial" | "in-progress";

type StatusPhase = {
	status: PhaseStatusValue | string;
	owner_notes: string[];
	outputs_present: string[];
	open_questions: string[];
};

type StatusFile = {
	project_name?: string;
	pipeline?: string;
	current_phase?: string;
	last_updated?: string;
	phases?: Record<string, StatusPhase>;
	next_actions?: string[];
};

type PipelinePhase = {
	id: string;
	purpose?: string;
	skill_path?: string;
	output_template?: string;
	depends_on?: string[];
	primary_output?: string;
	completion_criteria?: string[];
};

type PipelineFile = {
	workflow_name?: string;
	phase_order: string[];
	phases: PipelinePhase[];
};

type WorkspaceState = {
	cwd: string;
	workspaceDir: string;
	statusPath: string;
	pipelinePath: string;
	status: Required<Pick<StatusFile, "project_name" | "pipeline" | "current_phase" | "last_updated" | "phases" | "next_actions">>;
	pipeline: PipelineFile;
};

type ValidationResult = {
	phaseId: string;
	primaryOutput: string;
	outputPath: string;
	exists: boolean;
	hasValidationBlock: boolean;
	overall: "PASS" | "PASS WITH GAPS" | "FAIL" | "MISSING";
	rows: Array<{ criterion: string; result: string; evidence: string }>;
	gaps: string[];
	errors: string[];
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function normalizeForComparison(path: string): string {
	const normalized = normalize(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinPath(path: string, root: string): boolean {
	const normalizedPath = normalizeForComparison(resolve(path));
	const normalizedRoot = normalizeForComparison(resolve(root));
	if (normalizedPath === normalizedRoot) return true;
	return normalizedPath.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`);
}

function ensureArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function ensurePhaseRecord(value: unknown): Record<string, StatusPhase> {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	const result: Record<string, StatusPhase> = {};
	for (const [phaseId, phaseValue] of Object.entries(record)) {
		const phase = (phaseValue ?? {}) as Partial<StatusPhase>;
		result[phaseId] = {
			status: typeof phase.status === "string" ? phase.status : "pending",
			owner_notes: ensureArray(phase.owner_notes),
			outputs_present: ensureArray(phase.outputs_present),
			open_questions: ensureArray(phase.open_questions),
		};
	}
	return result;
}

function getPhaseMap(pipeline: PipelineFile): Map<string, PipelinePhase> {
	return new Map(pipeline.phases.map((phase) => [phase.id, phase]));
}

function getPipelineLabel(pipelinePath: string): string {
	const fileName = basename(pipelinePath, ".yaml");
	if (fileName === "pipeline") return "full";
	return fileName.replace(/^pipeline-/, "");
}

function createEmptyStatus(projectName: string, pipelinePath: string, pipeline: PipelineFile): Required<Pick<StatusFile, "project_name" | "pipeline" | "current_phase" | "last_updated" | "phases" | "next_actions">> {
	const phases: Record<string, StatusPhase> = {};
	for (const phaseId of pipeline.phase_order) {
		phases[phaseId] = {
			status: "pending",
			owner_notes: [],
			outputs_present: [],
			open_questions: [],
		};
	}

	const firstPhase = pipeline.phase_order[0] ?? "complete";
	const firstPhaseConfig = getPhaseMap(pipeline).get(firstPhase);

	return {
		project_name: projectName,
		pipeline: pipelinePath,
		current_phase: firstPhase,
		last_updated: "",
		phases,
		next_actions: firstPhaseConfig?.primary_output
			? [`Begin ${firstPhase} phase by producing ${firstPhaseConfig.primary_output}`]
			: ["Begin the first pending phase."],
	};
}

function normalizeStatus(status: StatusFile, pipeline: PipelineFile, pipelinePath: string, cwd: string): Required<Pick<StatusFile, "project_name" | "pipeline" | "current_phase" | "last_updated" | "phases" | "next_actions">> {
	const phases = ensurePhaseRecord(status.phases);
	for (const phaseId of pipeline.phase_order) {
		if (!phases[phaseId]) {
			phases[phaseId] = {
				status: "pending",
				owner_notes: [],
				outputs_present: [],
				open_questions: [],
			};
		}
	}

	return {
		project_name: status.project_name?.trim() || basename(cwd),
		pipeline: status.pipeline?.trim() || pipelinePath,
		current_phase: status.current_phase?.trim() || pipeline.phase_order[0] || "complete",
		last_updated: status.last_updated?.trim() || "",
		phases,
		next_actions: ensureArray(status.next_actions),
	};
}

function stripYamlComment(value: string): string {
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

function parseYamlScalar(rawValue: string): unknown {
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

function parseSimpleYaml(raw: string): unknown {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatYamlScalar(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "[]" : JSON.stringify(value);
	if (isPlainObject(value)) return Object.keys(value).length === 0 ? "{}" : JSON.stringify(value);
	const stringValue = String(value);
	if (stringValue === "") return '""';
	if (/^[A-Za-z0-9_./-]+$/.test(stringValue)) return stringValue;
	return JSON.stringify(stringValue);
}

function stringifySimpleYaml(value: unknown, indent: number = 0): string {
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

async function loadYamlFile<T>(path: string): Promise<T> {
	const raw = await readFile(path, "utf8");
	return (parseSimpleYaml(raw) ?? {}) as T;
}

async function getWorkspaceState(cwd: string): Promise<WorkspaceState | null> {
	const workspaceDir = join(cwd, ".codecarto");
	const statusPath = join(workspaceDir, "workflow", "status.yaml");
	if (!(await pathExists(statusPath))) return null;

	const rawStatus = await loadYamlFile<StatusFile>(statusPath);
	const pipelineRelativePath = rawStatus.pipeline?.trim();
	if (!pipelineRelativePath) {
		throw new Error(`Missing pipeline in ${relative(cwd, statusPath) || statusPath}`);
	}

	const pipelinePath = join(workspaceDir, pipelineRelativePath);
	if (!(await pathExists(pipelinePath))) {
		throw new Error(`Active pipeline does not exist: ${relative(cwd, pipelinePath) || pipelinePath}`);
	}

	const pipeline = await loadYamlFile<PipelineFile>(pipelinePath);
	const status = normalizeStatus(rawStatus, pipeline, pipelineRelativePath, cwd);

	return {
		cwd,
		workspaceDir,
		statusPath,
		pipelinePath,
		pipeline,
		status,
	};
}

function getNextEligiblePhase(state: WorkspaceState): PipelinePhase | null {
	const phaseMap = getPhaseMap(state.pipeline);
	for (const phaseId of state.pipeline.phase_order) {
		const phaseStatus = state.status.phases[phaseId]?.status;
		if (phaseStatus === "complete") continue;
		const phase = phaseMap.get(phaseId);
		if (!phase) continue;
		const dependencies = phase.depends_on ?? [];
		const ready = dependencies.every((dependencyId) => state.status.phases[dependencyId]?.status === "complete");
		if (ready) return phase;
	}
	return null;
}

function resolvePhase(state: WorkspaceState, phaseId?: string): PipelinePhase | null {
	const trimmed = phaseId?.trim();
	if (trimmed) {
		return getPhaseMap(state.pipeline).get(trimmed) ?? null;
	}
	return getNextEligiblePhase(state);
}

function resolvePipelineChoice(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (PIPELINE_ALIASES[trimmed]) return PIPELINE_ALIASES[trimmed];
	return trimmed.endsWith(".yaml") ? trimmed : null;
}

async function acquireLock(lockPath: string): Promise<{ release: () => Promise<void> }> {
	const startedAt = Date.now();

	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
			await handle.close();
			return {
				release: async () => {
					await rm(lockPath, { force: true }).catch(() => undefined);
				},
			};
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== "EEXIST") throw error;

			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
					await rm(lockPath, { force: true }).catch(() => undefined);
					continue;
				}
			} catch {
				continue;
			}

			if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}

			await sleep(LOCK_RETRY_MS);
		}
	}
}

async function updateStatusAtomically(
	cwd: string,
	updater: (state: WorkspaceState) => Promise<{ state: WorkspaceState; threadLogEntry?: string }> | { state: WorkspaceState; threadLogEntry?: string },
): Promise<WorkspaceState> {
	const workspaceDir = join(cwd, ".codecarto");
	const statusPath = join(workspaceDir, "workflow", "status.yaml");
	const lockPath = `${statusPath}.lock`;
	const lock = await acquireLock(lockPath);

	try {
		const currentState = await getWorkspaceState(cwd);
		if (!currentState) {
			throw new Error("CodeCartographer workspace not found. Run /codecarto-init first.");
		}

		const result = await updater(currentState);
		const nextState = result.state;
		const serialized = `${stringifySimpleYaml(nextState.status)}\n`;
		const tempPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tempPath, serialized, "utf8");
		await rename(tempPath, statusPath);

		if (result.threadLogEntry) {
			const threadLogPath = join(workspaceDir, "THREAD_LOG.md");
			await appendFile(threadLogPath, result.threadLogEntry, "utf8");
		}

		return nextState;
	} finally {
		await lock.release();
	}
}

function buildStatusLines(state: WorkspaceState, extraLines: string[] = []): string[] {
	const nextPhase = getNextEligiblePhase(state);
	const currentPhase = nextPhase?.id ?? state.status.current_phase ?? "complete";
	const pipelineLabel = getPipelineLabel(state.status.pipeline);
	const completedCount = state.pipeline.phase_order.filter((phaseId) => state.status.phases[phaseId]?.status === "complete").length;
	const currentOpenQuestions = currentPhase === "complete" ? 0 : state.status.phases[currentPhase]?.open_questions.length ?? 0;
	const nextAction = state.status.next_actions[0] ?? (nextPhase ? `Next: ${nextPhase.id}` : "All phases complete.");

	const lines = [
		"CodeCartographer",
		`Phase: ${currentPhase}`,
		`Pipeline: ${pipelineLabel}`,
		`Progress: ${completedCount}/${state.pipeline.phase_order.length} complete`,
		`Open questions: ${currentOpenQuestions}`,
		`Next: ${nextAction}`,
	];

	if (extraLines.length > 0) {
		lines.push("", ...extraLines);
	}

	return lines;
}

function setUiState(ctx: ExtensionContext | ExtensionCommandContext, state: WorkspaceState | null, extraLines: string[] = []): void {
	if (!ctx.hasUI) return;
	if (!state) {
		ctx.ui.setStatus(STATUS_LINE_ID, undefined);
		ctx.ui.setWidget(STATUS_WIDGET_ID, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const currentPhase = getNextEligiblePhase(state)?.id ?? state.status.current_phase ?? "complete";
	ctx.ui.setStatus(STATUS_LINE_ID, `${theme.fg("accent", "CC")} ${theme.fg("dim", currentPhase)}`);
	ctx.ui.setWidget(STATUS_WIDGET_ID, buildStatusLines(state, extraLines));
}

function buildPhasePrompt(state: WorkspaceState, phase: PipelinePhase, forced: boolean): string {
	const lines = [
		`Read .codecarto/GUIDE.md and continue the CodeCartographer workflow for the phase \`${phase.id}\`.`,
		`Work on this phase only. The analyzed source code is the repository outside .codecarto/.`,
		"",
		"Required reads before analysis:",
		"- .codecarto/GUIDE.md",
		"- .codecarto/workflow/status.yaml",
	];

	const primaryOutput = phase.primary_output ? `.codecarto/${phase.primary_output}` : undefined;
	if (primaryOutput) {
		lines.push(`- ${primaryOutput} if it already exists (continue instead of duplicating work)`);
	}
	if (phase.skill_path) lines.push(`- .codecarto/${phase.skill_path}`);
	if (phase.output_template) lines.push(`- .codecarto/${phase.output_template}`);

	lines.push("", "Rules:");
	lines.push("- Do not modify source files outside .codecarto/.");
	lines.push("- Follow the active pipeline and validation protocol.");
	lines.push("- Update findings under .codecarto/findings/ for this phase.");

	if (forced) {
		lines.push("- The user explicitly requested this phase even if it is not the next eligible phase.");
	}

	if (phase.depends_on && phase.depends_on.length > 0) {
		const unmet = phase.depends_on.filter((dependencyId) => state.status.phases[dependencyId]?.status !== "complete");
		if (unmet.length > 0) {
			lines.push(`- Warning: dependencies not complete yet: ${unmet.join(", ")}`);
		}
	}

	if (primaryOutput) {
		lines.push("", `Primary output target: ${primaryOutput}`);
	}

	return lines.join("\n");
}

async function validatePhaseOutput(state: WorkspaceState, phaseId?: string): Promise<ValidationResult> {
	const phase = resolvePhase(state, phaseId);
	if (!phase) {
		throw new Error(phaseId ? `Unknown phase: ${phaseId}` : "No eligible phase found.");
	}
	if (!phase.primary_output) {
		throw new Error(`Phase ${phase.id} has no primary_output in the active pipeline.`);
	}

	const outputPath = join(state.workspaceDir, phase.primary_output);
	if (!(await pathExists(outputPath))) {
		return {
			phaseId: phase.id,
			primaryOutput: phase.primary_output,
			outputPath,
			exists: false,
			hasValidationBlock: false,
			overall: "MISSING",
			rows: [],
			gaps: [],
			errors: [`Missing primary output: .codecarto/${phase.primary_output}`],
		};
	}

	const content = await readFile(outputPath, "utf8");
	const validationHeadingIndex = content.lastIndexOf("## Validation");
	if (validationHeadingIndex === -1) {
		return {
			phaseId: phase.id,
			primaryOutput: phase.primary_output,
			outputPath,
			exists: true,
			hasValidationBlock: false,
			overall: "FAIL",
			rows: [],
			gaps: [],
			errors: ["Primary output exists but is missing a ## Validation block."],
		};
	}

	const validationContent = content.slice(validationHeadingIndex);
	const rows: Array<{ criterion: string; result: string; evidence: string }> = [];
	let overall: ValidationResult["overall"] = "FAIL";

	for (const rawLine of validationContent.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("|")) {
			const cells = line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
			if (cells.length >= 4 && cells[0] !== "#" && !/^[-:]+$/.test(cells[0])) {
				rows.push({
					criterion: cells[1] ?? "",
					result: cells[2] ?? "",
					evidence: cells[3] ?? "",
				});
			}
		}

		const overallMatch = line.match(/^\*\*Overall:\*\*\s*(.+)$/i);
		if (overallMatch?.[1]) {
			const normalizedOverall = overallMatch[1].trim().toUpperCase();
			if (normalizedOverall === "PASS") overall = "PASS";
			else if (normalizedOverall === "PASS WITH GAPS") overall = "PASS WITH GAPS";
			else overall = "FAIL";
		}
	}

	const errors: string[] = [];
	const gaps = rows
		.filter((row) => row.result.toUpperCase().includes("PARTIAL"))
		.map((row) => `${row.criterion}: ${row.evidence}`);

	if (rows.length === 0) {
		errors.push("Validation block found, but no validation rows could be parsed.");
	}
	if (rows.some((row) => row.result.toUpperCase().includes("FAIL"))) {
		errors.push("One or more validation criteria are marked FAIL.");
		overall = "FAIL";
	}
	if (overall === "FAIL" && errors.length === 0) {
		errors.push("Validation overall result is FAIL.");
	}

	return {
		phaseId: phase.id,
		primaryOutput: phase.primary_output,
		outputPath,
		exists: true,
		hasValidationBlock: true,
		overall,
		rows,
		gaps,
		errors,
	};
}

function buildValidationSummary(validation: ValidationResult): string[] {
	const lines = [`Validation: ${validation.overall}`];
	if (!validation.exists) {
		lines.push(...validation.errors);
		return lines;
	}
	lines.push(`Output: .codecarto/${validation.primaryOutput}`);
	if (validation.gaps.length > 0) {
		lines.push(`Gaps: ${validation.gaps.length}`);
	}
	if (validation.errors.length > 0) {
		lines.push(...validation.errors.slice(0, 3));
	}
	return lines;
}

function uniqueStrings(items: string[]): string[] {
	return [...new Set(items.filter(Boolean))];
}

function buildThreadLogEntry(phaseId: string, validation: ValidationResult, timestamp: string): string {
	return `\n## ${timestamp} — ${phaseId}\n- Completed via \`/codecarto-complete\`.\n- Primary output: \`.codecarto/${validation.primaryOutput}\`.\n- Validation: **${validation.overall}**.\n`;
}

export default function codeCartographerExtension(pi: ExtensionAPI) {
	let lastFeedbackLines: string[] = [];

	const readWorkspaceState = async (ctx: ExtensionContext | ExtensionCommandContext, notifyOnError: boolean = true): Promise<WorkspaceState | null> => {
		try {
			return await getWorkspaceState(ctx.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastFeedbackLines = [message];
			setUiState(ctx, null);
			if (notifyOnError && ctx.hasUI) ctx.ui.notify(message, "error");
			return null;
		}
	};

	const refreshWorkspaceUi = async (ctx: ExtensionContext | ExtensionCommandContext, extraLines?: string[]): Promise<WorkspaceState | null> => {
		const state = await readWorkspaceState(ctx, false);
		setUiState(ctx, state, extraLines ?? lastFeedbackLines);
		if (state) {
			const phaseId = getNextEligiblePhase(state)?.id ?? state.status.current_phase;
			if (phaseId) pi.setSessionName(`CodeCartographer: ${phaseId}`);
		}
		return state;
	};

	const ensureWorkspaceState = async (ctx: ExtensionCommandContext): Promise<WorkspaceState | null> => {
		const state = await readWorkspaceState(ctx);
		if (state) return state;
		const hasWorkspace = await pathExists(join(ctx.cwd, ".codecarto", "workflow", "status.yaml"));
		if (!hasWorkspace) ctx.ui.notify("No .codecarto/ workspace found. Run /codecarto-init first.", "warning");
		return null;
	};

	pi.on("session_start", async (_event, ctx) => {
		const state = await refreshWorkspaceUi(ctx);
		if (!state) return;
		pi.setActiveTools(SAFE_TOOL_NAMES);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshWorkspaceUi(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const workspaceDir = join(ctx.cwd, ".codecarto");
		if (!(await pathExists(workspaceDir))) return undefined;

		if (event.toolName === "bash") {
			if (ctx.hasUI) ctx.ui.notify("Blocked bash in CodeCartographer mode", "warning");
			return { block: true, reason: "CodeCartographer mode disables bash to keep source analysis read-only." };
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const inputPath = typeof event.input.path === "string" ? event.input.path : "";
			const strippedPath = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
			const targetPath = await canonicalPath(resolve(ctx.cwd, strippedPath));
			const allowedRoot = await canonicalPath(workspaceDir);
			if (!isWithinPath(targetPath, allowedRoot)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked ${event.toolName} outside .codecarto/: ${inputPath}`, "warning");
				}
				return { block: true, reason: `CodeCartographer mode only allows ${event.toolName} within .codecarto/` };
			}
		}

		return undefined;
	});

	pi.registerCommand("codecarto-init", {
		description: "Initialize .codecarto/ in the current repository",
		getArgumentCompletions: (prefix) => {
			const items = Object.keys(PIPELINE_ALIASES)
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const pipelineChoice = resolvePipelineChoice(trimmedArgs);
			if (trimmedArgs && !pipelineChoice) {
				ctx.ui.notify(`Unknown pipeline: ${trimmedArgs}`, "error");
				return;
			}
			const targetWorkspaceDir = join(ctx.cwd, ".codecarto");
			const sourceWorkspaceDir = packagedWorkspaceDir;

			if (!(await pathExists(sourceWorkspaceDir))) {
				ctx.ui.notify("Packaged .codecarto assets are missing.", "error");
				return;
			}

			const targetExists = await pathExists(targetWorkspaceDir);
			if (targetExists) {
				const sameWorkspace = normalizeForComparison(await canonicalPath(targetWorkspaceDir)) === normalizeForComparison(await canonicalPath(sourceWorkspaceDir));
				if (!sameWorkspace) {
					const overwrite = await ctx.ui.confirm(
						"CodeCartographer already exists",
						"A .codecarto/ directory already exists in this repository. Overwrite it?",
					);
					if (!overwrite) return;
					await rm(targetWorkspaceDir, { recursive: true, force: true });
				}
			}

			if (!(await pathExists(targetWorkspaceDir))) {
				await mkdir(ctx.cwd, { recursive: true });
				await cp(sourceWorkspaceDir, targetWorkspaceDir, { recursive: true });
			}

			const rawStatusPath = join(targetWorkspaceDir, "workflow", "status.yaml");
			const rawStatus = (await loadYamlFile<StatusFile>(rawStatusPath)) ?? {};
			const selectedPipelinePath = pipelineChoice ?? rawStatus.pipeline?.trim() ?? "workflow/pipeline-full-with-audit.yaml";
			const resolvedPipelinePath = join(targetWorkspaceDir, selectedPipelinePath);

			if (!(await pathExists(resolvedPipelinePath))) {
				ctx.ui.notify(`Pipeline not found: ${selectedPipelinePath}`, "error");
				return;
			}

			const pipeline = await loadYamlFile<PipelineFile>(resolvedPipelinePath);
			const normalizedStatus = createEmptyStatus(basename(ctx.cwd), selectedPipelinePath, pipeline);
			normalizedStatus.last_updated = new Date().toISOString();
			await writeFile(rawStatusPath, `${stringifySimpleYaml(normalizedStatus)}\n`, "utf8");

			lastFeedbackLines = [`Initialized workspace with pipeline: ${getPipelineLabel(selectedPipelinePath)}`];
			ctx.ui.notify(`Initialized CodeCartographer (${getPipelineLabel(selectedPipelinePath)})`, "info");
			await ctx.reload();
			return;
		},
	});

	pi.registerCommand("codecarto-status", {
		description: "Show the current CodeCartographer phase and progress",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const nextPhase = getNextEligiblePhase(state)?.id ?? "complete";
			lastFeedbackLines = [`Current phase: ${nextPhase}`, `Pipeline: ${getPipelineLabel(state.status.pipeline)}`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`CodeCartographer phase: ${nextPhase}`, "info");
		},
	});

	pi.registerCommand("codecarto-next", {
		description: "Queue the next eligible CodeCartographer phase prompt",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const phase = getNextEligiblePhase(state);
			if (!phase) {
				lastFeedbackLines = ["All phases complete."];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify("All CodeCartographer phases are complete.", "info");
				return;
			}

			const prompt = buildPhasePrompt(state, phase, false);
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}

			lastFeedbackLines = [`Queued phase prompt for ${phase.id}`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`Queued CodeCartographer phase: ${phase.id}`, "info");
		},
	});

	pi.registerCommand("codecarto-phase", {
		description: "Queue a specific CodeCartographer phase prompt: /codecarto-phase <phase>",
		handler: async (args, ctx) => {
			const phaseId = args.trim();
			if (!phaseId) {
				ctx.ui.notify("Usage: /codecarto-phase <phase>", "warning");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const phase = resolvePhase(state, phaseId);
			if (!phase) {
				ctx.ui.notify(`Unknown phase: ${phaseId}`, "error");
				return;
			}

			const prompt = buildPhasePrompt(state, phase, true);
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}

			lastFeedbackLines = [`Queued explicit phase prompt for ${phase.id}`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`Queued CodeCartographer phase: ${phase.id}`, "info");
		},
	});

	pi.registerCommand("codecarto-validate", {
		description: "Validate a phase output: /codecarto-validate [phase]",
		handler: async (args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const validation = await validatePhaseOutput(state, args.trim() || undefined);
			lastFeedbackLines = buildValidationSummary(validation);
			setUiState(ctx, state, lastFeedbackLines);

			const level = validation.overall === "FAIL" || validation.overall === "MISSING" ? "error" : validation.overall === "PASS WITH GAPS" ? "warning" : "info";
			ctx.ui.notify(`Validation ${validation.phaseId}: ${validation.overall}`, level);
		},
	});

	pi.registerCommand("codecarto-complete", {
		description: "Mark a phase complete after validation passes: /codecarto-complete [phase]",
		handler: async (args, ctx) => {
			const currentState = await ensureWorkspaceState(ctx);
			if (!currentState) return;

			const validation = await validatePhaseOutput(currentState, args.trim() || undefined);
			if (validation.overall === "FAIL" || validation.overall === "MISSING") {
				lastFeedbackLines = buildValidationSummary(validation);
				setUiState(ctx, currentState, lastFeedbackLines);
				ctx.ui.notify(`Cannot complete ${validation.phaseId}: ${validation.overall}`, "error");
				return;
			}

			const updatedState = await updateStatusAtomically(ctx.cwd, (lockedState) => {
				const phase = resolvePhase(lockedState, validation.phaseId);
				if (!phase?.primary_output) {
					throw new Error(`Phase ${validation.phaseId} is missing primary_output.`);
				}

				const timestamp = new Date().toISOString();
				const nextStatus = normalizeStatus(lockedState.status, lockedState.pipeline, lockedState.status.pipeline, lockedState.cwd);
				const existingPhase = nextStatus.phases[validation.phaseId] ?? {
					status: "pending",
					owner_notes: [],
					outputs_present: [],
					open_questions: [],
				};

				nextStatus.phases[validation.phaseId] = {
					status: "complete",
					owner_notes: uniqueStrings([
						...existingPhase.owner_notes,
						`Completed via /codecarto-complete on ${timestamp}.`,
						`Primary output: .codecarto/${validation.primaryOutput}`,
						`Validation: ${validation.overall}`,
					]).slice(-3),
					outputs_present: uniqueStrings([...existingPhase.outputs_present, validation.primaryOutput]),
					open_questions: uniqueStrings([...existingPhase.open_questions, ...validation.gaps]),
				};

				nextStatus.last_updated = timestamp;
				const updatedWorkspaceState: WorkspaceState = {
					...lockedState,
					status: nextStatus,
				};

				const nextEligible = getNextEligiblePhase(updatedWorkspaceState);
				nextStatus.current_phase = nextEligible?.id ?? "complete";
				nextStatus.next_actions = nextEligible
					? [
						`Begin ${nextEligible.id} phase by producing ${nextEligible.primary_output ?? `findings/${nextEligible.id}/`}`,
					]
					: ["All phases complete. Review findings, open questions, and downstream implementation notes."];

				return {
					state: {
						...updatedWorkspaceState,
						status: nextStatus,
					},
					threadLogEntry: buildThreadLogEntry(validation.phaseId, validation, timestamp),
				};
			});

			lastFeedbackLines = [
				`Completed phase: ${validation.phaseId}`,
				`Validation: ${validation.overall}`,
				`Next phase: ${updatedState.status.current_phase}`,
			];
			setUiState(ctx, updatedState, lastFeedbackLines);
			ctx.ui.notify(`Marked ${validation.phaseId} complete`, validation.overall === "PASS WITH GAPS" ? "warning" : "info");
		},
	});
}
