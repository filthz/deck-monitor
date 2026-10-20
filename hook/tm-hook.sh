#!/bin/sh
# Taskmonitor hook for Claude Code and Qwen Code.
# Usage (in settings.json hooks): /path/to/tm-hook.sh claude|qwen
# Forwards the hook payload to the Taskmonitor server. Never blocks, never fails, prints nothing.

source_name=${1:-claude}
payload=$(cat)
[ -n "$payload" ] || exit 0

port=${TASKMONITOR_PORT:-7777}

json_escape() { printf %s "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/[[:cntrl:]]/ /g'; }

# The hook runs as a child of a shell spawned by the agent; walk up to find the agent process.
find_agent_pid() {
  pid=$PPID
  i=0
  while [ "$i" -lt 4 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null)
    case "$comm" in
      *sh|*/sh|*bash|*zsh|*dash) pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') ;;
      *) printf %s "$pid"; return ;;
    esac
    i=$((i + 1))
  done
  printf %s "$PPID"
}

(
  agent_pid=$(find_agent_pid)
  body=$(printf '{"source":"%s","pid":%s,"term":{"orcaPane":"%s","orcaTab":"%s","emulator":"%s","program":"%s"},"payload":%s}' \
    "$(json_escape "$source_name")" "${agent_pid:-0}" \
    "$(json_escape "${ORCA_PANE_KEY:-}")" "$(json_escape "${ORCA_TAB_ID:-}")" \
    "$(json_escape "${TERMINAL_EMULATOR:-}")" "$(json_escape "${TERM_PROGRAM:-}")" \
    "$payload")
  printf %s "$body" | curl -s -m 2 -X POST -H 'Content-Type: application/json' \
    --data-binary @- "http://127.0.0.1:$port/event" >/dev/null 2>&1
) </dev/null >/dev/null 2>&1 &

exit 0
