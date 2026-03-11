import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { BotConfig, TelegramBinding } from "./types.js";
import type { SessionManager } from "./session-manager.js";
import { relayStream } from "./stream-relay.js";

/**
 * Resolve a Telegram chatId to its binding config.
 * For group chats, matches on chatId. For DMs, matches on chatId.
 */
export function resolveBinding(
  chatId: number,
  bindings: TelegramBinding[],
): TelegramBinding | undefined {
  return bindings.find((b) => b.chatId === chatId);
}

/**
 * Check if a chat is authorized based on bindings allowlist.
 */
export function isAuthorized(chatId: number, bindings: TelegramBinding[]): boolean {
  return bindings.some((b) => b.chatId === chatId);
}

/**
 * Create and configure the Telegram bot.
 */
export function createTelegramBot(
  config: BotConfig,
  sessionManager: SessionManager,
): Bot {
  const bot = new Bot(config.telegramToken);

  // Auto-retry on rate limits
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

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
    const binding = resolveBinding(chatId, config.bindings);
    if (!binding) return;
    const agent = config.agents[binding.agentId];
    await ctx.reply(
      `Connected to agent "${binding.agentId}" (${agent?.model ?? "unknown"}). Send a message to start.`,
    );
  });

  // /reset command — close current session, next message creates fresh
  bot.command("reset", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await sessionManager.closeSession(chatId);
    await ctx.reply("Session reset. Next message starts a fresh conversation.");
  });

  // /status command — active sessions, memory, uptime
  bot.command("status", async (ctx) => {
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

    const session = sessionManager.getActive(String(ctx.chat.id));
    if (session) {
      const idleMs = Date.now() - session.lastActivity;
      const idleMins = Math.floor(idleMs / 60000);
      lines.push(`This session: idle ${idleMins}m, agent "${session.agentId}"`);
    }

    await ctx.reply(lines.join("\n"));
  });

  // Handle text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const binding = resolveBinding(chatId, config.bindings);
    if (!binding) return;

    // Group chat: only respond if bot is mentioned or message is a reply to bot
    if (binding.kind === "group") {
      const botInfo = bot.botInfo;
      const text = ctx.message.text ?? "";
      const isReplyToBot =
        ctx.message.reply_to_message?.from?.id === botInfo.id;
      const isMentioned =
        text.includes(`@${botInfo.username}`) ||
        (ctx.message.entities ?? []).some(
          (e) =>
            e.type === "mention" &&
            text.slice(e.offset, e.offset + e.length) === `@${botInfo.username}`,
        );

      if (!isReplyToBot && !isMentioned) {
        return; // Ignore group messages not directed at bot
      }
    }

    const chatIdStr = String(chatId);
    const messageText = ctx.message.text;

    try {
      const stream = sessionManager.sendSessionMessage(
        chatIdStr,
        binding.agentId,
        messageText,
      );

      await relayStream(stream, ctx);
    } catch (err) {
      console.error(`[telegram-bot] Error processing message for chat ${chatId}:`, err);
      await ctx.reply("Something went wrong. Try again or /reset the session.").catch(() => {});
    }
  });

  // Global error handler
  bot.catch((err) => {
    console.error("[telegram-bot] Unhandled error:", err.error);
    console.error("[telegram-bot] Update that caused the error:", JSON.stringify(err.ctx.update));
  });

  return bot;
}
