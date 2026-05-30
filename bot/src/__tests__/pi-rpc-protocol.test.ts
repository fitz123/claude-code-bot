import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  NewlineOnlyJsonlSplitter,
  buildPiPromptCommand,
  buildPiSpawnArgs,
  buildPiSpawnEnv,
  buildPiSteerCommand,
  sendPiPrompt,
  sendPiSteer,
} from "../pi-rpc-protocol.js";
import type { AgentConfig } from "../types.js";

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
  it("removes Claude OAuth token while preserving unrelated env", () => {
    const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const oldMarker = process.env.PI_RPC_TEST_MARKER;

    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "secret";
      process.env.PI_RPC_TEST_MARKER = "keep";

      const env = buildPiSpawnEnv(testAgent);

      assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.strictEqual(env.PI_RPC_TEST_MARKER, "keep");
    } finally {
      if (oldClaudeToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaudeToken;
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
