#!/bin/sh
# Consuls agent hook: records agent lifecycle events for the Consuls dashboard.
#
#   chm-hook.sh <harness> <event> [payload-json]
#
# The payload arrives on stdin (Claude Code) or as the last argument (Codex `notify`,
# the omp extension). Contract: never print, never fail, never block the agent — the
# output and exit code of some hooks (e.g. Claude's PermissionRequest/Stop) have meaning.

# tmux panes have $TMUX_PANE; direct (no tmux) shells started by Consuls export CHM_PANE.
pane=${TMUX_PANE:-$CHM_PANE}
[ -n "$pane" ] || exit 0
harness=$1
event=$2
payload=""
if [ -n "$3" ]; then
  payload=$3
elif [ ! -t 0 ]; then
  payload=$(cat 2>/dev/null)
fi

# Pull a string field out of the JSON payload without needing jq.
field() {
  printf '%s' "$payload" | tr -d '\n' | sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" | cut -c1-300 | tr -d '\\'
}

session=$(field session_id)
[ -n "$session" ] || session=$(field thread-id)
transcript=$(field transcript_path)
detail=$(field notification_type)
[ -n "$detail" ] || detail=$(field tool_name)

# CHM_STATE_DIR: set for local (Windows) shells, where $HOME may not be what we expect.
state_dir=${CHM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/consuls}
mkdir -p "$state_dir" 2>/dev/null
ts=$(date +%s 2>/dev/null)
# One short line per event, appended in a single write (atomic below PIPE_BUF).
printf '{"v":1,"ts":%s,"pane":"%s","harness":"%s","event":"%s","detail":"%s","session":"%s","transcript":"%s"}\n' \
  "${ts:-0}" "$pane" "$harness" "$event" "$detail" "$session" "$transcript" \
  >>"$state_dir/events.jsonl" 2>/dev/null

[ -n "$TMUX_PANE" ] && __TMUX__ set-option -p -t "$TMUX_PANE" @chm_state "$event" >/dev/null 2>&1
exit 0
