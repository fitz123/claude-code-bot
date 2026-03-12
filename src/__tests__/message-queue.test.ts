import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "grammy";
import {
  MessageQueue,
  buildCollectPrompt,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_QUEUE_CAP,
} from "../message-queue.js";

/** Minimal mock context — the queue never inspects it, only passes it through. */
function mockCtx(): Context {
  return {
    reply: async () => ({ message_id: 1 }),
  } as unknown as Context;
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
    _ctx: Context,
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
    const ctx = mockCtx();

    queue.enqueue("chat1", "main", "hello", ctx);
    queue.enqueue("chat1", "main", "world", ctx);
    queue.enqueue("chat1", "main", "foo", ctx);

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
    const ctx = mockCtx();

    queue.enqueue("chat1", "main", "solo message", ctx);

    await wait(80);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].text, "solo message");

    queue.clearAll();
  });

  it("treats separate chats independently", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 30 });
    const ctx = mockCtx();

    queue.enqueue("chat1", "main", "msg1", ctx);
    queue.enqueue("chat2", "yulia", "msg2", ctx);

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
    const ctx = mockCtx();

    // First call will block to simulate processing
    mock.setBlocking(true);

    queue.enqueue("chat1", "main", "initial message", ctx);

    // Wait for debounce to fire (flush starts, processFn blocks)
    await wait(60);

    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].text, "initial message");
    assert.ok(queue.isBusy("chat1"));

    // Enqueue messages while busy — should go to collect buffer
    queue.enqueue("chat1", "main", "queued msg 1", ctx);
    queue.enqueue("chat1", "main", "queued msg 2", ctx);

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
    const ctx = mockCtx();

    mock.setBlocking(true);
    queue.enqueue("chat1", "main", "first", ctx);
    await wait(60);

    // Enqueue single message while busy
    queue.enqueue("chat1", "main", "followup", ctx);

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
    const ctx = mockCtx();

    mock.setBlocking(true);
    queue.enqueue("chat1", "main", "first", ctx);
    await wait(60);

    // Fill collect buffer to cap
    queue.enqueue("chat1", "main", "c1", ctx);
    queue.enqueue("chat1", "main", "c2", ctx);
    queue.enqueue("chat1", "main", "c3", ctx);
    assert.strictEqual(queue.getCollectCount("chat1"), 3);

    // This should be dropped
    queue.enqueue("chat1", "main", "c4-dropped", ctx);
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
});

// -------------------------------------------------------------------
// MessageQueue — clear
// -------------------------------------------------------------------

describe("MessageQueue clear", () => {
  it("clears pending messages and cancels debounce timer", async () => {
    const { processFn, calls } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 100 });
    const ctx = mockCtx();

    queue.enqueue("chat1", "main", "will be cleared", ctx);
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
    const ctx = mockCtx();

    queue.enqueue("chat1", "main", "msg1", ctx);
    queue.enqueue("chat2", "yulia", "msg2", ctx);

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
  it("catches processFn errors and sends error reply via ctx", async () => {
    let repliedText = "";
    const errorCtx = {
      reply: async (text: string) => {
        repliedText = text;
        return { message_id: 1 };
      },
    } as unknown as Context;

    const failProcess = async () => {
      throw new Error("Claude exploded");
    };

    const queue = new MessageQueue(failProcess, { debounceMs: 30 });
    queue.enqueue("chat1", "main", "trigger error", errorCtx);

    await wait(80);

    assert.ok(repliedText.includes("Something went wrong"));
    assert.strictEqual(queue.isBusy("chat1"), false);

    queue.clearAll();
  });
});
