#!/bin/bash
# run-cron.sh — Shell wrapper for launchd cron plists
# Usage: run-cron.sh <task-name>
# Sets up environment and runs cron-runner.ts

set -euo pipefail

# Ensure HOME and PATH are set (launchd context may not have them)
export HOME="${HOME:-$(dscl . -read /Users/$(whoami) NFSHomeDirectory | awk '{print $2}')}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# Claude Code subprocess must NOT inherit CLAUDECODE
unset CLAUDECODE

# Read OAuth token from Keychain for Claude CLI subprocess
export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s claude-code-oauth-token -w)
unset ANTHROPIC_API_KEY

# Claude Code subprocess environment
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
export CLAUDE_CODE_DISABLE_CRON=1
export CLAUDE_CODE_SIMPLE=1
export CLAUDE_CODE_ENABLE_TELEMETRY=1

TASK_NAME="${1:?Usage: run-cron.sh <task-name>}"
export CRON_NAME="$TASK_NAME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$BOT_DIR"
exec /opt/homebrew/bin/npx tsx src/cron-runner.ts --task "$TASK_NAME"
