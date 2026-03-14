import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setThread, getThread, _clearCache, _cacheSize } from "../message-thread-cache.js";

describe("message-thread-cache", () => {
  beforeEach(() => {
    _clearCache();
  });

  it("round-trip: set then get returns topicId", () => {
    setThread(-100999, 42, 10);
    assert.strictEqual(getThread(-100999, 42), 10);
  });

  it("miss returns undefined", () => {
    assert.strictEqual(getThread(-100999, 99), undefined);
  });

  it("undefined topicId is skipped (not stored)", () => {
    setThread(-100999, 42, undefined);
    assert.strictEqual(getThread(-100999, 42), undefined);
    assert.strictEqual(_cacheSize(), 0);
  });

  it("eviction clears cache when size exceeds 10K", () => {
    for (let i = 0; i < 10_000; i++) {
      setThread(-100, i, 5);
    }
    assert.strictEqual(_cacheSize(), 10_000);

    // This 10,001st entry triggers clear, then inserts itself
    setThread(-100, 10_000, 5);
    assert.strictEqual(_cacheSize(), 1);

    // Old entries are gone
    assert.strictEqual(getThread(-100, 0), undefined);
    // New entry is present
    assert.strictEqual(getThread(-100, 10_000), 5);
  });

  it("key isolation across chats: same messageId different chats", () => {
    setThread(-100, 42, 10);
    setThread(-200, 42, 20);
    assert.strictEqual(getThread(-100, 42), 10);
    assert.strictEqual(getThread(-200, 42), 20);
  });

  it("overwrites topicId for same chatId+messageId", () => {
    setThread(-100, 42, 10);
    setThread(-100, 42, 20);
    assert.strictEqual(getThread(-100, 42), 20);
  });

  it("handles topicId 0 (General topic)", () => {
    setThread(-100, 42, 0);
    assert.strictEqual(getThread(-100, 42), 0);
  });
});
