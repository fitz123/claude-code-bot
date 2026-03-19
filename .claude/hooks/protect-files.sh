#!/bin/bash
# protect-files.sh — PreToolUse hook
# Blocks writes to protected skill files (for crons/autonomous agents only).

# Fail-closed: if jq is missing, block rather than bypass
if ! command -v jq &>/dev/null; then
    echo "BLOCKED by protect-files: jq not found — cannot parse hook input" >&2
    exit 2
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Protected: skill files (read-only for crons/autonomous agents)
if [[ "$FILE_PATH" == */.claude/skills/* ]]; then
  if [ -n "$CRON_NAME" ]; then
    echo "Blocked: cron '$CRON_NAME' cannot modify skill files: $FILE_PATH" >&2
    exit 2
  fi
fi

exit 0
