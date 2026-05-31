import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import {
  NewlineOnlyJsonlSplitter,
  buildPiPromptCommand,
  buildPiSpawnArgs,
  buildPiSpawnEnv,
  buildPiSteerCommand,
  extractPiTextDelta,
  parsePiEvent,
  readPiStream,
  sendPiPrompt,
  sendPiSteer,
} from "../pi-rpc-protocol.js";
import type { AgentConfig, StreamLine } from "../types.js";

const testAgent: AgentConfig = {
  id: "main",
  workspaceCwd: "/tmp/test-workspace",
  model: "gpt-5.5",
  fallbackModel: "claude-sonnet-4-6",
  maxTurns: 50,
  effort: "high",
};

describe("NewlineOnlyJsonlSplitter", () => {
  it("does not split on U+2028 or U+2029 inside JSON strings", () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const firstRecord = JSON.stringify({
      message: `before${lineSeparator}middle${paragraphSeparator}after`,
    });
    const secondRecord = JSON.stringify({ message: "done" });
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(
      splitter.push(Buffer.from(`${firstRecord}\n${secondRecord}\n`)),
      [firstRecord, secondRecord],
    );
  });

  it("accepts CRLF by stripping the trailing carriage return", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"ok\":true}\r\n")), [
      "{\"ok\":true}",
    ]);
  });

  it("does not split on a lone carriage return", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"a\":1}\r")), []);
    assert.deepStrictEqual(splitter.push(Buffer.from("{\"b\":2}\n")), [
      "{\"a\":1}\r{\"b\":2}",
    ]);
  });

  it("splits only on LF and reassembles partial chunks", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"text\":\"hel")), []);
    assert.deepStrictEqual(splitter.push(Buffer.from("lo\"}\n{\"n\"")), [
      "{\"text\":\"hello\"}",
    ]);
    assert.deepStrictEqual(splitter.push(Buffer.from(":2}\n")), [
      "{\"n\":2}",
    ]);
  });

  it("preserves multibyte characters split across chunks", () => {
    const splitter = new NewlineOnlyJsonlSplitter();
    const record = JSON.stringify({ text: String.fromCharCode(0x20ac) });
    const framed = Buffer.from(`${record}\n`);
    const splitAt = framed.indexOf(0xe2) + 1;

    assert.deepStrictEqual(splitter.push(framed.subarray(0, splitAt)), []);
    assert.deepStrictEqual(splitter.push(framed.subarray(splitAt)), [record]);
  });

  it("flushes an unterminated trailing record on end()", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"a\":1")), []);
    assert.deepStrictEqual(splitter.end(), ["{\"a\":1"]);
  });

  it("strips a trailing carriage return from the final record on end()", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    splitter.push(Buffer.from("{\"a\":1}\r"));
    assert.deepStrictEqual(splitter.end(), ["{\"a\":1}"]);
  });

  it("returns no records on end() when nothing is buffered", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"a\":1}\n")), [
      "{\"a\":1}",
    ]);
    assert.deepStrictEqual(splitter.end(), []);
  });
});

describe("buildPiSpawnArgs", () => {
  it("builds the Pi RPC OpenAI Codex command arguments", () => {
    assert.deepStrictEqual(buildPiSpawnArgs(testAgent), [
      "--mode", "rpc",
      "--provider", "openai-codex",
      "--model", "openai-codex/gpt-5.5",
    ]);
  });

  it("keeps an already-prefixed model", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      model: "openai-codex/gpt-5.5",
    });

    assert.strictEqual(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
  });

  it("uses the default Pi model when the model is blank", () => {
    const args = buildPiSpawnArgs({ ...testAgent, model: " " });

    assert.strictEqual(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
  });

  it("passes the agent system prompt as an append-system-prompt argument", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      systemPrompt: "You are precise.",
    });
    const promptIndex = args.indexOf("--append-system-prompt");

    assert.notStrictEqual(promptIndex, -1);
    assert.strictEqual(args[promptIndex + 1], "You are precise.");
  });

  it("omits Claude-only flags", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      systemPrompt: "persona",
    });

    assert.ok(!args.includes("--fallback-model"));
    assert.ok(!args.includes("--max-turns"));
    assert.ok(!args.includes("--effort"));
    assert.ok(!args.includes("--add-dir"));
  });
});

describe("buildPiSpawnEnv", () => {
  it("removes Anthropic credentials while preserving unrelated env", () => {
    const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const oldApiKey = process.env.ANTHROPIC_API_KEY;
    const oldMarker = process.env.PI_RPC_TEST_MARKER;

    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "secret";
      process.env.ANTHROPIC_API_KEY = "secret";
      process.env.PI_RPC_TEST_MARKER = "keep";

      const env = buildPiSpawnEnv(testAgent);

      assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(env.PI_RPC_TEST_MARKER, "keep");
    } finally {
      if (oldClaudeToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaudeToken;
      }

      if (oldApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = oldApiKey;
      }

      if (oldMarker === undefined) {
        delete process.env.PI_RPC_TEST_MARKER;
      } else {
        process.env.PI_RPC_TEST_MARKER = oldMarker;
      }
    }
  });

  it("includes /opt/homebrew/bin in PATH", () => {
    const env = buildPiSpawnEnv(testAgent);

    assert.ok(env.PATH?.includes("/opt/homebrew/bin"));
  });

  it("does not double-prepend /opt/homebrew/bin when already present", () => {
    const oldPath = process.env.PATH;

    try {
      process.env.PATH = "/opt/homebrew/bin:/usr/bin";
      const env = buildPiSpawnEnv(testAgent);

      assert.strictEqual(env.PATH, "/opt/homebrew/bin:/usr/bin");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

  it("scrubs the CLAUDECODE session marker (parity with the Claude path)", () => {
    const oldMarker = process.env.CLAUDECODE;

    try {
      process.env.CLAUDECODE = "1";
      const env = buildPiSpawnEnv(testAgent);

      assert.strictEqual(env.CLAUDECODE, undefined);
    } finally {
      if (oldMarker === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = oldMarker;
      }
    }
  });
});

describe("Pi RPC prompt and steer commands", () => {
  function createMockChild(overrides: Partial<Record<string, unknown>> = {}): ChildProcess {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    Object.assign(child, {
      stdin,
      pid: 1234,
      exitCode: null,
      killed: false,
      ...overrides,
    });
    return child;
  }

  it("builds prompt and steer command objects", () => {
    assert.deepStrictEqual(buildPiPromptCommand("hello"), {
      type: "prompt",
      message: "hello",
    });
    assert.deepStrictEqual(buildPiSteerCommand("stop"), {
      type: "steer",
      message: "stop",
    });
  });

  it("writes prompt commands to stdin", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const child = createMockChild({ stdin });

    sendPiPrompt(child, "hello");

    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString().trim()), {
      type: "prompt",
      message: "hello",
    });
  });

  it("writes steer commands to stdin", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const child = createMockChild({ stdin });

    sendPiSteer(child, "focus");

    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString().trim()), {
      type: "steer",
      message: "focus",
    });
  });

  it("throws when the child process is unavailable", () => {
    assert.throws(
      () => sendPiPrompt(createMockChild({ exitCode: 1 }), "hello"),
      /Pi RPC child process is not available/,
    );
  });
});

/**
 * Mirrors the exact `sawNonTextBlock` detection in stream-relay.ts (the consumer):
 * a stream_event whose `event.type === "content_block_start"` and whose
 * `content_block.type` is set and not "text" flips the flag.
 */
function flipsSawNonTextBlock(msg: StreamLine): boolean {
  if (msg.type !== "stream_event") {
    return false;
  }
  const ev = msg.event as Record<string, unknown>;
  if (ev.type !== "content_block_start") {
    return false;
  }
  const block = ev.content_block as Record<string, unknown> | undefined;
  return Boolean(block?.type && block.type !== "text");
}

describe("parsePiEvent", () => {
  it("translates a text_delta message_update into a streamable StreamEvent", () => {
    const line = parsePiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });

    assert.ok(line);
    assert.strictEqual(line.type, "stream_event");
    assert.strictEqual(extractPiTextDelta(line), "hello");
    assert.strictEqual(flipsSawNonTextBlock(line), false);
  });

  it("ignores non-text message_update deltas and the legacy text field", () => {
    assert.strictEqual(
      parsePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
      }),
      null,
    );
    assert.strictEqual(
      parsePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "" },
      }),
      null,
    );
    // The chunk lives in `delta`, not `text` — a `text` field must not stream.
    assert.strictEqual(
      parsePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", text: "wrong field" },
      }),
      null,
    );
  });

  it("translates tool_execution_start so stream-relay flips sawNonTextBlock", () => {
    const line = parsePiEvent({
      type: "tool_execution_start",
      toolName: "bash",
    });

    assert.ok(line);
    assert.strictEqual(flipsSawNonTextBlock(line), true);
    // A tool block carries no streamable text.
    assert.strictEqual(extractPiTextDelta(line), null);
  });

  it("falls back to a generic tool name when none is provided", () => {
    const line = parsePiEvent({ type: "tool_execution_start" });

    assert.ok(line);
    assert.strictEqual(flipsSawNonTextBlock(line), true);
  });

  it("translates turn_end into a ResultMessage, reconstructing text from the message object", () => {
    // Pi sends `turn_end.message` as an AssistantMessage object, never a string.
    const line = parsePiEvent({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "all " },
          { type: "text", text: "done" },
        ],
      },
    });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    assert.strictEqual((line as { result: string }).result, "all done");
  });

  it("translates agent_end into a ResultMessage with the last assistant message text", () => {
    const line = parsePiEvent({
      type: "agent_end",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "assistant", content: [{ type: "text", text: "final answer" }] },
      ],
    });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    assert.strictEqual((line as { result: string }).result, "final answer");
  });

  it("yields empty result text (not a crash) for a turn_end with no text blocks", () => {
    const line = parsePiEvent({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] },
    });

    assert.ok(line);
    assert.strictEqual((line as { result: string }).result, "");
    // turn_end carries no session id — that comes from a get_state response.
    assert.strictEqual((line as { session_id: string }).session_id, "");
  });

  it("captures the Pi session id from a successful get_state response", () => {
    const line = parsePiEvent({
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "pi-sess-123", isStreaming: false },
    });

    assert.ok(line);
    assert.strictEqual(line.type, "system");
    const init = line as unknown as Record<string, unknown>;
    assert.strictEqual(init.subtype, "init");
    assert.strictEqual(init.session_id, "pi-sess-123");
  });

  it("ignores successful responses that carry no session id", () => {
    assert.strictEqual(parsePiEvent({ type: "response", command: "prompt", success: true }), null);
    assert.strictEqual(
      parsePiEvent({ type: "response", command: "get_state", success: true, data: { sessionId: "" } }),
      null,
    );
  });

  it("surfaces a failed command response as an error ResultMessage", () => {
    const line = parsePiEvent({
      type: "response",
      command: "set_model",
      success: false,
      error: "Model not found: invalid/model",
    });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    const result = line as unknown as Record<string, unknown>;
    assert.strictEqual(result.subtype, "error_during_execution");
    assert.strictEqual(result.result, "Model not found: invalid/model");
    assert.strictEqual(result.is_error, true);
  });

  it("translates auto_retry_start into a rate_limit_event preserving the error message", () => {
    const line = parsePiEvent({
      type: "auto_retry_start",
      errorMessage: "429 Too Many Requests",
    });

    assert.ok(line);
    assert.strictEqual(line.type, "assistant");
    const rateLimit = line as unknown as Record<string, unknown>;
    assert.strictEqual(rateLimit.subtype, "rate_limit_event");
    assert.strictEqual(rateLimit.error_message, "429 Too Many Requests");
    // pi_event_type is the discriminator the dispatch layer uses to distinguish
    // start (counts a retry) from end (does not).
    assert.strictEqual(rateLimit.pi_event_type, "auto_retry_start");
  });

  it("translates auto_retry_end into a rate_limit_event tagged with its event type", () => {
    const line = parsePiEvent({
      type: "auto_retry_end",
      errorMessage: "recovered",
    });

    assert.ok(line);
    assert.strictEqual(line.type, "assistant");
    const rateLimit = line as unknown as Record<string, unknown>;
    assert.strictEqual(rateLimit.subtype, "rate_limit_event");
    assert.strictEqual(rateLimit.error_message, "recovered");
    assert.strictEqual(rateLimit.pi_event_type, "auto_retry_end");
  });

  it("defaults the rate_limit_event error message to an empty string when absent", () => {
    const line = parsePiEvent({ type: "auto_retry_start" });

    assert.ok(line);
    const rateLimit = line as unknown as Record<string, unknown>;
    assert.strictEqual(rateLimit.error_message, "");
  });

  it("translates an error event into an error ResultMessage", () => {
    const line = parsePiEvent({ type: "error", errorMessage: "boom" });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    const result = line as unknown as Record<string, unknown>;
    assert.strictEqual(result.subtype, "error_during_execution");
    assert.strictEqual(result.result, "boom");
    assert.strictEqual(result.is_error, true);
  });

  it("falls back to the message field, then a default, for error result text", () => {
    const fromMessage = parsePiEvent({ type: "error", message: "no errorMessage here" });
    assert.ok(fromMessage);
    assert.strictEqual((fromMessage as { result: string }).result, "no errorMessage here");

    const fromDefault = parsePiEvent({ type: "error" });
    assert.ok(fromDefault);
    assert.strictEqual((fromDefault as { result: string }).result, "Pi RPC error");
  });

  it("returns null for unknown and malformed events", () => {
    assert.strictEqual(parsePiEvent({ type: "tool_execution_update" }), null);
    assert.strictEqual(parsePiEvent({ type: "tool_execution_end" }), null);
    assert.strictEqual(parsePiEvent({}), null);
    assert.strictEqual(parsePiEvent(null), null);
    assert.strictEqual(parsePiEvent(undefined), null);
  });
});

describe("readPiStream", () => {
  function childWithStdout(records: string[]): ChildProcess {
    const child = new EventEmitter() as unknown as ChildProcess;
    const framed = records.map((r) => `${r}\n`).join("");
    Object.assign(child, { stdout: Readable.from([Buffer.from(framed)]) });
    return child;
  }

  it("yields only translated StreamLines, skipping unknown/malformed records", async () => {
    const child = childWithStdout([
      JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionId: "s1" } }),
      "not json",
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
      JSON.stringify({ type: "tool_execution_update" }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      }),
    ]);

    const lines: StreamLine[] = [];
    for await (const line of readPiStream(child)) {
      lines.push(line);
    }

    assert.deepStrictEqual(
      lines.map((l) => l.type),
      ["system", "stream_event", "result"],
    );
    assert.strictEqual(extractPiTextDelta(lines[1]), "hi");
  });

  it("handles records split across stdout chunks", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const record = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "split" },
    });
    const framed = Buffer.from(`${record}\n`);
    const cut = Math.floor(framed.length / 2);
    Object.assign(child, {
      stdout: Readable.from([framed.subarray(0, cut), framed.subarray(cut)]),
    });

    const lines: StreamLine[] = [];
    for await (const line of readPiStream(child)) {
      lines.push(line);
    }

    assert.strictEqual(lines.length, 1);
    assert.strictEqual(extractPiTextDelta(lines[0]), "split");
  });

  it("throws when stdout is unavailable", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    await assert.rejects(readPiStream(child).next(), /stdout is not available/);
  });
});
