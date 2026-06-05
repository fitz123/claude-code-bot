#!/bin/bash
# start-bot.sh — Launch the Telegram bot daemon
# Called by launchd plist; must work from non-interactive shell context

set -euo pipefail

# Ensure HOME and PATH are set (launchd context may not have them)
export HOME="${HOME:-$(dscl . -read /Users/$(whoami) NFSHomeDirectory | awk '{print $2}')}"
PATH_PREFIX="${MINIME_PATH_PREFIX:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
export PATH="${PATH_PREFIX}${PATH:+:${PATH}}"

# Drop inherited legacy AI runtime environment before boot
for env_name in ${!CLAUDE_CODE_@} ${!ANTHROPIC_@}; do
  unset "$env_name"
done
unset CLAUDECODE

# grammY debug logging — diagnose silent polling stops (bot-ac3)
export DEBUG=grammy:error,grammy:bot

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$BOT_DIR"
exec npx tsx src/main.ts
