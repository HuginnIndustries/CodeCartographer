// Git-configuration isolation for tests that build real Git fixtures.
//
// Import this FIRST, for its side effects, before any module that shells out
// to git:
//
//     import "./helpers/git-config-isolation.mjs";
//
// Git takes configuration from four environment-reachable sources, and
// neutralizing some of them is not isolation:
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
// Why a module rather than three lines in each test file: this must run
// before the code under test is imported. In ESM, static imports are
// evaluated before the importing module's body, so three lines at module
// scope run AFTER every static import — and in one file they sat after a
// dynamic `await import()` of the module under test. That did not break
// anything at the time (the imported module makes no git call while it is
// being evaluated), so it was a latent hazard rather than a realized
// defect. A side-effect import placed first is ordered by the module system
// instead of by line position, which is the property the guard needs if a
// module under test ever does resolve git configuration at import time.
//
// This only ever writes to `process.env` of the current process. It does not
// read, write, or modify the user's Git configuration.

import { join } from "node:path";
import { tmpdir } from "node:os";

/** A path git will read as empty config. It is never created. */
export const ABSENT_GIT_CONFIG = join(tmpdir(), "codecarto-tests-absent-gitconfig");

/**
 * Neutralize every environment-reachable Git configuration source for this
 * process.
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

isolateGitConfig();
