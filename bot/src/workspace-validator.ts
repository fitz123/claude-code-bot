import { existsSync, statSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadMergedCrons } from "./cron-runner.js";
import { PI_EXTENSIONS_DISABLED_ENV } from "./pi-rpc-protocol.js";
import {
  readWriteAllowlistSchema,
  resolveWriteAllowlistSchemaPath,
  type WriteAllowlistSchemaResult,
} from "./pi-extensions/write-allowlist-schema.js";
import type { BotConfig } from "./types.js";
import {
  realPathIsInsideOrEqual,
  resolveAgentWorkspaceCwd,
  type ResolvedWorkspaceContract,
} from "./workspace-contract.js";

export type WorkspaceValidationSeverity = "error" | "warning";

export interface WorkspaceValidationIssue {
  severity: WorkspaceValidationSeverity;
  message: string;
}

export interface WorkspaceValidationResult {
  contract: ResolvedWorkspaceContract;
  config?: BotConfig;
  crons?: Array<Record<string, unknown>>;
  schema?: WriteAllowlistSchemaResult;
  issues: WorkspaceValidationIssue[];
}

export interface ValidateWorkspaceOptions {
  env?: NodeJS.ProcessEnv;
  guardEnforcementEnabled?: boolean;
}

function issue(
  issues: WorkspaceValidationIssue[],
  severity: WorkspaceValidationSeverity,
  message: string,
): void {
  issues.push({ severity, message });
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function existsAsDirectory(path: string): boolean {
  return safeStat(path)?.isDirectory() === true;
}

function existsAsFile(path: string): boolean {
  return safeStat(path)?.isFile() === true;
}

function describePathKind(path: string): string {
  if (!existsSync(path)) {
    return "does not exist";
  }
  const stat = safeStat(path);
  if (!stat) {
    return "cannot be accessed";
  }
  if (stat.isDirectory()) {
    return "is a directory";
  }
  if (stat.isFile()) {
    return "is a regular file";
  }
  return "is not a regular file";
}

function schemaGuardEnabled(options: ValidateWorkspaceOptions, env: NodeJS.ProcessEnv): boolean {
  return options.guardEnforcementEnabled ?? env[PI_EXTENSIONS_DISABLED_ENV] !== "1";
}

export function workspaceValidationErrors(
  result: WorkspaceValidationResult,
): WorkspaceValidationIssue[] {
  return result.issues.filter((item) => item.severity === "error");
}

export function workspaceValidationWarnings(
  result: WorkspaceValidationResult,
): WorkspaceValidationIssue[] {
  return result.issues.filter((item) => item.severity === "warning");
}

export function validateWorkspaceContract(
  contract: ResolvedWorkspaceContract,
  options: ValidateWorkspaceOptions = {},
): WorkspaceValidationResult {
  const env = options.env ?? process.env;
  const issues: WorkspaceValidationIssue[] = [];
  let config: BotConfig | undefined;
  let crons: Array<Record<string, unknown>> | undefined;

  if (!existsSync(contract.paths.workspaceRoot)) {
    issue(issues, "error", `workspace root does not exist: ${contract.paths.workspaceRoot}`);
  } else if (!existsAsDirectory(contract.paths.workspaceRoot)) {
    issue(issues, "error", `workspace root is not a directory: ${contract.paths.workspaceRoot}`);
  }

  if (!existsAsFile(contract.paths.configPath)) {
    issue(issues, "error", `config path ${describePathKind(contract.paths.configPath)}: ${contract.paths.configPath}`);
  } else {
    try {
      config = loadConfig(contract.paths.configPath, {
        resolveSecrets: false,
        workspaceRoot: contract.paths.workspaceRoot,
      });
    } catch (err) {
      issue(issues, "error", `config does not parse with secret resolution disabled: ${(err as Error).message}`);
    }
  }

  if (!existsSync(contract.paths.cronsPath)) {
    issue(issues, "warning", `crons file is not present: ${contract.paths.cronsPath}`);
  } else if (!existsAsFile(contract.paths.cronsPath)) {
    issue(issues, "error", `crons path ${describePathKind(contract.paths.cronsPath)}: ${contract.paths.cronsPath}`);
  } else {
    try {
      crons = loadMergedCrons(contract.paths.cronsPath);
    } catch (err) {
      issue(issues, "error", `crons file does not parse: ${(err as Error).message}`);
    }
  }

  const defaultSchemaPath = normalize(resolve(contract.paths.workspaceRoot, "schema.md"));
  if (contract.effectivePaths.schemaPath.source !== "env" && contract.paths.schemaPath !== defaultSchemaPath) {
    issue(
      issues,
      "error",
      `schema path must default to workspace root schema.md when no override is set: ${contract.paths.schemaPath}`,
    );
  }

  const guardSchemaPath = resolveWriteAllowlistSchemaPath(contract.paths.workspaceRoot, env);
  if (guardSchemaPath !== contract.paths.schemaPath) {
    issue(
      issues,
      "error",
      `live guard schema path does not match validator schema path: guard=${guardSchemaPath} validator=${contract.paths.schemaPath}`,
    );
  }

  let schema: WriteAllowlistSchemaResult | undefined;
  if (schemaGuardEnabled(options, env)) {
    schema = readWriteAllowlistSchema(contract.paths.schemaPath);
    if (schema.issue) {
      issue(issues, "error", `schema validation failed: ${schema.issue.message}`);
    }
  } else {
    issue(issues, "warning", `Pi guard enforcement is disabled by ${PI_EXTENSIONS_DISABLED_ENV}=1; schema allow-list was not enforced`);
  }

  if (config) {
    for (const [agentId, agent] of Object.entries(config.agents)) {
      const agentWorkspace = resolveAgentWorkspaceCwd(contract.paths.workspaceRoot, agent.workspaceCwd);
      if (!existsSync(agentWorkspace)) {
        issue(issues, "error", `agent "${agentId}" workspaceCwd does not exist: ${agentWorkspace}`);
      } else if (!existsAsDirectory(agentWorkspace)) {
        issue(issues, "error", `agent "${agentId}" workspaceCwd is not a directory: ${agentWorkspace}`);
      } else if (!realPathIsInsideOrEqual(contract.paths.workspaceRoot, agentWorkspace)) {
        issue(
          issues,
          "error",
          `agent "${agentId}" workspaceCwd must be inside the resolved workspace root for Pi guard enforcement: ` +
            `workspaceCwd=${agentWorkspace} workspaceRoot=${contract.paths.workspaceRoot}`,
        );
      }
    }
  }

  if (!existsSync(contract.paths.piExtensionDir)) {
    issue(issues, "error", `Pi extension dir does not exist: ${contract.paths.piExtensionDir}`);
  } else if (!existsAsDirectory(contract.paths.piExtensionDir)) {
    issue(issues, "error", `Pi extension dir is not a directory: ${contract.paths.piExtensionDir}`);
  }

  for (const warning of contract.warnings) {
    issue(issues, "warning", warning);
  }

  return { contract, config, crons, schema, issues };
}
