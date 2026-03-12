# Bot Features and Fixes — Round 4

## Goal

Implement 5 features/fixes for the Telegram bot.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Reference: Real Claude CLI stream-json event shapes

Captured from `claude -p --output-format stream-json --verbose --include-partial-messages`:

```jsonl
{"type":"system","subtype":"init","session_id":"c9d40f09-...","model":"claude-opus-4-6"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help you today?"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"Hello! How can I help you today?","stop_reason":"end_turn","session_id":"c9d40f09-..."}
```

Key: streaming deltas have `type: "stream_event"`, NOT `type: "assistant"`. Do NOT accumulate text from assistant or result messages — only from `text_delta` events.

## Reference: whisper-cli usage

Binary: `/opt/homebrew/bin/whisper-cli`
Model: `/opt/homebrew/share/ggml-small.bin`

```bash
whisper-cli -m /opt/homebrew/share/ggml-small.bin -f /path/to/audio.ogg --no-timestamps
```

Telegram voice messages are `.oga` (Opus in OGG container). whisper-cli handles OGG natively — no ffmpeg conversion needed.

## Reference: OpenClaw image handling pattern

OpenClaw passes images to Claude CLI by:
1. Writing image data to temp files on disk
2. Appending file paths to the prompt text before sending

From `openclaw/src/agents/cli-runner/helpers.ts`:

```typescript
// appendImagePathsToPrompt — appends image file paths to prompt text
export function appendImagePathsToPrompt(prompt: string, paths: string[]): string {
  if (!paths.length) return prompt;
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.join("\n")}`;
}
```

For mid-session messages (after subprocess is already running), image file paths are appended to the text sent via stdin. Claude Code recognizes file paths and reads the images. The `--file` CLI flag only works at initial spawn.

## Reference: Telegram Bot API file download

```typescript
// Get file path from file_id
const file = await ctx.api.getFile(fileId);
// Download URL
const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
```

grammY provides `ctx.api.getFile(fileId)` which returns `{ file_path: string }`. Download the file from the URL above. Telegram limits file downloads to 20MB.

For photos, `ctx.msg.photo` is an array of PhotoSize sorted by size — use the last element (largest).

## Tasks

### Task 1: Voice message transcription via whisper-cli (bot-xzt, P1)

Receive Telegram voice messages, download audio, transcribe with local whisper-cli, send transcript to Claude session.

Pipeline:
1. Handle `message:voice` in telegram-bot.ts
2. Get file_id from `ctx.msg.voice.file_id`
3. Download via Telegram getFile() API to a temp file
4. Run `whisper-cli -m /opt/homebrew/share/ggml-small.bin -f <file> --no-timestamps`
5. Parse transcript from stdout
6. Echo transcript back to chat: reply with 📝 "<transcript>"
7. Send transcript text to Claude session via sendSessionMessage
8. Relay Claude's response as usual
9. Clean up temp files

No conversion step needed — whisper-cli handles OGG natively.

Error handling: if transcription fails, reply with error message, don't send to Claude.

- [x] Add voice message handler
- [x] Implement file download
- [x] Implement whisper-cli transcription
- [x] Add echo transcript reply
- [x] Clean up temp files
- [x] Update tests

### Task 2: Image support — pass photos to Claude (bot-hxe, P1)

Receive Telegram photos, download, pass to Claude session for vision analysis.

Pipeline:
1. Handle `message:photo` in telegram-bot.ts
2. Get file_id from `ctx.msg.photo` (last element = largest size)
3. Download via Telegram getFile() API to a temp file (use descriptive filename with extension, e.g. `/tmp/tg-photo-<id>.jpg`)
4. Build message text: if caption exists use it, otherwise use empty string. Append the temp file path to the text (following OpenClaw's `appendImagePathsToPrompt` pattern — just append the path on a new line)
5. Send the combined text+path to Claude session via sendSessionMessage
6. Claude Code will recognize the file path and read the image for vision analysis
7. Also handle `message:document` with image MIME types (image/png, image/jpeg, etc.)
8. Clean up temp files after response

- [x] Add photo message handler
- [x] Implement file download to temp file
- [x] Append image path to message text
- [x] Handle documents with image MIME types
- [x] Support photo + caption
- [x] Clean up temp files
- [x] Update tests

### Task 3: Verify subprocess crash logging (bot-ai2, P1)

Previous ralphex round fixed empty session stderr logs by removing premature `logStream.end()`. Verify the fix works — when a subprocess crashes, `~/.openclaw/logs/session-<chatId>.log` should contain actual error output. Write a test that simulates subprocess crash and verifies stderr is captured.

- [x] Write test that verifies stderr capture on crash
- [x] Fix if still broken

### Task 4: Register bot commands with Telegram API (bot-413, P2)

Bot doesn't call `setMyCommands` — Telegram menu shows stale commands from old OpenClaw gateway. On startup after bot.start(), call `bot.api.setMyCommands()` with the commands that actually exist: /start, /reset, /status. This clears old commands and registers current ones.

- [x] Add setMyCommands call on startup
- [x] Update tests

### Task 5: Agent effort level config (bot-86s, P2)

`config.yaml` already has `effort: high` in agent config but it's silently ignored. Wire it through:
1. Add `effort?: string` to `AgentConfig` type in types.ts
2. Parse it in config.ts
3. Pass `--effort <level>` in buildSpawnArgs in cli-protocol.ts when set

- [ ] Add effort to AgentConfig type
- [ ] Parse in config
- [ ] Pass --effort flag in buildSpawnArgs
- [ ] Update tests
