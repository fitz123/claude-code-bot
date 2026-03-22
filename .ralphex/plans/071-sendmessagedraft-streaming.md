# Replace editMessageText streaming with sendMessageDraft

GitHub issue: #71

## Context

Current streaming uses `sendMessage` + `editMessageText` with debounce. This causes 429 rate limits on editMessageText (retry_after up to 146s), resulting in truncated messages when the final edit is also rate-limited.

Telegram Bot API 9.3+ provides `sendMessageDraft` — designed specifically for streaming with no rate limit issues. grammY 1.41.1 supports it via `api.sendMessageDraft()`.

## New behavior

| Context | Streaming | Method |
|---|---|---|
| **DM (kind: "dm")** | Yes | `sendMessageDraft(draft_id, partial)` → `sendMessage(final)` |
| **Group/Channel** | No | `sendMessage(final)` only |

`editMessageText`-based streaming is removed entirely. No split strategy, no debounce tuning.

## Tasks

### Task 1: Refactor stream-relay.ts — replace editMessage streaming with sendMessageDraft

**File: `bot/src/stream-relay.ts`**

Remove:
- [x] `doEdit()` function (lines 166-183)
- [x] `scheduleEdit()` function (lines 185-196)
- [x] All `editMessage` calls for streaming (lines 177, 296)
- [x] `editTimer`, `editPending`, `lastEditTime` state variables
- [x] `sentMessageId` tracking for intermediate streaming (keep for NO_REPLY delete path)
- [x] The initial `sendMessage` for streaming (lines 234-248) — drafts replace this
- [x] The final `editMessage` + fallback path (lines 293-316)

Add:
- [x] `sendDraft(text)` method on PlatformContext — calls `sendMessageDraft` in DM, no-op in groups
- [x] Draft streaming loop: accumulate deltas, call `platform.sendDraft(accumulated)` with debounce
- [x] `draft_id` generation (random positive integer, stays same for entire response)
- [x] Final delivery: always `sendMessage(final)` — works for both DM (completes draft) and groups (sends as-is)

Keep unchanged:
- [x] `splitMessage()`, `collapseNewlines()`, `extractText()`, `sendOutboxFiles()`
- [x] Typing indicator logic
- [x] NO_REPLY handling (needs adjustment — drafts auto-disappear, no delete needed)
- [x] Multi-chunk overflow logic (sendMessage for remaining chunks)
- [x] Non-text block paragraph break insertion

**stream-relay.ts new flow:**
```
for await (msg of stream):
  accumulate text deltas
  if DM && have text:
    sendDraft(draft_id, accumulated)  // debounced, cosmetic failures OK
  if isFinal: break

// Final delivery (both DM and groups):
sendMessage(final_text)  // guaranteed, with retry
// Send overflow chunks as additional messages
```

### Task 2: Add sendDraft to PlatformContext interface and Telegram adapter

**File: `bot/src/types.ts`**

- Add `sendDraft(draftId: number, text: string): Promise<void>` to PlatformContext interface
- Remove `streamingUpdates` from TelegramBinding, DiscordBinding, DiscordChannelOverride, SessionDefaults
- Remove `editDebounceMs` from PlatformContext
- Keep `editMessage` on PlatformContext — still needed for other use cases (message corrections, etc.)

**File: `bot/src/telegram-adapter.ts`**

- Add `sendDraft` implementation: call `ctx.api.sendMessageDraft(chatId, { draft_id, text, message_thread_id })` with HTML formatting
- Implementation should be try/catch — draft failures are cosmetic, not critical
- Determine DM vs group from `binding.kind` — only send drafts for `kind: "dm"`
- Remove `TELEGRAM_EDIT_DEBOUNCE_MS` constant
- Remove `editDebounceMs` from returned PlatformContext
- Remove `streamingUpdates` from returned PlatformContext
- Keep `editMessage` method — may be used elsewhere

**File: `bot/src/discord-adapter.ts`**

- Add `sendDraft` as no-op (Discord has no equivalent API)
- Remove `DISCORD_EDIT_DEBOUNCE_MS` constant
- Remove `editDebounceMs` and `streamingUpdates` from returned PlatformContext

### Task 3: Remove streamingUpdates config from all config/docs/examples

**Files to clean:**
- `config.yaml` — remove `streamingUpdates` from sessionDefaults and any binding examples
- `README.md` — remove `streamingUpdates` and `editDebounceMs` references
- `CHANGELOG.md` — add entry for this change
- Any `.md` files referencing streaming config

**Search pattern:** `grep -rn "streamingUpdates\|editDebounceMs\|editMessage.*stream\|streaming.*edit" --include="*.{ts,md,yaml,json}"`

### Task 4: Update all tests

**Files:**
- `bot/src/__tests__/stream-relay.test.ts` — rewrite streaming tests: mock `sendDraft` instead of `editMessage`, test DM draft flow, test group final-only flow, test NO_REPLY with drafts
- `bot/src/__tests__/telegram-adapter.test.ts` — remove `streamingUpdates` tests, add `sendDraft` tests
- `bot/src/__tests__/discord-adapter.test.ts` — remove `streamingUpdates` tests, add no-op `sendDraft` test
- `bot/src/__tests__/config-defaults.test.ts` — remove `streamingUpdates` default tests
- `bot/src/__tests__/session-manager.test.ts` — remove any `streamingUpdates` references
- `bot/src/__tests__/message-queue.test.ts` — remove `streamingUpdates` references if any
- `bot/src/__tests__/metrics.test.ts` — remove `streamingUpdates` references if any

### Task 5: Remove streamingUpdates from config validation

**File: `bot/src/config.ts`**

- Remove `streamingUpdates` from binding validation schemas
- Remove `streamingUpdates` from sessionDefaults validation
- Remove `editDebounceMs` if present in config schema

## Verification

1. `npm test` — all tests pass
2. `npx tsc --noEmit` — no type errors
3. `grep -rn "streamingUpdates\|editDebounceMs" bot/src/ config.yaml README.md` — zero hits (except CHANGELOG)
4. DM: bot sends drafts during streaming, then final sendMessage
5. Group: bot sends only final sendMessage, no intermediate updates

## Risk

- `sendMessageDraft` is Bot API 9.3+ (Dec 2025), available to all bots since API 9.5 (Mar 2026). grammY 1.41.1 has types. If grammY method doesn't exist at runtime, Task 2 implementation should check and fall back gracefully.
- Draft only works in private chats — groups get final-only by design (which is what we want).
- NO_REPLY: drafts auto-disappear when `sendMessage` is not called — verify this behavior. If drafts persist, need explicit cleanup.
