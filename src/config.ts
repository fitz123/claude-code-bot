import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { BotConfig, AgentConfig, TelegramBinding, TopicOverride, SessionDefaults, DiscordBinding, DiscordChannelOverride, DiscordConfig } from "./types.js";
import { log, parseLogLevel } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "config.yaml");

interface RawConfig {
  telegramTokenService?: string;
  agents?: Record<string, unknown>;
  bindings?: unknown[];
  sessionDefaults?: unknown;
  logLevel?: string;
  metricsPort?: number;
  discord?: {
    tokenService?: string;
    bindings?: unknown[];
  };
}

function resolveKeychainSecret(service: string): string {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    throw new Error(`Failed to read Keychain service: ${service}`);
  }
}

function validateAgent(raw: unknown, id: string): AgentConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Agent "${id}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.workspaceCwd !== "string") {
    throw new Error(`Agent "${id}" missing workspaceCwd`);
  }
  if (typeof obj.model !== "string") {
    throw new Error(`Agent "${id}" missing model`);
  }
  return {
    id: String(obj.id ?? id),
    workspaceCwd: obj.workspaceCwd,
    model: obj.model,
    fallbackModel: typeof obj.fallbackModel === "string" ? obj.fallbackModel : undefined,
    systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : undefined,
    allowedTools: Array.isArray(obj.allowedTools) ? obj.allowedTools.map(String) : undefined,
    maxTurns: typeof obj.maxTurns === "number" ? obj.maxTurns : undefined,
    effort: typeof obj.effort === "string" && ["low", "medium", "high"].includes(obj.effort)
      ? (obj.effort as AgentConfig["effort"])
      : undefined,
  };
}

function validateBinding(raw: unknown, index: number): TelegramBinding {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Binding[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.chatId !== "number") {
    throw new Error(`Binding[${index}] missing chatId (number)`);
  }
  if (typeof obj.agentId !== "string") {
    throw new Error(`Binding[${index}] missing agentId`);
  }
  if (obj.kind !== "dm" && obj.kind !== "group") {
    throw new Error(`Binding[${index}] has invalid kind "${String(obj.kind)}" (must be "dm" or "group")`);
  }
  const kind = obj.kind;
  if (obj.topics !== undefined && kind !== "group") {
    throw new Error(`Binding[${index}] has topics but kind is "${kind}" (topics are only valid for groups)`);
  }
  if (obj.topicId !== undefined && obj.topics !== undefined) {
    throw new Error(`Binding[${index}] cannot have both topicId and topics`);
  }
  return {
    chatId: obj.chatId,
    agentId: obj.agentId,
    kind,
    topicId: typeof obj.topicId === "number" ? obj.topicId : undefined,
    label: typeof obj.label === "string" ? obj.label : undefined,
    requireMention: typeof obj.requireMention === "boolean" ? obj.requireMention : undefined,
    topics: validateTopics(obj.topics, index),
    voiceTranscriptEcho: typeof obj.voiceTranscriptEcho === "boolean" ? obj.voiceTranscriptEcho : undefined,
    streamingUpdates: typeof obj.streamingUpdates === "boolean" ? obj.streamingUpdates : undefined,
    typingIndicator: typeof obj.typingIndicator === "boolean" ? obj.typingIndicator : undefined,
  };
}

function validateTopics(raw: unknown, bindingIndex: number): TopicOverride[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`Binding[${bindingIndex}].topics must be an array`);
  }
  return raw.map((t, i) => {
    if (typeof t !== "object" || t === null) {
      throw new Error(`Binding[${bindingIndex}].topics[${i}] must be an object`);
    }
    const obj = t as Record<string, unknown>;
    if (typeof obj.topicId !== "number") {
      throw new Error(`Binding[${bindingIndex}].topics[${i}] missing topicId (number)`);
    }
    return {
      topicId: obj.topicId,
      agentId: typeof obj.agentId === "string" ? obj.agentId : undefined,
      requireMention: typeof obj.requireMention === "boolean" ? obj.requireMention : undefined,
    };
  });
}

export function validateDiscordChannels(raw: unknown, bindingIndex: number): DiscordChannelOverride[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`discord.bindings[${bindingIndex}].channels must be an array`);
  }
  return raw.map((c, i) => {
    if (typeof c !== "object" || c === null) {
      throw new Error(`discord.bindings[${bindingIndex}].channels[${i}] must be an object`);
    }
    const obj = c as Record<string, unknown>;
    if (typeof obj.channelId !== "string") {
      throw new Error(`discord.bindings[${bindingIndex}].channels[${i}] missing channelId (string)`);
    }
    return {
      channelId: obj.channelId,
      agentId: typeof obj.agentId === "string" ? obj.agentId : undefined,
      label: typeof obj.label === "string" ? obj.label : undefined,
      requireMention: typeof obj.requireMention === "boolean" ? obj.requireMention : undefined,
      streamingUpdates: typeof obj.streamingUpdates === "boolean" ? obj.streamingUpdates : undefined,
      typingIndicator: typeof obj.typingIndicator === "boolean" ? obj.typingIndicator : undefined,
    };
  });
}

export function validateDiscordBinding(raw: unknown, index: number): DiscordBinding {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`discord.bindings[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.guildId !== "string") {
    throw new Error(`discord.bindings[${index}] missing guildId (string)`);
  }
  if (typeof obj.agentId !== "string") {
    throw new Error(`discord.bindings[${index}] missing agentId`);
  }
  if (obj.kind !== "dm" && obj.kind !== "channel") {
    throw new Error(`discord.bindings[${index}] has invalid kind "${String(obj.kind)}" (must be "dm" or "channel")`);
  }
  if (obj.channelId !== undefined && typeof obj.channelId !== "string") {
    throw new Error(`discord.bindings[${index}] channelId must be a string if provided`);
  }
  if (obj.channels !== undefined && obj.channelId !== undefined) {
    throw new Error(`discord.bindings[${index}] cannot have both channelId and channels`);
  }
  return {
    channelId: typeof obj.channelId === "string" ? obj.channelId : undefined,
    guildId: obj.guildId,
    agentId: obj.agentId,
    kind: obj.kind,
    label: typeof obj.label === "string" ? obj.label : undefined,
    requireMention: typeof obj.requireMention === "boolean" ? obj.requireMention : undefined,
    streamingUpdates: typeof obj.streamingUpdates === "boolean" ? obj.streamingUpdates : undefined,
    typingIndicator: typeof obj.typingIndicator === "boolean" ? obj.typingIndicator : undefined,
    channels: validateDiscordChannels(obj.channels, index),
  };
}

function validateDiscordConfig(raw: RawConfig["discord"], agents: Record<string, AgentConfig>): DiscordConfig | undefined {
  if (!raw) return undefined;
  if (typeof raw.tokenService !== "string") {
    throw new Error("discord.tokenService must be a string");
  }
  const token = resolveKeychainSecret(raw.tokenService);
  if (!Array.isArray(raw.bindings) || raw.bindings.length === 0) {
    throw new Error("discord.bindings must be a non-empty array");
  }
  const bindings = raw.bindings.map((b, i) => {
    const binding = validateDiscordBinding(b, i);
    if (!agents[binding.agentId]) {
      throw new Error(`discord.bindings[${i}] references unknown agent "${binding.agentId}"`);
    }
    if (binding.channels) {
      for (const [j, channel] of binding.channels.entries()) {
        if (channel.agentId && !agents[channel.agentId]) {
          throw new Error(`discord.bindings[${i}].channels[${j}] references unknown agent "${channel.agentId}"`);
        }
      }
    }
    return binding;
  });
  return { token, bindings };
}

function validateSessionDefaults(raw: unknown): SessionDefaults {
  if (typeof raw !== "object" || raw === null) {
    return { idleTimeoutMs: 900000, maxConcurrentSessions: 3 };
  }
  const obj = raw as Record<string, unknown>;
  return {
    idleTimeoutMs: typeof obj.idleTimeoutMs === "number" ? obj.idleTimeoutMs : 900000,
    maxConcurrentSessions: typeof obj.maxConcurrentSessions === "number" ? obj.maxConcurrentSessions : 3,
  };
}

export function loadConfig(configPath?: string): BotConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const raw: RawConfig = parseYaml(readFileSync(path, "utf8"));

  if (!raw || typeof raw !== "object") {
    throw new Error("Config file is empty or invalid");
  }

  // Validate agents (needed before validating bindings)
  if (!raw.agents || typeof raw.agents !== "object") {
    throw new Error("Missing agents in config");
  }
  const agents: Record<string, AgentConfig> = {};
  for (const [id, agentRaw] of Object.entries(raw.agents)) {
    agents[id] = validateAgent(agentRaw, id);
  }

  // Resolve Telegram token from Keychain (optional — not needed for Discord-only setups)
  let telegramToken: string | undefined;
  if (typeof raw.telegramTokenService === "string") {
    telegramToken = resolveKeychainSecret(raw.telegramTokenService);
  }

  // Validate Telegram bindings (optional if Discord is configured)
  let bindings: TelegramBinding[] = [];
  if (Array.isArray(raw.bindings) && raw.bindings.length > 0) {
    if (!telegramToken) {
      throw new Error("Telegram bindings require telegramTokenService");
    }
    bindings = raw.bindings.map((b, i) => {
      const binding = validateBinding(b, i);
      if (!agents[binding.agentId]) {
        throw new Error(`Binding[${i}] references unknown agent "${binding.agentId}"`);
      }
      if (binding.topics) {
        for (const [j, topic] of binding.topics.entries()) {
          if (topic.agentId && !agents[topic.agentId]) {
            throw new Error(`Binding[${i}].topics[${j}] references unknown agent "${topic.agentId}"`);
          }
        }
      }
      return binding;
    });
  }

  // Validate Discord config (optional)
  const discord = validateDiscordConfig(raw.discord, agents);

  // At least one platform must be configured
  if (bindings.length === 0 && !discord) {
    throw new Error("At least one platform must be configured (Telegram bindings or discord section)");
  }

  const sessionDefaults = validateSessionDefaults(raw.sessionDefaults);

  // Log level: env var overrides config file
  const logLevel = parseLogLevel(process.env.LOG_LEVEL) ?? parseLogLevel(raw.logLevel);

  // Metrics port (optional — if not set, metrics endpoint is disabled)
  let metricsPort: number | undefined;
  if (typeof raw.metricsPort === "number") {
    if (!Number.isInteger(raw.metricsPort) || raw.metricsPort < 1 || raw.metricsPort > 65535) {
      throw new Error(`Invalid metricsPort: ${raw.metricsPort} (must be an integer between 1 and 65535)`);
    }
    metricsPort = raw.metricsPort;
  }

  return { telegramToken, agents, bindings, sessionDefaults, logLevel, metricsPort, discord };
}

// CLI: validate config
if (process.argv.includes("--validate")) {
  try {
    const config = loadConfig();
    log.info("config", "Config valid.");
    log.info("config", `  Agents: ${Object.keys(config.agents).join(", ")}`);
    log.info("config", `  Telegram bindings: ${config.bindings.length}`);
    if (config.telegramToken) {
      log.info("config", `  Telegram token: ${config.telegramToken.slice(0, 10)}...`);
    }
    if (config.discord) {
      log.info("config", `  Discord bindings: ${config.discord.bindings.length}`);
      log.info("config", `  Discord token: ${config.discord.token.slice(0, 10)}...`);
    }
    log.info("config", `  Idle timeout: ${config.sessionDefaults.idleTimeoutMs}ms`);
    log.info("config", `  Max sessions: ${config.sessionDefaults.maxConcurrentSessions}`);
  } catch (e) {
    log.error("config", `Config validation failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
