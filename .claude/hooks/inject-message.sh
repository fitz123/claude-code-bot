#!/bin/bash
# inject-message.sh — PreToolUse hook for mid-turn message injection.
#
# When the user sends a message while the agent is working (doing tool calls),
# the bot writes it to an inject file. This hook reads it before each tool call
# and returns it as additionalContext so the agent sees the message mid-turn.
#
# Install: register as a wildcard ("*") PreToolUse hook in .claude/settings.json
# Env: BOT_INJECT_DIR must be set by the bot at subprocess spawn time.
#
# File protocol:
#   $BOT_INJECT_DIR/pending              — user messages from bot (line 1 = count, line 2+ = content)
#   $BOT_INJECT_DIR/ack                  — cumulative consumed count (written by this hook)
#   $BOT_INJECT_DIR/pending.claimed      — transient (during atomic consumption)

dir="$BOT_INJECT_DIR"

[[ -z "$dir" ]] && exit 0

# --- User messages (from MessageQueue) ---
pending="$dir/pending"
user_content=""
user_count=0

if [[ -f "$pending" ]]; then
  if mv "$pending" "$pending.claimed" 2>/dev/null; then
    user_count=$(head -1 "$pending.claimed")
    user_content=$(tail -n +2 "$pending.claimed")
    rm -f "$pending.claimed"

    if ! [[ "$user_count" =~ ^[0-9]+$ ]] || [[ "$user_count" -eq 0 ]]; then
      user_content=""
      user_count=0
    fi
  fi
fi

# Update ack counter for user messages only
if [[ "$user_count" -gt 0 ]]; then
  ack_file="$dir/ack"
  _lockdir="$dir/ack.lock"
  _lock_acquired=1
  _lock_tries=0
  while ! mkdir "$_lockdir" 2>/dev/null; do
    _lock_tries=$(( _lock_tries + 1 ))
    if [[ $_lock_tries -ge 50 ]]; then
      _lock_acquired=0
      break
    fi
    sleep 0.01
  done
  if [[ $_lock_acquired -eq 1 ]]; then
    prev=0
    [[ -f "$ack_file" ]] && prev=$(< "$ack_file")
    [[ "$prev" =~ ^[0-9]+$ ]] || prev=0
    echo $(( prev + user_count )) > "$ack_file"
    rmdir "$_lockdir" 2>/dev/null
  fi
fi

# --- Build framed output ---
[[ -z "$user_content" ]] && exit 0

framed="LIVE MESSAGE from the user (sent while you were working — read carefully and adjust your approach):

$user_content"

exec jq -n --arg ctx "$framed" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$ctx}}'
