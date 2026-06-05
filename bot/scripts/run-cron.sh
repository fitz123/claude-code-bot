#!/bin/bash
# run-cron.sh — Shell wrapper for launchd cron plists
# Usage: run-cron.sh <task-name>
# Sets up environment and runs cron-runner.ts

set -euo pipefail

# Ensure HOME and PATH are set (launchd context may not have them)
export HOME="${HOME:-$(dscl . -read /Users/$(whoami) NFSHomeDirectory | awk '{print $2}')}"
PATH_PREFIX="${MINIME_PATH_PREFIX:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
export PATH="${PATH_PREFIX}${PATH:+:${PATH}}"

# Drop inherited legacy AI runtime environment before cron execution
for env_name in ${!CLAUDE_CODE_@} ${!ANTHROPIC_@}; do
  unset "$env_name"
done
unset CLAUDECODE

TASK_NAME="${1:?Usage: run-cron.sh <task-name>}"
export CRON_NAME="$TASK_NAME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$BOT_DIR"
exec npx tsx src/cron-runner.ts --task "$TASK_NAME"
