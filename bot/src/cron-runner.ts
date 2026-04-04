// cron-runner.ts — CLI entry point for running scheduled cron tasks
// Usage: npx tsx src/cron-runner.ts --task <name>
// Loads cron definition from crons.yaml, runs claude -p one-shot, delivers output to Telegram

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { loadRawMergedConfig } from "./config.js";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { CronJob, AgentConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(BOT_DIR, "..");
const CRONS_PATH = resolve(REPO_ROOT, "crons.yaml");
const LOG_DIR = process.env.LOG_DIR ?? join(homedir(), ".minime", "logs");
const DELIVER_SCRIPT = resolve(BOT_DIR, "scripts", "deliver.sh");

const DEFAULT_TIMEOUT_MS = 900000; // 15 minutes

function log(taskName: string, msg: string): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = resolve(LOG_DIR, `cron-${taskName}.log`);
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync(logFile, line);
  process.stderr.write(line);
}

interface CronsYaml {
  crons: Array<Record<string, unknown>>;
}

export interface DeliveryDefaults {
  defaultDeliveryChatId?: number;
  defaultDeliveryThreadId?: number;
}

// Derive the .local counterpart path: crons.yaml → crons.local.yaml
function deriveCronsLocalPath(cronsPath: string): string {
  return cronsPath.replace(/\.yaml$/, ".local.yaml");
}

// Load crons.yaml and merge crons.local.yaml on top if it exists.
// Local crons win on duplicate name. Exported for tests.
export function loadMergedCrons(cronsPath?: string): Array<Record<string, unknown>> {
  const path = cronsPath ?? CRONS_PATH;
  const raw: CronsYaml = parseYaml(readFileSync(path, "utf8"));
  if (!raw?.crons || !Array.isArray(raw.crons)) {
    throw new Error("crons.yaml missing 'crons' array");
  }
  const baseCrons = raw.crons as Array<Record<string, unknown>>;

  const localPath = deriveCronsLocalPath(path);
  if (!existsSync(localPath)) {
    return [...baseCrons];
  }
  const localRaw: CronsYaml = parseYaml(readFileSync(localPath, "utf8"));
  if (!localRaw?.crons || !Array.isArray(localRaw.crons)) {
    process.stderr.write(`Warning: ${localPath} found but has no valid 'crons' array — ignoring local overrides\n`);
    return [...baseCrons];
  }
  const localCrons = localRaw.crons as Array<Record<string, unknown>>;

  // Merge: start with base, local wins on duplicate name, new local crons appended
  const merged = [...baseCrons];
  for (const localCron of localCrons) {
    const idx = merged.findIndex((c) => c.name === localCron.name);
    if (idx >= 0) {
      merged[idx] = localCron;
    } else {
      merged.push(localCron);
    }
  }
  return merged;
}

function loadCronTask(taskName: string, cronsPath?: string, defaults?: DeliveryDefaults): CronJob {
  const crons = loadMergedCrons(cronsPath);
  const found = crons.find(
    (c) => c.name === taskName,
  );
  if (!found) {
    throw new Error(
      `Task "${taskName}" not found in crons.yaml / crons.local.yaml. Available: ${crons.map((c) => c.name).join(", ")}`,
    );
  }

  const c = found as Record<string, unknown>;

  // Resolve deliveryChatId: cron-level > config default. Error on present-but-invalid.
  let deliveryChatId: number | undefined;
  if (c.deliveryChatId !== undefined) {
    if (typeof c.deliveryChatId !== "number" || !Number.isInteger(c.deliveryChatId) || c.deliveryChatId === 0) {
      throw new Error(`Task "${taskName}" has invalid 'deliveryChatId' (${c.deliveryChatId}): must be a non-zero integer`);
    }
    deliveryChatId = c.deliveryChatId;
  } else {
    deliveryChatId = defaults?.defaultDeliveryChatId;
  }
  if (typeof deliveryChatId !== "number") {
    throw new Error(`Task "${taskName}" missing 'deliveryChatId' (not in cron config or config defaults)`);
  }

  // Resolve deliveryThreadId: cron-level > config default.
  // Only inherit default thread when targeting the default chat (thread IDs are chat-specific).
  const usedDefaultChat = c.deliveryChatId === undefined || c.deliveryChatId === defaults?.defaultDeliveryChatId;
  let deliveryThreadId: number | undefined;
  if (c.deliveryThreadId !== undefined) {
    if (typeof c.deliveryThreadId !== "number" || !Number.isInteger(c.deliveryThreadId) || c.deliveryThreadId === 0) {
      throw new Error(`Task "${taskName}" has invalid 'deliveryThreadId' (${c.deliveryThreadId}): must be a non-zero integer`);
    }
    deliveryThreadId = c.deliveryThreadId;
  } else if (usedDefaultChat) {
    deliveryThreadId = defaults?.defaultDeliveryThreadId;
  }

  if (c.type !== undefined && c.type !== "llm" && c.type !== "script") {
    throw new Error(`Task "${taskName}" has invalid type "${c.type}" (must be "llm" or "script")`);
  }
  const cronType = c.type === "script" ? "script" as const : "llm" as const;

  if (cronType === "script") {
    if (typeof c.command !== "string" || !c.command.trim()) {
      throw new Error(`Task "${taskName}" is type 'script' but missing required 'command' field`);
    }
  } else {
    if (typeof c.prompt !== "string" || !c.prompt.trim()) {
      throw new Error(`Task "${taskName}" missing required 'prompt' field`);
    }
  }

  if (typeof c.timeout === "number" && (!Number.isFinite(c.timeout) || c.timeout <= 0)) {
    throw new Error(`Task "${taskName}" has invalid 'timeout' (${c.timeout}): must be a positive number`);
  }
  return {
    name: String(c.name),
    schedule: String(c.schedule ?? ""),
    type: cronType,
    prompt: cronType === "llm" ? String(c.prompt) : undefined,
    command: cronType === "script" ? String(c.command) : undefined,
    agentId: String(c.agentId ?? "main"),
    deliveryChatId,
    deliveryThreadId,
    timeout: typeof c.timeout === "number" ? c.timeout : undefined,
    enabled: c.enabled === false ? false : undefined,
  };
}

function getAgentWorkspace(agentId: string): string {
  const raw = loadRawMergedConfig() as {
    agents?: Record<string, unknown>;
  };
  if (!raw?.agents?.[agentId]) {
    throw new Error(`Agent "${agentId}" not found in config.yaml / config.local.yaml`);
  }
  const agent = raw.agents[agentId] as AgentConfig;
  return agent.workspaceCwd;
}

export function loadAdminChatId(configPath?: string): number | undefined {
  const raw = loadRawMergedConfig(configPath) as {
    adminChatId?: unknown;
  };
  if (raw?.adminChatId === undefined) {
    return undefined;
  }
  if (typeof raw.adminChatId === "number" && Number.isInteger(raw.adminChatId) && raw.adminChatId !== 0) {
    return raw.adminChatId;
  }
  process.stderr.write(`[cron-runner] WARN: invalid adminChatId in config (${raw.adminChatId}), ignoring\n`);
  return undefined;
}

export function loadDefaultDelivery(configPath?: string): DeliveryDefaults {
  const raw = loadRawMergedConfig(configPath) as {
    defaultDeliveryChatId?: unknown;
    defaultDeliveryThreadId?: unknown;
  };
  const result: DeliveryDefaults = {};
  if (raw?.defaultDeliveryChatId !== undefined) {
    if (typeof raw.defaultDeliveryChatId === "number" && Number.isInteger(raw.defaultDeliveryChatId) && raw.defaultDeliveryChatId !== 0) {
      result.defaultDeliveryChatId = raw.defaultDeliveryChatId;
    } else {
      process.stderr.write(`[cron-runner] WARN: invalid defaultDeliveryChatId in config (${raw.defaultDeliveryChatId}), ignoring\n`);
    }
  }
  if (raw?.defaultDeliveryThreadId !== undefined) {
    if (typeof raw.defaultDeliveryThreadId === "number" && Number.isInteger(raw.defaultDeliveryThreadId) && raw.defaultDeliveryThreadId !== 0) {
      result.defaultDeliveryThreadId = raw.defaultDeliveryThreadId;
    } else {
      process.stderr.write(`[cron-runner] WARN: invalid defaultDeliveryThreadId in config (${raw.defaultDeliveryThreadId}), ignoring\n`);
    }
  }
  return result;
}

export function handleDeliveryFailure(
  cronName: string,
  targetChatId: number,
  errorMsg: string,
  adminChatId: number | undefined,
  deliverFn: (chatId: number, msg: string) => void = deliver,
): void {
  log(cronName, `FAIL delivery: ${errorMsg}`);
  if (adminChatId !== undefined) {
    try {
      deliverFn(
        adminChatId,
        `⚠️ Cron delivery FAIL\nTask: ${cronName}\nTarget: ${targetChatId}\nError: ${errorMsg}`,
      );
    } catch (err) {
      log(cronName, `FAIL: admin notification failed: ${(err as Error).message}`);
    }
  }
}

function buildDeliverCommand(
  chatId: number,
  threadId?: number,
): string {
  const threadArg = threadId ? ` --thread ${threadId}` : "";
  return `${DELIVER_SCRIPT} ${chatId}${threadArg}`;
}

function deliver(
  chatId: number,
  message: string,
  threadId?: number,
): void {
  try {
    execSync(buildDeliverCommand(chatId, threadId), {
      input: message,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`Delivery failed: ${(err as Error).message}`);
  }
}

function runScript(cron: CronJob): string {
  if (!cron.command) {
    throw new Error(`Script-mode cron "${cron.name}" has no command`);
  }
  const timeoutMs = cron.timeout ?? DEFAULT_TIMEOUT_MS;

  // Strip sensitive env vars — match runClaude's sanitization
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  const output = execSync(cron.command, {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: "/bin/bash",
    env,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    stdio: ["pipe", "pipe", "pipe"],
  });

  return output.trim();
}

function runClaude(cron: CronJob, workspaceCwd: string): string {
  const today = new Date().toISOString().split("T")[0];
  const timeoutMs = cron.timeout ?? DEFAULT_TIMEOUT_MS;

  const args: string[] = [
    "claude",
    "-p",
    cron.prompt!,
    "--output-format",
    "text",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    "--model",
    "claude-opus-4-6",
    "--fallback-model",
    "claude-sonnet-4-6",
    "--max-turns",
    "50",
    "--add-dir",
    workspaceCwd,
    "--append-system-prompt",
    `Today is ${today}. Respond concisely.`,
  ];

  // Build env without CLAUDECODE and without ANTHROPIC_API_KEY
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  env.HOME = homedir();
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  env.CLAUDE_CODE_DISABLE_CRON = "1";
  env.CLAUDE_CODE_SIMPLE = "1";

  const output = execSync(args.map(shellEscape).join(" "), {
    encoding: "utf8",
    timeout: timeoutMs,
    env,
    cwd: workspaceCwd,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    stdio: ["pipe", "pipe", "pipe"],
  });

  return output.trim();
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function main(): Promise<void> {
  const taskIdx = process.argv.indexOf("--task");
  if (taskIdx === -1 || !process.argv[taskIdx + 1]) {
    console.error("Usage: cron-runner.ts --task <name>");
    process.exit(1);
  }
  const taskName = process.argv[taskIdx + 1];

  log(taskName, `Starting cron task: ${taskName}`);

  let defaults: DeliveryDefaults = {};
  try {
    defaults = loadDefaultDelivery();
  } catch (err) {
    log(taskName, `WARN: could not load delivery defaults from config: ${(err as Error).message}`);
  }

  let cron: CronJob;
  try {
    cron = loadCronTask(taskName, undefined, defaults);
  } catch (err) {
    log(taskName, `FAIL: ${(err as Error).message}`);
    process.exit(1);
  }

  let adminChatId: number | undefined;
  try {
    adminChatId = loadAdminChatId();
  } catch (err) {
    log(taskName, `WARN: could not load adminChatId from config: ${(err as Error).message}`);
  }

  log(taskName, `Loaded: type=${cron.type}, agent=${cron.agentId}, deliver=${cron.deliveryChatId}${cron.deliveryThreadId ? `, thread=${cron.deliveryThreadId}` : ""}`);

  let workspaceCwd: string | undefined;
  if (cron.type !== "script") {
    try {
      workspaceCwd = getAgentWorkspace(cron.agentId);
    } catch (err) {
      log(taskName, `FAIL: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  let output: string;
  try {
    if (cron.type === "script") {
      output = runScript(cron);
      log(taskName, `Script returned ${output.length} chars`);
    } else {
      output = runClaude(cron, workspaceCwd!);
      log(taskName, `Claude returned ${output.length} chars`);
    }
  } catch (err) {
    const errMsg = `Cron task "${taskName}" failed: ${(err as Error).message}`;
    log(taskName, `FAIL: ${errMsg}`);

    // Send failure notification to delivery chat; use admin fallback if delivery fails
    try {
      deliver(cron.deliveryChatId, `⚠️ Cron FAIL: ${taskName}\n${errMsg.slice(0, 500)}`, cron.deliveryThreadId);
    } catch (deliveryErr) {
      handleDeliveryFailure(
        taskName,
        cron.deliveryChatId,
        `${errMsg.slice(0, 400)}\n(notification delivery failed: ${(deliveryErr as Error).message})`,
        adminChatId,
      );
    }
    process.exit(1);
  }

  if (!output) {
    log(taskName, "WARN: empty output — skipping delivery");
    log(taskName, "DONE");
    return;
  }
  if (cron.type === "llm" && /^NO_REPLY(\s|$)/.test(output.trim())) {
    log(taskName, "NO_REPLY — skipping delivery");
    log(taskName, "DONE");
    return;
  }

  // Deliver output to target chat
  try {
    deliver(cron.deliveryChatId, output, cron.deliveryThreadId);
    log(taskName, `Delivered to chat ${cron.deliveryChatId}${cron.deliveryThreadId ? ` thread ${cron.deliveryThreadId}` : ""}`);
  } catch (err) {
    handleDeliveryFailure(taskName, cron.deliveryChatId, (err as Error).message, adminChatId);
    process.exit(1);
  }

  log(taskName, "DONE");
}

// Only run main() when executed directly (not when imported in tests)
const isMain =
  process.argv[1]?.endsWith("cron-runner.ts") ||
  process.argv[1]?.endsWith("cron-runner.js");
if (isMain) {
  main();
}

export { loadCronTask, getAgentWorkspace, deliver, buildDeliverCommand, runClaude, runScript, shellEscape };
