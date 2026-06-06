import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PlatformContext } from "../types.js";
import {
  MessageQueue,
  buildCollectPrompt,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_QUEUE_CAP,
} from "../message-queue.js";

/** Minimal mock PlatformContext — the queue never inspects it deeply, only passes it through. */
function mockPlatform(): PlatformContext {
  return {
    maxMessageLength: 4096,
    typingIntervalMs: 4000,
    typingIndicator: true,
    async sendMessage() { return "1"; },
    async deleteMessage() {},
    async sendDraft() {},
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
    onAgentOwnership?: () => void,
  ) => {
    calls.push({ chatId, agentId, text });
    // Mimic real bot: agent accepts the prompt as soon as the call begins
    // (in production this fires when the first stream event arrives). The
    // queue ignores ownership signals fired after the queue was cleared, so
    // clear-mid-process tests still see drop cleanups fire correctly.
    onAgentOwnership?.();
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
      throw new Error("agent exploded");
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
// MessageQueue — drop cleanups (persistent media reclamation)
// -------------------------------------------------------------------

describe("MessageQueue drop cleanups", () => {
  it("runs pendingDropCleanups when processFn throws", async () => {
    let dropFired = 0;
    let cleanupFired = 0;
    const failProcess = async () => { throw new Error("send failed"); };

    const queue = new MessageQueue(failProcess, { debounceMs: 20 });
    const platform = mockPlatform();

    queue.enqueue(
      "chat1", "main", "hello", platform,
      () => { cleanupFired++; },
      () => { dropFired++; },
    );

    await wait(80);

    assert.strictEqual(cleanupFired, 1, "turn cleanup fires on error");
    assert.strictEqual(dropFired, 1, "drop cleanup MUST fire when delivery fails");

    queue.clearAll();
  });

  it("does NOT run pendingDropCleanups on successful delivery", async () => {
    let dropFired = 0;
    const { processFn } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 20 });
    const platform = mockPlatform();

    queue.enqueue(
      "chat1", "main", "hello", platform,
      undefined,
      () => { dropFired++; },
    );

    await wait(80);

    assert.strictEqual(dropFired, 0, "drop cleanup must not fire on success — session owns file");

    queue.clearAll();
  });

  it("runs pendingDropCleanups exactly once when queue is cleared mid-process before ownership transfer", async () => {
    let dropFired = 0;
    let unblock!: () => void;
    // processFn that blocks WITHOUT signaling ownership — mimics a real
    // session that hasn't yet received any stream events from the agent.
    const blockBeforeOwnership = async () => {
      await new Promise<void>((resolve) => { unblock = resolve; });
    };
    const queue = new MessageQueue(blockBeforeOwnership, { debounceMs: 20 });
    const platform = mockPlatform();

    queue.enqueue(
      "chat1", "main", "hello", platform,
      undefined,
      () => { dropFired++; },
    );

    // Wait for flush to start
    await wait(50);
    assert.ok(queue.isBusy("chat1"));

    // Clear while processFn is still blocked (and ownership not yet signaled)
    queue.clear("chat1");

    // Unblock — post-await code notices queue was cleared
    unblock();
    await wait(50);

    assert.strictEqual(dropFired, 1, "drop cleanup must fire exactly once on clear-while-busy when ownership hasn't transferred");

    queue.clearAll();
  });

  it("runs collectDropCleanups when drain processFn throws", async () => {
    let dropFired = 0;
    let callCount = 0;
    const processFn = async () => {
      callCount++;
      if (callCount === 1) {
        // block first call so a mid-turn message lands in collect buffer
        await new Promise<void>((r) => setTimeout(r, 30));
      } else {
        throw new Error("drain exploded");
      }
    };
    const queue = new MessageQueue(processFn, { debounceMs: 20 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "initial", platform);

    // Wait for flush to start processing (callCount goes to 1)
    await wait(40);

    // Enqueue a mid-turn message with a drop cleanup
    queue.enqueue(
      "chat1", "main", "mid-turn", platform,
      undefined,
      () => { dropFired++; },
    );

    // Wait for flush + drain to complete (drain will throw)
    await wait(120);

    assert.strictEqual(callCount, 2, "both flush and drain ran");
    assert.strictEqual(dropFired, 1, "collect drop cleanup fires on drain failure");

    queue.clearAll();
  });

  it("does NOT run collectDropCleanups on successful drain", async () => {
    let dropFired = 0;
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 20 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue("chat1", "main", "initial", platform);
    await wait(40);

    queue.enqueue(
      "chat1", "main", "mid-turn", platform,
      undefined,
      () => { dropFired++; },
    );

    mock.setBlocking(false);
    mock.unblock();
    await wait(80);

    assert.strictEqual(dropFired, 0, "drop cleanup must not fire on successful drain");

    queue.clearAll();
  });

  it("runs collectDropCleanups when queue is cleared mid-drain before ownership transfer", async () => {
    let dropFired = 0;
    const unblockers: Array<() => void> = [];
    // processFn that blocks WITHOUT signaling ownership on each call.
    const blockBeforeOwnership = async () => {
      await new Promise<void>((resolve) => { unblockers.push(resolve); });
    };
    const queue = new MessageQueue(blockBeforeOwnership, { debounceMs: 20 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "initial", platform);
    await wait(40); // flush is now blocked on initial

    // Mid-turn message with drop cleanup — buffered in collect
    queue.enqueue(
      "chat1", "main", "mid-turn", platform,
      undefined,
      () => { dropFired++; },
    );

    // Unblock the FIRST call; drain begins and blocks on the NEXT call.
    unblockers.shift()?.();
    await wait(40);

    // Clear the queue while drain is blocked on the collect message.
    queue.clear("chat1");

    // Unblock drain so it returns and notices queue was cleared.
    unblockers.shift()?.();
    await wait(40);

    assert.strictEqual(dropFired, 1, "drop cleanup fires exactly once on clear-mid-drain");

    queue.clearAll();
  });

  it("does NOT run pendingDropCleanups when processFn signals ownership then throws (issue #99 regression)", async () => {
    let dropFired = 0;
    let cleanupFired = 0;
    // Simulate: agent accepted prompt (ownership signaled), then response
    // relay failed (e.g. Telegram sendMessage failed for the first chunk).
    const ownThenFail = async (
      _chatId: string, _agentId: string, _text: string,
      _platform: PlatformContext, onAgentOwnership: () => void,
    ) => {
      onAgentOwnership();
      throw new Error("response relay failed after agent committed turn");
    };

    const queue = new MessageQueue(ownThenFail, { debounceMs: 20 });
    const platform = mockPlatform();

    queue.enqueue(
      "chat1", "main", "hello", platform,
      () => { cleanupFired++; },
      () => { dropFired++; },
    );

    await wait(80);

    assert.strictEqual(cleanupFired, 1, "turn cleanup still fires on relay failure");
    assert.strictEqual(dropFired, 0, "drop cleanup MUST NOT fire after ownership transferred — session owns media");

    queue.clearAll();
  });

  it("does NOT run collectDropCleanups when drain processFn signals ownership then throws", async () => {
    let dropFired = 0;
    let callCount = 0;
    const processFn = async (
      _chatId: string, _agentId: string, _text: string,
      _platform: PlatformContext, onAgentOwnership: () => void,
    ) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => setTimeout(r, 30));
      } else {
        onAgentOwnership();
        throw new Error("drain relay failed after agent committed turn");
      }
    };
    const queue = new MessageQueue(processFn, { debounceMs: 20 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "initial", platform);
    await wait(40);

    queue.enqueue(
      "chat1", "main", "mid-turn", platform,
      undefined,
      () => { dropFired++; },
    );

    await wait(120);

    assert.strictEqual(callCount, 2, "both flush and drain ran");
    assert.strictEqual(dropFired, 0, "drop cleanup MUST NOT fire after ownership transferred mid-drain");

    queue.clearAll();
  });

  it("runs drop cleanups when message is dropped by cap", () => {
    let dropFired = 0;
    const { processFn } = createMockProcess();
    const queue = new MessageQueue(processFn, { debounceMs: 1000, queueCap: 1 });
    const platform = mockPlatform();

    queue.enqueue("chat1", "main", "first", platform);
    queue.enqueue(
      "chat1", "main", "second", platform,
      undefined,
      () => { dropFired++; },
    );

    assert.strictEqual(dropFired, 1, "cap-dropped message runs its drop cleanup");

    queue.clearAll();
  });
});

const INJECT_CHAT = "__inject_test__";

// -------------------------------------------------------------------
// MessageQueue — reliable mid-turn buffering
// -------------------------------------------------------------------

describe("MessageQueue mid-turn buffering", () => {
  it("buffers and drains a mid-turn user message as a followup", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "main", "initial", platform);
    await wait(60);

    queue.enqueue(INJECT_CHAT, "main", "mid-turn msg", platform);
    assert.strictEqual(queue.getCollectCount(INJECT_CHAT), 1);

    mock.setBlocking(false);
    mock.unblock();
    await wait(80);
    assert.strictEqual(mock.calls.length, 2);
    assert.strictEqual(mock.calls[1].text, "mid-turn msg");

    queue.clearAll();
  });

  it("runs cleanup after buffered mid-turn delivery and does not run drop-cleanup", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30 });
    const platform = mockPlatform();

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "pi-agent", "initial", platform);
    await wait(60);

    let cleaned = false;
    let dropped = false;
    queue.enqueue(
      INJECT_CHAT,
      "pi-agent",
      "buffered",
      platform,
      () => { cleaned = true; },
      () => { dropped = true; },
    );

    assert.strictEqual(cleaned, false, "cleanup waits until the buffered followup is processed");
    assert.strictEqual(dropped, false, "drop-cleanup must not run while buffered");

    mock.setBlocking(false);
    mock.unblock();
    await wait(80);

    assert.strictEqual(cleaned, true, "cleanup runs after buffered delivery");
    assert.strictEqual(dropped, false, "drop-cleanup never runs after agent ownership");

    queue.clearAll();
  });

  it("caps the mid-turn collect buffer at queueCap, drops overflow, and runs overflow cleanup", async () => {
    const mock = createMockProcess();
    const queue = new MessageQueue(mock.processFn, { debounceMs: 30, queueCap: 2 });
    const platform = mockPlatform();
    let overflowCleanup = 0;
    let overflowDropCleanup = 0;

    mock.setBlocking(true);
    queue.enqueue(INJECT_CHAT, "pi-agent", "initial", platform);
    await wait(60);

    queue.enqueue(INJECT_CHAT, "pi-agent", "b1", platform);
    queue.enqueue(INJECT_CHAT, "pi-agent", "b2", platform);
    queue.enqueue(
      INJECT_CHAT,
      "pi-agent",
      "drop",
      platform,
      () => { overflowCleanup++; },
      () => { overflowDropCleanup++; },
    );

    assert.strictEqual(queue.getCollectCount(INJECT_CHAT), 2, "collect buffer capped at queueCap");
    assert.strictEqual(overflowCleanup, 1, "overflow cleanup runs immediately for the dropped message");
    assert.strictEqual(overflowDropCleanup, 1, "overflow drop cleanup runs immediately for the dropped message");

    mock.setBlocking(false);
    mock.unblock();
    await wait(80);

    assert.strictEqual(mock.calls.length, 2, "buffered messages drain as one followup; overflow is gone");
    assert.ok(mock.calls[1].text.includes("b1"));
    assert.ok(mock.calls[1].text.includes("b2"));
    assert.ok(!mock.calls[1].text.includes("drop"), "the over-cap message was dropped, not delivered");
    assert.strictEqual(overflowCleanup, 1, "overflow cleanup is not repeated during drain");
    assert.strictEqual(overflowDropCleanup, 1, "overflow drop cleanup is not repeated during drain");

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
    typingIntervalMs: 50, // short interval for fast tests
    typingIndicator: opts?.typingIndicator !== false,
    async sendMessage() { return "1"; },
    async deleteMessage() {},
    async sendDraft() {},
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
