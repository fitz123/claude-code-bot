#!/bin/bash
# auto-stage.sh — PostToolUse hook for Edit|Write
# Stages changed files (git add) so the agent can commit with meaningful messages.
# Cron sessions (CRON_NAME set) still auto-commit since they're one-shot.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Skip if not inside a git repo
if ! git -C "$(dirname "$FILE_PATH")" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Skip temporary files
if [[ "$FILE_PATH" == /tmp/* ]] || [[ "$FILE_PATH" == */node_modules/* ]]; then
  exit 0
fi

# Stage the file
git -C "$(dirname "$FILE_PATH")" add "$FILE_PATH" 2>/dev/null

# Cron sessions: auto-commit immediately (one-shot lifecycle, no agent to commit later)
# CRON_NAME can be set by the caller to enable auto-commit in one-shot sessions
if [ -n "$CRON_NAME" ]; then
  if ! git -C "$(dirname "$FILE_PATH")" diff --cached --quiet 2>/dev/null; then
    REL_PATH=$(git -C "$(dirname "$FILE_PATH")" ls-files --full-name "$FILE_PATH" 2>/dev/null)
    REL_PATH="${REL_PATH:-$(basename "$FILE_PATH")}"
    # --no-verify: cron sessions are one-shot with no agent to retry on hook failure
    git -C "$(dirname "$FILE_PATH")" commit -m "auto: update $REL_PATH" --no-verify
  fi
fi

exit 0
