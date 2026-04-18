# Persist downloaded media for session lifetime — Round 1

## Goal

Make photos and documents survive across turns within the same agent session so follow-up questions can reference earlier files without re-upload. Clean up on session close. Bound disk usage with a global cap (oldest evicted first). Voice unchanged. Resolves fitz123/claude-code-bot#99.

## Validation Commands

```bash
cd bot && npm test
cd bot && npx tsc --noEmit
```

## Reference: current media-cleanup wiring

Photo handler — cleanup callback fires on queue drain after the consuming turn finishes:

```ts
// bot/src/telegram-bot.ts:798-816
tempPath = tempFilePath("photo", ".jpg");
await downloadFile(url, tempPath);

// ... build message text containing tempPath ...

// Cleanup callback runs after the queue finishes processing this message
const pathToClean = tempPath;
tempPath = null;
messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(...), () => {
  cleanupTempFile(pathToClean);
});
```

Document/animation handler — same pattern:

```ts
// bot/src/telegram-bot.ts:874-901
tempPath = tempFilePath(anim ? "animation" : "doc", ext);
await downloadFile(url, tempPath);
// ... build messageText including tempPath ...
const pathToClean = tempPath;
tempPath = null;
messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(...), () => {
  cleanupTempFile(pathToClean);
});
```

Voice handler — cleanup runs in `finally` after transcription; only the transcript text enters context, the audio file path is never handed to the agent:

```ts
// bot/src/telegram-bot.ts:760-767
} catch (err) {
  log.error("telegram-bot", `Voice transcription error for chat ${chatId}:`, err);
  await ctx.reply("Failed to transcribe voice message. Please try again or send text.").catch(() => {});
} finally {
  if (tempPath) {
    await cleanupTempFile(tempPath);
  }
}
```

`bot/src/voice.ts:17-19` defines `tempFilePath` as a one-shot path under `tmpdir()`:

```ts
export function tempFilePath(prefix: string, extension: string): string {
  return `${tmpdir()}/bot-${prefix}-${randomUUID()}${extension}`;
}
```

`bot/src/message-queue.ts` runs registered cleanup callbacks on every queue drain (`pendingCleanups.splice(0)` and `collectCleanups.splice(0)` at lines 188, 245, 263, 287). The cleanup contract there is "fire when this message is consumed" — there is no notion of session lifetime.

## Reference: existing session-scoped directory pattern

`session-manager.ts` already maintains a per-session outbox directory whose lifetime matches the session, exactly the pattern a media retention dir would mirror:

```ts
// bot/src/session-manager.ts:15
const OUTBOX_BASE = "/tmp/bot-outbox";

// bot/src/session-manager.ts:23
export function outboxDir(chatId: string): string { /* ... */ }

// bot/src/session-manager.ts:48-51 — fields on ActiveSession
/** Per-session outbox directory for file delivery. */
outboxPath: string;
/** Per-session inject directory for mid-turn message delivery. */
injectDir: string;

// bot/src/session-manager.ts:206-214 — created on session spawn
const outboxPath = outboxDir(chatId);
rmSync(outboxPath, { recursive: true, force: true });
mkdirSync(outboxPath, { recursive: true });
// ...
const injectPath = injectDirForChat(chatId);
cleanupInjectDir(injectPath);

// bot/src/session-manager.ts:450-457 — cleaned on session close
rmSync(session.outboxPath, { recursive: true, force: true });
// ...
cleanupInjectDir(session.injectDir);
```

## Tasks

### Task 1: Persist downloaded media for the lifetime of a session (#99, P2)

**Problem.** Photo and document/animation handlers register a per-message cleanup callback that unlinks the downloaded file as soon as the consuming turn finishes (`bot/src/telegram-bot.ts:811-816` for photo, `:897-901` for document). The file path is still in the agent's conversation history, but the file is gone. When the user asks a follow-up about the same file in a later turn, the agent gets a missing-file error and has to ask the user to re-send. Reproducible by sending a multi-page PDF, asking for a summary, then in the next turn asking "now count occurrences of X" — the path is in conversation history but the file has been unlinked. Same symptom for photos when a follow-up wants a different region or aspect of the same image.

**What we want.** Within a single agent session, downloaded media stays readable for follow-up questions referencing the path. When the session ends (idle close, restart), media for that session is reclaimed. A global safety cap prevents unbounded disk growth if many large files arrive in a long-lived session. Voice files keep their current immediate-cleanup behavior — the audio file is never referenced after transcription, only the transcript text enters context.

- [ ] Photos referenced by a previous turn in the same session can still be read by the agent in a later turn (no missing-file error on follow-up)
- [ ] Documents and animations behave the same: re-readable across turns within the session
- [ ] Voice messages continue to be cleaned up immediately after transcription (no behavior change for voice)
- [ ] When the session closes (idle timeout, explicit close, restart, crash), all media files belonging to that session are removed from disk
- [ ] A configurable global cap on total media bytes across all sessions is enforced; when exceeded, oldest files are evicted first
- [ ] The default cap is at least 200 MB (10× the 20 MB Telegram per-file limit) and is documented in the public config example with a comment explaining how to tune it
- [ ] Files written for one chat/session are never readable by another session (no cross-session leakage of paths)
- [ ] Photo and document download error paths still clean up partial files (today's `if (tempPath) cleanupTempFile(tempPath)` behavior is preserved)
- [ ] Add tests covering: file persists across turns within a session, file is removed on session close, eviction kicks in when the global cap is exceeded, voice files are still removed immediately
- [ ] Verify existing tests pass
