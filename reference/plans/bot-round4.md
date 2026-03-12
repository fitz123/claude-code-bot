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

Telegram voice messages are `.oga` (Opus in OGG container). whisper-cli may need conversion to WAV first — check if it handles OGG natively, if not use `ffmpeg -i input.oga output.wav`.

Check if ffmpeg is available: `/opt/homebrew/bin/ffmpeg`

## Reference: OpenClaw voice transcription

See `~/minime/openclaw/src/media-understanding/` for the full pipeline:
- `audio-preflight.ts` — preflight transcription for group mention matching
- `transcribe-audio.ts` — public transcription API
- `echo-transcript.ts` — echo transcript back to chat before agent processing
- `providers/` — provider implementations (openai, groq, deepgram, google, mistral, local CLI)

OpenClaw whisper-cli provider: looks for `whisper-cli` binary, passes `WHISPER_CPP_MODEL` env var or defaults to `/opt/homebrew/share/whisper.bin`.

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
4. Convert to WAV if whisper-cli doesn't support OGG (use ffmpeg)
5. Run `whisper-cli -m /opt/homebrew/share/ggml-small.bin -f <file> --no-timestamps`
6. Parse transcript from stdout
7. Echo transcript back to chat: reply with 📝 "<transcript>"
8. Send transcript text to Claude session via sendSessionMessage
9. Relay Claude's response as usual
10. Clean up temp files

Error handling: if transcription fails, reply with error message, don't send to Claude.

- [ ] Add voice message handler
- [ ] Implement file download
- [ ] Implement whisper-cli transcription
- [ ] Add echo transcript reply
- [ ] Clean up temp files
- [ ] Update tests

### Task 2: Image support — pass photos to Claude (bot-hxe, P1)

Receive Telegram photos, download, pass to Claude session for vision analysis.

Pipeline:
1. Handle `message:photo` in telegram-bot.ts
2. Get file_id from `ctx.msg.photo` (last element = largest size)
3. Download via Telegram getFile() API to a temp file
4. Send to Claude session — investigate how stream-json input format handles image attachments. Options: base64 in message content, or save to workspace and reference in text.
5. Also handle `message:document` with image MIME types (image/png, image/jpeg, etc.)
6. Support photo + caption: use caption as message text alongside the image

- [ ] Add photo message handler
- [ ] Implement file download
- [ ] Pass image to Claude session
- [ ] Handle documents with image MIME types
- [ ] Support photo + caption
- [ ] Clean up temp files
- [ ] Update tests

### Task 3: Verify subprocess crash logging (bot-ai2, P1)

Previous ralphex round fixed empty session stderr logs by removing premature `logStream.end()`. Verify the fix works — when a subprocess crashes, `~/.openclaw/logs/session-<chatId>.log` should contain actual error output. Write a test that simulates subprocess crash and verifies stderr is captured.

- [ ] Write test that verifies stderr capture on crash
- [ ] Fix if still broken

### Task 4: Register bot commands with Telegram API (bot-413, P2)

Bot doesn't call `setMyCommands` — Telegram menu shows stale commands from old OpenClaw gateway. On startup after bot.start(), call `bot.api.setMyCommands()` with the commands that actually exist: /start, /reset, /status. This clears old commands and registers current ones.

- [ ] Add setMyCommands call on startup
- [ ] Update tests

### Task 5: Agent effort level config (bot-86s, P2)

`config.yaml` already has `effort: high` in agent config but it's silently ignored. Wire it through:
1. Add `effort?: string` to `AgentConfig` type in types.ts
2. Parse it in config.ts
3. Pass `--effort <level>` in buildSpawnArgs in cli-protocol.ts when set

- [ ] Add effort to AgentConfig type
- [ ] Parse in config
- [ ] Pass --effort flag in buildSpawnArgs
- [ ] Update tests
