#!/usr/bin/sh
# Disposable PostToolUse/PostToolUseFailure hook: records the host-delivered
# tool result into an inbox under the path the sandbox denies to the model's
# Bash. Fixed PATH and absolute interpreter: nothing it runs resolves through
# a directory the model could write.
PATH=/usr/bin:/bin
export PATH
umask 022
inbox="$SPIKE_ROOT/project/.codecarto/engineering/inbox"
/usr/bin/mkdir -p "$inbox" 2>/dev/null
n=$(/usr/bin/date +%s%N)
{ /usr/bin/echo "{\"uid\":$(/usr/bin/id -u),\"pid\":$$,\"ppid\":$PPID,\"project_dir\":\"${CLAUDE_PROJECT_DIR:-}\",\"payload\":"; /usr/bin/cat; /usr/bin/echo "}"; } > "$inbox/$n.json" 2>"$SPIKE_ROOT/hook-err.log"
/usr/bin/echo "hook-wrote-$?" >> "$SPIKE_ROOT/hook-status.log"
exit 0
