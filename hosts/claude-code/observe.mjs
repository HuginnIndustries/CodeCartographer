// Claude Code PostToolUse / PostToolUseFailure observer.
//
// Two kinds of event reach it (the settings template wires both):
//   - Bash: an OBSERVATION of the call (command, exit code, output digests);
//   - Edit / Write / MultiEdit / NotebookEdit: an ACTIVITY entry — the fact
//     that a file-changing tool ran, when, and in which session. Nothing
//     from tool_input (no paths, no content) is recorded. The reader uses
//     activity to refuse a check whose run was followed by a tree change
//     before the candidate snapshot was captured (stability, the contract's
//     real signal); it never turns an activity entry into a proof.
//
// This program runs OUTSIDE the model's sandbox (hooks do), so it is the
// trusted half of the `host-tool-result` path and is held to D4/E5:
//
//   - invoked by an ABSOLUTE interpreter from a protected settings file:
//       <node> <hook-dir>/observe.mjs <namespace>
//     No shebang: the interpreter is named in settings, not resolved via PATH.
//   - PATH pinned to /usr/bin:/bin, and never used: this program spawns
//     nothing and sources nothing. Nothing from the payload is executed.
//   - every path it WRITES is inside <namespace> (which is in `denyWrite`):
//       <namespace>/inbox/<stamp>.json        the observation or activity entry
//       <namespace>/hook-logs/<stamp>.status  one line: wrote|refused
//       <namespace>/hook-logs/<stamp>.err     only when something failed
//     each a fresh, uniquely named file opened O_CREAT|O_EXCL|O_NOFOLLOW, so
//     it never truncates or writes through a symlink it did not create.
//   - before ANY write it requires the namespace to be an absolute, already
//     canonical path (`realpathSync(namespace) === namespace`) and, after
//     creating them, the inbox and hook-logs directories to resolve to
//     exactly `<namespace>/inbox` and `<namespace>/hook-logs`. An lstat of
//     the three leaf paths is not enough: a symlinked ANCESTOR (the project's
//     `.codecarto` replaced by a link to elsewhere) leaves every leaf a real
//     directory while redirecting every write. The operator therefore creates
//     `<project>/.codecarto/engineering` as a real directory before the first
//     session; a namespace that does not exist, or resolves elsewhere, is
//     refused with nothing written and one line on stderr.
//   - it records identity and digests of the tool output, never the output
//     itself (hook-logs never carry text derived from the model's command).
//   - it exits 0 in every case: an observer must not block the host.
//
// Requires Node >= 22 (fs.constants.O_NOFOLLOW is POSIX-only; on hosts
// without it the program refuses to write rather than writing unsafely).

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stdin } from "node:process";

process.env.PATH = "/usr/bin:/bin";

const OBSERVATION_SCHEMA = "codecarto.host-observation/1";
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
/** Tools whose completion is recorded as activity (they may change the tree). */
const ACTIVITY_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const namespace = process.argv[2];
if (typeof namespace !== "string" || namespace.length === 0 || !namespace.startsWith("/")) process.exit(0);
const inbox = join(namespace, "inbox");
const logs = join(namespace, "hook-logs");
// The unit test passes an explicit stamp (argv[3]) to prove O_EXCL against a
// pre-created name; the shipped settings template never does, and the
// settings file is in the protected set, so the model cannot pick a name.
const stamp = typeof process.argv[3] === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(process.argv[3]) ? process.argv[3] : `${Date.now()}-${process.hrtime.bigint().toString(36)}-${process.pid}`;

const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_CREAT_EXCL = O_NOFOLLOW === undefined ? undefined : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;

/** Create-only, no-follow, mode 0600. Throws on an existing file or a symlink (dangling or not). */
function writeFresh(path, text) {
	if (O_CREAT_EXCL === undefined) throw new Error("O_NOFOLLOW unavailable on this platform; refusing to write");
	const fd = openSync(path, O_CREAT_EXCL, 0o600);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file after O_EXCL open`);
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

/** Fail closed before anything exists to log into: nothing written, one line on stderr, exit 0. */
function refuseSilently(reason) {
	try {
		process.stderr.write(`observe.mjs: refusing to write: ${reason}\n`);
	} catch {
		/* stderr closed: still exit 0 */
	}
	process.exit(0);
}

/** The canonical path, or null when it does not exist or cannot be resolved. */
function realpathOrNull(path) {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function status(line) {
	try {
		writeFresh(join(logs, `${stamp}.status`), `${line}\n`);
	} catch {
		/* nothing left to write to */
	}
}

function fail(reason) {
	try {
		writeFresh(join(logs, `${stamp}.err`), `${reason}\n`);
	} catch {
		/* ditto */
	}
	status("refused");
	process.exit(0);
}

// The namespace must already exist and be its own canonical path: no symlink
// at any component (an ancestor swap is exactly what this catches), no `..`,
// no trailing slash. Only then are the two leaf directories created, and
// each must resolve to precisely where it was asked to be.
if (realpathOrNull(namespace) !== namespace) refuseSilently("namespace is missing, not canonical, or reached through a symlink");
try {
	mkdirSync(inbox, { recursive: true, mode: 0o700 });
	mkdirSync(logs, { recursive: true, mode: 0o700 });
} catch {
	refuseSilently("could not create inbox/hook-logs");
}
if (realpathOrNull(inbox) !== inbox) refuseSilently("inbox does not resolve to <namespace>/inbox");
if (realpathOrNull(logs) !== logs) refuseSilently("hook-logs does not resolve to <namespace>/hook-logs");

const chunks = [];
let size = 0;
stdin.on("data", (chunk) => {
	size += chunk.length;
	if (size <= MAX_PAYLOAD_BYTES) chunks.push(chunk);
});
stdin.on("end", () => {
	if (size > MAX_PAYLOAD_BYTES) fail(`payload of ${size} bytes exceeds ${MAX_PAYLOAD_BYTES}`);
	let payload;
	try {
		payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		fail(`payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const record = observe(payload);
	if (record === null) fail("payload is not a Bash/Edit/Write/MultiEdit/NotebookEdit PostToolUse/PostToolUseFailure event");
	try {
		writeFresh(join(inbox, `${stamp}.json`), `${JSON.stringify(record, null, "\t")}\n`);
	} catch (error) {
		fail(`inbox write refused: ${error instanceof Error ? error.message : String(error)}`);
	}
	status("wrote");
	process.exit(0);
});

const digest = (text) => ({ digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`, size: Buffer.byteLength(text, "utf8") });
const str = (v) => (typeof v === "string" ? v : "");

/**
 * The observation (Bash), the activity entry (file-changing tools), or null
 * for anything else. Pure: tested black-box by spawning this program (a
 * module import would run it). Exit code: 0 on PostToolUse (Claude Code
 * fires it only for a succeeded call — spike E4b/E4c); on PostToolUseFailure
 * it is parsed from `error: "Exit code N\n..."`, and null when absent (a
 * failure without an exit code, e.g. a denied or interrupted call).
 */
function observe(payload) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
	const event = payload.hook_event_name;
	if (event !== "PostToolUse" && event !== "PostToolUseFailure") return null;
	if (typeof payload.tool_use_id !== "string" || payload.tool_use_id.length === 0) return null;
	const ended = new Date();

	if (ACTIVITY_TOOLS.has(payload.tool_name)) {
		// Only the fact of the call. Nothing from tool_input: no file path,
		// no content, no digest of either — the entry gates, it never proves.
		return {
			schema: OBSERVATION_SCHEMA,
			kind: "activity",
			host: "claude-code",
			event,
			tool_name: payload.tool_name,
			tool_use_id: payload.tool_use_id,
			session_id: str(payload.session_id),
			cwd: str(payload.cwd),
			ended_at: ended.toISOString(),
		};
	}

	if (payload.tool_name !== "Bash") return null;
	const input = payload.tool_input;
	const command = input && typeof input === "object" ? str(input.command) : "";
	if (command.length === 0) return null;

	let exit_code = null;
	let stdout = "";
	let stderr = "";
	if (event === "PostToolUse") {
		exit_code = 0;
		const response = payload.tool_response;
		if (response && typeof response === "object") {
			stdout = str(response.stdout);
			stderr = str(response.stderr);
		}
	} else {
		const error = str(payload.error);
		const m = /^Exit code (\d+)/.exec(error);
		exit_code = m ? Number(m[1]) : null;
		stderr = error;
	}
	const duration = typeof payload.duration_ms === "number" && payload.duration_ms >= 0 ? payload.duration_ms : 0;
	const started = new Date(ended.getTime() - duration);
	return {
		schema: OBSERVATION_SCHEMA,
		host: "claude-code",
		event,
		tool_name: "Bash",
		tool_use_id: payload.tool_use_id,
		session_id: str(payload.session_id),
		cwd: str(payload.cwd),
		command,
		exit_code,
		stdout: digest(stdout),
		stderr: digest(stderr),
		started_at: started.toISOString(),
		ended_at: ended.toISOString(),
		observer: { pid: process.pid, uid: typeof process.getuid === "function" ? process.getuid() : null, project_dir: str(process.env.CLAUDE_PROJECT_DIR) },
	};
}
