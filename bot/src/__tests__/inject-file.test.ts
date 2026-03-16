import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  injectDirForChat,
  writeInjectFile,
  readAckCount,
  cleanupInjectDir,
  INJECT_DIR_BASE,
} from "../inject-file.js";

const TEST_DIR = join(INJECT_DIR_BASE, "__test__");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// -------------------------------------------------------------------
// injectDirForChat
// -------------------------------------------------------------------

describe("injectDirForChat", () => {
  it("returns path under INJECT_DIR_BASE", () => {
    const dir = injectDirForChat("12345");
    assert.ok(dir.startsWith(INJECT_DIR_BASE));
    assert.ok(dir.endsWith("/12345"));
  });

  it("sanitizes colons in chat IDs (session keys with topicId)", () => {
    const dir = injectDirForChat("-1003894:1667");
    assert.ok(!dir.includes(":"));
    assert.ok(dir.includes("-1003894_1667"));
  });

  it("sanitizes special characters", () => {
    const dir = injectDirForChat("chat/../../etc");
    assert.ok(!dir.includes(".."));
  });
});

// -------------------------------------------------------------------
// writeInjectFile
// -------------------------------------------------------------------

describe("writeInjectFile", () => {
  it("writes single message with count header", () => {
    writeInjectFile(TEST_DIR, ["Hello from user"]);

    const content = readFileSync(join(TEST_DIR, "pending"), "utf-8");
    const lines = content.split("\n");
    assert.strictEqual(lines[0], "1");
    assert.ok(content.includes("Hello from user"));
  });

  it("writes multiple messages with correct count and separator", () => {
    writeInjectFile(TEST_DIR, ["First message", "Second message", "Third message"]);

    const content = readFileSync(join(TEST_DIR, "pending"), "utf-8");
    const lines = content.split("\n");
    assert.strictEqual(lines[0], "3");
    assert.ok(content.includes("First message"));
    assert.ok(content.includes("Second message"));
    assert.ok(content.includes("Third message"));
    assert.ok(content.includes("---"));
  });

  it("overwrites existing pending file atomically", () => {
    writeInjectFile(TEST_DIR, ["Old message"]);
    writeInjectFile(TEST_DIR, ["New message 1", "New message 2"]);

    const content = readFileSync(join(TEST_DIR, "pending"), "utf-8");
    assert.strictEqual(content.split("\n")[0], "2");
    assert.ok(!content.includes("Old message"));
    assert.ok(content.includes("New message 1"));
    assert.ok(content.includes("New message 2"));
  });

  it("creates directory if it does not exist", () => {
    const newDir = join(TEST_DIR, "nested", "dir");
    writeInjectFile(newDir, ["test"]);

    assert.ok(existsSync(join(newDir, "pending")));
    rmSync(newDir, { recursive: true, force: true });
  });

  it("does not leave temp files on success", () => {
    writeInjectFile(TEST_DIR, ["msg"]);

    const files = readdirSync(TEST_DIR);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    assert.strictEqual(tmpFiles.length, 0);
  });

  it("preserves multi-line messages", () => {
    writeInjectFile(TEST_DIR, ["line1\nline2\nline3"]);

    const content = readFileSync(join(TEST_DIR, "pending"), "utf-8");
    assert.ok(content.includes("line1\nline2\nline3"));
  });
});

// -------------------------------------------------------------------
// readAckCount
// -------------------------------------------------------------------

describe("readAckCount", () => {
  it("returns 0 when no ack file exists", () => {
    assert.strictEqual(readAckCount(TEST_DIR), 0);
  });

  it("returns 0 for non-existent directory", () => {
    assert.strictEqual(readAckCount("/tmp/bot-inject/nonexistent-dir-xyz"), 0);
  });

  it("reads cumulative count from ack file", () => {
    writeFileSync(join(TEST_DIR, "ack"), "5", "utf-8");
    assert.strictEqual(readAckCount(TEST_DIR), 5);
  });

  it("handles whitespace in ack file", () => {
    writeFileSync(join(TEST_DIR, "ack"), "  3\n", "utf-8");
    assert.strictEqual(readAckCount(TEST_DIR), 3);
  });

  it("returns 0 for invalid content", () => {
    writeFileSync(join(TEST_DIR, "ack"), "not-a-number", "utf-8");
    assert.strictEqual(readAckCount(TEST_DIR), 0);
  });

  it("returns 0 for empty file", () => {
    writeFileSync(join(TEST_DIR, "ack"), "", "utf-8");
    assert.strictEqual(readAckCount(TEST_DIR), 0);
  });
});

// -------------------------------------------------------------------
// cleanupInjectDir
// -------------------------------------------------------------------

describe("cleanupInjectDir", () => {
  it("removes directory and all contents", () => {
    writeInjectFile(TEST_DIR, ["msg"]);
    writeFileSync(join(TEST_DIR, "ack"), "1", "utf-8");

    cleanupInjectDir(TEST_DIR);
    assert.ok(!existsSync(TEST_DIR));
  });

  it("is safe for non-existent directory", () => {
    cleanupInjectDir("/tmp/bot-inject/nonexistent-dir-xyz");
    // Should not throw
  });
});

// -------------------------------------------------------------------
// Hook script simulation (end-to-end inject file protocol)
// -------------------------------------------------------------------

describe("inject file protocol (simulated hook)", () => {
  it("full cycle: write → hook consume → ack → dedup", () => {
    // Bot writes inject file with 2 messages
    writeInjectFile(TEST_DIR, ["msg1", "msg2"]);
    assert.ok(existsSync(join(TEST_DIR, "pending")));

    // Simulate hook: read, delete, write ack
    const content = readFileSync(join(TEST_DIR, "pending"), "utf-8");
    const count = parseInt(content.split("\n")[0], 10);
    assert.strictEqual(count, 2);

    // Hook claims and deletes the file
    renameSync(
      join(TEST_DIR, "pending"),
      join(TEST_DIR, "pending.claimed"),
    );
    rmSync(join(TEST_DIR, "pending.claimed"));

    // Hook writes ack
    writeFileSync(join(TEST_DIR, "ack"), String(count), "utf-8");

    // Bot reads ack
    assert.strictEqual(readAckCount(TEST_DIR), 2);

    // Bot writes new message (only un-consumed)
    writeInjectFile(TEST_DIR, ["msg3"]);

    // Hook reads again
    const content2 = readFileSync(join(TEST_DIR, "pending"), "utf-8");
    const count2 = parseInt(content2.split("\n")[0], 10);
    assert.strictEqual(count2, 1);
    assert.ok(content2.includes("msg3"));

    // Hook updates ack cumulatively
    const prev = readAckCount(TEST_DIR);
    writeFileSync(join(TEST_DIR, "ack"), String(prev + count2), "utf-8");
    assert.strictEqual(readAckCount(TEST_DIR), 3);
  });
});
