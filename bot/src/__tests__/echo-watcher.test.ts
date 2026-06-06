import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EchoWatcher,
  ECHO_PREFIX,
  type EchoMessage,
} from "../echo-watcher.js";

// Each test run gets its own temp directory to avoid touching the real echo spool.
const TEST_CHAT_ID = "__test_echo_chat__";
let TEST_ECHO_DIR: string;
let TEST_CHAT_DIR: string;
let fixtures: string[] = [];

function withPatchedGetuid<T>(uid: number, fn: () => T): T {
  const original = process.getuid;
  Object.defineProperty(process, "getuid", {
    value: () => uid,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process, "getuid");
    } else {
      Object.defineProperty(process, "getuid", {
        value: original,
        configurable: true,
      });
    }
  }
}

function writeEchoFile(
  chatId: string,
  text: string,
  opts?: { threadId?: string | null; filename?: string; baseDir?: string },
): void {
  const base = opts?.baseDir ?? TEST_ECHO_DIR;
  const dir = join(base, chatId);
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
  fixtures = [];
  TEST_ECHO_DIR = mkdtempSync(join(tmpdir(), "bot-echo-test-"));
  TEST_CHAT_DIR = join(TEST_ECHO_DIR, TEST_CHAT_ID);
});

afterEach(() => {
  rmSync(TEST_ECHO_DIR, { recursive: true, force: true });
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
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
      echoDir: TEST_ECHO_DIR,
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
      echoDir: TEST_ECHO_DIR,
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
      echoDir: TEST_ECHO_DIR,
      handler: (chatId, threadId, text) => calls.push({ chatId, threadId, text }),
    });

    watcher.drain();

    assert.strictEqual(calls[0].threadId, undefined);
  });

  it("cleans up echo files after processing", () => {
    writeEchoFile(TEST_CHAT_ID, "cleanup test");

    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
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
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => texts.push(text),
    });

    watcher.drain();

    assert.deepStrictEqual(texts, ["first", "second", "third"]);
  });

  it("processes files from multiple chat directories", () => {
    const chatId2 = "__test_echo_chat_2__";

    writeEchoFile(TEST_CHAT_ID, "msg from chat 1");
    writeEchoFile(chatId2, "msg from chat 2");

    const calls: Array<{ chatId: string; text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (chatId, _threadId, text) => calls.push({ chatId, text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 2);
    const chatIds = calls.map((c) => c.chatId).sort();
    assert.ok(chatIds.includes(TEST_CHAT_ID));
    assert.ok(chatIds.includes(chatId2));
  });

  it("refuses a symlinked echo base directory", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "bot-echo-base-symlink-target-"));
    fixtures.push(targetDir);
    writeEchoFile(TEST_CHAT_ID, "hidden msg", { baseDir: targetDir });
    rmSync(TEST_ECHO_DIR, { recursive: true, force: true });
    symlinkSync(targetDir, TEST_ECHO_DIR);

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 0);
  });

  it("refuses an echo base directory owned by another uid", () => {
    const currentUid = process.getuid?.();
    if (currentUid === undefined) return;
    writeEchoFile(TEST_CHAT_ID, "hidden msg");

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    withPatchedGetuid(currentUid + 1, () => watcher.drain());

    assert.strictEqual(calls.length, 0);
  });

  it("tightens a loose echo base directory before polling", () => {
    chmodSync(TEST_ECHO_DIR, 0o755);
    writeEchoFile(TEST_CHAT_ID, "permission msg");

    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: () => {},
    });

    watcher.drain();

    assert.strictEqual(statSync(TEST_ECHO_DIR).mode & 0o777, 0o700);
  });

  it("skips symlinked chat directories", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "bot-echo-symlink-target-"));
    fixtures.push(targetDir);
    writeEchoFile(TEST_CHAT_ID, "hidden msg", { baseDir: targetDir });
    symlinkSync(join(targetDir, TEST_CHAT_ID), TEST_CHAT_DIR);

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 0);
  });

  it("tightens loose chat directories before processing", () => {
    writeEchoFile(TEST_CHAT_ID, "permission msg");
    chmodSync(TEST_CHAT_DIR, 0o755);

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(statSync(TEST_CHAT_DIR).mode & 0o777, 0o700);
  });

  it("skips chat directories owned by another uid", () => {
    const currentUid = process.getuid?.();
    if (currentUid === undefined) return;
    writeEchoFile(TEST_CHAT_ID, "hidden msg");

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    withPatchedGetuid(currentUid + 1, () => {
      (watcher as unknown as { pollAll(): void }).pollAll();
    });

    assert.strictEqual(calls.length, 0);
  });

  it("skips symlinked echo files", () => {
    mkdirSync(TEST_CHAT_DIR, { recursive: true });
    const targetFile = join(TEST_ECHO_DIR, "target.json");
    writeFileSync(targetFile, JSON.stringify({
      chatId: TEST_CHAT_ID,
      threadId: null,
      text: "hidden msg",
      origin: "deliver.sh",
      timestamp: Math.floor(Date.now() / 1000),
    }), "utf-8");
    symlinkSync(targetFile, join(TEST_CHAT_DIR, "linked.json"));

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 0);
  });

  it("skips echo files owned by another uid", () => {
    const currentUid = process.getuid?.();
    if (currentUid === undefined) return;
    writeEchoFile(TEST_CHAT_ID, "hidden msg", { filename: "uid-mismatch.json" });

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    withPatchedGetuid(currentUid + 1, () => {
      (watcher as unknown as { processDir(chatDir: string): void }).processDir(TEST_CHAT_DIR);
    });

    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(readdirSync(TEST_CHAT_DIR), ["uid-mismatch.json"]);
  });

  it("skips malformed JSON files without crashing", () => {
    mkdirSync(TEST_CHAT_DIR, { recursive: true });
    writeFileSync(join(TEST_CHAT_DIR, "bad-1-1.json"), "not json{{{", "utf-8");
    writeEchoFile(TEST_CHAT_ID, "good msg", { filename: "good-2-1.json" });

    const calls: Array<{ text: string }> = [];
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: (_chatId, _threadId, text) => calls.push({ text }),
    });

    watcher.drain();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].text, "good msg");
  });

  it("handles empty echo directory", () => {
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
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
      echoDir: TEST_ECHO_DIR,
      handler: () => {},
      pollIntervalMs: 50,
    });

    watcher.start();
    watcher.stop();
  });

  it("stop is safe to call multiple times", () => {
    const watcher = new EchoWatcher({
      echoDir: TEST_ECHO_DIR,
      handler: () => {},
    });

    watcher.start();
    watcher.stop();
    watcher.stop();
  });
});
