import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createTelegramBot } from "./telegram-bot.js";

async function main(): Promise<void> {
  console.log("[main] Loading config...");
  const config = loadConfig();
  console.log(`[main] Config loaded: ${Object.keys(config.agents).length} agents, ${config.bindings.length} bindings`);

  const sessionManager = new SessionManager(config);
  console.log("[main] Session manager initialized");

  const bot = createTelegramBot(config, sessionManager);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[main] Received ${signal}, shutting down...`);
    bot.stop();
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
    onStart: (botInfo) => {
      console.log(`[main] Bot @${botInfo.username} is running (id: ${botInfo.id})`);
    },
  });
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
