# Plan: sessionDefaults fallback for streamingUpdates and requireMention

GitHub issue: #67

## Problem

`sessionDefaults.streamingUpdates` and `sessionDefaults.requireMention` are not used as fallbacks by adapters. Both Telegram and Discord adapters hardcode `true` as default when binding doesn't set these values.

## Goal

1. Add `streamingUpdates` and `requireMention` to `SessionDefaults` type and validation
2. Use `sessionDefaults` as fallback in adapters when binding doesn't specify a value
3. Change defaults: `streamingUpdates: false`, `requireMention: false`

## Files to change

- `bot/src/types.ts` — add fields to `SessionDefaults` interface
- `bot/src/config.ts` — parse new fields in `validateSessionDefaults()`, pass `sessionDefaults` to where adapters are created
- `bot/src/telegram-adapter.ts` — accept `sessionDefaults`, use as fallback for `streamingUpdates`
- `bot/src/discord-adapter.ts` — accept `sessionDefaults`, use as fallback for `streamingUpdates`
- `bot/src/telegram-bot.ts` — pass `sessionDefaults` to adapter; use as fallback for `requireMention` (line 363: `binding.requireMention ?? sessionDefaults.requireMention ?? false`)
- `bot/src/discord-bot.ts` — pass `sessionDefaults` to adapter; use as fallback for `requireMention` (line 81: `binding.requireMention ?? sessionDefaults.requireMention ?? false`)
- Tests — update existing tests, add new ones for fallback behavior

## Implementation details

### types.ts

Add to `SessionDefaults`:
```ts
streamingUpdates: boolean;
requireMention: boolean;
```

### config.ts — validateSessionDefaults()

Add parsing with defaults:
```ts
let streamingUpdates = false;
if (typeof obj.streamingUpdates === "boolean") {
  streamingUpdates = obj.streamingUpdates;
}

let requireMention = false;
if (typeof obj.requireMention === "boolean") {
  requireMention = obj.requireMention;
}
```

Return them in the result object.

### telegram-adapter.ts

Change function signature to accept `sessionDefaults`:
```ts
export function createTelegramAdapter(
  ctx: Context,
  binding?: TelegramBinding,
  threadIdOverride?: number,
  sessionDefaults?: SessionDefaults,
): PlatformContext {
```

Change line 38:
```ts
streamingUpdates: binding?.streamingUpdates ?? sessionDefaults?.streamingUpdates ?? false,
```

### discord-adapter.ts

Same pattern:
```ts
export function createDiscordAdapter(
  channel: DiscordSendableChannel,
  binding?: DiscordBinding,
  sessionDefaults?: SessionDefaults,
): PlatformContext {
```

Change line 29:
```ts
streamingUpdates: binding?.streamingUpdates ?? sessionDefaults?.streamingUpdates ?? false,
```

### telegram-bot.ts

Line 363 — change:
```ts
const requireMention = binding.requireMention ?? config.sessionDefaults.requireMention;
```

Pass `config.sessionDefaults` to `createTelegramAdapter()` calls.

### discord-bot.ts

Line 81 — change:
```ts
const requireMention = binding.requireMention ?? config.sessionDefaults.requireMention;
```

Pass `config.sessionDefaults` to `createDiscordAdapter()` calls.

### Tests

- [ ] Test that `validateSessionDefaults()` returns correct defaults when not specified
- [ ] Test that `validateSessionDefaults()` parses boolean values correctly
- [ ] Test telegram adapter uses sessionDefaults.streamingUpdates as fallback
- [ ] Test discord adapter uses sessionDefaults.streamingUpdates as fallback
- [ ] Test requireMention falls back to sessionDefaults in telegram shouldRespond
- [ ] Test requireMention falls back to sessionDefaults in discord shouldRespond
- [ ] Test binding-level values override sessionDefaults

## Checklist

- [ ] Add fields to SessionDefaults type
- [ ] Parse in validateSessionDefaults()
- [ ] Update telegram-adapter.ts fallback
- [ ] Update discord-adapter.ts fallback
- [ ] Update telegram-bot.ts requireMention fallback
- [ ] Update discord-bot.ts requireMention fallback
- [ ] Pass sessionDefaults to adapter creation call sites
- [ ] Update/add tests
- [ ] All tests pass
