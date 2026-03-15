import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setThread, getThread, clearThreadCache, threadCacheSize, saveThreadCache, restoreThreadCache } from "../message-thread-cache.js";

describe("message-thread-cache", () => {
  beforeEach(() => {
    clearThreadCache();
  });

  it("round-trip: stores and retrieves topicId", () => {
    setThread(-100999, 42, 10);
    assert.strictEqual(getThread(-100999, 42), 10);
  });

  it("returns undefined on cache miss", () => {
    assert.strictEqual(getThread(-100999, 999), undefined);
  });

  it("skips undefined topicId (does not store)", () => {
    setThread(-100999, 42, undefined);
    assert.strictEqual(getThread(-100999, 42), undefined);
    assert.strictEqual(threadCacheSize(), 0);
  });

  it("isolates keys across different chats", () => {
    setThread(-100, 1, 10);
    setThread(-200, 1, 20);
    assert.strictEqual(getThread(-100, 1), 10);
    assert.strictEqual(getThread(-200, 1), 20);
  });

  it("isolates keys across different messageIds in same chat", () => {
    setThread(-100, 1, 10);
    setThread(-100, 2, 20);
    assert.strictEqual(getThread(-100, 1), 10);
    assert.strictEqual(getThread(-100, 2), 20);
  });

  it("evicts all entries when cache exceeds 10K", () => {
    // Fill to exactly 10K
    for (let i = 0; i < 10_000; i++) {
      setThread(-1, i, 5);
    }
    assert.strictEqual(threadCacheSize(), 10_000);

    // The 10_001th entry triggers clear, then adds itself
    setThread(-1, 99999, 42);
    assert.strictEqual(threadCacheSize(), 1);
    assert.strictEqual(getThread(-1, 99999), 42);
    // Old entries are gone
    assert.strictEqual(getThread(-1, 0), undefined);
  });

  it("overwrites existing entry for same key", () => {
    setThread(-100, 1, 10);
    setThread(-100, 1, 20);
    assert.strictEqual(getThread(-100, 1), 20);
  });

  it("handles topicId 0 (General topic)", () => {
    setThread(-100, 1, 0);
    assert.strictEqual(getThread(-100, 1), 0);
  });
});

describe("message-thread-cache persistence", () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    clearThreadCache();
    tmpDir = mkdtempSync(join(tmpdir(), "thread-cache-test-"));
    cachePath = join(tmpDir, "thread-cache.json");
  });

  afterEach(() => {
    clearThreadCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trip: save then restore preserves entries", () => {
    setThread(-100, 1, 10);
    setThread(-100, 2, 20);
    setThread(-200, 5, 30);
    saveThreadCache(cachePath);

    clearThreadCache();
    assert.strictEqual(threadCacheSize(), 0);

    restoreThreadCache(cachePath);
    assert.strictEqual(threadCacheSize(), 3);
    assert.strictEqual(getThread(-100, 1), 10);
    assert.strictEqual(getThread(-100, 2), 20);
    assert.strictEqual(getThread(-200, 5), 30);
  });

  it("missing file results in empty cache, no crash", () => {
    restoreThreadCache(join(tmpDir, "nonexistent.json"));
    assert.strictEqual(threadCacheSize(), 0);
  });

  it("corrupt file results in empty cache, no crash", () => {
    writeFileSync(cachePath, "not valid json {{{", "utf8");
    restoreThreadCache(cachePath);
    assert.strictEqual(threadCacheSize(), 0);
  });

  it("corrupt file clears pre-existing cache entries", () => {
    setThread(-100, 1, 10);
    setThread(-100, 2, 20);
    assert.strictEqual(threadCacheSize(), 2);
    writeFileSync(cachePath, "not valid json {{{", "utf8");
    restoreThreadCache(cachePath);
    assert.strictEqual(threadCacheSize(), 0);
  });

  it("non-array JSON results in empty cache, no crash", () => {
    writeFileSync(cachePath, JSON.stringify({ key: "value" }), "utf8");
    restoreThreadCache(cachePath);
    assert.strictEqual(threadCacheSize(), 0);
  });

  it("non-array JSON clears pre-existing cache entries", () => {
    setThread(-100, 1, 10);
    setThread(-100, 2, 20);
    assert.strictEqual(threadCacheSize(), 2);
    writeFileSync(cachePath, JSON.stringify({ key: "value" }), "utf8");
    restoreThreadCache(cachePath);
    assert.strictEqual(threadCacheSize(), 0);
  });

  it("invalid entries are skipped during restore", () => {
    const entries = [
      ["-100:1", 10],       // valid
      "not-an-array",       // invalid: not an array
      ["-100:2"],           // invalid: wrong length
      ["-100:3", "text"],   // invalid: value not a number
      [42, 10],             // invalid: key not a string
      ["-200:1", 20],       // valid
    ];
    writeFileSync(cachePath, JSON.stringify(entries), "utf8");
    restoreThreadCache(cachePath);
    assert.strictEqual(threadCacheSize(), 2);
    assert.strictEqual(getThread(-100, 1), 10);
    assert.strictEqual(getThread(-200, 1), 20);
  });

  it("restore respects 10K cap", () => {
    // Create a file with 11K entries
    const entries: [string, number][] = [];
    for (let i = 0; i < 11_000; i++) {
      entries.push([`-1:${i}`, 5]);
    }
    writeFileSync(cachePath, JSON.stringify(entries), "utf8");

    restoreThreadCache(cachePath);
    assert.strictEqual(threadCacheSize(), 9_999);
  });

  it("save creates parent directories if missing", () => {
    const nestedPath = join(tmpDir, "sub", "dir", "cache.json");
    setThread(-100, 1, 10);
    saveThreadCache(nestedPath);
    assert.ok(existsSync(nestedPath));
    const data = JSON.parse(readFileSync(nestedPath, "utf8"));
    assert.strictEqual(data.length, 1);
  });

  it("preserves topicId 0 through save/restore", () => {
    setThread(-100, 1, 0);
    saveThreadCache(cachePath);
    clearThreadCache();
    restoreThreadCache(cachePath);
    assert.strictEqual(getThread(-100, 1), 0);
  });
});
