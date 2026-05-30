import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentConfig,
  StreamLine,
  StreamEvent,
  SystemInit,
  RateLimitEvent,
  ResultMessage,
} from "./types.js";
import { log } from "./logger.js";

const PI_BIN = "pi";
const PI_PROVIDER = "openai-codex";
const DEFAULT_PI_MODEL = "openai-codex/gpt-5.5";

export interface PiPromptCommand {
  type: "prompt";
  message: string;
}

export interface PiSteerCommand {
  type: "steer";
  message: string;
}

export type PiRpcCommand = PiPromptCommand | PiSteerCommand;

/**
 * Pi RPC uses strict JSONL framing: LF is the only record delimiter.
 * Node readline is intentionally avoided because it also splits on U+2028/U+2029.
 */
export class NewlineOnlyJsonlSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | Uint8Array | string): string[] {
    this.buffer += decodeChunk(this.decoder, chunk);
    return this.takeCompleteRecords();
  }

  end(chunk?: Buffer | Uint8Array | string): string[] {
    if (chunk !== undefined) {
      this.buffer += decodeChunk(this.decoder, chunk);
    }
    this.buffer += this.decoder.end();

    if (this.buffer.length === 0) {
      return [];
    }

    const finalRecord = stripTrailingCarriageReturn(this.buffer);
    this.buffer = "";
    return [finalRecord];
  }

  private takeCompleteRecords(): string[] {
    const records: string[] = [];

    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return records;
      }

      const record = this.buffer.slice(0, newlineIndex);
      records.push(stripTrailingCarriageReturn(record));
      this.buffer = this.buffer.slice(newlineIndex + 1);
    }
  }
}

function decodeChunk(
  decoder: StringDecoder,
  chunk: Buffer | Uint8Array | string,
): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return decoder.write(Buffer.from(chunk));
}

function stripTrailingCarriageReturn(record: string): string {
  return record.endsWith("\r") ? record.slice(0, -1) : record;
}

function normalizePiModel(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return DEFAULT_PI_MODEL;
  }
  return trimmed.includes("/") ? trimmed : `${PI_PROVIDER}/${trimmed}`;
}

export function buildPiSpawnArgs(agent: AgentConfig): string[] {
  const args = [
    "--mode", "rpc",
    "--provider", PI_PROVIDER,
    "--model", normalizePiModel(agent.model),
  ];

  if (agent.systemPrompt) {
    args.push("--append-system-prompt", agent.systemPrompt);
  }

  return args;
}

export function buildPiSpawnEnv(agent: AgentConfig): Record<string, string> {
  void agent;

  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // A Pi/Codex subprocess authenticates via ~/.pi/agent/auth.json and has no
  // use for Anthropic credentials — scrub both so they never reach it (matches
  // cron-runner.ts's sanitization of script subprocesses).
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  // Parity with the Claude path (cli-protocol.ts): never leak the Claude Code
  // session marker into a spawned agent subprocess.
  delete env.CLAUDECODE;

  if (!env.PATH?.includes("/opt/homebrew/bin")) {
    env.PATH = `/opt/homebrew/bin:${env.PATH ?? ""}`;
  }

  return env;
}

export function spawnPiRpcSession(agent: AgentConfig): ChildProcess {
  const child = spawn(PI_BIN, buildPiSpawnArgs(agent), {
    env: buildPiSpawnEnv(agent),
    cwd: agent.workspaceCwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString().trimEnd();
    if (text) {
      log.warn("pi-rpc", text);
    }
  });

  return child;
}

export function buildPiPromptCommand(text: string): PiPromptCommand {
  return { type: "prompt", message: text };
}

export function buildPiSteerCommand(text: string): PiSteerCommand {
  return { type: "steer", message: text };
}

export function sendPiPrompt(child: ChildProcess, text: string): void {
  writePiCommand(child, buildPiPromptCommand(text));
}

export function sendPiSteer(child: ChildProcess, text: string): void {
  writePiCommand(child, buildPiSteerCommand(text));
}

function writePiCommand(child: ChildProcess, command: PiRpcCommand): void {
  if (!child.stdin || child.stdin.destroyed || child.exitCode !== null || child.killed) {
    throw new Error("Pi RPC child process is not available");
  }
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

/**
 * A raw Pi RPC event as decoded from a JSONL record. Field access is defensive
 * (everything optional) because the translator must never throw on an
 * unexpected/extended event shape — it returns null and the caller skips it.
 */
export interface PiRpcEvent {
  type?: string;
  sessionId?: string;
  errorMessage?: string;
  message?: string;
  assistantMessageEvent?: {
    type?: string;
    text?: string;
    [key: string]: unknown;
  };
  toolName?: string;
  tool?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Translate a single Pi RPC event into the bot's existing 8-variant `StreamLine`
 * union so the downstream stream-relay/delivery path needs no changes.
 *
 * Mapping (per Plan A Technical Details):
 * - `message_update` w/ `assistantMessageEvent.type === "text_delta"` → `StreamEvent`
 *   carrying `event.delta = { type: "text_delta", text }` (drives live streaming).
 * - `tool_execution_start` → synthetic `StreamEvent` shaped as a
 *   `content_block_start` tool_use block so stream-relay flips `sawNonTextBlock`.
 * - `turn_end` / `agent_end` → `ResultMessage` (+ `session_id`).
 * - session header / `get_state` → `SystemInit` (captures the Pi `sessionId`).
 * - `auto_retry_start` / `auto_retry_end` → `RateLimitEvent` (raw error message
 *   preserved for the Task 4 retry classifier).
 * - `error` → error `ResultMessage` (`subtype: "error_during_execution"`).
 *
 * Returns null for unknown/ignored events (e.g. `tool_execution_update/end`,
 * `message_update` deltas that are not text) so the caller skips them.
 */
export function parsePiEvent(rawEvent: PiRpcEvent | null | undefined): StreamLine | null {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  switch (rawEvent.type) {
    case "message_update": {
      const inner = rawEvent.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.text === "string" && inner.text.length > 0) {
        const event: StreamEvent = {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: inner.text },
          },
        };
        return event;
      }
      return null;
    }

    case "tool_execution_start": {
      const toolName = rawEvent.toolName ?? rawEvent.tool?.name ?? "tool";
      const event: StreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", name: toolName },
        },
      };
      return event;
    }

    case "turn_end":
    case "agent_end": {
      const result: ResultMessage = {
        type: "result",
        result: typeof rawEvent.message === "string" ? rawEvent.message : "",
        session_id: rawEvent.sessionId ?? "",
      };
      return result;
    }

    case "session":
    case "session_start":
    case "get_state": {
      if (typeof rawEvent.sessionId !== "string" || rawEvent.sessionId.length === 0) {
        return null;
      }
      const init: SystemInit = {
        type: "system",
        subtype: "init",
        session_id: rawEvent.sessionId,
      };
      return init;
    }

    case "auto_retry_start":
    case "auto_retry_end": {
      const rateLimit: RateLimitEvent = {
        type: "assistant",
        subtype: "rate_limit_event",
        pi_event_type: rawEvent.type,
        error_message: rawEvent.errorMessage ?? "",
      };
      return rateLimit;
    }

    case "error": {
      const result: ResultMessage = {
        type: "result",
        subtype: "error_during_execution",
        result: rawEvent.errorMessage ?? rawEvent.message ?? "Pi RPC error",
        session_id: rawEvent.sessionId ?? "",
        is_error: true,
      };
      return result;
    }

    default:
      return null;
  }
}

/**
 * Async generator yielding translated `StreamLine`s from a Pi RPC child's
 * stdout: newline-only splitter → `JSON.parse` → `parsePiEvent`. Malformed
 * JSON records and untranslatable events are skipped (never throw mid-stream).
 */
export async function* readPiStream(child: ChildProcess): AsyncGenerator<StreamLine> {
  if (!child.stdout) {
    throw new Error("Pi RPC child process stdout is not available");
  }

  const splitter = new NewlineOnlyJsonlSplitter();

  for await (const chunk of child.stdout) {
    for (const record of splitter.push(chunk as Buffer)) {
      const line = parsePiRecord(record);
      if (line) {
        yield line;
      }
    }
  }

  for (const record of splitter.end()) {
    const line = parsePiRecord(record);
    if (line) {
      yield line;
    }
  }
}

function parsePiRecord(record: string): StreamLine | null {
  const trimmed = record.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let parsed: PiRpcEvent;
  try {
    parsed = JSON.parse(trimmed) as PiRpcEvent;
  } catch {
    return null;
  }

  return parsePiEvent(parsed);
}

/**
 * Extract streamable text from a translated Pi `StreamLine`, mirroring
 * `extractTextDelta` from cli-protocol so the relay treats both providers
 * identically.
 */
export function extractPiTextDelta(msg: StreamLine): string | null {
  if (msg.type === "stream_event") {
    const event = msg.event;
    if (event?.delta?.type === "text_delta" && event.delta.text) {
      return event.delta.text;
    }
  }
  return null;
}
