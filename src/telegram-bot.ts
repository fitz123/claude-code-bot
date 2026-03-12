import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { BotConfig, TelegramBinding } from "./types.js";
import type { SessionManager } from "./session-manager.js";
import { relayStream } from "./stream-relay.js";
import { MessageQueue } from "./message-queue.js";
import { tempFilePath, downloadFile, transcribeAudio, cleanupTempFile } from "./voice.js";

/** Commands to register with the Telegram Bot API via setMyCommands */
export const BOT_COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "reset", description: "Reset current session" },
  { command: "status", description: "Show bot status" },
] as const;

/** Image MIME types supported by Claude vision */
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);

/** Check if a MIME type is a supported image type */
export function isImageMimeType(mimeType: string | undefined): boolean {
  return mimeType !== undefined && SUPPORTED_IMAGE_MIMES.has(mimeType);
}

/** Map image MIME type to file extension */
export function imageExtensionForMime(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/bmp": return ".bmp";
    default: return ".jpg";
  }
}

/**
 * Build a session key from chatId and optional topicId.
 * Returns "chatId" or "chatId:topicId" when topicId is present.
 */
export function sessionKey(chatId: number | string, topicId?: number): string {
  const base = String(chatId);
  return topicId !== undefined ? `${base}:${topicId}` : base;
}

/**
 * Resolve a Telegram chatId (and optional topicId) to its binding config.
 * Bindings with topicId set only match when both chatId and topicId match.
 * A chatId-only binding serves as a fallback when no topic-specific binding matches.
 */
export function resolveBinding(
  chatId: number,
  bindings: TelegramBinding[],
  topicId?: number,
): TelegramBinding | undefined {
  let fallback: TelegramBinding | undefined;
  for (const b of bindings) {
    if (b.chatId !== chatId) continue;
    if (b.topicId !== undefined) {
      if (b.topicId === topicId) return b; // exact topic match wins
    } else {
      fallback ??= b; // chatId-only binding as fallback
    }
  }

  // Check topics array for per-topic overrides
  if (fallback && topicId !== undefined && fallback.topics) {
    const topic = fallback.topics.find((t) => t.topicId === topicId);
    if (topic) {
      const { topics: _, ...base } = fallback;
      return {
        ...base,
        agentId: topic.agentId ?? fallback.agentId,
        requireMention: topic.requireMention ?? fallback.requireMention,
        topicId,
      };
    }
  }

  return fallback;
}

/**
 * Build a source context prefix from binding and sender info.
 * Prepended to every message before enqueuing so Claude knows
 * which chat/topic a message came from and who sent it.
 */
export function buildSourcePrefix(
  binding: TelegramBinding,
  from?: { first_name: string; username?: string },
): string {
  const parts: string[] = [];

  if (binding.label) {
    parts.push(`Chat: ${binding.label}`);
  }

  if (from) {
    const name = from.first_name.replace(/[\n\r]/g, " ");
    const sender = from.username
      ? `${name} (@${from.username.replace(/[\n\r]/g, "")})`
      : name;
    parts.push(`From: ${sender}`);
  }

  return parts.length > 0 ? `[${parts.join(" | ")}]\n` : "";
}

/**
 * Check whether the bot should respond to a message in a group chat.
 * Returns true if the binding is a DM, requireMention is false,
 * or the message is a reply to the bot / @mentions the bot.
 */
export function shouldRespondInGroup(
  binding: TelegramBinding,
  botId: number,
  botUsername: string,
  message: {
    reply_to_message?: { from?: { id: number } };
    text?: string;
    caption?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    caption_entities?: Array<{ type: string; offset: number; length: number }>;
  },
): boolean {
  if (binding.kind !== "group") return true;

  const requireMention = binding.requireMention ?? true;
  if (!requireMention) return true;

  if (message.reply_to_message?.from?.id === botId) return true;

  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const mention = `@${botUsername}`;
  const mentionPattern = new RegExp(`(?<!\\w)@${botUsername}(?![a-zA-Z0-9_])`);
  if (
    mentionPattern.test(text) ||
    entities.some(
      (e) =>
        e.type === "mention" &&
        text.slice(e.offset, e.offset + e.length) === mention,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Check if a chat is authorized based on bindings allowlist.
 */
export function isAuthorized(chatId: number, bindings: TelegramBinding[]): boolean {
  return bindings.some((b) => b.chatId === chatId);
}

export interface TelegramBotResult {
  bot: Bot;
  messageQueue: MessageQueue;
}

/**
 * Create and configure the Telegram bot.
 */
export function createTelegramBot(
  config: BotConfig,
  sessionManager: SessionManager,
): TelegramBotResult {
  const bot = new Bot(config.telegramToken);

  // Auto-retry on rate limits
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  // Message queue: debounce rapid messages and collect mid-turn messages
  const messageQueue = new MessageQueue(
    async (chatId, agentId, text, ctx) => {
      const stream = sessionManager.sendSessionMessage(chatId, agentId, text);
      await relayStream(stream, ctx);
    },
  );

  // Auth middleware: reject unauthorized chats
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    if (!isAuthorized(chatId, config.bindings)) {
      console.log(`[telegram-bot] Rejected message from unauthorized chat ${chatId}`);
      return; // Silent drop
    }

    await next();
  });

  // /start command
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;
    const agent = config.agents[binding.agentId];
    await ctx.reply(
      `Connected to agent "${binding.agentId}" (${agent?.model ?? "unknown"}). Send a message to start.`,
    );
  });

  // /reset command — close current session, next message creates fresh
  bot.command("reset", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const binding = resolveBinding(ctx.chat.id, config.bindings, topicId);
    if (!binding) return;
    const key = sessionKey(ctx.chat.id, topicId);
    messageQueue.clear(key);
    await sessionManager.closeSession(key);
    await ctx.reply("Session reset. Next message starts a fresh conversation.");
  });

  // /status command — active sessions, memory, uptime, subprocess health
  bot.command("status", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const binding = resolveBinding(ctx.chat.id, config.bindings, topicId);
    if (!binding) return;
    const activeCount = sessionManager.getActiveCount();
    const memUsage = process.memoryUsage();
    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    const lines = [
      `Active sessions: ${activeCount}/${config.sessionDefaults.maxConcurrentSessions}`,
      `Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS`,
      `Uptime: ${hours}h ${minutes}m`,
    ];

    const health = sessionManager.getSessionHealth(sessionKey(ctx.chat.id, topicId));
    if (health) {
      const status = health.alive ? "alive" : "dead";
      const pidStr = health.pid !== null ? String(health.pid) : "n/a";
      const idleMins = Math.floor(health.idleMs / 60000);

      lines.push(`This session: agent "${health.agentId}", PID ${pidStr} (${status})`);

      if (health.processingMs !== null) {
        const procSecs = Math.floor(health.processingMs / 1000);
        lines.push(`  Processing: ${procSecs}s`);
      } else {
        lines.push(`  Idle: ${idleMins}m`);
      }

      if (health.lastSuccessAt !== null) {
        const agoMs = Date.now() - health.lastSuccessAt;
        const agoMins = Math.floor(agoMs / 60000);
        lines.push(`  Last success: ${agoMins}m ago`);
      } else {
        lines.push(`  Last success: none`);
      }

      lines.push(`  Restarts: ${health.restartCount}`);
    }

    await ctx.reply(lines.join("\n"));
  });

  // Handle text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message)) return;

    const key = sessionKey(chatId, topicId);
    const prefix = buildSourcePrefix(binding, ctx.from);
    const messageText = prefix + ctx.message.text;

    // Enqueue: debounce rapid messages, collect mid-turn messages.
    // Processing happens in the background after debounce timer expires.
    messageQueue.enqueue(key, binding.agentId, messageText, ctx);
  });

  // Handle voice messages — transcribe with whisper-cli and send to Claude
  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message)) return;

    const key = sessionKey(chatId, topicId);
    let tempPath: string | null = null;

    try {
      // Download voice file from Telegram
      const fileId = ctx.msg.voice.file_id;
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      tempPath = tempFilePath("voice", ".oga");
      await downloadFile(url, tempPath);

      // Transcribe with whisper-cli
      const transcript = await transcribeAudio(tempPath);
      if (!transcript) {
        await ctx.reply("Could not transcribe voice message (empty result).");
        return;
      }

      // Send transcript text to Claude session
      const prefix = buildSourcePrefix(binding, ctx.from);
      messageQueue.enqueue(key, binding.agentId, `${prefix}[Voice message] ${transcript}`, ctx);

      // Echo transcript back to user (non-critical — don't block enqueue)
      if (binding.voiceTranscriptEcho !== false) {
        await ctx.reply(`\ud83d\udcdd "${transcript}"`).catch((echoErr) => {
          console.warn(`[telegram-bot] Failed to echo transcript for chat ${chatId}:`, echoErr);
        });
      }
    } catch (err) {
      console.error(`[telegram-bot] Voice transcription error for chat ${chatId}:`, err);
      await ctx.reply("Failed to transcribe voice message. Please try again or send text.").catch(() => {});
    } finally {
      if (tempPath) {
        await cleanupTempFile(tempPath);
      }
    }
  });

  // Handle photo messages — download image and pass file path to Claude for vision
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message)) return;

    const key = sessionKey(chatId, topicId);
    let tempPath: string | null = null;

    try {
      // Get largest photo size (last element in array)
      const photos = ctx.msg.photo;
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      tempPath = tempFilePath("photo", ".jpg");
      await downloadFile(url, tempPath);

      // Build message: caption (if any) + image file path
      const prefix = buildSourcePrefix(binding, ctx.from);
      const caption = ctx.msg.caption ?? "";
      const messageText = caption.trimEnd()
        ? `${prefix}${caption.trimEnd()}\n\n${tempPath}`
        : `${prefix}${tempPath}`;

      // Cleanup callback runs after the queue finishes processing this message
      const pathToClean = tempPath;
      tempPath = null;
      messageQueue.enqueue(key, binding.agentId, messageText, ctx, () => {
        cleanupTempFile(pathToClean);
      });
    } catch (err) {
      console.error(`[telegram-bot] Photo handling error for chat ${chatId}:`, err);
      await ctx.reply("Failed to process photo. Please try again.").catch(() => {});
      if (tempPath) {
        cleanupTempFile(tempPath);
      }
    }
  });

  // Handle document messages with image MIME types
  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    const doc = ctx.msg.document;
    if (!isImageMimeType(doc.mime_type)) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message)) return;

    const key = sessionKey(chatId, topicId);
    let tempPath: string | null = null;

    try {
      const file = await ctx.api.getFile(doc.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const ext = imageExtensionForMime(doc.mime_type);
      tempPath = tempFilePath("doc", ext);
      await downloadFile(url, tempPath);

      const prefix = buildSourcePrefix(binding, ctx.from);
      const caption = ctx.msg.caption ?? "";
      const messageText = caption.trimEnd()
        ? `${prefix}${caption.trimEnd()}\n\n${tempPath}`
        : `${prefix}${tempPath}`;

      const pathToClean = tempPath;
      tempPath = null;
      messageQueue.enqueue(key, binding.agentId, messageText, ctx, () => {
        cleanupTempFile(pathToClean);
      });
    } catch (err) {
      console.error(`[telegram-bot] Document image handling error for chat ${chatId}:`, err);
      await ctx.reply("Failed to process image document. Please try again.").catch(() => {});
      if (tempPath) {
        cleanupTempFile(tempPath);
      }
    }
  });

  // Global error handler
  bot.catch((err) => {
    console.error("[telegram-bot] Unhandled error:", err.error);
    console.error("[telegram-bot] Update that caused the error:", JSON.stringify(err.ctx.update));
  });

  return { bot, messageQueue };
}
