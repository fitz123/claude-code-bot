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
#   $BOT_INJECT_DIR/pending       — messages from bot (line 1 = count, line 2+ = content)
#   $BOT_INJECT_DIR/ack           — cumulative consumed count (written by this hook)
#   $BOT_INJECT_DIR/pending.claimed — transient (during atomic consumption)

dir="$BOT_INJECT_DIR"

[[ -z "$dir" ]] && exit 0

pending="$dir/pending"

[[ -f "$pending" ]] || exit 0

mv "$pending" "$pending.claimed" 2>/dev/null || exit 0

count=$(head -1 "$pending.claimed")
content=$(tail -n +2 "$pending.claimed")
rm -f "$pending.claimed"

if ! [[ "$count" =~ ^[0-9]+$ ]] || [[ "$count" -eq 0 ]]; then
  exit 0
fi

ack_file="$dir/ack"
prev=0
[[ -f "$ack_file" ]] && prev=$(< "$ack_file")
[[ "$prev" =~ ^[0-9]+$ ]] || prev=0
echo $(( prev + count )) > "$ack_file"

framed="LIVE MESSAGE from the user (sent while you were working — read carefully and adjust your approach):

$content"

exec jq -n --arg ctx "$framed" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$ctx}}'
