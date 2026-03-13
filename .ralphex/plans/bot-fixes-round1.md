# Bot Features — Round 1

## Goal

Add missing Telegram reply/forward context for Claude sessions, and wire cron delivery to forum topics.

## Validation Commands

```bash
cd ~/.openclaw/bot && npx tsc --noEmit && npm test
```

## Reference: Message formatting (telegram-bot.ts)

Source prefix builder at lines 74-93:
```typescript
function buildSourcePrefix(binding: BindingConfig, from?: User): string {
  // Returns: "[Chat: <label> | From: <name> (@username)]"
}
```

Text message handling at lines 338-361:
```typescript
const messageText = prefix + ctx.message.text;
messageQueue.enqueue(key, binding.agentId, messageText, ...);
```

Voice messages formatted as: `${prefix}[Voice message] ${transcript}` (line 400)

The `ctx.message.reply_to_message` IS available in grammY but currently only used for forum topic detection (lines 96-118, 161-164). The actual replied-to text is never passed to Claude.

Forward metadata (`ctx.message.forward_origin`, `ctx.message.forward_date`) is completely ignored — never read or used.

## Reference: Cron delivery routing

`cron-runner.ts` lines 55-56: delivery uses `deliveryChatId`, defaults to `NINJA_CHAT_ID = <redacted-user-id>`.

`deliver.sh` already supports `--thread <thread_id>` flag for forum topics (line 17-20 in deliver.sh). But `cron-runner.ts` never passes `--thread` — only `${DELIVER_SCRIPT} ${chatId}`.

`crons.yaml` has no `deliveryThreadId` field in the schema.

## Tasks

### Task 1: Pass reply and forward context to Claude sessions (bot-bsx, P2)

When a user replies to a message in Telegram, Claude only sees the new message text — the replied-to message content is lost. Same for forwarded messages: forward origin and original author are not passed. This makes it impossible for Claude to understand what the user is referencing.

What we want: Reply-to message text and forward metadata included in the message text sent to Claude, using a clear format that Claude can parse.

- [ ] When user replies to a message, the replied-to text is included before the user's message
- [ ] Forum service messages (topic creation etc.) are excluded from reply context (existing detection at lines 96-118)
- [ ] When user forwards a message, forward origin (author/channel name) is included
- [ ] Reply/forward context is included for all message types (text, voice, photo)
- [ ] Long replied-to messages are truncated to prevent context bloat
- [ ] Add tests for reply context formatting
- [ ] Add tests for forward metadata formatting
- [ ] Verify existing tests pass

### Task 3: Cron delivery thread routing (bot-yri, P2)

Cron jobs can only deliver to a chat ID. Forum topics (threads) require a `message_thread_id` parameter. deliver.sh already supports `--thread` but cron-runner.ts never passes it and crons.yaml has no field for it.

What we want: Crons can specify a thread ID for delivery to forum topics, wired through from crons.yaml to deliver.sh.

- [ ] `deliveryThreadId` field added to crons.yaml schema
- [ ] cron-runner.ts passes `--thread` to deliver.sh when deliveryThreadId is set
- [ ] Config validation accepts the new field
- [ ] Add tests for thread delivery routing
- [ ] Verify existing tests pass
