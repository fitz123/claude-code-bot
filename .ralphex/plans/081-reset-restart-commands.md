# Plan: /clean for full context wipe, rename /reset to /reconnect

GitHub issue: #81

## Problem

Current `/reset` kills subprocess but keeps session file. Resume brings back compacted history. No way to get a clean slate.

## Changes

### 1. session-manager.ts — add `destroySession()` method

Add a new public method that closes the session AND deletes stored state:

```ts
async destroySession(chatId: string): Promise<void> {
  await this.closeSession(chatId);
  this.store.deleteSession(chatId);
}
```

`closeSession()` already handles: kill subprocess, clear idle timer, clean outbox/inject dirs, remove from active map. `destroySession()` adds: delete from store so no `--resume` happens.

- [x] Add `destroySession()` method to SessionManager

### 2. telegram-bot.ts — rename `/reset` to `/reconnect`, add `/clean`

Command list (line ~29):
```ts
{ command: "reconnect", description: "Reconnect session (keeps context)" },
{ command: "clean", description: "Clean session (fresh start)" },
```

Remove the old "reset" entry from command list.

Rename existing handler at line 588 from `bot.command("reset", ...)` to `bot.command("reconnect", ...)`.
Keep reply: `"Session restarted. Prior context may be partially retained."`

Add new `/clean` handler:
```ts
bot.command("clean", async (ctx) => {
  const topicId = ctx.message?.message_thread_id;
  if (ctx.message) setThread(ctx.chat.id, ctx.message.message_id, topicId);
  const binding = resolveBinding(ctx.chat.id, config.bindings, topicId);
  if (!binding) return;
  if (ctx.message && isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
    log.debug("telegram-bot", `Discarding stale /clean for chat ${ctx.chat.id}`);
    return;
  }
  const key = sessionKey(ctx.chat.id, topicId);
  messageQueue.clear(key);
  await sessionManager.destroySession(key);
  await ctx.reply("Session cleaned. Fresh start.");
});
```

- [ ] Update command list: replace "reset" with "reconnect" and "clean"
- [ ] Rename existing reset handler to "reconnect"
- [ ] Add new "/clean" handler calling `destroySession()`

### 3. discord-bot.ts — same changes

Rename slash command from "reset" to "reconnect", add new "clean" slash command.
Update handlers accordingly.

- [ ] Update Discord slash commands
- [ ] Update Discord handlers

### 4. Error messages — update references

In `message-queue.ts` and `session-manager.ts`, error messages say "use /reset". Change to "/reconnect" since users hitting errors want to retry with context, not nuke everything.

Files:
- `bot/src/message-queue.ts` lines 206, 282 — change `/reset` to `/reconnect`
- `bot/src/session-manager.ts` line 180 — change `/reset` to `/reconnect`

- [ ] Update error messages to reference /reconnect

### 5. Tests

- [ ] Update telegram-bot.test.ts command list assertion to include "reconnect" and "clean" instead of "reset"
- [ ] Add test: `/reconnect` calls `closeSession()` (not `destroySession()`)
- [ ] Add test: `/clean` calls `destroySession()`
- [ ] Add test: `destroySession()` calls `closeSession()` then `deleteSession()` on store
- [ ] Update any existing reset tests to use "reconnect"
- [ ] Update Discord tests if they exist

## Checklist

- [ ] `destroySession()` in session-manager.ts
- [ ] Telegram: rename to /reconnect, add /clean
- [ ] Discord: rename to /reconnect, add /clean
- [ ] Error messages → /reconnect
- [ ] Tests pass
