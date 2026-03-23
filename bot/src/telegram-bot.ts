import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { BotConfig, TelegramBinding } from "./types.js";
import { outboxDir, type SessionManager } from "./session-manager.js";
import { relayStream } from "./stream-relay.js";
import { MessageQueue } from "./message-queue.js";
import { createTelegramAdapter } from "./telegram-adapter.js";
import { tempFilePath, downloadFile, transcribeAudio, cleanupTempFile } from "./voice.js";
import { isImageMimeType, imageExtensionForMime } from "./mime.js";
import { log } from "./logger.js";
import { recordTelegramApiError, messagesReceived, messagesSent } from "./metrics.js";
import { setThread, getThread } from "./message-thread-cache.js";
import { recordMessage, lookupMessage } from "./message-content-index.js";
import type { MessageRecord } from "./message-content-index.js";
import { logReaction } from "./reaction-log.js";

// Re-export for backward compatibility (tests import from here)
export { isImageMimeType, imageExtensionForMime };

/** Derive a short sender label for the message content index. */
function senderLabel(from?: { first_name: string; username?: string }): string {
  if (!from) return "unknown";
  return from.username ? `@${from.username}` : from.first_name;
}

/** Commands to register with the Telegram Bot API via setMyCommands */
export const BOT_COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "reset", description: "Reset current session" },
  { command: "status", description: "Show bot status" },
] as const;

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

  // Preserve topicId for unlisted forum topics so headers show Topic: <id>
  if (fallback && topicId !== undefined) {
    return { ...fallback, topicId };
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
  timestampUnixSec?: number,
): string {
  const parts: string[] = [];

  if (binding.label) {
    parts.push(`Chat: ${binding.label}`);
  }

  if (binding.topicId !== undefined) {
    parts.push(`Topic: ${binding.topicId}`);
  }

  if (from) {
    const name = from.first_name.replace(/[\n\r]/g, " ");
    const sender = from.username
      ? `${name} (@${from.username.replace(/[\n\r]/g, "")})`
      : name;
    parts.push(`From: ${sender}`);
  }

  if (timestampUnixSec !== undefined) {
    const d = new Date(timestampUnixSec * 1000);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    parts.push(`${hh}:${mm}`);
  }

  return parts.length > 0 ? `[${parts.join(" | ")}]\n` : "";
}

/**
 * Check if a reply_to_message is a forum service message (topic creation/edit/close etc).
 * Telegram sets reply_to_message on every message in a forum topic, pointing to the
 * topic's creation service message. This is NOT a real user reply.
 */
function isForumServiceMessage(
  msg: {
    forum_topic_created?: unknown;
    forum_topic_edited?: unknown;
    forum_topic_closed?: unknown;
    forum_topic_reopened?: unknown;
    general_forum_topic_hidden?: unknown;
    general_forum_topic_unhidden?: unknown;
  },
): boolean {
  return !!(
    msg.forum_topic_created ||
    msg.forum_topic_edited ||
    msg.forum_topic_closed ||
    msg.forum_topic_reopened ||
    msg.general_forum_topic_hidden ||
    msg.general_forum_topic_unhidden
  );
}

/** Max characters of replied-to text to include before truncating. */
const REPLY_TRUNCATE_LIMIT = 200;

/**
 * Build reply context string when a user replies to a message.
 * Returns formatted context or empty string if not a real reply.
 * When `quote` is provided (user selected text before replying),
 * the quoted text is used instead of the full reply message.
 */
export function buildReplyContext(
  replyTo?: {
    from?: { first_name: string; username?: string };
    text?: string;
    caption?: string;
    forum_topic_created?: unknown;
    forum_topic_edited?: unknown;
    forum_topic_closed?: unknown;
    forum_topic_reopened?: unknown;
    general_forum_topic_hidden?: unknown;
    general_forum_topic_unhidden?: unknown;
  },
  quote?: {
    text: string;
    is_manual?: boolean;
  },
): string {
  if (!replyTo) return "";
  if (isForumServiceMessage(replyTo)) return "";

  const hasQuote = quote?.text != null && quote.text.length > 0;

  let header = "[Reply]";
  if (replyTo.from) {
    const name = replyTo.from.first_name.replace(/[\n\r]/g, " ");
    const uname = replyTo.from.username?.replace(/[\n\r]/g, "") ?? "";
    const sender = uname ? `${name} (@${uname})` : name;
    header = hasQuote ? `[Reply to ${sender}, quoting]` : `[Reply to ${sender}]`;
  } else if (hasQuote) {
    header = "[Reply, quoting]";
  }

  const replyText = hasQuote ? quote!.text : (replyTo.text ?? replyTo.caption ?? "");
  if (!replyText) return header + "\n";

  const cleaned = replyText.replace(/[\n\r]/g, " ").trim();
  const truncated = cleaned.length > REPLY_TRUNCATE_LIMIT
    ? cleaned.slice(0, REPLY_TRUNCATE_LIMIT) + "..."
    : cleaned;

  return `${header}\n> ${truncated}\n`;
}

/**
 * Build forward context string when a user forwards a message.
 * Returns formatted context or empty string if not a forward.
 */
export function buildForwardContext(
  forwardOrigin?: {
    type: string;
    sender_user?: { first_name: string; username?: string };
    sender_user_name?: string;
    sender_chat?: { title?: string };
    chat?: { title?: string };
    author_signature?: string;
  },
): string {
  if (!forwardOrigin) return "";

  let origin = "";
  switch (forwardOrigin.type) {
    case "user": {
      const u = forwardOrigin.sender_user;
      if (u) {
        const name = u.first_name.replace(/[\n\r]/g, " ");
        const uname = u.username?.replace(/[\n\r]/g, "") ?? "";
        origin = uname ? `${name} (@${uname})` : name;
      } else {
        origin = "Unknown";
      }
      break;
    }
    case "hidden_user":
      origin = (forwardOrigin.sender_user_name ?? "Unknown").replace(/[\n\r]/g, " ");
      break;
    case "chat":
      origin = (forwardOrigin.sender_chat?.title ?? "Unknown chat").replace(/[\n\r]/g, " ");
      break;
    case "channel":
      origin = (forwardOrigin.chat?.title ?? "Unknown channel").replace(/[\n\r]/g, " ");
      if (forwardOrigin.author_signature) {
        origin += ` (${forwardOrigin.author_signature.replace(/[\n\r]/g, " ")})`;
      }
      break;
    default:
      origin = "Unknown";
  }

  return `[Forwarded from ${origin}]\n`;
}

/**
 * Build reaction context lines for forwarding to the agent.
 * When a MessageRecord is available, includes author and text preview.
 * On cache miss, falls back to message ID only (previous behavior).
 */
export function buildReactionContext(
  messageId: number,
  emojiAdded: string[],
  emojiRemoved: string[],
  content?: MessageRecord,
): string {
  const target = content
    ? `message by ${content.from.replace(/[\n\r]/g, " ")}: "${content.preview.replace(/[\n\r]/g, " ")}"`
    : `message ${messageId}`;
  const lines: string[] = [];
  for (const emoji of emojiAdded) {
    lines.push(`[Reaction: ${emoji} on ${target}]`);
  }
  for (const emoji of emojiRemoved) {
    lines.push(`[Reaction removed: ${emoji} on ${target}]`);
  }
  return lines.join("\n");
}

/** Telegram Bot API file download limit (20 MB). */
export const TELEGRAM_FILE_SIZE_LIMIT = 20 * 1024 * 1024;

/**
 * Derive a file extension for a document.
 * Prefers the original filename extension; falls back to a MIME-based lookup.
 */
export function extensionForDocument(filename?: string, mimeType?: string): string {
  if (filename) {
    const dotIdx = filename.lastIndexOf(".");
    if (dotIdx > 0) {
      // Sanitize: keep only alphanumeric chars and dots to prevent path traversal
      return filename.slice(dotIdx).replace(/[^a-zA-Z0-9.]/g, "");
    }
  }
  switch (mimeType) {
    case "application/pdf": return ".pdf";
    case "text/plain": return ".txt";
    case "text/csv": return ".csv";
    case "application/json": return ".json";
    case "application/xml":
    case "text/xml": return ".xml";
    case "text/html": return ".html";
    case "application/zip": return ".zip";
    case "application/gzip": return ".gz";
    default: return ".bin";
  }
}

/**
 * Format a byte count as a human-readable string (e.g. "1.2 MB").
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a metadata line for a document attachment.
 * Example: `[Document: report.pdf | Type: application/pdf | Size: 1.2 MB]`
 */
export function formatDocumentMeta(
  filename?: string,
  mimeType?: string,
  fileSize?: number,
): string {
  const parts: string[] = [];
  parts.push(`Document: ${filename ?? "unknown"}`);
  if (mimeType) parts.push(`Type: ${mimeType}`);
  if (fileSize !== undefined) parts.push(`Size: ${formatFileSize(fileSize)}`);
  return `[${parts.join(" | ")}]`;
}

/**
 * Media info extracted from a Telegram message for the generic media handler.
 */
export interface MediaInfo {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  is_animated?: boolean;
  is_video?: boolean;
}

/**
 * Extract media object and type label from a Telegram message.
 * Checks each supported media type in order and returns the first match.
 */
export function extractMediaInfo(msg: {
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  animation?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video_note?: { file_id: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string; file_size?: number; is_animated?: boolean; is_video?: boolean };
}): { media: MediaInfo; mediaType: string; typeLabel: string } {
  if (msg.video) return { media: msg.video, mediaType: "video", typeLabel: "Video" };
  if (msg.animation) return { media: msg.animation, mediaType: "animation", typeLabel: "Animation" };
  if (msg.video_note) return { media: msg.video_note, mediaType: "video_note", typeLabel: "Video Note" };
  if (msg.audio) return { media: msg.audio, mediaType: "audio", typeLabel: "Audio" };
  if (msg.sticker) return { media: msg.sticker, mediaType: "sticker", typeLabel: "Sticker" };
  throw new Error("No supported media type found in message");
}

/**
 * Derive a file extension for a media attachment.
 * Prefers the original filename extension when available; falls back to type-specific defaults.
 */
export function extensionForMedia(media: MediaInfo, mediaType: string): string {
  if (media.file_name) {
    const dotIdx = media.file_name.lastIndexOf(".");
    if (dotIdx > 0) {
      return media.file_name.slice(dotIdx).replace(/[^a-zA-Z0-9.]/g, "");
    }
  }
  switch (mediaType) {
    case "video":
    case "animation":
    case "video_note":
      return ".mp4";
    case "audio": {
      switch (media.mime_type) {
        case "audio/mpeg": return ".mp3";
        case "audio/mp4":
        case "audio/x-m4a": return ".m4a";
        case "audio/ogg": return ".ogg";
        case "audio/flac": return ".flac";
        case "audio/wav":
        case "audio/x-wav": return ".wav";
        default: return ".mp3";
      }
    }
    case "sticker": {
      if (media.is_video) return ".webm";
      if (media.is_animated) return ".tgs";
      return ".webp";
    }
    default:
      return ".bin";
  }
}

/**
 * Build a metadata line for a media attachment.
 * Example: `[Video: clip.mp4 | Type: video/mp4 | Size: 5.2 MB]`
 */
export function formatMediaMeta(
  typeLabel: string,
  filename?: string,
  mimeType?: string,
  fileSize?: number,
): string {
  const parts: string[] = [];
  parts.push(filename ? `${typeLabel}: ${filename}` : typeLabel);
  if (mimeType) parts.push(`Type: ${mimeType}`);
  if (fileSize !== undefined) parts.push(`Size: ${formatFileSize(fileSize)}`);
  return `[${parts.join(" | ")}]`;
}

/**
 * Check if a message is too old to process.
 * Used to discard stale messages that accumulated during bot downtime.
 * @param messageTimestampMs Message timestamp in milliseconds
 * @param maxAgeMs Maximum allowed age in milliseconds
 */
export function isStaleMessage(messageTimestampMs: number, maxAgeMs: number): boolean {
  return Date.now() - messageTimestampMs > maxAgeMs;
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
    reply_to_message?: {
      from?: { id: number };
      forum_topic_created?: unknown;
      forum_topic_edited?: unknown;
      forum_topic_closed?: unknown;
      forum_topic_reopened?: unknown;
      general_forum_topic_hidden?: unknown;
      general_forum_topic_unhidden?: unknown;
    };
    text?: string;
    caption?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    caption_entities?: Array<{ type: string; offset: number; length: number }>;
  },
  sessionDefaults?: { requireMention?: boolean },
): boolean {
  if (binding.kind !== "group") return true;

  const requireMention = binding.requireMention ?? sessionDefaults?.requireMention ?? true;
  if (!requireMention) return true;

  if (
    message.reply_to_message?.from?.id === botId &&
    !isForumServiceMessage(message.reply_to_message)
  ) {
    return true;
  }

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

/** autoRetry options — exported so tests can assert the rethrowHttpErrors value. */
export const AUTO_RETRY_OPTIONS = {
  maxRetryAttempts: 5,
  maxDelaySeconds: 60,
  rethrowHttpErrors: false,
} as const;

/**
 * Create and configure the Telegram bot.
 */
export function createTelegramBot(
  config: BotConfig,
  sessionManager: SessionManager,
  opts?: { onUpdate?: () => void },
): TelegramBotResult {
  if (!config.telegramToken) {
    throw new Error("telegramToken is required for Telegram bot");
  }
  const token = config.telegramToken;
  const bot = new Bot(token);

// Log Telegram API errors, especially 429 rate limits (inner transformer —
  // sees each individual attempt before autoRetry decides whether to retry)
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      const res = await prev(method, payload, signal);
      if (!res.ok && res.error_code === 429) {
        log.warn("telegram-api", `Rate limited: method=${String(method)} retry_after=${res.parameters?.retry_after ?? "unknown"}`);
        recordTelegramApiError(String(method), 429);
      } else if (!res.ok && res.error_code) {
        recordTelegramApiError(String(method), res.error_code);
      }
      return res;
    } catch (err) {
      log.warn("telegram-api", `HTTP error: method=${String(method)} ${err instanceof Error ? err.message : err}`);
      recordTelegramApiError(String(method), "http_error");
      throw err;
    }
  });

  // Auto-retry on rate limits (outermost transformer — retries after inner errors)
  bot.api.config.use(autoRetry(AUTO_RETRY_OPTIONS));

  const maxMessageAgeMs = config.sessionDefaults.maxMessageAgeMs;

  // Message queue: debounce rapid messages and collect mid-turn messages
  const messageQueue = new MessageQueue(
    async (chatId, agentId, text, platform) => {
      const stream = sessionManager.sendSessionMessage(chatId, agentId, text);
      await relayStream(stream, platform, outboxDir(chatId));
    },
  );

  // Watchdog touch: notify liveness watchdog on every incoming update
  if (opts?.onUpdate) {
    const onUpdate = opts.onUpdate;
    bot.use(async (_ctx, next) => {
      onUpdate();
      await next();
    });
  }

  // Auth middleware: reject unauthorized chats
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    if (!isAuthorized(chatId, config.bindings)) {
      log.info("telegram-bot", `Rejected message from unauthorized chat ${chatId}`);
      return; // Silent drop
    }

    await next();
  });

  // /start command
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    if (ctx.message) setThread(chatId, ctx.message.message_id, topicId);
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;
    if (ctx.message && isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale /start for chat ${chatId} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }
    const agent = config.agents[binding.agentId];
    await ctx.reply(
      `Connected to agent "${binding.agentId}" (${agent?.model ?? "unknown"}). Send a message to start.`,
    );
  });

  // /reset command — close current session.
  // Session lifecycle: create → compact → reset → resume. The reset kills the
  // Claude subprocess but the session file (with compacted conversation history)
  // remains on disk. When the next message arrives, getOrCreateSession() finds
  // the file and resumes with --resume, so prior context may be partially
  // retained through the compaction summary.
  bot.command("reset", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (ctx.message) setThread(ctx.chat.id, ctx.message.message_id, topicId);
    const binding = resolveBinding(ctx.chat.id, config.bindings, topicId);
    if (!binding) return;
    if (ctx.message && isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale /reset for chat ${ctx.chat.id} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }
    const key = sessionKey(ctx.chat.id, topicId);
    messageQueue.clear(key);
    await sessionManager.closeSession(key);
    await ctx.reply("Session restarted. Prior context may be partially retained.");
  });

  // /status command — active sessions, memory, uptime, subprocess health
  bot.command("status", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (ctx.message) setThread(ctx.chat.id, ctx.message.message_id, topicId);
    const binding = resolveBinding(ctx.chat.id, config.bindings, topicId);
    if (!binding) return;
    if (ctx.message && isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale /status for chat ${ctx.chat.id} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }
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
      lines.push(`  Session ID: ${health.sessionId}`);

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
    setThread(chatId, ctx.message.message_id, topicId);
    recordMessage(chatId, ctx.message.message_id, senderLabel(ctx.from), ctx.message.text, "in");
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message, config.sessionDefaults)) return;

    // Discard stale messages accumulated during bot downtime
    if (isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale message for chat ${chatId} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }

    messagesReceived.inc({ type: "text" });

    const key = sessionKey(chatId, topicId);
    const prefix = buildSourcePrefix(binding, ctx.from, ctx.message.date);
    const replyCtx = buildReplyContext(ctx.message.reply_to_message, ctx.message.quote);
    const fwdCtx = buildForwardContext(ctx.message.forward_origin);
    const messageText = prefix + replyCtx + fwdCtx + ctx.message.text;

    // Enqueue: debounce rapid messages, collect mid-turn messages.
    // Processing happens in the background after debounce timer expires.
    messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(ctx, binding, undefined, config.sessionDefaults));
  });

  // Handle voice messages — transcribe with whisper-cli and send to Claude
  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    setThread(chatId, ctx.message.message_id, topicId);
    recordMessage(chatId, ctx.message.message_id, senderLabel(ctx.from), "[voice]", "in");
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message, config.sessionDefaults)) return;

    if (isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale voice message for chat ${chatId} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }

    messagesReceived.inc({ type: "voice" });

    const key = sessionKey(chatId, topicId);
    let tempPath: string | null = null;

    try {
      // Download voice file from Telegram
      const fileId = ctx.msg.voice.file_id;
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      tempPath = tempFilePath("voice", ".oga");
      await downloadFile(url, tempPath);

      // Transcribe with whisper-cli
      const transcript = await transcribeAudio(tempPath);
      if (!transcript) {
        await ctx.reply("Could not transcribe voice message (empty result).");
        return;
      }

      // Update index with actual transcript content
      recordMessage(chatId, ctx.message.message_id, senderLabel(ctx.from), transcript, "in");

      // Send transcript text to Claude session
      const prefix = buildSourcePrefix(binding, ctx.from, ctx.message.date);
      const replyCtx = buildReplyContext(ctx.message.reply_to_message, ctx.message.quote);
      const fwdCtx = buildForwardContext(ctx.message.forward_origin);
      messageQueue.enqueue(key, binding.agentId, `${prefix}${replyCtx}${fwdCtx}[Voice message] ${transcript}`, createTelegramAdapter(ctx, binding, undefined, config.sessionDefaults));

      // Echo transcript back to user (non-critical — don't block enqueue)
      if (binding.voiceTranscriptEcho !== false) {
        await ctx.reply(`\ud83d\udcdd "${transcript}"`).catch((echoErr) => {
          log.warn("telegram-bot", `Failed to echo transcript for chat ${chatId}:`, echoErr);
        });
      }
    } catch (err) {
      log.error("telegram-bot", `Voice transcription error for chat ${chatId}:`, err);
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
    setThread(chatId, ctx.message.message_id, topicId);
    recordMessage(chatId, ctx.message.message_id, senderLabel(ctx.from), ctx.message.caption ?? "[photo]", "in");
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message, config.sessionDefaults)) return;

    if (isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale photo message for chat ${chatId} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }

    messagesReceived.inc({ type: "photo" });

    const key = sessionKey(chatId, topicId);
    let tempPath: string | null = null;

    try {
      // Get largest photo size (last element in array)
      const photos = ctx.msg.photo;
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      tempPath = tempFilePath("photo", ".jpg");
      await downloadFile(url, tempPath);

      // Build message: caption (if any) + image file path
      const prefix = buildSourcePrefix(binding, ctx.from, ctx.message.date);
      const replyCtx = buildReplyContext(ctx.message.reply_to_message, ctx.message.quote);
      const fwdCtx = buildForwardContext(ctx.message.forward_origin);
      const context = prefix + replyCtx + fwdCtx;
      const caption = ctx.msg.caption ?? "";
      const messageText = caption.trimEnd()
        ? `${context}${caption.trimEnd()}\n\n${tempPath}`
        : `${context}${tempPath}`;

      // Cleanup callback runs after the queue finishes processing this message
      const pathToClean = tempPath;
      tempPath = null;
      messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(ctx, binding, undefined, config.sessionDefaults), () => {
        cleanupTempFile(pathToClean);
      });
    } catch (err) {
      log.error("telegram-bot", `Photo handling error for chat ${chatId}:`, err);
      await ctx.reply("Failed to process photo. Please try again.").catch(() => {});
      if (tempPath) {
        cleanupTempFile(tempPath);
      }
    }
  });

  // Handle document messages (images, animations, and general files).
  // Animation messages always carry a `document` field, so grammY's message:document
  // filter catches them here. We detect animations via ctx.msg.animation to give them
  // proper metadata and file extension instead of treating them as generic documents.
  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    setThread(chatId, ctx.message.message_id, topicId);

    const anim = ctx.msg.animation;
    const doc = ctx.msg.document;

    recordMessage(chatId, ctx.message.message_id, senderLabel(ctx.from), ctx.message.caption ?? (anim ? "[animation]" : "[document]"), "in");
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message, config.sessionDefaults)) return;

    if (isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale ${anim ? "animation" : "document"} message for chat ${chatId} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }

    // Telegram Bot API limits file downloads to 20 MB
    if (doc.file_size !== undefined && doc.file_size > TELEGRAM_FILE_SIZE_LIMIT) {
      await ctx.reply("File is too large (max 20 MB for bot downloads).").catch(() => {});
      return;
    }

    const isImage = !anim && isImageMimeType(doc.mime_type);
    messagesReceived.inc({ type: anim ? "animation" : "document" });

    const key = sessionKey(chatId, topicId);
    let tempPath: string | null = null;

    try {
      const file = await ctx.api.getFile(doc.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      let ext: string;
      if (anim) {
        ext = extensionForMedia(anim, "animation");
      } else if (isImage) {
        ext = imageExtensionForMime(doc.mime_type);
      } else {
        ext = extensionForDocument(doc.file_name, doc.mime_type);
      }
      tempPath = tempFilePath(anim ? "animation" : "doc", ext);
      await downloadFile(url, tempPath);

      const prefix = buildSourcePrefix(binding, ctx.from, ctx.message.date);
      const replyCtx = buildReplyContext(ctx.message.reply_to_message, ctx.message.quote);
      const fwdCtx = buildForwardContext(ctx.message.forward_origin);
      const context = prefix + replyCtx + fwdCtx;
      const caption = ctx.msg.caption ?? "";

      let messageText: string;
      if (isImage) {
        messageText = caption.trimEnd()
          ? `${context}${caption.trimEnd()}\n\n${tempPath}`
          : `${context}${tempPath}`;
      } else {
        const meta = anim
          ? formatMediaMeta("Animation", anim.file_name, anim.mime_type, anim.file_size)
          : formatDocumentMeta(doc.file_name, doc.mime_type, doc.file_size);
        messageText = caption.trimEnd()
          ? `${context}${caption.trimEnd()}\n\n${meta}\n${tempPath}`
          : `${context}${meta}\n${tempPath}`;
      }

      const pathToClean = tempPath;
      tempPath = null;
      messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(ctx, binding, undefined, config.sessionDefaults), () => {
        cleanupTempFile(pathToClean);
      });
    } catch (err) {
      log.error("telegram-bot", `${anim ? "Animation" : "Document"} handling error for chat ${chatId}:`, err);
      await ctx.reply(`Failed to process ${anim ? "animation" : "document"}. Please try again.`).catch(() => {});
      if (tempPath) {
        cleanupTempFile(tempPath);
      }
    }
  });

  // Handle media types without specialized handlers (video, video_note, audio, sticker).
  // Note: animation is NOT listed here — Telegram includes a `document` field alongside
  // `animation`, so the document handler above catches them first with proper animation metadata.
  bot.on(["message:video", "message:video_note", "message:audio", "message:sticker"], async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = ctx.message?.message_thread_id;
    setThread(chatId, ctx.message.message_id, topicId);

    const { media, mediaType, typeLabel } = extractMediaInfo(ctx.msg);

    recordMessage(chatId, ctx.message.message_id, senderLabel(ctx.from), ctx.message.caption ?? `[${typeLabel.toLowerCase()}]`, "in");
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    if (!shouldRespondInGroup(binding, bot.botInfo.id, bot.botInfo.username, ctx.message, config.sessionDefaults)) return;

    if (isStaleMessage(ctx.message.date * 1000, maxMessageAgeMs)) {
      log.debug("telegram-bot", `Discarding stale ${mediaType} message for chat ${chatId} (age: ${Math.round((Date.now() - ctx.message.date * 1000) / 1000)}s)`);
      return;
    }

    if (media.file_size !== undefined && media.file_size > TELEGRAM_FILE_SIZE_LIMIT) {
      await ctx.reply("File is too large (max 20 MB for bot downloads).").catch(() => {});
      return;
    }

    messagesReceived.inc({ type: mediaType });

    const key = sessionKey(chatId, topicId);
    let tempPath: string | null = null;

    try {
      const file = await ctx.api.getFile(media.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const ext = extensionForMedia(media, mediaType);
      tempPath = tempFilePath(mediaType, ext);
      await downloadFile(url, tempPath);

      const prefix = buildSourcePrefix(binding, ctx.from, ctx.message.date);
      const replyCtx = buildReplyContext(ctx.message.reply_to_message, ctx.message.quote);
      const fwdCtx = buildForwardContext(ctx.message.forward_origin);
      const context = prefix + replyCtx + fwdCtx;
      const caption = ctx.msg.caption ?? "";
      const meta = formatMediaMeta(typeLabel, media.file_name, media.mime_type, media.file_size);
      const messageText = caption.trimEnd()
        ? `${context}${caption.trimEnd()}\n\n${meta}\n${tempPath}`
        : `${context}${meta}\n${tempPath}`;

      const pathToClean = tempPath;
      tempPath = null;
      messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(ctx, binding, undefined, config.sessionDefaults), () => {
        cleanupTempFile(pathToClean);
      });
    } catch (err) {
      log.error("telegram-bot", `${typeLabel} handling error for chat ${chatId}:`, err);
      await ctx.reply(`Failed to process ${typeLabel.toLowerCase()}. Please try again.`).catch(() => {});
      if (tempPath) {
        cleanupTempFile(tempPath);
      }
    }
  });

  // Handle message reactions — forward as contextual info to the agent.
  // Telegram's MessageReactionUpdated does not include message_thread_id
  // (tdlib/telegram-bot-api#726). We work around this by maintaining an
  // in-memory cache of messageId→topicId populated by every message handler.
  // Cache miss degrades gracefully to chat-level routing (previous behavior).
  bot.on("message_reaction", async (ctx) => {
    const chatId = ctx.chat.id;
    const messageId = ctx.messageReaction.message_id;
    const topicId = getThread(chatId, messageId);
    const binding = resolveBinding(chatId, config.bindings, topicId);
    if (!binding) return;

    try {
      if (isStaleMessage(ctx.messageReaction.date * 1000, maxMessageAgeMs)) {
        log.debug("telegram-bot", `Discarding stale reaction for chat ${chatId} (age: ${Math.round((Date.now() - ctx.messageReaction.date * 1000) / 1000)}s)`);
        return;
      }

      const { emojiAdded, emojiRemoved } = ctx.reactions();
      if (emojiAdded.length === 0 && emojiRemoved.length === 0) return;

      messagesReceived.inc({ type: "reaction" });

      const user = ctx.messageReaction.user;
      const from = user ? { first_name: user.first_name, username: user.username } : undefined;
      const prefix = buildSourcePrefix(binding, from, ctx.messageReaction.date);
      const content = lookupMessage(chatId, messageId);
      const reactionText = buildReactionContext(messageId, emojiAdded, emojiRemoved, content);
      const messageText = prefix + reactionText;

      void logReaction({
        ts: new Date(ctx.messageReaction.date * 1000).toISOString(),
        chatId,
        topicId,
        messageId,
        userId: user?.id,
        username: user?.username,
        added: emojiAdded,
        removed: emojiRemoved,
      });

      const key = sessionKey(chatId, topicId);
      messageQueue.enqueue(key, binding.agentId, messageText, createTelegramAdapter(ctx, binding, topicId, config.sessionDefaults));
    } catch (err) {
      log.error("telegram-bot", `Reaction handling error for chat ${chatId}:`, err);
    }
  });

  // Global error handler
  bot.catch((err) => {
    log.error("telegram-bot", "Unhandled error:", err.error);
    log.error("telegram-bot", `Update that caused the error: ${JSON.stringify(err.ctx.update)}`);
  });

  return { bot, messageQueue };
}
