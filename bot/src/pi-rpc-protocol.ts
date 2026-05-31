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

/**
 * `get_state` is a no-argument RPC command whose successful `response` is the
 * ONLY place Pi exposes the session id it minted (no agent event carries it).
 * Issued once right after spawn to capture + persist that id for `--session`
 * resume across restarts.
 */
export interface PiGetStateCommand {
  type: "get_state";
}

export type PiRpcCommand = PiPromptCommand | PiSteerCommand | PiGetStateCommand;

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

export function buildPiSpawnArgs(agent: AgentConfig, resumeSessionId?: string): string[] {
  const args = [
    "--mode", "rpc",
    "--provider", PI_PROVIDER,
    "--model", normalizePiModel(agent.model),
  ];

  if (agent.systemPrompt) {
    args.push("--append-system-prompt", agent.systemPrompt);
  }

  // Pi mints its own session id (the bot cannot pre-assign one as it does for
  // claude via --session-id). When resuming a stored session, point Pi at the
  // captured id with --session; on a fresh start, omit it entirely (passing an
  // unknown id makes Pi exit 1 with "No session found matching").
  if (resumeSessionId) {
    args.push("--session", resumeSessionId);
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

/**
 * Startup diagnostics stashed on a Pi child by `spawnPiRpcSession` so the spawn
 * caller can classify a startup failure WITHOUT re-piping stderr. `piStartupStderr()`
 * returns the stderr buffered since spawn — the spawn caller matches it against
 * `No session found matching` to detect an unresumable stored session (and start
 * fresh once). The exit code is read directly from `child.exitCode`.
 */
export interface PiStartupDiagnostics {
  piStartupStderr?: () => string;
}

/** Cap on buffered startup stderr (the classifier only needs the startup tail). */
const PI_STARTUP_STDERR_CAP = 64 * 1024;

export function spawnPiRpcSession(agent: AgentConfig, resumeSessionId?: string): ChildProcess {
  const child = spawn(PI_BIN, buildPiSpawnArgs(agent, resumeSessionId), {
    env: buildPiSpawnEnv(agent),
    cwd: agent.workspaceCwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Buffer startup stderr so the spawn caller can classify a resume failure
  // (Pi prints `No session found matching <id>` and exits 1 when handed a stale
  // --session). Keep the existing log.warn so stderr stays visible in logs.
  // Cap the buffer: the only consumer is the startup classifier, and the signal
  // it matches appears in the first chunk(s); without a cap a long-lived, chatty
  // Pi session would accumulate all stderr in memory for the child's lifetime.
  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const raw = chunk.toString();
    if (stderrBuffer.length < PI_STARTUP_STDERR_CAP) {
      stderrBuffer += raw;
    }
    const text = raw.trimEnd();
    if (text) {
      log.warn("pi-rpc", text);
    }
  });
  (child as unknown as PiStartupDiagnostics).piStartupStderr = () => stderrBuffer;

  return child;
}

export function buildPiPromptCommand(text: string): PiPromptCommand {
  return { type: "prompt", message: text };
}

export function buildPiSteerCommand(text: string): PiSteerCommand {
  return { type: "steer", message: text };
}

export function buildGetStateCommand(): PiGetStateCommand {
  return { type: "get_state" };
}

export function sendPiPrompt(child: ChildProcess, text: string): void {
  writePiCommand(child, buildPiPromptCommand(text));
}

export function sendPiSteer(child: ChildProcess, text: string): void {
  writePiCommand(child, buildPiSteerCommand(text));
}

/**
 * Issue a `get_state` command. Its successful `response` carries the Pi-minted
 * session id, which `parsePiEvent` surfaces as a `SystemInit` — the bot's only
 * hook for capturing + persisting that id for resume.
 */
export function sendPiGetState(child: ChildProcess): void {
  writePiCommand(child, buildGetStateCommand());
}

function writePiCommand(child: ChildProcess, command: PiRpcCommand): void {
  if (!child.stdin || child.stdin.destroyed || child.exitCode !== null || child.killed) {
    throw new Error("Pi RPC child process is not available");
  }
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

/**
 * A raw Pi RPC record (stdout line) as decoded from JSONL — either an agent
 * event (`type: "turn_end"` etc.) or a command response (`type: "response"`).
 * Field access is defensive (everything optional) because the translator must
 * never throw on an unexpected/extended shape — it returns null and the caller
 * skips it.
 */
export interface PiRpcEvent {
  type?: string;
  sessionId?: string;
  errorMessage?: string;
  /**
   * For `turn_end`/`message_*` events this is an `AgentMessage` object (an
   * AssistantMessage whose `content` is an array of `{type, text}` blocks), NOT
   * a string. Typed `unknown` so the translator narrows at each use site; the
   * defensive `error`-event path also reads it when it happens to be a string.
   */
  message?: unknown;
  /** `agent_end` carries every `AgentMessage` generated during the run. */
  messages?: unknown;
  assistantMessageEvent?: {
    type?: string;
    /** Text chunk for `text_delta` — the Pi RPC field is `delta`, not `text`. */
    delta?: string;
    [key: string]: unknown;
  };
  // Command-response correlation fields (records with `type: "response"`).
  command?: string;
  success?: boolean;
  data?: { sessionId?: string; [key: string]: unknown };
  error?: string;
  toolName?: string;
  tool?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Concatenate the text blocks of a Pi `AgentMessage` (AssistantMessage). Pi
 * emits `turn_end.message` as an object whose `content` is an array of
 * `{type, text}` blocks — never a bare string. Returns "" for any other shape
 * so the translator never throws.
 */
function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * Extract the run's final assistant text from `agent_end.messages` by
 * concatenating the text blocks of the LAST assistant message.
 */
function extractFinalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg &&
      typeof msg === "object" &&
      (msg as { role?: unknown }).role === "assistant"
    ) {
      return extractAssistantText(msg);
    }
  }
  return "";
}

/**
 * Translate a single Pi RPC event into the bot's existing 8-variant `StreamLine`
 * union so the downstream stream-relay/delivery path needs no changes.
 *
 * Mapping (per Plan A Technical Details, field shapes per Pi's `docs/rpc.md`):
 * - `message_update` w/ `assistantMessageEvent.type === "text_delta"` → `StreamEvent`
 *   carrying `event.delta = { type: "text_delta", text }` from the Pi event's
 *   `assistantMessageEvent.delta` chunk (drives live streaming).
 * - `tool_execution_start` → synthetic `StreamEvent` shaped as a
 *   `content_block_start` tool_use block so stream-relay flips `sawNonTextBlock`.
 * - `agent_end` → terminal `ResultMessage`; the result text is the FINAL assistant
 *   message text reconstructed from `agent_end.messages`. `agent_end` fires exactly
 *   once at the very end of a run.
 * - `turn_end` → `null`. It is a per-turn boundary that fires once PER turn, so a
 *   multi-turn (tool-using) response emits several `turn_end`s before its single
 *   `agent_end`. Treating `turn_end` as terminal truncates such responses at their
 *   first turn — only `agent_end` is terminal.
 * - `response` → a successful `get_state`/`get_session_stats` reply yields a
 *   `SystemInit` capturing `data.sessionId` (the ONLY place Pi exposes the
 *   session id — no event carries it). A failed reply (`success: false`) is
 *   correlated by `command`: a failed `prompt` yields an error `ResultMessage`
 *   (the turn cannot proceed), but a failed side-command (`steer`, `get_state`,
 *   `set_model`, …) returns null + logs — mapping it to a terminal result would
 *   truncate the in-flight prompt turn whose stdout it shares.
 * - `auto_retry_start` / `auto_retry_end` → `RateLimitEvent` (raw error message
 *   preserved for the Task 4 retry classifier).
 * - `error` → error `ResultMessage` (`subtype: "error_during_execution"`).
 *
 * Returns null for unknown/ignored records (e.g. `tool_execution_update/end`,
 * non-text `message_update` deltas, responses with no session id) so the caller
 * skips them.
 */
export function parsePiEvent(rawEvent: PiRpcEvent | null | undefined): StreamLine | null {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  switch (rawEvent.type) {
    case "message_update": {
      const inner = rawEvent.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
        const event: StreamEvent = {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: inner.delta },
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
      // Per-turn boundary, NOT terminal. A multi-turn (tool-using) response fires
      // turn_end once per turn; the run only truly ends at agent_end (fires once).
      // Mapping turn_end to a ResultMessage truncates such responses at turn 1.
      return null;

    case "agent_end": {
      const result: ResultMessage = {
        type: "result",
        result: extractFinalAssistantText(rawEvent.messages),
        session_id: rawEvent.sessionId ?? "",
      };
      return result;
    }

    case "response": {
      // Command responses are side-channel replies, NOT prompt-turn stream
      // content. The terminal event of a prompt turn is `agent_end` (or a
      // top-level `error`). A `response` shares the same stdout the active turn
      // is reading, so it must be correlated by `command` before being treated
      // as terminal:
      //  - a failed `prompt` response IS terminal — the prompt was rejected, so
      //    no `agent_end` will ever arrive; surface it as an error result so the
      //    turn ends now instead of hanging until the activity timeout.
      //  - a failed side-command response (`steer`, `get_state`, `set_model`, …)
      //    must NOT be mapped to a terminal result: a mid-turn `steer` rejection
      //    would otherwise truncate the in-flight response (and the steered
      //    message has already been dropped from the queue). Log + return null so
      //    the failure is visible without ending the turn.
      // A successful `get_state`/`get_session_stats` reply carries the Pi-minted
      // session id (no event exposes it) and is captured below.
      if (rawEvent.success === false) {
        if (rawEvent.command === "prompt") {
          const result: ResultMessage = {
            type: "result",
            subtype: "error_during_execution",
            result: rawEvent.error ?? "Pi RPC command failed",
            session_id: "",
            is_error: true,
          };
          return result;
        }
        log.warn(
          "pi-rpc",
          `Pi RPC command failed (ignored in stream): command=${rawEvent.command ?? "unknown"} error=${rawEvent.error ?? "(none)"}`,
        );
        return null;
      }
      const sessionId = rawEvent.data?.sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        const init: SystemInit = {
          type: "system",
          subtype: "init",
          session_id: sessionId,
        };
        return init;
      }
      return null;
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
      const fallbackMessage =
        typeof rawEvent.message === "string" ? rawEvent.message : undefined;
      const result: ResultMessage = {
        type: "result",
        subtype: "error_during_execution",
        result: rawEvent.errorMessage ?? fallbackMessage ?? "Pi RPC error",
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
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error("Pi RPC child process stdout is not available");
  }

  const splitter = new NewlineOnlyJsonlSplitter();

  // destroyOnReturn:false honors the single-consumer handoff contract: the
  // spawn-path get_state capture opens this generator, reads the one SystemInit
  // record, then calls generator.return() to stop. A default async iterator would
  // destroy child.stdout on that early return, breaking every later
  // sendSessionMessage (each opens a fresh readPiStream on the same stdout).
  for await (const chunk of stdout.iterator({ destroyOnReturn: false })) {
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

export function parsePiRecord(record: string): StreamLine | null {
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
