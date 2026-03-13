# Bot Resilience — Round 10

## Goal

Prevent Discord network issues from killing the entire bot process, and stop stale messages from cascading failures after restarts.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Reference: Discord WebSocket crash (actual stack trace)

The bot crashed with this unhandled error from discord.js WebSocket:

```
node:events:486
      throw er; // Unhandled 'error' event
      ^

Error: Opening handshake has timed out
    at ClientRequest.<anonymous> (/Users/user/.openclaw/bot/node_modules/ws/lib/websocket.js:878:7)
    at ClientRequest.emit (node:events:508:20)
    at TLSSocket.emitRequestTimeout (node:_http_client:948:9)
    at Object.onceWrapper (node:events:622:28)
    at TLSSocket.emit (node:events:508:20)
    at Socket._onTimeout (node:net:610:8)
    at listOnTimeout (node:internal/timers:605:17)
    at process.processTimers (node:internal/timers:541:7)
Emitted 'error' event on WebSocket instance at:
    at emitErrorAndClose (/Users/user/.openclaw/bot/node_modules/ws/lib/websocket.js:1046:13)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)

Node.js v25.8.0
```

This kills the entire Node.js process — both Telegram and Discord go down.

## Reference: Discord client creation (no error handlers)

`discord-bot.ts` creates the Discord client with no top-level error handlers:

```typescript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});
```

Event handlers exist for `ThreadCreate`, `MessageCreate`, `InteractionCreate` — all wrapped in try/catch. But there are NO handlers for:
- `client.on(Events.Error, ...)` — client-level errors
- `client.on(Events.ShardError, ...)` — shard/WebSocket errors
- `client.on(Events.Warn, ...)` — warnings

## Reference: main.ts shutdown and startup

```typescript
// Graceful shutdown
const shutdown = async (signal: string) => {
  if (telegramBot) telegramBot.stop();
  if (discordClient) discordClient.destroy();
  for (const mq of messageQueues) mq.clearAll();
  await stopMetricsServer();
  await sessionManager.closeAll();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

No `process.on("uncaughtException")` or `process.on("unhandledRejection")` handlers. Discord startup has no timeout (unlike Telegram which has a 30s startup timeout).

## Reference: discord.js error handling API

Discord.js v14 provides these events for error handling:

```typescript
import { Events } from "discord.js";

// Client-level errors (includes WebSocket errors)
client.on(Events.Error, (error) => { /* Error object */ });

// Shard-level errors (WebSocket connection issues)
client.on(Events.ShardError, (error, shardId) => { /* Error, number */ });

// Warnings (non-fatal)
client.on(Events.Warn, (message) => { /* string */ });

// Shard reconnecting (after disconnect)
client.on(Events.ShardReconnecting, (shardId) => { /* number */ });

// Shard resumed (after reconnect)
client.on(Events.ShardResume, (shardId, replayedEvents) => { /* number, number */ });
```

Discord.js automatically reconnects on WebSocket failures if the error is caught. The crash happens because the `error` event is unhandled, which Node.js treats as `uncaughtException`.

## Reference: Message queue flush logic

`message-queue.ts` `flush()` method:

```typescript
private async flush(chatId: string): Promise<void> {
  const state = this.queues.get(chatId);
  if (!state || state.pendingTexts.length === 0) return;

  const texts = state.pendingTexts.splice(0);
  const cleanups = state.pendingCleanups.splice(0);
  state.debounceTimer = null;
  state.busy = true;

  const combinedText = texts.length === 1 ? texts[0] : texts.join("\n\n");

  try {
    if (state.latestPlatform) {
      await this.processFn(chatId, state.agentId, combinedText, state.latestPlatform);
    }
  } catch (err) {
    log.error("message-queue", `Send error for ${chatId}:`, err);
    if (state.latestPlatform) {
      await state.latestPlatform
        .replyError("Something went wrong. Try again or /reset the session.")
        .catch(() => {});
    }
  } finally {
    for (const fn of cleanups) fn();
  }
  // ...
  state.busy = false;
  await this.drainCollectBuffer(chatId);
  this.evictIfIdle(chatId);
}
```

No retry logic — errors are caught, logged, and user gets error reply. But the message queue itself works correctly (messages aren't retried).

## Reference: Telegram getUpdates behavior on restart

grammY's long-polling uses Telegram's `getUpdates` API with an offset. When the bot restarts:
- Telegram delivers ALL unprocessed updates since the last confirmed offset
- If the bot was down for hours, hundreds of messages may arrive at once
- Each message triggers `enqueue()` → `flush()` → `processFn()` → Claude session spawn
- With `maxConcurrentSessions: 6`, only 6 sessions run at a time, but the queue keeps accepting

The bot has no awareness of message age. A message sent 3 hours ago during downtime gets processed the same as a message sent 1 second ago.

## Reference: Session crash recovery in session-manager.ts

```typescript
// session-manager.ts — setupCrashRecovery (line ~507)
private setupCrashRecovery(chatId: string, session: ActiveSession): void {
  session.child.once("exit", (code, signal) => {
    // ... cleanup idle timer, update store, dec gauge ...
    log.error(
      "session-manager",
      `Session for chat ${chatId} crashed: code=${code} signal=${signal}`,
    );
    sessionCrashes.inc({ agent_id: session.agentId });
  });
}
```

On crash, the session is removed from `active` map but preserved in `store` (for resume). No backoff — the next message for this chatId immediately spawns a new session. If the crash cause persists (auth failure, workspace issue), this creates a rapid crash loop.

## Reference: restartCount tracking

```typescript
// session-manager.ts — in getOrCreateSession
const prevCount = this.restartCounts.get(chatId) ?? 0;
const restartCount = (existing || resume) ? prevCount + 1 : 0;
this.restartCounts.set(chatId, restartCount);
```

`restartCount` is tracked but never used for backoff or circuit-breaking. It's stored in the `ActiveSession` object and included in metrics but doesn't affect behavior.

## Tasks

### Task 1: Handle Discord client errors gracefully (bot-nva, P1)

**Problem:** Discord.js WebSocket errors (e.g. "Opening handshake has timed out") are unhandled `error` events on the WebSocket instance. Node.js treats unhandled `error` events as fatal — the entire process crashes, taking Telegram down with it. A transient Discord network issue should not affect Telegram service.

**What we want:** Discord client errors are caught, logged at ERROR level, and discord.js is allowed to reconnect automatically. The bot process must not crash from Discord WebSocket issues. Add handlers for `Events.Error`, `Events.ShardError`, and `Events.Warn` on the Discord client. Also add `process.on("uncaughtException")` and `process.on("unhandledRejection")` in `main.ts` as a safety net — log the error at FATAL level but do NOT crash the process (these should never fire if errors are properly caught, but they prevent total failure if something is missed). Log shard reconnection events at INFO level for visibility.

- [x] Discord `Events.Error` handled — logged at ERROR, process does not crash
- [x] Discord `Events.ShardError` handled — logged at ERROR with shard ID
- [x] Discord `Events.Warn` handled — logged at WARN
- [x] `Events.ShardReconnecting` and `Events.ShardResume` logged at INFO for visibility
- [x] `process.on("uncaughtException")` in main.ts logs at FATAL but does not exit
- [x] `process.on("unhandledRejection")` in main.ts logs at FATAL but does not exit
- [x] A Discord WebSocket timeout does not kill the Telegram bot
- [x] Tests for error handler registration
- [x] Verify existing tests pass

### Task 2: Skip stale messages and add session crash backoff (bot-kjc, P2)

**Problem 1: Stale messages flood the bot after restart.** When the bot restarts after extended downtime, Telegram delivers all accumulated updates at once. Messages sent hours ago get processed as if they're current — spawning sessions, hitting API rate limits, and wasting resources on conversations the user has long abandoned. There's no message age check.

**Problem 2: Session crash loops have no backoff.** When a session crashes (code=1 from auth failure, workspace issue, etc.), the next message immediately spawns a new session that crashes again. `restartCount` is tracked but never used for throttling. With stale messages arriving after a restart, this creates rapid-fire crash→spawn→crash cycles.

**What we want:**
- Messages older than a configurable threshold (e.g. 5 minutes) are silently discarded on arrival — they never enter the queue. Telegram message objects have a `date` field (Unix timestamp) that can be compared against current time. Log discarded messages at DEBUG level.
- Session spawn has exponential backoff based on `restartCount` — if a session for a chatId has crashed N times recently, delay the next spawn attempt. After a threshold (e.g. 5 crashes), stop spawning for that chatId and log at ERROR level. The backoff should reset when a session completes successfully.
- Same staleness check for Discord messages (Discord `Message.createdTimestamp` is milliseconds).

- [ ] Telegram messages older than a threshold are silently discarded (never enqueued)
- [ ] Discord messages older than the same threshold are silently discarded
- [ ] Threshold is configurable via config.yaml (e.g. `maxMessageAgeMs`, default 300000 = 5 min)
- [ ] Discarded messages logged at DEBUG level with age
- [ ] Session spawn backs off exponentially based on recent crash count for the same chatId
- [ ] After max crashes (e.g. 5), session spawn is blocked for that chatId with ERROR log
- [ ] Backoff resets when a session completes successfully
- [ ] Tests for message staleness filtering
- [ ] Tests for crash backoff and circuit breaking
- [ ] Verify existing tests pass
