// Git-configuration isolation for tests that build real Git fixtures.
//
// Import this FIRST, for its side effects, before any module that shells out
// to git:
//
//     import "./helpers/git-config-isolation.mjs";
//
// Git takes configuration from three independent sources, and neutralizing
// two of them is not isolation:
//
//   1. the system config file    -> GIT_CONFIG_SYSTEM
//   2. the global config file    -> GIT_CONFIG_GLOBAL
//   3. config injected through the environment
//                                -> GIT_CONFIG_COUNT / _KEY_n / _VALUE_n
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
// Why a module rather than three lines in each test file: this must run
// before the code under test is imported. In ESM, static imports are
// evaluated before the importing module's own body, so three lines at module
// scope run AFTER every static import — and in one file they sat after a
// dynamic `await import()` of the module under test. A side-effect import
// placed first is ordered by the module system instead of by line position,
// which is the property the guard actually needs.
//
// This only ever writes to `process.env` of the current process. It does not
// read, write, or modify the user's Git configuration.

import { join } from "node:path";
import { tmpdir } from "node:os";

/** A path git will read as empty config. It is never created. */
export const ABSENT_GIT_CONFIG = join(tmpdir(), "codecarto-tests-absent-gitconfig");

/**
 * Neutralize all three Git configuration sources for this process.
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
	return env;
}

isolateGitConfig();
