# Review: Telegram Bot Implementation — Bug Fixes

## Goal

Fix all known bugs in the grammY Telegram bot that wraps Claude Code CLI as a subprocess. The bot runs but has critical issues discovered during manual testing.

## Context

The bot was migrated from OpenClaw gateway to a standalone grammY + Claude Code CLI subprocess architecture. Source files are in `src/`. Tests are in `src/__tests__/`. The bot spawns `claude` CLI processes with `--input-format stream-json --output-format stream-json` and relays responses to Telegram.

Key architectural constraint: each Telegram chat gets one long-lived Claude subprocess. Messages are queued (PQueue concurrency=1) per session. The subprocess persists across messages via `--resume`.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Tasks

### Task 1: Fix double response text (CRITICAL)

**Bug:** User receives the same response text 2-3 times concatenated in a single message.

**Root cause:** `stream-relay.ts:extractText()` returns text from ALL event types and `relayStream()` accumulates all of them into `accumulated`:
- `extractTextDelta()` returns streaming deltas (e.g. "Hel", "lo", " wo", "rld") → accumulated one by one
- `extractAssistantText()` returns the FULL assistant message text ("Hello world") → ALSO added to accumulated
- `extractResultText()` returns the FULL result text ("Hello world") → ALSO added to accumulated

Claude CLI sends events in this order: content_block_delta (many) → assistant message (full text) → result (full text). So accumulated becomes "Hello worldHello worldHello world".

**Fix in `stream-relay.ts:extractText()`:**
- Track whether we've received any deltas
- If deltas were received, skip `extractAssistantText()` and `extractResultText()` text accumulation — only use them for `isFinal` detection
- OR: only return text from one source (deltas if available, otherwise assistant text, otherwise result text)

**Files:**
- [x] `src/stream-relay.ts` — `extractText()` function and `relayStream()` accumulation logic
- [x] `src/cli-protocol.ts` — `extractTextDelta()`, `extractAssistantText()`, `extractResultText()` (read-only, understand what each returns)
- [x] `src/__tests__/stream-relay.test.ts` — add/update tests for extractText behavior

### Task 2: Fix sendSessionMessage to actually stream

**Bug:** `sendSessionMessage` in `session-manager.ts` is an async generator but doesn't actually stream. It collects ALL response lines into an array inside `queue.add()`, then yields them after the queue task completes. This means the user sees only a typing indicator for the entire response duration with no progressive updates.

**Root cause:** The async generator pattern doesn't work with PQueue because `queue.add()` returns a Promise that resolves only after the callback completes.

**Fix:** Use an async queue/channel pattern:
- Create an `AsyncQueue<StreamLine>` (simple push/pull channel) 
- Inside `queue.add()`, read lines and push to the channel
- The generator yields from the channel as items arrive
- Signal completion when `result` type is received or on error

A simple implementation: array + resolve callback pattern, or use a `ReadableStream` as the bridge.

**Files:**
- [x] `src/session-manager.ts` — `sendSessionMessage()` method
- [x] `src/__tests__/session-manager.test.ts` — test streaming behavior

### Task 3: Handle EPIPE from dead subprocess

**Bug:** When a Claude subprocess dies (crash, OOM, network), `sendMessage()` writes to a destroyed stdin pipe. This throws an EPIPE error that isn't caught by the try/catch in `telegram-bot.ts` because it's an async error on the stream. It surfaces as `uncaughtException`, which may crash the bot or leave the session in a corrupt state.

**Fix:**
- In `sendMessage()` (`cli-protocol.ts`): check `child.stdin.destroyed` before writing (already partially done), and wrap `write()` in try/catch
- In `session-manager.ts`: add error handler on `child.stdin` to catch EPIPE gracefully
- In `session-manager.ts`: if child is dead when `sendSessionMessage` is called, auto-close and recreate the session before sending

**Files:**
- [x] `src/cli-protocol.ts` — `sendMessage()` function
- [x] `src/session-manager.ts` — `sendSessionMessage()` and `getOrCreateSession()`
- [x] `src/__tests__/session-manager.test.ts` — test dead process recovery

### Task 4: Add subprocess startup timeout

**Bug:** `getOrCreateSession` spawns Claude CLI but never checks if it started successfully. If Claude hangs (auth failure, network issues, Anthropic API down), the session is stuck with an infinite typing indicator.

**Fix:**
- After `spawnClaudeSession()`, wait for first stdout line OR process exit, with a timeout (e.g. 30 seconds)
- If timeout or early exit: throw an error, clean up the child process
- The caller in `telegram-bot.ts` already has try/catch that will send an error message to the user

**Files:**
- [x] `src/session-manager.ts` — `getOrCreateSession()` method
- [x] `src/__tests__/session-manager.test.ts` — test timeout behavior

### Task 5: Clean up dead waitForInit code

**Bug:** `waitForInit()` in `cli-protocol.ts` is exported and defined but no longer called anywhere (removed in commit f71ef4a). Dead code.

**Fix:**
- Remove `waitForInit()` function from `cli-protocol.ts`
- Remove `SystemInit` from type imports if only used by `waitForInit`
- Verify no other code references it

**Files:**
- [x] `src/cli-protocol.ts` — remove `waitForInit()`
- [x] `src/types.ts` — check if `SystemInit` type is still needed elsewhere
