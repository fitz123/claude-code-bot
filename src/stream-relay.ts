import type { Context } from "grammy";
import type { StreamLine } from "./types.js";
import { extractTextDelta, extractAssistantText, extractResultText } from "./cli-protocol.js";

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
  const delta = extractTextDelta(msg);
  if (delta !== null) {
    return { text: delta, isFinal: false };
  }

  const assistantText = extractAssistantText(msg);
  if (assistantText !== null) {
    return { text: assistantText, isFinal: false };
  }

  const resultText = extractResultText(msg);
  if (resultText !== null) {
    return { text: resultText, isFinal: true };
  }

  if (msg.type === "result") {
    return { text: null, isFinal: true };
  }

  return { text: null, isFinal: false };
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
    } catch {
      // Edit can fail if text hasn't changed - ignore
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
    for await (const msg of stream) {
      const { text, isFinal } = extractText(msg);

      if (text !== null) {
        accumulated += text;
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

    // Clean up pending edit timer
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }

    finalSent = true;

    // Send final version
    if (!accumulated) return;

    const chunks = splitMessage(accumulated);

    if (sentMessageId !== null && chunks.length >= 1) {
      // Edit the first message to final text
      try {
        await ctx.api.editMessageText(chatId, sentMessageId, chunks[0]);
      } catch {
        // May fail if text unchanged
      }

      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(chunks[i], {
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
      }
    } else if (sentMessageId === null && accumulated) {
      // Never sent an initial message (shouldn't happen, but handle it)
      for (const chunk of chunks) {
        await ctx.reply(chunk, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
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
