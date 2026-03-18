#!/bin/bash
# Discover recent human session JSONL files for a workspace.
# Usage: discover-sessions.sh WORKSPACE_PATH
# Output: newline-separated list of human session JSONL file paths (last 48h)
#
# Environment:
#   CLAUDE_SESSIONS_BASE — override session directory root (default: ~/.claude/projects)
#                          Useful for testing without touching real session files.
set -euo pipefail

# Fail loudly if jq is not available — silent skip would look like "no sessions"
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not found in PATH" >&2
  exit 1
fi

WORKSPACE_PATH="${1:?Usage: discover-sessions.sh WORKSPACE_PATH}"

# Resolve to absolute path
if [ -d "$WORKSPACE_PATH" ]; then
  WORKSPACE_PATH="$(cd "$WORKSPACE_PATH" && pwd)"
fi

# Session directory base — override with CLAUDE_SESSIONS_BASE for testing
SESSIONS_BASE="${CLAUDE_SESSIONS_BASE:-$HOME/.claude/projects}"

# Convert workspace path to Claude Code's session directory format:
# Replace / and . with - (e.g., /home/user/.config/ws → -home-user--config-ws)
SESSION_DIR_NAME=$(printf '%s' "$WORKSPACE_PATH" | sed 's|[/.]|-|g')
SESSION_DIR="${SESSIONS_BASE}/${SESSION_DIR_NAME}"

if [ ! -d "$SESSION_DIR" ]; then
  # No session directory — not an error, just no sessions
  exit 0
fi

# Find JSONL files modified in the last 48 hours
find "$SESSION_DIR" -maxdepth 1 -name "*.jsonl" -mtime -2 -type f 2>/dev/null | while read -r jsonl_file; do
  # Check if this is a human session by examining the first line
  first_line=$(head -1 "$jsonl_file" 2>/dev/null) || continue

  # Extract content field from the first line using jq
  content=$(printf '%s' "$first_line" | jq -r '.content // empty' 2>/dev/null) || continue

  # Human sessions start with [Chat:
  case "$content" in
    "[Chat:"*) echo "$jsonl_file" ;;
    *) ;;
  esac
done
