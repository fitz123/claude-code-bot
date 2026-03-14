#!/bin/bash
# inject-message.sh — PreToolUse hook for mid-turn message injection.
#
# When the user sends a message while the agent is working (doing tool calls),
# the bot writes it to an inject file. This hook reads it before each tool call
# and returns it as additionalContext so the agent sees the message mid-turn.
#
# Install: register as a wildcard ("*") PreToolUse hook in .claude/settings.json
# Env: OPENCLAW_INJECT_DIR must be set by the bot at subprocess spawn time.
#
# File protocol:
#   $OPENCLAW_INJECT_DIR/pending       — messages from bot (line 1 = count, line 2+ = content)
#   $OPENCLAW_INJECT_DIR/ack           — cumulative consumed count (written by this hook)
#   $OPENCLAW_INJECT_DIR/pending.claimed — transient (during atomic consumption)

dir="$OPENCLAW_INJECT_DIR"

# Fast path: no inject dir configured (not a bot session)
[[ -z "$dir" ]] && exit 0

pending="$dir/pending"

# Fast path: no pending messages — just a stat() call, <1ms
[[ -f "$pending" ]] || exit 0

# Atomically claim the pending file to prevent double-read
mv "$pending" "$pending.claimed" 2>/dev/null || exit 0

# Read count (line 1) and content (line 2+)
count=$(head -1 "$pending.claimed")
content=$(tail -n +2 "$pending.claimed")
rm -f "$pending.claimed"

# Validate count is a positive integer
if ! [[ "$count" =~ ^[0-9]+$ ]] || [[ "$count" -eq 0 ]]; then
  exit 0
fi

# Update cumulative ack count
ack_file="$dir/ack"
prev=0
[[ -f "$ack_file" ]] && prev=$(< "$ack_file")
# Validate prev is a non-negative integer (guards against corrupted ack file)
if ! [[ "$prev" =~ ^[0-9]+$ ]]; then prev=0; fi
echo $(( prev + count )) > "$ack_file"

# Frame the message so the agent recognizes it as live user input
framed="LIVE MESSAGE from the user (sent while you were working — read carefully and adjust your approach):

$content"

# Return additionalContext via Claude Code hook API
exec jq -n --arg ctx "$framed" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$ctx}}'
