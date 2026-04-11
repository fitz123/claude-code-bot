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
