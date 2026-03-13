# Bot Features — Round 9

## Goal

Fix session crashes on config changes, add guild-wide default Discord bindings with per-channel overrides, and redesign file sending so Claude can intentionally deliver files to users via an outbox directory.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Reference: Current Discord binding resolution

`resolveDiscordBinding` in `discord-bot.ts` does exact `channelId` match only:

```typescript
// discord-bot.ts:25-29
export function resolveDiscordBinding(
  channelId: string,
  bindings: DiscordBinding[],
): DiscordBinding | undefined {
  return bindings.find((b) => b.channelId === channelId);
}
```

Config validation in `config.ts` requires `channelId`:
```typescript
// config.ts:124
throw new Error(`discord.bindings[${index}] missing channelId (string)`);
```

Current `DiscordBinding` type in `types.ts`:
```typescript
export interface DiscordBinding {
  channelId: string;      // <-- currently required
  guildId: string;
  agentId: string;
  kind: "dm" | "channel";
  label?: string;
  requireMention?: boolean;
  streamingUpdates?: boolean;
  typingIndicator?: boolean;
}
```

## Reference: Telegram's topic override pattern (the model to follow)

Telegram already supports chat-wide defaults with per-topic overrides. `resolveBinding` in `telegram-bot.ts`:

```typescript
// telegram-bot.ts:37
export function resolveBinding(
  chatId: number,
  bindings: TelegramBinding[],
  topicId?: number,
): TelegramBinding | undefined {
  let fallback: TelegramBinding | undefined;
  for (const b of bindings) {
    if (b.chatId !== chatId) continue;
    if (b.topicId !== undefined) {
      if (b.topicId === topicId) return b; // exact topic match wins
    } else {
      fallback ??= b; // chatId-only binding as fallback
    }
  }

  // Check topics array for per-topic overrides
  if (fallback && topicId !== undefined && fallback.topics) {
    const topic = fallback.topics.find((t) => t.topicId === topicId);
    if (topic) {
      const { topics: _, ...base } = fallback;
      return {
        ...base,
        agentId: topic.agentId ?? fallback.agentId,
        requireMention: topic.requireMention ?? fallback.requireMention,
        topicId,
      };
    }
  }

  return fallback;
}
```

Resolution priority: exact topicId match → per-topic override from `topics[]` → chatId-only fallback.

## Reference: Current Discord config format

```yaml
discord:
  tokenService: discord-bot-token
  bindings:
    - channelId: '1479772128298664007'
      guildId: '1470077196537168007'
      agentId: main
      kind: channel
      label: Main
      requireMention: false
```

Desired format (guild-wide default + per-channel overrides):
```yaml
discord:
  tokenService: discord-bot-token
  bindings:
    - guildId: '1470077196537168007'
      agentId: main
      kind: channel
      label: My Server
      requireMention: true
      channels:
        - channelId: '1479772128298664007'
          label: Platform
          requireMention: false
        - channelId: '1479781308837138454'
          agentId: coder
          label: Coding
```

## Reference: Discord message handler channel resolution

`discord-bot.ts` message handler extracts channelId and passes to resolveDiscordBinding:

```typescript
// discord-bot.ts:120-134
const channelId = message.channel.isThread()
  ? message.channel.parentId ?? message.channelId
  : message.channelId;
const threadId = message.channel.isThread() ? message.channelId : undefined;

const binding = resolveDiscordBinding(channelId, discordConfig.bindings);
if (!binding) { log.info("discord-bot", `No binding for channel ${channelId} (thread: ${threadId})`); return; }
```

Note: for threads, `channelId` is already resolved to `parentId`. The binding resolution needs the `guildId` too — available via `message.guildId`.

**IMPORTANT:** `resolveDiscordBinding` is also called from the slash command handler (~line 239 in discord-bot.ts) with the same signature. Both call sites must be updated if the signature changes. `interaction.guildId` is available there.

## Reference: Disabled file sending in stream-relay.ts

File sending was implemented in round 6 but disabled because it auto-sends ALL files Claude writes (configs, gitignore, markdown edits, etc.):

```typescript
// stream-relay.ts:180-181
if (false && workspaceCwd) { // DISABLED: auto-sends all written files, needs redesign
  collectWritePaths(msg, writtenFiles);
```

The `collectWritePaths` helper (stream-relay.ts:81) scans AssistantMessage events for Write tool_use blocks and collects `input.file_path` into a `Set<string>`.

File sending after stream completes (stream-relay.ts:270-290) validates paths against workspace/tmp, checks existence, determines image vs document by extension, and calls `platform.sendFile()`.

## Reference: PlatformContext sendFile (already implemented in both adapters)

```typescript
// types.ts — PlatformContext interface
sendFile(filePath: string, isImage: boolean): Promise<void>;

// telegram-adapter.ts:48
async sendFile(filePath: string, isImage: boolean): Promise<void> {
  if (isImage) {
    await ctx.replyWithPhoto(new InputFile(filePath), threadOpts);
  } else {
    await ctx.replyWithDocument(new InputFile(filePath), threadOpts);
  }
}

// discord-adapter.ts:50
async sendFile(filePath: string, _isImage: boolean): Promise<void> {
  await channel.send({ files: [{ attachment: filePath }] });
}
```

Both adapters already implement `sendFile`. The plumbing works — the problem is detection (what files to send).

## Reference: How Claude sessions are spawned

`cli-protocol.ts` `buildSpawnArgs` constructs Claude CLI args including `--append-system-prompt` from agent config:

```typescript
if (opts.agent.systemPrompt) {
  args.push("--append-system-prompt", opts.agent.systemPrompt);
}
```

`AgentConfig` in `types.ts`:
```typescript
export interface AgentConfig {
  id: string;
  workspaceCwd: string;
  model: string;
  fallbackModel?: string;
  maxTurns?: number;
  effort?: string;
  systemPrompt?: string;
}
```

The `systemPrompt` field is already parsed from config.yaml agent definitions but not currently used by any agent.

`buildSpawnArgs` only appends `--append-system-prompt` from `opts.agent.systemPrompt`. To inject dynamic per-session instructions (like an outbox path), either `SpawnOptions` needs an additional field for dynamic prompts, or `buildSpawnArgs` needs to accept extra prompt text to append alongside the agent's static `systemPrompt`.

## Reference: relayStream signature

```typescript
// stream-relay.ts
export async function relayStream(
  stream: AsyncGenerator<StreamLine>,
  platform: PlatformContext,
  workspaceCwd?: string,
): Promise<void>
```

The outbox path needs to reach the file-sending logic after stream completion. Currently `workspaceCwd` is the only path parameter.

## Reference: Session resume ignores agentId mismatch

`getOrCreateSession` in `session-manager.ts` (line ~112) receives `agentId` from the binding but blindly uses the stored session for resume:

```typescript
// session-manager.ts:147-155
const stored = this.store.getSession(chatId);
const resume = stored !== undefined && stored.sessionId !== "";
const sessionId = resume ? stored.sessionId : randomUUID();

const child = spawnClaudeSession({
  agent,       // <-- from current binding (e.g. "coder")
  sessionId,   // <-- from stored session (created with "main")
  resume,      // <-- true, will pass --resume <sessionId>
  includePartialMessages: true,
});
```

`SessionState` stores the `agentId` that created the session:
```typescript
export interface SessionState {
  sessionId: string;
  chatId: string;
  agentId: string;
  lastActivity: number;
}
```

But `getOrCreateSession` never compares `stored.agentId` with the incoming `agentId`. When they differ (e.g. config changed from `main` to `coder`), it spawns Claude with `--resume <old-sessionId>` in the new agent's `workspaceCwd` — the old session doesn't exist in that workspace, causing `code=1` exit.

## Tasks

### Task 1: Discard stale sessions on agentId mismatch (bot-aj8, P1)

**Problem:** When a binding's `agentId` is changed in config.yaml, existing sessions in `data/sessions.json` still reference the old agent. `getOrCreateSession` blindly resumes the stored session in the new agent's workspace — the old Claude CLI session doesn't exist there, causing an immediate `code=1` crash. This requires manual deletion of `sessions.json` to recover, which kills all active sessions across all bindings.

**What we want:** Before attempting `--resume`, `getOrCreateSession` should compare the stored session's `agentId` with the current binding's `agentId`. If they differ, discard the stored session and create a fresh one. Log a warning when this happens so it's visible in logs. This should also handle the case where the stored `agentId` references an agent that no longer exists in config.

- [x] `getOrCreateSession` detects agentId mismatch between stored session and current binding
- [x] Mismatched sessions are discarded (not resumed) and a fresh session is created
- [x] Warning logged when a stale session is discarded due to agentId mismatch
- [x] Sessions with agentId referencing a deleted agent are also discarded
- [x] Other sessions in the store are not affected (no full flush)
- [x] Tests for agentId mismatch detection and fresh session creation
- [x] Verify existing tests pass

### Task 2: Guild-wide default Discord binding with per-channel overrides (bot-66d, P2)

**Problem:** Discord bindings require an explicit `channelId` for each channel. If you have a server with 20 channels, you need 20 binding entries. There's no way to set a guild-wide default and override specific channels — unlike Telegram, which supports chatId-level defaults with per-topic overrides via the `topics[]` array.

**What we want:** A Discord binding with `guildId` but no `channelId` acts as a guild-wide default — any channel in that guild uses it. Per-channel overrides (via a `channels[]` array on the guild binding, same pattern as Telegram's `topics[]`) can override `agentId`, `label`, `requireMention`, `streamingUpdates`, and `typingIndicator` for specific channels. Resolution priority: exact channelId match → per-channel override from `channels[]` → guild-wide fallback. `channelId` becomes optional in the binding type. Config validation updated accordingly. `resolveDiscordBinding` needs `guildId` as an additional parameter (available from the Discord message).

- [ ] `channelId` is optional in `DiscordBinding` — a binding with only `guildId` is valid
- [ ] `channels` array support on guild-wide bindings (same pattern as Telegram `topics[]`)
- [ ] `resolveDiscordBinding` accepts `guildId` parameter and resolves: exact channel → channel override → guild default
- [ ] Config validation allows bindings without `channelId`
- [ ] Config validation validates `channels[]` entries (channelId required in override, agentId references valid agent)
- [ ] Existing per-channel bindings (with explicit `channelId`) continue to work unchanged
- [ ] Tests for resolution priority (exact > override > guild default)
- [ ] Tests for config validation (guild-only binding, channel overrides, invalid entries)
- [ ] Verify existing tests pass

### Task 3: Outbox-based file sending from Claude to chat (bot-sdo, P2)

**Problem:** When Claude creates files during a session (images, charts, documents), there's no way to deliver them to the user. The round 6 implementation auto-sent ALL files from Write tool_use events, which was wrong — it sent every config file, gitignore, and markdown edit Claude touched. It was disabled with `if (false && workspaceCwd)`.

**What we want:** An explicit outbox mechanism. Each session gets an outbox directory (e.g. `/tmp/bot-outbox/<sessionKey>/`). Claude is told about this directory via a dynamic `--append-system-prompt` injected at session spawn time (not hardcoded in agent config — the outbox path is per-session). This dynamic prompt should be appended alongside any existing `systemPrompt` from the agent config, not replacing it. When Claude wants to send a file to the user, it writes/copies it to the outbox directory. After the stream completes (result received), the bot checks the outbox directory for files, sends each one via `platform.sendFile()`, then cleans up. No automatic scanning of Write tool_use events — only files explicitly placed in the outbox are sent. Works for both Telegram and Discord (both adapters already implement `sendFile`). Remove the old disabled `collectWritePaths` code path.

- [ ] Outbox directory created per session (unique path, e.g. `/tmp/bot-outbox/<sessionKey>/`)
- [ ] Outbox path communicated to Claude via `--append-system-prompt` when spawning the session
- [ ] System prompt instruction tells Claude to copy/write files to the outbox dir when user asks for a file
- [ ] After stream completes, bot scans outbox directory for files
- [ ] Each file in outbox is sent via `platform.sendFile()` (images via photo, others via document)
- [ ] Outbox directory cleaned up after files are sent (or on session close)
- [ ] Old disabled `collectWritePaths` code path removed from stream-relay.ts
- [ ] Works for both Telegram and Discord
- [ ] Tests for outbox scanning, file sending, and cleanup
- [ ] Verify existing tests pass
