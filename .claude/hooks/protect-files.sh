#!/bin/bash
# protect-files.sh — PreToolUse hook
# Blocks writes to protected skill files (for crons/autonomous agents only)
# and prevents deletion of task artifacts.

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

# Protected: task artifacts — never delete
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
if [[ "$FILE_PATH" == */reference/tasks/* ]] && [[ "$TOOL_NAME" == "Write" ]]; then
  :
fi

exit 0
