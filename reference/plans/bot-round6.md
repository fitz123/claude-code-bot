# Bot Bugfixes & Features — Round 6

## Goal

Fix forum topic mention bypass, add startup resilience, and enable file sending from Claude to Telegram.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Tasks

### Task 1: Fix shouldRespondInGroup forum topic bypass (bot-ve6, P1)

In Telegram forum groups, every message in a topic has `reply_to_message` set to the topic's creation message. This is how Telegram associates messages with forum topics — it is NOT an actual user reply. If the bot created the topic (or is the `from` on the creation message), then `reply_to_message.from.id === botId` is true for ALL messages in that topic, bypassing `requireMention` entirely.

The General topic is unaffected because it has no creation message, so `reply_to_message` is only set for actual user replies there.

**Bug location:** `shouldRespondInGroup()` in `telegram-bot.ts`:
```typescript
if (message.reply_to_message?.from?.id === botId) return true;
```

This check does not distinguish between:
1. A user actually replying to the bot's message (should bypass requireMention)
2. Telegram's forum thread association via reply_to_message (should NOT bypass requireMention)

**How to identify forum thread-association replies (not real user replies):**

Check if `reply_to_message` is a forum service message. These have one of these fields present:
- `forum_topic_created`
- `forum_topic_edited`
- `forum_topic_closed`
- `forum_topic_reopened`
- `general_forum_topic_hidden`
- `general_forum_topic_unhidden`

If any of these fields exist on `reply_to_message`, it is a forum service message (thread association), NOT a real user reply. Skip the `from.id === botId` check in that case.

**Fix:** Before checking `reply_to_message.from.id`, check if `reply_to_message` is a forum service message. If it is, do not treat it as a reply to the bot. Extend the `reply_to_message` type in the `message` parameter to include these optional fields.

- [ ] Add a helper (e.g. `isForumServiceMessage`) that checks for any `forum_topic_*` field on reply_to_message
- [ ] Update shouldRespondInGroup to skip the reply check when reply_to_message is a forum service message
- [ ] Extend the message type to include the new fields
- [ ] Add tests for forum topic scenarios (thread-association vs real reply vs General topic)
- [ ] Verify existing tests still pass

### Task 2: Add startup timeout to bot.start() (bot-pv0, P1)

`bot.start()` in `main.ts` intermittently hangs — the grammY long-poll initialization (deleteWebhook + first getUpdates) never resolves. The process stays alive but unresponsive. Since it doesn't crash, launchd's KeepAlive doesn't restart it.

Telegram API is reachable during these hangs (curl returns 302), so it's likely a stale long-poll conflict window or transient timeout in grammY's HTTP client.

**Current startup code in `main.ts`:**
```typescript
console.log("[main] Starting Telegram bot polling...");
await bot.start({
  onStart: async (botInfo) => {
    console.log(`[main] Bot @${botInfo.username} is running (id: ${botInfo.id})`);
    // ...
  },
});
```

**Important:** `bot.start()` never resolves during normal operation — it IS the polling loop. So you cannot `Promise.race` against it. `onStart` fires once `deleteWebhook` + `init` succeed but BEFORE polling begins. If `deleteWebhook` hangs, `onStart` never fires.

**Fix — timer + flag pattern:**
```typescript
let startedSuccessfully = false;
const startupTimeout = setTimeout(() => {
  if (!startedSuccessfully) {
    console.error("[main] Startup timed out after 30s — exiting for launchd restart");
    process.exit(1);
  }
}, 30_000);

await bot.start({
  onStart: async (botInfo) => {
    startedSuccessfully = true;
    clearTimeout(startupTimeout);
    // ... existing onStart logic
  },
});
```

The startup timeout must also be cleared in the SIGTERM/SIGINT shutdown handler to prevent a stale timer from exiting during graceful shutdown.

launchd's KeepAlive + ThrottleInterval (35s in the plist) will handle restart on `process.exit(1)`. No retry loop needed.

- [ ] Add startup timeout with timer+flag pattern in main.ts
- [ ] Clear the timeout both in onStart and in the shutdown handler
- [ ] Log clear error message on timeout before exit
- [ ] Verify graceful shutdown still works (SIGTERM during normal operation)

### Task 3: Send files from Claude back to Telegram (bot-sdo, P2)

When Claude creates files during a session (images, documents, code), there's no way to deliver them to the Telegram chat. The bot should detect file outputs and send them via Telegram.

#### Reference: Claude CLI stream-json protocol (tool use events)

The bot spawns Claude with `--output-format stream-json --verbose --include-partial-messages`. This emits NDJSON events. The relevant type for detecting file creation:

**`AssistantMessage`** (type `"assistant"`, no subtype) — contains `message.content` array with tool_use blocks:
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01ABC...",
        "name": "Write",
        "input": {
          "file_path": "/absolute/path/to/file.ext",
          "content": "file content..."
        }
      }
    ]
  },
  "session_id": "..."
}
```

Tools that create files:
- **`Write`** — `input.file_path` is the absolute path of the created file
- **`Edit`** — modifies existing files (not relevant for sending)
- **`Bash`** — may create files, but path detection is unreliable (skip)

The bot already defines these types in `types.ts`:
```typescript
export interface AssistantMessage {
  type: "assistant";
  subtype?: undefined;
  message: {
    role: "assistant";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
  session_id: string;
  [key: string]: unknown;
}
```

The `content` array items with `type: "tool_use"` and `name: "Write"` contain `input.file_path` (via the `[key: string]: unknown` catch-all).

**IMPORTANT deduplication note:** With `--include-partial-messages`, `AssistantMessage` snapshots are emitted multiple times as content accumulates. The same `tool_use` block will appear in MULTIPLE snapshots. Deduplicate using the `tool_use.id` field or collect paths in a `Set<string>`.

#### Reference: grammY file sending API

```typescript
import { InputFile } from "grammy";

// Send document (any file type)
await ctx.replyWithDocument(new InputFile("/path/to/file.ext"), {
  caption: "optional caption",
  message_thread_id: threadId,  // for forum topics
});

// Send photo (images only — jpeg, png, gif, webp — NOT bmp)
await ctx.replyWithPhoto(new InputFile("/path/to/image.jpg"), {
  caption: "optional caption",
  message_thread_id: threadId,
});
```

- `InputFile` accepts: file path string, Buffer, ReadableStream, URL
- Upload limit: 50 MB
- For images (jpeg/png/gif/webp): use `replyWithPhoto`; for everything else (including bmp): use `replyWithDocument`
- Multiple files = separate messages (no multi-file upload in Telegram)

#### Reference: Current stream processing

`stream-relay.ts` `relayStream()` iterates over `AsyncGenerator<StreamLine>` and only extracts text deltas. `extractText()` ignores all non-text events. Tool use events pass through the generator but are never inspected.

**`relayStream` currently receives `(stream, ctx)` — it does NOT have access to `workspaceCwd`.** The implementation will need to either pass `workspaceCwd` as an additional parameter, or pass an allowed-paths list.

#### Implementation approach

1. Modify `relayStream` signature to accept `workspaceCwd` (or an options object)
2. In the stream loop, scan `StreamLine` events for `AssistantMessage` (no subtype) with `content` blocks of `type: "tool_use"` where `name === "Write"`
3. Collect file paths from `input.file_path` into a `Set<string>` (dedup via Set since snapshots repeat)
4. After the stream completes (result received), for each collected path:
   - Check `fs.existsSync(path)` — skip if file doesn't exist (tool may have failed)
   - Verify path starts with `workspaceCwd` or `/tmp` — skip system files for safety
   - Determine type by extension: `.jpg`/`.jpeg`/`.png`/`.gif`/`.webp` → `replyWithPhoto`, everything else → `replyWithDocument`
   - Send via Telegram with `message_thread_id` for forum topics
5. No external MIME library needed — use simple extension check (project has no `mime-types` dep). Can reuse logic from existing `imageExtensionForMime()` in `telegram-bot.ts`
6. Update the `processFn` callback in `telegram-bot.ts` to pass `workspaceCwd` through to `relayStream`

- [ ] Extend relayStream signature to accept workspaceCwd
- [ ] Detect Write tool_use events in stream processing (deduplicate with Set)
- [ ] After stream completes, verify file exists and path is within allowed directories
- [ ] Send files via replyWithPhoto (images) or replyWithDocument (other)
- [ ] Include message_thread_id for forum topic support
- [ ] Update processFn in telegram-bot.ts to pass workspaceCwd
- [ ] Add tests
