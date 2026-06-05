import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  CODEX_QUOTA_ATTEMPT_FILE_ENV,
  CODEX_QUOTA_STATE_FILE_ENV,
  CODEX_QUOTA_TEXTFILE_DIR_ENV,
  NODE_EXPORTER_TEXTFILE_DIR_ENV,
  resolveCodexQuotaPaths,
  writeCodexQuotaSnapshot,
  type CodexQuotaSnapshot,
} from "./pi-extensions/codex-usage.js";

export const CODEX_QUOTA_MODEL_ENV = "CODEX_QUOTA_MODEL";
export const CODEX_QUOTA_SAMPLER_CWD_ENV = "CODEX_QUOTA_SAMPLER_CWD";
export const CODEX_QUOTA_TIMEOUT_MS_ENV = "CODEX_QUOTA_TIMEOUT_MS";
export const CODEX_QUOTA_DRY_RUN_ENV = "CODEX_QUOTA_DRY_RUN";
export const CODEX_QUOTA_PI_BIN_ENV = "CODEX_QUOTA_PI_BIN";
export const CODEX_QUOTA_PROBE_TEXTFILE_NAME = "codex_usage_probe.prom";

const PI_PROVIDER = "openai-codex";
const DEFAULT_PI_BIN = "pi";
const DEFAULT_CODEX_QUOTA_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_PROMPT = "Reply with exactly: OK";
const OUTPUT_BUFFER_LIMIT = 64 * 1024;
const SAMPLER_PROJECT_SETTINGS = { transport: "sse" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BOT_DIR = resolve(__dirname, "..");

export interface CodexQuotaSamplerCliOptions {
  model?: string;
  textfileDir?: string;
  stateFile?: string;
  samplerCwd?: string;
  timeoutMs?: number;
  dryRun?: boolean;
  piBin?: string;
  prompt?: string;
  help?: boolean;
}

export interface ResolveCodexQuotaSamplerConfigOptions {
  cli?: CodexQuotaSamplerCliOptions;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  botDir?: string;
  extensionPath?: string;
  forbiddenSamplerCwds?: readonly string[];
  isWritableDir?: (path: string) => boolean;
}

export interface CodexQuotaSamplerConfig {
  piBin: string;
  model: string;
  prompt: string;
  stateFile: string;
  textfileDir: string;
  samplerCwd: string;
  extensionPath: string;
  timeoutMs: number;
  killGraceMs: number;
  dryRun: boolean;
}

export interface ProbeAttempt {
  attemptedAt: Date;
  probeSuccess: boolean;
}

export interface SamplerRunResult {
  status: "success" | "failure" | "dry_run";
  config: CodexQuotaSamplerConfig;
  args: string[];
  settingsFile: string;
  attemptFile?: string;
  attemptMetricsFile?: string;
  failureReason?: string;
  child?: PiProbeResult;
}

interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface SamplerChildLike {
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SamplerSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => SamplerChildLike;

export interface RunPiProbeOptions {
  spawn?: SamplerSpawn;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGraceMs?: number;
}

export interface PiProbeResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface RunCodexQuotaSamplerOptions {
  config?: CodexQuotaSamplerConfig;
  cli?: CodexQuotaSamplerCliOptions;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  botDir?: string;
  extensionPath?: string;
  spawn?: SamplerSpawn;
  now?: Date;
}

export function parseCodexQuotaSamplerArgs(argv: readonly string[]): CodexQuotaSamplerCliOptions {
  const parsed: CodexQuotaSamplerCliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--model":
        parsed.model = readFlagValue(argv, ++i, arg);
        break;
      case "--textfile-dir":
        parsed.textfileDir = readFlagValue(argv, ++i, arg);
        break;
      case "--state-file":
        parsed.stateFile = readFlagValue(argv, ++i, arg);
        break;
      case "--sampler-cwd":
        parsed.samplerCwd = readFlagValue(argv, ++i, arg);
        break;
      case "--timeout":
      case "--timeout-ms":
        parsed.timeoutMs = parsePositiveInteger(readFlagValue(argv, ++i, arg), arg);
        break;
      case "--pi-bin":
        parsed.piBin = readFlagValue(argv, ++i, arg);
        break;
      case "--prompt":
        parsed.prompt = readFlagValue(argv, ++i, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export function resolveCodexQuotaSamplerConfig(
  options: ResolveCodexQuotaSamplerConfigOptions = {},
): CodexQuotaSamplerConfig {
  const cli = options.cli ?? {};
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const botDir = options.botDir ?? DEFAULT_BOT_DIR;

  const paths = resolveCodexQuotaPaths({
    cwd,
    env,
    stateFile: cli.stateFile,
    textfileDir: cli.textfileDir,
    isWritableDir: options.isWritableDir,
  });
  const stateFile = paths.stateFile;
  const textfileDir = paths.textfileDir;
  if (!textfileDir) {
    throw new Error(
      "Codex quota sampler requires a configured or writable Prometheus textfile directory; " +
      `set ${CODEX_QUOTA_TEXTFILE_DIR_ENV} or ${NODE_EXPORTER_TEXTFILE_DIR_ENV}, or make the node_exporter textfile directory writable`,
    );
  }
  const samplerCwd =
    resolveConfiguredPath(cli.samplerCwd, cwd) ??
    resolveConfiguredPath(env[CODEX_QUOTA_SAMPLER_CWD_ENV], cwd) ??
    defaultSamplerCwd();
  assertSamplerCwdIsolated(samplerCwd, botDir, options.forbiddenSamplerCwds ?? readConfiguredAgentWorkspaceCwds(botDir));

  return {
    piBin: nonEmpty(cli.piBin) ?? nonEmpty(env[CODEX_QUOTA_PI_BIN_ENV]) ?? DEFAULT_PI_BIN,
    model: normalizeCodexModel(nonEmpty(cli.model) ?? nonEmpty(env[CODEX_QUOTA_MODEL_ENV])),
    prompt: nonEmpty(cli.prompt) ?? DEFAULT_PROMPT,
    stateFile,
    textfileDir,
    samplerCwd,
    extensionPath: options.extensionPath ?? resolve(botDir, ".claude", "extensions", "codex-usage.ts"),
    timeoutMs:
      cli.timeoutMs ??
      parseOptionalPositiveInteger(env[CODEX_QUOTA_TIMEOUT_MS_ENV], CODEX_QUOTA_TIMEOUT_MS_ENV) ??
      DEFAULT_TIMEOUT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    dryRun: cli.dryRun ?? parseBooleanEnv(env[CODEX_QUOTA_DRY_RUN_ENV]) ?? false,
  };
}

export function buildCodexQuotaSamplerArgs(config: Pick<CodexQuotaSamplerConfig, "model" | "extensionPath" | "prompt">): string[] {
  return [
    "--provider",
    PI_PROVIDER,
    "--model",
    normalizeCodexModel(config.model),
    "--thinking",
    "off",
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
    "--extension",
    config.extensionPath,
    "--no-session",
    "--no-tools",
    "-p",
    config.prompt,
  ];
}

export function ensureSamplerProjectSettings(samplerCwd: string): string {
  ensurePrivateDirectory(samplerCwd, "Sampler cwd");
  ensurePrivateDirectory(join(samplerCwd, ".pi"), "Sampler Pi settings directory");
  ensurePrivateDirectory(join(samplerCwd, ".tmp"), "Sampler attempt directory");
  const settingsFile = samplerProjectSettingsFile(samplerCwd);
  const existing = readJsonObjectIfExists(settingsFile);
  if (existing === "malformed" || (existing && !isSamplerProjectSettings(existing))) {
    throw new Error(`Refusing to overwrite existing Pi project settings: ${settingsFile}`);
  }
  if (!existing) {
    atomicWriteFile(settingsFile, `${JSON.stringify(SAMPLER_PROJECT_SETTINGS, null, 2)}\n`);
  }
  return settingsFile;
}

export function buildSamplerChildEnv(
  config: Pick<CodexQuotaSamplerConfig, "stateFile" | "textfileDir"> & { attemptFile?: string },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME"] as const) {
    const value = nonEmpty(baseEnv[key]);
    if (value) {
      env[key] = value;
    }
  }

  env[CODEX_QUOTA_STATE_FILE_ENV] = config.stateFile;
  env[CODEX_QUOTA_TEXTFILE_DIR_ENV] = config.textfileDir;
  if (config.attemptFile) {
    env[CODEX_QUOTA_ATTEMPT_FILE_ENV] = config.attemptFile;
  }
  env.PATH = prependHomebrewPath(baseEnv.PATH);

  return env;
}

export function formatCodexQuotaProbePrometheus(attempt: ProbeAttempt): string {
  const timestamp = Math.floor(attempt.attemptedAt.getTime() / 1000);
  const success = attempt.probeSuccess ? 1 : 0;
  return [
    "# HELP codex_usage_last_attempt_timestamp Unix timestamp of the last Codex quota sampler attempt.",
    "# TYPE codex_usage_last_attempt_timestamp gauge",
    `codex_usage_last_attempt_timestamp ${timestamp}`,
    "# HELP codex_usage_probe_success Whether the last Codex quota sampler attempt refreshed the quota cache.",
    "# TYPE codex_usage_probe_success gauge",
    `codex_usage_probe_success ${success}`,
    "",
  ].join("\n");
}

export function writeProbeAttemptMetrics(textfileDir: string, attempt: ProbeAttempt): string {
  const metricsFile = join(textfileDir, CODEX_QUOTA_PROBE_TEXTFILE_NAME);
  atomicWriteFile(metricsFile, formatCodexQuotaProbePrometheus(attempt));
  return metricsFile;
}

export function runPiProbe(options: RunPiProbeOptions): Promise<PiProbeResult> {
  const spawn = options.spawn ?? defaultSpawn;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<PiProbeResult>((resolveResult) => {
    let child: SamplerChildLike;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killGraceTimer) {
        clearTimeout(killGraceTimer);
      }
      resolveResult({
        success: !timedOut && !error && exitCode === 0,
        exitCode,
        timedOut,
        killed,
        stdout,
        stderr,
        error,
      });
    };

    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, errorMessage(error));
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout = appendCapped(stdout, chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCapped(stderr, chunk.toString());
    });
    child.on("close", (code) => {
      finish(code ?? null);
    });
    child.on("error", (error) => {
      finish(null, errorMessage(error));
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killed = tryKill(child, "SIGTERM") || killed;
      killGraceTimer = setTimeout(() => {
        killed = tryKill(child, "SIGKILL") || killed;
        finish(null, `Pi probe timed out after ${options.timeoutMs}ms`);
      }, killGraceMs);
    }, options.timeoutMs);
  });
}

export async function runCodexQuotaSampler(
  options: RunCodexQuotaSamplerOptions = {},
): Promise<SamplerRunResult> {
  const config =
    options.config ??
    resolveCodexQuotaSamplerConfig({
      cli: options.cli,
      env: options.env,
      cwd: options.cwd,
      botDir: options.botDir,
      extensionPath: options.extensionPath,
    });
  const settingsFile = samplerProjectSettingsFile(config.samplerCwd);
  const args = buildCodexQuotaSamplerArgs(config);

  if (config.dryRun) {
    return {
      status: "dry_run",
      config,
      args,
      settingsFile,
    };
  }

  ensureSamplerProjectSettings(config.samplerCwd);

  const attemptedAt = options.now ?? new Date();
  const attemptFile = buildAttemptFilePath(config.samplerCwd);
  const child = await runPiProbe({
    spawn: options.spawn,
    command: config.piBin,
    args,
    cwd: config.samplerCwd,
    env: buildSamplerChildEnv({ ...config, attemptFile }, options.env),
    timeoutMs: config.timeoutMs,
    killGraceMs: config.killGraceMs,
  });
  const extensionWriteError = child.stderr.includes("[codex-usage] failed to write quota cache");
  const capturedSnapshot = child.success && !extensionWriteError
    ? readCapturedSnapshot(attemptFile)
    : undefined;
  let cacheRefreshed = false;
  let promotionError: unknown;
  if (capturedSnapshot) {
    try {
      writeCodexQuotaSnapshot(capturedSnapshot, {
        stateFile: config.stateFile,
        textfileDir: config.textfileDir,
      });
      cacheRefreshed = true;
    } catch (error) {
      promotionError = error;
    }
  }
  discardAttemptFile(attemptFile);
  const attempt = {
    attemptedAt,
    probeSuccess: cacheRefreshed,
  };
  let attemptStateError: unknown;
  try {
    writeProbeAttemptState(config.stateFile, attempt);
  } catch (error) {
    attemptStateError = error;
  }

  let attemptMetricsFile: string | undefined;
  let attemptMetricsError: unknown;
  try {
    attemptMetricsFile = writeProbeAttemptMetrics(config.textfileDir, attempt);
  } catch (error) {
    attemptMetricsError = error;
  }

  const samplerSucceeded = cacheRefreshed && !attemptStateError && !attemptMetricsError;

  return {
    status: samplerSucceeded ? "success" : "failure",
    config,
    args,
    settingsFile,
    attemptFile,
    attemptMetricsFile,
    failureReason: samplerSucceeded
      ? undefined
      : describeProbeFailure(child, extensionWriteError, promotionError, attemptStateError, attemptMetricsError),
    child,
  };
}

export async function runCodexQuotaSamplerFromCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseCodexQuotaSamplerArgs(argv);
  if (cli.help) {
    console.log(formatCodexQuotaSamplerHelp());
    return;
  }

  const result = await runCodexQuotaSampler({ cli });
  if (result.status === "dry_run") {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          command: result.config.piBin,
          args: result.args,
          cwd: result.config.samplerCwd,
          settingsFile: result.settingsFile,
          stateFile: result.config.stateFile,
          textfileDir: result.config.textfileDir,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (result.status === "success") {
    console.log(`[codex-quota-sampler] probe succeeded; attempt metrics: ${result.attemptMetricsFile}`);
    return;
  }

  const detail = result.failureReason ?? (result.child?.timedOut
    ? `timed out after ${result.config.timeoutMs}ms`
    : result.child?.error ?? result.child?.stderr.trim() ?? `exit ${result.child?.exitCode ?? "unknown"}`);
  console.error(`[codex-quota-sampler] probe failed: ${detail}`);
  process.exitCode = 1;
}

export function formatCodexQuotaSamplerHelp(): string {
  return [
    "Usage: npx tsx scripts/codex-quota-sampler.ts [options]",
    "",
    "Options:",
    "  --model <model>          Codex model for the probe",
    "  --textfile-dir <dir>     Prometheus textfile directory",
    "  --state-file <file>      Codex quota JSON state file",
    "  --sampler-cwd <dir>      Isolated cwd that receives .pi/settings.json",
    "  --timeout <ms>           Alias for --timeout-ms",
    "  --timeout-ms <ms>        Wall-clock timeout for the Pi child",
    "  --pi-bin <path>          Pi binary path or command name",
    "  --prompt <text>          Minimal prompt sent to Pi",
    "  --dry-run                Print the resolved command without launching Pi",
    "  --help, -h               Show this help",
    "",
    "Environment:",
    `  ${CODEX_QUOTA_MODEL_ENV}, ${CODEX_QUOTA_TEXTFILE_DIR_ENV}, ${CODEX_QUOTA_STATE_FILE_ENV}`,
    `  ${CODEX_QUOTA_SAMPLER_CWD_ENV}, ${CODEX_QUOTA_TIMEOUT_MS_ENV}, ${CODEX_QUOTA_DRY_RUN_ENV}`,
    `  ${CODEX_QUOTA_PI_BIN_ENV}`,
  ].join("\n");
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
): SamplerChildLike {
  return nodeSpawn(command, args, options) as ChildProcess;
}

function normalizeCodexModel(model: string | undefined): string {
  const trimmed = nonEmpty(model);
  if (!trimmed) {
    return DEFAULT_CODEX_QUOTA_MODEL;
  }
  return trimmed.includes("/") ? trimmed : `${PI_PROVIDER}/${trimmed}`;
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseOptionalPositiveInteger(raw: string | undefined, label: string): number | undefined {
  const trimmed = nonEmpty(raw);
  if (!trimmed) {
    return undefined;
  }
  return parsePositiveInteger(trimmed, label);
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(trimmed)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(trimmed)) {
    return false;
  }
  throw new Error(`${CODEX_QUOTA_DRY_RUN_ENV} must be boolean-like`);
}

function prependHomebrewPath(path: string | undefined): string {
  const homebrewPath = "/opt/homebrew/bin";
  if (!path) {
    return homebrewPath;
  }
  return path.split(":").includes(homebrewPath) ? path : `${homebrewPath}:${path}`;
}

function defaultSamplerCwd(): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `codex-quota-sampler-${uid}`);
}

function readConfiguredAgentWorkspaceCwds(botDir: string): string[] {
  const configPath = resolve(botDir, "..", "config.yaml");
  const projectRoot = resolve(botDir, "..");
  const config = loadConfig(configPath, { resolveSecrets: false });
  return Object.values(config.agents).flatMap((agent) => {
    const fromProjectRoot = resolveConfiguredPath(agent.workspaceCwd, projectRoot);
    const fromProcessCwd = resolveConfiguredPath(agent.workspaceCwd, process.cwd());
    return [fromProjectRoot, fromProcessCwd].filter((path, index, paths): path is string =>
      path !== undefined && paths.indexOf(path) === index
    );
  });
}

function assertSamplerCwdIsolated(samplerCwd: string, botDir: string, forbiddenCwds: readonly string[]): void {
  const normalizedSamplerCwd = normalizeComparablePath(samplerCwd);
  const protectedCwds = [botDir, ...forbiddenCwds].map(normalizeComparablePath);
  if (protectedCwds.includes(normalizedSamplerCwd)) {
    throw new Error(
      `Refusing to use sampler cwd that matches the bot directory or a configured agent workspace: ${samplerCwd}`,
    );
  }
}

function normalizeComparablePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "");
}

function samplerProjectSettingsFile(samplerCwd: string): string {
  return join(samplerCwd, ".pi", "settings.json");
}

function isSamplerProjectSettings(settings: Record<string, unknown>): boolean {
  const keys = Object.keys(settings);
  return keys.length === 1 && settings.transport === SAMPLER_PROJECT_SETTINGS.transport;
}

function ensurePrivateDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${path}`);
  }

  if (typeof process.getuid !== "function") {
    return;
  }

  const uid = process.getuid();
  if (stat.uid !== uid) {
    throw new Error(`${label} must be owned by the current user: ${path}`);
  }

  if ((stat.mode & 0o077) !== 0) {
    chmodSync(path, 0o700);
    stat = lstatSync(path);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be accessible by group or others: ${path}`);
    }
  }
}

function buildAttemptFilePath(samplerCwd: string): string {
  return join(
    samplerCwd,
    ".tmp",
    `codex-quota-attempt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

function writeProbeAttemptState(stateFile: string, attempt: ProbeAttempt): void {
  const existing = readJsonObjectIfExists(stateFile);
  if (existing === "malformed") {
    return;
  }

  const timestamp = Math.floor(attempt.attemptedAt.getTime() / 1000);
  const state = existing ?? {
    provider: "codex",
    windows: {
      "5h": {},
      week: {},
    },
  };

  state.lastAttempt = attempt.attemptedAt.toISOString();
  state.lastAttemptTimestamp = timestamp;
  state.probeSuccess = attempt.probeSuccess;
  atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function readCapturedSnapshot(attemptFile: string): CodexQuotaSnapshot | undefined {
  const content = readFileIfExists(attemptFile);
  if (!content) {
    return undefined;
  }
  const parsed = parseJsonObject(content);
  if (!parsed || parsed.provider !== "codex" || !parsed.windows || typeof parsed.windows !== "object") {
    return undefined;
  }
  return parsed as unknown as CodexQuotaSnapshot;
}

function discardAttemptFile(attemptFile: string): void {
  try {
    unlinkSync(attemptFile);
  } catch {
    // Attempt files are best-effort scratch files under the isolated sampler cwd.
  }
}

function describeProbeFailure(
  child: PiProbeResult,
  extensionWriteError: boolean,
  promotionError: unknown,
  attemptStateError: unknown,
  attemptMetricsError: unknown,
): string {
  if (child.timedOut) {
    return "Pi probe timed out";
  }
  if (child.error) {
    return child.error;
  }
  if (extensionWriteError) {
    return "quota cache write failed";
  }
  if (promotionError) {
    return `quota cache write failed: ${errorMessage(promotionError)}`;
  }
  if (attemptStateError) {
    return `probe attempt state write failed: ${errorMessage(attemptStateError)}`;
  }
  if (attemptMetricsError) {
    return `probe attempt metrics write failed: ${errorMessage(attemptMetricsError)}`;
  }
  if (child.success) {
    return "quota cache was not refreshed";
  }
  return child.stderr.trim() || `exit ${child.exitCode ?? "unknown"}`;
}

function readJsonObjectIfExists(path: string): Record<string, unknown> | "malformed" | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return parseJsonObject(readFileSync(path, "utf8")) ?? "malformed";
}

function readFileIfExists(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveConfiguredPath(raw: string | undefined, cwd: string): string | undefined {
  const trimmed = nonEmpty(raw);
  return trimmed ? resolve(cwd, trimmed) : undefined;
}

function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function appendCapped(existing: string, next: string): string {
  const combined = existing + next;
  return combined.length > OUTPUT_BUFFER_LIMIT ? combined.slice(-OUTPUT_BUFFER_LIMIT) : combined;
}

function tryKill(child: SamplerChildLike, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tempPath, content, { encoding: "utf8" });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup of a same-directory staging file.
    }
    throw error;
  }
}
