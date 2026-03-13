# Bot Observability — Round 7

## Goal

Gain visibility into Telegram API errors (especially 429 rate limits) and fix truncated message delivery caused by silent error swallowing.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Reference: Silent catch blocks in stream-relay.ts

The `relayStream()` function has two bare `catch {}` blocks that swallow all errors from `editMessageText`:

**Streaming edit (line ~157):**
```typescript
try {
  await ctx.api.editMessageText(chatId, sentMessageId, displayText);
  lastEditTime = Date.now();
} catch {
  // Edit can fail if text hasn't changed - ignore
}
```

**Final edit (line ~241):**
```typescript
try {
  await ctx.api.editMessageText(chatId, sentMessageId, chunks[0]);
} catch {
  // May fail if text unchanged
}
```

The streaming edit (line ~157) is cosmetic — if it fails, the next edit or the final one will update the message. But the final edit (line ~241) is the last chance to deliver the complete text. If it fails (e.g. 429 rate limit), the user sees the last streaming preview — which is typically truncated at the debounce boundary — as the final message. There is no retry or fallback.

## Reference: autoRetry plugin in telegram-bot.ts

```typescript
import { autoRetry } from "@grammyjs/auto-retry";
// line ~210:
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
```

This silently retries failed API calls up to 3 times. We have zero visibility into when retries happen, how often we hit 429, or which methods are rate-limited.

## Reference: ResultMessage type in types.ts

```typescript
export interface ResultMessage {
  type: "result";
  result: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  [key: string]: unknown;
}
```

The `[key: string]: unknown` catch-all captures the full usage object from Claude CLI result events:
```json
{
  "type": "result",
  "total_cost_usd": 0.05,
  "duration_ms": 12345,
  "num_turns": 3,
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 800,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 500
  }
}
```

This data arrives in `session-manager.ts` where `line.type === "result"` is checked — tokens and cost are currently ignored.

## Reference: Current console.* usage

~41 `console.*` calls across 6 source files with no timestamps or severity levels:
- `main.ts` — 13 calls
- `message-queue.ts` — 7 calls
- `telegram-bot.ts` — 7 calls
- `config.ts` — 7 calls
- `session-manager.ts` — 5 calls
- `stream-relay.ts` — 1 call

## Tasks

### Task 1: Structured logger and truncated message fix (bot-0iv, P1)

**Problem 1: Messages are delivered truncated.** Users receive incomplete bot responses. The final `editMessageText` in `stream-relay.ts` (line ~241) is the last chance to deliver the complete text. When it fails (e.g. 429 rate limit), the error is silently swallowed by a bare `catch {}` and the user sees the last streaming preview as the final message. This is a real user-facing bug.

We want: if the final edit fails, the complete text must still be delivered to the user (via retry, fallback to new message, or another mechanism). A test must reproduce this scenario — mock editMessageText to throw on the final call and verify the complete text is still delivered.

**Problem 2: 429 rate limits are invisible.** The `autoRetry` plugin silently retries on 429. We don't know how often we hit rate limits, which methods are affected, or whether our retry strategy is sufficient. We need 429 and other Telegram API errors logged at WARN level with the method name and retry_after value. Research grammY's autoRetry plugin and transformer chain API to find the right hook point for intercepting these errors.

**Problem 3: No structured logging.** ~41 `console.*` calls with no timestamps or severity. Replace with a simple logger module (no external deps) adding ISO timestamps and level tags. Log level configurable via `config.yaml` (`logLevel` key) and `LOG_LEVEL` env var (env overrides config).

- [x] Final editMessageText failure delivers complete text via retry or fallback
- [x] Test reproducing truncated message scenario (final edit throws, text still delivered)
- [x] 429 rate limit errors are logged at WARN level with method and retry_after
- [x] Structured logger with ISO timestamps and severity levels replaces all console.* calls
- [x] Log level configurable via config.yaml and LOG_LEVEL env var
- [x] Tests for logger
- [x] Verify existing tests pass

### Task 2: Prometheus metrics endpoint (bot-2kp, P2)

**Problem:** We have no quantitative data on token usage, costs, API errors, or session health. The `result` events from Claude CLI contain tokens, cost, and duration data but it's discarded. We want to expose this via a standard Prometheus `/metrics` endpoint for monitoring and alerting.

**What we want to track:**
- Token usage — input, output, cache read, cache creation tokens per session
- Costs — USD cost per turn/session
- Telegram API errors — especially 429, by error code and method
- Session health — active sessions (gauge), crashes, turn durations
- Message flow — received and sent message counts by chat/type

**Requirements:**
- Use `prom-client` npm package
- Metrics port configurable via `config.yaml` (`metricsPort`). If not set, metrics endpoint is disabled.
- Standard Prometheus text format on `/metrics`
- Hook into existing code at natural points (result events in session-manager, message handlers in telegram-bot, error handlers)
- Tests for metric recording
- [ ] prom-client dependency added
- [ ] Metrics module with counters, gauges, and histograms for the data above
- [ ] Result event data (tokens, cost, duration) recorded from session-manager
- [ ] Telegram API error counts recorded
- [ ] Session lifecycle metrics (active gauge, crash counter)
- [ ] Message flow counters in telegram-bot handlers
- [ ] HTTP server on configurable port serving /metrics
- [ ] Tests for metric recording
- [ ] Verify existing tests pass
