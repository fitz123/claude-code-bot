import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitMessage, extractText, collectWritePaths, isImageExtension, relayStream } from "../stream-relay.js";
import type { StreamLine, StreamEvent, AssistantMessage, ResultMessage, ToolProgress } from "../types.js";
import type { Context } from "grammy";

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    const result = splitMessage("Hello world", 4096);
    assert.deepStrictEqual(result, ["Hello world"]);
  });

  it("returns single chunk for exactly max length", () => {
    const text = "a".repeat(4096);
    const result = splitMessage(text, 4096);
    assert.deepStrictEqual(result, [text]);
  });

  it("splits at paragraph boundary", () => {
    const para1 = "a".repeat(100);
    const para2 = "b".repeat(100);
    const text = para1 + "\n\n" + para2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], para2);
  });

  it("splits at newline if no paragraph boundary", () => {
    const line1 = "a".repeat(100);
    const line2 = "b".repeat(100);
    const text = line1 + "\n" + line2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], line1);
    assert.strictEqual(result[1], line2);
  });

  it("splits at space if no newline", () => {
    const text = "word ".repeat(30).trim(); // ~150 chars
    const result = splitMessage(text, 50);
    assert.ok(result.length > 1);
    for (const chunk of result) {
      assert.ok(chunk.length <= 50, `Chunk too long: ${chunk.length}`);
    }
  });

  it("hard-cuts if no natural boundary", () => {
    const text = "a".repeat(200);
    const result = splitMessage(text, 50);
    assert.ok(result.length >= 4);
    assert.strictEqual(result[0].length, 50);
  });

  it("handles empty string", () => {
    const result = splitMessage("", 4096);
    assert.deepStrictEqual(result, [""]);
  });

  it("splits long response into multiple 4096-char chunks", () => {
    const text = "x".repeat(10000);
    const result = splitMessage(text);
    assert.ok(result.length >= 3);
    for (const chunk of result) {
      assert.ok(chunk.length <= 4096);
    }
    // Total content preserved
    assert.strictEqual(result.join("").length, 10000);
  });
});

describe("extractText", () => {
  it("extracts text_delta from stream_event", () => {
    const msg: StreamEvent = {
      type: "stream_event",
      event: {
        delta: { type: "text_delta", text: "Hello" },
      },
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, "Hello");
    assert.strictEqual(result.isFinal, false);
  });

  it("ignores assistant message snapshot (text already delivered via deltas)", () => {
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
      session_id: "test-id",
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("returns isFinal for result message without duplicating text", () => {
    const msg: ResultMessage = {
      type: "result",
      result: "Final answer",
      session_id: "test-id",
      cost_usd: 0.01,
      duration_ms: 1000,
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, true);
  });

  it("returns null for tool_progress", () => {
    const msg: ToolProgress = {
      type: "assistant",
      subtype: "tool_progress",
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("returns isFinal=true for result with no text", () => {
    const msg: ResultMessage = {
      type: "result",
      result: "",
      session_id: "test-id",
    };
    const result = extractText(msg);
    assert.strictEqual(result.isFinal, true);
  });

  it("handles stream_event without text delta", () => {
    const msg: StreamEvent = {
      type: "stream_event",
      event: {
        delta: { type: "input_json_delta" },
      },
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("does not duplicate text when processing full CLI event sequence", () => {
    // Simulates the event sequence from Claude CLI with --include-partial-messages:
    // 1. text_delta events (streaming chunks)
    // 2. assistant message snapshot (full text)
    // 3. result message (full text again)
    const events: StreamLine[] = [
      { type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } } as StreamEvent,
      { type: "stream_event", event: { delta: { type: "text_delta", text: " world" } } } as StreamEvent,
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] }, session_id: "s" } as AssistantMessage,
      { type: "result", result: "Hello world", session_id: "s" } as ResultMessage,
    ];

    let accumulated = "";
    let isFinal = false;
    for (const msg of events) {
      const r = extractText(msg);
      if (r.text !== null) accumulated += r.text;
      if (r.isFinal) isFinal = true;
    }

    assert.strictEqual(accumulated, "Hello world");
    assert.strictEqual(isFinal, true);
  });
});

describe("isImageExtension", () => {
  it("returns true for supported image extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.jpg"), true);
    assert.strictEqual(isImageExtension("/path/to/file.jpeg"), true);
    assert.strictEqual(isImageExtension("/path/to/file.png"), true);
    assert.strictEqual(isImageExtension("/path/to/file.gif"), true);
    assert.strictEqual(isImageExtension("/path/to/file.webp"), true);
  });

  it("returns true for uppercase extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.PNG"), true);
    assert.strictEqual(isImageExtension("/path/to/file.JPG"), true);
  });

  it("returns false for non-image extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.txt"), false);
    assert.strictEqual(isImageExtension("/path/to/file.pdf"), false);
    assert.strictEqual(isImageExtension("/path/to/file.bmp"), false);
    assert.strictEqual(isImageExtension("/path/to/file.ts"), false);
  });

  it("returns false for files with no extension", () => {
    assert.strictEqual(isImageExtension("/path/to/Makefile"), false);
  });
});

describe("collectWritePaths", () => {
  it("collects file path from Write tool_use block", () => {
    const paths = new Set<string>();
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            id: "toolu_01ABC",
            input: { file_path: "/workspace/output.png", content: "..." },
          },
        ],
      },
      session_id: "s",
    };
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 1);
    assert.ok(paths.has("/workspace/output.png"));
  });

  it("ignores Edit tool_use blocks", () => {
    const paths = new Set<string>();
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Edit",
            id: "toolu_01DEF",
            input: { file_path: "/workspace/existing.ts", old_string: "a", new_string: "b" },
          },
        ],
      },
      session_id: "s",
    };
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 0);
  });

  it("ignores non-assistant messages", () => {
    const paths = new Set<string>();
    const result: ResultMessage = {
      type: "result",
      result: "done",
      session_id: "s",
    };
    collectWritePaths(result, paths);
    assert.strictEqual(paths.size, 0);
  });

  it("ignores assistant messages with subtype (tool_progress etc)", () => {
    const paths = new Set<string>();
    const msg: ToolProgress = {
      type: "assistant",
      subtype: "tool_progress",
    };
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 0);
  });

  it("deduplicates repeated snapshots of the same Write", () => {
    const paths = new Set<string>();
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            id: "toolu_01ABC",
            input: { file_path: "/workspace/file.txt", content: "hello" },
          },
        ],
      },
      session_id: "s",
    };
    // Simulate repeated snapshots from --include-partial-messages
    collectWritePaths(msg, paths);
    collectWritePaths(msg, paths);
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 1);
  });

  it("ignores Write block with missing file_path in input", () => {
    const paths = new Set<string>();
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            id: "toolu_01GHI",
            input: { content: "hello" },
          },
        ],
      },
      session_id: "s",
    };
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 0);
  });

  it("ignores Write block with non-string file_path", () => {
    const paths = new Set<string>();
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            id: "toolu_01JKL",
            input: { file_path: 12345, content: "hello" },
          },
        ],
      },
      session_id: "s",
    };
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 0);
  });

  it("ignores Write block with undefined input", () => {
    const paths = new Set<string>();
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            id: "toolu_01MNO",
          },
        ],
      },
      session_id: "s",
    };
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 0);
  });

  it("handles assistant message with non-array content", () => {
    const paths = new Set<string>();
    const msg = {
      type: "assistant" as const,
      message: {
        role: "assistant" as const,
        content: "just a string",
      },
      session_id: "s",
    };
    collectWritePaths(msg as unknown as AssistantMessage, paths);
    assert.strictEqual(paths.size, 0);
  });

  it("collects multiple distinct Write paths", () => {
    const paths = new Set<string>();
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            id: "toolu_01A",
            input: { file_path: "/workspace/a.png", content: "..." },
          },
          {
            type: "tool_use",
            name: "Write",
            id: "toolu_01B",
            input: { file_path: "/workspace/b.txt", content: "..." },
          },
        ],
      },
      session_id: "s",
    };
    collectWritePaths(msg, paths);
    assert.strictEqual(paths.size, 2);
    assert.ok(paths.has("/workspace/a.png"));
    assert.ok(paths.has("/workspace/b.txt"));
  });
});

// -------------------------------------------------------------------
// relayStream — final edit failure fallback
// -------------------------------------------------------------------

/** Create a mock async generator yielding text deltas and a result. */
async function* fakeStream(deltas: string[]): AsyncGenerator<StreamLine> {
  for (const delta of deltas) {
    yield {
      type: "stream_event",
      event: { delta: { type: "text_delta", text: delta } },
    } as StreamEvent;
  }
  yield {
    type: "result",
    result: deltas.join(""),
    session_id: "test",
  } as ResultMessage;
}

/** Create a mock Context for relayStream tests. */
function mockRelayContext(options?: { editShouldThrow?: boolean }) {
  const replies: Array<{ text: string }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];

  const ctx = {
    chat: { id: 123 },
    message: {},
    api: {
      editMessageText: async (chatId: number, messageId: number, text: string) => {
        if (options?.editShouldThrow) {
          throw new Error("429: Too Many Requests: retry after 30");
        }
        edits.push({ chatId, messageId, text });
        return true;
      },
      sendChatAction: async () => true,
    },
    reply: async (text: string, _opts?: unknown) => {
      replies.push({ text });
      return { message_id: replies.length };
    },
  };

  return { ctx: ctx as unknown as Context, replies, edits };
}

describe("relayStream final edit fallback", () => {
  it("delivers complete text via fallback when final edit fails", async () => {
    const { ctx, replies } = mockRelayContext({ editShouldThrow: true });
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, ctx);

    // First reply: initial message with first delta ("Hello")
    // Second reply: fallback after final edit failed with complete text
    assert.ok(replies.length >= 2, `Expected at least 2 replies, got ${replies.length}`);
    const lastReply = replies[replies.length - 1];
    assert.strictEqual(lastReply.text, "Hello world");
  });

  it("does not send fallback when final edit succeeds", async () => {
    const { ctx, replies, edits } = mockRelayContext({ editShouldThrow: false });
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, ctx);

    // Only one reply: the initial message
    assert.strictEqual(replies.length, 1);
    // Final edit should have been called with complete text
    assert.ok(edits.length >= 1);
    assert.strictEqual(edits[edits.length - 1].text, "Hello world");
  });

  it("does not send fallback when edit fails with 'not modified'", async () => {
    const ctx = mockRelayContext().ctx;
    // Override editMessageText to throw "not modified"
    const replies: Array<{ text: string }> = [];
    (ctx as unknown as Record<string, unknown>).reply = async (text: string, _opts?: unknown) => {
      replies.push({ text });
      return { message_id: replies.length };
    };
    (ctx.api as unknown as Record<string, unknown>).editMessageText = async () => {
      throw new Error("Bad Request: message is not modified");
    };

    const stream = fakeStream(["Hello"]);
    await relayStream(stream, ctx);

    // Only one reply: the initial message. No fallback because "not modified" is fine.
    assert.strictEqual(replies.length, 1);
  });
});
