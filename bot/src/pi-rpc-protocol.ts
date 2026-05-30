import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentConfig } from "./types.js";
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

    const finalRecord = this.buffer;
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

  delete env.CLAUDE_CODE_OAUTH_TOKEN;

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
