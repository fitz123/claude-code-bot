// cron-runner.ts — CLI entry point for running scheduled cron tasks
// Usage: npx tsx src/cron-runner.ts --task <name>
// Loads cron definition from crons.yaml, runs a Pi print-mode one-shot, delivers output to Telegram

import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import {
  loadRawMergedConfig,
  loadTelegramToken,
  resolveConfigWorkspaceRoot,
  validateAgent,
} from "./config.js";
import {
  execSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { CronJob, AgentConfig } from "./types.js";
import { shouldSuppressNoReply } from "./no-reply.js";
import {
  buildPiSpawnEnv,
  resolveValidatedPiAgentWorkspaceCwd,
  shouldIncludePiChildEnvKey,
} from "./pi-rpc-protocol.js";
import { assemblePiContext } from "./pi-context-assembler.js";
import { resolveWorkspaceContract } from "./workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..");
const LOG_DIR = process.env.LOG_DIR ?? join(homedir(), ".minime", "logs");
const DELIVER_SCRIPT = resolve(BOT_DIR, "scripts", "deliver.sh");

const DEFAULT_TIMEOUT_MS = 900000; // 15 minutes
const DEFAULT_CRON_HEALTH_TEXTFILE_DIR = "/opt/homebrew/var/node_exporter/textfile";
const PI_CRON_MODEL = "openai-codex/gpt-5.5";
const PI_BIN = "pi";
const PI_ERROR_EXCERPT_CHARS = 1000;
type PiThinkingLevel = NonNullable<AgentConfig["thinking"]>;
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
export interface CronAgentData {
  id: string;
  workspaceCwd: string;
  systemPrompt?: string;
  thinking?: AgentConfig["thinking"];
}

export type PiRunResult =
  | { status: "ok"; output: string }
  | { status: "error"; message: string; diagnostics?: string };
type PiErrorRunResult = Extract<PiRunResult, { status: "error" }>;

class CronRunError extends Error {
  diagnostics?: string;

  constructor(message: string, diagnostics?: string) {
    super(message);
    this.name = "CronRunError";
    this.diagnostics = diagnostics;
  }
}

function errorFromUnknown(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function cronErrorDiagnostics(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("diagnostics" in err)) {
    return undefined;
  }
  const diagnostics = (err as { diagnostics?: unknown }).diagnostics;
  return typeof diagnostics === "string" && diagnostics.trim() ? diagnostics : undefined;
}

function log(taskName: string, msg: string): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = resolve(LOG_DIR, `cron-${taskName}.log`);
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync(logFile, line);
  process.stderr.write(line);
}

function shortStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeCronMetricStem(cronName: string): string {
  const safeName = cronName.trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${safeName || "unnamed"}_${shortStableHash(cronName)}`;
}

function escapePrometheusLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function writeAtomicTextFile(dir: string, fileName: string, content: string): void {
  const filePath = join(dir, fileName);
  const tmpPath = join(
    dir,
    `.${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

function writeCronHealthMetric(cronName: string, exitCode: number, success: boolean): void {
  const fileStem = sanitizeCronMetricStem(cronName);
  const label = escapePrometheusLabelValue(cronName);
  const dir = process.env.CRON_HEALTH_TEXTFILE_DIR ?? DEFAULT_CRON_HEALTH_TEXTFILE_DIR;
  const normalizedExitCode = Number.isFinite(exitCode) ? Math.trunc(exitCode) : 1;

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[cron-runner] WARN: failed to prepare cron health metric dir for "${cronName}": ${(err as Error).message}\n`,
    );
    return;
  }

  if (success) {
    try {
      writeAtomicTextFile(
        dir,
        `minime_cron_${fileStem}.success.prom`,
        `minime_cron_last_success_timestamp{cron="${label}"} ${Math.floor(Date.now() / 1000)}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[cron-runner] WARN: failed to write cron health success metric for "${cronName}": ${(err as Error).message}\n`,
      );
    }
  }

  try {
    writeAtomicTextFile(
      dir,
      `minime_cron_${fileStem}.exit.prom`,
      `minime_cron_last_exit_code{cron="${label}"} ${normalizedExitCode}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[cron-runner] WARN: failed to write cron health exit metric for "${cronName}": ${(err as Error).message}\n`,
    );
  }
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

export function resolveCronsPath(cronsPath?: string): string {
  return cronsPath === undefined
    ? resolveWorkspaceContract().paths.cronsPath
    : resolve(cronsPath);
}

// Load crons.yaml and merge crons.local.yaml on top if it exists.
// Local crons win on duplicate name. Exported for tests.
export function loadMergedCrons(cronsPath?: string): Array<Record<string, unknown>> {
  const path = resolveCronsPath(cronsPath);
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

  let engine: CronJob["engine"];
  if (cronType === "llm" && c.engine !== undefined) {
    if (c.engine === "claude") {
      throw new Error(`Task "${taskName}" uses engine: claude, but Claude cron runtime was removed; remove engine or set engine: pi`);
    }
    if (c.engine !== "pi") {
      throw new Error(`Task "${taskName}" has invalid 'engine' "${c.engine}" (must be "pi" or omitted)`);
    }
    engine = c.engine;
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
    engine,
  };
}

function isCronPiThinking(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && PI_THINKING_LEVELS.has(value as PiThinkingLevel);
}

function resolveCronAgentData(agentId: string, configPath?: string): CronAgentData {
  const workspaceRoot = resolveConfigWorkspaceRoot(configPath);
  const raw = loadRawMergedConfig(configPath) as {
    agents?: Record<string, unknown>;
    defaultModel?: unknown;
    defaultFallbackModel?: unknown;
  };
  if (raw.defaultModel !== undefined && typeof raw.defaultModel !== "string") {
    throw new Error(`Invalid defaultModel: must be a string`);
  }
  if (raw.defaultFallbackModel !== undefined) {
    throw new Error(`defaultFallbackModel was removed with the Claude runtime; remove defaultFallbackModel`);
  }
  if (
    typeof raw?.agents !== "object" ||
    raw.agents === null ||
    !Object.prototype.hasOwnProperty.call(raw.agents, agentId)
  ) {
    throw new Error(`Agent "${agentId}" not found in config.yaml / config.local.yaml`);
  }
  const rawAgent = raw.agents[agentId];
  if (typeof rawAgent !== "object" || rawAgent === null) {
    throw new Error(`Agent "${agentId}" missing workspaceCwd`);
  }

  const defaultModel = typeof raw.defaultModel === "string" ? raw.defaultModel : undefined;
  const agent = validateAgent(rawAgent, agentId, defaultModel, workspaceRoot);
  if (!agent.workspaceCwd.trim()) {
    throw new Error(`Agent "${agentId}" missing workspaceCwd`);
  }

  const result: CronAgentData = {
    id: agentId,
    workspaceCwd: agent.workspaceCwd,
  };
  if (agent.systemPrompt !== undefined) {
    result.systemPrompt = agent.systemPrompt;
  }
  if (agent.thinking !== undefined) {
    result.thinking = agent.thinking;
  }
  return result;
}

function buildPiCronAgentConfig(agentId: string, configPath?: string): AgentConfig {
  return buildPiCronAgentConfigFromData(resolveCronAgentData(agentId, configPath));
}

function buildPiCronAgentConfigFromData(agent: CronAgentData): AgentConfig {
  const result: AgentConfig = {
    id: agent.id,
    workspaceCwd: agent.workspaceCwd,
    provider: "pi",
    model: PI_CRON_MODEL,
  };
  if (agent.systemPrompt !== undefined) {
    result.systemPrompt = agent.systemPrompt;
  }
  if (agent.thinking !== undefined) {
    result.thinking = agent.thinking;
  }
  return result;
}

function getAgentWorkspace(agentId: string, configPath?: string): string {
  return resolveCronAgentData(agentId, configPath).workspaceCwd;
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

let cachedDeliveryTelegramToken: string | undefined;
let cachedDeliveryTelegramTokenError: Error | undefined;

function loadDeliveryTelegramToken(): string {
  if (cachedDeliveryTelegramToken !== undefined) {
    return cachedDeliveryTelegramToken;
  }
  if (cachedDeliveryTelegramTokenError !== undefined) {
    throw cachedDeliveryTelegramTokenError;
  }
  try {
    cachedDeliveryTelegramToken = loadTelegramToken();
    return cachedDeliveryTelegramToken;
  } catch (err) {
    cachedDeliveryTelegramTokenError = err instanceof Error ? err : new Error(String(err));
    throw cachedDeliveryTelegramTokenError;
  }
}

function deliver(
  chatId: number,
  message: string,
  threadId?: number,
): void {
  try {
    const telegramToken = loadDeliveryTelegramToken();
    execSync(buildDeliverCommand(chatId, threadId), {
      input: message,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: telegramToken,
      },
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

  const env = scrubLegacyRuntimeEnv(process.env);

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

function scrubLegacyRuntimeEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...rawEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key.startsWith("ANTHROPIC_")) {
      delete env[key];
    }
  }
  delete env.CLAUDECODE;
  return env;
}

function normalizeSpawnOutput(value: string | Buffer | null | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return value;
}

function buildCronSystemInstruction(): string {
  const today = new Date().toISOString().split("T")[0];
  return `Today is ${today}. Respond concisely.`;
}

function sanitizeCapturedOutput(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "?")
    .trim();
}

function formatCapturedOutputExcerpt(label: "stdout" | "stderr", value: string): string | undefined {
  const trimmed = sanitizeCapturedOutput(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= PI_ERROR_EXCERPT_CHARS) {
    return `${label}: ${trimmed}`;
  }

  const excerpt = trimmed.slice(0, PI_ERROR_EXCERPT_CHARS);
  return `${label} (first ${PI_ERROR_EXCERPT_CHARS} chars): ${excerpt}... [truncated ${trimmed.length - PI_ERROR_EXCERPT_CHARS} chars]`;
}

function piErrorResult(summary: string, stdout: string, stderr: string): PiErrorRunResult {
  const details = [
    formatCapturedOutputExcerpt("stderr", stderr),
    formatCapturedOutputExcerpt("stdout", stdout),
  ].filter((line): line is string => line !== undefined);
  return {
    status: "error",
    message: summary,
    diagnostics: details.length > 0 ? details.join("; ") : undefined,
  };
}

function classifyPiResult(
  exitCode: number | null | undefined,
  signal: NodeJS.Signals | string | null | undefined,
  stdoutValue: string | Buffer | null | undefined,
  stderrValue: string | Buffer | null | undefined,
): PiRunResult {
  const stdout = normalizeSpawnOutput(stdoutValue);
  const stderr = normalizeSpawnOutput(stderrValue);
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (signal) {
    return piErrorResult(`Pi cron exited with signal ${signal}`, stdout, stderr);
  }
  if (exitCode !== 0) {
    const summary = typeof exitCode === "number"
      ? `Pi cron exited with code ${exitCode}`
      : "Pi cron exited without an exit code";
    return piErrorResult(summary, stdout, stderr);
  }
  if (trimmedStdout) {
    return { status: "ok", output: trimmedStdout };
  }
  if (trimmedStderr) {
    return piErrorResult("Pi cron produced stderr without stdout", stdout, stderr);
  }
  return { status: "ok", output: "" };
}

type PiSpawnSync = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface PiRunDeps {
  spawnSync: PiSpawnSync;
  buildAgentConfig: (cron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => AgentConfig;
  buildEnv: () => Record<string, string>;
  assembleContext: typeof assemblePiContext;
}

function buildPiCronAgentConfigForRun(cron: CronJob, workspaceCwd: string, agentData?: CronAgentData): AgentConfig {
  const agent = agentData ?? resolveCronAgentData(cron.agentId);
  return buildPiCronAgentConfigFromData({ ...agent, workspaceCwd });
}

const defaultPiDeps: PiRunDeps = {
  spawnSync,
  buildAgentConfig: buildPiCronAgentConfigForRun,
  buildEnv: buildPiSpawnEnv,
  assembleContext: assemblePiContext,
};

function hardenPiCronEnv(rawEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (shouldIncludePiChildEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

function buildPiCronPromptArg(prompt: string): string {
  // Pi parses leading "-" as options and leading "@" as file references.
  return prompt.startsWith("-") || prompt.startsWith("@") ? ` ${prompt}` : prompt;
}

function runPi(
  cron: CronJob,
  workspaceCwd: string,
  deps: PiRunDeps = defaultPiDeps,
  agentData?: CronAgentData,
): string {
  if (!cron.prompt) {
    throw new Error(`Pi cron "${cron.name}" has no prompt`);
  }

  const agent = deps.buildAgentConfig(cron, workspaceCwd, agentData);
  const validatedWorkspaceCwd = resolveValidatedPiAgentWorkspaceCwd(agent);
  const thinking = isCronPiThinking(agent.thinking) ? agent.thinking : "medium";
  const systemInstruction = buildCronSystemInstruction();
  const env = hardenPiCronEnv(deps.buildEnv());
  // Pi authenticates via ~/.pi/agent/auth.json, not legacy OAuth credentials.
  env.HOME ||= homedir();
  const args: string[] = [
    "-p",
    buildPiCronPromptArg(cron.prompt),
    "--no-session",
    "--no-extensions",
    "--model",
    PI_CRON_MODEL,
    "--thinking",
    thinking,
  ];

  try {
    const context = deps.assembleContext(agent);
    if (context) {
      if (context.systemPromptPath) {
        args.push("--system-prompt", context.systemPromptPath);
      }
      args.push("--append-system-prompt", context.appendSystemPromptPath);
      args.push("--no-context-files");
    }
  } catch (err) {
    log(cron.name, `Pi context assembly failed; suppressing flat context loading: ${(err as Error).message}`);
    args.push("--no-context-files");
  }

  args.push("--append-system-prompt", systemInstruction);
  const result = deps.spawnSync(PI_BIN, args, {
    cwd: validatedWorkspaceCwd,
    timeout: cron.timeout ?? DEFAULT_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env,
  });

  if (result.error) {
    const spawnError = piErrorResult(`Pi cron spawn failed: ${result.error.message}`, result.stdout, result.stderr);
    throw new CronRunError(spawnError.message, spawnError.diagnostics);
  }

  const classified = classifyPiResult(result.status, result.signal, result.stdout, result.stderr);
  if (classified.status === "error") {
    throw new CronRunError(classified.message, classified.diagnostics);
  }
  return classified.output;
}

function resolveCronEngine(cron: CronJob): "pi" {
  if (cron.engine !== undefined && cron.engine !== "pi") {
    throw new Error(`Cron task "${cron.name}" uses unsupported engine "${cron.engine}"; only Pi cron execution is supported`);
  }
  if (process.env.CRON_PI_DISABLED === "1") {
    throw new Error("CRON_PI_DISABLED=1 is no longer supported; LLM crons only run via Pi print mode");
  }
  return "pi";
}

interface OneShotDeps {
  runPi: (cron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => string;
}

const defaultOneShotDeps: OneShotDeps = {
  runPi: (cron, workspaceCwd, agentData) => runPi(cron, workspaceCwd, defaultPiDeps, agentData),
};

function runOneShot(
  cron: CronJob,
  workspaceCwd: string,
  deps: OneShotDeps = defaultOneShotDeps,
  agentData?: CronAgentData,
): string {
  resolveCronEngine(cron);
  return deps.runPi(cron, workspaceCwd, agentData);
}

export interface CronRunnerMainDeps {
  argv: string[];
  consoleError: (message?: unknown, ...optionalParams: unknown[]) => void;
  exit: (code: number) => never;
  log: (taskName: string, msg: string) => void;
  loadDefaultDelivery: (configPath?: string) => DeliveryDefaults;
  loadCronTask: (taskName: string, cronsPath?: string, defaults?: DeliveryDefaults) => CronJob;
  loadAdminChatId: (configPath?: string) => number | undefined;
  resolveCronAgentData: (agentId: string, configPath?: string) => CronAgentData;
  runScript: (cron: CronJob) => string;
  runPi: (cron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => string;
  deliver: (chatId: number, message: string, threadId?: number) => void;
  handleDeliveryFailure: (
    cronName: string,
    targetChatId: number,
    errorMsg: string,
    adminChatId: number | undefined,
  ) => void;
  writeCronHealthMetric: (cronName: string, exitCode: number, success: boolean) => void;
}

const defaultMainDeps: Omit<CronRunnerMainDeps, "argv"> = {
  consoleError: console.error,
  exit: (code: number): never => process.exit(code),
  log,
  loadDefaultDelivery,
  loadCronTask,
  loadAdminChatId,
  resolveCronAgentData,
  runScript,
  runPi: (cron, workspaceCwd, agentData) => runPi(cron, workspaceCwd, defaultPiDeps, agentData),
  deliver,
  handleDeliveryFailure,
  writeCronHealthMetric,
};

async function main(overrides: Partial<CronRunnerMainDeps> = {}): Promise<void> {
  const deps: CronRunnerMainDeps = {
    ...defaultMainDeps,
    argv: process.argv,
    ...overrides,
  };

  const taskIdx = deps.argv.indexOf("--task");
  if (taskIdx === -1 || !deps.argv[taskIdx + 1]) {
    deps.consoleError("Usage: cron-runner.ts --task <name>");
    deps.writeCronHealthMetric("unknown", 1, false);
    deps.exit(1);
  }
  const taskName = deps.argv[taskIdx + 1];

  deps.log(taskName, `Starting cron task: ${taskName}`);

  let defaults: DeliveryDefaults = {};
  try {
    defaults = deps.loadDefaultDelivery();
  } catch (err) {
    deps.log(taskName, `WARN: could not load delivery defaults from config: ${(err as Error).message}`);
  }

  let cron: CronJob;
  try {
    cron = deps.loadCronTask(taskName, undefined, defaults);
  } catch (err) {
    deps.log(taskName, `FAIL: ${(err as Error).message}`);
    deps.writeCronHealthMetric(taskName, 1, false);
    deps.exit(1);
  }

  let adminChatId: number | undefined;
  try {
    adminChatId = deps.loadAdminChatId();
  } catch (err) {
    deps.log(taskName, `WARN: could not load adminChatId from config: ${(err as Error).message}`);
  }

  deps.log(taskName, `Loaded: type=${cron.type}, agent=${cron.agentId}, deliver=${cron.deliveryChatId}${cron.deliveryThreadId ? `, thread=${cron.deliveryThreadId}` : ""}`);

  let output: string;
  try {
    if (cron.type === "script") {
      output = deps.runScript(cron);
      deps.log(taskName, `Script returned ${output.length} chars`);
    } else {
      const cronAgentData = deps.resolveCronAgentData(cron.agentId);
      const workspaceCwd = cronAgentData.workspaceCwd;
      output = runOneShot(
        cron,
        workspaceCwd,
        { runPi: deps.runPi },
        cronAgentData,
      );
      deps.log(taskName, `Pi returned ${output.length} chars`);
    }
  } catch (err) {
    const error = errorFromUnknown(err);
    const errMsg = `Cron task "${taskName}" failed: ${error.message}`;
    deps.log(taskName, `FAIL: ${errMsg}`);
    const diagnostics = cronErrorDiagnostics(err);
    if (diagnostics) {
      deps.log(taskName, `FAIL diagnostics: ${diagnostics}`);
    }

    // Send failure notification to delivery chat; use admin fallback if delivery fails
    try {
      deps.deliver(cron.deliveryChatId, `⚠️ Cron FAIL: ${taskName}\n${errMsg.slice(0, 500)}`, cron.deliveryThreadId);
    } catch (deliveryErr) {
      deps.handleDeliveryFailure(
        taskName,
        cron.deliveryChatId,
        `${errMsg.slice(0, 400)}\n(notification delivery failed: ${(deliveryErr as Error).message})`,
        adminChatId,
      );
    }
    deps.writeCronHealthMetric(taskName, 1, false);
    deps.exit(1);
  }

  if (!output) {
    deps.log(taskName, "WARN: empty output — skipping delivery");
    deps.writeCronHealthMetric(taskName, 0, true);
    deps.log(taskName, "DONE");
    return;
  }
  if (cron.type === "llm" && shouldSuppressNoReply(output)) {
    deps.log(taskName, "NO_REPLY — skipping delivery");
    deps.writeCronHealthMetric(taskName, 0, true);
    deps.log(taskName, "DONE");
    return;
  }

  // Deliver output to target chat
  try {
    deps.deliver(cron.deliveryChatId, output, cron.deliveryThreadId);
    deps.log(taskName, `Delivered to chat ${cron.deliveryChatId}${cron.deliveryThreadId ? ` thread ${cron.deliveryThreadId}` : ""}`);
  } catch (err) {
    deps.handleDeliveryFailure(taskName, cron.deliveryChatId, (err as Error).message, adminChatId);
    deps.writeCronHealthMetric(taskName, 1, false);
    deps.exit(1);
  }

  deps.writeCronHealthMetric(taskName, 0, true);
  deps.log(taskName, "DONE");
}

// Only run main() when executed directly (not when imported in tests)
const isMain =
  process.argv[1]?.endsWith("cron-runner.ts") ||
  process.argv[1]?.endsWith("cron-runner.js");
if (isMain) {
  main();
}

export { loadCronTask, resolveCronAgentData, buildPiCronAgentConfig, getAgentWorkspace, deliver, buildDeliverCommand, runPi, runOneShot, resolveCronEngine, classifyPiResult, writeCronHealthMetric, runScript, main };
