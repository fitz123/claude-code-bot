# Plan: /reset for full context wipe, rename current to /restart

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

- [ ] Add `destroySession()` method to SessionManager

### 2. telegram-bot.ts — rename `/reset` to `/restart`, add new `/reset`

Command list (line ~29):
```ts
{ command: "restart", description: "Restart session (keeps context)" },
{ command: "reset", description: "Reset session (clean start)" },
```

Rename existing handler at line 588 from `bot.command("reset", ...)` to `bot.command("restart", ...)`.
Change reply to: `"Session restarted. Prior context may be partially retained."`

Add new `/reset` handler:
```ts
bot.command("reset", async (ctx) => {
  const topicId = ctx.message?.message_thread_id;
  if (ctx.message) setThread(ctx.chat.id, ctx.message.message_id, topicId);
  const binding = resolveBinding(ctx.chat.id, config.bindings, topicId);
  if (!binding) return;
  if (ctx.message && isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
    log.debug("telegram-bot", `Discarding stale /reset for chat ${ctx.chat.id}`);
    return;
  }
  const key = sessionKey(ctx.chat.id, topicId);
  messageQueue.clear(key);
  await sessionManager.destroySession(key);
  await ctx.reply("Session reset. Clean start.");
});
```

- [ ] Update command list: add "restart", update "reset" description
- [ ] Rename existing reset handler to "restart"
- [ ] Add new "/reset" handler calling `destroySession()`

### 3. discord-bot.ts — same changes

Rename slash command from "reset" to "restart", add new "reset" slash command.
Update handler to dispatch to correct method based on command name.

- [ ] Update Discord slash commands
- [ ] Update Discord handler

### 4. Error messages — update references

In `message-queue.ts` and `session-manager.ts`, error messages say "use /reset". Change to "/restart" since users hitting errors want to retry with context, not nuke everything.

Files:
- `bot/src/message-queue.ts` lines 206, 282 — change `/reset` to `/restart`
- `bot/src/session-manager.ts` line 180 — change `/reset` to `/restart`

- [ ] Update error messages to reference /restart

### 5. Tests

- [ ] Update telegram-bot.test.ts command list assertion to include both "reset" and "restart"
- [ ] Add test: `/restart` calls `closeSession()` (not `destroySession()`)
- [ ] Add test: `/reset` calls `destroySession()`
- [ ] Add test: `destroySession()` calls `closeSession()` then `deleteSession()` on store
- [ ] Update any existing reset tests to use "restart"
- [ ] Update Discord tests if they exist

## Checklist

- [ ] `destroySession()` in session-manager.ts
- [ ] Telegram: rename to /restart, add /reset
- [ ] Discord: rename to /restart, add /reset
- [ ] Error messages → /restart
- [ ] Tests pass
