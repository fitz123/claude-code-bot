#!/bin/bash
# run-cron.sh — Shell wrapper for launchd cron plists
# Usage: run-cron.sh <task-name>
# Sets up environment and runs cron-runner.ts

set -euo pipefail

# Absolute paths — no $HOME, ~, or $USER (launchd context)
export HOME="/Users/ninja"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

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
BOT_DIR="/Users/ninja/.openclaw/bot"

cd "$BOT_DIR"
exec /opt/homebrew/bin/npx tsx src/cron-runner.ts --task "$TASK_NAME"
