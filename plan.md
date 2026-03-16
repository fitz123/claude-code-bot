# Bug Fixes: autoRetry Error Swallowing + Cron Delivery Fallback — Round 1

## Goal

Fix two independent bugs that cause silent failures:
1. (bot-4qi) autoRetry plugin silently swallows HttpErrors during editMessageText, preventing stream-relay's fallback-to-new-message logic from triggering — users see truncated/missing text.
2. (bot-mmz) Cron delivery failures are logged but never reported to anyone — if deliveryChatId becomes unreachable, failures are invisible outside log files.

## Validation Commands

```bash
npx tsc --noEmit && npm test
```

## Reference: autoRetry Plugin Behavior (bot-4qi)

Current config at `src/telegram-bot.ts:429`:
```typescript
bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));
```

`@grammyjs/auto-retry` `AutoRetryOptions` (from `node_modules/@grammyjs/auto-retry/out/mod.d.ts`):
```typescript
export interface AutoRetryOptions {
    maxDelaySeconds: number;       // default: Infinity
    maxRetryAttempts: number;      // default: Infinity
    rethrowInternalServerErrors: boolean;  // default: false — retries 5xx
    rethrowHttpErrors: boolean;    // default: false — retries HttpErrors (network failures)
}
```

**Problem:** `rethrowHttpErrors` defaults to `false`. When network is flaky, `editMessageText` calls fail with `HttpError`. autoRetry retries 5 times, then **swallows the error** (doesn't rethrow). This means:

- `stream-relay.ts:170` — streaming edit catch never fires (no error to catch)
- `stream-relay.ts:280-296` — final edit fallback (send-as-new-message) never triggers
- User sees truncated text from the last successful streaming edit

Evidence from `~/.openclaw/logs/telegram-bot.stderr.log` (2026-03-16): 48 `editMessageText` failures logged by the inner API transformer at `telegram-bot.ts:425` (`HTTP error: method=editMessageText ...`), but none visible in stream-relay logs — confirming errors are swallowed by autoRetry before reaching stream-relay error handlers.

## Reference: stream-relay Error Handling Chain (bot-4qi)

**Streaming edit** (`src/stream-relay.ts:157-173`):
```typescript
const doEdit = async () => {
    // ...
    try {
      await platform.editMessage(sentMessageId, displayText);
      lastEditTime = Date.now();
    } catch (err) {
      // Cosmetic — logged as debug, swallowed. This is fine.
      log.debug("stream-relay", `Streaming edit failed: ...`);
    }
};
```

**Final edit with fallback** (`src/stream-relay.ts:276-298`):
```typescript
try {
    await platform.editMessage(sentMessageId, chunks[0]);
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("not modified")) {
        log.warn("stream-relay", `Final edit failed, sending as new message: ${msg}`);
        try {
            sentMessageId = await platform.sendMessage(chunks[0]);
            // ...
        } catch (fallbackErr) {
            log.error("stream-relay", `Fallback reply also failed: ...`);
            return;
        }
    }
}
```

This fallback logic is correct but **never executes** because autoRetry eats the error.

## Reference: Cron Delivery Code (bot-mmz)

**CronJob interface** (`src/types.ts:61-70`):
```typescript
export interface CronJob {
    name: string;
    schedule: string;
    prompt: string;
    agentId: string;
    deliveryChatId: number;
    deliveryThreadId?: number;
    timeout?: number;
    maxBudget?: number;
    // No adminChatId or fallback fields
}
```

**deliver function** (`src/cron-runner.ts:85-100`):
```typescript
function deliver(chatId: number, message: string, threadId?: number): void {
    try {
        execSync(buildDeliverCommand(chatId, threadId), {
            input: message, encoding: "utf8", timeout: 30000,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (err) {
        throw new Error(`Delivery failed: ${(err as Error).message}`);
    }
}
```

**Delivery call site** (`src/cron-runner.ts:207-216`):
```typescript
try {
    deliver(cron.deliveryChatId, output, cron.deliveryThreadId);
    log(taskName, `Delivered to chat ${cron.deliveryChatId}...`);
} catch (err) {
    log(taskName, `FAIL delivery: ${(err as Error).message}`);
    // No secondary notification — just exit
    process.exit(1);
}
```

**BotConfig interface** (`src/types.ts:85-93`):
```typescript
export interface BotConfig {
    telegramToken?: string;
    agents: Record<string, AgentConfig>;
    bindings: TelegramBinding[];
    sessionDefaults: SessionDefaults;
    logLevel?: LogLevel;
    metricsPort?: number;
    discord?: DiscordConfig;
    // No adminChatId field
}
```

**loadCronTask** (`src/cron-runner.ts:34-64`) — parses crons.yaml into CronJob, no adminChatId parsing.

**config.ts loadConfig** (`src/config.ts:225-293`) — returns BotConfig, no adminChatId field.

## Reference: Existing Test Files

- `src/__tests__/telegram-bot.test.ts` — tests for bot setup
- `src/__tests__/stream-relay.test.ts` — tests for streaming + fallback logic
- `src/__tests__/cron-runner.test.ts` — tests for cron task loading + delivery

## Tasks

### Task 1: Fix autoRetry error swallowing (bot-4qi)

autoRetry plugin silently absorbs HttpErrors after exhausting retries. This prevents stream-relay's fallback logic (send final text as new message) from executing when editMessageText fails during network issues. 48 such failures observed in a single day (2026-03-16).

What we want: HttpErrors propagate to callers after retry exhaustion, so stream-relay's existing fallback logic can trigger.

- [x] `rethrowHttpErrors: true` is set in autoRetry config at `src/telegram-bot.ts:429`
- [x] stream-relay final edit fallback (lines 280-296) receives errors and sends text as new message when editMessageText fails
- [x] Add test: autoRetry config includes `rethrowHttpErrors: true`
- [x] Add test: stream-relay final edit fallback triggers when platform.editMessage throws
- [x] Verify existing tests pass

### Task 2: Add adminChatId fallback for cron delivery failures (bot-mmz)

When cron delivery to `deliveryChatId` fails, the error is only logged to a local file. No one is notified. If the target chat becomes unreachable (bot blocked, chat deleted), cron failures are invisible.

What we want: Optional `adminChatId` in config.yaml (top-level). When set, cron-runner sends a fallback notification there on delivery failure. When not set, current behavior (log-only) is preserved.

- [x] `BotConfig` interface in `src/types.ts` has optional `adminChatId?: number` field
- [x] `config.ts` `loadConfig` parses and validates `adminChatId` from config.yaml
- [x] `cron-runner.ts` reads `adminChatId` from config and sends fallback notification on delivery failure
- [x] Fallback notification includes: cron name, target chatId, error message
- [x] If `adminChatId` is not set, behavior is unchanged (log-only)
- [x] If fallback notification itself fails, error is logged (no infinite retry)
- [x] Add test: adminChatId parsed from config when present
- [x] Add test: cron delivery failure triggers fallback notification to adminChatId
- [x] Add test: no fallback attempt when adminChatId is not configured
- [x] Verify existing tests pass
