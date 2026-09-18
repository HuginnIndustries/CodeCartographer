#!/usr/bin/sh
# Disposable PostToolUse/PostToolUseFailure hook: records the host-delivered
# tool result into the protected namespace. It runs OUTSIDE the sandbox, so
# every path it writes must be inside the denyWrite set, and it must refuse to
# write through a symlink it did not create:
#   - PATH fixed, absolute interpreter, absolute commands, nothing sourced
#   - set -C (noclobber): every ">" opens with O_CREAT|O_EXCL, which fails on an
#     existing file and on a symlink, dangling or not; no ">>" anywhere
#   - each invocation writes only fresh, uniquely named files
#   - no write outside $ns; stderr goes to a fresh file inside $ns too
PATH=/usr/bin:/bin
export PATH
umask 077
set -C
ns="$SPIKE_ROOT/project/.codecarto/engineering"
inbox="$ns/inbox"
logs="$ns/hook-logs"
for p in "$ns" "$inbox" "$logs"; do [ -L "$p" ] && exit 0; done
/usr/bin/mkdir -p "$inbox" "$logs" 2>/dev/null || exit 0
n="$(/usr/bin/date +%s%N)-$$"
exec 2>"$logs/$n.err" || exit 0
{ /usr/bin/echo "{\"uid\":$(/usr/bin/id -u),\"pid\":$$,\"ppid\":$PPID,\"project_dir\":\"${CLAUDE_PROJECT_DIR:-}\",\"payload\":"; /usr/bin/cat; /usr/bin/echo "}"; } >"$inbox/$n.json"
/usr/bin/echo "hook-wrote-$?" >"$logs/$n.status"
exit 0
