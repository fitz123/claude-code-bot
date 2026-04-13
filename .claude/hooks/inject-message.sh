#!/bin/bash
# inject-message.sh — PreToolUse hook for mid-turn message injection.
#
# When the user sends a message while the agent is working (doing tool calls),
# the bot writes it to an inject file. This hook reads it before each tool call
# and returns it as additionalContext so the agent sees the message mid-turn.
#
# Also reads echo messages (from deliver.sh/cron via the echo watcher) from
# a separate pending-echo file, framing them as "CONTEXT UPDATE" instead of
# "LIVE MESSAGE".
#
# Install: register as a wildcard ("*") PreToolUse hook in .claude/settings.json
# Env: BOT_INJECT_DIR must be set by the bot at subprocess spawn time.
#
# File protocol:
#   $BOT_INJECT_DIR/pending              — user messages from bot (line 1 = count, line 2+ = content)
#   $BOT_INJECT_DIR/pending-echo         — echo messages from deliver.sh/cron (line 1 = count, line 2+ = content)
#   $BOT_INJECT_DIR/ack                  — cumulative consumed count (written by this hook, pending only)
#   $BOT_INJECT_DIR/pending.claimed      — transient (during atomic consumption)
#   $BOT_INJECT_DIR/pending-echo.claimed — transient (during atomic consumption)

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

# --- Echo messages (from deliver.sh/cron via echo watcher) ---
# Prefix must match ECHO_PREFIX in bot/src/echo-watcher.ts — keep in sync
pending_echo="$dir/pending-echo"
echo_content=""

if [[ -f "$pending_echo" ]]; then
  if mv "$pending_echo" "$pending_echo.claimed" 2>/dev/null; then
    echo_count=$(head -1 "$pending_echo.claimed")
    echo_content=$(tail -n +2 "$pending_echo.claimed")
    rm -f "$pending_echo.claimed"

    if ! [[ "$echo_count" =~ ^[0-9]+$ ]] || [[ "$echo_count" -eq 0 ]]; then
      echo_content=""
    fi
    # Echo messages do NOT update the ack counter — they are not tracked
    # by MessageQueue's collectBuffer and don't need dedup
  fi
fi

# --- Build framed output ---
[[ -z "$user_content" ]] && [[ -z "$echo_content" ]] && exit 0

framed=""

if [[ -n "$user_content" ]]; then
  framed="LIVE MESSAGE from the user (sent while you were working — read carefully and adjust your approach):

$user_content"
fi

if [[ -n "$echo_content" ]]; then
  echo_framed="CONTEXT UPDATE (a message was sent in this chat while you were working):

$echo_content"

  if [[ -n "$framed" ]]; then
    framed="$framed

---

$echo_framed"
  else
    framed="$echo_framed"
  fi
fi

exec jq -n --arg ctx "$framed" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$ctx}}'
