import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "../types.js";
import {
  MessageQueue,
  buildCollectPrompt,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_QUEUE_CAP,
} from "../message-queue.js";
import { injectDirForChat, readAckCount, cleanupInjectDir, INJECT_DIR_BASE } from "../inject-file.js";

/** Minimal mock PlatformContext — the queue never inspects it deeply, only passes it through. */
function mockPlatform(): PlatformContext {
  return {
    maxMessageLength: 4096,
    editDebounceMs: 2000,
    typingIntervalMs: 4000,
    streamingUpdates: true,
    typingIndicator: true,
    async sendMessage() { return "1"; },
    async editMessage() {},
    async deleteMessage() {},
    async sendTyping() {},
    async sendFile() {},
    async replyError() {},
  };
}

/**
 * Create a tracked processFn for testing.
 * Can optionally block until manually unblocked.
 */
function createMockProcess() {
  const calls: Array<{ chatId: string; agentId: string; text: string }> = [];
  let shouldBlock = false;
  let blockResolve: (() => void) | null = null;

  const processFn = async (
    chatId: string,
    agentId: string,
    text: string,
    _platform: PlatformContext,
  ) => {
    calls.push({ chatId, agentId, text });
    if (shouldBlock) {
      await new Promise<void>((resolve) => {
        blockResolve = resolve;
      });
    }
  };

  return {
    processFn,
    calls,
    /** Make subsequent processFn calls block until unblock() is called. */
    setBlocking(block: boolean) {
      shouldBlock = block;
    },
    /** Unblock the currently blocked processFn call. */
    unblock() {
      if (blockResolve) {
        blockResolve();
        blockResolve = null;
      }
    },
  };
}

/** Wait for a given number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------------
// buildCollectPrompt
// -------------------------------------------------------------------

describe("buildCollectPrompt", () => {
  it("returns single message unchanged", () => {
    assert.strictEqual(buildCollectPrompt(["hello"]), "hello");
  });

  it("formats multiple messages with queue header and separators", () => {
    const result = buildCollectPrompt(["first msg", "second msg"]);
    const expected = [
      "[Queued messages while agent was busy]",
      "---",
      "Queued #1",
      "first msg",
      "---",
      "Queued #2",
      "second msg",
    ].join("\n");
    assert.strictEqual(result, expected);
  });

  it("formats three messages correctly", () => {
    const result = buildCollectPrompt(["a", "b", "c"]);
    assert.ok(result.includes("Queued #1"));
    assert.ok(result.includes("Queued #2"));
    assert.ok(result.includes("Queued #3"));
    assert.ok(result.includes("[Queued messages while agent was busy]"));
  });
});

// -------------------------------------------------------------------
// MessageQueue — defaults
// -------------------------------------------------------------------

describe("MessageQueue defaults", () => {
  it("exports expected default constants", () => {
    assert.strictEqual(DEFAULT_DEBOUNCE_MS, 3000);
    assert.strictEqual(DEFAULT_QUEUE_CAP, 20);
  });
});

// -------------------------------------------------------------------
// MessageQueue — pre-send debounce
// -------------------------------------------------------------------

describe("MessageQueue debounce", () => {
  it("debounces rapid messages into a single send", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 50 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "hello", platform);
    queue.enqueue("chat1", "main", "world", platform);
    queue.enqueue("chat1", "main", "foo", platform);

    // Before debounce fires, nothing sent
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(queue.getPendingCount("chat1"), 3);

    // Wait for debounce to fire and flush to complete
    await wait(100);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].text, "hello\n\nworld\n\nfoo");
    assert.strictEqual(calls[0].chatId, "chat1");
    assert.strictEqual(calls[0].agentId, "main");
    assert.strictEqual(queue.getPendingCount("chat1"), 0);

    queue.clearAll();
  });

  it("sends single message without joining", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "solo message", platform);

    await wait(80);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].text, "solo message");

    queue.clearAll();
  });

  it("treats separate chats independently", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "msg1", platform);
    queue.enqueue("chat2", "agent-b", "msg2", platform);

    await wait(80);

    assert.strictEqual(calls.length, 2);
    const chat1Call = calls.find((c) => c.chatId === "chat1");
    const chat2Call = calls.find((c) => c.chatId === "chat2");
    assert.ok(chat1Call);
    assert.ok(chat2Call);
    assert.strictEqual(chat1Call.text, "msg1");
    assert.strictEqual(chat2Call.text, "msg2");

    queue.clearAll();
  });
});

// -------------------------------------------------------------------
// MessageQueue — mid-turn collect
// -------------------------------------------------------------------

describe("MessageQueue mid-turn collect", () => {
  it("buffers messages arriving while busy and drains them after", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    // First call will block to simulate processing
    mock.setBlocking(true);

    queue.enqueue("chat1", "main", "initial message", platform);

    // Wait for debounce to fire (flush starts, processFn blocks)
    await wait(60);

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].text, "initial message");
    assert.ok(queue.isBusy("chat1"));

    // Enqueue messages while busy — should go to collect buffer
    queue.enqueue("chat1", "main", "queued msg 1", platform);
    queue.enqueue("chat1", "main", "queued msg 2", platform);

    assert.strictEqual(queue.getCollectCount("chat1"), 2);
    assert.strictEqual(queue.getPendingCount("chat1"), 0);

    // Unblock the first call — drain should follow
    mock.setBlocking(false);
    mock.unblock();

    // Wait for drain to complete
    await wait(50);

    assert.strictEqual(mock.calls.length, 2);
    assert.strictEqual(mock.calls[1].chatId, "chat1");
    // Drain uses buildCollectPrompt for multiple messages
    assert.ok(mock.calls[1].text.includes("[Queued messages while agent was busy]"));
    assert.ok(mock.calls[1].text.includes("Queued #1"));
    assert.ok(mock.calls[1].text.includes("queued msg 1"));
    assert.ok(mock.calls[1].text.includes("Queued #2"));
    assert.ok(mock.calls[1].text.includes("queued msg 2"));

    assert.strictEqual(queue.isBusy("chat1"), false);
    assert.strictEqual(queue.getCollectCount("chat1"), 0);

    queue.clearAll();
  });

  it("drains single collected message without header", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue("chat1", "main", "first", platform);
    await wait(60);

    // Enqueue single message while busy
    queue.enqueue("chat1", "main", "followup", platform);

    mock.setBlocking(false);
    mock.unblock();
    await wait(50);

    assert.strictEqual(mock.calls.length, 2);
    // Single collected message is passed as-is (no header)
    assert.strictEqual(mock.calls[1].text, "followup");

    queue.clearAll();
  });
});

// -------------------------------------------------------------------
// MessageQueue — queue cap
// -------------------------------------------------------------------

describe("MessageQueue queue cap", () => {
  it("drops messages beyond queue cap", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30, queueCap: 3 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue("chat1", "main", "first", platform);
    await wait(60);

    // Fill collect buffer to cap
    queue.enqueue("chat1", "main", "c1", platform);
    queue.enqueue("chat1", "main", "c2", platform);
    queue.enqueue("chat1", "main", "c3", platform);
    assert.strictEqual(queue.getCollectCount("chat1"), 3);

    // This should be dropped
    queue.enqueue("chat1", "main", "c4-dropped", platform);
    assert.strictEqual(queue.getCollectCount("chat1"), 3);

    mock.setBlocking(false);
    mock.unblock();
    await wait(50);

    // Verify drain used only the 3 capped messages
    assert.strictEqual(mock.calls.length, 2);
    assert.ok(mock.calls[1].text.includes("c1"));
    assert.ok(mock.calls[1].text.includes("c2"));
    assert.ok(mock.calls[1].text.includes("c3"));
    assert.ok(!mock.calls[1].text.includes("c4-dropped"));

    queue.clearAll();
  });

  it("drops messages beyond queue cap during debounce", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 50, queueCap: 3 });
    const platform = mockPlatform();

    // Fill debounce buffer to cap
    queue.enqueue("chat1", "main", "d1", platform);
    queue.enqueue("chat1", "main", "d2", platform);
    queue.enqueue("chat1", "main", "d3", platform);
    assert.strictEqual(queue.getPendingCount("chat1"), 3);

    // This should be dropped
    queue.enqueue("chat1", "main", "d4-dropped", platform);
    assert.strictEqual(queue.getPendingCount("chat1"), 3);

    await wait(100);

    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].text.includes("d1"));
    assert.ok(calls[0].text.includes("d3"));
    assert.ok(!calls[0].text.includes("d4-dropped"));

    queue.clearAll();
  });
});

// -------------------------------------------------------------------
// MessageQueue — clear
// -------------------------------------------------------------------

describe("MessageQueue clear", () => {
  it("clears pending messages and cancels debounce timer", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 100 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "will be cleared", platform);
    assert.strictEqual(queue.getPendingCount("chat1"), 1);

    queue.clear("chat1");

    // Wait past debounce time — should NOT have sent
    await wait(150);
    assert.strictEqual(calls.length, 0);

    queue.clearAll();
  });

  it("clear is safe for unknown chatId", () => {
    const { processFn } = createMockProcess();
    const queue = new MessageQueue(processFn);
    queue.clear("nonexistent");
  });

  it("clearAll clears all chats", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 100 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "msg1", platform);
    queue.enqueue("chat2", "agent-b", "msg2", platform);

    queue.clearAll();

    await wait(150);
    assert.strictEqual(calls.length, 0);
  });
});

// -------------------------------------------------------------------
// MessageQueue — status methods
// -------------------------------------------------------------------

describe("MessageQueue status", () => {
  it("reports not busy for unknown chat", () => {
    const { processFn } = createMockProcess();
    const queue = new MessageQueue(processFn);
    assert.strictEqual(queue.isBusy("unknown"), false);
    assert.strictEqual(queue.getPendingCount("unknown"), 0);
    assert.strictEqual(queue.getCollectCount("unknown"), 0);
  });
});

// -------------------------------------------------------------------
// MessageQueue — error handling
// -------------------------------------------------------------------

describe("MessageQueue error handling", () => {
  it("catches processFn errors and sends error reply via platform", async () => {
    let repliedText = "";
    const errorPlatform: PlatformContext = {
      ...mockPlatform(),
      async replyError(text: string) {
        repliedText = text;
      },
    };

    const failProcess = async () => {
      throw new Error("Claude exploded");
    };

    const queue = new MessageQueue(failProcess, { debounceMs: 30 });
    queue.enqueue("chat1", "main", "trigger error", errorPlatform);

    await wait(80);

    assert.ok(repliedText.includes("Something went wrong"));
    assert.strictEqual(queue.isBusy("chat1"), false);

    queue.clearAll();
  });

  it("catches errors during collect buffer drain and sends error reply", async () => {
    let callCount = 0;
    let repliedText = "";
    const errorPlatform: PlatformContext = {
      ...mockPlatform(),
      async replyError(text: string) {
        repliedText = text;
      },
    };

    const failOnDrain = async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Drain exploded");
      }
      // First call (flush) succeeds but blocks to allow enqueueing mid-turn
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
      }
    };

    const queue = new MessageQueue(failOnDrain, { debounceMs: 20 });
    queue.enqueue("chat1", "main", "initial", errorPlatform);

    await wait(40);

    // Now enqueue a mid-turn message while busy
    queue.enqueue("chat1", "main", "queued msg", errorPlatform);

    // Wait for flush + drain to complete
    await wait(100);

    assert.strictEqual(callCount, 2);
    assert.ok(repliedText.includes("Something went wrong:"));
    assert.strictEqual(queue.isBusy("chat1"), false);

    queue.clearAll();
  });
});

// -------------------------------------------------------------------
// MessageQueue — inject file writing
// -------------------------------------------------------------------

// Use a unique chatId prefix for inject tests to avoid collisions
const INJECT_CHAT = "__inject_test__";

function injectCleanup(chatId: string) {
  cleanupInjectDir(injectDirForChat(chatId));
}

describe("MessageQueue inject file writing", () => {
  afterEach(() => {
    injectCleanup(INJECT_CHAT);
  });

  it("writes inject file when message is enqueued mid-turn", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial", platform);
    await wait(60);

    // Enqueue mid-turn message
    queue.enqueue(INJECT_CHAT, "main", "mid-turn msg", platform);

    // Check inject file was created
    const dir = injectDirForChat(INJECT_CHAT);
    const pendingPath = join(dir, "pending");
    assert.ok(existsSync(pendingPath), "pending inject file should exist");

    const content = readFileSync(pendingPath, "utf-8");
    assert.strictEqual(content.split("\n")[0], "1", "count should be 1");
    assert.ok(content.includes("mid-turn msg"));

    mock.setBlocking(false);
    mock.unblock();
    await wait(50);
    queue.clearAll();
  });

  it("overwrites inject file with all un-consumed messages", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial", platform);
    await wait(60);

    // Enqueue multiple mid-turn messages
    queue.enqueue(INJECT_CHAT, "main", "msg A", platform);
    queue.enqueue(INJECT_CHAT, "main", "msg B", platform);

    const dir = injectDirForChat(INJECT_CHAT);
    const content = readFileSync(join(dir, "pending"), "utf-8");
    assert.strictEqual(content.split("\n")[0], "2", "count should be 2");
    assert.ok(content.includes("msg A"));
    assert.ok(content.includes("msg B"));

    mock.setBlocking(false);
    mock.unblock();
    await wait(50);
    queue.clearAll();
  });

  it("cleans up inject files on clearAll", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial", platform);
    await wait(60);
    queue.enqueue(INJECT_CHAT, "main", "mid-turn", platform);

    const dir = injectDirForChat(INJECT_CHAT);
    assert.ok(existsSync(join(dir, "pending")));

    mock.setBlocking(false);
    mock.unblock();
    await wait(50);
    queue.clearAll();

    // Inject dir should be cleaned up
    assert.ok(!existsSync(join(dir, "pending")));
  });
});

// -------------------------------------------------------------------
// MessageQueue — inject dedup (hook-consumed messages not re-drained)
// -------------------------------------------------------------------

describe("MessageQueue inject dedup", () => {
  afterEach(() => {
    injectCleanup(INJECT_CHAT);
  });

  it("deduplicates messages consumed by hook (full consumption)", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial message", platform);
    await wait(60);

    // Enqueue 2 mid-turn messages
    queue.enqueue(INJECT_CHAT, "main", "injected msg 1", platform);
    queue.enqueue(INJECT_CHAT, "main", "injected msg 2", platform);

    // Simulate hook consuming: delete pending file, write ack=2
    const dir = injectDirForChat(INJECT_CHAT);
    const pendingPath = join(dir, "pending");
    if (existsSync(pendingPath)) {
      unlinkSync(pendingPath);
    }
    writeFileSync(join(dir, "ack"), "2", "utf-8");

    // Unblock — drain should skip both consumed messages
    mock.setBlocking(false);
    mock.unblock();
    await wait(100);

    // Only the initial message should have been processed (no drain)
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].text, "initial message");

    queue.clearAll();
  });

  it("deduplicates partial consumption (some consumed, rest drained)", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial", platform);
    await wait(60);

    // Enqueue 3 mid-turn messages
    queue.enqueue(INJECT_CHAT, "main", "consumed msg", platform);
    queue.enqueue(INJECT_CHAT, "main", "drained msg 1", platform);
    queue.enqueue(INJECT_CHAT, "main", "drained msg 2", platform);

    // Simulate hook consuming only 1 message
    const dir = injectDirForChat(INJECT_CHAT);
    const pendingPath = join(dir, "pending");
    if (existsSync(pendingPath)) {
      unlinkSync(pendingPath);
    }
    writeFileSync(join(dir, "ack"), "1", "utf-8");

    // Unblock — drain should deliver the 2 non-consumed messages
    mock.setBlocking(false);
    mock.unblock();
    await wait(100);

    assert.strictEqual(mock.calls.length, 2);
    assert.strictEqual(mock.calls[0].text, "initial");

    // Second call should contain the 2 drained messages
    const drainText = mock.calls[1].text;
    assert.ok(drainText.includes("drained msg 1"));
    assert.ok(drainText.includes("drained msg 2"));
    // The consumed message should NOT be in the drain
    assert.ok(!drainText.includes("consumed msg"));

    queue.clearAll();
  });

  it("collect buffer works as fallback when no hook fires", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial", platform);
    await wait(60);

    // Enqueue mid-turn (inject file is written but no hook runs to consume it)
    queue.enqueue(INJECT_CHAT, "main", "fallback msg", platform);

    // No ack file written (hook never fired) — all messages should drain
    mock.setBlocking(false);
    mock.unblock();
    await wait(100);

    assert.strictEqual(mock.calls.length, 2);
    assert.strictEqual(mock.calls[0].text, "initial");
    assert.strictEqual(mock.calls[1].text, "fallback msg");

    queue.clearAll();
  });

  it("updates consumed count when new message arrives after hook fires", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial", platform);
    await wait(60);

    // First mid-turn message
    queue.enqueue(INJECT_CHAT, "main", "msg 1", platform);

    // Simulate hook consuming it
    const dir = injectDirForChat(INJECT_CHAT);
    unlinkSync(join(dir, "pending"));
    writeFileSync(join(dir, "ack"), "1", "utf-8");

    // Second mid-turn message — should trigger ack read and only write this one
    queue.enqueue(INJECT_CHAT, "main", "msg 2", platform);

    const content = readFileSync(join(dir, "pending"), "utf-8");
    assert.strictEqual(content.split("\n")[0], "1", "only 1 un-consumed message");
    assert.ok(content.includes("msg 2"));
    assert.ok(!content.includes("msg 1"));

    // Simulate hook consuming msg 2
    unlinkSync(join(dir, "pending"));
    writeFileSync(join(dir, "ack"), "2", "utf-8");

    // Unblock — all consumed, nothing to drain
    mock.setBlocking(false);
    mock.unblock();
    await wait(100);

    assert.strictEqual(mock.calls.length, 1);

    queue.clearAll();
  });
});

// -------------------------------------------------------------------
// MessageQueue — pre-stream typing indicator
// -------------------------------------------------------------------

/** Create a mock platform that tracks sendTyping calls. */
function mockTypingPlatform(opts?: { typingIndicator?: boolean }) {
  const typings: number[] = [];
  const platform: PlatformContext = {
    maxMessageLength: 4096,
    editDebounceMs: 2000,
    typingIntervalMs: 50, // short interval for fast tests
    streamingUpdates: true,
    typingIndicator: opts?.typingIndicator !== false,
    async sendMessage() { return "1"; },
    async editMessage() {},
    async deleteMessage() {},
    async sendTyping() { typings.push(Date.now()); },
    async sendFile() {},
    async replyError() {},
  };
  return { platform, typings };
}

describe("MessageQueue pre-stream typing", () => {
  it("sends typing when flush starts (before processFn)", async () => {
    const { platform, typings } = mockTypingPlatform();
    let typingsAtProcessStart = 0;

    const processFn = async (_chatId: string, _agentId: string, _text: string, _platform: PlatformContext) => {
      typingsAtProcessStart = typings.length;
    };

    const queue = new MessageQueue(processFn, { debounceMs: 30 });
    queue.enqueue("chat1", "main", "hello", platform);

    await wait(80);

    // Typing should have been sent before processFn was called
    assert.ok(typingsAtProcessStart >= 1, `Expected typing before processFn, got ${typingsAtProcessStart}`);

    queue.clearAll();
  });

  it("sets preStreamTypingTimer on platform before processFn", async () => {
    const { platform } = mockTypingPlatform();
    let timerSeenInProcessFn: ReturnType<typeof setInterval> | undefined;

    const processFn = async (_chatId: string, _agentId: string, _text: string, p: PlatformContext) => {
      timerSeenInProcessFn = p.preStreamTypingTimer;
    };

    const queue = new MessageQueue(processFn, { debounceMs: 30 });
    queue.enqueue("chat1", "main", "hello", platform);

    await wait(80);

    assert.ok(timerSeenInProcessFn !== undefined, "preStreamTypingTimer should be set during processFn");
    // After processFn completes, timer should be cleaned up
    assert.strictEqual(platform.preStreamTypingTimer, undefined, "timer should be cleared after processing");

    queue.clearAll();
  });

  it("cleans up pre-stream typing on processFn error", async () => {
    const { platform, typings } = mockTypingPlatform();

    const failProcess = async () => {
      throw new Error("boom");
    };

    const queue = new MessageQueue(failProcess, { debounceMs: 30 });
    queue.enqueue("chat1", "main", "trigger error", platform);

    await wait(80);

    // Typing was sent before the error
    assert.ok(typings.length >= 1, "typing should have been sent before error");
    // Timer should be cleaned up despite error
    assert.strictEqual(platform.preStreamTypingTimer, undefined, "timer should be cleared after error");

    queue.clearAll();
  });

  it("does not send typing when typingIndicator is false", async () => {
    const { platform, typings } = mockTypingPlatform({ typingIndicator: false });
    const { processFn } = createMockProcess();

    const queue = new MessageQueue(processFn, { debounceMs: 30 });
    queue.enqueue("chat1", "main", "hello", platform);

    await wait(80);

    assert.strictEqual(typings.length, 0, "should not send typing when disabled");
    assert.strictEqual(platform.preStreamTypingTimer, undefined, "no timer when typing disabled");

    queue.clearAll();
  });

  it("sends typing during drain of collect buffer", async () => {
    const { platform, typings } = mockTypingPlatform();
    const mock = createMockProcess();

    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });

    mock.setBlocking(true);
    queue.enqueue("chat1", "main", "initial", platform);
    await wait(60);

    const typingsBeforeCollect = typings.length;

    // Enqueue mid-turn message
    queue.enqueue("chat1", "main", "collected msg", platform);

    mock.setBlocking(false);
    mock.unblock();
    await wait(80);

    // Typing should have been sent during drain as well
    assert.ok(typings.length > typingsBeforeCollect, "typing should fire during collect drain");

    queue.clearAll();
  });
});
