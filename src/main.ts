import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createTelegramBot, BOT_COMMANDS } from "./telegram-bot.js";

async function main(): Promise<void> {
  console.log("[main] Loading config...");
  const config = loadConfig();
  console.log(`[main] Config loaded: ${Object.keys(config.agents).length} agents, ${config.bindings.length} bindings`);

  const sessionManager = new SessionManager(config);
  console.log("[main] Session manager initialized");

  const { bot, messageQueue } = createTelegramBot(config, sessionManager);

  // Startup timeout — if onStart doesn't fire within 30s, exit for launchd restart
  let startedSuccessfully = false;
  const startupTimeout = setTimeout(() => {
    if (!startedSuccessfully) {
      console.error("[main] Startup timed out after 30s — exiting for launchd restart");
      process.exit(1);
    }
  }, 30_000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[main] Received ${signal}, shutting down...`);
    clearTimeout(startupTimeout);
    bot.stop();
    messageQueue.clearAll();
    await sessionManager.closeAll();
    console.log("[main] All sessions closed. Exiting.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    console.error("[main] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[main] Unhandled rejection:", err);
  });

  console.log("[main] Starting Telegram bot polling...");
  await bot.start({
    onStart: async (botInfo) => {
      startedSuccessfully = true;
      clearTimeout(startupTimeout);
      console.log(`[main] Bot @${botInfo.username} is running (id: ${botInfo.id})`);
      try {
        await bot.api.setMyCommands(BOT_COMMANDS);
        console.log("[main] Bot commands registered with Telegram");
      } catch (err) {
        console.error("[main] Failed to register bot commands:", err);
      }
    },
  });
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
