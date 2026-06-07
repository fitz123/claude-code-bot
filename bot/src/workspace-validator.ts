import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadMergedCrons } from "./cron-runner.js";
import type { BotConfig } from "./types.js";
import {
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
  issues: WorkspaceValidationIssue[];
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

function warnIfMissingAgentContext(
  issues: WorkspaceValidationIssue[],
  agentId: string,
  agentWorkspace: string,
): void {
  for (const fileName of ["CLAUDE.md", "MEMORY.md"] as const) {
    const path = join(agentWorkspace, fileName);
    if (!existsAsFile(path)) {
      issue(issues, "warning", `agent "${agentId}" context file is not present: ${path}`);
    }
  }

  for (const relDir of [join(".claude", "rules", "platform"), join(".claude", "rules", "custom")] as const) {
    const path = join(agentWorkspace, relDir);
    if (!existsAsDirectory(path)) {
      issue(issues, "warning", `agent "${agentId}" rules dir is not present: ${path}`);
    }
  }
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
): WorkspaceValidationResult {
  const issues: WorkspaceValidationIssue[] = [];
  let config: BotConfig | undefined;
  let crons: Array<Record<string, unknown>> | undefined;

  if (!existsSync(contract.paths.workspaceRoot)) {
    issue(issues, "error", `control workspace root does not exist: ${contract.paths.workspaceRoot}`);
  } else if (!existsAsDirectory(contract.paths.workspaceRoot)) {
    issue(issues, "error", `control workspace root is not a directory: ${contract.paths.workspaceRoot}`);
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

  if (config) {
    for (const [agentId, agent] of Object.entries(config.agents)) {
      const agentWorkspace = resolveAgentWorkspaceCwd(contract.paths.workspaceRoot, agent.workspaceCwd);
      if (!existsSync(agentWorkspace)) {
        issue(issues, "error", `agent "${agentId}" workspaceCwd does not exist: ${agentWorkspace}`);
      } else if (!existsAsDirectory(agentWorkspace)) {
        issue(issues, "error", `agent "${agentId}" workspaceCwd is not a directory: ${agentWorkspace}`);
      } else {
        warnIfMissingAgentContext(issues, agentId, agentWorkspace);
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

  return { contract, config, crons, issues };
}
