# Telegram API call observability — chat_id in logs, binding-labelled metric — Round 1

> **Note (completed):** Reference sections below describe the pre-PR codebase state at the time the plan was written. File:line citations point at the legacy inline transformer; the merged implementation refactored it into the `createApiErrorLoggingTransformer` factory. See the merge commit on this branch for the post-implementation code.

## Goal

Add diagnostic data to Telegram API error logging and introduce a baseline call counter so future 429 bursts can be traced to a specific binding without having to cross-reference session JSONL timestamps. Observability-only change — no retry/throttle behavior is modified.

## Validation Commands

```bash
cd bot && npx tsc --noEmit && npm test
```

## Reference: Current rate-limit logging

`bot/src/telegram-bot.ts:519-534` — inner transformer that logs 429s and records `bot_telegram_api_errors_total`:

```ts
bot.api.config.use(async (prev, method, payload, signal) => {
  try {
    const res = await prev(method, payload, signal);
    if (!res.ok && res.error_code === 429) {
      log.warn("telegram-api", `Rate limited: method=${String(method)} retry_after=${res.parameters?.retry_after ?? "unknown"}`);
      recordTelegramApiError(String(method), 429);
    } else if (!res.ok && res.error_code) {
      recordTelegramApiError(String(method), res.error_code);
    }
    return res;
  } catch (err) {
    log.warn("telegram-api", `HTTP error: method=${String(method)} ${err instanceof Error ? err.message : err}`);
    recordTelegramApiError(String(method), "http_error");
    throw err;
  }
});
```

The `payload` argument carries `chat_id` and `message_thread_id` for chat-targeting methods (sendMessage, sendMessageDraft, sendChatAction, editMessageText, deleteMessage, etc.) but neither value is included in the log line or the error metric.

## Reference: Current metric

`bot/src/metrics.ts:54-60`:

```ts
export const telegramApiErrors = new client.Counter({
  name: "bot_telegram_api_errors_total",
  help: "Total Telegram API errors",
  labelNames: ["method", "error_code"] as const,
});
```

`bot/src/metrics.ts:123-128` — sole recorder, called from the transformer above:

```ts
export function recordTelegramApiError(method: string, errorCode: number | string): void {
  telegramApiErrors.inc({ method, error_code: String(errorCode) });
}
```

No counter exists for successful (non-error) API calls. Error rate cannot be expressed as a ratio (`errors / total_calls`) — only as an absolute rate.

## Reference: Live error counter snapshot (2026-05-15)

`curl -s http://127.0.0.1:9091/metrics | grep bot_telegram_api_errors_total`:

```
bot_telegram_api_errors_total{method="sendMessageDraft",error_code="429"} 78
bot_telegram_api_errors_total{method="sendChatAction",error_code="429"} 12
bot_telegram_api_errors_total{method="getUpdates",error_code="http_error"} 6
```

Sample log lines from the 19:15 MSK burst (bot stderr log):

```
2026-05-15T16:15:17.160Z WARN [telegram-api] Rate limited: method=sendMessageDraft retry_after=3
2026-05-15T16:15:17.199Z WARN [telegram-api] Rate limited: method=sendMessageDraft retry_after=3
2026-05-15T16:15:17.622Z WARN [telegram-api] Rate limited: method=sendMessageDraft retry_after=3
```

Determining which binding produced these required cross-referencing Claude session JSONL modification times — log alone had no chat context.

## Reference: Binding labels are bounded

`bot/src/types.ts:22-32`:

```ts
export interface TelegramBinding {
  chatId: number;
  agentId: string;
  kind: "dm" | "group";
  topicId?: number;
  label?: string;
  requireMention?: boolean;
  topics?: TopicOverride[];
  voiceTranscriptEcho?: boolean;
  typingIndicator?: boolean;
}
```

`label` is a human-readable string assigned in config (e.g. `"User1 DM"`, `"MyGroup"`). The runtime binding set is bounded (typical production deployments have on the order of 5-15 entries plus per-topic overrides), making `label` a safe Prometheus label dimension. Raw `chat_id` is not — it would balloon cardinality as new chats are added.

`bot/src/telegram-bot.ts:52-87` — `resolveBinding(chatId, bindings, topicId?)` already returns the resolved binding (including topic overrides) for a given chat/topic pair.

## Reference: Existing test coverage

`bot/src/__tests__/telegram-bot.test.ts` — `resolveBinding` has ~10 describe blocks covering chatId-only, topicId match, topics-array overrides, unlisted topics, and DM bindings.

`bot/src/__tests__/metrics.test.ts` exists and tests recorder functions.

Both test files are the conventional location for the work in this plan.

## Tasks

### Task 1: Add chat context to Telegram API rate-limit and HTTP-error logs (telegram-api-chat-id-log, P1)

**Problem:** A recent `TelegramAPIErrors` alert (78 × `sendMessageDraft` 429 + 12 × `sendChatAction` 429 + 6 × `getUpdates` http_error within a few minutes) could not be attributed to a binding from the log lines alone. The diagnosis required correlating burst timestamps against modification times of Claude session JSONL files under `~/.claude/projects/` to identify which DM binding was the source. This correlation is fragile, manual, and fails if multiple DMs stream concurrently.

**What we want:** Every `Rate limited` and `HTTP error` warning produced by the inner Telegram API transformer (`bot/src/telegram-bot.ts:519-534`) carries the originating `chat_id` and (when present) `message_thread_id`, so a single `grep` over `telegram-bot.stderr.log` answers "which chat triggered this burst" without external correlation.

- [x] `Rate limited` log line includes `chat_id` when the API payload contains one
- [x] `Rate limited` log line includes `message_thread_id` when present in the payload
- [x] `HTTP error` log line includes the same `chat_id` / `message_thread_id` context
- [x] Methods without a `chat_id` payload (`getUpdates`, `getMe`, `setWebhook`, etc.) continue to log cleanly without the chat fields, not with `chat_id=undefined`
- [x] Add tests covering: rate-limit with chat-targeted payload, rate-limit with non-chat payload, http_error with chat-targeted payload
- [x] Verify existing tests pass

### Task 2: Introduce binding-labelled call counter `bot_telegram_api_calls_total` (telegram-api-calls-metric, P1)

**Problem:** `bot_telegram_api_errors_total` reports absolute error rate but no denominator. `rate(bot_telegram_api_errors_total[5m]) > 0.1` (the current alert at `monitoring/prometheus/rules.yml:22-23`) fires identically whether the bot made 1 API call (100% error) or 10,000 calls (≪1% error). Without a baseline counter, we cannot decide whether the 429s on `sendMessageDraft` represent a meaningful fraction of draft traffic or are noise relative to a high-volume baseline — and therefore cannot judge whether `DRAFT_DEBOUNCE_MS` (`bot/src/stream-relay.ts:124`) or `AUTO_RETRY_OPTIONS` (`bot/src/telegram-bot.ts:497-501`) needs adjustment.

**What we want:** Every Telegram API call (success or failure) is counted in a new Prometheus counter, labelled by `method` and by a low-cardinality identifier of the originating binding. The error counter remains as-is — they are complementary, not a replacement.

- [x] A new counter `bot_telegram_api_calls_total` is exposed at `/metrics`
- [x] Counter is labelled with `method` and one bounded-cardinality binding identifier — pick what fits the existing binding model (e.g. `binding.label`, falling back to a fixed sentinel when no binding applies); the value MUST come from the resolved binding, never the raw `chat_id`
- [x] Counter increments exactly once per call, regardless of outcome
- [x] Calls without an originating binding (poll loop like `getUpdates`, system methods like `getMe`) increment with a stable sentinel label (e.g. `"none"`) — they do not silently drop
- [x] Methods that target a chat but whose `chat_id` does not resolve to any configured binding (incoming message from an unbound chat, cron sending to an unknown chat) use a distinct sentinel (e.g. `"unbound"`) so they are visible in metrics but separable from `"none"`
- [x] Documentation in `README.md` metrics section lists the new counter alongside the existing error counter
- [x] Add tests covering: counter increments on success, counter increments on 429, counter uses correct binding label for a chat-targeted call, counter uses sentinel for non-chat-targeted call, counter uses unbound sentinel for chat_id with no matching binding
- [x] Verify existing tests pass
