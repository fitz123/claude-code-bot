import { type Context, InputFile } from "grammy";
import type { PlatformContext, SessionDefaults, TelegramBinding } from "./types.js";
import { markdownToHtml } from "./markdown-html.js";
import { setThread } from "./message-thread-cache.js";
import { recordMessage } from "./message-content-index.js";

/** Telegram platform constants. */
const TELEGRAM_MAX_MSG_LENGTH = 4096;
const TELEGRAM_TYPING_INTERVAL_MS = 5000;

/** Bot username for outgoing message recording. Set at startup via setBotUsername(). */
let _botUsername = "bot";

/** Set the bot's username for outgoing message index recording. */
export function setBotUsername(username: string): void {
  _botUsername = username;
}

/**
 * Wraps a grammy Context into a platform-agnostic PlatformContext.
 * Handles Telegram-specific message threading (message_thread_id) and
 * maps message IDs to strings for the generic interface.
 */
export function createTelegramAdapter(
  ctx: Context,
  binding?: TelegramBinding,
  threadIdOverride?: number,
  sessionDefaults?: SessionDefaults,
): PlatformContext {
  const chatId = ctx.chat?.id;
  const threadId = threadIdOverride ?? ctx.message?.message_thread_id;
  const threadOpts = threadId != null ? { message_thread_id: threadId } : {};

  const isDm = binding?.kind === "dm";

  return {
    maxMessageLength: TELEGRAM_MAX_MSG_LENGTH,
    typingIntervalMs: TELEGRAM_TYPING_INTERVAL_MS,
    typingIndicator: binding?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      const html = markdownToHtml(text);
      try {
        const sent = await ctx.reply(html, { ...threadOpts, parse_mode: "HTML" });
        if (chatId != null && threadId != null) setThread(chatId, sent.message_id, threadId);
        if (chatId != null) recordMessage(chatId, sent.message_id, `@${_botUsername}`, text, "out");
        return String(sent.message_id);
      } catch (err) {
        // Only fall back to plain text for HTML parse errors; re-throw everything else
        if (err instanceof Error && /can't parse entities|message is too long/.test(err.message)) {
          const sent = await ctx.reply(text, { ...threadOpts });
          if (chatId != null && threadId != null) setThread(chatId, sent.message_id, threadId);
          if (chatId != null) recordMessage(chatId, sent.message_id, `@${_botUsername}`, text, "out");
          return String(sent.message_id);
        }
        throw err;
      }
    },

    async sendDraft(draftId: number, text: string): Promise<void> {
      if (!chatId || !isDm) return;
      const html = markdownToHtml(text);
      try {
        await ctx.api.sendMessageDraft(chatId, draftId, html, {
          parse_mode: "HTML",
          ...threadOpts,
        });
      } catch {
        // Draft failures are cosmetic — silently ignore
      }
    },

    async deleteMessage(messageId: string): Promise<void> {
      if (!chatId) return;
      await ctx.api.deleteMessage(chatId, Number(messageId));
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
      const sent = isImage
        ? await ctx.replyWithPhoto(new InputFile(filePath), threadOpts)
        : await ctx.replyWithDocument(new InputFile(filePath), threadOpts);
      if (chatId != null && threadId != null) setThread(chatId, sent.message_id, threadId);
      if (chatId != null) recordMessage(chatId, sent.message_id, `@${_botUsername}`, isImage ? "[photo]" : "[file]", "out");
    },

    async replyError(text: string): Promise<void> {
      const sent = await ctx.reply(text, { ...threadOpts });
      if (chatId != null && threadId != null) setThread(chatId, sent.message_id, threadId);
      if (chatId != null) recordMessage(chatId, sent.message_id, `@${_botUsername}`, text, "out");
    },
  };
}
