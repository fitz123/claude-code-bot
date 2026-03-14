# Bot UX Fixes — Round 11

## Goal

Fix three user-facing issues: messages render as raw markdown (no parse_mode), inline quote context is lost, and /reset message misleads about session persistence.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Reference: telegram-adapter.ts reply calls (current code)

All `reply()` and `editMessageText()` calls send plain text — no `parse_mode` specified:

```typescript
// telegram-adapter.ts
async sendMessage(text: string): Promise<string> {
  const sent = await ctx.reply(text, { ...threadOpts });
  return String(sent.message_id);
},

async editMessage(messageId: string, text: string): Promise<void> {
  if (!chatId) return;
  await ctx.api.editMessageText(chatId, Number(messageId), text);
},

async replyError(text: string): Promise<void> {
  await ctx.reply(text, { ...threadOpts });
},
```

Result: `**bold**` and `` `code` `` appear as literal text in Telegram.

## Reference: Telegram MarkdownV2 escaping requirements

MarkdownV2 requires escaping these characters outside of entities: `_ * [ ] ( ) ~ > # + - = | { } . !`

This makes MarkdownV2 fragile — any unescaped special char in agent output causes the entire message to fail with `400 Bad Request: can't parse entities`.

Alternative: `parse_mode: "HTML"` only needs escaping of `< > &` (standard HTML entities). Agent output from Claude uses markdown, so a markdown→HTML converter is needed.

grammY has `@grammyjs/parse-mode` plugin but it adds complexity. A simpler approach: convert common markdown patterns (bold, italic, code blocks, inline code, links) to HTML before sending.

Key edge case: if conversion fails or produces invalid HTML, Telegram returns 400. Must have fallback to send as plain text.

## Reference: Telegram Bot API — TextQuote object

When a user selects text before replying, `message.quote` contains:

```typescript
interface TextQuote {
  text: string;               // the quoted text
  entities?: MessageEntity[];  // formatting in the quote
  position: number;           // UTF-16 offset in original message
  is_manual?: true;           // true if user explicitly selected text
}
```

grammY access: `ctx.message.quote?.text`

Currently `buildReplyContext()` in `telegram-bot.ts` only reads `reply_to_message.text` / `.caption` — it ignores `ctx.message.quote` entirely.

## Reference: buildReplyContext() current signature and logic

```typescript
// telegram-bot.ts lines 127-159
export function buildReplyContext(
  replyTo?: {
    from?: { first_name: string; username?: string };
    text?: string;
    caption?: string;
    forum_topic_created?: unknown;
    // ... other forum fields
  },
): string {
  if (!replyTo) return "";
  if (isForumServiceMessage(replyTo)) return "";

  let header = "[Reply]";
  if (replyTo.from) {
    const name = replyTo.from.first_name.replace(/[\n\r]/g, " ");
    const uname = replyTo.from.username?.replace(/[\n\r]/g, "") ?? "";
    const sender = uname ? `${name} (@${uname})` : name;
    header = `[Reply to ${sender}]`;
  }

  const replyText = replyTo.text ?? replyTo.caption ?? "";
  if (!replyText) return header + "\n";

  const cleaned = replyText.replace(/[\n\r]/g, " ").trim();
  const truncated = cleaned.length > REPLY_TRUNCATE_LIMIT
    ? cleaned.slice(0, REPLY_TRUNCATE_LIMIT) + "..."
    : cleaned;

  return `${header}\n> ${truncated}\n`;
}
```

Call sites pass `ctx.message.reply_to_message` but NOT `ctx.message.quote`. The function needs an additional parameter for the quote.

## Reference: /reset command and session lifecycle

```typescript
// telegram-bot.ts line 362-374
// /reset command — close current session, next message creates fresh
bot.command("reset", async (ctx) => {
  // ... stale check ...
  await sessionManager.closeSession(String(ctx.chat.id));
  messageQueues.forEach((mq) => mq.clear(String(ctx.chat.id)));
  await ctx.reply("Session reset. Next message starts a fresh conversation.");
});
```

`closeSession()` kills the Claude process but the session file remains on disk with compacted conversation history. When the next message arrives, `getOrCreateSession()` finds the session file and resumes with `--resume` flag, recovering context through compaction summary.

The message "Next message starts a fresh conversation" is false — context survives through session resumption.

## Tasks

### Task 1: Add markdown→HTML conversion for Telegram messages (bot-3ak, P1)

**Problem:** Bot messages show raw markdown (`**bold**`, `` `code` ``) because `ctx.reply()` is called without `parse_mode`. Claude agent output uses markdown formatting that Telegram doesn't render without explicit `parse_mode`.

**What we want:** Telegram messages render with proper formatting — bold, italic, inline code, code blocks, and links. The conversion must be robust: if the HTML is malformed (unmatched tags, invalid nesting), the message should fall back to plain text rather than failing with a 400 error. Both `sendMessage` and `editMessage` in `telegram-adapter.ts` need the conversion. `replyError` can stay plain text.

- [x] Messages with markdown formatting render correctly in Telegram (bold, italic, code, code blocks, links)
- [x] `sendMessage` uses `parse_mode: "HTML"` with markdown→HTML conversion
- [x] `editMessage` uses `parse_mode: "HTML"` with the same conversion
- [x] If HTML parsing fails (Telegram returns 400), message is retried as plain text
- [x] Code blocks with language tags (` ```typescript `) render as `<pre>` blocks
- [x] Special HTML characters (`<`, `>`, `&`) in agent output are escaped
- [x] Tests for markdown→HTML conversion (bold, italic, code, code blocks, links, mixed)
- [x] Tests for fallback to plain text on conversion failure
- [x] Verify existing tests pass

### Task 2: Support inline quotes in reply context (bot-9q3, P2)

**Problem:** When a user selects specific text in a message and replies, the bot shows the entire replied-to message as context. The selected quote (the part the user highlighted) is ignored. This loses the user's intent — they quoted specific words for a reason.

**What we want:** `buildReplyContext()` accepts the optional `quote` field (`TextQuote`). When `quote.text` is present, it replaces the full message text in the reply context. The format should clearly indicate it's a quote: `[Reply to User, quoting: "selected text"]` with the quoted text on the `>` line instead of the full message.

- [ ] When user selects text and replies, only the selected quote appears in agent context
- [ ] `buildReplyContext()` accepts a `quote` parameter with the `TextQuote` shape
- [ ] All call sites pass `ctx.message.quote` to `buildReplyContext()`
- [ ] Full message text is still shown when no quote is present (backward compatible)
- [ ] Quote text is truncated at the same limit as regular reply text
- [ ] Tests for reply with quote vs without quote
- [ ] Tests for quote truncation
- [ ] Verify existing tests pass

### Task 3: Fix /reset message to accurately describe behavior (bot-yve, P3)

**Problem:** After `/reset`, the bot says "Session reset. Next message starts a fresh conversation." This is misleading — the session file with compacted history persists on disk. When the next message arrives, Claude resumes from the session file and retains prior context through the compaction summary. Users expect a clean slate but get context carryover.

**What we want:** The `/reset` response message accurately describes what happens. Something like: "Session restarted. Prior context may be partially retained." Also update the Discord `/reset` handler (discord-bot.ts) with the same corrected message. Document the actual session lifecycle (create → compact → reset → resume) in a code comment near the `/reset` handler so future developers understand the behavior.

- [ ] `/reset` response in Telegram accurately describes that context may be retained
- [ ] `/reset` response in Discord matches the Telegram message
- [ ] Code comment near `/reset` handler explains session lifecycle (create/compact/reset/resume)
- [ ] Verify existing tests pass
