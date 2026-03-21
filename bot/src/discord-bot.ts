import { Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { Message as DiscordMessage } from "discord.js";
import type { BotConfig, DiscordBinding, DiscordConfig } from "./types.js";
import { outboxDir, type SessionManager } from "./session-manager.js";
import { relayStream } from "./stream-relay.js";
import { MessageQueue } from "./message-queue.js";
import { createDiscordAdapter, type DiscordSendableChannel } from "./discord-adapter.js";
import { tempFilePath, downloadFile, transcribeAudio, cleanupTempFile } from "./voice.js";
import { log } from "./logger.js";
import { messagesReceived } from "./metrics.js";
import { isImageMimeType } from "./mime.js";
/** Check if a message is too old to process (same logic as telegram-bot.ts). */
function isStaleMessage(messageTimestampMs: number, maxAgeMs: number): boolean {
  return Date.now() - messageTimestampMs > maxAgeMs;
}

/**
 * Build a session key for Discord channels and threads.
 * Uses "discord:" prefix to avoid collisions with Telegram session keys.
 */
export function discordSessionKey(channelId: string, threadId?: string): string {
  const base = `discord:${channelId}`;
  return threadId ? `${base}:${threadId}` : base;
}

/**
 * Resolve a Discord channel to its binding config.
 * Resolution priority: exact channelId match → channel override from channels[] → guild-wide fallback.
 */
export function resolveDiscordBinding(
  channelId: string,
  bindings: DiscordBinding[],
  guildId?: string,
): DiscordBinding | undefined {
  let guildFallback: DiscordBinding | undefined;

  for (const b of bindings) {
    // Exact channelId match always wins
    if (b.channelId !== undefined && b.channelId === channelId) return b;

    // Guild-wide binding (no channelId) — candidate for fallback
    if (b.channelId === undefined && guildId !== undefined && b.guildId === guildId) {
      guildFallback ??= b;
    }
  }

  // Check channels[] array for per-channel overrides on the guild fallback
  if (guildFallback && guildFallback.channels) {
    const channel = guildFallback.channels.find((c) => c.channelId === channelId);
    if (channel) {
      const { channels: _, ...base } = guildFallback;
      return {
        ...base,
        channelId,
        agentId: channel.agentId ?? guildFallback.agentId,
        label: channel.label ?? guildFallback.label,
        requireMention: channel.requireMention ?? guildFallback.requireMention,
        streamingUpdates: channel.streamingUpdates ?? guildFallback.streamingUpdates,
        typingIndicator: channel.typingIndicator ?? guildFallback.typingIndicator,
      };
    }
  }

  if (guildFallback) {
    const { channels: _, ...base } = guildFallback;
    return base;
  }
  return undefined;
}

/**
 * Check whether the bot should respond to a message in a Discord channel.
 * Returns true for DMs, when requireMention is false, or when the bot is @mentioned.
 */
export function shouldRespondInDiscord(
  binding: DiscordBinding,
  botUserId: string,
  message: DiscordMessage,
  sessionDefaults?: { requireMention?: boolean },
): boolean {
  if (binding.kind === "dm") return true;
  const requireMention = binding.requireMention ?? sessionDefaults?.requireMention ?? false;
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
  timestampMs?: number,
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

  if (timestampMs !== undefined) {
    const d = new Date(timestampMs);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    parts.push(`${hh}:${mm}`);
  }

  return parts.length > 0 ? `[${parts.join(" | ")}]\n` : "";
}

export interface DiscordBotResult {
  client: Client;
  messageQueue: MessageQueue;
}

/**
 * Install error and lifecycle event handlers on the Discord client.
 * Prevents unhandled WebSocket errors from crashing the Node.js process.
 * Discord.js automatically reconnects after WebSocket failures if the
 * error event is caught — without these handlers, Node.js treats the
 * unhandled 'error' event as fatal and terminates.
 */
export function installDiscordErrorHandlers(client: Client): void {
  client.on(Events.Error, (error) => {
    log.error("discord-bot", "Client error:", error);
  });

  client.on(Events.ShardError, (error, shardId) => {
    log.error("discord-bot", `Shard ${shardId} error:`, error);
  });

  client.on(Events.Warn, (message) => {
    log.warn("discord-bot", `Warning: ${message}`);
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    log.info("discord-bot", `Shard ${shardId} reconnecting...`);
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    log.info("discord-bot", `Shard ${shardId} resumed (replayed ${replayedEvents} events)`);
  });
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

  // Install error handlers before anything else so WebSocket errors
  // during login or event handling don't crash the process
  installDiscordErrorHandlers(client);

  const maxMessageAgeMs = config.sessionDefaults.maxMessageAgeMs;

  const messageQueue = new MessageQueue(
    async (chatId, agentId, text, platform) => {
      const stream = sessionManager.sendSessionMessage(chatId, agentId, text);
      await relayStream(stream, platform, outboxDir(chatId));
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
      const binding = resolveDiscordBinding(channelId, discordConfig.bindings, message.guildId ?? undefined);
      if (!binding) { log.info("discord-bot", `No binding for channel ${channelId} (thread: ${threadId})`); return; }

      // Mention gating for channel bindings
      if (!shouldRespondInDiscord(binding, client.user!.id, message, config.sessionDefaults)) return;

      // Discard stale messages accumulated during bot downtime
      if (isStaleMessage(message.createdTimestamp, maxMessageAgeMs)) {
        log.debug("discord-bot", `Discarding stale message in ${channelId} (age: ${Math.round((Date.now() - message.createdTimestamp) / 1000)}s)`);
        return;
      }

      const key = discordSessionKey(channelId, threadId);
      const prefix = buildDiscordSourcePrefix(binding, message.author, message.createdTimestamp);
      // Strip bot mention syntax (<@botId>) from message content so Claude
      // doesn't receive raw snowflake IDs in every requireMention message
      const botMentionRe = new RegExp(`<@!?${client.user!.id}>\\s*`, "g");
      const channel = message.channel as unknown as DiscordSendableChannel;
      const adapter = createDiscordAdapter(channel, binding, config.sessionDefaults);

      // Collect image attachments (fall back to file extension when contentType is missing)
      const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp)$/i;
      const imageAttachments = [...message.attachments.values()].filter(
        (a) => isImageMimeType(a.contentType ?? undefined) || (!a.contentType && IMAGE_EXTENSIONS.test(a.name ?? "")),
      );

      // Collect audio attachments (fall back to file extension when contentType is missing)
      const AUDIO_EXTENSIONS = /\.(ogg|mp3|wav|m4a|aac|opus|oga|flac)$/i;
      const audioAttachments = [...message.attachments.values()].filter(
        (a) => a.contentType?.startsWith("audio/") || (!a.contentType && AUDIO_EXTENSIONS.test(a.name ?? "")),
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
            const caption = i === 0 ? (message.content ?? "").replace(botMentionRe, "").trim() : "";
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
        const cleanContent = message.content.replace(botMentionRe, "").trim();
        if (cleanContent) {
          messagesReceived.inc({ type: "text" });
          messageQueue.enqueue(key, binding.agentId, prefix + cleanContent, adapter);
        }
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

      const binding = resolveDiscordBinding(channelId, discordConfig.bindings, interaction.guildId ?? undefined);
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
        // Session lifecycle: create → compact → reset → resume. The reset
        // kills the Claude subprocess but the session file (with compacted
        // conversation history) remains on disk. When the next message arrives,
        // getOrCreateSession() finds the file and resumes with --resume, so
        // prior context may be partially retained through the compaction summary.
        case "reset": {
          messageQueue.clear(key);
          await sessionManager.closeSession(key);
          await interaction.reply("Session restarted. Prior context may be partially retained.");
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
            lines.push(`  Session ID: ${health.sessionId}`);

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
