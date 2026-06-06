import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { BotConfig, AgentConfig, TelegramBinding, TopicOverride, SessionDefaults, DiscordBinding, DiscordChannelOverride, DiscordConfig } from "./types.js";
import { log, parseLogLevel } from "./logger.js";
import { DEFAULT_MAX_MEDIA_BYTES } from "./media-store.js";
import { resolveSecret, sopsExtractExpression, type ExecFileSyncLike } from "./secrets.js";
import { resolveAgentWorkspaceCwd, resolveWorkspaceContract } from "./workspace-contract.js";

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const CONFIGURED_SECRET_PLACEHOLDER = "[configured]";
const LEGACY_TELEGRAM_SERVICE_KEY_RE = /^telegramToken[Ss]ervice$/;
const LEGACY_DISCORD_SERVICE_KEY_RE = /^token[Ss]ervice$/;

export function resolveConfigPath(configPath?: string): string {
  return configPath === undefined
    ? resolveWorkspaceContract().paths.configPath
    : resolve(configPath);
}

// Derive the .local counterpart path: config.yaml → config.local.yaml
function deriveLocalConfigPath(configPath: string): string {
  return configPath.replace(/\.yaml$/, ".local.yaml");
}

// Keys that must never be copied during merge to prevent prototype pollution.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Deep-merge two plain objects. Local values win. Arrays are replaced entirely.
export function mergeDeep(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      typeof overrideVal === "object" &&
      overrideVal !== null &&
      !Array.isArray(overrideVal) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = mergeDeep(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

// Load config.yaml and merge config.local.yaml on top if it exists.
// Exported for use by cron-runner.ts and tests.
export function loadRawMergedConfig(configPath?: string): Record<string, unknown> {
  const path = resolveConfigPath(configPath);
  const base = (parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>) ?? {};
  const localPath = deriveLocalConfigPath(path);
  if (existsSync(localPath)) {
    const local = (parseYaml(readFileSync(localPath, "utf8")) as Record<string, unknown>) ?? {};
    return mergeDeep(base, local);
  }
  return base;
}

interface RawConfig {
  secrets?: {
    sopsFile?: string;
  };
  telegramTokenSopsKey?: string;
  telegramTokenEnv?: string;
  agents?: Record<string, unknown>;
  bindings?: unknown[];
  sessionDefaults?: unknown;
  logLevel?: string;
  metricsPort?: number;
  metricsHost?: string;
  discord?: {
    tokenSopsKey?: string;
    tokenEnv?: string;
    bindings?: unknown[];
  };
  adminChatId?: number;
  defaultDeliveryChatId?: number;
  defaultDeliveryThreadId?: number;
  defaultModel?: unknown;
  defaultFallbackModel?: unknown;
}

interface LoadConfigOptions {
  resolveSecrets?: boolean;
  secretExecFileSync?: ExecFileSyncLike;
  workspaceRoot?: string;
}

export function resolveConfigWorkspaceRoot(configPath?: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    return resolve(workspaceRoot);
  }
  const contract = resolveWorkspaceContract();
  if (configPath === undefined || resolveConfigPath(configPath) === contract.paths.configPath) {
    return contract.paths.workspaceRoot;
  }
  return dirname(resolveConfigPath(configPath));
}

export function validateAgent(
  raw: unknown,
  id: string,
  defaultModel?: string,
  workspaceRoot?: string,
): AgentConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Agent "${id}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.workspaceCwd !== "string") {
    throw new Error(`Agent "${id}" missing workspaceCwd`);
  }
  if (obj.model !== undefined && typeof obj.model !== "string") {
    throw new Error(`Agent "${id}" has invalid model (must be a string)`);
  }
  if (obj.provider === "claude") {
    throw new Error(
      `Agent "${id}" uses provider "claude", but the Claude runtime has been removed; remove provider or set provider: "pi"`,
    );
  }
  if (obj.provider !== undefined && obj.provider !== "pi") {
    throw new Error(`Agent "${id}" has invalid provider "${String(obj.provider)}" (must be "pi"; Claude runtime was removed)`);
  }
  // Pi is now the only runtime, and Pi agents require explicit model pins.
  // Keep validating defaultModel for old configs, but do not inherit it here.
  if (obj.model === undefined) {
    const defaultHint = defaultModel !== undefined ? "; top-level defaultModel is no longer inherited by Pi agents" : "";
    throw new Error(`Agent "${id}" missing model (Pi agents must set an explicit model${defaultHint})`);
  }
  const model = obj.model;
  if (obj.fallbackModel !== undefined) {
    throw new Error(
      `Agent "${id}" uses fallbackModel, but fallback models were removed with the Claude runtime; remove fallbackModel`,
    );
  }
  if (obj.effort !== undefined) {
    throw new Error(
      `Agent "${id}" uses effort, but effort was replaced by Pi thinking; use thinking: off|minimal|low|medium|high|xhigh`,
    );
  }
  if (obj.maxTurns !== undefined) {
    throw new Error(
      `Agent "${id}" uses maxTurns, but Pi sessions do not support this setting; remove maxTurns`,
    );
  }
  if (obj.allowedTools !== undefined) {
    throw new Error(
      `Agent "${id}" uses allowedTools, but Pi sessions do not support this setting; remove allowedTools`,
    );
  }
  if (
    obj.thinking !== undefined &&
    (typeof obj.thinking !== "string" || !PI_THINKING_LEVELS.includes(obj.thinking as typeof PI_THINKING_LEVELS[number]))
  ) {
    throw new Error(
      `Agent "${id}" has invalid thinking "${String(obj.thinking)}" (must be one of: ${PI_THINKING_LEVELS.join(", ")})`,
    );
  }
  return {
    id: String(obj.id ?? id),
    workspaceCwd: workspaceRoot === undefined
      ? obj.workspaceCwd
      : resolveAgentWorkspaceCwd(workspaceRoot, obj.workspaceCwd),
    model,
    systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : undefined,
    thinking: obj.thinking as AgentConfig["thinking"] | undefined,
    provider: "pi",
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
  if (obj.kind === "dm" && obj.channelId === undefined) {
    throw new Error(`discord.bindings[${index}] kind "dm" requires channelId`);
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
    typingIndicator: typeof obj.typingIndicator === "boolean" ? obj.typingIndicator : undefined,
    channels: validateDiscordChannels(obj.channels, index),
  };
}

function validateDiscordConfig(
  raw: RawConfig["discord"],
  agents: Record<string, AgentConfig>,
  sopsFile: string | undefined,
  options: LoadConfigOptions = {},
): DiscordConfig | undefined {
  if (!raw) return undefined;
  const legacyKey = findLegacyConfigKey(raw, LEGACY_DISCORD_SERVICE_KEY_RE);
  if (legacyKey) {
    throw new Error(
      `discord.${legacyKey} is no longer supported; migrate to discord.tokenSopsKey with secrets.sopsFile or discord.tokenEnv`,
    );
  }
  const tokenSopsKey = optionalConfigString(raw.tokenSopsKey, "discord.tokenSopsKey");
  const tokenEnv = optionalConfigString(raw.tokenEnv, "discord.tokenEnv");
  validateConfiguredSopsSource(sopsFile, tokenSopsKey, "discord.tokenSopsKey");
  if (!tokenSopsKey && !tokenEnv) {
    throw new Error("discord requires a token source (discord.tokenSopsKey with secrets.sopsFile, or discord.tokenEnv)");
  }
  const token = options.resolveSecrets === false
    ? CONFIGURED_SECRET_PLACEHOLDER
    : resolveSecret({
      sopsFile,
      sopsKey: tokenSopsKey,
      envVar: tokenEnv,
      fieldName: "discord.token",
      execFileSync: options.secretExecFileSync,
    });
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

export function validateSessionDefaults(raw: unknown): SessionDefaults {
  if (typeof raw !== "object" || raw === null) {
    return { idleTimeoutMs: 3600000, maxConcurrentSessions: 12, maxMessageAgeMs: 600000, requireMention: true, maxMediaBytes: DEFAULT_MAX_MEDIA_BYTES };
  }
  const obj = raw as Record<string, unknown>;

  let idleTimeoutMs = 3600000;
  if (typeof obj.idleTimeoutMs === "number") {
    if (!Number.isFinite(obj.idleTimeoutMs) || obj.idleTimeoutMs <= 0) {
      throw new Error(`Invalid idleTimeoutMs: ${obj.idleTimeoutMs} (must be a finite positive number)`);
    }
    idleTimeoutMs = obj.idleTimeoutMs;
  }

  let maxConcurrentSessions = 12;
  if (typeof obj.maxConcurrentSessions === "number") {
    if (!Number.isInteger(obj.maxConcurrentSessions) || obj.maxConcurrentSessions <= 0) {
      throw new Error(`Invalid maxConcurrentSessions: ${obj.maxConcurrentSessions} (must be a positive integer)`);
    }
    maxConcurrentSessions = obj.maxConcurrentSessions;
  }

  let maxMessageAgeMs = 600000;
  if (typeof obj.maxMessageAgeMs === "number") {
    if (!Number.isFinite(obj.maxMessageAgeMs) || obj.maxMessageAgeMs <= 0) {
      throw new Error(`Invalid maxMessageAgeMs: ${obj.maxMessageAgeMs} (must be a finite positive number)`);
    }
    maxMessageAgeMs = obj.maxMessageAgeMs;
  }

  let requireMention = true;
  if (obj.requireMention !== undefined) {
    if (typeof obj.requireMention !== "boolean") {
      throw new Error(`Invalid requireMention: ${obj.requireMention} (must be a boolean)`);
    }
    requireMention = obj.requireMention;
  }

  let maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES;
  if (obj.maxMediaBytes !== undefined) {
    if (typeof obj.maxMediaBytes !== "number" || !Number.isFinite(obj.maxMediaBytes) || obj.maxMediaBytes <= 0) {
      throw new Error(`Invalid maxMediaBytes: ${obj.maxMediaBytes} (must be a finite positive number)`);
    }
    maxMediaBytes = obj.maxMediaBytes;
  }

  return { idleTimeoutMs, maxConcurrentSessions, maxMessageAgeMs, requireMention, maxMediaBytes };
}

function optionalConfigString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function resolveConfiguredSopsFile(raw: RawConfig, controlWorkspaceRoot: string): string | undefined {
  if (raw.secrets === undefined) return undefined;
  if (typeof raw.secrets !== "object" || raw.secrets === null || Array.isArray(raw.secrets)) {
    throw new Error("secrets must be an object");
  }
  const sopsFile = optionalConfigString(raw.secrets.sopsFile, "secrets.sopsFile");
  if (!sopsFile) return undefined;
  return resolve(controlWorkspaceRoot, sopsFile);
}

function validateConfiguredSopsSource(
  sopsFile: string | undefined,
  sopsKey: string | undefined,
  fieldName: string,
): void {
  if (!sopsKey) return;
  try {
    sopsExtractExpression(sopsKey);
  } catch {
    throw new Error(`${fieldName} must be a dot path with segments matching [A-Za-z0-9_-]+`);
  }
  if (!sopsFile) {
    throw new Error(`${fieldName} requires secrets.sopsFile`);
  }
}

function findLegacyConfigKey(raw: object, keyPattern: RegExp): string | undefined {
  return Object.keys(raw).find((key) => keyPattern.test(key));
}

export function loadTelegramToken(configPath?: string, options: LoadConfigOptions = {}): string {
  const raw: RawConfig = loadRawMergedConfig(configPath) as RawConfig;
  const workspaceRoot = resolveConfigWorkspaceRoot(configPath, options.workspaceRoot);
  const sopsFile = resolveConfiguredSopsFile(raw, workspaceRoot);
  const legacyTelegramKey = findLegacyConfigKey(raw, LEGACY_TELEGRAM_SERVICE_KEY_RE);
  if (legacyTelegramKey) {
    throw new Error(
      `${legacyTelegramKey} is no longer supported; migrate to telegramTokenSopsKey with secrets.sopsFile or telegramTokenEnv`,
    );
  }
  const telegramTokenSopsKey = optionalConfigString(raw.telegramTokenSopsKey, "telegramTokenSopsKey");
  const telegramTokenEnv = optionalConfigString(raw.telegramTokenEnv, "telegramTokenEnv");
  validateConfiguredSopsSource(sopsFile, telegramTokenSopsKey, "telegramTokenSopsKey");
  if (!telegramTokenSopsKey && !telegramTokenEnv) {
    throw new Error("Telegram delivery requires a token source (telegramTokenSopsKey with secrets.sopsFile, or telegramTokenEnv)");
  }
  return options.resolveSecrets === false
    ? CONFIGURED_SECRET_PLACEHOLDER
    : resolveSecret({
      sopsFile,
      sopsKey: telegramTokenSopsKey,
      envVar: telegramTokenEnv,
      fieldName: "telegramToken",
      execFileSync: options.secretExecFileSync,
    });
}

export function loadConfig(configPath?: string, options: LoadConfigOptions = {}): BotConfig {
  const raw: RawConfig = loadRawMergedConfig(configPath) as RawConfig;
  const resolveSecrets = options.resolveSecrets !== false;
  const workspaceRoot = resolveConfigWorkspaceRoot(configPath, options.workspaceRoot);

  if (!raw || typeof raw !== "object") {
    throw new Error("Config file is empty or invalid");
  }
  const sopsFile = resolveConfiguredSopsFile(raw, workspaceRoot);

  // Validate top-level defaults for migration clarity. Agents no longer inherit
  // defaultModel now that Pi is the only runtime.
  if (raw.defaultModel !== undefined && typeof raw.defaultModel !== "string") {
    throw new Error(`Invalid defaultModel: must be a string`);
  }
  if (raw.defaultFallbackModel !== undefined) {
    throw new Error(`defaultFallbackModel was removed with the Claude runtime; remove defaultFallbackModel`);
  }
  const defaultModel = typeof raw.defaultModel === "string" ? raw.defaultModel : undefined;

  // Validate agents (needed before validating bindings)
  if (!raw.agents || typeof raw.agents !== "object") {
    throw new Error("Missing agents in config");
  }
  const agents: Record<string, AgentConfig> = {};
  for (const [id, agentRaw] of Object.entries(raw.agents)) {
    agents[id] = validateAgent(agentRaw, id, defaultModel, workspaceRoot);
  }

  // Resolve Telegram token from configured non-interactive secret sources.
  // Optional — not needed for Discord-only setups.
  const legacyTelegramKey = findLegacyConfigKey(raw, LEGACY_TELEGRAM_SERVICE_KEY_RE);
  if (legacyTelegramKey) {
    throw new Error(
      `${legacyTelegramKey} is no longer supported; migrate to telegramTokenSopsKey with secrets.sopsFile or telegramTokenEnv`,
    );
  }
  const telegramTokenSopsKey = optionalConfigString(raw.telegramTokenSopsKey, "telegramTokenSopsKey");
  const telegramTokenEnv = optionalConfigString(raw.telegramTokenEnv, "telegramTokenEnv");
  validateConfiguredSopsSource(sopsFile, telegramTokenSopsKey, "telegramTokenSopsKey");
  const rawTelegramBindings = Array.isArray(raw.bindings) ? raw.bindings : [];
  const hasTelegramBindings = rawTelegramBindings.length > 0;
  let telegramToken: string | undefined;
  if (hasTelegramBindings && (telegramTokenSopsKey || telegramTokenEnv)) {
    telegramToken = resolveSecrets
      ? resolveSecret({
        sopsFile,
        sopsKey: telegramTokenSopsKey,
        envVar: telegramTokenEnv,
        fieldName: "telegramToken",
        execFileSync: options.secretExecFileSync,
      })
      : CONFIGURED_SECRET_PLACEHOLDER;
  }

  // Validate Telegram bindings (optional if Discord is configured)
  let bindings: TelegramBinding[] = [];
  if (hasTelegramBindings) {
    if (!telegramToken) {
      throw new Error("Telegram bindings require a token source (telegramTokenSopsKey with secrets.sopsFile, or telegramTokenEnv)");
    }
    bindings = rawTelegramBindings.map((b, i) => {
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
  const discord = validateDiscordConfig(raw.discord, agents, sopsFile, options);

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

  // Metrics listen host (optional — defaults to "127.0.0.1" in startMetricsServer).
  // Set to "0.0.0.0" when scrape source is reachable only via a non-loopback
  // interface (e.g. on Linux when Prometheus container scrapes via
  // host.docker.internal — that resolves to docker bridge gateway, not loopback).
  // Firewall must restrict external access separately.
  let metricsHost: string | undefined;
  if (raw.metricsHost !== undefined) {
    if (typeof raw.metricsHost !== "string" || raw.metricsHost.trim() === "") {
      throw new Error(`Invalid metricsHost: must be a non-empty string`);
    }
    metricsHost = raw.metricsHost.trim();
  }

  // adminChatId (optional — used by cron-runner for delivery failure notifications)
  let adminChatId: number | undefined;
  if (raw.adminChatId !== undefined) {
    if (!Number.isInteger(raw.adminChatId) || raw.adminChatId === 0) {
      throw new Error(`Invalid adminChatId: ${raw.adminChatId} (must be a non-zero integer)`);
    }
    adminChatId = raw.adminChatId;
  }

  // defaultDeliveryChatId (optional — used by cron-runner as fallback delivery target)
  let defaultDeliveryChatId: number | undefined;
  if (raw.defaultDeliveryChatId !== undefined) {
    if (!Number.isInteger(raw.defaultDeliveryChatId) || raw.defaultDeliveryChatId === 0) {
      throw new Error(`Invalid defaultDeliveryChatId: ${raw.defaultDeliveryChatId} (must be a non-zero integer)`);
    }
    defaultDeliveryChatId = raw.defaultDeliveryChatId;
  }

  // defaultDeliveryThreadId (optional — used with defaultDeliveryChatId)
  let defaultDeliveryThreadId: number | undefined;
  if (raw.defaultDeliveryThreadId !== undefined) {
    if (!Number.isInteger(raw.defaultDeliveryThreadId) || raw.defaultDeliveryThreadId === 0) {
      throw new Error(`Invalid defaultDeliveryThreadId: ${raw.defaultDeliveryThreadId} (must be a non-zero integer)`);
    }
    defaultDeliveryThreadId = raw.defaultDeliveryThreadId;
  }

  return { telegramToken, agents, bindings, sessionDefaults, logLevel, metricsPort, metricsHost, discord, adminChatId, defaultDeliveryChatId, defaultDeliveryThreadId };
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDirectEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined
    && realpathOrResolve(entrypoint) === realpathOrResolve(fileURLToPath(import.meta.url));
}

// CLI: validate config
const validateWithoutSecrets = process.argv.includes("--validate-structure") || process.argv.includes("--no-resolve-secrets");
if (isDirectEntrypoint() && (process.argv.includes("--validate") || validateWithoutSecrets)) {
  try {
    const config = loadConfig(undefined, { resolveSecrets: !validateWithoutSecrets });
    log.info("config", "Config valid.");
    log.info("config", `  Agents: ${Object.keys(config.agents).join(", ")}`);
    log.info("config", `  Telegram bindings: ${config.bindings.length}`);
    if (config.telegramToken) {
      log.info("config", "  Telegram token: configured");
    }
    if (config.discord) {
      log.info("config", `  Discord bindings: ${config.discord.bindings.length}`);
      log.info("config", "  Discord token: configured");
    }
    log.info("config", `  Idle timeout: ${config.sessionDefaults.idleTimeoutMs}ms`);
    log.info("config", `  Max sessions: ${config.sessionDefaults.maxConcurrentSessions}`);
  } catch (e) {
    log.error("config", `Config validation failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
