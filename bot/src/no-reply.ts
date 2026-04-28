// Shared NO_REPLY suppression check used by both interactive (stream-relay)
// and one-shot (cron-runner) delivery paths.
//
// Suppress when, on the trimmed output, EITHER:
//   (a) it starts with `NO_REPLY` followed by a word boundary
//       (issue #80 — preserves `NO_REPLY`, `NO_REPLY: reason`, `NO_REPLY\n\n<text>`); OR
//   (b) the last non-empty line, with surrounding whitespace stripped,
//       is exactly `NO_REPLY` (issue #111 — pipeline-style `<summary>\n\nNO_REPLY`).
//
// Same-line patterns like `All clean. NO_REPLY` are intentionally NOT
// suppressed — the token must be alone on its line. Substring tokens like
// `NO_REPLY_EXTRA` are not suppressed at end-of-message because the line
// equality check rejects anything other than exact `NO_REPLY`.

export function shouldSuppressNoReply(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (/^NO_REPLY\b/.test(trimmed)) return true;
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    return line === "NO_REPLY";
  }
  return false;
}
