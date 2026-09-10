import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { autoCompletePhase, buildAutoSummary, isPhaseRunning, runAuto, runSinglePhase } from "./auto-runner.ts";
import { disposeAgentsWidget } from "./agent-widget.ts";
import { parseDashboardFlags } from "./dashboard-flags.ts";
import { narrateDashboard } from "./dashboard-narrator.ts";
import { writeDashboard } from "./dashboard-writer.ts";
import { parseBroadsideFlags, KNOWN_BROADSIDE_TOKENS } from "./broadside-flags.ts";
import { parseNextFlags } from "./next-flags.ts";
import { buildPiGuideMessage } from "./guide-framing.ts";
import { phaseCompactionExtension } from "./phase-compaction.ts";

import {
	type Amendment,
	applyAmendment,
	buildPhasePrompt,
	buildSkillPrompt,
	buildValidationSummary,
	canonicalPath,
	copyPackagedWorkspace,
	computePerPhaseTotals,
	computeTotals,
	ConfidentialityMismatchError,
	createEmptyStatus,
	DEFAULT_PIPELINE_PATH,
	describeScaffoldStaleness,
	deriveSlug,
	discoverLibrary,
	type EntryGeneration,
	getNextEligiblePhase,
	getPipelineLabel,
	getWorkspaceState,
	isWithinPath,
	isWithinPathResolved,
	BROADSIDE_LENS_IDS,
	BROADSIDE_SKILL_NAME,
	BroadsideCancelledError,
	type BroadsideEstimate,
	broadsideDirFor,
	collectResultText,
	estimateSubmitText,
	getLens,
	type GuideDocument,
	listAmendmentNames,
	listBatchModels,
	listGuideTopics,
	listScaffoldRefreshFiles,
	listSkillNames,
	loadAmendmentFile,
	loadBroadsideConfig,
	modelsText,
	runBroadsideCollect,
	runBroadsideStatus,
	runBroadsideSubmit,
	statusText,
	loadCodecartoConfig,
	loadUsage,
	loadYamlFile,
	normalizeForComparison,
	type OpenQuestionEntry,
	packagedWorkspaceDir,
	pathExists,
	PACKAGE_VERSION,
	readBroadsideSkill,
	readGuide,
	refreshScaffold,
	PhasePreflightError,
	type PhasePreflightResult,
	PIPELINE_ALIASES,
	publishEntry,
	type PublishInput,
	type PublishOptions,
	type PublishResult,
	type PipelineFile,
	resolvePhase,
	resolvePipelineChoice,
	resolvePublishSourceRepo,
	SourceRepoMismatchError,
	runPhasePreflight,
	SCAFFOLD_REFRESH_PROTECTED,
	seedOrchestratorFiles,
	type StatusFile,
	stringifySimpleYaml,
	switchPipeline,
	validatePhaseOutput,
	type WorkspaceState,
	writeLibraryConfig,
} from "../../core/index.ts";
import { initLibrary } from "../../core/library.ts";
import { resolveUserConfigPath, USER_CONFIG_DIR } from "../../core/orchestrator-config.ts";

const STATUS_WIDGET_ID = "codecarto-widget";
// Broad-Side gets its own widget id: a scout run is legal on a repository with
// no workspace, where the phase widget has nothing to render.
const BROADSIDE_WIDGET_ID = "codecarto-broadside";
const STATUS_LINE_ID = "codecarto-status";
const SAFE_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write"];

function derivePublishHeadline(spec: string, cwd: string): string {
	const summary = spec.split(/^##\s+System Summary\s*$/mi)[1]?.split(/^##\s+/m)[0] ?? "";
	const candidate = summary
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("<!--") && !line.startsWith("-->") && !line.startsWith("#"));
	return candidate?.replace(/\s+/g, " ").slice(0, 280) || `Reimplementation specification for ${basename(cwd)}.`;
}

function piGeneration(ctx: ExtensionCommandContext): EntryGeneration {
	return {
		surface: "pi-extension",
		agent: "pi",
		agent_version: "unknown",
		model: ctx.model?.id ?? "unknown",
		model_vendor: ctx.model?.provider ?? "unknown",
		// Pi's extension context exposes the selected model but not the active
		// thinking level. Preserve that uncertainty instead of inferring it.
		reasoning: "unknown",
		notes: "",
	};
}

function formatUsageTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${count}`;
}

function formatUsageDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function buildStatusLines(state: WorkspaceState, extraLines: string[] = []): string[] {
	const nextPhase = getNextEligiblePhase(state);
	const currentPhase = nextPhase?.id ?? state.status.current_phase ?? "complete";
	const pipelineLabel = getPipelineLabel(state.status.pipeline);
	const completedCount = state.pipeline.phase_order.filter((phaseId) => state.status.phases[phaseId]?.status === "complete").length;
	const terminalOpenQuestions = Object.values(state.status.phases).reduce((sum, phase) => sum + (phase.open_questions?.length ?? 0), 0);
	const totalCarryForward = Object.values(state.status.phases).reduce((sum, phase) => sum + (phase.carry_forward?.length ?? 0), 0);
	const postPipelinePending = state.status.post_pipeline.filter((entry) => entry.status !== "resolved").length;
	const nextAction = state.status.next_actions[0] ?? (nextPhase ? `Next: ${nextPhase.id}` : "All phases complete.");

	const lines = [
		"CodeCartographer",
		`Phase: ${currentPhase}`,
		`Pipeline state: ${currentPhase === "complete" ? "complete" : "in progress"}`,
		`Pipeline: ${pipelineLabel}`,
		`Progress: ${completedCount}/${state.pipeline.phase_order.length} complete`,
		`Open questions (terminal unresolved): ${terminalOpenQuestions}`,
		`Carry-forward (pipeline phases): ${totalCarryForward}`,
		`Post-pipeline work: ${postPipelinePending} pending`,
		`Next: ${nextAction}`,
	];

	const scaffoldNotice = describeScaffoldStaleness(state);
	if (scaffoldNotice) lines.push(`Scaffold: ${scaffoldNotice}`);

	if (extraLines.length > 0) {
		lines.push("", ...extraLines);
	}

	return lines;
}

/**
 * Whether `ctx` still belongs to the live session.
 *
 * Pi invalidates an extension ctx when the session is replaced, and from then
 * on *every* property access on it throws — `ctx.cwd` and `ctx.hasUI` included.
 * A phase runs as a sub-agent, so by the time post-phase work fires, the ctx
 * captured when the command started may already be dead. That is an ordinary
 * outcome rather than an error: the UI it would have refreshed is gone with the
 * session. Callers skip their UI work instead of throwing into a `void` call
 * that nothing is waiting on.
 */
function isCtxLive(ctx: ExtensionContext | ExtensionCommandContext): boolean {
	try {
		return typeof ctx.cwd === "string";
	} catch {
		return false;
	}
}

/**
 * Notify through `ctx`, dropping the message if the session it belonged to is
 * gone.
 *
 * `ctx.hasUI` throws on a stale ctx rather than returning false, so the usual
 * `if (ctx.hasUI) ctx.ui.notify(...)` guard was itself a throw site. Inside a
 * promise chain that was worse than a lost message: the `.catch` handler threw
 * while reporting the original failure, and that second rejection had nothing
 * left to catch it.
 */
function notifyCtx(
	ctx: ExtensionContext | ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	if (!isCtxLive(ctx) || !ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function setUiState(ctx: ExtensionContext | ExtensionCommandContext, state: WorkspaceState | null, extraLines: string[] = []): void {
	if (!isCtxLive(ctx) || !ctx.hasUI) return;
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

/**
 * Resolve the OpenRouter key for a Broad-Side run. Deliberately no slash-command
 * parameter: a key typed as a command argument lands in the session transcript.
 */
function resolveBroadsideKey(configuredKey: string): string | null {
	const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	return configuredKey.trim() || null;
}

/** The spend decision, rendered for a human about to approve it. */
function describeBroadsideEstimate(estimate: BroadsideEstimate): string {
	const lines = [
		`Model: ${estimate.model}${estimate.mixedModels ? " (some lenses overridden — see below)" : ""} (pricing: ${estimate.pricing.source})`,
		`Rates: $${estimate.pricing.inputPerM.toFixed(4)}/M in · $${estimate.pricing.outputPerM.toFixed(4)}/M out`,
		"",
		"Per lens:",
		...estimate.lenses.map(({ name, slices, cost, model }) => {
			// Naming the model only when it differs keeps the common case quiet
			// and makes a mixed-model run impossible to approve without noticing.
			const override = estimate.mixedModels && model !== estimate.model ? ` on ${model}` : "";
			return `  ${name}: ${slices} slice${slices === 1 ? "" : "s"} — ~$${cost.toFixed(4)}${override}`;
		}),
		"",
		`Estimated total: ~$${estimate.totalCost.toFixed(4)} ` +
			`(~${Math.round(estimate.inputTokens / 1000)}k in, ~${Math.round(estimate.outputTokens / 1000)}k out)`,
	];
	if (estimate.maxCost > 0) {
		lines.push(
			estimate.exceedsLimit
				? `This EXCEEDS the configured max_cost of $${estimate.maxCost.toFixed(2)}. Approving here overrides it for this run.`
				: `Within the configured max_cost of $${estimate.maxCost.toFixed(2)}.`,
		);
	}
	if (estimate.baseHead) {
		lines.push(`Incremental: only modules changed since ${estimate.baseHead.slice(0, 8)} are included.`);
	} else if (estimate.sourceDirty) {
		lines.push("Incremental was requested but the tree is dirty — this is a full scan.");
	}
	lines.push("", "The estimate is a pre-flight prediction from file sizes; OpenRouter bills actual usage.");
	return lines.join("\n");
}

/**
 * Resolve the argument of /codecarto-amend to the slug applyAmendment takes.
 * Accepts the slug, `slug.yaml`, or a path to the file — but a path only when
 * it lands inside .codecarto/scratch/amendments/, the one place an amendment
 * is read from. The path names the file; the read always goes through the slug.
 */
function resolveAmendmentName(rawArg: string, cwd: string): string | null {
	const trimmed = rawArg.trim().replace(/^@/, "");
	if (!trimmed) return null;
	if (!/[\\/]/.test(trimmed)) return trimmed;
	const amendmentsDir = resolve(cwd, ".codecarto", "scratch", "amendments");
	for (const candidate of [resolve(cwd, trimmed), resolve(cwd, ".codecarto", trimmed)]) {
		if (dirname(candidate) === amendmentsDir) return basename(candidate);
	}
	return null;
}

function clipDescription(text: string | undefined, max = 140): string {
	if (!text) return "";
	const oneLine = text.replace(/\s+/g, " ").trim();
	return `: ${oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine}`;
}

/**
 * What an amendment will do to canonical state, rendered for a human about to
 * approve it: each closure resolved against status.yaml so an id that matches
 * nothing is visible before the write, not only in the result.
 */
function describeAmendmentPreview(amendment: Amendment, state: WorkspaceState): string {
	const openQuestions = new Map<string, { phaseId: string; entry: OpenQuestionEntry }[]>();
	for (const [phaseId, phase] of Object.entries(state.status.phases)) {
		for (const entry of phase.open_questions ?? []) {
			if (!entry.id) continue;
			openQuestions.set(entry.id, [...(openQuestions.get(entry.id) ?? []), { phaseId, entry }]);
		}
	}
	const unmatched = " — matches nothing (already closed or unknown; reported, not fatal)";
	const lines = [`Amendment file: .codecarto/scratch/amendments/${amendment.slug}.yaml`];

	if (amendment.open_question_closures.length > 0) {
		lines.push("", `Closes ${amendment.open_question_closures.length} open question(s):`);
		for (const id of amendment.open_question_closures) {
			const matches = openQuestions.get(id);
			if (!matches) {
				lines.push(`  - ${id}${unmatched}`);
				continue;
			}
			const { entry } = matches[0];
			const where = [matches.map((match) => match.phaseId).join(", "), entry.kind].filter(Boolean).join(", ");
			lines.push(`  - ${id} (${where})${clipDescription(entry.description)}`);
		}
	}
	if (amendment.post_pipeline_closures.length > 0) {
		lines.push("", `Retires ${amendment.post_pipeline_closures.length} post-pipeline item(s):`);
		for (const id of amendment.post_pipeline_closures) {
			const entry = state.status.post_pipeline.find((item) => item.id === id);
			if (!entry) {
				lines.push(`  - ${id}${unmatched}`);
				continue;
			}
			const where = [entry.kind, entry.source_phase ? `from ${entry.source_phase}` : ""].filter(Boolean).join(", ");
			lines.push(`  - ${id}${where ? ` (${where})` : ""}${clipDescription(entry.description)}`);
		}
	}
	if (amendment.notes.length > 0) {
		lines.push("", `Records ${amendment.notes.length} note(s) in the closeout:`, ...amendment.notes.map((note) => `  - ${note}`));
	}

	const summary = amendment.closeout_summary.trim();
	lines.push(
		"",
		`Writes .codecarto/closeouts/<date>-amendment-${amendment.slug}.md, appends one THREAD_LOG entry${summary ? ` ("${summary}")` : ""}, updates workflow/status.yaml under the completion lock, and refreshes the dashboard.`,
	);
	return lines.join("\n");
}

/**
 * What a scaffold refresh will overwrite, rendered for a human about to approve
 * it. The file set is the one refreshScaffold writes; the protected set is the
 * one it skips — both come from core, so the preview cannot drift from the write.
 */
function describeScaffoldRefreshPreview(files: string[], scaffoldVersionBefore: string | undefined): string {
	const topLevel: string[] = [];
	const byDir = new Map<string, string[]>();
	for (const file of files) {
		const slash = file.indexOf("/");
		if (slash === -1) {
			topLevel.push(file);
			continue;
		}
		const dir = file.slice(0, slash);
		byDir.set(dir, [...(byDir.get(dir) ?? []), file.slice(slash + 1)]);
	}
	const from = scaffoldVersionBefore ?? "unversioned";
	const lines = [
		from === PACKAGE_VERSION
			? `Scaffold version: ${from} (already current — the files are re-copied from the packaged template byte-for-byte).`
			: `Scaffold version: ${from} → ${PACKAGE_VERSION}.`,
		"",
		`Overwrites ${files.length} framework-owned file(s) in .codecarto/ with the packaged template:`,
	];
	if (topLevel.length > 0) lines.push(`  ${topLevel.join(", ")}`);
	for (const [dir, entries] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		// workflow/ is where the pipelines live, and the version marker: name them.
		lines.push(dir === "workflow" ? `  workflow/: ${entries.join(", ")}` : `  ${dir}/: ${entries.length} file(s)`);
	}
	if (byDir.has("findings")) {
		lines.push("  (findings/ refreshes only the packaged SKILL.md, README.md, and pass files — the findings outputs beside them stay.)");
	}
	const protectedPaths = [
		...SCAFFOLD_REFRESH_PROTECTED.workflowFiles.map((file) => `workflow/${file}`),
		...SCAFFOLD_REFRESH_PROTECTED.topLevel,
		...SCAFFOLD_REFRESH_PROTECTED.dirs.map((dir) => `${dir}/`),
	];
	lines.push("", `Never touched: ${protectedPaths.join(", ")}.`, "One THREAD_LOG entry records the refresh. Continue?");
	return lines.join("\n");
}

export default function codeCartographerExtension(pi: ExtensionAPI) {
	phaseCompactionExtension(pi);
	let lastFeedbackLines: string[] = [];
	let codecartoModeActive = false;
	// Argument completers receive only the prefix, so the session's cwd is
	// remembered here for the completers that list files under .codecarto/.
	let sessionCwd: string | undefined;

	const readWorkspaceState = async (ctx: ExtensionContext | ExtensionCommandContext, notifyOnError: boolean = true): Promise<WorkspaceState | null> => {
		// `ctx.cwd` was read before the try, so a stale ctx made this reject
		// rather than return null as its signature promises — and the callers
		// that fire it without awaiting turned that into an unhandled rejection.
		if (!isCtxLive(ctx)) return null;
		sessionCwd = ctx.cwd;
		try {
			return await getWorkspaceState(ctx.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastFeedbackLines = [message];
			setUiState(ctx, null);
			// The ctx can die between the read above and here, so the error
			// path must not assume it is still usable either.
			if (notifyOnError && isCtxLive(ctx) && ctx.hasUI) ctx.ui.notify(message, "error");
			return null;
		}
	};

	const refreshWorkspaceUi = async (ctx: ExtensionContext | ExtensionCommandContext, extraLines?: string[]): Promise<WorkspaceState | null> => {
		if (!isCtxLive(ctx)) return null;
		if (!codecartoModeActive) {
			setUiState(ctx, null);
			return null;
		}
		const state = await readWorkspaceState(ctx, false);
		setUiState(ctx, state, extraLines ?? lastFeedbackLines);
		if (state) {
			const phaseId = getNextEligiblePhase(state)?.id ?? state.status.current_phase;
			if (phaseId) pi.setSessionName(`CodeCartographer: ${phaseId}`);
		}
		return state;
	};

	const ensureWorkspaceState = async (ctx: ExtensionCommandContext): Promise<WorkspaceState | null> => {
		if (!codecartoModeActive) {
			setUiState(ctx, null);
			notifyCtx(ctx, "CodeCartographer is not active in this session. Run /codecarto-init first.", "warning");
			return null;
		}
		const state = await readWorkspaceState(ctx);
		if (state) return state;
		// Reached when the ctx is stale as well as when there is no workspace,
		// so neither `ctx.cwd` nor the notify below may assume a live ctx.
		if (!isCtxLive(ctx)) return null;
		const hasWorkspace = await pathExists(join(ctx.cwd, ".codecarto", "workflow", "status.yaml"));
		if (!hasWorkspace) notifyCtx(ctx, "No .codecarto/ workspace found. Run /codecarto-init first.", "warning");
		return null;
	};

	pi.on("session_start", async (_event, ctx) => {
		codecartoModeActive = false;
		lastFeedbackLines = [];
		sessionCwd = ctx.cwd;
		setUiState(ctx, null);
	});

	pi.on("session_shutdown", async () => {
		// Tear down the persistent agents widget so we don't leak the timer
		// or render against a torn-down UI context after a session swap.
		disposeAgentsWidget();
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshWorkspaceUi(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!codecartoModeActive) return undefined;

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
			const allowedRoots = [await canonicalPath(workspaceDir)];
			const config = await loadCodecartoConfig(workspaceDir);
			if (config.library.path && await discoverLibrary(config.library.path)) {
				allowedRoots.push(await canonicalPath(config.library.path));
			}
			const withinAllowed = await Promise.all(
			allowedRoots.map((allowedRoot) => isWithinPathResolved(targetPath, allowedRoot)),
		);
		if (!withinAllowed.some((result) => result)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked ${event.toolName} outside .codecarto/ or configured library: ${inputPath}`, "warning");
				}
				return { block: true, reason: `CodeCartographer mode only allows ${event.toolName} within .codecarto/ or the configured CodeCartographer library.` };
			}
		}

		return undefined;
	});

	pi.registerCommand("codecarto-open", {
		description: "Activate an existing .codecarto workspace without resetting durable state",
		handler: async (_args, ctx) => {
			const workspaceDir = join(ctx.cwd, ".codecarto");
			if (!(await pathExists(join(workspaceDir, "workflow", "status.yaml")))) {
				ctx.ui.notify("No existing CodeCartographer workspace found. Run /codecarto-init first.", "warning");
				return;
			}
			try {
				const state = await getWorkspaceState(ctx.cwd);
				codecartoModeActive = true;
				lastFeedbackLines = [`Opened existing workspace: ${getPipelineLabel(state.status.pipeline)}`];
				pi.setActiveTools(SAFE_TOOL_NAMES);
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify("Opened existing CodeCartographer workspace without resetting state.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to open CodeCartographer workspace: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("codecarto-vision", {
		description: "Run a guided product discovery interview to produce inputs/vision.md for the synthesis pipeline",
		handler: async (_args, ctx) => {
			const interviewPath = join(ctx.cwd, ".codecarto", "findings", "vision-capture", "INTERVIEW.md");
			if (!(await pathExists(interviewPath))) {
				ctx.ui.notify("Vision interview skill not found. Run /codecarto-init synthesis first.", "warning");
				return;
			}

			const interviewSkill = await readFile(interviewPath, "utf8");
			const inputsDir = join(ctx.cwd, ".codecarto", "inputs");
			const visionPath = join(inputsDir, "vision.md");
			const visionExists = await pathExists(visionPath);

			const prompt = [
				"Read the interview skill below and conduct a guided product discovery interview with the user.",
				"",
				interviewSkill,
				"",
				`The vision brief should be written to .codecarto/inputs/vision.md${visionExists ? " (it already exists — review and improve it based on the interview)" : " (it does not exist yet — create it)"}.`,
				"After the interview, write the synthesized brief and tell the user to run /codecarto-init synthesis followed by /codecarto-next to start the pipeline.",
			].join("\n");

			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}

			lastFeedbackLines = ["Vision interview started — answer the questions in chat."];
			ctx.ui.notify("Vision interview queued — answer the questions in the chat.", "info");
		},
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
						"CodeCartographer already exists — data will be lost",
						"A .codecarto/ directory already exists in this repository. Re-initializing will back up the existing workspace to .codecarto-backup-TIMESTAMP/ and create a fresh one. All phase findings, handoffs, usage data, closeouts, and progress will be moved to the backup. Consider /codecarto-open to reattach without resetting. Continue?",
					);
					if (!overwrite) return;
					const backupDir = join(ctx.cwd, `.codecarto-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
					await rename(targetWorkspaceDir, backupDir);
					if (ctx.hasUI) ctx.ui.notify(`Backed up existing workspace to ${basename(backupDir)}/`, "info");
				}
			}

			if (!(await pathExists(targetWorkspaceDir))) {
				await mkdir(ctx.cwd, { recursive: true });
				await copyPackagedWorkspace(targetWorkspaceDir);
			}

			const rawStatusPath = join(targetWorkspaceDir, "workflow", "status.yaml");
			const rawStatus = (await loadYamlFile<StatusFile>(rawStatusPath)) ?? {};
			const selectedPipelinePath = pipelineChoice ?? rawStatus.pipeline?.trim() ?? DEFAULT_PIPELINE_PATH;
			const resolvedPipelinePath = join(targetWorkspaceDir, selectedPipelinePath);

			if (!(await pathExists(resolvedPipelinePath))) {
				ctx.ui.notify(`Pipeline not found: ${selectedPipelinePath}`, "error");
				return;
			}

			const pipeline = await loadYamlFile<PipelineFile>(resolvedPipelinePath);
			const normalizedStatus = createEmptyStatus(basename(ctx.cwd), selectedPipelinePath, pipeline);
			normalizedStatus.last_updated = new Date().toISOString();
			await writeFile(rawStatusPath, `${stringifySimpleYaml(normalizedStatus)}\n`, "utf8");

			// Orchestration is on by default (issue #97/#98): seed the files its
			// duties maintain so they exist from the first phase.
			await seedOrchestratorFiles(targetWorkspaceDir);

			codecartoModeActive = true;
			lastFeedbackLines = [`Initialized workspace with pipeline: ${getPipelineLabel(selectedPipelinePath)}`];
			ctx.ui.notify(`Initialized CodeCartographer (${getPipelineLabel(selectedPipelinePath)})`, "info");
			// Render the initial dashboard (empty usage, all phases pending) so
			// the user sees the file exist immediately after /codecarto-init.
			void writeDashboard(ctx.cwd, PACKAGE_VERSION);
			await refreshWorkspaceUi(ctx, lastFeedbackLines);
			pi.setActiveTools(SAFE_TOOL_NAMES);
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

	pi.registerCommand("codecarto-switch-pipeline", {
		description: "Switch the active pipeline without losing findings or progress: /codecarto-switch-pipeline <variant>",
		getArgumentCompletions: (prefix) => {
			const items = Object.keys(PIPELINE_ALIASES)
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (!trimmedArgs) {
				ctx.ui.notify("Usage: /codecarto-switch-pipeline <variant> (e.g. lite, full, synthesis)", "warning");
				return;
			}

			const pipelineChoice = resolvePipelineChoice(trimmedArgs);
			if (!pipelineChoice) {
				ctx.ui.notify(`Unknown pipeline: ${trimmedArgs}`, "error");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const currentPipeline = state.status.pipeline;
			if (currentPipeline === pipelineChoice) {
				ctx.ui.notify(`Already on pipeline: ${getPipelineLabel(pipelineChoice)}`, "info");
				return;
			}

			try {
				const result = await switchPipeline(ctx.cwd, pipelineChoice);
				const lines = [
					`Switched pipeline: ${getPipelineLabel(pipelineChoice)}`,
				];
				if (result.carried.length > 0) lines.push(`Phases preserved (completed): ${result.carried.join(", ")}`);
				if (result.newPhases.length > 0) lines.push(`New phases: ${result.newPhases.join(", ")}`);
				if (result.dropped.length > 0) lines.push(`Phases not in new pipeline: ${result.dropped.join(", ")} (findings remain on disk)`);

				lastFeedbackLines = lines;
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify(`Switched to pipeline: ${getPipelineLabel(pipelineChoice)}`, "info");
				void writeDashboard(ctx.cwd, PACKAGE_VERSION);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				lastFeedbackLines = [message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerCommand("codecarto-next", {
		description: "Run the next eligible CodeCartographer phase as a sub-agent. Flags: --llm-steer / --no-llm-steer / --auto [--strict]",
		getArgumentCompletions: (prefix) => {
			const items = ["--llm-steer", "--no-llm-steer", "--auto", "--strict"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const flags = parseNextFlags(args);
			if (flags.error) {
				ctx.ui.notify(flags.error, "error");
				return;
			}
			if (flags.unknown.length > 0) {
				ctx.ui.notify(`Unknown /codecarto-next flag: ${flags.unknown.join(" ")}`, "error");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			if (flags.auto) {
				ctx.ui.notify(`Auto pipeline${flags.strict ? " (strict)" : ""} running…`, "info");
				const result = await runAuto(ctx, pi, state, {
					strict: flags.strict,
					llmSteerOverride: flags.llmSteerOverride,
					signal: ctx.signal,
					onPhaseAdvanced: (advancedState) => {
						// Refresh the status widget + session name between phases so
						// the readout tracks progress live instead of staying frozen
						// at the initial phase until the whole auto run finishes.
						setUiState(ctx, advancedState, [`Auto pipeline${flags.strict ? " (strict)" : ""} running…`]);
						const phaseId = getNextEligiblePhase(advancedState)?.id ?? advancedState.status.current_phase;
						if (phaseId) pi.setSessionName(`CodeCartographer: ${phaseId}`);
					},
				});
				const availableSkills = await listSkillNames(state.workspaceDir).catch(() => [] as string[]);
				pi.sendMessage({
					customType: "codecarto-auto-summary",
					content: buildAutoSummary(result, availableSkills),
					display: true,
				});
				lastFeedbackLines = [`Auto pipeline ${result.outcome}: ${result.reason}`];
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify(`Auto pipeline ${result.outcome}: ${result.phasesRun.length}/${result.totalPhases} phases.`, result.outcome === "complete" ? "info" : "warning");
				return;
			}

			const phase = getNextEligiblePhase(state);
			if (!phase) {
				lastFeedbackLines = ["All phases complete."];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify("All CodeCartographer phases are complete.", "info");
				return;
			}

			let preflight: PhasePreflightResult;
			try {
				preflight = await runPhasePreflight(state, phase);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				lastFeedbackLines = [message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(message, error instanceof PhasePreflightError ? "warning" : "error");
				return;
			}

			// Reject re-entry: don't spawn a duplicate runner for a phase that's
			// already in flight from a previous /codecarto-next invocation.
			if (isPhaseRunning(phase.id)) {
				ctx.ui.notify(`Phase ${phase.id} is already running.`, "warning");
				return;
			}

			const config = await loadCodecartoConfig(state.workspaceDir);
			const llmSteerEnabled = flags.llmSteerOverride ?? config.orchestrator.llm_steer_next_phase;

			lastFeedbackLines = [`Running ${phase.id} phase as sub-agent`];
			setUiState(ctx, state, lastFeedbackLines);

			// Fire-and-forget: keep the TUI responsive while the sub-agent works.
			// runSinglePhase handles all side effects (steering message, notify,
			// phase summary, recordUsage, dashboard regen, clearPhase linger).
			// After the sub-agent finishes, auto-validate and auto-complete the
			// phase so status.yaml advances without requiring the user to manually
			// run /codecarto-validate then /codecarto-complete. This mirrors what
			// the auto loop (runAuto) does after each phase.
			// The sub-agent replaces the session, which invalidates this ctx —
			// every later property access on it throws. Capture the directory
			// now so the post-phase work below does not depend on the ctx
			// surviving, and route UI updates through notifyCtx, which drops
			// them if it has not.
			const phaseCwd = ctx.cwd;
			void runSinglePhase(ctx, pi, state, phase, { llmSteerEnabled, signal: ctx.signal, preflight })
				.then(async (result) => {
					if (result.status !== "completed") return;

					// Refresh state from disk — the sub-agent may have written
					// findings that the validator needs to read.
					const stateForValidation = (await getWorkspaceState(phaseCwd)) ?? state;
					const validation = await validatePhaseOutput(stateForValidation, phase.id).catch(
						(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
					);

					if (validation instanceof Error) {
						notifyCtx(ctx, `Auto-validation error for ${phase.id}: ${validation.message}`, "warning");
						lastFeedbackLines = [`Validation error: ${validation.message}`, "Run `/codecarto-validate` then `/codecarto-complete` manually."];
						return;
					}

					if (validation.overall === "FAIL" || validation.overall === "MISSING") {
						notifyCtx(ctx, `Phase ${phase.id} validation: ${validation.overall}. Fix the output, then re-run /codecarto-next.`, "warning");
						lastFeedbackLines = buildValidationSummary(validation);
						return;
					}

					// PASS or PASS WITH GAPS — auto-complete the phase.
					try {
						const { updatedState, closeoutNotice } = await autoCompletePhase(phaseCwd, validation);
						notifyCtx(ctx, `Phase ${phase.id} auto-completed (validation: ${validation.overall}).`, validation.overall === "PASS WITH GAPS" ? "warning" : "info");
						if (closeoutNotice) notifyCtx(ctx, closeoutNotice, "info");
						lastFeedbackLines = [
							`Completed phase: ${validation.phaseId}`,
							`Validation: ${validation.overall}`,
							`Next phase: ${updatedState.status.current_phase}`,
						];
						if (closeoutNotice) lastFeedbackLines.push(closeoutNotice);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : String(error);
						notifyCtx(ctx, `Auto-completion failed for ${phase.id}: ${message}. Run /codecarto-complete manually.`, "warning");
						lastFeedbackLines = [`Auto-completion failed: ${message}`, "Run `/codecarto-complete` manually."];
					}
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					notifyCtx(ctx, `Post-phase processing error for ${phase.id}: ${message}`, "warning");
					lastFeedbackLines = [`Post-phase error: ${message}`];
				})
				.finally(() => {
					// Refresh the status widget after the phase resolves so the
					// "Open questions / Carry-forward / Next" lines reflect any
					// owner_notes the sub-agent wrote to status.yaml.
					void refreshWorkspaceUi(ctx).catch(() => undefined);
				});
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

			let prompt: string;
			try {
				prompt = await buildPhasePrompt(state, phase, true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, error instanceof PhasePreflightError ? "warning" : "error");
				return;
			}
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

			const validation = await validatePhaseOutput(state, args.trim() || undefined).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
			if (validation instanceof Error) {
				lastFeedbackLines = [validation.message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(validation.message, "error");
				return;
			}
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

			const validation = await validatePhaseOutput(currentState, args.trim() || undefined).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
			if (validation instanceof Error) {
				lastFeedbackLines = [validation.message];
				setUiState(ctx, currentState, lastFeedbackLines);
				ctx.ui.notify(validation.message, "error");
				return;
			}
			if (validation.overall === "FAIL" || validation.overall === "MISSING") {
				lastFeedbackLines = buildValidationSummary(validation);
				setUiState(ctx, currentState, lastFeedbackLines);
				ctx.ui.notify(`Cannot complete ${validation.phaseId}: ${validation.overall}`, "error");
				return;
			}

			// Completion refuses for reasons the framework words carefully — a
			// missing phase handoff, a carry-forward without `derives_from`, a
			// closure lacking runtime evidence. Those messages are the whole
			// point of the refusal, and this was the one call in this file that
			// let them escape as a rejection instead of showing them. The
			// irony was sharp: /codecarto-next catches this same throw and tells
			// the user to run /codecarto-complete manually, which then threw.
			let completion: Awaited<ReturnType<typeof autoCompletePhase>>;
			try {
				completion = await autoCompletePhase(ctx.cwd, validation);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				lastFeedbackLines = [`Completion refused: ${message}`];
				setUiState(ctx, currentState, lastFeedbackLines);
				ctx.ui.notify(message, "error");
				return;
			}
			const { updatedState, closeoutNotice, warnings } = completion;

			lastFeedbackLines = [
				`Completed phase: ${validation.phaseId}`,
				`Validation: ${validation.overall}`,
				`Next phase: ${updatedState.status.current_phase}`,
			];
			if (closeoutNotice) lastFeedbackLines.push(closeoutNotice);
			const notes = [...(validation.warnings ?? []), ...warnings];
			for (const note of notes) lastFeedbackLines.push(`NOTE: ${note} Non-gating.`);
			setUiState(ctx, updatedState, lastFeedbackLines);
			ctx.ui.notify(`Marked ${validation.phaseId} complete`, validation.overall === "PASS WITH GAPS" || notes.length > 0 ? "warning" : "info");
			if (closeoutNotice) ctx.ui.notify(closeoutNotice, "info");
			for (const note of notes) ctx.ui.notify(note, "warning");
		},
	});

	pi.registerCommand("codecarto-skill", {
		description: "Run a post-pipeline skill (after all phases are complete): /codecarto-skill <name>",
		handler: async (args, ctx) => {
			const skillName = args.trim();
			if (!skillName) {
				const available = await listSkillNames(join(ctx.cwd, ".codecarto"));
				const hint = available.length > 0 ? ` (available: ${available.join(", ")})` : "";
				ctx.ui.notify(`Usage: /codecarto-skill <name>${hint}`, "warning");
				return;
			}

			// Broad-Side is a reading guide for batch reconnaissance output, not a
			// post-pipeline skill: it is read before or during the pipeline and works
			// on a repository with scout state and no workspace. Same exemption the
			// MCP surface makes in handleSkill.
			if (skillName === BROADSIDE_SKILL_NAME) {
				const skill = await readBroadsideSkill(ctx.cwd).catch(() => null);
				if (!skill) {
					ctx.ui.notify("Broad-Side reading guide not found. Reinstall codecartographer-pi.", "error");
					return;
				}
				const message = [
					"Read the Broad-Side reading guide below and apply it to the batch reconnaissance results in .codecarto/broadside/.",
					"",
					skill.content,
				].join("\n");
				if (ctx.isIdle()) {
					pi.sendUserMessage(message);
				} else {
					pi.sendUserMessage(message, { deliverAs: "followUp" });
				}
				ctx.ui.notify("Queued the Broad-Side reading guide", "info");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const nextPhase = getNextEligiblePhase(state);
			if (nextPhase) {
				ctx.ui.notify(
					`Cannot run skill: pipeline is not complete (next phase: ${nextPhase.id}). Finish the pipeline before running post-pipeline skills.`,
					"error",
				);
				return;
			}

			const skillFile = join(state.workspaceDir, "skills", skillName, "SKILL.md");
			if (!(await pathExists(skillFile))) {
				const available = await listSkillNames(state.workspaceDir);
				const hint = available.length > 0 ? ` (available: ${available.join(", ")})` : " (no skills installed)";
				ctx.ui.notify(
					`Unknown skill: ${skillName}${hint}. The Broad-Side reading guide is served as \`${BROADSIDE_SKILL_NAME}\` and is not pipeline-gated.`,
					"error",
				);
				return;
			}

			const prompt = await buildSkillPrompt(state, skillName);
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}

			lastFeedbackLines = [`Queued post-pipeline skill: ${skillName}`];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`Queued CodeCartographer skill: ${skillName}`, "info");
		},
	});

	pi.registerCommand("codecarto-list-skills", {
		description: "List the post-pipeline skills installed in .codecarto/skills/ (and the ungated Broad-Side reading guide)",
		handler: async (_args, ctx) => {
			// Same gate as /codecarto-skill: the listing reads the workspace's
			// skills directory, so it needs a workspace — mirrors handleListSkills.
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const skills = await listSkillNames(state.workspaceDir);
			const lines = skills.length > 0
				? [`Available skills (${skills.length}):`, ...skills.map((name) => `  - ${name}`)]
				: ["No skills installed."];

			const nextPhase = getNextEligiblePhase(state);
			if (skills.length > 0) {
				lines.push(
					nextPhase
						? `Post-pipeline skills unlock when the pipeline completes (next phase: ${nextPhase.id}).`
						: "Run one with /codecarto-skill <name>.",
				);
			}

			// Broad-Side is listed apart from the post-pipeline set because it
			// answers to /codecarto-skill without the completion gate.
			const broadsideAvailable = await readBroadsideSkill(ctx.cwd).then(() => true, () => false);
			if (broadsideAvailable) {
				lines.push(
					"",
					`Also served by /codecarto-skill (not pipeline-gated): ${BROADSIDE_SKILL_NAME} — how to read a Broad-Side batch reconnaissance run.`,
				);
			}

			lastFeedbackLines = lines;
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(
				skills.length > 0
					? `${skills.length} post-pipeline skill${skills.length === 1 ? "" : "s"}: ${skills.join(", ")}`
					: "No post-pipeline skills installed.",
				"info",
			);
		},
	});

	pi.registerCommand("codecarto-guide", {
		description: "Read the packaged CodeCartographer agent guide into the session: /codecarto-guide [topic]",
		getArgumentCompletions: async (prefix) => {
			const topics = await listGuideTopics().catch(() => ["overview"]);
			const items = topics
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			// The guide is packaged with the extension, not copied into a
			// workspace, so — like codecarto_guide — this needs no workspace.
			let document: GuideDocument;
			let topics: string[];
			try {
				topics = await listGuideTopics();
				document = await readGuide(args.trim() || undefined);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const other = topics.filter((name) => name !== document.topic);
			// Framed, not bare: the guide is MCP-centric text arriving as a user
			// message, so it needs both a "this is reference, not a task" header
			// and a Pi-surface addendum. See guide-framing.ts.
			const message = buildPiGuideMessage(document.content, other);
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}

			lastFeedbackLines = [`Queued the CodeCartographer guide: ${document.topic}`];
			if (codecartoModeActive) void refreshWorkspaceUi(ctx, lastFeedbackLines).catch(() => undefined);
			ctx.ui.notify(`Queued the CodeCartographer guide (${document.topic})`, "info");
		},
	});

	pi.registerCommand("codecarto-broadside", {
		description: "Batch reconnaissance (Broad-Side): /codecarto-broadside [submit|collect|status|models] [lenses…] [flags]",
		getArgumentCompletions: (prefix) => {
			const items = KNOWN_BROADSIDE_TOKENS
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const flags = parseBroadsideFlags(args);
			if (flags.unknown.length > 0) {
				ctx.ui.notify(
					`Unknown /codecarto-broadside argument: ${flags.unknown.join(" ")}. ` +
						`Actions: submit, collect, status, models. Lenses: ${BROADSIDE_LENS_IDS.join(", ")}.`,
					"error",
				);
				return;
			}
			if (flags.error) {
				ctx.ui.notify(flags.error, "error");
				return;
			}

			// Broad-Side runs on any git repository, with or without a workspace —
			// so this command never goes through ensureWorkspaceState.
			const broadsideDir = broadsideDirFor(ctx.cwd);
			const config = await loadBroadsideConfig(broadsideDir);

			const finish = (lines: string[], notice: string, level: "info" | "warning" = "info"): void => {
				lastFeedbackLines = lines;
				if (codecartoModeActive) {
					// A workspace session already has a widget; fold the result into it.
					if (ctx.hasUI) ctx.ui.setWidget(BROADSIDE_WIDGET_ID, undefined);
					void refreshWorkspaceUi(ctx, lines).catch(() => undefined);
				} else if (ctx.hasUI) {
					// Scout-only repository: the Broad-Side widget is the only place
					// the result can live, so it holds it instead of being cleared.
					ctx.ui.setWidget(BROADSIDE_WIDGET_ID, ["Broad-Side", ...lines]);
				}
				ctx.ui.notify(notice, level);
			};

			if (flags.action === "status") {
				const { state } = await runBroadsideStatus(ctx.cwd);
				const runs = state.runs.length;
				finish(
					statusText(state).split("\n"),
					runs > 0 ? `Broad-Side: ${runs} recorded run${runs === 1 ? "" : "s"}` : "Broad-Side: no runs recorded yet",
				);
				return;
			}

			const apiKey = resolveBroadsideKey(config.apiKey);
			if (!apiKey) {
				ctx.ui.notify(
					"No OpenRouter API key. Set OPENROUTER_API_KEY in the environment, or add api_key to " +
						".codecarto/broadside/config.yaml. (A slash command takes no key: it would land in the transcript.)",
					"error",
				);
				return;
			}

			if (flags.action === "models") {
				ctx.ui.notify("Fetching the OpenRouter batch-model catalog…", "info");
				try {
					const { entries, benchmarks } = await listBatchModels(broadsideDir, config, apiKey, {
						includeBenchmarks: flags.benchmarks,
					});
					finish(
						modelsText(entries, { benchmarks, defaultModel: config.model }).split("\n"),
						`Broad-Side: ${entries.length} batch model${entries.length === 1 ? "" : "s"} listed`,
					);
				} catch (error) {
					ctx.ui.notify(`Model catalog lookup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			// Live per-lens progress. Poll callbacks fire often, so they render
			// into a widget rather than a notification stream.
			const progress = new Map<string, string>();
			const renderProgress = (heading: string): void => {
				if (!ctx.hasUI) return;
				ctx.ui.setWidget(BROADSIDE_WIDGET_ID, [
					"Broad-Side",
					heading,
					...[...progress.entries()].map(([lensId, line]) => `  ${lensId}: ${line}`),
				]);
			};
			const onStatus = (lensId: string, status: string, counts: Record<string, unknown>): void => {
				progress.set(lensId, `${status} (${counts.completed ?? 0}/${counts.total ?? "?"})`);
				renderProgress("Polling batches…");
			};

			const waitSeconds = flags.waitSeconds ?? config.waitSeconds;
			const waitMs = waitSeconds > 0 ? waitSeconds * 1000 : undefined;
			const includeSynthesis = flags.includeSynthesis ?? config.includeSynthesis;
			const includeTriage = flags.includeTriage ?? config.includeTriage;
			const retryTruncated = flags.retryTruncated ?? config.retryTruncated;

			if (flags.action === "submit") {
				const lenses = flags.lenses.length > 0 ? flags.lenses : config.defaultLenses;
				renderProgress("Slicing the repository and pricing the run…");
				let submit;
				try {
					submit = await runBroadsideSubmit(ctx.cwd, apiKey, {
						lenses,
						model: config.model,
						maxCost: flags.maxCost ?? config.maxCost,
						// `??`, not `||`: --no-incremental parses to false and must beat a
						// config-set true, exactly as MCP's `incremental: false` does (#163).
						incremental: flags.incremental ?? config.incremental,
						// Pi can ask, so it asks instead of refusing over max_cost the
						// way MCP has to. An approval here IS the force flag.
						confirm: (estimate) =>
							ctx.ui.confirm(
								`Broad-Side will spend about $${estimate.totalCost.toFixed(4)}`,
								describeBroadsideEstimate(estimate),
							),
					});
				} catch (error) {
					if (ctx.hasUI) ctx.ui.setWidget(BROADSIDE_WIDGET_ID, undefined);
					if (error instanceof BroadsideCancelledError) {
						ctx.ui.notify("Broad-Side cancelled. Nothing was submitted.", "info");
						return;
					}
					ctx.ui.notify(`Broad-Side submit failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}

				const lines = estimateSubmitText(submit, lenses.map(getLens)).split("\n");
				if (!waitMs) {
					lines.push("", "Batches are in flight. Run /codecarto-broadside collect when they finish.");
					finish(lines, `Broad-Side submitted: run ${submit.runId} (~$${submit.estimatedTotalCost.toFixed(4)})`);
					return;
				}

				ctx.ui.notify(`Broad-Side submitted run ${submit.runId}; polling for up to ${waitSeconds}s…`, "info");
				try {
					const collect = await runBroadsideCollect(ctx.cwd, apiKey, {
						waitMs,
						includeSynthesis,
						includeTriage,
						retryTruncated,
						onStatus,
					});
					finish([...lines, "", ...collectResultText(collect).split("\n")], `Broad-Side ${collect.status}: run ${collect.runId}`);
				} catch (error) {
					if (ctx.hasUI) ctx.ui.setWidget(BROADSIDE_WIDGET_ID, undefined);
					// The batches are submitted and paid for either way — say so, so
					// nobody re-submits a run that is already in flight.
					ctx.ui.notify(
						`Broad-Side submitted run ${submit.runId}, but collect failed: ` +
							`${error instanceof Error ? error.message : String(error)}. Retry with /codecarto-broadside collect.`,
						"error",
					);
				}
				return;
			}

			// action === "collect"
			renderProgress("Polling batches…");
			try {
				const collect = await runBroadsideCollect(ctx.cwd, apiKey, {
					waitMs,
					includeSynthesis,
					includeTriage,
					retryTruncated,
					onStatus,
				});
				const lines = collectResultText(collect).split("\n");
				const done = collect.status === "completed";
				if (!done) lines.push("", "Still in flight. Run /codecarto-broadside collect again to resume.");
				finish(lines, `Broad-Side ${collect.status}: ${collect.resultCount} result${collect.resultCount === 1 ? "" : "s"} saved`, done ? "info" : "warning");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.setWidget(BROADSIDE_WIDGET_ID, undefined);
				ctx.ui.notify(`Broad-Side collect failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("codecarto-publish", {
		description: "Publish the completed reimplementation spec to the configured CodeCartographer library",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const config = await loadCodecartoConfig(state.workspaceDir);
			if (!config.library.path) {
				ctx.ui.notify("No library.path is configured. Create a library directory with a .codecarto-library marker, then set library.path in ~/.codecarto/config.yaml or .codecarto/workflow/config.yaml.", "error");
				return;
			}
			const marker = await discoverLibrary(config.library.path);
			if (!marker) {
				ctx.ui.notify(`No CodeCartographer library at ${config.library.path} (missing .codecarto-library). Create a .codecarto-library marker file in that directory.`, "error");
				return;
			}

			const phase = resolvePhase(state, "reimplementation-spec");
			if (!phase?.primary_output) {
				ctx.ui.notify("The active pipeline does not produce a reimplementation spec to publish.", "error");
				return;
			}
			const specPath = join(state.workspaceDir, phase.primary_output);
			if (!(await pathExists(specPath))) {
				ctx.ui.notify(`Reimplementation spec is missing: .codecarto/${phase.primary_output}`, "error");
				return;
			}

			const spec = await readFile(specPath, "utf8");
			// The git remote when there is one, the directory otherwise (#147).
			// Slug and source_repo derive from the same value so they agree.
			const source = await resolvePublishSourceRepo(ctx.cwd);
			const slug = deriveSlug(source.source_repo);
			const headline = derivePublishHeadline(spec, ctx.cwd);
			const namespace = marker.namespaced ? config.library.namespace ?? undefined : undefined;
			if (marker.namespaced && !namespace) {
				ctx.ui.notify("The configured library is namespaced; set library.namespace before publishing.", "error");
				return;
			}
			const label = `${namespace ? `${namespace}/` : ""}${slug}`;

			const preview = [
				`Publish ${label} to ${config.library.path}`,
				`Source: ${source.source_repo}${source.remote ? ` (git remote ${source.remote})` : ""}`,
				`Spec: .codecarto/${phase.primary_output}`,
				`Headline: ${headline}`,
				`Provenance: Pi / ${ctx.model?.provider ?? "unknown"} / ${ctx.model?.id ?? "unknown"}`,
			].join("\n");
			if (config.library.publish_confirm && !(await ctx.ui.confirm("Publish reimplementation spec", preview))) return;

			const input: PublishInput = {
				slug,
				namespace,
				source_repo: source.source_repo,
				analyzed_at: new Date().toISOString(),
				pipeline: state.status.pipeline,
				codecarto_version: PACKAGE_VERSION,
				headline,
				tags: [],
				capabilities: [],
				generation: piGeneration(ctx),
			};

			try {
				// Both guards in publishEntry raise before anything is written, and
				// each asks a question only the user can answer, so the command has
				// no flags for them: a yes is the override. The options accumulate,
				// so a publish that trips both guards asks both questions in turn.
				const options: PublishOptions = {};
				let result: PublishResult | undefined;
				while (!result) {
					try {
						result = await publishEntry(config.library.path, spec, input, options);
					} catch (error) {
						if (error instanceof SourceRepoMismatchError && !options.allowSourceRepoChange) {
							// The entry's history belongs to whatever the newest version
							// records. Appending is right only if that repository and this
							// one are the same project under a new address (#146) — which
							// includes the first publish after upgrading from a Pi that
							// recorded the directory to one that records the git remote.
							const moved = await ctx.ui.confirm(
								"Source repository changed — did it move?",
								`Library entry ${label} records source_repo "${error.recorded}", but this publish carries "${error.incoming}". If the repository genuinely moved (rename, org transfer, host change — or this is the first publish since CodeCartographer began recording the git remote instead of the local directory), answer yes and this spec is appended as the entry's next version. If these are two different projects that share a directory name, answer no: nothing is written, and the second project needs a distinct slug (codecarto_publish on MCP accepts one). Did the repository move?`,
							);
							if (!moved) {
								ctx.ui.notify("Publish cancelled. Nothing was written.", "info");
								return;
							}
							options.allowSourceRepoChange = true;
						} else if (error instanceof ConfidentialityMismatchError && !options.allowConfidentialityMismatch) {
							// Pi declares no confidentiality, so the entry sits at the internal
							// default; whether it may go into a wider library is the user's call.
							const publishAnyway = await ctx.ui.confirm(
								"Confidentiality mismatch — publish anyway?",
								`This spec's confidentiality is "${error.entryConfidentiality}" (CodeCartographer's default; /codecarto-publish declares none), but the library "${marker.name}" has visibility "${error.libraryVisibility}". Publishing would expose it to everyone that library reaches. Publish anyway?`,
							);
							if (!publishAnyway) {
								ctx.ui.notify("Publish cancelled. Nothing was written.", "info");
								return;
							}
							options.allowConfidentialityMismatch = true;
						} else {
							throw error;
						}
					}
				}
				lastFeedbackLines = [`Published ${result.namespace ? `${result.namespace}/` : ""}${result.slug} v${result.version}`, result.isNewVersion ? "New content version." : "Metadata-only update (content unchanged)."];
				await writeDashboard(ctx.cwd, PACKAGE_VERSION);
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify(`Published ${result.namespace ? `${result.namespace}/` : ""}${result.slug} v${result.version}.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to publish: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("codecarto-library-init", {
		description: "Initialize a CodeCartographer library and configure it: /codecarto-library-init <path> [--namespace <name>]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const pathArg = parts[0];
			const namespaceIdx = parts.indexOf("--namespace");
			const namespace = namespaceIdx >= 0 ? parts[namespaceIdx + 1] : null;

			if (!pathArg) {
				ctx.ui.notify("Usage: /codecarto-library-init <path> [--namespace <name>]", "warning");
				return;
			}

			const libraryPath = pathArg.startsWith("~") ? join(homedir(), pathArg.slice(1)) : resolve(pathArg);

			try {
				const result = await initLibrary(libraryPath, {
					namespaced: !!namespace,
					...(namespace ? {} : {}),
				});

				// Write the config to the user-global location
				const configPath = resolveUserConfigPath();
				await writeLibraryConfig(configPath, libraryPath, namespace);

				const msg = result.alreadyExisted
					? `Library already exists at ${libraryPath} (marker preserved). Config updated.`
					: `Created library at ${libraryPath} with marker "${result.marker.name}".`;
				lastFeedbackLines = [msg, `Config written to ${configPath}`];
				if (ctx.hasUI) {
					ctx.ui.notify(msg, "info");
					ctx.ui.notify(`Config written to ${configPath}`, "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Library init failed: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("codecarto-config", {
		description: "Show the effective merged CodeCartographer configuration (global + workspace)",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			const config = await loadCodecartoConfig(state ? state.workspaceDir : join(ctx.cwd, ".codecarto"));

			const lines = [
				"Effective CodeCartographer configuration:",
				`  library.path: ${config.library.path ?? "(not set)"}`,
				`  library.namespace: ${config.library.namespace ?? "(not set)"}`,
				`  library.publish_confirm: ${config.library.publish_confirm}`,
				`  orchestrator.llm_steer_next_phase: ${config.orchestrator.llm_steer_next_phase}`,
				"",
				`  User-global config: ${resolveUserConfigPath()}`,
				`  Workspace config: ${state ? join(state.workspaceDir, "workflow/config.yaml") : "(no workspace)"}`,
			];

			if (config.library.path) {
				const marker = await discoverLibrary(config.library.path);
				lines.push(`  Library marker: ${marker ? `found ("${marker.name}", namespaced: ${marker.namespaced})` : "MISSING — run /codecarto-library-init"}`);
			}

			lastFeedbackLines = lines;
			if (state) setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify("Configuration shown in status widget.", "info");
		},
	});

	pi.registerCommand("codecarto-usage", {
		description: "Show cumulative + per-phase token usage from local phase runs",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			const usage = await loadUsage(state.workspaceDir);
			if (usage.runs.length === 0) {
				lastFeedbackLines = ["No phase runs recorded yet."];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify("No phase runs recorded yet.", "info");
				return;
			}

			const totals = computeTotals(usage);
			const perPhase = computePerPhaseTotals(usage);

			const lines: string[] = [];
			lines.push(`Total runs: ${totals.runs}`);
			lines.push(`Total tokens: ${formatUsageTokens(totals.tokens.input)} in · ${formatUsageTokens(totals.tokens.output)} out · ${formatUsageTokens(totals.tokens.cache_write)} cache-write`);
			lines.push(`Total duration: ${formatUsageDuration(totals.duration_ms)} · ${totals.tool_uses} tool uses`);
			lines.push(totals.compaction_runs > 0
				? `Compactions: ${totals.compactions.successful} successful · ${totals.compactions.failed} failed · ${totals.compactions.aborted} aborted`
				: "Compactions: unavailable — historical or host usage records did not report compaction events");
			lines.push("");
			lines.push("Per-phase totals:");
			for (const [phaseId, t] of perPhase) {
				const tokensTotal = t.tokens.input + t.tokens.output;
				lines.push(
					`  ${phaseId}: ${t.runs} run${t.runs === 1 ? "" : "s"} · ${formatUsageTokens(tokensTotal)} tokens · ${t.tool_uses} tool uses · ${t.compaction_runs > 0 ? `${t.compactions.successful + t.compactions.failed + t.compactions.aborted} compactions` : "compactions unavailable"} · ${formatUsageDuration(t.duration_ms)}`,
				);
			}

			lastFeedbackLines = lines;
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify(`CodeCartographer usage: ${totals.runs} run${totals.runs === 1 ? "" : "s"}, ${formatUsageTokens(totals.tokens.input + totals.tokens.output)} tokens total`, "info");
		},
	});

	pi.registerCommand("codecarto-dashboard", {
		description: "Regenerate .codecarto/dashboard.html (use --narrate for an LLM executive summary)",
		getArgumentCompletions: (prefix) => {
			const items = ["--narrate"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const flags = parseDashboardFlags(args);
			if (flags.unknown.length > 0) {
				ctx.ui.notify(`Unknown /codecarto-dashboard flag: ${flags.unknown.join(" ")}`, "error");
				return;
			}

			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			if (flags.narrate) {
				ctx.ui.notify(`Narrating dashboard via LLM…`, "info");
				const result = await narrateDashboard(ctx, state);
				if (result.used) {
					ctx.ui.notify("Narration written to .codecarto/.dashboard-narration.local.md", "info");
				} else {
					ctx.ui.notify(`LLM narration skipped (${result.skipReason}); rendering deterministic dashboard.`, "warning");
				}
			}

			await writeDashboard(ctx.cwd, PACKAGE_VERSION);
			lastFeedbackLines = ["Dashboard regenerated: .codecarto/dashboard.html"];
			setUiState(ctx, state, lastFeedbackLines);
			ctx.ui.notify("Dashboard regenerated: .codecarto/dashboard.html", "info");
		},
	});

	pi.registerCommand("codecarto-refresh-scaffold", {
		description: "Refresh the framework-owned .codecarto/ files (GUIDE.md, templates/, workflow/ pipelines and VALIDATE.md) from the packaged template, after confirming; project state is untouched",
		handler: async (_args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			// Pi can ask, so it shows the exact file set before overwriting
			// anything — MCP's codecarto_refresh_scaffold writes on call.
			let files: string[];
			try {
				files = await listScaffoldRefreshFiles();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const approved = await ctx.ui.confirm(
				"Refresh the .codecarto/ scaffold from the packaged template?",
				describeScaffoldRefreshPreview(files, state.scaffoldVersion),
			);
			if (!approved) {
				ctx.ui.notify("Scaffold refresh cancelled. Nothing was written.", "info");
				return;
			}

			try {
				const result = await refreshScaffold(ctx.cwd);
				const transition = `${result.scaffoldVersionBefore ?? "unversioned"} → ${result.scaffoldVersionAfter}`;
				lastFeedbackLines = [
					`Refreshed ${result.written.length} framework-owned file(s) from the packaged template (${transition}).`,
					"Project state, user config, findings outputs, scratch, closeouts, and orchestrator files were not touched.",
					"THREAD_LOG.md: one scaffold-refresh entry appended.",
				];
				// Re-read state so the widget's staleness line clears with the marker.
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				ctx.ui.notify(`Refreshed ${result.written.length} framework-owned file(s) (${transition}).`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				lastFeedbackLines = [message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(`Scaffold refresh failed: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("codecarto-amend", {
		description: "Apply a post-pipeline amendment from .codecarto/scratch/amendments/, after a preview: /codecarto-amend <name | scratch/amendments/name.yaml>",
		getArgumentCompletions: async (prefix) => {
			const names = await listAmendmentNames(join(sessionCwd ?? process.cwd(), ".codecarto"));
			const items = names
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const state = await ensureWorkspaceState(ctx);
			if (!state) return;

			if (!args.trim()) {
				const staged = await listAmendmentNames(state.workspaceDir);
				const hint = staged.length > 0
					? ` (staged: ${staged.join(", ")})`
					: " — write .codecarto/scratch/amendments/<name>.yaml first (see templates/amendment.yaml)";
				ctx.ui.notify(`Usage: /codecarto-amend <name>${hint}`, "warning");
				return;
			}
			const name = resolveAmendmentName(args, ctx.cwd);
			if (!name) {
				ctx.ui.notify(
					`Amendments are read from .codecarto/scratch/amendments/ only; pass the amendment name or a path inside that directory, not ${args.trim()}.`,
					"error",
				);
				return;
			}

			// The same refusals codecarto_amend surfaces, raised before the
			// confirmation so nobody approves an amendment that cannot apply.
			let amendment: Amendment;
			try {
				amendment = await loadAmendmentFile(name, state.workspaceDir);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const nextPhase = getNextEligiblePhase(state);
			if (nextPhase) {
				ctx.ui.notify(
					`Cannot amend: the pipeline is not complete (next phase: ${nextPhase.id}). `
						+ "Resolve open questions and routed items through that phase's handoff (open_question_closures / carry_forward_closures) instead.",
					"error",
				);
				return;
			}

			// Pi can ask, so the amendment is previewed against status.yaml
			// before anything is written — MCP's codecarto_amend applies on call.
			const approved = await ctx.ui.confirm(
				`Apply amendment "${amendment.slug}"?`,
				describeAmendmentPreview(amendment, state),
			);
			if (!approved) {
				ctx.ui.notify(`Amendment ${amendment.slug} cancelled. Nothing was written.`, "info");
				return;
			}

			try {
				const { applied, closeoutNotice } = await applyAmendment(ctx.cwd, name);
				// An amendment exists precisely to change the numbers the dashboard
				// shows; refresh it, reporting only a render that actually landed.
				const dashboardWritten = await writeDashboard(ctx.cwd, PACKAGE_VERSION);

				const lines = [
					`Amendment applied: ${amendment.slug}`,
					`Open questions closed: ${applied.openQuestionsClosed.length > 0 ? applied.openQuestionsClosed.join(", ") : "none"}`,
					`Post-pipeline items closed: ${applied.postPipelineClosed.length > 0 ? applied.postPipelineClosed.join(", ") : "none"}`,
				];
				if (applied.unknownIds.length > 0) lines.push(`Ids that matched nothing (already closed or unknown): ${applied.unknownIds.join(", ")}`);
				lines.push(closeoutNotice);
				if (dashboardWritten) lines.push("Dashboard refreshed: .codecarto/dashboard.html");

				lastFeedbackLines = lines;
				await refreshWorkspaceUi(ctx, lastFeedbackLines);
				const closed = applied.openQuestionsClosed.length + applied.postPipelineClosed.length;
				ctx.ui.notify(
					`Amendment ${amendment.slug} applied: ${applied.openQuestionsClosed.length} open question(s) and ${applied.postPipelineClosed.length} post-pipeline item(s) closed`
						+ `${applied.unknownIds.length > 0 ? `; ${applied.unknownIds.length} id(s) matched nothing` : ""}.`,
					closed === 0 || applied.unknownIds.length > 0 ? "warning" : "info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				lastFeedbackLines = [message];
				setUiState(ctx, state, lastFeedbackLines);
				ctx.ui.notify(`Amendment failed: ${message}`, "error");
			}
		},
	});
}
