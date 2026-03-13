import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createTelegramBot, BOT_COMMANDS } from "./telegram-bot.js";
import { log, setLogLevel } from "./logger.js";
import { startMetricsServer, stopMetricsServer } from "./metrics.js";

async function main(): Promise<void> {
  log.info("main", "Loading config...");
  const config = loadConfig();
  if (config.logLevel) {
    setLogLevel(config.logLevel);
  }
  log.info("main", `Config loaded: ${Object.keys(config.agents).length} agents, ${config.bindings.length} bindings`);

  // Start Prometheus metrics server if configured
  if (config.metricsPort !== undefined) {
    startMetricsServer(config.metricsPort);
  }

  const sessionManager = new SessionManager(config);
  log.info("main", "Session manager initialized");

  const { bot, messageQueue } = createTelegramBot(config, sessionManager);

  // Startup timeout — if onStart doesn't fire within 30s, exit for launchd restart
  let startedSuccessfully = false;
  const startupTimeout = setTimeout(() => {
    if (!startedSuccessfully) {
      log.error("main", "Startup timed out after 30s — exiting for launchd restart");
      process.exit(1);
    }
  }, 30_000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("main", `Received ${signal}, shutting down...`);
    clearTimeout(startupTimeout);
    bot.stop();
    messageQueue.clearAll();
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

  log.info("main", "Starting Telegram bot polling...");
  await bot.start({
    onStart: async (botInfo) => {
      startedSuccessfully = true;
      clearTimeout(startupTimeout);
      log.info("main", `Bot @${botInfo.username} is running (id: ${botInfo.id})`);
      try {
        await bot.api.setMyCommands(BOT_COMMANDS);
        log.info("main", "Bot commands registered with Telegram");
      } catch (err) {
        log.error("main", "Failed to register bot commands:", err);
      }
    },
  });
}

main().catch((err) => {
  log.error("main", "Fatal error:", err);
  process.exit(1);
});
