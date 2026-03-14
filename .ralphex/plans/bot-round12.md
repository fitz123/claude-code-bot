# Bot Features & Fixes — Round 3

## Goal

Fix paragraph newline loss in Telegram messages, add topicId to agent message headers, handle 409 Conflict crash-loops gracefully, support receiving files/documents from Telegram, and support message reactions as a feedback signal.

## Validation Commands

```bash
cd ~/.openclaw/bot && npx tsc --noEmit && npm test
```

## Reference: Message splitting (stream-relay.ts:12-44)

```typescript
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");  // BUG: strips ALL leading newlines
  }

  return chunks;
}
```

Line 40: `.replace(/^\n+/, "")` strips ALL leading newlines from the next chunk. When splitting at a `\n\n` paragraph boundary, this removes the paragraph break between chunks. The existing test at stream-relay.test.ts:20-38 asserts this buggy behavior as correct.

## Reference: deliver.sh splitting (scripts/deliver.sh:80-117)

```bash
if [ ${#remaining} -le $MAX_LEN ]; then
  send_message "$remaining"
  break
fi

chunk="${remaining:0:$MAX_LEN}"
split_pos=$(echo "$chunk" | grep -b -o $'\n\n' | tail -1 | cut -d: -f1 || echo "")

if [ -n "$split_pos" ] && [ "$split_pos" -gt 100 ]; then
  send_message "${remaining:0:$split_pos}"
  remaining="${remaining:$((split_pos + 2))}"  # Skips BOTH \n\n characters
```

Line 100: when splitting at `\n\n`, skips both newline chars, losing the paragraph break in the next chunk.

## Reference: buildSourcePrefix (telegram-bot.ts:74-93)

```typescript
export function buildSourcePrefix(
  binding: TelegramBinding,
  from?: { first_name: string; username?: string },
): string {
  const parts: string[] = [];

  if (binding.label) {
    parts.push(`Chat: ${binding.label}`);
  }

  if (from) {
    const name = from.first_name.replace(/[\n\r]/g, " ");
    const sender = from.username
      ? `${name} (@${from.username.replace(/[\n\r]/g, "")})`
      : name;
    parts.push(`From: ${sender}`);
  }

  return parts.length > 0 ? `[${parts.join(" | ")}]\n` : "";
}
```

TelegramBinding type (types.ts:22-33):
```typescript
export interface TelegramBinding {
  chatId: number;
  agentId: string;
  kind: "dm" | "group";
  topicId?: number;
  label?: string;
  requireMention?: boolean;
  topics?: TopicOverride[];
  voiceTranscriptEcho?: boolean;
  streamingUpdates?: boolean;
  typingIndicator?: boolean;
}
```

`binding.topicId` is already available but not included in the prefix output.

Existing tests (telegram-bot.test.ts:204-230):
```typescript
describe("buildSourcePrefix", () => {
  it("includes chat label and sender", () => {
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: Minime HQ | From: John (@johndoe)]\n");
  });
  it("handles missing username", () => {
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: User DM | From: Alice]\n");
  });
  it("handles missing label", () => {
    assert.strictEqual(buildSourcePrefix(binding, from), "[From: Bob (@bob123)]\n");
  });
  it("handles missing sender", () => {
    assert.strictEqual(buildSourcePrefix(binding, undefined), "[Chat: Dev Chat]\n");
  });
  it("returns empty for no info", () => {
    assert.strictEqual(buildSourcePrefix(binding, undefined), "");
  });
});
```

## Reference: Bot lifecycle and 409 handling (main.ts:31-89)

Graceful shutdown (main.ts:33-42):
```typescript
const shutdown = async (signal: string) => {
  log.info("main", `Received ${signal}, shutting down...`);
  if (telegramBot) telegramBot.stop();
  if (discordClient) discordClient.destroy();
  for (const mq of messageQueues) mq.clearAll();
  await stopMetricsServer();
  await sessionManager.closeAll();
  log.info("main", "All sessions closed. Exiting.");
  process.exit(0);
};
```

bot.start() call (main.ts:73-89):
```typescript
bot.start({
  onStart: async (botInfo) => {
    startedSuccessfully = true;
    clearTimeout(startupTimeout);
    log.info("main", `Telegram bot @${botInfo.username} is running`);
    // ...
  },
}).catch((err) => {
  log.error("main", "Telegram bot polling failed — exiting for restart:", err);
  process.exit(1);
});
```

grammY internal behavior (node_modules/grammy/out/bot.js:435-446):
- Error 409 is **thrown immediately**, not retried
- The thrown error propagates to the `.catch()` handler → `process.exit(1)` → launchd restarts → new instance also gets 409 → crash-loop

LaunchAgent plist has `ThrottleInterval: 35` seconds, but that's not enough if Telegram hasn't cleaned up the old getUpdates long-poll connection.

## Reference: Current message handlers (telegram-bot.ts)

Registered handlers:
- `bot.command("start")` — line 357
- `bot.command("reset")` — line 378
- `bot.command("status")` — line 393
- `bot.on("message:text")` — line 443
- `bot.on("message:voice")` — line 471
- `bot.on("message:photo")` — line 528
- `bot.on("message:document")` — line 582 (only image MIME types, non-images are silently ignored)
- `bot.catch()` — line 635

No `message_reaction` handler exists. No `allowed_updates` param in `bot.start()`.

## Reference: Voice handler pattern (telegram-bot.ts:471-525)

```typescript
bot.on("message:voice", async (ctx) => {
  // ... auth, binding, group checks ...
  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const inputPath = join(tmpdir(), `bot-voice-${randomUUID()}.ogg`);
  // ... download, transcribe, enqueue with [Voice message] label ...
  // cleanup in finally block
});
```

## Reference: Document handler — image only (telegram-bot.ts:582-632)

```typescript
bot.on("message:document", async (ctx) => {
  // ... auth, binding checks ...
  const doc = ctx.msg.document;
  if (!isImageMimeType(doc.mime_type)) return;  // Line 589: REJECTS non-images

  const file = await ctx.getFile();
  // ... download to tmp, enqueue with filepath, cleanup ...
});
```

## Reference: grammY reaction API

grammY v1.41.1 supports reactions:
```typescript
bot.reaction("👍", (ctx) => { /* ... */ });
bot.on("message_reaction", (ctx) => {
  const { emojiAdded, emojiRemoved } = ctx.reactions();
});
```

Requires `allowed_updates` to include `"message_reaction"` in `bot.start()`. Bot must be admin in groups.

`ctx.messageReaction` contains: `chat`, `message_id`, `date`, `old_reaction`, `new_reaction`, `user` (optional if anonymous).

## Reference: Telegram getFile API for documents

Two-step download: `getFile(file_id)` → returns `file_path` → download from `https://api.telegram.org/file/bot<TOKEN>/<file_path>`.
- Download limit: 20MB
- Link validity: ~1 hour

## Tasks

### Task 1: Fix paragraph newline loss in message splitting (bot-p2y, P1)

When a long message is split into chunks for Telegram's 4096-char limit, paragraph breaks (`\n\n`) between chunks are lost. This happens in two places: `splitMessage()` in stream-relay.ts strips all leading newlines from subsequent chunks, and deliver.sh skips both `\n\n` characters when splitting at paragraph boundaries.

Users see wall-of-text responses where Claude intended paragraph breaks. This is the most visible quality issue.

- [x] Paragraph breaks between split chunks are preserved in stream-relay.ts splitMessage()
- [x] Paragraph breaks between split chunks are preserved in deliver.sh
- [x] Existing split tests are updated to verify paragraph spacing is maintained
- [x] Add tests: message with multiple paragraph breaks split across chunks retains all breaks
- [x] Verify existing tests pass

### Task 2: Include topicId in agent message header (bot-2bm, P2)

When a message comes from a Telegram forum topic without its own binding, the parent binding's label is used. The agent cannot distinguish which topic the message came from. `binding.topicId` is already available but not included in `buildSourcePrefix()` output.

Current: `[Chat: Minime HQ | From: User (@user)]`
Desired: `[Chat: Minime HQ | Topic: 591 | From: User (@user)]` (when topicId is present)

- [x] `buildSourcePrefix()` includes `Topic: <id>` when `binding.topicId` is defined
- [x] Topic appears between Chat and From in the header
- [x] No Topic field when `topicId` is undefined (DMs, non-forum groups)
- [x] Update existing buildSourcePrefix tests
- [x] Add test: binding with topicId produces correct header
- [x] Add test: binding without topicId produces header without Topic field
- [x] Verify existing tests pass

### Task 3: Handle 409 Conflict on bot restart (bot-81s, P2)

When the bot is restarted via `launchctl kickstart -k`, the new instance starts before Telegram fully releases the old long-poll connection. grammY throws 409 Conflict immediately (no retry), which triggers `process.exit(1)`, and launchd restarts again — creating a crash-loop.

The 35-second ThrottleInterval in the LaunchAgent plist is insufficient because Telegram may hold the old connection longer.

- [x] Bot handles 409 Conflict errors with a retry-with-backoff strategy instead of immediately crashing
- [x] Retry attempts are logged at WARN level with attempt count
- [x] After exhausting retries (reasonable limit), the bot exits for launchd restart
- [x] Add tests for the 409 retry behavior
- [x] Verify existing tests pass

### Task 4: Support receiving files and documents from Telegram (bot-8ae, P2)

Currently the `message:document` handler only accepts image MIME types and silently drops everything else. Users cannot send PDFs, text files, or other documents to the agent. The voice handler already demonstrates the download-and-forward pattern.

Files should be downloaded from Telegram, saved to a temp path, and forwarded to Claude with metadata (filename, MIME type, size). Claude Code can read files natively — just pass the local path.

- [x] Non-image documents (PDF, TXT, CSV, etc.) are downloaded and forwarded to the agent session
- [x] Message to agent includes file metadata: original filename, MIME type, file size
- [x] Local file path is included so Claude can read the file
- [x] 20MB Telegram API limit is respected — files exceeding this are rejected with a user-facing message
- [x] Temp files are cleaned up after the agent processes the message
- [x] Add tests for document handling (various MIME types, size limits)
- [x] Verify existing tests pass

### Task 5: Support message reactions as feedback signal (bot-p1a, P2)

The bot has no way to receive reaction events from Telegram. Reactions (thumbs up/down, etc.) on bot messages are a natural feedback mechanism. The bot should forward reaction events to the agent session as contextual information.

- [x] `allowed_updates` in `bot.start()` includes `"message_reaction"`
- [x] New handler for `message_reaction` events
- [x] Reaction events are forwarded to the agent session as text context (e.g., `[Reaction: 👍 on message 123 from User]`)
- [x] Reactions in groups respect the same binding/authorization rules as messages
- [x] Reaction removals are also forwarded (so agent knows feedback was retracted)
- [x] Add tests for reaction event handling
- [x] Verify existing tests pass
