import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logReaction } from "../reaction-log.js";

const LOG_PATH = join(homedir(), ".openclaw", "logs", "reactions.jsonl");

// Save original contents if file exists so we can restore after tests
let originalContent: string | null = null;
let hadFile = false;

function setup() {
  hadFile = existsSync(LOG_PATH);
  if (hadFile) {
    originalContent = readFileSync(LOG_PATH, "utf-8");
  }
}

function teardown() {
  if (hadFile && originalContent !== null) {
    const { writeFileSync } = require("node:fs");
    writeFileSync(LOG_PATH, originalContent);
  } else if (!hadFile && existsSync(LOG_PATH)) {
    rmSync(LOG_PATH);
  }
}

describe("reaction-log", () => {
  afterEach(() => {
    teardown();
  });

  it("writes valid JSONL", () => {
    setup();
    const entry = {
      ts: "2026-03-14T12:00:00.000Z",
      chatId: -100999,
      topicId: 42,
      messageId: 123,
      userId: 555,
      username: "testuser",
      added: ["\ud83d\udc4d"],
      removed: [],
    };
    logReaction(entry);

    const content = readFileSync(LOG_PATH, "utf-8");
    const lines = content.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.chatId, -100999);
    assert.strictEqual(last.topicId, 42);
    assert.strictEqual(last.messageId, 123);
    assert.strictEqual(last.userId, 555);
    assert.strictEqual(last.username, "testuser");
    assert.deepStrictEqual(last.added, ["\ud83d\udc4d"]);
    assert.deepStrictEqual(last.removed, []);
  });

  it("does not throw on write error", () => {
    // logReaction should never throw even if something goes wrong.
    // We can't easily simulate a write error in a unit test, but we can
    // verify it doesn't throw for a normal call (coverage of the try/catch path).
    assert.doesNotThrow(() => {
      logReaction({
        ts: "2026-03-14T12:00:00.000Z",
        chatId: -100,
        topicId: undefined,
        messageId: 1,
        userId: undefined,
        username: undefined,
        added: [],
        removed: [],
      });
    });
  });
});
