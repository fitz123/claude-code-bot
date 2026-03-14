import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logReaction } from "../reaction-log.js";

describe("reaction-log", () => {
  const testDir = join(tmpdir(), `reaction-log-test-${Date.now()}-${process.pid}`);
  const testPath = join(testDir, "reactions.jsonl");

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes valid JSONL to disk", async () => {
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

    await logReaction(entry, testDir);

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
    const entry1 = { ts: "2026-03-15T12:00:00.000Z", chatId: -100, topicId: undefined, messageId: 1, userId: 1, username: "a", added: ["\ud83d\udc4d"], removed: [] };
    const entry2 = { ts: "2026-03-15T12:01:00.000Z", chatId: -200, topicId: 10, messageId: 2, userId: 2, username: "b", added: [], removed: ["\ud83d\udc4e"] };

    await logReaction(entry1, testDir);
    await logReaction(entry2, testDir);

    const lines = readFileSync(testPath, "utf-8").trim().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).chatId, -100);
    assert.strictEqual(JSON.parse(lines[1]).chatId, -200);
  });

  it("does not throw on unwritable path", async () => {
    await assert.doesNotReject(async () => {
      await logReaction({
        ts: "2026-03-15T12:00:00.000Z",
        chatId: -100,
        topicId: undefined,
        messageId: 1,
        userId: undefined,
        username: undefined,
        added: ["\ud83d\udc4d"],
        removed: [],
      }, "/nonexistent/deeply/nested/path/that/cannot/exist");
    });
  });
});
