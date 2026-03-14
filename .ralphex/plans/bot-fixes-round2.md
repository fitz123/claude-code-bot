# Bot Fixes — Round 2

## Goal

Fix two stability bugs: Discord WebSocket crashes killing Telegram, and stale message cascade after restart.

## Validation Commands

```bash
cd ~/.openclaw/bot && npx tsc --noEmit && npm test
```

## Reference: Discord error handling (discord-bot.ts)

Error handlers at lines 124-144:
```typescript
function installDiscordErrorHandlers(client: Client) {
  client.on(Events.Error, (error) => { log.error("discord", "Client error:", error); });
  client.on(Events.ShardError, (error, shardId) => { log.error("discord", `Shard ${shardId} error:`, error); });
  client.on(Events.Warn, (message) => { log.warn("discord", "Warning:", message); });
  client.on(Events.ShardReconnecting, (shardId) => { log.info("discord", `Shard ${shardId} reconnecting`); });
  client.on(Events.ShardResume, (shardId, replayed) => { log.info("discord", `Shard ${shardId} resumed (${replayed} events)`); });
}
```

Client creation at lines 150-167:
```typescript
export function createDiscordBot(...) {
  const client = new Client({ intents: [...], partials: [...] });
  installDiscordErrorHandlers(client);
  // ...
  client.login(token);
}
```

Discord.js has BUILT-IN automatic reconnection. Events.ShardReconnecting / Events.ShardResume already prove this. Do NOT implement custom reconnection — it will fight the library's built-in logic.

## Reference: Process-level handlers (main.ts)

Lines 50-55:
```typescript
process.on("uncaughtException", (error) => {
  log.error("main", "FATAL uncaught exception (process NOT exiting):", error);
});
process.on("unhandledRejection", (reason) => {
  log.error("main", "FATAL unhandled rejection (process NOT exiting):", reason);
});
```

These handlers explicitly do NOT exit the process. If the process is still dying, the cause is something else (e.g. launchd restart policy, OOM, etc.).

Lines 26-41: Shared shutdown — both Telegram and Discord destroyed together.
Lines 58-90: Telegram starts as blocking polling loop.
Lines 93-102: Discord starts as async init, errors caught and logged (Telegram continues).

## Reference: Stale message filtering (telegram-bot.ts)

Lines 216-218:
```typescript
function isStaleMessage(messageDateMs: number, maxAgeMs: number): boolean {
  return Date.now() - messageDateMs > maxAgeMs;
}
```

Used at lines 352-355, 367-369, 382-384, 437-440, 464-466, 521-523, 578-581 in each handler.
Config: `maxMessageAgeMs` from `config.sessionDefaults.maxMessageAgeMs` (line 323).

## Reference: Crash backoff (session-manager.ts)

Lines 13-17:
```typescript
const CRASH_BACKOFF_BASE_MS = 5_000;
const MAX_CRASH_BACKOFF_MS = 60_000;
const MAX_CRASH_RESTARTS = 5;
```

Lines 161-171: Exponential backoff `Math.min(base * 2^(count-1), max)`, circuit break at 5 crashes.
When blocked, `getOrCreateSession` throws an error. `/reset` calls `closeSession` which deletes restartCounts.

## Reference: Message queue (message-queue.ts)

Lines 68-281: `MessageQueue` class.
- Enqueue: lines 106-150 (debounce 3s default, 20 msg cap)
- Flush: lines 152-188 (process pending, no retry on error)
- Error handling: lines 162-176 (catch, log, reply to user, no requeue)
- Clear: lines 244-253 (deletes queue state entirely — called by `/reset`)
- ChatQueueState: lines 21-41 (pendingTexts, collectBuffer, debounceTimer, busy flag)

## Tasks

### Task 1: Discord observability and diagnosis (bot-nva, P1)

The existing error handlers (Events.Error, ShardError) and process.on("uncaughtException") should already prevent crashes. Discord.js has built-in reconnection. The actual root cause needs diagnosis, not more reconnection layers.

Minimal changes: add missing event handlers for observability, verify existing handlers work correctly.

- [ ] Add `Events.ShardDisconnect` handler to log disconnect events with close code and reason
- [ ] Add `Events.InvalidRequestWarning` handler if available in Discord.js version
- [ ] Verify `process.on("uncaughtException")` is registered BEFORE Discord client.login() (check execution order in main.ts)
- [ ] Add a test that verifies: when Discord client emits an Error event, the process does NOT exit
- [ ] Add a test that verifies: when Discord client.login() rejects, Telegram bot continues running
- [ ] Verify existing tests pass

### Task 2: Harden message queue against restart cascade (bot-kjc, P2)

After prolonged downtime, Telegram getUpdates delivers queued messages. `isStaleMessage` filters by age, but when sessions crash repeatedly within the age window, the queue keeps feeding messages that spawn new sessions, each hitting the circuit breaker and sending error replies.

Fix: When a chat hits the circuit breaker, the message queue blocks that chat entirely. Use a typed `SessionBlockedError` so MessageQueue can detect it cleanly. Add auto-unblock after 10 minutes so users don't get permanently stuck. Reduce `maxMessageAgeMs` default from 300s to 120s.

- [ ] Create `SessionBlockedError` class in session-manager.ts, thrown when crash count >= MAX_CRASH_RESTARTS
- [ ] Add `blocked` and `blockedNotified` flags to `ChatQueueState` in message-queue.ts
- [ ] In `flush()`: when `processFn` throws `SessionBlockedError`, set `blocked = true`
- [ ] In `enqueue()`: if chat is blocked, silently discard message. Send one notification on first block ("Chat blocked due to repeated failures, use /reset to recover"), set `blockedNotified = true`
- [ ] Add auto-unblock: store `blockedAt` timestamp, clear blocked flag if older than 10 minutes (check on next enqueue)
- [ ] `/reset` already clears via `messageQueue.clear()` + `sessionManager.closeSession()` — verify this works with new blocked flag
- [ ] Reduce `maxMessageAgeMs` default from 300000 to 120000 in config
- [ ] Add tests for blocked chat behavior (enqueue while blocked → discarded)
- [ ] Add tests for auto-unblock after timeout
- [ ] Add tests for `/reset` clearing blocked state
- [ ] Verify existing tests pass
