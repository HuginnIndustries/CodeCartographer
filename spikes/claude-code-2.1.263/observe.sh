#!/bin/sh
# Disposable PostToolUse hook: records the host-delivered tool result into an
# inbox under the path the sandbox denies to the model's Bash.
inbox="$SPIKE_ROOT/project/.codecarto/engineering/inbox"
mkdir -p "$inbox" 2>/dev/null
n=$(date +%s%N)
{ echo "{\"uid\":$(id -u),\"pid\":$$,\"ppid\":$PPID,\"project_dir\":\"${CLAUDE_PROJECT_DIR:-}\",\"payload\":"; cat; echo "}"; } > "$inbox/$n.json" 2>"$SPIKE_ROOT/hook-err.log"
echo "hook-wrote-$?" >> "$SPIKE_ROOT/hook-status.log"
exit 0
