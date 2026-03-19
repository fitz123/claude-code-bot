# Output Formatting

All rendering is handled by the bot's markdown-to-HTML converter. Agents must output **standard markdown only** — never attempt to render or format for a specific platform.

## Rules

- **Tables:** use markdown pipe syntax (`| col | col |`), never ASCII art, Unicode box-drawing, or manual space-padding
- **Emphasis:** use `**bold**` and `*italic*`, not CAPS or manual decoration
- **Lists:** use `- item` or `1. item`, not manual bullet characters (`•`, `▸`)
- **Code:** use backtick fences (` ``` `), not manual indentation for code display
- **Structure:** use headings (`##`), not separator lines (`---`, `===`, `───`)

## What NOT to do

- No `printf '%-20s'` padding for table alignment
- No Unicode box characters (─ │ ┌ ┐ └ ┘ ━ ═) for layout
- No `<pre>`, `<code>`, or any HTML tags in output — the converter handles this
- No MarkdownV2 escaping (`\.` `\!` `\-`) — the bot uses HTML mode
- No attempt to control column widths or text alignment

## Why

The bot converts markdown to HTML for Telegram (`parse_mode: "HTML"`). ASCII art and manual formatting break in proportional fonts. Markdown tables get properly converted to either HTML tables or transposed key:value format for narrow screens.

## Applies to

- All agent text responses (interactive and cron)
- All `deliver.sh` messages
- All skill output instructions in SKILL.md files
