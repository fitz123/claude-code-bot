# Message Content Sidecar Index for Reaction Context — Round 16

## Goal

When a reaction arrives, the agent sees blind `[Reaction: 👎 on message 3742]` — no text, no author. Telegram Bot API has no `getMessage` method. The bot must record message content at receive/send time so reactions can be enriched with context.

## Validation Commands

```bash
cd /Users/ninja/.openclaw/bot && npx tsc --noEmit && npx tsx --test src/__tests__/message-content-index.test.ts && npx tsx --test src/__tests__/telegram-bot.test.ts
```

## Reference: Current reaction handler

`src/telegram-bot.ts` lines 231–249 — `buildReactionContext`:

```typescript
export function buildReactionContext(
  messageId: number,
  emojiAdded: string[],
  emojiRemoved: string[],
): string {
  const lines: string[] = [];
  for (const emoji of emojiAdded) {
    lines.push(`[Reaction: ${emoji} on message ${messageId}]`);
  }
  for (const emoji of emojiRemoved) {
    lines.push(`[Reaction removed: ${emoji} on message ${messageId}]`);
  }
  return lines.join("\n");
}
```

The reaction handler at lines 758–798 calls `getThread(chatId, messageId)` for topicId, then passes messageId to `buildReactionContext`. No message text or author is available.

## Reference: Message handler pattern

All four message handlers (`message:text` lines 541–567, `message:voice` 570–625, `message:photo` 628–680, `message:document` 683–751) follow the same pattern:

```typescript
setThread(chatId, ctx.message.message_id, topicId);
// ... build messageText ...
messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(ctx, binding));
```

At the point of `setThread`, both `ctx.message.message_id` and message content (`ctx.message.text`, `ctx.message.caption`, transcribed voice text) are available.

## Reference: Outgoing message flow

`src/telegram-adapter.ts` lines 32–47 — `sendMessage`:

```typescript
const sent = await ctx.reply(html, { ...threadOpts, parse_mode: "HTML" });
setThread(chatId!, sent.message_id, threadId);
```

After `ctx.reply()`, both `sent.message_id` and the original `text` parameter are available.

Same pattern in `sendFile` (lines 73–78) and `replyError` (lines 80–83).

## Reference: Existing cache pattern to follow

`src/message-thread-cache.ts` (104 lines):

- `Map<string, number>` with key `"${chatId}:${messageId}"`
- `MAX_CACHE_SIZE = 10_000`, eviction: full `clear()`
- Persistence: `data/thread-cache.json` as `[key, value][]`
- Tolerant restore: ENOENT → empty, corrupt → empty, never throws
- Called in `main.ts`: `restoreThreadCache()` at startup (line 29), `saveThreadCache()` at shutdown (line 48)

## Reference: Startup and shutdown

`src/main.ts`:

- Startup (line 29): `restoreThreadCache()` before session manager and bots start
- Shutdown (lines 42–55): `saveThreadCache()` synchronously before `sessionManager.closeAll()`

## Tasks

### Task 1: Message content index module (bot-bq4, P2)

**Problem:** No mapping between Telegram `message_id` and message content exists. When a reaction arrives, the bot has only a number — no text, no author. Telegram Bot API provides no `getMessage` method (confirmed by research). The agent cannot understand what was reacted to.

**What we want:** An append-only sidecar index that maps `message_id` → `{from, preview, direction, timestamp}`. Preview is first 150 characters of plain text. The module follows the same pattern as `message-thread-cache.ts`: in-memory Map, persist to disk, tolerant restore.

- [ ] New module `src/message-content-index.ts` exports `recordMessage(chatId, messageId, from, text, direction)` and `lookupMessage(chatId, messageId)`
- [ ] In-memory Map with same 10K cap as thread cache
- [ ] `preview` field stores first 150 characters of text
- [ ] `direction` field: `"in"` for incoming, `"out"` for outgoing
- [ ] Persistence to `data/message-content-index.json`, same `[key, value][]` format
- [ ] Tolerant restore: missing file → empty, corrupt → empty, never throws
- [ ] `saveMessageIndex()` and `restoreMessageIndex()` exported
- [ ] Add tests covering: record + lookup, cap eviction, persistence round-trip, corrupt file, missing file
- [ ] Verify existing tests pass

### Task 2: Populate index from all message paths (bot-bq4, P2)

**Problem:** The new index module exists but nothing writes to it. Both incoming messages (4 handlers in `telegram-bot.ts`) and outgoing messages (`sendMessage`, `sendFile`, `replyError` in `telegram-adapter.ts`) need to record content.

**What we want:** Every message the bot sees (incoming or outgoing) is recorded in the content index. The index is restored at startup and saved at shutdown alongside the thread cache.

- [ ] All 4 message handlers in `telegram-bot.ts` call `recordMessage` after `setThread` — using `ctx.message.text`, `ctx.message.caption`, or transcribed voice text as content, `ctx.from.username ?? ctx.from.first_name` as author
- [ ] `sendMessage` in `telegram-adapter.ts` calls `recordMessage` after `ctx.reply()` with `direction: "out"` and bot's username as author
- [ ] `sendFile` and `replyError` in `telegram-adapter.ts` also call `recordMessage`
- [ ] `main.ts` calls `restoreMessageIndex()` at startup alongside `restoreThreadCache()`
- [ ] `main.ts` calls `saveMessageIndex()` at shutdown alongside `saveThreadCache()`
- [ ] Add integration test: simulate message → reaction → verify enriched context
- [ ] Verify existing tests pass

### Task 3: Enrich reaction context with message content (bot-bq4, P2)

**Problem:** `buildReactionContext` produces blind output: `[Reaction: 👎 on message 3742]`. The content index now has the data, but the reaction handler doesn't use it.

**What we want:** When a reaction arrives and content is found in the index, the agent sees who wrote the message and what it said. Cache miss gracefully degrades to current behavior.

- [ ] `buildReactionContext` accepts optional `{from?: string, preview?: string}` parameter
- [ ] When content available: `[Reaction: 👎 on message by @minitinyme_bot: "Доброе утро! Всё норм..."]`
- [ ] When content unavailable (cache miss): `[Reaction: 👎 on message 3742]` (current behavior, unchanged)
- [ ] Reaction handler in `telegram-bot.ts` calls `lookupMessage(chatId, messageId)` and passes result to `buildReactionContext`
- [ ] Add tests for both cache-hit and cache-miss formatting
- [ ] Verify existing tests pass
