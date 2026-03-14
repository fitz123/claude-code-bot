#!/usr/bin/env bash
# Ralphex → Telegram notification (bot workspace)
# Receives Result JSON on stdin from ralphex notify system.
# Sends formatted message via deliver.sh + saves to file for agent pickup.

set -euo pipefail

RESULT_FILE="/tmp/ralphex-last-result.json"
DELIVER="/Users/user/.openclaw/bot/scripts/deliver.sh"

# Resolve notification target
NOTIFY_TARGET="${RALPHEX_NOTIFY_TARGET:-}"

if [[ -z "$NOTIFY_TARGET" ]]; then
    _RUN_META="${RALPHEX_RUN_DIR:-}/run.meta"
    if [[ -n "${RALPHEX_RUN_DIR:-}" && -f "$_RUN_META" ]]; then
        _TG=$(grep '^notify_target=' "$_RUN_META" | cut -d= -f2- | head -1 || true)
        [[ -n "$_TG" ]] && NOTIFY_TARGET="$_TG"
    fi
fi

# Default: Minime HQ group, Бот-разработка topic (1890)
[[ -z "$NOTIFY_TARGET" ]] && NOTIFY_TARGET="-1003894624477"
NOTIFY_THREAD="${RALPHEX_NOTIFY_THREAD:-1890}"

# Read JSON from stdin
JSON=$(cat)
_TMP=$(mktemp "${RESULT_FILE}.XXXXXX")
echo "$JSON" > "$_TMP"
mv -f "$_TMP" "$RESULT_FILE"

# Parse fields
STATUS=$(echo "$JSON" | jq -r '.status // "unknown"')
PLAN=$(echo "$JSON" | jq -r '.plan_file // "?"')
BRANCH=$(echo "$JSON" | jq -r '.branch // "?"')
DURATION=$(echo "$JSON" | jq -r '.duration // "?"')
FILES=$(echo "$JSON" | jq -r '.files // 0')
ADDS=$(echo "$JSON" | jq -r '.additions // 0')
DELS=$(echo "$JSON" | jq -r '.deletions // 0')
ERROR=$(echo "$JSON" | jq -r '.error // ""')

# Format message
if [[ "$STATUS" == "success" ]]; then
    MSG="Ralphex complete
Plan: ${PLAN}
Branch: ${BRANCH}
Duration: ${DURATION}
Changes: ${FILES} files (+${ADDS}/-${DELS})"
else
    MSG="Ralphex failed
Plan: ${PLAN}
Branch: ${BRANCH}
Duration: ${DURATION}
Error: ${ERROR}"
fi

# Send via deliver.sh
echo "$MSG" | "$DELIVER" "$NOTIFY_TARGET" --thread "$NOTIFY_THREAD" 2>/dev/null || \
    echo "[WARN] Failed to send Telegram notification" >&2

exit 0
