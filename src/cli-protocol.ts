import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  StreamLine,
  StreamMessageUser,
  SystemInit,
  AgentConfig,
} from "./types.js";

const CLAUDE_BIN = "claude";

export interface SpawnOptions {
  agent: AgentConfig;
  sessionId?: string;
  resume?: boolean;
  includePartialMessages?: boolean;
}

/**
 * Build spawn arguments for the Claude CLI subprocess.
 */
export function buildSpawnArgs(opts: SpawnOptions): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--model", opts.agent.model,
  ];

  if (opts.includePartialMessages !== false) {
    args.push("--include-partial-messages");
  }

  if (opts.agent.fallbackModel) {
    args.push("--fallback-model", opts.agent.fallbackModel);
  }

  if (opts.agent.maxTurns) {
    args.push("--max-turns", String(opts.agent.maxTurns));
  }

  if (opts.agent.systemPrompt) {
    args.push("--append-system-prompt", opts.agent.systemPrompt);
  }

  if (opts.resume && opts.sessionId) {
    // --resume <sessionId> takes ID as argument, NOT combined with --session-id
    args.push("--resume", opts.sessionId);
  } else if (opts.sessionId) {
    args.push("--session-id", opts.sessionId);
  }

  args.push("--add-dir", opts.agent.workspaceCwd);

  return args;
}

/**
 * Build environment variables for the Claude CLI subprocess.
 */
export function buildSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy relevant env vars
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // Critical: CLAUDECODE must NOT be set
  delete env.CLAUDECODE;

  // Required env
  env.HOME = "/Users/ninja";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  env.CLAUDE_CODE_DISABLE_CRON = "1";
  env.CLAUDE_CODE_EXIT_AFTER_STOP_DELAY = "900000"; // 15min idle auto-exit
  env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet";
  env.CLAUDE_CODE_ENABLE_TELEMETRY = "1";

  // Ensure claude binary is in PATH
  if (!env.PATH?.includes("/opt/homebrew/bin")) {
    env.PATH = `/opt/homebrew/bin:${env.PATH ?? ""}`;
  }

  return env;
}

/**
 * Spawn a Claude CLI subprocess for interactive sessions.
 */
export function spawnClaudeSession(opts: SpawnOptions): ChildProcess {
  const args = buildSpawnArgs(opts);
  const env = buildSpawnEnv();

  const child = spawn(CLAUDE_BIN, args, {
    env,
    cwd: opts.agent.workspaceCwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return child;
}

/**
 * Build a user message for the stream-json protocol.
 */
export function buildUserMessage(text: string, sessionId: string): StreamMessageUser {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * Send a user message to the Claude CLI subprocess stdin.
 * Throws if the child process is dead or stdin is unavailable.
 */
export function sendMessage(child: ChildProcess, text: string, sessionId: string): void {
  if (!child.stdin || child.stdin.destroyed || child.exitCode !== null || child.killed) {
    throw new Error("Child process is not available");
  }
  const msg = buildUserMessage(text, sessionId);
  child.stdin.write(JSON.stringify(msg) + "\n");
}

/**
 * Parse a single NDJSON line from Claude CLI stdout.
 */
export function parseStreamLine(line: string): StreamLine | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);

    // system/init
    if (parsed.type === "system" && parsed.subtype === "init") {
      return parsed as SystemInit;
    }

    // result
    if (parsed.type === "result") {
      return parsed;
    }

    // assistant subtypes
    if (parsed.type === "assistant") {
      return parsed;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Create an async generator that yields parsed stream lines from a child process stdout.
 */
export async function* readStream(child: ChildProcess): AsyncGenerator<StreamLine> {
  if (!child.stdout) {
    throw new Error("Child process stdout is not available");
  }

  const rl = createInterface({ input: child.stdout });

  for await (const line of rl) {
    const parsed = parseStreamLine(line);
    if (parsed) {
      yield parsed;
    }
  }
}

/**
 * Extract text from a stream event delta.
 */
export function extractTextDelta(msg: StreamLine): string | null {
  if (
    msg.type === "assistant" &&
    "subtype" in msg &&
    msg.subtype === "stream_event"
  ) {
    const event = (msg as { event?: { delta?: { type: string; text?: string } } }).event;
    if (event?.delta?.type === "text_delta" && event.delta.text) {
      return event.delta.text;
    }
  }
  return null;
}

/**
 * Extract full text from an assistant message.
 */
export function extractAssistantText(msg: StreamLine): string | null {
  if (
    msg.type === "assistant" &&
    !("subtype" in msg && msg.subtype) &&
    "message" in msg
  ) {
    const assistantMsg = msg as { message?: { content?: Array<{ type: string; text?: string }> } };
    const parts = assistantMsg.message?.content;
    if (Array.isArray(parts)) {
      return parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("");
    }
  }
  return null;
}

/**
 * Extract result text from a result message.
 */
export function extractResultText(msg: StreamLine): string | null {
  if (msg.type === "result" && "result" in msg) {
    return (msg as { result: string }).result;
  }
  return null;
}
