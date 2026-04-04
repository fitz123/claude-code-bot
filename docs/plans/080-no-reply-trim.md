# Plan: Fix NO_REPLY check to use trim/startsWith

GitHub issue: #80

## Problem

When a cron LLM response starts with `NO_REPLY` but includes additional text (e.g. `NO_REPLY\n\nExplanation...`), the exact match `output === "NO_REPLY"` fails and the entire response gets delivered to the user.

Real example from bedtime-reminder cron:
```
NO_REPLY

Завтра (1 апреля) нет событий с конкретным временем...
```

## Root cause

`bot/src/cron-runner.ts:394`:
```ts
if (cron.type === "llm" && output === "NO_REPLY") {
```

Exact match doesn't handle trailing whitespace or extra text after `NO_REPLY`.

## Fix

Change line 394 from:
```ts
if (cron.type === "llm" && output === "NO_REPLY") {
```
to:
```ts
if (cron.type === "llm" && /^NO_REPLY(\s|$)/.test(output.trim())) {
```

Regex requires word boundary (`\s` or end-of-string) after `NO_REPLY` to avoid false matches on strings like `NO_REPLY_EXTRA`.

Also check `bot/src/stream-relay.ts` and `bot/src/message-queue.ts` for similar NO_REPLY checks — apply the same pattern everywhere.

## Files to change

- [x] `bot/src/cron-runner.ts` — line 394, fix the check
- [x] Search all `NO_REPLY` checks in `bot/src/` — apply same fix if exact match found
- [x] Add/update tests for NO_REPLY with trailing text, whitespace, and clean NO_REPLY

## Tests

- [x] `NO_REPLY` exact — should be swallowed
- [x] `NO_REPLY\n\nSome text` — should be swallowed
- [x] `  NO_REPLY  ` — should be swallowed
- [x] `NO_REPLY_EXTRA` — should NOT be swallowed (regex word boundary correctly rejects this)
- [x] Regular output — should be delivered
