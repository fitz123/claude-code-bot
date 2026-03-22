import type { Message } from "discord.js";
import type { PlatformContext, DiscordBinding, SessionDefaults } from "./types.js";

/** Discord platform constants. */
const DISCORD_MAX_MSG_LENGTH = 2000;
const DISCORD_EDIT_DEBOUNCE_MS = 2000;
const DISCORD_TYPING_INTERVAL_MS = 9000;

/** Minimal channel interface for Discord message I/O. */
export interface DiscordSendableChannel {
  send(options: string | { content?: string; files?: Array<{ attachment: string }> }): Promise<Message>;
  sendTyping(): Promise<void>;
}

/**
 * Wraps a Discord channel into a platform-agnostic PlatformContext.
 * Tracks sent messages internally so they can be edited by ID.
 */
export function createDiscordAdapter(
  channel: DiscordSendableChannel,
  binding?: DiscordBinding,
  sessionDefaults?: SessionDefaults,
): PlatformContext {
  const sentMessages = new Map<string, Message>();

  return {
    maxMessageLength: DISCORD_MAX_MSG_LENGTH,
    editDebounceMs: DISCORD_EDIT_DEBOUNCE_MS,
    typingIntervalMs: DISCORD_TYPING_INTERVAL_MS,
    streamingUpdates: binding?.streamingUpdates ?? sessionDefaults?.streamingUpdates ?? false,
    typingIndicator: binding?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      const msg = await channel.send(text);
      sentMessages.set(msg.id, msg);
      return msg.id;
    },

    async editMessage(messageId: string, text: string): Promise<void> {
      const msg = sentMessages.get(messageId);
      if (msg) {
        const edited = await msg.edit(text);
        sentMessages.set(messageId, edited);
      }
    },

    async deleteMessage(messageId: string): Promise<void> {
      const msg = sentMessages.get(messageId);
      if (msg) {
        await msg.delete();
        sentMessages.delete(messageId);
      }
    },

    async sendTyping(): Promise<void> {
      await channel.sendTyping();
    },

    async sendFile(filePath: string, _isImage: boolean): Promise<void> {
      await channel.send({ files: [{ attachment: filePath }] });
    },

    async replyError(text: string): Promise<void> {
      await channel.send(text);
    },
  };
}
