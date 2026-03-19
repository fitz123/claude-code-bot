#!/bin/bash
# protect-files.sh — PreToolUse hook
# Blocks writes to protected skill files (for crons/autonomous agents only).

# Fail-closed: if jq is missing, block rather than bypass
if ! command -v jq &>/dev/null; then
    echo "BLOCKED by protect-files: jq not found — cannot parse hook input" >&2
    exit 2
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty') || true

# Fail-closed: if jq failed to parse, FILE_PATH may be empty due to malformed input
# Distinguish "no file_path field" from "parse error" by re-checking jq exit code
if ! echo "$INPUT" | jq -e '.tool_input' &>/dev/null; then
  echo "BLOCKED by protect-files: failed to parse hook input JSON" >&2
  exit 2
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Normalize path: prevent bypass via non-canonical paths
# Collapse multiple slashes: // → /
while [[ "$FILE_PATH" == *//* ]]; do
  FILE_PATH="${FILE_PATH//\/\//\/}"
done
# Collapse /./ → /
while [[ "$FILE_PATH" == *"/./"* ]]; do
  FILE_PATH="${FILE_PATH//\/.\//\/}"
done
# Resolve /component/.. sequences
while [[ "$FILE_PATH" == *"/.."* ]]; do
  _prev="$FILE_PATH"
  FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's|/[^/][^/]*/\.\./|/|;s|/[^/][^/]*/\.\.$||')
  [[ "$FILE_PATH" == "$_prev" ]] && break
done

# Protected: skill files (read-only for crons/autonomous agents)
if [[ "$FILE_PATH" == */.claude/skills/* ]]; then
  if [ -n "$CRON_NAME" ]; then
    echo "Blocked: cron '$CRON_NAME' cannot modify skill files: $FILE_PATH" >&2
    exit 2
  fi
fi

exit 0
