import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createTelegramBot, BOT_COMMANDS, type TelegramBotResult } from "./telegram-bot.js";
import { createDiscordBot } from "./discord-bot.js";
import { log, setLogLevel } from "./logger.js";
import { startMetricsServer, stopMetricsServer } from "./metrics.js";
import { startBotWithRetry } from "./bot-startup.js";
import { createWatchdog, type Watchdog } from "./polling-watchdog.js";
import { restoreThreadCache, saveThreadCache } from "./message-thread-cache.js";
import { restoreMessageIndex, saveMessageIndex } from "./message-content-index.js";
import { setBotUsername } from "./telegram-adapter.js";
import { getVersion } from "./version.js";
import type { Client } from "discord.js";
import type { MessageQueue } from "./message-queue.js";

async function main(): Promise<void> {
  log.info("main", `Bot version: ${getVersion()}`);
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

  // Restore caches from disk (survives restarts)
  restoreThreadCache();
  restoreMessageIndex();

  const sessionManager = new SessionManager(config);
  log.info("main", "Session manager initialized");

  // Track resources for shutdown
  let telegramBot: TelegramBotResult["bot"] | undefined;
  const messageQueues: MessageQueue[] = [];
  let discordClient: Client | undefined;
  let watchdog: Watchdog | undefined;

  // Graceful shutdown — registered early so signals during bot startup are handled.
  // Closure captures mutable variables, so shutdown always sees current state.
  const shutdown = async (signal: string) => {
    log.info("main", `Received ${signal}, shutting down...`);
    if (watchdog) watchdog.stop();
    if (telegramBot) telegramBot.stop();
    if (discordClient) discordClient.destroy();
    for (const mq of messageQueues) mq.clearAll();
    if (telegramBot) {
      saveThreadCache();
      saveMessageIndex();
    }
    await stopMetricsServer();
    await sessionManager.closeAll();
    log.info("main", "All sessions closed. Exiting.");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Safety net: catch uncaught exceptions and unhandled rejections.
  // These should never fire if errors are properly caught, but they
  // prevent total process failure if something is missed (e.g. a
  // Discord WebSocket error that somehow bypasses the client handler).
  process.on("uncaughtException", (error) => {
    log.error("main", "FATAL uncaught exception (process NOT exiting):", error);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("main", "FATAL unhandled rejection (process NOT exiting):", reason);
  });

  // Start Telegram bot if configured
  if (config.telegramToken && config.bindings.length > 0) {
    // Mutable reference so onUpdate callback can reach the watchdog
    // (watchdog needs bot.api, which doesn't exist until after createTelegramBot)
    let onUpdateFn: (() => void) | undefined;
    const { bot, messageQueue } = createTelegramBot(config, sessionManager, {
      onUpdate: () => onUpdateFn?.(),
    });
    telegramBot = bot;
    messageQueues.push(messageQueue);

    // Polling liveness watchdog: exits the process if no updates arrive
    // within the threshold AND the Telegram API heartbeat also fails.
    watchdog = createWatchdog({
      heartbeat: async () => {
        try {
          await bot.api.getMe();
          return true;
        } catch {
          return false;
        }
      },
    });
    onUpdateFn = () => watchdog!.touch();

    // Startup timeout — if onStart doesn't fire, exit for launchd restart.
    // Set to 120s to accommodate the 409-retry backoff window (~75s worst case).
    let startedSuccessfully = false;
    const startupTimeout = setTimeout(() => {
      if (!startedSuccessfully) {
        log.error("main", "Telegram startup timed out after 120s — exiting for launchd restart");
        process.exit(1);
      }
    }, 120_000);

    log.info("main", "Starting Telegram bot polling...");
    // bot.start() blocks until stopped — run it without awaiting.
    // startBotWithRetry handles 409 Conflict errors (old instance still polling)
    // with exponential backoff to avoid crash-loops on restart.
    startBotWithRetry(
      () =>
        bot.start({
          allowed_updates: ["message", "message_reaction"],
          onStart: async (botInfo) => {
            startedSuccessfully = true;
            clearTimeout(startupTimeout);
            setBotUsername(botInfo.username);
            log.info("main", `Telegram bot @${botInfo.username} is running (id: ${botInfo.id})`);
            if (watchdog) watchdog.start();
            try {
              await bot.api.setMyCommands(BOT_COMMANDS);
              log.info("main", "Bot commands registered with Telegram");
            } catch (err) {
              log.error("main", "Failed to register bot commands:", err);
            }
          },
        }),
    ).catch((err) => {
      log.error("main", "Telegram bot polling failed — exiting for restart:", err);
      process.exit(1);
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

  // Fail fast if no bots are active
  if (!telegramBot && !discordClient) {
    log.error("main", "No bots started — exiting");
    process.exit(1);
  }

}

main().catch((err) => {
  log.error("main", "Fatal error:", err);
  process.exit(1);
});
