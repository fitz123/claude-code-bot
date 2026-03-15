import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordMessage,
  lookupMessage,
  clearMessageIndex,
  messageIndexSize,
  saveMessageIndex,
  restoreMessageIndex,
} from "../message-content-index.js";

describe("message-content-index", () => {
  beforeEach(() => {
    clearMessageIndex();
  });

  it("round-trip: record and lookup a message", () => {
    recordMessage(-100, 42, "alice", "Hello world", "in");
    const rec = lookupMessage(-100, 42);
    assert.ok(rec);
    assert.strictEqual(rec.from, "alice");
    assert.strictEqual(rec.preview, "Hello world");
    assert.strictEqual(rec.direction, "in");
    assert.strictEqual(typeof rec.timestamp, "number");
  });

  it("returns undefined on cache miss", () => {
    assert.strictEqual(lookupMessage(-100, 999), undefined);
  });

  it("isolates keys across different chats", () => {
    recordMessage(-100, 1, "alice", "Chat A", "in");
    recordMessage(-200, 1, "bob", "Chat B", "in");
    assert.strictEqual(lookupMessage(-100, 1)!.from, "alice");
    assert.strictEqual(lookupMessage(-200, 1)!.from, "bob");
  });

  it("isolates keys across different messageIds in same chat", () => {
    recordMessage(-100, 1, "alice", "First", "in");
    recordMessage(-100, 2, "alice", "Second", "in");
    assert.strictEqual(lookupMessage(-100, 1)!.preview, "First");
    assert.strictEqual(lookupMessage(-100, 2)!.preview, "Second");
  });

  it("overwrites existing entry for same key", () => {
    recordMessage(-100, 1, "alice", "Original", "in");
    recordMessage(-100, 1, "alice", "Updated", "in");
    assert.strictEqual(lookupMessage(-100, 1)!.preview, "Updated");
    assert.strictEqual(messageIndexSize(), 1);
  });

  it("truncates preview to 150 characters", () => {
    const longText = "x".repeat(300);
    recordMessage(-100, 1, "alice", longText, "in");
    const rec = lookupMessage(-100, 1)!;
    assert.strictEqual(rec.preview.length, 150);
    assert.strictEqual(rec.preview, "x".repeat(150));
  });

  it("stores direction correctly for outgoing messages", () => {
    recordMessage(-100, 1, "bot", "Response", "out");
    assert.strictEqual(lookupMessage(-100, 1)!.direction, "out");
  });

  it("FIFO eviction: removes oldest entries when exceeding 10K cap", () => {
    // Fill to exactly 10K
    for (let i = 0; i < 10_000; i++) {
      recordMessage(-1, i, "user", `msg-${i}`, "in");
    }
    assert.strictEqual(messageIndexSize(), 10_000);

    // The 10,001th entry triggers FIFO eviction of the oldest
    recordMessage(-1, 99999, "user", "new-msg", "in");
    assert.strictEqual(messageIndexSize(), 10_000);

    // New entry exists
    assert.ok(lookupMessage(-1, 99999));
    assert.strictEqual(lookupMessage(-1, 99999)!.preview, "new-msg");

    // Oldest entry was evicted
    assert.strictEqual(lookupMessage(-1, 0), undefined);

    // Second-oldest still exists
    assert.ok(lookupMessage(-1, 1));
  });

  it("handles empty text", () => {
    recordMessage(-100, 1, "alice", "", "in");
    assert.strictEqual(lookupMessage(-100, 1)!.preview, "");
  });
});

describe("message-content-index persistence", () => {
  let tmpDir: string;
  let indexPath: string;

  beforeEach(() => {
    clearMessageIndex();
    tmpDir = mkdtempSync(join(tmpdir(), "msg-index-test-"));
    indexPath = join(tmpDir, "message-content-index.json");
  });

  afterEach(() => {
    clearMessageIndex();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trip: save then restore preserves entries", () => {
    recordMessage(-100, 1, "alice", "Hello", "in");
    recordMessage(-100, 2, "bot", "Hi there", "out");
    recordMessage(-200, 5, "bob", "Test", "in");
    saveMessageIndex(indexPath);

    clearMessageIndex();
    assert.strictEqual(messageIndexSize(), 0);

    restoreMessageIndex(indexPath);
    assert.strictEqual(messageIndexSize(), 3);

    const rec1 = lookupMessage(-100, 1)!;
    assert.strictEqual(rec1.from, "alice");
    assert.strictEqual(rec1.preview, "Hello");
    assert.strictEqual(rec1.direction, "in");

    const rec2 = lookupMessage(-100, 2)!;
    assert.strictEqual(rec2.from, "bot");
    assert.strictEqual(rec2.direction, "out");

    assert.ok(lookupMessage(-200, 5));
  });

  it("missing file results in empty index, no crash", () => {
    restoreMessageIndex(join(tmpDir, "nonexistent.json"));
    assert.strictEqual(messageIndexSize(), 0);
  });

  it("corrupt file results in empty index, no crash", () => {
    writeFileSync(indexPath, "not valid json {{{", "utf8");
    restoreMessageIndex(indexPath);
    assert.strictEqual(messageIndexSize(), 0);
  });

  it("corrupt file clears pre-existing index entries", () => {
    recordMessage(-100, 1, "alice", "Hello", "in");
    recordMessage(-100, 2, "bob", "World", "in");
    assert.strictEqual(messageIndexSize(), 2);
    writeFileSync(indexPath, "not valid json {{{", "utf8");
    restoreMessageIndex(indexPath);
    assert.strictEqual(messageIndexSize(), 0);
  });

  it("non-array JSON results in empty index, no crash", () => {
    writeFileSync(indexPath, JSON.stringify({ key: "value" }), "utf8");
    restoreMessageIndex(indexPath);
    assert.strictEqual(messageIndexSize(), 0);
  });

  it("invalid entries are skipped during restore", () => {
    const entries = [
      ["-100:1", { from: "alice", preview: "Hello", direction: "in", timestamp: 1000 }], // valid
      "not-an-array",                                                                      // invalid
      ["-100:2"],                                                                          // invalid: wrong length
      ["-100:3", { from: "bob", preview: "Hi", direction: "bad", timestamp: 1000 }],      // invalid: bad direction
      ["-100:4", { from: "bob", preview: "Hi", direction: "in" }],                         // invalid: missing timestamp
      [42, { from: "bob", preview: "Hi", direction: "in", timestamp: 1000 }],              // invalid: key not string
      ["-200:1", { from: "bob", preview: "Test", direction: "out", timestamp: 2000 }],    // valid
    ];
    writeFileSync(indexPath, JSON.stringify(entries), "utf8");
    restoreMessageIndex(indexPath);
    assert.strictEqual(messageIndexSize(), 2);
    assert.strictEqual(lookupMessage(-100, 1)!.from, "alice");
    assert.strictEqual(lookupMessage(-200, 1)!.from, "bob");
  });

  it("restore respects 10K cap", () => {
    const entries: [string, MessageRecordLike][] = [];
    for (let i = 0; i < 11_000; i++) {
      entries.push([`-1:${i}`, { from: "user", preview: `msg-${i}`, direction: "in" as const, timestamp: i }]);
    }
    writeFileSync(indexPath, JSON.stringify(entries), "utf8");

    restoreMessageIndex(indexPath);
    assert.strictEqual(messageIndexSize(), 9_999);
  });

  it("save creates parent directories if missing", () => {
    const nestedPath = join(tmpDir, "sub", "dir", "index.json");
    recordMessage(-100, 1, "alice", "Hello", "in");
    saveMessageIndex(nestedPath);
    assert.ok(existsSync(nestedPath));
    const data = JSON.parse(readFileSync(nestedPath, "utf8"));
    assert.strictEqual(data.length, 1);
  });

  it("preserves all fields through save/restore", () => {
    recordMessage(-100, 1, "alice", "Hello world", "in");
    saveMessageIndex(indexPath);
    clearMessageIndex();
    restoreMessageIndex(indexPath);
    const rec = lookupMessage(-100, 1)!;
    assert.strictEqual(rec.from, "alice");
    assert.strictEqual(rec.preview, "Hello world");
    assert.strictEqual(rec.direction, "in");
    assert.strictEqual(typeof rec.timestamp, "number");
  });
});

// Helper type for test data construction
type MessageRecordLike = { from: string; preview: string; direction: string; timestamp: number };
