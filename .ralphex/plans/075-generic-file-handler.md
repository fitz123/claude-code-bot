# Generic File Handler for Unhandled Media Types — Round 1

## Goal

Add a single fallback handler for Telegram media types that have no specialized handler (video, animation, video_note, audio, sticker). Currently these are silently dropped — the user sends a file and gets no response. The handler should download the file and pass it to the Claude session, like the existing document handler does.

## Validation Commands

```bash
cd /Users/ninja/src/claude-code-bot && npx tsc --noEmit && npm test
```

## Reference: Current handler coverage

The bot registers handlers in this order in `bot/src/telegram-bot.ts`:
- `message:text` (line 570) — text handler
- `message:voice` (line 600) — transcribes with whisper, sends text to session
- `message:photo` (line 662) — downloads largest size, passes file path to session
- `message:document` (line 718) — downloads file, passes path + metadata to session

**Missing handlers:** `video`, `animation`, `video_note`, `audio`, `sticker`

When any of these media types arrive, grammY dispatches them but no handler matches, so the update is silently consumed with no response.

## Reference: Document handler pattern (bot/src/telegram-bot.ts:718-787)

The document handler is the closest template. It:
1. Resolves binding, checks shouldRespondInGroup, checks staleness
2. Checks file size against `TELEGRAM_FILE_SIZE_LIMIT` (20 MB)
3. Downloads via `ctx.api.getFile(file_id)` → fetch URL → `downloadFile()`
4. Builds message with metadata (`formatDocumentMeta`) and file path
5. Enqueues to `messageQueue` with cleanup callback

## Reference: How to extract file_id from each media type

Each Telegram media type has a different object shape:
- `ctx.msg.video` → `{ file_id, file_name?, mime_type?, file_size?, ... }`
- `ctx.msg.animation` → `{ file_id, file_name?, mime_type?, file_size?, ... }`
- `ctx.msg.video_note` → `{ file_id, file_size?, length, ... }` (no file_name or mime_type)
- `ctx.msg.audio` → `{ file_id, file_name?, mime_type?, file_size?, ... }`
- `ctx.msg.sticker` → `{ file_id, file_unique_id, is_animated, is_video, file_size?, ... }`

All have `file_id` which is what `ctx.api.getFile()` needs.

## Reference: Existing helpers in bot/src/voice.ts

- `tempFilePath(prefix, extension)` — generates `${os.tmpdir()}/bot-{prefix}-{uuid}{ext}` (macOS: `/var/folders/.../T/`)
- `downloadFile(url, destPath)` — fetches URL, writes to disk
- `cleanupTempFile(path)` — deletes temp file (best-effort)

## Reference: TELEGRAM_FILE_SIZE_LIMIT

Defined in `bot/src/telegram-bot.ts`. Telegram Bot API limits file downloads to 20 MB. The document handler already enforces this.

## Tasks

### Task 1: Add generic fallback handler for unhandled media types (#75, P1)

When a user sends a video, animation, video_note, audio, or sticker, the bot silently ignores it. No error, no acknowledgment. The user thinks the bot is broken.

We want: a single handler that catches all these types, downloads the file via Telegram Bot API, and passes it to the Claude session with metadata (type, filename, MIME, size). Follow the same pattern as the existing document handler.

- [x] video messages are downloaded and passed to session with metadata
- [x] animation (GIF) messages are downloaded and passed to session
- [x] video_note (round video) messages are downloaded and passed to session
- [x] audio messages are downloaded and passed to session
- [x] sticker messages are downloaded and passed to session (as image file)
- [x] Files over 20 MB are rejected with user-facing error message
- [x] Each type increments `messagesReceived` counter with appropriate type label
- [x] Message includes: source prefix, reply context, forward context, caption (if any), file metadata, temp file path
- [x] Temp files are cleaned up after session processes the message
- [x] Add tests for each media type handler
- [x] Verify existing tests pass
