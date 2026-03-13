import { Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { Message as DiscordMessage } from "discord.js";
import type { BotConfig, DiscordBinding, DiscordConfig } from "./types.js";
import type { SessionManager } from "./session-manager.js";
import { relayStream } from "./stream-relay.js";
import { MessageQueue } from "./message-queue.js";
import { createDiscordAdapter, type DiscordSendableChannel } from "./discord-adapter.js";
import { tempFilePath, downloadFile, transcribeAudio, cleanupTempFile } from "./voice.js";
import { log } from "./logger.js";
import { messagesReceived } from "./metrics.js";
import { isImageMimeType } from "./mime.js";

/**
 * Build a session key for Discord channels and threads.
 * Uses "discord:" prefix to avoid collisions with Telegram session keys.
 */
export function discordSessionKey(channelId: string, threadId?: string): string {
  const base = `discord:${channelId}`;
  return threadId ? `${base}:${threadId}` : base;
}

/**
 * Resolve a Discord channelId to its binding config.
 */
export function resolveDiscordBinding(
  channelId: string,
  bindings: DiscordBinding[],
): DiscordBinding | undefined {
  return bindings.find((b) => b.channelId === channelId);
}

/**
 * Check whether the bot should respond to a message in a Discord channel.
 * Returns true for DMs, when requireMention is false, or when the bot is @mentioned.
 */
export function shouldRespondInDiscord(
  binding: DiscordBinding,
  botUserId: string,
  message: DiscordMessage,
): boolean {
  if (binding.kind === "dm") return true;
  const requireMention = binding.requireMention ?? true;
  if (!requireMention) return true;
  if (message.mentions.has(botUserId)) return true;
  return false;
}

/**
 * Build a source context prefix for Discord messages.
 * Prepended to every message before enqueuing so Claude knows
 * which channel a message came from and who sent it.
 */
export function buildDiscordSourcePrefix(
  binding: DiscordBinding,
  author?: { username: string; displayName?: string; globalName?: string | null },
): string {
  const parts: string[] = [];

  if (binding.label) {
    parts.push(`Chat: ${binding.label}`);
  }

  if (author) {
    const displayName = author.globalName ?? author.displayName ?? author.username;
    const name = displayName.replace(/[\n\r]/g, " ");
    const sender = `${name} (@${author.username.replace(/[\n\r]/g, "")})`;
    parts.push(`From: ${sender}`);
  }

  return parts.length > 0 ? `[${parts.join(" | ")}]\n` : "";
}

export interface DiscordBotResult {
  client: Client;
  messageQueue: MessageQueue;
}

/**
 * Create and configure the Discord bot.
 * Returns a Client (already logged in) and a MessageQueue.
 */
export async function createDiscordBot(
  config: BotConfig,
  discordConfig: DiscordConfig,
  sessionManager: SessionManager,
): Promise<DiscordBotResult> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const messageQueue = new MessageQueue(
    async (chatId, agentId, text, platform) => {
      const stream = sessionManager.sendSessionMessage(chatId, agentId, text);
      const agent = config.agents[agentId];
      await relayStream(stream, platform, agent?.workspaceCwd);
    },
  );

  // Thread support: join threads on creation so we receive their messages
  client.on(Events.ThreadCreate, async (thread) => {
    if (!thread.joined) {
      try {
        await thread.join();
      } catch (err) {
        log.warn("discord-bot", `Failed to join thread ${thread.id}:`, err);
      }
    }
  });

  // Message handler
  client.on(Events.MessageCreate, async (message) => {
    try {
      // Ignore messages from bots (including ourselves)
      if (message.author.bot) return;

      // Only handle channels that support sending messages
      if (!("send" in message.channel)) return;

      // Determine channel and thread context
      const isThread = message.channel.isThread();
      const channelId = isThread
        ? ("parentId" in message.channel ? (message.channel.parentId ?? message.channelId) : message.channelId)
        : message.channelId;
      const threadId = isThread ? message.channelId : undefined;

      // Look up binding for this channel
      const binding = resolveDiscordBinding(channelId, discordConfig.bindings);
      if (!binding) return;

      // Mention gating for channel bindings
      if (!shouldRespondInDiscord(binding, client.user!.id, message)) return;

      const key = discordSessionKey(channelId, threadId);
      const prefix = buildDiscordSourcePrefix(binding, message.author);
      const channel = message.channel as unknown as DiscordSendableChannel;
      const adapter = createDiscordAdapter(channel, binding);

      // Collect image attachments
      const imageAttachments = [...message.attachments.values()].filter(
        (a) => isImageMimeType(a.contentType ?? undefined),
      );

      // Collect audio attachments (voice messages)
      const audioAttachments = [...message.attachments.values()].filter(
        (a) => a.contentType?.startsWith("audio/"),
      );

      // Handle text + image attachments
      if (imageAttachments.length > 0) {
        for (let i = 0; i < imageAttachments.length; i++) {
          const attachment = imageAttachments[i];
          messagesReceived.inc({ type: "photo" });
          let tempPath: string | null = null;
          try {
            const ext = attachment.name?.match(/\.(\w+)$/)?.[0] ?? ".jpg";
            tempPath = tempFilePath("discord-img", ext);
            await downloadFile(attachment.url, tempPath);

            // Only include caption text with the first image to avoid duplication
            const caption = i === 0 ? (message.content ?? "") : "";
            const messageText = caption.trimEnd()
              ? `${prefix}${caption.trimEnd()}\n\n${tempPath}`
              : `${prefix}${tempPath}`;

            const pathToClean = tempPath;
            tempPath = null;
            messageQueue.enqueue(key, binding.agentId, messageText, adapter, () => {
              cleanupTempFile(pathToClean);
            });
          } catch (err) {
            log.error("discord-bot", `Image attachment error in ${channelId}:`, err);
            if (tempPath) await cleanupTempFile(tempPath);
          }
        }
      } else if (audioAttachments.length > 0) {
        // Handle voice/audio attachments
        for (const attachment of audioAttachments) {
          messagesReceived.inc({ type: "voice" });
          let tempPath: string | null = null;
          try {
            const ext = attachment.name?.match(/\.(\w+)$/)?.[0] ?? ".ogg";
            tempPath = tempFilePath("discord-voice", ext);
            await downloadFile(attachment.url, tempPath);

            const transcript = await transcribeAudio(tempPath);
            if (!transcript) {
              await message.reply("Could not transcribe voice message (empty result).").catch(() => {});
              continue;
            }

            messageQueue.enqueue(
              key,
              binding.agentId,
              `${prefix}[Voice message] ${transcript}`,
              adapter,
            );
          } catch (err) {
            log.error("discord-bot", `Voice transcription error in ${channelId}:`, err);
            await message.reply("Failed to transcribe voice message. Please try again or send text.").catch(() => {});
          } finally {
            if (tempPath) await cleanupTempFile(tempPath);
          }
        }
      } else if (message.content) {
        // Plain text message (no relevant attachments)
        messagesReceived.inc({ type: "text" });
        messageQueue.enqueue(key, binding.agentId, prefix + message.content, adapter);
      }
    } catch (err) {
      log.error("discord-bot", `Message handler error in ${message.channelId}:`, err);
    }
  });

  // Slash commands handler
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;

      const isThread = interaction.channel?.isThread() ?? false;
      const channelId = isThread && interaction.channel && "parentId" in interaction.channel
        ? (interaction.channel.parentId ?? interaction.channelId)
        : interaction.channelId;
      const threadId = isThread ? interaction.channelId : undefined;

      const binding = resolveDiscordBinding(channelId, discordConfig.bindings);
      if (!binding) {
        await interaction.reply({ content: "This channel is not configured.", ephemeral: true });
        return;
      }

      const key = discordSessionKey(channelId, threadId);

      switch (interaction.commandName) {
        case "start": {
          const agent = config.agents[binding.agentId];
          await interaction.reply(
            `Connected to agent "${binding.agentId}" (${agent?.model ?? "unknown"}). Send a message to start.`,
          );
          break;
        }
        case "reset": {
          messageQueue.clear(key);
          await sessionManager.closeSession(key);
          await interaction.reply("Session reset. Next message starts a fresh conversation.");
          break;
        }
        case "status": {
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

          const health = sessionManager.getSessionHealth(key);
          if (health) {
            const status = health.alive ? "alive" : "dead";
            const pidStr = health.pid !== null ? String(health.pid) : "n/a";
            const idleMins = Math.floor(health.idleMs / 60000);

            lines.push(`This session: agent "${health.agentId}", PID ${pidStr} (${status})`);

            if (health.processingMs !== null) {
              lines.push(`  Processing: ${Math.floor(health.processingMs / 1000)}s`);
            } else {
              lines.push(`  Idle: ${idleMins}m`);
            }

            if (health.lastSuccessAt !== null) {
              const agoMins = Math.floor((Date.now() - health.lastSuccessAt) / 60000);
              lines.push(`  Last success: ${agoMins}m ago`);
            } else {
              lines.push(`  Last success: none`);
            }

            lines.push(`  Restarts: ${health.restartCount}`);
          }

          await interaction.reply(lines.join("\n"));
          break;
        }
        default:
          await interaction.reply({ content: "Unknown command.", ephemeral: true });
          break;
      }
    } catch (err) {
      log.error("discord-bot", `Interaction handler error:`, err);
      if (interaction.isChatInputCommand() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "An internal error occurred.", ephemeral: true }).catch(() => {});
      }
    }
  });

  // Login and register slash commands
  await client.login(discordConfig.token);
  log.info("discord-bot", `Discord bot logged in as ${client.user!.tag}`);

  // Register guild-scoped slash commands (instant, no 1-hour propagation delay)
  const commands = [
    new SlashCommandBuilder().setName("start").setDescription("Start the bot"),
    new SlashCommandBuilder().setName("reset").setDescription("Reset current session"),
    new SlashCommandBuilder().setName("status").setDescription("Show bot status"),
  ];
  const rest = new REST().setToken(discordConfig.token);
  const guildIds = [...new Set(discordConfig.bindings.map((b) => b.guildId))];

  for (const guildId of guildIds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user!.id, guildId),
        { body: commands.map((c) => c.toJSON()) },
      );
      log.info("discord-bot", `Slash commands registered for guild ${guildId}`);
    } catch (err) {
      log.error("discord-bot", `Failed to register commands for guild ${guildId}:`, err);
    }
  }

  return { client, messageQueue };
}
