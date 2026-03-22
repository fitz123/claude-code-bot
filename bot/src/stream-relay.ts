import { readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { StreamLine, PlatformContext } from "./types.js";
import { extractTextDelta } from "./cli-protocol.js";
import { log } from "./logger.js";
import { messagesSent } from "./metrics.js";

/**
 * Split text into chunks that fit a platform's message limit.
 * Splits at paragraph boundaries (\n\n) when possible, otherwise at newlines, otherwise hard-cut.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    let skipChars = 2; // skip the \n\n boundary
    if (splitIdx > 0) {
      // Walk back to the start of the newline run so the chunk
      // doesn't end with a stray \n from an overlapping match.
      while (splitIdx > 0 && remaining[splitIdx - 1] === "\n") {
        splitIdx--;
      }
    }
    if (splitIdx <= 0) {
      // Try newline
      splitIdx = remaining.lastIndexOf("\n", maxLen);
      skipChars = 1; // skip the \n boundary
    }
    if (splitIdx <= 0) {
      // Hard cut at space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
      skipChars = 1; // skip the space
    }
    if (splitIdx <= 0) {
      // Hard cut
      splitIdx = maxLen;
      skipChars = 0;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx + skipChars);
  }

  return chunks;
}

/**
 * Collapse runs of 3+ consecutive newlines down to exactly 2 (\n\n).
 * Preserves single newlines (line breaks) and double newlines (paragraph breaks).
 */
export function collapseNewlines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Extract text content from a stream line.
 * Returns text delta for streaming events, full text for assistant/result messages.
 */
export function extractText(msg: StreamLine): { text: string | null; isFinal: boolean } {
  // Only accumulate text from streaming deltas.
  // Assistant message snapshots and result messages repeat the same text
  // that was already delivered via text_delta events, so extracting text
  // from them would cause duplicate/triple output.
  const delta = extractTextDelta(msg);
  if (delta !== null) {
    return { text: delta, isFinal: false };
  }

  if (msg.type === "result") {
    return { text: null, isFinal: true };
  }

  return { text: null, isFinal: false };
}

/** Image extensions that can be displayed inline. */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Check if a file path has an image extension suitable for inline display. */
export function isImageExtension(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase());
}

/**
 * Scan the outbox directory for files and send each via the platform adapter.
 * After sending, files are removed from the outbox.
 */
export async function sendOutboxFiles(outboxPath: string, platform: PlatformContext): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(outboxPath);
  } catch {
    return; // Directory doesn't exist or isn't readable
  }

  for (const name of entries) {
    const filePath = join(outboxPath, name);
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile()) continue;
      await platform.sendFile(filePath, isImageExtension(filePath));
      // Delete only after successful send
      try { unlinkSync(filePath); } catch { /* ignore cleanup errors */ }
    } catch (err) {
      log.error("stream-relay", `Failed to send outbox file ${name}:`, err);
    }
  }
}

/** Debounce interval for draft updates (ms). Drafts are cosmetic — no rate limits. */
const DRAFT_DEBOUNCE_MS = 300;

/**
 * Relay Claude CLI stream output to a chat using the platform-agnostic interface.
 *
 * Strategy:
 * 1. Accumulate streaming text deltas
 * 2. Send draft updates via sendDraft (debounced, cosmetic, fire-and-forget)
 * 3. On completion, sendMessage with final text (guaranteed delivery)
 * 4. If text exceeds maxMessageLength, send continuation chunks via sendMessage
 *
 * Drafts auto-disappear when sendMessage is called (or when the response is suppressed).
 * When typingIndicator is false, no typing actions are sent.
 */
export async function relayStream(
  stream: AsyncGenerator<StreamLine>,
  platform: PlatformContext,
  outboxPath?: string,
): Promise<void> {
  let accumulated = "";
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDraftTime = 0;
  let lastDraftPromise: Promise<void> = Promise.resolve();
  let sawNonTextBlock = false;

  // Generate a stable draft_id for this entire response
  const draftId = Math.floor(Math.random() * 2147483647) + 1;

  // Take over pre-stream typing if active (clean handoff from message queue)
  if (platform.preStreamTypingTimer) {
    clearInterval(platform.preStreamTypingTimer);
    platform.preStreamTypingTimer = undefined;
  }

  // Send typing indicator periodically (if enabled)
  if (platform.typingIndicator) {
    typingTimer = setInterval(() => {
      platform.sendTyping().catch(() => {});
    }, platform.typingIntervalMs);

    // Send initial typing
    await platform.sendTyping().catch(() => {});
  }

  /** Send a draft update with the current accumulated text. Fire-and-forget. */
  const sendDraftNow = () => {
    if (!accumulated) return;
    const collapsed = collapseNewlines(accumulated);
    const displayText = collapsed.length > platform.maxMessageLength
      ? collapsed.slice(0, platform.maxMessageLength - 3) + "..."
      : collapsed;
    lastDraftPromise = platform.sendDraft(draftId, displayText).catch(() => {});
    lastDraftTime = Date.now();
  };

  /** Schedule a debounced draft update. */
  const scheduleDraft = () => {
    if (draftTimer) return;
    const elapsed = Date.now() - lastDraftTime;
    if (elapsed >= DRAFT_DEBOUNCE_MS) {
      sendDraftNow();
    } else {
      draftTimer = setTimeout(() => {
        draftTimer = null;
        sendDraftNow();
      }, DRAFT_DEBOUNCE_MS - elapsed);
    }
  };

  try {
    let resultText: string | null = null;

    for await (const msg of stream) {
      // Detect non-text content blocks (tool_use, etc.) so we can insert a
      // paragraph break when the next text block starts.  Without this,
      // "plan:" + [Edit tool] + "Done!" would become "plan:Done!".
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

        // Send draft update (debounced, cosmetic)
        if (!isFinal) {
          scheduleDraft();
        }
      }

      // Track result text as fallback when no streaming deltas arrive
      if (msg.type === "result" && msg.result) {
        resultText = msg.result;
      }

      if (isFinal) {
        break;
      }
    }

    // Fallback: if no streaming deltas arrived but result contains text,
    // use it (handles edge case where protocol sends no text_delta events)
    if (!accumulated && resultText) {
      accumulated = resultText;
    }

    // Clean up pending draft timer
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }

    // Wait for any in-flight draft to complete before final delivery,
    // so a late-arriving draft can't overwrite the sent message in the composer.
    await lastDraftPromise;

    // NO_REPLY: agent explicitly signals "no response needed" — suppress delivery.
    // Drafts auto-disappear when no sendMessage follows.
    const trimmed = accumulated?.trim() ?? "";
    if (accumulated && trimmed === "NO_REPLY") {
      return;
    }

    // Final delivery: always sendMessage (completes draft in DMs, sends fresh in groups)
    if (accumulated) {
      const chunks = splitMessage(collapseNewlines(accumulated), platform.maxMessageLength);

      for (let i = 0; i < chunks.length; i++) {
        try {
          await platform.sendMessage(chunks[i]);
          messagesSent.inc();
        } catch (err) {
          log.error("stream-relay", `Failed to send message chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : err}`);
          // If the first chunk fails, skip remaining — partial output missing
          // the beginning would be confusing.  Throw so the queue's error
          // handler can attempt to notify the user.
          if (i === 0) throw new Error(`Failed to deliver response: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Send any files Claude placed in the outbox directory
    if (outboxPath) {
      await sendOutboxFiles(outboxPath, platform);
    }
  } finally {
    if (typingTimer) {
      clearInterval(typingTimer);
    }
    if (draftTimer) {
      clearTimeout(draftTimer);
    }
  }
}
