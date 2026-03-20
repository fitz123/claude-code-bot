import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type { CliCapabilities } from "./types.js";

const CLAUDE_BIN = "claude";

/**
 * Detect Claude CLI capabilities by parsing --help and --version output.
 * Called once at bot startup, results cached for the session.
 */
export function detectCapabilities(): CliCapabilities {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) env[key] = val;
  }
  delete env.CLAUDECODE;
  env.HOME = homedir();

  let version = "unknown";
  try {
    version = execSync(`${CLAUDE_BIN} --version`, {
      encoding: "utf8",
      env,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // version detection failed, continue with defaults
  }

  let helpText = "";
  try {
    helpText = execSync(`${CLAUDE_BIN} --help`, {
      encoding: "utf8",
      env,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // help detection failed, continue with defaults
  }

  const flags = new Set<string>();
  const flagRegex = /--([a-z][\w-]*)/g;
  let match;
  while ((match = flagRegex.exec(helpText)) !== null) {
    flags.add(`--${match[1]}`);
  }

  return {
    version,
    flags,
    hasStreamJson: flags.has("--input-format") && flags.has("--output-format"),
    hasIncludePartialMessages: flags.has("--include-partial-messages"),
    hasFallbackModel: flags.has("--fallback-model"),
    hasAddDir: flags.has("--add-dir"),
    hasAppendSystemPrompt: flags.has("--append-system-prompt"),
    hasDangerouslySkipPermissions: flags.has("--dangerously-skip-permissions"),
    hasMaxTurns: flags.has("--max-turns"),
    hasTools: flags.has("--tools"),
  };
}

/**
 * Verify Claude CLI auth status. Returns true if authenticated.
 */
export function verifyAuth(): boolean {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) env[key] = val;
  }
  delete env.CLAUDECODE;
  env.HOME = homedir();

  try {
    execSync(`${CLAUDE_BIN} auth status`, {
      encoding: "utf8",
      env,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
