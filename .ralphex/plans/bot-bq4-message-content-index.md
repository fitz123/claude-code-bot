# Bot Improvements — Round 16

## Goal

Three improvements: (1) enrich reaction context with message content so agents can understand what was reacted to, (2) safe bot restart mechanism that doesn't loop, (3) typing indicator during long processing (tool calls, sub-agents).

## Validation Commands

```bash
cd /Users/user/.openclaw/bot && npx tsc --noEmit && npx tsx --test src/__tests__/*.test.ts
```

## Reference: Current reaction handler

`src/telegram-bot.ts` lines 236–249 — `buildReactionContext`:

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
- [ ] In-memory Map with 10K cap. Eviction: remove oldest entries (FIFO), NOT full clear() — reactions arrive after messages, full wipe would destroy needed context
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

- [ ] Text/photo/document handlers call `recordMessage` after `setThread` using `ctx.message.text` or `ctx.message.caption` as content
- [ ] Voice handler calls `recordMessage` AFTER transcription completes (not at `setThread` time — transcribed text is not available yet)
- [ ] `sendMessage` in `telegram-adapter.ts` calls `recordMessage` after `ctx.reply()` with `direction: "out"` and bot's username as author. Note: `createTelegramAdapter` does not currently have access to `bot.botInfo.username` — this needs to be passed in or set as a module-level variable at startup
- [ ] `sendFile` calls `recordMessage` with caption text if available, or `"[file]"` / `"[photo]"` placeholder
- [ ] `replyError` calls `recordMessage` with the error message text
- [ ] `main.ts` calls `restoreMessageIndex()` at startup alongside `restoreThreadCache()`
- [ ] `main.ts` calls `saveMessageIndex()` at shutdown alongside `saveThreadCache()`
- [ ] Add integration test: simulate message → reaction → verify enriched context
- [ ] Verify existing tests pass

### Task 3: Enrich reaction context with message content (bot-bq4, P2)

**Problem:** `buildReactionContext` produces blind output: `[Reaction: 👎 on message 3742]`. The content index now has the data, but the reaction handler doesn't use it.

**What we want:** When a reaction arrives and content is found in the index, the agent sees who wrote the message and what it said. Cache miss gracefully degrades to current behavior.

- [ ] When content available, reaction context includes author and text preview: `[Reaction: 👎 on message by @minitinyme_bot: "Доброе утро! Всё норм..."]`
- [ ] When content unavailable (cache miss): `[Reaction: 👎 on message 3742]` (current behavior, unchanged)
- [ ] Reaction handler in `telegram-bot.ts` calls `lookupMessage(chatId, messageId)` and passes result to `buildReactionContext`
- [ ] Add tests for both cache-hit and cache-miss formatting
- [ ] Verify existing tests pass

## Reference: Bot restart mechanism

The bot runs as a launchd service (`ai.openclaw.telegram-bot`). Restart is done via:
```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.telegram-bot
```

This sends SIGTERM to the bot process. The bot's shutdown handler (main.ts lines 42–55) stops telegram bot, clears queues, saves caches, closes sessions, then `process.exit(0)`. launchd then restarts the process.

**The problem:** Claude agent sessions are subprocesses of the bot. When the bot dies, all sessions die. When the bot restarts, a new session may pick up conversation context that says "restart needed" and trigger another restart → infinite loop.

**Evidence:** Observed 2026-03-15. Agent ran `launchctl kickstart -k`, bot died, restarted, new session tried to restart again. Required manual intervention ("хватит рестартовать") to break the cycle.

## Reference: Typing indicator architecture

`src/stream-relay.ts` lines 127–149 — typing starts inside `relayStream()`:
```typescript
if (platform.typingIndicator) {
  typingTimer = setInterval(() => {
    platform.sendTyping().catch(() => {});
  }, platform.typingIntervalMs);
  await platform.sendTyping().catch(() => {});
}
```

`typingTimer` is cleared in the `finally` block (lines 299–306).

`src/telegram-adapter.ts` lines 64–71 — `sendTyping()`:
```typescript
async sendTyping(): Promise<void> {
  if (!chatId) return;
  await ctx.api.sendChatAction(chatId, "typing",
    threadId != null ? { message_thread_id: threadId } : undefined);
},
```

`TELEGRAM_TYPING_INTERVAL_MS = 4000` (line 9). Telegram chat action lasts ~5 seconds.

**The gap:** Typing only starts when `relayStream()` is called. Before that — during debounce (3s in message-queue.ts), session spawn, queue wait, and Claude's thinking phase (tool calls, sub-agents before first text output) — there is zero indication. User sees "bot is silent."

`src/message-queue.ts` — `enqueue()` (lines 118–181): adds to `pendingTexts`, starts 3s debounce timer, calls `flush()`. `flush()` (lines 183–223) marks `busy=true`, calls `processFn()` which eventually calls `relayStream()`.

The `platform` adapter with `sendTyping()` is available at `enqueue()` time — it's passed as parameter.

### Task 4: Restart notification to prevent restart loop (bot-d9u, P2)

**Problem:** When the bot restarts, new sessions may re-trigger the restart from conversation context, causing an infinite loop. Observed 2026-03-15 — required manual intervention to break.

**Root cause:** The new session inherits context containing "restart needed" intent but has no signal that the restart already happened. Sessions are resumable via `--resume`, so abrupt shutdown is acceptable — the critical issue is the loop.

**Current shutdown flow** (`main.ts` lines 42–55): `watchdog.stop()` → `telegramBot.stop()` → `clearAll()` → `saveThreadCache()` → `sessionManager.closeAll()` → `process.exit(0)`.

**What we want:** On shutdown, persist a list of previously-active session keys. On startup, detect this is a restart (not first start) and inject a "restart completed, do not restart again" message into those sessions when they resume.

- [ ] On shutdown, list of active session keys is persisted to disk (e.g. `data/active-sessions-at-shutdown.json`)
- [ ] On startup, bot detects restart by presence of this file
- [ ] On restart, bot injects "restart completed" notification into sessions that were active before shutdown
- [ ] Active-sessions file is cleaned up after restart notifications are sent
- [ ] On first-ever start (no file), no notification is injected
- [ ] Restart loop is broken: agent sees "restart completed" and does not re-trigger
- [ ] Add tests: shutdown persistence, restart detection, notification injection, cleanup
- [ ] Verify existing tests pass

### Task 5: Typing indicator during processing gaps (bot-dgs, P2)

**Problem:** Typing indicator only fires inside `relayStream()` — when Claude is actively streaming text. During debounce wait (3s), session spawn, queue processing, and Claude's thinking phase (tool calls, sub-agents), there is zero user-visible indication. In Telegram it looks like the bot is dead. Observed 2026-03-15: 10-minute silence during sub-agent research with no typing indicator.

**What we want:** Typing indicator starts immediately when a message is received and continues until the response is fully delivered. Covers the gaps: debounce wait, session creation, Claude's thinking phase before first stream output.

- [ ] Typing starts when message processing begins (after debounce flushes, before session spawn/Claude response) — NOT during debounce window itself, as debounce batches rapid messages
- [ ] Typing continues during session processing until `relayStream()` takes over with its own typing timer
- [ ] Typing stops if processing is cancelled or errors out
- [ ] Works correctly with the existing `typingIndicator` config flag (respects `binding.typingIndicator !== false`)
- [ ] No duplicate typing timers (clean handoff between pre-stream and in-stream typing)
- [ ] Add tests
- [ ] Verify existing tests pass
