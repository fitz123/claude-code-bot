/**
 * Converts markdown text to Telegram-compatible HTML.
 * Handles: bold, italic, strikethrough, inline code, fenced code blocks, links.
 * Falls back gracefully — only converts patterns it recognizes.
 */

/** Escape HTML special characters (<, >, &, "). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert markdown links [text](url) to HTML, handling nested parentheses. */
function convertLinks(text: string): string {
  const linkStart = /\[([^\]]+)\]\(/g;
  let result = "";
  let lastIndex = 0;
  let match;

  while ((match = linkStart.exec(text)) !== null) {
    const linkText = match[1];
    const urlStart = match.index + match[0].length;

    // Find the balanced closing parenthesis
    let depth = 1;
    let pos = urlStart;
    while (pos < text.length && depth > 0) {
      if (text[pos] === "(") depth++;
      else if (text[pos] === ")") depth--;
      pos++;
    }

    if (depth !== 0) continue; // unbalanced — skip

    const url = text.slice(urlStart, pos - 1);

    // Only convert http/https URLs without whitespace
    if (!/^https?:\/\/\S+$/.test(url)) continue;

    result += text.slice(lastIndex, match.index);
    result += `<a href="${url}">${linkText}</a>`;
    lastIndex = pos;
    linkStart.lastIndex = pos;
  }

  result += text.slice(lastIndex);
  return result;
}

/** Convert inline markdown (bold, italic, code, links) to HTML. */
function convertInline(text: string): string {
  // Step 1: Extract inline code spans to protect their content from further conversion
  const codeSpans: string[] = [];
  let processed = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const i = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE${i}\x00`;
  });

  // Step 2: Escape HTML in remaining text
  processed = escapeHtml(processed);

  // Step 3: Convert markdown patterns (order matters — bold+italic before bold before italic)
  // Bold+Italic: ***text*** (must come before bold to avoid overlapping tags)
  processed = processed.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  // Bold: **text**
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic: *text* (single asterisks only, after bold is already consumed)
  processed = processed.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Links: [text](url) — only http/https URLs, handles nested parentheses
  processed = convertLinks(processed);

  // Step 4: Restore inline code spans
  processed = processed.replace(/\x00CODE(\d+)\x00/g, (_, i: string) => codeSpans[Number(i)]);

  return processed;
}

/**
 * Convert markdown to Telegram-compatible HTML.
 *
 * Splits on fenced code blocks first, then converts inline markdown in
 * the non-code segments. HTML special characters are escaped everywhere.
 */
export function markdownToHtml(md: string): string {
  const codeBlockRe = /```([^\n]*)\n([\s\S]*?)```/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(md)) !== null) {
    // Convert text before the code block
    result += convertInline(md.slice(lastIndex, match.index));

    // Convert the code block itself
    const lang = escapeHtml(match[1].trim());
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    result += lang
      ? `<pre><code class="language-${lang}">${code}</code></pre>`
      : `<pre>${code}</pre>`;

    lastIndex = match.index + match[0].length;
  }

  // Convert remaining text after last code block
  result += convertInline(md.slice(lastIndex));
  return result;
}
