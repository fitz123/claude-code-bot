// cron-runner.ts — CLI entry point for running scheduled cron tasks
// Usage: npx tsx src/cron-runner.ts --task <name>
// Loads cron definition from crons.yaml, runs claude -p one-shot, delivers output to Telegram

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { CronJob, AgentConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..");
const CRONS_PATH = resolve(BOT_DIR, "crons.yaml");
const CONFIG_PATH = resolve(BOT_DIR, "config.yaml");
const LOG_DIR = process.env.LOG_DIR ?? join(homedir(), ".openclaw", "logs");
const DELIVER_SCRIPT = resolve(BOT_DIR, "scripts", "deliver.sh");

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

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

function loadCronTask(taskName: string, cronsPath?: string): CronJob {
  const raw: CronsYaml = parseYaml(readFileSync(cronsPath ?? CRONS_PATH, "utf8"));
  if (!raw?.crons || !Array.isArray(raw.crons)) {
    throw new Error("crons.yaml missing 'crons' array");
  }

  const found = raw.crons.find(
    (c) => (c as Record<string, unknown>).name === taskName,
  );
  if (!found) {
    throw new Error(
      `Task "${taskName}" not found in crons.yaml. Available: ${raw.crons.map((c) => (c as Record<string, unknown>).name).join(", ")}`,
    );
  }

  const c = found as Record<string, unknown>;
  if (typeof c.deliveryChatId !== "number") {
    throw new Error(`Task "${taskName}" missing required 'deliveryChatId' in crons.yaml`);
  }
  return {
    name: String(c.name),
    schedule: String(c.schedule ?? ""),
    prompt: String(c.prompt),
    agentId: String(c.agentId ?? "main"),
    deliveryChatId: c.deliveryChatId,
    deliveryThreadId:
      typeof c.deliveryThreadId === "number" ? c.deliveryThreadId : undefined,
    timeout: typeof c.timeout === "number" ? c.timeout : undefined,
    maxBudget: typeof c.maxBudget === "number" ? c.maxBudget : undefined,
  };
}

function getAgentWorkspace(agentId: string): string {
  const raw = parseYaml(readFileSync(CONFIG_PATH, "utf8")) as {
    agents?: Record<string, unknown>;
  };
  if (!raw?.agents?.[agentId]) {
    throw new Error(`Agent "${agentId}" not found in config.yaml`);
  }
  const agent = raw.agents[agentId] as AgentConfig;
  return agent.workspaceCwd;
}

export function loadAdminChatId(configPath?: string): number | undefined {
  const raw = parseYaml(readFileSync(configPath ?? CONFIG_PATH, "utf8")) as {
    adminChatId?: unknown;
  };
  if (typeof raw?.adminChatId === "number") {
    return raw.adminChatId;
  }
  return undefined;
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

function runClaude(cron: CronJob, workspaceCwd: string): string {
  const today = new Date().toISOString().split("T")[0];
  const timeoutMs = cron.timeout ?? DEFAULT_TIMEOUT_MS;

  const args: string[] = [
    "claude",
    "-p",
    cron.prompt,
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

  if (cron.maxBudget) {
    args.push("--max-budget-usd", String(cron.maxBudget));
  }

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

  let cron: CronJob;
  try {
    cron = loadCronTask(taskName);
  } catch (err) {
    log(taskName, `FAIL: ${(err as Error).message}`);
    process.exit(1);
  }

  let adminChatId: number | undefined;
  try {
    adminChatId = loadAdminChatId();
  } catch {
    // Config read failure is non-fatal; proceed without admin fallback
  }

  log(taskName, `Loaded: agent=${cron.agentId}, deliver=${cron.deliveryChatId}${cron.deliveryThreadId ? `, thread=${cron.deliveryThreadId}` : ""}`);

  let workspaceCwd: string;
  try {
    workspaceCwd = getAgentWorkspace(cron.agentId);
  } catch (err) {
    log(taskName, `FAIL: ${(err as Error).message}`);
    process.exit(1);
  }

  let output: string;
  try {
    output = runClaude(cron, workspaceCwd);
    log(taskName, `Claude returned ${output.length} chars`);
  } catch (err) {
    const errMsg = `Cron task "${taskName}" failed: ${(err as Error).message}`;
    log(taskName, `FAIL: ${errMsg}`);

    // Send failure notification to delivery chat
    try {
      deliver(cron.deliveryChatId, `⚠️ Cron FAIL: ${taskName}\n${errMsg.slice(0, 500)}`);
    } catch {
      log(taskName, "FAIL: could not deliver failure notification");
    }
    process.exit(1);
  }

  if (!output || output === "NO_REPLY" || output.trim() === "NO_REPLY") {
    log(taskName, output ? "NO_REPLY — skipping delivery" : "WARN: empty output");
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

export { loadCronTask, getAgentWorkspace, deliver, buildDeliverCommand, runClaude, shellEscape };
