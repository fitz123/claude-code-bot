# Bot Features — Round 5

## Goal

Add message source context and flexible forum topic controls.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Reference: Current binding config

```yaml
bindings:
  - chatId: 306600687
    agentId: main
    kind: dm
    label: Ninja DM

  - chatId: -1003894624477
    agentId: main
    kind: group
    label: Minime HQ
```

## Reference: Current message flow

Messages are enqueued at 4 call sites in `telegram-bot.ts`:
- Line ~211: text messages — `messageQueue.enqueue(key, binding.agentId, messageText, ctx)`
- Line ~247: voice messages — `messageQueue.enqueue(key, binding.agentId, \`[Voice message] ${transcript}\`, ctx)`
- Line ~297: photo messages — `messageQueue.enqueue(key, binding.agentId, messageText, ctx, cleanup)`
- Line ~342: document messages — `messageQueue.enqueue(key, binding.agentId, messageText, ctx, cleanup)`

All messages arrive to Claude as plain text with no source context.

## Reference: Available sender info from grammY

`ctx.from` provides: `id`, `first_name`, `last_name?`, `username?`
`ctx.message.message_thread_id` provides the forum topic ID.
`binding.label` provides the human-readable chat name.

## Reference: Current TelegramBinding type

```typescript
export interface TelegramBinding {
  chatId: number;
  agentId: string;
  kind: "dm" | "group";
  topicId?: number;
  label?: string;
}
```

## Tasks

### Task 1: Add message source context prefix (bot-cbf, P1)

Claude does not know which chat or topic a message came from. Prefix every message sent to Claude with source context so it can respond appropriately across multiple chats.

All 4 enqueue call sites in `telegram-bot.ts` need the prefix. Sender info from `ctx.from` (first_name, username). Chat name from `binding.label`.

- [ ] Add helper to build source context prefix from binding and ctx
- [ ] Apply prefix at all 4 enqueue sites
- [ ] Update tests

### Task 2: Flexible forum topic bindings with requireMention (bot-odl, P2)

Group bindings currently always require @mention or reply-to-bot. Add flexible per-topic control:

1. Add `requireMention?: boolean` to TelegramBinding (default true for groups, false for DMs)
2. Add `topics?: Array<{ topicId: number; agentId?: string; requireMention?: boolean }>` to TelegramBinding
3. Group-level `agentId` and `requireMention` are defaults
4. Per-topic entries override either or both
5. Topics not listed inherit group defaults
6. Update `resolveBinding()` to resolve topic-level overrides
7. Update the group chat @mention filter to check resolved `requireMention`
8. Parse and validate new fields in `config.ts`

Example config:
```yaml
bindings:
  - chatId: -1003894624477
    agentId: main
    kind: group
    requireMention: true
    topics:
      - topicId: 123
        requireMention: false
      - topicId: 456
        agentId: finance-agent
        requireMention: false
```

- [ ] Add requireMention and topics to TelegramBinding type
- [ ] Parse and validate in config.ts
- [ ] Update resolveBinding to handle topic overrides
- [ ] Update group mention filter to use resolved requireMention
Note: the group mention filter is duplicated across 4 handlers. The text handler (line 188) checks both @mention and reply-to-bot. The voice (222), photo (270), and document (319) handlers only check reply-to-bot. When implementing requireMention, all 4 handlers need to use the resolved setting. Consider extracting a shared helper.- [ ] Update tests

### Task 3: Configurable echo transcript for voice messages (bot-61u, P2)

The 📝 "transcript" echo reply is currently always sent after voice transcription. Add a config option to enable/disable it per binding or globally.

OpenClaw uses a configurable format string with `{transcript}` placeholder (see `echo-transcript.ts`: `DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"'`).

Options to consider:
- Global setting in config.yaml (e.g. `voiceEcho: true/false`)
- Per-binding override
- Or a format string like OpenClaw (empty string = disabled)

The echo reply is at `telegram-bot.ts` line ~249: `ctx.reply(\`📝 "\${transcript}"\`)`

- [ ] Add echo transcript config option
- [ ] Apply to voice handler
- [ ] Update tests
