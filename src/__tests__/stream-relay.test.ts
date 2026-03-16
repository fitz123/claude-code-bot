import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { splitMessage, extractText, isImageExtension, sendOutboxFiles, relayStream } from "../stream-relay.js";
import type { StreamLine, StreamEvent, AssistantMessage, ResultMessage, ToolProgress, PlatformContext } from "../types.js";

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

  it("preserves paragraph breaks across split chunks", () => {
    // When splitting at \n\n, extra newlines after the boundary must survive
    const para1 = "a".repeat(100);
    const para2 = "b".repeat(100);
    // Three newlines: split consumes \n\n boundary, one \n remains at start of next chunk
    const text = para1 + "\n\n\n" + para2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], "\n" + para2, "extra newline after split boundary should be preserved");
  });

  it("preserves multiple paragraph breaks across split chunks", () => {
    const para1 = "a".repeat(80);
    const para2 = "b".repeat(80);
    const para3 = "c".repeat(80);
    // Build text: para1 \n\n para2 \n\n para3
    const text = para1 + "\n\n" + para2 + "\n\n" + para3;
    const result = splitMessage(text, 100);
    // Should split into 3 chunks, each paragraph intact
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], para2);
    assert.strictEqual(result[2], para3);
  });

  it("handles empty string", () => {
    const result = splitMessage("", 4096);
    assert.deepStrictEqual(result, [""]);
  });

  it("splits long response into multiple 4096-char chunks", () => {
    const text = "x".repeat(10000);
    const result = splitMessage(text, 4096);
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

describe("sendOutboxFiles", () => {
  const outboxPath = "/tmp/bot-outbox-test-relay";

  beforeEach(() => {
    rmSync(outboxPath, { recursive: true, force: true });
    mkdirSync(outboxPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(outboxPath, { recursive: true, force: true });
  });

  it("sends files from outbox directory", async () => {
    writeFileSync(join(outboxPath, "chart.png"), "fake-png");
    writeFileSync(join(outboxPath, "report.pdf"), "fake-pdf");

    const sentFiles: Array<{ path: string; isImage: boolean }> = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string, isImage: boolean): Promise<void> {
        sentFiles.push({ path: filePath, isImage });
      },
    };

    await sendOutboxFiles(outboxPath, platform);

    assert.strictEqual(sentFiles.length, 2);
    const names = sentFiles.map(f => f.path.split("/").pop());
    assert.ok(names.includes("chart.png"));
    assert.ok(names.includes("report.pdf"));

    // Image detection
    const png = sentFiles.find(f => f.path.endsWith("chart.png"));
    assert.strictEqual(png?.isImage, true);
    const pdf = sentFiles.find(f => f.path.endsWith("report.pdf"));
    assert.strictEqual(pdf?.isImage, false);
  });

  it("cleans up files after sending", async () => {
    writeFileSync(join(outboxPath, "output.txt"), "hello");

    await sendOutboxFiles(outboxPath, mockPlatform().platform);

    const remaining = readdirSync(outboxPath);
    assert.strictEqual(remaining.length, 0);
  });

  it("skips subdirectories in outbox", async () => {
    mkdirSync(join(outboxPath, "subdir"));
    writeFileSync(join(outboxPath, "file.txt"), "hello");

    const sentFiles: string[] = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    assert.strictEqual(sentFiles.length, 1);
    assert.ok(sentFiles[0].endsWith("file.txt"));
  });

  it("handles nonexistent outbox directory gracefully", async () => {
    rmSync(outboxPath, { recursive: true, force: true });
    // Should not throw
    await sendOutboxFiles(outboxPath, mockPlatform().platform);
  });

  it("handles empty outbox directory", async () => {
    const sentFiles: string[] = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    assert.strictEqual(sentFiles.length, 0);
  });

  it("continues sending remaining files if one fails", async () => {
    writeFileSync(join(outboxPath, "a.txt"), "aaa");
    writeFileSync(join(outboxPath, "b.png"), "bbb");

    const sentFiles: string[] = [];
    let callCount = 0;
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        callCount++;
        if (callCount === 1) throw new Error("network error");
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    // One succeeded, one failed — but both were attempted
    assert.strictEqual(sentFiles.length, 1);

    // Failed file should still exist (not deleted), successful file should be gone
    const remaining = readdirSync(outboxPath);
    assert.strictEqual(remaining.length, 1, "failed file should remain in outbox");
  });
});

// -------------------------------------------------------------------
// relayStream — tests using PlatformContext
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

/**
 * Create a mock stream that simulates text → tool_use → text sequences.
 * Each segment is either a string (text deltas) or "tool_use" (a tool block).
 */
async function* fakeStreamWithTools(segments: Array<string | "tool_use">): AsyncGenerator<StreamLine> {
  let fullText = "";
  for (const seg of segments) {
    if (seg === "tool_use") {
      // content_block_start for tool_use
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Edit" } },
      } as unknown as StreamEvent;
      // input_json_delta
      yield {
        type: "stream_event",
        event: { delta: { type: "input_json_delta", partial_json: "{}" } },
      } as unknown as StreamEvent;
      // content_block_stop
      yield {
        type: "stream_event",
        event: { type: "content_block_stop" },
      } as unknown as StreamEvent;
    } else {
      // content_block_start for text
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text" } },
      } as unknown as StreamEvent;
      // text_delta
      yield {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: seg } },
      } as StreamEvent;
      fullText += seg;
    }
  }
  yield {
    type: "result",
    result: fullText,
    session_id: "test",
  } as ResultMessage;
}

/** Create a mock PlatformContext for relayStream tests. */
function mockPlatform(options?: {
  editShouldThrow?: boolean;
  streamingUpdates?: boolean;
  typingIndicator?: boolean;
}) {
  const sends: Array<{ text: string }> = [];
  const edits: Array<{ messageId: string; text: string }> = [];
  const typings: number[] = [];
  let messageCounter = 0;

  const platform: PlatformContext = {
    maxMessageLength: 4096,
    editDebounceMs: 2000,
    typingIntervalMs: 4000,
    streamingUpdates: options?.streamingUpdates !== false,
    typingIndicator: options?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      messageCounter++;
      sends.push({ text });
      return String(messageCounter);
    },

    async editMessage(messageId: string, text: string): Promise<void> {
      if (options?.editShouldThrow) {
        throw new Error("429: Too Many Requests: retry after 30");
      }
      edits.push({ messageId, text });
    },

    async sendTyping(): Promise<void> {
      typings.push(Date.now());
    },

    async deleteMessage(): Promise<void> {},

    async sendFile(): Promise<void> {},

    async replyError(text: string): Promise<void> {
      sends.push({ text });
    },
  };

  return { platform, sends, edits, typings };
}

describe("relayStream final edit fallback", () => {
  it("delivers complete text via fallback when final edit fails", async () => {
    const { platform, sends } = mockPlatform({ editShouldThrow: true });
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    // First send: initial message with first delta ("Hello")
    // Second send: fallback after final edit failed with complete text
    assert.ok(sends.length >= 2, `Expected at least 2 sends, got ${sends.length}`);
    const lastSend = sends[sends.length - 1];
    assert.strictEqual(lastSend.text, "Hello world");
  });

  it("does not send fallback when final edit succeeds", async () => {
    const { platform, sends, edits } = mockPlatform({ editShouldThrow: false });
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    // Only one send: the initial message
    assert.strictEqual(sends.length, 1);
    // Final edit should have been called with complete text
    assert.ok(edits.length >= 1);
    assert.strictEqual(edits[edits.length - 1].text, "Hello world");
  });

  it("does not send fallback when edit fails with 'not modified'", async () => {
    const { platform, sends } = mockPlatform();
    // Override editMessage to throw "not modified"
    (platform as { editMessage: PlatformContext["editMessage"] }).editMessage = async () => {
      throw new Error("Bad Request: message is not modified");
    };

    const stream = fakeStream(["Hello"]);
    await relayStream(stream, platform);

    // Only one send: the initial message. No fallback because "not modified" is fine.
    assert.strictEqual(sends.length, 1);
  });
});

describe("relayStream streamingUpdates=false", () => {
  it("sends only the final message with no intermediate edits", async () => {
    const { platform, sends, edits } = mockPlatform({ streamingUpdates: false });
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    // No intermediate sends or edits — only the final message
    assert.strictEqual(edits.length, 0, "Should have no edits when streamingUpdates=false");
    assert.strictEqual(sends.length, 1, "Should send exactly one final message");
    assert.strictEqual(sends[0].text, "Hello world");
  });

  it("handles multi-chunk final message without streaming", async () => {
    const { platform, sends, edits } = mockPlatform({ streamingUpdates: false });
    // Create text longer than max message length
    const longText = "x".repeat(5000);
    const stream = fakeStream([longText]);

    await relayStream(stream, platform);

    assert.strictEqual(edits.length, 0, "Should have no edits when streamingUpdates=false");
    assert.ok(sends.length >= 2, "Should split into multiple messages");
    // Total content preserved
    const totalText = sends.map(s => s.text).join("");
    assert.strictEqual(totalText.length, 5000);
  });
});

describe("relayStream typingIndicator=false", () => {
  it("sends no typing indicators when disabled", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: false });
    const stream = fakeStream(["Hello"]);

    await relayStream(stream, platform);

    assert.strictEqual(typings.length, 0, "Should have no typing indicators");
  });

  it("sends typing indicators when enabled (default)", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: true });
    const stream = fakeStream(["Hello"]);

    await relayStream(stream, platform);

    assert.ok(typings.length >= 1, "Should have at least one typing indicator");
  });
});

describe("relayStream pre-stream typing handoff", () => {
  it("clears preStreamTypingTimer when relayStream starts", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: true });
    const stream = fakeStream(["Hello"]);

    // Simulate message queue having set a pre-stream typing timer
    let preStreamTimerCleared = false;
    platform.preStreamTypingTimer = setInterval(() => {
      // this would fire if not cleared
    }, 50);
    const originalTimer = platform.preStreamTypingTimer;

    await relayStream(stream, platform);

    // Pre-stream timer should have been cleared
    assert.strictEqual(platform.preStreamTypingTimer, undefined, "preStreamTypingTimer should be cleared");
    // relayStream's own typing should still have fired
    assert.ok(typings.length >= 1, "relayStream should send its own typing");

    // Clean up just in case
    clearInterval(originalTimer);
  });

  it("clears preStreamTypingTimer even when typingIndicator is false", async () => {
    const { platform } = mockPlatform({ typingIndicator: false });
    const stream = fakeStream(["Hello"]);

    // Pre-stream timer should still be cleared even if typing is disabled
    platform.preStreamTypingTimer = setInterval(() => {}, 50);
    const originalTimer = platform.preStreamTypingTimer;

    await relayStream(stream, platform);

    assert.strictEqual(platform.preStreamTypingTimer, undefined, "preStreamTypingTimer should be cleared");

    clearInterval(originalTimer);
  });
});

describe("relayStream paragraph breaks across tool-use", () => {
  it("inserts paragraph break between text blocks separated by tool_use", async () => {
    const { platform, sends, edits } = mockPlatform({ streamingUpdates: false });
    const stream = fakeStreamWithTools(["Here's the plan:", "tool_use", "Done! Applied."]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Here's the plan:\n\nDone! Applied.");
  });

  it("does not double paragraph break when text already ends with \\n\\n", async () => {
    const { platform, sends } = mockPlatform({ streamingUpdates: false });
    const stream = fakeStreamWithTools(["Plan:\n\n", "tool_use", "Done!"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Plan:\n\nDone!");
  });

  it("adds one \\n when text already ends with single \\n", async () => {
    const { platform, sends } = mockPlatform({ streamingUpdates: false });
    const stream = fakeStreamWithTools(["Plan:\n", "tool_use", "Done!"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Plan:\n\nDone!");
  });

  it("handles multiple tool-use blocks between text", async () => {
    const { platform, sends } = mockPlatform({ streamingUpdates: false });
    const stream = fakeStreamWithTools(["Part 1", "tool_use", "Part 2", "tool_use", "Part 3"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Part 1\n\nPart 2\n\nPart 3");
  });

  it("does not insert break when tool_use is before any text", async () => {
    const { platform, sends } = mockPlatform({ streamingUpdates: false });
    // Tool use before first text — no accumulated text yet, no separator needed
    async function* toolFirst(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_stop" } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "Result here" } } } as StreamEvent;
      yield { type: "result", result: "Result here", session_id: "test" } as ResultMessage;
    }

    await relayStream(toolFirst(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Result here");
  });

  it("does not insert break when tool_use is before first text arriving in multiple deltas", async () => {
    const { platform, sends } = mockPlatform({ streamingUpdates: false });
    // Tool use before first text, text arrives in multiple deltas — no spurious \n\n
    async function* toolFirstMultiDelta(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_stop" } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "Result" } } } as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: " here" } } } as StreamEvent;
      yield { type: "result", result: "Result here", session_id: "test" } as ResultMessage;
    }

    await relayStream(toolFirstMultiDelta(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Result here");
  });

  it("preserves paragraph breaks with streaming edits enabled", async () => {
    const { platform, edits } = mockPlatform({ streamingUpdates: true });
    const stream = fakeStreamWithTools(["Before tool", "tool_use", "After tool"]);

    await relayStream(stream, platform);

    // Final edit should contain the paragraph break
    const finalEdit = edits[edits.length - 1];
    assert.strictEqual(finalEdit.text, "Before tool\n\nAfter tool");
  });

  it("preserves paragraph breaks in split messages over 4096 chars", async () => {
    const { platform, sends } = mockPlatform({ streamingUpdates: false });
    const longBefore = "x".repeat(3000);
    const longAfter = "y".repeat(3000);
    const stream = fakeStreamWithTools([longBefore, "tool_use", longAfter]);

    await relayStream(stream, platform);

    // splitMessage splits at \n\n boundary, consuming it — the paragraph break
    // becomes a message boundary (separate Telegram messages), which is correct.
    assert.strictEqual(sends.length, 2, "Should split into 2 messages");
    assert.strictEqual(sends[0].text, longBefore);
    assert.strictEqual(sends[1].text, longAfter);
  });
});
