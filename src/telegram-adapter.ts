import { type Context, InputFile } from "grammy";
import type { PlatformContext, TelegramBinding } from "./types.js";
import { markdownToHtml } from "./markdown-html.js";
import { setThread } from "./message-thread-cache.js";

/** Telegram platform constants. */
const TELEGRAM_MAX_MSG_LENGTH = 4096;
const TELEGRAM_EDIT_DEBOUNCE_MS = 2000;
const TELEGRAM_TYPING_INTERVAL_MS = 4000;

/**
 * Wraps a grammy Context into a platform-agnostic PlatformContext.
 * Handles Telegram-specific message threading (message_thread_id) and
 * maps message IDs to strings for the generic interface.
 */
export function createTelegramAdapter(
  ctx: Context,
  binding?: TelegramBinding,
  threadIdOverride?: number,
): PlatformContext {
  const chatId = ctx.chat?.id;
  const threadId = threadIdOverride ?? ctx.message?.message_thread_id;
  const threadOpts = threadId != null ? { message_thread_id: threadId } : {};

  return {
    maxMessageLength: TELEGRAM_MAX_MSG_LENGTH,
    editDebounceMs: TELEGRAM_EDIT_DEBOUNCE_MS,
    typingIntervalMs: TELEGRAM_TYPING_INTERVAL_MS,
    streamingUpdates: binding?.streamingUpdates !== false,
    typingIndicator: binding?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      const html = markdownToHtml(text);
      try {
        const sent = await ctx.reply(html, { ...threadOpts, parse_mode: "HTML" });
        if (chatId != null && threadId != null) setThread(chatId, sent.message_id, threadId);
        return String(sent.message_id);
      } catch (err) {
        // Only fall back to plain text for HTML parse errors; re-throw everything else
        if (err instanceof Error && /can't parse entities|message is too long/.test(err.message)) {
          const sent = await ctx.reply(text, { ...threadOpts });
          if (chatId != null && threadId != null) setThread(chatId, sent.message_id, threadId);
          return String(sent.message_id);
        }
        throw err;
      }
    },

    async editMessage(messageId: string, text: string): Promise<void> {
      if (!chatId) return;
      const html = markdownToHtml(text);
      try {
        await ctx.api.editMessageText(chatId, Number(messageId), html, { parse_mode: "HTML" });
      } catch (err) {
        // Only fall back to plain text for HTML parse errors; re-throw everything else
        if (err instanceof Error && /can't parse entities|message is too long/.test(err.message)) {
          await ctx.api.editMessageText(chatId, Number(messageId), text);
          return;
        }
        throw err;
      }
    },

    async sendTyping(): Promise<void> {
      if (!chatId) return;
      await ctx.api.sendChatAction(
        chatId,
        "typing",
        threadId != null ? { message_thread_id: threadId } : undefined,
      );
    },

    async sendFile(filePath: string, isImage: boolean): Promise<void> {
      if (isImage) {
        await ctx.replyWithPhoto(new InputFile(filePath), threadOpts);
      } else {
        await ctx.replyWithDocument(new InputFile(filePath), threadOpts);
      }
    },

    async replyError(text: string): Promise<void> {
      await ctx.reply(text, { ...threadOpts });
    },
  };
}
