import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { BotConfig, AgentConfig, TelegramBinding, TopicOverride, SessionDefaults } from "./types.js";
import { log, parseLogLevel } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "config.yaml");

interface RawConfig {
  telegramTokenService?: string;
  agents?: Record<string, unknown>;
  bindings?: unknown[];
  sessionDefaults?: unknown;
  logLevel?: string;
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

  // Resolve Telegram token from Keychain
  const tokenService = raw.telegramTokenService;
  if (typeof tokenService !== "string") {
    throw new Error("Missing telegramTokenService in config");
  }
  const telegramToken = resolveKeychainSecret(tokenService);

  // Validate agents
  if (!raw.agents || typeof raw.agents !== "object") {
    throw new Error("Missing agents in config");
  }
  const agents: Record<string, AgentConfig> = {};
  for (const [id, agentRaw] of Object.entries(raw.agents)) {
    agents[id] = validateAgent(agentRaw, id);
  }

  // Validate bindings
  if (!Array.isArray(raw.bindings) || raw.bindings.length === 0) {
    throw new Error("Missing or empty bindings in config");
  }
  const bindings = raw.bindings.map((b, i) => {
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

  const sessionDefaults = validateSessionDefaults(raw.sessionDefaults);

  // Log level: env var overrides config file
  const logLevel = parseLogLevel(process.env.LOG_LEVEL) ?? parseLogLevel(raw.logLevel);

  return { telegramToken, agents, bindings, sessionDefaults, logLevel };
}

// CLI: validate config
if (process.argv.includes("--validate")) {
  try {
    const config = loadConfig();
    log.info("config", "Config valid.");
    log.info("config", `  Agents: ${Object.keys(config.agents).join(", ")}`);
    log.info("config", `  Bindings: ${config.bindings.length}`);
    log.info("config", `  Token: ${config.telegramToken.slice(0, 10)}...`);
    log.info("config", `  Idle timeout: ${config.sessionDefaults.idleTimeoutMs}ms`);
    log.info("config", `  Max sessions: ${config.sessionDefaults.maxConcurrentSessions}`);
  } catch (e) {
    log.error("config", `Config validation failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
