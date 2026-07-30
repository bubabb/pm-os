#!/usr/bin/env bash
# Append one memory event to the local spool. Called by hooks, so its contract is: NEVER block,
# NEVER fail, NEVER touch the network.
#
# WHY A SPOOL AND NOT A DIRECT INSERT: a hook runs on the critical path of a tool call. A synchronous
# write to Supabase puts a network round-trip there — the pooler waking up, a flaky link, or a paused
# free-tier instance would stall or drop the event, and offline work would be lost outright. Appending
# a line to a local file is a filesystem write: it works on a plane, and `memory-sync.py` flushes it
# on the next Stop hook or `make memory-sync`. The database lags by at most one session; nothing is
# ever lost.
#
# The append is a single `printf` under O_APPEND. Writes below PIPE_BUF (4096 on Linux) are atomic,
# so concurrent hooks interleave whole lines rather than corrupting each other. A line longer than
# that could in principle tear — memory-sync.py skips any line that fails to parse rather than
# stalling every event behind it.
#
# Usage:
#   memory-spool.sh <table> <json-object>
#   memory-spool.sh agent_run '{"project_id":"...","agent":"skeptic","asked":"...","resolved":false,"next_steps":"..."}'
#
# Exits 0 in every failure path ON PURPOSE: a broken spool must never break the session that
# feeds it. Problems are reported to stderr, where a hook's output is visible, and dropped.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # this script's project — never CLAUDE_PROJECT_DIR
SPOOL="$ROOT/.memory-spool.jsonl"
MAX_BYTES=${MEMORY_SPOOL_MAX_BYTES:-5242880}   # 5 MB: a runaway hook must not fill the disk

table="${1:-}"; row="${2:-}"
[ -n "$table" ] && [ -n "$row" ] || { echo "memory-spool: usage: memory-spool.sh <table> <json>" >&2; exit 0; }

# Only tables that exist in the project schema. An unknown name here is a caller bug; recording it
# would just make memory-sync skip the line later, so reject it where the mistake is visible.
case "$table" in
  session|request|delegation|agent_run|review_finding|audit_event) ;;
  *) echo "memory-spool: unknown table '$table' — dropped" >&2; exit 0 ;;
esac

# Validate the JSON if jq is available. If it is not, write anyway: a missing linter is not a reason
# to lose an event, and memory-sync.py skips unparseable lines on the way in.
if command -v jq >/dev/null 2>&1; then
  if ! printf '%s' "$row" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "memory-spool: row is not a JSON object — dropped" >&2; exit 0
  fi
  line=$(jq -cn --arg t "$table" --argjson r "$row" '{table:$t, row:$r}' 2>/dev/null)
else
  line="{\"table\":\"$table\",\"row\":$row}"
fi
[ -n "${line:-}" ] || exit 0

if [ -f "$SPOOL" ]; then
  size=$(wc -c < "$SPOOL" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt "$MAX_BYTES" ]; then
    echo "memory-spool: spool over ${MAX_BYTES}B — run 'make memory-sync' to flush; event dropped" >&2
    exit 0
  fi
fi

printf '%s\n' "$line" >> "$SPOOL" 2>/dev/null || true
exit 0
