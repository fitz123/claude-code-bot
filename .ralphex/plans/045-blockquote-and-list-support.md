# Add Blockquote and List Support to Markdown-HTML Converter — Round 1

## Goal

Add two missing markdown features to `bot/src/markdown-html.ts`: blockquote conversion (`>` lines → `<blockquote>`) and list bullet normalization (`- item` → `• item`). Both are cosmetic improvements that make agent output render properly in Telegram instead of passing through as raw markdown syntax.

## Validation Commands

```bash
cd bot && npx tsc --noEmit && node --import tsx --test src/__tests__/markdown-html.test.ts && [ "$(wc -l < src/markdown-html.ts)" -lt 300 ] && echo "Line count OK" || (echo "FAIL: markdown-html.ts exceeds 300 lines" && exit 1)
```

## Reference: Telegram HTML Supported Tags

Telegram `parse_mode: "HTML"` supports these tags (Bot API 2025):
- `<b>`, `<strong>` — bold
- `<i>`, `<em>` — italic
- `<u>`, `<ins>` — underline
- `<s>`, `<strike>`, `<del>` — strikethrough
- `<code>` — inline monospace
- `<pre>`, `<pre><code class="language-X">` — code blocks
- `<a href="URL">` — links
- `<blockquote>` — block quotation (renders with left border)
- `<blockquote expandable>` — collapsible quotation (user taps to expand)
- `<tg-spoiler>` — spoiler

NOT supported: `<ul>`, `<ol>`, `<li>`, `<h1>`-`<h6>`, `<p>`, `<table>`, `<hr>`.

## Reference: Current Converter Architecture (markdown-html.ts, 247 lines)

Processing pipeline:

1. `markdownToHtml()` (line 224) — entry point, splits on fenced code blocks (```` ``` ````)
2. Non-code segments → `convertSegment()` (line 163) — detects/renders tables, then passes non-table text to `convertInline()`
3. `convertInline()` (line 61) — extracts inline code spans, escapes HTML, converts bold/italic/strikethrough/links

Code blocks are extracted first at the top level, so anything inside ``` fences is never touched by `convertSegment()` or `convertInline()`. This means blockquote and list conversion added inside `convertSegment()` will automatically be protected from firing inside code blocks.

## Reference: Current Test Suite

File: `bot/src/__tests__/markdown-html.test.ts` (302 lines, 45 test cases across 14 describe blocks). All tests pass. Test structure uses `node:test` runner with `assert.strictEqual` / `assert.ok`.

## Tasks

### Task 1: Add blockquote support (fitz123/claude-code-bot#45, P2)

Currently `> quoted text` passes through as literal `> quoted text` in Telegram. Telegram supports `<blockquote>` natively — it renders as an indented block with a left border, which is the standard quotation style users expect.

What we want:
- Consecutive `> ` prefixed lines are grouped into a single `<blockquote>` block
- The `> ` prefix is stripped from each line
- Nested blockquotes (`>> `) are NOT required — flatten to single level is fine
- Blockquotes inside fenced code blocks are not converted (already guaranteed by the pipeline architecture)
- Empty `>` lines (no text after `>`) are preserved as empty lines inside the blockquote
- Blockquotes with 5+ lines use `<blockquote expandable>` instead of `<blockquote>` for collapsible display

- [x] `> single line` converts to `<blockquote>single line</blockquote>`
- [x] Consecutive `> ` lines merge into one `<blockquote>` with newlines between them
- [x] Blockquotes with 5+ lines use `<blockquote expandable>` tag
- [x] `> ` inside fenced code blocks is not converted
- [x] Inline markdown inside blockquotes still works (bold, italic, code, links)
- [x] Mixed content: text before/after blockquote renders correctly
- [x] Existing 45 tests still pass
- [x] Add tests covering the above cases

### Task 2: Add list bullet normalization (fitz123/claude-code-bot#45, P2)

Currently `- item` and `* item` pass through as literal text. The dash/asterisk looks like raw markdown rather than a proper bullet. Since Telegram doesn't support `<ul>`/`<ol>`, the fix is text-level: replace the marker character with `•`.

What we want:
- `- item` → `• item` (unordered, dash)
- `* item` → `• item` (unordered, asterisk) — but only at line start, must not conflict with `*italic*`
- Nested lists: `  - nested` → `  • nested` (preserve leading whitespace, just swap the marker)
- Numbered lists (`1. item`) — leave as-is, they already look fine
- Lists inside fenced code blocks are not converted (already guaranteed by the pipeline)
- Lists inside `<pre>` table blocks are not converted

- [x] `- item` at line start converts to `• item`
- [x] `* item` at line start converts to `• item` without breaking italic syntax
- [x] Indented `  - nested` preserves indentation and converts marker
- [x] Numbered lists (`1. text`) pass through unchanged
- [x] Lists inside fenced code blocks are not converted
- [x] Inline markdown in list items works (bold, links, etc.)
- [x] Existing 45 tests still pass
- [x] Converter stays under ~300 lines total
- [x] Add tests covering the above cases
