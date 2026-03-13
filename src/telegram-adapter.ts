import { type Context, InputFile } from "grammy";
import type { PlatformContext, TelegramBinding } from "./types.js";

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
): PlatformContext {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  const threadOpts = threadId ? { message_thread_id: threadId } : {};

  return {
    maxMessageLength: TELEGRAM_MAX_MSG_LENGTH,
    editDebounceMs: TELEGRAM_EDIT_DEBOUNCE_MS,
    typingIntervalMs: TELEGRAM_TYPING_INTERVAL_MS,
    streamingUpdates: binding?.streamingUpdates !== false,
    typingIndicator: binding?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      const sent = await ctx.reply(text, { ...threadOpts });
      return String(sent.message_id);
    },

    async editMessage(messageId: string, text: string): Promise<void> {
      if (!chatId) return;
      await ctx.api.editMessageText(chatId, Number(messageId), text);
    },

    async sendTyping(): Promise<void> {
      if (!chatId) return;
      await ctx.api.sendChatAction(
        chatId,
        "typing",
        threadId ? { message_thread_id: threadId } : undefined,
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
