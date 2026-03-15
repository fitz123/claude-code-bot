#!/bin/bash
# deliver.sh — Send a message to Telegram via Bot API
# Usage: deliver.sh <chat_id> [message]
# Or:    deliver.sh <chat_id> --thread <thread_id> [message]
# Or:    echo "message" | deliver.sh <chat_id> [--thread <thread_id>]
# Handles >4096 char messages by splitting at paragraph boundaries.

set -euo pipefail

# Resolve project root for HTML converter
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CHAT_ID="${1:?Usage: deliver.sh <chat_id> [--thread <thread_id>] [message]}"
shift

# Validate chat_id is numeric (prevents JSON injection)
[[ "$CHAT_ID" =~ ^-?[0-9]+$ ]] || { echo "[deliver] Error: invalid chat_id: $CHAT_ID" >&2; exit 1; }

THREAD_ID=""
if [ "${1:-}" = "--thread" ]; then
  THREAD_ID="${2:-}"
  shift 2
  [[ -z "$THREAD_ID" || "$THREAD_ID" =~ ^[0-9]+$ ]] || { echo "[deliver] Error: invalid thread_id: $THREAD_ID" >&2; exit 1; }
fi

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

# Convert markdown to HTML (same converter as the bot's interactive path)
PARSE_MODE=""
ORIGINAL_MESSAGE="$MESSAGE"
TSX_BIN="$BOT_DIR/node_modules/.bin/tsx"
CONVERTER="$BOT_DIR/src/markdown-html-cli.ts"
if [ -x "$TSX_BIN" ] && [ -f "$CONVERTER" ]; then
  HTML_MESSAGE=$("$TSX_BIN" "$CONVERTER" <<< "$MESSAGE" 2>/dev/null) || HTML_MESSAGE=""
  if [ -n "$HTML_MESSAGE" ]; then
    MESSAGE="$HTML_MESSAGE"
    PARSE_MODE="HTML"
  else
    echo "[deliver] warn: HTML converter returned empty output, sending plain text" >&2
  fi
fi

# Token from Keychain
TOKEN="$(security find-generic-password -s 'telegram-bot-token' -w 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  echo "[deliver] Error: failed to read Telegram token from Keychain" >&2
  exit 1
fi

API="https://api.telegram.org/bot${TOKEN}"
LOG_DIR="/Users/user/.openclaw/logs"
LOG_FILE="${LOG_DIR}/cron-delivery.log"
mkdir -p "$LOG_DIR"

build_payload() {
  local text_json="$1" parse_mode="${2:-}"
  local payload
  payload=$(printf '{"chat_id":%s,"text":%s' "$CHAT_ID" "$text_json")
  [ -n "$parse_mode" ] && payload="${payload},\"parse_mode\":\"${parse_mode}\""
  [ -n "$THREAD_ID" ] && payload="${payload},\"message_thread_id\":${THREAD_ID}"
  printf '%s}' "$payload"
}

send_message() {
  local text="$1"
  local text_json
  text_json=$(echo "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  local response
  response=$(curl -s -X POST "${API}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(build_payload "$text_json" "$PARSE_MODE")")

  local ok
  ok=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)

  if [ "$ok" != "True" ]; then
    # Retry without parse_mode using the same chunk as plain text
    text_json=$(echo "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
    response=$(curl -s -X POST "${API}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "$(build_payload "$text_json")")

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
      # Walk back to start of newline run (matches stream-relay.ts behavior)
      while [ "$split_pos" -gt 0 ] && [ "${remaining:$((split_pos - 1)):1}" = $'\n' ]; do
        split_pos=$((split_pos - 1))
      done
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
