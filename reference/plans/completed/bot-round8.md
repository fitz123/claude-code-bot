# Discord Support — Round 8

## Goal

Add Discord as a second messaging platform alongside Telegram. Same capabilities (messaging, streaming edits, voice, images, commands). Discord threads get independent sessions (no context injection from parent channel).

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Reference: Telegram-coupled code in stream-relay.ts

The `relayStream()` function takes a grammy `Context` and uses Telegram-specific APIs:

```typescript
import { type Context, InputFile } from "grammy";

export async function relayStream(
  stream: AsyncGenerator<StreamLine>,
  ctx: Context,
  workspaceCwd?: string,
): Promise<void>
```

Telegram-specific calls inside relayStream:
- `ctx.api.sendChatAction(chatId, "typing", ...)` — typing indicator (resent every 4000ms)
- `ctx.api.editMessageText(chatId, sentMessageId, displayText)` — streaming edit
- `ctx.reply(displayText, { message_thread_id })` — send new message
- `ctx.replyWithPhoto(new InputFile(realPath), opts)` — send image file
- `ctx.replyWithDocument(new InputFile(realPath), opts)` — send document file

Platform-specific constants:
- `MAX_MSG_LENGTH = 4096` (Discord: 2000)
- `EDIT_DEBOUNCE_MS = 2000`
- `TYPING_INTERVAL_MS = 4000` (Telegram typing lasts 5s; Discord typing lasts 10s)

Pure-logic helpers (reusable as-is, no platform API calls):
- `splitMessage(text, maxLen)` — already parameterized
- `extractText(msg)` — works on StreamLine types (imports `extractTextDelta` from cli-protocol)
- `collectWritePaths(msg, paths)` — extracts Write tool_use file paths
- `isImageExtension(filePath)` — extension check

NOTE: File sending code in `relayStream` is currently disabled (`if (false && workspaceCwd)`) but still uses `InputFile` from grammy. This dead code should be abstracted into the platform interface too, even though it is disabled.

## Reference: Telegram-coupled ProcessFn in message-queue.ts

```typescript
import type { Context } from "grammy";

export type ProcessFn = (
  chatId: string,
  agentId: string,
  text: string,
  ctx: Context,   // <-- coupling point 1
) => Promise<void>;
```

grammy Context is also used in error handlers and mid-turn drain:
```typescript
// Error handler (coupling point 2)
await state.latestCtx
  .reply("Something went wrong. Try again or /reset the session.")
  .catch(() => {});

// Mid-turn message drain also stores and uses latestCtx (coupling point 3)
```

All debounce, collect, and timer logic is platform-agnostic — only the ctx usage needs abstraction.

## Reference: Binding and config types in types.ts / config.ts

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
  // NOT YET PRESENT — bot-d9g requests these:
  // streamingUpdates?: boolean;  // default true. When false: no progressive edits, send final message only
  // typingIndicator?: boolean;   // default true. When false: no sendChatAction("typing")
}

export interface BotConfig {
  telegramToken: string;
  agents: Record<string, AgentConfig>;
  bindings: TelegramBinding[];
  sessionDefaults: SessionDefaults;
  logLevel?: LogLevel;
  metricsPort?: number;
}
```

Config uses `telegramTokenService` for macOS Keychain lookup. **IMPORTANT:** `loadConfig()` currently throws if `telegramTokenService` is missing — this must be made optional for Discord-only setups.
```yaml
telegramTokenService: telegram-bot-token
bindings:
  - chatId: 306600687
    agentId: main
    kind: dm
    label: Ninja DM
```

## Reference: Platform-agnostic core (no changes needed)

These modules have zero platform coupling:
- `session-manager.ts` — Claude CLI subprocess management, keyed by string IDs
- `cli-protocol.ts` — spawns claude CLI, stream-json protocol
- `session-store.ts` — JSON persistence (`data/sessions.json`), maps string keys to SessionState
- `logger.ts` — structured logging
- `metrics.ts` — Prometheus metrics

Session key pattern: `String(chatId)` or `${chatId}:${topicId}` — same pattern works for Discord with platform prefix.

## Reference: Session store and state

`SessionState` is defined in `types.ts` (NOT session-store.ts):
```typescript
// types.ts
export interface SessionState {
  sessionId: string;
  chatId: string;
  agentId: string;
  lastActivity: number;
}
```

`session-store.ts` imports `SessionState` from `types.ts` and persists it as JSON.

## Reference: Discord.js v14 key API patterns

Message sending and editing:
```typescript
const msg = await channel.send({ content: "Initial..." });
await msg.edit({ content: "Updated" }); // edit returns Message, not void
```

Typing (lasts 10s, not 5s like Telegram):
```typescript
await channel.sendTyping();
```

Thread handling:
```typescript
// Detect thread messages
if (message.channel.isThread()) {
  const parentChannelId = message.channel.parentId;
  const threadId = message.channel.id;
}

// Thread creation event — bot must join to receive messages
client.on('threadCreate', async (thread) => {
  if (!thread.joined) await thread.join();
});
```

Bot mention detection:
```typescript
if (message.mentions.has(client.user)) { /* mentioned */ }
```

File sending:
```typescript
await channel.send({
  files: [{ attachment: '/path/to/file.png', name: 'file.png' }]
});
```

Required intents:
```typescript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // privileged, must enable in Developer Portal
  ]
});
```

Key differences from Telegram:
- Message limit: 2000 chars (vs 4096)
- Rate limits: 5/5s per channel (vs ~20/min per chat_id, shared across forum topics)
- Edit API: `message.edit(text)` on message object (vs `editMessageText(chatId, msgId, text)`)
- Typing: lasts 10s (vs 5s)
- Auth: guild+channel ID (vs chat ID)

## Reference: telegram-bot.ts key functions

```typescript
function sessionKey(chatId: number | string, topicId?: number): string {
  const base = String(chatId);
  return topicId != null ? `${base}:${topicId}` : base;
}
// NOTE: already accepts string IDs — Discord snowflake IDs will work

function resolveBinding(chatId: number, bindings: TelegramBinding[], topicId?: number): TelegramBinding | undefined
// Maps chatId+topicId -> binding config. Has topic-override merging that creates synthetic binding objects.

function shouldRespondInGroup(binding: TelegramBinding, botId: number, botUsername: string, message: Message): boolean
// Params: binding, botId, botUsername, message (in that order — NOT message first)
// Checks requireMention, @mention detection, reply-to-bot, forum service messages

function buildSourcePrefix(binding: TelegramBinding, from: { first_name: string; username?: string }): string
// Returns "[Chat: label | From: name (@username)]" — prepended to every message for Claude context
```

## Tasks

### Task 1: Platform abstraction layer with per-binding streaming control (bot-discord-1 + bot-d9g, P1)

**Problem 1:** All message I/O is hardcoded to grammy types. `stream-relay.ts` imports `{ type Context, InputFile } from "grammy"` and calls `ctx.api.editMessageText()`, `ctx.api.sendChatAction()`, `ctx.reply()`, `ctx.replyWithPhoto()`, `ctx.replyWithDocument()` directly. `message-queue.ts` imports `type { Context } from "grammy"` and its `ProcessFn` type takes `ctx: Context`. Adding a second platform without abstraction means duplicating ~300 lines of relay logic and ~200 lines of queue logic.

**Problem 2 (bot-d9g):** There is no way to disable streaming edits or typing indicators per binding. In group chats with concurrent conversations, the bot hits Telegram's ~20 req/min rate limit because every binding sends edits every 2s + typing every 4s. Some bindings would benefit from "quiet mode" — send only the final message, no progressive edits, no typing indicator. This reduces API requests from ~45/min to ~1/min per active session.

**What we want:** A platform-agnostic interface that captures the message I/O operations both Telegram and Discord need — send message (returns an ID), edit message by ID, send typing indicator, send file (image vs document), reply with error. Each platform provides its own constants (max message length, edit debounce interval, typing interval). The interface also respects per-binding `streamingUpdates` (boolean, default true) and `typingIndicator` (boolean, default true) flags — when streaming is off, `relayStream` skips all intermediate edits and sends only the final message; when typing is off, no typing indicators are sent. `relayStream()` and `MessageQueue` use this interface instead of grammy `Context`. After this task, `import ... from "grammy"` appears only in `telegram-bot.ts`, its adapter, and Telegram-specific tests — nowhere else. Tests for `stream-relay` and `message-queue` should also be updated to use the platform interface instead of grammy mocks.

- [ ] Platform-agnostic message I/O interface defined with all operations (send, edit, typing, sendFile, replyError) and platform constants (maxMessageLength, editDebounceMs, typingIntervalMs)
- [ ] Interface includes `streamingUpdates` and `typingIndicator` boolean flags (from binding config)
- [ ] `relayStream()` refactored to use the interface — no grammy imports in stream-relay.ts
- [ ] When `streamingUpdates` is false, `relayStream` accumulates text without intermediate edits, sends only the final complete message
- [ ] When `typingIndicator` is false, no typing actions are sent
- [ ] `MessageQueue` refactored to use the interface — no grammy imports in message-queue.ts
- [ ] Telegram adapter implementing the interface by wrapping grammy Context
- [ ] `telegram-bot.ts` updated to create adapter and pass to relayStream/MessageQueue
- [ ] `streamingUpdates` and `typingIndicator` added to binding config types (default true for backward compatibility)
- [ ] Binding types generalized to support platform prefix in session keys
- [ ] All existing tests pass
- [ ] Tests for the platform interface adapter
- [ ] Tests for streamingUpdates=false (no edits, only final message) and typingIndicator=false (no typing sent)

### Task 2: Discord bot with streaming (bot-discord-2, P1)

**Problem:** No Discord support exists. The bot only works with Telegram. Users want the same capabilities on Discord: receive messages, stream responses with progressive edits, handle voice messages and images, support bot commands. Discord has different constraints: 2000-char message limit, 10s typing indicator, channel+guild auth model, `message.edit()` on message objects, `<@botId>` mention detection. Discord threads should get their own independent session (same as Telegram forum topics).

**What we want:** A `discord-bot.ts` module that connects to Discord, receives messages in configured channels and threads, streams responses using the platform interface from Task 1, handles voice/image attachments, supports slash commands (/start, /reset, /status), and integrates with the same SessionManager and MessageQueue. Discord threads get independent sessions keyed by `discord:${channelId}:${threadId}` — just a fresh session, no context injection from parent. Discord token stored in macOS Keychain (same pattern as `telegramTokenService`). Config supports `discord` section with `tokenService` and `bindings` array. Both platforms run simultaneously sharing one SessionManager. `main.ts` starts Discord bot alongside Telegram if discord config is present.

- [ ] `discord.js` added to package.json dependencies
- [ ] Discord binding types added (channelId, guildId, agentId, kind, label, requireMention)
- [ ] Config parsing for `discord.tokenService` and `discord.bindings` in config.ts
- [ ] `telegramTokenService` made optional (bot can run Discord-only)
- [ ] Discord bot module with client setup, required intents, login, message handler
- [ ] Discord adapter implementing the platform interface (2000 char limit, 9s typing resend, message.edit())
- [ ] Thread support: bot joins threads on creation, threads get independent sessions
- [ ] Binding resolution for Discord channels (thread inherits parent channel binding)
- [ ] Mention gating (requireMention support)
- [ ] Source prefix building for Discord context
- [ ] Voice message handling (download attachment, transcribe, enqueue)
- [ ] Image/document attachment handling
- [ ] Slash commands: /start, /reset, /status
- [ ] `main.ts` starts Discord bot alongside Telegram when discord config present
- [ ] Tests for Discord binding resolution, mention detection, session keys, thread handling
- [ ] All existing tests pass
