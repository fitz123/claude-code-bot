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

- [x] Photos referenced by a previous turn in the same session can still be read by the agent in a later turn (no missing-file error on follow-up)
- [x] Documents and animations behave the same: re-readable across turns within the session
- [x] Voice messages continue to be cleaned up immediately after transcription (no behavior change for voice)
- [x] When the session closes (idle timeout, explicit close, restart, crash), all media files belonging to that session are removed from disk
- [x] A configurable global cap on total media bytes across all sessions is enforced; when exceeded, oldest files are evicted first
- [x] The default cap is at least 200 MB (10× the 20 MB Telegram per-file limit) and is documented in the public config example with a comment explaining how to tune it
- [x] Files written for one chat/session are never readable by another session (no cross-session leakage of paths)
- [x] Photo and document download error paths still clean up partial files (today's `if (tempPath) cleanupTempFile(tempPath)` behavior is preserved)
- [x] Add tests covering: file persists across turns within a session, file is removed on session close, eviction kicks in when the global cap is exceeded, voice files are still removed immediately
- [x] Verify existing tests pass (949/950 pass; the 1 failure is a pre-existing WHISPER_MODEL env-var mismatch unrelated to this change)

### Task 2: Address PR #102 Copilot review findings — Round 2 (P1)

GitHub Copilot raised 5 concrete findings on PR #102, each citing a real file:line and representing a real risk (drop-cleanup leaks under error/clear paths, in-flight eviction, symlink attack vector, misleading docstring). Address them.

#### Finding 1 — `bot/src/message-queue.ts:223`
> `pendingDropCleanups` are spliced/discarded at the start of `flush()`, before `processFn` completes. If `processFn` throws (send failure) or the queue is cleared during processing (/reconnect, /clean), the drop cleanups will never run, so persistent media will leak on disk (and the in-flight tracking may be released). Keep drop cleanups until delivery succeeds; on send error or clear-while-busy paths, run them as part of the cleanup.

#### Finding 2 — `bot/src/message-queue.ts:303`
> In `drainCollectBuffer()`, `collectDropCleanups` are spliced/discarded before calling `processFn`. If `processFn` fails or the queue is cleared mid-drain, the drop cleanups won't run, so persistent-media files can become orphaned. Consider holding drop cleanups until after a successful drain, and running them on error/clear paths.

#### Finding 3 — `bot/src/media-store.ts:192`
> `enforceMediaCap()` can evict files that are still tracked as in-flight (including the file that was just downloaded and is about to be enqueued). This can lead to the agent receiving a path that no longer exists. When collecting/evicting candidates, skip paths in `inflightMediaPaths` (or accept a protected-path set) so cap enforcement never deletes files that haven't been delivered/owned yet.

#### Finding 4 — `bot/src/media-store.ts:13`
> The `inflightMediaPaths` docstring says it includes files "delivered and owned by an active session", but `releaseMediaPath()` removes paths from the set on successful delivery. This makes the comment misleading about what the set actually represents (it's more like "downloaded/queued but not yet released"). Update the comment to match the actual lifecycle so future changes don't rely on the wrong invariant.

#### Finding 5 — `bot/src/media-store.ts:56`
> `cleanupSessionMediaDir()` (and other cleanup paths) remove directories under `MEDIA_BASE` without verifying that `MEDIA_BASE` itself is not a symlink. Because `SessionManager.closeSession()` calls this even for sessions that never downloaded media, a pre-squatted symlink at `/tmp/bot-media` could redirect deletions outside the intended tree. Consider reusing the `ensureSecureDir`/`lstatSync` symlink check before recursive removal.

#### Outcomes
- [ ] Finding 1: `pendingDropCleanups` are no longer lost when `processFn` throws or when the queue is cleared during processing. Drop cleanups run on success AND on every error/clear path that abandons the in-flight message
- [ ] Finding 2: `collectDropCleanups` in `drainCollectBuffer()` get the same treatment — never lost on processFn failure or mid-drain clear
- [ ] Finding 3: `enforceMediaCap()` never evicts a path that is currently in `inflightMediaPaths`. Add a regression test that downloads a file, forces cap pressure, and verifies the in-flight file is preserved while older non-in-flight files get evicted
- [ ] Finding 4: `inflightMediaPaths` docstring accurately describes the set's actual lifecycle ("downloaded/queued but not yet released to a session" or equivalent — match the real semantics)
- [ ] Finding 5: `cleanupSessionMediaDir()` (and any other cleanup path that removes under `MEDIA_BASE`) refuses to act when `MEDIA_BASE` itself is a symlink. Reuse the existing `ensureSecureDir` / `lstatSync` pattern. Add a regression test that pre-squats a symlink at `MEDIA_BASE` and verifies cleanup refuses to follow it
- [ ] Existing media-store and message-queue tests still pass
- [ ] `cd bot && npx tsc --noEmit` clean
- [ ] `cd bot && npm test` — only the pre-existing WHISPER_MODEL voice test failure is acceptable; everything else passes
