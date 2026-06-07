#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  validateWorkspaceContract,
  workspaceValidationErrors,
  workspaceValidationWarnings,
  type WorkspaceValidationResult,
} from "./workspace-validator.js";
import {
  resolveWorkspaceContract,
  workspaceContractDiagnostics,
  type ResolvedWorkspaceContract,
} from "./workspace-contract.js";

type WriteFn = (text: string) => void;

export interface CliRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: WriteFn;
  stderr?: WriteFn;
}

interface ParsedArgs {
  command: string[];
  help: boolean;
  workspace?: string;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

class WorkspaceValidationError extends Error {
  constructor() {
    super("Workspace validation failed.");
    this.name = "WorkspaceValidationError";
  }
}

const HELP_TEXT = `Usage:
  minime-bot --help
  minime-bot config validate --workspace <path>
  minime-bot workspace validate --workspace <path>

Options:
  --workspace <path>  Control/app workspace root. Defaults to MINIME_WORKSPACE_ROOT, then source repo root or package cwd.
  -h, --help          Show this help text.
`;

function writeLine(write: WriteFn, text = ""): void {
  write(`${text}\n`);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let help = false;
  let workspace: string | undefined;
  const command: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--workspace") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError("--workspace requires a path");
      }
      workspace = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length).trim();
      if (!value) {
        throw new CliUsageError("--workspace requires a path");
      }
      workspace = value;
      continue;
    }
    command.push(arg);
  }

  return { command, help, workspace };
}

function resolveForCli(parsed: ParsedArgs, options: CliRunOptions): ResolvedWorkspaceContract {
  return resolveWorkspaceContract({
    workspace: parsed.workspace,
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  });
}

function formatEffectivePaths(contract: ResolvedWorkspaceContract): string[] {
  const diagnostics = workspaceContractDiagnostics(contract);
  return [
    `  control workspace root: ${diagnostics.controlWorkspaceRoot.path} (${diagnostics.controlWorkspaceRoot.source})`,
    `  config path: ${diagnostics.configPath.path} (${diagnostics.configPath.source})`,
    `  crons path: ${diagnostics.cronsPath.path} (${diagnostics.cronsPath.source})`,
    `  package root: ${diagnostics.packageRoot.path} (${diagnostics.packageRoot.source})`,
    `  Pi extension dir: ${diagnostics.piExtensionDir.path} (${diagnostics.piExtensionDir.source})`,
    `  data dir: ${diagnostics.dataDir.path} (${diagnostics.dataDir.source})`,
    `  session store path: ${diagnostics.sessionStorePath.path} (${diagnostics.sessionStorePath.source})`,
    `  log dir: ${diagnostics.logDir.path} (${diagnostics.logDir.source})`,
    `  media base dir: ${diagnostics.mediaBaseDir.path} (${diagnostics.mediaBaseDir.source})`,
    `  runtime dir: ${diagnostics.runtimeDir.path} (${diagnostics.runtimeDir.source})`,
  ];
}

function runConfigValidate(contract: ResolvedWorkspaceContract, stdout: WriteFn): void {
  const config = loadConfig(contract.paths.configPath, {
    resolveSecrets: false,
    workspaceRoot: contract.paths.workspaceRoot,
  });
  writeLine(stdout, "Config valid.");
  writeLine(stdout, `Config path: ${contract.paths.configPath}`);
  writeLine(stdout, `Agents: ${Object.keys(config.agents).join(", ")}`);
  writeLine(stdout, `Telegram bindings: ${config.bindings.length}`);
  if (config.discord) {
    writeLine(stdout, `Discord bindings: ${config.discord.bindings.length}`);
  }
}

function writeWorkspaceValidationReport(
  result: WorkspaceValidationResult,
  stdout: WriteFn,
): void {
  const errors = workspaceValidationErrors(result);
  const warnings = workspaceValidationWarnings(result);
  writeLine(stdout, errors.length === 0 ? "Workspace valid." : "Workspace invalid.");
  writeLine(stdout, "Effective paths:");
  for (const line of formatEffectivePaths(result.contract)) {
    writeLine(stdout, line);
  }
  if (result.config) {
    writeLine(stdout, `Agents: ${Object.keys(result.config.agents).join(", ")}`);
    writeLine(stdout, "Agent workspaces:");
    for (const [agentId, agent] of Object.entries(result.config.agents)) {
      writeLine(stdout, `  ${agentId}: ${agent.workspaceCwd}`);
    }
  }
  writeLine(stdout, `Crons: ${result.crons === undefined ? "not present" : result.crons.length}`);
  if (errors.length > 0) {
    writeLine(stdout, "Hard failures:");
    for (const error of errors) {
      writeLine(stdout, `  - ${error.message}`);
    }
  }
  if (warnings.length > 0) {
    writeLine(stdout, "Warnings:");
    for (const warning of warnings) {
      writeLine(stdout, `  - ${warning.message}`);
    }
  }
}

function runWorkspaceValidate(
  contract: ResolvedWorkspaceContract,
  stdout: WriteFn,
): void {
  const result = validateWorkspaceContract(contract);
  writeWorkspaceValidationReport(result, stdout);
  if (workspaceValidationErrors(result).length > 0) {
    throw new WorkspaceValidationError();
  }
}

export function runCli(argv: readonly string[] = process.argv.slice(2), options: CliRunOptions = {}): number {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    writeLine(stderr, `Error: ${(err as Error).message}`);
    return 2;
  }

  if (parsed.help || parsed.command.length === 0) {
    writeLine(stdout, HELP_TEXT.trimEnd());
    return 0;
  }

  const [scope, action, ...rest] = parsed.command;
  if (rest.length > 0) {
    writeLine(stderr, `Error: unexpected argument: ${rest[0]}`);
    return 2;
  }

  try {
    const contract = resolveForCli(parsed, options);
    if (scope === "config" && action === "validate") {
      runConfigValidate(contract, stdout);
      return 0;
    }
    if (scope === "workspace" && action === "validate") {
      runWorkspaceValidate(contract, stdout);
      return 0;
    }
  } catch (err) {
    writeLine(stderr, `Error: ${(err as Error).message}`);
    return 1;
  }

  writeLine(stderr, `Error: unknown command: ${parsed.command.join(" ")}`);
  return 2;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isDirectCliEntrypoint(
  moduleUrl = import.meta.url,
  entrypoint = process.argv[1],
): boolean {
  return entrypoint !== undefined
    && realpathOrResolve(entrypoint) === realpathOrResolve(fileURLToPath(moduleUrl));
}

if (isDirectCliEntrypoint()) {
  process.exitCode = runCli();
}
