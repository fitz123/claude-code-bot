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

/** Check if a line is a markdown table separator (e.g. |---|---| or | :---: | :--- |). */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  // Must contain both | and --- ; must consist entirely of |, -, :, and whitespace
  return trimmed.includes("|") && /---/.test(trimmed) && /^[\s|:\-]+$/.test(trimmed);
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
 * Convert markdown tables to <pre> blocks, then apply inline conversion to non-table text.
 * A table is: a header row (contains |), a separator row (only |, -, :, spaces with ---),
 * and zero or more body rows (contain |).
 */
function convertSegment(text: string): string {
  const lines = text.split("\n");
  const inTable: boolean[] = new Array(lines.length).fill(false);

  // Find separator lines and mark table boundaries
  for (let i = 0; i < lines.length; i++) {
    if (!isTableSeparator(lines[i])) continue;
    // Need a header row immediately above
    if (i === 0 || !lines[i - 1].includes("|")) continue;

    // Mark header row (directly above separator)
    inTable[i - 1] = true;
    // Mark separator
    inTable[i] = true;
    // Expand downward for body rows
    let down = i + 1;
    while (down < lines.length && lines[down].includes("|")) {
      inTable[down] = true;
      down++;
    }
  }

  // Fast path: no tables found
  if (!inTable.includes(true)) {
    return convertInline(text);
  }

  // Build output: group consecutive table/non-table lines
  let result = "";
  let i = 0;
  let firstGroup = true;
  while (i < lines.length) {
    if (!firstGroup) result += "\n";
    firstGroup = false;

    if (inTable[i]) {
      const tableLines: string[] = [];
      while (i < lines.length && inTable[i]) {
        tableLines.push(lines[i]);
        i++;
      }
      result += `<pre>${escapeHtml(tableLines.join("\n"))}</pre>`;
    } else {
      const textLines: string[] = [];
      while (i < lines.length && !inTable[i]) {
        textLines.push(lines[i]);
        i++;
      }
      result += convertInline(textLines.join("\n"));
    }
  }

  return result;
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
    // Convert text before the code block (tables → <pre>, then inline)
    result += convertSegment(md.slice(lastIndex, match.index));

    // Convert the code block itself
    const lang = escapeHtml(match[1].trim());
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    result += lang
      ? `<pre><code class="language-${lang}">${code}</code></pre>`
      : `<pre>${code}</pre>`;

    lastIndex = match.index + match[0].length;
  }

  // Convert remaining text after last code block (tables → <pre>, then inline)
  result += convertSegment(md.slice(lastIndex));
  return result;
}
