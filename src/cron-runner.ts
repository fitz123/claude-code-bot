// cron-runner.ts — CLI entry point for running scheduled cron tasks
// Usage: npx tsx src/cron-runner.ts --task <name>
// Loads cron definition from crons.yaml, runs claude -p one-shot, delivers output to Telegram

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { CronJob, AgentConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..");
const CRONS_PATH = resolve(BOT_DIR, "crons.yaml");
const CONFIG_PATH = resolve(BOT_DIR, "config.yaml");
const LOG_DIR = "/Users/user/.openclaw/logs";
const DELIVER_SCRIPT = resolve(BOT_DIR, "scripts", "deliver.sh");
const NINJA_CHAT_ID = <redacted-user-id>;

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

function loadCronTask(taskName: string): CronJob {
  const raw: CronsYaml = parseYaml(readFileSync(CRONS_PATH, "utf8"));
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
  return {
    name: String(c.name),
    schedule: String(c.schedule ?? ""),
    prompt: String(c.prompt),
    agentId: String(c.agentId ?? "main"),
    deliveryChatId:
      typeof c.deliveryChatId === "number" ? c.deliveryChatId : NINJA_CHAT_ID,
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

function deliver(chatId: number, message: string): void {
  try {
    execSync(`${DELIVER_SCRIPT} ${chatId}`, {
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
    "20",
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
  env.HOME = "/Users/user";
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

  log(taskName, `Loaded: agent=${cron.agentId}, deliver=${cron.deliveryChatId}`);

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

    // Send failure notification to Ninja
    try {
      deliver(NINJA_CHAT_ID, `⚠️ Cron FAIL: ${taskName}\n${errMsg.slice(0, 500)}`);
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
    deliver(cron.deliveryChatId, output);
    log(taskName, `Delivered to chat ${cron.deliveryChatId}`);
  } catch (err) {
    log(taskName, `FAIL delivery: ${(err as Error).message}`);

    // If delivery to target failed, try notifying Ninja
    if (cron.deliveryChatId !== NINJA_CHAT_ID) {
      try {
        deliver(
          NINJA_CHAT_ID,
          `⚠️ Cron "${taskName}" ran OK but delivery to ${cron.deliveryChatId} failed: ${(err as Error).message}`,
        );
      } catch {
        log(taskName, "FAIL: could not deliver failure notification to Ninja");
      }
    }
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

export { loadCronTask, getAgentWorkspace, deliver, runClaude, shellEscape };
