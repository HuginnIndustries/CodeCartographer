// Git-environment isolation for tests that build real Git fixtures.
//
// Import this FIRST, for its side effects, before any module that shells out
// to git:
//
//     import "./helpers/git-environment-isolation.mjs";
//
// The guarantee: fixture git commands see nothing of the developer's
// environment. Not their configuration, not their init template, not a
// repository they happen to have exported. The first version of this helper
// (#412, #421) was named for configuration alone and covered exactly that;
// #423 found that configuration is one member of a wider class — environment
// variables the developer set for their own reasons that change what a
// fixture git command does — and that naming the helper for the class makes
// the next gap easier to notice.
//
// CONFIGURATION. Git takes configuration from four environment-reachable
// sources, and neutralizing some of them is not isolation:
//
//   1. the system config file    -> GIT_CONFIG_SYSTEM
//   2. the global config file    -> GIT_CONFIG_GLOBAL
//   3. config injected through the environment
//                                -> GIT_CONFIG_COUNT / _KEY_n / _VALUE_n
//   4. config git passes to its own subprocesses
//                                -> GIT_CONFIG_PARAMETERS
//
// The first two are FILE lookups, so pointing them at a path that does not
// exist makes git read them as empty. The third is not a file at all — git
// reports its origin as `command line:` — so redirecting file lookups cannot
// reach it. A contributor whose environment supplies, say,
//
//     url.https://github.com/.insteadOf = git@github.com:
//
// (a common setup that routes SSH-syntax traffic over HTTPS) would still see
// that rewrite applied to fixture remotes, and
// `resolvePublishSourceRepo records origin's fetch URL verbatim` would fail
// on their machine while staying green on CI's bare runners. Setting
// GIT_CONFIG_COUNT=0 tells git there are zero injected entries, which
// neutralizes the whole GIT_CONFIG_KEY_n/VALUE_n set regardless of how many
// were supplied.
//
// The fourth is how git hands `-c key=value` down to the subprocesses it
// spawns, so it arrives without anyone setting it deliberately: run the suite
// under `git -c … <alias>`, or inside `git bisect run`, and every fixture
// command inherits it. It carries its own count, so GIT_CONFIG_COUNT=0 does
// not disarm it. Deleting it and setting it to "" both work — git reads an
// empty string as no entries — but deleting is what the name of the
// operation should say: the variable has no business being in the
// environment of a fixture command at all.
//
// TEMPLATE INJECTION (#423). GIT_TEMPLATE_DIR is not configuration, but git
// copies that directory — hooks/ included — into every `git init`. A
// developer who keeps an executable hooks/pre-commit in their template
// installs it into every fixture repository the suite creates, and every
// fixture that commits runs it. A hook that exits non-zero fails the fixture
// commit loudly; a hook that succeeds runs the developer's code inside the
// suite silently. Deleted: fixtures get git's default (built-in) template.
//
// REPOSITORY LOCATION. GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR,
// GIT_NAMESPACE and GIT_CEILING_DIRECTORIES all override how git locates the
// repository (or parts of it) that a command acts on. They override `-C` and
// cwd both: with GIT_DIR exported, `git -C fixture init` initializes the
// exported repository instead and `git -C fixture remote add` writes into
// it. Git exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE itself into the
// hooks and commands it runs, so a developer running the suite from inside
// `git rebase -x`, a hook, or a `git bisect run` inherits them without
// having typed them. Deleted: a fixture command's repository is the one its
// `-C` / cwd names, and nothing else.
//
// EDITORS AND PROMPTS. GIT_EDITOR, GIT_SEQUENCE_EDITOR, GIT_PAGER,
// GIT_ASKPASS, GIT_SSH and GIT_SSH_COMMAND name programs git would run on
// the developer's behalf. Fixtures pass `-m`, never page, and never reach a
// remote, so today none of these are consulted — but the first fixture that
// runs an interactive-capable command would open the developer's editor and
// hang the suite. GIT_EDITOR and GIT_SEQUENCE_EDITOR are set to `:` (the
// shell no-op, which git accepts as "take the message as-is");
// GIT_TERMINAL_PROMPT is set to 0 so a credential prompt fails instead of
// waiting on a terminal nobody is watching. GIT_PAGER, GIT_ASKPASS, GIT_SSH
// and GIT_SSH_COMMAND are deleted. EDITOR / VISUAL are the generic
// fallbacks git consults after GIT_EDITOR, so setting GIT_EDITOR shadows
// them without touching variables other tools own.
//
// LEFT ALONE, deliberately:
//
//   - GIT_AUTHOR_* / GIT_COMMITTER_*: fixtures set user.name/user.email in
//     the repository config, which these would override — but they only
//     change WHO the commit says it is from, and no test asserts on author
//     identity or date. CI runners set them for reproducible timestamps;
//     clobbering them would remove a property the developer may want.
//   - GIT_TRACE*, GIT_FLUSH, GIT_PROGRESS_DELAY, GIT_ADVICE: diagnostics
//     that write to stderr and change no command's outcome. A developer
//     debugging the suite wants them to reach fixture commands.
//   - GIT_DEFAULT_HASH, GIT_DEFAULT_REF_FORMAT: change the on-disk format
//     of new fixture repositories. Nothing asserts on object IDs or ref
//     storage, and the values are ones the developer chose for every new
//     repository on purpose — the suite should pass under them.
//   - GIT_EXEC_PATH, PATH, HOME: which git binary runs, and where. Out of
//     scope: the suite runs whichever git is on PATH, by design.
//   - GIT_EXTERNAL_DIFF, GIT_DIFF_OPTS: only reach `git diff` in porcelain
//     form; fixtures use `--porcelain` / `--name-only` plumbing, which
//     ignores them.
//
// Why a module rather than a handful of lines in each test file: this must
// run before the code under test is imported. In ESM, static imports are
// evaluated before the importing module's body, so lines at module scope run
// AFTER every static import — and in one file they sat after a dynamic
// `await import()` of the module under test. That did not break anything at
// the time (the imported module makes no git call while it is being
// evaluated), so it was a latent hazard rather than a realized defect. A
// side-effect import placed first is ordered by the module system instead of
// by line position, which is the property the guard needs if a module under
// test ever does resolve git configuration at import time.
//
// This only ever writes to `process.env` of the current process. It does not
// read, write, or modify the user's Git configuration, template, or
// repositories.

import { join } from "node:path";
import { tmpdir } from "node:os";

/** A path git will read as empty config. It is never created. */
export const ABSENT_GIT_CONFIG = join(tmpdir(), "codecarto-tests-absent-gitconfig");

/**
 * Environment variables that redirect a git command away from the repository
 * its `-C` / cwd names. Git exports several of these into its own hooks and
 * subcommands, so a suite run from inside `git rebase -x` or a hook inherits
 * them without anyone typing them.
 */
export const GIT_LOCATION_VARIABLES = Object.freeze([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
]);

/**
 * Environment variables that name a program git would run on the developer's
 * behalf. Fixtures never need one; a developer's would hang or reach out.
 */
export const GIT_PROGRAM_VARIABLES = Object.freeze(["GIT_PAGER", "GIT_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND"]);

/**
 * Neutralize every environment-reachable Git configuration source for this
 * process.
 *
 * Kept under its original name so callers that want configuration isolation
 * alone (none in-tree today) still have it. `isolateGitEnvironment` is the
 * full guarantee and is what the side-effect import applies.
 *
 * Idempotent, and safe to call from a child process that inherited an
 * injected environment: the point is to overwrite what was inherited.
 */
export function isolateGitConfig(env = process.env) {
	env.GIT_CONFIG_GLOBAL = ABSENT_GIT_CONFIG;
	env.GIT_CONFIG_SYSTEM = ABSENT_GIT_CONFIG;
	// Zero injected entries. Git stops reading GIT_CONFIG_KEY_n/VALUE_n
	// entirely, so any number of already-set pairs become inert; deleting
	// them one by one would require knowing the original count.
	env.GIT_CONFIG_COUNT = "0";
	// This variable carries its own entries, so GIT_CONFIG_COUNT cannot
	// disarm it. Deleted rather than blanked: it should not be in a fixture
	// command's environment at all.
	delete env.GIT_CONFIG_PARAMETERS;
	return env;
}

/**
 * Neutralize everything in the developer's environment that changes what a
 * fixture git command does: configuration, the init template, repository
 * location overrides, and the programs git would run on the developer's
 * behalf.
 *
 * Idempotent, and safe to call from a child process that inherited an
 * injected environment.
 */
export function isolateGitEnvironment(env = process.env) {
	isolateGitConfig(env);
	// Git copies this directory, hooks/ included, into every `git init`.
	// Deleted so fixtures get git's built-in default template (#423).
	delete env.GIT_TEMPLATE_DIR;
	// Each of these overrides the repository a command acts on, beating both
	// `-C` and cwd. Git exports some of them into its own hooks and
	// subcommands, so they arrive without being typed.
	for (const name of GIT_LOCATION_VARIABLES) delete env[name];
	// Programs git would launch for the developer. None are wanted here.
	for (const name of GIT_PROGRAM_VARIABLES) delete env[name];
	// `:` is the shell no-op; git treats it as "accept the message as-is",
	// so an interactive-capable command completes instead of opening the
	// developer's editor and waiting. Shadows EDITOR / VISUAL without
	// touching them.
	env.GIT_EDITOR = ":";
	env.GIT_SEQUENCE_EDITOR = ":";
	// A credential prompt fails fast instead of waiting on a terminal.
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

isolateGitEnvironment();
