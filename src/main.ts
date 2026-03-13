import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createTelegramBot, BOT_COMMANDS, type TelegramBotResult } from "./telegram-bot.js";
import { createDiscordBot } from "./discord-bot.js";
import { log, setLogLevel } from "./logger.js";
import { startMetricsServer, stopMetricsServer } from "./metrics.js";
import type { Client } from "discord.js";
import type { MessageQueue } from "./message-queue.js";

async function main(): Promise<void> {
  log.info("main", "Loading config...");
  const config = loadConfig();
  if (config.logLevel) {
    setLogLevel(config.logLevel);
  }
  log.info("main", `Config loaded: ${Object.keys(config.agents).length} agents, ${config.bindings.length} Telegram bindings${config.discord ? `, ${config.discord.bindings.length} Discord bindings` : ""}`);

  // Start Prometheus metrics server if configured
  if (config.metricsPort !== undefined) {
    startMetricsServer(config.metricsPort);
  }

  const sessionManager = new SessionManager(config);
  log.info("main", "Session manager initialized");

  // Track resources for shutdown
  let telegramBot: TelegramBotResult["bot"] | undefined;
  const messageQueues: MessageQueue[] = [];
  let discordClient: Client | undefined;

  // Start Telegram bot if configured
  if (config.telegramToken && config.bindings.length > 0) {
    const { bot, messageQueue } = createTelegramBot(config, sessionManager);
    telegramBot = bot;
    messageQueues.push(messageQueue);

    // Startup timeout — if onStart doesn't fire within 30s, exit for launchd restart
    let startedSuccessfully = false;
    const startupTimeout = setTimeout(() => {
      if (!startedSuccessfully) {
        log.error("main", "Telegram startup timed out after 30s — exiting for launchd restart");
        process.exit(1);
      }
    }, 30_000);

    log.info("main", "Starting Telegram bot polling...");
    // bot.start() blocks until stopped — run it without awaiting
    bot.start({
      onStart: async (botInfo) => {
        startedSuccessfully = true;
        clearTimeout(startupTimeout);
        log.info("main", `Telegram bot @${botInfo.username} is running (id: ${botInfo.id})`);
        try {
          await bot.api.setMyCommands(BOT_COMMANDS);
          log.info("main", "Bot commands registered with Telegram");
        } catch (err) {
          log.error("main", "Failed to register bot commands:", err);
        }
      },
    }).catch((err) => {
      log.error("main", "Telegram bot error:", err);
    });
  }

  // Start Discord bot if configured
  if (config.discord) {
    try {
      const result = await createDiscordBot(config, config.discord, sessionManager);
      discordClient = result.client;
      messageQueues.push(result.messageQueue);
      log.info("main", "Discord bot started");
    } catch (err) {
      log.error("main", "Failed to start Discord bot:", err);
    }
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("main", `Received ${signal}, shutting down...`);
    if (telegramBot) telegramBot.stop();
    if (discordClient) discordClient.destroy();
    for (const mq of messageQueues) mq.clearAll();
    await stopMetricsServer();
    await sessionManager.closeAll();
    log.info("main", "All sessions closed. Exiting.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    log.error("main", "Uncaught exception:", err);
  });
  process.on("unhandledRejection", (err) => {
    log.error("main", "Unhandled rejection:", err);
  });
}

main().catch((err) => {
  log.error("main", "Fatal error:", err);
  process.exit(1);
});
