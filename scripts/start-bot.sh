#!/bin/bash
# start-bot.sh — Launch the Telegram bot daemon
# Called by launchd plist; must work from non-interactive shell context

set -euo pipefail

# Absolute paths — no $HOME, ~, or $USER (launchd context may not have them)
export HOME="/Users/user"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Claude Code CLI subprocess must NOT inherit CLAUDECODE
unset CLAUDECODE

# Read OAuth token from Keychain for Claude CLI subprocess
export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s claude-code-oauth-token -w)

# grammY debug logging — diagnose silent polling stops (bot-ac3)
export DEBUG=grammy:error,grammy:bot
# Claude Code subprocess environment
export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
export CLAUDE_CODE_DISABLE_CRON=1
export CLAUDE_CODE_EXIT_AFTER_STOP_DELAY=900000
export CLAUDE_CODE_ENABLE_TELEMETRY=1

BOT_DIR="/Users/user/.openclaw/bot"

cd "$BOT_DIR"
exec /opt/homebrew/bin/npx tsx src/main.ts
