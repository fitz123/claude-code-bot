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

# No API key — Max subscription via CLI OAuth
unset ANTHROPIC_API_KEY

# Claude Code subprocess environment
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
export CLAUDE_CODE_DISABLE_CRON=1
export CLAUDE_CODE_SIMPLE=1
export CLAUDE_CODE_ENABLE_TELEMETRY=1

TASK_NAME="${1:?Usage: run-cron.sh <task-name>}"
BOT_DIR="/Users/ninja/.openclaw/bot"

cd "$BOT_DIR"
exec /opt/homebrew/bin/npx tsx src/cron-runner.ts --task "$TASK_NAME"
