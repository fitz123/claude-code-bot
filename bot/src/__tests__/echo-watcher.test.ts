import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  EchoWatcher,
  ECHO_DIR_BASE,
  ECHO_PREFIX,
  type EchoMessage,
} from "../echo-watcher.js";
import { writeEchoInjectFile } from "../inject-file.js";

// Use a test-specific subdirectory to avoid interfering with real echo files.
// The watcher scans ECHO_DIR_BASE subdirectories, so we use the real base
// but create unique chat dirs for testing.
const TEST_CHAT_ID = "__test_echo_chat__";
const TEST_CHAT_DIR = join(ECHO_DIR_BASE, TEST_CHAT_ID);
const TEST_INJECT_DIR = "/tmp/bot-inject/__test_echo_inject__";

function writeEchoFile(
  chatId: string,
  text: string,
  opts?: { threadId?: string | null; filename?: string },
): void {
  const dir = join(ECHO_DIR_BASE, chatId);
  mkdirSync(dir, { recursive: true });
  const fname = opts?.filename ?? `${Date.now()}-${Math.random()}.json`;
  const msg: EchoMessage = {
    chatId,
    threadId: opts?.threadId ?? null,
    text,
    origin: "deliver.sh",
    timestamp: Math.floor(Date.now() / 1000),
  };
  writeFileSync(join(dir, fname), JSON.stringify(msg), "utf-8");
}

beforeEach(() => {
  rmSync(TEST_CHAT_DIR, { recursive: true, force: true });
  rmSync(TEST_INJECT_DIR, { recursive: true, force: true });
  mkdirSync(ECHO_DIR_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_CHAT_DIR, { recursive: true, force: true });
  rmSync(TEST_INJECT_DIR, { recursive: true, force: true });
});

// -------------------------------------------------------------------
// ECHO_PREFIX constant
// -------------------------------------------------------------------

describe("ECHO_PREFIX", () => {
  it("starts with [Bot echo", () => {
    assert.strictEqual(ECHO_PREFIX, "[Bot echo");
  });
});

// -------------------------------------------------------------------
// EchoWatcher.drain()
// -------------------------------------------------------------------

describe("EchoWatcher.drain", () => {
  it("processes existing echo files and calls handler with correct args", () => {
    writeEchoFile(TEST_CHAT_ID, "Hello from cron");

    const calls: Array<{ chatId: string; threadId: string | undefined; text: string }> = [];
    const watcher = new EchoWatcher({
      handler: (chatId, threadId, text) => calls.push({ chatId, threadId, text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].chatId, TEST_CHAT_ID);
    assert.strictEqual(calls[0].threadId, undefined);
    assert.strictEqual(calls[0].text, "Hello from cron");
  });

  it("passes threadId when present", () => {
    writeEchoFile(TEST_CHAT_ID, "threaded msg", { threadId: "42" });

    const calls: Array<{ chatId: string; threadId: string | undefined; text: string }> = [];
    const watcher = new EchoWatcher({
      handler: (chatId, threadId, text) => calls.push({ chatId, threadId, text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].threadId, "42");
  });

  it("converts null threadId to undefined", () => {
    writeEchoFile(TEST_CHAT_ID, "no thread", { threadId: null });

    const calls: Array<{ chatId: string; threadId: string | undefined; text: string }> = [];
    const watcher = new EchoWatcher({
      handler: (chatId, threadId, text) => calls.push({ chatId, threadId, text }),
    });

    watcher.drain();

    assert.strictEqual(calls[0].threadId, undefined);
  });

  it("cleans up echo files after processing", () => {
    writeEchoFile(TEST_CHAT_ID, "cleanup test");

    const watcher = new EchoWatcher({
      handler: () => {},
    });

    watcher.drain();

    const remaining = readdirSync(TEST_CHAT_DIR).filter((f) => f.endsWith(".json"));
    assert.strictEqual(remaining.length, 0);
  });

  it("processes multiple files in sorted order", () => {
    writeEchoFile(TEST_CHAT_ID, "second", { filename: "2-1-1.json" });
    writeEchoFile(TEST_CHAT_ID, "first", { filename: "1-1-1.json" });
    writeEchoFile(TEST_CHAT_ID, "third", { filename: "3-1-1.json" });

    const texts: string[] = [];
    const watcher = new EchoWatcher({
      handler: (_chatId, _threadId, text) => texts.push(text),
    });

    watcher.drain();

    assert.deepStrictEqual(texts, ["first", "second", "third"]);
  });

  it("processes files from multiple chat directories", () => {
    const chatId2 = "__test_echo_chat_2__";
    const chatDir2 = join(ECHO_DIR_BASE, chatId2);

    try {
      writeEchoFile(TEST_CHAT_ID, "msg from chat 1");
      writeEchoFile(chatId2, "msg from chat 2");

      const calls: Array<{ chatId: string; text: string }> = [];
      const watcher = new EchoWatcher({
        handler: (chatId, _threadId, text) => calls.push({ chatId, text }),
      });

      watcher.drain();

      assert.strictEqual(calls.length, 2);
      const chatIds = calls.map((c) => c.chatId).sort();
      assert.ok(chatIds.includes(TEST_CHAT_ID));
      assert.ok(chatIds.includes(chatId2));
    } finally {
      rmSync(chatDir2, { recursive: true, force: true });
    }
  });

  it("skips malformed JSON files without crashing", () => {
    mkdirSync(TEST_CHAT_DIR, { recursive: true });
    writeFileSync(join(TEST_CHAT_DIR, "bad-1-1.json"), "not json{{{", "utf-8");
    writeEchoFile(TEST_CHAT_ID, "good msg", { filename: "good-2-1.json" });

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].text, "good msg");
  });

  it("handles empty echo directory", () => {
    const watcher = new EchoWatcher({
      handler: () => {
        assert.fail("handler should not be called");
      },
    });

    // Should not throw
    watcher.drain();
  });
});

// -------------------------------------------------------------------
// EchoWatcher.start / stop
// -------------------------------------------------------------------

describe("EchoWatcher lifecycle", () => {
  it("start and stop without errors", () => {
    const watcher = new EchoWatcher({
      handler: () => {},
      pollIntervalMs: 50,
    });

    watcher.start();
    watcher.stop();
  });

  it("stop is safe to call multiple times", () => {
    const watcher = new EchoWatcher({
      handler: () => {},
    });

    watcher.start();
    watcher.stop();
    watcher.stop();
  });
});

// -------------------------------------------------------------------
// writeEchoInjectFile
// -------------------------------------------------------------------

describe("writeEchoInjectFile", () => {
  it("writes to pending-echo, not pending", () => {
    mkdirSync(TEST_INJECT_DIR, { recursive: true });
    writeEchoInjectFile(TEST_INJECT_DIR, ["echo msg"]);

    assert.ok(existsSync(join(TEST_INJECT_DIR, "pending-echo")));
    assert.ok(!existsSync(join(TEST_INJECT_DIR, "pending")));
  });

  it("writes message count header and content", () => {
    mkdirSync(TEST_INJECT_DIR, { recursive: true });
    writeEchoInjectFile(TEST_INJECT_DIR, ["msg1", "msg2"]);

    const content = readFileSync(join(TEST_INJECT_DIR, "pending-echo"), "utf-8");
    const lines = content.split("\n");
    assert.strictEqual(lines[0], "2");
    assert.ok(content.includes("msg1"));
    assert.ok(content.includes("msg2"));
    assert.ok(content.includes("---"));
  });

  it("creates directory if it does not exist", () => {
    const nestedDir = join(TEST_INJECT_DIR, "nested", "dir");
    writeEchoInjectFile(nestedDir, ["test"]);

    assert.ok(existsSync(join(nestedDir, "pending-echo")));
    rmSync(nestedDir, { recursive: true, force: true });
  });

  it("does not leave temp files on success", () => {
    mkdirSync(TEST_INJECT_DIR, { recursive: true });
    writeEchoInjectFile(TEST_INJECT_DIR, ["msg"]);

    const files = readdirSync(TEST_INJECT_DIR);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    assert.strictEqual(tmpFiles.length, 0);
  });

  it("overwrites existing pending-echo file atomically", () => {
    mkdirSync(TEST_INJECT_DIR, { recursive: true });
    writeEchoInjectFile(TEST_INJECT_DIR, ["old"]);
    writeEchoInjectFile(TEST_INJECT_DIR, ["new1", "new2"]);

    const content = readFileSync(join(TEST_INJECT_DIR, "pending-echo"), "utf-8");
    assert.strictEqual(content.split("\n")[0], "2");
    assert.ok(!content.includes("old"));
    assert.ok(content.includes("new1"));
    assert.ok(content.includes("new2"));
  });
});

// -------------------------------------------------------------------
// onFlush callback (accumulation support)
// -------------------------------------------------------------------

describe("EchoWatcher.onFlush", () => {
  it("calls onFlush after processing each chat directory", () => {
    writeEchoFile(TEST_CHAT_ID, "msg1");

    let flushCount = 0;
    const watcher = new EchoWatcher({
      handler: () => {},
      onFlush: () => flushCount++,
    });

    watcher.drain();

    assert.strictEqual(flushCount, 1);
  });

  it("calls onFlush once per chat directory", () => {
    const chatId2 = "__test_echo_chat_flush2__";
    const chatDir2 = join(ECHO_DIR_BASE, chatId2);

    try {
      writeEchoFile(TEST_CHAT_ID, "msg from chat 1");
      writeEchoFile(chatId2, "msg from chat 2");

      let flushCount = 0;
      const watcher = new EchoWatcher({
        handler: () => {},
        onFlush: () => flushCount++,
      });

      watcher.drain();

      assert.strictEqual(flushCount, 2);
    } finally {
      rmSync(chatDir2, { recursive: true, force: true });
    }
  });

  it("enables accumulation pattern: handler collects, onFlush writes", () => {
    // Simulate 3 split message chunks for the same chat
    writeEchoFile(TEST_CHAT_ID, "chunk 1", { filename: "1-1-1.json" });
    writeEchoFile(TEST_CHAT_ID, "chunk 2", { filename: "2-1-1.json" });
    writeEchoFile(TEST_CHAT_ID, "chunk 3", { filename: "3-1-1.json" });

    const accumulated = new Map<string, string[]>();

    const watcher = new EchoWatcher({
      handler: (chatId, _threadId, text) => {
        const existing = accumulated.get(chatId);
        if (existing) {
          existing.push(text);
        } else {
          accumulated.set(chatId, [text]);
        }
      },
      onFlush: () => {
        for (const [dir, messages] of accumulated) {
          mkdirSync(join(TEST_INJECT_DIR, dir), { recursive: true });
          writeEchoInjectFile(join(TEST_INJECT_DIR, dir), messages);
        }
        accumulated.clear();
      },
    });

    watcher.drain();

    // All 3 chunks should be in a single pending-echo file
    const outputDir = join(TEST_INJECT_DIR, TEST_CHAT_ID);
    const content = readFileSync(join(outputDir, "pending-echo"), "utf-8");
    assert.strictEqual(content.split("\n")[0], "3");
    assert.ok(content.includes("chunk 1"));
    assert.ok(content.includes("chunk 2"));
    assert.ok(content.includes("chunk 3"));

    rmSync(outputDir, { recursive: true, force: true });
  });
});

// -------------------------------------------------------------------
// Integration: handler + accumulation simulating telegram-bot.ts flow
// -------------------------------------------------------------------

import { resolveBinding, sessionKey } from "../telegram-bot.js";
import { injectDirForChat } from "../inject-file.js";
import type { TelegramBinding } from "../types.js";

describe("Echo handler integration (simulated telegram-bot handler)", () => {
  const TEST_BINDINGS: TelegramBinding[] = [
    { chatId: 12345, agentId: "main", kind: "dm", requireMention: false },
    { chatId: 67890, agentId: "other", kind: "group", requireMention: true },
  ];
  const TEST_CHAT_NUMERIC = "12345";
  const TEST_CHAT_REQUIRE_MENTION = "67890";
  const INJECT_DIRS_TO_CLEAN: string[] = [];

  afterEach(() => {
    for (const dir of INJECT_DIRS_TO_CLEAN) {
      rmSync(dir, { recursive: true, force: true });
    }
    INJECT_DIRS_TO_CLEAN.length = 0;
    rmSync(join(ECHO_DIR_BASE, TEST_CHAT_NUMERIC), { recursive: true, force: true });
    rmSync(join(ECHO_DIR_BASE, TEST_CHAT_REQUIRE_MENTION), { recursive: true, force: true });
  });

  function createHandlerAndWatcher(bindings: TelegramBinding[]) {
    const echoAccumulator = new Map<string, string[]>();

    const watcher = new EchoWatcher({
      handler: (chatId, threadId, text) => {
        const numericChatId = parseInt(chatId, 10);
        const numericThreadId = threadId ? parseInt(threadId, 10) : undefined;

        const binding = resolveBinding(numericChatId, bindings, numericThreadId);
        if (!binding) return;
        if (binding.requireMention !== false) return;

        const key = sessionKey(numericChatId, numericThreadId);
        const injectDir = injectDirForChat(key);

        const framedText = `${ECHO_PREFIX} — context only, no reply needed]\n\n${text}`;

        const existing = echoAccumulator.get(injectDir);
        if (existing) {
          existing.push(framedText);
        } else {
          echoAccumulator.set(injectDir, [framedText]);
        }
      },
      onFlush: () => {
        for (const [dir, messages] of echoAccumulator) {
          mkdirSync(dir, { recursive: true });
          writeEchoInjectFile(dir, messages);
          INJECT_DIRS_TO_CLEAN.push(dir);
        }
        echoAccumulator.clear();
      },
    });

    return watcher;
  }

  it("writes framed echo to correct inject dir for requireMention:false binding", () => {
    writeEchoFile(TEST_CHAT_NUMERIC, "Hello from deliver.sh");
    const watcher = createHandlerAndWatcher(TEST_BINDINGS);
    watcher.drain();

    const key = sessionKey(12345);
    const injectDir = injectDirForChat(key);
    const content = readFileSync(join(injectDir, "pending-echo"), "utf-8");
    assert.ok(content.includes("[Bot echo"));
    assert.ok(content.includes("Hello from deliver.sh"));
  });

  it("skips bindings with requireMention !== false", () => {
    writeEchoFile(TEST_CHAT_REQUIRE_MENTION, "Should be skipped");
    const watcher = createHandlerAndWatcher(TEST_BINDINGS);
    watcher.drain();

    const key = sessionKey(67890);
    const injectDir = injectDirForChat(key);
    assert.ok(!existsSync(join(injectDir, "pending-echo")));
  });

  it("skips unknown chat IDs", () => {
    const unknownChatId = "99999";
    const unknownDir = join(ECHO_DIR_BASE, unknownChatId);
    try {
      writeEchoFile(unknownChatId, "Should be skipped");
      const watcher = createHandlerAndWatcher(TEST_BINDINGS);
      watcher.drain();

      const key = sessionKey(99999);
      const injectDir = injectDirForChat(key);
      assert.ok(!existsSync(join(injectDir, "pending-echo")));
    } finally {
      rmSync(unknownDir, { recursive: true, force: true });
    }
  });

  it("accumulates split messages into single pending-echo write", () => {
    writeEchoFile(TEST_CHAT_NUMERIC, "part 1", { filename: "1-1-1.json" });
    writeEchoFile(TEST_CHAT_NUMERIC, "part 2", { filename: "2-1-1.json" });
    writeEchoFile(TEST_CHAT_NUMERIC, "part 3", { filename: "3-1-1.json" });

    const watcher = createHandlerAndWatcher(TEST_BINDINGS);
    watcher.drain();

    const key = sessionKey(12345);
    const injectDir = injectDirForChat(key);
    const content = readFileSync(join(injectDir, "pending-echo"), "utf-8");
    // Should have 3 messages in a single file
    assert.strictEqual(content.split("\n")[0], "3");
    assert.ok(content.includes("part 1"));
    assert.ok(content.includes("part 2"));
    assert.ok(content.includes("part 3"));
  });

  it("frames text with ECHO_PREFIX", () => {
    writeEchoFile(TEST_CHAT_NUMERIC, "test message");
    const watcher = createHandlerAndWatcher(TEST_BINDINGS);
    watcher.drain();

    const key = sessionKey(12345);
    const injectDir = injectDirForChat(key);
    const content = readFileSync(join(injectDir, "pending-echo"), "utf-8");
    assert.ok(content.includes("[Bot echo — context only, no reply needed]"));
    assert.ok(content.includes("test message"));
  });
});
