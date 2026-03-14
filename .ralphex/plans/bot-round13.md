# Bot Fixes & Features — Round 13

## Goal

Fix paragraph breaks lost in Telegram messages (root cause in HTML conversion, not splitting), add topicId to message headers for inherited bindings, and implement mid-turn message injection so users can steer the agent during active turns.

## Validation Commands

```bash
npx tsc --noEmit && npm test
```

## Reference: Message pipeline (paragraph breaks)

The full pipeline from Claude output to Telegram:

1. Claude CLI outputs text via stream-json (newlines intact)
2. `relayStream()` accumulates text deltas (newlines intact)
3. `splitMessage()` splits at paragraph boundaries if >4096 chars — **already fixed in bot-round12**
4. `platform.sendMessage(chunk)` calls telegram-adapter
5. `createTelegramAdapter.sendMessage()` calls `markdownToHtml(text)` then `ctx.reply(html, { parse_mode: "HTML" })`

Current `markdownToHtml()` in `src/markdown-html.ts` (lines 90-113) does NOT convert `\n\n` to any HTML block structure. It outputs raw `\n` characters. In Telegram HTML mode, consecutive `\n` may be collapsed.

Current `createTelegramAdapter` in `src/telegram-adapter.ts` (lines 30-43):
```typescript
sendMessage: async (text: string) => {
  const html = markdownToHtml(text);
  try {
    const sent = await ctx.reply(html, { parse_mode: "HTML" });
    return sent.message_id;
  } catch {
    const sent = await ctx.reply(text);
    return sent.message_id;
  }
}
```

`splitMessage()` in `src/stream-relay.ts` (lines 12-55) was fixed in bot-round12 (commit a73d5f1) — walk-back logic preserves newline runs at split boundaries. `deliver.sh` (lines 81-121) also fixed (commit 1243661).

## Reference: Binding resolution (topicId)

`resolveBinding()` in `src/telegram-bot.ts` (lines 37-67):
- Exact topic-binding match (line 46): returns binding with explicit `topicId` ✓
- Topics-array match (lines 53-63): returns synthesized binding with `topicId` ✓
- **Fallback (line 66): returns base binding WITHOUT `topicId`** ← the gap

Every message handler reads `ctx.message?.message_thread_id` (e.g., line 524) and passes it to `resolveBinding()`, but the fallback path discards it.

`buildSourcePrefix()` at lines 74-97 correctly shows `Topic: <id>` when `binding.topicId` is defined — but it's never defined for fallback bindings.

Types:
```typescript
// src/types.ts
interface TelegramBinding {
  chatId: number; agentId: string; kind: "dm" | "group";
  topicId?: number; label?: string; requireMention?: boolean;
  topics?: TopicOverride[];
  // ...
}
interface TopicOverride {
  topicId: number; agentId?: string; requireMention?: boolean;
}
```

Current config for Minime HQ: `topics: [{ topicId: 1667, agentId: coder }]`. Topic 1667 gets topicId in header. Topics 591, 1890, 120 — no topicId shown.

Note: `MessageReactionUpdated` does NOT contain `message_thread_id`. This is a Telegram API limitation — reaction events cannot be routed to specific topics. Document this, don't try to fix.

## Reference: Current collect buffer and spawn env (mid-turn injection)

`MessageQueue` collect buffer in `src/message-queue.ts`:
- Lines 110-127: When `state.busy === true`, messages go to `collectBuffer` (in-memory array)
- Lines 190-225: `drainCollectBuffer()` delivers collected messages after turn completes with `[Queued messages while agent was busy]` header

`buildSpawnEnv()` in `src/cli-protocol.ts` (lines 79-98): currently only deletes `CLAUDECODE` and ensures homebrew in PATH. No custom env vars.

`sendMessage()` in `src/cli-protocol.ts` (lines 132-138): writes NDJSON `{"type":"user","message":...}` to child stdin. Writing during active turn queues for next turn (CLI limitation, not fixable).

Hooks live in agent workspaces (e.g., `/Users/ninja/.minime/workspace/.claude/settings.json`), NOT in bot repo. Current hooks: `protect-files.sh`, `guardian.sh` (PreToolUse, matcher `Edit|Write`), `auto-stage.sh` (PostToolUse).

Claude Code hooks API: PreToolUse hook can return JSON with `hookSpecificOutput.additionalContext` to inject text into current turn context. `systemMessage` is UI-only — Claude never sees it.

## Tasks

### Task 1: Fix paragraph breaks in Telegram HTML messages (bot-p2y, P1)

**Problem:** Paragraph breaks between sections are lost when messages are delivered to Telegram. User sees "логи.Ни одного" instead of "логи.\n\nНи одного". The splitMessage() fix from bot-round12 is correct for splitting, but the root cause is elsewhere in the pipeline.

**Evidence:** Screenshot from user showing missing paragraph break in a message that was NOT split (under 4096 chars). The splitMessage() fix only applies to messages exceeding 4096 chars.

**What we want:** All paragraph breaks (`\n\n`) in Claude's output are preserved when displayed in Telegram, regardless of message length or parse_mode.

**Key observation:** The problem occurs between tool calls. When Claude outputs text, then runs a tool, then outputs more text — the two text blocks are concatenated without any separator. Example: "план:" + [Edit tool] + "Добавил Task 4" → "план:Добавил Task 4".

**Root cause confirmed:** `relayStream()` in stream-relay.ts line 188: `accumulated += text` — pure concatenation of all text_delta events. When Claude outputs text → tool_use → text, the stream-json protocol sends separate text_delta events for each text block, but `relayStream()` joins them without any separator.

**Investigation needed:** How `relayStream()` in stream-relay.ts handles text deltas separated by tool-use events. Also check `markdownToHtml()` and Telegram HTML parser behavior with consecutive newlines for non-tool-boundary cases.

- [x] Paragraph breaks (`\n\n`) between sections are visually preserved in Telegram messages under 4096 chars
- [x] Paragraph breaks are preserved in messages that are split (over 4096 chars)
- [x] Paragraph breaks are preserved during streaming edits (editMessageText path)
- [x] bot-round12 splitMessage() walk-back changes are NOT dead code — they handle split-boundary newline preservation for messages >4096 chars. Do not remove them.
- [x] Add tests reproducing the paragraph break loss scenario (text block before tool call + text block after = should have separator)
- [x] Verify existing tests pass

### Task 2: Show topicId in header for all topics, not just explicit bindings (bot-2bm, P2)

**Problem:** When a message arrives from a forum topic without its own binding entry (e.g., topic 1890 "Bot Dev"), the header shows `[Chat: Minime HQ | From: ...]` without any Topic field. The agent cannot distinguish which topic the message came from. This was partially fixed in bot-round12 but only for topics listed in the `topics` config array.

**Evidence:** Current session headers show no Topic field despite messages coming from topic 1890. The `resolveBinding()` fallback path (line 66) returns the base binding without `topicId`.

**What we want:** All messages from forum topics include `Topic: <id>` in the header, whether or not the topic has an explicit binding. For reaction events where `message_thread_id` is unavailable (Telegram API limitation), document this with a code comment and do not attempt to add topicId.

- [x] Messages from ANY forum topic include `Topic: <id>` in the source prefix header
- [x] Messages from topics WITH explicit bindings still work correctly
- [x] Messages from DMs (no topic) show no Topic field
- [x] Reaction events document the Telegram API limitation (no message_thread_id available)
- [x] Update existing buildSourcePrefix tests
- [x] Add test: message from unlisted topic shows topicId in header
- [x] Verify existing tests pass

### Task 3: Mid-turn message injection via PreToolUse hook (bot-5uy, P1)

**Problem:** When the user sends messages while the agent is processing a turn (doing tool calls), those messages queue in the collect buffer and only arrive after the entire turn completes as `[Queued messages while agent was busy]`. The user cannot steer, correct, or add context to the agent mid-turn. This leads to wasted work and repeated corrections.

**Evidence:** Every turn in this conversation shows queued messages. User sends corrections seconds after the initial message but agent doesn't see them until the full turn finishes (often minutes later). Example from bot logs: `Queued mid-turn message for -1003894624477:1890 (3 in buffer)` followed by drain only after turn completes.

**What we want:** Messages sent during an active turn are picked up by a PreToolUse hook and injected into the current turn's context via `additionalContext`. Coverage target: ~90% of cases (every tool call boundary). Messages during pure text generation still wait — this is acceptable.

**Design constraints (from ADR-053 and Opus review):**
- Hook mechanism: PreToolUse wildcard hook returns `additionalContext` (NOT `systemMessage`)
- IPC: file-based, atomic writes to prevent partial reads
- Bot sets env var at spawn time so hook knows which file to read
- Collect buffer remains as safety net — messages consumed by hook are not re-delivered on drain
- Hook must be minimal (bash, fast path = file existence check + exit)
- Hooks live in AGENT workspaces (`/Users/ninja/.minime/workspace/.claude/settings.json`), not bot repo

**Important:** This affects both `main` agent workspace (`/Users/ninja/.minime/workspace/`) and `coder` workspace (`/Users/ninja/.minime/workspace-coder/`). Both need the hook installed.

- [x] Bot writes queued mid-turn messages to an inject file when `state.busy === true`
- [x] File writes are atomic (no partial reads possible)
- [x] Bot sets an env var at subprocess spawn identifying the inject file path
- [x] PreToolUse hook in main agent workspace reads inject file and returns `additionalContext`
- [x] PreToolUse hook in coder workspace reads inject file and returns `additionalContext`
- [x] Hook fast path (no pending message) adds negligible latency (<10ms)
- [x] Messages consumed by hook are not re-delivered via collect buffer drain
- [x] Injected messages are clearly framed so the agent recognizes them as live user input
- [x] Collect buffer still works as fallback for messages not consumed by hook
- [x] Add tests for inject file writing and dedup logic
- [x] Verify existing tests pass

### Task 4: Log bot version on startup (bot-fo3, P2)

**Problem:** When the bot starts, there's no way to tell which version of the code is running. After deploys or restarts, it's unclear whether the new code was picked up.

**Evidence:** Bot startup logs show `Telegram bot @minitinyme_bot is running (id: 8210768920)` but no version info. After merging bot-round12 changes, we couldn't confirm the new code was running.

**What we want:** On startup, log the current git commit hash (short) so we can verify which version is running. Log only — do not add to /status output.

- [x] Bot logs git commit hash on startup (e.g., `INFO [main] Bot version: abc1234`)
- [x] Works when `.git` directory is available (normal case)
- [x] Gracefully handles missing `.git` (logs "unknown" or similar, does not crash)
- [x] Add test for version reading logic
- [x] Verify existing tests pass
