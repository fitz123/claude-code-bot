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

User receives the same response text 2-3 times concatenated in a single message.

Investigate `stream-relay.ts` and `cli-protocol.ts` — how `extractText()` accumulates text from stream events, and whether multiple event types contribute duplicate text to the same `accumulated` buffer.

- [x] Identify root cause in text extraction/accumulation
- [x] Fix the duplication
- [x] Update tests in `src/__tests__/stream-relay.test.ts`

### Task 2: Fix sendSessionMessage to actually stream

`sendSessionMessage` in `session-manager.ts` is an async generator but doesn't actually stream — user sees only a typing indicator for the entire response duration with no progressive message updates.

Investigate how `queue.add()` interacts with the async generator pattern and why lines are yielded only after the full response completes.

- [x] Make response lines yield in real-time
- [x] Update tests in `src/__tests__/session-manager.test.ts`

### Task 3: Handle EPIPE from dead subprocess

When a Claude subprocess dies unexpectedly, writing to its stdin causes an EPIPE that surfaces as `uncaughtException` instead of being caught gracefully.

Investigate error propagation path from `sendMessage()` through the session manager to the telegram bot error handler.

- [x] Ensure EPIPE is caught and handled gracefully
- [x] Ensure dead sessions are recovered on next message
- [x] Update tests

### Task 4: Add subprocess startup timeout

`getOrCreateSession` spawns Claude CLI but never verifies it started successfully. If Claude hangs (auth, network), the session is stuck forever.

- [x] Add startup verification with timeout
- [x] Update tests

### Task 5: Clean up dead waitForInit code

`waitForInit()` in `cli-protocol.ts` is exported but no longer called anywhere. Remove dead code and any unused type imports.

- [x] Remove dead code
- [x] Verify no references remain
