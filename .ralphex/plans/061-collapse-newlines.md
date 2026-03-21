# Collapse Excessive Newlines in Stream Relay — Round 1

## Goal

Fix excessive empty lines in Telegram messages caused by multiple consecutive tool calls inserting redundant `\n\n` separators between text blocks.

## Validation Commands

```bash
cd bot && npx tsc --noEmit && npm test
```

## Reference: newline insertion logic

`bot/src/stream-relay.ts:196-216`:

```typescript
if (msg.type === "stream_event") {
  const ev = msg.event as Record<string, unknown>;
  if (ev.type === "content_block_start") {
    const block = ev.content_block as Record<string, unknown> | undefined;
    if (block?.type && block.type !== "text") {
      sawNonTextBlock = true;
    }
  }
}

const { text, isFinal } = extractText(msg);

if (text !== null) {
  // Insert paragraph break when text resumes after a tool-use block
  if (sawNonTextBlock) {
    if (accumulated.length > 0 && !accumulated.endsWith("\n\n")) {
      accumulated += accumulated.endsWith("\n") ? "\n" : "\n\n";
    }
    sawNonTextBlock = false;
  }
  accumulated += text;
}
```

Each tool-use block sets `sawNonTextBlock = true`. When text resumes, `\n` or `\n\n` is appended. But the agent's text often already ends with `\n`, and the next text delta may start with `\n`, producing 3-4+ consecutive newlines.

## Reference: final send path

`bot/src/stream-relay.ts:282-284`:

```typescript
// Send final text version
if (accumulated) {
  const chunks = splitMessage(accumulated, platform.maxMessageLength);
```

No newline normalization occurs before `splitMessage` or final delivery.

## Reference: user evidence

Screenshot shows ~4 empty line gaps between paragraphs in a Telegram message where the agent used browser tools extensively. Multiple consecutive tool calls (browser_snapshot, browser_click, browser_take_screenshot) each trigger the `sawNonTextBlock` → `\n\n` insertion, producing `\n\n\n\n` or more between text segments.

## Tasks

### Task 1: Normalize consecutive newlines before final send (#61, P1)

Multiple tool calls between text blocks produce 3+ consecutive newlines in `accumulated` text. Telegram renders these as large empty gaps between paragraphs. User reported this with screenshot evidence.

Evidence: `stream-relay.ts:211-212` inserts `\n`/`\n\n` after every tool-use block. When agent text already ends with `\n` and next text starts with `\n`, the result is `\n\n\n` or more. No normalization happens at `stream-relay.ts:283` before `splitMessage`.

Desired: consecutive newlines (3+) are collapsed to exactly `\n\n` before the message is sent. Single `\n` (line breaks) and `\n\n` (paragraph breaks) are preserved. The fix applies to the final accumulated text before splitting and sending.

- [ ] Messages with multiple consecutive tool calls between text blocks have at most one empty line between paragraphs (no `\n\n\n` or more in delivered text)
- [ ] Single newlines within paragraphs are preserved
- [ ] Double newlines (paragraph breaks) are preserved
- [ ] Normalization applies to both streaming edits and final send
- [ ] Add tests: text with `\n\n\n\n` between paragraphs is collapsed to `\n\n`
- [ ] Add tests: `\n\n` is not collapsed further
- [ ] Add tests: single `\n` is not affected
- [ ] Verify existing tests pass
