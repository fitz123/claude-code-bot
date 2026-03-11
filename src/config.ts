import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { BotConfig, AgentConfig, TelegramBinding, SessionDefaults } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "config.yaml");

interface RawConfig {
  telegramTokenService?: string;
  agents?: Record<string, unknown>;
  bindings?: unknown[];
  sessionDefaults?: unknown;
}

function resolveKeychainSecret(service: string): string {
  try {
    return execSync(
      `security find-generic-password -s '${service}' -w`,
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
  const kind = obj.kind === "group" ? "group" as const : "dm" as const;
  return {
    chatId: obj.chatId,
    agentId: obj.agentId,
    kind,
    topicId: typeof obj.topicId === "number" ? obj.topicId : undefined,
    label: typeof obj.label === "string" ? obj.label : undefined,
  };
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
    return binding;
  });

  const sessionDefaults = validateSessionDefaults(raw.sessionDefaults);

  return { telegramToken, agents, bindings, sessionDefaults };
}

// CLI: validate config
if (process.argv.includes("--validate")) {
  try {
    const config = loadConfig();
    console.log("Config valid.");
    console.log(`  Agents: ${Object.keys(config.agents).join(", ")}`);
    console.log(`  Bindings: ${config.bindings.length}`);
    console.log(`  Token: ${config.telegramToken.slice(0, 10)}...`);
    console.log(`  Idle timeout: ${config.sessionDefaults.idleTimeoutMs}ms`);
    console.log(`  Max sessions: ${config.sessionDefaults.maxConcurrentSessions}`);
  } catch (e) {
    console.error(`Config validation failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
