import { realpathSync } from "node:fs";
import { type Context, InputFile } from "grammy";
import type { StreamLine } from "./types.js";
import { extractTextDelta } from "./cli-protocol.js";
import { log } from "./logger.js";
import { messagesSent } from "./metrics.js";

/** Maximum Telegram message length. */
const MAX_MSG_LENGTH = 4096;

/** Minimum interval between editMessageText calls (ms). */
const EDIT_DEBOUNCE_MS = 2000;

/** Typing action resend interval (ms). */
const TYPING_INTERVAL_MS = 4000;

/**
 * Split text into chunks that fit Telegram's message limit.
 * Splits at paragraph boundaries (\n\n) when possible, otherwise at newlines, otherwise hard-cut.
 */
export function splitMessage(text: string, maxLen: number = MAX_MSG_LENGTH): string[] {
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
    if (splitIdx <= 0) {
      // Try newline
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx <= 0) {
      // Hard cut at space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx <= 0) {
      // Hard cut
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
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

/** Image extensions that Telegram can display inline via replyWithPhoto. */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Check if a file path has an image extension suitable for replyWithPhoto. */
export function isImageExtension(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase());
}

/**
 * Scan a stream line for Write tool_use blocks and collect file paths.
 * AssistantMessage snapshots repeat with --include-partial-messages,
 * so paths are collected into a Set for deduplication.
 */
export function collectWritePaths(msg: StreamLine, paths: Set<string>): void {
  if (msg.type !== "assistant" || msg.subtype !== undefined) return;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (
      block.type === "tool_use" &&
      (block as Record<string, unknown>).name === "Write"
    ) {
      const input = (block as Record<string, unknown>).input as
        | Record<string, unknown>
        | undefined;
      const filePath = input?.file_path;
      if (typeof filePath === "string") {
        paths.add(filePath);
      }
    }
  }
}

/**
 * Relay Claude CLI stream output to a Telegram chat.
 *
 * Strategy (since @grammyjs/stream is unavailable):
 * 1. Send initial message with first text chunk
 * 2. Accumulate streaming deltas
 * 3. editMessageText every EDIT_DEBOUNCE_MS with accumulated text
 * 4. On completion, send final version
 * 5. If text exceeds 4096 chars, finish current message and send continuation
 */
export async function relayStream(
  stream: AsyncGenerator<StreamLine>,
  ctx: Context,
  workspaceCwd?: string,
): Promise<void> {
  let accumulated = "";
  let sentMessageId: number | null = null;
  let lastEditTime = 0;
  let editPending = false;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let finalSent = false;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  const writtenFiles = new Set<string>();

  if (!chatId) return;

  // Send typing indicator periodically
  typingTimer = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing", threadId ? { message_thread_id: threadId } : undefined).catch(() => {});
  }, TYPING_INTERVAL_MS);

  // Send initial typing
  await ctx.api.sendChatAction(chatId, "typing", threadId ? { message_thread_id: threadId } : undefined).catch(() => {});

  const doEdit = async () => {
    if (!sentMessageId || !accumulated || finalSent) return;
    editPending = false;

    // Truncate to Telegram limit for in-progress updates
    const displayText = accumulated.length > MAX_MSG_LENGTH
      ? accumulated.slice(0, MAX_MSG_LENGTH - 3) + "..."
      : accumulated;

    try {
      await ctx.api.editMessageText(chatId, sentMessageId, displayText);
      lastEditTime = Date.now();
    } catch (err) {
      // Streaming edit failure is cosmetic — next edit or final edit will update
      log.debug("stream-relay", `Streaming edit failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const scheduleEdit = () => {
    if (editPending || finalSent) return;
    const elapsed = Date.now() - lastEditTime;
    if (elapsed >= EDIT_DEBOUNCE_MS) {
      editPending = true;
      doEdit();
    } else {
      editPending = true;
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(doEdit, EDIT_DEBOUNCE_MS - elapsed);
    }
  };

  try {
    let resultText: string | null = null;

    for await (const msg of stream) {
      const { text, isFinal } = extractText(msg);

      if (text !== null) {
        accumulated += text;
      }

      // Collect file paths from Write tool_use events
      if (false && workspaceCwd) { // DISABLED: auto-sends all written files, needs redesign
        collectWritePaths(msg, writtenFiles);
      }

      // Track result text as fallback when no streaming deltas arrive
      if (msg.type === "result" && msg.result) {
        resultText = msg.result;
      }

      // Send initial message once we have text
      if (accumulated && sentMessageId === null) {
        const displayText = accumulated.length > MAX_MSG_LENGTH
          ? accumulated.slice(0, MAX_MSG_LENGTH - 3) + "..."
          : accumulated;
        const sent = await ctx.reply(displayText, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
        sentMessageId = sent.message_id;
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

    // Send final text version
    if (accumulated) {
      const chunks = splitMessage(accumulated);

      if (sentMessageId !== null && chunks.length >= 1) {
        // Edit the first message to final text
        try {
          await ctx.api.editMessageText(chatId, sentMessageId, chunks[0]);
        } catch (err) {
          // "Message is not modified" means text already matches — safe to ignore.
          // Any other error (429, network, etc.) means the user may see truncated text.
          // Fall back to sending the complete text as a new message.
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("not modified")) {
            log.warn("stream-relay", `Final edit failed, sending as new message: ${msg}`);
            try {
              await ctx.reply(chunks[0], {
                ...(threadId ? { message_thread_id: threadId } : {}),
              });
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
          await ctx.reply(chunks[i], {
            ...(threadId ? { message_thread_id: threadId } : {}),
          });
          messagesSent.inc();
        }
      } else if (sentMessageId === null) {
        // Never sent an initial message (shouldn't happen, but handle it)
        for (const chunk of chunks) {
          await ctx.reply(chunk, {
            ...(threadId ? { message_thread_id: threadId } : {}),
          });
          messagesSent.inc();
        }
      }
    }

    // Send any files created by Claude's Write tool
    if (workspaceCwd && writtenFiles.size > 0) {
      for (const filePath of writtenFiles) {
        // Resolve symlinks to prevent path-check bypass (e.g. symlink inside
        // workspace pointing outside it). realpathSync also verifies existence.
        let realPath: string;
        try {
          realPath = realpathSync(filePath);
        } catch {
          continue; // File doesn't exist or is inaccessible
        }
        if (!realPath.startsWith(workspaceCwd + "/") && !realPath.startsWith("/tmp/") && !realPath.startsWith("/private/tmp/")) continue;

        try {
          const opts = threadId ? { message_thread_id: threadId } : {};
          if (isImageExtension(realPath)) {
            await ctx.replyWithPhoto(new InputFile(realPath), opts);
          } else {
            await ctx.replyWithDocument(new InputFile(realPath), opts);
          }
        } catch (err) {
          log.error("stream-relay", `Failed to send file ${filePath}:`, err);
        }
      }
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
