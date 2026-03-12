import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildSpawnArgs,
  buildSpawnEnv,
  buildUserMessage,
  sendMessage,
  parseStreamLine,
  extractTextDelta,
} from "../cli-protocol.js";
import type { AgentConfig } from "../types.js";

const testAgent: AgentConfig = {
  id: "main",
  workspaceCwd: "/Users/ninja/.openclaw/workspace",
  model: "claude-opus-4-6",
  fallbackModel: "claude-sonnet-4-6",
  maxTurns: 50,
};

describe("buildSpawnArgs", () => {
  it("includes required flags", () => {
    const args = buildSpawnArgs({ agent: testAgent });
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--input-format"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--permission-mode"));
    assert.ok(args.includes("bypassPermissions"));
    assert.ok(args.includes("--include-partial-messages"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("claude-opus-4-6"));
  });

  it("includes fallback model", () => {
    const args = buildSpawnArgs({ agent: testAgent });
    assert.ok(args.includes("--fallback-model"));
    assert.ok(args.includes("claude-sonnet-4-6"));
  });

  it("includes session-id when provided", () => {
    const args = buildSpawnArgs({ agent: testAgent, sessionId: "test-uuid" });
    assert.ok(args.includes("--session-id"));
    assert.ok(args.includes("test-uuid"));
  });

  it("uses --resume <sessionId> when resuming (not --session-id)", () => {
    const args = buildSpawnArgs({ agent: testAgent, sessionId: "test-uuid", resume: true });
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("test-uuid"));
    // --session-id must NOT be present when resuming
    assert.ok(!args.includes("--session-id"));
    // --resume takes the session ID as its argument
    const resumeIdx = args.indexOf("--resume");
    assert.strictEqual(args[resumeIdx + 1], "test-uuid");
  });

  it("includes --add-dir with workspace", () => {
    const args = buildSpawnArgs({ agent: testAgent });
    assert.ok(args.includes("--add-dir"));
    assert.ok(args.includes("/Users/ninja/.openclaw/workspace"));
  });

  it("includes --max-turns", () => {
    const args = buildSpawnArgs({ agent: testAgent });
    assert.ok(args.includes("--max-turns"));
    assert.ok(args.includes("50"));
  });

  it("omits optional flags when not set", () => {
    const minAgent: AgentConfig = {
      id: "min",
      workspaceCwd: "/tmp",
      model: "opus",
    };
    const args = buildSpawnArgs({ agent: minAgent });
    assert.ok(!args.includes("--fallback-model"));
    assert.ok(!args.includes("--max-turns"));
    assert.ok(!args.includes("--append-system-prompt"));
  });
});

describe("buildSpawnEnv", () => {
  it("removes CLAUDECODE", () => {
    process.env.CLAUDECODE = "1";
    const env = buildSpawnEnv();
    assert.strictEqual(env.CLAUDECODE, undefined);
    delete process.env.CLAUDECODE;
  });

  it("sets required env vars", () => {
    const env = buildSpawnEnv();
    assert.strictEqual(env.HOME, "/Users/ninja");
    assert.strictEqual(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.strictEqual(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.strictEqual(env.CLAUDE_CODE_DISABLE_CRON, "1");
    assert.strictEqual(env.CLAUDE_CODE_EXIT_AFTER_STOP_DELAY, "900000");
    assert.strictEqual(env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
    assert.strictEqual(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  });

  it("includes /opt/homebrew/bin in PATH", () => {
    const env = buildSpawnEnv();
    assert.ok(env.PATH?.includes("/opt/homebrew/bin"));
  });
});

describe("buildUserMessage", () => {
  it("creates correct message structure", () => {
    const msg = buildUserMessage("hello", "sess-123");
    assert.strictEqual(msg.type, "user");
    assert.strictEqual(msg.message.role, "user");
    assert.strictEqual(msg.message.content, "hello");
    assert.strictEqual(msg.parent_tool_use_id, null);
    assert.strictEqual(msg.session_id, "sess-123");
  });
});

describe("parseStreamLine", () => {
  it("parses system/init", () => {
    const line = '{"type":"system","subtype":"init","session_id":"abc-123"}';
    const parsed = parseStreamLine(line);
    assert.ok(parsed);
    assert.strictEqual(parsed!.type, "system");
    assert.strictEqual((parsed as { session_id: string }).session_id, "abc-123");
  });

  it("parses stream_event with text delta", () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}';
    const parsed = parseStreamLine(line);
    assert.ok(parsed);
    assert.strictEqual(parsed!.type, "stream_event");
  });

  it("parses result", () => {
    const line = '{"type":"result","result":"Done","session_id":"abc","cost_usd":0.01}';
    const parsed = parseStreamLine(line);
    assert.ok(parsed);
    assert.strictEqual(parsed!.type, "result");
    assert.strictEqual((parsed as { result: string }).result, "Done");
  });

  it("returns null for empty lines", () => {
    assert.strictEqual(parseStreamLine(""), null);
    assert.strictEqual(parseStreamLine("   "), null);
  });

  it("returns null for non-JSON lines", () => {
    assert.strictEqual(parseStreamLine("not json"), null);
    assert.strictEqual(parseStreamLine("debug: something"), null);
  });

  it("returns null for invalid JSON", () => {
    assert.strictEqual(parseStreamLine("{broken"), null);
  });
});

describe("extractTextDelta", () => {
  it("extracts text from stream_event", () => {
    const msg = parseStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}}'
    )!;
    assert.strictEqual(extractTextDelta(msg), "world");
  });

  it("returns null for non-text deltas", () => {
    const msg = parseStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta"}}}'
    )!;
    assert.strictEqual(extractTextDelta(msg), null);
  });

  it("returns null for non-stream-event", () => {
    const msg = parseStreamLine('{"type":"result","result":"done","session_id":"x"}')!;
    assert.strictEqual(extractTextDelta(msg), null);
  });
});

describe("sendMessage", () => {
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

  it("throws when child exitCode is set (process exited)", () => {
    const child = createMockChild({ exitCode: 1 });
    assert.throws(
      () => sendMessage(child, "hello", "sess-1"),
      /Child process is not available/
    );
  });

  it("throws when child is killed", () => {
    const child = createMockChild({ killed: true });
    assert.throws(
      () => sendMessage(child, "hello", "sess-1"),
      /Child process is not available/
    );
  });

  it("throws when stdin is destroyed", () => {
    const child = createMockChild();
    child.stdin!.destroy();
    assert.throws(
      () => sendMessage(child, "hello", "sess-1"),
      /Child process is not available/
    );
  });

  it("throws when stdin is null", () => {
    const child = createMockChild({ stdin: null });
    assert.throws(
      () => sendMessage(child, "hello", "sess-1"),
      /Child process is not available/
    );
  });

  it("writes JSON message to stdin for live process", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    const child = createMockChild({ stdin });
    sendMessage(child, "hello", "sess-1");
    const written = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(written.trim());
    assert.strictEqual(parsed.type, "user");
    assert.strictEqual(parsed.message.content, "hello");
    assert.strictEqual(parsed.session_id, "sess-1");
  });
});
