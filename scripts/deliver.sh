#!/bin/bash
# deliver.sh — Send a message to Telegram via Bot API
# Usage: deliver.sh <chat_id> [message]
# Or:    echo "message" | deliver.sh <chat_id>
# Handles >4096 char messages by splitting at paragraph boundaries.

set -euo pipefail

CHAT_ID="${1:?Usage: deliver.sh <chat_id> [message]}"
shift

# Get message from args or stdin
if [ $# -gt 0 ]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  echo "[deliver] Error: empty message" >&2
  exit 1
fi

# Token from Keychain
TOKEN="$(security find-generic-password -s 'telegram-bot-token' -w 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  echo "[deliver] Error: failed to read Telegram token from Keychain" >&2
  exit 1
fi

API="https://api.telegram.org/bot${TOKEN}"
LOG_DIR="/Users/ninja/.openclaw/logs"
LOG_FILE="${LOG_DIR}/cron-delivery.log"
mkdir -p "$LOG_DIR"

send_message() {
  local text="$1"
  local response
  response=$(curl -s -X POST "${API}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"chat_id":%s,"text":%s,"parse_mode":"Markdown"}' "$CHAT_ID" "$(echo "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')")")

  local ok
  ok=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)

  if [ "$ok" != "True" ]; then
    # Retry without parse_mode in case of markdown errors
    response=$(curl -s -X POST "${API}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "$(printf '{"chat_id":%s,"text":%s}' "$CHAT_ID" "$(echo "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')")")

    ok=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
    if [ "$ok" != "True" ]; then
      echo "[deliver] $(date -Iseconds) FAIL chat=$CHAT_ID response=$response" >> "$LOG_FILE"
      echo "[deliver] Error: sendMessage failed: $response" >&2
      return 1
    fi
  fi

  echo "[deliver] $(date -Iseconds) OK chat=$CHAT_ID len=${#text}" >> "$LOG_FILE"
}

MAX_LEN=4096

if [ ${#MESSAGE} -le $MAX_LEN ]; then
  send_message "$MESSAGE"
else
  # Split at paragraph boundaries (double newline), respecting max length
  remaining="$MESSAGE"
  while [ ${#remaining} -gt 0 ]; do
    if [ ${#remaining} -le $MAX_LEN ]; then
      send_message "$remaining"
      break
    fi

    # Find last double-newline within limit
    chunk="${remaining:0:$MAX_LEN}"
    split_pos=$(echo "$chunk" | grep -b -o $'\n\n' | tail -1 | cut -d: -f1 || echo "")

    if [ -n "$split_pos" ] && [ "$split_pos" -gt 100 ]; then
      send_message "${remaining:0:$split_pos}"
      remaining="${remaining:$((split_pos + 2))}"
    else
      # No good split point — split at last newline
      split_pos=$(echo "$chunk" | grep -b -o $'\n' | tail -1 | cut -d: -f1 || echo "")
      if [ -n "$split_pos" ] && [ "$split_pos" -gt 100 ]; then
        send_message "${remaining:0:$split_pos}"
        remaining="${remaining:$((split_pos + 1))}"
      else
        # Hard split at max length
        send_message "${remaining:0:$MAX_LEN}"
        remaining="${remaining:$MAX_LEN}"
      fi
    fi

    # Brief pause between split messages to maintain order
    sleep 0.3
  done
fi
