# Stop autoRetry from amplifying rate-limited sendMessageDraft — Round 1

## Goal

Issue #117: streaming replies in DMs produce dense bursts of 429 logs because every rate-limited `sendMessageDraft` call is retried up to 5 times by `@grammyjs/auto-retry`. Drafts are cosmetic (fire-and-forget at the caller, auto-cleared by the final `sendMessage`), so retries add no user-visible value — only log noise and amplified Prometheus error counters. Skip the retry chain for `sendMessageDraft` only, leaving every other method's retry behavior identical.

## Validation Commands

```bash
cd bot && npx tsc --noEmit && npm test
```

## Reference: Current transformer chain

`bot/src/telegram-bot.ts:610-616` — two transformers registered on `bot.api.config`, both fire for every API call:

```ts
  // Log Telegram API errors, especially 429 rate limits, and count every API
  // call attempt by binding (inner transformer — sees each individual attempt
  // before autoRetry decides whether to retry)
  bot.api.config.use(createApiErrorLoggingTransformer({ bindings: config.bindings }));

  // Auto-retry on rate limits (outermost transformer — retries after inner errors)
  bot.api.config.use(autoRetry(AUTO_RETRY_OPTIONS));
```

`bot/src/telegram-bot.ts:589-594` — exported options that govern every retried method:

```ts
/** autoRetry options — exported so tests can assert the rethrowHttpErrors value. */
export const AUTO_RETRY_OPTIONS = {
  maxRetryAttempts: 5,
  maxDelaySeconds: 60,
  rethrowHttpErrors: false,
} as const;
```

There is no per-method filter at registration time.

## Reference: @grammyjs/auto-retry has no per-method filter

`bot/node_modules/@grammyjs/auto-retry/out/mod.js:34-39` — the only options exposed:

```js
function autoRetry(options) {
    const maxDelay = options?.maxDelaySeconds ?? Infinity;
    const maxRetries = options?.maxRetryAttempts ?? Infinity;
    const rethrowInternalServerErrors = options?.rethrowInternalServerErrors ?? false;
    const rethrowHttpErrors = options?.rethrowHttpErrors ?? false;
```

The returned transformer is a flat closure: `async (prev, method, payload, signal) => ...`. It does not branch on `method`. Filtering must therefore happen one layer up — by either skipping `autoRetry`'s transformer for matching methods, or by wrapping a method-name guard around it.

## Reference: Drafts are fire-and-forget at the caller

`bot/src/stream-relay.ts:174-182`:

```ts
const sendDraftNow = () => {
  if (!accumulated) return;
  const collapsed = collapseNewlines(accumulated);
  const displayText = collapsed.length > platform.maxMessageLength
    ? collapsed.slice(0, platform.maxMessageLength - 3) + "..."
    : collapsed;
  draftPromises.push(platform.sendDraft(draftId, displayText).catch(() => {}));
  lastDraftTime = Date.now();
};
```

`bot/src/telegram-adapter.ts:60-71`:

```ts
async sendDraft(draftId: number, text: string): Promise<void> {
  if (!chatId || !isDm) return;
  const html = markdownToHtml(text);
  try {
    await ctx.api.sendMessageDraft(chatId, draftId, html, {
      parse_mode: "HTML",
      ...threadOpts,
    });
  } catch {
    // Draft failures are cosmetic — silently ignore
  }
}
```

Drafts have no recovery semantics — a 429 retry that arrives 3-10 seconds late would land on a stream that has already moved on. The final `sendMessage` (which IS retried) is what guarantees delivery.

## Reference: Misleading comment that motivated the original 300ms debounce

`bot/src/stream-relay.ts:123-124`:

```ts
/** Debounce interval for draft updates (ms). Drafts are cosmetic — no rate limits. */
const DRAFT_DEBOUNCE_MS = 300;
```

The "no rate limits" claim is contradicted by empirical observation (issue #117 — drafts hit Telegram's per-chat ~1/sec limit in DMs).

## Reference: Live evidence of the cascade

Anonymized burst from the bot's stderr log (single user-message in a DM, post-observability deploy):

```
2026-05-25T15:15:07.093Z WARN [telegram-api] Rate limited: method=sendMessageDraft chat_id=<DM> retry_after=4
2026-05-25T15:15:07.434Z WARN [telegram-api] Rate limited: method=sendMessageDraft chat_id=<DM> retry_after=4
2026-05-25T15:15:07.967Z WARN [telegram-api] Rate limited: method=sendMessageDraft chat_id=<DM> retry_after=3
2026-05-25T15:15:08.415Z WARN [telegram-api] Rate limited: method=sendMessageDraft chat_id=<DM> retry_after=3
2026-05-25T15:15:08.981Z WARN [telegram-api] Rate limited: method=sendMessageDraft chat_id=<DM> retry_after=3
2026-05-25T15:15:09.472Z WARN [telegram-api] Rate limited: method=sendMessageDraft chat_id=<DM> retry_after=3
```

Cumulative rate-limit counts since the observability deploy (~10 days):

```
1109 sendMessageDraft
 180 sendChatAction
```

`sendMessageDraft` accounts for ~86% of all rate-limit log entries. With `maxRetryAttempts: 5`, the underlying number of distinct user-streaming events triggering 429s is roughly 1/5th of that — the rest is amplification.

## Reference: Reviewer convergence (issue #117 comment)

Two independent reviewers (codex CLI + a fresh Opus session reading source separately) both proposed the same shape of fix, captured in #117's review comment: a thin wrapper transformer registered in place of bare `autoRetry`, gated on `method === "sendMessageDraft"`. They diverged on whether Option A (raise `DRAFT_DEBOUNCE_MS`) is also necessary — that decision is explicitly out of scope here; we ship the autoRetry skip first and measure residual draft 429 ratio against the new `bot_telegram_api_calls_total` counter before deciding.

## Reference: Existing test patterns for transformers

`bot/src/__tests__/telegram-bot.test.ts` already has the `createApiErrorLoggingTransformer` test block with `captureWarn`, mock `prev` returning `{ ok: false, error_code: 429, parameters: { retry_after: 3 } }`, and explicit invocation as `await transformer(prev as never, "sendMessageDraft", { chat_id: 555000111, draft_id: 1, text: "x" })`. The same shape extends naturally to verifying that the new wrapper does or does not invoke `autoRetry`'s inner transformer based on `method`.

## Tasks

### Task 1: Skip autoRetry for sendMessageDraft (telegram-draft-autoretry-skip, P1)

**Problem:** Every rate-limited `sendMessageDraft` call to a DM hits autoRetry, which awaits Telegram's `retry_after` (3-10 s) and retries up to 5 times. By the time a retry fires, the stream has produced newer accumulated text — the retry's payload is stale. Meanwhile the new draft, fired ~300 ms after the previous one, queues behind the same rate limit. The result is documented in #117: a single ~10-20 s streaming reply produces 60-80 `[telegram-api]` warn lines and 60-80 increments on `bot_telegram_api_errors_total{method="sendMessageDraft", error_code="429"}`, even though the user observes a single successful final `sendMessage`. Cumulative since observability landed: 1109 `sendMessageDraft` 429 lines vs ~180 for the next-noisiest method.

`@grammyjs/auto-retry` exposes no per-method filter (see Reference section); filtering must happen at the transformer-chain layer. The existing two-layer chain (inner = logging/counter, outer = autoRetry) is in `bot/src/telegram-bot.ts:610-616`.

The misleading comment at `bot/src/stream-relay.ts:123` ("Drafts are cosmetic — no rate limits") is the assumption that originally set `DRAFT_DEBOUNCE_MS = 300`. It needs to be replaced with an accurate statement so a future contributor doesn't recreate the same regression.

**What we want:** Outbound `sendMessageDraft` calls go through the API once and surface their result (success or 429) to the caller without any retry-induced amplification. Every other Telegram API method (`sendMessage`, `sendChatAction`, `editMessageText`, `deleteMessage`, etc.) retains the current `AUTO_RETRY_OPTIONS` behavior unchanged. The inline rationale at `stream-relay.ts:123` reflects reality.

- [x] A single rate-limited `sendMessageDraft` call produces exactly one `Rate limited` warn line and one `bot_telegram_api_errors_total{method="sendMessageDraft", error_code="429"}` increment — not the current up-to-five
- [x] A rate-limited `sendMessage` (and any other method targeting a chat) still retries per `AUTO_RETRY_OPTIONS.maxRetryAttempts = 5` after waiting `retry_after`
- [x] The fire-and-forget call path at `bot/src/stream-relay.ts:174-182` is unchanged — no caller change required
- [x] The misleading inline comment at `bot/src/stream-relay.ts:123` is replaced with one that accurately describes the per-chat rate-limit reality and references issue #117 (or the autoRetry-skip behavior) so the constant's value is understandable to a future reader
- [x] `AUTO_RETRY_OPTIONS` continues to be exported with the same shape (existing tests in `__tests__/telegram-bot.test.ts` assert this)
- [x] Add tests covering: (a) `sendMessageDraft` bypasses retry (calls `prev` exactly once when result is 429 with `retry_after`), (b) `sendMessage` still retries on 429, (c) `sendChatAction` still retries on 429
- [x] Verify existing tests pass
