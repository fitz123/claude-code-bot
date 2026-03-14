import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setThread, getThread, clearThreadCache, threadCacheSize } from "../message-thread-cache.js";

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
