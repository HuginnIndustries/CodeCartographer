// Repository intake: file listing, language detection, repo info, glob matching, lens scoping and fallback, file slurping into slices.
//
// Split out of core/broadside.ts (#339); the barrel there re-exports every
// name, so `core/index.ts` and the tests see one module as before.

import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";
import { GIT_TIMEOUT_MS, pathExists } from "../utils.ts";
import { isSecretFile, redactSecrets } from "../secrets.ts";
import { type FileSlice, type RepoInfo, type RepoSnapshotSource } from "./types.ts";
import { type LensDefinition } from "./lenses.ts";

const execFileAsync = promisify(execFile);

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

/**
 * Manifest files and the languages each one can mean. `package.json` covers
 * both TypeScript and JavaScript; which of the two a repository is comes from
 * counting its source files, not from the manifest.
 */
export const MANIFEST_CANDIDATES: ReadonlyArray<readonly [string, readonly string[]]> = [
	["go.mod", ["go"]],
	["package.json", ["typescript", "javascript"]],
	["Cargo.toml", ["rust"]],
	["pyproject.toml", ["python"]],
	["setup.py", ["python"]],
	["requirements.txt", ["python"]],
];

/** The languages Broad-Side can scan; anything else is refused at submit. */
export const BROADSIDE_LANGUAGES = ["go", "python", "rust", "typescript", "javascript"] as const;

/** Chars of the entry-point file and the manifest that ride in the architecture prompt (#249). */
const REPO_INFO_FILE_CAP = 20_000;

const SOURCE_SPECS: Record<string, { glob: string; exts: string[] }> = {
	go: { glob: "**/*.go", exts: [".go"] },
	python: { glob: "**/*.py", exts: [".py"] },
	rust: { glob: "**/*.rs", exts: [".rs"] },
	typescript: { glob: "**/*.ts", exts: [".ts", ".tsx"] },
	javascript: { glob: "**/*.js", exts: [".js", ".jsx"] },
};

/**
 * The files a run scans, and where they came from. Contents are always read
 * from the working tree, so the list is the working tree's too: tracked files
 * plus untracked ones git does not ignore, minus files deleted on disk. The
 * list used to come from `git ls-tree HEAD`, so a run mixed the committed
 * file list with uncommitted contents and never saw an untracked file (#248).
 * A target that is not a git repository gets a bounded walk.
 */
export async function listRepoFiles(targetDir: string): Promise<{ files: string[]; snapshot: RepoSnapshotSource }> {
	try {
		const listed = await execFileAsync(
			"git",
			["-C", targetDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS },
		);
		const deleted = await execFileAsync("git", ["-C", targetDir, "ls-files", "-z", "--deleted"], {
			maxBuffer: 64 * 1024 * 1024,
			timeout: GIT_TIMEOUT_MS,
		});
		const gone = new Set(deleted.stdout.split("\0").filter(Boolean));
		const files = listed.stdout.split("\0").filter((path) => path && !gone.has(path));
		return { files, snapshot: "working-tree" };
	} catch {
		return { files: await walkFiles(targetDir, targetDir, 0, 30_000), snapshot: "walk" };
	}
}

export async function gitHead(targetDir: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", targetDir, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024, timeout: GIT_TIMEOUT_MS });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export async function gitDirty(targetDir: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", targetDir, "status", "--porcelain"], { maxBuffer: 1024 * 1024, timeout: GIT_TIMEOUT_MS });
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Repo-relative paths changed since `baseHead` (or all files when there is
 * no base). Returns null when the diff cannot be computed (non-git tree,
 * missing base commit) so callers fall back to a full scan.
 */
export async function changedFilesSince(targetDir: string, baseHead: string | null): Promise<Set<string> | null> {
	if (!baseHead) return null;
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", targetDir, "diff", "--name-only", baseHead, "HEAD"],
			{ maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS },
		);
		return new Set(stdout.split("\n").filter(Boolean));
	} catch {
		return null;
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
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue;
			if (depth > 8) continue;
			const children = await walkFiles(rootDir, join(dir, entry.name), depth + 1, remaining - out.length);
			out = out.concat(children);
		} else if (entry.isFile()) {
			// relative() rather than slice(rootDir.length + 1): the hand-rolled
			// slice cut one character too many whenever rootDir carried a trailing
			// separator, and mangled every path outright when rootDir was "/".
			const rel = relative(rootDir, join(dir, entry.name)).split("\\").join("/");
			out.push(rel);
		}
	}
	return out;
}

function sourceFileCount(language: string, fileCounts: Record<string, number>): number {
	return (SOURCE_SPECS[language]?.exts ?? []).reduce((sum, ext) => sum + (fileCounts[ext] ?? 0), 0);
}

/**
 * The language the lenses scan as. The manifests present name the candidates
 * (all of them, not the first one found: a Python service with a
 * `package.json` for its docs tooling is not a TypeScript repository), and
 * among candidates the one with the most source files wins; without a
 * manifest, the language with the most source files; without any source
 * file, `unknown` — which submit refuses rather than scanning nothing and
 * paying for it (#250). Ties keep manifest order.
 */
function detectLanguage(fileCounts: Record<string, number>, manifestPaths: string[]): string {
	const candidates: string[] = [];
	for (const [candidate, languages] of MANIFEST_CANDIDATES) {
		if (!manifestPaths.includes(candidate)) continue;
		for (const language of languages) if (!candidates.includes(language)) candidates.push(language);
	}
	const pool = candidates.length > 0 ? candidates : [...BROADSIDE_LANGUAGES];
	let best: string | null = null;
	let bestCount = -1;
	for (const language of pool) {
		const count = sourceFileCount(language, fileCounts);
		if (count > bestCount) {
			best = language;
			bestCount = count;
		}
	}
	if (bestCount > 0) return best!;
	// A manifest with no source files behind it still names the language;
	// submit reports the empty count. No manifest and no source: unknown.
	return candidates[0] ?? "unknown";
}

/** Cut a file that rides whole in a prompt down to the cap, saying so (#249). */
function capForPrompt(content: string, cap: number): string {
	if (content.length <= cap) return content;
	return `${content.slice(0, cap)}\n… [truncated: ${cap.toLocaleString()} of ${content.length.toLocaleString()} chars shown]\n`;
}

export async function collectRepoInfo(targetDir: string, opts: { redact?: boolean } = {}): Promise<RepoInfo> {
	const redact = opts.redact ?? true;
	const { files: allFiles, snapshot } = await listRepoFiles(targetDir);
	// Named credential stores are out of every lens (isSlurpable); listed here
	// so the submit report can say so.
	const secretFilesSkipped = allFiles.filter((path) => isSecretFile(path)).sort();
	let redactedValues = 0;
	// The entry point, manifest, and README ride in the architecture prompt
	// as text, so they get the same pass the slices do (#252).
	const clean = (text: string): string => {
		if (!redact) return text;
		const redaction = redactSecrets(text);
		redactedValues += redaction.count;
		return redaction.text;
	};

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

	// Every manifest present counts toward language detection; the first one
	// found is the one the architecture prompt shows.
	const manifestPaths: string[] = [];
	for (const [candidate] of MANIFEST_CANDIDATES) {
		if (await pathExists(join(targetDir, candidate))) manifestPaths.push(candidate);
	}
	const language = detectLanguage(sortedCounts, manifestPaths);
	// Show the manifest that belongs to the detected language when there is
	// one, so a polyglot repo's prompt does not open with the other stack's file.
	const manifestPath = manifestPaths.find((path) => MANIFEST_CANDIDATES.find(([candidate]) => candidate === path)?.[1].includes(language))
		?? manifestPaths[0]
		?? null;
	let manifest: { path: string; content: string } | null = null;
	if (manifestPath) {
		try {
			manifest = { path: manifestPath, content: capForPrompt(clean(await readFile(join(targetDir, manifestPath), "utf8")), REPO_INFO_FILE_CAP) };
		} catch {
			manifest = null;
		}
	}

	// Read whole and unbounded before, and then estimated at a flat 6,000
	// chars: a large entry point shipped in full while the cap was checked
	// against a number that had nothing to do with it (#249).
	let mainFile = "";
	for (const candidate of ["main.go", "main.py", "src/main.rs", "src/index.ts", "index.ts", "src/index.js", "index.js"]) {
		const p = join(targetDir, candidate);
		if (await pathExists(p)) {
			try {
				mainFile = capForPrompt(clean(await readFile(p, "utf8")), REPO_INFO_FILE_CAP);
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
			readmeFirst = clean((await readFile(readmePath, "utf8")).slice(0, 4000));
		} catch {
			readmeFirst = "";
		}
	}

	const fileTree = buildFileTree(allFiles);

	// An unknown language used to fall through to Go's globs, so the code
	// lenses matched nothing and the run paid for empty batches (#250).
	const sourceSpec = SOURCE_SPECS[language] ?? { glob: "", exts: [] };
	const name = targetDir.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
	const sourceFiles = allFiles.filter((path) => isSlurpable(path) && sourceSpec.exts.some((ext) => path.toLowerCase().endsWith(ext))).length;

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
		sourceFileCount: sourceFiles,
		snapshot,
		secretFilesSkipped,
		redactedValues,
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

export function isSlurpable(relPath: string): boolean {
	// A credential store is never a lens input, whatever its globs say (#252).
	if (isSecretFile(relPath)) return false;
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

export function sanitizeId(segment: string): string {
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

/**
 * "auto" slicing: directory-slice when the repo is large enough that a
 * single whole-repo slice would overflow the lens's char cap, otherwise a
 * single slice. The threshold is the lens's own cap — a repo whose matching
 * files fit in one slice gains nothing from per-module splitting, and a
 * small repo pays for it in extra requests.
 */
function resolveSliceMode(lens: LensDefinition, files: CollectedFile[], totalChars: number): "none" | "directory" {
	if (lens.sliceBy !== "auto") return lens.sliceBy;
	return totalChars > lens.maxChars ? "directory" : "none";
}

function collectFilesMatching(allFiles: string[], lens: LensDefinition, globs: string[]): CollectedFile[] {
	if (globs.length === 0) return [];
	const out: CollectedFile[] = [];
	for (const f of allFiles) {
		if (!isSlurpable(f)) continue;
		if (lens.skipTestFiles && isTestFile(f)) continue;
		if (!matchesAnyGlob(f, globs)) continue;
		out.push({ relPath: f, moduleName: topLevelModule(f) });
	}
	return out;
}

/** Code in any language Broad-Side scans as, whatever this repo's is. */
const SOURCE_EXTENSIONS = new Set(Object.values(SOURCE_SPECS).flatMap((spec) => spec.exts));

function isSourceFile(relPath: string): boolean {
	const dot = relPath.lastIndexOf(".");
	return dot > relPath.lastIndexOf("/") && SOURCE_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/** `a, b, c and 4 more` — a matched-file list short enough for a status line. */
function listSome(paths: string[], max = 3): string {
	if (paths.length <= max) return paths.join(", ");
	return `${paths.slice(0, max).join(", ")} and ${paths.length - max} more`;
}

/**
 * The files a lens will read: its targeted globs, or — when those match no
 * source file and the lens declares a fallback — the fallback globs on top
 * of whatever did match, with a sentence saying so (#319). The sentence
 * travels to the estimate, the batch entry, and the prompt, so a fallback
 * scan is never a silent one.
 *
 * "No source file" rather than "no file": a policy document or a config
 * file under a targeted path satisfies the globs and leaves the lens with
 * nothing to review, and the coverage note it writes back is the only sign.
 */
export function selectLensFiles(
	allFiles: string[],
	lens: LensDefinition,
	info: RepoInfo,
): { files: CollectedFile[]; fallback?: string } {
	const globs = lens.globsFor(info).filter(Boolean);
	const targeted = collectFilesMatching(allFiles, lens, globs);
	if (globs.length === 0 || !lens.fallbackGlobsFor) return { files: targeted };
	if (targeted.some((f) => isSourceFile(f.relPath))) return { files: targeted };
	const fallbackGlobs = lens.fallbackGlobsFor(info).filter(Boolean);
	const matched = new Set(targeted.map((f) => f.relPath));
	const sources = collectFilesMatching(allFiles, lens, fallbackGlobs).filter((f) => !matched.has(f.relPath));
	if (sources.length === 0) return { files: targeted };
	const excluded = lens.skipTestFiles ? "test files excluded" : "";
	const scanned = `scanned all ${info.language} sources (${fallbackGlobs.join(", ")})`;
	return {
		// What did match rides first: the policy the model is about to check
		// the code against, ahead of the code.
		files: [...targeted, ...sources],
		fallback:
			targeted.length === 0
				? `no files matched ${globs.join(", ")}${excluded ? ` (${excluded})` : ""}; ${scanned} instead`
				: `no source files matched ${globs.join(", ")} (only ${listSome(targeted.map((f) => f.relPath))}` +
					`${excluded ? `; ${excluded}` : ""}); ${scanned} as well`,
	};
}


async function slurpFileList(
	targetDir: string,
	files: CollectedFile[],
	maxChars: number,
	redact = true,
): Promise<FileSlice[]> {
	const slices: FileSlice[] = [];
	let currentModule = "";
	let parts: string[] = [];
	let running = 0;
	let fileCount = 0;
	let filePaths: string[] = [];
	let redactedValues = 0;
	let redactedFiles: string[] = [];

	const flush = () => {
		if (parts.length === 0) return;
		slices.push({
			moduleName: currentModule,
			content: parts.join("\n"),
			fileCount,
			chars: running,
			files: filePaths,
			redactedValues,
			redactedFiles,
		});
		parts = [];
		running = 0;
		fileCount = 0;
		filePaths = [];
		redactedValues = 0;
		redactedFiles = [];
	};

	for (const file of files) {
		let content = "";
		try {
			content = await readFile(join(targetDir, file.relPath), "utf8");
		} catch (error) {
			// The listing is the working tree's, so this is a race with a
			// concurrent delete rather than a listed-but-deleted file; skip it.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			content = "[BINARY or UNREADABLE]";
		}
		if (redact) {
			// Before the slice is built, so the count and the chars the estimate
			// sees are of what is actually sent (#252).
			const redaction = redactSecrets(content);
			if (redaction.count > 0) {
				content = redaction.text;
				redactedValues += redaction.count;
				redactedFiles.push(file.relPath);
			}
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
		filePaths.push(file.relPath);
	}
	flush();
	return slices;
}

export async function gatherSlices(targetDir: string, lens: LensDefinition, info: RepoInfo, opts: { redact?: boolean } = {}): Promise<FileSlice[]> {
	const redact = opts.redact ?? true;
	if (lens.sliceBy === "none" && lens.globsFor(info).length === 0) {
		// Repo-info lens (architecture): the prompt is built from info alone.
		return [{ moduleName: "root", content: "", fileCount: 0, chars: 0, files: [] }];
	}
	const { files: allFiles } = await listRepoFiles(targetDir);
	const { files, fallback } = selectLensFiles(allFiles, lens, info);
	const totalChars = await sumFileSizes(targetDir, files);
	const mode = resolveSliceMode(lens, files, totalChars);
	const slices = mode === "none"
		// Whole-repo slice: one module named after the repo, so a small
		// repo produces a single request instead of one per directory.
		? await slurpFileList(targetDir, files.map((f) => ({ ...f, moduleName: info.name })), lens.maxChars, redact)
		: await slurpFileList(targetDir, files, lens.maxChars, redact);
	if (fallback) for (const slice of slices) slice.fallback = fallback;
	return slices;
}

async function sumFileSizes(targetDir: string, files: CollectedFile[]): Promise<number> {
	let total = 0;
	for (const f of files) {
		try {
			total += (await stat(join(targetDir, f.relPath))).size;
		} catch {
			// Unreadable file — slurpFileList substitutes a placeholder.
		}
	}
	return total;
}
