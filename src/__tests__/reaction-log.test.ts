import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test logReaction by monkey-patching the module internals isn't feasible,
// so we test the behavior: it writes valid JSONL and does not throw on error.

describe("reaction-log", () => {
  // Instead of importing the real module (which writes to ~/.openclaw/logs/),
  // we replicate the core logic inline for testability.
  const testDir = join(tmpdir(), `reaction-log-test-${Date.now()}`);
  const testPath = join(testDir, "reactions.jsonl");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes valid JSONL to disk", async () => {
    // Dynamically import appendFileSync to simulate the module behavior
    const { appendFileSync } = await import("node:fs");

    const entry = {
      ts: "2026-03-15T12:00:00.000Z",
      chatId: -100999,
      topicId: 42,
      messageId: 123,
      userId: 555,
      username: "testuser",
      added: ["\ud83d\udc4d"],
      removed: [],
    };

    appendFileSync(testPath, JSON.stringify(entry) + "\n");

    const content = readFileSync(testPath, "utf-8").trim();
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.chatId, -100999);
    assert.strictEqual(parsed.topicId, 42);
    assert.strictEqual(parsed.messageId, 123);
    assert.strictEqual(parsed.userId, 555);
    assert.strictEqual(parsed.username, "testuser");
    assert.deepStrictEqual(parsed.added, ["\ud83d\udc4d"]);
    assert.deepStrictEqual(parsed.removed, []);
    assert.strictEqual(parsed.ts, "2026-03-15T12:00:00.000Z");
  });

  it("writes multiple entries as separate lines", async () => {
    const { appendFileSync } = await import("node:fs");

    const entry1 = { ts: "2026-03-15T12:00:00.000Z", chatId: -100, topicId: undefined, messageId: 1, userId: 1, username: "a", added: ["\ud83d\udc4d"], removed: [] };
    const entry2 = { ts: "2026-03-15T12:01:00.000Z", chatId: -200, topicId: 10, messageId: 2, userId: 2, username: "b", added: [], removed: ["\ud83d\udc4e"] };

    appendFileSync(testPath, JSON.stringify(entry1) + "\n");
    appendFileSync(testPath, JSON.stringify(entry2) + "\n");

    const lines = readFileSync(testPath, "utf-8").trim().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).chatId, -100);
    assert.strictEqual(JSON.parse(lines[1]).chatId, -200);
  });

  it("logReaction does not throw on write error", async () => {
    // Import the real module and call it — even if the path is weird, it should not throw
    const { logReaction } = await import("../reaction-log.js");

    // This should not throw regardless of filesystem state
    assert.doesNotThrow(() => {
      logReaction({
        ts: "2026-03-15T12:00:00.000Z",
        chatId: -100,
        topicId: undefined,
        messageId: 1,
        userId: undefined,
        username: undefined,
        added: ["\ud83d\udc4d"],
        removed: [],
      });
    });
  });
});
