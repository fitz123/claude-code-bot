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

/**
 * Relay Claude CLI stream output to a chat using the platform-agnostic interface.
 *
 * Strategy:
 * 1. Send initial message with first text chunk
 * 2. Accumulate streaming deltas
 * 3. editMessage every editDebounceMs with accumulated text (if streamingUpdates enabled)
 * 4. On completion, send final version
 * 5. If text exceeds maxMessageLength, finish current message and send continuation
 *
 * When streamingUpdates is false, no intermediate edits are sent — only the final message.
 * When typingIndicator is false, no typing actions are sent.
 */
export async function relayStream(
  stream: AsyncGenerator<StreamLine>,
  platform: PlatformContext,
  outboxPath?: string,
): Promise<void> {
  let accumulated = "";
  let sentMessageId: string | null = null;
  let lastEditTime = 0;
  let editPending = false;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let finalSent = false;
  let sawNonTextBlock = false;

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

  const doEdit = async () => {
    if (!sentMessageId || !accumulated || finalSent) return;
    editPending = false;

    // Truncate to platform limit for in-progress updates
    const displayText = accumulated.length > platform.maxMessageLength
      ? accumulated.slice(0, platform.maxMessageLength - 3) + "..."
      : accumulated;

    try {
      await platform.editMessage(sentMessageId, displayText);
      lastEditTime = Date.now();
    } catch (err) {
      // Streaming edit failure is cosmetic — next edit or final edit will update
      log.debug("stream-relay", `Streaming edit failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const scheduleEdit = () => {
    if (editPending || finalSent || !platform.streamingUpdates) return;
    const elapsed = Date.now() - lastEditTime;
    if (elapsed >= platform.editDebounceMs) {
      editPending = true;
      doEdit().catch(() => {});
    } else {
      editPending = true;
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(doEdit, platform.editDebounceMs - elapsed);
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
      }

      // Track result text as fallback when no streaming deltas arrive
      if (msg.type === "result" && msg.result) {
        resultText = msg.result;
      }

      // Send initial message once we have text (only if streaming is enabled)
      if (accumulated && sentMessageId === null && platform.streamingUpdates) {
        const displayText = accumulated.length > platform.maxMessageLength
          ? accumulated.slice(0, platform.maxMessageLength - 3) + "..."
          : accumulated;
        sentMessageId = await platform.sendMessage(displayText);
        lastEditTime = Date.now();
        messagesSent.inc();
        continue;
      }

      // Schedule debounced edit for streaming updates
      if (text !== null && sentMessageId !== null && !isFinal) {
        scheduleEdit();
      }

      // On final message, do the last edit and handle overflow
      if (isFinal) {
        break;
      }
    }

    // Fallback: if no streaming deltas arrived but result contains text,
    // use it (handles edge case where protocol sends no text_delta events)
    if (!accumulated && resultText) {
      accumulated = resultText;
    }

    // Clean up pending edit timer
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }

    finalSent = true;

    // NO_REPLY: agent explicitly signals "no response needed" — suppress delivery
    const trimmed = accumulated?.trim() ?? "";
    if (trimmed !== "NO_REPLY" && trimmed.length < 30) {
      process.stderr.write(`[stream-relay] DEBUG final text (${trimmed.length} chars): ${JSON.stringify(trimmed)}\n`);
    }
    if (accumulated && trimmed === "NO_REPLY") {
      if (sentMessageId !== null) {
        // Delete the streaming message that was already sent
        try {
          await platform.deleteMessage(sentMessageId);
        } catch {
          // best-effort: message may already be gone
        }
      }
      return;
    }

    // Send final text version
    if (accumulated) {
      const chunks = splitMessage(accumulated, platform.maxMessageLength);

      if (sentMessageId !== null && chunks.length >= 1) {
        // Edit the first message to final text
        try {
          await platform.editMessage(sentMessageId, chunks[0]);
        } catch (err) {
          // "Message is not modified" means text already matches — safe to ignore.
          // Any other error (429, network, etc.) means the user may see truncated text.
          // Fall back to sending the complete text as a new message.
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("not modified")) {
            log.warn("stream-relay", `Final edit failed, sending as new message: ${msg}`);
            try {
              sentMessageId = await platform.sendMessage(chunks[0]);
              messagesSent.inc();
            } catch (fallbackErr) {
              log.error("stream-relay", `Fallback reply also failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`);
              // If we can't send chunks[0] at all, skip remaining chunks —
              // the API is clearly failing and partial output missing the
              // beginning would be confusing.
              return;
            }
          }
        }

        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          await platform.sendMessage(chunks[i]);
          messagesSent.inc();
        }
      } else if (sentMessageId === null) {
        // No initial message was sent (streaming disabled or no text during streaming)
        for (const chunk of chunks) {
          await platform.sendMessage(chunk);
          messagesSent.inc();
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
    if (editTimer) {
      clearTimeout(editTimer);
    }
  }
}
