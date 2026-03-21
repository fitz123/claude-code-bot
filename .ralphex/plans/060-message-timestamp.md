# Add Timestamp to Message Source Prefix — Round 1

## Goal

Add message timestamp to the source prefix so Claude agents know when each message was sent. Currently the prefix shows chat, topic, and sender but no time — agents cannot distinguish stale from fresh messages or reason about timing.

## Validation Commands

```bash
cd bot && npx tsc --noEmit && npm test
```

## Reference: buildSourcePrefix (Telegram)

Current implementation at `bot/src/telegram-bot.ts:89-112`:

```typescript
export function buildSourcePrefix(
  binding: TelegramBinding,
  from?: { first_name: string; username?: string },
): string {
  const parts: string[] = [];
  if (binding.label) {
    parts.push(`Chat: ${binding.label}`);
  }
  if (binding.topicId !== undefined) {
    parts.push(`Topic: ${binding.topicId}`);
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

Current output: `[Chat: Minime HQ | Topic: 1890 | From: User (@user)]`

## Reference: buildDiscordSourcePrefix

Current implementation at `bot/src/discord-bot.ts:92-109`:

```typescript
export function buildDiscordSourcePrefix(
  binding: DiscordBinding,
  author?: { username: string; displayName?: string; globalName?: string | null },
): string {
  const parts: string[] = [];
  if (binding.label) {
    parts.push(`Chat: ${binding.label}`);
  }
  if (author) {
    const displayName = author.globalName ?? author.displayName ?? author.username;
    const name = displayName.replace(/[\n\r]/g, " ");
    const sender = `${name} (@${author.username.replace(/[\n\r]/g, "")})`;
    parts.push(`From: ${sender}`);
  }
  return parts.length > 0 ? `[${parts.join(" | ")}]\n` : "";
}
```

## Reference: Message timestamp sources

Telegram `ctx.message.date` — Unix seconds (integer). Already used at multiple call sites for stale message detection (e.g. `telegram-bot.ts:572`: `isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)`).

Discord `message.createdTimestamp` — Unix milliseconds. Used at `discord-bot.ts:213` for stale detection.

Reaction events: `ctx.messageReaction.date` — Unix seconds (Telegram).

## Reference: Call sites

Telegram (`telegram-bot.ts`):
- Line 580: text messages — `buildSourcePrefix(binding, ctx.from)`
- Line 631: voice messages — `buildSourcePrefix(binding, ctx.from)`
- Line 684: photo messages — `buildSourcePrefix(binding, ctx.from)`
- Line 748: document messages — `buildSourcePrefix(binding, ctx.from)`
- Line 805: reactions — `buildSourcePrefix(binding, from)`

Discord (`discord-bot.ts`):
- Line 219: text messages — `buildDiscordSourcePrefix(binding, message.author)`

## Reference: Existing tests

`bot/src/__tests__/telegram-bot.test.ts:215-268` — 7 tests for `buildSourcePrefix`:
- DM without label
- Group with label and from
- Without from
- Empty (no label, no from)
- With topicId
- Without topicId
- DM without topicId

`bot/src/__tests__/discord-bot.test.ts` — tests for `buildDiscordSourcePrefix`.

## Reference: Timezone

No timezone configuration exists in `config.ts` or agent config. The system timezone (`process.env.TZ` or OS default) is used implicitly.

## Tasks

### Task 1: Add timestamp to Telegram and Discord message prefixes (#60, P1)

Agents receive messages without timestamps. The user reports this makes it impossible to know when a message was sent — important for busy chats, stale messages after reconnect, and time-of-day context.

Evidence: current `buildSourcePrefix` output is `[Chat: Minime HQ | Topic: 1890 | From: User (@user)]` — no time component. User request in issue #60.

Desired: both Telegram and Discord source prefixes include the message time (HH:MM format in system timezone) as the last element before the closing bracket. Example: `[Chat: Minime HQ | Topic: 1890 | From: User (@user) | 19:53]`

- [ ] Telegram text, voice, photo, document, and reaction messages all include HH:MM timestamp in the source prefix
- [ ] Discord messages include HH:MM timestamp in the source prefix
- [ ] Timestamp uses system timezone
- [ ] When timestamp is not available (undefined/null), the prefix works without it (no crash, no empty field)
- [ ] Add tests for timestamp in prefix output (both Telegram and Discord)
- [ ] Verify existing tests pass
