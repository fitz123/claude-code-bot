# Reaction Topic Routing via Message-Thread Cache (bot-yu4)

## Goal

Enable Telegram reactions in forum topics to route to the correct topic session instead of the chat-level fallback. Currently all reactions land in the General topic because the Telegram Bot API omits `message_thread_id` from reaction events.

Two deliverables:
1. **Real-time routing** — reaction in a topic reaches the correct topic session
2. **Reaction log** — append-only JSONL for future async analysis

## Validation Commands

```bash
cd ~/.openclaw/bot && npx tsc --noEmit
cd ~/.openclaw/bot && npx vitest run
cd ~/.openclaw/bot && npx tsx src/config.ts --validate
```

## Reference: MessageReactionUpdated type (grammY types)

The `MessageReactionUpdated` interface has NO `message_thread_id` field — this is the root cause:

```typescript
// node_modules/@grammyjs/types/message.d.ts:1346-1361
export interface MessageReactionUpdated {
    chat: Chat;
    message_id: number;
    user?: User;
    actor_chat?: Chat;
    date: number;
    old_reaction: ReactionType[];
    new_reaction: ReactionType[];
}
```

Compare with regular `Message` type which includes `message_thread_id?: number`.

Telegram Bot API issue: tdlib/telegram-bot-api#726 (open since 2023, no resolution).

## Reference: Current reaction handler

```typescript
// src/telegram-bot.ts:734-766
// Handle message reactions — forward as contextual info to the agent.
// Note: Telegram's MessageReactionUpdated does not include message_thread_id,
// so reactions in forum topics resolve to the chat-level binding. This is a
// Telegram API limitation — topicId is unavailable for reaction events.
bot.on("message_reaction", async (ctx) => {
    const chatId = ctx.chat.id;
    const binding = resolveBinding(chatId, config.bindings);  // ← NO topicId
    if (!binding) return;
    // ...
    const key = sessionKey(chatId);  // ← NO topicId
    messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(ctx, binding));
});
```

## Reference: Message handlers that DO have topicId

All other handlers extract topicId and pass it correctly:

```typescript
// src/telegram-bot.ts — text handler (line 528)
const topicId = ctx.message?.message_thread_id;
const binding = resolveBinding(chatId, config.bindings, topicId);
const key = sessionKey(chatId, topicId);

// Same pattern in: voice (line 556), photo (line 613), document (line 667)
// Also command handlers: /start, /reset, /status
```

## Reference: createTelegramAdapter threading

```typescript
// src/telegram-adapter.ts:15-21
export function createTelegramAdapter(
  ctx: Context,
  binding?: TelegramBinding,
): PlatformContext {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;  // ← undefined for reactions (ctx.message is undefined)
  const threadOpts = threadId ? { message_thread_id: threadId } : {};
```

For reaction events `ctx.message` is `undefined` — only `ctx.messageReaction` exists. So `threadId` is always `undefined`, and reply goes to General topic.

## Reference: sessionKey and resolveBinding signatures

```typescript
// src/telegram-bot.ts:27-30
export function sessionKey(chatId: number | string, topicId?: number): string {
  const base = String(chatId);
  return topicId !== undefined ? `${base}:${topicId}` : base;
}

// src/telegram-bot.ts:37-40
export function resolveBinding(
  chatId: number,
  bindings: TelegramBinding[],
  topicId?: number,
): TelegramBinding | undefined {
```

Both already accept optional `topicId` — the reaction handler just doesn't pass it.

## Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Cache strategy | Plain `Map<string, number>` with 10K cap | Zero deps, sufficient for bot volume |
| 2 | Cache key | `"${chatId}:${messageId}"` | messageIds are not globally unique |
| 3 | Eviction | `map.clear()` when size > 10K | Simple, cache miss is harmless |
| 4 | Persistence | None (in-memory only) | Restart = cache miss = current behavior |
| 5 | Adapter threading | Pass optional `threadIdOverride` param | Reaction replies go to correct topic |
| 6 | Scope | Cache all messages bot sees | Better coverage, trivial overhead |
| 7 | Reaction log | Append-only JSONL at `~/.openclaw/logs/reactions.jsonl` | Simplest persistent format for future cron |

## Tasks

### Task 1: Message-thread cache + reaction routing + JSONL log (bot-yu4) [HIGH]

**Problem:** Telegram's `MessageReactionUpdated` event lacks `message_thread_id` (confirmed: field absent from grammY type definition). The reaction handler at `telegram-bot.ts:738` calls `resolveBinding(chatId, config.bindings)` and `sessionKey(chatId)` without topicId. The adapter at `telegram-adapter.ts:20` derives `threadId` from `ctx.message?.message_thread_id` which is `undefined` for reaction events. Result: all reactions in forum topics route to the chat-level (General) session instead of the correct topic session.

**What we want:**
- An in-memory cache (`Map<string, number>`) mapping `"chatId:messageId"` → `topicId`, populated by every message handler
- The reaction handler looks up topicId from cache and passes it to `resolveBinding()`, `sessionKey()`, and `createTelegramAdapter()`
- `createTelegramAdapter` accepts an optional `threadIdOverride` parameter so reaction replies go to the correct topic
- Cache miss degrades gracefully to current behavior (chat-level routing)
- Cache has 10K cap with `map.clear()` eviction
- Every reaction event is appended to `~/.openclaw/logs/reactions.jsonl` (JSONL format, try/catch so logging never breaks message flow)

**Files:**
- Create: `src/message-thread-cache.ts`
- Create: `src/reaction-log.ts`
- Modify: `src/telegram-bot.ts`
- Modify: `src/telegram-adapter.ts`

- [ ] Cache module: `setThread(chatId, messageId, topicId)` + `getThread(chatId, messageId)`, 10K cap with clear, skip undefined topicId
- [ ] All message handlers (text, voice, photo, document, commands) call `setThread()` BEFORE stale-message checks
- [ ] Reaction handler looks up `getThread(chatId, messageId)` and passes topicId to `resolveBinding`, `sessionKey`, and adapter
- [ ] `createTelegramAdapter` accepts optional `threadIdOverride` parameter: `threadIdOverride ?? ctx.message?.message_thread_id`
- [ ] Reaction handler passes cached topicId as third arg to `createTelegramAdapter`
- [ ] JSONL reaction logger: `appendFileSync` to `~/.openclaw/logs/reactions.jsonl`, fields: `ts, chatId, topicId, messageId, userId, username, added[], removed[]`, wrapped in try/catch
- [ ] Reaction handler calls `logReaction()` after building reaction data
- [ ] Update comment block at reaction handler explaining the cache workaround
- [ ] Add tests for cache: round-trip, miss returns undefined, undefined topicId skipped, eviction at 10K+1, key isolation across chats
- [ ] Add tests for reaction log: writes valid JSONL, does not throw on write error
- [ ] Verify existing tests pass
- [ ] `npx tsc --noEmit` passes
