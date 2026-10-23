#!/usr/bin/env bash
# Wait until <package>@<version> is visible on npm's read side (#463).
#
# `npm publish` returns before the registry serves the new version: in the
# v0.27.0 release, `npm view codecartographer-pi@0.27.0 --prefer-online` kept
# returning 404 for about 90 s, so the MCP Registry publish that ran seconds
# later failed validation. release.yml runs this between the two steps.
#
# Usage: scripts/wait-for-npm-version.sh <package> <version>
# Env overrides (seconds): NPM_WAIT_TIMEOUT_SECONDS (default 300),
# NPM_WAIT_INTERVAL_SECONDS (default 15), NPM_WAIT_ATTEMPT_TIMEOUT_SECONDS
# (default 30; bounds each `npm view` so npm's own retries cannot stretch the
# overall wait).
set -uo pipefail

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: $0 <package> <version>" >&2
  exit 2
fi

PACKAGE="$1"
VERSION="$2"
TIMEOUT="${NPM_WAIT_TIMEOUT_SECONDS:-300}"
INTERVAL="${NPM_WAIT_INTERVAL_SECONDS:-15}"
ATTEMPT_TIMEOUT="${NPM_WAIT_ATTEMPT_TIMEOUT_SECONDS:-30}"

start=$(date +%s)
deadline=$((start + TIMEOUT))
attempt=0
last_error=""

while :; do
  attempt=$((attempt + 1))
  err_file=$(mktemp)
  got=$(timeout "$ATTEMPT_TIMEOUT" npm view "$PACKAGE@$VERSION" version --prefer-online 2>"$err_file")
  status=$?
  last_error=$(tail -n 5 "$err_file")
  rm -f "$err_file"
  got=$(printf '%s' "$got" | tr -d '[:space:]')

  # Exact match only: an empty result (unknown version of a known package)
  # or any other value is "not visible yet".
  if [ "$status" -eq 0 ] && [ "$got" = "$VERSION" ]; then
    echo "$PACKAGE@$VERSION is visible on npm after $(( $(date +%s) - start ))s (attempt $attempt)"
    exit 0
  fi

  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "::error::$PACKAGE@$VERSION did not appear on the npm registry within ${TIMEOUT}s ($attempt attempts); not publishing to the MCP Registry, which validates against npm. Re-run the job once npm serves the version." >&2
    if [ -n "$last_error" ]; then
      echo "Last npm view error (exit $status):" >&2
      printf '%s\n' "$last_error" >&2
    fi
    exit 1
  fi

  echo "$PACKAGE@$VERSION not visible on npm yet (attempt $attempt, npm view exit $status); retrying in ${INTERVAL}s"
  remaining=$((deadline - now))
  sleep "$(( INTERVAL < remaining ? INTERVAL : remaining ))"
done
