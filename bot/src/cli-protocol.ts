import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  StreamLine,
  StreamMessageUser,
  AgentConfig,
} from "./types.js";

const CLAUDE_BIN = "claude";

export interface SpawnOptions {
  agent: AgentConfig;
  sessionId?: string;
  resume?: boolean;
  includePartialMessages?: boolean;
  /** Per-session outbox directory; injected into system prompt so Claude can send files. */
  outboxPath?: string;
  /** Per-session inject directory for mid-turn message delivery via PreToolUse hook. */
  injectDir?: string;
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

  // Build combined system prompt: agent's static prompt + dynamic outbox instruction
  const promptParts: string[] = [];
  if (opts.agent.systemPrompt) {
    promptParts.push(opts.agent.systemPrompt);
  }
  if (opts.outboxPath) {
    promptParts.push(
      `To share a file with the user, write or copy it to this outbox directory: ${opts.outboxPath}\n` +
      "Files placed there will be automatically sent to the user after your response completes.",
    );
  }
  if (promptParts.length > 0) {
    args.push("--append-system-prompt", promptParts.join("\n\n"));
  }

  if (opts.agent.effort) {
    args.push("--effort", opts.agent.effort);
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
export function buildSpawnEnv(options?: { injectDir?: string }): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy relevant env vars
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // Critical: CLAUDECODE must NOT be set (prevents nested session detection)
  delete env.CLAUDECODE;

  // Ensure claude binary is in PATH
  if (!env.PATH?.includes("/opt/homebrew/bin")) {
    env.PATH = `/opt/homebrew/bin:${env.PATH ?? ""}`;
  }

  // Mid-turn message injection: tell the PreToolUse hook where to find inject files.
  // Always set explicitly — clear any inherited value when no injectDir is provided.
  if (options?.injectDir) {
    env.BOT_INJECT_DIR = options.injectDir;
  } else {
    delete env.BOT_INJECT_DIR;
  }

  return env;
}

/**
 * Spawn a Claude CLI subprocess for interactive sessions.
 */
export function spawnClaudeSession(opts: SpawnOptions): ChildProcess {
  const args = buildSpawnArgs(opts);
  const env = buildSpawnEnv({ injectDir: opts.injectDir });

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
    return JSON.parse(trimmed);
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

  try {
    for await (const line of rl) {
      const parsed = parseStreamLine(line);
      if (parsed) {
        yield parsed;
      }
    }
  } finally {
    // Explicitly close the readline interface to remove its listeners from
    // child.stdout. Without this, each call to readStream leaks end/data
    // listeners on the underlying socket because generator.return() does not
    // always propagate to the inner for-await-of in all Node.js versions.
    rl.close();
  }
}

/**
 * Extract text from a stream event delta.
 */
export function extractTextDelta(msg: StreamLine): string | null {
  if (msg.type === "stream_event") {
    const event = msg.event;
    if (event?.delta?.type === "text_delta" && event.delta.text) {
      return event.delta.text;
    }
  }
  return null;
}

