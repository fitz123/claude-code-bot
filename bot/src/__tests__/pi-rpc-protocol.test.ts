import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import {
  NewlineOnlyJsonlSplitter,
  buildGetStateCommand,
  buildPiPromptCommand,
  buildPiSpawnArgs,
  buildPiSpawnEnv,
  buildPiSteerCommand,
  extractPiTextDelta,
  parsePiEvent,
  readPiStream,
  sendPiGetState,
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

  it("appends --session with the resume session id when one is provided", () => {
    const args = buildPiSpawnArgs(testAgent, "pi-sess-resume");
    const idx = args.indexOf("--session");

    assert.notStrictEqual(idx, -1, "should include --session on resume");
    assert.strictEqual(args[idx + 1], "pi-sess-resume");
  });

  it("omits --session on a fresh start (no resume id, or a blank one)", () => {
    assert.ok(!buildPiSpawnArgs(testAgent).includes("--session"), "no arg => fresh start");
    assert.ok(!buildPiSpawnArgs(testAgent, "").includes("--session"), "blank id => fresh start");
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

  it("builds a no-argument get_state command object", () => {
    assert.deepStrictEqual(buildGetStateCommand(), { type: "get_state" });
  });

  it("writes get_state commands to stdin", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const child = createMockChild({ stdin });

    sendPiGetState(child);

    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString().trim()), {
      type: "get_state",
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

  it("treats turn_end as a non-terminal per-turn boundary (returns null)", () => {
    // turn_end fires once per turn; only agent_end is terminal. Mapping turn_end
    // to a ResultMessage would truncate a multi-turn (tool-using) response at its
    // first turn, so turn_end must translate to null regardless of its content.
    assert.strictEqual(
      parsePiEvent({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "partial turn text" },
          ],
        },
      }),
      null,
    );
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

  it("yields empty result text (not a crash) for an agent_end with no assistant text", () => {
    const line = parsePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] }],
    });

    assert.ok(line);
    assert.strictEqual((line as { result: string }).result, "");
    // agent_end here carries no top-level sessionId — that comes from get_state.
    assert.strictEqual((line as { session_id: string }).session_id, "");
  });

  it("multi-turn sequence (2x turn_end + 1x agent_end) terminates exactly once with the FINAL text", () => {
    // Verified live sequence: a tool-using response fires turn_end per turn, then
    // a single agent_end. Only agent_end is terminal, and it carries the final answer.
    const sequence = [
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "let me check" }] },
      },
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "still working" }] },
      },
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "do the thing" },
          { role: "assistant", content: [{ type: "text", text: "let me check" }] },
          { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
          { role: "assistant", content: [{ type: "text", text: "the final answer" }] },
        ],
      },
    ];

    const lines = sequence.map((e) => parsePiEvent(e));
    const terminals = lines.filter((l) => l?.type === "result");

    assert.strictEqual(terminals.length, 1);
    assert.strictEqual((terminals[0] as { result: string }).result, "the final answer");
    // The two turn_end boundaries do not terminate.
    assert.strictEqual(lines[0], null);
    assert.strictEqual(lines[1], null);
  });

  it("single-turn sequence (1x turn_end + 1x agent_end) terminates exactly once", () => {
    const sequence = [
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "quick answer" }] },
      },
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "quick answer" }] },
        ],
      },
    ];

    const lines = sequence.map((e) => parsePiEvent(e));
    const terminals = lines.filter((l) => l?.type === "result");

    assert.strictEqual(terminals.length, 1);
    assert.strictEqual((terminals[0] as { result: string }).result, "quick answer");
    assert.strictEqual(lines[0], null);
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
      // A non-terminal turn_end is filtered out by the stream (returns null).
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "mid" }] },
      }),
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
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
    assert.strictEqual((lines[2] as { result: string }).result, "ok");
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

  it("does not destroy stdout on early return, so a second consumer can resume (single-consumer handoff)", async () => {
    // Models the spawn-path get_state capture: read exactly the SystemInit
    // record, stop the generator, then open a FRESH readPiStream on the SAME
    // child for the first sendSessionMessage. The first generator must leave
    // child.stdout intact (destroyOnReturn:false) or the handoff breaks.
    const stdout = new Readable({ read() {} });
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdout });

    // First consumer: the get_state capture reads one SystemInit then stops.
    const first = readPiStream(child);
    stdout.push(
      JSON.stringify({
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "pi-handoff-1" },
      }) + "\n",
    );
    const r1 = await first.next();
    assert.strictEqual(r1.done, false);
    assert.strictEqual(r1.value.type, "system");
    assert.strictEqual((r1.value as { session_id: string }).session_id, "pi-handoff-1");
    await first.return(undefined);

    assert.strictEqual(stdout.destroyed, false, "early return must NOT destroy stdout");

    // Second consumer: a fresh readPiStream keeps reading the same stdout.
    const second = readPiStream(child);
    stdout.push(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after handoff" },
      }) + "\n",
    );
    const r2 = await second.next();
    assert.strictEqual(r2.done, false);
    assert.strictEqual(extractPiTextDelta(r2.value), "after handoff");
    await second.return(undefined);
  });
});
