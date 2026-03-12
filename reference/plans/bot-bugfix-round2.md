# Fix: Bugs Found in Manual Testing (Round 2)

## Goal

Fix 3 bugs discovered during manual testing of the Telegram bot after the first ralphex review pass.

## Context

Bot is at `~/.openclaw/bot/`. First ralphex pass fixed double response text, EPIPE handling, streaming architecture, startup timeout, and dead code. These 3 bugs were found by testing the running bot and inspecting real Claude CLI stream-json output.

Real Claude CLI stream-json output for reference (from `echo '...' | claude -p --output-format stream-json --include-partial-messages`):
- Streaming deltas arrive as `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}`
- NOT as `{"type":"assistant","subtype":"stream_event",...}`

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Tasks

### Task 1: Fix extractTextDelta wrong event type check (bot-jbr, P0)

`extractTextDelta()` in `cli-protocol.ts` checks `msg.type === "assistant" && msg.subtype === "stream_event"` but Claude CLI actually emits streaming deltas as `msg.type === "stream_event"` (top-level type, no subtype). All text deltas are silently dropped, making streaming non-functional.

- [x] Fix the type check to match real CLI output
- [x] Update tests to use correct event shape

### Task 2: Fix readline listener leak in readStream (bot-07l, P1)

`readStream()` in `cli-protocol.ts` creates a new `readline.createInterface()` on `child.stdout` each time it's called (once per message in `sendSessionMessage`). Previous readline instances are not closed, leaking `end`/`error`/`data` listeners on the underlying socket. After ~10 messages: `MaxListenersExceededWarning: 11 end listeners added to [Socket]`.

- [ ] Fix the readline lifecycle to avoid leaking listeners
- [ ] Update tests

### Task 3: Fix empty session stderr logs (bot-ai2, P1)

When a Claude subprocess crashes, the per-session log at `~/.openclaw/logs/session-<chatId>.log` is 0 bytes. `setupStderrLogging()` in `session-manager.ts` pipes `child.stderr` to a file, but crash details are not being captured. Investigate why and fix.

- [ ] Ensure subprocess crash output is captured in session logs
- [ ] Update tests
