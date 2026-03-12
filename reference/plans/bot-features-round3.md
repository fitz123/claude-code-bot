# Bot Features and Fixes — Round 3

## Goal

Implement 4 features/fixes for the Telegram bot. Reference OpenClaw's queue implementation at `~/minime/openclaw/src/auto-reply/reply/queue/` for the collect pattern design.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Real Claude CLI stream-json event shapes

Use these real event shapes in tests. Captured from `claude -p --output-format stream-json --verbose --include-partial-messages`:

```jsonl
{"type":"system","subtype":"init","session_id":"c9d40f09-...","model":"claude-opus-4-6"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"! How"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" can I help you today?"}}}
{"type":"assistant","message":{"model":"claude-opus-4-6","role":"assistant","content":[{"type":"text","text":"Hello! How can I help you today?"}]}}
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}
{"type":"stream_event","event":{"type":"message_stop"}}
{"type":"result","subtype":"success","is_error":false,"result":"Hello! How can I help you today?","stop_reason":"end_turn","session_id":"c9d40f09-..."}
```

Key facts:
- Streaming deltas have `type: "stream_event"` (NOT `type: "assistant"` with `subtype: "stream_event"`)
- The `assistant` message (full text) arrives AFTER all deltas — do NOT accumulate text from it
- The `result` message also contains full text — do NOT accumulate text from it
- `extractTextDelta()` must check `msg.type === "stream_event"` and look for `event.delta.type === "text_delta"`
- Round 2 already fixed this in `extractTextDelta()` — verify tests use correct shapes

## Previous bugs found in testing (avoid regressions)

- `readStream()` creating new readline per call leaked listeners (MaxListenersExceededWarning after ~10 messages). Fixed in round 2.
- `extractText()` was accumulating text from deltas + assistant message + result = triple text. Fixed in round 2.
- Session stderr log was 0 bytes on crash. Fix attempted in round 2 (removed premature logStream.end()). Not yet verified.

## Tasks

### Task 1: Message batching and mid-turn queue (bot-43s, P1)

Messages sent rapidly by the user should be concatenated into a single message before sending to Claude. If messages arrive while Claude is already processing a response, they should be queued and delivered as a combined followup after the current turn finishes.

Two behaviors:
- **Pre-send debounce** (3s window): hold incoming messages, reset timer on each new one, send concatenated result when timer expires
- **Mid-turn collect**: buffer messages arriving during active processing, combine into a single followup prompt when the turn completes, formatted like:
  ```
  [Queued messages while agent was busy]
  ---
  Queued #1
  <text>
  ---
  Queued #2
  <text>
  ```

Reference implementation: OpenClaw `~/minime/openclaw/src/auto-reply/reply/queue/` (modes, debounce, drain loop, collect prompt building). Key files: `types.ts` (QueueMode, QueueSettings), `settings.ts` (resolveQueueSettings), `drain.ts` (scheduleFollowupDrain, buildCollectPrompt), `state.ts` (DEFAULT_QUEUE_DEBOUNCE_MS=1000, DEFAULT_QUEUE_CAP=20).

- [x] Implement pre-send debounce in message handler
- [x] Implement mid-turn collect queue
- [x] Auto-drain queued messages after turn completes
- [x] Update tests

### Task 2: Verify and fix subprocess crash logging (bot-ai2, P1)

Previous ralphex round attempted to fix empty session stderr logs by removing premature `logStream.end()`. Verify the fix works — when a subprocess crashes, `~/.openclaw/logs/session-<chatId>.log` should contain the actual error output. If still broken, investigate and fix.

- [x] Verify stderr logging captures subprocess crash output
- [x] Fix if still broken
- [x] Update tests

### Task 3: Enhanced /status command with session health (bot-7ed, P2)

The `/status` command should show real subprocess state so the user can tell if Claude is alive, working, or hung. Currently it only shows active count, memory, uptime, and idle time.

Add: subprocess PID, whether the process is alive, current response duration if processing, last successful response timestamp, subprocess restart count.

- [x] Add subprocess health info to /status output
- [x] Update tests

### Task 4: Per-topic bindings for forum supergroups (bot-h7j, P3)

Allow binding a specific Telegram forum topic (thread) to an agent. The `topicId` field already exists in `TelegramBinding` type and config parser. The stream relay already passes `message_thread_id` for replies. Missing pieces: routing and session isolation.

`resolveBinding()` in `telegram-bot.ts` currently matches only on `chatId` — it should also match `topicId` when set in the binding config. Session key is currently just `chatId` string — it should include topicId so each topic gets its own Claude session. grammY exposes topic as `ctx.msg.message_thread_id`.

- [ ] Update binding resolution to match chatId + topicId
- [ ] Update session key to include topicId
- [ ] Update tests
